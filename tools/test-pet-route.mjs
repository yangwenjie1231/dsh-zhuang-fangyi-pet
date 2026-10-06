/**
 * 庄方宜桌宠 · 路由与安全围栏单测（无框架，纯 node:assert）
 *
 * 用法：`node tools/test-pet-route.mjs`
 *
 * ── 这里为什么必须有测试 ──────────────────────────────────────────────────
 *
 * 本插件注册的前缀 `/api/zhuang-fangyi/pet` **长于**内核的 `/api`，而 `webServer`
 * 是「最长前缀胜出」—— 所以我们的 handler 会**先于**内核的 admission 检查执行。
 * 也就是说：围栏一旦写错，这些路由就会**应答任何本机调用者**。
 *
 * 所以这里用真实的 `http.Server` 起一个 listener、发真实请求来验：
 *   · 围栏 1（信任）：非 loopback Host / cross-site / Origin 不匹配 → 403；
 *   · 围栏 2（令牌）：缺失/错误/长度不同 → 401，且**常量时间比较**；
 *   · 围栏 3（素材白名单）：`../` 遍历、白名单外文件 → 404；
 *   · SSE 帧格式符合契约 §2（`event:`/`data:` 单行 JSON + 注释心跳）；
 *   · 端口自发现与 `0.0.0.0` → `127.0.0.1` 映射。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createHandler,
  newToken,
  tokenMatches,
  structuralRejection,
  rejectionFor,
  ROUTE_PREFIX
} from '../src/pet/routes.js'
import { createHub } from '../src/pet/hub.js'
import { createPomodoro } from '../src/pet/pomodoro.js'
import { normalizeAtlas, loadAtlas } from '../src/pet/atlas.js'
import { baseUrlOf, locateExe, EXE_NAME } from '../src/pet/launcher.js'

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

async function okAsync (label, fn) {
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
 * 测试用的临时素材目录与服务器
 * ═════════════════════════════════════════════════════════════════════════ */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-pet-route-'))
const artDir = path.join(tmpRoot, 'art', 'pet')
fs.mkdirSync(path.join(artDir, 'bubble'), { recursive: true })

/** 造一张极小的合法 PNG（1×1 透明），用于验证素材路由真的能发字节。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)
fs.writeFileSync(path.join(artDir, 'idle.png'), PNG_1PX)
fs.writeFileSync(path.join(artDir, 'bubble', '01.png'), PNG_1PX)
/** 白名单外的文件：存在，但绝不该被服务。 */
fs.writeFileSync(path.join(artDir, 'secret.png'), PNG_1PX)

/** 清单落盘，让 `loadAtlas` 也有一条真实路径可测。 */
const ATLAS_JSON = {
  version: 1,
  frameHeight: 256,
  states: { idle: { file: 'idle.png', frames: 1, frameMs: 36 } },
  bubble: [{ file: 'bubble/01.png', w: 1, h: 1 }]
}
fs.writeFileSync(path.join(artDir, 'pet.json'), JSON.stringify(ATLAS_JSON, null, 2))

const atlas = normalizeAtlas(ATLAS_JSON)

const TOKEN = newToken()
const snapshot = () => ({
  rev: 7,
  petState: 'thinking',
  label: '正在思考…',
  since: 1000,
  bubble: null,
  sessions: [{ sessionId: 's1', state: 'thinking', toolsInFlight: 0 }],
  nativeAvailable: false,
  nativeError: null
})

const hub = createHub({ logger: { warn () {}, debug () {}, info () {} }, heartbeatMs: 60000 })

let positionPatch = null
let commandSeen = null
let settingsValue = { enabled: true, mode: 'auto', scale: 1 }
/** `/pet/send` 的桩：记录调用、可控能力位与错误。 */
let sendSeen = null
let sendCap = { available: true, reason: null }
let sendThrow = null

const handler = createHandler({
  snapshot,
  atlas: () => atlas,
  artDir,
  token: TOKEN,
  hub,
  logger: { warn () {}, debug () {}, info () {} },
  connection: () => undefined,
  diagnostics: () => ({ build: 'test-build' }),
  onPosition: patch => {
    positionPatch = patch
  },
  onCommand: command => {
    commandSeen = command
    return { ok: command }
  },
  sendCapability: () => sendCap,
  onSend: async (text, sessionId) => {
    if (sendThrow !== null) throw sendThrow
    sendSeen = { text, sessionId }
    return { sessionId: sessionId ?? 'auto-picked' }
  },
  getSettings: () => settingsValue,
  setSettings: next => {
    settingsValue = { ...settingsValue, ...next }
    return settingsValue
  }
})

const server = http.createServer((req, res) => {
  handler(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const BASE = `http://127.0.0.1:${port}`
const ROUTE = `${BASE}${ROUTE_PREFIX}`

/** 发一个请求，返回 `{status, headers, body}`。 */
async function call (urlPath, options = {}) {
  const res = await fetch(`${BASE}${urlPath}`, options)
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text }
}

/** 带令牌的请求头。 */
function auth (extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 令牌
 * ═════════════════════════════════════════════════════════════════════════ */
section('1. 准入：令牌 或 同源围栏（两条路径都必须成立）')

ok('newToken 产生 48 位 hex 且每次都不同', () => {
  const a = newToken()
  const b = newToken()
  assert.equal(a.length, 48)
  assert.match(a, /^[0-9a-f]{48}$/)
  assert.notEqual(a, b)
})

ok('tokenMatches 接受正确令牌', () => {
  assert.equal(tokenMatches({ headers: { authorization: `Bearer ${TOKEN}` } }, TOKEN), true)
})

ok('tokenMatches 拒绝缺失/错误/格式不符', () => {
  assert.equal(tokenMatches({ headers: {} }, TOKEN), false)
  assert.equal(tokenMatches({ headers: { authorization: 'Bearer wrong' } }, TOKEN), false)
  assert.equal(tokenMatches({ headers: { authorization: TOKEN } }, TOKEN), false, '缺 Bearer 前缀应拒绝')
  assert.equal(tokenMatches({ headers: { authorization: `Bearer ${TOKEN}x` } }, TOKEN), false, '长度不同应拒绝')
  assert.equal(tokenMatches({ headers: { authorization: 'Bearer ' } }, TOKEN), false)
})

await okAsync('带正确令牌访问 /state → 200（原生 exe 路径）', async () => {
  const r = await call(`${ROUTE_PREFIX}/state`, { headers: auth() })
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.equal(body.petState, 'thinking')
  assert.equal(body.rev, 7)
  assert.ok(Array.isArray(body.sessions))
})

await okAsync('不带令牌但同源访问 /state → 200（浏览器半边路径）', async () => {
  // 关键：浏览器半边带不了令牌，EventSource 更是连请求头都不允许设。
  // 所以同源请求必须放行，否则窗口内兜底桌宠直接坏掉。
  const r = await call(`${ROUTE_PREFIX}/state`)
  assert.equal(r.status, 200, '同源无令牌必须放行')
})

await okAsync('不带令牌且非 loopback Host → 403（挡住网页）', async () => {
  const raw = await new Promise((resolve, reject) => {
    const socket = http.request({
      host: '127.0.0.1',
      port,
      path: `${ROUTE_PREFIX}/state`,
      method: 'GET',
      headers: { host: 'evil.example.com' }
    }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    socket.on('error', reject)
    socket.end()
  })
  assert.equal(raw.status, 403)
})

await okAsync('不带令牌且 cross-site → 403（挡住网页）', async () => {
  const raw = await new Promise((resolve, reject) => {
    const socket = http.request({
      host: '127.0.0.1',
      port,
      path: `${ROUTE_PREFIX}/state`,
      method: 'GET',
      headers: { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' }
    }, res => {
      res.on('data', () => {})
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    socket.on('error', reject)
    socket.end()
  })
  assert.equal(raw.status, 403)
})

await okAsync('带令牌时即使 Origin 可疑也放行（原生 exe 不带 Origin）', async () => {
  // exe 是原生进程，不会有 Origin；但万一有代理加上了，令牌仍应生效。
  const r = await call(`${ROUTE_PREFIX}/state`, {
    headers: auth({ origin: 'http://evil.com' })
  })
  assert.equal(r.status, 200, '令牌有效即放行')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 信任围栏
 * ═════════════════════════════════════════════════════════════════════════ */
section('2. 信任围栏（围栏 1）')

ok('structuralRejection 放行正常的 loopback 请求', () => {
  assert.equal(structuralRejection({ headers: { host: '127.0.0.1:19387' } }), undefined)
  assert.equal(structuralRejection({ headers: { host: 'localhost:80' } }), undefined)
})

ok('非 loopback Host → 403（DNS 重绑定防御）', () => {
  assert.equal(structuralRejection({ headers: { host: 'evil.example.com' } }), 403)
  assert.equal(structuralRejection({ headers: { host: '192.168.1.5:19387' } }), 403)
})

ok('缺 Host → 403', () => {
  assert.equal(structuralRejection({ headers: {} }), 403)
})

ok('sec-fetch-site: cross-site → 403', () => {
  assert.equal(
    structuralRejection({ headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }),
    403
  )
})

ok('Origin 与 Host 不同 authority → 403', () => {
  assert.equal(
    structuralRejection({
      headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:9999' }
    }),
    403
  )
  assert.equal(
    structuralRejection({
      headers: { host: '127.0.0.1:19387', origin: 'http://evil.com' }
    }),
    403
  )
})

ok('Origin 与 Host 同 authority → 放行', () => {
  assert.equal(
    structuralRejection({
      headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }
    }),
    undefined
  )
})

ok('Origin 声称 https 但 Host 是 http → 403（webServer 讲明文 http）', () => {
  assert.equal(
    structuralRejection({
      headers: { host: '127.0.0.1:19387', origin: 'https://127.0.0.1:19387' }
    }),
    403
  )
})

ok('rejectionFor 优先用 connection.admit', () => {
  const req = { headers: { host: 'evil.com' } }
  // connection 明确放行时，就不该再走结构围栏。
  assert.equal(rejectionFor(req, { admit: () => ({}) }), undefined)
  // connection 明确拒绝时，用它的状态码。
  assert.equal(rejectionFor(req, { admit: () => ({ rejection: 418 }) }), 418)
})

ok('connection.admit 抛错时退回结构围栏（不 500）', () => {
  const req = { headers: { host: 'evil.com' } }
  assert.equal(
    rejectionFor(req, { admit: () => { throw new Error('boom') } }),
    403,
    '应退回结构围栏并拒绝'
  )
})

ok('connection 缺 admit 方法时退回结构围栏', () => {
  assert.equal(rejectionFor({ headers: { host: 'evil.com' } }, {}), 403)
})

await okAsync('真实请求：伪造非 loopback Host 且无令牌 → 403', async () => {
  // fetch 不允许改 Host 头，所以直接对 server 发原始请求。
  const raw = await new Promise((resolve, reject) => {
    const socket = http.request({
      host: '127.0.0.1',
      port,
      path: `${ROUTE_PREFIX}/state`,
      method: 'GET',
      headers: { host: 'evil.example.com' }
    }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    socket.on('error', reject)
    socket.end()
  })
  assert.equal(raw.status, 403)
})

await okAsync('真实请求：伪造 Host 但令牌有效 → 放行（令牌强于围栏）', async () => {
  // 令牌是比 Host 头更强的秘密：持有令牌的一方本就能读快照，
  // 所以令牌正确时不再因 Host 可疑而拒绝（原生 exe 也不带 Origin）。
  const raw = await new Promise((resolve, reject) => {
    const socket = http.request({
      host: '127.0.0.1',
      port,
      path: `${ROUTE_PREFIX}/state`,
      method: 'GET',
      headers: { host: 'evil.example.com', authorization: `Bearer ${TOKEN}` }
    }, res => {
      res.on('data', () => {})
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    socket.on('error', reject)
    socket.end()
  })
  assert.equal(raw.status, 200)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 素材白名单
 * ═════════════════════════════════════════════════════════════════════════ */
section('3. 素材白名单（围栏 3）')

await okAsync('白名单内素材 → 200 + image/png + 正确字节', async () => {
  const res = await fetch(`${ROUTE}/art/idle.png`, { headers: auth() })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /image\/png/)
  const buf = Buffer.from(await res.arrayBuffer())
  assert.equal(buf.length, PNG_1PX.length)
  assert.ok(buf.equals(PNG_1PX), '字节应与磁盘一致')
})

await okAsync('白名单外的文件（存在）→ 404', async () => {
  const r = await call(`${ROUTE_PREFIX}/art/secret.png`, { headers: auth() })
  assert.equal(r.status, 404, '白名单外绝不服务')
})

await okAsync('目录遍历 ../ → 404', async () => {
  for (const evil of [
    '../secret.png',
    '../../secret.png',
    '..%2Fsecret.png',
    '%2e%2e%2fsecret.png',
    '....//secret.png',
    'bubble/../../secret.png'
  ]) {
    const r = await call(`${ROUTE_PREFIX}/art/${evil}`, { headers: auth() })
    assert.equal(r.status, 404, `${evil} 应 404`)
  }
})

await okAsync('不存在的白名单路径 → 404', async () => {
  const r = await call(`${ROUTE_PREFIX}/art/nope.png`, { headers: auth() })
  assert.equal(r.status, 404)
})

await okAsync('/atlas 返回清单且含覆盖率报告', async () => {
  const r = await call(`${ROUTE_PREFIX}/atlas`, { headers: auth() })
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.ok(body.states.idle)
  assert.equal(body.frameHeight, 256)
  assert.ok(body.report.coveredStates.includes('idle'))
  assert.ok(body.report.uncoveredStates.includes('sleeping'))
})

/* ══════════════════════════════════════════════════════════════════════════
 * 4. SSE 帧格式
 * ═════════════════════════════════════════════════════════════════════════ */
section('4. SSE 帧格式（契约 §2）')

await okAsync('/events 建立流并立刻发 hello + retry', async () => {
  // hello 只在**已有快照**时发送（绝不发空对象，见 hub.attach 的说明），
  // 所以先广播一帧再连，模拟宿主启动时的行为。
  hub.broadcast(snapshot())

  const controller = new AbortController()
  const res = await fetch(`${ROUTE}/events`, { headers: auth(), signal: controller.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (text.includes('event: hello')) break
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  controller.abort()

  assert.ok(text.includes(': connected'), '应有连接注释帧')
  assert.ok(text.includes('retry: 3000'), '应有重连建议')
  assert.ok(text.includes('event: hello'), '应有 hello 帧')
  assert.match(text, /\ndata: \{/, 'data 行格式应为 "data: {..."')
})

await okAsync('无快照时不发空 hello（避免 petState/rev 变 undefined）', async () => {
  // 用一个全新的 hub，确保没有 lastSnapshot。
  const fresh = createHub({ logger: { warn () {} }, heartbeatMs: 60000 })
  const seen = []
  fresh.attach({ on () {} }, {
    writeHead () {},
    write (chunk) { seen.push(String(chunk)) },
    end () {},
    on () {},
    writableEnded: false,
    destroyed: false
  })
  const joined = seen.join('')
  assert.ok(joined.includes(': connected'), '仍应有连接注释')
  assert.ok(!joined.includes('data: {}'), '绝不能发空对象 hello')
  fresh.dispose()
})

await okAsync('SSE 的 data 行是单行 JSON（不能含裸换行）', async () => {
  const controller = new AbortController()
  const res = await fetch(`${ROUTE}/events`, { headers: auth(), signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  // 故意塞一个含真实换行的 label，验证它**不会**破坏"空行 = 帧结束"的解析。
  hub.broadcast({ ...snapshot(), label: 'line1\nline2\r\nline3' })
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (text.includes('line1')) break
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  controller.abort()

  assert.ok(text.includes('line1'), '应收到含 label 的帧')

  // 契约 §2 的硬要求：每个 data 行都必须能**独立**解析成完整 JSON。
  // 只要有一条 data 行解析失败，就说明帧里混进了裸换行，C# 侧与 overlay 侧都会读错。
  const dataLines = text.split('\n').filter(l => l.startsWith('data: '))
  assert.ok(dataLines.length > 0, '应有 data 行')
  for (const line of dataLines) {
    assert.doesNotThrow(() => JSON.parse(line.slice('data: '.length)), `data 行不可解析：${line}`)
  }

  // 换行必须被 JSON 转义（而不是变成裸换行），且解析后能完整还原。
  const withLabel = dataLines
    .map(l => JSON.parse(l.slice('data: '.length)))
    .find(o => typeof o.label === 'string' && o.label.includes('line1'))
  assert.ok(withLabel !== undefined, '应能解析出带 label 的快照')
  assert.equal(withLabel.label, 'line1\nline2\r\nline3', '换行应原样还原（走 JSON 转义，不是裸换行）')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 位置与命令
 * ═════════════════════════════════════════════════════════════════════════ */
section('5. 位置回报与命令')

await okAsync('POST /position 只落 x/y（scale 绝不经过这里）', async () => {
  positionPatch = null
  const r = await call(`${ROUTE_PREFIX}/position`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ x: 100.6, y: 200.4, scale: 1.25 })
  })
  assert.equal(r.status, 200)
  assert.equal(positionPatch.x, 101, '应四舍五入')
  assert.equal(positionPatch.y, 200)
  // ⭐ scale **不属于** /pet/position：它属于 /pet/settings（滚轮缩放走那里）。
  // 这里若回写 scale 会形成回响环 —— exe 应用 scale → ReclampPosition →
  // POST position{scale} → 写进 settings → 广播 → exe 再应用 → 再上报……
  // 实测 pet.log 里 scale 会永远震荡停不下来。
  assert.equal(positionPatch.scale, undefined, 'scale 必须被忽略（回响环防线）')
})

await okAsync('POST /position 忽略非法字段（不崩）', async () => {
  positionPatch = null
  const r = await call(`${ROUTE_PREFIX}/position`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ x: 'abc', y: null, junk: 1 })
  })
  assert.equal(r.status, 200)
  assert.deepEqual(positionPatch, {}, '非法值不该写进 patch')
})

await okAsync('POST /position 非法 JSON → 400', async () => {
  const r = await call(`${ROUTE_PREFIX}/position`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: '{not json'
  })
  assert.equal(r.status, 400)
})

/* ── /pet/send：从气泡发消息（契约 §3）────────────────────────────────── */

await okAsync('POST /send 正常发送并回执 sessionId', async () => {
  sendSeen = null; sendThrow = null; sendCap = { available: true, reason: null }
  const r = await call(`${ROUTE_PREFIX}/send`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ text: '  你好呀  ' })
  })
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.equal(body.ok, true)
  assert.ok(body.sessionId, '应回执投递到的会话')
  assert.equal(sendSeen.text, '你好呀', '两端空白应被裁掉')
})

await okAsync('POST /send 空文本 → 400（不打扰会话）', async () => {
  sendSeen = null
  for (const text of ['', '   ', '\n\t ']) {
    const r = await call(`${ROUTE_PREFIX}/send`, {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ text })
    })
    assert.equal(r.status, 400)
    assert.equal(JSON.parse(r.body).error, 'empty')
  }
  assert.equal(sendSeen, null, '空文本不该到达发送层')
})

await okAsync('POST /send 超长 → 400（气泡是快捷入口，不是写长文的地方）', async () => {
  sendSeen = null
  const r = await call(`${ROUTE_PREFIX}/send`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ text: 'a'.repeat(2001) })
  })
  assert.equal(r.status, 400)
  assert.equal(JSON.parse(r.body).error, 'too-long')
  assert.equal(sendSeen, null)
})

await okAsync('POST /send 边界：正好 2000 字放行', async () => {
  sendSeen = null
  const r = await call(`${ROUTE_PREFIX}/send`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ text: 'a'.repeat(2000) })
  })
  assert.equal(r.status, 200, '上限本身是允许的')
})

await okAsync('POST /send 能力不可用 → 503 + 原因（不要假装发出去了）', async () => {
  sendCap = { available: false, reason: '宿主未装配 sessionController 服务' }
  const r = await call(`${ROUTE_PREFIX}/send`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ text: 'hi' })
  })
  assert.equal(r.status, 503)
  const body = JSON.parse(r.body)
  assert.equal(body.error, 'unavailable')
  assert.match(body.reason, /sessionController/)
  sendCap = { available: true, reason: null }
})

await okAsync('POST /send 没有可发会话 → 409', async () => {
  const err = new Error('没有可发送的会话'); err.code = 'no-session'
  sendThrow = err
  const r = await call(`${ROUTE_PREFIX}/send`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ text: 'hi' })
  })
  assert.equal(r.status, 409)
  assert.equal(JSON.parse(r.body).error, 'no-session')
  sendThrow = null
})

await okAsync('POST /send 投递被拒 → 502 + 可读 message', async () => {
  sendThrow = new Error('agent busy')
  const r = await call(`${ROUTE_PREFIX}/send`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ text: 'hi' })
  })
  assert.equal(r.status, 502)
  const body = JSON.parse(r.body)
  assert.equal(body.error, 'send-failed')
  assert.match(body.message, /busy/)
  sendThrow = null
})

await okAsync('POST /send 非法 JSON → 400', async () => {
  const r = await call(`${ROUTE_PREFIX}/send`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: '{oops'
  })
  assert.equal(r.status, 400)
})

await okAsync('POST /send 无令牌且伪造 Host → 403（准入与其他路由一致）', async () => {
  // `fetch` 不允许改 Host 头，所以直接对 server 发原始请求（照抄 §2 的做法）。
  const raw = await new Promise((resolve, reject) => {
    const socket = http.request({
      host: '127.0.0.1',
      port,
      path: `${ROUTE_PREFIX}/send`,
      method: 'POST',
      headers: { host: 'evil.example.com', 'content-type': 'application/json' }
    }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    socket.on('error', reject)
    socket.end(JSON.stringify({ text: 'hi' }))
  })
  assert.equal(raw.status, 403, '发消息是**写**操作，不能只靠同源假设')
})

await okAsync('POST /command 分派命令', async () => {
  commandSeen = null
  const r = await call(`${ROUTE_PREFIX}/command`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ command: 'reload-art' })
  })
  assert.equal(r.status, 200)
  assert.equal(commandSeen, 'reload-art')
})

await okAsync('POST /command 缺 command → 400', async () => {
  const r = await call(`${ROUTE_PREFIX}/command`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({})
  })
  assert.equal(r.status, 400)
})

await okAsync('未知路由 → 404', async () => {
  const r = await call(`${ROUTE_PREFIX}/nope`, { headers: auth() })
  assert.equal(r.status, 404)
})

await okAsync('GET /settings 返回桌宠自己的设置', async () => {
  const r = await call(`${ROUTE_PREFIX}/settings`, { headers: auth() })
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.equal(body.settings.mode, 'auto')
})

await okAsync('POST /settings 覆盖设置并回执归一化结果', async () => {
  const r = await call(`${ROUTE_PREFIX}/settings`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ settings: { mode: 'overlay', scale: 1.5 } })
  })
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.equal(body.settings.mode, 'overlay')
  assert.equal(body.settings.scale, 1.5)
})

await okAsync('POST /settings 非法 JSON → 400', async () => {
  const r = await call(`${ROUTE_PREFIX}/settings`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: '{oops'
  })
  assert.equal(r.status, 400)
})

await okAsync('GET /diag 暴露构建标记与素材报告', async () => {
  const r = await call(`${ROUTE_PREFIX}/diag`, { headers: auth() })
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.equal(body.routePrefix, ROUTE_PREFIX)
  assert.equal(body.diag.build, 'test-build')
  assert.ok(body.atlas)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5b. 番茄钟路由（契约 §3 新增）
 * ═════════════════════════════════════════════════════════════════════════ */
section('5b. 番茄钟路由（/pet/pomodoro）')

/**
 * 给 handler 装一个**真的**番茄钟（不是桩）。
 *
 * 为什么不用手写桩：桩只能验证"路由把 action 转发出去了"，
 * 而真正会出错的是"action 名与番茄钟方法对不上""白名单漏了一个动作"。
 * 用真模块才能覆盖那条链路。这里用固定时钟，避免测试受真实时间影响。
 */
let pomoClock = 1_000_000
const realPomodoro = createPomodoro({
  now: () => pomoClock,
  config: { enabled: true, focusMs: 60_000, breakMs: 30_000, longBreakMs: 90_000, roundsPerLongBreak: 4 }
})
/**
 * 记录**每一个到达 `control` 的 action**。
 *
 * 为什么需要它：这条断言最初写成"非白名单动作返回 400"，但回退验证发现
 * 把白名单整个删掉**测试照样全绿** —— 因为 `control` 对未知动作返回 `null`，
 * 路由的第二个检查（`result === null`）把 400 补上了。于是断言测的是
 * "control 返回 null"，**完全没测到白名单**。
 *
 * 真正的安全性质是：**动作串绝不允许到达内部**（白名单是那道闸，
 * `control` 的 null 只是它的备份）。所以要直接断言"control 从没见过
 * 非白名单动作"——这才是白名单独有的、删掉它就失败的性质。
 */
const controlCalls = []
const pomoHandler = createHandler({
  snapshot,
  atlas: () => atlas,
  artDir,
  token: TOKEN,
  hub,
  logger: { warn () {}, debug () {}, info () {} },
  connection: () => undefined,
  onPosition: () => {},
  onCommand: () => ({}),
  getSettings: () => settingsValue,
  setSettings: next => next,
  pomodoro: {
    snapshot: () => realPomodoro.snapshot(pomoClock),
    control: action => {
      controlCalls.push(action)
      switch (action) {
        case 'start': return { started: realPomodoro.start(pomoClock) }
        case 'pause': return { paused: realPomodoro.pause() }
        case 'toggle': return { running: realPomodoro.toggle(pomoClock) }
        case 'skip': return realPomodoro.skip(pomoClock)
        case 'reset': return { reset: realPomodoro.reset(pomoClock) }
        default: return null
      }
    }
  }
})
const pomoServer = http.createServer((req, res) => {
  pomoHandler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
})
await new Promise(resolve => pomoServer.listen(0, '127.0.0.1', resolve))
const POMO_BASE = `http://127.0.0.1:${pomoServer.address().port}`

async function pomoCall (method, body) {
  const res = await fetch(`${POMO_BASE}${ROUTE_PREFIX}/pomodoro`, {
    method,
    headers: auth(body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: res.status, body: await res.text() }
}

await okAsync('GET /pomodoro 返回契约 §2 形状的块', async () => {
  const r = await pomoCall('GET')
  assert.equal(r.status, 200, `状态码 ${r.status}`)
  const p = JSON.parse(r.body).pomodoro
  for (const key of ['enabled', 'phase', 'running', 'remainingMs', 'totalMs',
    'endsAt', 'completed', 'round', 'roundsPerLongBreak', 'autoNext', 'notify',
    'text', 'show']) {
    assert.ok(key in p, `块缺字段 ${key}`)
  }
})

await okAsync('⭐⭐ 白名单之外的动作**根本到不了** control（不是靠它返回 null 兜底）', async () => {
  // 回退验证过的区分度：把 `if (!ALLOWED.includes(action))` 删掉，这条会失败。
  // 之前的版本测不出来 —— 它测的是"control 返回 null"，而白名单删掉后
  // 那个兜底照样给 400，于是断言全绿而闸门其实已经没了。
  const EVIL = ['__proto__', 'constructor', 'toString', 'hasOwnProperty',
    'start;process.exit(1)', '', 'START', 'pause ', 'reset\n', 'skip\t',
    'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']
  for (const evil of EVIL) {
    controlCalls.length = 0
    const r = await pomoCall('POST', { action: evil })
    assert.equal(r.status, 400, `动作 ${JSON.stringify(evil)} 应 400，实际 ${r.status}`)
    assert.deepEqual(controlCalls, [],
      `动作 ${JSON.stringify(evil)} **不该到达 control**，实际到达了：${JSON.stringify(controlCalls)}`)
  }
})

await okAsync('白名单内的动作**确实**到达 control（否则上面的断言是空的）', async () => {
  // 反向确认：没有这条，"control 从没见过非法动作"可能只是因为
  // control 从来没被调用过（那断言毫无意义）。
  for (const good of ['start', 'pause', 'toggle', 'skip', 'reset']) {
    controlCalls.length = 0
    const r = await pomoCall('POST', { action: good })
    assert.equal(r.status, 200, `合法动作 ${good} 应 200，实际 ${r.status}`)
    assert.deepEqual(controlCalls, [good],
      `合法动作 ${good} 必须到达 control，实际：${JSON.stringify(controlCalls)}`)
  }
})

await okAsync('缺 action 字段 → 400 且列出允许值（调用方能自我纠正）', async () => {
  const r = await pomoCall('POST', {})
  assert.equal(r.status, 400)
  const body = JSON.parse(r.body)
  assert.deepEqual(body.allowed, ['start', 'pause', 'toggle', 'skip', 'reset'])
})

await okAsync('非法 JSON → 400', async () => {
  const res = await fetch(`${POMO_BASE}${ROUTE_PREFIX}/pomodoro`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: '{oops'
  })
  assert.equal(res.status, 400)
})

await okAsync('不支持的方法 → 405', async () => {
  const res = await fetch(`${POMO_BASE}${ROUTE_PREFIX}/pomodoro`, {
    method: 'DELETE',
    headers: auth()
  })
  assert.equal(res.status, 405)
})

await okAsync('⭐⭐ 每个允许的动作都**真的**作用到番茄钟（不是只回 ok）', async () => {
  // 这是本节最重要的一条：如果路由只回 `{ok:true}` 而没调 `control`，
  // 上面所有断言都会通过 —— 但按钮是死的。所以逐个动作验证**真实状态变化**。
  realPomodoro.reset(pomoClock)

  // start：真的开始跑
  let r = await pomoCall('POST', { action: 'start' })
  assert.equal(r.status, 200)
  assert.equal(JSON.parse(r.body).pomodoro.running, true, 'start 后应在跑')
  assert.equal(realPomodoro.internals.running, true, '真实对象也应在跑（不是只回了 ok）')

  // pause：真的停
  r = await pomoCall('POST', { action: 'pause' })
  assert.equal(JSON.parse(r.body).pomodoro.running, false, 'pause 后应停')
  assert.equal(realPomodoro.internals.running, false)

  // toggle：停 → 跑
  r = await pomoCall('POST', { action: 'toggle' })
  assert.equal(JSON.parse(r.body).pomodoro.running, true, 'toggle 应变成跑')
  assert.equal(realPomodoro.internals.running, true)

  // skip：真的切阶段
  const beforePhase = realPomodoro.internals.phase
  r = await pomoCall('POST', { action: 'skip' })
  assert.equal(r.status, 200)
  assert.notEqual(realPomodoro.internals.phase, beforePhase, 'skip 应切换阶段')
  assert.equal(JSON.parse(r.body).pomodoro.phase, realPomodoro.internals.phase,
    '回执的块必须反映切换后的真实状态')

  // reset：真的回到第一轮专注
  realPomodoro.skip(pomoClock)     // 先弄脏状态
  r = await pomoCall('POST', { action: 'reset' })
  assert.equal(realPomodoro.internals.phase, 'focus', 'reset 应回到专注')
  assert.equal(realPomodoro.internals.completed, 0, 'reset 应清空轮数')
  assert.equal(JSON.parse(r.body).pomodoro.phase, 'focus')
})

await okAsync('回执里带上动作后的新块（exe 不必再拉一次 /state）', async () => {
  realPomodoro.reset(pomoClock)
  const r = await pomoCall('POST', { action: 'start' })
  const body = JSON.parse(r.body)
  assert.equal(body.ok, true)
  assert.equal(body.action, 'start')
  assert.ok(body.pomodoro, '回执必须带新块')
  assert.equal(body.pomodoro.running, true)
})

await okAsync('未装配番茄钟时返回 503（不许假装成功）', async () => {
  const bare = createHandler({
    snapshot,
    atlas: () => atlas,
    artDir,
    token: TOKEN,
    hub,
    logger: { warn () {}, debug () {}, info () {} },
    connection: () => undefined,
    onPosition: () => {},
    onCommand: () => ({})
    // 故意不传 pomodoro
  })
  const srv = http.createServer((req, res) => {
    bare(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${srv.address().port}`
  const res = await fetch(`${base}${ROUTE_PREFIX}/pomodoro`, { headers: auth() })
  assert.equal(res.status, 503, '没装配就该明确说不可用')
  const body = JSON.parse(await res.text())
  assert.equal(body.error, 'unavailable')
  await new Promise(resolve => srv.close(resolve))
})

await okAsync('番茄钟路由也受令牌/围栏保护（无令牌的跨站请求被拒）', async () => {
  const res = await fetch(`${POMO_BASE}${ROUTE_PREFIX}/pomodoro`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ action: 'start' })
  })
  assert.equal(res.status, 403, `跨站请求应 403，实际 ${res.status}`)
})

await new Promise(resolve => pomoServer.close(resolve))

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 端口自发现与 exe 定位
 * ═════════════════════════════════════════════════════════════════════════ */
section('6. 端口自发现与 exe 定位')

ok('baseUrlOf 用 webServer.port（不硬编码 19387）', () => {
  assert.equal(baseUrlOf({ host: '127.0.0.1', port: 45678 }), 'http://127.0.0.1:45678')
})

ok('baseUrlOf 把 0.0.0.0 映射为 127.0.0.1（契约 §0）', () => {
  assert.equal(baseUrlOf({ host: '0.0.0.0', port: 8080 }), 'http://127.0.0.1:8080')
})

ok('baseUrlOf 缺 host 时也回落 127.0.0.1', () => {
  assert.equal(baseUrlOf({ port: 1234 }), 'http://127.0.0.1:1234')
})

ok('baseUrlOf 对 IPv6 加方括号', () => {
  assert.equal(baseUrlOf({ host: '::1', port: 99 }), 'http://[::1]:99')
})

ok('baseUrlOf 端口非法时返回 null（不猜）', () => {
  assert.equal(baseUrlOf({ port: 0 }), null)
  assert.equal(baseUrlOf({ port: -1 }), null)
  assert.equal(baseUrlOf({ port: 'abc' }), null)
  assert.equal(baseUrlOf(undefined), null)
  assert.equal(baseUrlOf({}), null)
})

ok('locateExe 在 bin/ 找到 exe', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-pet-exe-'))
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'bin', EXE_NAME), 'fake')
  const found = locateExe(root)
  assert.ok(found !== null && found.endsWith(EXE_NAME))
})

ok('locateExe 找不到时返回 null（供上层回落 overlay）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-pet-noexe-'))
  assert.equal(locateExe(root), null)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 7. hub 生命周期
 * ═════════════════════════════════════════════════════════════════════════ */
section('7. hub 生命周期')

/**
 * 桩响应：形状对齐 node:http 的 ServerResponse 中 hub 真正用到的那几项
 * （`writeHead` / `write` / `end` / `on` / `writableEnded` / `destroyed`）。
 * 桩请求同理只需 `on`。
 */
function stubRes (onWrite) {
  return {
    writeHead () {},
    write (chunk) {
      if (onWrite !== undefined) onWrite(String(chunk))
    },
    end () {},
    on () {},
    writableEnded: false,
    destroyed: false
  }
}
const stubReq = () => ({ on () {} })

ok('hub.dispose 关闭全部流（不留半开响应）', () => {
  const h = createHub({ logger: { warn () {} }, heartbeatMs: 60000 })
  const ended = []
  const res = stubRes()
  res.end = () => {
    ended.push(1)
  }
  h.attach(stubReq(), res)
  assert.equal(h.size, 1)
  h.dispose()
  assert.equal(h.size, 0)
  assert.equal(ended.length, 1, '应调用 end()')
})

ok('hub 广播给多个客户端', () => {
  const h = createHub({ logger: { warn () {} }, heartbeatMs: 60000 })
  const seen = []
  h.attach(stubReq(), stubRes(c => seen.push(c)))
  h.attach(stubReq(), stubRes(c => seen.push(c)))
  assert.equal(h.size, 2)
  h.broadcast({ rev: 1 })
  assert.equal(seen.filter(c => c.includes('event: state')).length, 2)
  h.dispose()
})

ok('hub 对新客户端立刻发最近快照作为 hello', () => {
  const h = createHub({ logger: { warn () {} }, heartbeatMs: 60000 })
  h.broadcast({ rev: 42, petState: 'working' })
  const seen = []
  h.attach(stubReq(), stubRes(c => seen.push(c)))
  assert.ok(seen.some(c => c.includes('event: hello') && c.includes('"rev":42')))
  h.dispose()
})

ok('hub 在客户端断开后不泄漏（size 归零）', () => {
  const h = createHub({ logger: { warn () {} }, heartbeatMs: 60000 })
  let closeCb = null
  const req = { on (name, fn) { if (name === 'close') closeCb = fn } }
  h.attach(req, stubRes())
  assert.equal(h.size, 1)
  closeCb()
  assert.equal(h.size, 0, '断开后应移除客户端')
  h.dispose()
})

/* ══════════════════════════════════════════════════════════════════════════
 * 8. loadAtlas 容错
 * ═════════════════════════════════════════════════════════════════════════ */
section('8. loadAtlas 容错（缺素材不该让插件瘫掉）')

ok('pet.json 不存在时返回空清单且不抛', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-pet-noatlas-'))
  const a = loadAtlas(empty, { warn () {} })
  assert.equal(a.allowed.size, 0)
  assert.equal(a.frameHeight, 0)
})

ok('pet.json 损坏时返回空清单且不抛', () => {
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-pet-badatlas-'))
  fs.writeFileSync(path.join(bad, 'pet.json'), '{ this is not json')
  const a = loadAtlas(bad, { warn () {} })
  assert.equal(a.allowed.size, 0)
})

ok('真实清单能被加载并派生白名单', () => {
  const a = loadAtlas(artDir, { warn () {} })
  assert.ok(a.allowed.has('idle.png'))
  assert.ok(a.allowed.has('bubble/01.png'))
})

/* ═════════════════════════════════════════════════════════════════════════ */
hub.dispose()
await new Promise(resolve => server.close(resolve))
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
} catch { /* 清理失败不影响结论 */ }

console.log(`\n${'═'.repeat(60)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('❌ 有失败项')
  process.exit(1)
}
console.log('✅ 全部通过')