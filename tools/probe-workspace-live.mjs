/**
 * 真机验证：工作区归属修复（**不碰用户的真实会话**）
 *
 * 做法：起一个真实 index.js 装配，用**临时 DSH_HOME + 临时聊天目录**，
 * 但 `workspaceRegistry` / `sessionController` 用**真实的宿主服务**吗？——
 * 不行：那是宿主进程内的服务，测试进程拿不到。
 *
 * 所以这里验证的是**我们能验证的那一半**：调用序列与参数形状
 * （registry.create(path,title) → create({workspaceId})，且不带 cwd）。
 * 真机那一半由用户重启后自己看到"已归入工作区"来确认 ——
 * 这比在测试里假装拥有宿主服务更诚实。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-ws-live-'))
process.env.DSH_HOME = tmpHome
const chatDir = path.join(tmpHome, 'chat-ws')

const calls = { registry: [], create: [], attach: [] }
const workspace = {
  id: 'ws-live-1',
  path: chatDir,
  title: '庄方宜',
  sessionIds: [],
  async attachSession (sid) { calls.attach.push(sid); this.sessionIds.push(sid) }
}

const routes = []
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  const hit = routes.find(r => r.kind === 'prefix' && (p === r.path || p.startsWith(r.path + '/')))
  if (!hit) { res.writeHead(404); res.end(); return }
  Promise.resolve(hit.handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const services = new Map()
services.set('webServer', {
  routes, port, host: '127.0.0.1',
  register (r) { routes.push(r); return () => {} },
  registerUpgrade () { return () => {} },
  tapIndex () { return () => {} }
})
services.set('workspaceRegistry', {
  async create (p, title) { calls.registry.push({ p, title }); workspace.path = p; return workspace },
  get (id) { return id === workspace.id ? workspace : undefined },
  list () { return [workspace] }
})
services.set('sessionController', {
  async list () { return { items: [] } },
  async create (req) { calls.create.push({ ...req }); return { sessionId: 'chat-live-1' } },
  async prompt (req, signal) { signal.throwIfAborted(); return { accepted: true } }
})

const ctx = {
  logger: { info () {}, warn () {}, debug () {}, error () {} },
  on () { return () => {} },
  effect (fn) { const d = fn(); return d },
  // ⚠️ `inject(['webServer'], scoped => ...)` 的 scoped ctx 必须**真的带 webServer**：
  // index.js 在回调里读 `scoped.webServer`，不给就会在路由注册处炸
  //（探针第一版就是这么挂的）。
  inject (deps, cb) { return cb({ ...ctx, webServer: services.get('webServer') }) },
  get (n) { return services.get(n) },
  provide (n, v) { services.set(n, v); return () => services.delete(n) },
  set (n, v) { services.set(n, v) }
}

const pet = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
pet.apply(ctx, {})

const base = `http://127.0.0.1:${port}`
await fetch(`${base}/api/zhuang-fangyi/pet/settings`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ settings: { chatWorkspace: chatDir } })
})
const res = await fetch(`${base}/api/zhuang-fangyi/pet/chat`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '在吗？' })
})
console.log('聊天 POST 状态：', res.status)

console.log('\n=== 调用序列 ===')
console.log('registry.create:', JSON.stringify(calls.registry))
console.log('session.create :', JSON.stringify(calls.create))
console.log('attachSession  :', JSON.stringify(calls.attach))

const st = await (await fetch(`${base}/api/zhuang-fangyi/pet/chat`)).json()
console.log('\n状态里的归属：', st.workspaceId, '/', st.workspaceTitle)

assert.equal(res.status, 200, '聊天应成功')
assert.equal(calls.registry.length, 1, '应先注册工作区')
assert.equal(calls.registry[0].title, '庄方宜', '工作区标题应是「庄方宜」')
assert.equal(calls.create[0].workspaceId, 'ws-live-1', '会话应带 workspaceId')
assert.equal(calls.create[0].cwd, undefined, 'workspaceId 与 cwd 互斥')
assert.equal(st.workspaceId, 'ws-live-1', '状态应报出归属')
console.log('\n✅ 真机链路形状正确（注册 → 按 workspaceId 建会话 → 归属可见）')
server.close()
