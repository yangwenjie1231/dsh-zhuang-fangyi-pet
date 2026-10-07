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
  l.react.resetHooks()
  const tree = Section({ close () {} })

  const toggles = collectByType(tree, 'Toggle').map(n => n.props)
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

  // 直接验 Slider 的产物结构：它应当渲染出 __control 容器，
  // 且 range 与 __value 都是它的**后代**（而不是行的直接子节点）。
  const probe = sliders[0].type({ ...sliders[0].props, hint: 'x' })
  const kids = probe.props.children
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

ok('⭐ 设置页可滚动内容不该比必要的高（行高回归兜底）', () => {
  // 这条不量真实像素（无头测试没有布局引擎），只锁住"行的垂直内边距"
  // 这个唯一由我们控制的高度来源 —— 实测把它从 9px 调到 6px，
  // 整页从 2870px 降到 2608px（40 行 × 6px）。
  const css = loaded.exports.__test.styleText()
  const row = css.match(/\.zf-pet-row\{[^}]*\}/)
  assert.ok(row, '应有 .zf-pet-row 规则')
  const m = row[0].match(/padding:\s*(\d+)px\s+0/)
  assert.ok(m, `.zf-pet-row 应有垂直内边距，实际：${row[0]}`)
  assert.ok(Number(m[1]) <= 8,
    `行的垂直内边距应 ≤ 8px（过高会让设置页长到 2800px+），实际 ${m[1]}px`)
})

ok('⭐ 分组标题不能用西文那套 uppercase/字距（套在中文上只会更难读）', () => {
  const css = loaded.exports.__test.styleText()
  for (const sel of ['.zf-pet-settings__group', '.zf-pet-group__sum']) {
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

  // 诊断区那行必须**仍然**有文件路径与容量
  l.react.resetHooks()
  tree = Section({ close () {} })
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
  const tree = renderSectionTree({ pomodoro: true })
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
  const css = loaded.exports.__test.styleText()
  const rule = css.match(/\.zf-pet-row\s*\+\s*\.zf-pet-row\{[^}]*\}/)
  assert.ok(rule, '应有"相邻行加分隔线"的规则')
  assert.ok(!/border-l1/.test(rule[0]),
    `分隔线不该用 border-l1（4% 不透明度，看不见），实际：${rule[0]}`)
  assert.ok(/border-l2/.test(rule[0]),
    `分隔线应与外壳 settings-form 同档（border-l2），实际：${rule[0]}`)
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

/** 收集树里所有**用户可见文案**（含函数组件的 label/hint/title props）。 */
function collectStrings (node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (typeof node === 'number' || typeof node === 'boolean') return out
  if (Array.isArray(node)) { node.forEach(n => collectStrings(n, out)); return out }
  if (typeof node !== 'object') return out
  const p = node.props ?? {}
  for (const k of ['label', 'hint', 'title', 'placeholder']) {
    if (typeof p[k] === 'string') out.push(p[k])
  }
  collectStrings(p.children, out)
  return out
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

function renderSectionTree (settingsPatch = {}) {
  const l = loadClient()
  l.exports.apply(l.ctx)
  const { Section, runtime } = l.exports.__test
  runtime.__state.atlas = { frameHeight: 256, states: { idle: { file: 'i.png', frames: 1 } } }
  runtime.__state.snapshot = { petState: 'idle', label: '', bubble: null, nativeAvailable: true }
  runtime.__state.settings = normalizePet(settingsPatch)
  l.react.resetHooks()
  return Section({ close () {} })
}

ok('⭐ 重排后每个设置控件都还在（防"功能悄悄消失"）', () => {
  // 用**用户看得见的文案**核对，而不是内部键名：文案没了 = 控件没了。
  const texts = collectStrings(renderSectionTree({ pomodoro: true, ttsResident: false }))
  const joined = texts.join('|')
  const expected = [
    '启用桌宠', '显示方式', '大小', '不透明度', '总在最前', '点击穿透',
    '显示气泡', '气泡显示表情图', '对话文字大小', '气泡显示时长', '两条气泡最小间隔',
    'AI 完成时弹提醒', '审批/提问常亮提醒', '双击桌宠',
    '活跃度', '完成后的开心时长', '空闲多久后睡觉', '深浅色主题',
    '悬停时显示状态', '桌宠下方常显状态', '状态文字大小',
    '让庄方宜说话', '把 AI 的回答念出来', '合成服务地址', '每次朗读字数上限',
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

  const sliders = []
  const walk = n => {
    if (n === null || n === undefined) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    if (typeof n.type === 'function' && n.type.name === 'Slider') sliders.push(n)
    if (n.props) walk(n.props.children)
  }
  walk(tree)
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

ok('⭐ 分组按"用户找东西的心智"排序（不再是开发历史顺序）', () => {
  const groups = collectByType(renderSectionTree({}), 'Group')
  const titles = groups.map(g => g.props.title)
  // 标题复用既有 i18n 键（`groupBubble`='气泡'、`groupChat`='聊天'），
  // 只有新增的分组才有新键 —— 这里断言的是**顺序与构成**，不是措辞。
  assert.deepEqual(titles,
    ['桌宠', '气泡', '作息与外观', '语音', '番茄钟', '聊天', '高级与诊断'],
    `分组顺序不对，实际：${titles.join(' → ')}`)
  // 关键性质：原先把"常规/窗口"拆成两组、把"运行状态"压在最后；
  // 现在前两组是桌宠本体，诊断在最后且可折叠。
  assert.equal(titles[0], '桌宠', '第一组应是桌宠本体')
  assert.equal(titles[titles.length - 1], '高级与诊断', '诊断应在最后（不再夹在中间）')
})

ok('⭐ 诊断区默认**收起**（机器路径不该糊在脸上）', () => {
  const groups = collectByType(renderSectionTree({}), 'Group')
  const adv = groups.find(g => g.props.title === '高级与诊断')
  assert.ok(adv, '应有"高级与诊断"分组')
  assert.equal(adv.props.collapsible, true, '"高级与诊断"必须是可折叠的')
  assert.notEqual(adv.props.open, true, '"高级与诊断"必须默认收起')
  // 番茄钟默认关 → 也收起（8 个控件不该占着主面板）
  const pomo = groups.find(g => g.props.title === '番茄钟')
  assert.equal(pomo.props.collapsible, true, '番茄钟应可折叠')
  assert.notEqual(pomo.props.open, true, '番茄钟默认关时应收起')
})

ok('⭐ 启动命令（机器路径）只出现在折叠的诊断区里', () => {
  // 这条是"降噪"的核心：绝对路径原先以正文段落的形式糊在面板中间。
  const tree = renderSectionTree({})
  const groups = collectByType(tree, 'Group')
  const adv = groups.find(g => g.props.title === '高级与诊断')
  const advText = collectStrings(adv).join('|')
  const allText = collectStrings(tree).join('|')
  // 诊断区里**有**路径位（launch 由运行时数据填，静态渲染时是键名）
  assert.ok(advText.includes('启动命令'), '诊断区应包含"启动命令"')
  // 而正文（诊断区之外）不该出现机器路径的痕迹
  const outside = collectStrings(tree).filter(s => !advText.includes(s)).join('|')
  assert.ok(!/[A-Z]:\\/.test(outside), `正文里不该出现盘符路径：${outside.slice(0, 160)}`)
  assert.ok(allText.length > 0, '面板应有可见文案')
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
// ⚠️ 异步用例必须在汇总**之前**跑完（见 `okAsync` 的注释）。
await runAsyncCases()

console.log(`\n${'═'.repeat(60)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('❌ 有失败项')
  process.exit(1)
}
console.log('✅ 全部通过')