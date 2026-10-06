/**
 * 庄方宜桌宠 · 设置模型（Host / Client 共用，**唯一默认值来源**）
 *
 * 持久化位置：`$DSH_HOME/zhuang-fangyi-pet/settings.json`
 *
 * 与主题插件（`dsh-zhuang-fangyi`）**各自独立**一份设置：两个插件零耦合，
 * 装一个不装另一个都能正常工作（`桌宠开发文档.md` §一/§七）。
 * 桌宠只读主题写在 CSS 变量上的配色（`--dsw-alias-*`），**不读它的设置文件** ——
 * 那是实现细节，会锁死两个插件的版本关系。
 *
 * 归一化策略照抄主题插件 `src/settings.js` 的风格：**逐字段回落，不整体丢弃**。
 * 用户改坏一个字段不该让其余设置一起失效。
 */

/**
 * 桌宠运行模式。
 *
 * ⚠️ **v2 起 `auto` 已并入 `native`，overlay 被冻结为兼容兜底。**
 *
 * 起因：`auto` 与 `native` 的差别只是"exe 不可用时要不要回落 overlay"，
 * 而 overlay 半边要额外维护 464 行 CSS、自己判断主题、自己存位置，
 * 还要吃透一堆 DSH 内部知识（`position:fixed` 绕 grid、`pointer-events:auto`、
 * `z-index` 上限）。历史上 **12 次提交**是"两半边必须同步"的税。
 *
 * 关键事实：**DSH 的 webServer 只绑 loopback**（实测 `127.0.0.1:19387`），
 * 所以"用网页版"的用户 DSH 也在本地跑，exe 永远连得上 ——
 * overlay 的"跨平台"价值只剩下非 Windows 与 exe 被杀软拦两种边缘情况。
 *
 * 所以现在的语义是：
 *   · `native`（**默认**）—— 桌面窗为主；exe **不可用**时仍回落 overlay
 *     （逃生舱留着，否则插件会变成一个"什么都没发生"的空壳）；
 *   · `overlay` —— 用户显式强制窗口内悬浮。
 *
 * `auto` 作为**旧值别名**继续接受，归一化成 `native`（行为与从前完全一致，
 * 因为从前 auto 就是"优先桌面窗"）。
 *
 * **overlay 从此不再补功能**：它缺滚轮缩放/右键菜单/画廊/托盘，
 * 这是有意为之，不是待办。
 */
export const PET_MODES = ['native', 'overlay']

/** 旧值别名 → 新值。用于兼容已落盘的设置文件。 */
export const PET_MODE_ALIASES = { auto: 'native' }

/**
 * 缩放范围（托盘档位与滚轮缩放共用）。
 *
 * 上限 3.0：滚轮缩放是用户点名的功能，范围要够玩；再大会糊（源素材帧高 256px）。
 * 下限 0.3：再小就点不中了。
 */
export const SCALE_MIN = 0.3
export const SCALE_MAX = 3.0

/** 不透明度范围。低于 0.3 就基本看不见了，没意义。 */
export const OPACITY_MIN = 0.3
export const OPACITY_MAX = 1.0

/** 气泡一次显示多久（ms）。 */
export const BUBBLE_MS_MIN = 1000
export const BUBBLE_MS_MAX = 20000

/** 两次气泡之间的最小间隔（ms），防刷屏。0 = 不限。 */
export const BUBBLE_GAP_MIN = 0
export const BUBBLE_GAP_MAX = 60000

/** 双击桌宠的行为。 */
export const DOUBLE_CLICK_ACTIONS = ['focus-dsh', 'emote', 'none']

/** 深浅色贴纸选择。`auto` = 渲染方自己判断（exe 读系统、overlay 读外壳）。 */
export const THEME_MODES = ['auto', 'light', 'dark']

/**
 * 活跃度档位：安静 / 正常 / 调皮。
 *
 * 用户点名的功能（"调成安静、正常、调皮来改变它的活跃度"）。
 * 它是一层**预设**，作用在气泡频率与主动卖萌上；具体数值见
 * `src/pet/activity.js`（Host 与测试共用的唯一真相）。
 */
export const ACTIVITY_MODES = ['quiet', 'normal', 'playful']

/**
 * 番茄钟阶段名（与 `src/pet/pomodoro.js` 的 `POMODORO_PHASES` 同值域）。
 *
 * **故意在这里重复一份**而不是 import：`settings.js` 是 Host/Client/测试
 * 三方共用的稳定契约，不该依赖番茄钟实现。两边不一致时由单测的
 * 契约断言兜住（见 `test-pet-pomodoro.mjs` 的"契约同值域"一节）。
 */
export const POMODORO_PHASE_NAMES = ['focus', 'break', 'long-break']

/** 番茄钟时长范围（**毫秒**，与设置字段同单位）。 */
export const POMODORO_FOCUS_MIN = 60 * 1000
export const POMODORO_FOCUS_MAX = 240 * 60 * 1000
export const POMODORO_BREAK_MIN = 60 * 1000
export const POMODORO_BREAK_MAX = 60 * 60 * 1000
export const POMODORO_LONG_BREAK_MIN = 60 * 1000
export const POMODORO_LONG_BREAK_MAX = 120 * 60 * 1000
export const POMODORO_ROUNDS_MIN = 2
export const POMODORO_ROUNDS_MAX = 12

/** 设置结构版本。v1 为首个版本。 */
export const SETTINGS_VERSION = 1

/** 默认设置。 */
export function defaultSettings () {
  return {
    version: SETTINGS_VERSION,
    enabled: true,
    /**
     * 默认 `native`（v2 起）。`auto` 已并入它 —— 见 `PET_MODES` 的说明。
     * 语义没变：**优先桌面窗，exe 不可用时回落 overlay**。
     */
    mode: 'native',
    scale: 1.0,
    opacity: 1.0,
    /** 整窗穿透：开启后桌宠变成纯装饰，鼠标完全穿过（含不透明区域）。 */
    clickThrough: false,
    topmost: true,
    /** 气泡总开关。 */
    bubble: true,
    /** 气泡是否显示表情图（关掉只剩文字）。 */
    bubbleImages: true,
    /** 位置记忆。null = 未定，由 exe 放到主屏右下角。 */
    x: null,
    y: null,
    /** `happy` 闩锁时长（ms）。 */
    happyMs: 3000,
    /** 全局空闲多久算睡着（ms）。 */
    sleepMs: 300000,
    /** 气泡一次显示多久（ms）。 */
    bubbleMs: 6000,
    /** 两次气泡之间的最小间隔（ms），防刷屏。0 = 不限。 */
    bubbleGapMs: 8000,
    /** 双击桌宠做什么。 */
    doubleClick: 'focus-dsh',
    /** 深色模式贴纸：auto 跟随渲染方环境，light/dark 强制。 */
    theme: 'auto',
    /** 活跃度：安静 / 正常 / 调皮。改变气泡频率与是否主动卖萌。 */
    activity: 'normal',
    /** 悬停时是否显示状态文字。 */
    hint: true,
    /** 是否在桌宠**下方常显**状态文字（不止悬停才出现）。 */
    statusAlways: false,
    /** AI 完成一回合并时弹一条提醒气泡（force，绕过静默期）。 */
    notifyComplete: true,
    /**
     * 授权/提问**常亮**提醒（用户点名的功能）：AI 要授权或提问时，
     * 气泡一直亮着直到你处理完。**独立于 `bubble` 总开关** ——
     * 关掉普通气泡不等于不想要审批提醒。
     */
    attentionReminder: true,
    /** 气泡文案语言；跟随 DSH 界面语言时可被客户端覆盖。 */
    locale: 'zh',

    // ── 番茄钟（用户点名："增加番茄钟提醒我休息"）────────────────────────────
    //
    // ⚠️ **默认关闭**。装完插件就自己开始一个 25 分钟倒计时是**骚扰**，不是功能 ——
    // 用户明确点的是"提醒我休息"，前提是他自己按了开始。
    /** 总开关。关掉时倒计时与阶段提醒都不出现。 */
    pomodoro: false,
    /** 专注时长（ms）。默认 25 分钟。 */
    pomodoroFocusMs: 25 * 60 * 1000,
    /** 短休时长（ms）。默认 5 分钟。 */
    pomodoroBreakMs: 5 * 60 * 1000,
    /** 长休时长（ms）。默认 15 分钟 —— 用户点名"每 4 轮一次长休息（15 分）"。 */
    pomodoroLongBreakMs: 15 * 60 * 1000,
    /** 每几轮专注后给一次长休。用户点名 4。 */
    pomodoroRounds: 4,
    /** 阶段结束后自动进入下一阶段；关掉则每段结束后停下等你按开始。 */
    pomodoroAutoNext: true,
    /** 阶段结束时让桌宠提醒（气泡 + 表情 + 语音）。 */
    pomodoroNotify: true,
    /**
     * 桌宠**下方常显倒计时**。
     *
     * 独立于 `statusAlways`（那个是"状态文字"）：用户可能不想要状态文字，
     * 但番茄钟的倒计时是他主动开的，得看得见。
     */
    pomodoroCountdown: true,

    // ── 语音（用户点名："claude目录下有一个庄方宜专属的语音合成skill"）────────
    //
    // ⚠️ **默认关闭**。桌宠突然开口说话是**强打扰** —— 用户点的是"加语音"，
    // 不是"一装就出声"。默认关 = 他主动打开才生效。
    //
    // 运行时**绝不合成**（实测 GPT-SoVITS 冷启动 30.6 秒、热态 5 秒/句，
    // 而桌宠要在一秒内回应点击）。台词是封闭集合，构建期已压成 mp3，
    // 运行时只播放 —— 见 `src/pet/voice.js` 与 `tools/build-voice.ps1`。
    voice: false
  }
}

/** 夹取数值到范围；非有限数回落 fallback。 */
function clamp (value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 可选整数（位置允许 null = 未定）。 */
function optionalInt (value, fallback) {
  if (value === null || value === undefined) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.round(n)
}

/**
 * 从任意来源归一化为合法设置。
 *
 * @param {unknown} input
 * @returns {object} 合法设置
 */
export function normalizeSettings (input) {
  const base = defaultSettings()
  if (input === null || typeof input !== 'object') return base
  const out = { ...base }

  if (typeof input.enabled === 'boolean') out.enabled = input.enabled
  // `auto` 是 v1 的旧值，语义与 `native` 相同（都是"优先桌面窗"）——
  // 归一化成 `native`，这样已落盘的旧设置文件不会突然失效。
  if (PET_MODES.includes(input.mode)) out.mode = input.mode
  else if (PET_MODE_ALIASES[input.mode] !== undefined) out.mode = PET_MODE_ALIASES[input.mode]
  out.scale = clamp(input.scale, SCALE_MIN, SCALE_MAX, base.scale)
  out.opacity = clamp(input.opacity, OPACITY_MIN, OPACITY_MAX, base.opacity)

  for (const key of ['clickThrough', 'topmost', 'bubble', 'bubbleImages',
    'hint', 'statusAlways', 'notifyComplete', 'attentionReminder',
    'pomodoro', 'pomodoroAutoNext', 'pomodoroNotify', 'pomodoroCountdown',
    'voice']) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }

  out.x = optionalInt(input.x, base.x)
  out.y = optionalInt(input.y, base.y)

  // 时长给宽范围：测试想设 1ms 也不该被夹掉，但 0/负数无意义。
  out.happyMs = clamp(input.happyMs, 100, 600000, base.happyMs)
  out.sleepMs = clamp(input.sleepMs, 10000, 86400000, base.sleepMs)
  out.bubbleMs = clamp(input.bubbleMs, BUBBLE_MS_MIN, BUBBLE_MS_MAX, base.bubbleMs)
  out.bubbleGapMs = clamp(input.bubbleGapMs, BUBBLE_GAP_MIN, BUBBLE_GAP_MAX, base.bubbleGapMs)

  if (DOUBLE_CLICK_ACTIONS.includes(input.doubleClick)) out.doubleClick = input.doubleClick
  if (THEME_MODES.includes(input.theme)) out.theme = input.theme
  if (ACTIVITY_MODES.includes(input.activity)) out.activity = input.activity

  // 番茄钟时长：与 `src/pet/pomodoro.js` 的 POMODORO_LIMITS **同值域**。
  // 两处都要有是因为：设置页要能挡住荒唐值（1 秒的专注没有意义），
  // 而番茄钟模块自己也必须防（它可能被直接构造，不经设置）。
  out.pomodoroFocusMs = clamp(input.pomodoroFocusMs,
    POMODORO_FOCUS_MIN, POMODORO_FOCUS_MAX, base.pomodoroFocusMs)
  out.pomodoroBreakMs = clamp(input.pomodoroBreakMs,
    POMODORO_BREAK_MIN, POMODORO_BREAK_MAX, base.pomodoroBreakMs)
  out.pomodoroLongBreakMs = clamp(input.pomodoroLongBreakMs,
    POMODORO_LONG_BREAK_MIN, POMODORO_LONG_BREAK_MAX, base.pomodoroLongBreakMs)
  out.pomodoroRounds = clamp(input.pomodoroRounds,
    POMODORO_ROUNDS_MIN, POMODORO_ROUNDS_MAX, base.pomodoroRounds)

  if (input.locale === 'zh' || input.locale === 'en') out.locale = input.locale
  out.version = SETTINGS_VERSION
  return out
}

/**
 * 给 exe 的 argv 参数（契约 §5）。
 *
 * 位置未定时**不传** `--x/--y`：让 exe 自己放到主屏右下角，
 * 比宿主瞎猜一个坐标好（宿主不知道多屏布局）。
 *
 * @param {object} settings - 归一化后的设置
 * @param {{url: string, token: string, state: string}} runtime
 * @returns {string[]} argv 片段（不含 exe 路径）
 */
export function exeArgs (settings, runtime) {
  const args = [
    '--url', runtime.url,
    '--token', runtime.token,
    '--state', runtime.state,
    '--scale', String(settings.scale),
    '--opacity', String(settings.opacity),
    '--topmost', settings.topmost ? '1' : '0',
    '--click-through', settings.clickThrough ? '1' : '0',
    '--bubble', settings.bubble ? '1' : '0',
    // v8：语音开关。**必须透传** —— exe 是独立进程，它自己不认 settings.json。
    // 漏传的症状是"设置页开了语音但没声音"，而 Host 与 exe 各自的测试都是绿的
    // （所以 `test-pet-native-e2e.mjs` 专门断言了这一个参数）。
    '--voice', settings.voice ? '1' : '0'
  ]
  if (Number.isFinite(settings.x) && Number.isFinite(settings.y)) {
    args.push('--x', String(settings.x), '--y', String(settings.y))
  }
  return args
}