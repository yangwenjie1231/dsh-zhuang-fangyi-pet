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

/** 桌宠运行模式。`auto` = 能开原生窗就开，否则回落窗口内 overlay。 */
export const PET_MODES = ['auto', 'native', 'overlay']

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

/** 设置结构版本。v1 为首个版本。 */
export const SETTINGS_VERSION = 1

/** 默认设置。 */
export function defaultSettings () {
  return {
    version: SETTINGS_VERSION,
    enabled: true,
    mode: 'auto',
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
    locale: 'zh'
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
  if (PET_MODES.includes(input.mode)) out.mode = input.mode
  out.scale = clamp(input.scale, SCALE_MIN, SCALE_MAX, base.scale)
  out.opacity = clamp(input.opacity, OPACITY_MIN, OPACITY_MAX, base.opacity)

  for (const key of ['clickThrough', 'topmost', 'bubble', 'bubbleImages',
    'hint', 'statusAlways', 'notifyComplete', 'attentionReminder']) {
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
    '--bubble', settings.bubble ? '1' : '0'
  ]
  if (Number.isFinite(settings.x) && Number.isFinite(settings.y)) {
    args.push('--x', String(settings.x), '--y', String(settings.y))
  }
  return args
}