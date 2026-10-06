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
import { loadAtlas, artForState, bubbleArtByFile, atlasReport } from './src/pet/atlas.js'
import { pickEmoteFile, pickPoolEmote, EMOTE_BY_KEY } from './src/pet/emotes.js'
import { shortIdsFor } from './src/pet/shortid.js'
import { createHub } from './src/pet/hub.js'
import { createHandler, newToken, ROUTE_PREFIX } from './src/pet/routes.js'
import { createLauncher } from './src/pet/launcher.js'
import { createPomodoro } from './src/pet/pomodoro.js'
import { loadVoice, resolveVoice, voiceReport } from './src/pet/voice.js'
import { createAffection, INTERACT_KINDS, interactText, interactLabel } from './src/pet/interactions.js'
import {
  loadPersonas, applyPersona, readPersona, personaReport, DEFAULT_PERSONA_NAME
} from './src/pet/persona.js'
import {
  createChatState, extractAssistantText, bubbleText, validateChatText,
  DEFAULT_WORKSPACE_NAME
} from './src/pet/chat.js'

/** 插件标识（Loader 行 id、token 层 source 共用）。 */
export const name = 'zhuang-fangyi-pet'

/** 无硬依赖；`webServer` 由嵌套 inject 处理（见下）。 */
export const inject = []

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ART_DIR = path.join(HERE, 'art', 'pet')
const VOICE_DIR = path.join(HERE, 'art', 'voice')
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

  // ── 语音包：只读白名单，**运行时绝不合成**（见 voice.js 文件头）──────────
  //
  // 缺失是正常情况（没跑过 `build-voice.ps1`）—— 只是"没有声音"，
  // 不影响桌宠其它任何功能，所以 `loadVoice` 绝不抛。
  let voice = loadVoice(VOICE_DIR, logger)
  if (voice.count > 0) {
    boot(`语音包已加载：${voice.count} 条`)
  } else {
    boot('语音包为空（未跑过 tools/build-voice.ps1，桌宠静音运行）')
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

  /** 上一张按状态挑出来的表情（下次尽量不重复）。 */
  let lastEmoteFile = null

  /**
   * 挑一张气泡图（状态机唯一的选图入口）。
   *
   * 抽成具名函数是为了**能被真正测到**：`exposed.pickBubbleImage` 指向的就是
   * 它本身，状态机用的也是它 —— 不是手抄副本。
   */
  const pickBubbleImage = (key, seed) => {
    if (!settings.get().bubble || !settings.get().bubbleImages) return null
    // 返回**整条记录**（含 `hasText`）而不只是路径：状态机需要知道这张图
    // 是否已经把文字画进去了，才决定要不要叠 Host 文案 ——
    // 自带中文的贴纸再叠一句，屏幕上会出现两段互相打架的文字（契约 §4）。
    //
    // ⭐ 表情**结合状态**：先按 key 查语义映射（出错配生气、完成配庆祝），
    // 映射里没有这个 key 才回落到全池轮换。
    // 曾经这里是纯 `bubbleArt(atlas, seed)`（按索引取模、忽略 key），
    // 于是"刚报错就弹好耶""刚完成就弹庄一直哭"——用户直接反馈过。
    const emote = pickEmoteFile(key, seed, lastEmoteFile)
    if (emote !== null) {
      const rec = bubbleArtByFile(atlas, emote)
      if (rec !== null) {
        lastEmoteFile = rec.file
        return rec
      }
      // 映射里的文件在清单里不存在（素材被换过）→ 不要静默变成"没表情"，
      // 记一笔并回落到全池，免得整个状态哑掉。
      logger?.debug?.(`zhuang-fangyi-pet: 映射里的表情不在清单里：${emote}`)
    }
    // 全池兜底：用 `pickPoolEmote` 而不是 `bubbleArt` —— 后者是纯 index 取模，
    // **不认识排除名单**，会随机撒出「么么哒」「晚安啦」这类语义太强的图。
    // （这个名单以前只导出、只被测试引用，运行时从没读过，等于形同虚设。）
    const fallback = pickPoolEmote(atlas?.bubble, seed)
    if (fallback !== null) lastEmoteFile = fallback.file
    return fallback
  }

  const machine = createPetState({
    config: machineConfig(),
    pickBubbleImage
  })

  // ── 番茄钟（用户点名："增加番茄钟提醒我休息"）─────────────────────────────
  //
  // 它是**独立于 AI 状态**的一条时间线（见 `pomodoro.js` 文件头），
  // 所以这里只做三件事：把设置喂给它、按 tick 推进它、阶段结束时让桌宠说句话。
  //
  // 状态持久化在 `pomodoro.json`：DSH 重启（升级/重载插件）后番茄钟要能接着走，
  // 否则用户每次重启都丢进度。`adopt()` 自己处理"停机太久就作废"的边界。
  let pomodoroStore = null
  try {
    pomodoroStore = new JsonStore(path.join(dataDir, 'pomodoro.json'), null, { log: null })
  } catch (error) {
    logger.warn?.(`zhuang-fangyi-pet: 番茄钟状态无法持久化（${error?.message ?? error}）`)
  }

  /** 设置 → 番茄钟参数（抽成函数，热更新与启动共用同一份映射）。 */
  const pomodoroConfig = () => {
    const s = settings.get()
    return {
      enabled: s.pomodoro,
      focusMs: s.pomodoroFocusMs,
      breakMs: s.pomodoroBreakMs,
      longBreakMs: s.pomodoroLongBreakMs,
      roundsPerLongBreak: s.pomodoroRounds,
      autoNext: s.pomodoroAutoNext,
      notify: s.pomodoroNotify
    }
  }

  /**
   * 阶段切换 → 桌宠说话（气泡 + 表情 + 语音）。
   *
   * 只在 `kind === 'end'` 时提醒：`start` 事件也发出来了（exe 的倒计时切换要用），
   * 但"开始专注"不值得每次都弹一条 —— 用户自己按的，他知道。
   * 例外是**休息结束**：那是"该回来干活了"，值得提醒。
   */
  const onPomodoroTransition = event => {
    try {
      if (pomodoroStore !== null) {
        pomodoroStore.value = pomodoro.persist(Date.now())
        pomodoroStore.schedule()
      }
      if (event?.kind === 'start') {
        // 只有"休息结束、回到专注"这一种 start 值得提醒（用户可能离开过）。
        if (event.phase === 'focus' && pomodoroConfig().notify) {
          machine.notify({
            key: 'pomodoro/break-end',
            state: 'waking',
            priority: 96,
            durationMs: 5000
          })
        }
        return
      }
      if (event?.kind !== 'end') return
      if (!pomodoroConfig().notify) return
      // 结束的三种：专注结束（该休息）、短休结束、长休结束。
      const key = event.phase === 'focus'
        ? 'pomodoro/focus-end'
        : (event.phase === 'long-break' ? 'pomodoro/long-end' : 'pomodoro/break-end')
      // 专注结束用 `waiting`（"该你动一下了"），休息结束用 `happy`（"回来啦"）。
      machine.notify({
        key,
        state: event.phase === 'focus' ? 'waiting' : 'happy',
        priority: 96,
        durationMs: 8000
      })
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 番茄钟提醒失败（${error?.message ?? error}）`)
    }
  }

  const pomodoro = createPomodoro({
    config: pomodoroConfig(),
    onTransition: onPomodoroTransition
  })
  // 恢复上次的进度（`adopt` 内部处理"停机太久 → 作废本轮且不补通知"）。
  if (pomodoroStore !== null && pomodoroStore.get() !== null) {
    try {
      pomodoro.adopt(pomodoroStore.get(), Date.now())
    } catch (error) {
      boot(`⚠️ 番茄钟状态恢复失败（已忽略）：${error?.message ?? error}`)
    }
  }

  // ── 互动与好感度（用户点名："增加一些互动"）───────────────────────────────
  //
  // 纯逻辑在 `src/pet/interactions.js`（防刷的三道闸都在那里，有 27 条单测）。
  // 这里只做三件事：持久化、把互动变成"桌宠说一句话"、把状态放进快照。
  let affectionStore = null
  try {
    affectionStore = new JsonStore(path.join(dataDir, 'affection.json'), null, { log: null })
  } catch (error) {
    logger.warn?.(`zhuang-fangyi-pet: 好感度无法持久化（${error?.message ?? error}）`)
  }

  const affection = createAffection()
  if (affectionStore !== null && affectionStore.get() !== null) {
    try {
      affection.adopt(affectionStore.get())
    } catch (error) {
      boot(`⚠️ 好感度恢复失败（已忽略）：${error?.message ?? error}`)
    }
  }

  /**
   * 最近一次互动（**给 exe 的一次性信号**）。
   *
   * 为什么放在快照里而不是让 exe 自己轮询：互动是"用户点了"这个瞬时事件，
   * exe 需要**恰好播一次**语音。用一个递增的 `seq` 让 exe 判"这是新的一次"，
   * 比时间戳可靠（同一毫秒两次互动也不会漏）。
   */
  let lastInteract = null
  let interactSeq = 0

  // ── 聊天（用户点名："可以与桌宠聊天"）───────────────────────────────────
  //
  // 设计：**专用工作区 + 专用会话**，而不是另起一套 LLM 调用。
  //   · 人设**优先走系统提示词 section**（会话级替换，见下 `applyChatPersona`）；
  //   · 宿主不支持时退回 AGENTS.md（`dsh-agent-instructions` 自动加载）；
  //   · 用户能在 DSH 界面里看到这段对话、接着聊、翻历史，那才是"聊天"。
  //
  // 人设**可切换**（用户明确要求"人设、性格要作为可调的，因为我有好多种提示词"）：
  // 切换 = 把人设文件同步进工作区 `AGENTS.md`（见 `persona.js` 的安全约束）。
  const PERSONAS_DIR = path.join(dataDir, 'personas')

  let chatStore = null
  try {
    chatStore = new JsonStore(path.join(dataDir, 'chat.json'), null, { log: null })
  } catch (error) {
    logger.warn?.(`zhuang-fangyi-pet: 聊天状态无法持久化（${error?.message ?? error}）`)
  }
  const chat = createChatState()
  if (chatStore !== null && chatStore.get() !== null) {
    try { chat.adopt(chatStore.get()) } catch { /* 坏数据按新建处理 */ }
  }

  /**
   * 当前挂在聊天会话上的人设 section（`{sessionId, persona, dispose}` 或 null）。
   *
   * 同名 section 在同一作用域注册两次会抛，所以换人设/换会话前必须先
   * dispose 旧的 —— 这个状态就是那本账。
   */
  let personaSection = null

  /**
   * **首次运行播种**：把包里的人设样例（用户提供的庄方宜完整人设）放进
   * `personas/`，让 `default` 一开始就是真角色而不是空壳。
   *
   * 只在**目录为空**时播种：之后用户删掉它（想换自己的）不该被复活，
   * 用户改过它更不该被覆盖 —— 那是不可逆的数据丢失。
   */
  const seedPersonas = () => {
    try {
      // 先建目录：**首次运行时它还不存在**（readdir 会 ENOENT），
      // 不先建的话播种永远不生效 —— 而那是这条功能唯一的一次执行机会。
      fs.mkdirSync(PERSONAS_DIR, { recursive: true })
      const existing = fs.readdirSync(PERSONAS_DIR).filter(f => f.toLowerCase().endsWith('.md'))
      if (existing.length > 0) return
      const seed = path.join(HERE, 'personas-seed', 'default.md')
      if (!fs.existsSync(seed)) return
      fs.copyFileSync(seed, path.join(PERSONAS_DIR, 'default.md'))
      boot('人设目录为空 → 已播种内置的庄方宜人设（default.md）')
    } catch (error) {
      boot(`人设播种失败（已忽略）：${error?.message ?? error}`)
    }
  }
  seedPersonas()
  let personas = loadPersonas(PERSONAS_DIR, logger)
  boot(`人设已加载：${personas.items.length} 份（目录 ${PERSONAS_DIR}）`)

  /** 当前选中的人设（设置项；`default` = 内置）。 */
  const currentPersona = () => {
    const name = settings.get().persona
    return typeof name === 'string' && name !== '' ? name : DEFAULT_PERSONA_NAME
  }

  /**
   * 聊天工作区目录。
   *
   * 默认放在**用户的下载目录**下（`~/Downloads/庄方宜`）—— 用户一眼能找到，
   * 而不是藏在 `$DSH_HOME` 里。设置项可改。
   */
  const chatWorkspace = () => {
    const configured = settings.get().chatWorkspace
    if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
    let base = null
    try { base = os.homedir() } catch { base = null }
    if (base === null) base = dataDir
    return path.join(base, 'Downloads', DEFAULT_WORKSPACE_NAME)
  }

  /** 只建目录（`create({cwd})` 需要它存在）；**不写 AGENTS.md**。 */
  const ensureWorkspaceDir = () => {
    const dir = chatWorkspace()
    try {
      fs.mkdirSync(dir, { recursive: true })
      return { ok: true, dir }
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 聊天工作区创建失败（${error?.message ?? error}）：${dir}`)
      return { ok: false, reason: 'mkdir-failed', dir }
    }
  }

  // ── 人设 → 系统提示词（**会话级替换**）─────────────────────────────────────
  //
  // 机制（实测自宿主源码 `@deepseek-ai/dsh-system-prompt`）：
  //   · `systemPrompt.section({name, order, text})` 注册一段系统提示词；
  //   · **同名 scoped section 遮蔽全局** —— 源码注释原文：
  //     "for a per-agent override, register through that agent's `agent.ctx` instead"；
  //   · `deployment:persona-prefix`（order 0）就是**官方人设槽位**：
  //     "an agent preset shadows the deployment's persona with its own"。
  //
  // 所以：把人设注册到**聊天会话那个 agent 的作用域**里、用官方人设槽位的名字
  // —— 替换只发生在这一个会话，别的会话（你的工作会话）完全不受影响。
  // 这正是"仅在聊天中替换"的宿主原生实现。
  //
  // 兜底：宿主没有 `resolveAgent` / agent 作用域拿不到 `systemPrompt` 时，
  // 退回 AGENTS.md 方案（写进聊天工作区，`dsh-agent-instructions` 会加载它）。
  const PERSONA_SECTION_NAME = 'deployment:persona-prefix'

  /**
   * 给聊天会话注册/更新人设 section。
   *
   * @param {string} sessionId
   * @returns {Promise<{mode: 'section'|'agents'|'none', reason?: string}>}
   */
  const applyChatPersona = async sessionId => {
    const name = currentPersona()
    const body = readPersona(PERSONAS_DIR, name, logger)
    if (body === null) return { mode: 'none', reason: 'unknown-persona' }
    const svc = resolveSendService()
    if (svc === null || typeof svc.resolveAgent !== 'function') {
      return { mode: 'agents', reason: 'no-resolveAgent' }
    }
    try {
      const resolved = await svc.resolveAgent(sessionId)
      const agent = resolved?.agent ?? resolved?.value?.agent ?? null
      const actx = agent?.ctx ?? null
      if (actx === null) return { mode: 'agents', reason: 'no-agent' }
      // ⚠️ 读取未声明服务在 cordis 上会**抛**（可选链防不住）——所以必须 try。
      let sp = null
      try {
        sp = typeof actx.get === 'function' ? actx.get('systemPrompt') : undefined
      } catch { sp = null }
      if (sp === null || sp === undefined || typeof sp.section !== 'function') {
        return { mode: 'agents', reason: 'no-systemPrompt' }
      }
      const order = typeof sp.getSectionOrder === 'function'
        ? sp.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
        : 0
      // `interpolate: false`：人设正文里的 `{{` 保持字面（否则会被当成变量引用，
      // 未定义的引用会让整次组装**抛错** —— 用户的人设里出现双花括号是迟早的事）。
      const dispose = sp.section({
        name: PERSONA_SECTION_NAME,
        order: Number.isFinite(order) ? order : 0,
        text: '本会话的角色设定如下；它取代默认的助手人设。除工具调用等运行规范外，'
          + '请始终以该角色的身份、语气与知识边界回应。\n\n' + body.trim(),
        interpolate: false
      })
      if (personaSection !== null && personaSection.dispose !== null) {
        try { personaSection.dispose() } catch { /* 旧会话已没了 */ }
      }
      personaSection = {
        sessionId,
        persona: name,
        dispose: typeof dispose === 'function' ? dispose : null
      }
      boot(`人设已作为系统提示词注册到聊天会话（${name}，section=${PERSONA_SECTION_NAME}）`)
      return { mode: 'section' }
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 人设 section 注册失败（退回 AGENTS.md）：${error?.message ?? error}`)
      return { mode: 'agents', reason: 'section-failed' }
    }
  }

  /** 把人设写进工作区 AGENTS.md（**兜底路径**；section 路成功时不走这里）。 */
  const writePersonaAgentsMd = () => {
    const dir = chatWorkspace()
    const name = currentPersona()
    const result = applyPersona({ workspaceDir: dir, personaDir: PERSONAS_DIR, name, logger })
    if (!result.ok) {
      // `user-file` 是**唯一可接受的失败**：用户在那儿手写了 AGENTS.md，
      // 我们尊重它（聊天照常能用，只是人设不由我们管）。
      if (result.reason === 'user-file') {
        boot(`聊天工作区已有用户手写的 AGENTS.md，不改动它：${dir}`)
        return { ok: true, dir, reason: 'user-file' }
      }
      logger.warn?.(`zhuang-fangyi-pet: 人设写入失败（${result.reason}）：${dir}`)
      return { ok: false, reason: result.reason, dir }
    }
    return { ok: true, dir, file: result.file }
  }

  // 插件卸载 → 收掉挂着的 section。**不收的话**：宿主重载插件后旧的
  // `deployment:persona-prefix` scoped section 还在会话作用域里，
  // 新的一次注册又会插一份（或撞名抛错）—— 人设就泄漏到别的会话去了。
  ctx.effect(() => () => {
    if (personaSection !== null && personaSection.dispose !== null) {
      try { personaSection.dispose() } catch { /* 会话已经没了 */ }
    }
    personaSection = null
  }, 'zhuang-fangyi-pet: chat persona section')

  /**
   * 解析聊天会话服务并**确保会话存在**。
   *
   * `sessionController.create({cwd, sessionId})` 是"创建或**幂等采纳**"语义，
   * 所以重启后拿同一个 sessionId 再调一次就能接上原来的对话。
   */
  const ensureChatSession = async () => {
    const svc = resolveSendService()
    if (svc === null) {
      const error = new Error(sendMissingReason ?? '宿主未装配 sessionController 服务')
      error.code = 'unavailable'
      throw error
    }
    if (typeof svc.create !== 'function') {
      const error = new Error('宿主未提供 sessionController.create（无法新建聊天会话）')
      error.code = 'unavailable'
      throw error
    }
    const ws = ensureWorkspaceDir()
    if (!ws.ok) {
      const error = new Error('聊天工作区目录创建失败')
      error.code = 'no-session'
      throw error
    }
    // 已有会话（新建过或重启采纳的）：只需保证人设 section 挂在它身上。
    if (chat.sessionId !== null) {
      const applied = await applyChatPersona(chat.sessionId)
      if (applied.mode === 'agents') writePersonaAgentsMd()   // 兜底
      return chat.sessionId
    }
    const created = await svc.create({ cwd: ws.dir })
    const id = created?.sessionId ?? created?.id ?? null
    if (typeof id !== 'string' || id === '') {
      const error = new Error('sessionController.create 没有返回 sessionId')
      error.code = 'no-session'
      throw error
    }
    chat.setSession(id)
    if (chatStore !== null) {
      chatStore.value = chat.persist()
      chatStore.flush()
    }
    // 人设：优先走**会话级 section**（真正替换系统提示词、只影响这个会话）；
    // 宿主不支持时退回 AGENTS.md。
    const applied = await applyChatPersona(id)
    if (applied.mode === 'agents') {
      const md = writePersonaAgentsMd()
      boot(`聊天会话已建立：${id}（人设走 AGENTS.md：${md.ok ? 'ok' : md.reason}）`)
    } else {
      boot(`聊天会话已建立：${id}（人设走系统提示词 section）`)
    }
    return id
  }

  /**
   * 发一条聊天消息（**排队语义**，与气泡输入框一致）。
   *
   * ⚠️ `prompt()` 的两条必填约束与 `sendToSession` 完全相同
   * （`mode` + 真 `AbortSignal`）—— 那个坑踩过两次，这里绝不重犯。
   */
  const sendChat = async rawText => {
    const v = validateChatText(rawText)
    if (!v.ok) {
      const error = new Error(v.reason === 'too-long' ? '消息太长' : '消息不能为空')
      error.code = v.reason === 'too-long' ? 'too-long' : 'empty'
      throw error
    }
    const sessionId = await ensureChatSession()
    const svc = resolveSendService()
    await svc.prompt({
      sessionId,
      content: [{ type: 'text', text: v.text }],
      requestId: `zf-pet-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      mode: 'queue'
    }, new AbortController().signal)
    chat.markSent()
    if (chatStore !== null) {
      chatStore.value = chat.persist()
      chatStore.schedule()
    }
    return { sessionId }
  }

  /**
   * 记一次互动：算好感 → 让桌宠说话（气泡 + 表情 + 语音）。
   *
   * ⚠️ **冷却中也要有反应**（`interactions.js` 的 `accepted` 语义）：
   * 点了没反应比"没涨分"更像坏了。只有未知动作才真的拒绝。
   *
   * @param {string} kind - `pet-head` | `feed` | `praise` | `click`
   * @returns {object} 给路由的响应体
   */
  const doInteract = (kind, at = Date.now()) => {
    const result = affection.interact(kind, at)
    if (!result.accepted) return { ok: false, error: 'unknown-kind', allowed: INTERACT_KINDS }

    // 持久化（含冷却与今日记账 —— 缺了它们"重启刷新冷却"就成了后门）。
    if (affectionStore !== null) {
      affectionStore.value = affection.persist(at)
      affectionStore.schedule()
    }

    // 让桌宠说话。文案取自互动配置（click 故意为 null = 不弹气泡，
    // 它太频繁，弹气泡会刷屏 —— 但它仍然有语音与表情）。
    try {
      const locale = settings.get().locale
      const text = interactText(kind, locale)
      machine.notify({
        key: `interact/${kind}`,
        // 情绪：夸奖/投喂是开心的，摸摸头/打招呼是平静的。
        state: kind === 'praise' || kind === 'feed' ? 'happy' : 'listening',
        text: text ?? undefined,
        priority: 94,
        durationMs: 5000
      })
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 互动气泡失败（${error?.message ?? error}）`)
    }

    // 语音：交给 exe 播（Host 只告诉它"哪个事件"）。
    // ⚠️ 这里**不直接播** —— Host 没有音频能力，且播放去重/节流在 exe 侧。
    // 通过快照里的 `interact` 块把"刚发生的互动"传过去（见 `withSettings`）。
    lastInteract = {
      seq: ++interactSeq,
      kind,
      voice: result.voice,
      label: interactLabel(kind),
      at
    }

    return {
      ok: true,
      kind,
      label: interactLabel(kind),
      gain: result.gain,
      cooling: result.cooling,
      dailyCapped: result.dailyCapped,
      tierChanged: result.tierChanged,
      affection: affection.snapshot(at),
      /** exe 据此播语音（`pet/*` 事件名）。 */
      voice: result.voice,
      text: result.text
    }
  }

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
      theme: s.theme,
      // 状态显示：原生窗要有和 overlay 一样的「悬停显示 / 常显」能力。
      // 原先只有 overlay 用这两个字段，exe 拿到了快照里的 label 却没人用 ——
      // 桌面版桌宠因此完全没有状态文字。
      hint: s.hint,
      statusAlways: s.statusAlways,
      // 番茄钟倒计时是否常显（独立于 statusAlways：那是"状态文字"，
      // 这是用户主动开的计时器，两者可以各自开关）。
      pomodoroCountdown: s.pomodoroCountdown,
      // 语音总开关（默认关：桌宠突然开口是强打扰，用户主动打开才生效）。
      voice: s.voice
    }
  }

  /**
   * 会话列表（给"发送到哪个对话"的选择器用）。
   *
   * ── 为什么需要它 ────────────────────────────────────────────────────────
   *
   * 发消息本来就**可以**指定会话（`/pet/send` 一直支持 `sessionId`），
   * 但界面上没得选 —— 更根本的是：`sessionId` 是一串不透明的乱码，
   * 直接把状态机的会话列表摆给用户，他也不知道哪个是哪个。
   *
   * ── 名字从哪来 ─────────────────────────────────────────────────────────
   *
   * DSH 的 `sessionController.list()` 返回 `{ items: SessionSummary[] }`，
   * 标题在 `item.projections.values.title`（会话标题投影）。
   * 回退顺序照抄 DSH 自己的 `displayTitleOf`：**标题 → 工作目录名 → id 前缀**。
   * 不自己发明一套，免得和外壳里显示的名字对不上。
   *
   * ── 为什么带缓存 ────────────────────────────────────────────────────────
   *
   * `withSettings()` 在**每次广播**时都会调用（状态一变就广播），
   * 而 `list()` 会读持久化 header —— 绝不能挂在热路径上。
   * 所以缓存 5 秒；**失败也记时间戳**，避免每帧去撞一个坏掉的服务。
   */
  const SESSION_LIST_TTL_MS = 5000
  let sessionListCache = { at: 0, items: [] }

  /** 从 cwd 取目录名（DSH 的 displayTitleOf 同款回退）。 */
  const basenameOf = p => {
    if (typeof p !== 'string' || p === '') return null
    const parts = p.replace(/[\\/]+$/, '').split(/[\\/]+/)
    return parts.length > 0 && parts[parts.length - 1] !== '' ? parts[parts.length - 1] : null
  }

  /** 短 id（无法命名时的最后回退）。 */
  /**
   * 给会话起个能认出来的名字。纯函数（测试直接断言回退顺序），不碰 IO。
   * @param {object} item - `SessionSummary`
   * @returns {string} 一定有值（最差是 id 前缀）
   */
  const titleOfSummary = (item, short) => {
    if (item === null || typeof item !== 'object') return ''
    const proj = item.projections?.values
    const t = proj?.title
    if (typeof t === 'string' && t.trim() !== '') return t.trim()
    const base = basenameOf(item.cwd)
    if (base !== null) return base
    // 最差回落到短标识（由调用方**整批**算好，见 shortIdsFor）
    return short ?? item.sessionId ?? ''
  }

  /**
   * 取会话列表（带 TTL 缓存）。**绝不抛** —— 取不到就退回状态机自己记的会话，
   * 至少让用户能按"哪个在忙"来选。
   */
  const sessionChoices = snap => {
    const live = Array.isArray(snap?.sessions) ? snap.sessions : []
    const now = Date.now()
    if (now - sessionListCache.at > SESSION_LIST_TTL_MS) {
      sessionListCache = { at: now, items: sessionListCache.items }
      const svc = resolveSendService()
      if (svc !== null && typeof svc.list === 'function') {
        // 不 await：广播是同步路径。拿回来更新缓存，下次广播自然带上。
        Promise.resolve()
          .then(() => svc.list({}))
          .then(value => {
            const items = Array.isArray(value?.items) ? value.items : (Array.isArray(value) ? value : [])
            // 整批算短标识：算法要看到**全部** id 才能推出公共前缀（见 shortIdsFor）
            const shortMap = shortIdsFor(items.map(it => it?.sessionId))
            sessionListCache = {
              at: Date.now(),
              items: items
                .filter(it => it !== null && typeof it === 'object' && typeof it.sessionId === 'string')
                .map(it => ({
                  sessionId: it.sessionId,
                  title: titleOfSummary(it, shortMap.get(it.sessionId)),
                  running: it.running === true,
                  updatedAt: typeof it.updatedAt === 'number' ? it.updatedAt : null,
                  // 层级信息：子代理会话不是"对话"，选择器要排除它们。
                  subagent: it.origin === 'subagent' || typeof it.parentSessionId === 'string',
                  blank: it.blank === true,
                  // 项目分组：同一 cwd 下的会话归一组（用户说"没有层级"，
                  // 而会话天然是按项目聚在一起的 —— 385 个会话里绝大多数 cwd 相同）。
                  cwd: typeof it.cwd === 'string' ? it.cwd : null,
                  project: basenameOf(it.cwd)
                }))
            }
          })
          .catch(error => {
            // 失败也记时间戳：否则每帧都会重试一个坏掉的服务。
            logger?.debug?.(`zhuang-fangyi-pet: 会话列表读取失败（${error?.message ?? error}）`)
            sessionListCache = { at: Date.now(), items: sessionListCache.items }
          })
      }
    }

    // 以**状态机记的活跃会话**为准（它是实时的），标题从缓存里补。
    //
    // 先把最终要发出去的**全部**会话 id 收齐，再整批算短标识 ——
    // 算法依赖"看到全集"才能推出公共前缀（见 shortIdsFor）。
    const byId = new Map(sessionListCache.items.map(it => [it.sessionId, it]))
    const liveReal = live.filter(s => s.sessionId !== 'unknown')
    const rest = [...byId.values()]
      .filter(it => it.subagent !== true && it.blank !== true)
      // 按**项目**聚拢（同项目相邻），项目内按更新时间倒序 —— 这样选择器分组后
      // 顺序稳定，用户能靠"位置"记住常发的那个对话。
      .sort((a, b) => {
        const pa = a.project ?? ''
        const pb = b.project ?? ''
        if (pa !== pb) return pa < pb ? -1 : 1
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
      })
      .slice(0, 20)
    const shortAll = shortIdsFor([
      ...liveReal.map(s => s.sessionId),
      ...rest.map(it => it.sessionId)
    ])

    const out = []
    for (const s of liveReal) {
      const meta = byId.get(s.sessionId)
      out.push({
        sessionId: s.sessionId,
        title: meta?.title ?? shortAll.get(s.sessionId) ?? s.sessionId,
        state: s.state,
        running: meta?.running === true || s.state === 'working' || s.state === 'thinking',
        updatedAt: meta?.updatedAt ?? null,
        // 项目分组（选择器按它做层级）
        project: meta?.project ?? null,
        // 保留状态机原有的字段：老渲染方（旧 exe/overlay）只认这几个，不能丢。
        toolsInFlight: s.toolsInFlight ?? 0
      })
      byId.delete(s.sessionId)
    }
    // 缓存里有、状态机没记的（例如刚重启过）也列出来，按更新时间排在后面。
    //
    // ⚠️ 必须**限量且过滤子代理**：真机上 `list()` 能返回 300+ 个历史会话，
    // 全塞进下拉里既没法选（大量同名）也不是用户想发消息的对象。
    //  · 子代理会话（origin=subagent / 有 parentSessionId）**不是对话**，排除；
    //  · 空会话（blank）没有内容，排除；
    //  · 只留最近活跃的一小批（用户要发消息的多半是最近在聊的）。
    for (const it of rest) {
      out.push({
        sessionId: it.sessionId,
        title: it.title,
        state: 'idle',
        running: it.running === true,
        updatedAt: it.updatedAt,
        project: it.project ?? null
      })
    }
    return disambiguate(out)
  }

  /**
   * 同名消歧。
   *
   * ── 为什么需要 ──────────────────────────────────────────────────────────
   *
   * 真机上会话标题大量重复（截图里 11 个都叫「精确中文画面文字转录（OCR）」）——
   * 因为标题默认取自首条消息，而用户会反复发同一句话。
   * 光看名字根本选不出该发哪一个，这正是用户说的"没有展示层级"的实际后果。
   *
   * 做法：**只在重名时**给这些项补一个短 id 后缀（唯一且稳定）。
   * 名字唯一时不加后缀，保持清爽。
   */
  const disambiguate = list => {
    const seen = new Map()
    for (const it of list) {
      seen.set(it.title, (seen.get(it.title) ?? 0) + 1)
    }
    const dupIds = list.filter(it => (seen.get(it.title) ?? 0) > 1).map(it => it.sessionId)
    if (dupIds.length === 0) return list
    // 只对**重名的那批**算短标识：算法在子集上求公共前缀，
    // 所以这批之间一定拿得到互不相同的后缀（这正是消歧需要的）。
    const shorts = shortIdsFor(dupIds)
    for (const it of list) {
      if ((seen.get(it.title) ?? 0) > 1) {
        it.title = `${it.title} · ${shorts.get(it.sessionId) ?? it.sessionId}`
      }
    }
    return list
  }

  /**
   * 画廊数据（右键「表情包…」用）。
   *
   * 返回**清单里的全部气泡** + 每张的语义分组，让用户能主动看全 ——
   * 在此之前 41 张只能靠"状态变化时随机撒"，用户反馈"这么久都没看全"。
   *
   * 只发渲染方需要的最小字段（file/hasText/opaque/fileDark + 分组名），
   * 不带几何（那是气泡定位用的，画廊按网格排版）。
   */
  const gallery = () => {
    const pool = Array.isArray(atlas?.bubble) ? atlas.bubble : []
    const groupOf = new Map()
    for (const [key, files] of Object.entries(EMOTE_BY_KEY)) {
      for (const f of files) {
        // 同一张图可能属于多个情境，保留第一个（列表顺序即"主要情境"）
        if (!groupOf.has(f)) groupOf.set(f, key)
      }
    }
    return pool.map(entry => ({
      file: entry.file,
      hasText: entry.hasText === true,
      opaque: entry.opaque === true,
      fileDark: typeof entry.fileDark === 'string' ? entry.fileDark : null,
      /** 主要情境（用于画廊分组与说明）；未归类的为 null。 */
      group: groupOf.get(entry.file) ?? null
    }))
  }
  /** 快照 + 设置 = 广播帧（exe 与 overlay 共用同一帧）。 */
  const withSettings = snap => ({
    ...snap,
    settings: exeSettings(),
    // 番茄钟块：**每帧都带上**（exe 用它显示倒计时，overlay 忽略）。
    // 与 `settings` 同一条通道，exe 断线降级轮询时拿到的也是同一份。
    pomodoro: pomodoro.snapshot(Date.now()),
    // 好感度（exe 显示档位；overlay 忽略）。
    affection: affection.snapshot(),
    /**
     * 最近一次互动 —— exe 靠 `seq` 判"这是新的一次"从而**恰好播一次**语音。
     *
     * 为什么不放时间戳：同一毫秒内两次互动（比如快速点了两下不同按钮）
     * 时间戳相同，exe 会漏掉第二次。递增序号不会。
     */
    interact: lastInteract,
    // 会话列表：给"发送到哪个对话"的选择器用（见 `sessionChoices`）。
    sessions: sessionChoices(snap),
    // 能力位：两半边的 ✎ 入口都靠它决定显不显示（**不做没入口的错误**）。
    // 每次广播时**现取**服务：它可能稍后才装配好，缓存一次会让入口永久消失。
    send: {
      available: resolveSendService() !== null,
      reason: sendMissingReason ?? null
    },
    /**
     * 聊天能力位（契约 §2 v9，additive）。
     *
     * exe 的输入窗靠它决定"聊天"那个选项显不显示 ——
     * **给了入口但点了必失败是最糟的交互**（✎ 按钮当初就是为此用能力位控制的）。
     */
    chat: {
      available: resolveSendService() !== null && settings.get().chatEnabled === true,
      /** 设置里的总开关（与 available 分开：一个"宿主不行"、一个"用户不要"）。 */
      enabled: settings.get().chatEnabled === true,
      reason: resolveSendService() !== null
        ? (settings.get().chatEnabled === true ? null : '聊天已在设置里关闭')
        : (sendMissingReason ?? null),
      /** 当前人设（exe 的提示语里可以显示）。 */
      persona: currentPersona()
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

  /**
   * 原生窗口**该不该在跑** —— 唯一判据，启动与设置变化共用。
   *
   * 抽成纯函数是有意的：以前这个条件只写在启动那一刻，
   * 于是"改设置"和"启动"会各判各的，早晚分叉（事实上已经分叉了：
   * 关掉总开关只停了 overlay，桌面那只还在）。
   */
  const nativeWanted = () => {
    const s = settings.get()
    return s.enabled === true && s.mode !== 'overlay'
  }

  /** 让 exe 的存活状态与 `nativeWanted()` 一致（幂等：已一致就什么都不做）。 */
  const syncNativeProcess = () => {
    const want = nativeWanted()
    const running = launcher.status.running === true
    if (want === running) return
    try {
      if (want) {
        const started = launcher.start()
        boot(`exe 启动（设置变化触发）：started=${started}`)
        if (!started) {
          logger.warn?.('zhuang-fangyi-pet: 原生窗口不可用，浏览器半边将渲染窗口内桌宠')
        }
      } else {
        launcher.stop()
        boot('exe 已停止（enabled=false 或 mode=overlay）')
      }
    } catch (error) {
      // 启停失败不该影响设置本身已生效这件事（overlay 仍会按新设置渲染）。
      boot(`⚠️ exe 启停失败（已忽略）：${error?.stack ?? error}`)
    }
  }

  // 设置变化 → 也广播一帧。否则 exe 只能等下一次状态变化才知道设置改了
  //（用户改完大小盯着桌宠看，半天没反应，会以为坏了）。
  const offSettings = settings.subscribe(() => {    try {
      // 先让状态机吃到新配置（活跃度/气泡时长/完成提醒都要**立刻**生效），
      // 再广播 —— 顺序反了的话，这一帧推的还是旧行为，用户会看到"改完没反应"。
      machine.setConfig(machineConfig())
      // 番茄钟同理：设置页把专注从 25 分改成 30 分要立刻生效。
      // `setConfig` 自己保证"跑着的时候不动当前阶段的剩余时间"。
      pomodoro.setConfig(pomodoroConfig())
      hub.broadcast(withSettings(machine.snapshot()))
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 设置变化广播失败（${error?.message ?? error}）`)
    }
    // 总开关与显示模式**必须在宿主侧生效** —— exe 是被 spawn 出来的进程，
    // 它自己不认 `enabled`（宿主也没把这个字段发给它），所以"关掉总开关"
    // 以前只停了 overlay，**桌面那只还杵在那儿**：用户会以为开关坏了。
    syncNativeProcess()
  })
  ctx.effect(() => () => offSettings(), 'zhuang-fangyi-pet: settings subscription')

  // ── 事件桥：根 Context 收全部 scoped 事件（见 events.js 文件头）──────────
  const offEvents = bridgeHostEvents(ctx, machine, logger)
  ctx.effect(() => () => offEvents(), 'zhuang-fangyi-pet: host events')
  boot('状态机 + 事件桥已就绪')

  // ── 聊天回复 → 桌宠气泡 ─────────────────────────────────────────────────
  //
  // ⚠️ **单独订阅，不走状态机**：状态机是"AI 在干什么"的聚合（它故意不看
  // 消息正文 —— 那是一条硬不变式）。而聊天需要**正文**，所以这里另开一条
  // 只服务于聊天的通道，且**只认聊天会话**（`chat.accept` 做过滤）。
  //
  // 为什么不用 `assistant/chunk` 逐字拼：气泡要的是"说完了的整句"，
  // 逐字拼会弹出一堆半截话。用 `assistant/message`（一条完整消息）。
  const wireChatEvent = (name, handler) => {
    try {
      const off = ctx.on(name, handler)
      if (typeof off === 'function') {
        ctx.effect(() => () => off(), `zhuang-fangyi-pet: chat ${name}`)
      }
    } catch (error) {
      // 事件名在旧版本可能不存在 —— 跳过，绝不让插件瘫掉（与 events.js 同一纪律）。
      logger.debug?.(`zhuang-fangyi-pet: 聊天事件 ${name} 订阅失败（已跳过）：${error?.message ?? error}`)
    }
  }

  const onAssistantMessage = (session, payload) => {
    try {
      const sid = typeof session === 'string'
        ? session
        : (session?.sessionId ?? session?.id ?? payload?.sessionId ?? null)
      // 回合标识：优先用事件里的 turn，拿不到就用"消息 id"或时间戳兜底。
      const turnKey = payload?.turn ?? payload?.turnId ?? payload?.message?.id ??
        payload?.id ?? `${sid}:${Date.now()}`
      if (!chat.accept(sid, turnKey)) return
      const text = extractAssistantText(payload)
      if (text === null) return
      const line = bubbleText(text)
      if (line === null) return
      chat.markReply()
      if (chatStore !== null) {
        chatStore.value = chat.persist()
        chatStore.schedule()
      }
      // 进气泡：用 `chat/reply` 这个 key（它不在语义映射里 → 走全池兜底选图，
      // 但文案是我们给的完整回复）。
      machine.notify({
        key: 'chat/reply',
        state: 'listening',
        text: line,
        priority: 97,
        durationMs: 12000
      })
      boot(`聊天回复进气泡（${line.length} 字）`)
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 聊天回复处理失败（已忽略）：${error?.message ?? error}`)
    }
  }

  wireChatEvent('assistant/message', onAssistantMessage)

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

  // ── 番茄钟推进 ──────────────────────────────────────────────────────────
  //
  // **1 秒一次**，比状态机的 15s 密得多。理由：番茄钟是**秒级承诺**
  //（用户盯着倒计时看），15s 的粒度意味着"25:00 到了"最多晚 15 秒才提醒。
  //
  // 为什么不让 exe 自己报时、Host 只收结果：那样"该提醒了"这个判断就散在
  // 两个进程里，DSH 重启/断线时口径必然分叉。**Host 是唯一真相**，
  // exe 只用 `endsAt` 做**显示**用的本地插值（它不会自己触发提醒）。
  //
  // 广播只在**真的发生阶段切换**时发生（`tick` 返回事件时由 `machine.notify`
  // 走正常通道）；平时每秒的 tick 只推进内部计数，不推帧 —— 否则 25 分钟里
  // 会推 1500 帧无意义的状态更新，exe 每秒重绘一次倒计时纯属浪费。
  const pomodoroTicker = setInterval(() => {
    try {
      const event = pomodoro.tick(Date.now())
      if (event !== null && pomodoroStore !== null) {
        pomodoroStore.value = pomodoro.persist(Date.now())
        pomodoroStore.schedule()
      }
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 番茄钟 tick 失败（${error?.message ?? error}）`)
    }
  }, 1000)
  pomodoroTicker.unref?.()
  ctx.effect(() => () => clearInterval(pomodoroTicker), 'zhuang-fangyi-pet: pomodoro ticker')

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
      requestId: `zf-pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      // ⚠️ **`mode` 是必填**，不是可选。
      //
      // 曾经这里写的是"不传 mode ⇒ 走 `agent.followup`（排队）"—— **那是错的**。
      // 上游 `dsh-api-session-controller` 的 zod schema（`typert.host.js` 实测）是：
      //
      //     'mode': z.union([z.literal("queue"), z.literal("steer")]).readonly(),
      //
      // **没有 `.optional()`**，少这个字段直接校验失败。
      // `'queue'` = 排在当前回合之后（就是我们要的"排队、不打断"）。
      mode: 'queue'
    },
    // ⚠️ **第二个参数 `signal` 也是必填** —— 这是真机上"发送必 502"的**第二个**
    // 原因，比 `mode` 更隐蔽（上一次我只修了 `mode` 就以为好了，结果还是 502）。
    //
    // 上游把 `prompt` 注册为 `cancellation: { parameter: 'signal' }`
    // （`typert.host.js` 的描述符实测）。网关按这个描述符取**第 2 个实参**
    // 并直接调 `signal.throwIfAborted()` —— 少传就是：
    //
    //     TypeError: Cannot read properties of undefined (reading 'throwIfAborted')
    //
    // 这句抛在 `prompt()` 内部，被路由的兜底分支包成 502 `send-failed`，
    // 于是屏幕上只剩"发送失败（HTTP 502）"。
    //
    // 必须是**真 `AbortSignal`**（不能是 undefined，也不能是普通对象）：
    // 网关要调它的 `throwIfAborted` 并加 `abort` 监听。
    //
    // 用"永不 abort"的信号是有意的：投递本身很快，"排队不打断"由
    // `mode: 'queue'` 保证，取消权不属于我们 —— 真要中断那是用户在 DSH 里操作。
    new AbortController().signal)
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
    if (typeof requested === 'string' && requested !== '') {
      // 调用方明确指定了会话：**必须用它，且必须存在**。
      // 绝不静默改投别的会话 —— 用户选了"发给 A"，消息却进了 B，
      // 那比报错更糟（他以为发对了地方）。
      //
      // ⚠️ 校验必须用**选择器同一个来源**（`sessionChoices`，= 状态机活跃会话 ∪ list() 缓存）。
      // 曾经只查状态机，结果是"列表里能选、选了却 409" —— 用户撞上的是自相矛盾的界面。
      const known = sessionChoices(machine.snapshot()).some(s => s.sessionId === requested)
      if (!known) {
        const error = new Error(`指定的会话不存在或已结束：${requested}`)
        error.code = 'no-session'
        throw error
      }
      return requested
    }
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
    gallery,
    atlas: () => atlas,
    artDir: ART_DIR,
    token,
    hub,
    logger,
    diagnostics: () => ({
      build: PLUGIN_BUILD,
      ...diagnostics,
      launcher: launcher.status,
      nativeAvailable: machine.snapshot().nativeAvailable,
      // 语音包状态：让"到底装上没有"一眼可见（缺失是正常的，不是错误）。
      voice: voiceReport(voice)
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
      // 番茄钟参数也要跟着走（设置页改时长 → 立刻生效）。
      pomodoro.setConfig(pomodoroConfig())
      // 番茄钟状态有变化 → 立刻广播一帧（否则改了要等下一次状态变化才看到）。
      hub.broadcast(withSettings(machine.snapshot()))
      return applied
    },
    /** 语音（契约 §3 新增）：白名单查表，**运行时绝不合成**。 */
    resolveVoice: name => resolveVoice(VOICE_DIR, name, voice),
    voiceManifest: () => ({
      version: voice.version,
      generatedAt: voice.generatedAt,
      count: voice.count,
      lines: voice.lines
    }),
    /**
     * 互动（契约 §3 新增）。
     *
     * `list()` 给 exe 建右键菜单用 —— **动作表由 Host 给**，不在 exe 里硬编码。
     * 这样"加一个互动"只改 `interactions.js`，exe 不用动也不用重新编译。
     */
    interact: {
      /** 可用动作名（路由层用它做白名单校验 —— 与 `list()` 同一份真相）。 */
      kinds: INTERACT_KINDS,
      list: () => ({
        kinds: INTERACT_KINDS.map(k => ({
          kind: k,
          label: interactLabel(k),
          /** 该动作有没有气泡文案（click 没有 —— 它太频繁）。 */
          hasText: interactText(k, 'zh') !== null
        })),
        affection: affection.snapshot()
      }),
      do: kind => doInteract(kind)
    },
    /**
     * 聊天（契约 §3 新增）。
     *
     * `send` 是**异步**的（要 create 会话 + prompt），路由会 await 它。
     */
    chat: {
      status: () => {
        const ws = chatWorkspace()
        const snap = chat.snapshot()
        return {
          enabled: settings.get().chatEnabled === true,
          sessionId: snap.sessionId,
          sentCount: snap.sentCount,
          replyCount: snap.replyCount,
          lastError: snap.lastError,
          persona: currentPersona(),
          workspace: ws,
          /** 工作区是否已经真的存在（UI 上"打开目录"按钮据此禁用）。 */
          workspaceExists: (() => {
            try { return fs.existsSync(ws) } catch { return false }
          })(),
          /** 能力位：宿主没装配 sessionController 就明确不可用。 */
          available: resolveSendService() !== null,
          reason: resolveSendService() !== null ? null : (sendMissingReason ?? null)
        }
      },
      send: text => sendChat(text)
    },
    /** 人设（契约 §3 新增）：**可切换**是用户明确要求的。 */
    personas: {
      list: () => ({
        ...personaReport(personas, currentPersona()),
        items: personas.items
      }),
      select: async name => {
        const rec = personas.byName.get(name)
        if (rec === undefined) {
          return { ok: false, reason: 'unknown-persona', allowed: personas.items.map(p => p.name) }
        }
        // 切人设 = 改设置 + 把新人设送到聊天会话上。
        // section 路成功时只换 section（旧的同名 section 先 dispose）；
        // 走 AGENTS.md 兜底时重写文件。两条路都由 applyChatPersona 内部选好。
        settings.update({ persona: name })
        settings.flush()
        let applied = { ok: true, dir: chatWorkspace(), mode: 'none' }
        if (chat.sessionId !== null) {
          // 会话活着：直接换 section（applyChatPersona 内部会先 dispose 旧的）。
          const r = await applyChatPersona(chat.sessionId)
          applied = { ok: true, dir: chatWorkspace(), mode: r.mode }
          if (r.mode === 'agents') {
            const md = writePersonaAgentsMd()
            if (!md.ok) applied = { ok: false, reason: md.reason, allowed: personas.items.map(p => p.name) }
          }
        } else {
          // 会话还没建：只更新兜底用的 AGENTS.md（section 等会话建立时再挂）。
          const md = writePersonaAgentsMd()
          if (!md.ok) applied = { ok: false, reason: md.reason, allowed: personas.items.map(p => p.name) }
        }
        if (!applied.ok) {
          return { ok: false, reason: applied.reason, allowed: personas.items.map(p => p.name) }
        }
        // 人设换了 → 广播一帧（exe 的菜单/设置页要看到新值）。
        hub.broadcast(withSettings(machine.snapshot()))
        boot(`人设已切换 → ${name}（${applied.mode === 'section' ? '系统提示词 section' : 'AGENTS.md'}）`)
        return {
          ok: true,
          persona: name,
          workspace: applied.dir,
          /** 走的是哪条路（UI 可以显示"重启会话后生效"之类）。 */
          mode: applied.mode,
          /** 用户手写了 AGENTS.md 时我们不动它 —— 如实告诉调用方。 */
          note: null
        }
      },
      /** 重新扫描人设目录（用户往目录里丢了新的 md 后不必重启）。 */
      reload: () => {
        personas = loadPersonas(PERSONAS_DIR, logger)
        return personaReport(personas, currentPersona())
      }
    },
    /** 番茄钟状态存取（`/pet/pomodoro` 用；见 routes.js 的说明）。 */
    pomodoro: {
      snapshot: () => pomodoro.snapshot(Date.now()),
      control: action => {
        const at = Date.now()
        let result = null
        switch (action) {
          case 'start': result = { started: pomodoro.start(at) }; break
          case 'pause': result = { paused: pomodoro.pause() }; break
          case 'toggle': result = { running: pomodoro.toggle(at) }; break
          case 'skip': result = pomodoro.skip(at); break
          case 'reset': result = { reset: pomodoro.reset(at) }; break
          default: return null
        }
        // 持久化 + 广播：用户按了开始，桌宠那边要立刻看到倒计时。
        if (pomodoroStore !== null) {
          pomodoroStore.value = pomodoro.persist(at)
          pomodoroStore.flush()
        }
        hub.broadcast(withSettings(machine.snapshot()))
        return result
      }
    },
    onCommand: command => {
      switch (command) {
        case 'reload-art':
          return atlasReport(reloadAtlas())
        case 'reload-voice':
          // 重建语音包后不必重启 DSH（与 reload-art 同一考虑）。
          voice = loadVoice(VOICE_DIR, logger)
          return voiceReport(voice)
        case 'reset-affection':
          // 诊断用：好感度写坏了（比如手工改了 json）时能归零重来。
          // **故意不做成界面按钮** —— 一键清空累计好感是很粗暴的事。
          affection.reset()
          if (affectionStore !== null) {
            affectionStore.value = affection.persist(Date.now())
            affectionStore.flush()
          }
          return affection.snapshot()
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
    // 用与设置变化**同一个**判据（`nativeWanted`），两边不可能分叉。
    if (nativeWanted()) {
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
      /**
       * 状态机实际使用的**选图函数本身**（不是副本）。
       *
       * 为什么把它暴露出来：兜底路径原先用 `bubbleArt`（纯 index 取模），
       * **不认识排除名单** —— 而这条缺陷没有任何测试能发现，因为
       * 断言只能看到"名单存在"，看不到"运行时有没有读它"。
       *
       * 暴露真函数后，e2e 可以直接断言：
       * 无论传什么 key，返回的图都**不在** `EMOTE_EXCLUDE_FROM_RANDOM` 里。
       * 这测的是运行路径本身，不是它的手抄副本（这个教训已经吃过四次）。
       */
      pickBubbleImage: (key, seed) => pickBubbleImage(key, seed),
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