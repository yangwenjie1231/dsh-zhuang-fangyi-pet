/**
 * 庄方宜桌宠 · 浏览器半边（**窗口内兜底**）
 *
 * 手写 ModuleLoader bundle：无构建步骤，除外壳已提供的 `react` 外无依赖。
 *
 * ── 这个半边是干什么的（以及不是干什么的）────────────────────────────────
 *
 * 桌宠的**主形态是原生桌面窗口**（由宿主经 `ctx.subprocess` 启动的 net48 exe，
 * 真的浮在桌面上）。这个半边是**兜底**，在下列情况自动接管：
 *
 *   · 非 Windows 平台（没有原生 exe）；
 *   · 宿主没提供 `ctx.subprocess`（Web profile 或旧版本）；
 *   · exe 未构建 / 被杀软删除 / 秒退（宿主会在快照里给出 `nativeError`）；
 *   · 用户把 `mode` 设成 `overlay`。
 *
 * 功能上它和原生窗口等价：同一个状态机快照、同一份素材清单、同一套气泡规则。
 * 差别只有一个：它**只能在 DSH 窗口内浮动**。
 *
 * ── 渲染层的三个硬约束（都是实测踩过的，不是推测）────────────────────────
 *
 * 1. **必须 `position:fixed`**。`shell.overlay` 的容器是 `AppFrame`（CSS Grid）
 *    的**第 4 个子元素**，而三列 + overlay 都没写 `grid-area`，全靠自动放置 ——
 *    三列填满第 1 行后 overlay **溢出到隐式第 2 行**，它的包含块整体下移将近一屏
 *    （实测 `top:40px` 的元素落在 y≈572）。用 `absolute` 会偏一屏，`fixed`
 *    相对视口定位，彻底绕开。
 *
 * 2. **容器必须小**。外壳对 overlay 的**直接子元素**开了 `pointer-events:auto`
 *    （`.overlayLayer>*{pointer-events:auto}`）。若宠物容器铺满全屏（`inset:0`）
 *    就会挡住整个界面。所以容器只包住宠物本身。
 *
 * 3. **层级别乱加**。overlay 层本身 `z-index:20`，官方菜单栏是 `1100`，别去盖它。
 *
 * ── 素材 ──────────────────────────────────────────────────────────────────
 *
 * 精灵图是**横向条带**（`frames × frameHeight`），用 CSS `animation: steps(N)`
 * 播放 —— 与原生窗口的 `CroppedBitmap` 取帧共用同一份产物与同一份 `pet.json` 时序，
 * 两边不会分叉。
 */

window.__ModuleLoader__.load({
  id: 'dsh-zhuang-fangyi-pet',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useRef, useEffect, useCallback } = React

    const NS = 'settings.zhuangFangyiPet'
    const ROUTE = '/api/zhuang-fangyi/pet'
    const OVERLAY_ID = 'zhuang-fangyi-pet'

    /**
     * 插件装配出的**唯一运行时**。组件只能从这里拿，**不能指望 `props.runtime`**。
     *
     * ⚠️ 这是一个真机上真实炸过的坑，值得写清楚：
     *
     * 外壳渲染一个 slot 条目时，props 只有四部分（`dsh-client-ui-renderer` 源码实测，
     * `renderEntry`）：
     *
     *     { ...kit, ...entry.inject, ...slotInjected.props, ...ownerProps }
     *
     * 其中 `entry.inject` 来自**注册选项**里的 `inject`（我们没给），
     * `slotInjected.props` 来自**插槽声明**的 `inject`（`shell.overlay` 没声明），
     * 而 `ownerProps` 由调用点决定：`shell.overlay` 是 `renderSlot("shell.overlay", {})`，
     * `settings.section` 是 `renderSlot("settings.section", { close })`。
     *
     * **三者都不含 `runtime`。** 于是组件第一行读 `runtime.t` 就抛 `TypeError`，
     * 被外壳的 `SlotErrorBoundary` 接住 → `reportEntryError(abdicate: true)` →
     * 该条目被**逐出所在单元格**：它会从 `entriesOfSlot()` 里消失。
     *
     * 实测证据：live slot 树里我们的 overlay 条目 `active: false`，
     * 而同插槽其余 12 个条目全是 `true` —— 这就是"已经被 abdicate 掉"的样子。
     * 症状是桌宠不出现、设置页一片空白（且**不报错**，只在浏览器 console 里）。
     *
     * 为什么测试没抓到：测试一直用 `Pet({ runtime })` 这种**手写的 props 形状**，
     * 而外壳从不这样传。教训是——测试必须用**外壳真实的调用形状**。
     */
    let pluginRuntime = null

    /** 取当前装配的运行时；未装配时给一句能看懂的错，而不是 `undefined.t`。 */
    function requireRuntime () {
      if (pluginRuntime === null) {
        throw new Error('zhuang-fangyi-pet: 运行时尚未装配（apply() 还没跑）')
      }
      return pluginRuntime
    }

    /**
     * 判断**当前要不要用深色变体**（契约 §4 `fileDark`）。
     *
     * overlay 是渲染方，必须由它自己判断 —— Host 在服务端无从知晓浏览器主题。
     * 优先读外壳 presenter 设置的 `data-ds-theme-source`（DSH 主题可能是
     * system/light/dark 任一，用户也可能是强制深色）；读不到再退回系统
     * `prefers-color-scheme`。两处都拿不到时按浅色处理（安全侧：绝大多数贴纸
     * 的浅色版是原始素材，不会丢信息）。
     *
     * @returns {boolean}
     */
    function prefersDarkNow () {
      try {
        const root = typeof document !== 'undefined' ? document.documentElement : null
        const src = root?.getAttribute?.('data-ds-theme-source')
        if (src === 'dark') return true
        if (src === 'light') return false
        if (typeof matchMedia === 'function') {
          return matchMedia('(prefers-color-scheme: dark)').matches === true
        }
      } catch (_) { /* 环境不可用就按浅色 */ }
      return false
    }

    /** 状态 → 兜底文案（清单没给出 label 时用）。与 Host 的 STATE_TEXT 同 key 集。 */
    const STATE_TEXT = {
      zh: {
        waking: '醒来了…',
        idle: '待机中',
        listening: '收到啦',
        thinking: '正在思考…',
        working: '正在调用工具…',
        waiting: '在等你审批',
        happy: '完成啦',
        error: '出错了…',
        sleeping: '睡一会儿…'
      },
      en: {
        waking: 'Waking up…',
        idle: 'Idle',
        listening: 'Got it',
        thinking: 'Thinking…',
        working: 'Working…',
        waiting: 'Waiting for your approval',
        happy: 'Done!',
        error: 'Something went wrong…',
        sleeping: 'Sleeping…'
      }
    }

    /** 设置页文案。 */
    const DICT = {
      zh: {
        nav: '庄方宜桌宠',
        title: '庄方宜桌宠',
        subtitle: '真的浮在桌面上的桌宠 · 表情随 agent 状态实时变化',        enabled: '启用桌宠',
        mode: '显示方式',
        modeNative: '桌面窗口（推荐）',
        modeNativeHint: '真的浮在桌面上。窗口内悬浮只在它不可用时作为兜底出现',
        modeOverlay: '只用窗口内悬浮（功能较少，兼容用）',
        modeOverlayHint: '只在 DSH 窗口内显示，功能少于桌面窗口',
        scale: '大小',
        opacity: '不透明度',        topmost: '总在最前',
        clickThrough: '点击穿透',
        clickThroughHint: '开启后鼠标完全穿过桌宠（纯装饰）',
        groupBubble: '气泡',
        bubble: '显示气泡',
        bubbleImages: '气泡显示表情图',
        chatFontScale: '对话文字大小',
        chatFontScaleHint: '只影响气泡里的对话正文，与桌宠大小无关',
        bubbleMs: '气泡显示时长',
        bubbleGapMs: '两条气泡最小间隔',
        bubbleGapHint: '调大可减少刷屏；0 = 不限',
        notifyComplete: 'AI 完成时弹提醒',
        notifyCompleteHint: '一回合并干净结束就强制弹一条（绕过上面的间隔）',
        attentionReminder: '审批/提问常亮提醒',
        attentionReminderHint: '审批/提问时常亮，直到你处理完',        happyMs: '完成后的开心时长',
        sleepMs: '空闲多久后睡觉',
        doubleClick: '双击桌宠',
        doubleClickFocus: '打开 DSH 主窗口',
        doubleClickEmote: '换一个随机表情',
        doubleClickNone: '什么都不做',
        theme: '深浅色主题',
        themeAuto: '自动跟随系统',
        themeLight: '浅色（白底 / 浅色气泡）',
        themeDark: '深色（黑底 / 深色气泡）',
        hint: '悬停时显示状态',
        statusAlways: '桌宠下方常显状态',
        statusAlwaysHint: '开启后状态文字一直挂在桌宠下方，不用悬停',
        statusFontScale: '状态文字大小',
        statusFontScaleHint: '只影响状态文字，与桌宠大小无关',
        // ── 番茄钟（v3）─────────────────────────────────────────────────────
        groupPomodoro: '番茄钟',
        pomodoro: '启用番茄钟',
        pomodoroHint: '专注一段、休息一段。默认关闭 —— 打开后自己按开始',
        pomodoroFocusMs: '专注时长',
        pomodoroBreakMs: '短休息',
        pomodoroLongBreakMs: '长休息',
        pomodoroRounds: '每几轮长休息',
        pomodoroRoundsHint: '连续专注这么多轮之后给一次长休息',
        pomodoroAutoNext: '自动进入下一段',
        pomodoroAutoNextHint: '关掉后每段结束会停下等你按开始',
        pomodoroNotify: '阶段结束时提醒我',
        pomodoroNotifyHint: '气泡 + 表情（开了语音还会说话）',
        pomodoroCountdown: '桌宠下方显示倒计时',
        pomodoroStart: '开始专注',
        pomodoroPause: '暂停',
        pomodoroResume: '继续',
        pomodoroSkip: '跳过当前段',
        pomodoroReset: '重置',
        // ── v10：番茄钟扩展（目标 / 预设 / 呼吸）───────────────────────────
        pomodoroGoalCount: '今日目标番茄数',
        pomodoroGoalCountHint: '设 0 就不显示目标，只记录',
        pomodoroPreset: '节奏预设',
        pomodoroPresetHint: '选一个套用时长；之后手改时长会标成「自定义」',
        presetClassic: '经典 25/5',
        presetDeep: '深度工作 52/17',
        presetSprint: '冲刺 25/5',
        presetFree: '自由计时（上限 4 小时）',
        presetCustom: '自定义',
        pomodoroBreath: '专注时显示呼吸引导',
        pomodoroBreathHint: '桌宠下方一个随呼吸缩放的光环（4-7-8 节奏）',
        pomodoroTask: '这一轮做什么',
        pomodoroTaskHint: '起个名字，统计里能看到时间花在哪',
        pomodoroTaskPlaceholder: '比如：桌宠开发',
        // ── v10：互动手势 ──────────────────────────────────────────────────
        groupGesture: '手势互动',
        gestureLead: '在桌宠身上：点一下 = 打招呼 · 按住不动 = 摸头 · 快速甩出去 = 她会飞',
        gestureHintBtn: '再看一次手势提示',
        gestureHintNote: '提示会出现在桌宠的气泡里（需要桌面窗口在运行）',
        flingEnabled: '拖住甩出去',
        flingEnabledHint: '快速甩动她会飞出去再落地；慢慢拖仍然只是挪位置',
        longPress: '按住摸头',
        longPressHint: '按住不动会逐级反应；松手即停',
        gestureSensitivity: '手势灵敏度',
        gestureSensitivityHint: '点不中 / 按不住就调大（高 DPI 鼠标常见）',
        noteGesture: '手势容差按"屏幕像素"判定，而手抖落成多少像素 = 手抖距离 × 鼠标硬件 DPI × 系统指针增益。系统指针增益桌宠能自己读（并自动补偿），但**鼠标硬件 DPI 没有接口可读** —— 所以「我 DPI 开得高」那一半只能靠这个滑杆补。调大的代价：慢慢拖动一小段距离时，也可能被当成点击。',
        debugGestures: '手势调试日志（面包屑）',
        debugGesturesHint: '记下每一次按下/移动/松手，并说明为什么没触发',
        debugGesturesNote: '打开后，桌宠会把每一次按下、移动、松手都写进日志 —— **包括原先什么都不记的那些情况**（点在透明像素上、抛掷动画中、抬起时没有按下记录），并给出「为什么没触发」的一句话解释。日志在 `%LOCALAPPDATA%\\DSH-ZhuangFangyi-Pet\\pet.log`，搜 `[手势]` 即可。**开启之前**最后 200 条也会一并倒出来，所以「按了几下没反应 → 再来开开关」这个流程不会丢掉证据。默认关闭：面包屑很密集，常态开着会淹掉日志。右键菜单里也有一键开关。',
        hoverReact: '鼠标停在她身上时看你一眼',
        hoverReactHint: '默认关闭 —— 这是唯一她会主动找你的互动',
        // ── v10：「今天」页签 ──────────────────────────────────────────────
        tabToday: '今天',
        groupToday: '今天',
        todayCount: '今日番茄',
        todayFocus: '专注时长',
        todayInterrupts: '摸鱼次数',
        todayStreak: '连续天数',
        todayEmpty: '还没有记录 —— 开一次番茄钟就会出现在这里',
        todayGoal: '目标进度',
        todayByTask: '时间花在哪',
        todayByTaskEmpty: '（还没绑定过任务）',
        todayMilestone: '已达成的里程碑',
        todayMilestoneEmpty: '（还没有）',
        todayRecent: '最近 7 天',
        todayUnit: '个',
        todayDays: '天',
        todayTimes: '次',
        taskNote: '回车提交。绑定后统计里能看到时间花在哪。',
        taskUnnamed: '（未命名）',
        hours: '小时',
        minutes: '分钟',
        rounds: '轮',
        /**
         * 秒 / 分钟的单位。
         *
         * ⚠️ 原先气泡时长、开心时长、睡眠时长这几个滑杆的单位是**写死英文**的
         * （`suffix: 's'` / `suffix: 'min'`），而番茄钟那几个走的是
         * `t('minutes')`（中文"分钟"）。于是同一个面板里
         * 「空闲多久后睡觉 5min」和「专注时长 25 分钟」并排出现 —— 不一致。
         * 单位也是文案，必须走同一份字典。
         */
        unitSec: '秒',
        unitMin: '分钟',
        // ── 语音（v3）───────────────────────────────────────────────────────        voice: '让庄方宜说话',
        voiceHint: '点击、完成、出错、番茄钟到点时播一句',
        voiceCount: '语音包',
        voiceCountHint: '用 tools/build-voice.ps1 生成；缺失时静音运行',
        voiceLines: '台词一览',
        voiceSynth: '合成',
        // ── 聊天与人设（v3）─────────────────────────────────────────────────
        groupChat: '聊天',
        chatEnabled: '允许在气泡里聊天',
        chatEnabledHint: '关闭后只在设置页这里聊',
        persona: '人设风格',
        personaHint: '语言风格。世界观与身份写在"共享背景"里，会自动拼在它前面',
        personaReload: '重新扫描人设目录',
        personaDir: '人设目录',        sharedTitle: '共享背景（所有风格共用）',
        sharedHint: '这些人设文件会拼在每种风格前面 —— 改一次，所有风格一起变',
        sharedEmpty: '还没有共享背景（当前风格是自包含的）',
        sharedUsed: '当前风格已拼接',
        sharedFiles: '份',
        speakTitle: '念出回答（动态语音）',
        speakHint: '需要合成子插件在跑（默认 127.0.0.1:8765）。连不上时自动退回固定台词，聊天不受影响',
        speakReplies: '把 AI 的回答念出来',
        speakRepliesHint: '合成需要几秒（GPU 约 3 秒/句），气泡会先显示文字',
        ttsUrl: '合成服务地址',
        speechMaxChars: '每段朗读字数',
        /**
         * 说明文字。
         *
         * ⚠️ 这个设置**不再是"总共只念多少字"**。以前它是硬上限，超出直接截断
         *（后半句就不念了）—— 用户问过"为什么一次只能念 60 个字，别限制啊"。
         * 现在回复是**按句分段、边合成边播**，整段都会念完；
         * 这个值只决定"每段多长"，也就是**多久开口**。
         */
        speechMaxCharsHint: '一段念多少字。整段回复都会念完，这个值只影响"多久开口"：调小开口更快，调大合成次数更少',
        ttsResident: '让语音模型常驻',
        ttsResidentHint: '常驻：启动一次后一直留在显存里，每次合成立刻开始（占显存）。关闭：空闲后自动停掉释放显存，但每次会话第一次合成要等模型加载',
        ttsIdleStopSec: '空闲多少秒后释放（秒，0 = 不停）',
        ttsIdleAction: '空闲时怎么释放',
        ttsIdleActionDefault: '用插件默认',
        ttsIdleActionUnload: '只卸模型（恢复快，进程留着）',
        ttsIdleActionStop: '杀进程（全释放）',
        svcStart: '启动服务',
        svcStop: '停止并释放',
        svcState: '合成服务',
        svcOurs: '运行中（桌宠启动的）',
        svcExternal: '运行中（你自己启动的，桌宠不会停它）',
        svcDown: '未运行',
        svcResidentOn: '常驻',
        svcUnknown: '合成服务：状态未知',
        svcByPlugin: '由语音插件托管',
        svcLaunch: '启动命令',
        svcStartOk: '服务已就绪',
        svcStartFail: '启动失败',
        svcStopOk: '已停止，显存已释放',
        svcStopNone: '这个服务不是你起的，桌宠不会去停它',
        speakProbe: '试一句',
        speakProbing: '探测中…',
        speakOk: '合成服务正常',
        speakFail: '合成服务不可用',
        speakPlayed: '已播放',
        speakStatus: '动态语音',
        speakCached: '已缓存',
        on: '开',
        off: '关',
        memoryTitle: '长期记忆（跨会话共享）',
        memoryHint: '所有聊天会话共享这份记忆；换会话、重开会话都不会忘',
        memoryAuto: '自动记住值得长期保留的事',
        memoryAutoHint: '每次回复后用模型提炼 0~3 条（称呼、项目、约定…），追加到这里',
        memoryEmpty: '（还没有记住什么）',
        memorySave: '保存记忆',
        memorySaved: '已保存',
        memorySaving: '保存中…',
        memoryBytes: '字节',
        memoryFile: '记忆文件',
        chatWorkspace: '聊天工作区',
        chatWorkspaceHint: '留空 = ~/Downloads/庄方宜',        chatStatus: '聊天状态',
        chatWsOk: '已归入工作区',
        chatWsNone: '尚未归入工作区（下次发消息时会自动建并挂上）',
        chatSend: '发一条',
        chatPlaceholder: '和庄方宜说点什么…',
        chatSending: '发送中…',
        chatSent: '已发送',
        chatReplyNote: '回复会显示在桌宠气泡里（记得让桌宠可见）',
        chatNoSession: '还没建立聊天会话（发第一条消息时会自动建）',
        groupStatus: '运行状态',
        nativeOn: '桌面窗口运行中',
        nativeOff: '桌面窗口不可用',
        fallbackNote: '当前使用窗口内悬浮（只在 DSH 窗口里可见）',
        reason: '原因',
        reset: '重置位置',        sendTitle: '发消息给庄方宜',
        sendPlaceholder: '说点什么…',
        sendTip: 'Enter 发送 · Esc 收起',
        sendTo: '发给',
        sending: '发送中…',
        activity: '活跃度',
        activityQuiet: '安静（只提醒要紧的事）',
        activityNormal: '正常',
        activityPlayful: '调皮（爱说话、会主动冒头）',
        // ── 分组标题（v-next：按用户心智重排，不再按开发历史）────────────────
        groupPet: '桌宠',        groupAdvanced: '高级与诊断',
        // ── 页签与卡片标题（v4：一页 = 一类问题；每张卡片可折叠）───────────
        //
        // 为什么有页签：DSH 的设置导航只有一级（一个插件一个入口），
        // 40 多个控件塞在一页里实测 2556px、要滚三屏。
        tabAppearance: '外观',
        tabBubble: '气泡',
        tabBehavior: '行为',
        tabVoice: '语音',
        tabChat: '对话',
        tabDiag: '诊断',        groupStatusText: '状态文字',
        groupReminder: '提醒',
        groupActivity: '活跃度',
        groupVoiceLines: '固定台词',
        groupSendMessage: '发消息',
        groupPaths: '路径与会话',
        // ── 卡片里**折叠**的长说明 ─────────────────────────────────────────
        //
        // 行内的说明一律压到一行（≤34 字）：原先 24 条说明散在正文里、
        // 最长的一条 61 字占三行，把真正要调的控件淹了。
        // 权衡、代价、边界这类"要知道但不必天天看"的，挪进卡片底部的
        // 「说明」折叠块 —— 控件是主角，文档点开就有。
        noteLabel: '说明',
        notePet: '桌面窗口是真的浮在桌面上（支持滚轮缩放、右键菜单、表情包画廊、托盘图标）。窗口内悬浮只是兜底：只在 DSH 窗口里可见，也不再补新功能 —— 原生窗口不可用时会自动回落到它。',
        noteBubble: '「对话文字大小」和「大小」（桌宠本体）是两件事：把桌宠调小是为了不占地，而气泡里的正文是要读的 —— 跟着一起缩就会小到看不清，所以单独可调。「审批/提问常亮」不看气泡时长：AI 在等你处理时会一直亮着。',
        noteSpeak: '需要合成子插件在跑（默认 127.0.0.1:8765）；连不上会自动退回固定台词，聊天不受影响。整段回复都会念完，按句分段、边合成边播 ——「每段朗读字数」只决定多久开口：调小开口更快，调大合成次数更少。常驻：加载一次后一直留在显存里，每次合成立刻开始；关闭：空闲后释放显存，但每次会话第一次合成要等模型加载。',
        advancedHint: '出问题时才需要看：服务状态、启动命令、素材与会话信息',
        // ── 诊断区键名 ──────────────────────────────────────────────────────
        diagAssets: '素材',
        diagStates: '个状态已覆盖',
        diagBubbles: '张气泡',
        diagMissing: '张待抠图',
        sharedDir: '共享背景目录',
        chatWsLabel: '工作区',
        chatSentCount: '已发',
        chatReplyCount: '已回',
        ttsIdleActionHint: '只卸模型：显存还了、但进程仍占约 2.7GB 内存；杀进程：全部释放',
      },
      en: {
        nav: 'Zhuang Fangyi Pet',
        title: 'Zhuang Fangyi Pet',
        subtitle: 'A pet that floats on your desktop · reacts to agent state',        enabled: 'Enable pet',
        mode: 'Display mode',
        modeNative: 'Desktop window (recommended)',
        modeNativeHint: 'Truly floats on your desktop. The in-window overlay appears only as a fallback when it is unavailable',
        modeOverlay: 'In-window overlay only (fewer features, compatibility)',
        modeOverlayHint: 'Inside the DSH window only — fewer features',
        scale: 'Size',
        opacity: 'Opacity',        topmost: 'Always on top',
        clickThrough: 'Click-through',
        clickThroughHint: 'Mouse passes fully through the pet (decoration only)',
        groupBubble: 'Bubble',
        bubble: 'Show bubbles',
        bubbleImages: 'Show expression images in bubbles',
        chatFontScale: 'Chat text size',
        chatFontScaleHint: 'Affects bubble chat text only, not the pet size',
        bubbleMs: 'Bubble duration',
        bubbleGapMs: 'Min gap between bubbles',
        bubbleGapHint: 'Raise it to reduce spam; 0 = unlimited',
        notifyComplete: 'Notify when AI finishes',
        notifyCompleteHint: 'Force a bubble on every clean turn end (bypasses the gap above)',
        attentionReminder: 'Sticky approval/question alert',
        attentionReminderHint: 'Stays lit until you approve or answer',        happyMs: 'Happy duration after done',
        sleepMs: 'Idle time before sleeping',
        doubleClick: 'Double-click pet',
        doubleClickFocus: 'Open DSH main window',
        doubleClickEmote: 'Show a random expression',
        doubleClickNone: 'Do nothing',
        theme: 'Light / dark theme',
        themeAuto: 'Auto (follow system)',
        themeLight: 'Light (white sticker / light bubble)',
        themeDark: 'Dark (black sticker / dark bubble)',
        hint: 'Show status on hover',
        statusAlways: 'Always show status below pet',
        statusAlwaysHint: 'Keeps the status text visible without hovering',
        statusFontScale: 'Status text size',
        statusFontScaleHint: 'Affects the status text only, not the pet size',
        // ── Pomodoro (v3) ───────────────────────────────────────────────────
        groupPomodoro: 'Pomodoro',
        pomodoro: 'Enable pomodoro',
        pomodoroHint: 'Focus, then rest. Off by default — press start yourself',
        pomodoroFocusMs: 'Focus length',
        pomodoroBreakMs: 'Short break',
        pomodoroLongBreakMs: 'Long break',
        pomodoroRounds: 'Rounds per long break',
        pomodoroRoundsHint: 'A long break after this many focus rounds',
        pomodoroAutoNext: 'Auto-start next phase',
        pomodoroAutoNextHint: 'When off, it stops after each phase and waits for you',
        pomodoroNotify: 'Notify me when a phase ends',
        pomodoroNotifyHint: 'Bubble + expression (and voice, if enabled)',
        pomodoroCountdown: 'Show countdown below pet',
        pomodoroStart: 'Start focus',
        pomodoroPause: 'Pause',
        pomodoroResume: 'Resume',
        pomodoroSkip: 'Skip phase',
        pomodoroReset: 'Reset',
        // ── v10: pomodoro extras ───────────────────────────────────────────
        pomodoroGoalCount: 'Daily pomodoro goal',
        pomodoroGoalCountHint: 'Set 0 to just track, without a goal',
        pomodoroPreset: 'Pace preset',
        pomodoroPresetHint: 'Applies a set of lengths; editing them marks it Custom',
        presetClassic: 'Classic 25/5',
        presetDeep: 'Deep work 52/17',
        presetSprint: 'Sprint 25/5',
        presetFree: 'Free (up to 4 hours)',
        presetCustom: 'Custom',
        pomodoroBreath: 'Breathing guide while focusing',
        pomodoroBreathHint: 'A ring below the pet that expands and contracts (4-7-8)',
        pomodoroTask: 'What this round is for',
        pomodoroTaskHint: 'Name it and the stats show where the time went',
        pomodoroTaskPlaceholder: 'e.g. pet plugin',
        // ── v10: gestures ──────────────────────────────────────────────────
        groupGesture: 'Gestures',
        gestureLead: 'On the pet itself: click = greet · hold still = pet · flick = she flies',
        gestureHintBtn: 'Show the gesture hint again',
        gestureHintNote: 'The hint appears in the pet bubble (needs the desktop window running)',
        flingEnabled: 'Fling by dragging',
        flingEnabledHint: 'Flick her and she flies and lands; a slow drag still just moves her',
        longPress: 'Pet by holding',
        longPressHint: 'Hold still for a graded reaction; release to stop',
        gestureSensitivity: 'Gesture sensitivity',
        gestureSensitivityHint: 'Raise this if taps/holds miss (common with high-DPI mice)',
        noteGesture: 'Gesture tolerance is judged in screen pixels, while hand tremor in pixels = tremor distance × mouse hardware DPI × system pointer gain. The pet can read the system pointer gain itself (and compensates automatically), but mouse hardware DPI has no readable API — so the "my DPI is high" half can only be covered by this slider. The tradeoff: dragging a short distance slowly may also register as a tap.',
        debugGestures: 'Gesture debug log (breadcrumbs)',
        debugGesturesHint: 'Record every press/move/release and why it did not fire',
        debugGesturesNote: 'When on, the pet logs every press, move and release — including the cases that previously logged nothing (presses on transparent pixels, during a fling animation, or a release with no recorded press) — plus a one-line explanation of why the gesture did not fire. The log is at `%LOCALAPPDATA%\\DSH-ZhuangFangyi-Pet\\pet.log`; search for `[手势]`. The last 200 entries from before you enabled it are flushed too, so "tap a few times with no reaction, then enable it" keeps the evidence. Off by default: breadcrumbs are dense. There is also a one-click toggle in the right-click menu.',
        hoverReact: 'Glance up when the cursor rests on her',
        hoverReactHint: 'Off by default — the only interaction she starts herself',
        // ── v10: Today tab ────────────────────────────────────────────────
        tabToday: 'Today',
        groupToday: 'Today',
        todayCount: 'Pomodoros today',
        todayFocus: 'Focus time',
        todayInterrupts: 'Interruptions',
        todayStreak: 'Day streak',
        todayEmpty: 'No records yet — run one pomodoro and it shows up here',
        todayGoal: 'Goal progress',
        todayByTask: 'Where the time went',
        todayByTaskEmpty: '(no task bound yet)',
        todayMilestone: 'Milestones reached',
        todayMilestoneEmpty: '(none yet)',
        todayRecent: 'Last 7 days',
        todayUnit: '',
        todayDays: 'days',
        todayTimes: 'x',
        taskNote: 'Press Enter to submit. Once bound, the stats show where the time went.',
        taskUnnamed: '(unnamed)',
        hours: 'h',
        minutes: 'min',
        rounds: 'rounds',
        unitSec: 's',
        unitMin: 'min',
        // ── Voice (v3) ──────────────────────────────────────────────────────        voice: 'Let her speak',
        voiceHint: 'Speaks on click, completion, errors and pomodoro phases',
        voiceCount: 'Voice pack',
        voiceCountHint: 'Build it with tools/build-voice.ps1; runs silent when missing',
        voiceLines: 'All lines',
        voiceSynth: 'synth',
        // ── Chat & persona (v3) ─────────────────────────────────────────────
        groupChat: 'Chat',
        chatEnabled: 'Allow chatting from the bubble',
        chatEnabledHint: 'When off, chat only from this settings page',
        persona: 'Persona style',
        personaHint: 'Language style. World & identity live in the shared background and are prepended automatically',
        personaReload: 'Rescan persona folder',
        personaDir: 'Persona folder',        sharedTitle: 'Shared background (used by every style)',
        sharedHint: 'These files are prepended to every style — edit once, all styles change',
        sharedEmpty: 'No shared background yet (current style is self-contained)',
        sharedUsed: 'Current style composes',
        sharedFiles: 'file(s)',
        speakTitle: 'Speak the reply (dynamic TTS)',
        speakHint: 'Requires the synthesis sub-plugin (default 127.0.0.1:8765). Falls back to fixed lines when unreachable; chat is unaffected',
        speakReplies: 'Speak AI replies aloud',
        speakRepliesHint: 'Synthesis takes seconds (≈3 s/sentence on GPU); the bubble shows text first',
        ttsUrl: 'TTS service URL',
        speechMaxChars: 'Characters per segment',
        speechMaxCharsHint: 'How many characters per segment. The whole reply is always spoken — this only controls how soon the first audio starts: smaller = starts sooner, larger = fewer synthesis calls',
        ttsResident: 'Keep the voice model resident',
        ttsResidentHint: 'Resident: load once and stay in VRAM — every synthesis starts instantly (uses VRAM). Off: unload when idle to free VRAM, but the first synthesis of each session waits for model load',
        ttsIdleStopSec: 'Unload after idle (seconds, 0 = never)',
        ttsIdleAction: 'How to release when idle',
        ttsIdleActionDefault: 'Plugin default',
        ttsIdleActionUnload: 'Unload model only (fast resume)',
        ttsIdleActionStop: 'Stop process (full release)',
        svcStart: 'Start service',
        svcStop: 'Stop & free VRAM',
        svcState: 'TTS service',
        svcOurs: 'running (started by the pet)',
        svcExternal: 'running (started by you — the pet will not stop it)',
        svcDown: 'not running',
        svcResidentOn: 'resident',
        svcUnknown: 'TTS service: unknown',
        svcByPlugin: 'managed by the voice plugin',
        svcLaunch: 'Launch command',
        svcStartOk: 'Service ready',
        svcStartFail: 'Start failed',
        svcStopOk: 'Stopped, VRAM freed',
        svcStopNone: 'That service was not started by the pet',
        speakProbe: 'Try one',
        speakProbing: 'Probing…',
        speakOk: 'TTS service OK',
        speakFail: 'TTS service unavailable',
        speakPlayed: 'played',
        speakStatus: 'Dynamic speech',
        speakCached: 'cached',
        on: 'on',
        off: 'off',
        memoryTitle: 'Long-term memory (shared across sessions)',
        memoryHint: 'Every chat session shares this memory; switching or reopening a session keeps it',
        memoryAuto: 'Automatically remember durable facts',
        memoryAutoHint: 'After each reply the model extracts 0–3 facts (names, projects, agreements…) and appends them here',
        memoryEmpty: '(nothing remembered yet)',
        memorySave: 'Save memory',
        memorySaved: 'Saved',
        memorySaving: 'Saving…',
        memoryBytes: 'bytes',
        memoryFile: 'Memory file',
        chatWorkspace: 'Chat workspace',
        chatWorkspaceHint: 'Empty = ~/Downloads/庄方宜',        chatStatus: 'Chat status',
        chatWsOk: 'Filed under workspace',
        chatWsNone: 'Not filed under a workspace yet (created on your next message)',
        chatSend: 'Send',
        chatPlaceholder: 'Say something to her…',
        chatSending: 'Sending…',
        chatSent: 'Sent',
        chatReplyNote: 'Replies show up in the pet bubble (keep the pet visible)',
        chatNoSession: 'No chat session yet (created on your first message)',
        groupStatus: 'Status',
        nativeOn: 'Desktop window running',
        nativeOff: 'Desktop window unavailable',
        fallbackNote: 'Using in-window overlay (visible only inside DSH)',
        reason: 'Reason',
        reset: 'Reset position',        sendTitle: 'Send a message',
        sendPlaceholder: 'Say something…',
        sendTip: 'Enter to send · Esc to close',
        sendTo: 'To',
        sending: 'Sending…',
        activity: 'Liveliness',
        activityQuiet: 'Quiet (only important notices)',
        activityNormal: 'Normal',
        activityPlayful: 'Playful (chatty, pops up on its own)',
        groupPet: 'Pet',        groupAdvanced: 'Advanced & diagnostics',
        // ── Tabs and card titles (v4: one page = one class of question) ─────
        tabAppearance: 'Appearance',
        tabBubble: 'Bubble',
        tabBehavior: 'Behavior',
        tabVoice: 'Voice',
        tabChat: 'Chat',
        tabDiag: 'Diagnostics',        groupStatusText: 'Status text',
        groupReminder: 'Reminders',
        groupActivity: 'Liveliness',
        groupVoiceLines: 'Fixed lines',
        groupSendMessage: 'Send a message',
        groupPaths: 'Paths & session',
        // ── Long explanations that live in a collapsed card footer ─────────
        // Inline descriptions are capped at one line; trade-offs move here.
        noteLabel: 'Details',
        notePet: 'The desktop window truly floats on your desktop (wheel zoom, right-click menu, emote gallery, tray icon). The in-window overlay is a fallback only: visible inside DSH, and it gets no new features — it appears automatically when the native window is unavailable.',
        noteBubble: 'Chat text size and pet size are separate: you shrink the pet to save space, but bubble text is meant to be read, so it stays adjustable on its own. The sticky approval alert ignores bubble duration — it stays lit while the AI waits for you.',
        noteSpeak: 'Needs the synthesis sub-plugin (default 127.0.0.1:8765); when unreachable it falls back to fixed lines and chat is unaffected. The whole reply is always spoken, in sentence-sized segments synthesized while playing — the segment size only controls how soon the first audio starts. Resident: load once and stay in VRAM, instant synthesis. Off: free VRAM when idle, but the first synthesis of each session waits for the model to load.',
        advancedHint: 'Only needed when something is wrong: service state, launch command, assets and session info',
        diagAssets: 'Assets',
        diagStates: 'states covered',
        diagBubbles: 'bubbles',
        diagMissing: 'awaiting cutout',
        sharedDir: 'Shared background dir',
        chatWsLabel: 'Workspace',
        chatSentCount: 'sent',
        chatReplyCount: 'replied',
        ttsIdleActionHint: 'Unload keeps the process (~2.7GB RAM still held); stop releases everything'
      }
    }

    /**
     * 按项目把会话分组（overlay 选择器的"折叠"）。
     *
     * 真机上同一项目下能有十几个对话（用户截图一整列同名），平铺一个下拉翻不到，
     * 所以用 `<optgroup>` 让"项目"成为天然的折叠层。
     * 保持 Host 给的顺序（Host 已按项目聚拢），只做相邻切分。
     * 没有 project 的归入一组 `project: null`（不套 optgroup）。
     *
     * @param {Array} sessions
     * @returns {Array<{project: string|null, items: Array}>}
     */
    function groupByProject (sessions) {
      const out = []
      for (const s of sessions ?? []) {
        const key = typeof s?.project === 'string' && s.project !== '' ? s.project : null
        const last = out.length > 0 ? out[out.length - 1] : null
        if (last !== null && last.project === key) last.items.push(s)
        else out.push({ project: key, items: [s] })
      }
      return out
    }

    /** 单条会话的下拉选项（项目名由 optgroup 承担，不重复前缀）。 */
    function sessionOption (s) {
      return h('option', { key: s.sessionId, value: s.sessionId },
        (s.running === true ? '● ' : '') + (s.title || s.sessionId))
    }
    /* ------------------------------------------------------------------ *
     * 小工具
     * ------------------------------------------------------------------ */

    /**
     * 番茄钟节奏预设（v10）。**与 Host 的 `POMODORO_PRESETS` 同集**。
     *
     * ⚠️ 客户端也要有一份：它是**下拉框的选项值**，而白名单校验发生在
     * 客户端归一化里（`normalizePet` 会原样 POST 给宿主）。两边不同集时，
     * 界面能选到一个宿主不认识的值 → 宿主回落默认 → **界面显示 deep、
     * 实际跑 25 分钟**，而且不报错。
     *
     * `custom` 不在下拉里（它是"用户手改过时长"的标记，不是一个可选项）。
     */
    const PET_POMODORO_PRESETS = ['classic', 'deep', 'sprint', 'free']

    /** 预设 → 四个时长字段。与 Host 的 `POMODORO_PRESET_VALUES` 同值。 */
    const PET_POMODORO_PRESET_VALUES = {
      classic: { pomodoroFocusMs: 25 * 60 * 1000, pomodoroBreakMs: 5 * 60 * 1000, pomodoroLongBreakMs: 15 * 60 * 1000, pomodoroRounds: 4 },
      deep: { pomodoroFocusMs: 52 * 60 * 1000, pomodoroBreakMs: 17 * 60 * 1000, pomodoroLongBreakMs: 30 * 60 * 1000, pomodoroRounds: 3 },
      sprint: { pomodoroFocusMs: 25 * 60 * 1000, pomodoroBreakMs: 5 * 60 * 1000, pomodoroLongBreakMs: 15 * 60 * 1000, pomodoroRounds: 4 },
      free: { pomodoroFocusMs: 240 * 60 * 1000, pomodoroBreakMs: 5 * 60 * 1000, pomodoroLongBreakMs: 15 * 60 * 1000, pomodoroRounds: 4 }
    }

    /** 取一个 host 设置对象，缺字段时回落默认值。 */
    function normalizePet (input) {
      const base = {
        enabled: true,
        /**
         * 默认 `native`（v2 起，`auto` 已并入它）—— 与 Host 的
         * `src/settings.js` 同值。overlay 现在是**冻结的兼容兜底**，
         * 见那边 `PET_MODES` 的说明。
         */
        mode: 'native',
        scale: 1,
        opacity: 1,
        clickThrough: false,
        topmost: true,
        bubble: true,
        bubbleImages: true,
        x: null,
        y: null,
        happyMs: 3000,
        sleepMs: 300000,
        /** 气泡一次显示多久 / 两条之间最小间隔（与 Host 的 settings.js 同范围）。 */
        bubbleMs: 6000,
        bubbleGapMs: 8000,
        /** 双击桌宠做什么。 */
        doubleClick: 'focus-dsh',
        /** 活跃度：安静 / 正常 / 调皮（气泡频率与主动卖萌，语义见 src/pet/activity.js）。 */
        activity: 'normal',
        /** 深浅色贴纸：auto 跟随渲染方环境。 */
        theme: 'auto',
        /** 悬停显示状态文字 / 桌宠下方常显状态。 */
        hint: true,
        statusAlways: false,
        /**
         * 状态文字字号倍率（1.0 = 基准）。
         * 与"桌宠大小"（`scale`）分开：桌宠可以小，字照样看得清。
         * 与 Host 的 `src/settings.js` 同默认值。
         */
        statusFontScale: 1,
        /**
         * 气泡**对话正文**的字号倍率（1.0 = 基准）。
         * 与 `statusFontScale` 分开：状态文字扫一眼、正文要读，需求不同。
         * 与 Host 的 `src/settings.js` 同默认值、同范围（0.5~3.0）。
         */
        chatFontScale: 1,
        /** AI 完成一回合时弹提醒。 */
        notifyComplete: true,
        /** 授权/提问常亮提醒（Host 用它决定 attention；独立于 bubble 总开关）。 */
        attentionReminder: true,
        // ── 番茄钟（v3）─────────────────────────────────────────────────────
        // **默认关**：装完就自己开始 25 分钟倒计时是骚扰，不是功能。
        pomodoro: false,
        pomodoroFocusMs: 25 * 60 * 1000,
        pomodoroBreakMs: 5 * 60 * 1000,
        pomodoroLongBreakMs: 15 * 60 * 1000,
        pomodoroRounds: 4,
        pomodoroAutoNext: true,
        pomodoroNotify: true,
        pomodoroCountdown: true,
        // ── 番茄钟 v10（今日目标 / 节奏预设 / 呼吸引导）────────────────────
        pomodoroGoalCount: 8,
        pomodoroPreset: 'classic',
        pomodoroBreath: false,
        // ── 互动手势 v10（用户："通过右键就点个按钮，很奇怪"）───────────────
        // 抛掷与长按摸头**默认开**：只有用户主动做手势才触发，不是骚扰。
        flingEnabled: true,
        longPress: true,
        /**
         * 手势灵敏度倍率（1.0 = 基准）。
         *
         * 用户点名："我鼠标DPI平时开的比较高，所以很多手势触发不了，怎么回事"。
         * 容差是绝对物理像素，而手抖落成多少像素 = 手抖物理距离 × 硬件 DPI ×
         * 指针增益 —— exe 能自动读**指针增益**，但**硬件 DPI 没有 API**，
         * 所以必须给用户一个自己拧的旋钮。默认 1.0 = 与之前完全一致。
         */
        gestureSensitivity: 1,
        // 悬停反应**默认关**：这是唯一"她主动找你"的互动，默认开就是骚扰。
        hoverReact: false,
        // ── 语音（v3）───────────────────────────────────────────────────────
        // **默认关**：桌宠突然开口是强打扰，用户主动打开才生效。
        voice: false,
        /**
         * ⚠️ 以下 12 个字段曾经**整批缺席**，代价是设置页 7 个控件全是死的。
         *
         * 为什么缺席：`normalizePet` 是**白名单**（逐字段拷贝），而这份白名单
         * 是手写的，语音那批字段加进来时只改了 Host 的 `src/settings.js`
         *（那里有 `defaultSettings()`），忘了这里。于是：
         *
         *   ① `load()` 把宿主 JSON 喂进来 → 这些键被丢掉 → 界面显示错值
         *      （实测：宿主 `speakReplies=true`，界面显示"关"）；
         *   ② `updateSettings(patch)` 也是 `normalizePet({...state, ...patch})`
         *      → 发出去的 POST body **根本不含这些键** → 宿主是**合并**语义
         *      → 点了等于没点，且**不报错**。
         *
         * 为什么测试没抓到：`tools/test-pet-e2e.mjs` 直接 POST `/pet/settings`
         * （绕过客户端归一化），所以宿主侧全绿；而客户端测试只验了
         * 它自己认识的那些字段。**两个半边各自都"对"，接缝上全错。**
         *
         * 现在由 `test-pet-client.mjs` 的"字段集与宿主同口径"一节兜住：
         * 它把宿主 `defaultSettings()` 的键逐个比对客户端归一化结果，
         * 以后任何一边加字段而另一边忘了，测试立刻红。
         */
        // 长期记忆：自动提炼开关（跨会话共享）。
        memoryAuto: true,
        // ── 动态语音（TTS）──────────────────────────────────────────────────
        speakReplies: false,
        ttsUrl: 'http://127.0.0.1:8765',
        speechMaxChars: 60,
        ttsResident: false,
        ttsIdleStopSec: 300,
        /** '' = 用语音插件的默认值。 */
        ttsIdleAction: '',
        /** 机器相关路径：由插件 loader 配置管，这里只做透传与只读展示。 */
        ttsPython: '',
        ttsRepoDir: '',
        ttsBackend: '',
        ttsGsvRoot: '',
        ttsModelDir: '',
        // ── 聊天与人设（v3）─────────────────────────────────────────────────
        persona: 'default',
        chatWorkspace: '',
        chatEnabled: true,
        locale: 'zh'
      }
      if (input === null || typeof input !== 'object') return base
      const out = { ...base }
      if (typeof input.enabled === 'boolean') out.enabled = input.enabled
      // `auto` 是 v1 旧值 → 归一化成 `native`（与 Host 的 settings.js 同规则）。
      if (input.mode === 'auto') out.mode = 'native'
      else if (['native', 'overlay'].includes(input.mode)) out.mode = input.mode
      // 0.3~3.0：与 Host 的 settings.js、exe 的滚轮缩放同一个范围（三处必须一致）。
      if (Number.isFinite(input.scale)) out.scale = Math.min(3, Math.max(0.3, input.scale))
      if (Number.isFinite(input.opacity)) out.opacity = Math.min(1, Math.max(0.3, input.opacity))
      // 状态文字字号倍率：与 Host 的 `STATUS_FONT_MIN/MAX` **同范围**（0.5~3.0）。
      // 两处口径必须一致，否则"设置页能选的值"和"宿主接受的值"会分叉。
      if (Number.isFinite(input.statusFontScale)) {
        out.statusFontScale = Math.min(3, Math.max(0.5, input.statusFontScale))
      }
      // 气泡正文字号倍率：与 Host 同范围同口径（0.5~3.0）。
      if (Number.isFinite(input.chatFontScale)) {
        out.chatFontScale = Math.min(3, Math.max(0.5, input.chatFontScale))
      }
      // v13 手势灵敏度：与 Host 同范围（1.0~3.0）。
      // ⚠️ 下限是 1.0 而不是 0.5 —— **容差绝不许比基准更小**，
      // 那会让手势更难触发，与本功能的目的正好相反。
      if (Number.isFinite(input.gestureSensitivity)) {
        out.gestureSensitivity = Math.min(3, Math.max(1, input.gestureSensitivity))
      }
      for (const k of ['clickThrough', 'topmost', 'bubble', 'bubbleImages',
        'hint', 'statusAlways', 'notifyComplete', 'attentionReminder',
        'pomodoro', 'pomodoroAutoNext', 'pomodoroNotify', 'pomodoroCountdown',
        // v10：番茄钟扩展 + 互动手势。同样必须在这里 —— 漏一个就是
        // "界面能改、但发不出去"（合并语义下宿主静默忽略，零报错）。
        'pomodoroBreath', 'flingEnabled', 'longPress', 'hoverReact',
        'voice', 'chatEnabled',
        // ⚠️ 这三个曾经漏在白名单外 —— 见上面 `memoryAuto` 的说明。
        'memoryAuto', 'speakReplies', 'ttsResident',
        // v13.6：手势调试日志。同样必须在这里，否则设置页能勾、但发不出去。
        'debugGestures']) {
        if (typeof input[k] === 'boolean') out[k] = input[k]
      }
      // 番茄钟时长：与 Host 的 settings.js **同范围**（三处口径必须一致：
      // Host 归一化、客户端归一化、番茄钟模块自己的 POMODORO_LIMITS）。
      const num = (v, min, max, fb) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb)
      out.pomodoroFocusMs = num(input.pomodoroFocusMs, 60000, 240 * 60000, base.pomodoroFocusMs)
      out.pomodoroBreakMs = num(input.pomodoroBreakMs, 60000, 60 * 60000, base.pomodoroBreakMs)
      out.pomodoroLongBreakMs = num(input.pomodoroLongBreakMs, 60000, 120 * 60000, base.pomodoroLongBreakMs)
      out.pomodoroRounds = num(input.pomodoroRounds, 2, 12, base.pomodoroRounds)
      // v10：今日目标（0 = 不设目标，所以下限是 0）+ 节奏预设（白名单）。
      out.pomodoroGoalCount = num(input.pomodoroGoalCount, 0, 30, base.pomodoroGoalCount)
      if (PET_POMODORO_PRESETS.includes(input.pomodoroPreset)) out.pomodoroPreset = input.pomodoroPreset
      if (typeof input.persona === 'string') {
        const p = input.persona.trim()
        if (p !== '' && p.length <= 64) out.persona = p
      }
      if (typeof input.chatWorkspace === 'string') {
        const w = input.chatWorkspace.trim()
        if (w === '') out.chatWorkspace = ''
        else if (w.length <= 260) out.chatWorkspace = w
      }
      // ── 动态语音（TTS）的四个值字段 ──────────────────────────────────────
      //
      // ⚠️ 与上面那三个布尔同一个洞：它们曾经全部缺席，于是
      // 「合成服务地址」「每次朗读字数上限」「空闲多少秒后释放」这三个输入框
      // 改完**发不出去**（POST body 里没有这些键），而界面还显示"我改过了"。
      //
      // 校验口径**照抄 Host 的 `src/settings.js`**（同范围、同白名单）：
      // 客户端归一化的产物会原样 POST 给宿主，若两边夹取范围不同，
      // 就会出现"界面显示 500，宿主存成 300"这种界面骗人的情况。
      if (typeof input.ttsUrl === 'string') {
        const u = input.ttsUrl.trim()
        // 只接受 http/https：它会被 fetch 直接使用，放开等于给了任意协议入口。
        if (u === '') out.ttsUrl = ''
        else if (u.length <= 300 && /^https?:\/\//i.test(u)) out.ttsUrl = u
      }
      if (Number.isFinite(input.speechMaxChars)) {
        out.speechMaxChars = Math.min(300, Math.max(10, Math.round(input.speechMaxChars)))
      }
      if (Number.isFinite(input.ttsIdleStopSec)) {
        out.ttsIdleStopSec = Math.min(86400, Math.max(0, Math.round(input.ttsIdleStopSec)))
      }
      // 释放方式：只认两个值 + 空串（= 用插件默认），与 Host 的 `TT_IDLE_ACTIONS` 同集。
      if (input.ttsIdleAction === '' || input.ttsIdleAction === 'unload' || input.ttsIdleAction === 'stop') {
        out.ttsIdleAction = input.ttsIdleAction
      }
      // 机器相关路径与后端：长度限住，后端只认三个值（与 Host 的 `TT_BACKENDS` 同集）。
      // 这几个**不提供编辑控件**（归插件 loader 配置管），但必须能透传 ——
      // 否则设置页 POST 完整对象时会把它们冲掉。
      for (const key of ['ttsPython', 'ttsRepoDir', 'ttsGsvRoot', 'ttsModelDir']) {
        if (typeof input[key] === 'string' && input[key].length <= 300) out[key] = input[key].trim()
      }
      if (input.ttsBackend === '' || input.ttsBackend === 'torch' || input.ttsBackend === 'onnx') {
        out.ttsBackend = input.ttsBackend
      }
      if (Number.isFinite(input.x)) out.x = Math.round(input.x)
      if (Number.isFinite(input.y)) out.y = Math.round(input.y)
      if (Number.isFinite(input.happyMs)) out.happyMs = Math.min(600000, Math.max(100, input.happyMs))
      if (Number.isFinite(input.sleepMs)) out.sleepMs = Math.min(86400000, Math.max(10000, input.sleepMs))
      if (Number.isFinite(input.bubbleMs)) out.bubbleMs = Math.min(20000, Math.max(1000, input.bubbleMs))
      if (Number.isFinite(input.bubbleGapMs)) out.bubbleGapMs = Math.min(60000, Math.max(0, input.bubbleGapMs))
      if (['focus-dsh', 'emote', 'none'].includes(input.doubleClick)) out.doubleClick = input.doubleClick
      if (['auto', 'light', 'dark'].includes(input.theme)) out.theme = input.theme
      if (['quiet', 'normal', 'playful'].includes(input.activity)) out.activity = input.activity
      if (input.locale === 'zh' || input.locale === 'en') out.locale = input.locale
      return out
    }

    /** 位置落 localStorage：这是纯前端偏好，不需要跨设备同步。 */
    const POS_KEY = 'zf-pet-position'

    /**
     * 设置页当前页签（v4）。
     *
     * 与位置同理：纯前端偏好，不回传宿主。记住它是因为设置页有六页，
     * 每次都从「外观」开始意味着常改语音的人每次都要多点一下。
     * 读写全程 try/catch —— 隐私模式下 localStorage 会抛异常，
     * 而它只是"记住上次"，不该把整个设置页打崩。
     */
    const TAB_KEY = 'zf-pet-settings-tab'

    function readPos () {
      try {
        const raw = window.localStorage.getItem(POS_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) {
          return { x: Math.round(parsed.x), y: Math.round(parsed.y) }
        }
      } catch { /* 存储不可用或内容损坏：当作没存过 */ }
      return null
    }

    function writePos (pos) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(pos))
      } catch { /* 隐私模式等：静默降级，位置不持久化而已 */ }
    }

    /**
     * 把位置夹到视口内。
     *
     * 拖出视口后必须能找回来 —— 否则用户一不小心就"把桌宠弄丢了"。
     * 尺寸未知时给一个保守下限，宁可夹得紧一点也不能让它跑到屏幕外。
     */
    function clampPos (pos, width, height) {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1600
      const vh = typeof window !== 'undefined' ? window.innerHeight : 900
      const w = Math.max(1, Math.min(width || 120, vw))
      const h = Math.max(1, Math.min(height || 120, vh))
      return {
        x: Math.min(Math.max(0, Math.round(pos.x)), Math.max(0, vw - w)),
        y: Math.min(Math.max(0, Math.round(pos.y)), Math.max(0, vh - h))
      }
    }

    /** 取当前语言（外壳 locale 服务，拿不到就 zh）。 */
    function makeT (ctx) {
      let lang = 'zh'
      try {
        const l = ctx.locale?.get?.() ?? ctx.locale?.current
        if (typeof l === 'string' && l.toLowerCase().startsWith('en')) lang = 'en'
      } catch { /* 拿不到就用 zh */ }
      const dict = DICT[lang] ?? DICT.zh
      return key => dict[key] ?? DICT.zh[key] ?? key
    }

    /* ------------------------------------------------------------------ *
     * 桌宠本体
     * ------------------------------------------------------------------ */

    /**
     * 桌宠组件。
     *
     * 状态来自宿主的 SSE；素材来自 `/pet/atlas` + `/pet/art/*`。
     * 两条流都是**只读**的，组件本身不做任何业务判断（判断都在宿主的状态机里），
     * 这样原生窗口与 overlay 的行为不可能分叉。
     */
    function Pet (props) {
      // 运行时从模块级单例取，**不是** props.runtime —— 见 `requireRuntime()` 的说明。
      const runtime = requireRuntime()
      const runtimeRef = useRef(runtime)
      runtimeRef.current = runtime
      /** 文案取词器（`✎` 与输入框的提示要本地化；与设置页同一份字典）。 */
      const t = runtime.t ?? (key => key)

      const [snapshot, setSnapshot] = useState(() => runtimeRef.current.snapshot)
      const [atlas, setAtlas] = useState(() => runtimeRef.current.atlas)
      const [settings, setSettings] = useState(() => runtimeRef.current.settings)
      const [pos, setPos] = useState(() => {
        const stored = readPos()
        if (stored !== null) return stored
        // 首次：放到右下角，避开输入框区域。
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1600
        const vh = typeof window !== 'undefined' ? window.innerHeight : 900
        return { x: vw - 200, y: vh - 260 }
      })

      const imgRef = useRef(null)
      const dragRef = useRef(null)
      const [dragging, setDragging] = useState(false)
      const [size, setSize] = useState({ w: 160, h: 160 })
      /**
       * 从**图片本身**量出来的单帧几何。
       *
       * 为什么不能假设方形：实测产出的条带单帧宽在 **239~288px** 之间（不是 256），
       * 因为素材内容 bbox 的纵横比各不相同（0.85~1.13）。若按 `frameHeight` 当宽度，
       * 图会被**横向压扁**，且切状态时宽度跳变。
       *
       * 所以以**图片实际尺寸**为准（`naturalWidth / frames`），清单里的
       * `frameWidth` 只作为加载前的占位值。
       *
       * **必须连同"是哪张图"一起记**：换状态/换变体时，上一张图的实测值
       * 对新图是错的（帧数与宽度都可能不同），若不清掉会短暂用错几何。
       */
      const [natural, setNatural] = useState(null)
      const naturalForRef = useRef(null)

      // 订阅宿主的运行时（快照/清单/设置都在同一个订阅里推过来）。
      useEffect(() => {
        const r = runtimeRef.current
        const off = r.subscribe(next => {
          if (next.snapshot !== undefined) setSnapshot(next.snapshot)
          if (next.atlas !== undefined) setAtlas(next.atlas)
          if (next.settings !== undefined) setSettings(next.settings)
          // 设置页点了"重置位置"：这里把桌宠移回右下角。
          if (next.resetPosition !== undefined) {
            const vw = typeof window !== 'undefined' ? window.innerWidth : 1600
            const vh = typeof window !== 'undefined' ? window.innerHeight : 900
            setPos({ x: vw - 200, y: vh - 260 })
          }
        })
        return off
      }, [])

      // 视口变化时重新夹取：否则缩小窗口后桌宠会留在视口外。
      useEffect(() => {
        const onResize = () => setPos(p => clampPos(p, size.w, size.h))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [size.w, size.h])

      // ── 深色模式：overlay 是**渲染方**，由它自己判断实际主题（契约 §4 `fileDark`）──
      // 优先看外壳 presenter 设置的 `data-ds-theme-source`（DSH 主题可能是
      // system/light/dark 任一，用户也可能是强制深色）；读不到再退回系统
      // `prefers-color-scheme`。监听两处变化，主题切换**不重载页面**也能生效。
      const [darkAuto, setDarkAuto] = useState(() => prefersDarkNow())
      useEffect(() => {
        const mq = typeof matchMedia === 'function'
          ? matchMedia('(prefers-color-scheme: dark)')
          : null
        const sync = () => setDarkAuto(prefersDarkNow())
        if (mq) { mq.addEventListener?.('change', sync); sync() }
        const root = typeof document !== 'undefined' ? document.documentElement : null
        const mo = (typeof MutationObserver === 'function' && root)
          ? new MutationObserver(sync)
          : null
        mo?.observe(root, { attributes: true, attributeFilter: ['data-ds-theme-source'] })
        return () => {
          if (mq) mq.removeEventListener?.('change', sync)
          mo?.disconnect()
        }
      }, [])

      // 用户手动覆盖（设置页 `theme`）：auto = 渲染方自判，light/dark 强制。
      // exe 侧同一条设置走 snapshot.settings.theme，两半行为一致。
      const dark = settings.theme === 'dark'
        ? true
        : settings.theme === 'light' ? false : darkAuto

      // ── 从气泡发消息（用户点名："直接在桌宠的气泡中发送"）────────────────
      //
      // 入口：鼠标悬停时桌宠旁边出现一个小 ✎；点它才展开输入框。
      // 这样不占地方、不破坏拖动，也不占用双击（双击默认是打开 DSH）。
      //
      // **能力位门控**：宿主没装配 `sessionController` 时 `send.available=false`，
      // 这时**不显示** ✎ —— 给一个点了必报错的入口比没有入口更像坏了。
      const canSend = snapshot?.send?.available === true
      const [composerOpen, setComposerOpen] = useState(false)
      const [sending, setSending] = useState(false)
      const [sendError, setSendError] = useState(null)
      const sendTextRef = useRef('')
      // 发给哪个对话：默认第一个（Host 已把"在跑的"排前面）。
      const [targetSessionId, setTargetSessionId] = useState(null)
      const sessionChoices = Array.isArray(snapshot?.sessions)
        ? snapshot.sessions.filter(s => s && s.sessionId && s.sessionId !== 'unknown')
        : []
      // 选中的会话若已消失（对话结束了），自动落到第一个 —— 否则会发向一个不存在的会话。
      const effectiveTargetId = sessionChoices.some(s => s.sessionId === targetSessionId)
        ? targetSessionId
        : (sessionChoices[0]?.sessionId ?? null)

      const submitSend = useCallback(async () => {
        const text = String(sendTextRef.current ?? '').trim()
        if (text === '' || sending) return
        if (text.length > 2000) {
          setSendError('太长了（最多 2000 字）')
          return
        }
        setSending(true)
        setSendError(null)
        try {
          await runtime.sendMessage?.(text, effectiveTargetId)
          // 发出去就收起来：输入框是快捷入口，不是常驻编辑器。
          setComposerOpen(false)
          sendTextRef.current = ''
        } catch (error) {
          // **失败不关闭、不清空** —— 用户刚打的字不能丢。
          setSendError(error?.message ?? String(error))
        } finally {
          setSending(false)
        }
      }, [runtime, sending])

      /* ---- 拖动：用 Pointer Events（不是 mouse），并捕获指针 ---- */
      const onPointerDown = useCallback(event => {
        if (event.button !== 0) return
        const el = event.currentTarget
        try {
          el.setPointerCapture(event.pointerId)
        } catch { /* 某些环境不支持捕获：退化为普通拖动 */ }
        dragRef.current = {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originX: pos.x,
          originY: pos.y,
          moved: false
        }
        setDragging(true)
      }, [pos.x, pos.y])

      const onPointerMove = useCallback(event => {
        const drag = dragRef.current
        if (drag === null || drag.id !== event.pointerId) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
        setPos(clampPos({ x: drag.originX + dx, y: drag.originY + dy }, size.w, size.h))
      }, [size.w, size.h])

      const onPointerUp = useCallback(event => {
        const drag = dragRef.current
        if (drag === null) return
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch { /* 已释放 */ }
        dragRef.current = null
        setDragging(false)
        // 只有真的拖动过才落盘，避免单击也写一次。
        if (drag.moved) {
          const next = clampPos({ x: drag.originX + (event.clientX - drag.startX), y: drag.originY + (event.clientY - drag.startY) }, size.w, size.h)
          writePos(next)
        }
      }, [size.w, size.h])

      /* ---- 双击：唤起 DSH 主窗口（overlay 里只能发命令让 exe 去做）---- */
      const onDoubleClick = useCallback(() => {
        runtimeRef.current.sendCommand?.('focus-dsh')
      }, [])

      const state = snapshot?.petState ?? 'idle'
      const scale = Number(settings.scale) || 1
      const entry = atlas?.states?.[state] ?? atlas?.states?.idle ?? null

      /**
       * 轮换到的素材文件。
       *
       * **几何必须按「文件」取，不能按「状态」取。** 因为 `variants` 里混了
       * 静态 PNG（1 帧）与动态 GIF（N 帧），实测 24 个变体里 **14 个**与所属
       * state 的声明不符。若按 state 的 `frames` 去切，`happy-4.png`（239px）
       * 会被切成 `239/33 = 7px` 的碎条。
       *
       * 优先级与契约 §4 一致：`files[file]` → `states[state]` → 图片实测。
       */
      const seed = Number(snapshot?.variantSeed) || 0
      const variantList = atlas?.variants?.[state]
      const file = (Array.isArray(variantList) && variantList.length > 0)
        ? variantList[Math.abs(Math.trunc(seed)) % variantList.length]
        : (entry?.file ?? null)

      const geom = file !== null && file !== undefined ? (atlas?.files?.[file] ?? null) : null
      const spriteUrl = file !== null && file !== undefined
        ? `${ROUTE}/art/${encodeURIComponent(file)}`
        : null
      const frames = Math.max(1, Number(geom?.frames ?? entry?.frames) || 1)
      const frameMs = Number(geom?.frameMs ?? entry?.frameMs) || 36

      // 实测几何只对**它自己那张图**有效。换了文件就丢弃，回落到清单声明，
      // 否则会拿上一张图的宽度去算新图的视口（切状态时肉眼可见地跳一下）。
      const natural2 = naturalForRef.current === spriteUrl ? natural : null

      // 单帧几何：优先用**实测值**（图片加载后得到），加载前用清单里的
      // `frameWidth`，最后才回落到 frameHeight。
      //
      // 单帧**不是方的**（实测 239~288px 宽），所以绝不能拿 frameHeight 当宽度 ——
      // 那会把图横向压扁，并在切状态时宽度跳变。
      const declaredW = Number(geom?.frameWidth ?? entry?.frameWidth)
      const frameH = natural2?.h ?? (Number(atlas?.frameHeight) || 256)
      const frameW = natural2?.w ?? (declaredW > 0 ? declaredW : frameH)

      // 图片加载后量真实尺寸，并记下它属于哪张图。
      const onImgLoad = event => {
        const el = event.currentTarget
        if (el?.naturalWidth > 0 && el.src === spriteUrl) {
          naturalForRef.current = spriteUrl
          setNatural({ w: el.naturalWidth / frames, h: el.naturalHeight })
          setSize({
            w: Math.round((el.naturalWidth / frames) * scale),
            h: Math.round(el.naturalHeight * scale)
          })
        }
      }

      const bubble = settings.bubble ? (snapshot?.bubble ?? null) : null
      // 深色模式用变体（契约 §4 `fileDark`）。变体缺失时回落浅色版 —— 不会更糟。
      const bubbleFile = bubble
        ? (dark && bubble.imageDark ? bubble.imageDark : bubble.image)
        : null
      const bubbleImage = settings.bubbleImages && bubbleFile
        ? `${ROUTE}/art/${encodeURIComponent(bubbleFile)}`
        : null

      // 容器必须小（只包住宠物），否则会挡住界面 —— 见文件头约束 2。
      //
      // ── 精灵图必须有一个**裁剪视口**（这里最容易做错）────────────────────
      //
      // 条带图是 `frames × frameHeight` 宽的一整张。若把 `<img>` 直接放进容器，
      // 浏览器会把**整条带子**铺开显示（33 帧并排 = 一条巨长的横条），而不是
      // 只显示当前帧。所以必须：
      //
      //   1. 一个宽度 = **单帧宽** 的视口，`overflow:hidden` 裁掉其余帧；
      //   2. `<img>` 绝对定位在其中，宽度 = 整条带；
      //   3. 用 `steps(frames)` 把它逐帧左移。
      //
      // 位移用 `translateX(-100%)` 是**对的**：translateX 的百分比相对**元素自身**
      // 宽度（= frames×帧宽），所以 -100% 正好等于 -frames×帧宽；配合 steps(frames)
      // 落在 t=0,1/N,…,(N-1)/N，得到的位移正是 0, -1帧, -2帧, …, -(N-1)帧 —— 恰好 N 帧。
      const viewW = Math.round(frameW * scale)
      const viewH = Math.round(frameH * scale)

      /**
       * **让位**：桌面窗口在跑时，overlay 必须完全不渲染。
       *
       * 否则屏幕上会有**两只桌宠**（一只在桌面、一只在 DSH 窗口里），
       * 而且它们各自记位置、各自响应拖动 —— 看起来就是坏了。
       * 契约 §2 对 `nativeAvailable` 的注释就是"供 overlay 判断是否让位"。
       *
       * 三种情况让位：
       *   · `enabled === false` —— 总开关关掉。宿主**不会**启动 exe，
       *     但 overlay 是纯前端渲染，必须自己停，否则"关了还在"；
       *   · `mode === 'native'`（**默认值**）—— 桌面窗为主。注意 exe
       *     **不可用**时它仍然要渲染，那正是逃生舱的意义（否则插件会变成
       *     一个"什么都没发生"的空壳）；
       *   · `nativeAvailable === true` —— exe 真的在跑，让给它。
       *
       * ⚠️ **`mode === 'overlay'` 不让位**，哪怕 `nativeAvailable` 是 true。
       * 原因：宿主按 mode 决定起不起 exe，但"从 native 切到 overlay"时
       * 已经在跑的 exe 要等设置变化把宿主停掉；这个窗口期内让位就等于
       * "用户选了窗口内，结果什么都不显示"。用户显式选的 mode 优先于探测到的状态。
       */
      const nativeRunning = snapshot?.nativeAvailable === true
      const shouldYield = settings.enabled === false ||
        (settings.mode !== 'overlay' && nativeRunning)
      if (shouldYield) return null

      return h('div', {
        className: 'zf-pet',
        'data-zf-pet-state': state,
        'data-zf-pet-dragging': dragging ? '1' : undefined,
        style: {
          left: `${pos.x}px`,
          top: `${pos.y}px`,
          opacity: settings.opacity,
          pointerEvents: settings.clickThrough ? 'none' : 'auto',
          // 未加载出素材前不渲染，避免"一张巨大的脸"（主题插件踩过：CSS 缺失时
          // <img> 会按原始尺寸铺开）。
          display: spriteUrl === null ? 'none' : undefined
        },
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        onDoubleClick,
        title: snapshot?.label ?? ''
      }, [
        spriteUrl === null
          ? null
          : h('div', {
              key: 'view',
              className: 'zf-pet__view',
              // 单帧宽高的裁剪视口：只露出当前帧。
              style: { width: `${viewW}px`, height: `${viewH}px` }
            }, h('img', {
              ref: imgRef,
              className: 'zf-pet__sprite',
              src: spriteUrl,
              alt: '',
              draggable: false,
              onLoad: onImgLoad,
              style: {
                height: `${viewH}px`,
                // 整条带的宽度 = 单帧宽 × 帧数。
                width: `${viewW * frames}px`,
                // steps() 让每帧硬切，不做插值 —— 否则会糊成一片。
                animationDuration: `${frames * frameMs}ms`,
                animationTimingFunction: `steps(${frames})`
              }
            })),
        bubble === null
          ? null
          : h('div', {
              key: 'bubble',
              className: 'zf-pet__bubble'
                + (bubble.imageOpaque ? ' zf-pet__bubble--opaque' : '')
                + (bubble.kind === 'attention' ? ' zf-pet__bubble--attention' : ''),
              'data-zf-pet-bubble-kind': bubble.kind,
              // 对话正文字号倍率（契约 §2 settings.chatFontScale）。
              // overlay 是**冻结的兜底**，但这只是把它已有的字号乘一个系数、
              // 不引新交互；不跟着变的话，用户切换显示方式会看到两种大小。
              style: { fontSize: `${(13 * (Number(settings.chatFontScale) || 1)).toFixed(1)}px` }
            }, [
              // 待处理计数徽标（同时两处要处理时显示 "2"）——
              // 常亮提醒最怕"只看见一个，其实有俩"。
              bubble.kind === 'attention' && (bubble.attentionCount ?? 1) > 1
                ? h('span', {
                    key: 'bubble-badge',
                    className: 'zf-pet__bubble-badge'
                  }, String(bubble.attentionCount))
                : null,
              bubbleImage === null
                ? null
                : h('img', {
                    key: 'bubble-img',
                    className: 'zf-pet__bubble-img',
                    src: bubbleImage,
                    alt: '',
                    draggable: false
                  }),
              bubble.text === null || bubble.text === undefined
                ? null
                : h('span', { key: 'bubble-text', className: 'zf-pet__bubble-text' }, bubble.text)
            ]),
        // 状态文字：`statusAlways` = 桌宠下方**常显**；`hint` = 仅悬停时露出。
        // 两个都关 → 完全不渲染，桌宠最安静。穿透时也不渲染（挡不住鼠标）。
        (settings.clickThrough || (!settings.statusAlways && !settings.hint))
          ? null
          : h('div', {
              key: 'hint',
              className: 'zf-pet__hint' + (settings.statusAlways ? ' zf-pet__hint--always' : ''),
              // 字号倍率：与原生窗同一设置（契约 §2 settings.statusFontScale）。
              // overlay 是**冻结的兜底**，但这个字段只是把它已有的字号乘以一个系数，
              // 不引入新交互 —— 不跟着变的话，用户切换显示方式会看到两种大小。
              style: { fontSize: `${(11 * (Number(settings.statusFontScale) || 1)).toFixed(1)}px` }
            }, snapshot?.label ?? ''),

        // ── ✎ 发消息入口（悬停才出现；能力不可用/整体穿透时不渲染）──────────
        //
        // 穿透模式下桌宠收不到鼠标，按钮会出现但点不动 —— 那比不给入口更像坏了。
        canSend && !settings.clickThrough
          ? h('button', {
              key: 'send-btn',
              className: 'zf-pet__send-btn',
              title: t('sendTitle'),
              'aria-label': t('sendTitle'),
              onClick: event => {
                // 别让点击冒泡到容器的拖动处理（否则会顺带拖一下/触发双击）。
                event.stopPropagation()
                setSendError(null)
                setComposerOpen(true)
              }
            }, '✎')
          : null,

        // ── 输入条：点 ✎ 后出现，Enter 发送、Esc 收起 ────────────────────────
        composerOpen
          ? h('div', { key: 'composer', className: 'zf-pet__composer' }, [
              // 发给哪个对话：多个对话时才有意义，只有一个就不占地方。
              sessionChoices.length > 1
                ? h('div', { key: 'target', className: 'zf-pet__composer-target' }, [
                    h('span', { key: 'label', className: 'zf-pet__composer-target-label' }, t('sendTo')),
                    h('select', {
                      key: 'sel',
                      className: 'zf-pet__composer-select',
                      value: effectiveTargetId ?? '',
                      onChange: event => setTargetSessionId(event.target.value)
                    // 用 <optgroup> 按项目**折叠**：真机上同一项目下能有十几个对话
                    //（用户截图一整列同名），平铺翻不到。分组让"项目"成为天然的折叠层。
                    }, groupByProject(sessionChoices).map(g =>
                      g.project === null
                        ? g.items.map(s => sessionOption(s))
                        : h('optgroup', { key: 'g-' + g.project, label: g.project }, g.items.map(s => sessionOption(s)))
                    ).flat())
                  ])
                : null,
              h('input', {
                key: 'input',
                className: 'zf-pet__composer-input',
                type: 'text',
                placeholder: t('sendPlaceholder'),
                maxLength: 2000,
                autoFocus: true,
                disabled: sending,
                onInput: event => { sendTextRef.current = event.target.value },
                onKeyDown: event => {
                  // Enter 发送。用 keydown 而不是表单提交：这是浮层，没有 form。
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    submitSend()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    setComposerOpen(false)
                    setSendError(null)
                  }
                }
              }),
              h('span', { key: 'tip', className: 'zf-pet__composer-tip' },
                sending ? t('sending') : (sendError ?? t('sendTip')))
            ])
          : null
      ])
    }

    /* ------------------------------------------------------------------ *
     * 设置页
     * ------------------------------------------------------------------ */

    /** 一个受控开关。样式走本插件自己的类名，不依赖外壳组件。 */

    /* ------------------------------------------------------------------ *
     * 设置页构件
     *
     * 这一层只管"长什么样"，不管业务。四个构件：
     *   Row  —— 一行设置（左：标题 + 可选说明；右：定宽控件列）
     *   Card —— 一张可折叠卡片（= 一个概念）
     *   Tabs —— 顶部页签（外壳的设置导航只有一级，这排是我们补的二级导航）
     *   Diag —— 诊断键值行（只出现在「诊断」页签里）
     * ------------------------------------------------------------------ */

    /**
     * 一行设置。
     *
     * ⚠️ 说明文字（`desc`）**必须落在左列**（`.zf-pet-row__main`），
     * 不许再挂到控件下面。原先三种写法并存 —— `Toggle` 的说明在控件下方
     * 通栏、下拉框的说明挤在标签与控件之间、独立的 note 段落又满行一段 ——
     * 同一屏里说明文字**跳三个位置**，"这一行在说什么"得靠找。
     * 现在只有一种位置，与 DSH 外壳自己的设置行一致（外壳的 `.description`
     * 也在标题下面、同一列里）。
     *
     * 根元素仍然是 `<label>`：点行内任意位置就能激活控件（开关尤其需要，
     * 16px 的方框很难点）。两个子容器用 `<span>` —— label 的内容模型是
     * phrasing content，用 `<div>` 是非法结构；span 加 display:flex
     * 一样能当弹性盒子使。
     */
    function Row (props) {
      const { label, desc, control } = props
      return h('label', { className: 'zf-pet-row' }, [
        h('span', { key: 'm', className: 'zf-pet-row__main' }, [
          h('span', { key: 'l', className: 'zf-pet-row__label' }, label),
          desc === undefined || desc === null || desc === ''
            ? null
            : h('span', { key: 'd', className: 'zf-pet-row__desc' }, desc)
        ]),
        h('span', { key: 'c', className: 'zf-pet-row__control' },
          Array.isArray(control) ? control : [control])
      ])
    }

    function Toggle (props) {
      const { label, value, onChange, hint } = props
      return h(Row, {
        label,
        desc: hint,
        control: h('input', {
          key: 'i',
          type: 'checkbox',
          className: 'zf-pet-row__input',
          checked: value === true,
          onChange: e => onChange(e.target.checked)
        })
      })
    }

    /**
     * 一个受控滑杆。
     *
     * `hint` 是可选的说明文字 —— 与 `Toggle` 对齐（那里一直支持 hint）。
     * 之前 Slider 忽略它：调用方传了 hint 却不显示，**静默丢失**。
     * 新加的"状态文字字号"就需要解释"它和上面那个大小不是一回事"。
     */
    function Slider (props) {
      const { label, value, min, max, step, suffix, onChange, hint } = props
      return h(Row, {
        label,
        desc: hint,
        // ⭐ 滑杆与数值**必须包在同一个容器里**（就是 `Row` 的控件列）。
        //
        // 原先它们是行网格里两个平级的 `auto` 轨道项，于是被排到**两行**去
        //（实测：标签 y=18、控件 y=18、数值 y=46 —— 数值掉到下一行，
        // 行高 68px，而一个正常的行只要 34px）。用 headless Edge 量过
        // 320/420/520/640/760/900 六种面板宽度，**全都换行** ——
        // 所以这不是"窗口窄了"，是这个布局本身错了。
        control: [
          h('input', {
            key: 'i',
            type: 'range',
            className: 'zf-pet-row__input',
            min,
            max,
            step,
            value,
            onChange: e => onChange(Number(e.target.value))
          }),
          h('span', { key: 'v', className: 'zf-pet-row__value' }, `${value}${suffix ?? ''}`)
        ]
      })
    }

    /**
     * 一张卡片（= 一个概念）。
     *
     * `<details>` + `<summary>`：**整张卡片可折叠**（用户点名"设置里的一些
     * 内容应该可以折叠或展开"）。`open` 用**声明式**属性（不读 DOM）：
     * 外壳的 React 桩没有真实 DOM，读 `open` 会让测试与真机行为分叉。
     * 注意 `open` 只在挂载时生效（非受控 `<details>`）—— 这是有意的：
     * 用户手动展开后不该被下一次重渲染合上。
     *
     * `note` 是**折叠的**长说明：那些"为什么默认这样、代价是什么"的权衡文字
     * 原先以 2~3 行段落直接糊在正文里，把真正要调的控件淹了。
     */
    function Card (props) {
      const { title, open, lead, note, noteLabel, children } = props
      const body = (children ?? []).filter(c => c !== null && c !== undefined)
      return h('details', { className: 'zf-pet-card', open: open === true }, [
        h('summary', { key: 's', className: 'zf-pet-card__sum' }, title),
        h('div', { key: 'b', className: 'zf-pet-card__body' }, [
          lead === undefined || lead === null
            ? null
            : h('p', { key: 'l', className: 'zf-pet-card__lead' }, lead),
          ...body
        ]),
        note === undefined || note === null
          ? null
          : h('details', { key: 'n', className: 'zf-pet-card__noteBox' }, [
              h('summary', { key: 'ns', className: 'zf-pet-card__noteSum' }, noteLabel),
              h('p', { key: 'np', className: 'zf-pet-card__note' }, note)
            ])
      ])
    }

    /**
     * 顶部页签。
     *
     * 为什么必须有它：DSH 的设置面板只提供**一级**导航（`settings.section`，
     * 一个插件一个入口），我们这 42 个控件原先全塞在同一页里 —— 实测 2556px、
     * 要滚三屏才能看完，而外壳自己的设置页都是一屏。
     * 只渲染当前页签的卡片，这就是"太长"的直接解药。
     */
    function Tabs (props) {
      const { items, value, onSelect } = props
      return h('div', { className: 'zf-pet-tabs', role: 'tablist' }, items.map(it =>
        h('button', {
          key: it.id,
          type: 'button',
          role: 'tab',
          id: `zf-pet-tab-${it.id}`,
          className: 'zf-pet-tab',
          'aria-selected': it.id === value ? 'true' : 'false',
          'aria-controls': `zf-pet-panel-${it.id}`,
          tabIndex: it.id === value ? 0 : -1,
          onClick: () => onSelect(it.id),
          // 键盘左右切换 + Home/End：页签是个导航控件，只能用鼠标点是不合格的。
          onKeyDown: e => {
            const i = items.findIndex(x => x.id === value)
            let next = -1
            if (e.key === 'ArrowRight') next = (i + 1) % items.length
            else if (e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length
            else if (e.key === 'Home') next = 0
            else if (e.key === 'End') next = items.length - 1
            if (next < 0) return
            e.preventDefault()
            onSelect(items[next].id)
          }
        }, it.label)))
    }

    /**
     * 诊断键值行。
     *
     * `mono` 给路径/命令行用：等宽 + 允许断行，长路径不会把面板撑破。
     */
    function Diag (props) {
      const { k, v, mono } = props
      return h('div', { className: 'zf-pet-diag' }, [
        h('span', { key: 'k', className: 'zf-pet-diag__k' }, k),
        h('span', {
          key: 'v',
          className: 'zf-pet-diag__v' + (mono === true ? ' zf-pet-diag__v--mono' : '')
        }, String(v ?? '—'))
      ])
    }

    function Section (props) {
      // 同上：`settings.section` 的 ownerProps 只有 `{ close }`，没有 runtime。
      const runtime = requireRuntime()
      const [settings, setSettings] = useState(() => runtime.settings)
      const [snapshot, setSnapshot] = useState(() => runtime.snapshot)
      const [atlas, setAtlas] = useState(() => runtime.atlas)
      const t = runtime.t

      useEffect(() => runtime.subscribe(next => {
        if (next.settings !== undefined) setSettings(next.settings)
        if (next.snapshot !== undefined) setSnapshot(next.snapshot)
        if (next.atlas !== undefined) setAtlas(next.atlas)
      }), [runtime])

      const set = patch => runtime.updateSettings?.(patch)

      // ── v3：番茄钟 / 语音 / 聊天 的本地状态 ──────────────────────────────
      //
      // 为什么不放进全局 runtime：这些都是**设置页自己的**临时 UI 状态
      //（草稿文本、加载中、提示语），桌宠与 overlay 都不关心。
      // 放全局会让每次按键都触发一次全局重渲染。
      const [voiceInfo, setVoiceInfo] = useState(null)
      const [personas, setPersonas] = useState(null)
      const [chatStatus, setChatStatus] = useState(null)
      const [chatBusy, setChatBusy] = useState(false)
      const [chatNote, setChatNote] = useState(null)
      /** 记忆：正文 + 保存状态（v3 跨会话共享）。 */
      const [memory, setMemory] = useState(null)
      const [memoryBusy, setMemoryBusy] = useState(false)
      const [memoryNote, setMemoryNote] = useState(null)
      /** 记忆草稿用 ref：每敲一个字都变，不该触发整页重渲染。 */
      const memoryDraftRef = useRef('')
      /**
       * 记忆编辑框的重建计数器（`key` 的一部分）。
       *
       * 为什么需要它：那个 textarea 是**非受控**的，`defaultValue` 只在挂载时
       * 生效一次。首帧 `memory` 还是 null（空串），加载回来之后若 key 不变，
       * React 不会重建元素 → 用户看到**永远空白的框**，在里面打字再保存
       * 就会把真实记忆覆盖掉（详见渲染处那段注释）。
       */
      const [memoryNonce, setMemoryNonce] = useState(0)
      /** 动态语音（TTS）状态与探测结果。 */
      const [speakStatus, setSpeakStatus] = useState(null)
      const [speakBusy, setSpeakBusy] = useState(false)
      const [speakNote, setSpeakNote] = useState(null)
      /** 草稿用 ref 而不是 state：它每敲一个字都变，不该触发重渲染。 */
      const chatDraftRef = useRef('')
      /**
       * ⚠️ 这里曾经是 `const chatDraft = chatDraftRef.current`，而输入框的
       * `onInput` 写的是 `chatDraft = e.target.value` —— **给 const 赋值**。
       *
       * 后果：用户每敲一个字都抛 `TypeError: Assignment to constant variable.`，
       * 草稿 ref 永远是空串 → 「发一条」按钮点了直接 `return`（`text === ''`），
       * **一句话也发不出去**，而且不报错、不给提示。
       * 实测复现：调用该输入框的 `onInput` 必抛（探针见
       * `.scratch/probe-chat-input-bug.mjs`）。
       *
       * 为什么测试没抓到：测试只检查"输入框在不在、placeholder 对不对"，
       * 从没**调用过**它的 `onInput`。
       *
       * 修法：不再抄一份快照出来，`value` 直接用 ref（非受控 + 初始空串），
       * 输入时写 ref。发完消息清空 ref 后，用 `draftNonce` 强制重建元素 ——
       * 否则输入框里会留着已发出的文字。
       */
      const [draftNonce, setDraftNonce] = useState(0)

      /**
       * 当前页签（v4）。
       *
       * 优先序：`runtime.__state.tab`（**测试缝**，与 `__state.settings` 同款，
       * 让测试能直接渲染指定那一页）→ localStorage（记住上次看的是哪一页）→ 首页。
       *
       * 为什么不放全局 runtime：切页签只影响设置页自己，桌宠与 overlay 都不关心；
       * 放全局会让每次切换触发一次全局重渲染（与上面那几个草稿 ref 同理）。
       */
      const [tab, setTabState] = useState(() => {
        const override = runtime.__state?.tab
        if (typeof override === 'string' && override !== '') return override
        try {
          const saved = window.localStorage.getItem(TAB_KEY)
          if (typeof saved === 'string' && saved !== '') return saved
        } catch { /* 读不到就用默认页 */ }
        return 'appearance'
      })

      /** 切页签：改状态 + 顺手记下来（记不住也不影响这一次切换）。 */
      const setTab = id => {
        setTabState(id)
        try { window.localStorage.setItem(TAB_KEY, id) } catch { /* 忽略 */ }
      }

      /**
       * 番茄钟动作：POST /pet/pomodoro。
       *
       * 失败也要给提示 —— "点了没反应"是最糟的（用户会以为坏了）。
       *
       * @param {string} action - `start`|`pause`|`skip`|`reset`|`set-task`
       * @param {object} [options] - `set-task` 时带 `{task}`
       */
      const pomodoroAction = (action, options) => {
        const doPost = runtime.pomodoroAction
        if (typeof doPost !== 'function') {
          setChatNote('番茄钟不可用（宿主未装配）')
          return
        }
        // `set-task` 要给反馈（输入框按回车后没有任何视觉变化，
        // 用户不知道到底提交了没有）；其余动作静默成功即可。
        Promise.resolve(doPost(action, options))
          .then(r => {
            if (r === null || r === undefined) return
            if (action === 'set-task') {
              const name = r?.result?.task
              setChatNote(name === '' || name === undefined
                ? '已清空这一轮的任务名'
                : `这一轮：${name}`)
              return
            }
            setChatNote(null)
          })
          .catch(e => setChatNote(`番茄钟操作失败：${e?.message ?? e}`))
      }

      const reloadPersonas = () => {
        const fn = runtime.reloadPersonas
        if (typeof fn !== 'function') return
        Promise.resolve(fn())
          .then(list => { if (list !== null && list !== undefined) setPersonas(list) })
          .catch(() => { /* 保持原列表 */ })
      }

      const selectPersona = name => {
        const fn = runtime.selectPersona
        if (typeof fn !== 'function') return
        Promise.resolve(fn(name))
          .then(r => {
            if (r?.ok === true) {
              setChatNote(r.note ?? null)
              set({ persona: name })
              if (typeof runtime.loadPersonas === 'function') {
                Promise.resolve(runtime.loadPersonas()).then(setPersonas).catch(() => {})
              }
            } else {
              setChatNote(`切换人设失败：${r?.error ?? r?.reason ?? '未知原因'}`)
            }
          })
          .catch(e => setChatNote(`切换人设失败：${e?.message ?? e}`))
      }

      /**
       * 保存记忆（整体替换）。失败要**如实报**，不能静默 ——
       * 用户按了保存却以为没生效，会反复改。
       */
      const saveMemory = () => {
        const fn = runtime.saveMemory
        if (typeof fn !== 'function') {
          setMemoryNote('记忆不可用（宿主未装配）')
          return
        }
        setMemoryBusy(true)
        setMemoryNote(null)
        Promise.resolve(fn(memoryDraftRef.current))
          .then(r => {
            if (r?.ok === false) {
              // ⚠️ 宿主写盘失败时返回的是 `{ok:false, reason}`，HTTP 状态仍是 200
              //（`api()` 只在 `!res.ok` 时抛）—— 所以**必须自己看 `ok`**，
              // 否则会把"写失败"报成"已保存"，用户以为记住了、其实没有。
              setMemoryNote(`保存失败：${r.reason ?? '未知原因'}`)
              return
            }
            setMemoryNote(t('memorySaved'))
            // ⚠️ 这里必须**合并**，不能整体替换。
            //
            // `POST /memory` 的应答只有 `{ok, bytes, text}`，而 `GET /memory`
            // 给的是 `{text, bytes, capBytes, auto, file}` —— 两个形状不一样。
            // 原先写的是 `setMemory(r)`：保存一次之后 `memory.file` /
            // `memory.capBytes` 就变成 undefined，诊断区那行"记忆文件"
            // 会退化成 `— · N / 0 字节`（用户看到的是"文件不见了"）。
            if (r !== null && r !== undefined) {
              setMemory(prev => ({ ...(prev ?? {}), ...r }))
            }
            // 让编辑框重建，显示"已保存的那一份"（与 `key` 里的 nonce 配套）。
            setMemoryNonce(n => n + 1)
          })
          .catch(e => setMemoryNote(`保存失败：${e?.message ?? e}`))
          .finally(() => setMemoryBusy(false))
      }

      /**
       * 启动/停止合成服务进程（"常驻"开关的手动入口）。
       *
       * 为什么要手动入口：常驻决定"要不要一直占着显存"，
       * 用户应该能**立刻**要它起来或释放，而不是等空闲超时。
       */
      const controlService = action => {
        const fn = runtime.controlTtsService
        if (typeof fn !== 'function') {
          setSpeakNote('服务控制不可用（宿主未装配）')
          return
        }
        setSpeakBusy(true)
        setSpeakNote(null)
        Promise.resolve(fn(action))
          .then(r => {
            if (r === null || r === undefined) { setSpeakNote('无响应'); return }
            if (action === 'stop') {
              setSpeakNote(r.stopped === true ? t('svcStopOk') : (r.note ?? t('svcStopNone')))
            } else {
              setSpeakNote(r.ok === true
                ? `${t('svcStartOk')}${r.backend ? ` · ${r.backend}` : ''}`
                : `${t('svcStartFail')}：${r.reason ?? 'unknown'}`)
            }
            if (r.service !== undefined || r.ready !== undefined) {
              Promise.resolve(runtime.loadSpeechStatus?.()).then(v => { if (v) setSpeakStatus(v) }).catch(() => {})
            }
          })
          .catch(e => setSpeakNote(`服务操作异常：${e?.message ?? e}`))
          .finally(() => setSpeakBusy(false))
      }

      /**
       * 探测合成服务（子插件）是否在跑，并试合成一句。
       *
       * 为什么必须有这个按钮：子插件是**独立进程**，用户看不出它到底起没起。
       * 而"开了开关却没声音"是最难自查的状态 —— 探测把原因直接写出来
       *（连不上 / 超时 / 合成失败），比让用户猜强得多。
       */
      const probeTts = () => {
        const fn = runtime.probeTts
        if (typeof fn !== 'function') {
          setSpeakNote('探测不可用（宿主未装配）')
          return
        }
        setSpeakBusy(true)
        setSpeakNote(null)
        Promise.resolve(fn())
          .then(r => {
            if (r === null || r === undefined) { setSpeakNote('探测失败（无响应）'); return }
            if (r.ok === true) {
              setSpeakNote(`${t('speakOk')}：${r.backend ?? '?'}` +
                (r.elapsedMs != null ? ` · ${r.elapsedMs} ms` : '') +
                (r.played === true ? ` · ${t('speakPlayed')}` : ''))
            } else {
              setSpeakNote(`${t('speakFail')}：${r.reason ?? 'unknown'}`)
            }
            if (r.status !== undefined) setSpeakStatus(r.status)
          })
          .catch(e => setSpeakNote(`探测异常：${e?.message ?? e}`))
          .finally(() => setSpeakBusy(false))
      }

      const sendChatMessage = () => {        const text = chatDraftRef.current
        if (typeof text !== 'string' || text.trim() === '') return
        const fn = runtime.sendChat
        if (typeof fn !== 'function') {
          setChatNote('聊天不可用（宿主未装配）')
          return
        }
        setChatBusy(true)
        setChatNote(null)
        Promise.resolve(fn(text))
          .then(() => {
            chatDraftRef.current = ''
            // 清空后必须**重建**输入框（它非受控，光改 ref 不会动 DOM）——
            // 否则用户看到自己刚发出去的字还留在框里。
            setDraftNonce(n => n + 1)
            setChatNote(t('chatSent'))
          })
          .catch(e => setChatNote(`发送失败：${e?.message ?? e}`))
          .finally(() => {
            setChatBusy(false)
            // 刷一次状态（会话 id / 计数会变）
            if (typeof runtime.loadChatStatus === 'function') {
              Promise.resolve(runtime.loadChatStatus()).then(setChatStatus).catch(() => {})
            }
          })
      }

      // 首次挂载时拉三份数据（语音包信息 / 人设列表 / 聊天状态）。
      // **失败一律忽略**：拉不到只是界面少一行信息，不该让设置页报错。
      useEffect(() => {
        let alive = true
        if (typeof runtime.loadVoiceInfo === 'function') {
          Promise.resolve(runtime.loadVoiceInfo()).then(v => { if (alive) setVoiceInfo(v) }).catch(() => {})
        }
        if (typeof runtime.loadPersonas === 'function') {
          Promise.resolve(runtime.loadPersonas()).then(v => { if (alive) setPersonas(v) }).catch(() => {})
        }
        if (typeof runtime.loadChatStatus === 'function') {
          Promise.resolve(runtime.loadChatStatus()).then(v => { if (alive) setChatStatus(v) }).catch(() => {})
        }
        if (typeof runtime.loadSpeechStatus === 'function') {
          Promise.resolve(runtime.loadSpeechStatus()).then(v => { if (alive) setSpeakStatus(v) }).catch(() => {})
        }
        if (typeof runtime.loadMemory === 'function') {
          Promise.resolve(runtime.loadMemory())
            .then(v => {
              if (!alive || v === null || v === undefined) return
              setMemory(v)
              // 草稿只在**首次加载**时同步；之后用户可能正在编辑，别覆盖他的输入。
              if (memoryDraftRef.current === '') memoryDraftRef.current = v.text ?? ''
              // ⭐ 必须让编辑框重建一次，否则屏幕上还是首帧那个空白框。
              setMemoryNonce(n => n + 1)
            })
            .catch(() => {})
        }
        return () => { alive = false }
      }, [runtime])

      const coverage = atlas?.report ?? null
      const missingCount = coverage?.missingCount ?? 0

      /* ── 页签装配 ────────────────────────────────────────────────────────
       *
       * `card(tabId, props, children)` 只在装配期给卡片贴一个"属于哪一页"的
       * 标签，`Card` 自己**不读**它。
       *
       * 为什么用 `{ tab, node }` 包一层，而不是给元素塞个 prop：
       * React 的元素 props 在开发构建里是 **Object.freeze 过的**，
       * 往 `node.props` 上写值会直接抛错 —— 桩里看不出来，真机上必炸。
       * ──────────────────────────────────────────────────────────────── */
      const card = (tabId, props, children) => ({ tab: tabId, node: h(Card, props, children) })

      /**
       * 页签与页序。
       *
       * 为什么是这七页（v10 加了「今天」）：按**用户找东西的心智**切，
       * 不按代码结构切 —— 一页 = 一类问题（她长什么样 / 她怎么冒泡 /
       * 她什么时候活跃 / 她怎么说话 / 她记住什么 / **今天做了多少** /
       * 出问题了看哪里）。
       * 默认配置下每页展开的行数都 ≤ 10，一屏放得下。
       *
       * ⚠️「今天」放在「聊天」之后、**「诊断」之前**：它是"回顾"，
       * 不是"配置"。放到设置类页签中间会打断"调完这个调那个"的动线。
       */
      const tabItems = [
        { id: 'appearance', label: t('tabAppearance') },
        { id: 'bubble', label: t('tabBubble') },
        { id: 'behavior', label: t('tabBehavior') },
        { id: 'voice', label: t('tabVoice') },
        { id: 'chat', label: t('tabChat') },
        { id: 'today', label: t('tabToday') },
        { id: 'diag', label: t('tabDiag') }
      ]

      /* ── v10：「今天」页签用的小工具 ────────────────────────────────────
       *
       * 数据全部来自快照的 `today` 块（**只读**）。这里只做**展示格式化**，
       * 不做任何判定 —— 计数、连续天数、里程碑全在宿主判定（唯一真相）。
       *
       * ⚠️ `today` 块可能**整块缺失**（旧宿主 / 插件刚启动还没广播）：
       * 所以一律 `?? 0` / `?? []`，绝不直接取属性 —— 那会抛
       * `Cannot read properties of undefined`，而设置页整片崩掉是本项目
       * 出过的最严重事故（见 client.js 顶部的说明）。 */
      const today = (snapshot !== null && typeof snapshot === 'object' && snapshot.today !== null &&
        typeof snapshot.today === 'object') ? snapshot.today : {}

      /** 一次都没跑过番茄钟 → 显示一句引导而不是四个 0。 */
      const todayIsEmpty = () => {
        const c = Number(today.pomodoroCount ?? 0)
        const s = Number(today.streakDays ?? 0)
        const i = Number(today.interrupts ?? 0)
        return !(c > 0 || s > 0 || i > 0)
      }

      /**
       * 时长格式化：`25 分` / `1 小时 5 分` / `0 分`。
       *
       * ⚠️ 与 exe 的 `PetTodayInfo.FormatDuration` **同一口径**（不足一分钟
       * 显示"1 分"而不是"0 分"）：显示 0 分而番茄数 +1，用户会以为统计坏了。
       * 两处各写一套的风险是"菜单显示 25 分、面板显示 0 分" —— 所以两边的
       * 边界都写成了同一条判据（有值但不足一分钟 → 1 分）。
       */
      const formatFocus = ms => {
        const n = Number(ms ?? 0)
        if (!Number.isFinite(n) || n <= 0) return '0 ' + t('minutes')
        const totalMin = Math.floor(n / 60000)
        if (totalMin <= 0) return '1 ' + t('minutes')
        const h = Math.floor(totalMin / 60)
        const m = totalMin % 60
        if (h <= 0) return m + ' ' + t('minutes')
        if (m <= 0) return h + ' ' + t('hours')
        return h + ' ' + t('hours') + ' ' + m + ' ' + t('minutes')
      }

      /** 目标进度百分比（夹到 0..100 —— 超额完成不该把进度条撑出容器）。 */
      const goalPercent = () => {
        const goal = Number(today.goalCount ?? 0)
        const done = Number(today.pomodoroCount ?? 0)
        if (!Number.isFinite(goal) || goal <= 0) return 0
        const pct = Math.round((done / goal) * 100)
        return Math.min(100, Math.max(0, pct))
      }

      /** 迷你柱状图的高度：按最近 7 天里最多的那天归一化。 */
      const sparkHeight = count => {
        const list = Array.isArray(today.recent) ? today.recent : []
        let max = 0
        for (const d of list) {
          const c = Number(d?.count ?? 0)
          if (Number.isFinite(c) && c > max) max = c
        }
        const c = Number(count ?? 0)
        if (max <= 0) return '2%'          // 全 0 时留一条底线，否则柱子完全看不见
        const pct = Math.round((c / max) * 100)
        return Math.max(2, Math.min(100, pct)) + '%'
      }

      /**
       * 已达成里程碑的名字（宿主给的是 key，中英由这里的字典映射）。
       *
       * ⚠️ 认不出的 key **原样显示**，不隐藏：里程碑是宿主加的，客户端
       * 字典可能还没跟上 —— 隐藏会让"我明明达成了却看不到"，
       * 而原样显示至少能看出"有个东西达成了"。
       */
      const milestoneKeys = () => {
        const ms = (snapshot !== null && typeof snapshot === 'object' &&
          snapshot.growth !== null && typeof snapshot.growth === 'object')
          ? snapshot.growth.milestone
          : null
        if (ms === null || typeof ms !== 'object' || typeof ms.key !== 'string') return []
        const label = ms.label !== null && typeof ms.label === 'object'
          ? (ms.label[locale] ?? ms.label.zh ?? ms.key)
          : ms.key
        return [label]
      }

      /** 「今天」页签里的一个数字块。 */
      const todayStat = (label, value) => h('div', { key: label, className: 'zf-pet-stat' }, [
        h('b', { key: 'v', className: 'zf-pet-stat__v' }, value),
        h('span', { key: 'l', className: 'zf-pet-stat__l' }, label)
      ])

      const panels = [
        /* ── ① 外观：她是谁、长多大、在哪儿 ──────────────────────────────── */
        card('appearance', {
          key: 'gPet',
          title: t('groupPet'),
          open: true,
          noteLabel: t('noteLabel'),
          note: t('notePet')
        }, [
          h(Toggle, {
            key: 'enabled',
            label: t('enabled'),
            value: settings.enabled,
            onChange: v => set({ enabled: v })
          }),
          h(Row, {
            key: 'mode',
            label: t('mode'),
            // 选中项的解释随选择变化 —— 用户不该靠猜"这两种有什么区别"。
            desc: settings.mode === 'overlay' ? t('modeOverlayHint') : t('modeNativeHint'),
            control: h('select', {
              key: 's',
              className: 'zf-pet-row__input',
              value: settings.mode,
              onChange: e => set({ mode: e.target.value })
            }, [
              h('option', { key: 'native', value: 'native' }, t('modeNative')),
              h('option', { key: 'overlay', value: 'overlay' }, t('modeOverlay'))
            ])
          }),
          h(Slider, {
            key: 'scale',
            label: t('scale'),
            value: settings.scale,
            min: 0.5,
            max: 2,
            step: 0.1,
            suffix: '×',
            onChange: v => set({ scale: v })
          }),
          h(Slider, {
            key: 'opacity',
            label: t('opacity'),
            value: settings.opacity,
            min: 0.3,
            max: 1,
            step: 0.05,
            suffix: '',
            onChange: v => set({ opacity: v })
          }),
          h(Toggle, {
            key: 'topmost',
            label: t('topmost'),
            value: settings.topmost,
            onChange: v => set({ topmost: v })
          }),
          h(Toggle, {
            key: 'clickThrough',
            label: t('clickThrough'),
            hint: t('clickThroughHint'),
            value: settings.clickThrough,
            onChange: v => set({ clickThrough: v })
          }),
          // 主题并进这张卡片：单独给它一张卡（一行 + 一个卡片头 ≈ 100px）
          // 是纯浪费 —— 它本来就是"桌宠长什么样"的一部分。
          h(Row, {
            key: 'theme',
            label: t('theme'),
            control: h('select', {
              key: 's',
              className: 'zf-pet-row__input',
              value: settings.theme,
              onChange: e => set({ theme: e.target.value })
            }, [
              h('option', { key: 'auto', value: 'auto' }, t('themeAuto')),
              h('option', { key: 'light', value: 'light' }, t('themeLight')),
              h('option', { key: 'dark', value: 'dark' }, t('themeDark'))
            ])
          }),
          h('div', { key: 'posBtns', className: 'zf-pet-settings__btns' }, [
            h('button', {
              key: 'reset',
              className: 'zf-pet-settings__btn',
              onClick: () => runtime.requestResetPosition?.()
            }, t('reset'))
          ])
        ]),

        /* 状态文字单独成卡：它跟"她多大"是两件事 —— 用户把桌宠调小是为了
         * 不占地，而状态文字是给人读的，跟着一起缩就本末倒置
         *（实测 0.4× 时字号被下限夹到 8px，确实看不清）。 */
        card('appearance', { key: 'gStatusText', title: t('groupStatusText'), open: true }, [
          h(Toggle, {
            key: 'hint',
            label: t('hint'),
            value: settings.hint,
            onChange: v => set({ hint: v })
          }),
          h(Toggle, {
            key: 'statusAlways',
            label: t('statusAlways'),
            hint: t('statusAlwaysHint'),
            value: settings.statusAlways,
            onChange: v => set({ statusAlways: v })
          }),
          h(Slider, {
            key: 'statusFontScale',
            label: t('statusFontScale'),
            hint: t('statusFontScaleHint'),
            value: settings.statusFontScale ?? 1,
            min: 0.5,
            max: 3,
            step: 0.1,
            suffix: '×',
            onChange: v => set({ statusFontScale: v })
          })
        ]),

        /* ── ② 气泡：她怎么"说话"（不说话的那一半）────────────────────── */
        card('bubble', {
          key: 'gBubble',
          title: t('groupBubble'),
          open: true,
          noteLabel: t('noteLabel'),
          note: t('noteBubble')
        }, [
          h(Toggle, {
            key: 'bubble',
            label: t('bubble'),
            value: settings.bubble,
            onChange: v => set({ bubble: v })
          }),
          h(Toggle, {
            key: 'bubbleImages',
            label: t('bubbleImages'),
            value: settings.bubbleImages,
            onChange: v => set({ bubbleImages: v })
          }),
          h(Slider, {
            key: 'bubbleMs',
            label: t('bubbleMs'),
            value: Math.round(settings.bubbleMs / 1000),
            min: 1,
            max: 20,
            step: 1,
            suffix: t('unitSec'),
            onChange: v => set({ bubbleMs: v * 1000 })
          }),
          h(Slider, {
            key: 'bubbleGapMs',
            label: t('bubbleGapMs'),
            value: Math.round(settings.bubbleGapMs / 1000),
            min: 0,
            max: 60,
            step: 1,
            suffix: t('unitSec'),
            hint: t('bubbleGapHint'),
            onChange: v => set({ bubbleGapMs: v * 1000 })
          }),
          // ⭐ 对话正文字号（用户点名"你对话里面的文字大小也需要可调呀"）。
          // 与「大小」（桌宠本体）分开：桌宠小、正文照样清楚。
          h(Slider, {
            key: 'chatFontScale',
            label: t('chatFontScale'),
            hint: t('chatFontScaleHint'),
            value: settings.chatFontScale ?? 1,
            min: 0.5,
            max: 3,
            step: 0.1,
            suffix: '×',
            onChange: v => set({ chatFontScale: v })
          })
        ]),

        card('bubble', { key: 'gReminder', title: t('groupReminder'), open: true }, [
          h(Toggle, {
            key: 'notifyComplete',
            label: t('notifyComplete'),
            hint: t('notifyCompleteHint'),
            value: settings.notifyComplete,
            onChange: v => set({ notifyComplete: v })
          }),
          h(Toggle, {
            key: 'attentionReminder',
            label: t('attentionReminder'),
            hint: t('attentionReminderHint'),
            value: settings.attentionReminder,
            onChange: v => set({ attentionReminder: v })
          }),
          h(Row, {
            key: 'doubleClick',
            label: t('doubleClick'),
            control: h('select', {
              key: 's',
              className: 'zf-pet-row__input',
              value: settings.doubleClick,
              onChange: e => set({ doubleClick: e.target.value })
            }, [
              h('option', { key: 'focus-dsh', value: 'focus-dsh' }, t('doubleClickFocus')),
              h('option', { key: 'emote', value: 'emote' }, t('doubleClickEmote')),
              h('option', { key: 'none', value: 'none' }, t('doubleClickNone'))
            ])
          })
        ]),

        /* ── ③ 行为：她什么时候活跃 ────────────────────────────────────── */
        card('behavior', { key: 'gActivity', title: t('groupActivity'), open: true }, [
          h(Row, {
            key: 'activity',
            label: t('activity'),
            control: h('select', {
              key: 's',
              className: 'zf-pet-row__input',
              value: settings.activity,
              onChange: e => set({ activity: e.target.value })
            }, [
              h('option', { key: 'quiet', value: 'quiet' }, t('activityQuiet')),
              h('option', { key: 'normal', value: 'normal' }, t('activityNormal')),
              h('option', { key: 'playful', value: 'playful' }, t('activityPlayful'))
            ])
          }),
          h(Slider, {
            key: 'happyMs',
            label: t('happyMs'),
            value: Math.round(settings.happyMs / 1000),
            min: 1,
            max: 30,
            step: 1,
            suffix: t('unitSec'),
            onChange: v => set({ happyMs: v * 1000 })
          }),
          h(Slider, {
            key: 'sleepMs',
            label: t('sleepMs'),
            value: Math.round(settings.sleepMs / 60000),
            min: 1,
            max: 60,
            step: 1,
            suffix: t('unitMin'),
            onChange: v => set({ sleepMs: v * 60000 })
          })
        ]),

        /* ── ③b 手势互动（v10）───────────────────────────────────────────
         *
         * 用户原话："互动当前方式，通过右键就点个按钮，很奇怪，能不能加一些
         * 更有意思的"。这一组就是那几个"手上的动作"的开关。
         *
         * 为什么放在「行为」页而不是新开一页：它们描述的是"她怎么被碰"，
         * 与"她什么时候活跃"是同一类问题（互动性）。单开一页会多出一个
         * 只有 3 行的页签，而页签本身也是有成本的（每多一个都要点一次）。
         *
         * 位置在「活跃度」**之后**：那一张是这一页的主卡（"她什么时候活跃"
         * 是这一页存在的理由），手势是它的补充。 */
        card('behavior', { key: 'gGesture', title: t('groupGesture'), open: true, lead: t('gestureLead'),
          noteLabel: t('noteLabel'), note: t('noteGesture') }, [
          h(Toggle, {
            key: 'longPress',
            label: t('longPress'),
            hint: t('longPressHint'),
            value: settings.longPress,
            onChange: v => set({ longPress: v })
          }),
          h(Toggle, {
            key: 'flingEnabled',
            label: t('flingEnabled'),
            hint: t('flingEnabledHint'),
            value: settings.flingEnabled,
            onChange: v => set({ flingEnabled: v })
          }),
          h(Toggle, {
            key: 'hoverReact',
            label: t('hoverReact'),
            hint: t('hoverReactHint'),
            value: settings.hoverReact,
            onChange: v => set({ hoverReact: v })
          }),
          // v13：手势灵敏度。放在三个开关**之后** —— 它是一个"调参"，
          // 而开关是"要不要这个功能"；用户报"手势触发不了"时，
          // 前面的开关都开着、只有这一项要往上调。
          h(Slider, {
            key: 'gestureSensitivity',
            label: t('gestureSensitivity'),
            hint: t('gestureSensitivityHint'),
            value: settings.gestureSensitivity ?? 1,
            min: 1,
            max: 3,
            step: 0.1,
            suffix: '×',
            onChange: v => set({ gestureSensitivity: v })
          }),
          // v13.6：手势调试模式（面包屑日志）。
          // 用户："手势的目前触发判定还是很奇怪。能不能加入类似可选的开关，
          // 就是比如说开启调试模式，用面包屑记录更详细的日志"。
          // 放在灵敏度**之后**：灵敏度是"让它能触发"，调试日志是"触发不了时怎么看"。
          h(Toggle, {
            key: 'debugGestures',
            label: t('debugGestures'),
            hint: t('debugGesturesHint'),
            value: settings.debugGestures,
            onChange: v => set({ debugGestures: v })
          }),
          h('div', { key: 'debugGesturesNote', className: 'zf-pet-settings__note' },
            t('debugGesturesNote')),
          // v10：手势提示只有**一次**（10 秒气泡），很容易错过 ——
          // 而"错过之后再也看不到"正是用户报的那个问题。所以给一个
          // 随时能再要一次的入口（托盘里也有一份）。
          h('div', { key: 'gestureHintBtns', className: 'zf-pet-settings__btns' }, [
            h('button', {
              key: 'hint',
              className: 'zf-pet-settings__btn',
              onClick: () => {
                const fn = runtime.sendCommand
                if (typeof fn !== 'function') return
                Promise.resolve(fn('gesture-hint'))
                  .then(r => setChatNote(r?.result?.shown === true
                    ? '手势提示已发出（看桌宠的气泡）'
                    : '没能发出 —— 桌面窗口没在运行？'))
                  .catch(e => setChatNote(`手势提示失败：${e?.message ?? e}`))
              }
            }, t('gestureHintBtn'))
          ]),
          h('p', { key: 'gestureHintNote', className: 'zf-pet-settings__note' }, t('gestureHintNote'))
        ]),

        /* 番茄钟：默认关 → 整张卡片收起（8 个控件不该占着主面板）。 */
        card('behavior', {
          key: 'gPomodoro',
          title: t('groupPomodoro'),
          open: settings.pomodoro === true
        }, [
          h(Toggle, {
            key: 'pomodoro',
            label: t('pomodoro'),
            hint: t('pomodoroHint'),
            value: settings.pomodoro,
            onChange: v => set({ pomodoro: v })
          }),
          // 时长只在启用后渲染：默认关着的时候摆一堆滑杆是噪音。
          settings.pomodoro
            ? h('div', { key: 'pomoControls' }, [
                // v10：节奏预设放**时长滑杆之前** —— 它是"一次套用一组值"，
                // 放在后面会让人以为"先调时长再选预设"（顺序是反的）。
                h(Row, {
                  key: 'pomodoroPreset',
                  label: t('pomodoroPreset'),
                  desc: t('pomodoroPresetHint'),
                  control: h('select', {
                    key: 's',
                    className: 'zf-pet-row__input',
                    value: PET_POMODORO_PRESETS.includes(settings.pomodoroPreset)
                      ? settings.pomodoroPreset
                      : 'custom',
                    onChange: e => {
                      const v = e.target.value
                      const preset = PET_POMODORO_PRESET_VALUES[v]
                      // `custom` 不在表里 → 只改标记，不动时长（用户手改过的那组值）。
                      if (preset === undefined) set({ pomodoroPreset: 'custom' })
                      else set({ pomodoroPreset: v, ...preset })
                    }
                  }, [
                    ...PET_POMODORO_PRESETS.map(id => h('option', { key: id, value: id }, t('preset' + id[0].toUpperCase() + id.slice(1)))),
                    // `custom` 只在**当前就是**自定义时才出现 —— 否则下拉里会
                    // 永远挂着一个用户选不了也取消不掉的项。
                    PET_POMODORO_PRESETS.includes(settings.pomodoroPreset)
                      ? null
                      : h('option', { key: 'custom', value: 'custom' }, t('presetCustom'))
                  ])
                }),
                h(Slider, {
                  key: 'pomodoroFocusMs',
                  label: t('pomodoroFocusMs'),
                  value: Math.round(settings.pomodoroFocusMs / 60000),
                  min: 1,
                  max: 240,
                  step: 1,
                  suffix: t('minutes'),
                  // 手改时长 → 预设标成"自定义"（否则下拉显示 deep、实际跑 30 分钟）。
                  onChange: v => set({ pomodoroFocusMs: v * 60000, pomodoroPreset: 'custom' })
                }),
                h(Slider, {
                  key: 'pomodoroBreakMs',
                  label: t('pomodoroBreakMs'),
                  value: Math.round(settings.pomodoroBreakMs / 60000),
                  min: 1,
                  max: 60,
                  step: 1,
                  suffix: t('minutes'),
                  onChange: v => set({ pomodoroBreakMs: v * 60000, pomodoroPreset: 'custom' })
                }),
                h(Slider, {
                  key: 'pomodoroLongBreakMs',
                  label: t('pomodoroLongBreakMs'),
                  value: Math.round(settings.pomodoroLongBreakMs / 60000),
                  min: 1,
                  max: 120,
                  step: 1,
                  suffix: t('minutes'),
                  onChange: v => set({ pomodoroLongBreakMs: v * 60000, pomodoroPreset: 'custom' })
                }),
                h(Slider, {
                  key: 'pomodoroRounds',
                  label: t('pomodoroRounds'),
                  value: settings.pomodoroRounds,
                  min: 2,
                  max: 12,
                  step: 1,
                  suffix: t('rounds'),
                  hint: t('pomodoroRoundsHint'),
                  onChange: v => set({ pomodoroRounds: v, pomodoroPreset: 'custom' })
                }),
                h(Toggle, {
                  key: 'pomodoroAutoNext',
                  label: t('pomodoroAutoNext'),
                  hint: t('pomodoroAutoNextHint'),
                  value: settings.pomodoroAutoNext,
                  onChange: v => set({ pomodoroAutoNext: v })
                }),
                h(Toggle, {
                  key: 'pomodoroNotify',
                  label: t('pomodoroNotify'),
                  hint: t('pomodoroNotifyHint'),
                  value: settings.pomodoroNotify,
                  onChange: v => set({ pomodoroNotify: v })
                }),
                h(Toggle, {
                  key: 'pomodoroCountdown',
                  label: t('pomodoroCountdown'),
                  value: settings.pomodoroCountdown,
                  onChange: v => set({ pomodoroCountdown: v })
                }),
                h(Toggle, {
                  key: 'pomodoroBreath',
                  label: t('pomodoroBreath'),
                  hint: t('pomodoroBreathHint'),
                  value: settings.pomodoroBreath,
                  onChange: v => set({ pomodoroBreath: v })
                }),
                // 开始/暂停按钮：设置页也能控制（桌宠不在手边时用得上）。
                h('div', { key: 'pomoBtns', className: 'zf-pet-settings__btns' }, [
                  h('button', {
                    key: 'toggle',
                    className: 'zf-pet-settings__btn',
                    onClick: () => pomodoroAction(snapshot?.pomodoro?.running === true ? 'pause' : 'start')
                  }, snapshot?.pomodoro?.running === true ? t('pomodoroPause') : t('pomodoroStart')),
                  h('button', {
                    key: 'skip',
                    className: 'zf-pet-settings__btn',
                    onClick: () => pomodoroAction('skip')
                  }, t('pomodoroSkip')),
                  h('button', {
                    key: 'reset',
                    className: 'zf-pet-settings__btn',
                    onClick: () => pomodoroAction('reset')
                  }, t('pomodoroReset'))
                ]),
                snapshot?.pomodoro?.show === true
                  ? h('p', { key: 'pomoNow', className: 'zf-pet-settings__note' },
                      `${snapshot.pomodoro.text ?? ''} · 第 ${snapshot.pomodoro.round ?? 1}/${snapshot.pomodoro.roundsPerLongBreak ?? 4} 轮`)
                  : null
              ])
            : null
        ]),

        /* ── ④ 语音：固定台词包 + 念出回答 ───────────────────────────────
         *
         * 原先"语音"组只有 1 个开关 + 台词清单，而真正的语音设置
         *（合成地址/字数/常驻/空闲释放）埋在"聊天"组里 —— 因为历史上先有
         * 固定语音包、后有动态语音，功能长在了不同组里。对用户来说这就是
         * "语音"，两件事该在同一页。 */
        card('voice', {
          key: 'gVoiceLines',
          title: t('groupVoiceLines'),
          // 台词清单是**只读清单**（现在 130+ 条），默认收起 —— 它不是要调的东西。
          open: false
        }, [
          h(Toggle, {
            key: 'voice',
            label: t('voice'),
            hint: t('voiceHint'),
            value: settings.voice,
            onChange: v => set({ voice: v })
          }),
          h('p', { key: 'voiceInfo', className: 'zf-pet-settings__note' },
            `${t('voiceCount')}：${voiceInfo === null
              ? t('voiceCountHint')
              : `${voiceInfo.count ?? 0} 条 / ${Math.round((voiceInfo.totalMs ?? 0) / 1000)}s`}`),
          // 台词一览：用户有权知道"她都会说什么" —— 不看清单就只能靠撞。
          (voiceInfo?.lines?.length ?? 0) === 0
            ? null
            : h('details', { key: 'voiceLines', className: 'zf-pet-details' }, [
                h('summary', { key: 's' }, `${t('voiceLines')}（${voiceInfo.lines.length}）`),
                h('ul', { key: 'ul', className: 'zf-pet-list' },
                  voiceInfo.lines.map(l => h('li', { key: l.name },
                    `${l.event ?? '—'} · ${l.text ?? l.name}` +
                    (l.source === 'synth' ? `（${t('voiceSynth')}）` : ''))))
              ])
        ]),

        card('voice', {
          key: 'gSpeak',
          title: t('speakTitle'),
          open: true,
          noteLabel: t('noteLabel'),
          note: t('noteSpeak')
        }, [
          h(Toggle, {
            key: 'speakReplies',
            label: t('speakReplies'),
            hint: t('speakRepliesHint'),
            value: settings.speakReplies,
            onChange: v => set({ speakReplies: v })
          }),
          h(Row, {
            key: 'ttsUrl',
            label: t('ttsUrl'),
            control: h('input', {
              key: 'i',
              className: 'zf-pet-row__input',
              type: 'text',
              defaultValue: settings.ttsUrl ?? '',
              spellCheck: false,
              placeholder: 'http://127.0.0.1:8765',
              onBlur: e => set({ ttsUrl: e.target.value.trim() })
            })
          }),
          h(Row, {
            key: 'speechMax',
            label: t('speechMaxChars'),
            control: h('input', {
              key: 'i',
              className: 'zf-pet-row__input',
              type: 'number',
              min: 10,
              max: 300,
              defaultValue: String(settings.speechMaxChars ?? 60),
              onBlur: e => set({ speechMaxChars: Number(e.target.value) })
            })
          }),
          // 常驻开关：合成要加载模型（CUDA 下更慢），加载完长期占显存。
          // 所以"常驻 vs 用完释放"必须让用户选 —— 代价写在卡片的「说明」里。
          h(Toggle, {
            key: 'ttsResident',
            label: t('ttsResident'),
            value: settings.ttsResident,
            onChange: v => set({ ttsResident: v })
          }),
          // 非常驻时：多久释放 + **怎么**释放（杀进程全释放 / 只卸模型）
          settings.ttsResident
            ? null
            : h(Row, {
                key: 'idleAction',
                label: t('ttsIdleAction'),
                desc: t('ttsIdleActionHint'),
                control: h('select', {
                  key: 's',
                  className: 'zf-pet-row__input',
                  value: settings.ttsIdleAction ?? '',
                  onChange: e => set({ ttsIdleAction: e.target.value })
                }, [
                  h('option', { key: 'd', value: '' }, t('ttsIdleActionDefault')),
                  h('option', { key: 'u', value: 'unload' }, t('ttsIdleActionUnload')),
                  h('option', { key: 'k', value: 'stop' }, t('ttsIdleActionStop'))
                ])
              }),
          settings.ttsResident
            ? null
            : h(Row, {
                key: 'idleStop',
                label: t('ttsIdleStopSec'),
                control: h('input', {
                  key: 'i',
                  className: 'zf-pet-row__input',
                  type: 'number',
                  min: 0,
                  max: 86400,
                  defaultValue: String(settings.ttsIdleStopSec ?? 300),
                  onBlur: e => set({ ttsIdleStopSec: Number(e.target.value) })
                })
              }),
          h('div', { key: 'speakBtns', className: 'zf-pet-settings__btns' }, [
            h('button', {
              key: 'probe',
              className: 'zf-pet-settings__btn',
              disabled: speakBusy,
              onClick: () => probeTts()
            }, speakBusy ? t('speakProbing') : t('speakProbe')),
            h('button', {
              key: 'svcUp',
              className: 'zf-pet-settings__btn',
              disabled: speakBusy,
              onClick: () => controlService('start')
            }, t('svcStart')),
            h('button', {
              key: 'svcDown',
              className: 'zf-pet-settings__btn',
              disabled: speakBusy,
              onClick: () => controlService('stop')
            }, t('svcStop'))
          ]),
          speakNote === null
            ? null
            : h('p', { key: 'speakNote', className: 'zf-pet-settings__note' }, speakNote)
        ]),

        /* ── ⑤ 对话：人设、共享背景、长期记忆、发消息 ───────────────────── */
        card('chat', { key: 'gChat', title: t('groupChat'), open: true }, [
          h(Toggle, {
            key: 'chatEnabled',
            label: t('chatEnabled'),
            hint: t('chatEnabledHint'),
            value: settings.chatEnabled,
            onChange: v => set({ chatEnabled: v })
          }),
          h(Row, {
            key: 'persona',
            label: t('persona'),
            desc: t('personaHint'),
            control: h('select', {
              key: 's',
              className: 'zf-pet-row__input',
              value: settings.persona,
              onChange: e => selectPersona(e.target.value)
            }, (personas?.items ?? [{ name: 'default', title: '默认（内置）' }]).map(p =>
              h('option', { key: p.name, value: p.name }, p.title ?? p.name)))
          }),
          h('div', { key: 'personaBtns', className: 'zf-pet-settings__btns' }, [
            h('button', {
              key: 'reload',
              className: 'zf-pet-settings__btn',
              onClick: () => reloadPersonas()
            }, t('personaReload'))
          ]),
          // 共享背景（人设的"底座"）：用户点名"基于通用的世界观提示词加上不同的
          // 语言风格"、"可以在设置中共享"。所以把"底座"显式列出来 ——
          // 用户才知道世界观写在哪儿、改哪里。
          h('details', { key: 'shared', className: 'zf-pet-details' }, [
            h('summary', { key: 's' }, t('sharedTitle')),
            h('p', { key: 'hint', className: 'zf-pet-settings__note' }, t('sharedHint')),
            (personas?.shared?.items?.length ?? 0) === 0
              ? h('p', { key: 'empty', className: 'zf-pet-settings__note' }, t('sharedEmpty'))
              : h('ul', { key: 'list', className: 'zf-pet-list' },
                  (personas?.shared?.items ?? []).map(it => h('li', { key: it.name },
                    `${it.name}.md · ${it.bytes} ${t('memoryBytes')}` +
                    (it.preview ? ` — ${it.preview}` : '')))),
            (personas?.shared?.items?.length ?? 0) === 0
              ? null
              : h('p', { key: 'used', className: 'zf-pet-settings__note' },
                  `${t('sharedUsed')} ${personas?.shared?.used ?? 0} ${t('sharedFiles')}`)
          ])
        ]),

        card('chat', {
          key: 'gMemory',
          title: t('memoryTitle'),
          open: true,
          lead: t('memoryHint')
        }, [
          h(Toggle, {
            key: 'memoryAuto',
            label: t('memoryAuto'),
            hint: t('memoryAutoHint'),
            value: settings.memoryAuto,
            onChange: v => set({ memoryAuto: v })
          }),
          h('textarea', {
            key: `memBox-${memoryNonce}`,
            className: 'zf-pet-memobox',
            placeholder: t('memoryEmpty'),
            spellCheck: false,
            // **非受控**（defaultValue + onInput）：受控 textarea 每敲一个字都会
            // 重渲染整个设置页（人设/语音/聊天都在同一棵树里），打字会卡。
            //
            // ⚠️ `key` 里必须带 `memoryNonce`。原先 `key` 是写死的 `'memBox'`，
            // 而注释却声称"key 带上字节数" —— 注释与代码不一致，代价是**数据丢失**：
            //
            //   ① 首帧渲染时 `memory` 还是 null → `defaultValue` 是空串；
            //   ② 挂载后 `loadMemory()` 回来，`memory` 有内容了，但 **key 没变**，
            //      React 不会重建元素 → 屏幕上仍是**空白框**（实测确认）；
            //   ③ 用户在空白框里敲一个字再点「保存记忆」→ 发出的是
            //      `{"text":"那一个字"}`，**把真实记忆整个覆盖掉**。
            //
            // 现在 `memoryNonce` 只在两个安全时机自增：首次加载完成、保存成功。
            //
            // ⚠️ `memoryDraftRef.current || …` 这一层是**页签**带来的新要求：
            // 切到别的页签会把这张卡片整个卸载，切回来时 textarea 会按
            // `defaultValue` 重建 —— 若只看 `memory?.text`，用户打了一半的草稿
            // 就被"已保存的那一份"覆盖了（ref 挂在 Section 上，活得比卡片久）。
            defaultValue: memoryDraftRef.current || memory?.text || '',
            onInput: e => { memoryDraftRef.current = e.target.value }
          }),
          h('div', { key: 'memBtns', className: 'zf-pet-settings__btns' }, [
            h('button', {
              key: 'save',
              className: 'zf-pet-settings__btn',
              disabled: memoryBusy,
              onClick: () => saveMemory()
            }, memoryBusy ? t('memorySaving') : t('memorySave'))
          ]),
          memoryNote === null
            ? null
            : h('p', { key: 'memNote', className: 'zf-pet-settings__note' }, memoryNote)
        ]),

        // 发消息：桌宠本体上也有入口（悬停出现的 ✎），设置页这里是"它不在手边"
        // 时的备用通道 —— 所以默认收起，不占位置。
        card('chat', { key: 'gSend', title: t('groupSendMessage'), open: false }, [
          h(Row, {
            key: 'chatWs',
            label: t('chatWorkspace'),
            control: h('input', {
              key: 'i',
              className: 'zf-pet-row__input',
              type: 'text',
              value: settings.chatWorkspace,
              placeholder: t('chatWorkspaceHint'),
              onChange: e => set({ chatWorkspace: e.target.value })
            })
          }),
          h('div', { key: 'chatRow', className: 'zf-pet-chatrow' }, [
            h('input', {
              // ⚠️ `key` 带 `draftNonce`：发完消息后 ref 被清空，但输入框是
              // **非受控**的，不重建元素的话已发出的文字会留在框里。
              // 见 `chatDraftRef` 上面那段注释（这里原来还有个给 const
              // 赋值的 bug，导致一个字都发不出去）。
              key: `msg-${draftNonce}`,
              className: 'zf-pet-row__input zf-pet-chatrow__input',
              type: 'text',
              // 同上：切页签会重建这个输入框，草稿存在 ref 里，别丢。
              defaultValue: chatDraftRef.current,
              placeholder: t('chatPlaceholder'),
              disabled: chatBusy,
              onInput: e => { chatDraftRef.current = e.target.value },
              onKeyDown: e => {
                if (e.key === 'Enter' && !chatBusy) sendChatMessage()
              }
            }),
            h('button', {
              key: 'send',
              className: 'zf-pet-settings__btn',
              disabled: chatBusy,
              onClick: () => sendChatMessage()
            }, chatBusy ? t('chatSending') : t('chatSend'))
          ]),
          chatNote === null
            ? null
            : h('p', { key: 'chatNote', className: 'zf-pet-settings__note' }, chatNote),
          h('p', { key: 'chatReplyNote', className: 'zf-pet-settings__note' }, t('chatReplyNote'))
        ]),

        /* ── ⑥ 今天：番茄钟统计 + 这一轮做什么（v10）─────────────────────
         *
         * 为什么单独一页而不是塞进「番茄钟」页：那一页是**设置**（调时长、
         * 开关），这一页是**记录**（今天做了多少）。混在一起的话，用户想
         * "看看今天怎么样"要在滑杆和开关里找数字。
         *
         * 位置放在「聊天」之后、「诊断」之前：它是"回顾"，不是"配置"。
         * 全部数据来自快照的 `today` 块（**只读展示**，绝不在这里算 ——
         * 判定与记账的唯一真相在宿主）。 */
        card('today', {
          key: 'gToday',
          title: t('groupToday'),
          open: true,
          // 一次都没跑过番茄钟时给一句引导，而不是四个 0（四个 0 只是噪音）。
          lead: todayIsEmpty() ? t('todayEmpty') : null
        }, [
          // 四个数字：番茄 / 时长 / 摸鱼 / 连续天数
          h('div', { key: 'stats', className: 'zf-pet-stats' }, [
            todayStat(t('todayCount'), String(today.pomodoroCount ?? 0) + t('todayUnit')),
            todayStat(t('todayFocus'), formatFocus(today.focusMs ?? 0)),
            todayStat(t('todayInterrupts'), String(today.interrupts ?? 0) + t('todayTimes')),
            todayStat(t('todayStreak'), String(today.streakDays ?? 0) + t('todayDays'))
          ]),
          // 目标进度条：只在设了目标时出现（0 = 不设目标，见设置里的说明）。
          (today.goalCount ?? 0) > 0
            ? h('div', { key: 'goal', className: 'zf-pet-goal' }, [
                h('div', { key: 'bar', className: 'zf-pet-goal__bar' }, [
                  h('i', {
                    key: 'fill',
                    className: 'zf-pet-goal__fill',
                    style: { width: goalPercent() + '%' }
                  })
                ]),
                h('span', { key: 'txt', className: 'zf-pet-goal__txt' },
                  `${t('todayGoal')} ${today.pomodoroCount ?? 0}/${today.goalCount}`)
              ])
            : null,
          // 这一轮做什么：绑定任务名（POST /pet/pomodoro {action:'set-task'}）
          h(Row, {
            key: 'task',
            label: t('pomodoroTask'),
            desc: t('pomodoroTaskHint'),
            control: h('input', {
              key: 'i',
              className: 'zf-pet-row__input',
              type: 'text',
              placeholder: t('pomodoroTaskPlaceholder'),
              maxLength: 24,
              // 非受控 + `defaultValue`：与记忆框/聊天输入框同一条纪律
              //（切页签会卸载卡片，受控值要靠外部 ref 才不丢草稿 ——
              //  而这里只是"起个名字"，丢了也不心疼，所以用最简单的写法）。
              defaultValue: snapshot?.pomodoro?.task ?? '',
              onKeyDown: e => {
                if (e.key !== 'Enter') return
                // 失焦一下让用户看到"已经提交了"（输入框没有别的反馈）
                try { e.target.blur() } catch { /* 忽略 */ }
                pomodoroAction('set-task', { task: e.target.value ?? '' })
              }
            })
          }),
          h('p', { key: 'taskNote', className: 'zf-pet-settings__note' }, t('taskNote')),
          // 时间花在哪：按任务聚合（宿主已按耗时降序排好，这里不再排一次）
          h('p', { key: 'byTaskTitle', className: 'zf-pet-settings__note' }, t('todayByTask')),
          (today.byTask ?? []).length === 0
            ? h('p', { key: 'byTaskEmpty', className: 'zf-pet-settings__note' }, t('todayByTaskEmpty'))
            : h('ul', { key: 'byTask', className: 'zf-pet-tasklist' },
                (today.byTask ?? []).map(it => h('li', { key: it.task || '∅' },
                  `${it.task === '' ? t('taskUnnamed') : it.task} · ${formatFocus(it.ms)}`))),
          // 最近 7 天：一行一个迷你条（不做图表库 —— 7 个数字画柱子足够）
          h('p', { key: 'recentTitle', className: 'zf-pet-settings__note' }, t('todayRecent')),
          h('div', { key: 'recent', className: 'zf-pet-spark' },
            (today.recent ?? []).map(d => h('span', {
              key: d.dayKey,
              className: 'zf-pet-spark__bar',
              title: `${d.dayKey} · ${d.count} 个`,
              // 高度按"7 天里最多的那天"归一化；全 0 时给 2% 保证看得见一条底线。
              style: { height: sparkHeight(d.count) }
            }))),
          // 里程碑：已达成的列出来（没有就说没有，不留空白）
          h('p', { key: 'msTitle', className: 'zf-pet-settings__note' }, t('todayMilestone')),
          milestoneKeys().length === 0
            ? h('p', { key: 'msEmpty', className: 'zf-pet-settings__note' }, t('todayMilestoneEmpty'))
            : h('p', { key: 'ms', className: 'zf-pet-settings__note' }, milestoneKeys().join(' · '))
        ]),

        /* ── ⑦ 诊断：**整页默认全部收起** ────────────────────────────────
         *
         * 这里放的全是"出问题时才需要看"的东西：服务状态、**启动命令（机器
         * 路径）**、素材覆盖、会话 id、目录路径。原先它们以 24 条同权重的说明
         * 段落散在正文里，其中一整行是绝对路径 —— 把真正要调的东西淹了。
         * 折叠而不是删除：排障时它们是关键信息，藏起来但别丢掉。 */
        card('diag', {
          key: 'gRuntime',
          title: t('groupStatus'),
          open: false,
          lead: t('advancedHint')
        }, [
          // 桌宠是否真的浮在桌面上（第一眼要能判断）
          h('div', { key: 'status', className: 'zf-pet-status' }, [
            h('span', {
              key: 'dot',
              className: 'zf-pet-status__dot',
              'data-zf-native': snapshot?.nativeAvailable === true ? 'on' : 'off'
            }),
            h('span', { key: 'txt' }, snapshot?.nativeAvailable === true ? t('nativeOn') : t('nativeOff'))
          ]),
          snapshot?.nativeAvailable === true
            ? null
            : h('p', { key: 'fallback', className: 'zf-pet-settings__note' }, t('fallbackNote')),
          snapshot?.nativeError === null || snapshot?.nativeError === undefined
            ? null
            : h(Diag, { key: 'reason', k: t('reason'), v: snapshot.nativeError })
        ]),

        card('diag', { key: 'gAssets', title: t('diagAssets'), open: false }, [
          coverage === null
            ? null
            : h(Diag, {
                key: 'cov',
                k: t('diagAssets'),
                v: `${coverage.coveredStates?.length ?? 0}/${(coverage.coveredStates?.length ?? 0) + (coverage.uncoveredStates?.length ?? 0)} ` +
                  `${t('diagStates')} · ${coverage.bubbleCount ?? 0} ${t('diagBubbles')}` +
                  (missingCount > 0 ? ` · ${missingCount} ${t('diagMissing')}` : '')
              })
        ]),

        card('diag', { key: 'gTtsService', title: t('svcState'), open: false }, [
          // 合成服务（谁在管、pid、后端、最近一次错误）
          speakStatus?.service === undefined || speakStatus.service === null
            ? h(Diag, { key: 'svc', k: t('svcState'), v: t('svcUnknown') })
            : h(Diag, {
                key: 'svc',
                k: t('svcState'),
                v: (speakStatus.service.ready
                  ? (speakStatus.service.ours ? t('svcOurs') : t('svcExternal'))
                  : t('svcDown')) +
                  // 谁在管进程（装了语音 DSH 插件 vs 桌宠自己起）—— 排查时要能分清
                  (speakStatus.service.mode === 'plugin' ? ` · ${t('svcByPlugin')}` : '') +
                  (speakStatus.service.backend ? ` · ${speakStatus.service.backend}` : '') +
                  (speakStatus.service.pid ? ` · pid ${speakStatus.service.pid}` : '') +
                  (speakStatus.service.resident ? ` · ${t('svcResidentOn')}` : '') +
                  (speakStatus.service.lastError ? ` · ⚠ ${speakStatus.service.lastError}` : '')
              }),
          // 启动命令解析结果：用户能看到桌宠**到底会执行什么**
          //（自动探测猜错时，一眼就能看出该改哪个配置）。机器路径归插件 loader
          // 配置管，面板只**只读展示**，不提供编辑控件。
          speakStatus?.launch === undefined || speakStatus.launch === null
            ? null
            : h(Diag, {
                key: 'svcLaunch',
                k: t('svcLaunch'),
                mono: true,
                v: (speakStatus.launch.argv ?? []).join(' ')
              }),
          speakStatus === null
            ? null
            : h(Diag, {
                key: 'speakStatus',
                k: t('speakStatus'),
                v: `${speakStatus.enabled ? t('on') : t('off')} · ${speakStatus.url ?? '—'} · ` +
                  `${t('speakCached')} ${speakStatus.cached ?? 0}`
              })
        ]),

        card('diag', { key: 'gPaths', title: t('groupPaths'), open: false }, [
          h(Diag, { key: 'personaDir', k: t('personaDir'), mono: true, v: personas?.dir ?? '—' }),
          h(Diag, { key: 'sharedDir', k: t('sharedDir'), mono: true, v: personas?.shared?.dir ?? '—' }),
          h(Diag, {
            key: 'memFile',
            k: t('memoryFile'),
            mono: true,
            v: `${memory?.file ?? '—'}` +
              (memory === null ? '' : ` · ${memory.bytes ?? 0} / ${memory.capBytes ?? 0} ${t('memoryBytes')}`)
          }),
          h(Diag, {
            key: 'chatState',
            k: t('chatStatus'),
            mono: true,
            v: chatStatus === null
              ? t('chatNoSession')
              : `${chatStatus.sessionId ?? t('chatNoSession')} · ` +
                `${t('chatSentCount')} ${chatStatus.sentCount ?? 0} / ${t('chatReplyCount')} ${chatStatus.replyCount ?? 0}`
          }),
          // ⭐ 工作区归属：用户反馈过"归类在未分类"，所以把归属**显示出来** ——
          // 修没修好他自己一眼能看到，不用去翻工作区列表。
          chatStatus === null
            ? null
            : h(Diag, {
                key: 'chatWsInfo',
                k: t('chatWsLabel'),
                v: chatStatus.workspaceId
                  ? `${t('chatWsOk')}：${chatStatus.workspaceTitle ?? chatStatus.workspaceId}`
                  : t('chatWsNone')
              })
        ])
      ]

      return h('div', { className: 'zf-pet-settings' }, [
        h('h2', { key: 'title', className: 'zf-pet-settings__title' }, t('title')),
        h('p', { key: 'intro', className: 'zf-pet-settings__intro' }, t('subtitle')),
        h(Tabs, { key: 'tabs', items: tabItems, value: tab, onSelect: setTab }),
        /* 只渲染当前页签的卡片 —— 这是"太长、要滚三屏"的直接解药。
         * 面板上也标好 ARIA 关系，读屏能跟着走。 */
        h('div', {
          key: 'panel',
          className: 'zf-pet-panel',
          id: `zf-pet-panel-${tab}`,
          role: 'tabpanel',
          'aria-labelledby': `zf-pet-tab-${tab}`
        }, panels.filter(p => p.tab === tab).map(p => p.node))
      ])
    }

    /* ------------------------------------------------------------------ *
     * 样式（唯一来源；原生窗口用不到它）
     * ------------------------------------------------------------------ */

    /**
     * ⚠️ 下面这个返回值是**模板字符串**（反引号），所以 CSS 注释里
     * **绝不能出现反引号** —— 一个 `` ` `` 就会提前结束字符串，
     * 报出来的是 `SyntaxError: Unexpected identifier`，指向的是注释内容
     * 而不是"这里有个反引号"，很容易看错地方。
     *
     * 这个坑踩过**两次**（都在给设置页加注释时）。要强调某个 CSS 属性名，
     * 直接写 `border-l2` 那样的裸词或用「」，别用反引号。
     */
    function styleText () {
      return `
/* 桌宠容器：**必须 fixed**（overlay 被 grid 挤到隐式第 2 行，absolute 会偏一屏）。
   容器只包住宠物本身，绝不 inset:0 —— overlay 的直接子元素被外壳自动开了
   pointer-events:auto，铺满会挡住整个界面。 */
.zf-pet{
  position:fixed;
  z-index:30;                 /* overlay 层是 20；官方菜单栏 1100，别去盖 */
  display:flex;align-items:flex-end;gap:8px;
  pointer-events:auto;
  touch-action:none;          /* 拖动时不要触发浏览器手势 */
  cursor:grab;
  user-select:none;
  will-change:left,top;
}
.zf-pet[data-zf-pet-dragging="1"]{ cursor:grabbing; }

/* 裁剪视口：宽度 = **单帧宽**，overflow:hidden 裁掉条带里其余帧。
   没有它的话，浏览器会把整条 33 帧的带子铺开成一条巨长的横条。 */
.zf-pet__view{
  position:relative;
  overflow:hidden;
  flex:0 0 auto;
}

/* 精灵条带：整条带作为一张图放进视口，靠 steps() 逐帧左移。
   位移用 translateX(-100%) 是对的 —— 百分比相对**元素自身**宽度（= frames×帧宽），
   配合 steps(frames) 恰好覆盖 N 帧。 */
.zf-pet__sprite{
  position:absolute;
  top:0;left:0;
  display:block;
  max-width:none;             /* 关键：否则会被视口的宽度约束压扁 */
  image-rendering:auto;
  animation-name:zf-pet-play;
  animation-iteration-count:infinite;
  animation-fill-mode:both;
  animation-timing-function:steps(1,end);
  pointer-events:none;
  filter:drop-shadow(0 6px 14px rgba(0,0,0,.28));
}
@keyframes zf-pet-play{
  from{ transform:translateX(0); }
  to{ transform:translateX(-100%); }
}

/* 气泡：贴在本体右侧，不参与拖动命中测试之外的事。 */
.zf-pet__bubble{
  /* ⭐ 贴在本体**左上角**（与原生窗同一规则，见 PetBubble.ComputeBubbleTarget）：
     气泡右下角对着本体左上角，像对话框的尾巴指向角色 ——
     不再压在头顶遮住角色的头（用户明确要求）。
     用绝对定位 + 负偏移，避免影响 flex 流里的精灵尺寸。 */
  position:absolute;
  right:100%;                 /* 气泡右边缘贴本体左边缘 */
  bottom:75%;                 /* 气泡底边略高于本体顶边 */
  margin-right:6px;           /* 与本体留缝，不糊在一起 */
  z-index:1;
  max-width:220px;
  padding:7px 10px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-1, #fff);
  color:var(--dsw-alias-label-primary, #222);
  border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  box-shadow:0 6px 18px rgba(0,0,0,.18);
  font-size:12px;line-height:1.4;
  display:flex;align-items:center;gap:7px;
  pointer-events:none;
  animation:zf-pet-bubble-in .16s ease-out;
}
.zf-pet__bubble-img{ width:34px;height:34px;object-fit:contain;flex:0 0 auto; }
.zf-pet__bubble-text{ white-space:pre-wrap;word-break:break-word; }

/* ── 不透明满幅贴纸（契约 §4 的 opaque 字段）──────────────────────────
 * 这类图**自带白底/黑底、铺满整图**（黑白线稿贴纸）。它们本身已经是「一张卡片」，
 * 若再套气泡的底色/边框/内边距，就会出现「一张纸贴在另一个浅色框里」的双层边框。
 * 所以：不画底、不加边框/内边距，只留投影；圆角贴在图片自己身上。
 * ──────────────────────────────────────────────────────────────────── */
.zf-pet__bubble--opaque{
  background:transparent;
  border:none;
  padding:0;
  gap:0;
  overflow:hidden;
}
.zf-pet__bubble--opaque .zf-pet__bubble-img{
  /* 贴纸本身就是整句话，34px 根本读不清。放宽到 128px —— 气泡 max-width 220 之内。 */
  width:auto;max-width:128px;
  height:auto;max-height:128px;
  object-fit:contain;
  border-radius:10px;
  display:block;
}
/* ── 常亮提醒（契约 §2 attention）──────────────────────────────────────
 * 它与普通气泡的区别只有**醒目程度**，绝不能盖掉桌宠本体：
 * · 描边加粗 + 主题强调色（比普通气泡的灰边明显一档）；
 * · 轻微呼吸脉动（2.5s 一轮，只改描边/投影亮度，不做位移 —— 位移会跟拖动打架）；
 * · 徽标：两处以上待处理时显示计数，别让人只看见一个。
 * 它**不参与过期**：显隐完全由 attention 块决定（Host 已把 sticky 透传）。
 * ──────────────────────────────────────────────────────────────────── */
.zf-pet__bubble--attention{
  border:2px solid var(--dsw-alias-brand-primary, #4a7);
  font-weight:600;
  animation:zf-pet-bubble-in .16s ease-out, zf-pet-attention-pulse 2.5s ease-in-out infinite;
}
.zf-pet__bubble-badge{
  flex:0 0 auto;
  min-width:18px;height:18px;padding:0 5px;
  border-radius:9px;
  background:#d94848;color:#fff;
  font-size:11px;font-weight:700;line-height:18px;
  text-align:center;
}
@keyframes zf-pet-attention-pulse{
  0%,100%{ box-shadow:0 6px 18px rgba(0,0,0,.18); }
  50%{ box-shadow:0 6px 18px rgba(0,0,0,.18), 0 0 14px 2px var(--dsw-alias-brand-primary, #4a7); }
}
@keyframes zf-pet-bubble-in{
  from{ opacity:0; transform:translateY(4px) scale(.96); }
  to{ opacity:1; transform:none; }
}

/* 悬停提示：只在鼠标悬停时露出状态文案，平时不干扰。 */
.zf-pet__hint{
  position:absolute;left:0;bottom:-20px;
  font-size:11px;white-space:nowrap;
  color:var(--dsw-alias-label-secondary, #666);
  background:var(--dsw-alias-bg-layer-1, #fff);
  border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  border-radius:6px;padding:1px 6px;
  opacity:0;transition:opacity .12s;
  pointer-events:none;
}
.zf-pet:hover .zf-pet__hint{ opacity:1; }
/* statusAlways：桌宠下方**常显**状态（用户点名"在底下显示一下状态"）。
 * 不加投影/不换底色 —— 它是说明文字，不该比桌宠本体更抢眼。 */
.zf-pet__hint--always{ opacity:1; }

/* ── ✎ 发消息入口 ───────────────────────────────────────────────────────
 * 平时完全隐藏，只在悬停桌宠时淡入 —— 桌宠是装饰，不该常驻一个按钮抢注意力。
 * 尺寸用固定 px（不随 scale 缩放）：它是个**控件**，不是素材，
 * 跟着缩放到 0.3× 时会小到点不中。
 * ──────────────────────────────────────────────────────────────────────── */
.zf-pet__send-btn{
  position:absolute; right:-4px; top:-4px;
  width:22px;height:22px;padding:0;
  display:flex;align-items:center;justify-content:center;
  border-radius:50%;
  border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  background:var(--dsw-alias-bg-layer-1, #fff);
  color:var(--dsw-alias-label-primary, #222);
  font-size:12px;line-height:1;cursor:pointer;
  box-shadow:0 2px 6px rgba(0,0,0,.18);
  opacity:0;transition:opacity .12s;
  pointer-events:auto;
}
.zf-pet:hover .zf-pet__send-btn{ opacity:1; }
.zf-pet__send-btn:focus-visible{ opacity:1; outline:2px solid var(--dsw-alias-brand-primary); }

/* 输入条：浮在桌宠下方。必须 pointer-events:auto（气泡是 none）。 */
.zf-pet__composer{
  position:absolute; left:0; bottom:-30px;
  display:flex;align-items:center;gap:6px;
  padding:4px 6px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1, #fff);
  border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  box-shadow:0 6px 18px rgba(0,0,0,.18);
  pointer-events:auto;
}
.zf-pet__composer-target{ display:flex; align-items:center; gap:6px; margin:0 0 6px; }
.zf-pet__composer-target-label{ font-size:11px; opacity:.72; white-space:nowrap; }
.zf-pet__composer-select{
  flex:1 1 auto; min-width:0; font-size:12px; padding:3px 6px; border-radius:6px;
  border:1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.18));
  background:var(--dsw-alias-bg-elevated, #fff);
  color:inherit;
}.zf-pet__composer-input{
  width:150px;font-size:12px;
  padding:3px 6px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  background:transparent;color:var(--dsw-alias-label-primary, #222);
}
.zf-pet__composer-input:focus{ outline:none; border-color:var(--dsw-alias-brand-primary); }
.zf-pet__composer-tip{
  font-size:11px;max-width:150px;
  color:var(--dsw-alias-label-tertiary, #888);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}

/* 尊重系统的减弱动效：停在第一帧。 */
@media (prefers-reduced-motion:reduce){
  .zf-pet__sprite{ animation:none; }
  .zf-pet__bubble{ animation:none; }
}

/* ── 设置页 ───────────────────────────────────────────────────────────
 *
 * 这一块是**为"看得懂"服务的**，不是装饰。第三轮改造前实测（headless Edge
 * 拉真实渲染树，见 '.scratch/probe-settings-fullpage.mjs'）：
 *
 *   · 总高 **2556px**（面板宽 520，7 组 / 40 行 / 42 控件）—— 要滚三屏；
 *   · 每一行的说明文字**位置不固定**：Toggle 的挂 在控件下方通栏、下拉框的
 *     挤在标签与控件之间、独立的 note 又满行一段 —— 同一屏里跳三个位置；
 *   · 字号只有 11 / 12 / 13 三档，互相差 1px —— 整页一片灰，没有重点；
 *   · 输入框高 30px 圆角 6px、按钮圆角 8px、聊天框圆角 8px 配 12px 字 ——
 *     同一个面板里混了**四套控件外观**；
 *   · 42 个控件同权重平铺，没有分组容器，也没有任何导航。
 *
 * 现在对齐 **DSH 外壳自己的设置页**（把 dsh-client-ui-settings-general 与
 * -models 的样式从 app.asar 里挖出来逐条核对）：
 *
 *   · 行 = 左（标题 14px + 说明 12px 二级灰）+ 右（定宽 208px 控件列），
 *     上下内边距 14px，行间 .5px 发丝线（border-l2，外壳同款）；
 *   · 一张卡片 = 一个概念，卡片头可折叠（外壳用 settings-card-fill /
 *     -stroke + radius-xl 20px，这里照抄）；
 *   · 字号阶梯只有 **12 / 14 / 16** 三档，层级靠档位差，不靠堆字重；
 *   · 顶部六个页签，每页只渲染自己那几张卡片 —— 一屏放得下，不用滚。
 *
 * 判定标准只有一条：**用户能不能一眼找到"我该动哪个"**。
 * ──────────────────────────────────────────────────────────────────── */
.zf-pet-settings{
  /* 卡片与控件的尺度**只在这里定义一次**，别处一律引用 ——
   * 同一个面板里混四套控件外观，正是"很乱"最直接的那一半。 */
  --zf-card-fill:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, rgba(0,0,0,.02)));
  --zf-card-stroke:var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2, rgba(0,0,0,.1)));
  --zf-hairline:var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  --zf-ctl-h:32px;
  --zf-ctl-radius:var(--dsw-radius-sm, 8px);
  display:flex;flex-direction:column;gap:10px;
  /* 外壳 models 那页自己封了 720px。这里给 760px：够放"最长的标题 + 一行
   * 说明"，又不至于让标签和控件被拉到两端看不见彼此。 */
  max-width:760px;
}
.zf-pet-settings__title{ margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary); }
.zf-pet-settings__intro{ margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary); }

/* 页签。
 * 外壳的设置导航只有**一级**（settings.section，一个插件一个入口），
 * 我们没有二级 —— 40 多个控件全塞一页就是实测的 2556px 三屏。
 * 这一排就是补上的二级导航；每页只渲染自己那几张卡片。 */
.zf-pet-tabs{ display:flex;flex-wrap:wrap;gap:4px;margin:2px 0; }
.zf-pet-tab{
  height:34px;padding:0 12px;border:none;cursor:pointer;
  border-radius:var(--dsw-radius-md, 12px);
  background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:14px;line-height:34px;
}
.zf-pet-tab:hover{ background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); }
.zf-pet-tab[aria-selected="true"]{
  background:var(--dsw-alias-interactive-bg-active, rgba(0,0,0,.06));
  color:var(--dsw-alias-label-primary);font-weight:500;
}
.zf-pet-tab:focus-visible{ outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px; }
.zf-pet-panel{ display:flex;flex-direction:column;gap:12px; }

/* ── 卡片 ─────────────────────────────────────────────────────────────
 * 一个概念一张卡；卡片头可折叠（用户点名"设置里的一些内容应该可以折叠
 * 或展开"）。外观照抄外壳的 settings-models：fill + .5px stroke + radius-xl。
 * 折叠用原生 <details>，不用自己管开关状态。 */
.zf-pet-card{
  border:.5px solid var(--zf-card-stroke);
  background:var(--zf-card-fill);
  border-radius:var(--dsw-radius-xl, 20px);
  padding:0 14px;
}
.zf-pet-card__sum{
  display:flex;align-items:center;gap:8px;height:40px;cursor:pointer;
  list-style:none;font-size:14px;line-height:22px;font-weight:500;
  color:var(--dsw-alias-label-primary);
}
.zf-pet-card__sum::-webkit-details-marker{ display:none; }
/* 自绘折叠箭头：不依赖原生 marker（各浏览器样式不一）。 */
.zf-pet-card__sum::before{ content:'▾';color:var(--dsw-alias-label-tertiary);font-size:12px; }
.zf-pet-card:not([open]) > .zf-pet-card__sum::before{ content:'▸'; }
.zf-pet-card__body{ display:flex;flex-direction:column; }
/* 卡片级的说明行：一句话讲清这张卡在干什么（外壳的 .description 同款）。 */
.zf-pet-card__lead{
  margin:0 0 2px;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary);
}
/* 卡片的「说明」折叠块：放**权衡**（代价、边界、为什么默认这样）。
 * 这些原先以 2~3 行的段落直接糊在正文里，把真正要调的控件淹了。 */
.zf-pet-card__noteBox{ margin:0 0 8px; }
.zf-pet-card__noteSum{
  cursor:pointer;list-style:none;padding:4px 0 0;
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);
}
.zf-pet-card__noteSum::-webkit-details-marker{ display:none; }
.zf-pet-card__noteSum::before{ content:'▸ '; }
.zf-pet-card__noteBox[open] > .zf-pet-card__noteSum::before{ content:'▾ '; }
.zf-pet-card__note{
  margin:4px 0 0;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary);
}

/* ── 一行设置 ─────────────────────────────────────────────────────────
 * 左列：标题 14px + 说明 12px（**说明必须在左列**，见 Row 的注释）；
 * 右列：定宽 208px 的控件列（定宽是"右边缘对齐"的前提 —— 原先用 auto，
 * 每个控件右边缘取决于自身宽度，一眼扫下去是锯齿状的）。
 * 上下 12px：外壳自己用 16px，这里取 12px —— 卡片本身还有一层内边距，
 * 叠起来已经比原先的 6px 松了一倍；而实测（headless Edge，见
 * '.scratch/probe-settings-tabs.mjs'）最高的「外观」页要压进一屏 846px，
 * 14px 会超出。 */
.zf-pet-row{
  display:flex;align-items:center;justify-content:space-between;gap:24px;
  padding:12px 0;
  border-bottom:.5px solid var(--zf-hairline);
  font-size:14px;color:var(--dsw-alias-label-primary);
}
/* 卡片里最后一行不画底线：卡片自己的圆角边就是边界，多一条线反而脏。 */
.zf-pet-card__body > .zf-pet-row:last-child{ border-bottom:none; }
.zf-pet-row__main{ display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto; }
.zf-pet-row__label{ font-size:14px;line-height:20px; }
.zf-pet-row__desc{ font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary); }
.zf-pet-row__control{
  display:flex;align-items:center;justify-content:flex-end;gap:10px;
  flex:0 0 208px;min-width:0;
}

/* 滑杆与复选框没有文字，但仍让它们继承字号 —— 否则浏览器给表单控件的
 * 默认字号（13.3333px）会冒出来，量字号阶梯时凭空多出一档，看着像 bug。 */
.zf-pet-row__input{ accent-color:var(--dsw-alias-brand-primary);min-width:0;font:inherit; }
input[type=range].zf-pet-row__input{ flex:1 1 auto;width:100%; }
/* 复选框：贴控件列右边缘，与下拉/输入框的右边缘对齐。 */
input[type=checkbox].zf-pet-row__input{
  flex:0 0 auto;width:18px;height:18px;margin:0 0 0 auto;
}

/* 下拉 / 文本框 / 数字框 —— **一套规则**。
 *
 * ⚠️ 这里必须把两种输入框都收进来。历史上「合成服务地址」等 4 个控件用的是
 * zf-pet-settings__input，而那个类名**从来没有被定义过**（4 处引用、0 处
 * 规则）→ 它们是浏览器裸样式，高度/边框/圆角/背景与旁边的下拉框全不一致，
 * 这正是"看起来很乱"的一大来源。现在只剩一个类名，不可能再分叉。
 * 聊天输入框也带 zf-pet-row__input（额外那个类只负责 flex 行为）。 */
select.zf-pet-row__input,
input[type=text].zf-pet-row__input,
input[type=number].zf-pet-row__input{
  width:100%;height:var(--zf-ctl-h);box-sizing:border-box;
  padding:0 8px;border-radius:var(--zf-ctl-radius);
  border:1px solid var(--zf-hairline);
  background:var(--dsw-alias-bg-layer-1, #fff);
  color:inherit;font:inherit;font-size:14px;
}
select.zf-pet-row__input:focus-visible,
input[type=text].zf-pet-row__input:focus-visible,
input[type=number].zf-pet-row__input:focus-visible{
  outline:none;border-color:var(--dsw-alias-brand-primary);
}

/* 数值：等宽 + 固定最小宽度（右对齐），数字变化时滑杆不会左右抖。 */
.zf-pet-row__value{
  flex:0 0 auto;min-width:44px;text-align:right;
  font-family:Consolas,"Cascadia Mono",monospace;font-size:12px;
  color:var(--dsw-alias-brand-primary);
}

.zf-pet-status{ display:flex;align-items:center;gap:7px;font-size:12px;line-height:18px; }
.zf-pet-status__dot{ width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#c9a227; }
.zf-pet-status__dot[data-zf-native="on"]{ background:var(--dsw-alias-state-success-primary,#2ea043); }

/* 诊断键值行：路径/命令行用等宽并允许断行，长路径不会把面板撑破。 */
.zf-pet-diag{
  display:grid;grid-template-columns:minmax(84px,auto) 1fr;gap:8px;
  padding:8px 0;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-primary);align-items:baseline;
}
.zf-pet-diag__k{ color:var(--dsw-alias-label-secondary);white-space:nowrap; }
.zf-pet-diag__v{ word-break:break-all; }
.zf-pet-diag__v--mono{ font-family:Consolas,"Cascadia Mono",monospace; }

/* 反馈与状态（探测结果 / 保存结果 / 当前番茄钟状态 / 语音包条数）。
 * 与"说明"分开：这些是**刚才那一下怎么样了**，不是文档。 */
.zf-pet-settings__note{
  margin:4px 0 8px;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary);
}

/* 按钮也走同一套尺度（高 32px / 圆角 8px / 14px 字）。 */
.zf-pet-settings__btn{
  align-self:flex-start;margin:0;height:var(--zf-ctl-h);padding:0 12px;
  border-radius:var(--zf-ctl-radius);
  border:1px solid var(--zf-hairline);
  background:var(--dsw-alias-bg-layer-1, transparent);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer;
}
.zf-pet-settings__btn:hover{ border-color:var(--dsw-alias-brand-primary); }
.zf-pet-settings__btn:disabled{ opacity:.5;cursor:default; }
.zf-pet-settings__btns{ display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px 0; }

/* 聊天输入行：输入框占满剩余宽度，按钮不缩。 */
.zf-pet-chatrow{ display:flex;gap:6px;align-items:center;padding:8px 0; }
.zf-pet-chatrow__input{ flex:1 1 auto;min-width:0; }
.zf-pet-chatrow__input:disabled{ opacity:.6; }
.zf-pet-chatrow .zf-pet-settings__btn{ flex:0 0 auto; }

/* ── v10「今天」页签 ────────────────────────────────────────────────────
 *
 * 四个数字 + 目标进度 + 任务列表 + 7 天迷你柱。
 *
 * ⚠️ 字号只用 12/14/16 三档（设置页有断言守着这条）：
 *   数字 16（要一眼看到）、标签 12（次要）、其余 12/14。
 * 布局一律 flex + min-width:0，否则长任务名会把卡片撑破。 */
.zf-pet-stats{ display:flex;gap:10px;flex-wrap:wrap;padding:4px 0 10px; }
.zf-pet-stat{
  flex:1 1 0;min-width:88px;
  display:flex;flex-direction:column;gap:2px;
  padding:10px 12px;border-radius:var(--zf-ctl-radius);
  background:var(--zf-card-fill);
  border:1px solid var(--zf-card-stroke);
}
.zf-pet-stat__v{
  font-size:16px;line-height:24px;font-weight:600;
  color:var(--dsw-alias-label-primary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.zf-pet-stat__l{ font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary); }

/* 目标进度：细条 + 一行文字。宽度夹在容器内，超额完成不撑破。 */
.zf-pet-goal{ display:flex;align-items:center;gap:10px;padding:2px 0 10px; }
.zf-pet-goal__bar{
  flex:1 1 auto;min-width:0;height:6px;border-radius:3px;
  background:var(--zf-hairline);overflow:hidden;
}
.zf-pet-goal__fill{
  display:block;height:100%;border-radius:3px;
  background:var(--dsw-alias-brand-primary,#4c8dff);
}
.zf-pet-goal__txt{ flex:0 0 auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary); }

/* 任务耗时列表：左对齐、任务名可省略号（长名字不换行撑高卡片）。 */
.zf-pet-tasklist{ margin:0 0 8px;padding:0 0 0 18px;list-style:disc; }
.zf-pet-tasklist li{
  font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}

/* 最近 7 天迷你柱：固定高度容器 + 底部对齐，柱子按最大值归一化。
 * 高度用百分比 → 容器必须有确定高度（24px），否则百分比无从计算。 */
.zf-pet-spark{ display:flex;align-items:flex-end;gap:4px;height:24px;padding:0 0 10px; }
.zf-pet-spark__bar{
  flex:1 1 0;min-width:0;border-radius:2px;
  background:var(--dsw-alias-brand-primary,#4c8dff);opacity:.65;
}

/* 记忆编辑框：等宽 + 可纵向拖。高度压到 96px —— 它是个编辑区，
 * 不是正文，默认给太大就会把「保存」按钮顶到屏幕外。 */
.zf-pet-memobox{
  width:100%;box-sizing:border-box;min-height:96px;max-height:280px;margin:8px 0 0;
  padding:8px;border-radius:var(--zf-ctl-radius);resize:vertical;
  border:1px solid var(--zf-hairline);
  background:var(--dsw-alias-bg-layer-1, transparent);
  color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}

/* 卡片内的折叠清单（台词一览 / 共享背景）。 */
.zf-pet-details{ margin:0;font-size:12px;line-height:18px; }
.zf-pet-details summary{ cursor:pointer;color:var(--dsw-alias-label-secondary);padding:8px 0; }
.zf-pet-list{
  margin:0 0 8px;padding-left:18px;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary);
}
.zf-pet-list li{ margin:2px 0;word-break:break-all; }
`
    }

    /* ------------------------------------------------------------------ *
     * 运行时：把宿主的 SSE + 设置串起来
     * ------------------------------------------------------------------ */

    /**
     * 建运行时。
     *
     * **设计要点：运行时不做任何业务判断。** 状态、气泡、文案全部由宿主的状态机
     * 决定并推过来；这里只负责"取回来、存下来、通知订阅者"。
     * 这样原生窗口与 overlay 不可能行为分叉 —— 它们消费的是同一份快照。
     */
    function createRuntime (ctx, t) {
      const state = {
        snapshot: null,
        atlas: null,
        settings: normalizePet(null),
        source: null
      }
      const listeners = new Set()
      let es = null
      let disposed = false

      const emit = patch => {
        Object.assign(state, patch)
        for (const fn of [...listeners]) {
          try {
            fn(patch)
          } catch (error) {
            console.warn('[zhuang-fangyi-pet] 订阅者抛错（已忽略）：', error?.message ?? error)
          }
        }
      }

      /** 从宿主拉设置与清单（一次）。 */
      async function load () {
        try {
          // 桌宠有**自己**的设置端点（与主题插件各自独立一份 settings.json）。
          const res = await fetch(`${ROUTE}/settings`)
          if (res.ok) {
            const body = await res.json()
            emit({ settings: normalizePet(body?.settings) })
          }
        } catch (error) {
          console.warn('[zhuang-fangyi-pet] 读取设置失败（用默认值）：', error?.message ?? error)
        }
        await loadAtlas()
      }

      async function loadAtlas () {
        try {
          const res = await fetch(`${ROUTE}/atlas`)
          if (res.ok) emit({ atlas: await res.json() })
        } catch (error) {
          console.warn('[zhuang-fangyi-pet] 读取素材清单失败：', error?.message ?? error)
        }
      }

      /**
       * 把快照里的 `settings` **并进**本地设置状态。
       *
       * ⚠️ 这里就是"桌面端改完，设置页不跟着变"的根因。
       *
       * 改造前 `state.settings` 只有**两个**写入点：
       *   ① 挂载时 `GET /settings` 拉一次；
       *   ② 设置页自己 `updateSettings(patch)`（乐观 emit + POST）。
       * 而宿主**每一帧快照都带着 `settings`**（`exeSettings()`：scale / opacity /
       * clickThrough / topmost / bubble / doubleClick / theme / hint / statusAlways /
       * statusFontScale / chatFontScale / pomodoroCountdown / voice）——
       * 客户端拿到了却**从来不读**。于是任何"不是设置页发起"的改动都到不了界面上：
       *   · 桌面端**滚轮缩放**（exe 去抖 300ms 后 POST /pet/settings）；
       *   · 桌面端**托盘菜单**改主题 / 状态显示 / 番茄钟 / 语音 / 缩放 / 穿透 / 置顶 / 气泡；
       *   · 宿主侧对值的夹取或回落（界面显示的值与磁盘上的分叉）。
       * 用户看到的就是"我在桌面端调完，设置页还显示旧值"。
       *
       * 为什么不无脑 emit：快照**每帧**都来（状态一变就广播）。
       * 无脑 emit 会让设置页每帧重渲染一次，而且重渲染的内容"看起来没变"，
       * 排查起来极费劲 —— 逐字段浅比较（设置是平的）足够，与宿主侧
       * `#emitIfChanged()` 同一套判据。
       */
      const applySnapshotSettings = snap => {
        const incoming = snap?.settings
        if (incoming === null || typeof incoming !== 'object') return
        // 合并而不是替换：快照只带 exe 关心的子集，其余字段必须保持现状。
        const merged = normalizePet({ ...state.settings, ...incoming })
        for (const k of Object.keys(merged)) {
          if (!Object.is(merged[k], state.settings[k])) {
            emit({ settings: merged })
            return
          }
        }
      }

      /** 一帧快照 → 通知订阅者 + 把里面的设置并进来（SSE 与轮询共用一条路）。 */
      const applySnapshot = (snap, source) => {
        emit({ snapshot: snap, source })
        applySnapshotSettings(snap)
      }

      /** 订阅 SSE；失败则退化为轮询。 */
      function connect () {
        if (disposed) return
        try {
          es = new EventSource(`${ROUTE}/events`)
        } catch (error) {
          console.warn('[zhuang-fangyi-pet] 无法建立事件流，改用轮询：', error?.message ?? error)
          startPolling()
          return
        }
        es.addEventListener('hello', event => {
          try {
            applySnapshot(JSON.parse(event.data), 'sse')
          } catch { /* 坏帧忽略 */ }
        })
        es.addEventListener('state', event => {
          try {
            applySnapshot(JSON.parse(event.data), 'sse')
          } catch { /* 坏帧忽略 */ }
        })
        es.addEventListener('error', () => {
          // EventSource 自带重连；只在真的关闭时退化。
          if (es !== null && es.readyState === 2) startPolling()
        })
      }

      let pollTimer = null
      function startPolling () {
        if (pollTimer !== null || disposed) return
        const poll = async () => {
          try {
            const res = await fetch(`${ROUTE}/state`)
            if (res.ok) applySnapshot(await res.json(), 'poll')
          } catch { /* 下一轮再试 */ }
        }
        void poll()
        pollTimer = setInterval(poll, 2000)
        pollTimer.unref?.()
      }

      /**
       * 从桌宠气泡里发一条消息到会话（契约 §3 `/pet/send`）。
       *
       * **排队语义**：宿主固定用 `agent.followup`，不打断当前回合 —— 这是用户
       * 明确选的投递方式（"排队，不打断"）。这里只负责把文本送过去并如实报错。
       *
       * @param {string} text
       * @returns {Promise<void>} 失败时抛错（带可读原因），由 UI 就地展示
       */
      /**
       * 通用 `/pet/*` 请求（v3 新增）。
       *
       * 抽出来的理由：v3 加了 5 个端点（番茄钟/语音/人设/聊天），
       * 每个都手写一遍 fetch + 错误归一化会让"错误处理"有 5 个版本，
       * 早晚有一个忘了把宿主的原因带出来（502 那次就是这么丢的）。
       *
       * **同源请求**：浏览器半边靠 loopback 围栏（与 `/pet/state` 一致），
       * 不带令牌 —— EventSource 连请求头都设不了，令牌那条路对浏览器不存在。
       *
       * @param {string} method
       * @param {string} path - `/pet` 之后的路径
       * @param {object} [body]
       * @returns {Promise<object>} 失败时抛错，message 里带宿主给的原因
       */
      async function api (method, path, body) {
        let res
        try {
          res = await fetch(`${ROUTE}${path}`, {
            method,
            headers: body === undefined ? {} : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
          })
        } catch (error) {
          throw new Error(`网络错误：${error?.message ?? error}`)
        }
        let payload = null
        try { payload = await res.json() } catch { /* 非 JSON 响应 */ }
        if (!res.ok) {
          // ⚠️ **必须把宿主给的原因带出来**（`message` → `reason` → 状态码）。
          // 只显示"HTTP 502"会让用户和开发者都不知道发生了什么 —— 这个坑踩过。
          const reason = payload?.message ?? payload?.reason ?? payload?.error ?? `HTTP ${res.status}`
          throw new Error(String(reason))
        }
        return payload
      }

      async function sendMessage (text, sessionId) {
        let res
        try {
          // 指定了会话就带上（用户在选择器里选的那个）；没指定则省略字段，
          // 由 Host 挑最近活跃的 —— 省略与发空串语义不同。
          const payload = sessionId ? { text, sessionId } : { text }
          res = await fetch(`${ROUTE}/send`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          })
        } catch (error) {
          throw new Error(`网络错误：${error?.message ?? error}`)
        }
        // 失败时把宿主给的原因翻成人话 —— "503" 对用户毫无意义。
        if (!res.ok) {
          let body = null
          try { body = await res.json() } catch { /* 非 JSON 响应 */ }
          const map = {
            empty: '内容是空的',
            'too-long': '太长了（最多 2000 字）',
            'no-session': '现在没有可以发的会话',
            unavailable: '宿主没提供发消息能力',
            'send-failed': '发送被拒绝'
          }
          const key = body?.error
          const detail = body?.reason ?? body?.message
          throw new Error((map[key] ?? `发送失败（HTTP ${res.status}）`) + (detail ? `：${detail}` : ''))
        }
      }

      /** 设置改动 → 通知宿主（宿主负责落盘与转达 exe）。 */
      async function updateSettings (patch) {
        const next = normalizePet({ ...state.settings, ...patch })
        emit({ settings: next })
        try {
          // 端点是桌宠自己的，直接提交完整设置对象（宿主侧做归一化）。
          await fetch(`${ROUTE}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ settings: next })
          })
        } catch (error) {
          console.warn('[zhuang-fangyi-pet] 保存设置失败：', error?.message ?? error)
        }
      }

      /**
       * 位置回报。
       *
       * **overlay 的位置只记 localStorage，不回传宿主** —— 理由：
       *   · 它是纯前端偏好（同一台机器的窗口内位置），跨设备同步没有意义；
       *   · 原生窗口与 overlay 是两套坐标（桌面坐标 vs 视口坐标），
       *     混写到同一个 `x/y` 字段会互相覆盖，导致两个形态位置乱跳。
       * 所以 `x/y` 这两个设置字段**只属于原生窗口**，overlay 自己用 localStorage。
       */
      async function reportPosition () {
        // 有意为空：见上面的说明。
      }

      async function sendCommand (command) {
        try {
          await fetch(`${ROUTE}/command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ command })
          })
        } catch { /* 命令失败静默 */ }
      }

      return {
        get snapshot () {
          return state.snapshot
        },
        get atlas () {
          return state.atlas
        },
        get settings () {
          return state.settings
        },
        get source () {
          return state.source
        },
        t,
        subscribe (fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        /**
         * 请求把桌宠移回默认位置。
         *
         * 用事件而不是直接改状态：`Section`（设置页）与 `Pet`（桌宠本体）是两个
         * 独立挂载的组件，设置页拿不到 `Pet` 的 `setPos`。所以这里发一个信号，
         * 由 `Pet` 自己订阅并处理 —— 单向数据流，不引入共享可变状态。
         */
        requestResetPosition () {
          try {
            window.localStorage.removeItem(POS_KEY)
          } catch { /* 存储不可用 */ }
          emit({ resetPosition: (state.resetPosition ?? 0) + 1 })
        },
        load,
        updateSettings,
        reportPosition,
        sendCommand,
        sendMessage,
        // ── v3：番茄钟 / 语音 / 人设 / 聊天 ────────────────────────────────
        //
        // 全部走上面那个 `api()`，共用错误归一化与围栏处理。
        /**
         * @param {string} action
         * @param {object} [options] - `set-task` 时带 `{task}`（宿主侧有白名单与长度校验）
         */
        pomodoroAction (action, options) {
          return api('POST', '/pomodoro',
            options === undefined ? { action } : { action, ...options })
        },
        loadVoiceInfo () {
          return api('GET', '/voices')
        },
        loadPersonas () {
          return api('GET', '/personas')
        },
        /**
         * 重新扫描人设目录。
         *
         * ⚠️ 没有"reload"专用端点 —— 直接重新 GET 一次 `/personas` 就是重扫
         *（`list()` 每次都现读磁盘）。少一个端点就少一处不一致的可能。
         */
        reloadPersonas () {
          return api('GET', '/personas')
        },
        selectPersona (name) {
          return api('POST', '/personas', { name })
        },
        loadChatStatus () {
          return api('GET', '/chat')
        },
        sendChat (text) {
          return api('POST', '/chat', { text })
        },
        /** 动态语音（TTS）：状态 / 探测（试合成一句并播出来）。 */
        loadSpeechStatus () {
          return api('GET', '/speech')
        },
        probeTts () {
          return api('POST', '/speech/probe', {})
        },
        /** 合成服务进程控制（常驻开关的手动入口）。 */
        controlTtsService (action) {
          return api('POST', '/speech/service', { action })
        },
        /** 长期记忆（v3，跨会话共享）：读全文 / 整体替换。 */
        loadMemory () {
          return api('GET', '/memory')
        },
        saveMemory (text) {
          return api('POST', '/memory', { text })
        },
        connect,
        dispose () {
          disposed = true
          try {
            es?.close()
          } catch { /* 已关闭 */ }
          es = null
          if (pollTimer !== null) {
            clearInterval(pollTimer)
            pollTimer = null
          }
          listeners.clear()
        },
        __state: state
      }
    }

    /* ------------------------------------------------------------------ *
     * apply
     * ------------------------------------------------------------------ */

    /**
     * @param {object} ctx
     */
    function apply (ctx) {
      const t = makeT(ctx)
      const runtime = createRuntime(ctx, t)
      // 组件从这里取运行时（外壳不会把 runtime 当 prop 传，见 `requireRuntime()`）。
      pluginRuntime = runtime

      // 样式：自建 <style>，卸载时移除。**CSS 只有这一份来源**（原生窗口用不到它）。
      ctx.effect(() => {
        const el = document.createElement('style')
        el.id = 'zf-pet-style'
        el.textContent = styleText()
        document.head.appendChild(el)
        return () => {
          try {
            el.remove()
          } catch { /* 已移除 */ }
        }
      }, 'zhuang-fangyi-pet: styles')

      /**
       * 安全注册：任何注册失败都只警告，**绝不中断 `apply()`**。
       *
       * 这是主题插件用惨痛代价换来的教训：官方插件已在 `sidebar.brand.mark`
       * 占了 priority 0，而 `SlotCore.register` 对同 priority 重复注册**直接抛错**，
       * 一抛错整个 `apply()` 就中断，后面的功能全部没执行。
       * 一个可选装饰位的冲突，不该让整个插件瘫痪。
       */
      function safeInject (slot, meta, component) {
        try {
          return ctx.slots.inject(slot, () => ctx.slots.register(
            { name: slot, ...meta }, component))
        } catch (error) {
          console.warn(`[zhuang-fangyi-pet] 插槽 ${slot} 注册失败（已跳过）：`, error?.message ?? error)
          return null
        }
      }

      // 桌宠本体进 `shell.overlay`：加性 id，不与官方 11 个占位冲突。
      safeInject('shell.overlay', { id: OVERLAY_ID, order: 95, locale: NS }, Pet)

      // 设置页。
      safeInject('settings.section', { id: 'zhuang-fangyi-pet', order: 130, label: () => t('nav'), locale: NS }, Section)

      // 加载设置 + 素材，然后接上事件流。
      void runtime.load().then(() => runtime.connect())

      ctx.effect(() => () => runtime.dispose(), 'zhuang-fangyi-pet: runtime')
    }

    /**
     * 测试出口（与主题插件同样的做法：无头测试直接验这些纯函数）。
     *
     * **在模块作用域定义，不在 `apply()` 里** —— 这样"没装配就渲染组件"这种
     * 场景也能被测到（见 `requireRuntime()` 的说明）。`runtime` 用 getter 取，
     * 因为它要到 `apply()` 之后才存在。
     */
    exports.__test = {
      normalizePet,
      clampPos,
      readPos,
      writePos,
      POS_KEY,
      TAB_KEY,
      STATE_TEXT,
      DICT,
      OVERLAY_ID,
      ROUTE,
      get runtime () { return pluginRuntime },
      Pet,
      Section,
      styleText,
      /* v4 设置页的构件：测试要能单独展开它们核对结构（桩 React 不会自动
       * 展开函数组件，只按 `type.name` 找得到节点）。 */
      Row,
      Card,
      Tabs
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.name = 'zhuang-fangyi-pet'
    return module.exports
  }
})
