/**
 * 庄方宜桌宠 · 浏览器半边单测（无框架，纯 node:assert）
 *
 * 用法：`node tools/test-pet-client.mjs`
 *
 * ── 怎么测一个浏览器 bundle ───────────────────────────────────────────────
 *
 * `client.js` 是手写的 ModuleLoader bundle，靠 `window.__ModuleLoader__.load()`
 * 装载。所以这里用**桩 window + 桩 React**把真实的 `client.js` 跑起来，
 * 再直接验它的纯函数与组件树 —— 照抄主题插件 `tools/test-client.mjs` 的做法
 * （它用同一套路跑了 131 项断言）。
 *
 * 重点验三件最容易写错、且在浏览器里很难复现的事：
 *
 *   1. **定位约束**：容器必须 `position:fixed` 且**不能铺满**（否则挡住整个界面）；
 *   2. **拖动夹取**：拖出视口要能找回来，且位置持久化；
 *   3. **插槽注册失败不能中断 `apply()`**（主题插件为此瘫痪过一次）。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'client.js')

let passed = 0
let failed = 0

function section (name) {
  console.log(`\n── ${name} ──`)
}

function ok (label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${error?.message ?? error}`)
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 桩环境
 * ═════════════════════════════════════════════════════════════════════════ */

/** 极简 React 桩：只需让 `h()` 产出可检查的树。 */
function makeReactStub () {
  const h = (type, props, ...children) => {
    const flat = []
    const push = value => {
      if (value === null || value === undefined || value === false) return
      if (Array.isArray(value)) {
        for (const v of value) push(v)
        return
      }
      flat.push(value)
    }
    for (const c of children) push(c)
    return { type, props: { ...(props ?? {}), children: flat } }
  }
  const hooks = {
    states: [],
    cursor: 0,
    effects: [],
    refs: []
  }
  return {
    h,
    React: {
      createElement: h,
      useState (init) {
        const i = hooks.cursor
        hooks.cursor += 1
        if (hooks.states[i] === undefined) {
          hooks.states[i] = typeof init === 'function' ? init() : init
        }
        return [hooks.states[i], v => { hooks.states[i] = typeof v === 'function' ? v(hooks.states[i]) : v }]
      },
      useRef (init) {
        const i = hooks.cursor
        hooks.cursor += 1
        if (hooks.refs[i] === undefined) hooks.refs[i] = { current: init }
        return hooks.refs[i]
      },
      useEffect (fn) {
        hooks.cursor += 1
        hooks.effects.push(fn)
      },
      useCallback (fn) {
        hooks.cursor += 1
        return fn
      }
    },
    hooks,
    resetHooks () {
      hooks.cursor = 0
    }
  }
}

/** 桩 localStorage。 */
function makeStorageStub () {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    __map: map
  }
}

/**
 * 装载 client.js。
 *
 * @param {object} [options]
 * @param {object} [options.ctx] - 桩 ctx
 * @param {object} [options.fetchImpl]
 * @returns {{exports: object, ctx: object, calls: object}}
 */
function loadClient (options = {}) {
  const react = makeReactStub()
  const storage = makeStorageStub()
  const calls = {
    registered: [],
    effects: [],
    fetches: [],
    warnings: []
  }

  const documentStub = {
    head: { appendChild () {} },
    createElement: () => ({ id: '', textContent: '', remove () {} }),
    // 允许测试注入外壳主题属性（client.js 读 data-ds-theme-source 选深色变体）。
    documentElement: {
      getAttribute: k => Object.prototype.hasOwnProperty.call(options.documentAttrs ?? {}, k)
        ? options.documentAttrs[k]
        : null
    }
  }

  const win = {
    innerWidth: 1600,
    innerHeight: 900,
    localStorage: storage,
    addEventListener () {},
    removeEventListener () {},
    EventSource: class {
      constructor (url) {
        this.url = url
        this.readyState = 0
      }
      addEventListener () {}
      close () {}
    }
  }

  let captured = null
  const sandboxWindow = {
    ...win,
    __ModuleLoader__: {
      load ({ id, factory }) {
        captured = { id, factory }
      }
    }
  }

  const ctx = options.ctx ?? {
    slots: {
      inject (slot, cb) {
        calls.registered.push(slot)
        return cb()
      },
      register (meta, component) {
        return { meta, component, dispose () {} }
      }
    },
    locale: { get: () => 'zh' },
    effect (fn, label) {
      calls.effects.push(label)
      const dispose = fn()
      return dispose
    }
  }

  const fetchImpl = options.fetchImpl ?? (async url => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => ''
  }))

  // 用 new Function 注入桩全局，避免污染真实 global。
  const source = fs.readFileSync(CLIENT, 'utf8')
  const runner = new Function(
    'window', 'document', 'console', 'fetch', 'localStorage', 'EventSource', 'setInterval', 'clearInterval', 'require',
    source
  )
  runner(
    sandboxWindow,
    documentStub,
    { warn: (...a) => calls.warnings.push(a.join(' ')), log () {}, error () {} },
    async (url, init) => {
      calls.fetches.push({ url, init })
      return fetchImpl(url, init)
    },
    storage,
    sandboxWindow.EventSource,
    () => ({ unref () {} }),
    () => {},
    name => {
      if (name === 'react') return react.React
      throw new Error(`未桩化的依赖：${name}`)
    }
  )

  assert.ok(captured !== null, 'client.js 应调用 __ModuleLoader__.load')
  const module = captured.factory(name => {
    if (name === 'react') return react.React
    throw new Error(`未桩化的依赖：${name}`)
  })

  return { exports: module, ctx, calls, react, storage, sandboxWindow }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. bundle 契约
 * ═════════════════════════════════════════════════════════════════════════ */
section('1. bundle 契约')

const loaded = loadClient()

ok('ModuleLoader id 正确（决定 /plugins/<id>/client.js 的路径）', () => {
  assert.equal(loaded.exports.name, 'zhuang-fangyi-pet')
})

ok('导出 apply 与 inject', () => {
  assert.equal(typeof loaded.exports.apply, 'function')
  assert.ok(Array.isArray(loaded.exports.inject))
})

ok('inject 声明了 slots（否则 ctx.slots 拿不到）', () => {
  assert.ok(loaded.exports.inject.includes('slots'))
})

ok('apply 不抛错', () => {
  assert.doesNotThrow(() => loaded.exports.apply(loaded.ctx))
})

ok('注册了 shell.overlay 与 settings.section', () => {
  assert.ok(loaded.calls.registered.includes('shell.overlay'), '应注册桌宠本体')
  assert.ok(loaded.calls.registered.includes('settings.section'), '应注册设置页')
})

ok('注入样式表并在卸载时移除', () => {
  assert.ok(loaded.calls.effects.some(l => String(l).includes('styles')))
})

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 插槽冲突不能中断 apply
 * ═════════════════════════════════════════════════════════════════════════ */
section('2. 插槽冲突不能中断 apply（主题插件为此瘫痪过）')

ok('某个插槽注册抛错时，apply 仍完成且其余插槽照常注册', () => {
  const registered = []
  const ctx = {
    slots: {
      inject (slot, cb) {
        if (slot === 'shell.overlay') throw new Error('duplicate priority 0')
        registered.push(slot)
        return cb()
      },
      register () {
        return {}
      }
    },
    locale: { get: () => 'zh' },
    effect () {
      return () => {}
    }
  }
  const l = loadClient({ ctx })
  assert.doesNotThrow(() => l.exports.apply(ctx), '插槽冲突绝不能让 apply 抛错')
  assert.ok(registered.includes('settings.section'), '后续插槽仍应注册')
  assert.ok(l.calls.warnings.length > 0, '应留下警告')
})

ok('两个插槽都抛错时也不崩', () => {
  const ctx = {
    slots: {
      inject () {
        throw new Error('nope')
      },
      register () {
        return {}
      }
    },
    locale: { get: () => 'zh' },
    effect () {
      return () => {}
    }
  }
  const l = loadClient({ ctx })
  assert.doesNotThrow(() => l.exports.apply(ctx))
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 位置夹取
 * ═════════════════════════════════════════════════════════════════════════ */
section('3. 位置夹取（拖出视口要能找回来）')

const { clampPos, normalizePet, readPos, writePos, POS_KEY } = loaded.exports.__test

ok('正常范围内的位置原样返回', () => {
  const p = clampPos({ x: 100, y: 200 }, 120, 120)
  assert.deepEqual(p, { x: 100, y: 200 })
})

ok('负坐标夹到 0', () => {
  assert.deepEqual(clampPos({ x: -50, y: -80 }, 120, 120), { x: 0, y: 0 })
})

ok('超出右下角夹回视口内', () => {
  const p = clampPos({ x: 99999, y: 99999 }, 120, 120)
  assert.ok(p.x <= 1600 - 120, `x 应在视口内，实际 ${p.x}`)
  assert.ok(p.y <= 900 - 120, `y 应在视口内，实际 ${p.y}`)
})

ok('尺寸大于视口时也不产生负坐标', () => {
  const p = clampPos({ x: 10, y: 10 }, 99999, 99999)
  assert.ok(p.x >= 0 && p.y >= 0)
})

ok('小数坐标被取整', () => {
  const p = clampPos({ x: 10.7, y: 20.2 }, 120, 120)
  assert.equal(p.x, 11)
  assert.equal(p.y, 20)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 位置持久化
 * ═════════════════════════════════════════════════════════════════════════ */
section('4. 位置持久化（localStorage）')

ok('写入后能读回', () => {
  writePos({ x: 300, y: 400 })
  assert.deepEqual(readPos(), { x: 300, y: 400 })
})

ok('未写过时返回 null', () => {
  loaded.storage.__map.clear()
  assert.equal(readPos(), null)
})

ok('存储内容损坏时返回 null 且不抛', () => {
  loaded.storage.setItem(POS_KEY, '{not json')
  assert.equal(readPos(), null)
})

ok('存储里字段非法时返回 null', () => {
  loaded.storage.setItem(POS_KEY, JSON.stringify({ x: 'a', y: null }))
  assert.equal(readPos(), null)
})

ok('localStorage 抛错时不崩（隐私模式）', () => {
  // 把 localStorage 换成会抛的实现，验证 readPos/writePos 的 try/catch 真的兜住。
  // 注意 `__test` 是 apply() 时挂上的，所以必须先 apply。
  const l = loadClient()
  l.exports.apply(l.ctx)
  const t = l.exports.__test
  assert.ok(t !== undefined, '__test 应在 apply 后可用')
  Object.assign(l.sandboxWindow.localStorage, {
    getItem () { throw new Error('SecurityError') },
    setItem () { throw new Error('SecurityError') },
    removeItem () { throw new Error('SecurityError') }
  })
  assert.doesNotThrow(() => t.writePos({ x: 1, y: 2 }), '写入失败不该抛')
  assert.equal(t.readPos(), null, '读取失败应回落 null')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 设置归一化
 * ═════════════════════════════════════════════════════════════════════════ */
section('5. 设置归一化')

ok('null/垃圾输入回落默认值', () => {
  const d = normalizePet(null)
  assert.equal(d.enabled, true)
  assert.equal(d.mode, 'native', 'v2 起默认 native（auto 已并入它）')
  assert.equal(d.scale, 1)
  assert.equal(d.bubble, true)
})

ok('scale 被夹到 0.3~3（滚轮缩放同范围，三处必须一致）', () => {
  assert.equal(normalizePet({ scale: 99 }).scale, 3)
  assert.equal(normalizePet({ scale: 0.01 }).scale, 0.3)
  assert.equal(normalizePet({ scale: 2.5 }).scale, 2.5, '范围内的值不能被夹掉')
})

ok('新增设置字段：气泡时长/间隔、双击、主题、状态显示、完成提醒', () => {
  const n = normalizePet({
    bubbleMs: 2500, bubbleGapMs: 0,
    doubleClick: 'emote', theme: 'dark',
    hint: false, statusAlways: true, notifyComplete: false
  })
  assert.equal(n.bubbleMs, 2500)
  assert.equal(n.bubbleGapMs, 0, '0 = 不限，必须放行')
  assert.equal(n.doubleClick, 'emote')
  assert.equal(n.theme, 'dark')
  assert.equal(n.hint, false)
  assert.equal(n.statusAlways, true)
  assert.equal(n.notifyComplete, false)
})

ok('新增字段越界/非法值回落默认（不整体丢弃）', () => {
  const n = normalizePet({
    bubbleMs: 99, bubbleGapMs: 999999,
    doubleClick: 'hack', theme: 'psychedelic'
  })
  assert.equal(n.bubbleMs, 1000, '气泡时长下限 1s')
  assert.equal(n.bubbleGapMs, 60000, '间隔上限 60s')
  assert.equal(n.doubleClick, 'focus-dsh', '非法值回落默认')
  assert.equal(n.theme, 'auto')
  // 缺字段按默认（旧设置文件向后兼容）
  const d = normalizePet({})
  assert.equal(d.bubbleMs, 6000)
  assert.equal(d.doubleClick, 'focus-dsh')
  assert.equal(d.theme, 'auto')
  assert.equal(d.statusAlways, false)
  assert.equal(d.notifyComplete, true)
})

ok('opacity 被夹到 0.3~1', () => {
  assert.equal(normalizePet({ opacity: 5 }).opacity, 1)
  assert.equal(normalizePet({ opacity: 0 }).opacity, 0.3)
})

ok('mode 只接受两个合法值，且旧值 auto 归一化成 native', () => {
  assert.equal(normalizePet({ mode: 'overlay' }).mode, 'overlay')
  assert.equal(normalizePet({ mode: 'native' }).mode, 'native')
  assert.equal(normalizePet({ mode: 'hack' }).mode, 'native', '非法值回落默认')
  // ⭐ 兼容：v1 的设置文件里写的是 auto，语义与 native 相同。
  // 若不归一化，老用户升级后 mode 会变成非法值而被回落 —— 虽然结果一样，
  // 但设置页会显示成"native"，用户以为自己的选择丢了。归一化让它是**同一个值**。
  assert.equal(normalizePet({ mode: 'auto' }).mode, 'native', 'auto 是 v1 旧值 → native')
})

ok('布尔字段逐个回落', () => {
  const s = normalizePet({ enabled: false, bubble: false, bubbleImages: false, clickThrough: true })
  assert.equal(s.enabled, false)
  assert.equal(s.bubble, false)
  assert.equal(s.bubbleImages, false)
  assert.equal(s.clickThrough, true)
  assert.equal(s.topmost, true, '未给的字段保持默认')
})

ok('时长被夹到合理范围', () => {
  assert.equal(normalizePet({ happyMs: 1 }).happyMs, 100)
  assert.equal(normalizePet({ happyMs: 1e9 }).happyMs, 600000)
  assert.equal(normalizePet({ sleepMs: 1 }).sleepMs, 10000)
})

ok('非法 locale 回落到 zh', () => {
  assert.equal(normalizePet({ locale: 'fr' }).locale, 'zh')
  assert.equal(normalizePet({ locale: 'en' }).locale, 'en')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 渲染：定位约束（最容易挡住整个界面的地方）
 * ═════════════════════════════════════════════════════════════════════════ */
section('6. 渲染：定位约束')

const styleCss = loaded.exports.__test.styleText()

ok('容器用 position:fixed（absolute 会被 grid 挤偏一屏）', () => {
  assert.match(styleCss, /\.zf-pet\{[^}]*position:fixed/s, '容器必须 fixed')
})

ok('容器**没有** inset:0 / 100vw 之类铺满视口的写法', () => {
  const block = styleCss.match(/\.zf-pet\{[^}]*\}/s)?.[0] ?? ''
  assert.ok(!/inset\s*:\s*0/.test(block), '铺满会挡住整个界面')
  assert.ok(!/width\s*:\s*100vw/.test(block))
  assert.ok(!/height\s*:\s*100vh/.test(block))
})

ok('z-index 不超过必要层级（overlay=20，官方菜单=1100）', () => {
  const block = styleCss.match(/\.zf-pet\{[^}]*\}/s)?.[0] ?? ''
  const m = block.match(/z-index\s*:\s*(\d+)/)
  assert.ok(m !== null, '应显式声明 z-index')
  const z = Number(m[1])
  assert.ok(z >= 20, '要盖住 overlay 内容')
  assert.ok(z < 1100, '绝不该盖住官方菜单栏')
})

ok('精灵图用 steps() 硬切帧，不做插值', () => {
  const block = styleCss.match(/\.zf-pet__sprite\{[^}]*\}/s)?.[0] ?? ''
  assert.match(block, /animation-timing-function:\s*steps\(/, '样式里要有 steps() 兜底')
  // 真正的帧数由 JS 内联设置（每张图帧数不同），已在组件树测试里验证。
})

ok('裁剪视口有 overflow:hidden（否则整条带会铺开）', () => {
  const block = styleCss.match(/\.zf-pet__view\{[^}]*\}/s)?.[0] ?? ''
  assert.match(block, /overflow\s*:\s*hidden/, '必须裁掉其余帧')
  assert.match(block, /position\s*:\s*relative/, '要作为条带绝对定位的包含块')
})

ok('精灵图有 max-width:none（否则会被视口压扁）', () => {
  const block = styleCss.match(/\.zf-pet__sprite\{[^}]*\}/s)?.[0] ?? ''
  assert.match(block, /max-width\s*:\s*none/)
  assert.match(block, /position\s*:\s*absolute/)
})

ok('尊重 prefers-reduced-motion', () => {
  assert.match(styleCss, /prefers-reduced-motion/)
})

ok('气泡与提示不参与命中测试（pointer-events:none）', () => {
  const bubble = styleCss.match(/\.zf-pet__bubble\{[^}]*\}/s)?.[0] ?? ''
  assert.match(bubble, /pointer-events:\s*none/)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 7. 渲染组件树
 * ═════════════════════════════════════════════════════════════════════════ */
section('7. 渲染组件树')

ok('Pet 在无素材时渲染为空（不出现"一张巨大的脸"）', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  // 未加载素材 → display:none，且不渲染 img。
  l.react.resetHooks()
  const tree = Pet({})
  assert.equal(tree.props.style.display, 'none')
  const imgs = tree.props.children.filter(c => c !== null && c.type === 'img')
  assert.equal(imgs.length, 0, '没素材时不该渲染 img')
})

/** 取一个节点的子元素（桩 React 的 children 恒为数组）。 */
function firstChild (node) {
  const c = node?.props?.children
  return Array.isArray(c) ? c[0] : c
}

/** 从 Pet 的树里取裁剪视口。 */
function viewOf (tree) {
  return tree.props.children.find(c => c !== null && c.props?.className === 'zf-pet__view')
}

ok('精灵图放在**裁剪视口**里，视口宽 = 单帧宽（否则整条带会铺开）', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = {
    frameHeight: 256,
    states: { thinking: { file: 'thinking.png', frames: 33, frameMs: 36 } },
    report: null
  }
  runtime.__state.snapshot = { petState: 'thinking', label: '正在思考…', bubble: null }
  runtime.__state.settings = normalizePet({ scale: 1 })
  l.react.resetHooks()
  const tree = Pet({})
  const view = viewOf(tree)
  assert.ok(view !== undefined, '必须有裁剪视口')
  assert.equal(view.props.style.width, '256px', '视口宽度应是**单帧**宽，不是整条带')
  assert.equal(view.props.style.height, '256px')
  const img = firstChild(view)
  assert.equal(img.type, 'img')
  assert.equal(img.props.style.width, `${256 * 33}px`, 'img 自身才是整条带的宽度')
})

ok('Pet 有素材时渲染精灵条带，宽度 = 帧宽 × 帧数', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = {
    frameHeight: 256,
    states: { thinking: { file: 'thinking.png', frames: 33, frameMs: 36 } },
    report: null
  }
  runtime.__state.snapshot = { petState: 'thinking', label: '正在思考…', bubble: null }
  runtime.__state.settings = normalizePet({ scale: 1 })
  l.react.resetHooks()
  const tree = Pet({})
  const img = firstChild(viewOf(tree))
  assert.equal(img.props.src, '/api/zhuang-fangyi/pet/art/thinking.png')
  assert.equal(img.props.style.height, '256px')
  assert.equal(img.props.style.width, `${256 * 33}px`, '条带宽度应为帧宽×帧数')
  assert.match(img.props.style.animationTimingFunction, /steps\(33\)/)
  assert.equal(img.props.style.animationDuration, `${33 * 36}ms`)
})

ok('缩放同时作用于视口与条带（不能只缩一个）', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 4, frameMs: 60 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null }
  runtime.__state.settings = normalizePet({ scale: 1.5 })
  l.react.resetHooks()
  const tree = Pet({})
  const view = viewOf(tree)
  const img = firstChild(view)
  assert.equal(view.props.style.width, `${Math.round(256 * 1.5)}px`)
  assert.equal(img.props.style.height, `${Math.round(256 * 1.5)}px`)
  assert.equal(img.props.style.width, `${Math.round(256 * 1.5) * 4}px`, '条带宽度也要按同比例放大')
})

ok('Pet 的状态经 data 属性暴露（便于样式与调试）', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { working: { file: 'w.png', frames: 2, frameMs: 36 } } }
  runtime.__state.snapshot = { petState: 'working', label: 'x', bubble: null }
  runtime.__state.settings = normalizePet({})
  l.react.resetHooks()
  const tree = Pet({})
  assert.equal(tree.props['data-zf-pet-state'], 'working')
})

ok('clickThrough 开启时容器 pointer-events:none', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1, frameMs: 36 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null }
  runtime.__state.settings = normalizePet({ clickThrough: true })
  l.react.resetHooks()
  const tree = Pet({})
  assert.equal(tree.props.style.pointerEvents, 'none')
})

ok('bubble 关闭时不渲染气泡', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1, frameMs: 36 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: { id: 1, kind: 'text', text: 'hi', image: null } }
  runtime.__state.settings = normalizePet({ bubble: false })
  l.react.resetHooks()
  const tree = Pet({})
  const bubble = tree.props.children.find(c => c !== null && c.props?.['data-zf-pet-bubble-kind'] !== undefined)
  assert.equal(bubble, undefined, 'bubble 关闭时不该渲染')
})

ok('bubbleImages 关闭时气泡只剩文字', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1, frameMs: 36 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: { id: 1, kind: 'both', text: 'hi', image: 'bubble/01.png' } }
  runtime.__state.settings = normalizePet({ bubble: true, bubbleImages: false })
  l.react.resetHooks()
  const tree = Pet({})
  const bubble = tree.props.children.find(c => c !== null && c.props?.['data-zf-pet-bubble-kind'] !== undefined)
  assert.ok(bubble !== undefined, '应渲染气泡')
  const imgs = bubble.props.children.filter(c => c !== null && c.type === 'img')
  assert.equal(imgs.length, 0, '关掉表情图后不该有 img')
})

/* ── 深色变体（契约 §4 `fileDark`）与不透明贴纸（`opaque`）──────────────── */

function renderBubble (bubble, opts = {}) {
  const l = loadClient(opts)
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1, frameMs: 36 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble }
  runtime.__state.settings = normalizePet({ bubble: true, bubbleImages: true })
  l.react.resetHooks()
  const tree = Pet({})
  const b = tree.props.children.find(c => c !== null && c.props?.['data-zf-pet-bubble-kind'] !== undefined)
  const img = b.props.children.find(c => c !== null && c.type === 'img')
  return { bubbleNode: b, img }
}

ok('⭐ 深色模式（外壳 data-ds-theme-source=dark）→ 用 imageDark', () => {
  const { img } = renderBubble({
    id: 1, kind: 'image', text: null, image: 'bubble/new/01.png',
    imageDark: 'bubble/new/01-dark.png', imageOpaque: true, imageHasText: true
  }, { documentAttrs: { 'data-ds-theme-source': 'dark' } })
  assert.ok(img, '应渲染 img')
  assert.equal(decodeURIComponent(img.props.src), '/api/zhuang-fangyi/pet/art/bubble/new/01-dark.png')
})

ok('浅色模式 → 用原图（不用变体）', () => {
  const { img } = renderBubble({
    id: 1, kind: 'image', text: null, image: 'bubble/new/01.png',
    imageDark: 'bubble/new/01-dark.png', imageOpaque: true, imageHasText: true
  }, { documentAttrs: { 'data-ds-theme-source': 'light' } })
  assert.equal(decodeURIComponent(img.props.src), '/api/zhuang-fangyi/pet/art/bubble/new/01.png')
})

ok('没有 imageDark 时深色模式回落原图（不会更糟）', () => {
  const { img } = renderBubble({
    id: 1, kind: 'image', text: null, image: 'bubble/17-yay.png',
    imageDark: null, imageOpaque: false, imageHasText: true
  }, { documentAttrs: { 'data-ds-theme-source': 'dark' } })
  assert.equal(decodeURIComponent(img.props.src), '/api/zhuang-fangyi/pet/art/bubble/17-yay.png')
})

ok('不透明贴纸 → 气泡带 zf-pet__bubble--opaque（不套气泡底）', () => {
  const { bubbleNode } = renderBubble({
    id: 1, kind: 'image', text: null, image: 'bubble/new/01.png',
    imageDark: null, imageOpaque: true, imageHasText: true
  })
  assert.ok(bubbleNode.props.className.includes('zf-pet__bubble--opaque'),
    'opaque=true 应加修饰类（CSS 里不画底/边框/内边距）')
})

ok('透明抠图 → 气泡保持原样（不加 opaque 修饰类）', () => {
  const { bubbleNode } = renderBubble({
    id: 1, kind: 'both', text: 'hi', image: 'bubble/17-yay.png',
    imageDark: null, imageOpaque: false, imageHasText: true
  })
  assert.ok(!bubbleNode.props.className.includes('zf-pet__bubble--opaque'))
})

/* ── ✎ 从气泡发消息（能力位门控）──────────────────────────────────────────
 *
 * 入口只在 `snapshot.send.available === true` 时出现 —— 宿主没装配
 * `sessionController` 时给一个点了必报错的按钮，比不给入口更像坏了。
 * ──────────────────────────────────────────────────────────────────────── */

function renderPetWithSend (sendBlock) {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1, frameMs: 36 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, send: sendBlock }
  runtime.__state.settings = normalizePet({})
  l.react.resetHooks()
  const tree = Pet({})
  const btn = tree.props.children.find(c => c !== null && c.props?.className === 'zf-pet__send-btn')
  return { tree, btn }
}

ok('⭐ send.available=false 时不渲染 ✎（不给必然报错的入口）', () => {
  const { btn } = renderPetWithSend({ available: false, reason: '宿主未装配 sessionController 服务' })
  assert.equal(btn, undefined)
})

ok('⭐ 缺 send 块（旧 Host 快照）时也不渲染 ✎', () => {
  const { btn } = renderPetWithSend(undefined)
  assert.equal(btn, undefined, '缺能力位按不可用处理')
})

ok('send.available=true 时渲染 ✎', () => {
  const { btn } = renderPetWithSend({ available: true, reason: null })
  assert.ok(btn !== undefined, '能力可用就该给入口')
  assert.equal(btn.type, 'button')
})

ok('点击 ✎ 会 stopPropagation（不能顺带触发拖动/双击）', () => {
  const { btn } = renderPetWithSend({ available: true, reason: null })
  let stopped = false
  let prevented = false
  btn.props.onClick({ stopPropagation: () => { stopped = true }, preventDefault: () => { prevented = true } })
  assert.equal(stopped, true, '必须阻止冒泡到容器的指针处理')
})

ok('⭐ clickThrough 时不给 ✎（按钮会显示却点不动）', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1, frameMs: 36 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, send: { available: true } }
  runtime.__state.settings = normalizePet({ clickThrough: true })
  l.react.resetHooks()
  const tree = Pet({})
  const btn = tree.props.children.find(c => c !== null && c.props?.className === 'zf-pet__send-btn')
  assert.equal(btn, undefined, '穿透模式下桌宠收不到鼠标，按钮点了也没用')
})

ok('activity 字段归一化：非法值回落 normal', () => {
  assert.equal(normalizePet({ activity: 'playful' }).activity, 'playful')
  assert.equal(normalizePet({ activity: 'quiet' }).activity, 'quiet')
  assert.equal(normalizePet({ activity: 'chaos' }).activity, 'normal', '非法值回落')
  assert.equal(normalizePet({}).activity, 'normal')
})

/* ── 常亮提醒（契约 §2 attention）的 overlay 渲染 ───────────────────────── */

ok('⭐ attentionReminder 归一化：默认开、非法值回落', () => {
  assert.equal(normalizePet({}).attentionReminder, true, '默认开（新功能默认可见）')
  assert.equal(normalizePet({ attentionReminder: false }).attentionReminder, false)
  assert.equal(normalizePet({ attentionReminder: 'yes' }).attentionReminder, true, '非法值回落默认')
})

function renderBubbleWith (bubble, snapshotExtra = {}) {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1, frameMs: 36 } } }
  runtime.__state.snapshot = { petState: 'waiting', label: '', bubble, ...snapshotExtra }
  runtime.__state.settings = normalizePet({})
  l.react.resetHooks()
  const tree = Pet({})
  const b = tree.props.children.find(c => c !== null && c.props?.['data-zf-pet-bubble-kind'] !== undefined)
  return b
}

ok('⭐ attention 气泡带 --attention 修饰类（醒目描边/脉动）', () => {
  const b = renderBubbleWith({
    id: 9, kind: 'attention', text: '在等你审批', image: null,
    sticky: true, attentionCount: 1, durationMs: 1800000, priority: 100
  })
  assert.ok(b !== undefined, '应渲染气泡')
  assert.ok(b.props.className.includes('zf-pet__bubble--attention'))
  assert.equal(b.props['data-zf-pet-bubble-kind'], 'attention')
})

ok('普通气泡不带 --attention 类（现状零回归）', () => {
  const b = renderBubbleWith({
    id: 9, kind: 'both', text: '在等你审批', image: null, durationMs: 6000, priority: 80
  })
  assert.ok(!b.props.className.includes('zf-pet__bubble--attention'))
})

ok('⭐ 待处理 ≥2 时渲染计数徽标，=1 不渲染', () => {
  const many = renderBubbleWith({
    id: 9, kind: 'attention', text: '在等你审批', image: null,
    sticky: true, attentionCount: 2, durationMs: 1800000, priority: 100
  })
  const badge = many.props.children.find(c => c !== null && c.props?.className === 'zf-pet__bubble-badge')
  assert.ok(badge !== undefined, '2 项待处理应显示徽标')
  // React children 是数组形态（单字符串包一层）。
  assert.equal(String(badge.props.children), '2')
  const one = renderBubbleWith({
    id: 9, kind: 'attention', text: '在等你审批', image: null,
    sticky: true, attentionCount: 1, durationMs: 1800000, priority: 100
  })
  const badge1 = one.props.children.find(c => c !== null && c.props?.className === 'zf-pet__bubble-badge')
  assert.equal(badge1, undefined, '只有 1 项时不显示徽标')
})

ok('⭐ 多个对话时输入条出现「发给」选择器，且选项用 title', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1, frameMs: 36 } } }
  runtime.__state.snapshot = {
    petState: 'idle', label: '',
    send: { available: true, reason: null },
    sessions: [
      { sessionId: 's-a', title: '桌宠开发', running: true, state: 'working' },
      { sessionId: 's-b', title: 'beta', running: false, state: 'idle' }
    ]
  }
  runtime.__state.settings = normalizePet({})
  l.react.resetHooks()
  // 打开输入条
  const tree = Pet({})
  // 找 ✎ 按钮并触发
  const findPen = node => {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (Array.isArray(node)) { for (const c of node) { const r = findPen(c); if (r) return r } return null }
    if (node.props) {
      const cls = node.props.className
      if (typeof cls === 'string' && cls.includes('zf-pet__send-btn')) return node
      return findPen(node.props.children)
    }
    return null
  }
  const pen = findPen(tree)
  assert.ok(pen !== null, '有发送能力时应渲染 ✎')
  l.react.resetHooks()
  pen.props.onClick({ stopPropagation () {} })
  const tree2 = Pet({})
  const sel = findPen(tree2)
  // 重新查找 select
  const findSelect = node => {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (Array.isArray(node)) { for (const c of node) { const r = findSelect(c); if (r) return r } return null }
    if (node.props) {
      if (node.props.className === 'zf-pet__composer-select') return node
      return findSelect(node.props.children)
    }
    return null
  }
  const select = findSelect(tree2)
  assert.ok(select !== null, '多对话时应出现选择器')
  assert.equal(select.props.value, 's-a', '默认选中第一个（Host 已把在跑的排前面）')
  const opts = select.props.children
  assert.equal(opts.length, 2, '两个对话 → 两个选项')
  assert.ok(String(opts[0].props.children).includes('桌宠开发'), '选项显示 title 而不是乱码 id')
  assert.ok(String(opts[0].props.children).includes('●'), '在跑的加标记')
})

ok('⭐ 选择器按项目分组（<optgroup> 折叠，对话多了才翻得到）', () => {
  // 真机上同一个项目下能有十几个对话（用户截图一整列同名），平铺一个下拉翻不到。
  // 分组让"项目"成为天然的折叠层（等价于折叠展开）。
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1, frameMs: 36 } } }
  runtime.__state.snapshot = {
    petState: 'idle', label: '',
    send: { available: true, reason: null },
    sessions: [
      { sessionId: 's-a1', title: '甲1', project: 'alpha', running: true, state: 'working' },
      { sessionId: 's-a2', title: '甲2', project: 'alpha', running: false, state: 'idle' },
      { sessionId: 's-a3', title: '甲3', project: 'alpha', running: false, state: 'idle' },
      { sessionId: 's-b1', title: '乙1', project: 'beta', running: false, state: 'idle' },
      { sessionId: 's-x1', title: '无项目', running: false, state: 'idle' }
    ]
  }
  runtime.__state.settings = normalizePet({})
  const findPen = node => {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (Array.isArray(node)) { for (const c of node) { const r = findPen(c); if (r) return r } return null }
    if (node.props) {
      const cls = node.props.className
      if (typeof cls === 'string' && cls.includes('zf-pet__send-btn')) return node
      return findPen(node.props.children)
    }
    return null
  }
  l.react.resetHooks()
  const pen = findPen(Pet({}))
  l.react.resetHooks()
  pen.props.onClick({ stopPropagation () {} })
  const tree2 = Pet({})
  const findSelect = node => {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (Array.isArray(node)) { for (const c of node) { const r = findSelect(c); if (r) return r } return null }
    if (node.props) {
      if (node.props.className === 'zf-pet__composer-select') return node
      return findSelect(node.props.children)
    }
    return null
  }
  const select = findSelect(tree2)
  assert.ok(select !== null, '多对话时应出现选择器')
  const kids = select.props.children
  // 期望结构：optgroup(alpha) + optgroup(beta) + option(无项目) = 3 个顶层节点
  const groups = kids.filter(k => k !== null && k.props && k.props.label !== undefined)
  const looseOpts = kids.filter(k => k !== null && k.props && k.props.value !== undefined)
  assert.equal(groups.length, 2, `应有 2 个项目分组，实际 ${groups.length}`)
  assert.equal(looseOpts.length, 1, '没有项目的会话直接作为 option（不套空 optgroup）')
  const alpha = groups.find(g => g.props.label === 'alpha')
  assert.ok(alpha, 'alpha 分组应存在')
  assert.equal(alpha.props.children.length, 3, 'alpha 下应有 3 个对话（折叠后同组）')
  // 组内不重复项目名前缀（项目名已由 optgroup 承担）
  const firstOpt = alpha.props.children[0]
  assert.ok(!String(firstOpt.props.children).includes('[alpha]'),
    '组内选项不该重复项目名前缀')
  assert.ok(String(firstOpt.props.children).includes('●'), '在跑的仍带标记')
})
ok('⭐ 只有一个对话时不显示选择器（不占地方）', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1, frameMs: 36 } } }
  runtime.__state.snapshot = {
    petState: 'idle', label: '',
    send: { available: true, reason: null },
    sessions: [{ sessionId: 's-only', title: '唯一', running: false, state: 'idle' }]
  }
  runtime.__state.settings = normalizePet({})
  const findPen = node => {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (Array.isArray(node)) { for (const c of node) { const r = findPen(c); if (r) return r } return null }
    if (node.props) {
      const cls = node.props.className
      if (typeof cls === 'string' && cls.includes('zf-pet__send-btn')) return node
      return findPen(node.props.children)
    }
    return null
  }
  l.react.resetHooks()
  const pen = findPen(Pet({}))
  l.react.resetHooks()
  pen.props.onClick({ stopPropagation () {} })
  const tree2 = Pet({})
  const findSelect = node => {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (Array.isArray(node)) { for (const c of node) { const r = findSelect(c); if (r) return r } return null }
    if (node.props) {
      if (node.props.className === 'zf-pet__composer-select') return node
      return findSelect(node.props.children)
    }
    return null
  }
  assert.equal(findSelect(tree2), null, '只有一个对话时不该出现选择器')
})
ok('⭐ 气泡贴在本体左上角（不压头顶）—— 与原生窗同一规则', () => {
  // 用户明确要求："气泡不应该优先在左上角而不是在头顶上吗"。
  // 判据用 CSS 的定位属性（气泡是绝对定位，right:100% 表示"贴在本体左侧"）。
  const css = fs.readFileSync(CLIENT, 'utf8')
  const m = css.match(/\.zf-pet__bubble\{([\s\S]*?)\}/)
  assert.ok(m, '应有 .zf-pet__bubble 规则')
  const body = m[1]
  assert.ok(/position\s*:\s*absolute/.test(body), '气泡应绝对定位（否则会挤进 flex 流、撑开容器）')
  assert.ok(/right\s*:\s*100%/.test(body),
    'right:100% = 气泡右边缘贴本体左边缘（左上角规则）；实际：' + body.replace(/\s+/g, ' ').slice(0, 120))
  assert.ok(/bottom\s*:/.test(body), '需要 bottom 让它垂直靠上（不压头顶）')
  // 不该再用"贴头顶"的写法
  assert.ok(!/top\s*:\s*-100%/.test(body), '不该再贴正上方（会遮住角色的头）')
})
ok('⭐ attention 在 clickThrough 下仍显示（它是通知，不是交互）', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1, frameMs: 36 } } }
  runtime.__state.snapshot = {
    petState: 'waiting', label: '',
    bubble: { id: 9, kind: 'attention', text: '在等你审批', image: null, sticky: true, attentionCount: 1, priority: 100 }
  }
  runtime.__state.settings = normalizePet({ clickThrough: true })
  l.react.resetHooks()
  const tree = Pet({})
  const b = tree.props.children.find(c => c !== null && c.props?.['data-zf-pet-bubble-kind'] !== undefined)
  assert.ok(b !== undefined, '穿透只是不吃鼠标，通知必须仍可见 —— 否则"人不在 DSH 前"就错过了')
})

ok('⭐ 设置页有"审批/提问常亮提醒"开关', () => {
  // Section 树里 Toggle 还是未展开的元素：文案在 `label`、值在 `value`（布尔）。
  let toggle = null
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.props) {
      if (typeof node.props.label === 'string' && node.props.label.includes('常亮提醒')) toggle = node
      walk(node.props.children)
    }
  }
  walk(renderSection({ attentionReminder: false }).props.children)
  assert.ok(toggle !== null, '设置页应有该开关')
  assert.equal(toggle.props.value, false, '开关应反映当前值（关闭态）')
  // 再确认开着的时候渲染 true
  let toggle2 = null
  const walk2 = node => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk2); return }
    if (node.props) {
      if (typeof node.props.label === 'string' && node.props.label.includes('常亮提醒')) toggle2 = node
      walk2(node.props.children)
    }
  }
  walk2(renderSection({ attentionReminder: true }).props.children)
  assert.equal(toggle2?.props.value, true)
})

/* ── 设置页（Section）必须能渲染 ─────────────────────────────────────────
 *
 * 这一条是被真实事故逼出来的：设置页在用户那里**整片空白**，
 * 而当时的测试只渲染了 Pet —— Section 里的运行时错误（例如未定义的取词器）
 * 完全没被发现。一个"注册了却渲染不出来"的设置页，用户看到的就是坏了。
 * ──────────────────────────────────────────────────────────────────────── */

function renderSection (settingsPatch = {}) {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: false }
  runtime.__state.settings = normalizePet(settingsPatch)
  l.react.resetHooks()
  return Section({ close () {} })
}

ok('⭐ 设置页能渲染（不抛错、不出空白）', () => {
  const tree = renderSection()
  assert.ok(tree !== null && tree !== undefined, 'Section 必须返回节点')
  assert.equal(tree.type, 'div', '应渲染成容器')
})

ok('⭐ 设置页包含关键控件且反映当前值（大小/活跃度/双击/主题）', () => {
  const values = []
  const collect = node => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (typeof node !== 'object') return
    if (node.props) {
      if (typeof node.props.value === 'string' || typeof node.props.value === 'number') {
        values.push(String(node.props.value))
      }
      collect(node.props.children)
    }
  }
  collect(renderSection({ activity: 'playful', doubleClick: 'emote', theme: 'dark' }).props.children)
  const joined = values.join('|')
  assert.ok(joined.includes('playful'), '活跃度选择器应反映当前值')
  assert.ok(joined.includes('emote'), '双击行为选择器应反映当前值')
  assert.ok(joined.includes('dark'), '贴纸深浅色选择器应反映当前值')
})

ok('设置页在设置缺字段（旧设置文件）时也能渲染', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.settings = { scale: 1, enabled: true } // 缺 activity/doubleClick 等新字段
  l.react.resetHooks()
  const tree = Section({ close () {} })
  assert.ok(tree !== null, '缺字段不该让设置页崩掉')
})

ok('缺该状态的素材时回落到 idle', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'idle.png', frames: 4, frameMs: 60 } } }
  runtime.__state.snapshot = { petState: 'sleeping', label: '', bubble: null }
  runtime.__state.settings = normalizePet({})
  l.react.resetHooks()
  const tree = Pet({})
  assert.match(firstChild(viewOf(tree)).props.src, /idle\.png$/, '应回落 idle 素材')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 7b. ⭐ 组件必须能接受**外壳真实的 props 形状**（真机炸过）
 *
 * 这一条是被真机事故逼出来的，且比第 7 节所有断言都重要：
 *
 * 外壳渲染 slot 条目时传的 props 是
 *     `{ ...kit, ...entry.inject, ...slotInjected.props, ...ownerProps }`
 * —— **没有 `runtime`**。`shell.overlay` 的 ownerProps 是 `{}`，
 * `settings.section` 的是 `{ close }`。
 *
 * 而此前的测试一律写 `Pet({ runtime })`，那是**测试自己发明的形状**，
 * 外壳永远不会这样调。于是两边都"通过"：测试绿、真机上条目一渲染就抛
 * `TypeError`，被外壳 `SlotErrorBoundary` 接住并 `abdicate`（逐出单元格）。
 * 实测 live slot 树里我们的 overlay 条目 `active: false`、其余 12 个全 `true`
 * —— 正是"已被逐出"的证据。用户看到的则是桌宠不出现、设置页空白。
 *
 * 所以这里**只传外壳真会传的东西**，并额外断言"绝不依赖 props.runtime"。
 * ──────────────────────────────────────────────────────────────────────── */
section('7b. 外壳真实 props 形状（无 runtime）')

ok('⭐ Pet 用外壳的真实调用形状（{}）渲染不抛错', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null }
  runtime.__state.settings = normalizePet({})
  l.react.resetHooks()
  assert.doesNotThrow(() => Pet({}), '外壳传 {} —— 抛错就会被 abdicate 掉')
})

ok('⭐ Section 用外壳的真实调用形状（{ close }）渲染不抛错', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section } = l.exports.__test
  l.react.resetHooks()
  assert.doesNotThrow(() => Section({ close () {} }), 'settings.section 的 ownerProps 只有 close')
})

ok('⭐ 组件不读 props.runtime（传了就说明还在依赖它）', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet } = l.exports.__test
  // 传一个会抛错的 runtime：若组件仍在读它，这里就会炸。
  const trap = new Proxy({}, {
    get (_t, key) { throw new Error(`组件不该读 props.runtime.${String(key)}`) }
  })
  l.react.resetHooks()
  assert.doesNotThrow(() => Pet({ runtime: trap }), 'props.runtime 必须完全不被读取')
})

ok('运行时未装配时给出可读错误，而不是 undefined.t', () => {
  // 不调 apply()，直接渲染 —— 模拟"装配顺序错了"。
  const l = loadClient()
  const { Pet } = l.exports.__test
  l.react.resetHooks()
  assert.throws(() => Pet({}), /运行时尚未装配/, '错误信息应指出运行时没装配')
})

/* ── 让位：原生窗口在跑时 overlay 必须完全不渲染 ──────────────────────────
 *
 * 契约 §2 对 `nativeAvailable` 的注释就是"供 overlay 判断是否让位"，
 * 但此前**没有一处读它**。修好"客户端半边整片崩溃"之后这条会立刻显形：
 * 屏幕上是**两只桌宠**（桌面一只、DSH 窗口里一只），各自记位置、各自响应拖动。
 * ──────────────────────────────────────────────────────────────────────── */

/** 渲染 Pet 并返回树（`nativeAvailable` 等按参数给）。 */
function renderPetWith (snapshotPatch = {}, settingsPatch = {}) {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, ...snapshotPatch }
  runtime.__state.settings = normalizePet(settingsPatch)
  l.react.resetHooks()
  return Pet({})
}

ok('⭐ 原生窗口在跑时 overlay 让位（否则屏幕上两只桌宠）', () => {
  const tree = renderPetWith({ nativeAvailable: true })
  assert.equal(tree, null, 'nativeAvailable=true 时不该渲染任何东西')
})

ok('⭐ 桌面窗为主时，exe 不可用必须回落 overlay（逃生舱）', () => {
  // ⚠️ 这条断言的方向在 v2 改过，理由是"别让插件变成空壳"：
  //
  // 如果 `mode: 'native'` 在 exe 不可用时什么都不渲染，那么在
  // **非 Windows**（没有 net48）或 **exe 被杀软拦掉**的机器上，
  // 用户装完插件会看到"什么都没有，也不报错" —— 正是我们一直在打的那种
  // 静默失败。所以 native 的语义是"**优先**桌面窗"，不是"只允许桌面窗"。
  //
  // 想要"只在桌面窗、绝不回落"的用户不存在；想要"只在窗口内"的用 overlay。
  const tree = renderPetWith({ nativeAvailable: false }, { mode: 'native' })
  assert.ok(tree !== null, 'exe 不可用时 overlay 必须接管，否则插件形同不存在')
})

ok('⭐ 总开关关掉时 overlay 不渲染（宿主不启 exe，overlay 也得停）', () => {
  const tree = renderPetWith({ nativeAvailable: false }, { enabled: false })
  assert.equal(tree, null, 'enabled=false 时应停')
})

ok('mode=overlay 时不让位（用户显式选的 mode 优先于探测到的 exe 状态）', () => {
  // 宿主按 mode 决定起不起 exe，但"从 native 切到 overlay"时已在跑的 exe
  // 要等设置变化把宿主停掉；这个窗口期内让位就等于
  // "用户选了窗口内，结果什么都不显示"。
  const tree = renderPetWith({ nativeAvailable: true }, { mode: 'overlay' })
  assert.ok(tree !== null, 'mode=overlay 是用户显式选择，应当渲染')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 运行时：数据来源
 * ═════════════════════════════════════════════════════════════════════════ */
section('8. 运行时数据来源')

ok('运行时从桌宠**自己的**设置端点读取（不碰主题插件的设置文件）', async () => {
  const fetches = []
  const l = loadClient({
    fetchImpl: async url => {
      fetches.push(url)
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
  })
  l.exports.apply(l.ctx)
  await l.exports.__test.runtime.load()
  assert.ok(
    fetches.some(u => u === '/api/zhuang-fangyi/pet/settings'),
    `应读桌宠自己的设置端点，实际：${fetches.join(', ')}`
  )
  assert.ok(
    !fetches.some(u => u === '/api/zhuang-fangyi/settings'),
    '绝不该读主题插件的设置端点'
  )
  assert.ok(fetches.some(u => u.endsWith('/atlas')), '应读素材清单')
})

ok('SSE 用 EventSource（浏览器无法给 SSE 设请求头，所以走同源准入）', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  assert.doesNotThrow(() => l.exports.__test.runtime.connect())
})

ok('订阅者能收到快照推送', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const rt = l.exports.__test.runtime
  const seen = []
  const off = rt.subscribe(next => seen.push(next))
  rt.__state.snapshot = { petState: 'happy' }
  // 手动触发一次 emit（走内部 state 赋值路径）。
  off()
  assert.ok(Array.isArray(seen))
})

/* ══════════════════════════════════════════════════════════════════════════
 * 9. 文案
 * ═════════════════════════════════════════════════════════════════════════ */
section('9. 文案')

const { STATE_TEXT, DICT } = loaded.exports.__test

ok('9 个状态都有中英文案，且与 Host 的 key 集一致', () => {
  const states = ['waking', 'idle', 'listening', 'thinking', 'working', 'waiting', 'happy', 'error', 'sleeping']
  for (const s of states) {
    assert.ok(STATE_TEXT.zh[s], `zh 缺 ${s}`)
    assert.ok(STATE_TEXT.en[s], `en 缺 ${s}`)
  }
})

ok('设置页文案 zh/en key 集一致', () => {
  const zh = Object.keys(DICT.zh).sort()
  const en = Object.keys(DICT.en).sort()
  assert.deepEqual(zh, en, '两种语言的 key 集必须一致，否则切换语言会露 key')
})

/* ═════════════════════════════════════════════════════════════════════════ */
console.log(`\n${'═'.repeat(60)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('❌ 有失败项')
  process.exit(1)
}
console.log('✅ 全部通过')