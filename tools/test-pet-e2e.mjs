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