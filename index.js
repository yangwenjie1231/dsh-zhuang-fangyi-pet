/**
 * 庄方宜桌宠 · Host 半身
 *
 * ── 这个插件做什么 ────────────────────────────────────────────────────────
 *
 * 让桌宠**真的浮在桌面上**：宿主启动一个自带的 .NET Framework 4.8 小 exe
 * （无边框 + 透明 + 置顶 + alpha 点击穿透），经 HTTP/SSE 把 agent 实时状态推给它。
 *
 * 为什么不走"页面内悬浮层"（`桌宠开发文档.md` 的原方案）：`shell.overlay` 只能在
 * DSH 窗口内浮动，用户明确要求"直接浮动在我的桌面上"。也不走"自带 Electron"
 * （+80~150MB）或"借主进程开窗"（IPC 是封闭白名单，实测 7 处
 * `setWindowOpenHandler` 一律 deny）—— 详见 `docs/桌宠方案调研.md` 的修订。
 *
 * 关键：**这不碰 DSH 的 IPC 白名单**。那条白名单限制的是"让 DSH 替我开窗"，
 * 不限制"我自己 spawn 一个进程"。用的是官方 `ctx.subprocess` 接缝。
 *
 * ── 组成 ──────────────────────────────────────────────────────────────────
 *
 *   src/pet/state.js     纯函数状态机（本体状态 + 气泡），唯一真相
 *   src/pet/events.js    DSH 事件 → 状态机信封（唯一翻译点）
 *   src/pet/atlas.js     素材清单加载 + 白名单（唯一素材入口）
 *   src/pet/hub.js       SSE 推送
 *   src/pet/routes.js    /pet/* 路由 + 信任围栏 + 令牌
 *   src/pet/launcher.js  exe 启动/观测/终止
 *
 * ── 降级策略（绝不半残）──────────────────────────────────────────────────
 *
 * 缺 exe / 无 `subprocess` / 非 Windows → `nativeAvailable: false` 且带 `nativeError`，
 * 浏览器半边据此自动渲染窗口内 overlay 桌宠。功能完整，只是不浮在桌面上。
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { defaultSettings, normalizeSettings, SETTINGS_VERSION } from './src/settings.js'
import { createPetState, DEFAULT_BUBBLE_STATES } from './src/pet/state.js'
import { activityConfig } from './src/pet/activity.js'
import { bridgeHostEvents } from './src/pet/events.js'
import { loadAtlas, artForState, bubbleArt, atlasReport } from './src/pet/atlas.js'
import { createHub } from './src/pet/hub.js'
import { createHandler, newToken, ROUTE_PREFIX } from './src/pet/routes.js'
import { createLauncher } from './src/pet/launcher.js'

/** 插件标识（Loader 行 id、token 层 source 共用）。 */
export const name = 'zhuang-fangyi-pet'

/** 无硬依赖；`webServer` 由嵌套 inject 处理（见下）。 */
export const inject = []

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ART_DIR = path.join(HERE, 'art', 'pet')
const DATA_DIR_NAME = 'zhuang-fangyi-pet'

/**
 * 构建标记。由 `tools/deploy.ps1` 在部署时写入（取源文件 mtime）。
 *
 * 为什么需要：宿主进程缓存 ESM 模块，`plugin_manager` 的 disable → enable
 * **只重跑 `apply()`，不会重新 import** `src/pet/*.js`。所以改了状态机后可能
 * "文件已更新、行为还是旧的"。一次 HTTP 探活就能区分"代码写错了"与"进程没重载"。
 * （这个坑是主题插件实测踩过的，见 `双壳适配说明.md` §七。）
 */
const PLUGIN_BUILD = '__ZF_PET_BUILD__'

/** `$DSH_HOME` 优先，其次 `~/.dsh`（与外壳 home-paths 同一解析规则）。 */
function resolveDshHome () {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/**
 * 极简 JSON 持久化：读损坏时保留原文件，写入走"临时文件 + rename"。
 *
 * 照抄主题插件 `index.js` 的 `JsonStore`（同一份已验证的做法）：
 * 崩溃不会留下半截文件，用户设置不会被静默覆盖。
 */
class JsonStore {
  constructor (file, fallback, { normalize, log } = {}) {
    this.file = file
    this.fallback = fallback
    this.normalize = normalize
    this.log = log
    this.value = this.#read()
    this.timer = null
    this.listeners = new Set()
    /** 上次通知订阅者时的值（用于"没变化就不广播"这道闸）。 */
    this.#lastEmitted = undefined
  }

  #lastEmitted

  /**
   * 订阅设置变化。**exe 的实时设置靠它**：用户在设置页改大小/透明度，
   * Host 重新归一化后广播一帧快照，exe 侧 diff 出差异才应用 ——
   * 没有这条通知，exe 只能等重启（这正是这次要修掉的缺陷）。
   */
  subscribe (fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  #emit () {
    for (const fn of this.listeners) {
      try {
        fn(this.value)
      } catch { /* 监听者坏了不能拖垮设置存储 */ }
    }
  }

  #read () {
    let raw
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log?.(`读取失败：${error?.message ?? error}`)
      return this.normalize ? this.normalize(this.fallback) : this.fallback
    }
    try {
      return this.normalize ? this.normalize(JSON.parse(raw)) : JSON.parse(raw)
    } catch (error) {
      try {
        const keep = `${this.file}.corrupt-${Date.now()}`
        fs.copyFileSync(this.file, keep)
        this.log?.(`设置文件损坏，已备份到 ${keep}：${error?.message ?? error}`)
      } catch { /* 无法写入的 home 不是这个文件的问题 */ }
      return this.normalize ? this.normalize(this.fallback) : this.fallback
    }
  }

  get () {
    return this.value
  }

  /** 合并补丁并安排一次合并写入（250ms 去抖）。 */
  update (patch) {
    this.value = this.normalize ? this.normalize({ ...this.value, ...patch }) : { ...this.value, ...patch }
    this.schedule()
    this.#emitIfChanged()
    return this.value
  }

  /** 整体替换（设置页提交完整对象时用）。 */
  replace (next) {
    this.value = this.normalize ? this.normalize(next) : next
    this.schedule()
    this.#emitIfChanged()
    return this.value
  }

  /**
   * 只在归一化后的值**真的变了**时才通知订阅者。
   *
   * 为什么必须有这道闸：exe 每次应用设置都会 ReclampPosition 并 POST 一次位置，
   * 位置上报又走 `settings.update` —— 如果"没变化的 update"也广播，
   * 每一次广播都会让 exe 再走一遍"应用 → 上报"，
   * 广播风暴就是这么来的。逐字段浅比较足够（设置是平的）。
   */
  #emitIfChanged () {
    const prev = this.#lastEmitted
    if (prev !== undefined) {
      const keys = new Set([...Object.keys(prev), ...Object.keys(this.value)])
      let same = true
      for (const k of keys) {
        if (!Object.is(prev[k], this.value[k])) { same = false; break }
      }
      if (same) return
    }
    this.#lastEmitted = this.value
    this.#emit()
  }

  schedule () {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 250)
    this.timer.unref?.()
  }

  flush () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
      fs.writeFileSync(tmp, `${JSON.stringify(this.value, null, 2)}\n`, 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (error) {
      this.log?.(`写入失败：${error?.message ?? error}`)
    }
  }

  dispose () {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply (ctx, config) {
  const logger = ctx.logger ?? console
  const home = resolveDshHome()
  const dataDir = path.join(home, DATA_DIR_NAME)

  /**
   * 启动面包屑。
   *
   * **为什么需要**：这个插件跑在宿主的进程里，它的 `apply()` 抛错只会出现在
   * 宿主自己的控制台里 —— 而用户看不到那个控制台。于是"插件没生效"变成了
   * 一个只能靠猜的现象（设置页空白、桌宠不出现、路由 404，全都没有原因）。
   * 把每个阶段与任何异常写进一个**用户能读到的文件**，诊断就从猜变成看。
   */
  const bootLog = path.join(dataDir, 'boot.log')
  const boot = stage => {
    try {
      fs.appendFileSync(bootLog, `${new Date().toISOString()} ${stage}\n`, 'utf8')
    } catch { /* 日志失败绝不能影响启动 */ }
  }
  boot(`--- apply() 进入 build=${PLUGIN_BUILD} home=${home} ---`)

  // 把整个装配包起来：任何未预期异常都先落盘再抛（照旧让宿主知道失败）。
  try {
    return applyInner()
  } catch (error) {
    boot(`❌ apply() 抛错：${error?.stack ?? error}`)
    throw error
  }

  function applyInner () {
  let settings
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    settings = new JsonStore(path.join(dataDir, 'settings.json'), defaultSettings(), {
      normalize: normalizeSettings,
      log: message => logger.warn?.(`zhuang-fangyi-pet: ${message}`)
    })
  } catch (error) {
    logger.warn?.(`zhuang-fangyi-pet: 无法建立设置目录，改用内存默认值（${error?.message ?? error}）`)
    settings = new JsonStore(path.join(os.tmpdir(), 'zhuang-fangyi-pet-settings.json'), defaultSettings(), {
      normalize: normalizeSettings
    })
  }
  ctx.effect(() => () => settings.dispose(), 'zhuang-fangyi-pet: settings store')
  boot(`设置已就绪 mode=${settings.get().mode} enabled=${settings.get().enabled}`)

  // ── 素材清单：可重载（用户抠好图后跑 prepare-pet.py 再发 reload-art）────────
  let atlas = loadAtlas(ART_DIR, logger)
  const reloadAtlas = () => {
    atlas = loadAtlas(ART_DIR, logger)
    logger.info?.(`zhuang-fangyi-pet: 素材已重载（${atlasReport(atlas).files} 个文件）`)
    return atlas
  }

  // ── 一次性令牌：每次进程启动重新生成，不落盘 ─────────────────────────────
  const token = newToken()

  // ── SSE hub ─────────────────────────────────────────────────────────────
  const hub = createHub({ logger })
  ctx.effect(() => () => hub.dispose(), 'zhuang-fangyi-pet: sse hub')

  // ── 状态机：气泡选图注入 atlas（状态机本身不知道素材目录）─────────────────
  /**
   * 当前设置 → 状态机 `config`。
   *
   * **抽成函数是为了热更新**：设置页里改活跃度/气泡时长/完成提醒，
   * 必须立刻重算并 `machine.setConfig()`，否则用户点了没反应。
   */
  const machineConfig = () => {
    const s = settings.get()
    // 活跃度档位：只决定「哪些状态值得弹、间隔倍率、要不要主动卖萌」。
    // 用户的显式数值仍是基准（档位乘倍率），见 src/pet/activity.js 的说明。
    const act = activityConfig(s.activity, s, DEFAULT_BUBBLE_STATES)
    return {
      happyMs: s.happyMs,
      sleepMs: s.sleepMs,
      /** 气泡一次显示多久、两条之间最小间隔（用户可调；档位在此之上缩放）。 */
      bubbleMs: s.bubbleMs,
      bubbleSilenceMs: act.bubbleSilenceMs,
      /** "调皮"档空闲主动蹦表情的中位间隔；其余档位为 null。 */
      idleEmoteMs: act.idleEmoteMs,
      /** AI 完成一回合时**强制**弹一条提醒（绕过静默期与优先级）。 */
      notifyComplete: s.notifyComplete,
      /** 授权/提问常亮提醒。**不看 `bubble` 总开关** —— 它们是独立开关。 */
      attentionReminder: s.attentionReminder,
      locale: s.locale,
      // 气泡总开关关掉 → 空列表（状态机据此知道"用户不想要任何气泡"）。
      bubbleStates: s.bubble ? act.bubbleStates : []
    }
  }

  const machine = createPetState({
    config: machineConfig(),
    pickBubbleImage: (key, seed) => {
      if (!settings.get().bubble || !settings.get().bubbleImages) return null
      // 返回**整条记录**（含 `hasText`）而不只是路径：状态机需要知道这张图
      // 是否已经把文字画进去了，才决定要不要叠 Host 文案 ——
      // 自带中文的贴纸再叠一句，屏幕上会出现两段互相打架的文字（契约 §4）。
      return bubbleArt(atlas, seed)
    }
  })

  // 诊断信息（`/pet/diag` 暴露，用于区分"代码没生效"与"进程没重载"）。
  const diagnostics = {
    lastChangeAt: null,
    lastState: null,
    lastBubbleAt: null
  }

  /**
   * 发消息服务（`ctx.sessionController`）的**惰性解析**。
   *
   * 位置要求：必须早于 `withSettings` —— 后者每帧广播都会读它，
   * 而广播可能在装配早期就发生（`let`/`const` 声明晚于使用会踩暂时性死区）。
   *
   * ⚠️ **绝不能用 `ctx.inject` 在加载期拿这个服务**（这里踩过坑）：
   * `ctx.inject` 会**创建一个子 fiber**；子 fiber 失败时可能连带父插件一起被判定失败，
   * 而后面的**路由注册与 exe 启动会被一并回收** —— 症状是"桌宠不出现 + 设置页空白 +
   * 路由 404"三连，且 `try/catch` 抓不到（失败是异步的）。
   *
   * 而发消息**只在用户真的发送时才需要**，加载期不必知道它在不在。
   * 所以每次要用时现取；取不到就如实报不可用。
   */
  let sendServiceCache = null
  let sendMissingReason = '宿主未装配 sessionController 服务'
  const resolveSendService = () => {
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
      sendServiceCache = svc ?? null
      sendMissingReason = (svc === undefined || svc === null)
        ? '宿主未装配 sessionController 服务'
        : null
    } catch (error) {
      // `ctx.get` 在部分宿主实现上可能抛（服务未注册）。按不可用处理，不中断任何东西。
      sendServiceCache = null
      sendMissingReason = `取 sessionController 失败：${error?.message ?? error}`
    }
    return sendServiceCache
  }

  /**
   * exe 关心的设置子集（契约 §2 `snapshot.settings`）。
   *
   * **为什么只挑这几个**：快照每次变化都会广播，别把整个设置对象塞进去 ——
   * locale/happyMs/sleepMs 这类 exe 用不上的字段只会让 diff 噪音变大。
   */
  const exeSettings = () => {
    const s = settings.get()
    return {
      scale: s.scale,
      opacity: s.opacity,
      clickThrough: s.clickThrough,
      topmost: s.topmost,
      bubble: s.bubble,
      doubleClick: s.doubleClick,
      theme: s.theme
    }
  }

  /** 快照 + 设置 = 广播帧（exe 与 overlay 共用同一帧）。 */
  const withSettings = snap => ({
    ...snap,
    settings: exeSettings(),
    // 能力位：两半边的 ✎ 入口都靠它决定显不显示（**不做没入口的错误**）。
    // 每次广播时**现取**服务：它可能稍后才装配好，缓存一次会让入口永久消失。
    send: {
      available: resolveSendService() !== null,
      reason: sendMissingReason ?? null
    }
  })

  // 状态变化 → 广播。这是唯一的推送出口。
  const offChange = machine.on(snapshot => {
    diagnostics.lastChangeAt = new Date().toISOString()
    diagnostics.lastState = snapshot.petState
    if (snapshot.bubble !== null) diagnostics.lastBubbleAt = new Date().toISOString()
    hub.broadcast(withSettings(snapshot))
  })
  ctx.effect(() => () => offChange(), 'zhuang-fangyi-pet: state subscription')

  // 设置变化 → 也广播一帧。否则 exe 只能等下一次状态变化才知道设置改了
  //（用户改完大小盯着桌宠看，半天没反应，会以为坏了）。
  const offSettings = settings.subscribe(() => {
    try {
      // 先让状态机吃到新配置（活跃度/气泡时长/完成提醒都要**立刻**生效），
      // 再广播 —— 顺序反了的话，这一帧推的还是旧行为，用户会看到"改完没反应"。
      machine.setConfig(machineConfig())
      hub.broadcast(withSettings(machine.snapshot()))
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 设置变化广播失败（${error?.message ?? error}）`)
    }
  })
  ctx.effect(() => () => offSettings(), 'zhuang-fangyi-pet: settings subscription')

  // ── 事件桥：根 Context 收全部 scoped 事件（见 events.js 文件头）──────────
  const offEvents = bridgeHostEvents(ctx, machine, logger)
  ctx.effect(() => () => offEvents(), 'zhuang-fangyi-pet: host events')
  boot('状态机 + 事件桥已就绪')

  // ── 空闲驱动：`sleeping` 需要时间推进，纯事件驱动不会自己发生 ─────────────
  // 每 15s tick 一次足够（sleepMs 默认 5 分钟，精度要求很低）。
  const ticker = setInterval(() => {
    try {
      machine.tick()
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: tick 失败（${error?.message ?? error}）`)
    }
  }, 15000)
  ticker.unref?.()
  ctx.effect(() => () => clearInterval(ticker), 'zhuang-fangyi-pet: idle ticker')

  // ── 发消息能力：`ctx.sessionController`（GUI 发消息走的就是这条服务）────────
  //
  // 发消息服务（`ctx.sessionController`）已在上面以**惰性解析**方式准备就绪
  //（`resolveSendService`），这里不再建立任何加载期依赖。


  /**
   * 发一条消息到某个会话（**排队语义**，不打断当前回合）。
   *
   * 用 `followup`（mode 不给/非 steer）而非 `steer`：用户明确选了"排队，不打断"。
   *
   * @param {string} text
   * @param {string} sessionId
   * @returns {Promise<void>} 失败时抛错，由路由映射成 HTTP 状态码
   */
  const sendToSession = async (text, sessionId) => {
    const svc = resolveSendService()
    if (svc === null) {
      const error = new Error(sendMissingReason ?? '宿主未装配 sessionController 服务')
      error.code = 'unavailable'
      throw error
    }
    await svc.prompt({
      sessionId,
      content: [{ type: 'text', text }],
      // 每次发送一个唯一 id：Host 用它做去重（同 id 重试不会插入第二条）。
      requestId: `zf-pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      // 不传 mode ⇒ 走 `agent.followup`（排队）
    })
  }

  /**
   * 挑一个要发给它的会话。
   *
   * 优先用调用方指定的；否则用**最近活跃**的那个（就是桌宠此刻在为你演的那个会话）。
   * 状态机已经按会话记了 `lastEventAt`，直接复用它的记账，不另建一套认知。
   *
   * @param {string|undefined} requested
   * @returns {string|null} 没有可发会话时返回 null
   */
  const pickSessionId = requested => {
    if (typeof requested === 'string' && requested !== '') return requested
    const stats = machine.sessionStats()
    // 状态机把"事件没带 sessionId"归到字面量 `'unknown'`。**绝不能拿它去发消息** ——
    // 那不是一个真实会话，`prompt()` 必然 not-found；宁可回 409 说"没有可发的会话",
    // 也不要发一个注定失败、还可能让用户以为消息出去了的请求。
    const real = stats.find(s => s.sessionId !== 'unknown')
    return real !== undefined ? real.sessionId : null
  }

  // ── exe launcher ────────────────────────────────────────────────────────
  //
  // ⚠️ **必须容错**：启动器出错会把后面的**路由注册**一起带走（路由在它之后），
  // 症状是"桌宠不出现 + 设置页空白 + 路由 404"三连，而且看不出任何原因。
  // 所以这里失败只降级成"没有原生窗口"，绝不中断装配。
  let launcher = null
  try {
    launcher = createLauncher({
    ctx,
    pkgRoot: HERE,
    getSettings: () => settings.get(),
    getSnapshot: () => machine.snapshot(),
    token,
    logger,
    onStatus: status => {
      machine.apply({
        type: 'native/status',
        available: status.available,
        reason: status.reason ?? status.lastError ?? null
      })
    }
    })
  } catch (error) {
    boot(`⚠️ exe 启动器创建失败（已降级为无原生窗口）：${error?.stack ?? error}`)
    logger.warn?.(`zhuang-fangyi-pet: 启动器创建失败（已降级）：${error?.message ?? error}`)
    launcher = {
      status: { available: false, reason: `启动器创建失败：${error?.message ?? error}` },
      start: () => false,
      stop: () => {},
      restart: () => false,
      dispose: () => {}
    }
  }
  if (launcher !== null && typeof launcher.dispose === 'function') {
    ctx.effect(() => () => launcher.dispose(), 'zhuang-fangyi-pet: exe launcher')
  }
  boot(`exe 启动器已就绪（available=${launcher?.status?.available === true}）`)

  // ── 路由 ────────────────────────────────────────────────────────────────
  const handler = createHandler({
    // `/pet/state` 与 SSE 帧必须**同构**（都带 settings）：exe 断线降级轮询时
    // 拿到的设置不能和 SSE 推的不一样，否则轮询回退会把 scale 拉回旧值。
    snapshot: () => withSettings(machine.snapshot()),
    atlas: () => atlas,
    artDir: ART_DIR,
    token,
    hub,
    logger,
    diagnostics: () => ({
      build: PLUGIN_BUILD,
      ...diagnostics,
      launcher: launcher.status,
      nativeAvailable: machine.snapshot().nativeAvailable
    }),
    // `connection` 服务是可选的：拿不到就走结构围栏。
    connection: () => {
      try {
        return typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      } catch {
        return undefined
      }
    },
    onPosition: patch => {
      settings.update(patch)
    },
    /** 发消息（契约 §3 新增）。路由把抛出的错映射成状态码，见 routes.js。 */
    onSend: async (text, sessionId) => {
      const target = pickSessionId(sessionId)
      if (target === null) {
        const error = new Error('没有可发送的会话')
        error.code = 'no-session'
        throw error
      }
      await sendToSession(text, target)
      return { sessionId: target }
    },
    sendCapability: () => ({
      available: resolveSendService() !== null,
      reason: resolveSendService() !== null ? null : (sendMissingReason ?? '发消息能力不可用')
    }),
    getSettings: () => settings.get(),
    setSettings: next => {
      // **必须是合并，不是整体替换**：exe 的滚轮缩放只 POST `{"scale": n}` 一个字段，
      // 若走 replace（按默认值归一化），用户的透明度/穿透/主题/双击……会被**全部抹回默认**。
      // 实测过：POST {scale:0.5} 之后 theme/doubleClick 直接回到默认 —— 那是数据丢失。
      // `replace` 语义保留给"提交完整设置对象"的调用方；HTTP 补丁一律合并。
      const applied = settings.update(next)
      settings.flush()
      // 设置变了要让状态机跟着变（气泡开关、语言、时长、完成提醒）。
      machine.apply({ type: 'tick' })
      return applied
    },
    onCommand: command => {
      switch (command) {
        case 'reload-art':
          return atlasReport(reloadAtlas())
        case 'quit':
          launcher.stop()
          return { stopped: true }
        case 'restart':
          return { started: launcher.restart() }
        case 'focus-dsh':
          // 由 exe 侧执行（它才有 Win32 能力）；宿主只回执。
          return { handledBy: 'exe' }
        default:
          return { unknown: command }
      }
    }
  })

  /**
   * 挂路由。
   *
   * **必须用嵌套 `ctx.inject`**：`ctx.get('webServer')` 在 apply 期会拿到 undefined
   * （插件先于 webServer 发布加载），一次性取法会导致路由永不注册。
   * 这是本 profile 两个现有插件（主题插件、our-free-model）都记录过的坑。
   */
  ctx.inject(['webServer'], scoped => {
    boot('webServer 就绪，开始注册路由')
    const server = scoped.webServer
    try {
      scoped.effect(
        () => server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
        'zhuang-fangyi-pet: pet routes'
      )
      boot(`路由已注册：${ROUTE_PREFIX}（port=${server?.port ?? '?'}）`)
      logger.info?.(`zhuang-fangyi-pet: 路由已挂载于 ${ROUTE_PREFIX}`)
    } catch (error) {
      boot(`❌ 路由注册失败：${error?.stack ?? error}`)
      throw error
    }

    // 先广播一帧初始快照，再启动 exe。
    //
    // 为什么：hub 的 `hello` 只在**已有快照**时发送（绝不发空对象 `{}` ——
    // 那会让客户端拿到 undefined 的 petState/rev）。所以这里主动填一帧，
    // 让任何时刻连上来的客户端立刻知道现状，而不是干等下一次状态变化。
    hub.broadcast(withSettings(machine.snapshot()))

    // webServer 就绪 = 端口已知 = 可以启动 exe 了。
    if (settings.get().enabled && settings.get().mode !== 'overlay') {
      try {
        const started = launcher.start()
        if (!started) {
          logger.warn?.('zhuang-fangyi-pet: 原生窗口不可用，浏览器半边将渲染窗口内桌宠')
        }
        boot(`exe 启动尝试：started=${started}`)
      } catch (error) {
        boot(`⚠️ exe 启动抛错（已忽略）：${error?.stack ?? error}`)
      }
    } else {
      boot(`未启动 exe（enabled=${settings.get().enabled} mode=${settings.get().mode}）`)
    }
    boot('webServer inject 回调执行完毕')
  })
  boot('路由挂载已提交（等待 webServer 就绪）')

  // ── 对外暴露（供测试与其它插件读取）─────────────────────────────────────
  //
  // **必须容错**：这是一个便利出口，不是功能依赖。若宿主版本的 `set`/`provide`
  // 行为不同（或该名字已被占用），**绝不能让 `apply()` 中断** —— 那会让路由、
  // 事件桥、exe 启动全部不执行。主题插件正是被这类"可选位注册失败"坑过一次
  // （`client.js` 的 `safeInject` 注释里记着代价）。
  try {
    const exposed = {
      get build () {
        return PLUGIN_BUILD
      },
      snapshot: () => machine.snapshot(),
      atlas: () => atlasReport(atlas),
      settings: () => settings.get(),
      updateSettings: patch => settings.update(patch),
      launcher
    }
    if (typeof ctx.provide === 'function') {
      // `provide` 返回 disposer，交给 fiber 回收；`ctx.set` 没有回收语义。
      ctx.effect(() => ctx.provide('zhuangFangyiPet', exposed), 'zhuang-fangyi-pet: expose service')
    } else if (typeof ctx.set === 'function') {
      ctx.set('zhuangFangyiPet', exposed)
    }
  } catch (error) {
    logger.warn?.(`zhuang-fangyi-pet: 暴露 ctx.zhuangFangyiPet 失败（已忽略）：${error?.message ?? error}`)
  }

  boot('--- apply() 完成 ---')
  } // applyInner
}

export { SETTINGS_VERSION }