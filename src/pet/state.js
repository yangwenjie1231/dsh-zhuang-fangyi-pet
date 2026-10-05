/**
 * 庄方宜桌宠 · 聚合状态机（**纯函数，无 IO、无定时器**）
 *
 * ── 为什么单独抽出来 ──────────────────────────────────────────────────────
 *
 * 桌宠的表现质量几乎全部取决于这个文件：它决定「现在该摆什么表情、弹什么气泡」。
 * 所以它必须能被**穷举单测**。为此它满足三条约束：
 *
 *   1. **无 IO** —— 不读文件、不发请求、不碰 DOM；
 *   2. **无定时器** —— 时间从注入的 `now()` 取，超时由显式 `tick()` 驱动；
 *      否则测试就得 `await sleep()`，既慢又不稳；
 *   3. **素材解耦** —— 气泡图由注入的 `pickBubbleImage()` 提供，本文件不知道 `art/` 的存在。
 *
 * 宿主（`index.js`）只负责把 DSH 事件翻译成 `apply()` 能吃的信封（见 `events.js`），
 * 再把这个状态机的快照塞进 SSE。exe 与窗口内 overlay 都只是消费者。
 *
 * ── 状态优先级（契约 §1，改这里必须同步改 docs/接口契约.md）───────────────
 *
 *     working(90) > waiting(80) > thinking(70) > error(60)
 *                > happy(50) > listening(40) > waking(30) > idle(20) > sleeping(10)
 *
 * 两个关键判断都有依据，不是随手排的：
 *
 *   · `error`(60) **低于** `thinking`(70)/`waiting`(80)
 *     这是照抄主题插件已验证的 `tool > running > error > done > ready > idle`
 *     顺序要解决的同一个问题：**历史错误不该覆盖当前回合**。若 error 排最高，
 *     一次失败之后宠物会一直生气，直到用户手动干预 —— 与外壳行为不一致。
 *     配合「`running` 会清除该会话的 error 闩锁」，60 只在该会话**真的停在错误上**时生效。
 *
 *   · `waiting`(80) **高于** `thinking`(70)
 *     在等你审批时最该被看到（否则一个被审批卡住的会话看起来只是"在忙"）。
 *
 * ── 多会话 ────────────────────────────────────────────────────────────────
 *
 * 每个会话一份记录，聚合时**取优先级最大者**。所以并行跑多个会话时，
 * 桌宠表现的是「最需要被看到」的那个，而不是最后收到事件的那个。
 *
 * @module src/pet/state.js
 */

// 只借一个**纯函数**（带抖动的排程计算）—— 它没有 IO 也没有状态，
// 不违反本文件"无 IO、无定时器"的约束。活跃度档位的语义真相在 `activity.js`。
import { nextIdleEmoteDelay } from './activity.js'

/** 合法状态名（契约 §1 的唯一值域；顺序即文档顺序，非优先级）。 */
export const PET_STATES = [
  'waking',
  'idle',
  'listening',
  'thinking',
  'working',
  'waiting',
  'happy',
  'error',
  'sleeping'
]

/** 状态优先级：数值大者胜（契约 §1 的表）。 */
export const STATE_PRIORITY = {
  working: 90,
  waiting: 80,
  thinking: 70,
  error: 60,
  happy: 50,
  listening: 40,
  waking: 30,
  idle: 20,
  sleeping: 10
}

/** 每个状态的文案。Host 按 `locale` 选一条，同时把 key 发给客户端以便自行本地化。 */
export const STATE_TEXT = {
  waking: { zh: '醒来了…', en: 'Waking up…' },
  idle: { zh: '待机中', en: 'Idle' },
  listening: { zh: '收到啦', en: 'Got it' },
  thinking: { zh: '正在思考…', en: 'Thinking…' },
  working: { zh: '正在调用工具…', en: 'Working…' },
  waiting: { zh: '在等你审批', en: 'Waiting for your approval' },
  happy: { zh: '完成啦', en: 'Done!' },
  error: { zh: '出错了…', en: 'Something went wrong…' },
  sleeping: { zh: '睡一会儿…', en: 'Sleeping…' }
}

/** 非「状态本身」的气泡文案（事件驱动，不改变 petState）。 */
export const EVENT_TEXT = {
  'inbox/inserted': { zh: '收到新消息', en: 'New message' },
  'tool/failed': { zh: '工具出错了', en: 'A tool failed' },
  'turn/max-tokens': { zh: '输出被截断', en: 'Output truncated' },
  /** `notifyComplete` 强提醒的文案。不是状态，只是"跑完了"的一声招呼。 */
  'notify-complete': { zh: '完成啦！来看看～', en: 'All done — take a look!' },
  'native/error': { zh: '桌面窗口开不起来', en: 'Desktop window unavailable' }
}

/** 进入这些状态时会弹一次气泡；`idle`/`waking`/`sleeping` 太安静，不弹。 */
/** 默认弹气泡的状态（`activity.js` 的"正常/调皮"档按它走）。 */
export const DEFAULT_BUBBLE_STATES = ['listening', 'thinking', 'working', 'waiting', 'happy', 'error']

/** 默认参数。全部可被 `createPetState({config})` 覆盖，便于测试用极小值。 */
export const DEFAULT_CONFIG = {
  /** 启动后的亮相时长：让用户看到"它醒了"，然后转入 idle。 */
  wakingMs: 1500,
  /** `happy` 闩锁时长：庆祝一下就回 idle，别一直傻笑。 */
  happyMs: 3000,
  /** `listening` 闩锁时长：收到消息时的短促反应。 */
  listeningMs: 1200,
  /** 全局空闲多久算睡着。 */
  sleepMs: 300000,
  /** 气泡默认停留时长。 */
  bubbleMs: 6000,
  /** 同一个 key 的气泡静默期，防刷屏。 */
  bubbleSilenceMs: 8000,
  /** 进入哪些状态时弹气泡。 */
  bubbleStates: DEFAULT_BUBBLE_STATES,
  /**
   * 空闲时**主动**蹦一个随机表情的中位间隔（ms）。`null` = 永不主动。
   *
   * 由活跃度档位给出（只有"调皮"会给一个数）。见 `activity.js`。
   */
  idleEmoteMs: null,
  /** 气泡文案语言。 */
  locale: 'zh'
}

/**
 * 哪些事件算「真实的 agent 活动」。
 *
 * 只有它们会**结束 waking**：`native/status`（宿主自己在报告）与 `tick` 不算，
 * 否则插件一启动就立刻脱离 waking，那个"醒来"的表情永远看不到。
 */
const ACTIVITY_EVENTS = new Set([
  'agent/status',
  'step/start',
  'tool/call',
  'tool/result',
  'turn/end',
  'agent/error',
  'session/error',
  'inbox/inserted',
  'approval/asked',
  'approval/decided'
])

/** 取优先级；未知状态按 idle 处理（前向兼容：新增状态不会让聚合炸掉）。 */
function priorityOf (state) {
  const p = STATE_PRIORITY[state]
  return typeof p === 'number' ? p : STATE_PRIORITY.idle
}

/**
 * 按优先级取最大者；空数组 → idle。
 *
 * **未知状态名归一化为 `idle`**：这样聚合结果永远是合法状态名，
 * 客户端与 exe 不需要处理"没见过的状态"。DSH 升级新增状态时最坏只是退化成 idle。
 */
export function highestState (states) {
  let best = 'idle'
  let bestP = -1
  for (const raw of states) {
    // 未知状态名按 idle 参与比较，但**输出**用 idle 而不是原名。
    const state = STATE_PRIORITY[raw] !== undefined ? raw : 'idle'
    const p = priorityOf(state)
    if (p > bestP) {
      bestP = p
      best = state
    }
  }
  return best
}

/** 本地化一条文案；未知 key 回落到 key 本身，绝不抛错。 */
export function textOf (table, key, locale) {
  const entry = table[key]
  if (entry === undefined || entry === null) return key
  return entry[locale] ?? entry.zh ?? key
}

/**
 * 建立一个会话记录。
 *
 * `toolsInFlight` 用 **Set 而不是计数器**：工具结果可能乱序或重复到达，
 * 按 `callId` 去重才不会把计数算歪（计数一旦变负，`working` 就永远退不出来了）。
 */
function newRecord (sessionId) {
  return {
    sessionId,
    running: false,
    toolsInFlight: new Set(),
    waiting: false,
    error: null,
    happyUntil: null,
    listeningUntil: null,
    lastEventAt: 0
  }
}

/**
 * 单个会话此刻的状态。判定顺序**必须**与优先级表一致。
 *
 * @param {object} rec - 会话记录
 * @param {number} at - 当前时间（epoch ms）
 * @returns {string} 状态名
 */
export function sessionState (rec, at) {
  if (rec.toolsInFlight.size > 0) return 'working'
  if (rec.waiting) return 'waiting'
  if (rec.running) return 'thinking'
  if (rec.error !== null) return 'error'
  if (rec.happyUntil !== null && at < rec.happyUntil) return 'happy'
  if (rec.listeningUntil !== null && at < rec.listeningUntil) return 'listening'
  return 'idle'
}

/**
 * 创建状态机。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - 时间源（测试注入假时钟）
 * @param {object} [options.config] - 覆盖 {@link DEFAULT_CONFIG}
 * @param {(key: string, seed: number) => ({file: string, hasText: boolean}|string|null)} [options.pickBubbleImage]
 *   气泡表情图选择器。返回 `{file, hasText}`、纯路径字符串、或 null。
 *   **`hasText` 必须如实反映「该图是否自带文字」** —— 状态机会据此决定要不要叠文案
 *   （见 `requestBubble` 里的说明）。**注入而非内联**：状态机不该知道素材目录的存在，
 *   测试也能给出确定结果。
 * @returns {object} 状态机实例
 */
export function createPetState (options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  // **过滤掉 undefined 的覆盖项**：`{...DEFAULT_CONFIG, ...{bubbleStates: undefined}}`
  // 会把默认值抹成 undefined，之后 `cfg.bubbleStates.includes(...)` 直接抛 TypeError。
  // 调用方传 undefined 的意图几乎总是"用默认值"，所以这里按意图处理。
  const overrides = {}
  for (const [key, value] of Object.entries(options.config ?? {})) {
    if (value !== undefined) overrides[key] = value
  }
  /** 配置（**可变**：设置页改活跃度/气泡参数要能热更新，见 `setConfig`）。 */
  let cfg = { ...DEFAULT_CONFIG, ...overrides }

  /**
   * 把配置补丁归一化：只接受已知键、过滤 undefined、夹取数值。
   *
   * 与创建期同一套规则 —— 热更新不能成为绕过校验的后门。
   */
  function normalizeConfig (patch) {
    const next = { ...DEFAULT_CONFIG }
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!(key in DEFAULT_CONFIG)) continue
      if (value === undefined) continue
      next[key] = value
    }
    // 数值字段夹取：负数/NaN 会让排程与静默期算出荒唐结果。
    for (const key of ['wakingMs', 'happyMs', 'listeningMs', 'sleepMs', 'bubbleMs', 'bubbleSilenceMs']) {
      const n = Number(next[key])
      next[key] = Number.isFinite(n) && n >= 0 ? n : DEFAULT_CONFIG[key]
    }
    if (next.idleEmoteMs !== null) {
      const n = Number(next.idleEmoteMs)
      next.idleEmoteMs = Number.isFinite(n) && n > 0 ? n : null
    }
    if (!Array.isArray(next.bubbleStates)) next.bubbleStates = DEFAULT_CONFIG.bubbleStates
    if (next.locale !== 'zh' && next.locale !== 'en') next.locale = DEFAULT_CONFIG.locale
    return next
  }

  const pickBubbleImage = typeof options.pickBubbleImage === 'function'
    ? options.pickBubbleImage
    : () => null

  /** @type {Map<string, object>} 会话 id → 记录 */
  const sessions = new Map()
  /** 气泡静默期的记账：key → 上次弹出的时间 */
  const bubbleHistory = new Map()
  const listeners = new Set()

  let rev = 0
  let petState = cfg.initialState ?? 'waking'
  let since = now()
  let lastActivityAt = since
  /**
   * `waking` 的结束时刻。
   *
   * 为什么需要它：`waking` 是个**纯时间**状态（插件刚加载，还没有任何 agent 活动）。
   * 它必须在 `wakingMs` 后自动转入 `idle`，否则桌宠会一直停在"醒来"的表情上。
   * 但只要**真实活动**先到了（用户已经在发消息），就立刻结束 waking ——
   * 不能为了演"醒来"而把真实状态压住。
   */
  let wakingUntil = since + (typeof cfg.wakingMs === 'number' ? cfg.wakingMs : 1500)
  let variantSeed = 0
  let bubble = null
  let bubbleSeq = 0
  /**
   * 最近一次「回合并干净结束」的时刻，与它已提醒到的位置。
   * `notifyComplete` 打开时，`refresh` 里发现 `lastCompletedAt > completedNotifiedAt`
   * 就**强制**弹一条提醒 —— 这是"AI 完成时通知我"的实现基础。
   * 分开记两个值，保证同一次完成只提醒一次。
   */
  let lastCompletedAt = 0
  let completedNotifiedAt = 0
  /** "调皮"档主动蹦表情的排程：下次时刻、是否已武装、以及用于绕开静默期的递增 key。 */
  let idleEmoteAt = 0
  let idleEmoteArmed = false
  let idleEmoteSeq = 0
  let nativeAvailable = false
  let nativeError = null

  function ensure (sessionId) {
    const key = String(sessionId ?? 'unknown')
    let rec = sessions.get(key)
    if (rec === undefined) {
      rec = newRecord(key)
      sessions.set(key, rec)
    }
    return rec
  }

  /** 聚合出此刻应该展示的状态。 */
  function computeState (at) {
    const states = []
    for (const rec of sessions.values()) states.push(sessionState(rec, at))
    let best = highestState(states)

    // `waking` 是启动亮相态：只在**还没有任何会话活动**、且仍在亮相窗口内时显示。
    // 一旦有真实活动（sessions 非空或已过了窗口），就交给正常的优先级聚合 ——
    // 绝不为演"醒来"而压住真实的 thinking/working。
    const hasSessions = sessions.size > 0
    if (!hasSessions && best === 'idle' && at < wakingUntil) return 'waking'

    // 睡着是**全局**判断：所有会话都静下来了，且确实安静了很久。
    // 只在聚合结果为 idle 时才可能睡着 —— happy/listening 这些闩锁态不该被盖掉。
    if (best === 'idle' && at - lastActivityAt >= cfg.sleepMs) best = 'sleeping'
    return best
  }

  /**
   * 请求弹一个气泡。三条规则，都可单测：
   *   1. 正在显示且**优先级不更高** → 拒绝（高优先级可以打断低优先级）；
   *   2. 同一个 key 在静默期内 → 拒绝（防刷屏）；
   *   3. `force` 跳过全部规则（用于用户显式操作）。
   */
  function requestBubble (key, at, extra = {}) {
    const priority = extra.priority ?? priorityOf(extra.state ?? key)

    // 挑图。`pickBubbleImage` 现在返回 `{file, hasText, opaque, fileDark}`（或 null）——
    // 必须知道这些才能：决定要不要叠文字（hasText）、要不要套气泡底（opaque）、
    // 深色模式下用哪个文件（fileDark，由渲染方按自己的主题挑）。
    const picked = extra.image !== undefined ? extra.image : pickBubbleImage(key, variantSeed)
    const image = picked === null || picked === undefined
      ? null
      : (typeof picked === 'string' ? picked : (picked.file ?? null))
    const imageHasText = typeof picked === 'object' && picked !== null && picked.hasText === true
    const imageOpaque = typeof picked === 'object' && picked !== null && picked.opaque === true
    const imageDark = typeof picked === 'object' && picked !== null && typeof picked.fileDark === 'string'
      ? picked.fileDark
      : null

    // ⭐ 图自带文字时**不叠 Host 文案**：否则屏幕上会出现两段互相打架的文字
    //（例如贴纸写着「好耶！」，气泡又写「完成啦」）。
    // 这不是显示偏好，是正确性要求 —— 见契约 §4 的 `hasText`。
    const text = imageHasText
      ? null
      : (extra.text ?? textOf(extra.table ?? STATE_TEXT, key, cfg.locale))

    if (extra.force !== true) {
      if (bubble !== null && at < bubble.at + bubble.durationMs && priority <= bubble.priority) return false
      const last = bubbleHistory.get(key)
      if (last !== undefined && at - last < cfg.bubbleSilenceMs) return false
    }

    bubbleSeq += 1
    bubble = {
      id: bubbleSeq,
      kind: image === null ? 'text' : (text ? 'both' : 'image'),
      image: image ?? null,
      text: text ?? null,
      /** 该图是否自带文字（透传给客户端，便于诊断与样式微调）。 */
      imageHasText,
      /** 该图是否不透明满幅（自带底色，渲染方不该再套气泡底）。 */
      imageOpaque: imageOpaque,
      /** 深色模式变体路径（渲染方按自己的主题挑；null 表示没有变体）。 */
      imageDark,
      durationMs: extra.durationMs ?? cfg.bubbleMs,
      priority,
      state: extra.state ?? null,
      at
    }
    bubbleHistory.set(key, at)
    return true
  }

  /** 重新求值；状态或气泡变化时推进 `rev` 并通知监听者。 */
  function refresh (at) {
    const next = computeState(at)
    let changed = false

    if (next !== petState) {
      petState = next
      since = at
      variantSeed += 1
      changed = true
      if (cfg.bubbleStates.includes(next)) {
        if (requestBubble(next, at, { state: next })) changed = true
      }
    }

    // ⭐ "AI 完成时提醒我"：一回合成干净结束（completed）就**强制**弹一条。
    // 这是用户点名的功能 —— `happy` 闩锁气泡可能被静默期/优先级挡掉，
    // 但"跑完了"这个事实值得立刻知道。所以绕过 requestBubble 的三条规则
    //（等价于 `force: true`），只受 `notifyComplete` 与气泡总开关约束。
    // **气泡总开关优先**：`bubbleStates: []` 表达"用户不想要任何气泡"，
    // 提醒再重要也不能违背它 —— 否则关了气泡还会突然蹦一条，等于失控。
    if (cfg.notifyComplete === true &&
        cfg.bubbleStates.length > 0 &&
        lastCompletedAt > completedNotifiedAt) {
      completedNotifiedAt = lastCompletedAt
      if (requestBubble('notify-complete', at, {
        state: 'happy',
        force: true,
        priority: priorityOf('happy'),
        table: EVENT_TEXT
      })) changed = true
    }

    // ⭐ 活跃度"调皮"：空闲时**主动**蹦一个随机表情。
    //
    // 只在 truly idle（不是 working/sleeping/waiting）时才会蹦 —— 用户在忙的时候
    // 桌宠自己跳出来卖萌是干扰，不是可爱。
    //
    // 每次都重新排下一次（哪怕这次没弹）：排程本身就是限流，
    // 所以用**带计数的 key**绕开按 key 的静默期，而不是靠静默期限流。
    if (typeof cfg.idleEmoteMs === 'number' && cfg.idleEmoteMs > 0 && cfg.bubbleStates.length > 0) {
      if (idleEmoteArmed === false) {
        idleEmoteAt = at + nextIdleEmoteDelay(cfg.idleEmoteMs)
        idleEmoteArmed = true
      } else if (petState === 'idle' && at >= idleEmoteAt) {
        idleEmoteSeq += 1
        requestBubble(`idle-emote-${idleEmoteSeq}`, at, { state: 'idle' })
        idleEmoteAt = at + nextIdleEmoteDelay(cfg.idleEmoteMs)
        changed = true
      } else if (petState !== 'idle' && at >= idleEmoteAt) {
        // 忙着呢 —— 这段时间不算数，重新排，别一空下来就立刻蹦。
        idleEmoteAt = at + nextIdleEmoteDelay(cfg.idleEmoteMs)
      }
    } else {
      idleEmoteArmed = false
    }

    // 气泡过期：清掉，让客户端收起气泡窗。
    if (bubble !== null && at >= bubble.at + bubble.durationMs) {
      bubble = null
      changed = true
    }

    if (changed) {
      rev += 1
      const snap = snapshot(at)
      for (const fn of listeners) {
        try {
          fn(snap)
        } catch {
          // 监听者抛错不该拖垮状态机（与官方 emit 语义一致：监听失败被容纳）。
        }
      }
    }
    return changed
  }

  /**
   * 应用一个事件信封（由 `events.js` 从真实 DSH 事件翻译而来）。
   *
   * 未知 `type` 一律**静默忽略**：DSH 版本升级新增事件时桌宠不该崩，
   * 这是前向兼容的硬要求。
   *
   * @param {object} event - `{type, sessionId?, ...}`
   * @returns {boolean} 是否引起了可见变化
   */
  function apply (event) {
    if (event === null || typeof event !== 'object') return false
    const at = now()
    const type = String(event.type ?? '')
    const sessionId = event.sessionId

    switch (type) {
      case 'agent/status': {
        const rec = ensure(sessionId)
        rec.lastEventAt = at
        if (event.status === 'running') {
          rec.running = true
          // 关键：新回合一开始就清掉错误闩锁，否则「历史错误覆盖当前回合」。
          rec.error = null
          rec.happyUntil = null
          rec.listeningUntil = null
        } else {
          rec.running = false
          // 兜底：真的 idle 了却还有在飞工具，说明结果事件丢了。
          // 不清掉的话桌宠会永远卡在 working —— 宁可保守复位。
          rec.toolsInFlight.clear()
        }
        break
      }

      case 'step/start': {
        const rec = ensure(sessionId)
        rec.running = true
        rec.lastEventAt = at
        break
      }

      case 'tool/call': {
        const rec = ensure(sessionId)
        rec.running = true
        rec.toolsInFlight.add(String(event.callId ?? `${at}-${rec.toolsInFlight.size}`))
        rec.lastEventAt = at
        break
      }

      case 'tool/result': {
        const rec = ensure(sessionId)
        if (event.callId !== undefined) rec.toolsInFlight.delete(String(event.callId))
        else if (rec.toolsInFlight.size > 0) {
          // 没有 callId 时退化为「移除一个」，保守但不会卡死。
          rec.toolsInFlight.delete(rec.toolsInFlight.values().next().value)
        }
        rec.lastEventAt = at
        if (event.isError === true) {
          requestBubble('tool/failed', at, {
            table: EVENT_TEXT, text: textOf(EVENT_TEXT, 'tool/failed', cfg.locale),
            priority: STATE_PRIORITY.thinking, state: 'working'
          })
        }
        break
      }

      case 'turn/end': {
        const rec = ensure(sessionId)
        rec.running = false
        rec.toolsInFlight.clear()
        rec.lastEventAt = at
        const kind = event.reason?.kind ?? event.reason ?? 'completed'
        if (kind === 'completed') {
          rec.happyUntil = at + cfg.happyMs
          rec.error = null
          // 记下"最近一次干净完成"的时刻，供 `notifyComplete` 强提醒用
          //（refresh 里比较这个值，知道有没有**新的**完成要提醒）。
          if (at > lastCompletedAt) lastCompletedAt = at
        } else if (kind === 'error' || kind === 'max-tokens') {
          rec.error = {
            text: kind === 'max-tokens'
              ? textOf(EVENT_TEXT, 'turn/max-tokens', cfg.locale)
              : (event.message ?? textOf(STATE_TEXT, 'error', cfg.locale)),
            kind,
            at
          }
          rec.happyUntil = null
        } else {
          // aborted / interrupted / blocked / forked / 未来新增的未知原因
          // → 一律回 idle。未知原因按「干净结束」处理最安全。
          rec.happyUntil = null
        }
        break
      }

      case 'agent/error':
      case 'session/error': {
        const rec = ensure(sessionId)
        rec.error = { text: event.message ?? textOf(STATE_TEXT, 'error', cfg.locale), kind: 'error', at }
        rec.happyUntil = null
        rec.lastEventAt = at
        break
      }

      case 'inbox/inserted': {
        const rec = ensure(sessionId)
        rec.listeningUntil = at + cfg.listeningMs
        rec.lastEventAt = at
        requestBubble('inbox/inserted', at, {
          table: EVENT_TEXT, text: textOf(EVENT_TEXT, 'inbox/inserted', cfg.locale),
          priority: STATE_PRIORITY.listening, state: 'listening'
        })
        break
      }

      case 'approval/asked': {
        const rec = ensure(sessionId)
        rec.waiting = true
        rec.lastEventAt = at
        break
      }

      case 'approval/decided': {
        const rec = ensure(sessionId)
        rec.waiting = false
        rec.lastEventAt = at
        break
      }

      case 'session/gone': {
        sessions.delete(String(sessionId ?? 'unknown'))
        break
      }

      case 'native/status': {
        nativeAvailable = event.available === true
        nativeError = nativeAvailable ? null : (event.reason ?? null)
        break
      }

      case 'wake': {
        // 醒来：把静默计时重置，让 sleeping 立刻退出。
        lastActivityAt = at
        break
      }

      case 'tick': {
        // 只驱动超时求值，不改任何记账。
        break
      }

      default:
        // 未知事件：忽略，但**不重置** lastActivityAt —— 否则任何无关事件
        // 都会把桌宠从睡着里叫醒。只有已知的真实活动才算活动。
        return false
    }

    // 只有**真实的 agent 活动**才重置全局静默计时。
    //
    // `tick` 是自己驱动的求值（显然不算活动）；`native/status` 是宿主在报告
    // exe 可用性 —— 它不是用户/agent 的活动，若算进去，exe 每次重连都会
    // 把桌宠从睡着里叫醒，那就不对了。
    if (ACTIVITY_EVENTS.has(type)) lastActivityAt = at
    return refresh(at)
  }

  /** 取当前快照（契约 §2）。 */
  function snapshot (at = now()) {
    const state = computeState(at)
    return {
      rev,
      petState: state,
      labelKey: state,
      label: textOf(STATE_TEXT, state, cfg.locale),
      since,
      variantSeed,
      bubble: bubble === null
        ? null
        : {
            id: bubble.id,
            kind: bubble.kind,
            image: bubble.image,
            text: bubble.text,
            /** 该图是否自带文字（`kind === 'image'` 时通常为 true）。 */
            imageHasText: bubble.imageHasText === true,
            /** 该图是否不透明满幅（自带底色，渲染方不该再套气泡底）。 */
            imageOpaque: bubble.imageOpaque === true,
            /** 深色模式变体路径（渲染方按自己的主题挑；null 表示没有）。 */
            imageDark: bubble.imageDark ?? null,
            durationMs: bubble.durationMs,
            priority: bubble.priority
          },
      sessions: [...sessions.values()].map(rec => ({
        sessionId: rec.sessionId,
        state: sessionState(rec, at),
        toolsInFlight: rec.toolsInFlight.size
      })),
      nativeAvailable,
      nativeError
    }
  }

  return {
    apply,
    tick: () => refresh(now()),
    snapshot,
    /**
     * 热更新配置（**改完立即生效，不需要重载插件**）。
     *
     * 用途：活跃度档位、气泡时长/间隔、完成提醒这些都在设置页里现改 ——
     * 用户点一下就该看到差别，而不是"重启 DSH 才生效"。
     * 走的是同一套 `normalizeConfig`，所以非法值依旧被挡住。
     *
     * @param {object} patch - 配置补丁（只写要改的字段）
     */
    setConfig (patch) {
      cfg = normalizeConfig({ ...cfg, ...patch })
      // 换档后立刻重算：比如从"安静"切到"调皮"，当前该不该弹要马上重新判断。
      idleEmoteArmed = false
      refresh(now())
    },
    /**
     * 各会话的活跃记账（**供"发消息挑目标会话"用**）。
     *
     * 快照里的 `sessions` 只有 `{sessionId, state, toolsInFlight}`，**不带时间**，
     * 判不出谁最近活跃。这里把内部记录里已有的 `lastEventAt` 透出来，
     * 让上层挑"最近那个会话"时用的是同一份真相，而不是另建一套认知。
     *
     * @returns {Array<{sessionId: string, at: number, state: string, running: boolean, toolsInFlight: number}>}
     *   按 `at` 降序（最近活跃在前）。空会话列表返回 []。
     */
    sessionStats () {
      const at = now()
      return [...sessions.values()]
        .map(rec => ({
          sessionId: rec.sessionId,
          at: typeof rec.lastEventAt === 'number' ? rec.lastEventAt : 0,
          state: sessionState(rec, at),
          running: rec.running === true,
          toolsInFlight: rec.toolsInFlight.size
        }))
        .sort((a, b) => b.at - a.at)
    },
    /** 订阅变化；返回取消函数。监听者抛错被容纳，不影响其它监听者。 */
    on (fn) {
      if (typeof fn !== 'function') return () => {}
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** 供测试与调试读取内部记账。 */
    internals: {
      sessions,
      config: cfg,
      get rev () {
        return rev
      },
      get variantSeed () {
        return variantSeed
      },
      reset () {
        sessions.clear()
        bubbleHistory.clear()
        bubble = null
        rev = 0
        variantSeed = 0
        petState = 'waking'
        since = now()
        lastActivityAt = since
        wakingUntil = since + (typeof cfg.wakingMs === 'number' ? cfg.wakingMs : 1500)
      }
    }
  }
}
