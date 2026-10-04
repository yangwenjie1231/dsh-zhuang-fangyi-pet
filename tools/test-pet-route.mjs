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

await okAsync('POST /position 落盘位置', async () => {
  positionPatch = null
  const r = await call(`${ROUTE_PREFIX}/position`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ x: 100.6, y: 200.4, scale: 1.25 })
  })
  assert.equal(r.status, 200)
  assert.equal(positionPatch.x, 101, '应四舍五入')
  assert.equal(positionPatch.y, 200)
  assert.equal(positionPatch.scale, 1.25)
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
  assert.equal(a.files.size, 0)
  assert.equal(a.frameHeight, 0)
})

ok('pet.json 损坏时返回空清单且不抛', () => {
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-pet-badatlas-'))
  fs.writeFileSync(path.join(bad, 'pet.json'), '{ this is not json')
  const a = loadAtlas(bad, { warn () {} })
  assert.equal(a.files.size, 0)
})

ok('真实清单能被加载并派生白名单', () => {
  const a = loadAtlas(artDir, { warn () {} })
  assert.ok(a.files.has('idle.png'))
  assert.ok(a.files.has('bubble/01.png'))
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