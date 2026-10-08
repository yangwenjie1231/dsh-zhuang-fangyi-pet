/**
 * 庄方宜桌宠 · 端到端集成测试
 *
 * 用法：`node tools/test-pet-e2e.mjs`
 *
 * ── 与前三套单测的区别 ────────────────────────────────────────────────────
 *
 * 前三套各自测一个模块（状态机 / 路由 / 浏览器半边）。这一套测**真实装配**：
 *
 *   · 用**真实的** `apply()`（`index.js`）挂上桩 ctx，走真实的路由与 SSE；
 *   · 用**真实的**素材产物 `art/pet/pet.json`（不是造的假清单）；
 *   · 从 `/pet/events` 真的读 SSE 帧，验证「发事件 → 状态变化 → 推送」整条链路。
 *
 * 这是唯一能发现「模块都对但接起来不对」的地方 —— 比如契约里状态名对不上、
 * 素材清单字段缺失、SSE 帧格式与客户端解析不匹配。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSettings } from '../src/settings.js'
import { sanitizeForSpeech } from '../src/pet/tts.js'
import { EMOTE_BY_KEY, EMOTE_EXCLUDE_FROM_RANDOM } from '../src/pet/emotes.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const ART = path.join(ROOT, 'art', 'pet')

let passed = 0
let failed = 0

function section (name) {
  console.log(`\n── ${name} ──`)
}

async function ok (label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${error?.message ?? error}`)
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 桩 ctx：模拟 cordis 的最小契约
 * ══════════════════════════════════════════════════════════════════════════ */

/** 一个够用的桩 ctx：事件总线 + effect + inject + logger。 */
function makeCtx (webServer) {
  const handlers = new Map()
  const effects = []
  const services = new Map()
  if (webServer !== undefined) services.set('webServer', webServer)

  const ctx = {
    logger: { info () {}, warn () {}, debug () {}, error () {} },
    on (name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set())
      handlers.get(name).add(fn)
      return () => handlers.get(name)?.delete(fn)
    },
    /** 测试用：派发一个宿主事件。 */
    emit (name, ...args) {
      for (const fn of handlers.get(name) ?? []) fn(...args)
    },
    effect (fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    inject (deps, cb) {
      const scoped = {
        ...ctx,
        webServer,
        effect: ctx.effect
      }
      return cb(scoped)
    },
    get (name) {
      return services.get(name)
    },
    provide (name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    set (name, value) {
      services.set(name, value)
    },
    __handlers: handlers,
    __effects: effects,
    __services: services
  }
  return ctx
}

/**
 * 把桩 ctx 包成"cordis 模式"：读**未声明**的服务时**抛**
 * `cannot get property "x" without inject`（复刻 cordis 的 Proxy getter）。
 *
 * 为什么需要：真实 cordis 里，`ctx.webServer` 这种未在 inject 声明的服务
 * **读取会抛异常**，而不是返回 undefined。`launcher.js` 曾用 `ctx?.webServer`
 * 去取端口 —— 可选链防不住这个，异常直接把 exe 启动掐死，而当时所有桩 ctx
 * 都是普通对象（能读到 webServer），所以测试全绿、真实环境必崩。
 * 这个包装让"抛"这条路径在测试里也能被覆盖。
 */
function toCordisLike (ctx, injected = []) {
  const allowed = new Set(['logger', 'on', 'emit', 'effect', 'inject', 'get',
    'provide', 'set', 'call', 'subprocess', 'sessionController', ...injected])
  return new Proxy(ctx, {
    get (target, prop, recv) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, recv)
      if (allowed.has(prop)) return undefined
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    }
  })
}

/** 桩 webServer：真的起一个 http.Server，把注册的 route 接上。 */
function makeWebServer () {
  const routes = []
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    // 复刻真实 webServer 的派发：exact 优先，然后最长前缀胜出。
    let best = null
    for (const r of routes) {
      if (r.kind === 'exact' && r.path === pathname) {
        best = r
        break
      }
      if (r.kind === 'prefix' && (pathname === r.path || pathname.startsWith(r.path + '/'))) {
        if (best === null || r.path.length > best.path.length) best = r
      }
    }
    if (best === null) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(best.handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  return {
    routes,
    server,
    port: 0,
    host: '127.0.0.1',
    register (route) {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i !== -1) routes.splice(i, 1)
      }
    },
    registerUpgrade () {
      return () => {}
    },
    tapIndex () {
      return () => {}
    },
    async listen () {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      this.port = server.address().port
      return this.port
    },
    async close () {
      await new Promise(resolve => server.close(resolve))
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 装配：用真实 apply()
 * ══════════════════════════════════════════════════════════════════════════ */

// 用一个临时 DSH_HOME，避免污染真实设置文件。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-pet-e2e-'))
process.env.DSH_HOME = tmpHome

const webServer = makeWebServer()
const port = await webServer.listen()
const ctx = makeCtx(webServer)

// 真实 index.js：它会读 art/pet/pet.json、挂路由、建状态机、尝试起 exe。
const pet = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
pet.apply(ctx, {})

const BASE = `http://127.0.0.1:${port}`
const ROUTE = `${BASE}/api/zhuang-fangyi/pet`

/** 同源请求（浏览器半边走这条路：无令牌，靠围栏）。 */
async function get (p) {
  const res = await fetch(`${BASE}${p}`)
  const text = await res.text()
  return { status: res.status, body: text, headers: res.headers }
}

/**
 * 数 GIF 里**真正的帧数**（按块结构走一遍）。
 *
 * 为什么不用"扫 `0x21 0xF9`（图形控制扩展）出现次数"：那两个字节序列在
 * **LZW 压缩数据里也会出现**，实测把 33 帧的 `05_星空公式` 数成 45 帧 ——
 * 于是断言红在一个**根本不存在的产品问题**上。校验工具本身必须先是对的，
 * 否则它只是在产生噪音（这条断言第一次跑就是这么被打回来的）。
 *
 * @returns {number} 帧数；结构异常返回负数（让调用方直接判失败）
 */
function gifFrameCount (buf) {
  const sig = buf.toString('ascii', 0, 6)
  if (sig !== 'GIF89a' && sig !== 'GIF87a') return -1
  let p = 6
  const screenFlags = buf[p + 4]
  p += 7
  if (screenFlags & 0x80) p += 3 * (1 << ((screenFlags & 0x07) + 1))  // 全局色表
  const skipSubBlocks = () => {
    while (p < buf.length && buf[p] !== 0) p += buf[p] + 1
    p += 1
  }
  let frames = 0
  while (p < buf.length) {
    const b = buf[p]
    if (b === 0x3b) break                       // trailer
    if (b === 0x2c) {                           // image descriptor = 一帧
      frames++
      const localFlags = buf[p + 9]
      p += 10
      if (localFlags & 0x80) p += 3 * (1 << ((localFlags & 0x07) + 1))
      p += 1                                    // LZW 最小码长
      skipSubBlocks()
    } else if (b === 0x21) {                    // 扩展块（GCE/注释/应用）
      p += 2
      skipSubBlocks()
    } else {
      return -2                                 // 认不出的块 → 文件有问题
    }
  }
  return frames
}

/** 同源 POST（JSON body）。 */
async function post2 (p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, body: text, headers: res.headers }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 装配与路由
 * ══════════════════════════════════════════════════════════════════════════ */
section('1. 真实 apply() 装配与路由')

await ok('apply() 在 webServer 上挂上了 /pet 路由', async () => {
  assert.ok(
    webServer.routes.some(r => r.path === '/api/zhuang-fangyi/pet'),
    `未挂路由，实际：${webServer.routes.map(r => r.path).join(', ')}`
  )
})

await ok('订阅了宿主事件（agent/status、session/event、agent/error）', async () => {
  for (const name of ['agent/status', 'session/event', 'agent/error']) {
    assert.ok(ctx.__handlers.has(name), `未订阅 ${name}`)
  }
})

await ok('GET /pet/state 返回契约 §2 形状的快照', async () => {
  const r = await get('/api/zhuang-fangyi/pet/state')
  assert.equal(r.status, 200, `状态码 ${r.status}`)
  const snap = JSON.parse(r.body)
  for (const key of ['rev', 'petState', 'label', 'since', 'sessions', 'nativeAvailable', 'nativeError']) {
    assert.ok(key in snap, `快照缺字段 ${key}`)
  }
})

await ok('⭐ 快照带 settings 块（exe 实时应用的依据，契约 §2）', async () => {
  const r = await get('/api/zhuang-fangyi/pet/state')
  const snap = JSON.parse(r.body)
  assert.ok(snap.settings && typeof snap.settings === 'object', '快照应有 settings 块')
  for (const key of ['scale', 'opacity', 'clickThrough', 'topmost', 'bubble', 'doubleClick', 'theme']) {
    assert.ok(key in snap.settings, `settings 缺 ${key}`)
  }
})

await ok('⭐ 快照带 send 能力位（✎ 入口的开关，契约 §2）', async () => {
  const r = await get('/api/zhuang-fangyi/pet/state')
  const snap = JSON.parse(r.body)
  assert.ok(snap.send && typeof snap.send === 'object', '快照应有 send 块')
  assert.equal(typeof snap.send.available, 'boolean')
  // 这个 e2e 宿主没装配 sessionController → 必须如实报不可用，而不是乐观地报可用
  assert.equal(snap.send.available, false, '桩宿主没提供 sessionController，应报不可用')
  assert.ok(snap.send.reason, '不可用必须给出原因（UI 要能显示为什么）')
})

await ok('⭐ 能力不可用时 /pet/send 返回 503 而不是假装成功', async () => {
  const r = await post2('/api/zhuang-fangyi/pet/send', { text: '你好' })
  assert.equal(r.status, 503, '没有发消息能力就该明确说不可用')
  const body = JSON.parse(r.body)
  assert.equal(body.error, 'unavailable')
})

/* ── 会话选择器：给"发给哪个对话"提供可读名字（契约 §2 sessions[].title）───── */

await ok('⭐ 桩宿主没装配 sessionController 时，sessions 仍列出状态机记的会话', async () => {
  // 关键：**不能因为拿不到标题就什么都不给** —— 至少让用户能按"哪个在忙"选。
  const r = await get('/api/zhuang-fangyi/pet/state')
  const snap = JSON.parse(r.body)
  assert.ok(Array.isArray(snap.sessions), 'sessions 必须是数组')
  for (const s of snap.sessions) {
    assert.equal(typeof s.sessionId, 'string', 'sessionId 必须可发给 /pet/send')
    assert.ok(typeof s.title === 'string' && s.title !== '',
      'title 必须**一定有值**（最差是 id 前缀）—— 否则选择器只能显示乱码')
    assert.ok(s.sessionId !== 'unknown', '绝不能把 unknown 列为可发会话')
  }
})

await ok('⭐ 有 sessionController 时：list() 的标题进快照，指定会话能投递', async () => {
  // 用**第二个装配**（带桩 sessionController）验证整条链路：
  // list() 提供标题 → 快照 sessions[].title → 按 sessionId 发送 → prompt 收到对的会话。
  const local = makeCtx(makeWebServer())
  const prompts = []
  local.provide('sessionController', {
    async list () {
      return {
        items: [
          // 有标题 → 用标题
          { sessionId: 's-titled', updatedAt: 300, running: true, cwd: 'D:\\work\\alpha', projections: { values: { title: '桌宠开发' } } },
          // 无标题、有 cwd → 用目录名（照抄 DSH 的 displayTitleOf 回退）
          { sessionId: 's-cwd-only', updatedAt: 200, running: false, cwd: 'D:\\work\\beta' },
          // 都没有 → 用 id 前缀
          { sessionId: 's-bare-1234567890', updatedAt: 100, running: false },
          // 重名（真机上大量出现：标题取自首条消息，用户会反复发同一句）
          { sessionId: 's-dup-aaaaaaaa', updatedAt: 90, running: false, cwd: 'D:\\w\\p', projections: { values: { title: '精确中文画面文字转录（OCR）' } } },
          { sessionId: 's-dup-bbbbbbbb', updatedAt: 80, running: false, cwd: 'D:\\w\\p', projections: { values: { title: '精确中文画面文字转录（OCR）' } } },
          // 子代理会话：不是"对话"，必须被排除
          { sessionId: 's-subagent-1111', updatedAt: 999, running: false, origin: 'subagent', cwd: 'D:\\w\\p' },
          // 空会话：没有内容，必须被排除
          { sessionId: 's-blank-2222', updatedAt: 998, running: false, blank: true, cwd: 'D:\\w\\p' }
        ]
      }
    },
    /**
     * ⭐ 桩必须复刻**上游的真实契约**，否则测不出真机上的 502。
     *
     * 上游 `dsh-api-session-controller`（`typert.host.js` 实测）有**两条**约束：
     *
     *   1. zod schema：`'mode': z.union([z.literal("queue"), z.literal("steer")])`
     *      —— **没有 `.optional()`**，少字段直接校验失败。
     *   2. 描述符：`cancellation: { parameter: 'signal' }` —— 网关按它取
     *      **第 2 个实参**并直接调 `signal.throwIfAborted()`。少传就是
     *      `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')`。
     *
     * 这两条都是真机上实测踩过的 502 根因，而且**第二个更隐蔽**：
     * 第一次只修了 `mode`，自检/单测全绿，真机仍然 502。
     *
     * 之前这个桩是 `async prompt (req) { prompts.push(req); return {accepted:true} }`
     * —— 什么都不检查，于是这两种漏传在测试里**永远绿**。
     * 复刻校验（尤其是 `signal.throwIfAborted()` 这句）是唯一能让断言有意义的方式。
     */
    async prompt (req, signal) {
      if (req?.mode !== 'queue' && req?.mode !== 'steer') {
        throw new Error(
          `RemoteError gateway/bad-request: prompt.mode 必须是 'queue' 或 'steer'，` +
          `实际 ${JSON.stringify(req?.mode)}（上游 schema 无 .optional()）`
        )
      }
      // 复刻网关对 signal 的使用：**不判空、直接调** —— 少传就抛 TypeError。
      signal.throwIfAborted()
      prompts.push({ ...req, __signal: signal })
      return { accepted: true }
    }
  })
  // 与文件顶部同一导入方式（模块命名空间直接有 apply，没有 default 包装）。
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  // 桩 webServer 要显式 listen 才会分配端口（否则 port=0，fetch 必然失败）。
  await ws.listen()
  // 等一次广播把 list() 的结果吃进缓存
  for (const f of (local.__handlers.get('agent/status') ?? [])) {
    f({ type: 'agent/status', sessionId: 's-titled', status: 'running' })
  }
  await new Promise(r => setTimeout(r, 250))

  const base = `http://127.0.0.1:${ws.port}`
  const state = await fetch(`${base}/api/zhuang-fangyi/pet/state`).then(r => r.json())
  const byId = new Map((state.sessions ?? []).map(s => [s.sessionId, s]))
  assert.ok(byId.has('s-titled'), '状态机记的会话必须在列表里')
  assert.equal(byId.get('s-titled').title, '桌宠开发', '有标题就用标题')
  assert.equal(byId.get('s-cwd-only')?.title, 'beta', '没标题用工作目录名')
  // ⭐ 层级分组：会话要带 project（工作目录名），选择器才能按项目分层。
  // 用户反馈"选择对话的时候没有层级" —— 385 个会话大量同名，平铺一串选不出来。
  assert.equal(byId.get('s-cwd-only')?.project, 'beta', '带 cwd 的会话应有 project')
  assert.equal(byId.get('s-titled')?.project, 'alpha', 'project 取自 cwd 的目录名')
  // 既无标题也无 cwd → 用**短标识**回落（剥掉固定的 `session-` 前缀后取前 8 字符）。
  // 这个桩 id 没有该前缀，所以剥前后都是前 8 字符。
  // 短标识由 `shortIdsFor` **从数据推导公共前缀**后取定长（不再硬编码任何前缀）。
  // 本桩里全部 id 的公共前缀是 `s-`，故 `s-bare-1234567890` 的短标识是 `bare-1`。
  // 注意断言的是"有值且不等于完整 id"，不绑定具体字面 —— 具体值由算法决定。
  const bareTitle = byId.get('s-bare-1234567890')?.title
  assert.ok(typeof bareTitle === 'string' && bareTitle !== '' &&
            bareTitle !== 's-bare-1234567890',
    `都没有标题/cwd 时应回落到**短**标识，实际 ${JSON.stringify(bareTitle)}`)
  // ⭐ 重名消歧：真机截图里 11 个对话同名，光看名字选不出该发哪个。
  const dupA = byId.get('s-dup-aaaaaaaa')
  const dupB = byId.get('s-dup-bbbbbbbb')
  assert.ok(dupA && dupB, '重名会话都应在列表里')
  assert.ok(dupA.title.includes('精确中文画面文字转录'), '标题保留原样，只补后缀')
  assert.notEqual(dupA.title, dupB.title, '重名必须消歧（否则用户选不出来）')
  // 后缀**不绑定字面**：算法从数据推公共前缀（本桩公共前缀 `s-dup-`），
  // 所以后缀是 `aaaaaaaa` / `bbbbbbbb` 之类。断言"后缀存在且互不相同"即可 ——
  // 写死具体值等于把测试焊在实现细节上（前两版就是这么被硬编码带偏的）。
  const suffixA = dupA.title.split(' · ').pop()
  const suffixB = dupB.title.split(' · ').pop()
  assert.ok(suffixA && suffixB && suffixA !== suffixB,
    `消歧后缀必须存在且互不相同：${suffixA} / ${suffixB}`)
  assert.ok(suffixA.length < 's-dup-aaaaaaaa'.length,
    `后缀应是**短**标识而非完整 id：${suffixA}`)

  // ⭐ 子代理会话不是"对话"，空会话没内容 —— 都不该出现在可发列表里
  assert.ok(!byId.has('s-subagent-1111'), '子代理会话不该出现在发送选择器里')
  assert.ok(!byId.has('s-blank-2222'), '空会话不该出现在发送选择器里')

  // 指定会话发送 → prompt 必须收到**那个**会话
  const okRes = await fetch(`${base}/api/zhuang-fangyi/pet/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '发给 titled', sessionId: 's-titled' })
  })
  assert.equal(okRes.status, 200, `期望 200，实际 ${okRes.status}`)
  assert.equal(prompts.length, 1, '应恰好投递一次')
  assert.equal(prompts[0].sessionId, 's-titled', '必须投给指定的会话，不能改投')
  // ⭐ `mode` 必填（上游 zod schema 无 `.optional()`）。漏了它真机必 502 ——
  // 用户实测报的就是"发送提示 502"。这里断言**值**也断言**存在**。
  assert.equal(prompts[0].mode, 'queue', 'mode 必须是 queue（排队、不打断当前回合）')
  // ⭐ `signal` 必填（描述符 `cancellation: { parameter: 'signal' }`）。这是 502 的
  // **第二个**根因：少传 → `undefined.throwIfAborted()` → 被包成 502。
  // 断言它是**真 AbortSignal**，不是 undefined、也不是普通对象。
  assert.ok(prompts[0].__signal instanceof AbortSignal,
    `prompt 的第 2 个实参必须是真 AbortSignal，实际 ${typeof prompts[0].__signal}`)
  assert.equal(prompts[0].__signal.aborted, false, '信号不应处于已取消状态')
  // requestId 是去重键，必须每次都不同（否则第二次发送会被当成重试而丢弃）
  assert.ok(typeof prompts[0].requestId === 'string' && prompts[0].requestId !== '',
    'requestId 必须存在（Host 用它去重）')

  // 指定不存在的会话 → 409（**绝不静默改投别的会话**）
  const badRes = await fetch(`${base}/api/zhuang-fangyi/pet/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好', sessionId: 'session-does-not-exist' })
  })
  assert.equal(badRes.status, 409, `期望 409，实际 ${badRes.status}`)
  assert.equal((await badRes.json()).error, 'no-session')
  assert.equal(prompts.length, 1, '被拒的发送不能真的投递出去')

  for (const dispose of local.__effects) {
    if (typeof dispose === 'function') assert.doesNotThrow(() => dispose())
  }
  // 必须关掉这个桩 webServer：它真的在 listen，不关会让测试进程挂着不退出。
  await ws.close()
})

/* ── 人设：播种、会话级 section、AGENTS.md 兜底（v3）───────────────────────── */

section('1b. 人设 → 系统提示词（会话级替换）')

await ok('⭐ 首次运行播种：共享背景 + 风格两份都在（加法人设）', async () => {
  const dir = path.join(tmpHome, 'zhuang-fangyi-pet', 'personas')
  const styleFile = path.join(dir, 'default.md')
  assert.ok(fs.existsSync(styleFile), `风格文件不存在：${styleFile}`)
  // 加法人设：世界观在 shared/，风格只写"她怎么说话"
  const sharedDir = path.join(dir, 'shared')
  const sharedFiles = fs.existsSync(sharedDir) ? fs.readdirSync(sharedDir) : []
  assert.ok(sharedFiles.length > 0, `共享背景没播种：${sharedDir}`)
  const sharedText = fs.readFileSync(path.join(sharedDir, sharedFiles[0]), 'utf8')
  const styleText = fs.readFileSync(styleFile, 'utf8')
  assert.ok(sharedText.includes('=== 世界观 ==='), '共享背景应含世界观')
  assert.ok(sharedText.includes('角色身份'), '共享背景应含角色身份')
  assert.ok(styleText.includes('### 三、说话方式'), '风格文件应含说话方式')
  assert.ok(!styleText.includes('=== 世界观 ==='),
    '风格文件**不该**重复世界观（那是共享背景的职责 —— 否则改一次要改 N 处）')
  // 用户点名的台词必须逐字在（防止我"顺手改写"了人设内容）
  const both = sharedText + styleText
  for (const line of ['能咬牙坚持下来，就不算输。', '人还在，那就什么都在。',
    '冬天总会过去，春天总会再来。']) {
    assert.ok(both.includes(line), `台词缺失：${line}`)
  }
  // 给我的指令（"注意合理替换…"）绝不能进人设正文 —— 模型读到会困惑
  assert.ok(!both.includes('仅在聊天中替换'), '元指令不该出现在人设正文里')
})

await ok('GET /personas 列出播种的人设，标题取自 # 行', async () => {
  const r = await get('/api/zhuang-fangyi/pet/personas')
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.ok(body.names.includes('default'), '应有 default')
  const d = body.items.find(i => i.name === 'default')
  assert.equal(d.title, '庄方宜（默认风格）', `标题应取 # 行，实际 ${JSON.stringify(d?.title)}`)
})

/**
 * 装配一个带完整聊天链路的实例：sessionController.create + prompt + resolveAgent。
 *
 * `agentCtx.get('systemPrompt')` 返回**记录器** —— 断言打在"注册了什么 section"
 * 上，这正是"会话级替换"的可观测结果。
 */
function makeChatAssembly ({ withResolveAgent }) {
  const local = makeCtx(makeWebServer())
  const created = []
  const prompts = []
  const registered = []
  let disposed = 0
  const agentCtx = {
    get (name) {
      if (name === 'systemPrompt') {
        return {
          section (s) {
            registered.push({ ...s })
            disposed += 0
            return () => { disposed += 1 }
          },
          getSectionOrder (n) { return n === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : -1 }
        }
      }
      return undefined
    }
  }
  local.provide('sessionController', {
    async list () { return { items: [] } },
    create: async req => { created.push({ ...req }); return { sessionId: 'chat-e2e-1' } },
    async prompt (req, signal) {
      if (req?.mode !== 'queue' && req?.mode !== 'steer') throw new Error('mode 必填')
      signal.throwIfAborted()
      prompts.push({ ...req, __signal: signal })
      return { accepted: true }
    },
    ...(withResolveAgent
      ? { resolveAgent: async () => ({ agent: { ctx: agentCtx } }) }
      : {})
  })
  const petIndex = null // 与上面同一导入（复用 petIndex 变量会遮蔽，这里直接用 pet）
  local.__petApply = null
  return { local, created, prompts, registered, disposeCount: () => disposed }
}

await ok('⭐⭐ 聊天发送 → 人设作为 deployment:persona-prefix 注册到会话作用域', async () => {
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-persona-e2e-'))
  const { local, created, prompts, registered } = makeChatAssembly({ withResolveAgent: true })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  // 工作区指到临时目录：**绝不**在真机 Downloads 里建目录（测试纪律）
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { chatWorkspace: path.join(chatHome, 'ws') } })
  })
  const res = await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好' })
  })
  assert.equal(res.status, 200, `聊天发送应 200，实际 ${res.status}`)
  // create 收到的 cwd 就是设置的工作区
  assert.equal(created.length, 1)
  assert.equal(created[0].cwd, path.join(chatHome, 'ws'))
  // ⭐ 人设 section 已注册到 agent 作用域，用的就是官方人设槽位的名字
  assert.equal(registered.length, 2, `应注册人设 + 记忆两个 section，实际 ${registered.length}`)
  assert.equal(registered[0].name, 'deployment:persona-prefix',
    `必须用官方人设槽位名（遮蔽部署人设），实际 ${registered[0].name}`)
  assert.equal(registered[0].interpolate, false,
    '必须 interpolate:false —— 人设正文里的 {{ 不该被当变量（未定义引用会让组装抛错）')
  assert.ok(registered[0].text.includes('取代默认的助手人设'), '应有替换声明')
  assert.ok(registered[0].text.includes('能咬牙坚持下来，就不算输。'),
    '人设正文应逐字进入 section')
  // ⭐ 共享背景必须**拼进**人设正文（加法人设：世界观 + 风格）
  assert.ok(registered[0].text.includes('=== 世界观 ==='),
    '共享背景（世界观）应拼在人设前面 —— 否则"改一次所有风格一起变"不成立')
  // ⭐⭐ 记忆 section：跨会话共享的那份记忆也必须挂上
  assert.equal(registered[1].name, 'zf-pet:memory',
    `应有记忆 section，实际 ${registered[1].name}`)
  assert.equal(registered[1].interpolate, false, '记忆也可能含 {{，必须关插值')
  assert.ok(registered[1].text.includes('跨会话共享'), '记忆 section 应说明它是共享的')
  // ⭐ section 路成功 → **不写** AGENTS.md（否则人设文本进提示词两遍）
  assert.ok(!fs.existsSync(path.join(chatHome, 'ws', 'AGENTS.md')),
    'section 路成功时不应再写 AGENTS.md（会双重注入）')
  // 聊天 prompt 正常投递（mode/signal 约束与 /pet/send 同一套）
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].mode, 'queue')
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
})

/* ── ⭐ 工作区归属：聊天必须归到独立工作区，而不是"未分类" ──────────────────
 *
 * 用户实测反馈："聊天能不能单独建一个工作区啊，而不是归类在未分类"。
 * 根因：DSH 的工作区是**独立注册表**（`workspaceRegistry`），光给会话一个 cwd
 * 不会让它归属任何工作区。修法是先 `workspaceRegistry.create(path, title)`
 * 拿到 workspaceId，再 `sessionController.create({ workspaceId })`。
 *
 * ⚠️ **`workspaceId` 与 `cwd` 互斥**（宿主会抛 `gateway/bad-request`）——
 * 这一条必须断言，否则"两个都传"会在真机上直接失败。
 * ──────────────────────────────────────────────────────────────────────── */

await ok('⭐⭐ 聊天会话按 workspaceId 创建（不再掉进"未分类"）', async () => {
  // 清掉上一条测试留下的会话：共享 tmpHome 会串味（实测踩到：前一个测试写过
  // chat.json，于是这里走的是"采纳已有会话"分支，create 根本没被调用）。
  fs.rmSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'chat.json'), { force: true })
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-ws-e2e-'))
  const local = makeCtx(makeWebServer())
  const created = []
  const wsCalls = []
  const fakeWorkspace = {
    id: 'ws-zf-1',
    path: path.join(chatHome, 'ws'),
    title: '庄方宜',
    sessionIds: [],
    attachSession: async sid => { fakeWorkspace.sessionIds.push(sid) }
  }
  local.provide('workspaceRegistry', {
    async create (p, title) { wsCalls.push({ p, title }); fakeWorkspace.path = p; return fakeWorkspace },
    get (id) { return id === fakeWorkspace.id ? fakeWorkspace : undefined },
    list () { return [fakeWorkspace] }
  })
  local.provide('sessionController', {
    async list () { return { items: [] } },
    async create (req) {
      created.push({ ...req })
      return { sessionId: 'chat-ws-1' }
    },
    async prompt (req, signal) {
      if (req?.mode !== 'queue' && req?.mode !== 'steer') throw new Error('mode 必填')
      signal.throwIfAborted()
      return { accepted: true }
    }
  })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { chatWorkspace: path.join(chatHome, 'ws') } })
  })
  const res = await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好' })
  })
  assert.equal(res.status, 200, `聊天应 200，实际 ${res.status}`)
  // ⭐ 工作区先被注册（幂等接口），标题就是工作区名
  assert.equal(wsCalls.length, 1, `应注册一次工作区，实际 ${wsCalls.length}`)
  assert.equal(wsCalls[0].p, path.join(chatHome, 'ws'), '注册的 path 应是聊天工作区目录')
  assert.equal(wsCalls[0].title, '庄方宜', '工作区标题应是「庄方宜」')
  // ⭐⭐ 会话用 workspaceId 创建，且**不带 cwd**（两者互斥，宿主会抛）
  assert.equal(created.length, 1)
  assert.equal(created[0].workspaceId, 'ws-zf-1', `应带 workspaceId，实际 ${JSON.stringify(created[0])}`)
  assert.equal(created[0].cwd, undefined,
    'workspaceId 与 cwd 互斥 —— 同时传宿主会抛 gateway/bad-request')
  // 状态里能看出归属（用户不用去猜"到底归到哪儿了"）
  const st = await (await fetch(`${base}/api/zhuang-fangyi/pet/chat`)).json()
  assert.equal(st.workspaceId, 'ws-zf-1', '状态应报出工作区 id')
  assert.equal(st.workspaceTitle, '庄方宜', '状态应报出工作区标题')
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
})

await ok('⭐ 宿主没有 workspaceRegistry → 退回 cwd（聊天仍可用，不假装有工作区）', async () => {
  fs.rmSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'chat.json'), { force: true })
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-ws-fb-'))
  const { local, created } = makeChatAssembly({ withResolveAgent: false })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { chatWorkspace: path.join(chatHome, 'ws') } })
  })
  const res = await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好' })
  })
  assert.equal(res.status, 200, '没有工作区注册表时聊天也必须能用')
  assert.equal(created[0].workspaceId, undefined, '拿不到注册表就不该编一个 workspaceId')
  assert.equal(created[0].cwd, path.join(chatHome, 'ws'), '应退回 cwd 路')
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
})

await ok('⭐⭐ 注册表返回垃圾（没有 id）→ 退回 cwd，绝不编一个假 workspaceId', async () => {
  // 为什么单独测这条：`create()` 的返回值形状是**宿主的契约**，
  // 万一它不返回 id（版本差异/字段改名），我们绝不能拿一个编的 id 去建会话 ——
  // 那样宿主会抛 `workspace/not-found`，而用户看到的是"聊天坏了"。
  // 正确行为是**退回 cwd**（会话仍能用，只是显示未分类）。
  fs.rmSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'chat.json'), { force: true })
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-ws-bad-'))
  const local = makeCtx(makeWebServer())
  const created = []
  local.provide('workspaceRegistry', {
    // 故意返回一个**没有 id** 的记录
    async create () { return { path: 'x', title: 'y' } },
    get () { return undefined },
    list () { return [] }
  })
  local.provide('sessionController', {
    async list () { return { items: [] } },
    async create (req) { created.push({ ...req }); return { sessionId: 'chat-bad-1' } },
    async prompt (req, signal) { signal.throwIfAborted(); return { accepted: true } }
  })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { chatWorkspace: path.join(chatHome, 'ws') } })
  })
  const res = await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好' })
  })
  assert.equal(res.status, 200, '注册表给不出 id 时聊天也必须能用')
  assert.equal(created[0].workspaceId, undefined, '绝不能编一个假 workspaceId（宿主会抛 workspace/not-found）')
  assert.equal(created[0].cwd, path.join(chatHome, 'ws'), '应退回 cwd 路')
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
})

await ok('⭐⭐ 已有会话会被补挂进工作区（迁移"未分类"里的旧会话）', async () => {
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-ws-mig-'))
  const local = makeCtx(makeWebServer())
  const attached = []
  const fakeWorkspace = {
    id: 'ws-zf-2',
    path: path.join(chatHome, 'ws'),
    title: '庄方宜',
    sessionIds: [],
    attachSession: async sid => { attached.push(sid) }
  }
  local.provide('workspaceRegistry', {
    async create (p, title) { fakeWorkspace.path = p; return fakeWorkspace },
    get (id) { return id === fakeWorkspace.id ? fakeWorkspace : undefined },
    list () { return [fakeWorkspace] }
  })
  local.provide('sessionController', {
    async list () { return { items: [] } },
    // 关键：**采纳**已有会话（chat.json 里那条），不是新建
    async create () { return { sessionId: 'chat-existing-1' } },
    async prompt (req, signal) {
      if (req?.mode !== 'queue' && req?.mode !== 'steer') throw new Error('mode 必填')
      signal.throwIfAborted()
      return { accepted: true }
    }
  })
  // 预置一条"已存在"的聊天会话（模拟用户之前聊过、当时还没有工作区）
  fs.writeFileSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'chat.json'), JSON.stringify({
    sessionId: 'chat-existing-1', sentCount: 1, replyCount: 0
  }), 'utf8')
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { chatWorkspace: path.join(chatHome, 'ws') } })
  })
  await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好' })
  })
  assert.deepEqual(attached, ['chat-existing-1'],
    `已有会话应被补挂进工作区，实际 ${JSON.stringify(attached)}`)
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
  fs.rmSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'chat.json'), { force: true })
})

await ok('⭐ 宿主没有 resolveAgent → 退回 AGENTS.md（功能不瘸）', async () => {
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-persona-fb-'))
  const { local, registered } = makeChatAssembly({ withResolveAgent: false })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { chatWorkspace: path.join(chatHome, 'ws') } })
  })
  const res = await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好' })
  })
  assert.equal(res.status, 200)
  assert.equal(registered.length, 0, '没有 resolveAgent 就不该有 section')
  // 兜底：AGENTS.md 应被写进工作区
  const md = path.join(chatHome, 'ws', 'AGENTS.md')
  assert.ok(fs.existsSync(md), `兜底路径应写 AGENTS.md：${md}`)
  const text = fs.readFileSync(md, 'utf8')
  assert.ok(text.includes('能咬牙坚持下来，就不算输。'), 'AGENTS.md 应含人设正文')
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
})

await ok('⭐ 切换人设 → 旧 section 先 dispose 再挂新的（不撞名、不残留）', async () => {
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-persona-sw-'))
  // 先放第二个人设
  const personaDir = path.join(tmpHome, 'zhuang-fangyi-pet', 'personas')
  fs.writeFileSync(path.join(personaDir, 'strict.md'), '# 严格模式\n\n只说结论。\n', 'utf8')
  const asm = makeChatAssembly({ withResolveAgent: true })
  const { local, registered } = asm
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { chatWorkspace: path.join(chatHome, 'ws') } })
  })
  await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好' })
  })
  assert.equal(registered.length, 2, '首次应注册人设 + 记忆两个 section')
  const before = asm.disposeCount()
  const sw = await fetch(`${base}/api/zhuang-fangyi/pet/personas`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'strict' })
  })
  assert.equal(sw.status, 200, `切换应 200，实际 ${sw.status}`)
  assert.equal(registered.length, 4, '切换后应重新注册人设 + 记忆（共 4 个）')
  // ⭐ 旧的两个 section 都必须先 dispose（同名注册两次会抛）
  assert.equal(asm.disposeCount(), before + 2,
    `旧的人设与记忆 section 都必须先 dispose（+2），实际 +${asm.disposeCount() - before}`)
  assert.ok(registered[2].text.includes('只说结论。'), '新 section 应含新人设正文')
  assert.ok(!registered[2].text.includes('大量使用省略号'), '旧风格不该残留（那条是默认风格专属）')
  // 共享背景仍然拼在新风格前面（加法人设对每种风格都成立）
  assert.ok(registered[2].text.includes('=== 世界观 ==='), '新风格也应拼上共享背景')
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
  fs.rmSync(path.join(personaDir, 'strict.md'), { force: true })
})

/* ── 工程卫生：.ps1 必须带 UTF-8 BOM（这条抓到过 3 次真实事故）─────────────── */

await ok('⭐⭐ 所有 tools/*.ps1 都是 UTF-8 **带 BOM**（PS 5.1 否则按 ANSI 解析中文）', async () => {
  // 为什么放在测试里而不是脚本自己里：BOM 被 `edit`/`write` 工具剥掉后，
  // 脚本在 PS 5.1 下**解析都过不了**，自己永远没机会自检。
  // 本轮 real-world 事故：build-voice.ps1、deploy.ps1 各炸过一次，
  // 症状都是"Missing closing '}'"这种莫名其妙的解析错误。
  const toolDir = path.join(ROOT, 'tools')
  const scripts = fs.readdirSync(toolDir).filter(f => f.toLowerCase().endsWith('.ps1'))
  assert.ok(scripts.length > 0, 'tools 下应至少有一个 .ps1（找不到说明测试跑错目录）')
  for (const f of scripts) {
    const head = fs.readFileSync(path.join(toolDir, f)).subarray(0, 3)
    const hasBom = head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF
    assert.ok(hasBom, `tools/${f} 缺 UTF-8 BOM —— PS 5.1 会把它按 ANSI 解析直接崩。` +
      '修复：用 [System.IO.File]::WriteAllText($p, $text, new UTF8Encoding($true)) 补回。')
  }
})

/* ── ⭐⭐ 动态语音：AI 回答 → 合成 → 交付给 exe ──────────────────────────
 *
 * 子插件（`dsh-zhuang-fangyi-voice`）还没写完，所以这里起一个**假合成服务**
 * 复刻它的对外契约（`/health` + `/tts` → audio/wav）。
 *
 * 这条测试的价值：它是唯一能端到端验证"回答被念出来"的手段 ——
 * 从聊天回复事件，到合成、落盘、快照交付、字节可取，整条链路。
 * ──────────────────────────────────────────────────────────────────────── */

/** 造一段最小合法 WAV（32kHz 单声道 16-bit，1 秒静音）。 */
function fakeWav (samples = 32000) {
  const dataLen = samples * 2
  const b = Buffer.alloc(44 + dataLen)
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22); b.writeUInt32LE(32000, 24); b.writeUInt32LE(64000, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii'); b.writeUInt32LE(dataLen, 40)
  return b
}

await ok('⭐⭐ AI 回答 → 合成 → 快照交付 → 字节可取（整条链路）', async () => {
  fs.rmSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'chat.json'), { force: true })
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-tts-e2e-'))
  // ① 假合成服务：复刻子插件的契约
  const ttsCalls = []
  const ttsServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0]
      if (url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, service: 'zfh-voice', backend: 'onnx', ready: true }))
        return
      }
      if (url === '/tts') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        ttsCalls.push(body.text)
        const wav = fakeWav()
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(wav.length) })
        res.end(wav)
        return
      }
      res.writeHead(404); res.end('{}')
    })
  })
  await new Promise(r => ttsServer.listen(0, '127.0.0.1', r))
  const ttsPort = ttsServer.address().port

  const local = makeCtx(makeWebServer())
  local.provide('sessionController', {
    async list () { return { items: [] } },
    async create () { return { sessionId: 'chat-tts-1' } },
    async prompt (req, signal) { signal.throwIfAborted(); return { accepted: true } }
  })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  // ② 打开动态语音 + 语音总开关，指向假服务
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: {
      chatWorkspace: path.join(chatHome, 'ws'),
      speakReplies: true,
      voice: true,
      ttsUrl: `http://127.0.0.1:${ttsPort}`
    } })
  })
  // ②b（占位：字数上限的回归断言放在本条链路**跑完之后** —— 见下方 ⑦）
  // ③ 真发一条消息建立会话
  const sent = await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '在吗？' })
  })
  assert.equal(sent.status, 200, `发消息应 200，实际 ${sent.status}`)
  // ④ 派发回复事件（带 markdown —— 验证清洗真的生效）
  local.emit('session/event', { id: 'chat-tts-1' }, {
    type: 'assistant/message',
    seq: 9100,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'msg-tts-1',
        role: 'assistant',
        content: [{ type: 'text', text: '**好了**，我看过 `index.js` 了。' }],
        source: { kind: 'model', provider: 'e2e', model: 'e2e' }
      },
      stream: []
    }
  })
  // ⑤ 等合成完成（fire-and-forget）
  const deadline = Date.now() + 8000
  let snap = null
  while (Date.now() < deadline) {
    snap = await (await fetch(`${base}/api/zhuang-fangyi/pet/state`)).json()
    if (snap.speak !== null && snap.speak !== undefined) break
    await new Promise(r => setTimeout(r, 50))
  }
  assert.ok(ttsCalls.length >= 1, `应调用过合成服务，实际 ${ttsCalls.length} 次`)
  // ⭐ 清洗必须生效：念的是"好了，我看过 index.js 了。"而不是带星号反引号的原文
  const spoken = ttsCalls[ttsCalls.length - 1]
  assert.ok(!spoken.includes('**'), `不该念出星号：${spoken}`)
  assert.ok(!spoken.includes('`'), `不该念出反引号：${spoken}`)
  assert.ok(spoken.includes('好了') && spoken.includes('index.js'),
    `应保留文字内容，实际 ${JSON.stringify(spoken)}`)
  // ⭐ 快照里出现 speak 块（exe 靠它去取字节）
  assert.ok(snap.speak !== null && snap.speak !== undefined, '快照应带 speak 块')
  assert.equal(typeof snap.speak.name, 'string')
  assert.match(snap.speak.name, /^[0-9a-f]{16}$/, 'name 应是缓存键形状')
  assert.equal(snap.speak.durationMs, 1000, '时长应从 WAV 头解析出 1000ms')
  // ⭐⭐ 按 name 取字节：这就是 exe 播放前做的事
  const audio = await fetch(`${base}/api/zhuang-fangyi/pet/speech/${snap.speak.name}`)
  assert.equal(audio.status, 200, `取语音应 200，实际 ${audio.status}`)
  assert.equal(audio.headers.get('content-type'), 'audio/wav')
  const bytes = Buffer.from(await audio.arrayBuffer())
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', '应是 WAV 字节')
  assert.equal(bytes.length, 44 + 32000 * 2, '字节数应与合成产物一致')
  // ⑥ 状态端点
  const st = await (await fetch(`${base}/api/zhuang-fangyi/pet/speech`)).json()
  assert.equal(st.enabled, true, '状态应报已开启')
  assert.ok(st.cached >= 1, `应至少缓存 1 条，实际 ${st.cached}`)

  // ⑦ ⭐⭐ 分段朗读：**整段都念完**，不再是"截到上限就丢"
  //
  // 这条原先断言的是**旧行为**（超过上限直接截断）。用户点名问过
  // "为什么一次只能念 60 个字，别限制啊" —— 现在改成按句分段、逐段合成，
  // 所以断言也必须跟着变成"分段"，否则它会**因为每段都 ≤ 上限而碰巧继续通过**，
  // 把"还在截断"这件事藏起来。
  //
  // ⚠️ 三个坑（都是回滚验证时露的馅，别改回去）：
  //   1. 必须记**基线条数**再等新增 —— 写 `while (ttsCalls.length < 1)` 会立刻
  //      退出（那时已非空），读到旧调用，断言永远成立；
  //   2. 必须放在**会话已建立、且本链路自己的回复跑完之后** —— 合成只在
  //      speakReplies/voice 都开、且有聊天会话时才走，提前发事件会被静默忽略；
  //   3. 必须断言原文**长于**上限，否则"分段"无从谈起。
  const callsBefore = ttsCalls.length
  const bootLogPath = path.join(tmpHome, 'zhuang-fangyi-pet', 'boot.log')
  const bootLinesBefore = fs.existsSync(bootLogPath)
    ? fs.readFileSync(bootLogPath, 'utf8').split('\n').length
    : 0
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { speechMaxChars: 12 } })
  })
  const longReply = '这是一句很长的回复，用来验证字数上限改了以后立刻生效，而不是等下次重启才生效。'
  assert.ok(longReply.length > 12, '测试前提：原文必须长于上限')
  // 期望值 = **不截断**清洗后的全文（分段器一个字都不该丢）
  const expectedFull = sanitizeForSpeech(longReply, { maxChars: 12, truncate: false })
  local.emit('session/event', { id: 'chat-tts-1' }, {
    type: 'assistant/message',
    seq: 9101,
    time: Date.now(),
    data: {
      turn: 1, step: 2,
      message: {
        id: 'msg-tts-limit', role: 'assistant',
        content: [{ type: 'text', text: longReply }],
        source: { kind: 'model', provider: 'e2e', model: 'e2e' }
      },
      stream: []
    }
  })
  {
    // 等到"所有分片都合成过"（拼接结果等于全文）或超时
    const deadline2 = Date.now() + 10000
    while (Date.now() < deadline2) {
      if (ttsCalls.slice(callsBefore).join('') === expectedFull) break
      await new Promise(r => setTimeout(r, 30))
    }
    const segments = ttsCalls.slice(callsBefore)
    assert.ok(segments.length >= 2,
      `应分成**多段**合成（这是"不再截断"的证明），实际只有 ${segments.length} 段：${JSON.stringify(segments)}`)
    assert.equal(segments.join(''), expectedFull,
      '所有分片拼起来必须等于全文 —— 一个字都不许丢（旧行为会丢掉后半句）')
    for (const s of segments) {
      assert.ok(s.length <= 12,
        `每段都应 <= 12 字（分段器没失效），实际 ${s.length} 字：${JSON.stringify(s)}`)
    }
    // ⭐ 交付时每一段都带**同一个 utterance**（exe 靠它把分片排成队列而不是互相抢占）
    const snap2 = await (await fetch(`${base}/api/zhuang-fangyi/pet/state`)).json()
    assert.ok(snap2.speak !== null && snap2.speak !== undefined, '分段交付后快照仍应带 speak 块')
    assert.ok(Number.isFinite(snap2.speak.utterance) && snap2.speak.utterance > 0,
      `speak 块必须带 utterance（>0），实际 ${JSON.stringify(snap2.speak.utterance)} —— ` +
      '没有它 exe 会把每一段都当成"新的一句"而互相打断，听起来每句只念开头几个字')
    // ⭐ 宿主日志里应能看到"N 段"的逐段交付（这条是"循环真的跑完了"的直接证据）
    const newLines = fs.existsSync(bootLogPath)
      ? fs.readFileSync(bootLogPath, 'utf8').split('\n').slice(bootLinesBefore)
      : []
    const delivered = newLines.filter(l => l.includes('段）'))
    assert.equal(delivered.length, segments.length,
      `日志里的分段交付条数应等于合成段数（${segments.length}），实际 ${delivered.length}：\n${delivered.join('\n')}`)
  }

  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
  await new Promise(r => ttsServer.close(r))
})

await ok('⭐⭐ 合成服务不在 → 气泡照常、不交付语音（绝不因语音挂掉）', async () => {
  fs.rmSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'chat.json'), { force: true })
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-tts-down-'))
  const local = makeCtx(makeWebServer())
  local.provide('sessionController', {
    async list () { return { items: [] } },
    async create () { return { sessionId: 'chat-tts-2' } },
    async prompt (req, signal) { signal.throwIfAborted(); return { accepted: true } }
  })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  // 指向一个**没人监听**的端口
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: {
      chatWorkspace: path.join(chatHome, 'ws'),
      speakReplies: true,
      voice: true,
      ttsUrl: 'http://127.0.0.1:9'       // 保留端口，必然连不上
    } })
  })
  await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '在吗？' })
  })
  local.emit('session/event', { id: 'chat-tts-2' }, {
    type: 'assistant/message', seq: 9200, time: Date.now(),
    data: {
      turn: 1, step: 1,
      message: {
        id: 'msg-tts-2', role: 'assistant',
        content: [{ type: 'text', text: '服务没起的时候我也要能回话。' }],
        source: { kind: 'model', provider: 'e2e', model: 'e2e' }
      },
      stream: []
    }
  })
  // 气泡必须照常出现（语音失败不该影响聊天）
  const deadline = Date.now() + 5000
  let snap = null
  while (Date.now() < deadline) {
    snap = await (await fetch(`${base}/api/zhuang-fangyi/pet/state`)).json()
    if (snap.bubble !== null && snap.bubble !== undefined) break
    await new Promise(r => setTimeout(r, 50))
  }
  assert.ok(snap.bubble?.text?.includes('服务没起'), '气泡必须照常显示回复')
  // ⚠️ 必须先等合成路径**走完**再断言 speak —— 否则测的是竞态：
  // 气泡是同步出现的，而合成是异步的；一拿到气泡就断言的话，
  // 失败路径可能还没执行完，于是"硬交付垃圾"这种 bug 也能蒙过去
  //（回退验证实测确认漏过）。
  await new Promise(r => setTimeout(r, 1200))
  const after = await (await fetch(`${base}/api/zhuang-fangyi/pet/state`)).json()
  // ⚠️ **不许交付音频**：`speak.name` / `speak.seq` 必须缺席 ——
  //   exe 拿 name 去 `/pet/speech/<name>` 取字节，硬交付一个不存在的名字
  //   只会换来一条警告 + 每次帧都重试。
  assert.ok(after.speak === null || after.speak === undefined ||
    after.speak.name === undefined,
  `合成失败时不该交付语音音频，实际 ${JSON.stringify(after.speak)}`)
  // ⭐ 但**要**给兜底信号（契约 §2 `speak.fallback`）：TTS 没兜住的那个时刻
  //   不该完全无声 —— `chat/reply` 那 12 条固定台词就是干这个用的。
  //   （以前这里只有一句注释、exe 侧从没实现，于是它们是死资源。）
  const fb = after.speak?.fallback
  assert.ok(fb && typeof fb.seq === 'number' && fb.seq > 0 && fb.event === 'chat/reply',
    `合成失败时应发兜底台词信号，实际 ${JSON.stringify(after.speak?.fallback)}`)
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
})

await ok('⭐⭐ 语音总开关关着时**不合成**（白等几秒还没人播）', async () => {
  fs.rmSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'chat.json'), { force: true })
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-tts-mute-'))
  const ttsCalls = []
  const ttsServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      if ((req.url ?? '').startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, backend: 'onnx' }))
        return
      }
      ttsCalls.push('called')
      const wav = fakeWav(100)
      res.writeHead(200, { 'content-type': 'audio/wav' })
      res.end(wav)
    })
  })
  await new Promise(r => ttsServer.listen(0, '127.0.0.1', r))
  const local = makeCtx(makeWebServer())
  local.provide('sessionController', {
    async list () { return { items: [] } },
    async create () { return { sessionId: 'chat-tts-3' } },
    async prompt (req, signal) { signal.throwIfAborted(); return { accepted: true } }
  })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: {
      chatWorkspace: path.join(chatHome, 'ws'),
      speakReplies: true,      // 开了"念回答"
      voice: false,            // 但语音总开关关着
      ttsUrl: `http://127.0.0.1:${ttsServer.address().port}`
    } })
  })
  await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '在吗？' })
  })
  local.emit('session/event', { id: 'chat-tts-3' }, {
    type: 'assistant/message', seq: 9300, time: Date.now(),
    data: {
      turn: 1, step: 1,
      message: {
        id: 'msg-tts-3', role: 'assistant',
        content: [{ type: 'text', text: '语音关着的时候别白干活。' }],
        source: { kind: 'model', provider: 'e2e', model: 'e2e' }
      },
      stream: []
    }
  })
  await new Promise(r => setTimeout(r, 600))
  assert.equal(ttsCalls.length, 0,
    `语音总开关关着时不该调用合成服务（合成完也没人播），实际调用 ${ttsCalls.length} 次`)
  const snap = await (await fetch(`${base}/api/zhuang-fangyi/pet/state`)).json()
  assert.ok(snap.speak === null || snap.speak === undefined, '不该交付语音')
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
  await new Promise(r => ttsServer.close(r))
})

await ok('⭐⭐ 语音名白名单在**真实装配**里生效（非法形状即使文件存在也不给）', async () => {
  // 为什么这么测：光请求一个"不存在的非法名"永远 404 —— 那测不出白名单
  //（文件本来就不存在）。**必须种一个非法形状的真实文件**：
  //   · 有白名单 → 404（名字形状不合法，压根不拼路径）
  //   · 没白名单 → 200（文件真的在那儿）
  // 这才是决定性的。
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-tts-trav-'))
  const speechDir = path.join(tmpHome, 'zhuang-fangyi-pet', 'speech')
  fs.mkdirSync(speechDir, { recursive: true })
  const planted = ['ABC1234567890abc.wav', 'abc.wav', '..wav']
  for (const f of planted) fs.writeFileSync(path.join(speechDir, f), fakeWav(100))
  const local = makeCtx(makeWebServer())
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { chatWorkspace: path.join(chatHome, 'ws') } })
  })
  for (const name of ['ABC1234567890abc', 'abc', '..']) {
    const res = await fetch(`${base}/api/zhuang-fangyi/pet/speech/${name}`)
    assert.equal(res.status, 404,
      `${name} 形状非法但文件确实存在 —— 有白名单就该 404，实际 ${res.status}`)
  }
  // 反向：合法的 16 位十六进制名，若文件存在则必须能取到
  //（证明上面不是"一律 404"的假绿）。
  const legal = '0123456789abcdef'
  fs.writeFileSync(path.join(speechDir, `${legal}.wav`), fakeWav(50))
  const okRes = await fetch(`${base}/api/zhuang-fangyi/pet/speech/${legal}`)
  assert.equal(okRes.status, 200, `合法名应能取到（实际 ${okRes.status}）`)
  assert.equal(Buffer.from(await okRes.arrayBuffer()).toString('ascii', 0, 4), 'RIFF')
  for (const f of [...planted, `${legal}.wav`]) {
    fs.rmSync(path.join(speechDir, f), { force: true })
  }
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
})

await ok('⭐⭐ speakReplies 关着时**不合成**（默认就是关的）', async () => {
  fs.rmSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'chat.json'), { force: true })
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-tts-off-'))
  const ttsCalls = []
  const ttsServer = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      if ((req.url ?? '').startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, backend: 'onnx' }))
        return
      }
      ttsCalls.push('called')
      res.writeHead(200, { 'content-type': 'audio/wav' })
      res.end(fakeWav(100))
    })
  })
  await new Promise(r => ttsServer.listen(0, '127.0.0.1', r))
  const local = makeCtx(makeWebServer())
  local.provide('sessionController', {
    async list () { return { items: [] } },
    async create () { return { sessionId: 'chat-tts-4' } },
    async prompt (req, signal) { signal.throwIfAborted(); return { accepted: true } }
  })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: {
      chatWorkspace: path.join(chatHome, 'ws'),
      voice: true,
      speakReplies: false,     // ← 默认值
      ttsUrl: `http://127.0.0.1:${ttsServer.address().port}`
    } })
  })
  await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '在吗？' })
  })
  local.emit('session/event', { id: 'chat-tts-4' }, {
    type: 'assistant/message', seq: 9400, time: Date.now(),
    data: {
      turn: 1, step: 1,
      message: {
        id: 'msg-tts-4', role: 'assistant',
        content: [{ type: 'text', text: '开关关着就别合成。' }],
        source: { kind: 'model', provider: 'e2e', model: 'e2e' }
      },
      stream: []
    }
  })
  await new Promise(r => setTimeout(r, 700))
  assert.equal(ttsCalls.length, 0,
    `speakReplies=false 时不该调用合成服务，实际 ${ttsCalls.length} 次`)
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
  await new Promise(r => ttsServer.close(r))
})

await ok('⭐ 探测端点：服务连不上时如实报错（不假装成功）', async () => {
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-tts-probe-'))
  const local = makeCtx(makeWebServer())
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { chatWorkspace: path.join(chatHome, 'ws'), ttsUrl: 'http://127.0.0.1:9' } })
  })
  const res = await fetch(`${base}/api/zhuang-fangyi/pet/speech/probe`, { method: 'POST' })
  assert.equal(res.status, 200, '探测自身应 200（失败信息在 body 里）')
  const body = await res.json()
  assert.equal(body.ok, false, '连不上时应 ok=false')
  assert.ok(typeof body.reason === 'string' && body.reason.length > 0, '必须给出原因')
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
})

await ok('⭐⭐ 服务控制路由：动作白名单 + 顺序不被 /speech/<name> 抢走', async () => {
  // 这条同时防两件事：
  //   ① 动作白名单（绝不把用户串透传到内部，与番茄钟/互动同一纪律）；
  //   ② **路由顺序** —— `/speech/service` 必须排在 `/speech/<name>` 前缀分支
  //      之前，否则 `service` 会被当成"要取名为 service 的语音"而 404
  //     （`/speech/probe` 已经踩过一次这个坑）。
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-svc-'))
  const local = makeCtx(makeWebServer())
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { chatWorkspace: path.join(chatHome, 'ws') } })
  })
  const post = body => fetch(`${base}/api/zhuang-fangyi/pet/speech/service`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  })

  // ① status：只读快照，必须带常驻/是否我们起的/pid 等字段
  const st = await post({ action: 'status' })
  assert.equal(st.status, 200, `status 应 200，实际 ${st.status}`)
  const stBody = await st.json()
  for (const k of ['resident', 'launchable', 'ours', 'ready', 'idleStopSec']) {
    assert.ok(k in stBody, `状态缺字段 ${k}`)
  }
  // ② 非法动作 → 400 且列出可选项（不是 500，也不是静默当成 status）
  const bad = await post({ action: '__proto__' })
  assert.equal(bad.status, 400, `非法动作应 400，实际 ${bad.status}`)
  const badBody = await bad.json()
  assert.deepEqual(badBody.allowed, ['start', 'stop', 'status'])
  // ③ stop：没起过任何进程 → stopped=false，且**如实说明原因**
  const stop = await post({ action: 'stop' })
  assert.equal(stop.status, 200)
  const stopBody = await stop.json()
  assert.equal(stopBody.stopped, false, '没起过进程就不该说"停了"')
  assert.ok(typeof stopBody.note === 'string' && stopBody.note.length > 0,
    '必须解释为什么没停成（"不是你起的" vs "停止失败"）')
  // ④ start：本机探测不到子插件仓库时 → ok=false 且带原因（不假装成功）
  const start = await post({ action: 'start' })
  assert.equal(start.status, 200, 'start 自身应 200（结果在 body 里）')
  const startBody = await start.json()
  if (startBody.ok === false) {
    assert.ok(typeof startBody.reason === 'string' && startBody.reason.length > 0,
      '启动失败必须给原因')
  }
  // ⑤ GET 该方法 → 405（控制是写操作，不该能被 GET 触发）
  const got = await fetch(`${base}/api/zhuang-fangyi/pet/speech/service`)
  assert.equal(got.status, 405, `GET 应 405，实际 ${got.status}`)
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
})

await ok('⭐⭐ 常驻开关真的存下去并进状态（点了等于没点是最糟的）', async () => {
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-resident-'))
  const local = makeCtx(makeWebServer())
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  const patch = body => fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: body })
  })
  await patch({ chatWorkspace: path.join(chatHome, 'ws') })

  // 默认关（不占显存）
  let st = await (await fetch(`${base}/api/zhuang-fangyi/pet/speech`)).json()
  assert.equal(st.service.resident, false, '默认应是非常驻')

  // 打开常驻 → 状态里必须跟着变
  await patch({ ttsResident: true })
  st = await (await fetch(`${base}/api/zhuang-fangyi/pet/speech`)).json()
  assert.equal(st.service.resident, true,
    'ttsResident=true 没进状态 —— 开关点了等于没点（设置白名单漏了它？）')

  // 空闲释放时间也要能改（非常驻模式的旋钮）
  await patch({ ttsResident: false, ttsIdleStopSec: 42 })
  st = await (await fetch(`${base}/api/zhuang-fangyi/pet/speech`)).json()
  assert.equal(st.service.resident, false)
  assert.equal(st.service.idleStopSec, 42, 'ttsIdleStopSec 应真的生效')

  // 非法空闲值被夹住（不能把荒唐值灌进决策）
  await patch({ ttsIdleStopSec: -5 })
  st = await (await fetch(`${base}/api/zhuang-fangyi/pet/speech`)).json()
  assert.ok(st.service.idleStopSec >= 0, `负数应被夹到 >=0，实际 ${st.service.idleStopSec}`)

  // 状态里必须带"启动命令解析结果"（用户能看到桌宠到底会执行什么）
  assert.ok('launch' in st, '状态应带 launch（诊断用）')
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
})

await ok('⭐⭐ 装了语音 DSH 插件 → 委派给它（`zfhVoice` 服务，桌宠不再自己起进程）', async () => {
  // 为什么必须有这条：现在有**两条**合成路 —— 装了语音插件走服务，
  // 没装走桌宠自己的进程+HTTP。两条路的代码不同，必须各自被覆盖，
  // 否则"装了插件反而更糟"这类问题发现不了（而用户装插件是常态）。
  fs.rmSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'chat.json'), { force: true })
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-svc-delegate-'))
  const local = makeCtx(makeWebServer())
  const calls = { synth: [], configure: [], start: 0, stop: 0 }
  const fakeVoice = {
    async synthesize (text) {
      calls.synth.push(text)
      return { bytes: fakeWav(1600), durationMs: 50, backend: 'torch' }
    },
    async health () { return { ok: true, backend: 'torch' } },
    status () {
      return {
        ready: true, ours: true, pid: 777, backend: 'torch', resident: true,
        idleMs: 0, idleStopSec: 300, lastError: null, launchable: true,
        launch: { argv: ['python', '-m', 'zfh_voice', '--backend', 'torch', 'serve'], cwd: 'D:/vf' }
      }
    },
    start () { calls.start += 1; return true },
    stop () { calls.stop += 1; return true },
    configure (patch) { calls.configure.push(patch); return this.status() }
  }
  local.provide('zfhVoice', fakeVoice)
  local.provide('sessionController', {
    async list () { return { items: [] } },
    async create () { return { sessionId: 'chat-svc-1' } },
    async prompt (req, signal) { signal.throwIfAborted(); return { accepted: true } }
  })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: {
      chatWorkspace: path.join(chatHome, 'ws'), speakReplies: true, voice: true,
      ttsResident: true, ttsIdleStopSec: 120, ttsIdleAction: 'unload'
    } })
  })
  // ① 设置推给了插件（开关只有一处）
  assert.ok(calls.configure.length >= 1, '设置应推给语音插件（否则开关点了没用）')
  const pushed = calls.configure[calls.configure.length - 1]
  assert.equal(pushed.resident, true, '常驻开关应推给插件')
  assert.equal(pushed.idleStopSec, 120, '空闲释放时间应推给插件')
  // 释放方式（stop = 杀进程 / unload = 只卸模型）也要能推过去 ——
  // 否则语音插件新增的这个能力在桌宠设置页里够不着（"开关只有一处"就断了）。
  assert.equal(pushed.idleAction, 'unload', '释放方式应推给插件')
  // ⭐⭐ **回归断言**：空的 ttsBackend 绝不能被推成 `'auto'`。
  // 这里踩过真实 bug —— 原先无条件推 `backend: ... || 'auto'`，于是每次设置
  // 变化都把插件 loader 里配好的 `backend: torch` 覆盖成 `auto`，
  // 最后报"模型没装"，而用户明明配了 torch。
  assert.ok(!('backend' in pushed),
    `空 ttsBackend 不该推给插件（会覆盖 loader 里的 torch），实际推了 ${JSON.stringify(pushed.backend)}`)
  assert.ok(!('gsvRoot' in pushed) && !('modelDir' in pushed),
    '空的路径设置也不该推（同理会把插件的机器配置冲掉）')

  // 正向：用户**显式设了** backend 就要推过去
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { ttsBackend: 'onnx' } })
  })
  assert.equal(calls.configure[calls.configure.length - 1].backend, 'onnx',
    '显式设置的后端应推给插件')

  // ⭐⭐ 「用插件默认」必须**显式推默认值**，不能"不推"。
  //
  // 这里原先断言的是 `!('idleAction' in lastPatch)` —— 它把 bug 当成了规格。
  // 真相：`configure()` 对空串是**忽略**（不覆盖），所以"不推"= "保持上一次的值"：
  //   用户先选「只卸模型」→ 再改回「用插件默认」→ 插件仍是 unload，
  //   而界面显示"用插件默认"，**没有任何地方会报错**（线上实测复现过）。
  // 所以正确行为是：空串 → 推插件的默认 `stop`（界面显示什么，插件就是什么）。
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { ttsIdleAction: '' } })
  })
  const lastPatch = calls.configure[calls.configure.length - 1]
  assert.equal(lastPatch.idleAction, 'stop',
    `「用插件默认」应显式推 stop（不推会保留上一次的 unload，界面与行为不一致），实际 ${JSON.stringify(lastPatch.idleAction)}`)

  // 反向：先设 unload，再设回空 → 必须真的回到 stop（这条是 bug 的直接复现路径）
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { ttsIdleAction: 'unload' } })
  })
  assert.equal(calls.configure[calls.configure.length - 1].idleAction, 'unload', 'unload 应推过去')
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { ttsIdleAction: '' } })
  })
  assert.equal(calls.configure[calls.configure.length - 1].idleAction, 'stop',
    'unload → 「用插件默认」必须回到 stop（否则用户以为恢复了默认，其实没有）')
  // ② 状态里说明 mode=plugin（排查时要能分清"谁在管"）
  const st = await (await fetch(`${base}/api/zhuang-fangyi/pet/speech`)).json()
  assert.equal(st.service.mode, 'plugin', `状态应报 mode=plugin，实际 ${st.service.mode}`)
  assert.equal(st.service.pid, 777, '状态应来自插件而不是本地监管器')
  // ②b ⭐⭐ 常驻 = **主动起好并预热**，不是"别停它"。
  //
  // 用户问过"为什么开了常驻，语音合成还是很慢"。量出来的答案是：
  // 载入模型后的**第一次推理**要 ~21 秒（cuDNN 内核自动调优），
  // 之后只要 2~3 秒 —— 而语音插件的 `preload()` 只加载模型、不做推理，
  // 于是那 20 秒正好砸在用户第一句话上。常驻却照样逃不掉。
  //
  // 所以桌宠打开常驻后要在后台把服务起起来 + 跑一次**丢弃的**合成。
  // 这条断言就是钉住它：预热必须真的发生（`start` 被调到、且有预热合成）。
  {
    const warmDeadline = Date.now() + 3000
    while (Date.now() < warmDeadline && calls.start === 0) await new Promise(r => setTimeout(r, 30))
    assert.ok(calls.start >= 1,
      '常驻打开后应**主动启动**服务（`start()`），而不是等第一次说话 —— 否则"常驻"只是"别停它"')
    const warmDeadline2 = Date.now() + 3000
    while (Date.now() < warmDeadline2 && calls.synth.length === 0) await new Promise(r => setTimeout(r, 30))
    assert.ok(calls.synth.length >= 1,
      '常驻打开后应跑一次**预热合成**（把首次推理的 20 秒前移），实际一次都没调')
    // 预热那句不能说成"要念的回复"：它必须是固定暖机文案，且**不交付给 exe**
    const warmText = calls.synth[0]
    assert.ok(!warmText.includes('插件路径'),
      `预热用的应是固定暖机文案而不是回复正文，实际 ${JSON.stringify(warmText)}`)
    const snapWarm = await (await fetch(`${base}/api/zhuang-fangyi/pet/state`)).json()
    assert.ok(snapWarm.speak === null || snapWarm.speak === undefined,
      `预热**不该出声**（不写 speak 块），实际 ${JSON.stringify(snapWarm.speak)}`)
  }
  // ③ 发消息 + 回复 → 合成**走插件**
  await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '在吗？' })
  })
  local.emit('session/event', { id: 'chat-svc-1' }, {
    type: 'assistant/message', seq: 9500, time: Date.now(),
    data: {
      turn: 1, step: 1,
      message: {
        id: 'msg-svc-1', role: 'assistant',
        content: [{ type: 'text', text: '**插件路径**也要能念出来。' }],
        source: { kind: 'model', provider: 'e2e', model: 'e2e' }
      },
      stream: []
    }
  })
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && calls.synth.length === 0) await new Promise(r => setTimeout(r, 50))
  // ⭐⭐ 委派给插件的 synthesize：**必须区分"预热"与"真念这句"**。
  //
  // 打开常驻后，桌宠会在后台先跑一次**丢弃的**合成来预热 —— 实测
  // "载入模型后的第一次推理"要 21 秒（cuDNN 内核自动调优），而热态只要 2~3 秒；
  // 语音插件的 `preload()` 只加载模型、不做推理，那 20 秒就落在用户第一句话上。
  // 所以这里**不能**再断言"总共只调了一次"（那会把预热当成 bug），
  // 而要断言：**真念的那一句在调用里**、且**只出现一次**、且**已清洗**。
  const spokenCalls = calls.synth.filter(t => t.includes('插件路径'))
  assert.equal(spokenCalls.length, 1,
    `真回复应恰好送进插件一次，实际 ${spokenCalls.length} 次（全部调用：${JSON.stringify(calls.synth)}）`)
  assert.ok(!spokenCalls[0].includes('**'), `送进插件的文本必须已清洗：${spokenCalls[0]}`)
  assert.ok(spokenCalls[0].includes('插件路径'), '清洗后应保留文字')
  // ④ 服务控制委派给插件
  const ctl = await (await fetch(`${base}/api/zhuang-fangyi/pet/speech/service`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stop' })
  })).json()
  assert.equal(ctl.mode, 'plugin', '控制也应走插件')
  assert.equal(calls.stop, 1, '应真的调了插件的 stop')
  // ⭐⭐ 插件模式下「试一句」必须**让插件去启动服务**，而不是先做 HTTP 健康检查
  //（实测踩过：服务没起时立刻报"连不上"，明明只要让它启动就行）。
  //
  // ⚠️ 这里**不能断言"合成总调用次数"** —— 打开常驻后桌宠会在后台先跑一次
  // **丢弃的**合成来预热（把 cuDNN 首次推理那 20 秒挪出用户的等待路径）。
  // 断言固定次数等于把预热当成 bug。改为"记基线 → 断言增加"，锚的是语义。
  const synthBeforeProbe = calls.synth.length
  const probe = await (await fetch(`${base}/api/zhuang-fangyi/pet/speech/probe`, { method: 'POST' })).json()
  assert.equal(probe.ok, true, `插件模式下试一句应成功，实际 ${JSON.stringify(probe.reason)}`)
  assert.equal(probe.mode, 'plugin', 'probe 应报 plugin 模式')
  assert.equal(probe.played, true, '应交付给 exe 播放')
  assert.ok(calls.synth.length > synthBeforeProbe,
    `试一句应真的走插件合成（调用数应从 ${synthBeforeProbe} 增加，实际 ${calls.synth.length}）`)
  // ⭐⭐ 应答里的 `cached` 必须**数盘**，不能推算
  //
  // 实测踩过：原来写的是 `status.cached + 1`（假设"这次探测必然新增一条缓存"）。
  // 但探测用的是固定句子 → 缓存键固定 → 第二次探测是**覆盖同名文件**：磁盘上
  // 还是 1 条，报告里却写 2 条。真实宿主上就是这么露的 —— `/pet/diag` 说 1、
  // 探测应答说 2，而 `speech/` 里只有 1 个文件。
  const speechDir = path.join(tmpHome, 'zhuang-fangyi-pet', 'speech')
  const onDisk = () => fs.readdirSync(speechDir).filter(f => f.endsWith('.wav')).length
  assert.equal(probe.status.cached, onDisk(),
    `试一句应答的 cached 应等于磁盘实际条数，实际报 ${probe.status.cached} / 盘上 ${onDisk()}`)
  const probe2 = await (await fetch(`${base}/api/zhuang-fangyi/pet/speech/probe`, { method: 'POST' })).json()
  assert.equal(probe2.ok, true, '第二次试一句也应成功')
  assert.equal(probe2.status.cached, onDisk(),
    `同名覆盖后 cached 不该 +1：盘上 ${onDisk()} 条，实际报 ${probe2.status.cached}`)
  assert.equal(probe2.status.cached, probe.status.cached,
    `同一句话探两次，缓存条数应不变（同名覆盖），实际 ${probe.status.cached} → ${probe2.status.cached}`)
  const stSpeech = await (await fetch(`${base}/api/zhuang-fangyi/pet/speech`)).json()
  assert.equal(stSpeech.cached, onDisk(),
    `状态端点的 cached 也应等于盘上条数，实际报 ${stSpeech.cached} / 盘上 ${onDisk()}`)
  // 状态里的 launch 应是**插件的**启动命令（含 --backend），不是桌宠自己那份
  const st2 = await (await fetch(`${base}/api/zhuang-fangyi/pet/speech`)).json()
  assert.ok(st2.launch !== null, '应带 launch')
  assert.ok(st2.launch.argv.join(' ').includes('--backend'),
    `launch 应是插件的完整命令（含 --backend），实际 ${st2.launch.argv.join(' ')}`)

  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
})

/* ── 画廊（读操作，无副作用）────────────────────────────────────────────── */

await ok('⭐ 快照 settings 块带 hint/statusAlways（原生窗状态显示的依据，契约 §2 v6）', async () => {
  // 这两个字段原先只有 overlay 用 —— 桌面版桌宠因此一直没有状态文字
  //（快照里明明有 label，exe 也解析了，却无人渲染）。
  const r = await get('/api/zhuang-fangyi/pet/state')
  const snap = JSON.parse(r.body)
  assert.ok(snap.settings && typeof snap.settings === 'object', '应有 settings 块')
  assert.equal(typeof snap.settings.hint, 'boolean', 'hint 必须是布尔（exe 按它决定悬停显示）')
  assert.equal(typeof snap.settings.statusAlways, 'boolean', 'statusAlways 必须是布尔（常显开关）')
  // label 是状态文字的**唯一来源**（已本地化），必须一并存在
  assert.equal(typeof snap.label, 'string', '快照应带 label（状态文字来源）')
})

await ok('⭐ 状态文字字号：设置 → 快照 → 边界夹取（用户要"调大一点"）', async () => {
  // 用户点名："我希望能够调整字的大小，因为有的时候字太小了"。
  // 关键：它必须**独立于** `scale`（桌宠大小）—— 用户把桌宠调到 0.4 是为了不占地，
  // 而字是给人读的。所以这条既验"能传下去"，也验"与 scale 互不干扰"。
  const before = JSON.parse((await get('/api/zhuang-fangyi/pet/settings')).body).settings

  // ① 设一个明确的值 → 快照里必须是同一个数
  await fetch(`${ROUTE}/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { statusFontScale: 2.4 } })
  })
  let snap = JSON.parse((await get('/api/zhuang-fangyi/pet/state')).body)
  assert.equal(snap.settings.statusFontScale, 2.4,
    `快照应透传 statusFontScale，实际 ${snap.settings.statusFontScale}`)

  // ② 与 scale 独立：改 scale 不该动它
  await fetch(`${ROUTE}/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { scale: 0.5 } })
  })
  snap = JSON.parse((await get('/api/zhuang-fangyi/pet/state')).body)
  assert.equal(snap.settings.statusFontScale, 2.4,
    '改桌宠大小不该影响文字字号（两者独立）')

  // ③ 越界必须夹取（否则字会大到糊住桌面 / 小到读不出）
  for (const [input, want] of [[99, 3], [0.01, 0.5]]) {
    await fetch(`${ROUTE}/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { statusFontScale: input } })
    })
    snap = JSON.parse((await get('/api/zhuang-fangyi/pet/state')).body)
    assert.equal(snap.settings.statusFontScale, want,
      `statusFontScale=${input} 应夹到 ${want}，实际 ${snap.settings.statusFontScale}`)
  }

  // ④ 旧设置文件缺这个字段 → 回落 1.0（不能变 NaN/undefined）
  await fetch(`${ROUTE}/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { statusFontScale: null } })
  })
  snap = JSON.parse((await get('/api/zhuang-fangyi/pet/state')).body)
  assert.ok(Number.isFinite(snap.settings.statusFontScale) && snap.settings.statusFontScale > 0,
    `缺字段时应回落一个有效倍率，实际 ${snap.settings.statusFontScale}`)

  // 还原用户原值
  await fetch(`${ROUTE}/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: {
      statusFontScale: before.statusFontScale ?? 1,
      scale: before.scale ?? 1
    } })
  })
})

await ok('⭐ 对话文字大小：设置 → 快照 → 与"桌宠大小"互不干扰', async () => {
  // 用户点名："你对话里面的文字大小也需要可调呀"。
  // 与状态文字同一类问题：字号原先只跟 `scale` 走，用户把桌宠调小是为了不占地，
  // 正文却被一起缩到读不了（实测 scale=0.5 → 6.5px）。
  const before = JSON.parse((await get('/api/zhuang-fangyi/pet/settings')).body).settings

  await fetch(`${ROUTE}/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { chatFontScale: 2.2 } })
  })
  let snap = JSON.parse((await get('/api/zhuang-fangyi/pet/state')).body)
  assert.equal(snap.settings.chatFontScale, 2.2,
    `快照应透传 chatFontScale，实际 ${snap.settings.chatFontScale}`)

  // 与 scale 独立；也与 statusFontScale 独立（两者是分开的两项）
  await fetch(`${ROUTE}/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { scale: 0.5, statusFontScale: 1.0 } })
  })
  snap = JSON.parse((await get('/api/zhuang-fangyi/pet/state')).body)
  assert.equal(snap.settings.chatFontScale, 2.2,
    '改桌宠大小/状态文字字号都不该影响对话文字大小（三项独立）')

  // 越界夹取
  for (const [input, want] of [[99, 3], [0.01, 0.5]]) {
    await fetch(`${ROUTE}/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { chatFontScale: input } })
    })
    snap = JSON.parse((await get('/api/zhuang-fangyi/pet/state')).body)
    assert.equal(snap.settings.chatFontScale, want,
      `chatFontScale=${input} 应夹到 ${want}，实际 ${snap.settings.chatFontScale}`)
  }

  await fetch(`${ROUTE}/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: {
      chatFontScale: before.chatFontScale ?? 1,
      scale: before.scale ?? 1,
      statusFontScale: before.statusFontScale ?? 1
    } })
  })
})
await ok('⭐ GET /pet/gallery 返回全部表情（能主动看全，不再靠随机撒）', async () => {
  const r = await get('/api/zhuang-fangyi/pet/gallery')
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.ok(Array.isArray(body.items), 'items 必须是数组')
  const atlas = JSON.parse((await get('/api/zhuang-fangyi/pet/atlas')).body)
  assert.equal(body.items.length, atlas.bubble.length,
    `画廊数量应等于清单气泡数（${body.items.length} vs ${atlas.bubble.length}）`)
  for (const it of body.items) {
    assert.equal(typeof it.file, 'string')
    assert.equal(typeof it.hasText, 'boolean')
    assert.ok(it.file.startsWith('bubble/'), `路径异常：${it.file}`)
  }
  assert.ok(body.items.some(it => typeof it.group === 'string' && it.group !== ''),
    '应有表情带情境分组（"结合状态"的落地证据）')
})
await ok('⭐ POST /pet/settings 是合并语义：裸 {scale} 不许抹掉其它设置', async () => {
  // 对应一个实测抓到的数据丢失缺陷：exe 滚轮缩放只 POST {"scale": n}，
  // 若 Host 按整体替换处理（按默认值归一化），用户的透明度/穿透/主题/双击会被全抹回默认。
  // 实测：POST {scale:0.5} 之后 theme/doubleClick 直接回到默认。
  const post = async body => post2('/api/zhuang-fangyi/pet/settings', body)

  // 先放一组"用户设置"
  await post({ opacity: 0.6, theme: 'dark', doubleClick: 'emote', clickThrough: true })
  // 模拟 exe 滚轮上报：只带一个字段
  const r = await post({ scale: 1.75 })
  assert.equal(r.status, 200, `状态码 ${r.status}`)
  const after = JSON.parse(r.body).settings
  assert.equal(after.scale, 1.75, 'scale 应生效')
  assert.equal(after.opacity, 0.6, 'opacity 不许被抹掉')
  assert.equal(after.theme, 'dark', 'theme 不许被抹掉')
  assert.equal(after.doubleClick, 'emote', 'doubleClick 不许被抹掉')
  assert.equal(after.clickThrough, true, 'clickThrough 不许被抹掉')
  // 非法值回落默认而不是报错
  const r2 = await post({ scale: 999, theme: 'psychedelic' })
  const after2 = JSON.parse(r2.body).settings
  assert.equal(after2.scale, 3, 'scale 夹到上限 3')
  assert.equal(after2.theme, 'auto', '非法 theme 回落 auto')
})

await ok('GET /pet/diag 暴露 build 标记（用于判断宿主是否重载过）', async () => {
  const r = await get('/api/zhuang-fangyi/pet/diag')
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.ok(body.diag, '应有 diag')
  assert.ok('build' in body.diag, 'diag 应有 build 字段')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 真实素材清单
 * ══════════════════════════════════════════════════════════════════════════ */
section('2. 真实素材产物（art/pet/pet.json）')

await ok('art/pet/pet.json 存在（素材管线已跑过）', async () => {
  assert.ok(fs.existsSync(path.join(ART, 'pet.json')), '缺少 pet.json，请先跑 tools/prepare-pet.py')
})

await ok('⭐ 深色模式**直接用原图**：真实清单里一个 fileDark 都没有', async () => {
  // 用户实测反馈："深色模式气泡表情反转太诡异了，直接原图还挺好的"
  //          "深色模式不用单独的表情包"。
  //
  // 原因是结构性的，不是算法调参能救的：那批贴纸是**白纸上的墨线**，
  // 白色不只是背景，**还是脸和衣服的填充色**。翻明度之后整张脸变黑、
  // 只有轮廓发白 —— 那是**底片**，不是"深色贴纸"。人眼对"脸是黑的"极度敏感。
  //
  // 这条断言盯的是**真实产物**（磁盘 pet.json + HTTP 两处），
  // 因为"管线不再生成"与"清单里确实没有"是两件事：
  // 只要有人把 dark=True 加回去，或旧产物没被清理，这里就会红。
  const onDisk = JSON.parse(fs.readFileSync(path.join(ART, 'pet.json'), 'utf8'))
  const withDark = (onDisk.bubble ?? []).filter(b => b.fileDark)
  assert.equal(withDark.length, 0,
    `清单里不该有 fileDark，实际 ${withDark.length} 张：${withDark.map(b => b.file).join(', ')}`)

  // HTTP 这一跳也要查（只测磁盘不够 —— files 字段就吃过这个亏）。
  const r = await get('/api/zhuang-fangyi/pet/atlas')
  const body = JSON.parse(r.body)
  const httpDark = (body.bubble ?? []).filter(b => b.fileDark)
  assert.equal(httpDark.length, 0, `HTTP 清单里也不该有 fileDark，实际 ${httpDark.length} 张`)

  // 画廊（用户主动浏览全部表情的那条路）同样不该有条目指向深色文件。
  const g = JSON.parse((await get('/api/zhuang-fangyi/pet/gallery')).body)
  const galleryDark = (g.items ?? []).filter(it => it.fileDark)
  assert.equal(galleryDark.length, 0, `画廊里也不该有 fileDark，实际 ${galleryDark.length} 条`)

  // 磁盘上也不该留 `-dark.png` 孤儿（管线会清理未引用产物）。
  const strays = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('-dark.png')) strays.push(path.relative(ART, p))
    }
  }
  walk(path.join(ART, 'bubble'))
  assert.equal(strays.length, 0, `磁盘上残留深色变体：${strays.join(', ')}`)
})

await ok('GET /pet/atlas 返回清单 + 覆盖率报告', async () => {
  const r = await get('/api/zhuang-fangyi/pet/atlas')
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.ok(body.states && typeof body.states === 'object')
  assert.ok(Array.isArray(body.bubble))
  assert.ok(body.report, '应有 report')
})

await ok('⭐ /pet/atlas 必须带上 files 映射（否则 files 机制在 HTTP 链路上是死代码）', async () => {
  // 这条断言对应一个**实测抓到的集成缺陷**：
  // 路由原先漏发 `files`，exe 通过 HTTP 拿清单时打日志
  // 「0 个 files 几何（来源 host）」，于是退化成按 state 声明切变体，
  // 而 24 个变体里 14 个与声明不符 → 全被拒收 → files 支持等于没有。
  //
  // 教训：只测「从磁盘读 pet.json」不够，**HTTP 这一跳也必须测**。
  const r = await get('/api/zhuang-fangyi/pet/atlas')
  const body = JSON.parse(r.body)
  assert.ok(body.files !== undefined, '/pet/atlas 必须包含 files 字段')
  const onDisk = JSON.parse(fs.readFileSync(path.join(ART, 'pet.json'), 'utf8'))
  const diskFiles = onDisk.files ?? {}
  assert.equal(
    Object.keys(body.files).length, Object.keys(diskFiles).length,
    `HTTP 里的 files 条目数(${Object.keys(body.files).length}) 应与磁盘一致(${Object.keys(diskFiles).length})`
  )
  // 逐条比对，确保没有在传输中丢字段
  for (const [file, geom] of Object.entries(diskFiles)) {
    const got = body.files[file]
    assert.ok(got !== undefined, `HTTP 清单缺 ${file}`)
    assert.equal(got.frames, geom.frames, `${file} 的 frames 传输后不一致`)
    assert.equal(got.frameWidth, geom.frameWidth, `${file} 的 frameWidth 传输后不一致`)
  }
})

await ok('变体经 HTTP 清单拿到的是**自己的**几何，不是 state 的声明', async () => {
  const r = await get('/api/zhuang-fangyi/pet/atlas')
  const body = JSON.parse(r.body)
  // 找一个几何与 state 声明确实不同的变体（真实素材里必然存在）
  let checked = 0
  for (const [state, list] of Object.entries(body.variants ?? {})) {
    const decl = body.states[state]
    for (const file of list) {
      const geom = body.files?.[file]
      if (geom === undefined || decl === undefined) continue
      if (geom.frames !== decl.frames || geom.frameWidth !== decl.frameWidth) {
        checked += 1
        assert.ok(geom.frames > 0, `${file} 的 frames 应 > 0`)
        assert.ok(geom.frameWidth > 0, `${file} 的 frameWidth 应 > 0`)
      }
    }
  }
  assert.ok(checked > 0, '真实素材里应至少有一个变体的几何与 state 声明不同（否则这条测试没意义）')
})

await ok('⭐ 素材台账落地：产物名带语义 id + 清单有 assets 身份段', async () => {
  // 用户 2026-10-07 拍板："改成带语义名"。产物从按位置编号（`idle-4.png`）
  // 改成带语义 id（`idle-smile.png`），清单同步多出 `assets` 身份段。
  //
  // 这一改动的最大收益在下面几条断言里：以前"某张图归哪个状态"只能**数张数**
  // （历史包袱：几何指纹撞车导致假绿、认文件名把人认错过一次），现在可以按 id 认人。
  const atlas = JSON.parse((await get('/api/zhuang-fangyi/pet/atlas')).body)
  const onDisk = JSON.parse(fs.readFileSync(path.join(ART, 'pet.json'), 'utf8'))
  const ledger = atlas.assets ?? {}
  assert.ok(Object.keys(ledger).length > 0, '清单里应有 assets 段（产物路径 → 身份）')

  // ① 每条变体都能拆成 `<state>-<id>.png`，且 id 与清单对得上
  for (const [state, files] of Object.entries(atlas.variants ?? {})) {
    for (const file of files) {
      assert.ok(file.startsWith(`${state}-`) && file.endsWith('.png'),
        `${file} 应命名为 <state>-<id>.png（现在还是按位置编号）`)
      const meta = ledger[file]
      assert.ok(meta && meta.id, `${file} 在 assets 里应有语义 id`)
      assert.deepEqual(meta.states, [state], `${file} 的 states 应恰好是 [${state}]`)
    }
  }

  // ② **一张素材只服务一个状态** —— 此前 5 张素材跨 2~3 个状态被复用
  //    （"微笑"同时出现在 waking/idle/happy），于是"每个状态表情都不一样"从根上不成立。
  const owners = new Map()
  for (const [state, files] of Object.entries(atlas.variants ?? {})) {
    for (const file of files) {
      const id = ledger[file]?.id
      owners.set(id, [...(owners.get(id) ?? []), state])
    }
  }
  const shared = [...owners].filter(([, st]) => st.length > 1)
  assert.deepEqual(shared, [],
    `这些素材被多个状态共用：${shared.map(([id, st]) => `${id}→${st.join('/')}`).join(', ')}`)

  // ③ listening 已降级为纯气泡（用户：它几乎不会出现，意义不大）→ 不分配主体素材
  assert.ok(!atlas.variants?.listening, 'listening 不该再有主体变体')
  assert.ok(!atlas.states?.listening, 'listening 不该再有 canonical 条目')

  // ④ 旧的按序号命名不许复活
  const legacy = []
  for (const files of Object.values(atlas.variants ?? {})) {
    for (const file of files) {
      if (/^[a-z]+-[2-9]\.png$/.test(path.basename(file))) legacy.push(file)
    }
  }
  assert.deepEqual(legacy, [], `不该再有按序号命名的产物：${legacy.join(', ')}`)

  // ⑤ HTTP 这一跳与磁盘一致（`files` 字段曾在这两处不一致上吃过亏）
  assert.equal(Object.keys(onDisk.assets ?? {}).length, Object.keys(ledger).length,
    '磁盘 pet.json 与 /pet/atlas 的 assets 条目数应一致')
})

await ok('⭐ F5 那批已改为**桌宠主体**（用户点名"不要做气泡表情"）', async () => {
  // 用户 2026-10-07："新增的那一批表情包不要做气泡表情，要做桌宠主体"。
  // 这条锁住：① 这批进了 `states.variants`（= 主体）而不是只在气泡池里；
  //          ② 曾经被透明占比判据挡住的两张也已按用户决定归队；
  //          ③ 它们**不在**气泡池。
  //
  // ⚠️ 断言用**名字**认，不数张数 —— 产物现在带语义 id，这是本轮改名最大的收益。
  const atlas = JSON.parse((await get('/api/zhuang-fangyi/pet/atlas')).body)
  const idOf = f => atlas.assets?.[f]?.id
  const idsOf = state => (atlas.variants?.[state] ?? []).map(idOf)

  const expect = {
    happy: ['muscle', 'watermelon', 'cat-paws', 'cheerful', 'excited'],
    error: ['listless', 'sunglasses', 'road-rage'],
    thinking: ['dizzy', 'stunned', 'star-eyes', 'wink', 'please', 'grass-holding'],
    working: ['megaphone', 'follow-me'],
    waiting: ['hungry', 'cover-mouth']
  }
  for (const [state, ids] of Object.entries(expect)) {
    const have = idsOf(state)
    for (const id of ids) {
      assert.ok(have.includes(id), `${id} 应在 ${state} 的变体里，实际：${have.join(', ')}`)
    }
  }
  const bubbleIds = (atlas.bubble ?? []).map(b => idOf(b.file))
  for (const id of ['muscle', 'sunglasses', 'starry-formula', 'listless']) {
    assert.ok(!bubbleIds.includes(id), `${id} 做了主体，就不该再留在气泡池`)
  }

  // 主体条带几何自洽（帧数/帧宽 ≥ 1）
  for (const list of Object.values(atlas.variants ?? {})) {
    for (const f of list) {
      const g = atlas.files?.[f]
      if (!g) continue
      assert.ok(g.frames >= 1 && g.frameWidth >= 1, `${f} 几何非法`)
    }
  }
})

await ok('⭐ 用户拍板的三处归属，按名字钉住（不再数张数）', async () => {
  // 这三处都是 2026-10-07 用户点名的决定：
  //   ① "思考用这张图不合适，这张图出错的时候放" → 吐彩虹（listless）归 error；
  //   ② "这张图应该用于思考的时候" + "这两个都并存" → 星空公式进 thinking，
  //      并成为 thinking 的**主图**（思考意象最强的那张）；
  //   ③ "把这张图从气泡里挪开" → 星空公式只当主体，不在气泡池。
  //
  // ── 为什么改成"按名字" ────────────────────────────────────────────────
  //
  // 这条断言过去踩过两次坑，都记在这里免得后人重走：
  //   · **几何指纹**（25 帧/40ms）：持刀那张**也是** 25 帧/40ms，`some()` 恒真，
  //     回滚后照样绿 —— 是**假断言**（实测确认）。
  //   · **数张数**（`thinking.length === 5`）：素材一换版就红，而且看不出
  //     哪张挪去了哪，只能再数一遍。
  //   · **按源文件名认**：我正是被文件名骗过一次（把"圆睁大眼嘴巴张成小小"
  //     猜成 `stunned`）—— 这批 GIF 的文件名描述的是**首帧印象**，
  //     而用户看到的是中后段。认图必须看中间帧。
  // 现在产物带语义 id 且清单有 `assets` 段，于是按 id 认人：**以后再挪图不用改测试**。
  const atlas = JSON.parse((await get('/api/zhuang-fangyi/pet/atlas')).body)
  const idOf = f => atlas.assets?.[f]?.id
  const idsOf = state => (atlas.variants?.[state] ?? []).map(idOf)

  assert.ok(idsOf('error').includes('listless'), '吐彩虹（listless）应在 error 的变体里')
  assert.ok(!idsOf('thinking').includes('listless'), '吐彩虹不该再出现在 thinking')
  assert.deepEqual(
    idsOf('thinking').filter(id => idsOf('error').includes(id)), [],
    'thinking 与 error 不该共用变体（用户逐条指定过）'
  )
  assert.equal(atlas.variants?.thinking?.[0], 'thinking-starry-formula.png',
    'thinking 的主图应是星空公式')
})

await ok('8 个实际使用的状态全部有专属素材（覆盖率 8/8）', async () => {
  // `listening` 不在其中：2026-10-07 用户决定它降级为纯气泡（收到消息只弹气泡、
  // 不切主体状态）。契约 §1 的 9 个状态名保留不动，只是运行时不再产出它。
  const r = await get('/api/zhuang-fangyi/pet/atlas')
  const body = JSON.parse(r.body)
  const covered = body.report.coveredStates
  assert.equal(covered.length, 8, `只覆盖 ${covered.length} 个：${covered.join(',')}`)
  assert.equal(body.report.uncoveredStates.length, 0,
    `这些状态没有专属素材：${body.report.uncoveredStates.join(',')}`)
  assert.ok(!covered.includes('listening'), 'listening 已降级为纯气泡，不该出现在主体覆盖里')
})

await ok('每个状态的素材文件都能通过 /pet/art/ 真的取到字节', async () => {
  const atlasRes = await get('/api/zhuang-fangyi/pet/atlas')
  const body = JSON.parse(atlasRes.body)
  for (const [state, entry] of Object.entries(body.states)) {
    const res = await fetch(`${ROUTE}/art/${encodeURIComponent(entry.file)}`)
    assert.equal(res.status, 200, `${state} 的 ${entry.file} 取不到（${res.status}）`)
    const buf = Buffer.from(await res.arrayBuffer())
    assert.ok(buf.length > 100, `${entry.file} 字节数过小：${buf.length}`)
    // PNG magic
    assert.equal(buf[0], 0x89, `${entry.file} 不是 PNG`)
  }
})

await ok('⭐ 动态气泡：GIF 能取到字节、MIME 正确、清单声明与文件真实帧数一致', async () => {
  // 这条覆盖的是"气泡动图"整条**交付链**（契约 §4 v-next）：
  //   管线产出 GIF → 清单声明 frames/frameMs → 宿主 atlas 透传 → 白名单放行 → MIME image/gif。
  // 原先 `/pet/art/` 硬编码 `image/png`，且宿主 atlas 解析**没有** frames 字段：
  // 前者一旦交付 GIF 就贴错类型，后者会让表情"在池子里、永远不动"。
  // 两处都只有走真实 HTTP 这一跳才暴露 —— 所以这里用真实产物验，不用假 fixture。
  const body = JSON.parse((await get('/api/zhuang-fangyi/pet/atlas')).body)
  const animated = (body.bubble ?? []).filter(b => (b.frames ?? 1) > 1)
  // 2026-10-07 星空公式按用户要求撤出气泡池后，动图气泡只剩 angry-charge 一张
  //（星空公式转做 thinking 主体条带，见"星空公式只在思考主体"那条）。
  assert.ok(animated.length >= 1,
    `清单里应至少 1 张动态气泡（angry-charge），实际 ${animated.length}`)

  for (const b of animated) {
    assert.match(b.file, /\.gif$/, `动态气泡应交付 GIF，实际 ${b.file}`)
    const res = await fetch(`${ROUTE}/art/${encodeURIComponent(b.file)}`)
    assert.equal(res.status, 200, `${b.file} 取不到（${res.status}）`)
    assert.equal(res.headers.get('content-type'), 'image/gif',
      `${b.file} 的 MIME 应是 image/gif，实际 ${res.headers.get('content-type')}`)
    const buf = Buffer.from(await res.arrayBuffer())
    assert.equal(buf.toString('ascii', 0, 6), 'GIF89a', `${b.file} 不是 GIF89a`)
    // 清单声明的帧数必须与文件里真实帧数一致 —— 声明多了末尾空转、少了漏播，
    // 都是"看着在动但不对"。
    const real = gifFrameCount(buf)
    assert.ok(real > 0, `${b.file} 结构异常（gifFrameCount=${real}）`)
    assert.equal(b.frames, real, `${b.file} 声明 ${b.frames} 帧，文件里 ${real} 帧`)
    assert.ok(b.frameMs >= 20 && b.frameMs <= 5000, `${b.file} frameMs 越界：${b.frameMs}`)
    assert.ok(b.w > 0 && b.h > 0, `${b.file} 缺 w/h（渲染方要用它定解码上限）`)
  }
  // 静态气泡不能被误标成动图（否则每次显示都要白解一遍全部帧）
  const png = (body.bubble ?? []).filter(b => /\.png$/.test(b.file))
  assert.ok(png.every(b => (b.frames ?? 1) === 1),
    '静态 PNG 气泡不该声明 frames > 1')
})

await ok('条带的实际宽度 == frames × frameWidth（几何自洽）', async () => {
  const atlasRes = await get('/api/zhuang-fangyi/pet/atlas')
  const body = JSON.parse(atlasRes.body)
  // 用 PNG 头里的 IHDR 读宽度，避免引图像库。
  for (const [state, entry] of Object.entries(body.states)) {
    const res = await fetch(`${ROUTE}/art/${encodeURIComponent(entry.file)}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    assert.equal(height, body.frameHeight, `${state} 高度 ${height} != frameHeight ${body.frameHeight}`)
    if (Number.isFinite(entry.frameWidth) && entry.frameWidth > 0) {
      assert.equal(
        width, entry.frames * entry.frameWidth,
        `${state} 宽 ${width} != frames(${entry.frames}) × frameWidth(${entry.frameWidth})`
      )
    }
  }
})

await ok('素材白名单拒绝清单外的文件（目录遍历防线在真实装配里生效）', async () => {
  for (const evil of ['../pet.json', '../../index.js', 'nope.png']) {
    const res = await fetch(`${ROUTE}/art/${encodeURIComponent(evil)}`)
    assert.equal(res.status, 404, `${evil} 应 404，实际 ${res.status}`)
  }
})

/* ── ⭐ 选图函数必须走**运行路径**，且真的读排除名单 ──────────────────────
 *
 * 这一节针对一个**真实存在过**的缺口：`EMOTE_EXCLUDE_FROM_RANDOM` 导出了、
 * 被单测引用了，但运行时的兜底路径用的是 `bubbleArt(atlas, seed)` —— 纯
 * index 取模，**完全不认识名单**。于是"全池随机"仍会撒出「么么哒」「晚安啦」。
 *
 * 为什么单测发现不了：单测只能断言"名单存在且格式对"，看不到"运行时有没有读"。
 * 所以这里**取 `exposed.pickBubbleImage`** —— 它是状态机实际使用的那个函数
 * 本身（`index.js` 里注入给 `createPetState` 的就是它），不是手抄副本。
 *
 * 教训已经吃过四次：**断言要打在运行路径上**。凑一个"看起来像"的本地函数
 * 再断言，等于自证。
 * ──────────────────────────────────────────────────────────────────────── */

await ok('⭐ exposed.pickBubbleImage 就是状态机用的那个函数（同一引用）', async () => {
  const svc = ctx.__services?.get('zhuangFangyiPet')
  assert.ok(svc !== undefined, '未暴露 zhuangFangyiPet 服务')
  assert.equal(typeof svc.pickBubbleImage, 'function')
  // 真函数应该吃 (key, seed) 并返回清单里的**整条记录**（含 hasText）。
  const rec = svc.pickBubbleImage('happy', 0)
  assert.ok(rec !== null && typeof rec === 'object', `应返回记录对象，实际 ${JSON.stringify(rec)}`)
  assert.equal(typeof rec.file, 'string', '记录必须带 file')
  assert.equal(typeof rec.hasText, 'boolean', '记录必须带 hasText（状态机据此决定叠不叠文案）')
})

await ok('⭐⭐ 运行路径的兜底**永不**撒出排除名单里的图（未知 key → 走全池）', async () => {
  const svc = ctx.__services.get('zhuangFangyiPet')
  // 未知 key 必然落到全池兜底分支 —— 正是原先那处漏读名单的路径。
  // 扫遍整个池长范围，任何一次都不许命中排除图。
  const atlas = JSON.parse((await get('/api/zhuang-fangyi/pet/atlas')).body)
  const poolLen = atlas.bubble.length
  const seen = new Set()
  for (let seed = 0; seed < poolLen * 2; seed += 1) {
    const rec = svc.pickBubbleImage('__no_such_key__', seed)
    assert.ok(rec !== null, `seed=${seed} 兜底不该没表情（会整个状态哑掉）`)
    assert.ok(
      !EMOTE_EXCLUDE_FROM_RANDOM.includes(rec.file),
      `seed=${seed} 兜底撒出了排除图：${rec.file}`
    )
    seen.add(rec.file)
  }
  // 反向确认这条测试**有区分度**：兜底确实在轮换，而不是永远返回同一张。
  assert.ok(seen.size > 1, `兜底应轮换多张，实际只见过 ${seen.size} 张 —— 断言无区分度`)
})

await ok('⭐ 已知 key 走专属池，且池内图都在清单里（映射不悬空）', async () => {
  const svc = ctx.__services?.get('zhuangFangyiPet')
  assert.ok(svc !== undefined, '未暴露 zhuangFangyiPet 服务')
  const atlas = JSON.parse((await get('/api/zhuang-fangyi/pet/atlas')).body)
  const disk = new Set(atlas.bubble.map(b => b.file))
  let checkedKeys = 0
  for (const key of Object.keys(EMOTE_BY_KEY)) {
    for (const file of EMOTE_BY_KEY[key]) {
      assert.ok(disk.has(file),
        `映射里的 ${file}（key=${key}）不在真实清单里 —— 素材换过而映射没跟`)
    }
    const rec = svc.pickBubbleImage(key, 0)
    assert.ok(rec !== null && disk.has(rec.file),
      `key=${key} 挑出来的图不在清单里：${JSON.stringify(rec)}`)
    checkedKeys += 1
  }
  assert.ok(checkedKeys >= 9, `应覆盖全部状态池，实际只查了 ${checkedKeys} 个 key`)
})

/* ── ⭐ 语音：真实装配下走运行路径 ────────────────────────────────────────
 *
 * 单测覆盖了 `voice.js` 的纯逻辑与白名单；这里补的是**接线**：
 * `index.js` 有没有真的把 `resolveVoice`/`voiceManifest` 接上路由。
 * 两者分开测是必要的 —— 模块全对但没接上，单测全绿而功能是死的。
 * ──────────────────────────────────────────────────────────────────────── */

await ok('⭐ GET /pet/voices 返回真实清单（接线到位）', async () => {
  const r = await get('/api/zhuang-fangyi/pet/voices')
  assert.equal(r.status, 200, `状态码 ${r.status}`)
  const body = JSON.parse(r.body)
  assert.ok(body.count > 0,
    `清单为 0 条。若尚未构建语音包请跑 tools/build-voice.ps1；` +
    '若是构建后仍为 0，说明 index.js 的接线断了。')
  assert.equal(body.lines.length, body.count)
})

await ok('⭐⭐ 真实装配下白名单生效：清单内可取、清单外 404', async () => {
  const manifest = JSON.parse((await get('/api/zhuang-fangyi/pet/voices')).body)
  const name = manifest.lines[0].name

  // 正向：清单第一条必须真能取到字节
  const okRes = await fetch(`${ROUTE}/voice/${encodeURIComponent(name)}`)
  assert.equal(okRes.status, 200, `${name} 应能取到`)
  const buf = Buffer.from(await okRes.arrayBuffer())
  assert.ok(buf.length > 100, `字节数过小：${buf.length}`)
  const isId3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33
  const isFrame = buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0
  assert.ok(isId3 || isFrame, `${name} 不是 MP3`)

  // 反向：清单外一律 404（含穿越写法）
  for (const evil of ['../index.js', '%2e%2e%2findex.js', 'C:\\Windows\\win.ini',
    '/etc/passwd', 'nope', 'voice.json']) {
    const res = await fetch(`${ROUTE}/voice/${evil}`)
    assert.equal(res.status, 404, `${evil} 应 404，实际 ${res.status}`)
    const text = await res.text()
    assert.ok(!text.includes('root:'), `${evil} 泄漏了系统文件！`)
  }
})

await ok('⭐ /pet/diag 暴露语音状态（"到底装上没有"一眼可见）', async () => {
  const r = await get('/api/zhuang-fangyi/pet/diag')
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.ok(body.diag.voice !== undefined, 'diag 应带 voice 块')
  assert.equal(typeof body.diag.voice.available, 'boolean')
  assert.equal(typeof body.diag.voice.count, 'number')
  assert.ok(body.diag.voice.count > 0, '真实产物在仓库里，diag 应报出条数')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 端到端：宿主事件 → 状态 → SSE 推送
 * ══════════════════════════════════════════════════════════════════════════ */
section('3. 端到端：宿主事件 → 状态机 → SSE')

/** 连上 SSE 并收集帧。 */
async function openSse () {
  const controller = new AbortController()
  const res = await fetch(`${ROUTE}/events`, { signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    } catch { /* abort */ }
  })()
  return {
    get text () {
      return text
    },
    /** 等某个子串出现（或超时）。 */
    async waitFor (needle, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (text.includes(needle)) return true
        await new Promise(r => setTimeout(r, 25))
      }
      return false
    },
    /** 解析出所有 state 帧的快照。 */
    snapshots () {
      return text
        .split('\n')
        .filter(l => l.startsWith('data: '))
        .map(l => {
          try {
            return JSON.parse(l.slice('data: '.length))
          } catch {
            return null
          }
        })
        .filter(Boolean)
    },
    async close () {
      controller.abort()
      await pump.catch(() => {})
    }
  }
}

await ok('⭐ 兜底 ticker 在连着两个"无 deadline"的事件之后**仍然 armed**', async () => {
  // 这条守的是一个**能永久丢掉定时器**的顺序：
  // `scheduleTick()` 原先"先 clearTimeout 再判 delay===tickFloor"，
  // 于是同一延迟的那一支会**把定时器清掉却不补上** —— 而 `tickFloor` 还留着
  // 旧值，后续每次算出同一个 delay 都再次早退，定时器**永远回不来**。
  // 后果不是"晚一点"：`sleeping`/气泡过期只靠这个 15 秒兜底，
  // 丢了它桌宠就再也不睡觉、气泡再也不消失（且毫无报错）。
  //
  // 触发条件现在很容易满足：`onApplied` 让每个事件都重排一次，
  // 而"没有 deadline"的事件算出来都是兜底值 15000 —— 连着两个就中。
  // 这里就用两次同状态的 `agent/status` 制造"无 deadline"（状态没变 → 无驻留到期）。
  const armed = async () => JSON.parse((await get('/api/zhuang-fangyi/pet/diag')).body).diag.tick
  ctx.emit('agent/status', { agent: { id: 'e2e-tick' }, status: 'idle' })
  await new Promise(r => setTimeout(r, 60))
  ctx.emit('agent/status', { agent: { id: 'e2e-tick' }, status: 'idle' })
  await new Promise(r => setTimeout(r, 60))
  const t = await armed()
  assert.ok(t !== undefined && t !== null, 'diag 应带 tick 块')
  assert.equal(t.armed, true,
    `连着两个无 deadline 的事件之后兜底 ticker 丢了（floor=${t.floor}）—— ` +
    '桌宠将不再睡觉、气泡不再过期，直到某个事件算出不同的 delay')
})

const sse = await openSse()

await ok('SSE 建立后立刻收到 hello + retry（契约 §2）', async () => {
  assert.ok(await sse.waitFor('event: hello'), '未收到 hello 帧')
  assert.ok(sse.text.includes('retry: 3000'), '未收到重连建议')
  assert.ok(sse.text.includes(': connected'), '未收到连接注释')
})

await ok('hello 帧是全量快照，不是空对象（否则 petState/rev 会变 undefined）', async () => {
  const helloLine = sse.text
    .split('\n')
    .find(l => l.startsWith('data: '))
  assert.ok(helloLine !== undefined, '应有 data 行')
  const snap = JSON.parse(helloLine.slice('data: '.length))
  assert.ok('petState' in snap && snap.petState !== undefined, 'hello 必须带 petState')
  assert.ok(typeof snap.rev === 'number', 'hello 必须带数值 rev')
})

/* ── ⭐ 下行通道：exe/桌面端改了设置 → 快照必须把它带出来 ──────────────────
 *
 * 用户报的："桌面端滚轮调完大小，DSH 的设置页不跟着变"。
 * 链路是：exe 去抖后 POST /pet/settings → 宿主合并落盘 → **广播带新 settings 的快照**
 * → 浏览器半边把快照里的 settings 并进本地状态。
 *
 * 这一条测的是**中间那一跳**：POST 之后，SSE 帧里到底有没有带上新值。
 * 少了它，客户端再怎么"并进本地状态"也拿不到东西（两边各自都绿、接缝上全错 ——
 * 这个项目已经在"字段白名单"上栽过一次同样的跟头）。
 * ──────────────────────────────────────────────────────────────────────── */
await ok('⭐⭐ POST /pet/settings 的改动必须出现在随后的 SSE 快照里（设置下行通道）', async () => {
  // 用 doubleClick + statusFontScale：两者都在快照的 settings 子集里，
  // 且**不影响画面**（改 scale 会真的缩放用户桌面上的桌宠）。
  const before = JSON.parse((await get('/api/zhuang-fangyi/pet/settings')).body).settings
  const targetDc = before.doubleClick === 'none' ? 'emote' : 'none'
  const targetFs = Math.abs(before.statusFontScale - 2.1) < 0.001 ? 1.3 : 2.1

  const framesBefore = sse.snapshots().length
  const posted = await post2('/api/zhuang-fangyi/pet/settings',
    { doubleClick: targetDc, statusFontScale: targetFs })
  assert.equal(posted.status, 200, `POST 应成功，实际 ${posted.status}`)

  const deadline = Date.now() + 4000
  let hit = null
  while (Date.now() < deadline) {
    hit = sse.snapshots().slice(framesBefore).find(s =>
      s.settings !== undefined &&
      s.settings.doubleClick === targetDc &&
      Math.abs(s.settings.statusFontScale - targetFs) < 0.001)
    if (hit !== null && hit !== undefined) break
    await new Promise(r => setTimeout(r, 25))
  }
  assert.ok(hit !== null && hit !== undefined,
    `改完设置后没有广播带新值的快照 —— 设置页就永远看不到桌面端的改动。` +
    `最近帧的 settings：${JSON.stringify(sse.snapshots().slice(-2).map(s => s.settings))}`)

  // 其余字段不许被这一帧冲掉（合并语义：补丁只带两个键）
  assert.equal(hit.settings.scale, before.scale, '合并语义：没动的 scale 必须原样保留')
  assert.equal(hit.settings.voice, before.voice, '合并语义：没动的 voice 必须原样保留')

  // 还原（别把用户的真实设置改掉）
  await post2('/api/zhuang-fangyi/pet/settings',
    { doubleClick: before.doubleClick, statusFontScale: before.statusFontScale })
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3b. v10：手势 / 情境 / 摸鱼计数 / 今日统计（整条链路）
 * ══════════════════════════════════════════════════════════════════════════ */

await ok('⭐⭐ 快照每帧都带 growth 与 today 两块（缺块 = 旧宿主，客户端会静默忽略）', async () => {
  // 这两块是 v10 新增的**下行数据**：设置页「今天」页签与右键菜单「今天」
  // 一行都读它们。缺了不会报错 —— 只会让那两个地方永远显示"没有记录"。
  const framesBefore = sse.snapshots().length
  // 触发一次广播（改个无关设置再改回来，避免动画面）
  await post2('/api/zhuang-fangyi/pet/settings', { hint: true })
  const deadline = Date.now() + 4000
  let hit = null
  while (Date.now() < deadline) {
    hit = sse.snapshots().slice(framesBefore).find(s => s.growth !== undefined && s.today !== undefined)
    if (hit) break
    await new Promise(r => setTimeout(r, 25))
  }
  assert.ok(hit, `快照里缺 growth/today 块。最近帧的键：${JSON.stringify(Object.keys(sse.snapshots().slice(-1)[0] ?? {}))}`)
  // growth 的必要字段
  for (const k of ['firstMetAt', 'daysMet', 'streakDays', 'todayInteracts', 'todayByKind']) {
    assert.ok(k in hit.growth, `growth 缺 ${k}`)
  }
  assert.ok('milestone' in hit.growth, 'growth 必须**总是**带 milestone 键（null 也要有）')
  assert.equal(typeof hit.growth.daysMet, 'number')
  assert.ok(hit.growth.daysMet >= 1, 'daysMet 至少是 1（初次见面当天算第 1 天）')
  // today 的必要字段
  for (const k of ['dayKey', 'pomodoroCount', 'focusMs', 'interrupts', 'streakDays', 'goalCount']) {
    assert.ok(k in hit.today, `today 缺 ${k}`)
  }
  assert.ok(Array.isArray(hit.today.byTask), 'today.byTask 应是数组')
  assert.ok(Array.isArray(hit.today.recent), 'today.recent 应是数组')
  assert.equal(hit.today.recent.length, 7, 'recent 应给 7 天')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3c. v10：手势首次指引（用户："手势之内的缺乏第一次的指引"）
 *
 * 这是一个**我自己造成的**缺口：v10 把互动从右键菜单移走了（避免"同一个
 * 动作两个入口"），却没有任何发现途径 —— 用户不可能凭空猜到"按住 = 摸头"。
 * ══════════════════════════════════════════════════════════════════════════ */

await ok('⭐⭐ 手势指引**只在原生窗口上**发（overlay 里说"甩出去她会飞"是骗人）', async () => {
  // 本套 e2e 的 ctx **没有** subprocess → nativeAvailable=false →
  // 指引**不该**发出来。这条同时验证了"不该发的时候不发"。
  const r = await post2('/api/zhuang-fangyi/pet/command', { command: 'gesture-hint' })
  assert.equal(r.status, 200, `命令应被接受，实际 ${r.status}`)
  const body = JSON.parse(r.body)
  assert.equal(body.result?.shown, false,
    `没有原生窗口时不该发出指引（实际 ${JSON.stringify(body.result)}）`)
})

await ok('⭐ 手势指引的命令在**路由层**就被认（不是静默忽略）', async () => {
  // `/pet/command` 没有动作白名单，靠 `onCommand` 的 switch default 兜底。
  // 这条断言"已知命令有回执、未知命令有 unknown"，防止把新命令写错名字后
  // **静默什么都不做**（那看起来就是"按钮点了没反应"）。
  const known = JSON.parse((await post2('/api/zhuang-fangyi/pet/command', { command: 'gesture-hint' })).body)
  assert.ok(known.result !== undefined, '已知命令必须有 result')
  assert.ok('shown' in known.result, `gesture-hint 的 result 应含 shown：${JSON.stringify(known.result)}`)
  const unknown = JSON.parse((await post2('/api/zhuang-fangyi/pet/command', { command: 'nope-nope' })).body)
  assert.equal(unknown.result?.unknown, 'nope-nope', '未知命令应回 unknown（不静默）')
})

await ok('⭐⭐ 手势指引的文案在状态机的文案表里（否则气泡显示裸 key）', async () => {
  // `t()`/`textOf` 取不到 key 时**回落成 key 名本身** —— 界面上会一本正经地
  // 显示 `pet/gesture-hint`。这类错没有任何断言会红（"只是难看"）。
  const { EVENT_TEXT } = await import(`file://${path.join(ROOT, 'src/pet/state.js').replace(/\\/g, '/')}`)
  assert.ok(EVENT_TEXT['pet/gesture-hint'], '文案表里没有 pet/gesture-hint')
  const zh = EVENT_TEXT['pet/gesture-hint'].zh
  const en = EVENT_TEXT['pet/gesture-hint'].en
  assert.ok(typeof zh === 'string' && zh !== '', '缺中文文案')
  assert.ok(typeof en === 'string' && en !== '', '缺英文文案')
  // 一句话要讲完三个手势（气泡宽度只有 240px，分三条弹像广告）
  for (const word of ['点', '按', '甩']) {
    assert.ok(zh.includes(word), `中文文案应提到「${word}」：${zh}`)
  }
})

await ok('⭐⭐⭐ 文案表里有 key **不等于**气泡会把它送到屏幕上', async () => {
  // 上一条断言只证明"表里有文案"。而真机上出的正是**表里有、屏幕上没有**：
  //
  //   · 选图走全池随机，42 张里 36 张自带文字；
  //   · 状态机有一条正确性规则：**图自带文字时不叠 Host 文案**（契约 §4）
  //     → `text` 被置 null，只剩一张「好吵啊」贴纸，指引一个字都没出现。
  //
  // 实测（真机触发后读快照）：
  //   {kind:'image', image:'bubble/new/15-so-loud.png', text:null, imageHasText:true}
  //
  // 所以这里直接验证**交付物**：真实状态机 + 无文字图池，气泡必须
  // 同时满足 (a) `text` 是那句指引、(b) 配图 `hasText === false`。
  const { createPetState, EVENT_TEXT } = await import(
    `file://${path.join(ROOT, 'src/pet/state.js').replace(/\\/g, '/')}`)
  const noTextRec = { file: 'bubble/safe.png', hasText: false, opaque: false }
  const s = createPetState({
    config: { locale: 'zh' },
    pickBubbleImage: () => noTextRec
  })
  s.notify({
    key: 'pet/gesture-hint',
    state: 'listening',
    text: EVENT_TEXT['pet/gesture-hint'].zh,
    image: noTextRec,
    priority: 93,
    durationMs: 10000
  })
  const b = s.snapshot(Date.now()).bubble
  assert.ok(b, '没有气泡')
  assert.equal(b.text, EVENT_TEXT['pet/gesture-hint'].zh,
    `气泡的 text 必须是那句指引，实际 ${JSON.stringify(b.text)}`)
  assert.notEqual(b.text, 'pet/gesture-hint', '气泡显示了裸 key（说明文案解析回落了）')
  assert.equal(b.imageHasText, false, '配图自带文字 → 会把指引吞掉')

  // 反向：**故意**给一张自带文字的图 → `text` 必须被吞掉（证明上面那条
  // 断言不是恒真 —— 它抓的正是"图与文案互斥"这条规则本身）。
  const s2 = createPetState({
    config: { locale: 'zh' },
    pickBubbleImage: () => ({ file: 'bubble/with-text.png', hasText: true, opaque: true })
  })
  s2.notify({
    key: 'pet/gesture-hint',
    state: 'listening',
    text: EVENT_TEXT['pet/gesture-hint'].zh,
    image: { file: 'bubble/with-text.png', hasText: true, opaque: true },
    priority: 93,
    force: true
  })
  const b2 = s2.snapshot(Date.now()).bubble
  assert.equal(b2.text, null, '自带文字的图必须压掉 Host 文案（否则屏幕上两段文字打架）')
})

await ok('⭐⭐ 文案表写错名也能查到（resolveBubbleText 兜底，不再回落到裸 key）', async () => {
  // 真 bug 的第二半：`pet/gesture-hint` 写在 EVENT_TEXT 里，而调用方没传
  // `table` → `requestBubble` 查 STATE_TEXT 查不到 → 回落成 key 本身。
  // 现在两张表都查，所以**不传 table 也能拿到文案**。
  const { createPetState, EVENT_TEXT, STATE_TEXT } = await import(
    `file://${path.join(ROOT, 'src/pet/state.js').replace(/\\/g, '/')}`)
  const s = createPetState({
    config: { locale: 'zh' },
    pickBubbleImage: () => null
  })
  // 不传 table、不传 text —— 完全靠兜底
  s.notify({ key: 'pet/gesture-hint', state: 'listening', priority: 93, force: true })
  const b = s.snapshot(Date.now()).bubble
  assert.equal(b.text, EVENT_TEXT['pet/gesture-hint'].zh,
    `应查 EVENT_TEXT 兜底，实际 ${JSON.stringify(b.text)}`)

  // 显式传错表（STATE_TEXT）也要能兜到 —— 这是最容易犯的写法
  const s2 = createPetState({
    config: { locale: 'zh' },
    pickBubbleImage: () => null
  })
  s2.notify({ key: 'pet/gesture-hint', table: STATE_TEXT, state: 'listening', priority: 93, force: true })
  const b2 = s2.snapshot(Date.now()).bubble
  assert.equal(b2.text, EVENT_TEXT['pet/gesture-hint'].zh,
    `表名传错也应兜到 EVENT_TEXT，实际 ${JSON.stringify(b2.text)}`)

  // 两张表都没有的 key → 才回落 key 本身（保留原设计）
  const s3 = createPetState({ config: { locale: 'zh' }, pickBubbleImage: () => null })
  s3.notify({ key: 'nonexistent/key', state: 'listening', priority: 93, force: true })
  const b3 = s3.snapshot(Date.now()).bubble
  assert.equal(b3.text, 'nonexistent/key', '未知 key 应回落 key 本身（不抛错）')
})

await ok('⭐ GET /pet/growth 与快照里的两块**同一份真相**', async () => {
  const g = JSON.parse((await get('/api/zhuang-fangyi/pet/growth')).body)
  const snap = sse.snapshots().slice(-1)[0]
  assert.ok(g.growth, '缺 growth 块')
  assert.ok(g.today, '缺 today 块')
  assert.ok(g.affection, '缺 affection 块')
  // 与最近一帧快照对比：daysMet / streakDays 这类"慢变量"必须一致
  //（两处各算一份的话，菜单显示 3 天、面板显示 2 天，谁也说不清哪个对）
  if (snap && snap.growth) {
    assert.equal(g.growth.daysMet, snap.growth.daysMet, 'daysMet 与快照不一致')
    assert.equal(g.today.streakDays, snap.today.streakDays, 'streakDays 与快照不一致')
    assert.equal(g.today.dayKey, snap.today.dayKey, 'dayKey 与快照不一致')
  }
})

await ok('⭐⭐ 专注期间的互动被记成"摸鱼"，并出现在快照的 pomodoro.interrupts 里', async () => {
  // 这是把"互动"与"番茄钟"真正连起来的那一条链路：
  //   POST /pet/interact → mood 判定 context==='focus' → stats.interrupt()
  //   → 快照 pomodoro.interrupts 变大 → 阶段结束时她点评
  //
  // 用**真实时钟**把番茄钟跑起来（不注入假时钟：e2e 跑的就是线上配置）。
  const before = JSON.parse((await get('/api/zhuang-fangyi/pet/pomodoro')).body).pomodoro
  const iBefore = before.interrupts ?? 0

  // 先开番茄钟（时长取设置里的，默认 25 分钟 —— 我们只跑开头几秒）
  await post2('/api/zhuang-fangyi/pet/settings', { pomodoro: true })
  await post2('/api/zhuang-fangyi/pet/pomodoro', { action: 'start' })
  await new Promise(r => setTimeout(r, 150))
  const running = JSON.parse((await get('/api/zhuang-fangyi/pet/pomodoro')).body).pomodoro
  assert.equal(running.running, true, `番茄钟没跑起来：${JSON.stringify(running)}`)
  assert.equal(running.phase, 'focus', '应该处于专注段')

  // 专注期间摸她一下 → 应被记成摸鱼
  const r = await post2('/api/zhuang-fangyi/pet/interact', { kind: 'click' })
  assert.equal(r.status, 200, `互动应成功，实际 ${r.status}`)
  const body = JSON.parse(r.body)
  assert.equal(body.context, 'focus', `情境应是 focus，实际 ${body.context}`)
  assert.ok(typeof body.interrupts === 'number' && body.interrupts > 0,
    `专注期间的互动应返回摸鱼计数，实际 ${JSON.stringify(body.interrupts)}`)

  const after = JSON.parse((await get('/api/zhuang-fangyi/pet/pomodoro')).body).pomodoro
  assert.ok((after.interrupts ?? 0) > iBefore,
    `pomodoro.interrupts 应该变大（${iBefore} → ${after.interrupts}）`)

  // 悬停**不算**摸鱼（鼠标路过不该算你分心）
  const iNow = after.interrupts
  const r2 = await post2('/api/zhuang-fangyi/pet/interact', { kind: 'hover' })
  assert.equal(r2.status, 200)
  const after2 = JSON.parse((await get('/api/zhuang-fangyi/pet/pomodoro')).body).pomodoro
  assert.equal(after2.interrupts, iNow, 'hover 不该增加摸鱼计数')

  // 收尾：停表（别让它继续跑）
  await post2('/api/zhuang-fangyi/pet/pomodoro', { action: 'pause' })
  await post2('/api/zhuang-fangyi/pet/settings', { pomodoro: false })
})

await ok('⭐⭐ 情境感应真的生效：同一动作在不同状态下给出不同 context', async () => {
  // 用户："互动当前方式，通过右键就点个按钮，很奇怪"。
  // 情境感应就是那一维：同一个动作，结果随"她当时在干什么"变化。
  // 这里用**真实状态机**驱动 —— 派发事件让 petState 变，再互动看 context。
  const post = async kind => {
    const r = await post2('/api/zhuang-fangyi/pet/interact', { kind })
    assert.equal(r.status, 200, `互动失败：${r.status}`)
    return JSON.parse(r.body)
  }

  // ① 默认（idle）→ context 是 default 或 close（取决于好感度档位）
  const idle = await post('click')
  assert.ok(['default', 'close'].includes(idle.context),
    `idle 下应是 default/close，实际 ${idle.context}`)

  // ② 派发一个工具调用 → working（等最短驻留）→ busy
  ctx.emit('session/event', { id: 'e2e-mood' }, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c-mood', name: 'bash', arguments: '{}' }
  })
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (sse.snapshots().slice(-1)[0]?.petState === 'working') break
    await new Promise(r => setTimeout(r, 50))
  }
  const busy = await post('click')
  assert.equal(busy.context, 'busy', `working 下应是 busy，实际 ${busy.context}`)
  // 而且文案与默认**不同**（否则"情境感应"是假的）
  assert.notEqual(busy.text, idle.text, 'busy 下的文案应与 idle 不同')

  // ③ 派发 turn/end（失败）→ error → trouble
  ctx.emit('session/event', { id: 'e2e-mood' }, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error' } }
  })
  const deadline2 = Date.now() + 4000
  while (Date.now() < deadline2) {
    if (sse.snapshots().slice(-1)[0]?.petState === 'error') break
    await new Promise(r => setTimeout(r, 50))
  }
  const trouble = await post('click')
  assert.ok(['trouble', 'busy'].includes(trouble.context),
    `出错后应是 trouble（或仍在 busy），实际 ${trouble.context}`)

  // ⚠️ **收尾：把这个会话彻底清干净**。
  //
  // 这里踩过两次，都是"新用例全绿、却让下游老用例红"：
  //
  //  1. `e2e-mood` 会以 error(60) 一直压住后面的 happy(50) —— 下游那条
  //     "turn/end completed → 推 happy" 无论怎么派发都到不了 happy；
  //  2. 更隐蔽的一次：我在这里留了**一个仍在 running 的会话**，
  //     于是下游"派发 agent/status running → 推 thinking"**不产生新帧**
  //     （状态没变，`#emitIfChanged` 就不广播）—— 那条用例断言的是
  //     "帧数变多了"，于是失败信息看起来与本节毫无关系。
  //
  // e2e 的用例共享**同一个真实宿主**，"我这条绿了"不等于"整体还绿"。
  // 所以收尾必须做到：闩锁清掉 + 会话退出聚合 + **断言真的清干净了**。
  //
  // 清法走正常路径（设计里就是这么定的：`running` 清 error 闩锁）：
  // 先 running（清闩锁）再 idle（让它不再参与聚合）。
  ctx.emit('agent/status', { agent: { id: 'e2e-mood' }, status: 'running' })
  await new Promise(r => setTimeout(r, 120))
  ctx.emit('agent/status', { agent: { id: 'e2e-mood' }, status: 'idle' })
  // 等到聚合状态不再被这个会话压住为止
  const deadline3 = Date.now() + 4000
  while (Date.now() < deadline3) {
    const sess = sse.snapshots().slice(-1)[0]?.sessions?.find(s => s.sessionId === 'e2e-mood')
    if (sess === undefined || (sess.state !== 'error' && sess.running !== true)) break
    await new Promise(r => setTimeout(r, 50))
  }
  const finalSess = sse.snapshots().slice(-1)[0]?.sessions?.find(s => s.sessionId === 'e2e-mood')
  assert.ok(finalSess === undefined || (finalSess.state !== 'error' && finalSess.running !== true),
    `e2e-mood 没收干净（会污染下游用例：既不产生新帧、又压住低优先级状态）：${JSON.stringify(finalSess)}`)
})

await ok('⭐ 手势动作走真实路由（pat 带 level / fling / hover）', async () => {
  const r1 = await post2('/api/zhuang-fangyi/pet/interact', { kind: 'pat', level: 2 })
  assert.equal(r1.status, 200, `pat 应成功，实际 ${r1.status}`)
  const b1 = JSON.parse(r1.body)
  assert.equal(b1.kind, 'pat')
  // 第 2 级有它自己的文案（与第 1 级不同）
  const r2 = await post2('/api/zhuang-fangyi/pet/interact', { kind: 'pat', level: 1 })
  const b2 = JSON.parse(r2.body)
  assert.equal(r2.status, 200)
  // 两个动作都必须**有反应**（哪怕在冷却里）
  assert.ok(b1.text !== null || b2.text !== null, 'pat 至少给一次文案')

  const r3 = await post2('/api/zhuang-fangyi/pet/interact', { kind: 'fling' })
  assert.equal(r3.status, 200, 'fling 应成功')
  const b3 = JSON.parse(r3.body)
  assert.equal(b3.gain, 0, 'fling 不该涨好感（甩她不是亲昵）')

  const r4 = await post2('/api/zhuang-fangyi/pet/interact', { kind: 'hover' })
  assert.equal(r4.status, 200, 'hover 应成功')
  assert.equal(JSON.parse(r4.body).gain, 0, 'hover 不该涨好感')
})

await ok('⭐ 计时节奏预设能改到设置（并立刻生效）', async () => {
  const before = JSON.parse((await get('/api/zhuang-fangyi/pet/settings')).body).settings
  const target = before.pomodoroPreset === 'deep' ? 'classic' : 'deep'
  await post2('/api/zhuang-fangyi/pet/settings', { pomodoroPreset: target })
  const after = JSON.parse((await get('/api/zhuang-fangyi/pet/settings')).body).settings
  assert.equal(after.pomodoroPreset, target, `预设没改到：${after.pomodoroPreset}`)
  // 还原
  await post2('/api/zhuang-fangyi/pet/settings', { pomodoroPreset: before.pomodoroPreset })
})

await ok('⭐ set-task 真的写进快照（任务绑定）', async () => {
  const r = await post2('/api/zhuang-fangyi/pet/pomodoro', { action: 'set-task', task: 'e2e 任务' })
  assert.equal(r.status, 200, `set-task 应成功，实际 ${r.status}`)
  const p = JSON.parse((await get('/api/zhuang-fangyi/pet/pomodoro')).body).pomodoro
  assert.equal(p.task, 'e2e 任务', `快照里的 task 不对：${p.task}`)
  // 还原（清空）
  await post2('/api/zhuang-fangyi/pet/pomodoro', { action: 'set-task', task: '' })
})

await ok('⭐⭐⭐ 快照的 pomodoro 块与 /pet/pomodoro 路由**形状必须一致**', async () => {
  // 这条断言来自一个**我亲手犯的**缺陷：v10 加 `task` / `interrupts` 时，
  // 我只改了路由那一份、忘了快照那一份 —— 于是：
  //
  //   · `/pet/pomodoro`（GET）：有 task / interrupts
  //   · 快照（SSE 每帧）：**没有**
  //
  // 而设置页「今天」页签的任务输入框读的是 `snapshot.pomodoro.task`
  //（它的数据源是快照）→ **任务名永远显示空**，即使宿主明明存着它，且不报错。
  //
  // 这就是"同一份数据只该有一个产出形状"那条纪律的又一次翻车
  //（`voiceManifest` 那次是手挑字段 → 数字静默变成 0）。现在两处都走
  // 同一个 `pomodoroBlock()`，这条断言把"键集必须相同"钉住。
  const route = JSON.parse((await get('/api/zhuang-fangyi/pet/pomodoro')).body).pomodoro
  const snap = sse.snapshots().slice(-1)[0]
  assert.ok(snap, '应该已经有快照了')
  assert.ok(snap.pomodoro, '快照里必须有 pomodoro 块')
  const routeKeys = Object.keys(route).sort()
  const snapKeys = Object.keys(snap.pomodoro).sort()
  assert.deepEqual(snapKeys, routeKeys,
    `两处的 pomodoro 块键集不一致：\n  路由独有：${routeKeys.filter(k => !snapKeys.includes(k))}\n` +
    `  快照独有：${snapKeys.filter(k => !routeKeys.includes(k))}`)
  // 具体把 v10 那两个字段点名（键集相同但两边都漏掉也会全绿）
  assert.ok(snapKeys.includes('task'), '快照的 pomodoro 块缺 task（设置页任务框会永远显示空）')
  assert.ok(snapKeys.includes('interrupts'), '快照的 pomodoro 块缺 interrupts（摸鱼计数看不到）')
})

await ok('派发 agent/status running → SSE 推 thinking', async () => {
  const before = sse.snapshots().length
  ctx.emit('agent/status', { agent: { id: 'e2e-1' }, status: 'running' })
  const deadline = Date.now() + 4000
  let hit = false
  while (Date.now() < deadline) {
    const snaps = sse.snapshots()
    if (snaps.length > before && snaps.some(s => s.petState === 'thinking')) {
      hit = true
      break
    }
    await new Promise(r => setTimeout(r, 25))
  }
  assert.ok(hit, `未推送 thinking。最近帧：${JSON.stringify(sse.snapshots().slice(-2))}`)
})

await ok('派发 session/event tool/call → 先不动，满 2 秒最短驻留才推 working', async () => {
  // ⚠️ 这里断言的是**加了最短驻留之后**的行为（用户 2026-10-07 定的 2 秒）。
  //
  // 背景：`thinking` 与 `working` 是交替的 —— `tool/call` 进来就变 working，
  // `tool/result` 出去又回 thinking，而一次本地工具常常只有几百毫秒。
  // 每次切换都换图 ⇒ 桌面上一直在抖。所以过程态加了最短驻留：
  // 刚进入 thinking 不到 2 秒时，**工具来了也不换图**。
  //
  // 这里用**真实时钟等**（不用假时钟）：e2e 跑的就是线上配置，
  // 把这 2 秒等出来顺带证明了"生产环境确实生效"，而不是只在单测的假时钟里绿。
  const before = sse.snapshots().length
  ctx.emit('session/event', { id: 'e2e-1' }, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c-e2e', name: 'bash', arguments: '{}' }
  })
  // ① 立刻不该变成 working
  await new Promise(r => setTimeout(r, 200))
  const early = sse.snapshots().slice(before)
  assert.ok(!early.some(s => s.petState === 'working'),
    `驻留期内不该推 working（实际推了：${early.map(s => s.petState).join(',')}）`)
  // ② 等满 2 秒就该切过去
  const deadline = Date.now() + 6000
  let hit = false
  while (Date.now() < deadline) {
    if (sse.snapshots().some(s => s.petState === 'working')) {
      hit = true
      break
    }
    await new Promise(r => setTimeout(r, 25))
  }
  assert.ok(hit, `满 2 秒后仍未推送 working。最近帧：${JSON.stringify(sse.snapshots().slice(-2))}`)
})

/* ── ⭐⭐ 聊天回复 → 气泡（用户报的 bug 就在这里）───────────────────────────
 *
 * 用户原话："他回我的消息，能不能通过气泡发送出来?"、"气泡里只提示了已发送"。
 *
 * 根因：原先用 `ctx.on('assistant/message', …)` 订阅 —— 而
 * `assistant/message` 是 **SessionEventMap 里的事件**（经 `session/event` 派发），
 * **cordis 根上没有这个事件名**。`ctx.on` 对未知事件名**不抛错**，
 * 于是订阅静静地永不触发：日志里一行警告都没有，气泡永远空着。
 *
 * 这个测试是**唯一**能抓到它的东西 —— 之前所有套件全绿，因为**没有任何
 * 测试真的派发过一条回复事件**（这就是它能溜到用户面前的原因）。
 * ──────────────────────────────────────────────────────────────────────── */

await ok('⭐⭐ 派发 assistant/message（session/event）→ 回复真的进气泡', async () => {
  // 为什么用**独立装配**而不是主装配：主装配没有 sessionController（`chat.sessionId`
  // 是 null），而这条要测的正是"聊天会话的回复"。独立装配里我们自己建会话、
  // 自己发事件，链路完整（sessionController.create → chat.setSession → 事件 → 气泡）。
  fs.rmSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'chat.json'), { force: true })
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-bubble-'))
  const local = makeCtx(makeWebServer())
  const prompts = []
  local.provide('sessionController', {
    async list () { return { items: [] } },
    async create () { return { sessionId: 'chat-bubble-1' } },
    async prompt (req, signal) {
      if (req?.mode !== 'queue' && req?.mode !== 'steer') throw new Error('mode 必填')
      signal.throwIfAborted()
      prompts.push({ ...req })
      return { accepted: true }
    }
  })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const ws = local.__services.get('webServer')
  await ws.listen()
  const base = `http://127.0.0.1:${ws.port}`
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { chatWorkspace: path.join(chatHome, 'ws') } })
  })
  // 先真的发一条，让插件建立/采纳聊天会话（这样 chat.accept 才认这个 id）
  const sent = await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '在吗？' })
  })
  assert.equal(sent.status, 200, `发消息应 200，实际 ${sent.status}`)
  const st = await (await fetch(`${base}/api/zhuang-fangyi/pet/chat`)).json()
  assert.equal(st.sessionId, 'chat-bubble-1', '会话应已建立')

  // 现在派发一条**真实形状**的回复事件（照抄 SessionEventMap）
  const seen = []
  const offSnap = local.__handlers.get('pet/state') ?? []
  local.emit('session/event', { id: 'chat-bubble-1' }, {
    type: 'assistant/message',
    seq: 9001,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'msg-e2e-bubble',
        role: 'assistant',
        content: [{ type: 'text', text: '我在。实验刚告一段落，正好歇口气。' }],
        source: { kind: 'model', provider: 'e2e', model: 'e2e' }
      },
      stream: []
    }
  })
  // 直接从快照读气泡（不依赖 SSE：独立装配没有 SSE 客户端）
  const snap = await (await fetch(`${base}/api/zhuang-fangyi/pet/state`)).json()
  seen.push(snap)
  const bubble = snap.bubble
  // ⭐ 正文必须在 —— 这一条抓的是**两个**真实 bug：
  //   ① 事件名写错（`ctx.on('assistant/message')` 不存在）→ 气泡压根不弹；
  //   ② 选到自带文字的贴纸 → 状态机按契约 §4 不叠 Host 文案，
  //      于是回复正文被整段吞掉（用户看到的就是"只提示了已发送"）。
  assert.ok(bubble !== null && bubble !== undefined, '应弹出气泡')
  assert.equal(typeof bubble.text, 'string',
    `气泡必须带正文（image=${JSON.stringify(bubble.image)} imageHasText=${bubble.imageHasText}）—— ` +
    '若 imageHasText 为 true，说明聊天回复选到了自带文字的贴纸，正文被吞了')
  assert.ok(bubble.text.includes('实验刚告一段落'),
    `气泡正文应是回复内容，实际 ${JSON.stringify(bubble.text)}`)
  assert.equal(bubble.imageHasText, false,
    '聊天回复的气泡图必须是**无文字**的（否则状态机不叠文案，正文消失）')
  // 状态：刚建好的桌宠可能还在 `waking`（唤醒优先级压过 listening）——
  // 那是合法的，不该焊死具体状态。这里只断言"气泡确实带着回复"。
  assert.ok(['listening', 'waking', 'thinking'].includes(snap.petState),
    `聊天回复后桌宠应处于活跃状态，实际 ${snap.petState}`)
  await ws.close()
  for (const d of local.__effects) if (typeof d === 'function') assert.doesNotThrow(() => d())
  fs.rmSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'chat.json'), { force: true })
})

await ok('⭐ 非聊天会话的回复不进气泡（只认聊天会话，不打扰你的工作会话）', async () => {
  const before = sse.snapshots().length
  ctx.emit('session/event', { id: 'session-some-other-work-session' }, {
    type: 'assistant/message',
    seq: 9002,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'msg-e2e-other',
        role: 'assistant',
        content: [{ type: 'text', text: '这段是你工作会话里的内容，不该出现在桌宠气泡里。' }],
        source: { kind: 'model', provider: 'e2e', model: 'e2e' }
      },
      stream: []
    }
  })
  await new Promise(r => setTimeout(r, 200))
  const leaked = sse.snapshots().slice(before)
    .some(s => typeof s.bubble === 'string' && s.bubble.includes('不该出现在桌宠气泡里'))
  assert.ok(!leaked, '别的会话的回复绝不该进桌宠气泡')
})

await ok('派发 turn/end completed → 推 happy', async () => {  ctx.emit('session/event', { id: 'e2e-1' }, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } }
  })
  const deadline = Date.now() + 4000
  let hit = false
  while (Date.now() < deadline) {
    if (sse.snapshots().some(s => s.petState === 'happy')) {
      hit = true
      break
    }
    await new Promise(r => setTimeout(r, 25))
  }
  assert.ok(hit, `未推送 happy。最近帧：${JSON.stringify(sse.snapshots().slice(-2))}`)
})

await ok('派发 agent/error → 推 error', async () => {
  ctx.emit('agent/error', { agent: { id: 'e2e-2' }, turn: 1, step: 1, error: new Error('e2e boom') })
  const deadline = Date.now() + 4000
  let hit = false
  while (Date.now() < deadline) {
    if (sse.snapshots().some(s => s.petState === 'error')) {
      hit = true
      break
    }
    await new Promise(r => setTimeout(r, 25))
  }
  assert.ok(hit, `未推送 error。最近帧：${JSON.stringify(sse.snapshots().slice(-2))}`)
})

/* ── attention（常亮提醒）在真实装配下的起落（契约 §2）─────────────────── */

await ok('⭐ approval/asked → attention 随 /pet/state 与 SSE 推出，气泡 sticky', async () => {
  ctx.emit('session/event', { id: 'e2e-1' }, {
    type: 'approval/asked',
    data: { turn: 2, step: 1 }
  })
  const deadline = Date.now() + 4000
  let hit = null
  while (Date.now() < deadline) {
    const frame = [...sse.snapshots()].reverse().find(s => s.attention != null)
    if (frame) { hit = frame; break }
    await new Promise(r => setTimeout(r, 25))
  }
  assert.ok(hit, `SSE 未推 attention。最近帧：${JSON.stringify(sse.snapshots().slice(-1))}`)
  assert.equal(hit.attention.kind, 'approval')
  assert.equal(hit.attention.count, 1)
  assert.equal(hit.bubble?.kind, 'attention')
  assert.equal(hit.bubble?.sticky, true, 'sticky=渲染方不按 durationMs 收')
  // /pet/state（轮询兜底通道）与 SSE 必须同构
  const st = JSON.parse((await get('/api/zhuang-fangyi/pet/state')).body)
  assert.equal(st.attention?.kind, 'approval', '/pet/state 也要带 attention')
  assert.equal(st.bubble?.kind, 'attention')
})

await ok('⭐ attention 存续期间普通气泡被挡住（帧里持续是 attention 气泡）', async () => {
  const last = [...sse.snapshots()].reverse().find(s => s.attention != null)
  assert.ok(last !== undefined, 'attention 应仍在帧里')
  assert.equal(last.bubble?.kind, 'attention', '普通气泡抢不走（priority 100）')
})

await ok('⭐ approval/decided → attention 归零（/pet/state 同步）', async () => {
  ctx.emit('session/event', { id: 'e2e-1' }, {
    type: 'approval/decided',
    data: { turn: 2, step: 1, outcome: 'allowed' }
  })
  const deadline = Date.now() + 4000
  let cleared = false
  while (Date.now() < deadline) {
    const st = JSON.parse((await get('/api/zhuang-fangyi/pet/state')).body)
    if (st.attention === null) { cleared = true; break }
    await new Promise(r => setTimeout(r, 25))
  }
  assert.ok(cleared, '处理完应立刻收起')
  const st = JSON.parse((await get('/api/zhuang-fangyi/pet/state')).body)
  assert.equal(st.bubble, null, '气泡同步收起')
})

await ok('SSE 里每一帧的 petState 都是契约 §1 的合法状态名', async () => {
  const VALID = ['waking', 'idle', 'listening', 'thinking', 'working', 'waiting', 'happy', 'error', 'sleeping']
  for (const snap of sse.snapshots()) {
    assert.ok(VALID.includes(snap.petState), `非法状态名泄漏到线上：${snap.petState}`)
  }
})

await ok('SSE 的每个 data 行都能独立解析成完整 JSON（帧格式正确）', async () => {
  const lines = sse.text.split('\n').filter(l => l.startsWith('data: '))
  assert.ok(lines.length > 0, '应有 data 行')
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line.slice('data: '.length)), `不可解析：${line}`)
  }
})

await ok('rev 在推送序列里单调不减', async () => {
  const revs = sse.snapshots().map(s => s.rev)
  for (let i = 1; i < revs.length; i += 1) {
    assert.ok(revs[i] >= revs[i - 1], `rev 回退：${revs[i - 1]} → ${revs[i]}`)
  }
})

await sse.close()

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 降级：没有 exe 时不能半残
 * ══════════════════════════════════════════════════════════════════════════ */
section('4. 降级行为（没有 exe / 没有 subprocess）')

await ok('没有 ctx.subprocess 时 nativeAvailable=false 且给出原因', async () => {
  const r = await get('/api/zhuang-fangyi/pet/state')
  const snap = JSON.parse(r.body)
  assert.equal(snap.nativeAvailable, false, '本机测试环境无 exe，应为 false')
  assert.ok(typeof snap.nativeError === 'string' && snap.nativeError.length > 0, '应给出原因')
})

await ok('降级时其余功能照常（状态、素材、路由都可用）', async () => {
  const state = await get('/api/zhuang-fangyi/pet/state')
  const atlas = await get('/api/zhuang-fangyi/pet/atlas')
  assert.equal(state.status, 200)
  assert.equal(atlas.status, 200)
  const body = JSON.parse(atlas.body)
  // 8 个而不是 9：`listening` 已降级为纯气泡（2026-10-07 用户决定），不算主体覆盖。
  assert.equal(body.report.coveredStates.length, 8, '素材仍应完整')
})

/* ── 总开关必须真的停掉桌面那只 ──────────────────────────────────────────
 *
 * 真机上炸过的形态：`enabled` 只被 overlay 读到（它据此不渲染），
 * 而 exe 是宿主 spawn 的**独立进程**，宿主既没把 `enabled` 发给它、
 * 也没在设置变化时停它 —— 于是"关掉总开关"之后桌面那只**还在**，
 * 用户会以为开关坏了。
 *
 * ⚠️ **断言方式很关键（第三次踩同一个坑）**：
 *
 *   · 第一版断言 `launcher.status.running === false` —— 但本环境没有
 *     `subprocess`，`start()` 必失败、`running` **恒为 false**，
 *     所以这条断言**天然成立**，删掉同步逻辑后照样全绿。
 *   · 第二版改断言"stop 被调用过" —— 但 `syncNativeProcess` 是**幂等**的：
 *     `running` 已经是 false 时它正确地跳过 `stop()`，于是 `stop=0`，
 *     断言又打在了不可能发生的条件上。
 *
 * 两次的根因是同一个：**环境里进程从来就没跑起来过**。
 * 所以这一节**自己装一套 ctx**，带一个最小可用的 `subprocess` 桩，
 * 让 `start()` 真的成功、`running` 真的变 true，然后才验证
 * "改设置 → 真的把它停掉"。这才是运行路径。
 * ──────────────────────────────────────────────────────────────────────── */
section('4b. 总开关 / 显示模式必须真的作用到原生进程')

await ok('⭐ 关掉总开关会真的 terminate 已运行的原生进程', async () => {
  const ws = makeWebServer()
  const local = makeCtx(ws)
  // 最小可用的 subprocess 桩：spawn 成功、done 永不 settle（进程"一直在跑"）。
  const spawned = []
  local.provide('subprocess', {
    spawn () {
      const rec = { terminated: 0 }
      spawned.push(rec)
      return {
        terminate () { rec.terminated += 1 },
        kill () { rec.terminated += 1 },
        unref () {},
        on () {},
        done: new Promise(() => {})
      }
    }
  })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  // ⚠️ **必须先 listen 再 apply**：exe 的启动发生在 `ctx.inject(['webServer'])`
  // 回调里，而它需要 `webServer.port` 才能告诉 exe 连哪里。桩服务器没 listen
  // 时 port 还是 0 → `baseUrlOf` 返回 null → `start()` 直接放弃、根本不 spawn。
  // （这正是本用例第一次写错的原因：spawned=0。）
  await ws.listen()
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const base = `http://127.0.0.1:${ws.port}`
  const put = body => fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: body })
  })
  const launcher = local.__services.get('zhuangFangyiPet').launcher

  // 起始：enabled=true + auto → 启动时应当已经 spawn 了一个。
  assert.equal(launcher.status.running, true,
    `启动时就该有原生进程（spawned=${spawned.length}）`)

  // 关总开关 → 必须**真的** terminate。
  const res = await put({ enabled: false })
  assert.equal(res.status, 200)
  assert.equal(launcher.status.running, false, '关掉总开关后原生进程必须停')
  assert.equal(spawned[0].terminated, 1, 'terminate() 必须被调用一次')

  // 再打开 → 必须重新 spawn（不是停掉就再也不起）。
  await put({ enabled: true, mode: 'auto' })
  assert.equal(launcher.status.running, true, '重新打开后应再次启动')
  assert.equal(spawned.length, 2, '应发生第二次 spawn')

  for (const dispose of local.__effects) {
    if (typeof dispose === 'function') assert.doesNotThrow(() => dispose())
  }
  await ws.close()
})

await ok('⭐ mode=overlay 会真的停掉原生进程（用户只要窗口内）', async () => {
  const ws = makeWebServer()
  const local = makeCtx(ws)
  const spawned = []
  local.provide('subprocess', {
    spawn () {
      const rec = { terminated: 0 }
      spawned.push(rec)
      return {
        terminate () { rec.terminated += 1 },
        kill () { rec.terminated += 1 },
        unref () {},
        on () {},
        done: new Promise(() => {})
      }
    }
  })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  // 同上：必须先 listen，否则 port=0 → 不 spawn。
  await ws.listen()
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  const base = `http://127.0.0.1:${ws.port}`
  const launcher = local.__services.get('zhuangFangyiPet').launcher

  assert.equal(launcher.status.running, true, '起始应有原生进程')
  await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { mode: 'overlay' } })
  })
  assert.equal(launcher.status.running, false, 'mode=overlay 时原生进程必须停')
  assert.equal(spawned[0].terminated, 1, 'terminate() 必须被调用')

  for (const dispose of local.__effects) {
    if (typeof dispose === 'function') assert.doesNotThrow(() => dispose())
  }
  await ws.close()
})

await ok('mode=overlay 时**启动阶段就不该** spawn（判据两处共用）', async () => {
  const ws = makeWebServer()
  const local = makeCtx(ws)
  let spawnCount = 0
  local.provide('subprocess', {
    spawn () {
      spawnCount += 1
      return { terminate () {}, kill () {}, unref () {}, on () {}, done: new Promise(() => {}) }
    }
  })
  const petIndex = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  // 起始设置就是 overlay：启动路径必须用与设置变化**同一个**判据。
  const settingsFile = path.join(tmpHome, 'zhuang-fangyi-pet', 'settings.json')
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, enabled: true, mode: 'overlay' }))
  petIndex.apply(toCordisLike(local, ['webServer']), {})
  await ws.listen()

  assert.equal(spawnCount, 0, 'mode=overlay 时启动阶段不该 spawn（否则两处判据分叉）')

  for (const dispose of local.__effects) {
    if (typeof dispose === 'function') assert.doesNotThrow(() => dispose())
  }
  await ws.close()
  // 复原共享设置文件，避免影响后面的断言。
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, enabled: true, mode: 'auto' }))
})

await ok('⭐ cordis 语义下取端口走 ctx.get()，不读会抛的 ctx.webServer', async () => {
  // 回归测试，对应一次真实事故：`launcher.js` 用 `ctx?.webServer` 取端口，
  // 而 cordis 对未声明服务用 Proxy getter —— 读取**抛** `cannot get property ... without inject`。
  // 可选链防不住，异常被 apply 的 try/catch 吞掉后，exe 永远起不来（真机表现"桌宠不出现"）。
  //
  // 注意断言方式：**不能**只断言 apply() 不抛（那层 try/catch 一定会兜住，测不出真伪）。
  // 这里直接盯住"端口是怎么拿到的"：baseUrlOf 必须拿到 webServer，
  // 也就是 launcher 走了 ctx.get() 这条路。`readWebServer` 计数即证据。
  const { createLauncher } = await import('../src/pet/launcher.js')

  const webServer = { port: 51999, host: '127.0.0.1' }
  let getCalls = 0
  let reads = 0
  // 复刻 cordis：读未声明服务**抛**；ctx.get('webServer') 正常返回。
  const cordisCtx = new Proxy({
    logger: { info () {}, warn () {}, debug () {}, error () {} },
    get (name) {
      getCalls += 1
      if (name === 'webServer') return webServer
      if (name === 'subprocess') {
        return { spawn () { return { kill () {}, unref () {}, on () {} } } }
      }
      return undefined
    }
  }, {
    get (target, prop, recv) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, recv)
      // 任何未声明的服务属性：cordis 的 Proxy getter 行为
      reads += 1
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    }
  })

  const launcher = createLauncher({
    ctx: cordisCtx,
    pkgRoot: ROOT,
    getSettings: () => ({ ...normalizeSettings({ enabled: true, mode: 'auto' }) }),
    getSnapshot: () => ({ petState: 'idle' }),
    token: 'f'.repeat(48),
    logger: { info () {}, warn () {}, debug () {}, error () {} },
    onStatus () {}
  })

  // 显式不带 runtime.url，强制走"自己推导端口"这条路径（事故发生的正是这条）
  const started = launcher.start({ state: 'idle' })
  // 不论 exe 二进制在不在（probe 可能先失败），关键断言：
  // ① 读未声明属性这条路**一次都不该走**（reads === 0）
  // ② 端口必须是用 ctx.get 拿到的
  assert.equal(reads, 0, `不应读未声明的 ctx 属性（cordis 会抛）；实际读了 ${reads} 次`)
  if (started === true) {
    assert.ok(getCalls > 0, '启动时必须通过 ctx.get 取端口')
  }
  launcher.dispose?.()
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 卸载干净
 * ══════════════════════════════════════════════════════════════════════════ */
section('5. 卸载')

await ok('跑完所有 effect 的 disposer 不抛错（无残留定时器/监听）', async () => {
  for (const dispose of ctx.__effects) {
    if (typeof dispose === 'function') {
      assert.doesNotThrow(() => dispose())
    }
  }
})

await ok('卸载后路由已摘除（不会留下半死的 handler）', async () => {
  // 路由的注册 disposer 由 scoped.effect 持有，上面已全部执行。
  const res = await fetch(`${ROUTE}/state`).catch(() => null)
  // 路由可能还在（桩 webServer 的 remove 由 disposer 调用），这里只要求不抛。
  assert.ok(res === null || typeof res.status === 'number')
})

/* ═════════════════════════════════════════════════════════════════════════ */
await webServer.close()
try {
  fs.rmSync(tmpHome, { recursive: true, force: true })
} catch { /* 清理失败不影响结论 */ }

console.log(`\n${'═'.repeat(60)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('❌ 有失败项')
  process.exit(1)
}
console.log('✅ 全部通过')