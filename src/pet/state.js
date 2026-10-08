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
  /**
   * `listening` **保留在值域里，但运行时不再产出**（用户 2026-10-07：
   * 「Listening 这个状态几乎不会出现（过的很快，而且意义不大）」）。
   *
   * 它原本是 `inbox/inserted` 置的一个 1.2 秒闩锁，优先级低于 thinking ——
   * 于是只有在"你刚发完消息、agent 还没起跑"的那 1.2 秒里才可能成为 petState，
   * agent 一开跑就被 thinking 盖掉；而它那组图（眨眼等）与 idle 撞脸，
   * 就算闪过你也分辨不出来。改为**只弹气泡**（`inbox/inserted` 事件本来就有）。
   *
   * 保留条目是为了**向后兼容**：契约 §1 的 9 个状态名、老客户端、老设置都不动。
   */
  listening: 40,
  waking: 30,
  idle: 20,
  sleeping: 10
}

/**
 * 哪些状态**不受最短驻留约束**（切过去立即生效）。
 *
 * 驻留是为了消除抖动（见 `effectiveSessionState`），但这几个是"事件时刻"：
 * 完成 / 出错 / 等你审批 / 刚醒 / 睡着 —— 晚 2 秒才出��会让语音与画面对不上，
 * 「等你审批」更是会把一次**要人动手**的提醒硬压两秒。
 */
export const DWELL_EXEMPT_STATES = new Set(['waking', 'happy', 'error', 'waiting', 'sleeping'])

/** 每个状态的文案。Host 按 `locale` 选一条，同时把 key 发给客户端以便自行本地化。 */
export const STATE_TEXT = {
  waking: { zh: '醒来了…', en: 'Waking up…' },
  idle: { zh: '待机中', en: 'Idle' },
  /** 保留在值域里但运行时不再产出（见 `STATE_PRIORITY.listening` 的说明）。 */
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
  'inbox/inserted': { zh: '收到，说吧。', en: "Got it — go ahead." },
  'tool/failed': { zh: '工具出错了', en: 'A tool failed' },
  'turn/max-tokens': { zh: '输出被截断', en: 'Output truncated' },
  /** `notifyComplete` 强提醒的文案。不是状态，只是"跑完了"的一声招呼。 */
  'notify-complete': { zh: '完成啦！来看看～', en: 'All done — take a look!' },
  /** 常亮提醒：AI 在等你回答问题（`ask_user_question`）。 */
  'ask-user': { zh: '问了你一个问题，在等你回答…', en: 'Asked you a question — waiting…' },
  'native/error': { zh: '桌面窗口开不起来', en: 'Desktop window unavailable' },

  // ── 番茄钟（用户点名："增加番茄钟提醒我休息"）────────────────────────────
  //
  // 文案放在这里而不是拼在 Host 里：`locale` 是状态机的配置，文案表也在
  // 状态机里 —— 在 Host 拼字符串会让"中英切换"这件事有两个真相。
  'pomodoro/focus-start': { zh: '开始专注啦，加油～', en: 'Focus time — go!' },
  'pomodoro/focus-end': { zh: '专注结束，去休息一下吧', en: 'Focus done — take a break' },
  /**
   * v10：专注结束的两个极端档。
   *
   * 用户："当前的番茄钟太简单了"。这两个 key 是"互动 ↔ 番茄钟"真正连起来的
   * 地方 —— 她不只是计时，她**记得你中途碰了她几次**。
   *
   * `-busted` 的文案里带 `{n}`：具体次数由调用方（`index.js`）填进去。
   * 为什么不在这里写死"好几次"：含糊的说法没有杀伤力，而"你摸了我 7 次"
   * 才是这个功能有趣的地方（用户要的就是"更有意思"）。
   */
  'pomodoro/focus-end-clean': { zh: '整整一轮，一次都没碰我。厉害。', en: 'A whole round — you never touched me. Nice.' },
  'pomodoro/focus-end-busted': { zh: '这一轮你摸了我 {n} 次。', en: 'You poked me {n} times that round.' },

  /**
   * v10：**手势首次指引**（用户 2026-10-08："手势之内的缺乏第一次的指引"）。
   *
   * 这是一个**我自己造成的**问题：v10 把互动从右键菜单里移走了（避免"同一个
   * 动作两个入口"），却没有任何**发现途径** —— 用户不可能凭空猜到
   * "按住不动 = 摸头"、"甩出去 = 抛掷"。功能都在，但没人知道怎么用。
   *
   * 文案必须**一句话讲完三个手势**：气泡宽度有限（`MaxWidth` 240px），
   * 分三条弹会像广告。所以用「·」分隔的短句，一眼扫完。
   */
  'pet/gesture-hint': {
    zh: '点一下打招呼 · 按住不动是摸头 · 甩出去她会飞',
    en: 'Click to greet · hold still to pet · flick her and she flies'
  },
  'pomodoro/break-end': { zh: '休息结束，继续加油！', en: 'Break over — back to it!' },
  'pomodoro/long-end': { zh: '长休息结束，回来啦～', en: 'Long break over — welcome back!' }
}

/** 进入这些状态时会弹一次气泡；`idle`/`waking`/`sleeping` 太安静，不弹。 */
/** 默认弹气泡的状态（`activity.js` 的"正常/调皮"档按它走）。 */
export const DEFAULT_BUBBLE_STATES = ['thinking', 'working', 'waiting', 'happy', 'error']

/** 默认参数。全部可被 `createPetState({config})` 覆盖，便于测试用极小值。 */
export const DEFAULT_CONFIG = {
  /** 启动后的亮相时长：让用户看到"它醒了"，然后转入 idle。 */
  wakingMs: 1500,
  /** `happy` 闩锁时长：庆祝一下就回 idle，别一直傻笑。 */
  happyMs: 3000,
  /**
   * **过程态的最短驻留**（ms）：切到新状态不足这么久就继续显示上一个。
   *
   * 为什么需要它：`thinking` 与 `working` 是**交替**而不是阶段 ——
   * `sessionState()` 里 `toolsInFlight > 0` 就是 working，否则 running 就是 thinking。
   * 于是每个工具调用都会来一轮「想 → 做 → 回到想」，而一次本地工具常常只有
   * 几十~几百毫秒。切状态就会换图（exe 换精灵条带），于是桌面上一直在抖，
   * 变体轮换还没轮到就被抖回去了 —— 这正是"主体变化度少"的一半原因。
   *
   * 2 秒是用户定的值。豁免名单见 `DWELL_EXEMPT_STATES`（完成/出错/等你审批等
   * 事件时刻立即生效，不被压两秒）。测试可置 0 恢复"立刻响应"的旧行为。
   */
  minStateDwellMs: 2000,
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
  /**
   * 「授权/提问常亮提醒」开关（用户点名的功能）。
   *
   * 开启时：AI 要授权（`approval/asked`）或提问（`ask_user_question`）期间，
   * 气泡**常亮直到处理完**，不受 `bubbleMs` 影响。
   * 关闭时：完全回到现状（审批只弹 6 秒）。
   *
   * **独立于 `bubble` 总开关**：关掉普通气泡不等于不想要审批提醒。
   */
  attentionReminder: true,
  /**
   * 常亮提醒的**兜底上限**（ms）：超过这个时长还没被处理就自动放下。
   *
   * 为什么必须有：提问的清除依赖 `tool/result`（实测真实 tool/result 不带 callId，
   * 只能保守清除）；一旦某个事件没到，提醒会永久挂在屏幕上挡住视线。
   * 30 分钟足够人离开电脑吃顿饭再回来，也不会变成"永久钉子"。
   */
  attentionMaxMs: 1800000,
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
 * 气泡文案解析：**两张表都查**，再回落 key。
 *
 * ── 为什么需要它（真机上出过的事故）────────────────────────────────────
 *
 * `requestBubble` 原先只查 `extra.table ?? STATE_TEXT`。而调用方很容易忘传
 * `table` —— `pet/gesture-hint` 就写在 `EVENT_TEXT` 里，调用时没传 table，
 * 于是 `textOf` 查不到、按设计**回落成 key 本身**，用户在气泡里看到的是一串
 * 「pet/gesture-hint」英文键名（或者更糟：被贴纸的 `hasText` 规则整个吞掉，
 * 一个字都不显示）。
 *
 * 这个回落"绝不抛错"的设计本身是对的（文案缺失不该让桌宠崩），但它**太安静**：
 * 写错了表名没有任何信号。所以这里改成**两张表都查**：
 *   · 显式给了 `table` → 先查它（调用方明确指定时必须尊重）；
 *   · 都不是 → 再依次查另一张；
 *   · 仍然没有 → 才回落 key。
 *
 * 这样"表名写错"这个错误类别**根本不存在**了，而不是靠人记得传参。
 */
function resolveBubbleText (table, key, locale) {
  const tables = table === undefined || table === null
    ? [STATE_TEXT, EVENT_TEXT]
    : [table, table === STATE_TEXT ? EVENT_TEXT : STATE_TEXT]
  for (const t of tables) {
    const entry = t[key]
    if (entry !== undefined && entry !== null) {
      return entry[locale] ?? entry.zh ?? key
    }
  }
  return key
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
    /** `ask_user_question` 已发出、还没拿到回答（常亮提醒的 question 一侧）。 */
    askPending: false,
    /**
     * 当前待处理事项（waiting 或 askPending）的起始时刻。
     * 既是提醒的 `since`，也是**兜底上限** `attentionMaxMs` 的计时起点。
     */
    attentionSince: null,
    error: null,
    happyUntil: null,
    /**
     * **最短驻留闩锁**：上一次"对外显示"的状态与起始时刻（见
     * `effectiveSessionState`）。`null` = 还没显示过任何状态。
     *
     * 为什么按会话存而不是全局存：快照里的 `sessions[].state` 也要过闩锁 ——
     * exe 的 `EffectiveState()` 会拿各会话状态与顶层 `petState` 比优先级取最大，
     * 只锁顶层的话原始会话状态会把它顶回去，抖动照旧。
     */
    latchState: null,
    latchSince: 0,
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
  return 'idle'
}

/**
 * 单个会话此刻**对外显示**的状态 = `sessionState()` 过一道最短驻留闩锁。
 *
 * 规则（用户定的 2 秒）：
 *   · 与上次显示相同 → 不动（`latchSince` 也不动）；
 *   · 新旧**都**是过程态（不在 `DWELL_EXEMPT_STATES` 里）且距上次切换不足
 *     `minStateDwellMs` → **继续显示上一个**；
 *   · 其余（事件时刻：完成/出错/等你审批/刚醒/睡着）→ 立即切换。
 *
 * 为什么需要：见 `DEFAULT_CONFIG.minStateDwellMs` —— thinking 与 working 是交替的，
 * 一个工具调用就能触发一次切换，几百毫秒一轮，桌面上一直在抖。
 *
 * 纯函数性：只改 `rec` 上的两个字段（闩锁记账），不改任何语义状态。
 *
 * @param {object} rec - 会话记录
 * @param {number} at - 当前时间（epoch ms）
 * @param {number} dwellMs - 最短驻留（`0` = 不驻留，直接返回 `sessionState()`）
 * @returns {string} 状态名
 */
export function effectiveSessionState (rec, at, dwellMs) {
  const raw = sessionState(rec, at)
  if (!(dwellMs > 0)) return raw
  if (rec.latchState === null) {
    rec.latchState = raw
    rec.latchSince = at
    return raw
  }
  if (raw === rec.latchState) return raw
  const bothProcess = !DWELL_EXEMPT_STATES.has(raw) &&
    !DWELL_EXEMPT_STATES.has(rec.latchState)
  if (bothProcess && at - rec.latchSince < dwellMs) return rec.latchState
  rec.latchState = raw
  rec.latchSince = at
  return raw
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
    for (const key of ['wakingMs', 'happyMs', 'minStateDwellMs', 'sleepMs', 'bubbleMs', 'bubbleSilenceMs']) {
      const n = Number(next[key])
      next[key] = Number.isFinite(n) && n >= 0 ? n : DEFAULT_CONFIG[key]
    }
    if (next.idleEmoteMs !== null) {
      const n = Number(next.idleEmoteMs)
      next.idleEmoteMs = Number.isFinite(n) && n > 0 ? n : null
    }
    if (!Array.isArray(next.bubbleStates)) next.bubbleStates = DEFAULT_CONFIG.bubbleStates
    // 常亮提醒：非布尔一律回落默认（true）；上限必须是有限正数，
    // 否则 `at - since >= NaN` 永远为 false，兜底就失效了。
    next.attentionReminder = next.attentionReminder === true || next.attentionReminder === false
      ? next.attentionReminder
      : DEFAULT_CONFIG.attentionReminder
    {
      const n = Number(next.attentionMaxMs)
      next.attentionMaxMs = Number.isFinite(n) && n > 0 ? n : DEFAULT_CONFIG.attentionMaxMs
    }
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
  /**
   * 当前「授权/提问」待处理提醒（契约 §2 的 `attention` 块）。
   * 由 `refresh()` 每次重算；`null` = 没有需要处理的事。
   */
  let lastAttention = null
  let lastAttentionKey = null
  /**
   * 外部功能请求的一条气泡（**番茄钟提醒 / 互动反应 / 聊天回复共用**）。
   *
   * 为什么走"挂起 + `refresh` 消费"而不是直接调 `requestBubble`：
   * `requestBubble` 只改 `bubble`，**不推进 `rev`、不广播** —— 直接调会得到
   * "气泡已经设好了但客户端收不到"的诡异现象（`bubble` 变了而 rev 没变，
   * 客户端按 rev 去重就把它丢了）。挂在这里让 `refresh` 消费，就复用了
   * 同一条 rev/广播通道，不另开旁路。
   */
  let pendingNotify = null
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
    for (const rec of sessions.values()) states.push(effectiveSessionState(rec, at, cfg.minStateDwellMs))
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
      : (extra.text ?? resolveBubbleText(extra.table, key, cfg.locale))

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

  /**
   * 计算当前「授权/提问」待处理提醒（契约 §2 `attention`）。
   *
   * 规则：
   *   · `approval`（在等你审批）**压过** `question`（问了你问题）；
   *   · 同级取 `lastEventAt` 最新的那个会话（桌宠此刻最可能在演它）；
   *   · `count` = 待处理会话总数（同时有两处要处理时给渲染方一个"2"）；
   *   · **兜底上限** `attentionMaxMs`：超时的会话直接不再提醒 ——
   *     提问的清除依赖 tool/result（真实事件不带 callId，只能保守），
   *     事件没到时必须能自己放下，绝不能永久钉在屏幕上。
   *
   * @param {number} at
   * @returns {object|null}
   */
  function computeAttention (at) {
    if (cfg.attentionReminder !== true) return null
    let best = null
    let bestSeverity = 0
    let count = 0
    for (const rec of sessions.values()) {
      let kind = null
      if (rec.waiting === true) kind = 'approval'
      else if (rec.askPending === true) kind = 'question'
      if (kind === null) continue
      const since = rec.attentionSince ?? rec.lastEventAt
      if (at - since >= cfg.attentionMaxMs) continue // 超上限：放下这个（每个会话独立计时）
      count += 1
      const severity = kind === 'approval' ? 2 : 1
      if (severity > bestSeverity ||
          (severity === bestSeverity && rec.lastEventAt >= (best?.lastEventAt ?? -Infinity))) {
        best = { kind, sessionId: rec.sessionId, since, lastEventAt: rec.lastEventAt }
      }
    }
    if (best === null) return null
    const text = best.kind === 'approval'
      ? textOf(STATE_TEXT, 'waiting', cfg.locale)
      : textOf(EVENT_TEXT, 'ask-user', cfg.locale)
    return { kind: best.kind, sessionId: best.sessionId, text, since: best.since, count }
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

    // ── ⭐ 常亮提醒（attention）─────────────────────────────────────────────
    //
    // 它**接管**普通气泡的显示位，直到被处理或触达上限：
    //   · 出现/切换（不同会话或重新发起）→ 换一个新气泡（id 递增，渲染方据此重绘）；
    //   · 还在等 → 保持不动（sticky：不走下面的过期清理）；
    //   · 撤了 → 立刻收起。
    const attention = computeAttention(at)
    const attentionKey = attention === null
      ? null
      : `${attention.kind}:${attention.sessionId}:${attention.since}`
    if (attentionKey !== null) {
      const current = bubble !== null && bubble.kind === 'attention' ? bubble : null
      if (current === null || current.attentionKey !== attentionKey) {
        bubble = {
          id: ++bubbleSeq,
          kind: 'attention',
          attentionKey,
          image: null,
          imageHasText: false,
          imageOpaque: false,
          imageDark: null,
          text: attention.text,
          /** 常亮：渲染方不按 durationMs 收，一切以 attention 块为准。 */
          sticky: true,
          /** 待处理计数（渲染方徽标）；创建时就带上，否则首帧会显示成 1。 */
          attentionCount: attention.count,
          // durationMs 只作最后防线（与 attentionMaxMs 同源）；正常靠 attention=null 收。
          durationMs: cfg.attentionMaxMs,
          // 高于 working(90)：普通气泡在它存续期间全被优先级挡住。
          priority: 100,
          state: null,
          at
        }
        changed = true
      } else if (current.text !== attention.text || current.attentionCount !== attention.count) {
        // 文案（locale/审批类型）或 count 变了：同 key 也要刷新显示。
        current.text = attention.text
        current.attentionCount = attention.count
        changed = true
      }
    } else if (bubble !== null && bubble.kind === 'attention') {
      bubble = null // 提醒被处理/超时撤下 → 立刻收起
      changed = true
    }
    // 提醒块本身变了（即使气泡内容没变，count/session 变化也要推进 rev）。
    const prevAttentionKey = lastAttentionKey
    lastAttention = attention
    lastAttentionKey = attentionKey
    if (attentionKey !== prevAttentionKey) changed = true

    // ⭐ "AI 完成时提醒我"：一回合成干净结束（completed）就**强制**弹一条。
    // 这是用户点名的功能 —— `happy` 闩锁气泡可能被静默期/优先级挡掉，
    // 但"跑完了"这个事实值得立刻知道。所以绕过 requestBubble 的三条规则
    //（等价于 `force: true`），只受 `notifyComplete` 与气泡总开关约束。
    // **气泡总开关优先**：`bubbleStates: []` 表达"用户不想要任何气泡"，
    // 提醒再重要也不能违背它 —— 否则关了气泡还会突然蹦一条，等于失控。
    // **attention 优先级更高**：正在等你审批时，"完成啦"的声势必须让位。
    if (attentionKey === null &&
        cfg.notifyComplete === true &&
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
    if (attentionKey === null &&
        typeof cfg.idleEmoteMs === 'number' && cfg.idleEmoteMs > 0 && cfg.bubbleStates.length > 0) {
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
    } else if (attentionKey === null) {
      idleEmoteArmed = false
    }

    // ⭐ 外部功能的气泡（番茄钟提醒 / 互动反应 / 聊天回复）──
    //
    // 放在 notify-complete 之后、idleEmote 之前：它的优先级比"AI 跑完了"低
    // （后者是用户点名的强提醒），但比"闲着没事蹦一个"高。
    //
    // `pendingNotify` 由公开的 `notify()` 挂上；这里消费并清空。
    // **只在 attention 不存续时消费**：正在等你审批时，番茄钟的"休息一下"
    // 不该把审批提醒挤掉（那会让你漏掉真正卡住的事）。被挤掉的通知就丢弃，
    // 而不是排队 —— 一条 30 秒后才出现的"该休息了"是误导。
    if (pendingNotify !== null) {
      const req = pendingNotify
      pendingNotify = null
      if (attentionKey === null && cfg.bubbleStates.length > 0) {
        if (requestBubble(req.key, at, {
          state: req.state ?? null,
          text: req.text ?? undefined,
          force: true,
          priority: req.priority ?? 95,
          durationMs: req.durationMs,
          image: req.image
        })) changed = true
      }
    }

    // 气泡过期：清掉，让客户端收起气泡窗。
    // **sticky（attention）不过期** —— 它的存续由上面的 attention 块决定。
    if (bubble !== null && bubble.sticky !== true && at >= bubble.at + bubble.durationMs) {
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
        // ⭐ AI 在等你回答问题（`ask_user_question` 是阻塞工具：结果要等你选）。
        // 这就是常亮提醒的 question 一侧 —— 没有它，提问只会表现为 working，
        // 6 秒气泡过去后桌面毫无动静，人不在电脑前就错过了。
        if (event.name === 'ask_user_question' && rec.askPending !== true) {
          rec.askPending = true
          // 同会话已有待处理事项（如审批）时保留原起点：计时取最早。
          if (rec.attentionSince === null) rec.attentionSince = at
        }
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
        // 提问被回答 = 没有在飞的工具了（真实 tool/result **不带 callId**，
        // 无法精确配对，用"归零"做保守清除；归不了零的还有 attentionMaxMs 兜底）。
        if (rec.askPending === true && rec.toolsInFlight.size === 0) {
          rec.askPending = false
          if (!rec.waiting) rec.attentionSince = null
        }
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
        // 回合结束 = 提问无论答没答都被收回（模型不再等了），提醒跟着撤。
        rec.askPending = false
        if (!rec.waiting) rec.attentionSince = null
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
        rec.lastEventAt = at
        // ⭐ 只弹气泡，**不再切主体状态**（用户 2026-10-07）。
        // 原先这里置一个 1.2 秒的 `listeningUntil` 闩锁，但 `listening` 优先级低于
        // `thinking` —— agent 一开跑就被盖掉，于是它极少真正成为 petState；
        // 而它那组图与 idle 撞脸，闪过也分辨不出。现在"收到"这件事由气泡承担。
        //
        // ⚠️ `state: 'inbox/inserted'` 是**挑图用的情境 key**（见 `pickBubbleImage`），
        // 不是 petState —— 别再写 `state: 'listening'`。
        requestBubble('inbox/inserted', at, {
          table: EVENT_TEXT, text: textOf(EVENT_TEXT, 'inbox/inserted', cfg.locale),
          priority: STATE_PRIORITY.listening, state: 'inbox/inserted'
        })
        break
      }

      case 'approval/asked': {
        const rec = ensure(sessionId)
        rec.waiting = true
        // 计时从**最早**的待处理事项算起（同会话先提问后审批时保留提问的起点）。
        if (rec.attentionSince === null) rec.attentionSince = at
        rec.lastEventAt = at
        break
      }

      case 'approval/decided': {
        const rec = ensure(sessionId)
        rec.waiting = false
        rec.lastEventAt = at
        // 审批处理完：若没有提问还挂着，起始时刻一并清掉。
        if (!rec.askPending) rec.attentionSince = null
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
            /** 常亮气泡（attention）：**不按 durationMs 收**，以 attention 块为准。 */
            sticky: bubble.sticky === true,
            /** attention 的待处理计数（渲染方显示"2 项待处理"；普通气泡为 1）。 */
            attentionCount: bubble.attentionCount ?? 1,
            durationMs: bubble.durationMs,
            priority: bubble.priority
          },
      /**
       * 契约 §2 `attention`：当前**等你处理**的事（授权/提问）。
       *
       * `null` = 没有。渲染方用它决定常亮气泡的显隐与样式；
       * **缺该块（旧 Host）按 null 处理**（向后兼容）。
       */
      attention: lastAttention,
      sessions: [...sessions.values()].map(rec => ({
        sessionId: rec.sessionId,
        // ⚠️ 走 `effectiveSessionState` 而非 `sessionState`：**快照里这一列也会被
        // exe 的 `EffectiveState()` 拿去比优先级取最大**。写原始状态等于把抖动
        // 又放回去（顶层的闩锁被它一票推翻）。
        state: effectiveSessionState(rec, at, cfg.minStateDwellMs),
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
     * **下一个需要主动重算的时刻**（epoch ms；`null` = 没有待办）。
     *
     * 为什么需要它：状态机是**事件驱动**的，宿主原先只有一个 15 秒兜底 ticker。
     * 有了最短驻留之后，这就出问题了 —— "思考满 2 秒才切干活"这个决定要等到
     * **下一次 tick** 才生效，最坏要压 15 秒（实测 e2e 里 2 秒后仍未切换）。
     * 气泡到期同理：`bubbleMs` 6 秒却可能挂到 21 秒。
     *
     * 所以这里把"已经知道会变、只是还没到点"的时刻报出来，宿主据此安排定时器
     * （见 `index.js` 的调度器）。没到期的不报，兜底 ticker 继续管睡觉那类粗粒度逻辑。
     *
     * 报的只有两类，且都要求**两者都不是豁免态**（否则早就立即切了）：
     *   · 最短驻留到期 —— 到点就该换图；
     *   · 气泡到期（常亮气泡不按 durationMs 收，跳过）。
     *
     * @returns {number|null}
     */
    nextDeadline () {
      const at = now()
      let best = null
      const take = t => {
        if (t > at && (best === null || t < best)) best = t
      }
      for (const rec of sessions.values()) {
        if (rec.latchState === null) continue
        const raw = sessionState(rec, at)
        if (raw === rec.latchState) continue
        if (DWELL_EXEMPT_STATES.has(raw) || DWELL_EXEMPT_STATES.has(rec.latchState)) continue
        take(rec.latchSince + cfg.minStateDwellMs)
      }
      // 常亮气泡（attention）不按 durationMs 收 —— 它由 attention 块决定去留。
      if (bubble !== null && bubble.sticky !== true) take(bubble.at + bubble.durationMs)
      return best
    },
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
          // 与快照同源（也过闩锁）：这份数据被"发消息挑目标会话"用，
          // 报出来的状态应该和桌面上看到的一致。
          state: effectiveSessionState(rec, at, cfg.minStateDwellMs),
          running: rec.running === true,
          toolsInFlight: rec.toolsInFlight.size
        }))
        .sort((a, b) => b.at - a.at)
    },
    /**
     * 让桌宠说一句话（**外部功能的统一入口**：番茄钟 / 互动 / 聊天）。
     *
     * 为什么不让调用方直接改 `bubble`：那样不推进 `rev`、不广播，
     * 客户端按 rev 去重就永远收不到这条 —— 症状是"代码说发了，屏幕没反应"。
     * 这里只**挂起**请求，由 `refresh` 在正确的时机消费并走正常广播通道。
     *
     * @param {object} request
     * @param {string} request.key - 气泡 key（决定选图与静默期记账）
     * @param {string} [request.text] - 覆盖文案（不给则用 key 的默认文案表）
     * @param {string} [request.state] - 关联状态名（影响优先级与选图）
     * @param {number} [request.priority] - 覆盖优先级
     * @param {number} [request.durationMs] - 覆盖停留时长
     * @param {object} [request.image] - 直接指定图（跳过选图器）
     * @returns {boolean} 是否接受了请求（attention 存续时会被丢弃，见 `refresh`）
     */
    notify (request) {
      if (request === null || typeof request !== 'object') return false
      if (typeof request.key !== 'string' || request.key === '') return false
      pendingNotify = request
      // 立刻求值一次：调用方（HTTP 路由）希望"这一帧就带上"。
      refresh(now())
      return true
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
