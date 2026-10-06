/**
 * 庄方宜桌宠 · 合成服务进程监管（"语音模型常驻"开关的实现）
 *
 * ── 用户在解决什么问题 ────────────────────────────────────────────────────
 *
 * 用户原话："还需要一个开关，每次包括是特别是使用 CUDA 的时候，加载模型会占
 * 更多的时间。可以加一个是否让语音模型常驻的选项。"
 *
 * 也就是：合成服务启动时要**加载模型**（onnx 约 10 秒；torch+CUDA 要把
 * GPT/SoVITS/BERT/HuBERT 搬进显存，更慢），而且加载完会**长期占着显存**。
 * 两个诉求互相冲突，所以必须让用户选：
 *
 *   · **常驻**（`ttsResident: true`）—— 桌宠负责让服务一直活着：
 *     启动一次、之后每次合成**立刻开始**（不重复加载）；挂了自动拉起。
 *     代价：显存一直被占。
 *   · **非常驻**（默认）—— 需要时才启动，空闲 `ttsIdleStopSec` 秒后
 *     **自动停掉释放显存**。代价：每次会话第一次合成要等模型加载。
 *
 * ── 一条纪律：只停"自己起的" ──────────────────────────────────────────────
 *
 * 用户完全可能自己在终端里 `python -m zfh_voice serve`。那种情况下
 * 桌宠**只连接、绝不终止** —— 别人的进程不该被我们杀掉
 *（`ours` 标志就是这件事的账本）。
 *
 * ── 另一条纪律：秒退不重启 ────────────────────────────────────────────────
 *
 * 启动失败（没装依赖、模型缺失、端口占用）时自动重启会变成重启风暴。
 * 与 `launcher.js` 同一条教训：短命退出只记 `lastError`，不再自动重试，
 * 等用户显式操作或插件重载。
 *
 * @module src/pet/tts-service.js
 */

/** 默认空闲多少秒后停掉服务释放显存（非常驻模式）。 */
export const DEFAULT_IDLE_STOP_SEC = 300

/** 启动后等健康检查的最长时间。CUDA 下加载模型可能几十秒。 */
export const DEFAULT_START_TIMEOUT_MS = 120000

/** 健康探测间隔（常驻模式下用它发现"服务死了"）。 */
export const HEALTH_POLL_MS = 15000

/** 短命退出判定：低于它就认为"起不来"，不再自动重启（防风暴）。 */
export const RAPID_EXIT_MS = 10000

/**
 * 组装启动命令。
 *
 * CLI 形状（实测自子插件 `cli.py`）——**全局参数必须在子命令前面**：
 *
 *     python -m zfh_voice --backend torch --gsv-root <dir> serve --host 127.0.0.1 --port 8765
 *
 * @param {object} o
 * @param {string} o.python - python 可执行文件
 * @param {string} o.repoDir - 子插件仓库根（工作目录）
 * @param {string} [o.backend] - `torch` | `onnx` | ''（用子插件默认）
 * @param {string} [o.gsvRoot] - GPT-SoVITS 检出目录（torch 后端需要）
 * @param {string} [o.modelDir]
 * @param {string} [o.host]
 * @param {number} [o.port]
 * @returns {{argv: string[], cwd: string, env: object}|null} 缺关键项 → null
 */
export function buildServeCommand (o = {}) {
  const python = String(o.python ?? '').trim()
  const repoDir = String(o.repoDir ?? '').trim()
  if (python === '' || repoDir === '') return null
  const host = String(o.host ?? '').trim() || '127.0.0.1'
  const port = Number.isFinite(Number(o.port)) && Number(o.port) > 0
    ? Math.floor(Number(o.port))
    : 8765
  const argv = [python, '-m', 'zfh_voice']
  const backend = String(o.backend ?? '').trim()
  if (backend === 'torch' || backend === 'onnx') argv.push('--backend', backend)
  const gsv = String(o.gsvRoot ?? '').trim()
  if (gsv !== '') argv.push('--gsv-root', gsv)
  const model = String(o.modelDir ?? '').trim()
  if (model !== '') argv.push('--model-dir', model)
  argv.push('serve', '--host', host, '--port', String(port))
  return {
    argv,
    cwd: repoDir,
    // ⭐ `src/` 布局：从仓库直接跑必须把 `src` 放进 PYTHONPATH，
    // 否则 `python -m zfh_voice` 报 ModuleNotFoundError（包没安装时）。
    // 这一条能让用户**不必先 pip install -e .** 就能跑起来。
    env: { PYTHONPATH: joinPath(repoDir, 'src') }
  }
}

/** 极简 path.join（避免为了拼一个路径而 import node:path —— 本模块要可纯测）。 */
function joinPath (a, b) {
  const sep = a.includes('\\') ? '\\' : '/'
  return a.replace(/[\\/]+$/, '') + sep + b
}

/**
 * **纯决策**：这一刻该对服务做什么。
 *
 * 抽成纯函数是为了能穷举边界（常驻/非常驻 × 健康/不健康 × 谁起的 × 空闲多久），
 * 那些组合在真实时序里很难复现，但逻辑错误会造成"显存一直不释放"或
 * "反复重启"这类用户可见的坏行为。
 *
 * @param {object} s
 * @param {boolean} s.resident - 常驻开关
 * @param {boolean} s.ours - 是我们起的吗（不是 → 绝不终止）
 * @param {boolean} s.healthy - 健康检查通过
 * @param {number} s.idleMs - 距上次使用的毫秒数
 * @param {number} s.idleLimitMs - 空闲上限（非常驻模式）
 * @param {boolean} s.launchable - 有可用的启动命令
 * @param {boolean} s.rapidExit - 上次是否短命退出（防重启风暴）
 * @returns {{action: 'none'|'stop'|'restart', why: string}}
 */
export function nextServiceAction (s) {
  const resident = s.resident === true
  const ours = s.ours === true
  const healthy = s.healthy === true
  const launchable = s.launchable === true
  const idleMs = Number.isFinite(s.idleMs) ? s.idleMs : 0
  const idleLimitMs = Number.isFinite(s.idleLimitMs) ? s.idleLimitMs : 0

  // ① 不是我们起的 → 永不碰它（用户自己开的服务）。
  if (!ours) return { action: 'none', why: 'not-ours' }

  // ② 不健康 + 是我们起的 → 可能崩了。常驻且能启动才重启，且防风暴。
  if (!healthy) {
    if (!resident) return { action: 'none', why: 'down-not-resident' }
    if (!launchable) return { action: 'none', why: 'down-no-launch' }
    if (s.rapidExit === true) return { action: 'none', why: 'down-rapid-exit' }
    return { action: 'restart', why: 'down-resident' }
  }

  // ③ 健康 + 非我们起的已在 ① 返回；健康 + 我们起的：
  //    常驻 → 留着；非常驻 → 空闲够了就停（释放显存）。
  if (resident) return { action: 'none', why: 'resident-keep' }
  if (idleLimitMs > 0 && idleMs >= idleLimitMs) {
    return { action: 'stop', why: 'idle-stop' }
  }
  return { action: 'none', why: 'in-use' }
}

/**
 * 创建监管器。
 *
 * @param {object} o
 * @param {(spec: object) => object} o.spawn - `ctx.subprocess.spawn`
 * @param {() => Promise<object|null>} o.health - 健康检查（返回 null 表示不可用）
 * @param {object} [o.logger]
 * @param {() => number} [o.now]
 * @returns {object} 监管器
 */
export function createTtsSupervisor (o = {}) {
  const spawn = typeof o.spawn === 'function' ? o.spawn : null
  const health = typeof o.health === 'function' ? o.health : async () => null
  const logger = o.logger ?? null
  const now = typeof o.now === 'function' ? o.now : () => Date.now()

  /** 配置（`configure()` 更新；设置页改了立刻生效）。 */
  let cfg = {
    resident: false,
    launch: null,          // {argv, cwd, env} | null
    idleStopSec: DEFAULT_IDLE_STOP_SEC,
    startTimeoutMs: DEFAULT_START_TIMEOUT_MS
  }

  /** 状态。 */
  let handle = null         // 子进程句柄
  let startedAt = 0         // 我们启动它的时刻
  let exitedAt = 0          // 它退出的时刻（0 = 没退过）
  let lastUseAt = now()
  let lastError = null
  let backend = null
  let starting = null       // 启动中的 promise（防并发双启）

  const launchable = () => cfg.launch !== null && spawn !== null

  const markUse = () => { lastUseAt = now() }

  /** 现在健康吗（顺带记录后端名）。 */
  const probe = async () => {
    const h = await health()
    if (h !== null && h !== undefined && h.ok === true) {
      backend = typeof h.backend === 'string' ? h.backend : backend
      return true
    }
    return false
  }

  /**
   * 确保服务可用。会按需启动（有启动命令时）。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.wait] - 是否等它变成健康（默认 true）
   * @returns {Promise<boolean>}
   */
  const ensure = async (opts = {}) => {
    markUse()
    if (await probe()) { exitedAt = 0; return true }
    if (!launchable()) return false
    if (starting !== null) return starting
    starting = (async () => {
      try {
        logger?.info?.('zhuang-fangyi-pet: 启动合成服务…')
        handle = spawn({
          argv: cfg.launch.argv,
          cwd: cfg.launch.cwd,
          env: cfg.launch.env,
          stdio: 'ignore',
          graceMs: 2000
        })
        startedAt = now()
        exitedAt = 0
        lastError = null
        // 进程退出 → 记账（用于短命退出判定）
        try {
          handle?.done?.then(value => {
            exitedAt = now()
            const ms = startedAt > 0 ? exitedAt - startedAt : 0
            if (ms < RAPID_EXIT_MS) {
              lastError = `服务启动后 ${Math.round(ms / 1000)} 秒就退出了（exit=${value?.exitCode ?? '?'}）—— 见 docs 排查`
              logger?.warn?.(`zhuang-fangyi-pet: ${lastError}`)
            } else {
              logger?.info?.(`zhuang-fangyi-pet: 合成服务已退出（exit=${value?.exitCode ?? '?'}）`)
            }
            handle = null
          }).catch(() => {})
        } catch { /* done 不是 promise 也不影响 */ }
        // 等它加载完模型（CUDA 下可能几十秒）
        if (opts.wait === false) return true
        const deadline = now() + cfg.startTimeoutMs
        while (now() < deadline) {
          if (await probe()) {
            logger?.info?.(`zhuang-fangyi-pet: 合成服务就绪（${Math.round((now() - startedAt) / 1000)}s，backend=${backend ?? '?'}）`)
            return true
          }
          if (handle === null && exitedAt > 0) {
            logger?.warn?.('zhuang-fangyi-pet: 合成服务没起来（进程已退出）')
            return false
          }
          await new Promise(r => setTimeout(r, 1000))
        }
        lastError = `等 ${Math.round(cfg.startTimeoutMs / 1000)} 秒仍未就绪（模型可能太大或首次加载慢）`
        logger?.warn?.(`zhuang-fangyi-pet: ${lastError}`)
        return false
      } catch (error) {
        lastError = String(error?.message ?? error)
        logger?.warn?.(`zhuang-fangyi-pet: 启动合成服务失败：${lastError}`)
        return false
      } finally {
        starting = null
      }
    })()
    return starting
  }

  /**
   * 停掉服务 —— **只停我们自己起的**。
   * @returns {boolean} 是否真的发了终止
   */
  const stop = () => {
    if (handle === null) return false
    try {
      handle.terminate?.()
      logger?.info?.('zhuang-fangyi-pet: 已停止合成服务（释放显存）')
      handle = null
      startedAt = 0
      return true
    } catch (error) {
      logger?.warn?.(`zhuang-fangyi-pet: 停止合成服务失败：${error?.message ?? error}`)
      return false
    }
  }

  /**
   * 周期检查（由上层定时调用）。执行 `nextServiceAction` 的决定。
   */
  const tick = async () => {
    const healthy = await probe().catch(() => false)
    const idleLimitMs = Math.max(0, Number(cfg.idleStopSec) || 0) * 1000
    const decision = nextServiceAction({
      resident: cfg.resident,
      ours: handle !== null || (exitedAt > 0 && startedAt > 0),
      healthy,
      idleMs: now() - lastUseAt,
      idleLimitMs,
      launchable: launchable(),
      rapidExit: lastError !== null && lastError.includes('就退出了')
    })
    if (decision.action === 'stop') {
      stop()
      return decision
    }
    if (decision.action === 'restart') {
      if (await ensure()) return decision
    }
    return decision
  }

  return {
    configure (next) {
      if (next === null || typeof next !== 'object') return
      if (typeof next.resident === 'boolean') cfg.resident = next.resident
      if ('launch' in next) cfg.launch = next.launch ?? null
      if (Number.isFinite(Number(next.idleStopSec))) {
        cfg.idleStopSec = Math.max(0, Math.floor(Number(next.idleStopSec)))
      }
      if (Number.isFinite(Number(next.startTimeoutMs))) {
        cfg.startTimeoutMs = Math.max(1000, Math.floor(Number(next.startTimeoutMs)))
      }
    },
    ensure,
    stop,
    tick,
    markUse,
    /** 诊断快照（设置页/日志用）。 */
    status () {
      const ready = handle !== null
      return {
        resident: cfg.resident,
        /** 有启动命令吗（没有就只能连用户自己开的服务）。 */
        launchable: launchable(),
        /** 是我们起的吗（不是 → 我们不会去停止它）。 */
        ours: ready,
        /** 子进程 pid（拿得到才有）。 */
        pid: handle?.pid ?? null,
        ready,
        backend,
        lastError,
        startedAt: startedAt > 0 ? startedAt : null,
        idleMs: now() - lastUseAt,
        idleStopSec: cfg.idleStopSec
      }
    }
  }
}
