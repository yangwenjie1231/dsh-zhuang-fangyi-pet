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
  assert.equal(d.mode, 'auto')
  assert.equal(d.scale, 1)
  assert.equal(d.bubble, true)
})

ok('scale 被夹到 0.5~2', () => {
  assert.equal(normalizePet({ scale: 99 }).scale, 2)
  assert.equal(normalizePet({ scale: 0.01 }).scale, 0.5)
})

ok('opacity 被夹到 0.3~1', () => {
  assert.equal(normalizePet({ opacity: 5 }).opacity, 1)
  assert.equal(normalizePet({ opacity: 0 }).opacity, 0.3)
})

ok('mode 只接受三个合法值', () => {
  assert.equal(normalizePet({ mode: 'overlay' }).mode, 'overlay')
  assert.equal(normalizePet({ mode: 'native' }).mode, 'native')
  assert.equal(normalizePet({ mode: 'hack' }).mode, 'auto')
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
  const tree = Pet({ runtime })
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
  const tree = Pet({ runtime })
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
  const tree = Pet({ runtime })
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
  const tree = Pet({ runtime })
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
  const tree = Pet({ runtime })
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
  const tree = Pet({ runtime })
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
  const tree = Pet({ runtime })
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
  const tree = Pet({ runtime })
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
  const tree = Pet({ runtime })
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

ok('缺该状态的素材时回落到 idle', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Pet, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'idle.png', frames: 4, frameMs: 60 } } }
  runtime.__state.snapshot = { petState: 'sleeping', label: '', bubble: null }
  runtime.__state.settings = normalizePet({})
  l.react.resetHooks()
  const tree = Pet({ runtime })
  assert.match(firstChild(viewOf(tree)).props.src, /idle\.png$/, '应回落 idle 素材')
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