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
        modeAuto: '自动（优先桌面窗口）',
        modeNative: '只用桌面窗口',
        modeOverlay: '只用窗口内悬浮',
        scale: '大小',
        opacity: '不透明度',
        groupWindow: '窗口',
        topmost: '总在最前',
        clickThrough: '点击穿透',
        clickThroughHint: '开启后鼠标完全穿过桌宠（纯装饰）',
        groupBubble: '气泡',
        bubble: '显示气泡',
        bubbleImages: '气泡显示表情图',
        groupBehavior: '行为',
        happyMs: '完成后的开心时长',
        sleepMs: '空闲多久后睡觉',
        groupStatus: '运行状态',
        nativeOn: '桌面窗口运行中',
        nativeOff: '桌面窗口不可用',
        fallbackNote: '当前使用窗口内悬浮（只在 DSH 窗口里可见）',
        reason: '原因',
        reset: '重置位置',
        resetDone: '已重置，重新拖动即可'
      },
      en: {
        nav: 'Zhuang Fangyi Pet',
        title: 'Zhuang Fangyi Pet',
        subtitle: 'A pet that floats on your desktop · reacts to agent state',
        groupGeneral: 'General',
        enabled: 'Enable pet',
        mode: 'Display mode',
        modeAuto: 'Auto (prefer desktop window)',
        modeNative: 'Desktop window only',
        modeOverlay: 'In-window overlay only',
        scale: 'Size',
        opacity: 'Opacity',
        groupWindow: 'Window',
        topmost: 'Always on top',
        clickThrough: 'Click-through',
        clickThroughHint: 'Mouse passes fully through the pet (decoration only)',
        groupBubble: 'Bubble',
        bubble: 'Show bubbles',
        bubbleImages: 'Show expression images in bubbles',
        groupBehavior: 'Behavior',
        happyMs: 'Happy duration after done',
        sleepMs: 'Idle time before sleeping',
        groupStatus: 'Status',
        nativeOn: 'Desktop window running',
        nativeOff: 'Desktop window unavailable',
        fallbackNote: 'Using in-window overlay (visible only inside DSH)',
        reason: 'Reason',
        reset: 'Reset position',
        resetDone: 'Reset. Drag it anywhere.'
      }
    }

    /* ------------------------------------------------------------------ *
     * 小工具
     * ------------------------------------------------------------------ */

    /** 取一个 host 设置对象，缺字段时回落默认值。 */
    function normalizePet (input) {
      const base = {
        enabled: true,
        mode: 'auto',
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
        locale: 'zh'
      }
      if (input === null || typeof input !== 'object') return base
      const out = { ...base }
      if (typeof input.enabled === 'boolean') out.enabled = input.enabled
      if (['auto', 'native', 'overlay'].includes(input.mode)) out.mode = input.mode
      if (Number.isFinite(input.scale)) out.scale = Math.min(2, Math.max(0.5, input.scale))
      if (Number.isFinite(input.opacity)) out.opacity = Math.min(1, Math.max(0.3, input.opacity))
      for (const k of ['clickThrough', 'topmost', 'bubble', 'bubbleImages']) {
        if (typeof input[k] === 'boolean') out[k] = input[k]
      }
      if (Number.isFinite(input.x)) out.x = Math.round(input.x)
      if (Number.isFinite(input.y)) out.y = Math.round(input.y)
      if (Number.isFinite(input.happyMs)) out.happyMs = Math.min(600000, Math.max(100, input.happyMs))
      if (Number.isFinite(input.sleepMs)) out.sleepMs = Math.min(86400000, Math.max(10000, input.sleepMs))
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
      const { runtime } = props
      const runtimeRef = useRef(runtime)
      runtimeRef.current = runtime

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
      const bubbleImage = settings.bubbleImages && bubble?.image
        ? `${ROUTE}/art/${encodeURIComponent(bubble.image)}`
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
              className: 'zf-pet__bubble',
              'data-zf-pet-bubble-kind': bubble.kind
            }, [
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
        settings.clickThrough
          ? null
          : h('div', { key: 'hint', className: 'zf-pet__hint' }, snapshot?.label ?? '')
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
      const { runtime } = props
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
            h('option', { key: 'auto', value: 'auto' }, t('modeAuto')),
            h('option', { key: 'native', value: 'native' }, t('modeNative')),
            h('option', { key: 'overlay', value: 'overlay' }, t('modeOverlay'))
          ])
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

        h('h3', { key: 'g4', className: 'zf-pet-settings__group' }, t('groupBehavior')),
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

      // 测试出口（与主题插件同样的做法：无头测试直接验这些纯函数）。
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
        runtime,
        Pet,
        Section,
        styleText
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.name = 'zhuang-fangyi-pet'
    return module.exports
  }
})
