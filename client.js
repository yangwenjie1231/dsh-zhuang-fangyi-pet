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
        subtitle: '真的浮在桌面上的桌宠 · 表情随 agent 状态实时变化',
        groupGeneral: '常规',
        enabled: '启用桌宠',
        mode: '显示方式',
        modeNative: '桌面窗口（推荐）',
        modeNativeHint: '真的浮在桌面上。窗口内悬浮只在它不可用时作为兜底出现',
        modeOverlay: '只用窗口内悬浮（功能较少，兼容用）',
        modeOverlayHint: '仅在 DSH 窗口内显示。没有滚轮缩放/右键菜单/表情包画廊/托盘 —— 它只是兜底，不再补新功能',
        scale: '大小',
        opacity: '不透明度',
        groupWindow: '窗口',
        topmost: '总在最前',
        clickThrough: '点击穿透',
        clickThroughHint: '开启后鼠标完全穿过桌宠（纯装饰）',
        groupBubble: '气泡',
        bubble: '显示气泡',
        bubbleImages: '气泡显示表情图',
        bubbleMs: '气泡显示时长',
        bubbleGapMs: '两条气泡最小间隔',
        bubbleGapHint: '调大可减少刷屏；0 = 不限',
        notifyComplete: 'AI 完成时弹提醒',
        notifyCompleteHint: '一回合并干净结束就强制弹一条（绕过上面的间隔）',
        attentionReminder: '审批/提问常亮提醒',
        attentionReminderHint: 'AI 要授权或问你问题时，气泡一直亮着直到你处理完（不看上面的气泡时长）',
        groupBehavior: '行为',
        happyMs: '完成后的开心时长',
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
        minutes: '分钟',
        rounds: '轮',
        // ── 语音（v3）───────────────────────────────────────────────────────
        groupVoice: '语音',
        voice: '让庄方宜说话',
        voiceHint: '点击、完成、出错、番茄钟到点时播一句。默认关闭 —— 突然出声容易吓人',
        voiceCount: '语音包',
        voiceCountHint: '用 tools/build-voice.ps1 生成；缺失时静音运行',
        // ── 聊天与人设（v3）─────────────────────────────────────────────────
        groupChat: '聊天',
        chatEnabled: '允许在气泡里聊天',
        chatEnabledHint: '关闭后只在设置页这里聊',
        persona: '人设风格',
        personaHint: '语言风格。世界观与身份写在"共享背景"里，会自动拼在它前面',
        personaReload: '重新扫描人设目录',
        personaDir: '人设目录',
        personaDirHint: '把你的 .md 丢进这个目录，再点"重新扫描"',
        sharedTitle: '共享背景（所有风格共用）',
        sharedHint: '这些人设文件会拼在每种风格前面 —— 改一次，所有风格一起变',
        sharedEmpty: '还没有共享背景（当前风格是自包含的）',
        sharedUsed: '当前风格已拼接',
        sharedFiles: '份',
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
        chatWorkspaceHint: '留空 = ~/Downloads/庄方宜',
        chatOpen: '打开工作区目录',
        chatStatus: '聊天状态',
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
        reset: '重置位置',
        resetDone: '已重置，重新拖动即可',
        sendTitle: '发消息给庄方宜',
        sendPlaceholder: '说点什么…',
        sendTip: 'Enter 发送 · Esc 收起',
        sendTo: '发给',
        sending: '发送中…',
        activity: '活跃度',
        activityQuiet: '安静（只提醒要紧的事）',
        activityNormal: '正常',
        activityPlayful: '调皮（爱说话、会主动冒头）'
      },
      en: {
        nav: 'Zhuang Fangyi Pet',
        title: 'Zhuang Fangyi Pet',
        subtitle: 'A pet that floats on your desktop · reacts to agent state',
        groupGeneral: 'General',
        enabled: 'Enable pet',
        mode: 'Display mode',
        modeNative: 'Desktop window (recommended)',
        modeNativeHint: 'Truly floats on your desktop. The in-window overlay appears only as a fallback when it is unavailable',
        modeOverlay: 'In-window overlay only (fewer features, compatibility)',
        modeOverlayHint: 'Shows inside the DSH window only. No wheel zoom, right-click menu, emote gallery or tray — it is a fallback and gets no new features',
        scale: 'Size',
        opacity: 'Opacity',
        groupWindow: 'Window',
        topmost: 'Always on top',
        clickThrough: 'Click-through',
        clickThroughHint: 'Mouse passes fully through the pet (decoration only)',
        groupBubble: 'Bubble',
        bubble: 'Show bubbles',
        bubbleImages: 'Show expression images in bubbles',
        bubbleMs: 'Bubble duration',
        bubbleGapMs: 'Min gap between bubbles',
        bubbleGapHint: 'Raise it to reduce spam; 0 = unlimited',
        notifyComplete: 'Notify when AI finishes',
        notifyCompleteHint: 'Force a bubble on every clean turn end (bypasses the gap above)',
        attentionReminder: 'Sticky approval/question alert',
        attentionReminderHint: 'Keeps the bubble lit until you approve or answer (ignores the bubble duration above)',
        groupBehavior: 'Behavior',
        happyMs: 'Happy duration after done',
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
        minutes: 'min',
        rounds: 'rounds',
        // ── Voice (v3) ──────────────────────────────────────────────────────
        groupVoice: 'Voice',
        voice: 'Let her speak',
        voiceHint: 'Speaks on click, completion, errors and pomodoro phase ends. Off by default',
        voiceCount: 'Voice pack',
        voiceCountHint: 'Build it with tools/build-voice.ps1; runs silent when missing',
        // ── Chat & persona (v3) ─────────────────────────────────────────────
        groupChat: 'Chat',
        chatEnabled: 'Allow chatting from the bubble',
        chatEnabledHint: 'When off, chat only from this settings page',
        persona: 'Persona style',
        personaHint: 'Language style. World & identity live in the shared background and are prepended automatically',
        personaReload: 'Rescan persona folder',
        personaDir: 'Persona folder',
        personaDirHint: 'Drop your .md files there, then hit rescan',
        sharedTitle: 'Shared background (used by every style)',
        sharedHint: 'These files are prepended to every style — edit once, all styles change',
        sharedEmpty: 'No shared background yet (current style is self-contained)',
        sharedUsed: 'Current style composes',
        sharedFiles: 'file(s)',
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
        chatWorkspaceHint: 'Empty = ~/Downloads/庄方宜',
        chatOpen: 'Open workspace folder',
        chatStatus: 'Chat status',
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
        reset: 'Reset position',
        resetDone: 'Reset. Drag it anywhere.',
        sendTitle: 'Send a message',
        sendPlaceholder: 'Say something…',
        sendTip: 'Enter to send · Esc to close',
        sendTo: 'To',
        sending: 'Sending…',
        activity: 'Liveliness',
        activityQuiet: 'Quiet (only important notices)',
        activityNormal: 'Normal',
        activityPlayful: 'Playful (chatty, pops up on its own)'
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
        // ── 语音（v3）───────────────────────────────────────────────────────
        // **默认关**：桌宠突然开口是强打扰，用户主动打开才生效。
        voice: false,
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
      for (const k of ['clickThrough', 'topmost', 'bubble', 'bubbleImages',
        'hint', 'statusAlways', 'notifyComplete', 'attentionReminder',
        'pomodoro', 'pomodoroAutoNext', 'pomodoroNotify', 'pomodoroCountdown',
        'voice', 'chatEnabled']) {
        if (typeof input[k] === 'boolean') out[k] = input[k]
      }
      // 番茄钟时长：与 Host 的 settings.js **同范围**（三处口径必须一致：
      // Host 归一化、客户端归一化、番茄钟模块自己的 POMODORO_LIMITS）。
      const num = (v, min, max, fb) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb)
      out.pomodoroFocusMs = num(input.pomodoroFocusMs, 60000, 240 * 60000, base.pomodoroFocusMs)
      out.pomodoroBreakMs = num(input.pomodoroBreakMs, 60000, 60 * 60000, base.pomodoroBreakMs)
      out.pomodoroLongBreakMs = num(input.pomodoroLongBreakMs, 60000, 120 * 60000, base.pomodoroLongBreakMs)
      out.pomodoroRounds = num(input.pomodoroRounds, 2, 12, base.pomodoroRounds)
      if (typeof input.persona === 'string') {
        const p = input.persona.trim()
        if (p !== '' && p.length <= 64) out.persona = p
      }
      if (typeof input.chatWorkspace === 'string') {
        const w = input.chatWorkspace.trim()
        if (w === '') out.chatWorkspace = ''
        else if (w.length <= 260) out.chatWorkspace = w
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
              'data-zf-pet-bubble-kind': bubble.kind
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
              className: 'zf-pet__hint' + (settings.statusAlways ? ' zf-pet__hint--always' : '')
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
    function Toggle (props) {
      const { label, value, onChange, hint } = props
      return h('label', { className: 'zf-pet-row' }, [
        h('span', { key: 'l', className: 'zf-pet-row__label' }, label),
        h('input', {
          key: 'i',
          type: 'checkbox',
          className: 'zf-pet-row__input',
          checked: value === true,
          onChange: e => onChange(e.target.checked)
        }),
        hint === undefined ? null : h('span', { key: 'h', className: 'zf-pet-row__hint' }, hint)
      ])
    }

    /** 一个受控滑杆。 */
    function Slider (props) {
      const { label, value, min, max, step, suffix, onChange } = props
      return h('label', { className: 'zf-pet-row' }, [
        h('span', { key: 'l', className: 'zf-pet-row__label' }, label),
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
      /** 草稿用 ref 而不是 state：它每敲一个字都变，不该触发重渲染。 */
      const chatDraftRef = useRef('')
      const chatDraft = chatDraftRef.current

      /**
       * 番茄钟动作：POST /pet/pomodoro。
       *
       * 失败也要给提示 —— "点了没反应"是最糟的（用户会以为坏了）。
       */
      const pomodoroAction = action => {
        const doPost = runtime.pomodoroAction
        if (typeof doPost !== 'function') {
          setChatNote('番茄钟不可用（宿主未装配）')
          return
        }
        Promise.resolve(doPost(action))
          .then(r => { if (r !== null && r !== undefined) setChatNote(null) })
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
            setMemoryNote(t('memorySaved'))
            if (r !== null && r !== undefined) setMemory(r)
          })
          .catch(e => setMemoryNote(`保存失败：${e?.message ?? e}`))
          .finally(() => setMemoryBusy(false))
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
        if (typeof runtime.loadMemory === 'function') {
          Promise.resolve(runtime.loadMemory())
            .then(v => {
              if (!alive || v === null || v === undefined) return
              setMemory(v)
              // 草稿只在**首次加载**时同步；之后用户可能正在编辑，别覆盖他的输入。
              if (memoryDraftRef.current === '') memoryDraftRef.current = v.text ?? ''
            })
            .catch(() => {})
        }
        return () => { alive = false }
      }, [runtime])

      const coverage = atlas?.report ?? null
      const missingCount = coverage?.missingCount ?? 0

      return h('div', { className: 'zf-pet-settings' }, [
        h('p', { key: 'sub', className: 'zf-pet-settings__sub' }, t('subtitle')),

        h('h3', { key: 'g1', className: 'zf-pet-settings__group' }, t('groupGeneral')),
        h(Toggle, {
          key: 'enabled',
          label: t('enabled'),
          value: settings.enabled,
          onChange: v => set({ enabled: v })
        }),
        h('label', { key: 'mode', className: 'zf-pet-row' }, [
          h('span', { key: 'l', className: 'zf-pet-row__label' }, t('mode')),
          h('select', {
            key: 's',
            className: 'zf-pet-row__input',
            value: settings.mode,
            onChange: e => set({ mode: e.target.value })
          }, [
            h('option', { key: 'native', value: 'native' }, t('modeNative')),
            h('option', { key: 'overlay', value: 'overlay' }, t('modeOverlay'))
          ]),
          // 选中项的解释随选择变化 —— 用户不该靠猜"这两种有什么区别"。
          h('span', { key: 'h', className: 'zf-pet-row__hint' },
            settings.mode === 'overlay' ? t('modeOverlayHint') : t('modeNativeHint'))
        ]),
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

        h('h3', { key: 'g2', className: 'zf-pet-settings__group' }, t('groupWindow')),
        h(Toggle, {
          key: 'topmost',
          label: t('topmost'),
          value: settings.topmost,
          onChange: v => set({ topmost: v })
        }),
        h(Toggle, {
          key: 'clickThrough',
          label: t('clickThrough'),
          value: settings.clickThrough,
          hint: t('clickThroughHint'),
          onChange: v => set({ clickThrough: v })
        }),

        h('h3', { key: 'g3', className: 'zf-pet-settings__group' }, t('groupBubble')),
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
          suffix: 's',
          onChange: v => set({ bubbleMs: v * 1000 })
        }),
        h(Slider, {
          key: 'bubbleGapMs',
          label: t('bubbleGapMs'),
          value: Math.round(settings.bubbleGapMs / 1000),
          min: 0,
          max: 60,
          step: 1,
          suffix: 's',
          hint: t('bubbleGapHint'),
          onChange: v => set({ bubbleGapMs: v * 1000 })
        }),
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

        h('h3', { key: 'g4', className: 'zf-pet-settings__group' }, t('groupBehavior')),
        h('label', { key: 'activity', className: 'zf-pet-row' }, [
          h('span', { key: 'l', className: 'zf-pet-row__label' }, t('activity')),
          h('select', {
            key: 's',
            className: 'zf-pet-row__input',
            value: settings.activity,
            onChange: e => set({ activity: e.target.value })
          }, [
            h('option', { key: 'quiet', value: 'quiet' }, t('activityQuiet')),
            h('option', { key: 'normal', value: 'normal' }, t('activityNormal')),
            h('option', { key: 'playful', value: 'playful' }, t('activityPlayful'))
          ])
        ]),
        h(Slider, {
          key: 'happyMs',
          label: t('happyMs'),
          value: Math.round(settings.happyMs / 1000),
          min: 1,
          max: 30,
          step: 1,
          suffix: 's',
          onChange: v => set({ happyMs: v * 1000 })
        }),
        h(Slider, {
          key: 'sleepMs',
          label: t('sleepMs'),
          value: Math.round(settings.sleepMs / 60000),
          min: 1,
          max: 60,
          step: 1,
          suffix: 'min',
          onChange: v => set({ sleepMs: v * 60000 })
        }),
        h('label', { key: 'doubleClick', className: 'zf-pet-row' }, [
          h('span', { key: 'l', className: 'zf-pet-row__label' }, t('doubleClick')),
          h('select', {
            key: 's',
            className: 'zf-pet-row__input',
            value: settings.doubleClick,
            onChange: e => set({ doubleClick: e.target.value })
          }, [
            h('option', { key: 'focus-dsh', value: 'focus-dsh' }, t('doubleClickFocus')),
            h('option', { key: 'emote', value: 'emote' }, t('doubleClickEmote')),
            h('option', { key: 'none', value: 'none' }, t('doubleClickNone'))
          ])
        ]),
        h('label', { key: 'theme', className: 'zf-pet-row' }, [
          h('span', { key: 'l', className: 'zf-pet-row__label' }, t('theme')),
          h('select', {
            key: 's',
            className: 'zf-pet-row__input',
            value: settings.theme,
            onChange: e => set({ theme: e.target.value })
          }, [
            h('option', { key: 'auto', value: 'auto' }, t('themeAuto')),
            h('option', { key: 'light', value: 'light' }, t('themeLight')),
            h('option', { key: 'dark', value: 'dark' }, t('themeDark'))
          ])
        ]),
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

        h('h3', { key: 'g6', className: 'zf-pet-settings__group' }, t('groupPomodoro')),
        h(Toggle, {
          key: 'pomodoro',
          label: t('pomodoro'),
          hint: t('pomodoroHint'),
          value: settings.pomodoro,
          onChange: v => set({ pomodoro: v })
        }),
        // 时长只在启用后显示：默认关着的时候摆一堆滑块是噪音。
        settings.pomodoro
          ? h('div', { key: 'pomoControls' }, [
              h(Slider, {
                key: 'pomodoroFocusMs',
                label: t('pomodoroFocusMs'),
                value: Math.round(settings.pomodoroFocusMs / 60000),
                min: 1,
                max: 240,
                step: 1,
                suffix: t('minutes'),
                onChange: v => set({ pomodoroFocusMs: v * 60000 })
              }),
              h(Slider, {
                key: 'pomodoroBreakMs',
                label: t('pomodoroBreakMs'),
                value: Math.round(settings.pomodoroBreakMs / 60000),
                min: 1,
                max: 60,
                step: 1,
                suffix: t('minutes'),
                onChange: v => set({ pomodoroBreakMs: v * 60000 })
              }),
              h(Slider, {
                key: 'pomodoroLongBreakMs',
                label: t('pomodoroLongBreakMs'),
                value: Math.round(settings.pomodoroLongBreakMs / 60000),
                min: 1,
                max: 120,
                step: 1,
                suffix: t('minutes'),
                onChange: v => set({ pomodoroLongBreakMs: v * 60000 })
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
                onChange: v => set({ pomodoroRounds: v })
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
          : null,

        h('h3', { key: 'g7', className: 'zf-pet-settings__group' }, t('groupVoice')),
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

        h('h3', { key: 'g8', className: 'zf-pet-settings__group' }, t('groupChat')),
        h(Toggle, {
          key: 'chatEnabled',
          label: t('chatEnabled'),
          hint: t('chatEnabledHint'),
          value: settings.chatEnabled,
          onChange: v => set({ chatEnabled: v })
        }),
        h('label', { key: 'persona', className: 'zf-pet-row' }, [
          h('span', { key: 'l', className: 'zf-pet-row__label' }, t('persona')),
          h('select', {
            key: 's',
            className: 'zf-pet-row__input',
            value: settings.persona,
            onChange: e => selectPersona(e.target.value)
          }, (personas?.items ?? [{ name: 'default', title: '默认（内置）' }]).map(p =>
            h('option', { key: p.name, value: p.name }, p.title ?? p.name)))
        ]),
        h('p', { key: 'personaHint', className: 'zf-pet-settings__note' }, t('personaHint')),
        h('div', { key: 'personaBtns', className: 'zf-pet-settings__btns' }, [
          h('button', {
            key: 'reload',
            className: 'zf-pet-settings__btn',
            onClick: () => reloadPersonas()
          }, t('personaReload'))
        ]),
        h('p', { key: 'personaDir', className: 'zf-pet-settings__note' },
          `${t('personaDir')}：${personas?.dir ?? t('personaDirHint')}`),

        // ── 共享背景（加法人设的"底座"）────────────────────────────────────
        //
        // 用户点名："基于通用的世界观提示词加上不同的语言风格"、"可以在设置中共享"。
        // 所以这里把"底座"显式列出来 —— 用户才知道世界观写在哪儿、改哪里。
        h('h4', { key: 'sharedTitle', className: 'zf-pet-settings__sub' }, t('sharedTitle')),
        h('p', { key: 'sharedHint', className: 'zf-pet-settings__note' }, t('sharedHint')),
        (personas?.shared?.items?.length ?? 0) === 0
          ? h('p', { key: 'sharedEmpty', className: 'zf-pet-settings__note' }, t('sharedEmpty'))
          : h('ul', { key: 'sharedList', className: 'zf-pet-list' },
              (personas?.shared?.items ?? []).map(it => h('li', { key: it.name },
                `${it.name}.md · ${it.bytes} ${t('memoryBytes')}` +
                (it.preview ? ` — ${it.preview}` : '')))),
        (personas?.shared?.items?.length ?? 0) === 0
          ? null
          : h('p', { key: 'sharedUsed', className: 'zf-pet-settings__note' },
              `${t('sharedUsed')} ${personas?.shared?.used ?? 0} ${t('sharedFiles')}`),
        h('p', { key: 'sharedDir', className: 'zf-pet-settings__note' },
          `${t('personaDir')}：${personas?.shared?.dir ?? '—'}`),

        // ── 长期记忆（跨会话共享）──────────────────────────────────────────
        h('h4', { key: 'memTitle', className: 'zf-pet-settings__sub' }, t('memoryTitle')),
        h('p', { key: 'memHint', className: 'zf-pet-settings__note' }, t('memoryHint')),
        h(Toggle, {
          key: 'memoryAuto',
          label: t('memoryAuto'),
          hint: t('memoryAutoHint'),
          value: settings.memoryAuto,
          onChange: v => set({ memoryAuto: v })
        }),
        h('textarea', {
          key: 'memBox',
          className: 'zf-pet-memobox',
          placeholder: t('memoryEmpty'),
          spellCheck: false,
          // **非受控**（defaultValue + onInput）：受控 textarea 每敲一个字都会
          // 重渲染整个设置页（人设/语音/聊天都在同一棵树里），打字会卡。
          // `key` 带上字节数 → 外部改了记忆（比如自动提炼追加）时会重建元素，
          // 用户能看到新内容；但他正在打字时不会被打断（草稿在 ref 里）。
          defaultValue: memory?.text ?? '',
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
          : h('p', { key: 'memNote', className: 'zf-pet-settings__note' }, memoryNote),
        h('p', { key: 'memFile', className: 'zf-pet-settings__note' },
          `${t('memoryFile')}：${memory?.file ?? '—'}` +
          (memory === null ? '' : ` · ${memory.bytes ?? 0} / ${memory.capBytes ?? 0} ${t('memoryBytes')}`)),
        h('label', { key: 'chatWs', className: 'zf-pet-row' }, [
          h('span', { key: 'l', className: 'zf-pet-row__label' }, t('chatWorkspace')),
          h('input', {
            key: 'i',
            className: 'zf-pet-row__input',
            type: 'text',
            value: settings.chatWorkspace,
            placeholder: t('chatWorkspaceHint'),
            onChange: e => set({ chatWorkspace: e.target.value })
          })
        ]),
        h('div', { key: 'chatRow', className: 'zf-pet-chatrow' }, [
          h('input', {
            key: 'msg',
            className: 'zf-pet-chatrow__input',
            type: 'text',
            value: chatDraft,
            placeholder: t('chatPlaceholder'),
            disabled: chatBusy,
            onInput: e => { chatDraft = e.target.value },
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
        h('p', { key: 'chatReplyNote', className: 'zf-pet-settings__note' }, t('chatReplyNote')),
        h('p', { key: 'chatState', className: 'zf-pet-settings__note' },
          chatStatus === null
            ? t('chatNoSession')
            : `${t('chatStatus')}：${chatStatus.sessionId ?? t('chatNoSession')} · ` +
              `已发 ${chatStatus.sentCount ?? 0} / 已回 ${chatStatus.replyCount ?? 0}`),

        h('h3', { key: 'g5', className: 'zf-pet-settings__group' }, t('groupStatus')),
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
          : h('p', { key: 'reason', className: 'zf-pet-settings__note' },
              `${t('reason')}：${snapshot.nativeError}`),
        coverage === null
          ? null
          : h('p', { key: 'cov', className: 'zf-pet-settings__note' },
              `素材：${coverage.coveredStates?.length ?? 0}/${(coverage.coveredStates?.length ?? 0) + (coverage.uncoveredStates?.length ?? 0)} 个状态已覆盖，` +
              `气泡池 ${coverage.bubbleCount ?? 0} 张` +
              (missingCount > 0 ? `，${missingCount} 张待抠图` : '')),
        h('button', {
          key: 'reset',
          className: 'zf-pet-settings__btn',
          onClick: () => runtime.requestResetPosition?.()
        }, t('reset'))
      ])
    }

    /* ------------------------------------------------------------------ *
     * 样式（唯一来源；原生窗口用不到它）
     * ------------------------------------------------------------------ */

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

/* ── 设置页 ─────────────────────────────────────────────────────────── */
.zf-pet-settings{ display:flex;flex-direction:column;gap:9px; }
.zf-pet-settings__sub{ margin:0 0 4px;color:var(--dsw-alias-label-tertiary);font-size:12px; }
.zf-pet-settings__group{
  margin:12px 0 2px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--dsw-alias-label-tertiary);font-weight:600;
}
.zf-pet-row{
  display:grid;grid-template-columns:minmax(120px,1fr) auto;align-items:center;gap:10px;
  font-size:13px;color:var(--dsw-alias-label-primary);
}
.zf-pet-row__label{ min-width:0; }
.zf-pet-row__input{ accent-color:var(--dsw-alias-brand-primary); }
.zf-pet-row__value{
  font-family:Consolas,"Cascadia Mono",monospace;font-size:12px;
  color:var(--dsw-alias-brand-primary);min-width:52px;text-align:right;
}
.zf-pet-row__hint{
  grid-column:1/-1;font-size:11px;color:var(--dsw-alias-label-tertiary);
}
.zf-pet-status{ display:flex;align-items:center;gap:7px;font-size:12px; }
.zf-pet-status__dot{ width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#c9a227; }
.zf-pet-status__dot[data-zf-native="on"]{ background:var(--dsw-alias-state-success-primary,#2ea043); }
.zf-pet-settings__note{ margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary); }
.zf-pet-settings__btn{
  align-self:flex-start;margin-top:6px;padding:6px 12px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background:var(--dsw-alias-bg-layer-2, transparent);
  color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;
}
.zf-pet-settings__btn:hover{ border-color:var(--dsw-alias-brand-primary); }
.zf-pet-settings__btn:disabled{ opacity:.5;cursor:default; }
/* 按钮组（v3：番茄钟三个按钮 / 人设重扫）—— 横排，间距一致 */
.zf-pet-settings__btns{ display:flex;gap:6px;flex-wrap:wrap;margin-top:6px; }
.zf-pet-settings__btns .zf-pet-settings__btn{ margin-top:0; }
/* 聊天输入行（v3）：输入框占满剩余宽度，按钮不缩 */
.zf-pet-chatrow{ display:flex;gap:6px;align-items:center;margin-top:8px; }
.zf-pet-chatrow__input{
  flex:1 1 auto;min-width:0;padding:6px 8px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background:var(--dsw-alias-bg-layer-2, transparent);
  color:var(--dsw-alias-label-primary);font-size:12px;
}
.zf-pet-chatrow__input:disabled{ opacity:.6; }
.zf-pet-chatrow .zf-pet-settings__btn{ margin-top:0;flex:0 0 auto; }
/* 记忆编辑框（v3）：等宽 + 可纵向拖，长记忆也能看清 */
.zf-pet-memobox{
  width:100%;box-sizing:border-box;min-height:120px;max-height:280px;margin-top:6px;
  padding:8px;border-radius:8px;resize:vertical;
  border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background:var(--dsw-alias-bg-layer-2, transparent);
  color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
/* 共享背景文件列表 */
.zf-pet-list{
  margin:4px 0 0;padding-left:18px;font-size:11px;
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
            emit({ snapshot: JSON.parse(event.data), source: 'sse' })
          } catch { /* 坏帧忽略 */ }
        })
        es.addEventListener('state', event => {
          try {
            emit({ snapshot: JSON.parse(event.data), source: 'sse' })
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
            if (res.ok) emit({ snapshot: await res.json(), source: 'poll' })
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
        pomodoroAction (action) {
          return api('POST', '/pomodoro', { action })
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
      STATE_TEXT,
      DICT,
      OVERLAY_ID,
      ROUTE,
      get runtime () { return pluginRuntime },
      Pet,
      Section,
      styleText
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.name = 'zhuang-fangyi-pet'
    return module.exports
  }
})
