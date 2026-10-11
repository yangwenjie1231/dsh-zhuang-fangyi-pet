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

/**
 * 状态文字字号倍率范围（用户点名"字太小了，想调大"）。
 *
 * 与 `scale` 分开：`scale` 是"桌宠多大"，这个是"字多大"。
 * 上限 3.0 足够大（基准 11px → 33px），下限 0.5 保证还读得出来。
 */
export const STATUS_FONT_MIN = 0.5
export const STATUS_FONT_MAX = 3.0

/**
 * 手势灵敏度倍率范围（v13）。
 *
 * 上限 3.0：与 1.5× 指针增益叠加后容差 = 4 × 4.5 = 18px，已经是"慢慢拖一小段
 * 也会被当成点击"的边缘，再大就会让"挪位置"这个基本操作变得不可用。
 * 下限 1.0：**容差绝不比 v12 更小** —— 低灵敏度不该让手势更难触发，
 * 那与本功能的目的正好相反。
 */
export const GESTURE_SENS_MIN = 1.0
export const GESTURE_SENS_MAX = 3.0

/**
 * 字号倍率范围 —— 状态文字与气泡正文**共用**同一套上下限。
 *
 * 两处口径必须一致：它们都是"给人读的字"，没有理由一个能到 3× 另一个只到 2×。
 * 上限 3.0 足够大（正文 13px → 39px），下限 0.5 保证还读得出来。
 */

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

/**
 * 计时节奏预设（v10，用户："当前的番茄钟太简单了"）。
 *
 * ── 为什么是"预设"而不是"多套独立的时长字段" ─────────────────────────────
 *
 * 四个时长字段（focus/break/longBreak/rounds）**永远是真相**，预设只是
 * "一次性把它们写成某一组值"的快捷方式。选中预设后用户再手改时长，
 * 预设会被标成 `custom`（见 `applyPreset`）。
 *
 * 反过来做（预设与字段同时说了算）会出现"我明明改成 30 分钟，它又变回 25"
 * 这种打架状态 —— 而用户永远说不清最终生效的是哪个（`activity.js` 的
 * 档位设计里记过同一个教训）。
 *
 * ⚠️ `free`（自由计时）**不用 0 表示"不限时"**，而是给 240 分钟上限。
 * 理由：`remainingMs === 0` 在 `pomodoro.js` 里**到处**被当作"阶段已结束"
 *（`enter()` 的去重守卫、`start()` 的重置分支、`adopt()` 的回落），
 * 引入 0 语义会同时打破那四处，而它们的失败方式都是静默的。
 * 240 分钟与 `POMODORO_FOCUS_MAX` 一致，用户感知上没有损失。
 */
export const POMODORO_PRESETS = ['classic', 'deep', 'sprint', 'free', 'custom']

/**
 * v14：番茄钟倒计时窗的**停靠方位**。
 *
 * 用户问："番茄钟的位置可以调吗" —— 原先它是**自动贴在她下方**的
 *（居中，下方放不下就翻到上方，再 clamp 进工作区），用户无法左右。
 *
 * 四方位而不是"任意坐标"：
 *   · 倒计时是**挂在桌宠身上**的说明性元素，跟着她走才是它该有的行为
 *     （桌宠可以拖到任何地方，绝对坐标会在她移动后失效）；
 *   · 四个方位已经覆盖"挡住任务栏/挡住桌面图标"的全部实际诉求，
 *     而任意坐标要额外解决"桌宠移动后怎么办""屏幕换了怎么办"两个新问题。
 *
 * `auto` = 保持原先的智能避让（默认，零回归）。
 */
export const POMODORO_ANCHORS = ['auto', 'below', 'above', 'left', 'right']

/** 停靠方位 → 中文标签（设置页与右键菜单**共用这一份**，不许各写一份）。 */
export const POMODORO_ANCHOR_LABELS = {
  auto: '自动（贴下方，放不下自动避让）',
  below: '桌宠下方',
  above: '桌宠上方',
  left: '桌宠左侧',
  right: '桌宠右侧'
}

/** 预设 → 四个时长字段。`custom` 不在表里（它是"用户手改过"的标记）。 */
export const POMODORO_PRESET_VALUES = {
  classic: { pomodoroFocusMs: 25 * 60 * 1000, pomodoroBreakMs: 5 * 60 * 1000, pomodoroLongBreakMs: 15 * 60 * 1000, pomodoroRounds: 4 },
  deep: { pomodoroFocusMs: 52 * 60 * 1000, pomodoroBreakMs: 17 * 60 * 1000, pomodoroLongBreakMs: 30 * 60 * 1000, pomodoroRounds: 3 },
  sprint: { pomodoroFocusMs: 25 * 60 * 1000, pomodoroBreakMs: 5 * 60 * 1000, pomodoroLongBreakMs: 15 * 60 * 1000, pomodoroRounds: 4 },
  free: { pomodoroFocusMs: 240 * 60 * 1000, pomodoroBreakMs: 5 * 60 * 1000, pomodoroLongBreakMs: 15 * 60 * 1000, pomodoroRounds: 4 }
}

/**
 * 把预设套用成一组时长。未知预设返回 null（调用方据此**什么都不做**，
 * 而不是把设置改成一堆 undefined）。
 *
 * ⚠️ **必须 `hasOwnProperty`**：`POMODORO_PRESET_VALUES['__proto__']` 会返回
 * `Object.prototype`（原型链上的），`['toString']` 返回函数 —— 于是"未知预设"
 * 被当成合法值一路传下去。本项目在 `interactions.js` 的 `interactConfig` 上
 * 已经踩过一模一样的坑（探针实测 `interact('__proto__')` 返回了
 * `accepted: true`）。这里同样是"用户串查表"，所以同样要挡。
 *
 * @param {string} preset
 * @returns {object|null}
 */
export function applyPreset (preset) {
  if (typeof preset !== 'string') return null
  if (!Object.prototype.hasOwnProperty.call(POMODORO_PRESET_VALUES, preset)) return null
  const v = POMODORO_PRESET_VALUES[preset]
  if (v === null || typeof v !== 'object') return null
  return { ...v, pomodoroPreset: preset }
}

/** 设置结构版本。v1 为首个版本。 */
/** 推理后端白名单（'' = 用子插件默认）。 */
export const TT_BACKENDS = ['', 'torch', 'onnx']

/** 空闲释放方式白名单（'' = 用语音插件默认）。 */
export const TT_IDLE_ACTIONS = ['', 'stop', 'unload']

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
    /**
     * 状态文字的**字号倍率**（1.0 = 基准 11px）。
     *
     * 用户点名："我希望能够调整字的大小，因为有的时候字太小了"。
     * 为什么必须独立于 `scale`：`scale` 决定"桌宠多大"，用户调小它是为了让桌宠
     * 不占地方；而状态文字是**给人读的**，跟着一起缩就本末倒置了。
     * 独立成项后可以"桌宠小、字清楚"。
     *
     * 范围与 clamp 见 `normalizeSettings`（0.5 ~ 3.0）。
     */
    statusFontScale: 1.0,
    /**
     * **气泡正文**的字号倍率（1.0 = 基准 13px）。
     *
     * 用户点名："你对话里面的文字大小也需要可调呀"。
     * 与 `statusFontScale` 同一个道理、同一套范围：字号原先只跟 `scale` 走，
     * 用户把桌宠调小是为了不占地，正文却被一起缩到读不了
     *（实测 scale=0.5 时正文被下限夹到 6.5px）。
     *
     * 为什么与状态文字**分开**：状态文字是"她现在在干嘛"（扫一眼），
     * 正文是"她说了什么"（要读）—— 两者需求本来就可能不同。
     */
    chatFontScale: 1.0,
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
    /**
     * v10：今日目标番茄数（0 = 不设目标）。
     *
     * 为什么要"目标"而不是只显示数字：一个裸的"今天 3 个"没有参照 ——
     * 3 个算多还是算少？有了目标才有进度感，也是 `today` 行显示 `3/8` 的来源。
     * 默认 8（约 3.5 小时专注）—— 不给 0 是因为"没目标"等于少了一半信息；
     * 想要纯粹记录的人可以调到 0。
     */
    pomodoroGoalCount: 8,
    /**
     * v10：计时节奏预设（`classic` / `deep` / `sprint` / `free`）。
     *
     * ⚠️ 它**只决定"套用哪一组时长"**，不是第四个真相：
     * 选中预设后会把 `pomodoroFocusMs` 等字段写进去，之后用户手改时长
     * 会把预设标成 `custom`。若让预设与四个时长字段同时"说了算"，
     * 就会出现"我明明改成 30 分钟，它又变回 25"这种打架状态。
     */
    pomodoroPreset: 'classic',
    /**
     * v14：倒计时窗停靠方位（用户问"番茄钟的位置可以调吗"）。
     *
     * `auto` = 原先的智能避让（贴下方，放不下翻上方）。默认值保持 `auto`，
     * 所以老配置**零回归** —— 没碰过这个设置的人看到的位置与之前完全一样。
     */
    pomodoroAnchor: 'auto',
    /**
     * v10：专注期间显示呼吸引导（4-7-8 节奏）。
     *
     * **默认关闭**：它会在桌宠下方常驻一个动画，而多数人只想看倒计时。
     * 与"计时器类功能不许默认开"同一条纪律。
     */
    pomodoroBreath: false,

    // ── 互动手势（v10，用户："通过右键就点个按钮，很奇怪"）──────────────────
    /**
     * 允许**抛掷**（拖住甩出去，她沿抛物线飞）。
     *
     * 默认**开**：它不是骚扰型功能 —— 只有用户主动甩才会触发，
     * 而"慢慢拖"仍然是正常的挪位置（判据是速度，见 `PetGesture`）。
     * 关掉之后甩动会被当成普通拖动（她直接停在松手的位置）。
     */
    flingEnabled: true,
    /**
     * 允许**长按摸头**（按住不动逐级反应）。
     *
     * 默认**开**：与抛掷同理，必须用户主动按住才触发。
     */
    longPress: true,
    /**
     * **手势灵敏度倍率**（1.0 = 基准）。用户点名："我鼠标DPI平时开的比较高，
     * 所以很多手势触发不了，怎么回事"。
     *
     * ── 为什么必须有这个旋钮 ───────────────────────────────────────────────
     *
     * 手势容差是**屏幕物理像素**（点击 4px / 摸头 6px），而要吸收的量是
     * "按住鼠标时手抖了多少**像素**"：
     *
     *     手抖像素 = 手抖的物理距离 × 鼠标硬件 DPI × 指针增益
     *
     * exe 能读到**指针增益**（`SPI_GETMOUSESPEED`，本机实测 12 → 1.5×）
     * 并自动补偿，但**鼠标硬件 DPI 没有任何 API 可读** —— 而用户说的
     * "我 DPI 开得高"恰好就在读不到的那一半。所以只做自动检测修不彻底，
     * 必须留一个用户能自己拧的旋钮。
     *
     * 调大 = 容差更宽 = 手抖不容易被当成"在拖动"，点击/摸头更容易触发。
     * 代价是慢慢拖动小距离时可能被当成点击 —— 所以默认 1.0（= 与 v12 一致），
     * **不主动改变任何现有用户的手感**。
     */
    gestureSensitivity: 1.0,
    /**
     * **手势调试模式**（v13.6）。用户原话："手势的目前触发判定还是很奇怪。
     * 能不能加入类似可选的开关，就是比如说开启调试模式，用面包屑记录更详细的日志"。
     *
     * 打开后，exe 会把**每一次按下/移动/松手**都写进日志，包括原先
     * **什么都不记**的那些路径（点在透明像素上、抛掷动画期间、抬起时没有按下记录），
     * 并给出"**为什么没触发**"的一句话解释。
     *
     * ⚠️ **默认关闭**：面包屑是高频的（拖动时每次移动都可能记一行），
     * 常态开着会把日志淹掉。用户遇到问题时会主动打开 —— 所以它必须是
     * 一个**显式开关**，而不是恒开的调试输出。
     */
    debugGestures: false,
    /**
     * **悬停反应**：鼠标停在她身上一会儿，她看你一眼。
     *
     * ⚠️ **默认关闭**。这是唯一"她主动找你"的互动 —— 默认开就是骚扰
     * （用户只是在桌面上移动鼠标经过她而已）。与番茄钟/语音同一条纪律。
     */
    hoverReact: false,

    // ── 语音（用户点名："claude目录下有一个庄方宜专属的语音合成skill"）────────
    //
    // ⚠️ **默认关闭**。桌宠突然开口说话是**强打扰** —— 用户点的是"加语音"，
    // 不是"一装就出声"。默认关 = 他主动打开才生效。
    //
    // 运行时**绝不合成**（实测 GPT-SoVITS 冷启动 30.6 秒、热态 5 秒/句，
    // 而桌宠要在一秒内回应点击）。台词是封闭集合，构建期已压成 mp3，
    // 运行时只播放 —— 见 `src/pet/voice.js` 与 `tools/build-voice.ps1`。
    voice: false,

    // ── 聊天（用户点名："可以与桌宠聊天"）──────────────────────────────────
    //
    // 聊天走**真实 DSH 会话**（专用工作区 + 专用会话），所以人设、历史、
    // 上下文都由 DSH 管 —— 不自己发明一套提示词注入。
    //
    // `persona` = 当前人设名（对应 `$DSH_HOME/zhuang-fangyi-pet/personas/<名>.md`）。
    // **可切换**是用户明确要求的（"人设、性格要作为可调的，我有好多种提示词"）。
    persona: 'default',
    /**
     * 聊天工作区目录。空 = 默认 `~/Downloads/庄方宜`。
     *
     * 放在**下载目录**下而不是 `$DSH_HOME`：用户要能一眼找到它
     *（他可能想自己往里放资料、看对话记录）。
     */
    chatWorkspace: '',
    /** 气泡里的聊天入口开关（关掉就只在设置页聊）。 */
    chatEnabled: true,
    /**
     * 自动提炼长期记忆（**跨会话共享**）。
     *
     * 开启后：每次收到聊天回复，用宿主默认模型把这一轮里"值得长期记住的事"
     * 提炼成几行，追加到 `$DSH_HOME/zhuang-fangyi-pet/memory.md`；
     * 那份记忆会注入到**每一个**聊天会话（所以换会话不会失忆）。
     *
     * 默认**开**：用户点名要"不同会话能共享 memory"，不自动记就等于没有。
     * 关掉后仍可手动编辑记忆（设置页或直接改文件）。
     */
    memoryAuto: true,
    /**
     * **念出 AI 的回答**（动态语音合成）。
     *
     * 需要独立的合成子插件在跑（`dsh-zhuang-fangyi-voice`，默认
     * `http://127.0.0.1:8765`）。服务不在时自动退回固定台词，聊天不受影响。
     *
     * 默认**关**：把整段回复念出来是强打扰（而且合成要几秒），
     * 用户主动开才生效 —— 与 `voice` 同一考虑。
     */
    speakReplies: false,
    /** 合成服务地址。 */
    ttsUrl: 'http://127.0.0.1:8765',
    /**
     * 单句朗读的字符上限（清洗后截断）。
     *
     * 为什么默认只有 60：气泡里已经有全文了，语音只是"陪一句"。
     * 而合成耗时与长度成正比（onnx 后端 6 秒音频要 37 秒），
     * 越长越不可能及时 —— 60 字 ≈ 15 秒音频，已经是可接受的体验上限。
     */
    speechMaxChars: 60,
    /**
     * **让语音模型常驻**（用户点名要的开关）。
     *
     * 背景：合成服务启动时要加载模型。onnx 约 10 秒；**torch+CUDA 要把
     * GPT/SoVITS/BERT/HuBERT 搬进显存，更慢，而且加载完长期占着显存**。
     *
     *   · `true`  —— 桌宠托管它一直活着：启动一次，之后每次合成**立刻开始**；
     *                挂了自动拉起。代价是显存一直被占。
     *   · `false` —— 需要时才启动，空闲 `ttsIdleStopSec` 秒后自动停掉释放显存。
     *                代价是每次会话第一次合成要等模型加载。
     *
     * ⚠️ 桌宠**只停自己起的进程**：用户自己在终端起的服务，我们只连不杀。
     */
    ttsResident: false,
    /** 非常驻模式下，空闲多少秒后停掉服务释放显存（0 = 永不自动停）。 */
    ttsIdleStopSec: 300,
    /**
     * 空闲时**怎么**释放：`stop`（杀进程，全释放、恢复慢）或
     * `unload`（只卸模型、留进程，显存同样释放、恢复快）。
     * 空串 = 用语音插件自己的默认值。
     */
    ttsIdleAction: '',
    /** 启动合成服务用的 python（留空 = 自动探测）。 */
    ttsPython: '',
    /** 合成子插件仓库目录（留空 = 自动探测）。 */
    ttsRepoDir: '',
    /** 推理后端：'' = 用子插件默认；`torch`（快，占显存）/ `onnx`（慢，省显存）。 */
    ttsBackend: '',
    /** GPT-SoVITS 检出目录（torch 后端需要）。留空 = 用环境变量 ZFH_GSV_ROOT。 */
    ttsGsvRoot: '',
    /** 模型目录（等价 ZFH_MODEL_DIR）。留空 = 让 Python 侧自己找。 */
    ttsModelDir: ''
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
  // 状态文字字号倍率：0.5~3.0。
  // 下限 0.5（再小读不了，与 `PetStatusLabel.MinFontSize` 的兜底意图一致）；
  // 上限 3.0（再大字会把面板/桌面占满，且远超"看得清"的需求）。
  out.statusFontScale = clamp(input.statusFontScale, STATUS_FONT_MIN, STATUS_FONT_MAX, base.statusFontScale)
  // 气泡正文字号倍率：与状态文字**同范围同口径**（用户可能只调其中一个）。
  out.chatFontScale = clamp(input.chatFontScale, STATUS_FONT_MIN, STATUS_FONT_MAX, base.chatFontScale)

  for (const key of ['clickThrough', 'topmost', 'bubble', 'bubbleImages',
    'hint', 'statusAlways', 'notifyComplete', 'attentionReminder',
    'pomodoro', 'pomodoroAutoNext', 'pomodoroNotify', 'pomodoroCountdown',
    'pomodoroBreath', 'flingEnabled', 'longPress', 'hoverReact',
    'voice', 'chatEnabled', 'memoryAuto', 'speakReplies', 'ttsResident',
    'debugGestures']) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }

  // v10：今日目标番茄数。0 = 不设目标（**合法值**，所以下限是 0 而不是 1）。
  // 上限 30：一天 30 个番茄已经是 12.5 小时专注，再高没有现实意义
  //（而且目标行会撑得很长）。
  out.pomodoroGoalCount = clamp(input.pomodoroGoalCount, 0, 30, base.pomodoroGoalCount)

  // v13：手势灵敏度。下限 1.0（**绝不让容差比 v12 更小**），上限 3.0。
  out.gestureSensitivity = clamp(input.gestureSensitivity,
    GESTURE_SENS_MIN, GESTURE_SENS_MAX, base.gestureSensitivity)

  // v10：计时节奏预设。**只认白名单**，未知值回落到 base ——
  // 它是"套用哪一组时长"的开关，不认识的值必须回落而不是透传
  //（透传的话下游 `applyPreset` 查表会拿到 undefined，静默什么都不做）。
  if (POMODORO_PRESETS.includes(input.pomodoroPreset)) out.pomodoroPreset = input.pomodoroPreset

  // v14：倒计时停靠方位。与预设同样是**枚举白名单** ——
  // 不认识的值必须回落到 base，不能透传（透传的话 exe 侧查表拿到未知名，
  // 会静默按"居中贴下方"处理，用户改了设置却看不到任何变化）。
  if (POMODORO_ANCHORS.includes(input.pomodoroAnchor)) out.pomodoroAnchor = input.pomodoroAnchor

  // 人设名与聊天工作区：字符串，走**保守校验**。
  //
  // ⚠️ 人设名的白名单校验在 `src/pet/persona.js`（那里才拼路径）。
  // 这里只保证"是个像样的非空短字符串" —— 设置层不该知道人设的存储细节，
  // 但**必须挡住明显荒唐的值**（比如 10KB 的字符串）。
  if (typeof input.persona === 'string') {
    const p = input.persona.trim()
    if (p !== '' && p.length <= 64) out.persona = p
  }
  if (typeof input.chatWorkspace === 'string') {
    const w = input.chatWorkspace.trim()
    // 空字符串是**合法值**（= 用默认目录），所以要单独放行。
    if (w === '') out.chatWorkspace = ''
    else if (w.length <= 260) out.chatWorkspace = w
  }
  if (typeof input.ttsUrl === 'string') {
    const u = input.ttsUrl.trim()
    // 只接受 http/https：这是个**网络地址**，别的协议（file:/data:）不该进设置 ——
    // 它会被 fetch 直接使用，放开等于给了一个任意协议入口。
    if (u === '') out.ttsUrl = ''
    else if (u.length <= 300 && /^https?:\/\//i.test(u)) out.ttsUrl = u
  }
  // 朗读长度上限：夹在 10~300 字。太短没意义（一个词），太长合成等不起。
  out.speechMaxChars = clamp(input.speechMaxChars, 10, 300, base.speechMaxChars)
  // 空闲释放时间：0 = 不自动停；上限一天（再长就没有"释放显存"的意义了）。
  out.ttsIdleStopSec = clamp(input.ttsIdleStopSec, 0, 86400, base.ttsIdleStopSec)
  // 释放方式：只认两个值 + 空串（= 用插件默认）。别的值一律不传下去。
  if (TT_IDLE_ACTIONS.includes(input.ttsIdleAction)) out.ttsIdleAction = input.ttsIdleAction
  // 启动服务用的路径与后端。长度限住，后端只认两个值。
  for (const key of ['ttsPython', 'ttsRepoDir', 'ttsGsvRoot', 'ttsModelDir']) {
    if (typeof input[key] === 'string' && input[key].length <= 300) out[key] = input[key].trim()
  }
  if (TT_BACKENDS.includes(input.ttsBackend)) out.ttsBackend = input.ttsBackend

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