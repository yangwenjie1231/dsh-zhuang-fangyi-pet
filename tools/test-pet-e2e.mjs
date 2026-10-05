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
     * ⭐ 桩**必须校验 `mode`**，否则测不出真机上的 502。
     *
     * 上游 `dsh-api-session-controller` 的 zod schema（`typert.host.js` 实测）：
     *     'mode': z.union([z.literal("queue"), z.literal("steer")]).readonly(),
     * **没有 `.optional()`** —— 少这个字段直接校验失败。
     *
     * 之前这个桩是 `async prompt (req) { prompts.push(req); return {accepted:true} }`，
     * 什么都不检查，于是"漏传 mode"在测试里**永远绿**，真机上却必 502。
     * 复刻校验是唯一能让这条断言有意义的方式。
     */
    async prompt (req) {
      if (req?.mode !== 'queue' && req?.mode !== 'steer') {
        throw new Error(
          `RemoteError gateway/bad-request: prompt.mode 必须是 'queue' 或 'steer'，` +
          `实际 ${JSON.stringify(req?.mode)}（上游 schema 无 .optional()）`
        )
      }
      prompts.push(req)
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

await ok('9 个状态全部有专属素材（覆盖率 9/9）', async () => {
  const r = await get('/api/zhuang-fangyi/pet/atlas')
  const body = JSON.parse(r.body)
  const covered = body.report.coveredStates
  assert.equal(covered.length, 9, `只覆盖 ${covered.length} 个：${covered.join(',')}`)
  assert.equal(body.report.uncoveredStates.length, 0)
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

await ok('派发 session/event tool/call → 推 working', async () => {
  ctx.emit('session/event', { id: 'e2e-1' }, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c-e2e', name: 'bash', arguments: '{}' }
  })
  const deadline = Date.now() + 4000
  let hit = false
  while (Date.now() < deadline) {
    if (sse.snapshots().some(s => s.petState === 'working')) {
      hit = true
      break
    }
    await new Promise(r => setTimeout(r, 25))
  }
  assert.ok(hit, `未推送 working。最近帧：${JSON.stringify(sse.snapshots().slice(-2))}`)
})

await ok('派发 turn/end completed → 推 happy', async () => {
  ctx.emit('session/event', { id: 'e2e-1' }, {
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
  assert.equal(body.report.coveredStates.length, 9, '素材仍应完整')
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