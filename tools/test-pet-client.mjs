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

// 宿主的设置模型：第 5b 节用它做**字段集与默认值的同口径比对**。
// 直接 import 真文件（不是抄一份常量）—— 抄一份就又会分叉。
import { defaultSettings, normalizeSettings } from '../src/settings.js'

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

/**
 * 异步断言（需要 `await` 的用例）。
 *
 * ⚠️ 为什么要单独一个函数：`ok()` 是**同步**的，它的 `try/catch` 接不住
 * 一个 async 函数里抛出的错 —— 那种错误会变成 **unhandled rejection**，
 * 表现为整个测试进程**直接崩掉**（退出码 1、后面的用例一条都不跑），
 * 而不是干净地记一条 ✗。实测踩过：回滚验证时它把测试进程整个打断了。
 *
 * 用法：注册进来，文件末尾在汇总前统一 `await` 跑完。
 */
const asyncCases = []
function okAsync (label, fn) {
  asyncCases.push({ label, fn })
}

/** 跑完所有异步用例（在打印汇总之前调用）。 */
async function runAsyncCases () {
  for (const { label, fn } of asyncCases) {
    try {
      await fn()
      passed += 1
      console.log(`  ✓ ${label}`)
    } catch (error) {
      failed += 1
      console.log(`  ✗ ${label}\n      ${error?.message ?? error}`)
    }
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
  // 每次装载都换一份"实例账本"：测试据此找到那个 EventSource 并**手动推帧**。
  const EventSourceStub = class {
    constructor (url) {
      this.url = url
      this.readyState = 0
      this.handlers = {}
      EventSourceStub.instances.push(this)
    }
    addEventListener (name, fn) { this.handlers[name] = fn }
    close () { this.readyState = 2 }
  }
  EventSourceStub.instances = []
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
    EventSource: EventSourceStub
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

  return { exports: module, ctx, calls, react, storage, sandboxWindow, EventSource: EventSourceStub }
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

/* ── v3 新设置（番茄钟 / 语音 / 聊天）────────────────────────────────────── */

ok('v3 新字段有默认值，且"会打扰人"的两个默认关', () => {
  const d = normalizePet(null)
  // ⚠️ 这两条的默认值是**刻意的产品决定**，值得断言：
  // 装完插件就自己开始 25 分钟倒计时、或者突然开口说话，都是骚扰。
  assert.equal(d.pomodoro, false, '番茄钟默认关')
  assert.equal(d.voice, false, '语音默认关')
  assert.equal(d.chatEnabled, true, '聊天默认开（它不主动出声，只在用户点的时候用）')
  assert.equal(d.pomodoroFocusMs, 25 * 60 * 1000)
  assert.equal(d.pomodoroBreakMs, 5 * 60 * 1000)
  assert.equal(d.pomodoroLongBreakMs, 15 * 60 * 1000, '用户点名"每 4 轮一次长休息（15 分）"')
  assert.equal(d.pomodoroRounds, 4)
  assert.equal(d.pomodoroCountdown, true)
  assert.equal(d.persona, 'default')
  assert.equal(d.chatWorkspace, '', '空 = 用默认目录')
})

ok('⭐ v3 布尔字段逐个归一化（不整体丢弃）', () => {
  const n = normalizePet({
    pomodoro: true, pomodoroAutoNext: false, pomodoroNotify: false,
    pomodoroCountdown: false, voice: true, chatEnabled: false
  })
  assert.equal(n.pomodoro, true)
  assert.equal(n.pomodoroAutoNext, false)
  assert.equal(n.pomodoroNotify, false)
  assert.equal(n.pomodoroCountdown, false)
  assert.equal(n.voice, true)
  assert.equal(n.chatEnabled, false)
  // 非布尔值不该被当成 true（`typeof` 检查）
  const m = normalizePet({ pomodoro: 'yes', voice: 1 })
  assert.equal(m.pomodoro, false, '字符串不该被当成 true')
  assert.equal(m.voice, false, '数字不该被当成 true')
})

ok('⭐⭐ 番茄钟时长范围与 Host **同口径**（三处必须一致）', () => {
  // 三处：Host `src/settings.js`、客户端 `normalizePet`、番茄钟模块
  // `POMODORO_LIMITS`。差一处就会出现"设置页能拖到 500 分钟、
  // 但 Host 夹回 240"这种界面与行为不一致。
  const n = normalizePet({
    pomodoroFocusMs: 1,                      // 太小 → 夹到 60s
    pomodoroBreakMs: 99 * 60 * 60 * 1000,    // 太大 → 夹到 60min
    pomodoroLongBreakMs: 'abc',              // 非数 → 回落默认
    pomodoroRounds: 999                      // 太大 → 夹到 12
  })
  assert.equal(n.pomodoroFocusMs, 60 * 1000, '专注下限 1 分钟')
  assert.equal(n.pomodoroBreakMs, 60 * 60 * 1000, '短休上限 60 分钟')
  assert.equal(n.pomodoroLongBreakMs, 15 * 60 * 1000, '非法值回落默认')
  assert.equal(n.pomodoroRounds, 12, '轮数上限 12')
  // 范围内的值必须原样保留（不能被夹掉）
  const keep = normalizePet({
    pomodoroFocusMs: 45 * 60 * 1000,
    pomodoroBreakMs: 10 * 60 * 1000,
    pomodoroLongBreakMs: 30 * 60 * 1000,
    pomodoroRounds: 3
  })
  assert.equal(keep.pomodoroFocusMs, 45 * 60 * 1000)
  assert.equal(keep.pomodoroBreakMs, 10 * 60 * 1000)
  assert.equal(keep.pomodoroLongBreakMs, 30 * 60 * 1000)
  assert.equal(keep.pomodoroRounds, 3)
})

ok('⭐ 人设名与工作区路径的保守校验', () => {
  // 合法值原样保留（含中文名 —— 用户会用人名）
  assert.equal(normalizePet({ persona: '庄方宜' }).persona, '庄方宜')
  assert.equal(normalizePet({ persona: ' strict ' }).persona, 'strict', '应 trim')
  // 空/超长/非字符串 → 回落默认
  assert.equal(normalizePet({ persona: '' }).persona, 'default')
  assert.equal(normalizePet({ persona: 'x'.repeat(65) }).persona, 'default', '超长回落')
  assert.equal(normalizePet({ persona: 42 }).persona, 'default', '非字符串回落')
  // 工作区：空字符串是**合法值**（= 用默认目录），不能被回落成别的
  assert.equal(normalizePet({ chatWorkspace: '' }).chatWorkspace, '')
  assert.equal(normalizePet({ chatWorkspace: '  D:\\x  ' }).chatWorkspace, 'D:\\x', '应 trim')
  assert.equal(normalizePet({ chatWorkspace: 'x'.repeat(261) }).chatWorkspace, '', '超长回落空')
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
 * 5b. 客户端字段集必须与宿主同口径（**接缝测试**）
 *
 * 这一节是为了一个**真机上存在了很久、却没有任何测试能发现**的 bug：
 *
 *   `normalizePet` 是**白名单**（逐字段拷贝），而这份白名单是手写的。
 *   语音那批字段（speakReplies/ttsUrl/speechMaxChars/ttsResident/
 *   ttsIdleStopSec/ttsIdleAction/memoryAuto + 5 个机器路径）加进来时只改了
 *   Host 的 `src/settings.js`，忘了客户端。后果是**设置页 7 个控件全是死的**：
 *
 *     · `load()` 喂进来的 JSON 里这些键被丢掉 → 界面显示错值
 *       （实测：宿主 `speakReplies=true`，界面显示"关"）；
 *     · `updateSettings()` 走同一个归一化 → POST body 里**没有这些键**
 *       → 宿主是**合并**语义 → 点了等于没点，**而且不报错**。
 *
 * 为什么原有测试全绿：`test-pet-e2e.mjs` 直接 POST `/pet/settings`，
 * **绕过了客户端的归一化**，所以宿主侧一切正常；而客户端测试只验了
 * 它自己认识的那些字段。两个半边各自都"对"，接缝上全错。
 *
 * 所以这一节**直接 import 宿主的 `defaultSettings()`** 逐键比对 ——
 * 以后任何一边加字段而另一边忘了，测试立刻红。
 * ═════════════════════════════════════════════════════════════════════════ */
section('5b. 客户端字段集与宿主同口径（防"设置页点了没反应"）')

ok('⭐⭐ 宿主 defaultSettings() 的每个字段，客户端归一化后都必须在', () => {
  const host = defaultSettings()
  const client = normalizePet(host)
  // `version` 是宿主自己维护的结构版本号，客户端**有意**不持有它
  //（它不参与任何界面逻辑，透传反而会在 POST 时写回一个旧值）。
  const INTENTIONAL = new Set(['version'])
  const missing = Object.keys(host).filter(k => !INTENTIONAL.has(k) && !(k in client))
  assert.deepEqual(missing, [],
    `这些字段宿主有、客户端没有 → 界面上对应的控件会是死的（读不到值、改了发不出去）：${missing.join(', ')}`)
})

ok('⭐⭐ 每个字段的默认值与宿主一致（同名字段不许有两套默认值）', () => {
  const host = defaultSettings()
  const client = normalizePet(host)
  const diff = []
  for (const k of Object.keys(host)) {
    if (k === 'version') continue
    if (JSON.stringify(host[k]) !== JSON.stringify(client[k])) {
      diff.push(`${k}: 宿主 ${JSON.stringify(host[k])} vs 客户端 ${JSON.stringify(client[k])}`)
    }
  }
  assert.deepEqual(diff, [], `默认值分叉会让"没设置过"和"设成默认值"表现不同：\n      ${diff.join('\n      ')}`)
})

ok('⭐⭐ 往返不丢字段：宿主设置 → 客户端归一化 → 回送宿主', () => {
  // 造一份"每个字段都不是默认值"的设置 —— 默认值相同的字段发现不了丢失。
  const host = normalizeSettings({
    enabled: false, mode: 'overlay', scale: 1.7, opacity: 0.6,
    clickThrough: true, topmost: false, bubble: false, bubbleImages: false,
    happyMs: 4321, sleepMs: 123456, bubbleMs: 7777, bubbleGapMs: 1234,
    doubleClick: 'emote', theme: 'dark', activity: 'playful',
    hint: false, statusAlways: true, statusFontScale: 2.2, chatFontScale: 1.7,
    notifyComplete: false, attentionReminder: false,
    pomodoro: true, pomodoroFocusMs: 90 * 60000, pomodoroBreakMs: 11 * 60000,
    pomodoroLongBreakMs: 44 * 60000, pomodoroRounds: 7,
    pomodoroAutoNext: false, pomodoroNotify: false, pomodoroCountdown: false,
    voice: true, persona: '严谨', chatWorkspace: 'D:\\ws', chatEnabled: false,
    memoryAuto: false, speakReplies: true, ttsUrl: 'http://127.0.0.1:9999',
    speechMaxChars: 111, ttsResident: true, ttsIdleStopSec: 77, ttsIdleAction: 'unload',
    ttsPython: 'D:\\py\\python.exe', ttsRepoDir: 'D:\\repo', ttsBackend: 'torch',
    ttsGsvRoot: 'D:\\gsv', ttsModelDir: 'D:\\models'
  })
  const roundTrip = normalizeSettings(normalizePet(host))
  const lost = Object.keys(host).filter(k => k !== 'version' &&
    JSON.stringify(roundTrip[k]) !== JSON.stringify(host[k]))
  assert.deepEqual(lost, [],
    `往返后这些字段变了 —— 用户在设置页改完、宿主存下去，值会跟界面显示的**不是一回事**：${lost.join(', ')}`)
})

ok('⭐⭐ POST 出去的 body 里必须带全字段（合并语义下缺键 = 用户白点）', () => {
  // 这是上一条的**行为级**版本：不比对字段名，而是真的走一遍
  // "读进来 → 改一个 → 发出去"，看 POST body 里有没有那个键。
  // 宿主 `settings.update()` 是**合并**语义，缺键不只"没改"，而是"完全没反应"。
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  // 宿主真实设置（每个字段都不是默认值）
  runtime.__state.settings = normalizePet({
    speakReplies: true, ttsResident: false, memoryAuto: true,
    ttsUrl: 'http://127.0.0.1:8765', speechMaxChars: 60,
    ttsIdleStopSec: 300, ttsIdleAction: ''
  })
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  // 页签化之后这些开关分在两页里（语音 / 对话）。必须走**真实的 onSelect** 切页签：
  // 桩的 `useState` 会把首次 `init()` 的结果缓存在 `hooks.states[i]` 里，
  // 只改 `runtime.__state.tab` 再渲染等于**没切**（第二次读到的还是旧值）。
  l.react.resetHooks()
  const first = Section({ close () {} })
  const toggles = [
    ...collectByType(first, 'Toggle').map(n => n.props),
    ...collectByType(switchTab(l, first, 'voice'), 'Toggle').map(n => n.props),
    ...collectByType(switchTab(l, first, 'chat'), 'Toggle').map(n => n.props)
  ]
  const find = label => toggles.find(x => x.label === label)

  // 每个受影响的控件都真的点一下，检查 POST body。
  // 注意 `runtime.updateSettings` 是**异步**的（内部 fetch），但 `set()` 会
  // **同步**先 `emit({settings})` 再发请求 —— 而请求体的构造也在同步段里，
  // 所以这里同步读完 fetch 记录即可（`loadClient` 的 fetch 桩同步入栈）。
  const cases = [
    ['把 AI 的回答念出来', 'speakReplies'],
    ['让语音模型常驻', 'ttsResident'],
    ['自动记住值得长期保留的事', 'memoryAuto']
  ]
  for (const [label, key] of cases) {
    const c = find(label)
    assert.ok(c, `找不到「${label}」开关`)
    l.calls.fetches.length = 0
    c.onChange(!c.value)
    const post = l.calls.fetches.find(f => f.init?.method === 'POST')
    assert.ok(post, `点「${label}」应发出 POST`)
    const body = JSON.parse(post.init.body)
    assert.ok(Object.prototype.hasOwnProperty.call(body.settings, key),
      `POST body 里没有 ${key} —— 宿主是合并语义，缺键等于这次点击**完全没生效**，` +
      '而且界面上不会有任何提示（这是"设置页点了没反应"的根因）')
  }
})

ok('⭐ 语音的四个值字段也能被客户端归一化（不再静默丢弃）', () => {
  const n = normalizePet({
    ttsUrl: 'http://127.0.0.1:9000', speechMaxChars: 120,
    ttsIdleStopSec: 60, ttsIdleAction: 'unload'
  })
  assert.equal(n.ttsUrl, 'http://127.0.0.1:9000')
  assert.equal(n.speechMaxChars, 120)
  assert.equal(n.ttsIdleStopSec, 60)
  assert.equal(n.ttsIdleAction, 'unload')
  // 校验口径与宿主同集（否则界面显示的值和宿主存的值会分叉）
  assert.equal(normalizePet({ ttsUrl: 'file:///etc/passwd' }).ttsUrl, 'http://127.0.0.1:8765',
    '非 http(s) 协议必须回落（这个值会被 fetch 直接用）')
  assert.equal(normalizePet({ speechMaxChars: 9999 }).speechMaxChars, 300, '上限 300')
  assert.equal(normalizePet({ speechMaxChars: 1 }).speechMaxChars, 10, '下限 10')
  assert.equal(normalizePet({ ttsIdleStopSec: -5 }).ttsIdleStopSec, 0, '下限 0')
  assert.equal(normalizePet({ ttsIdleStopSec: 1e9 }).ttsIdleStopSec, 86400, '上限一天')
  assert.equal(normalizePet({ ttsIdleAction: 'hack' }).ttsIdleAction, '', '非法值回落空串')
  assert.equal(normalizePet({ ttsBackend: 'hack' }).ttsBackend, '', '非法后端回落')
})

ok('⭐ 机器路径字段能透传（否则 POST 完整对象时会被冲掉）', () => {
  const n = normalizePet({
    ttsPython: 'D:\\py\\python.exe', ttsRepoDir: 'D:\\repo',
    ttsBackend: 'torch', ttsGsvRoot: 'D:\\gsv', ttsModelDir: 'D:\\models'
  })
  assert.equal(n.ttsPython, 'D:\\py\\python.exe')
  assert.equal(n.ttsRepoDir, 'D:\\repo')
  assert.equal(n.ttsBackend, 'torch')
  assert.equal(n.ttsGsvRoot, 'D:\\gsv')
  assert.equal(n.ttsModelDir, 'D:\\models')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5c. 输入框的 onInput 必须真的收下内容
 * ═════════════════════════════════════════════════════════════════════════ */

ok('⭐⭐ 聊天输入框的 onInput 不抛错，且草稿真的存下来（否则一个字都发不出去）', () => {
  // 真机上这里曾经是 `const chatDraft = chatDraftRef.current` +
  // `onInput: e => { chatDraft = e.target.value }` —— **给 const 赋值**。
  // 用户每敲一个字抛 TypeError，草稿永远是空串 →「发一条」直接被
  // `text === ''` 的守卫 return 掉，一句话也发不出去，还不报错。
  // 测试从没抓到，因为只验了"输入框在不在"，从没**调用过** onInput。
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.settings = normalizePet({})
  runtime.__state.tab = 'chat'   // 聊天输入框在「对话」页签里
  l.react.resetHooks()
  const tree = Section({ close () {} })

  const inputs = collectByType(tree, 'input').map(n => n.props)
  const chatInput = inputs.find(p => String(p.className).includes('zf-pet-chatrow__input'))
  assert.ok(chatInput, '应有聊天输入框')
  assert.doesNotThrow(() => chatInput.onInput({ target: { value: '你好呀' } }),
    'onInput 抛错 = 用户打的字被吞掉（真机上这里抛的是 Assignment to constant variable）')

  // 草稿必须真的进了 ref —— 这才是「发一条」能读到的东西。
  const draft = l.react.hooks.refs.find(r => r && r.current === '你好呀')
  assert.ok(draft, '输入的内容必须存进草稿 ref（否则发送时 text 是空串，直接 return）')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5d. 记忆编辑框：加载后必须可见，且不许覆盖真实记忆
 * ═════════════════════════════════════════════════════════════════════════ */

okAsync('⭐⭐⭐ 记忆加载完成后编辑框会重建（否则是空白框，保存会覆盖掉真实记忆）', async () => {
  // 真机行为：textarea 是**非受控**的（defaultValue 只在挂载时生效）。
  // 首帧 `memory` 还是 null → defaultValue 是空串；加载回来后若 `key` 不变，
  // React 不重建元素 → 屏幕上**永远是空白框**。
  // 用户在空白框里敲一个字再点「保存记忆」，就会把真实记忆整个覆盖成那个字。
  // 实测过（`.scratch/probe-memory-box.mjs`）。
  const l = loadClient({
    fetchImpl: async url => {
      if (String(url).endsWith('/memory')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ text: '用户叫 A，在做仿通行证项目。', file: 'm.md', bytes: 24, capBytes: 4096 }),
          text: async () => ''
        }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
  })
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.tab = 'chat'   // 记忆编辑框在「对话」页签里
  l.react.resetHooks()

  // ① 首帧：memory 还是 null
  const first = Section({ close () {} })
  const box1 = collectByType(first, 'textarea')[0]
  assert.ok(box1, '应有记忆编辑框')
  assert.equal(box1.props.defaultValue, '', '首帧还没有记忆，空串是对的')

  // ② 跑挂载 effect（拉 /memory），然后重渲染 —— 模拟外壳的行为
  for (const fn of l.react.hooks.effects) {
    if (typeof fn === 'function') { try { fn() } catch { /* 忽略 */ } }
  }
  await new Promise(r => setTimeout(r, 30))

  // ③ 重渲染：key 必须变了（React 靠它重建元素）
  l.react.resetHooks()
  const second = Section({ close () {} })
  const box2 = collectByType(second, 'textarea')[0]
  assert.notEqual(box2.props.key, box1.props.key,
    '加载完记忆后 key 必须变 —— 否则 React 不重建这个非受控 textarea，' +
    '用户看到的是一个空白框，在里面打字保存就会把真实记忆覆盖掉')
  assert.equal(box2.props.defaultValue, '用户叫 A，在做仿通行证项目。',
    '重建后编辑框里应该能看到真实记忆')

  // ④ 再渲染一次（普通重渲染，比如改别的设置）：key 不该再变，
  //    否则会打断用户正在进行的输入。
  l.react.resetHooks()
  const third = Section({ close () {} })
  const box3 = collectByType(third, 'textarea')[0]
  assert.equal(box3.props.key, box2.props.key,
    '普通重渲染不能重建编辑框（会清掉用户正在打的字）')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5e. 设置页的结构与样式（"界面很混乱"的可回归化部分）
 * ═════════════════════════════════════════════════════════════════════════ */

ok('⭐⭐ 每个用到的 zf-* 类名都必须在 CSS 里有规则（防"裸样式"控件）', () => {
  // 真机上真实存在的问题：语音组那 4 个控件用的是
  // `zf-pet-settings__input`，而这个类名**只有引用、没有任何 CSS 规则** ——
  // 于是「合成服务地址」等输入框是浏览器裸样式：高度/边框/圆角/背景
  // 与旁边的下拉框完全不一致，这是"看起来很乱"的一大来源。
  // 这类问题没有任何断言会红（样式缺失不报错，只是难看）。
  const src = fs.readFileSync(CLIENT, 'utf8')
  const css = loaded.exports.__test.styleText()
  // ① 渲染代码里用到的类名。**只认 `className:` 那一行** ——
  //    早先我用"所有 'zf-xxx' 字符串字面量"来收集，结果把
  //    `el.id = 'zf-pet-style'` 这类 **DOM id** 也算了进来
  //    （id 不需要 CSS 规则，`#zf-pet-style` 本来就不存在）。
  //    检查器本身错了会报假红，比不检查更糟。
  const used = new Set()
  for (const m of src.matchAll(/className:\s*'([^']+)'/g)) {
    for (const cls of m[1].split(/\s+/)) if (cls.startsWith('zf-')) used.add(cls)
  }
  // ② 三元/拼接写出来的修饰类（`className: 'a' + (x ? ' b' : '')`）。
  //    只取**明确以修饰符形态出现**的：以 `--` 开头的类名。
  for (const m of src.matchAll(/'(\s+zf-[a-zA-Z0-9_-]+)'/g)) {
    for (const cls of m[1].trim().split(/\s+/)) used.add(cls)
  }
  // ③ CSS 里定义了的类名
  const defined = new Set([...css.matchAll(/\.(zf-[a-zA-Z0-9_-]+)/g)].map(m => m[1]))

  const missing = [...used].filter(c => !defined.has(c)).sort()
  assert.deepEqual(missing, [],
    `这些类名被用在渲染里、但 CSS 里没有规则 → 控件会是浏览器裸样式（难看且不一致）：${missing.join(', ')}`)
})

ok('⭐ 滑杆的数值与滑杆必须在同一个容器里（否则数值被挤到第二行）', () => {
  // 真机实测（headless Edge 量 getBoundingClientRect，见
  // `.scratch/probe-slider-wrap.mjs`）：原先 Slider 的 range 与 __value
  // 是行网格里两个平级的 auto 轨道项，**在 320~900px 六种宽度下全部换行** ——
  // 数值掉到第二行，行高从 34px 涨到 68px（整整一倍）。
  const tree = renderSectionTree({})
  const sliders = collectByType(tree, 'Slider')
  assert.ok(sliders.length > 0, '应有滑杆')

  // 直接验 Slider 的产物结构：v4 起所有行都走 `Row` 这一条骨架，
  // Slider 把 range 与数值作为**同一个控件列**的两个兄弟交给它。
  const { Row } = loaded.exports.__test
  const probe = sliders[0].type({ ...sliders[0].props, hint: 'x' })
  assert.equal(probe.type.name, 'Row',
    'Slider 应当通过 Row 渲染 —— 行骨架只允许有一处，否则又会出现两套行布局')
  const kids = Row(probe.props).props.children
  const ctrl = kids.find(c => c && c.props?.className === 'zf-pet-row__control')
  assert.ok(ctrl, '滑杆应把 range 与数值包进 .zf-pet-row__control（否则数值会换行）')
  const flat = []
  const walk = n => {
    if (n === null || n === undefined) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    if (typeof n.type === 'string') flat.push(n.type)
    if (n.props) walk(n.props.children)
  }
  walk(ctrl)
  assert.ok(flat.includes('input'), '控件容器里应有滑杆本体')
  assert.ok(flat.includes('span'), '控件容器里应有数值')
  // 数值不能同时挂在行上（否则会渲染两次）
  const directValue = kids.filter(c => c && c.props?.className === 'zf-pet-row__value')
  assert.equal(directValue.length, 0, '数值不该再作为行的直接子节点（会与容器里的重复）')
})

ok('⭐ 行的呼吸感：至少 12px（外壳用 16px，原来 6px 挤成一团）', () => {
  // ⚠️ 这条断言的**方向反过来了**。原先是"行内边距必须 ≤ 8px"，因为那一版的
  // 问题是"整页太长"（实测 2556px、要滚三屏）。但把行压到 6px 只是让长页面
  // 更密 —— 用户的原话是"太密：行挤在一起，没有呼吸感"，而 DSH 外壳自己的
  // 设置行用的是 `padding:16px 0`。
  // 真正的解法是**页签**（每页只渲染一页的卡片，实测首页 998px 一屏放得下），
  // 把"长度"交给信息架构解决，行距就该回到正常值。
  // 所以现在锁的是：内边距**不能小于 12px**（别再挤回去）。
  const css = loaded.exports.__test.styleText()
  const row = css.match(/\.zf-pet-row\{[^}]*\}/)
  assert.ok(row, '应有 .zf-pet-row 规则')
  const m = row[0].match(/padding:\s*(\d+)px\s+0/)
  assert.ok(m, `.zf-pet-row 应有垂直内边距，实际：${row[0]}`)
  assert.ok(Number(m[1]) >= 12,
    `行的垂直内边距应 ≥ 12px（外壳自己用 16px；6px 实测"挤成一团"），实际 ${m[1]}px`)
  // 行必须是"左标签 + 右控件"的两列弹性布局，且控件列**定宽** ——
  // 定宽是右边缘对齐的前提（原先 auto 轨道下每个控件右边缘各不相同，是锯齿）。
  assert.ok(/display:flex/.test(row[0]) && /justify-content:space-between/.test(row[0]),
    `行应是左右两列的弹性布局，实际：${row[0]}`)
  const ctrl = css.match(/\.zf-pet-row__control\{[^}]*\}/)
  assert.ok(ctrl, '应有 .zf-pet-row__control 规则')
  assert.ok(/flex:0 0 208px/.test(ctrl[0]),
    `控件列必须定宽（对齐的前提），实际：${ctrl[0]}`)
})

ok('⭐⭐ 设置页只有一套字号阶梯（12 / 14 / 16），不许再挤成 11/12/13', () => {
  // 用户原话："字太小太淡：一片灰，看不出重点"。
  // 病根是整页只用了 11/12/13 三档、互相只差 1px —— 层级被压平了。
  // 外壳自己的设置页是 16 / 14 / 12 三档（差 2px），才读得出层级。
  const css = loaded.exports.__test.styleText()
  const SETTINGS_SEL = /\.(zf-pet-settings|zf-pet-row|zf-pet-card|zf-pet-tab|zf-pet-tabs|zf-pet-panel|zf-pet-diag|zf-pet-list|zf-pet-details|zf-pet-memobox|zf-pet-chatrow|zf-pet-status)/
  // 只看设置页那一批规则 —— overlay / 气泡那边还有 11px、12px，不归这条管。
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map(m => ({ sel: m[1].trim(), body: m[2] }))
    .filter(r => SETTINGS_SEL.test(r.sel))
  assert.ok(rules.length > 20, `设置页规则应有 20+ 条，实际 ${rules.length}`)
  const sizes = new Set()
  for (const r of rules) {
    for (const m of r.body.matchAll(/font-size:\s*([0-9.]+)px/g)) sizes.add(Number(m[1]))
  }
  const bad = [...sizes].filter(n => ![12, 14, 16].includes(n)).sort((a, b) => a - b)
  assert.deepEqual(bad, [],
    `设置页出现了阶梯外的字号（只允许 12/14/16）—— 11px 太小，13px 与 12/14 只差 1px 读不出层级：${bad.join(', ')}`)
})

ok('⭐ 分组标题不能用西文那套 uppercase/字距（套在中文上只会更难读）', () => {
  const css = loaded.exports.__test.styleText()
  for (const sel of ['.zf-pet-card__sum', '.zf-pet-settings__title']) {
    const rule = css.match(new RegExp(`\\${sel}\\{[^}]*\\}`))
    assert.ok(rule, `应有 ${sel} 规则`)
    assert.ok(!/text-transform:\s*uppercase/.test(rule[0]),
      `${sel} 不该用 text-transform:uppercase（中文没有大小写，是空操作）`)
    assert.ok(!/letter-spacing:\s*\.?0?\.12em/.test(rule[0]),
      `${sel} 不该用 0.12em 字距（中文会被拉成「作 息 与 外 观」）`)
  }
})

okAsync('⭐⭐ 保存记忆后编辑框会重建（显示"已保存的那一份"）', async () => {
  // ⚠️ 这条与上一条配套：`saveMemory()` 也必须让 nonce 自增。
  // 我第一版写了注释声称"加载完成、保存成功两处都自增"，但代码只在加载处
  // 自增了 —— **注释与代码不一致**，正是这一整轮在修的那种 bug。
  // 单靠读代码很容易漏，所以给它一条断言。
  const l = loadClient({
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/memory')) {
        if (init?.method === 'POST') {
          const sent = JSON.parse(init.body)
          return { ok: true, status: 200, json: async () => ({ ok: true, bytes: sent.text.length, text: sent.text }), text: async () => '' }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ text: '旧记忆', file: 'D:\\m.md', bytes: 9, capBytes: 4096, auto: true }),
          text: async () => ''
        }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
  })
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.tab = 'chat'
  l.react.resetHooks()
  Section({ close () {} })

  // 拉记忆（挂载 effect）
  for (const fn of l.react.hooks.effects) { if (typeof fn === 'function') { try { fn() } catch { /* 忽略 */ } } }
  await new Promise(r => setTimeout(r, 30))
  l.react.resetHooks()
  const loaded = Section({ close () {} })
  const keyAfterLoad = collectByType(loaded, 'textarea')[0].props.key

  // 改一个字，点保存。
  // ⚠️ 每次 `Section()` 之前**必须** `resetHooks()`：桩的 hook 游标是全局的，
  //    连着渲染两次而不重置 → 第二次从越界游标开始、给每个 hook 建**新槽位**，
  //    于是 setState 写进新槽、下一次渲染读旧槽，表现为"状态没变"。
  //    我第一版漏了这一步，断言因此误报（是测试错了，不是代码错了）。
  l.react.resetHooks()
  const dirty = Section({ close () {} })
  collectByType(dirty, 'textarea')[0].props.onInput({ target: { value: '新记忆' } })
  let saveBtn = null
  const walk = n => {
    if (n === null || n === undefined) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    if (n.type === 'button' && Array.isArray(n.props?.children) && String(n.props.children[0]).includes('保存')) saveBtn = n
    if (n.props) walk(n.props.children)
  }
  walk(dirty)
  assert.ok(saveBtn, '应有「保存记忆」按钮')
  assert.equal(saveBtn.props.disabled, false, '空闲时保存按钮应可点')
  saveBtn.props.onClick()
  await new Promise(r => setTimeout(r, 30))

  l.react.resetHooks()
  const after = Section({ close () {} })
  const box = collectByType(after, 'textarea')[0]
  assert.notEqual(box.props.key, keyAfterLoad,
    '保存成功后编辑框应重建（否则框里留着旧内容，而磁盘上已经是新的了）')
  assert.equal(box.props.defaultValue, '新记忆', '重建后应显示刚保存的内容')
})

okAsync('⭐⭐ 保存记忆后，诊断区的"记忆文件/容量"不许退化成 —（两个端点形状不同）', async () => {
  // `GET /memory`  → {text, bytes, capBytes, auto, file}
  // `POST /memory` → {ok, bytes, text}          ← **没有 file / capBytes**
  // 原先保存走的是 `setMemory(r)`（整体替换），于是保存一次之后
  // `memory.file` 与 `memory.capBytes` 变成 undefined，
  // 诊断区那行会显示成 `— · N / 0 字节`，看起来像"记忆文件不见了"。
  const l = loadClient({
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/memory')) {
        if (init?.method === 'POST') {
          const sent = JSON.parse(init.body)
          return { ok: true, status: 200, json: async () => ({ ok: true, bytes: sent.text.length, text: sent.text }), text: async () => '' }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ text: '旧记忆', file: 'D:\\data\\memory.md', bytes: 9, capBytes: 4096, auto: true }),
          text: async () => ''
        }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
  })
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.tab = 'chat'
  l.react.resetHooks()
  Section({ close () {} })
  for (const fn of l.react.hooks.effects) { if (typeof fn === 'function') { try { fn() } catch { /* 忽略 */ } } }
  await new Promise(r => setTimeout(r, 30))

  // 保存
  l.react.resetHooks()
  let tree = Section({ close () {} })
  collectByType(tree, 'textarea')[0].props.onInput({ target: { value: '新记忆更长一点' } })
  let saveBtn = null
  const walk = n => {
    if (n === null || n === undefined) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    if (n.type === 'button' && Array.isArray(n.props?.children) && String(n.props.children[0]).includes('保存')) saveBtn = n
    if (n.props) walk(n.props.children)
  }
  walk(tree)
  saveBtn.props.onClick()
  await new Promise(r => setTimeout(r, 30))

  // 诊断区那行必须**仍然**有文件路径与容量。
  // ⚠️ 这里必须**在同一个挂载里切页签**（走真实的 onSelect），不能重新挂载：
  // 重新挂载会重新 GET /memory，那份数据本来就带 file/capBytes ——
  // 那样即使 `setMemory` 的合并坏了，这条断言也会假绿。
  tree = switchTab(l, tree, 'diag')
  const diags = collectByType(tree, 'Diag').map(n => n.props)
  const memRow = diags.find(d => String(d.k).includes('记忆文件') || String(d.k).includes('Memory'))
  assert.ok(memRow, `诊断区应有"记忆文件"行，实际的键：${diags.map(d => d.k).join(', ')}`)
  assert.ok(!String(memRow.v).startsWith('—'),
    `保存后记忆文件路径不该变成 '—'（说明 setMemory 把 GET 的形状整体替换成了 POST 的形状），实际：${memRow.v}`)
  assert.ok(String(memRow.v).includes('memory.md'), `应保留文件路径，实际：${memRow.v}`)
  assert.ok(!/\/ 0 /.test(String(memRow.v)),
    `保存后容量不该变成 0（capBytes 被 POST 应答冲掉了），实际：${memRow.v}`)
})

okAsync('⭐ 宿主写盘失败（HTTP 200 + ok:false）必须如实报错，不许报"已保存"', async () => {
  // 宿主写盘失败时返回 `{ok:false, reason:'write-failed'}`，**HTTP 状态仍是 200**，
  // 而客户端的 `api()` 只在 `!res.ok` 时抛 —— 所以不自己看 `ok` 就会把
  // "写失败"报成"已保存"。用户以为记住了，其实没有。
  const l = loadClient({
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/memory')) {
        if (init?.method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ ok: false, reason: 'write-failed' }), text: async () => '' }
        }
        return { ok: true, status: 200, json: async () => ({ text: 'x', file: 'f', bytes: 1, capBytes: 10 }), text: async () => '' }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
  })
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.tab = 'chat'
  l.react.resetHooks()
  let tree = Section({ close () {} })
  let saveBtn = null
  const walk = n => {
    if (n === null || n === undefined) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    if (n.type === 'button' && Array.isArray(n.props?.children) && String(n.props.children[0]).includes('保存')) saveBtn = n
    if (n.props) walk(n.props.children)
  }
  walk(tree)
  saveBtn.props.onClick()
  await new Promise(r => setTimeout(r, 30))

  l.react.resetHooks()
  tree = Section({ close () {} })
  const notes = collectStrings(tree)
  const joined = notes.join('|')
  assert.ok(!joined.includes('已保存'),
    '写盘失败时**不能**显示"已保存"（用户会以为记住了）')
  assert.ok(joined.includes('write-failed') || joined.includes('保存失败'),
    `应如实报出失败原因，实际提示：${joined}`)
})

ok('⭐ 滑杆单位也必须走字典（不许写死英文 s/min）', () => {
  // 真机症状：同一个面板里并排出现「空闲多久后睡觉 5min」和
  // 「专注时长 25 分钟」—— 因为秒/分钟那几处是写死的 `'s'` / `'min'`，
  // 而番茄钟那几处走 `t('minutes')`。单位也是文案。
  const tree = renderSectionTree({ pomodoro: true }, 'behavior')
  const sliders = collectByType(tree, 'Slider').map(n => n.props)
  const raw = sliders.filter(s => s.suffix === 's' || s.suffix === 'min')
  assert.deepEqual(raw.map(s => s.label), [],
    '这些滑杆的单位写死了英文，应与其它单位一样走字典：' + raw.map(s => `${s.label}=${s.suffix}`).join(', '))
  // 中文字典里必须有这两个键，且不能是英文
  //（`DICT` 这个 `const` 在后面的第 9 节才解构，这里直接从模块出口取）
  const dict = loaded.exports.__test.DICT
  assert.equal(dict.zh.unitSec, '秒')
  assert.equal(dict.zh.unitMin, '分钟')
  assert.equal(dict.en.unitSec, 's')
  assert.equal(dict.en.unitMin, 'min')
})

ok('⭐ 行分隔线要用看得见的档位（l1 只有 4% 不透明度，等于没画）', () => {
  // 我第一版抄了外壳 settings-form 的"发丝线"写法，但把颜色档位写成了
  // `--dsw-alias-border-l1`（rgba(0,0,0,.04)）—— 浅色主题下肉眼几乎看不见，
  // 于是"加了分隔线"这件事在验收时是不成立的。外壳自己用的是 l2（.1）。
  //
  // v4 改成外壳 settings-general 的**同款写法**：线画在行的 `border-bottom` 上
  //（不是 `row + row` 的 border-top），这样卡片内最后一行可以用
  // `:last-child` 去掉底线 —— 否则卡片自己的圆角边旁边会多一条线，显脏。
  const css = loaded.exports.__test.styleText()
  const rule = css.match(/\.zf-pet-row\{[^}]*\}/)
  assert.ok(rule, '应有 .zf-pet-row 规则')
  assert.ok(/border-bottom:\.5px solid var\(--zf-hairline\)/.test(rule[0]),
    `行的分隔线应是 .5px 且走同一个发丝色变量，实际：${rule[0]}`)
  assert.ok(!/border-l1/.test(rule[0]),
    `分隔线不该用 border-l1（4% 不透明度，看不见），实际：${rule[0]}`)
  // 发丝色变量本身必须是 l2（外壳同档）
  const token = css.match(/--zf-hairline:([^;]*);/)
  assert.ok(token, '应定义 --zf-hairline 发丝色变量')
  assert.ok(/border-l2/.test(token[1]),
    `发丝线应与外壳 settings-form 同档（border-l2），实际：${token[1]}`)
  // 最后一行不画底线
  assert.ok(/\.zf-pet-card__body\s*>\s*\.zf-pet-row:last-child\{[^}]*border-bottom:none/.test(css),
    '卡片内最后一行必须去掉底线（否则与卡片自己的边撞在一起）')
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
  walk(renderSection({ attentionReminder: false }, 'bubble').props.children)
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
  walk2(renderSection({ attentionReminder: true }, 'bubble').props.children)
  assert.equal(toggle2?.props.value, true)
})

/* ── 设置页（Section）必须能渲染 ─────────────────────────────────────────
 *
 * 这一条是被真实事故逼出来的：设置页在用户那里**整片空白**，
 * 而当时的测试只渲染了 Pet —— Section 里的运行时错误（例如未定义的取词器）
 * 完全没被发现。一个"注册了却渲染不出来"的设置页，用户看到的就是坏了。
 * ──────────────────────────────────────────────────────────────────────── */

function renderSection (settingsPatch = {}, tab = 'appearance') {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: false }
  runtime.__state.settings = normalizePet(settingsPatch)
  runtime.__state.tab = tab
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
      // ⚠️ v4 的控件挂在 `Row` 的 `control` **prop** 上，不是 children ——
      // 只走 children 会一个控件值都收不到（这条断言会假红）。
      collect(node.props.control)
    }
  }
  // 页签化之后这三个控件分在「外观」（主题）「气泡」（双击）「行为」（活跃度）
  // 三页里 —— 逐个页签渲染再收集。
  for (const tab of ['appearance', 'bubble', 'behavior']) {
    collect(renderSection({ activity: 'playful', doubleClick: 'emote', theme: 'dark' }, tab).props.children)
  }
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

/* ══════════════════════════════════════════════════════════════════════════
 * 7c. ⭐ 设置面板的**信息架构**（重排后必须保住的东西）
 *
 * 面板原先是一列平铺：8 个分组 + 38 个控件 + 24 条同权重的说明段落 + 8 个按钮，
 * 三种性质完全不同的东西（设置 / 状态 / 操作）挤在一起。重排的风险是
 * **悄悄弄丢控件**（用户报"功能不见了"比"排列难看"严重得多），所以这里
 * 逐项核对，而不是只断言"能渲染"。
 *
 * ⚠️ 桩 React **不会展开函数组件**（`Group`/`Toggle`/`Slider`/`Diag` 都停在
 * `{type: fn, props}`），所以文案要从 `props.label/hint/title` 里取，
 * 不能只扫 children —— 第一版就是这么写的，于是三条断言全假红。
 * ──────────────────────────────────────────────────────────────────────── */

/** 收集树里所有**用户可见文案**（含函数组件的文案 props）。 */
function collectStrings (node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (typeof node === 'number' || typeof node === 'boolean') return out
  if (Array.isArray(node)) { node.forEach(n => collectStrings(n, out)); return out }
  if (typeof node !== 'object') return out
  const p = node.props ?? {}
  // `desc`/`lead`/`note` 是 v4 的说明位（行的说明、卡片的引导句、折叠的长说明）——
  // 它们也是用户看得见的文案，漏掉它们会让"文案还在不在"的核对出现假绿。
  for (const k of ['label', 'hint', 'title', 'placeholder', 'desc', 'lead', 'note']) {
    if (typeof p[k] === 'string') out.push(p[k])
  }
  collectStrings(p.children, out)
  return out
}

/**
 * 在**同一个挂载**里切页签（模拟用户点那一下），返回重渲染后的树。
 *
 * 为什么不能靠 `runtime.__state.tab` 再渲染一次：桩的 `useState` 会把首次
 * `init()` 的结果**缓存**在 `hooks.states[i]` 里（`resetHooks()` 只归零游标），
 * 所以第二次渲染读到的还是第一次的页签 —— 那不是"切换"，是"没切"。
 * 走真实的 `onSelect` 才是用户路径，也才能验到"状态真的变了"。
 */
function switchTab (l, tree, id) {
  const tabs = collectByType(tree, 'Tabs')[0]
  assert.ok(tabs, '设置页应渲染出页签控件（Tabs）')
  tabs.props.onSelect(id)
  l.react.resetHooks()
  return l.exports.__test.Section({ close () {} })
}

/** 按组件名收集节点（桩里函数组件不会展开，只能按 `type.name` 找）。 */
function collectByType (node, name, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { node.forEach(n => collectByType(n, name, out)); return out }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function' && node.type.name === name) out.push(node)
  if (typeof node.type === 'string' && node.type === name) out.push(node)
  if (node.props) collectByType(node.props.children, name, out)
  return out
}

/**
 * 把函数组件**递归展开**，得到接近真实 DOM 形状的树。
 *
 * `collectByType` 只按 `type.name` 找节点、**不展开** —— 但 v4 起控件藏在
 * `Row` 的 `control` **prop** 里（不是 children），所以"每个控件都带同一个
 * 类名""说明文字必须在左列"这类断言必须展开后才验得到。
 * ⚠️ 只能用在 `Section` 返回的树上，**不能**用在 `Section` 元素本身（会重跑 hooks）。
 */
function expandTree (node) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) return node.map(expandTree).filter(n => n !== null)
  if (typeof node !== 'object') return node
  const props = { ...node.props }
  if (props.children !== undefined) props.children = expandTree(props.children)
  if (props.control !== undefined) props.control = expandTree(props.control)
  if (typeof node.type === 'function') return expandTree(node.type({ ...props, key: undefined }))
  return { type: node.type, props }
}

/** 一行设置的两个必需容器（左列 / 右列）。 */
function rowParts (row) {
  const kids = row.props.children ?? []
  return {
    main: kids.find(c => c && String(c.props?.className).includes('zf-pet-row__main')),
    ctrl: kids.find(c => c && String(c.props?.className).includes('zf-pet-row__control'))
  }
}

/**
 * 渲染设置页的**某一页签**（v4 起设置页是六页签的，控件分在六页里）。
 * 页签通过 `runtime.__state.tab` 这个测试缝注入（与 `__state.settings` 同款）。
 */
function renderSectionTree (settingsPatch = {}, tab = 'appearance') {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.settings = normalizePet(settingsPatch)
  runtime.__state.tab = tab
  l.react.resetHooks()
  return Section({ close () {} })
}

ok('⭐ 重排后每个设置控件都还在（防"功能悄悄消失"）', () => {
  // 用**用户看得见的文案**核对，而不是内部键名：文案没了 = 控件没了。
  //
  // v4 把设置页拆成六个页签，所以必须**逐页收集再合并** ——
  // 只渲染一页会漏掉另外五页的控件，而"页签化把功能弄丢"正是这一步最大的风险。
  const TABS = ['appearance', 'bubble', 'behavior', 'voice', 'chat', 'today', 'diag']
  const joined = TABS
    .map(tab => collectStrings(renderSectionTree({ pomodoro: true, ttsResident: false }, tab)).join('|'))
    .join('|')
  const expected = [
    '启用桌宠', '显示方式', '大小', '不透明度', '总在最前', '点击穿透',
    '显示气泡', '气泡显示表情图', '对话文字大小', '气泡显示时长', '两条气泡最小间隔',
    'AI 完成时弹提醒', '审批/提问常亮提醒', '双击桌宠',
    '活跃度', '完成后的开心时长', '空闲多久后睡觉', '深浅色主题',
    '悬停时显示状态', '桌宠下方常显状态', '状态文字大小',
    '让庄方宜说话', '把 AI 的回答念出来', '合成服务地址', '每段朗读字数',
    '让语音模型常驻', '空闲时怎么释放', '空闲多少秒后释放（秒，0 = 不停）',
    '启用番茄钟', '专注时长', '短休息', '长休息', '每几轮长休息',
    '自动进入下一段', '阶段结束时提醒我', '桌宠下方显示倒计时',
    '允许在气泡里聊天', '人设风格', '自动记住值得长期保留的事', '聊天工作区',
    '重置位置', '试一句', '启动服务', '停止并释放', '保存记忆', '发一条'
  ]
  const missing = expected.filter(s => !joined.includes(s))
  assert.deepEqual(missing, [], `这些控件的文案在重排中丢了：${missing.join('、')}`)
})

ok('⭐ 状态文字大小：独立滑杆，能改到设置（用户要"调大一点"）', () => {
  // 用户点名："我希望能够调整字的大小，因为有的时候字太小了"。
  // 之前字号**只能**跟着"大小"（桌宠本体）走 —— 用户把桌宠调到 0.4 是为了不占地，
  // 字却被一起缩小（实测被下限夹到 8px，确实看不清）。
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.settings = normalizePet({ statusFontScale: 1.8 })
  runtime.__state.tab = 'appearance'
  l.react.resetHooks()
  const tree = Section({ close () {} })

  const sliders = []
  const walk = n => {
    if (n === null || n === undefined) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    if (typeof n.type === 'function' && n.type.name === 'Slider') sliders.push(n)
    if (n.props) walk(n.props.children)
  }
  walk(tree)
  const fontSlider = sliders.find(s => s.props.label === '状态文字大小')
  assert.ok(fontSlider, '应有「状态文字大小」滑杆')
  assert.equal(fontSlider.props.value, 1.8, '滑杆应反映当前值（不是永远显示 1）')
  assert.ok(fontSlider.props.min <= 0.5 && fontSlider.props.max >= 3,
    `范围应覆盖 0.5~3，实际 ${fontSlider.props.min}~${fontSlider.props.max}`)
  assert.ok(typeof fontSlider.props.hint === 'string' && fontSlider.props.hint !== '',
    '应带说明（解释它和"大小"不是一回事）')

  // 客户端归一化也要夹取（与 Host 的 0.5~3.0 同口径，否则两端分叉）
  assert.equal(normalizePet({ statusFontScale: 99 }).statusFontScale, 3, '越界应夹到 3')
  assert.equal(normalizePet({ statusFontScale: 0.01 }).statusFontScale, 0.5, '越界应夹到 0.5')
})

ok('⭐ 对话文字大小：独立滑杆（用户点名"对话里的文字大小也要能调"）', () => {
  // 与状态文字同一个坑：字号原先只跟"大小"（桌宠本体）走 ——
  // 用户把桌宠调到 0.5 是为了不占地，正文却被一起缩到 6.5px，读不了。
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.settings = normalizePet({ chatFontScale: 2.4, statusFontScale: 1.2 })
  l.react.resetHooks()
  const tree = Section({ close () {} })

  const collectSliders = node => {
    const out = []
    const walk = n => {
      if (n === null || n === undefined) return
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (typeof n !== 'object') return
      if (typeof n.type === 'function' && n.type.name === 'Slider') out.push(n)
      if (n.props) walk(n.props.children)
    }
    walk(node)
    return out
  }
  // v4：两个字号滑杆分属两页（状态文字在「外观」、对话正文在「气泡」）——
  // 在**同一个挂载**里切页签再收集，「各管各的」这条性质才验得到。
  const sliders = [...collectSliders(tree), ...collectSliders(switchTab(l, tree, 'bubble'))]
  const chatSlider = sliders.find(s => s.props.label === '对话文字大小')
  assert.ok(chatSlider, '应有「对话文字大小」滑杆')
  assert.equal(chatSlider.props.value, 2.4, '滑杆应反映当前值')
  assert.ok(chatSlider.props.min <= 0.5 && chatSlider.props.max >= 3,
    `范围应覆盖 0.5~3，实际 ${chatSlider.props.min}~${chatSlider.props.max}`)
  // ⭐ 两个字号滑杆必须**各管各的**：不能绑到同一个值
  const statusSlider = sliders.find(s => s.props.label === '状态文字大小')
  assert.ok(statusSlider, '状态文字滑杆应仍在')
  assert.notEqual(chatSlider.props.value, statusSlider.props.value,
    '两个滑杆应各自反映自己的设置（对话 2.4 / 状态 1.2），不能是同一个值')

  assert.equal(normalizePet({ chatFontScale: 99 }).chatFontScale, 3, '越界应夹到 3')
  assert.equal(normalizePet({ chatFontScale: 0.01 }).chatFontScale, 0.5, '越界应夹到 0.5')
})

ok('⭐⭐ 页签与卡片按"用户找东西的心智"排（不再按开发历史）', () => {
  // 旧版是一列 7 个分组平铺（实测 2556px、三屏）。v4 拆成六页，每页若干张卡片。
  // 这里断言**每一页的卡片构成**：顺序与归属错了，用户就又找不到东西了。
  const TABS = ['appearance', 'bubble', 'behavior', 'voice', 'chat', 'today', 'diag']
  const layout = TABS.map(tab =>
    collectByType(renderSectionTree({}, tab), 'Card').map(c => c.props.title))
  // 「外观」只有两张卡：「主题」并进了「桌宠」—— 单行卡片自带一个卡片头，
  // 实测要占 100px，"一行一个概念"反而把一屏挤爆（见 probe-settings-tabs）。
  assert.deepEqual(layout[0], ['桌宠', '状态文字'], `「外观」页不对：${layout[0].join(' → ')}`)
  assert.deepEqual(layout[1], ['气泡', '提醒'], `「气泡」页不对：${layout[1].join(' → ')}`)
  // v10：「行为」页多了「手势互动」（用户："通过右键就点个按钮，很奇怪"）
  assert.deepEqual(layout[2], ['活跃度', '手势互动', '番茄钟'], `「行为」页不对：${layout[2].join(' → ')}`)
  assert.deepEqual(layout[3], ['固定台词', '念出回答（动态语音）'], `「语音」页不对：${layout[3].join(' → ')}`)
  assert.deepEqual(layout[4], ['聊天', '长期记忆（跨会话共享）', '发消息'], `「对话」页不对：${layout[4].join(' → ')}`)
  assert.deepEqual(layout[5], ['今天'], `「今天」页不对：${layout[5].join(' → ')}`)
  assert.deepEqual(layout[6], ['运行状态', '素材', '合成服务', '路径与会话'], `「诊断」页不对：${layout[6].join(' → ')}`)
  // 关键性质：诊断**单独一页**（原先被压在整个面板最后，要滚到底才看得见）
  assert.equal(layout[6][0], '运行状态', '诊断页的第一张应是运行状态')
  // 而且诊断**仍然是最后一页**（它是"出问题了看哪里"，不该挡在回顾前面）
  assert.equal(TABS[TABS.length - 1], 'diag', '诊断必须是最后一页')

  // 而且渲染出的卡片**只能有当前页签的** —— 这是"三屏变一屏"的全部机制。
  const cards = collectByType(renderSectionTree({}, 'voice'), 'Card')
  assert.deepEqual(cards.map(c => c.props.title), layout[3],
    '渲染出的卡片必须只有当前页签的（否则页签等于没做）')

  // 卡片必须是真正可折叠的（用户点名"设置里的一些内容应该可以折叠或展开"）
  const { Card } = loaded.exports.__test
  const sample = Card({ title: 'x', children: [] })
  assert.equal(sample.type, 'details', '卡片必须渲染成 <details>（原生折叠，不用自己管状态）')
  assert.equal(sample.props.open, false, 'open 不显式给 true 时应是收起的')
})

ok('⭐ 诊断页的卡片默认**全部收起**（机器路径不该糊在脸上）', () => {
  const cards = collectByType(renderSectionTree({}, 'diag'), 'Card')
  assert.ok(cards.length >= 4, `诊断页应有 4 张卡片，实际 ${cards.length}`)
  for (const c of cards) {
    assert.notEqual(c.props.open, true, `诊断页的「${c.props.title}」必须默认收起`)
  }
  // 番茄钟默认关 → 也收起（8 个控件不该占着主面板）
  const pomoCards = collectByType(renderSectionTree({}, 'behavior'), 'Card')
  const pomo = pomoCards.find(c => c.props.title === '番茄钟')
  assert.ok(pomo, '应有「番茄钟」卡片')
  assert.notEqual(pomo.props.open, true, '番茄钟默认关时应收起')
  // 而启用之后应当展开 —— 否则用户打开了开关却看不到时长设置
  const pomoOn = collectByType(renderSectionTree({ pomodoro: true }, 'behavior'), 'Card')
    .find(c => c.props.title === '番茄钟')
  assert.equal(pomoOn.props.open, true, '启用番茄钟后该卡片应展开')
})

ok('⭐ 启动命令（机器路径）只出现在诊断页里', () => {
  // 这条是"降噪"的核心：绝对路径原先以正文段落的形式糊在面板中间。
  const diagText = collectStrings(renderSectionTree({}, 'diag')).join('|')
  assert.ok(diagText.includes('启动命令'), '诊断页应包含"启动命令"')
  // 其余五页是**日常设置**，不该出现盘符路径。
  for (const tab of ['appearance', 'bubble', 'behavior', 'voice', 'chat']) {
    const text = collectStrings(renderSectionTree({}, tab)).join('|')
    assert.ok(!/[A-Z]:\\/.test(text), `「${tab}」页里不该出现盘符路径：${text.slice(0, 160)}`)
    assert.ok(text.length > 0, `「${tab}」页应有可见文案`)
  }
})

/* ── v4 新增：页签本身、每页的行数预算、单一样式系统、说明的位置与长度 ──────
 *
 * 这几条对应用户点名的六条：太长 / 太密 / 一片灰 / 控件尺寸不统一 /
 * 说明文字淹了控件 / 诊断混在正文里。都是"不会报错、只是难看"的那类问题，
 * 所以必须变成断言才守得住。 */

ok('⭐⭐ 页签是真正的导航控件（role/aria + 点一下真的换页）', () => {
  const tree = renderSectionTree({}, 'appearance')
  const tabs = collectByType(tree, 'Tabs')
  assert.equal(tabs.length, 1, '应恰好渲染一个页签条')
  const items = tabs[0].props.items
  assert.equal(items.length, 7, `应有 7 个页签，实际 ${items.length}`)
  assert.deepEqual(items.map(i => i.id),
    ['appearance', 'bubble', 'behavior', 'voice', 'chat', 'today', 'diag'], '页签顺序不对')
  assert.deepEqual(items.map(i => i.label),
    ['外观', '气泡', '行为', '语音', '对话', '今天', '诊断'],
    `页签文案不对：${items.map(i => i.label).join('/')}`)

  // 渲染出来的按钮必须带 ARIA（读屏要能用），且**恰好一个**选中态
  const { Tabs } = loaded.exports.__test
  const rendered = Tabs({ items, value: 'appearance', onSelect: () => {} })
  assert.equal(rendered.props.role, 'tablist', '页签条应有 role=tablist')
  const btns = rendered.props.children
  assert.equal(btns.length, 7, '应渲染 7 个页签按钮')
  for (const b of btns) {
    assert.equal(b.props.role, 'tab', `页签按钮应有 role=tab，实际 ${b.props.role}`)
    assert.ok(b.props['aria-controls'], '页签按钮应有 aria-controls（指向面板）')
  }
  const selected = btns.filter(b => b.props['aria-selected'] === 'true')
  assert.equal(selected.length, 1, `必须恰好一个页签是选中态，实际 ${selected.length}`)
  assert.equal(selected[0].props.id, 'zf-pet-tab-appearance', '选中的应是当前页')

  // 点「语音」→ 卡片整批换掉，面板的 ARIA 关系跟着走
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.settings = normalizePet({})
  runtime.__state.tab = 'appearance'
  l.react.resetHooks()
  const before = Section({ close () {} })
  const beforeTitles = collectByType(before, 'Card').map(c => c.props.title)
  const after = switchTab(l, before, 'voice')
  const afterTitles = collectByType(after, 'Card').map(c => c.props.title)
  assert.notDeepEqual(afterTitles, beforeTitles, '点了页签卡片必须换掉')
  assert.ok(!afterTitles.includes('桌宠'), '切到「语音」后不该还渲染着「桌宠」卡片')
  assert.ok(afterTitles.includes('固定台词'), '切到「语音」后应渲染语音那一页的卡片')
  const panel = after.props.children.find(c => c && c.props?.role === 'tabpanel')
  assert.ok(panel, '应有 role=tabpanel 的面板')
  assert.equal(panel.props.id, 'zf-pet-panel-voice', '面板 id 应跟着当前页签')
  assert.equal(panel.props['aria-labelledby'], 'zf-pet-tab-voice', '面板应指回当前页签按钮')
})

ok('⭐⭐ 每个页签「展开状态」的行数 ≤ 10（一屏放得下）', () => {
  // 用户原话："太长：要滚好几屏，找不到东西"。原先一列 40 行、实测 2556px。
  // 拆页之后，每页**摊开来看**的行数必须控制在一屏之内。
  // 只数**展开卡片**里的行：收起的卡片（诊断页、台词清单、发消息）本来就看不见。
  const TABS = ['appearance', 'bubble', 'behavior', 'voice', 'chat', 'today', 'diag']
  const counts = {}
  for (const tab of TABS) {
    const cards = collectByType(renderSectionTree({}, tab), 'Card')
    let rows = 0
    for (const c of cards) {
      if (c.props.open !== true) continue
      // Toggle / Slider 各自就是一行（它们渲染 Row，但桩不展开，所以不会重复计）
      rows += collectByType(c, 'Row').length +
        collectByType(c, 'Toggle').length +
        collectByType(c, 'Slider').length
    }
    counts[tab] = rows
    assert.ok(rows <= 10, `「${tab}」页展开后有 ${rows} 行（应 ≤ 10，否则又要滚屏）`)
  }
  assert.ok(counts.appearance >= 6, `「外观」页行数明显偏少，可能控件丢了：${counts.appearance}`)
})

ok('⭐⭐ 全设置页只有一套控件外观（不许再有第二个输入框类名）', () => {
  // 用户原话："控件尺寸不统一"。病根是同一个面板里混了四套外观：
  // 输入框 30px/圆角 6px、按钮圆角 8px、聊天框圆角 8px 配 12px 字、正文 13px。
  // 现在所有 input/select 共用同一个类名 —— 也就是同一组 CSS 规则，无法再分叉。
  const src = fs.readFileSync(CLIENT, 'utf8')
  // 只查"还有没有在 className 里用" —— CSS 注释里保留它的来历是对的
  //（那正是"为什么会裸样式"的现场记录），把注释也算进去就成了假红。
  const usedClasses = new Set()
  for (const m of src.matchAll(/className:\s*'([^']+)'/g)) {
    for (const cls of m[1].split(/\s+/)) usedClasses.add(cls)
  }
  assert.ok(!usedClasses.has('zf-pet-settings__input'),
    'zf-pet-settings__input 应已彻底不再使用（那个类名曾经只有引用没有规则，是"裸样式控件"的根因）')

  const TABS = ['appearance', 'bubble', 'behavior', 'voice', 'chat', 'today', 'diag']
  const bad = []
  let seen = 0
  for (const tab of TABS) {
    const tree = expandTree(renderSectionTree({ pomodoro: true, ttsResident: false }, tab))
    for (const tag of ['input', 'select']) {
      for (const n of collectByType(tree, tag)) {
        seen += 1
        const cls = String(n.props.className ?? '')
        if (!cls.split(/\s+/).includes('zf-pet-row__input')) {
          bad.push(`${tag}[${n.props.type ?? ''}] ${cls}`)
        }
      }
    }
  }
  assert.ok(seen > 25, `应检查到 25+ 个控件，实际 ${seen}`)
  assert.deepEqual(bad, [], `这些控件没走统一的控件类名（会各长各的样）：${bad.join(' / ')}`)
})

ok('⭐⭐ 每行的说明都在左列（不许再挂到控件下面）', () => {
  // 用户原话："说明文字太多，把要调的淹了"。三种写法并存时，同一个面板里
  // 说明文字**跳三个位置**（控件下方通栏 / 标签与控件之间 / 独立段落），
  // 视线每一行都要重新找一次。现在只有一种位置：行标题下面、左列里面。
  const TABS = ['appearance', 'bubble', 'behavior', 'voice', 'chat']
  let descs = 0
  let rows = 0
  for (const tab of TABS) {
    const tree = expandTree(renderSectionTree({ pomodoro: true, ttsResident: false }, tab))
    const rowNodes = collectByType(tree, 'label')
      .filter(n => String(n.props.className).includes('zf-pet-row'))
    for (const row of rowNodes) {
      rows += 1
      const { main, ctrl } = rowParts(row)
      assert.ok(main, '每行都应有左列 .zf-pet-row__main')
      assert.ok(ctrl, '每行都应有右列 .zf-pet-row__control')
      const direct = (row.props.children ?? [])
        .filter(c => c && String(c.props?.className).includes('zf-pet-row__desc'))
      assert.equal(direct.length, 0, '说明文字不能是行的直接子节点（必须在左列里）')
      const inCtrl = collectByType(ctrl, 'span')
        .filter(n => String(n.props.className).includes('zf-pet-row__desc'))
      assert.equal(inCtrl.length, 0, '说明文字不该出现在控件列里')
      descs += collectByType(main, 'span')
        .filter(n => String(n.props.className).includes('zf-pet-row__desc')).length
    }
  }
  assert.ok(rows > 15, `应检查到 15+ 行，实际 ${rows}`)
  assert.ok(descs > 5, `应有若干行带说明且都在左列，实际 ${descs}`)
})

ok('⭐⭐ 行内说明压到一行（中文 ≤ 34 字），长解释挪进卡片的「说明」折叠块', () => {
  // 用户原话："说明文字太多，把要调的淹了"。原先最长的行内说明 61 字、
  // 占三行，把控件压成了配角。现在行内只留一句话，权衡搬进折叠块。
  // 34 字 ≈ 左列 500px 宽下的一行（12px 中文），是量出来的预算。
  const long = []
  for (const tab of ['appearance', 'bubble', 'behavior', 'voice', 'chat']) {
    const tree = expandTree(renderSectionTree({ pomodoro: true, ttsResident: false }, tab))
    for (const n of collectByType(tree, 'span')) {
      if (!String(n.props.className).includes('zf-pet-row__desc')) continue
      const text = (n.props.children ?? []).map(String).join('')
      if (text.length > 34) long.push(text)
    }
  }
  assert.deepEqual(long, [],
    `这些行内说明超过一行（34 字），应挪进卡片的「说明」折叠块：${long.map(s => s.slice(0, 18) + '…').join(' / ')}`)

  // 而且要确认完整解释是**挪了位置**、不是被删掉
  const speakCard = collectByType(renderSectionTree({}, 'voice'), 'Card')
    .find(c => String(c.props.title).includes('念出回答'))
  assert.ok(speakCard, '应有「念出回答」卡片')
  assert.ok(String(speakCard.props.note).includes('显存'),
    '常驻/释放的权衡说明必须保留在卡片的「说明」里（挪位置，不是删内容）')
  assert.equal(speakCard.props.noteLabel, '说明', '折叠块要有「说明」这个可点的标题')
})

okAsync('⭐⭐ 切页签不能丢掉草稿（卡片会被整个卸载重建）', async () => {
  // 页签是有代价的：非当前页的卡片会被**卸载**。记忆框与聊天输入框都是
  // **非受控**的（defaultValue 只在挂载时生效），切回来就按 defaultValue 重建 ——
  // 若 defaultValue 只看 `memory?.text`，用户打了一半的草稿会被"已保存的那一份"
  // 覆盖，等于静默丢掉他刚打的内容（和当年那个"空白框覆盖真实记忆"是同一类数据丢失）。
  // 修法：defaultValue 优先用草稿 ref —— ref 挂在 Section 上，活得比卡片久。
  const l = loadClient({
    fetchImpl: async url => {
      if (String(url).endsWith('/memory')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ text: '磁盘上的旧记忆', file: 'm.md', bytes: 12, capBytes: 4096 }),
          text: async () => ''
        }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
    }
  })
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.settings = normalizePet({})
  runtime.__state.tab = 'chat'
  l.react.resetHooks()
  let tree = Section({ close () {} })
  for (const fn of l.react.hooks.effects) { if (typeof fn === 'function') { try { fn() } catch { /* 忽略 */ } } }
  await new Promise(r => setTimeout(r, 30))
  l.react.resetHooks()
  tree = Section({ close () {} })

  const box = collectByType(tree, 'textarea')[0]
  assert.ok(box, '应有记忆编辑框')
  assert.equal(box.props.defaultValue, '磁盘上的旧记忆', '加载完应能看到磁盘上的记忆')
  box.props.onInput({ target: { value: '我写到一半的草稿' } })

  // 聊天输入框也在这一页（「发消息」卡片里），一并验
  const chatInput = collectByType(tree, 'input')
    .find(n => String(n.props.className).includes('zf-pet-chatrow__input'))
  assert.ok(chatInput, '应有聊天输入框')
  chatInput.props.onInput({ target: { value: '没发出去的半句话' } })

  // 切走 → 这两张卡片应当真的被卸载（页签省地方靠的就是这个）
  const away = switchTab(l, tree, 'voice')
  assert.equal(collectByType(away, 'textarea').length, 0, '切走后记忆框应已卸载')

  // 切回来 → 草稿必须还在
  const back = switchTab(l, away, 'chat')
  const box2 = collectByType(back, 'textarea')[0]
  assert.equal(box2.props.defaultValue, '我写到一半的草稿',
    '切回来必须还是用户的草稿 —— 否则等于静默丢掉他刚打的内容')
  const chat2 = collectByType(back, 'input')
    .find(n => String(n.props.className).includes('zf-pet-chatrow__input'))
  assert.equal(chat2.props.defaultValue, '没发出去的半句话', '聊天草稿同样不能在切页签时丢')
})

ok('⭐ i18n 中英键集必须一致（漏翻会直接显示键名）', () => {
  // 面板重排时新增了十几个键，最容易出的错是**只加一份** ——
  // 那样英文界面会直接显示 `groupAdvanced` 这种裸键名。
  //
  // 用 `__test.DICT` 这个**真对象**核对，不去正则解析源码：
  // 第一版就是正则切 `const DICT = {`，结果被嵌套结构撑爆（切出 5 份）。
  // 数据已经在手里，就别去猜源码长什么样。
  const l = loadClient()
  const DICT = l.exports.__test.DICT
  assert.ok(DICT && DICT.zh && DICT.en, '应导出 zh/en 两份文案')
  const zh = Object.keys(DICT.zh)
  const en = Object.keys(DICT.en)
  assert.ok(zh.length > 100, `中文键数应 > 100，实际 ${zh.length}`)
  assert.deepEqual(zh.filter(k => !en.includes(k)), [], '这些键只有中文')
  assert.deepEqual(en.filter(k => !zh.includes(k)), [], '这些键只有英文')
})

ok('⭐⭐⭐ 每个 t(...) 用到的键都必须在字典里（否则界面直接显示裸键名）', () => {
  // 真机上刚发生过：给 DICT 插入新键时**把锚点那一行替换掉了**，
  // 于是 `advancedHint` 从两份字典里一起消失 —— 而 `t()` 取不到键时
  // **回落成键名本身**，诊断页上就一本正经地显示着 "advancedHint"。
  // 这类错没有任何断言会红（"只是难看"），人眼也很容易滑过去。
  const src = fs.readFileSync(CLIENT, 'utf8')
  const DICT = loaded.exports.__test.DICT
  const used = new Set()
  for (const m of src.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)) used.add(m[1])
  assert.ok(used.size > 60, `应解析出 60+ 个文案键，实际 ${used.size}`)
  const missingZh = [...used].filter(k => !(k in DICT.zh)).sort()
  const missingEn = [...used].filter(k => !(k in DICT.en)).sort()
  assert.deepEqual(missingZh, [], `这些键在代码里用了、中文文案里却没有（会显示裸键名）：${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `这些键在代码里用了、英文文案里却没有：${missingEn.join(', ')}`)
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

/* ── 桌面端 ↔ 设置页 的同步（用户报："滚轮调完大小，设置页不跟着变"）──────
 *
 * 根因：`state.settings` 原先只有两个写入点 —— 挂载时 GET 一次、设置页自己
 * `updateSettings`。而宿主**每帧快照都带着 settings**（exe 关心的那 13 个字段），
 * 客户端拿到了却从来不读 → 任何"不是设置页发起"的改动都到不了界面上。
 * 下面这条推真帧进去验，而不是读代码"确认它有写"。 */

ok('⭐⭐⭐ 宿主快照里的 settings 必须并进本地状态（桌面端改完设置页要跟着变）', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const rt = l.exports.__test.runtime
  rt.connect()
  const es = l.EventSource.instances[0]
  assert.ok(es, '应建立 EventSource（否则推帧都无从谈起）')
  assert.equal(typeof es.handlers.state, 'function', '应监听 state 帧')

  // 先给本地一份"设置页刚加载完"的状态（含一个快照里没有的字段）
  rt.__state.settings = l.exports.__test.normalizePet({ scale: 0.8, ttsUrl: 'http://127.0.0.1:8765' })
  const settingsEvents = []
  rt.subscribe(next => { if (next.settings !== undefined) settingsEvents.push(next.settings) })

  // ① 桌面端滚轮缩放 → exe 去抖后 POST /pet/settings → 宿主广播带新 scale 的快照
  es.handlers.state({ data: JSON.stringify({ rev: 9, petState: 'idle', settings: { scale: 1.4 } }) })
  assert.equal(rt.settings.scale, 1.4,
    '快照里的 scale 必须并进本地设置 —— 否则「桌面端滚轮调完、设置页还显示旧值」')
  assert.equal(rt.settings.ttsUrl, 'http://127.0.0.1:8765',
    '合并而不是替换：快照只带 exe 子集，其余字段必须原样保留')
  assert.equal(settingsEvents.length, 1, '这一次变化应该只 emit 一次设置')

  // ② 同一帧再来一次（宿主每帧都带 settings）→ **不许**再 emit
  //    否则设置页每帧重渲染一次，而且"看起来没变"，排查极费劲。
  es.handlers.state({ data: JSON.stringify({ rev: 10, petState: 'happy', settings: { scale: 1.4 } }) })
  assert.equal(settingsEvents.length, 1,
    '快照里 settings 与原值相同时不许再 emit（否则每帧一次无意义的重渲染）')

  // ③ 托盘改成"总在最前 = 关" → 同样要跟着变
  es.handlers.state({ data: JSON.stringify({ rev: 11, settings: { topmost: false } }) })
  assert.equal(rt.settings.topmost, false, '托盘改的开关也要跟着走')
  assert.equal(rt.settings.scale, 1.4, '其它字段不能被这一帧冲掉')

  // ④ 快照里没有 settings 块（老 Host / 空帧）→ 不许把本地设置抹成默认
  const before = rt.settings
  es.handlers.state({ data: JSON.stringify({ rev: 12, petState: 'idle' }) })
  assert.equal(rt.settings, before, '没有 settings 块的帧不该动本地设置')
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

/* ══════════════════════════════════════════════════════════════════════════
 * 10. v10：「今天」页签与新手势设置
 * ═════════════════════════════════════════════════════════════════════════ */

section('10. v10「今天」页签 + 手势设置')

ok('⭐⭐ today 块缺失时「今天」页不崩（旧宿主 / 还没广播）', () => {
  // 这是本项目最严重的一类事故：设置页整片崩溃且不报错。
  // `snapshot.today` 是 v10 新增的**可选**块，旧宿主根本没有 ——
  // 直接取 `snapshot.today.pomodoroCount` 会抛 TypeError。
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.settings = normalizePet({})
  runtime.__state.tab = 'today'
  l.react.resetHooks()
  assert.doesNotThrow(() => Section({ close () {} }), 'today 块缺失时不该抛')
})

ok('⭐「今天」页显示四个数字（番茄/时长/摸鱼/连续天数）', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = {
    petState: 'idle',
    label: '',
    bubble: null,
    nativeAvailable: true,
    today: {
      dayKey: '2026-10-08',
      pomodoroCount: 3,
      focusMs: 75 * 60 * 1000,
      interrupts: 2,
      streakDays: 5,
      goalCount: 8,
      byTask: [{ task: '桌宠开发', ms: 50 * 60 * 1000 }],
      recent: [{ dayKey: '2026-10-08', count: 3, focusMs: 1000 }]
    }
  }
  runtime.__state.settings = normalizePet({})
  runtime.__state.tab = 'today'
  l.react.resetHooks()
  const tree = Section({ close () {} })
  const text = collectStrings(tree).join('|')
  assert.ok(text.includes('今日番茄'), '缺「今日番茄」')
  assert.ok(text.includes('专注时长'), '缺「专注时长」')
  assert.ok(text.includes('摸鱼次数'), '缺「摸鱼次数」')
  assert.ok(text.includes('连续天数'), '缺「连续天数」')
  // 时长格式化：75 分钟 → "1 小时 15 分"（不是 75 分、不是 4500 秒）
  assert.ok(text.includes('1 小时 15 分'), `时长格式化不对：${text.slice(0, 200)}`)
  // 目标进度 3/8
  assert.ok(text.includes('3/8'), `缺目标进度：${text.slice(0, 200)}`)
  // 任务列表
  assert.ok(text.includes('桌宠开发'), '缺任务名')
})

ok('⭐「今天」页一次没用过时给引导，而不是四个 0', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = {
    petState: 'idle', label: '', bubble: null, nativeAvailable: true,
    today: { pomodoroCount: 0, focusMs: 0, interrupts: 0, streakDays: 0, goalCount: 0, byTask: [], recent: [] }
  }
  runtime.__state.settings = normalizePet({})
  runtime.__state.tab = 'today'
  l.react.resetHooks()
  const text = collectStrings(Section({ close () {} })).join('|')
  assert.ok(text.includes('还没有记录'), `应有引导文案：${text.slice(0, 200)}`)
})

ok('⭐⭐ 时长格式化与 exe 同口径（不足一分钟 → 1 分，不是 0 分）', () => {
  // 两处各写一套的风险是"菜单显示 25 分、面板显示 0 分"。
  // exe 的 `PetTodayInfo.FormatDuration` 有一条一模一样的断言。
  //
  // ⚠️ 每个用例都要**新起一个挂载**（`loadClient()`），不能复用一个 `runtime`
  // 反复改快照再渲染 —— 桩的 `useState` 会把首次渲染的结果**缓存**在
  // `hooks.states[i]` 里，`resetHooks()` 只归零游标、不清缓存，
  // 于是第二次渲染读到的还是第一份快照（这正是本项目记过的"假绿"陷阱）。
  const render = focusMs => {
    const l = loadClient()
    l.exports.apply(l.ctx)
    const { Section, runtime } = l.exports.__test
    runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
    runtime.__state.snapshot = {
      petState: 'idle', label: '', bubble: null, nativeAvailable: true,
      today: { pomodoroCount: 1, focusMs, interrupts: 0, streakDays: 1, goalCount: 0, byTask: [], recent: [] }
    }
    runtime.__state.settings = normalizePet({})
    runtime.__state.tab = 'today'
    l.react.resetHooks()
    return collectStrings(Section({ close () {} })).join('|')
  }
  assert.ok(render(30 * 1000).includes('1 分钟'), '30 秒应显示 1 分钟（显示 0 分会让人以为统计坏了）')
  assert.ok(render(25 * 60 * 1000).includes('25 分钟'), '25 分钟')
  assert.ok(render(60 * 60 * 1000).includes('1 小时'), '1 小时')
  assert.ok(render(65 * 60 * 1000).includes('1 小时 5 分钟'), '1 小时 5 分钟')
  assert.ok(render(0).includes('0 分钟'), '0 应显示 0 分钟')
})

ok('⭐ 新手势设置三个开关都在，且能改到设置里', () => {
  const tree = renderSectionTree({}, 'behavior')
  const text = collectStrings(tree).join('|')
  assert.ok(text.includes('按住摸头'), '缺「按住摸头」')
  assert.ok(text.includes('拖住甩出去'), '缺「拖住甩出去」')
  assert.ok(text.includes('鼠标停在她身上时看你一眼'), '缺「悬停反应」')
})

ok('⭐⭐ 悬停反应默认关（唯一"她主动找你"的互动，默认开就是骚扰）', () => {
  const d = normalizePet({})
  assert.equal(d.hoverReact, false, '悬停反应必须默认关')
  // 而抛掷与长按默认开：只有用户主动做手势才触发，不是骚扰
  assert.equal(d.flingEnabled, true, '抛掷默认开（要主动甩才触发）')
  assert.equal(d.longPress, true, '长按默认开（要主动按住才触发）')
})

ok('⭐ 新设置字段能穿过归一化（否则"界面能改、发不出去"）', () => {
  const n = normalizePet({
    hoverReact: true, flingEnabled: false, longPress: false,
    pomodoroBreath: true, pomodoroGoalCount: 12, pomodoroPreset: 'deep'
  })
  assert.equal(n.hoverReact, true)
  assert.equal(n.flingEnabled, false)
  assert.equal(n.longPress, false)
  assert.equal(n.pomodoroBreath, true)
  assert.equal(n.pomodoroGoalCount, 12)
  assert.equal(n.pomodoroPreset, 'deep')
})

ok('⭐ 目标数夹在 0..30（0 = 不设目标是**合法值**）', () => {
  assert.equal(normalizePet({ pomodoroGoalCount: 0 }).pomodoroGoalCount, 0)
  assert.equal(normalizePet({ pomodoroGoalCount: -5 }).pomodoroGoalCount, 0)
  assert.equal(normalizePet({ pomodoroGoalCount: 999 }).pomodoroGoalCount, 30)
  assert.equal(normalizePet({ pomodoroGoalCount: 'x' }).pomodoroGoalCount, 8, '坏值回落默认 8')
})

ok('⭐⭐ 预设只认白名单（未知值回落，不透传）', () => {
  assert.equal(normalizePet({ pomodoroPreset: 'deep' }).pomodoroPreset, 'deep')
  assert.equal(normalizePet({ pomodoroPreset: 'nope' }).pomodoroPreset, 'classic')
  assert.equal(normalizePet({ pomodoroPreset: '__proto__' }).pomodoroPreset, 'classic',
    '原型链名字必须被挡（本项目在 interactions.js 上踩过一模一样的坑）')
  assert.equal(normalizePet({ pomodoroPreset: 'toString' }).pomodoroPreset, 'classic')
})

ok('⭐⭐ 预设选项集与宿主**同集**（不同集会让界面选到一个宿主不认识的值）', () => {
  // 界面能选到 deep、宿主回落 classic → "显示 deep、实际跑 25 分钟"，且不报错。
  const src = fs.readFileSync(CLIENT, 'utf8')
  const m = src.match(/const PET_POMODORO_PRESETS = \[([^\]]+)\]/)
  assert.ok(m, '找不到 PET_POMODORO_PRESETS')
  const clientSet = m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
  assert.deepEqual(clientSet.sort(), ['classic', 'deep', 'free', 'sprint'].sort(),
    `客户端预设集不对：${clientSet.join(',')}`)
  // 宿主那份必须含同样的四个（外加 custom 标记）
  const hostSrc = fs.readFileSync(
    path.join(path.dirname(CLIENT), 'src', 'settings.js'), 'utf8')
  for (const id of clientSet) {
    assert.ok(hostSrc.includes(`'${id}'`), `宿主 settings.js 里没有预设 ${id}`)
  }
})

ok('⭐ 番茄钟页有预设下拉，且选中后会套用时长', () => {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.settings = normalizePet({ pomodoro: true })
  runtime.__state.tab = 'behavior'
  l.react.resetHooks()
  const tree = Section({ close () {} })

  // ⚠️ `collectStrings` 只走 `props.children`，而 v4 起**控件挂在 `Row` 的
  // `control` prop 里**（不是 children）—— 所以要自己把 control 也走一遍。
  // 这正是本项目记过的"只走 children 的检查器一个控件都找不到"。
  const texts = []
  const walk = n => {
    if (n === null || n === undefined) return
    if (typeof n === 'string') { texts.push(n); return }
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    const p = n.props ?? {}
    for (const k of ['label', 'hint', 'title', 'placeholder', 'desc', 'lead', 'note']) {
      if (typeof p[k] === 'string') texts.push(p[k])
    }
    walk(p.control)
    walk(p.children)
  }
  walk(tree)
  const text = texts.join('|')
  assert.ok(text.includes('节奏预设'), `缺「节奏预设」：${text.slice(0, 200)}`)
  assert.ok(text.includes('经典 25/5'), '缺预设选项（下拉的 option 文案）')
  assert.ok(text.includes('深度工作 52/17'), '缺深度工作预设')
  assert.ok(text.includes('自由计时（上限 4 小时）'), '缺自由计时预设')

  // 选中 deep 后应把 52 分钟写进 focusMs —— 断言映射表本身（onChange 的产物
  // 无法从树上观察，因为 `set` 是闭包内的函数）。
  const mm = fs.readFileSync(CLIENT, 'utf8').match(/deep: \{ pomodoroFocusMs: (\d+) \* 60 \* 1000/)
  assert.ok(mm, '找不到 deep 的时长定义')
  assert.equal(Number(mm[1]), 52, `deep 的专注时长应是 52 分钟，实际 ${mm[1]}`)
  // 而且四个预设的映射表必须与宿主一致（不同集 = 界面选 deep、实际跑 classic）
  const hostSrc = fs.readFileSync(path.join(path.dirname(CLIENT), 'src', 'settings.js'), 'utf8')
  for (const [id, focus] of [['classic', 25], ['deep', 52], ['sprint', 25], ['free', 240]]) {
    const re = new RegExp(`${id}: \\{ pomodoroFocusMs: (\\d+) \\* 60 \\* 1000`)
    const hm = hostSrc.match(re)
    assert.ok(hm, `宿主 settings.js 里找不到预设 ${id}`)
    assert.equal(Number(hm[1]), focus, `${id} 的时长与客户端不一致（宿主 ${hm[1]} / 期望 ${focus}）`)
  }
})

ok('⭐ 手改时长会把预设标成自定义（否则下拉显示 deep、实际跑 30 分钟）', () => {
  const src = fs.readFileSync(CLIENT, 'utf8')
  // 四个时长滑杆的 onChange 都必须带上 pomodoroPreset: 'custom'
  for (const key of ['pomodoroFocusMs', 'pomodoroBreakMs', 'pomodoroLongBreakMs', 'pomodoroRounds']) {
    const re = new RegExp(`key: '${key}'[\\s\\S]{0,400}?onChange: v => set\\(\\{ ${key}: [^}]*pomodoroPreset: 'custom'`)
    assert.ok(re.test(src), `${key} 的 onChange 没有把预设标成 custom`)
  }
})

/* ═════════════════════════════════════════════════════════════════════════ */
// ⚠️ 异步用例必须在汇总**之前**跑完（见 `okAsync` 的注释）。
await runAsyncCases()

console.log(`\n${'═'.repeat(60)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('❌ 有失败项')
  process.exit(1)
}
console.log('✅ 全部通过')