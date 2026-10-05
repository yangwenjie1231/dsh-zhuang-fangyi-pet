/**
 * 庄方宜桌宠 · 原生窗口 exe 的启动与生命周期
 *
 * ── 为什么用 `ctx.subprocess` 而不是 `node:child_process` ──────────────────
 *
 * `ctx.subprocess` 是官方提供的**受管子进程接缝**，本机已实测它是活的
 * （`dsh-subprocess-local` 在跑）。用它有三个实际好处，绕过它全都会丢：
 *
 *   1. **服务 dispose 时自动终止所有受管进程** —— 关闭 DSH 不会留下孤儿桌宠；
 *   2. 沙箱感知（`dsh-pwsh-sandbox` 就是这么接的），不会绕过策略；
 *   3. 退出事实是结构化 promise（`done: Promise<{exitCode, signal}>`），
 *      不用自己拼 `on('exit')`。
 *
 * 契约（实测）：
 *   spawn(spec): SubprocessHandle        // 同步返回
 *   spec = { argv, cwd, stdio, graceMs, signal?, env? }
 *   handle = { stdin, stdout, stderr, collected,
 *              done: Promise<{exitCode, signal}>, terminate(), waitForExit(signal?) }
 *
 * ── 三条防呆（都是"会让用户看到坏行为"的场景）────────────────────────────
 *
 *   · **秒退不重启**：exe 若在 10s 内非零退出（缺 net48、被杀软删、参数错），
 *     自动重启只会变成无限重启风暴。改成只记录 `lastError`，等用户显式操作
 *     或插件重载时才重试。
 *   · **能力探测**：没有 `subprocess` 服务 / exe 文件不存在 → 直接置
 *     `nativeUnavailable`，让上层回落窗口内 overlay，绝不半残。
 *   · **单例**：exe 侧有命名互斥体，多 host/多 profile 时只有一个窗口。
 *
 * @module src/pet/launcher.js
 */

import fs from 'node:fs'
import path from 'node:path'

import { exeArgs } from '../settings.js'

/** exe 文件名（与 `tools/build-pet.ps1` 的产物名一致）。 */
export const EXE_NAME = 'dsh-zhuang-fangyi-pet.exe'

/** 秒退判定阈值：低于它就认为"起不来"，不自动重启。 */
const FAST_EXIT_MS = 10000

/**
 * 找 exe。优先 `bin/`（构建产物），其次包根（打包时可能平铺）。
 *
 * @param {string} pkgRoot
 * @returns {string|null}
 */
export function locateExe (pkgRoot) {
  for (const rel of [path.join('bin', EXE_NAME), EXE_NAME, path.join('pet', EXE_NAME)]) {
    const abs = path.join(pkgRoot, rel)
    try {
      if (fs.statSync(abs).isFile()) return abs
    } catch { /* 继续找 */ }
  }
  return null
}

/**
 * 把 `0.0.0.0` 映射为 `127.0.0.1`，再拼基址。
 *
 * exe 是本机进程，连 `0.0.0.0` 没有意义（且在某些栈上会失败），
 * 所以按契约 §0 做映射。
 *
 * @param {{host?: string, port?: number}} webServer
 * @returns {string|null}
 */
export function baseUrlOf (webServer) {
  const port = webServer?.port
  if (!Number.isFinite(port) || port <= 0) return null
  const host = webServer?.host
  const usable = (host === undefined || host === null || host === '' || host === '0.0.0.0')
    ? '127.0.0.1'
    : String(host)
  // IPv6 字面量要加方括号。
  const authority = usable.includes(':') && !usable.startsWith('[') ? `[${usable}]` : usable
  return `http://${authority}:${port}`
}

/**
 * 创建 launcher。
 *
 * @param {object} deps
 * @param {object} deps.ctx - cordis Context（用于取 subprocess 服务与 logger）
 * @param {string} deps.pkgRoot - 包根绝对路径
 * @param {() => object} deps.getSettings - 取当前设置
 * @param {() => object} deps.getSnapshot - 取当前快照（用于 `--state` 初值）
 * @param {string} deps.token - 一次性令牌
 * @param {(status: object) => void} deps.onStatus - 可用性变化回调
 * @param {object} [deps.logger]
 * @returns {object}
 */
export function createLauncher (deps) {
  const logger = deps.logger ?? console
  const ctx = deps.ctx

  let handle = null
  let startedAt = 0
  let lastError = null
  let available = false
  let reason = null
  let disposed = false
  let lastOutcome = null

  /** 探测可用性，不启动。 */
  function probe () {
    const exe = locateExe(deps.pkgRoot)
    if (exe === null) {
      return { ok: false, reason: `未找到 ${EXE_NAME}，请先跑 tools/build-pet.ps1` }
    }
    // `ctx.get` 是**可选**取法：服务不存在时返回 undefined（契约明确要求做 undefined 检查）。
    let service
    try {
      service = typeof ctx?.get === 'function' ? ctx.get('subprocess') : undefined
    } catch {
      service = undefined
    }
    if (service === undefined || service === null || typeof service.spawn !== 'function') {
      return { ok: false, reason: '宿主未提供 ctx.subprocess（Web profile 或旧版本），已回落窗口内桌宠' }
    }
    return { ok: true, exe, service }
  }

  /** 通知上层可用性变化。 */
  function publish () {
    try {
      deps.onStatus({ available, reason, lastError, lastOutcome })
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 可用性回调失败（${error?.message ?? error}）`)
    }
  }

  /**
   * 启动 exe。
   *
   * @param {object} [runtime] - `{url, state}`；缺省时自行推导
   * @returns {boolean} 是否成功启动
   */
  function start (runtime) {
    if (disposed) return false
    if (handle !== null) return true // 已在跑

    const probeResult = probe()
    if (!probeResult.ok) {
      available = false
      reason = probeResult.reason
      publish()
      logger.warn?.(`zhuang-fangyi-pet: ${reason}`)
      return false
    }

    // ⚠️ 取 webServer **必须用 `ctx.get()`，不能读 `ctx.webServer`**：
    // cordis 对"未在 inject 声明的服务"用 Proxy getter，读取会**抛**
    // `cannot get property "webServer" without inject`（实测把 exe 启动整个掐死）。
    // 可选链 `ctx?.webServer` 防不住这个 —— 抛的是异常，不是 undefined。
    // `ctx.get()` 是 cordis 的"无 inject 读取"通道，读不到返回 undefined。
    let url = runtime?.url ?? null
    if (url === null || url === undefined) {
      let webServer = null
      try {
        webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') : null
      } catch (error) {
        // 某些宿主实现连 get 都可能抛（服务名未注册）——按"端口未知"处理。
        logger.warn?.(`zhuang-fangyi-pet: 读 webServer 失败（${error?.message ?? error}）`)
      }
      url = baseUrlOf(webServer)
    }
    if (url === null || url === undefined) {
      available = false
      reason = 'webServer 端口未知，无法告知 exe 连哪里'
      publish()
      logger.warn?.(`zhuang-fangyi-pet: ${reason}`)
      return false
    }

    const settings = deps.getSettings()
    const state = runtime?.state ?? deps.getSnapshot().petState
    const argv = [probeResult.exe, ...exeArgs(settings, { url, token: deps.token, state })]

    try {
      handle = probeResult.service.spawn({
        argv,
        // cwd 用包根：exe 若想读相邻的 art/ 也能找到（虽然正常走 HTTP）。
        cwd: deps.pkgRoot,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 3000
      })
    } catch (error) {
      handle = null
      available = false
      lastError = `启动失败：${error?.message ?? error}`
      reason = lastError
      publish()
      logger.warn?.(`zhuang-fangyi-pet: ${lastError}`)
      return false
    }

    startedAt = Date.now()
    available = true
    reason = null
    lastError = null
    publish()
    logger.info?.(`zhuang-fangyi-pet: 已启动原生桌宠窗口（pid 见宿主日志）`)

    // 观测退出：这是"秒退不重启"与"无孤儿"的关键。
    const done = handle.done
    if (done !== undefined && typeof done.then === 'function') {
      done.then(outcome => {
        lastOutcome = outcome ?? null
        handle = null
        const lived = Date.now() - startedAt
        const code = outcome?.exitCode
        if (disposed) return // 正常卸载，不报告
        available = false
        if (code === 0) {
          reason = '桌宠窗口已退出'
        } else if (lived < FAST_EXIT_MS) {
          // 秒退：不自动重启，把原因留给用户看。
          reason = `桌宠窗口启动后 ${Math.round(lived / 1000)}s 即退出（退出码 ${code}）。` +
            '常见原因：缺少 .NET Framework 4.8、exe 被杀软拦截、或参数非法。'
          lastError = reason
        } else {
          reason = `桌宠窗口已退出（退出码 ${code}）`
        }
        publish()
        logger.warn?.(`zhuang-fangyi-pet: ${reason}`)
      }).catch(error => {
        handle = null
        available = false
        reason = `桌宠进程观测失败：${error?.message ?? error}`
        lastError = reason
        publish()
      })
    }

    return true
  }

  /** 停掉 exe。`terminate()` 是唯一终止动词（契约实测）。 */
  function stop () {
    if (handle === null) return
    try {
      handle.terminate()
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 终止桌宠进程失败（${error?.message ?? error}）`)
    }
    handle = null
    available = false
  }

  return {
    start,
    stop,
    probe,
    /** 用户显式"重开"时用：清掉错误再启动。 */
    restart (runtime) {
      stop()
      lastError = null
      reason = null
      return start(runtime)
    },
    dispose () {
      disposed = true
      stop()
    },
    get status () {
      return { available, reason, lastError, lastOutcome, running: handle !== null }
    }
  }
}
