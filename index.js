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
import { randomUUID } from 'node:crypto'
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
  loadPersonas, applyPersona, composePersona, loadShared,
  personaReport, DEFAULT_PERSONA_NAME
} from './src/pet/persona.js'
import {
  createChatState, extractAssistantText, bubbleText, validateChatText,
  DEFAULT_WORKSPACE_NAME
} from './src/pet/chat.js'
import {
  memoryExtractionPrompt, parseMemoryFacts, mergeMemory,
  readMemoryFile, writeMemoryFile, ensureMemoryFile, MEMORY_CAP_BYTES
} from './src/pet/memory.js'
import {
  createTtsClient, wavDurationMs, speechCacheKey, DEFAULT_TTS_URL, DEFAULT_MAX_SPEECH_CHARS
} from './src/pet/tts.js'
import {
  createTtsSupervisor, buildServeCommand, HEALTH_POLL_MS as TTS_HEALTH_POLL_MS
} from './src/pet/tts-service.js'

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
  /** 聊天气泡的轮换游标（见 `pickChatBubbleImage`）。 */
  let chatBubbleCursor = -1

  const pickBubbleImage = (key, seed) => {    if (!settings.get().bubble || !settings.get().bubbleImages) return null
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

  /**
   * 给**聊天回复**挑一张气泡图 —— 只要**不带文字**的那种。
   *
   * 为什么单独一个函数：状态机有一条正确性规则（契约 §4 的 `hasText`）——
   * **图自带文字时不叠 Host 文案**。聊天回复的正文是主角，绝不能被一张
   * 「么么哒」贴纸吞掉（用户实测报过："气泡里只提示了已发送"）。
   *
   * 所以这里只从**无文字**的图里挑：
   *   · 关掉气泡图 → null（纯文字气泡）；
   *   · 一张无文字的图都挑不到 → null（**宁可没有图，也不能吞掉正文**）。
   *
   * @returns {object|null} `{file, hasText: false, …}` 或 null
   */
  const pickChatBubbleImage = () => {
    if (!settings.get().bubble || !settings.get().bubbleImages) return null
    const pool = Array.isArray(atlas?.bubble) ? atlas.bubble : []
    const textFree = pool.filter(rec => rec !== null && typeof rec === 'object' &&
      rec.hasText !== true && typeof rec.file === 'string')
    if (textFree.length === 0) return null
    // 轮换而不是每次同一张：连着聊几句时视觉上有变化（与状态机选图同一意图）。
    chatBubbleCursor = (chatBubbleCursor + 1) % textFree.length
    return textFree[chatBubbleCursor]
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
   * dispose 旧的 —— 这个状态就是那本账（人设 + 记忆各一个 disposer）。
   */
  let personaSection = null

  /** 收掉当前挂着的全部 section（幂等）。 */
  const disposePersonaSection = () => {
    if (personaSection === null) return
    for (const d of personaSection.disposers ?? []) {
      try { d() } catch { /* 会话已经没了 */ }
    }
    personaSection = null
  }

  /**
   * **首次运行播种**：把包里的人设样例放进 `personas/`。
   *
   * 加法结构：`shared/` 是**共享背景**（世界观/身份/称呼…，所有风格共用），
   * 顶层 `.md` 是**语言风格**（只写"她怎么说话"，不重复世界观）。
   * 两者独立播种：用户删掉某个风格不该让共享背景复活，反之亦然。
   */
  const seedPersonas = () => {
    const seedDir = path.join(HERE, 'personas-seed')
    try {
      // 共享背景：shared/ 目录缺或空 → 播种
      const sharedDir = path.join(PERSONAS_DIR, 'shared')
      fs.mkdirSync(PERSONAS_DIR, { recursive: true })
      let sharedExisting = []
      try {
        sharedExisting = fs.readdirSync(sharedDir).filter(f => f.toLowerCase().endsWith('.md'))
      } catch { sharedExisting = [] }
      if (sharedExisting.length === 0) {
        const seedShared = path.join(seedDir, 'shared')
        if (fs.existsSync(seedShared)) {
          fs.mkdirSync(sharedDir, { recursive: true })
          for (const f of fs.readdirSync(seedShared)) {
            fs.copyFileSync(path.join(seedShared, f), path.join(sharedDir, f))
          }
          boot(`共享背景已播种（${fs.readdirSync(sharedDir).length} 份）`)
        }
      }
      // 风格：顶层没有 .md → 播种 default.md
      // 不先建目录的话 readdir 永远 ENOENT —— 而那是这条功能唯一的一次执行机会。
      fs.mkdirSync(PERSONAS_DIR, { recursive: true })
      const existing = fs.readdirSync(PERSONAS_DIR).filter(f => f.toLowerCase().endsWith('.md'))
      if (existing.length > 0) return
      const seed = path.join(seedDir, 'default.md')
      if (!fs.existsSync(seed)) return
      fs.copyFileSync(seed, path.join(PERSONAS_DIR, 'default.md'))
      boot('人设目录为空 → 已播种内置的庄方宜风格（default.md）')
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

  /**
   * 确保聊天工作区在 **DSH 的工作区注册表**里存在，并返回它的 id。
   *
   * ── 为什么必须有这一步（用户实测报的问题）────────────────────────────────
   *
   * "聊天能不能单独建一个工作区啊，而不是归类在未分类"。
   *
   * 根因：DSH 的「工作区」是**一份独立的注册表**
   *（`$DSH_HOME/storages/workspace.json` 的 `tables.workspaces`），
   * 光给会话一个 cwd **不会**让它归属任何工作区 —— 于是它掉进「未分类」。
   * 实测确认：聊天会话的 `cwd` 确实是 `…/Downloads/庄方宜`，目录也真的存在，
   * 但注册表里没有这个 path 的记录 → 未分类。
   *
   * 机制（实测自宿主源码 `dsh-api-session-controller` 的 `SessionCommandController`）：
   *   · `sessionController.create({ workspaceId })` 会 `workspace.attachSession()`
   *     把会话挂进那个工作区；
   *   · ⚠️ **`workspaceId` 与 `cwd` 互斥**：两个都传会抛
   *     `gateway/bad-request: session.create accepts workspaceId or cwd, not both`。
   *     所以走这条路时**不能再传 cwd**（cwd 由工作区的 path 决定）。
   *
   * 用 `workspaceRegistry.create(path, title)`：它**幂等**
   *（"the existing or newly durable workspace"），已存在就返回已有的。
   *
   * @returns {Promise<string|null>} workspaceId；拿不到注册表时返回 null（退回 cwd 路）
   */
  const ensureChatWorkspaceId = async () => {
    let registry = null
    try {
      registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    } catch { registry = null }
    if (registry === null || registry === undefined || typeof registry.create !== 'function') {
      // 宿主没这个服务（旧版本/精简 profile）→ 退回 cwd 路（会话仍可用，只是未分类）。
      boot('宿主未提供 workspaceRegistry，聊天会话退回 cwd 归属（可能显示为未分类）')
      return null
    }
    const dir = chatWorkspace()
    try {
      // 先建目录：`create()` 明确要求 path 是**已存在的目录**
      //（"Existing directory to own"），否则抛 "path is not a directory"。
      fs.mkdirSync(dir, { recursive: true })
      // title 只在**新建**记录时生效（已有记录不会被改名 —— 用户自己改过的标题要尊重）。
      const wsRecord = await registry.create(dir, DEFAULT_WORKSPACE_NAME)
      const id = wsRecord?.id ?? wsRecord?.workspaceId ?? null
      if (typeof id !== 'string' || id === '') {
        boot('workspaceRegistry.create 没有返回 id，聊天会话退回 cwd 归属')
        return null
      }
      return id
    } catch (error) {
      // 拿不到工作区不该让聊天不可用 —— 退回 cwd 路（只是显示为未分类）。
      logger.warn?.(`zhuang-fangyi-pet: 聊天工作区注册失败（退回 cwd）：${error?.message ?? error}`)
      return null
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
  /** 记忆 section 的名字与位置（紧挨人设之后、工具说明之前）。 */
  const MEMORY_SECTION_NAME = 'zf-pet:memory'
  const MEMORY_SECTION_ORDER = 10

  /**
   * 给聊天会话注册/更新人设 section（加法：共享背景 + 风格）与**共享记忆** section。
   *
   * @param {string} sessionId
   * @returns {Promise<{mode: 'section'|'agents'|'none', reason?: string}>}
   */
  const applyChatPersona = async sessionId => {
    const name = currentPersona()
    const composed = composePersona(PERSONAS_DIR, name, logger)
    if (composed.text === null) return { mode: 'none', reason: 'unknown-persona' }
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
      // 先收旧的（同名 section 在同一作用域注册两次会抛）。
      disposePersonaSection()
      // `interpolate: false`：人设/记忆正文里的 `{{` 保持字面（否则会被当成
      // 变量引用，未定义的引用会让整次组装**抛错**）。
      const disposers = []
      const d1 = sp.section({
        name: PERSONA_SECTION_NAME,
        order: Number.isFinite(order) ? order : 0,
        text: '本会话的角色设定如下；它取代默认的助手人设。除工具调用等运行规范外，'
          + '请始终以该角色的身份、语气与知识边界回应。\n\n' + composed.text.trim(),
        interpolate: false
      })
      disposers.push(typeof d1 === 'function' ? d1 : null)
      // ⭐ 跨会话共享记忆：一份 memory.md，注入到**每个**聊天会话的作用域 ——
      // 换会话/重开会话它都跟着走，这就是"不同会话共享 memory"。
      const memoryText = ensureMemoryFile(dataDir)
      const d2 = sp.section({
        name: MEMORY_SECTION_NAME,
        order: MEMORY_SECTION_ORDER,
        text: '以下是你（庄方宜）与用户长期相处积累的记忆，跨会话共享；'
          + '其中可能有过时的内容 —— 与当前对话冲突时以对话为准。\n\n'
          + (memoryText.trim() === '' ? '（还没有记住什么。）' : memoryText.trim()),
        interpolate: false
      })
      disposers.push(typeof d2 === 'function' ? d2 : null)
      personaSection = { sessionId, persona: name, disposers: disposers.filter(d => d !== null) }
      boot(`人设 + 记忆已注册到聊天会话（${name}，共享背景 ${composed.sharedCount} 份）`)
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
  ctx.effect(() => () => disposePersonaSection(), 'zhuang-fangyi-pet: chat persona section')

  /**
   * 把**已存在**的聊天会话挂进工作区（迁移用）。
   *
   * 为什么需要：用户已经在「未分类」里聊过了（那时我们还没建工作区）。
   * `Workspace.attachSession()` 会校验"会话 cwd == 工作区 path"——
   * 而聊天会话的 cwd 恰好就是工作区目录，所以**能挂**。
   *
   * 只做一次、失败只记日志：这是"把旧会话挪到正确位置"的补偿，
   * 失败了聊天照常可用（只是仍显示未分类）。
   *
   * @param {string} workspaceId
   * @param {string} sessionId
   */
  const attachExistingChatSession = async (workspaceId, sessionId) => {
    try {
      let registry = null
      try {
        registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
      } catch { registry = null }
      const wsRecord = registry?.get?.(workspaceId)
      if (wsRecord === undefined || wsRecord === null) return false
      // 已经在里面了 → 什么都不做（幂等）。
      if (Array.isArray(wsRecord.sessionIds) && wsRecord.sessionIds.includes(sessionId)) return true
      if (typeof wsRecord.attachSession !== 'function') return false
      await wsRecord.attachSession(sessionId)
      boot(`已把现有聊天会话挂进工作区：${sessionId}`)
      return true
    } catch (error) {
      // 挂不上不算错（比如会话 cwd 被用户改过）—— 如实记一笔就够了。
      logger.warn?.(`zhuang-fangyi-pet: 现有聊天会话挂进工作区失败（已忽略）：${error?.message ?? error}`)
      return false
    }
  }

  /**
   * 解析聊天会话服务并**确保会话存在**。
   *
   * `sessionController.create({sessionId})` 是"创建或**幂等采纳**"语义，
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
      // ⭐ 迁移：这条会话可能是"还没建工作区"时创建的（显示为未分类）。
      // 工作区是幂等注册的，所以每次都可以安全地尝试把它挂进去 ——
      // 已经在里面时 `attachSession` 那一步会被跳过（见函数内的幂等检查）。
      const workspaceId = await ensureChatWorkspaceId()
      if (workspaceId !== null) await attachExistingChatSession(workspaceId, chat.sessionId)
      const applied = await applyChatPersona(chat.sessionId)
      if (applied.mode === 'agents') writePersonaAgentsMd()   // 兜底
      return chat.sessionId
    }
    // ⭐ 先注册工作区，再按 **workspaceId** 建会话 —— 这样它才会被归到
    // 独立的工作区里，而不是掉进「未分类」（用户实测反馈的就是这个）。
    const workspaceId = await ensureChatWorkspaceId()
    // ⚠️ `workspaceId` 与 `cwd` **互斥**（宿主会抛 gateway/bad-request）。
    const created = await svc.create(
      workspaceId === null ? { cwd: ws.dir } : { workspaceId }
    )
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
   * 最近一条用户发的聊天消息（**记忆提炼要用**）。
   *
   * 为什么记在这里：提炼需要"用户说了什么 + 她答了什么"这一对。
   * 回复事件里只有她的答案，所以用户那句得先存下来。
   */
  let lastChatSent = null

  // ── 动态语音（TTS）：把 AI 的回答念出来 ───────────────────────────────────
  //
  // 接线对象是**独立的子插件** `dsh-zhuang-fangyi-voice`（HTTP 服务，
  // 见 `src/pet/tts.js` 文件头的契约）。它还在开发中，所以这里全程:
  //   · **可选**：服务不在就退回固定台词（`chat/reply`），聊天照常；
  //   · **异步**：合成慢（torch ≈3s、onnx ≈37s），绝不阻塞气泡；
  //   · **可关**：设置里 `speakReplies` 默认关 —— 桌宠突然把长回复念出来
  //     是强打扰，用户主动开才生效。
  //
  // 交付给 exe 的方式与互动语音同一套：写进 `speech/` 目录 → 快照带
  // `speak: {seq, name}` → exe 按 seq 变化去 `/pet/speech/<name>` 取字节播放。

  /** 动态语音缓存目录（WAV）。 */
  const SPEECH_DIR = path.join(dataDir, 'speech')

  /** 语音交付序号（exe 靠它去重：同一个 seq 只播一次）。 */
  let speechSeq = 0
  /** 最近一次交付的语音（进快照）。 */
  let speechLatest = null
  /**
   * 合成代际：每来一条新回复就 +1。
   *
   * 为什么需要它：合成要几秒，而用户可能连发几条。没有代际的话，
   * 先发的那句合成完会**盖住**后发的 —— 听起来就是"念了上一句"。
   */
  let speechGeneration = 0

  const ensureSpeechDir = () => {
    try {
      fs.mkdirSync(SPEECH_DIR, { recursive: true })
      return true
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 语音缓存目录创建失败：${error?.message ?? error}`)
      return false
    }
  }

  /**
   * 语音缓存里有几条（WAV 计数）。
   *
   * ⚠️ **数盘，不要猜**。这里踩过一个坑：`probe` 的返回值原先写的是
   * `status.cached + 1` —— 假设"这次探测必然新增一条缓存"。但探测用的
   * 是固定句子，缓存键（文本哈希）也一样，所以第二次探测是**覆盖同名
   * 文件**，磁盘上还是 1 条，报告里却写 2 条。实测：`/pet/diag` 说 1、
   * 探测应答说 2，而 `speech/` 目录里只有 1 个文件。
   *
   * 计数类字段一旦开始"推算"，就会和真相脱节 —— 所以这里统一走数盘。
   */
  const speechCacheCount = () => {
    try {
      return fs.readdirSync(SPEECH_DIR).filter(f => f.endsWith('.wav')).length
    } catch { return 0 }
  }

  /** 惰性创建 TTS 客户端（设置改了要能换 URL）。 */
  let ttsClient = null
  let ttsClientUrl = null
  const tts = () => {
    const url = String(settings.get().ttsUrl ?? '').trim() || DEFAULT_TTS_URL
    if (ttsClient === null || ttsClientUrl !== url) {
      ttsClient = createTtsClient({
        baseUrl: url,
        maxChars: speechMaxChars(),
        logger
      })
      ttsClientUrl = url
    }
    return ttsClient
  }

  const speechMaxChars = () => {
    const n = Number(settings.get().speechMaxChars)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_SPEECH_CHARS
  }

  // ── 合成服务进程监管（"语音模型常驻"开关）────────────────────────────────
  //
  // 用户点名的需求："每次特别是使用 CUDA 的时候，加载模型会占更多的时间。
  // 可以加一个是否让语音模型常驻的选项。"
  //
  // 于是这里托管它的**进程生命周期**（见 `src/pet/tts-service.js`）：
  //   · 常驻 → 一直活着，挂了自动拉起；
  //   · 非常驻 → 需要时才起，空闲后自动停掉释放显存；
  //   · **只停自己起的** —— 用户自己在终端起的服务碰都不碰。

  /** 从设置里的 URL 反推端口（起服务要与它一致，否则连不上自己起的服务）。 */
  const portFromUrl = url => {
    const m = /^https?:\/\/[^/]*?:(\d+)/i.exec(String(url ?? ''))
    if (m !== null) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n > 0 && n < 65536) return n
    }
    return 8765
  }

  const firstExisting = list => {
    for (const p of list) {
      try { if (p !== '' && fs.existsSync(p)) return p } catch { /* 继续找 */ }
    }
    return null
  }

  const envOf = name => {
    try { return String(process.env[name] ?? '').trim() } catch { return '' }
  }

  /**
   * 找 python。
   *
   * ⚠️ **不许硬编码绝对路径**（用户明确要求）—— 全部按可移植顺序推导：
   *   设置 → 环境变量 `ZFH_VOICE_PYTHON` → 仓库里的 `.venv` → PATH 上的 python。
   * 第一版写死了 `~/miniconda3/envs/voice/python.exe`，那是我这台机器的布局，
   * 换台机器就是错的（而且错得毫无提示）。
   */
  const detectPython = repoDir => {
    const fromEnv = envOf('ZFH_VOICE_PYTHON')
    if (fromEnv !== '') return fromEnv
    if (repoDir !== null) {
      const hit = firstExisting([
        path.join(repoDir, '.venv', 'Scripts', 'python.exe'),
        path.join(repoDir, '.venv', 'bin', 'python'),
        path.join(repoDir, 'venv', 'Scripts', 'python.exe'),
        path.join(repoDir, 'venv', 'bin', 'python')
      ])
      if (hit !== null) return hit
    }
    // 交给 PATH（名字随平台）。
    return process.platform === 'win32' ? 'python' : 'python3'
  }

  /**
   * 找语音子插件仓库目录 —— **只用相对位置与环境变量**。
   *
   * `HERE` 是桌宠插件自己的安装目录（`<profile>/node_modules/dsh-zhuang-fangyi-pet`），
   * 所以 `HERE/../dsh-zhuang-fangyi-voice` 同时覆盖两种装法：
   *   · 语音插件也装在同一个 `node_modules` 下（DSH 插件管理器装的）；
   *   · 两个仓库并排签出（开发者本地）。
   */
  const detectRepoDir = () => firstExisting([
    envOf('DSH_ZFH_VOICE_DIR'),
    envOf('ZFH_VOICE_DIR'),
    path.join(HERE, '..', 'dsh-zhuang-fangyi-voice'),
    path.join(HERE, '..', '..', 'dsh-zhuang-fangyi-voice')
  ])

  /** 找 GPT-SoVITS 检出目录（torch 后端需要）—— 同样只用相对位置与环境变量。 */
  const detectGsvRoot = repoDir => {
    const fromEnv = envOf('ZFH_GSV_ROOT')
    if (fromEnv !== '') return fromEnv
    if (repoDir === null) return null
    return firstExisting([path.join(repoDir, 'third_party', 'GPT-SoVITS')])
  }

  /**
   * 解析启动参数（设置优先，其次自动探测）。
   *
   * 自动探测的意义：让用户**不必先配四项设置**就能跑起来。
   * 探测不到就返回 null → 不托管进程（只连已运行的服务），并如实记日志。
   */
  const resolveLaunch = () => {
    const cfg = settings.get()
    const repoDir = String(cfg.ttsRepoDir ?? '').trim() || detectRepoDir()
    if (repoDir === null) return null
    const python = String(cfg.ttsPython ?? '').trim() || detectPython(repoDir)
    const backend = String(cfg.ttsBackend ?? '').trim()
    return buildServeCommand({
      python,
      repoDir,
      backend,
      // gsvRoot：torch 后端需要；探测不到就不传（交给子插件自己找）。
      gsvRoot: detectGsvRoot(repoDir),
      port: portFromUrl(String(cfg.ttsUrl ?? '').trim() || DEFAULT_TTS_URL)
    })
  }

  /**
   * 装了语音 DSH 插件吗？装了就把一切交给它。
   *
   * `dsh-zhuang-fangyi-voice` 会挂一个 `zfhVoice` 服务，它自己负责进程生命周期
   * （启动/保活/释放显存）。此时桌宠**不再自己起进程**（避免两个监管者抢同一个
   * 端口/进程），只把开关推给它、并调用它的 `synthesize`。
   *
   * 没装 → 退回"自己起进程 + HTTP"的老路（那套仍然完整可用）。
   */
  const voiceService = () => {
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('zfhVoice') : undefined
      if (svc === null || svc === undefined) return null
      if (typeof svc.synthesize !== 'function') return null
      return svc
    } catch { return null }
  }

  const supervisor = createTtsSupervisor({
    spawn: spec => {
      let sub = null
      try {
        sub = typeof ctx.get === 'function' ? ctx.get('subprocess') : undefined
      } catch { sub = null }
      if (sub === null || sub === undefined || typeof sub.spawn !== 'function') {
        throw new Error('宿主未提供 ctx.subprocess，无法托管合成服务进程')
      }
      return sub.spawn(spec)
    },
    health: () => tts().health(),
    logger
  })

  /** 把当前设置推给监管器（设置改了立刻生效）。 */
  const syncTtsService = () => {
    const cfg = settings.get()
    supervisor.configure({
      resident: cfg.ttsResident === true,
      idleStopSec: Number(cfg.ttsIdleStopSec) || 0,
      launch: resolveLaunch()
    })
    // 装了语音插件 → 把开关与路径推给它（设置页仍是**唯一**的控制面）。
    const svc = voiceService()
    if (svc !== null && typeof svc.configure === 'function') {
      try {
        // ⚠️ **只推"用户真的设了"的键**。
        //
        // 这里踩过一个真实的坑：原先无条件推 `backend: ... || 'auto'`，于是每次
        // 设置变化都会把插件 loader 里配好的 `backend: torch` 覆盖成 `auto` ——
        // 而 `auto` 在没有 gsvRoot 时会去选 onnx，最后报"模型没装"。
        // 症状是"我明明配了 torch，它却按 auto 跑"，排查方向全错。
        //
        // 分工写清楚：
        //   · **桌宠推**运行时开关（resident / idleStopSec / idleAction）——
        //     它们是设置页上的 UI，用户随时会拨；
        //   · **插件自己的 loader 配置**保留机器相关路径
        //     （backend / gsvRoot / modelDir / python / repoDir / port）——
        //     那些是"装在哪"，不该被一个空设置项冲掉。
        const patch = {
          resident: cfg.ttsResident === true,
          idleStopSec: Number(cfg.ttsIdleStopSec) || 0
        }
        // 释放方式只在用户**明确选了**才推（空串 = 用插件默认）。
        const idleAction = String(cfg.ttsIdleAction ?? '').trim()
        if (idleAction === 'stop' || idleAction === 'unload') patch.idleAction = idleAction
        // 路径/后端只在设置了非空值时才推。
        const explicit = {
          backend: String(cfg.ttsBackend ?? '').trim(),
          python: String(cfg.ttsPython ?? '').trim(),
          repoDir: String(cfg.ttsRepoDir ?? '').trim(),
          gsvRoot: String(cfg.ttsGsvRoot ?? '').trim(),
          modelDir: String(cfg.ttsModelDir ?? '').trim()
        }
        for (const [k, v] of Object.entries(explicit)) if (v !== '') patch[k] = v
        // 端口只在用户显式改了地址时才推（ttsUrl 有值意味着他指了别的服务）。
        const url = String(cfg.ttsUrl ?? '').trim()
        if (url !== '') patch.port = portFromUrl(url)
        svc.configure(patch)
      } catch (error) {
        logger.warn?.(`zhuang-fangyi-pet: 同步语音插件配置失败：${error?.message ?? error}`)
      }
    }
  }
  syncTtsService()

  // 周期检查：常驻时服务死了就拉起；非常驻时空闲够了就停掉释放显存。
  ctx.effect(() => {
    const timer = setInterval(() => {
      void supervisor.tick().catch(() => {})
    }, TTS_HEALTH_POLL_MS)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      // 插件卸载 → 收掉我们自己起的服务（`ctx.subprocess` 也会兜底终止，
      // 但显式停一次更干脆，日志里也能看出是"我们停的"）。
      try { supervisor.stop() } catch { /* 已退出 */ }
    }
  }, 'zhuang-fangyi-pet: tts service supervisor')

  /**
   * 念一句回复（fire-and-forget）。
   *
   * @param {string} rawReply - **原始回复文本**（markdown，函数内部会清洗）
   */
  const speakReply = rawReply => {
    if (settings.get().speakReplies !== true) return
    // 语音总开关关着时不用合成 —— 合成完也没人播（还白等几秒）。
    if (settings.get().voice !== true) return
    const client = tts()
    // ⭐ 清洗：markdown 直接念会念出"星号星号"、代码、URL。
    const text = client.sanitize(rawReply)
    if (text === null) return   // 全是代码之类 —— 没东西可念，不硬念
    const gen = ++speechGeneration
    void (async () => {
      try {
        if (!ensureSpeechDir()) return
        const key = client.cacheKey(text)
        const file = path.join(SPEECH_DIR, `${key}.wav`)
        let durationMs = 0
        let fromCache = false
        if (fs.existsSync(file)) {
          try {
            durationMs = wavDurationMs(fs.readFileSync(file))
            fromCache = true
          } catch { fromCache = false }
        }
        if (!fromCache) {
          // ⭐ 两条路：
          //   · 装了语音 DSH 插件 → 交给它的 `synthesize`（它自己管进程与常驻策略）
          //   · 没装 → 桌宠自己起进程 + HTTP（"需要时才启动"）
          // 全程在 fire-and-forget 的异步块里，chat 不受任何影响。
          const svc = voiceService()
          let r = null
          if (svc !== null) {
            const out = await svc.synthesize(text)
            r = out === null ? null : { bytes: out.bytes, durationMs: out.durationMs }
          } else {
            await supervisor.ensure()
            r = await client.synthesize(text)
          }
          if (r === null) {
            // 服务没起 / 超时 / 返回垃圾 —— 退回固定台词（exe 侧会播 chat/reply）。
            boot('动态语音合成不可用 → 退回固定台词')
            return
          }
          try {
            fs.writeFileSync(file, r.bytes)
          } catch (error) {
            logger.warn?.(`zhuang-fangyi-pet: 语音写入失败：${error?.message ?? error}`)
            return
          }
          durationMs = r.durationMs
        }
        // ⭐ 代际检查：这条已经不是最新的了 → 丢掉（别盖住更新的那句）。
        if (gen !== speechGeneration) {
          boot('动态语音已过期（有更新的回复）→ 丢弃')
          return
        }
        // 交付：seq 递增 → exe 看到变化就去取。
        speechSeq += 1
        speechLatest = { seq: speechSeq, name: key, durationMs, text }
        boot(`动态语音就绪（${fromCache ? '缓存' : '新合成'}，${durationMs}ms）：${text.slice(0, 24)}`)
        hub.broadcast(withSettings(machine.snapshot()))
      } catch (error) {
        logger.warn?.(`zhuang-fangyi-pet: 动态语音失败（已忽略）：${error?.message ?? error}`)
      }
    })()
  }

  /**
   * 自动提炼记忆（**跨会话共享**）：把这一轮里值得长期记住的事追加到 `memory.md`。
   *
   * 设计取舍：
   *   · **fire-and-forget**：绝不阻塞聊天，失败只记日志（记忆是加分项，不是必需项）；
   *   · **只提炼这一轮**：全量提炼既贵又重复；已有记忆模型自己在 section 里看得到；
   *   · **走宿主的 `ctx.llm`**：不自己拉 key、不自己算路由（`agentDefaultModel`
   *     给的就是用户当前选的那个模型）；
   *   · **提示词与解析都是纯函数**（`memory.js`），可单测。
   *
   * @param {string} userText
   * @param {string} replyText
   */
  const extractChatMemory = (userText, replyText) => {
    if (settings.get().memoryAuto !== true) return
    if (typeof userText !== 'string' || userText.trim() === '') return
    if (typeof replyText !== 'string' || replyText.trim() === '') return
    // 全部塞进一个 async IIFE：调用方不等它（fire-and-forget）。
    void (async () => {
      try {
        let llm = null
        try {
          llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
        } catch { llm = null }
        if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
          logger.debug?.('zhuang-fangyi-pet: 宿主没有 llm 服务，跳过记忆提炼')
          return
        }
        let route = null
        try {
          const picker = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
          route = typeof picker?.currentSelection === 'function' ? picker.currentSelection() : null
        } catch { route = null }
        const provider = route?.provider
        const model = route?.model
        if (typeof provider !== 'string' || typeof model !== 'string') {
          logger.debug?.('zhuang-fangyi-pet: 拿不到默认模型路由，跳过记忆提炼')
          return
        }
        const prompt = memoryExtractionPrompt(userText, replyText)
        // 超时保护：提炼是后台任务，绝不能挂着一个请求不放。
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 30000)
        timer.unref?.()
        let out = ''
        try {
          // 消息形状照抄宿主 `createUserMessage`：`{role, content:[{type:'text',text}], source, id}`。
          const messages = [{
            role: 'user',
            id: randomUUID(),
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'dsh-zhuang-fangyi-pet' }
          }]
          const stream = llm.stream({
            provider,
            model,
            messages,
            maxTokens: 200,
            purpose: 'zhuang-fangyi-pet-memory',
            signal: controller.signal
          })
          for await (const chunk of stream) {
            // 只要正文增量；reasoning 增量不进记忆（那是她的"思考"，不是事实）。
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
          }
        } finally {
          clearTimeout(timer)
        }
        const facts = parseMemoryFacts(out)
        if (facts.length === 0) return
        const current = readMemoryFile(dataDir) ?? ''
        const next = mergeMemory(current, facts, Date.now(), { capBytes: MEMORY_CAP_BYTES })
        if (writeMemoryFile(dataDir, next)) {
          boot(`记忆 +${facts.length} 条：${facts.join(' | ').slice(0, 120)}`)
          // 记忆变了 → 立刻把新的记忆 section 挂回聊天会话（下次组装就带上）。
          // 不重挂的话要等下一次会话切换才生效，用户会觉得"它没记住"。
          if (chat.sessionId !== null) {
            void applyChatPersona(chat.sessionId).catch(() => {})
          }
        }
      } catch (error) {
        // 记忆提炼失败绝不能影响聊天本身（abort 也是正常路径）。
        logger.debug?.(`zhuang-fangyi-pet: 记忆提炼失败（已忽略）：${error?.message ?? error}`)
      }
    })()
  }

  /**
   * 发一条聊天消息（**排队语义**，与气泡输入框一致）。
   *
   * ⚠️ `prompt()` 的两条必填约束与 `sendToSession` 完全相同
   * （`mode` + `真 AbortSignal`）—— 那个坑踩过两次，这里绝不重犯。
   */
  const sendChat = async rawText => {    const v = validateChatText(rawText)
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
    // 记住"这一轮用户说了什么" —— 收到回复时要拿它一起做记忆提炼。
    lastChatSent = { text: v.text, at: Date.now() }
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
    /**
     * 动态语音（合成出来的回答语音）—— exe 靠 `seq` 判"这是新的一句"。
     *
     * 与 `interact` 同一模式：seq 递增而不是时间戳（同一毫秒两次不会漏）。
     * `name` 是缓存键，exe 去 `/pet/speech/<name>` 取 WAV。
     * 没开动态语音 / 还没合成好时是 null —— exe 保持沉默，退回固定台词。
     */
    speak: speechLatest,
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

  // 设置里改了常驻/空闲时间/启动路径/地址 → 立刻推给监管器（不等重启）。
  //
  // ⚠️ `settings.subscribe` 的回调**不带参数**（就是"变了"的通知），
  // 所以要靠 `syncTtsService()` 每次重算一遍 —— 它自己会读最新设置。
  // 第一版这里写成了 `settings.onChange((next, prev) => ...)`（不存在的 API），
  // 是凭空发明的接口。
  const offTtsSettings = settings.subscribe(() => {
    try {
      syncTtsService()
      // 从"常驻"改成"非常驻"时立刻评估一次：不必等 15 秒轮询才释放显存。
      void supervisor.tick().catch(() => {})
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 合成服务监管同步失败：${error?.message ?? error}`)
    }
  })
  ctx.effect(() => () => offTtsSettings(), 'zhuang-fangyi-pet: tts settings subscription')

  // ── 事件桥：根 Context 收全部 scoped 事件（见 events.js 文件头）──────────
  //
  // ⚠️ **聊天正文走这条桥的回调**，不是另开一个 `ctx.on`。
  //
  // 这里踩过一个真实的坑（用户报"气泡只提示已发送，回复从不出现"）：
  // 原先写的是 `ctx.on('assistant/message', …)` —— 而 `assistant/message`
  // 是 **SessionEventMap 里的事件**（经 `session/event` 派发），
  // **cordis 根上没有这个事件名**。`ctx.on` 对未知事件名**不抛错**，
  // 于是订阅静静地永远不触发：日志里连一行警告都没有，气泡自然永远空着。
  //
  // 现在把 `assistant/message` 从 `session/event` 里接出来交给 `onChatMessage`：
  // 状态机仍然不读正文（红线不变），聊天另走一条**只认聊天会话**的通道。
  const offEvents = bridgeHostEvents(ctx, machine, logger, {
    onChatMessage: (sessionId, event) => onAssistantMessage(sessionId, event)
  })
  ctx.effect(() => () => offEvents(), 'zhuang-fangyi-pet: host events')
  boot('状态机 + 事件桥已就绪（含聊天正文通道）')

  // ── 聊天回复 → 桌宠气泡 ─────────────────────────────────────────────────
  //
  // ⚠️ **单独订阅，不走状态机**：状态机是"AI 在干什么"的聚合（它故意不看
  // 消息正文 —— 那是一条硬不变式）。而聊天需要**正文**，所以另开一条
  // 只服务于聊天的通道，且**只认聊天会话**（`chat.accept` 做过滤）。
  //
  // 为什么不用 `assistant/chunk` 逐字拼：气泡要的是"说完了的整句"，
  // 逐字拼会弹出一堆半截话。用 `assistant/message`（一条完整消息）。
  //
  // 参数形状（`SessionEventMap` 实测）：
  //   `{ type: 'assistant/message', data: { turn, step, message: AssistantMessage,
  //      stream, usage?, interrupted? }, seq, time }`
  //   `AssistantMessage = { id, role: 'assistant', content: ContentBlock[], source }`
  const onAssistantMessage = (sessionId, event) => {
    try {
      const sid = typeof sessionId === 'string' ? sessionId : (sessionId?.id ?? null)
      const payload = event?.data ?? event ?? {}
      // 回合标识：优先 `turn`（同一回合的多次 step 会各发一条消息，
      // 用 `message.id` 区分才不会把后续 step 的回复当成重复丢掉）。
      const turnKey = payload?.message?.id ?? payload?.turn ?? payload?.id ??
        `${sid}:${Date.now()}`
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
      //
      // ⚠️ **必须传 `image`，而且必须是"不带文字"的那张**。
      //
      // 这里踩过一个真实的坑（用户报"气泡里只提示了已发送"）：状态机有一条
      // **正确性规则** —— 图自带文字时不叠 Host 文案（否则屏幕上两段文字打架，
      // 契约 §4 的 `hasText`）。而全池兜底会挑到「么么哒」「好耶！」这类
      // **自带中文的贴纸**，于是我们传的回复正文被整段丢掉，用户只看到一张贴纸
      //（优先级/时长都是对的，所以状态机"成功地"弹了一个没有内容的气泡）。
      //
      // 修法：聊天回复**显式指定一张纯图**（`hasText: false`），
      // 让正文永远有地方显示；挑不到纯图就干脆不配图（纯文字气泡也比吞掉正文好）。
      const image = pickChatBubbleImage()
      machine.notify({
        key: 'chat/reply',
        state: 'listening',
        text: line,
        image,
        priority: 97,
        durationMs: 12000
      })
      boot(`聊天回复进气泡（${line.length} 字）`)
      // ⭐ 动态语音：把**回复正文**合成出来念（子插件提供合成服务）。
      //
      // 这是"回答通过语音合成念出来"的入口。取的是**原始回复**（不是被
      // 气泡截断的 `line`）—— 语音该念完整句子，气泡才受长度限制。
      // fire-and-forget：合成慢（torch ≈3s/句，onnx ≈37s/句），绝不能阻塞气泡。
      speakReply(text)
      // 记忆提炼：拿"用户那句 + 这句回复"去提炼值得长期记住的事。
      // fire-and-forget —— 绝不让它拖慢气泡显示。
      const sent = lastChatSent
      lastChatSent = null
      if (sent !== null) extractChatMemory(sent.text, text)
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 聊天回复处理失败（已忽略）：${error?.message ?? error}`)
    }
  }

  // ⚠️ **不要再写 `ctx.on('assistant/message', …)`** —— 那是 SessionEventMap 的
  // 事件（经 `session/event` 派发），cordis 根上没有它；`ctx.on` 不抛错，
  // 于是订阅永远不触发、也没有任何日志（这正是用户报的那个 bug 的根因）。
  // 订阅已在上面的 `bridgeHostEvents(..., { onChatMessage })` 里完成。

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
        // 工作区归属：让"到底归到哪儿了"可见（用户反馈过"归类在未分类"）。
        let workspaceId = null
        let workspaceTitle = null
        try {
          const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
          if (registry !== null && registry !== undefined && typeof registry.list === 'function') {
            const hit = registry.list().find(w => {
              const p = String(w?.path ?? '').replace(/[\\/]+$/, '')
              return p.toLowerCase() === ws.replace(/[\\/]+$/, '').toLowerCase()
            })
            if (hit !== undefined) {
              workspaceId = hit.id ?? null
              workspaceTitle = hit.title ?? null
            }
          }
        } catch { /* 拿不到就不显示（不假装有） */ }
        return {
          enabled: settings.get().chatEnabled === true,
          sessionId: snap.sessionId,
          sentCount: snap.sentCount,
          replyCount: snap.replyCount,
          lastError: snap.lastError,
          persona: currentPersona(),
          workspace: ws,
          /** DSH 工作区注册表里的归属（null = 未注册 → 会显示为"未分类"）。 */
          workspaceId,
          workspaceTitle,
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
      list: () => {
        const shared = loadShared(PERSONAS_DIR, logger)
        return {
          ...personaReport(personas, currentPersona()),
          items: personas.items,
          /**
           * 共享背景（加法人设的"底座"）：所有风格都拼在它后面。
           * 设置页要把这几份文件显示出来 —— 用户才知道"世界观写在哪儿"。
           */
          shared: {
            dir: shared.dir,
            items: shared.items,
            /** 当前风格实际拼上了几份共享背景（0 = 该风格是自包含的）。 */
            used: composePersona(PERSONAS_DIR, currentPersona(), logger).sharedCount
          }
        }
      },
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
    /**
     * 动态语音字节（`/pet/speech/<name>`）。
     *
     * 读盘而不是留在内存：语音可能几百 KB，常驻内存不值得；
     * 而它就在本地磁盘上，读一次比一次 HTTP 往返便宜。
     * ⚠️ 名字**只允许** 16 位十六进制（缓存键形状）—— 这是路径拼接的
     * 白名单防线，与 `/pet/voice/` 同一纪律（那里踩过 `..` 穿越）。
     */
    speech: {
      read: name => {
        if (typeof name !== 'string' || !/^[0-9a-f]{16}$/.test(name)) return null
        try {
          const file = path.join(dataDir, 'speech', `${name}.wav`)
          const buf = fs.readFileSync(file)
          return buf.length > 0 ? buf : null
        } catch {
          return null
        }
      },
      /**
       * 进程控制（设置页的"启动/停止"按钮）。
       *
       * `start` = 起进程并等它就绪（会真的等模型加载完）；`stop` = 停掉
       * **我们自己起的**（用户自己起的那份绝不终止）；`status` = 只读快照。
       */
      service: async action => {
        // 装了语音插件 → 控制权在它那儿（同一时间只该有一个监管者）。
        const svc = voiceService()
        if (svc !== null && typeof svc.status === 'function') {
          try {
            if (action === 'status') return { ok: true, mode: 'plugin', ...svc.status() }
            if (action === 'stop') {
              const stopped = typeof svc.stop === 'function' ? svc.stop() : false
              return {
                ok: true,
                mode: 'plugin',
                stopped,
                note: stopped ? null : '这个服务不是你起的（或插件未托管），桌宠不会去停它',
                ...svc.status()
              }
            }
            const ready = typeof svc.start === 'function' ? await svc.start() : false
            const st = svc.status()
            return {
              ok: ready === true,
              mode: 'plugin',
              reason: ready === true ? null : (st.lastError ?? '启动超时或进程没能就绪'),
              ...st
            }
          } catch (error) {
            return { ok: false, mode: 'plugin', reason: String(error?.message ?? error) }
          }
        }
        if (action === 'status') return { ok: true, mode: 'http', ...supervisor.status() }
        if (action === 'stop') {
          const stopped = supervisor.stop()
          return {
            ok: true,
            stopped,
            // 没停成有两种可能，如实区分（用户看日志时能分清）
            note: stopped ? null : (supervisor.status().ours ? '停止失败' : '这个服务不是你起的，桌宠不会去停它'),
            ...supervisor.status()
          }
        }
        const before = supervisor.status()
        const ready = await supervisor.ensure()
        const after = supervisor.status()
        return {
          ok: ready,
          reason: ready
            ? null
            : (after.launchable
                ? (after.lastError ?? '启动超时或进程没能就绪')
                : '没有可用的启动命令（请在设置里填 python 与子插件目录）'),
          startedNow: before.ours !== after.ours || after.startedAt !== before.startedAt,
          ...after
        }
      },
      /** 给设置页/诊断用：当前状态（开没开、服务地址、已缓存几条）。 */
      status: () => {
        return {
          enabled: settings.get().speakReplies === true,
          url: String(settings.get().ttsUrl ?? '') || DEFAULT_TTS_URL,
          maxChars: speechMaxChars(),
          cached: speechCacheCount(),
          latest: speechLatest === null
            ? null
            : { name: speechLatest.name, durationMs: speechLatest.durationMs, text: speechLatest.text },
          /**
           * 进程监管状态。
           *
           * `mode` 说明用的是哪条路：
           *   · `plugin` —— 装了语音 DSH 插件，进程由它管（这里的状态从它那儿取）；
           *   · `http`   —— 没装插件，桌宠自己起进程 + HTTP。
           * 用户看设置页时要能分清"到底谁在管"，否则排查时会找错地方。
           */
          service: (() => {
            const svc = voiceService()
            if (svc !== null && typeof svc.status === 'function') {
              try { return { mode: 'plugin', ...svc.status() } } catch { /* 退回本地状态 */ }
            }
            return { mode: 'http', ...supervisor.status() }
          })(),
          /**
           * 启动命令（诊断用：用户要能看到**到底会执行什么**）。
           *
           * 插件模式下显示**插件的**那份 —— 桌宠自己那份没带 gsvRoot/modelDir，
           * 显示出来会误导（实测：设置页显示 `python -m zfh_voice serve …`，
           * 而插件实际执行的是带 `--backend torch --gsv-root …` 的完整命令）。
           */
          launch: (() => {
            const svc = voiceService()
            if (svc !== null && typeof svc.status === 'function') {
              try {
                const st = svc.status()
                if (st?.launch) return st.launch
              } catch { /* 退回自己解析 */ }
            }
            const l = resolveLaunch()
            return l === null ? null : { argv: l.argv, cwd: l.cwd }
          })()
        }
      },
      /**
       * 探测合成服务：真合成一句、真播出来。
       *
       * 这是唯一能回答"开关开了为什么没声音"的手段 —— 它把失败原因
       *（连不上 / 超时 / 返回非 WAV）直接带回设置页，而不是让用户猜。
       */
      probe: async () => {
        const started = Date.now()
        const svc = voiceService()
        // 插件模式下用插件自己的 url/缓存键（缓存键含服务身份，两边算出来不同）
        const client = svc === null ? tts() : null
        const status = {
          enabled: settings.get().speakReplies === true,
          url: client === null ? (String(settings.get().ttsUrl ?? '') || DEFAULT_TTS_URL) : client.baseUrl,
          maxChars: speechMaxChars(),
          mode: svc === null ? 'http' : 'plugin',
          cached: speechCacheCount()
        }

        // ⭐ 两种模式的分工：
        //   · **插件模式** —— 直接调 `synthesize`：它会**先把服务拉起来**
        //     并等模型加载完（首次约 20 秒）。这里踩过一个真实的坑：
        //     原先不管哪种模式都只做 HTTP 健康检查，
        //     于是插件模式下服务没起时立刻报"连不上"—— 明明只要让它启动就行。
        //   · **HTTP 模式** —— 桌宠自己管进程，先健康检查再合成。
        const probeText = '嗯，我在呢。'
        let backend = null
        let bytes = null
        let durationMs = 0
        let cacheKey = null
        if (svc !== null) {
          const r = await svc.synthesize(probeText)
          if (r === null) {
            const st = (() => {
              try { return svc.status() } catch { return {} }
            })()
            return {
              ok: false,
              reason: st.lastError ?? '插件没能启动或合成（看宿主日志里的「庄方宜语音」）',
              backend: st.backend ?? null,
              elapsedMs: Date.now() - started,
              status: { ...status, service: st }
            }
          }
          bytes = r.bytes
          durationMs = r.durationMs
          backend = r.backend ?? null
        } else {
          const h = await client.health()
          if (h === null) {
            return {
              ok: false,
              reason: `连不上合成服务（${client.baseUrl}）—— 子插件起了吗？`,
              elapsedMs: Date.now() - started,
              status
            }
          }
          const r = await client.synthesize(probeText)
          if (r === null) {
            return {
              ok: false,
              backend: h.backend,
              reason: '服务在跑，但合成失败（看子插件日志）',
              elapsedMs: Date.now() - started,
              status
            }
          }
          bytes = r.bytes
          durationMs = r.durationMs
          backend = h.backend
          cacheKey = client.cacheKey(probeText)
        }

        // 存进缓存并交付给 exe 播一次（用户点"试一句"就该听到声音）。
        let played = false
        try {
          if (ensureSpeechDir()) {
            // 插件模式：我们的缓存键只用于**本地文件命名**，与插件内部缓存无关 ——
            // 用同样的算法（文本 + 服务身份）会拿不到身份，所以这里用文本哈希。
            const key = cacheKey ?? speechCacheKey(probeText, `probe:${backend ?? ''}`)
            fs.writeFileSync(path.join(SPEECH_DIR, `${key}.wav`), bytes)
            speechSeq += 1
            speechLatest = { seq: speechSeq, name: key, durationMs, text: probeText }
            hub.broadcast(withSettings(machine.snapshot()))
            played = true
            boot('动态语音探测成功，已交付播放')
          }
        } catch (error) {
          logger.warn?.(`zhuang-fangyi-pet: 探测语音写入失败：${error?.message ?? error}`)
        }
        return {
          ok: true,
          backend,
          mode: status.mode,
          elapsedMs: Date.now() - started,
          durationMs,
          played,
          // 写完**重新数盘**（不是 `+1`）：覆盖同名缓存时条数不变，见 speechCacheCount。
          status: { ...status, cached: speechCacheCount() }
        }
      }
    },
    /**
     * 记忆（契约 §3 新增）：**跨会话共享**。
     *
     * `set` 是整体替换（用户在设置页里编辑），写成功后立刻重挂 section ——
     * 否则要等下一次会话切换才生效，用户会觉得"改了没用"。
     */
    memory: {
      get: () => {
        const text = readMemoryFile(dataDir)
        return {
          /** 文件不存在时给头注释（用户打开就能看到格式说明）。 */
          text: text ?? '',
          bytes: Buffer.byteLength(text ?? '', 'utf8'),
          capBytes: MEMORY_CAP_BYTES,
          auto: settings.get().memoryAuto === true,
          /** 记忆文件位置（设置页显示给用户，方便直接用编辑器改）。 */
          file: path.join(dataDir, 'memory.md')
        }
      },
      set: text => {
        if (typeof text !== 'string') return { ok: false, reason: 'not-string' }
        if (!writeMemoryFile(dataDir, text)) return { ok: false, reason: 'write-failed' }
        boot(`记忆已更新（${Buffer.byteLength(text, 'utf8')} 字节）`)
        // 立刻把新记忆挂回会话（下次组装就带上）。
        if (chat.sessionId !== null) {
          void applyChatPersona(chat.sessionId).catch(() => {})
        }
        return {
          ok: true,
          bytes: Buffer.byteLength(text, 'utf8'),
          text
        }
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