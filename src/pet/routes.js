/**
 * 庄方宜桌宠 · HTTP 路由 + 两道安全围栏
 *
 * ── 为什么必须有围栏（这不是过度设计）────────────────────────────────────
 *
 * 本插件注册的前缀是 `/api/zhuang-fangyi/pet`，**比内核的 `/api` 长**。
 * `webServer` 的派发规则是「exact 优先，然后最长前缀胜出」，所以我们的 handler
 * 会**先于**内核 `connection` 服务的 admission 检查执行 —— 也就是说，
 * 不自己把关的话，这些路由会**应答任何本机调用者**。
 *
 * 这个边界在本 profile 里已被实测并记录（`dsh-our-free-model/src/trust.js` 的
 * 文件头就是这么写的），所以这里照抄它的两层做法：
 *
 *   1. 组合里有 `connection` 服务时，用它的 `admit(req)` —— 与内核同一条判定，
 *      保证插件**绝不比 app 本身更宽松**；
 *   2. 没有该服务时，退回结构复刻（仅 loopback Host、拒 cross-site、
 *      Origin/Referer 必须同 authority）。
 *
 * ── 但围栏只防浏览器 ─────────────────────────────────────────────────────
 *
 * 围栏挡的是 DNS 重绑定与跨站请求。**它挡不住本机任意进程**（任何进程都能伪造
 * loopback Host）。所以再加**一次性令牌**：每次 spawn exe 时随机生成、经 argv 传递、
 * 不落盘。
 *
 * ── 两条准入路径（**必须两条，否则浏览器半边直接坏掉**）──────────────────
 *
 * 这一点踩过，值得写清楚：
 *
 *   · **原生 exe** 能带请求头 → 走 `Authorization: Bearer <token>`；
 *   · **浏览器半边** 带不了令牌。而且 **`EventSource` 根本不允许设置请求头**，
 *     所以 SSE 那条路在浏览器侧**不可能**用令牌。
 *
 * 因此准入是「**令牌 或 同源围栏**」二者之一：
 *
 *   1. 令牌正确 → 放行（原生 exe）；
 *   2. 否则走信任围栏：仅 loopback Host、非 cross-site、Origin/Referer 同 authority
 *      → 放行（DSH 渲染进程的同源 fetch / EventSource）。
 *
 * 这个取舍与本 profile 的既有事实一致：主题插件的 `/api/zhuang-fangyi/*`
 * 本来就是**无令牌、仅靠 loopback 暴露**的（实测 `Invoke-WebRequest` 裸访问返回 200），
 * 而桌宠快照里**不含任何消息正文**，只有 `thinking/working/…` 这类状态词。
 * 真正需要防的是**网页**（跨站读取/DNS 重绑定），那正是围栏在做的事。
 *
 * ── 第三道：素材白名单 ───────────────────────────────────────────────────
 *
 * `/pet/art/<name>` 绝不拼接客户端传入的路径，一律经 `atlas.resolveArt()` ——
 * 它既查清单白名单，又二次校验 `path.resolve` 结果仍在 `art/pet` 内。
 *
 * @module src/pet/routes.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resolveArt, artForState, atlasReport } from './atlas.js'

/** 路由前缀。**不要改**：exe 与 overlay 都按契约 §3 硬编码它。 */
export const ROUTE_PREFIX = '/api/zhuang-fangyi/pet'

/** 回环主机名白名单（与内核 `isLoopbackHostname` 同集合）。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/** 请求体上限。位置/命令都是极小的 JSON。 */
const MAX_BODY = 8 * 1024

/** 生成一次性令牌（48 位 hex = 24 字节熵）。 */
export function newToken () {
  return crypto.randomBytes(24).toString('hex')
}

/** 拆 Host/Origin/Referer 为 `{scheme, hostname, port}`。 */
function authorityOf (value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

/**
 * 结构复刻围栏（与内核 `isTrustedApiRequest` 同形）。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {number|undefined} 拒绝用的 HTTP 状态码，或 undefined 放行
 */
export function structuralRejection (req) {
  const host = authorityOf(req.headers.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 403
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const authority = authorityOf(raw.trim())
    if (authority === null) return 403
    // webServer 在 loopback 上讲明文 http，所以声称 https 的 Origin 不是本页。
    if (authority.scheme !== host.scheme ||
        authority.hostname !== host.hostname ||
        authority.port !== host.port) return 403
  }
  return undefined
}

/**
 * 决定一个请求该不该被拒。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object|undefined} connection - 组合里的 `connection` 服务（可能没有）
 * @returns {number|undefined}
 */
export function rejectionFor (req, connection) {
  if (connection !== undefined && connection !== null && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req)
      if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
        return admission.rejection
      }
      return undefined
    } catch {
      // connection 服务抛错是组合 bug；退回结构围栏，而不是对每个请求回 500。
    }
  }
  return structuralRejection(req)
}

/** 常量时间比较令牌，避免时序侧信道。 */
export function tokenMatches (req, token) {
  const raw = req.headers.authorization ?? ''
  const presented = typeof raw === 'string' && raw.startsWith('Bearer ')
    ? raw.slice('Bearer '.length).trim()
    : ''
  if (presented === '' || token === '') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(token)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** 读请求体（带上限）。 */
function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 建立路由 handler。
 *
 * @param {object} deps
 * @param {() => object} deps.snapshot - 取当前快照（契约 §2）
 * @param {() => object} deps.atlas - 取当前素材清单
 * @param {string} deps.artDir - `art/pet/` 绝对路径
 * @param {string} deps.token - 一次性令牌
 * @param {object} deps.hub - SSE hub
 * @param {(patch: object) => void} deps.onPosition - 位置回报
 * @param {(text: string, sessionId?: string) => Promise<object>} [deps.onSend] - 发消息到会话
 * @param {() => {available: boolean, reason: string|null}} [deps.sendCapability] - 发消息能力位
 * @param {(command: string) => object} deps.onCommand - 命令处理
 * @param {object} [deps.pomodoro] - 番茄钟（`{snapshot(), control(action)}`）；
 *   缺失时 `/pet/pomodoro` 返回 503（**不许假装成功**）
 * @param {(name: string) => string|null} [deps.resolveVoice] - 语音名 → 绝对路径
 *   （**白名单查表**，不在清单里返回 null → 404）
 * @param {() => object} [deps.voiceManifest] - 语音清单（`GET /pet/voices`）
 * @param {object} [deps.interact] - 互动（`{list(), do(kind)}`）；
 *   缺失时 `/pet/interact` 返回 503
 * @param {object} [deps.chat] - 聊天（`{status(), send(text)}`）；缺失时 503
 * @param {object} [deps.personas] - 人设（`{list(), select(name)}`）；缺失时 503
 * @param {object} [deps.memory] - 记忆（`{get(), set(text)}`）；缺失时 503
 * @param {() => object} deps.getSettings - 取当前设置
 * @param {(next: object) => object} deps.setSettings - 覆盖设置（归一化后返回）
 * @param {() => object|undefined} deps.connection - 取 `connection` 服务
 * @param {object} [deps.logger]
 * @returns {(req, res) => Promise<void>}
 */
export function createHandler (deps) {
  const logger = deps.logger ?? console

  /**
   * 一条消息的长度上限。
   *
   * 为什么要有：气泡输入框是**单行**的快捷入口，不是用来写长文的。
   * 不设限的话，一次误粘贴能把一整个文件塞进会话，既难撤回也烧 token。
   * 2000 字对"说句话"绰绰有余。
   */
  const SEND_MAX_CHARS = 2000

  const sendJson = (res, code, body) => {
    const text = JSON.stringify(body)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text)
    })
    res.end(text)
  }

  /**
   * `/pet/art/` 的 MIME —— **按扩展名**，不再硬编码 `image/png`。
   *
   * 为什么现在必须区分：动态气泡（契约 §4 v-next 的 `frames`）交付的是 **GIF**。
   * 类型贴错在"只服务 PNG"的年代看不出来，一旦有 GIF 就会让按 MIME 处理的
   * 客户端/代理走错分支（`nosniff` 一开更是直接坏掉）。
   * 认不出的扩展名回落 `application/octet-stream`（安全侧：不去猜）。
   */
  const ART_MIME = {
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg'
  }
  const artMime = rel => ART_MIME[path.extname(String(rel)).toLowerCase()] ?? 'application/octet-stream'

  const deny = (res, code) => {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(code === 401 ? 'unauthorized' : 'forbidden')
  }

  return async function handler (req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      sendJson(res, 400, { error: 'bad url' })
      return
    }
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'

    // ── 准入：令牌 **或** 同源围栏（见文件头"两条准入路径"）─────────────────
    //
    // 先算围栏，再决定是否放行：原生 exe 带令牌但**不带 Origin**，围栏也会放行；
    // 浏览器不带令牌但 Origin 同源，围栏放行。
    // 只有「令牌错 **且** 围栏拒」才 403 —— 这样既挡住网页，又不破坏浏览器半边。
    let connection
    try {
      connection = deps.connection?.()
    } catch { connection = undefined }
    const rejection = rejectionFor(req, connection)
    const hasToken = tokenMatches(req, deps.token)

    if (!hasToken && rejection !== undefined) {
      deny(res, rejection)
      return
    }

    try {
      // ── 设置读写 ────────────────────────────────────────────────────────
      //
      // 桌宠有**自己**的设置文件（`$DSH_HOME/zhuang-fangyi-pet/settings.json`），
      // 与主题插件各自独立 —— 两个插件零耦合，装一个不装另一个都能工作。
      // 所以这里绝不代理到主题插件的 `/api/zhuang-fangyi/settings`：
      // 那样写会把桌宠的 `pet` 块塞进主题插件的设置，被它的 normalize 丢掉。
      if (route === '/settings') {
        if (req.method === 'GET') {
          sendJson(res, 200, { settings: deps.getSettings() })
          return
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          let parsed
          try {
            parsed = JSON.parse(await readBody(req))
          } catch {
            sendJson(res, 400, { error: 'invalid json' })
            return
          }
          const next = deps.setSettings(parsed?.settings ?? parsed)
          sendJson(res, 200, { settings: next })
          return
        }
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }

      // ── SSE 下行 ────────────────────────────────────────────────────────
      if (route === '/events' && req.method === 'GET') {
        deps.hub.attach(req, res)
        return
      }

      // ── 快照（轮询兜底）────────────────────────────────────────────────
      if (route === '/state' && req.method === 'GET') {
        sendJson(res, 200, deps.snapshot())
        return
      }

      // ── 素材清单 ────────────────────────────────────────────────────────
      //
      // ⚠️ **必须带上 `files`**（每个文件自己的几何）。漏掉它的后果实测过：
      // exe 通过 HTTP 拿到清单时会打日志「0 个 files 几何（来源 host）」，
      // 于是退化成按 state 声明切变体 —— 而 24 个变体里有 14 个与声明不符，
      // 会被拒收并回落 canonical。整个 `files` 机制**在真实链路上变成死代码**。
      //
      // 教训：只测「从磁盘读 pet.json」是不够的，**HTTP 这一跳也必须测**。
      if (route === '/atlas' && req.method === 'GET') {
        const atlas = deps.atlas()
        sendJson(res, 200, {
          version: atlas.version,
          generatedAt: atlas.generatedAt,
          frameHeight: atlas.frameHeight,
          states: atlas.states,
          variants: atlas.variants,
          files: atlas.files,
          /**
           * 素材台账（产物路径 → 语义 id / 画面说明）。
           *
           * 为什么必须透传：`files` 字段曾因为只在这一跳被吃掉而**静默失效**过
           * （宿主自检直接读 pet.json 是绿的，走 HTTP 却拿到缺字段的清单，
           * 症状是"变体永远按错几何切"）。`assets` 是同一个坑的同一条防线：
           * exe 与 e2e 断言都靠它把 `error-listless.png` 和「吐彩虹」对上号。
           */
          assets: atlas.assets,
          bubble: atlas.bubble,
          missing: atlas.missing,
          report: atlasReport(atlas)
        })
        return
      }

      // ── 诊断 ────────────────────────────────────────────────────────────
      if (route === '/diag' && req.method === 'GET') {
        sendJson(res, 200, {
          routePrefix: ROUTE_PREFIX,
          clients: deps.hub.size,
          atlas: atlasReport(deps.atlas()),
          state: deps.snapshot(),
          diag: deps.diagnostics?.() ?? null,
          // 动态语音状态（子插件通没通 —— 用户一眼可见，不用去翻设置页）
          speech: deps.speech?.status?.() ?? null
        })
        return
      }

      // ── 素材（围栏 3：白名单 + 路径二次校验）────────────────────────────
      if (route.startsWith('/art/') && req.method === 'GET') {
        let rel
        try {
          rel = decodeURIComponent(route.slice('/art/'.length))
        } catch {
          sendJson(res, 400, { error: 'bad encoding' })
          return
        }
        const abs = resolveArt(deps.artDir, rel, deps.atlas())
        if (abs === null) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        let stat
        try {
          stat = fs.statSync(abs)
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        if (!stat.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        res.writeHead(200, {
          // ⚠️ 按扩展名给 MIME。原先硬编码 `image/png` —— 在气泡只有 PNG 时没暴露，
          // 但动态气泡（契约 §4 v-next 的 `frames`）交付的是 **GIF**，
          // 贴错类型会让浏览器/代理按 PNG 处理（`nosniff` 一开就是直接坏掉）。
          'content-type': artMime(rel),
          'content-length': stat.size,
          // 文件名随内容变化（prepare-pet.py 重跑会换名），可以长缓存。
          'cache-control': 'public, max-age=604800, immutable'
        })
        fs.createReadStream(abs).pipe(res)
        return
      }

      // ── 位置回报 ────────────────────────────────────────────────────────
      if (route === '/position' && (req.method === 'POST' || req.method === 'PUT')) {
        let parsed
        try {
          parsed = JSON.parse(await readBody(req))
        } catch {
          sendJson(res, 400, { error: 'invalid json' })
          return
        }
        const patch = {}
        for (const key of ['x', 'y']) {
          if (Number.isFinite(parsed?.[key])) patch[key] = Math.round(parsed[key])
        }
        // ⚠️ **只收 x/y，绝不收 scale**。scale 属于 `/pet/settings`（滚轮缩放走那里）。
        // 这里若回写 scale 会形成回响环：exe 应用 scale → ReclampPosition →
        // POST position{scale} → 这里写进 settings → 广播 → exe 再应用 → 再上报……
        // 实测会无限震荡（pet.log 里 scale 在几个值之间永远停不下来）。
        if ('scale' in (parsed ?? {})) {
          logger?.warn?.('zhuang-fangyi-pet: /pet/position 收到 scale 字段，已忽略（scale 只走 /pet/settings）')
        }
        deps.onPosition(patch)
        sendJson(res, 200, { ok: true, applied: patch })
        return
      }

      // ── 发消息到会话（契约 §3 新增）────────────────────────────────────
      if (route === '/send' && (req.method === 'POST' || req.method === 'PUT')) {
        let parsed
        try {
          parsed = JSON.parse(await readBody(req))
        } catch {
          sendJson(res, 400, { error: 'invalid-json' })
          return
        }
        const raw = parsed?.text
        const text = typeof raw === 'string' ? raw.trim() : ''
        if (text === '') {
          sendJson(res, 400, { error: 'empty' })
          return
        }
        if (text.length > SEND_MAX_CHARS) {
          sendJson(res, 400, { error: 'too-long', max: SEND_MAX_CHARS })
          return
        }
        // 能力位先查一次：宿主没装配 sessionController 就明确 503，
        // 不要让调用方以为"消息发出去了"。
        const cap = deps.sendCapability?.()
        if (cap !== undefined && cap !== null && cap.available !== true) {
          sendJson(res, 503, { error: 'unavailable', reason: cap.reason ?? null })
          return
        }
        try {
          const result = await deps.onSend(text, parsed?.sessionId)
          sendJson(res, 200, { ok: true, sessionId: result?.sessionId ?? null })
        } catch (error) {
          const code = error?.code
          if (code === 'no-session') sendJson(res, 409, { error: 'no-session' })
          else if (code === 'unavailable') {
            sendJson(res, 503, { error: 'unavailable', reason: error?.message ?? null })
          } else {
            logger?.warn?.(`zhuang-fangyi-pet: 发送失败（${error?.message ?? error}）`)
            sendJson(res, 502, { error: 'send-failed', message: String(error?.message ?? error) })
          }
        }
        return
      }

      // ── 画廊（契约 §3）：清单里的全部气泡，供「表情包…」主动浏览 ──────
      if (route === '/gallery' && req.method === 'GET') {
        try {
          const items = deps.gallery?.() ?? []
          sendJson(res, 200, { items })
        } catch (error) {
          sendJson(res, 500, { error: 'gallery-failed', message: String(error?.message ?? error) })
        }
        return
      }
      // ── 番茄钟（契约 §3 新增）─────────────────────────────────────────
      //
      // 为什么单独一条路由而不是复用 `/pet/command`：命令通道是
      // **fire-and-forget 的字符串**（`{command}` → `{result}`），没有返回值语义，
      // 而番茄钟的每个动作都要回一个**新状态**给 exe 立刻重绘（按了开始要马上
      // 看到倒计时在跑）。走 command 的话 exe 得再拉一次 `/pet/state`，多一跳。
      //
      // GET  = 取当前块（exe 首帧/轮询兜底用）
      // POST = 动作（start/pause/toggle/skip/reset）
      if (route === '/pomodoro') {
        if (deps.pomodoro === undefined || deps.pomodoro === null) {
          sendJson(res, 503, { error: 'unavailable', reason: '宿主未装配番茄钟' })
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, { pomodoro: deps.pomodoro.snapshot() })
          return
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          let parsed
          try {
            parsed = JSON.parse(await readBody(req))
          } catch {
            sendJson(res, 400, { error: 'invalid json' })
            return
          }
          const action = String(parsed?.action ?? '')
          // ⚠️ **白名单**：动作名直接映射到番茄钟方法，绝不能把用户串
          // 透传到内部（那等于给了一个任意方法调用入口）。
          const ALLOWED = ['start', 'pause', 'toggle', 'skip', 'reset']
          if (!ALLOWED.includes(action)) {
            sendJson(res, 400, { error: 'bad action', allowed: ALLOWED })
            return
          }
          const result = deps.pomodoro.control(action)
          if (result === null) {
            sendJson(res, 400, { error: 'bad action', allowed: ALLOWED })
            return
          }
          sendJson(res, 200, { ok: true, action, result, pomodoro: deps.pomodoro.snapshot() })
          return
        }
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }

      // ── 聊天（契约 §3 新增）───────────────────────────────────────────
      //
      // `GET  /pet/chat`  → 状态（会话 id / 人设 / 工作区 / 计数）
      // `POST /pet/chat`  → 发一条消息（body `{text}`）
      // `GET  /pet/personas` → 人设列表
      // `POST /pet/personas` → 切换人设（body `{name}`）
      //
      // 为什么聊天不复用 `/pet/send`：`/pet/send` 是"发到**某个已有**会话"
      //（用户从列表里挑一个），而聊天是"发到**我们自己的**会话" ——
      // 它会按需创建工作区与会话，语义完全不同。
      if (route === '/chat') {
        if (deps.chat === undefined || deps.chat === null) {
          sendJson(res, 503, { error: 'unavailable', reason: '宿主未装配聊天' })
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, deps.chat.status())
          return
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          let parsed
          try {
            parsed = JSON.parse(await readBody(req))
          } catch {
            sendJson(res, 400, { error: 'invalid json' })
            return
          }
          try {
            const result = await deps.chat.send(parsed?.text)
            sendJson(res, 200, { ok: true, sessionId: result?.sessionId ?? null })
          } catch (error) {
            const code = error?.code
            if (code === 'empty') sendJson(res, 400, { error: 'empty' })
            else if (code === 'too-long') sendJson(res, 400, { error: 'too-long', max: SEND_MAX_CHARS })
            else if (code === 'no-session') sendJson(res, 409, { error: 'no-session', message: String(error?.message ?? error) })
            else if (code === 'unavailable') sendJson(res, 503, { error: 'unavailable', reason: String(error?.message ?? error) })
            else {
              logger?.warn?.(`zhuang-fangyi-pet: 聊天发送失败（${error?.message ?? error}）`)
              sendJson(res, 502, { error: 'send-failed', message: String(error?.message ?? error) })
            }
          }
          return
        }
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }

      if (route === '/personas') {
        if (deps.personas === undefined || deps.personas === null) {
          sendJson(res, 503, { error: 'unavailable', reason: '宿主未装配人设' })
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, deps.personas.list())
          return
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          let parsed
          try {
            parsed = JSON.parse(await readBody(req))
          } catch {
            sendJson(res, 400, { error: 'invalid json' })
            return
          }
          // ⚠️ `select` 是**异步**的：换人设可能要把 section 挂到活着的聊天
          // 会话上（resolveAgent 是异步的）。漏 await 的话 result 永远是
          // Promise，`result.ok !== true` 恒成立 → 切换永远 400。
          const result = await deps.personas.select(String(parsed?.name ?? ''))
          if (result.ok !== true) {
            // 400 而不是 500：名字不在列表里是**调用方的错**，不是内部故障。
            sendJson(res, 400, { error: result.reason ?? 'bad persona', allowed: result.allowed ?? [] })
            return
          }
          sendJson(res, 200, result)
          return
        }
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }

      // ── 动态语音：状态与探测（契约 §3 新增）───────────────────────────
      //
      // `GET  /pet/speech`        → 状态（开关/地址/已缓存几条/最近一条）
      // `POST /pet/speech/probe`  → 真去合成一句并播放（设置页"试一句"）
      //
      // ⚠️ **必须排在下面的 `/speech/<name>` 前缀分支之前** ——
      // 否则 `/speech/probe` 会先被当成"要取名为 probe 的语音"，
      // 结果是 404，而且看起来像"服务没起"（其实是路由顺序错了）。
      //
      // 探测为什么必须有：合成服务是**独立进程**，用户看不出它起没起；
      // 而"开了开关却没声音"是最难自查的状态。探测把原因直接写出来。
      if (route === '/speech') {
        if (deps.speech === undefined || deps.speech === null) {
          sendJson(res, 503, { error: 'unavailable', reason: '宿主未装配动态语音' })
          return
        }
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        sendJson(res, 200, deps.speech.status())
        return
      }
      if (route === '/speech/probe') {
        if (deps.speech === undefined || deps.speech === null) {
          sendJson(res, 503, { error: 'unavailable', reason: '宿主未装配动态语音' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const r = await deps.speech.probe()
        sendJson(res, 200, r)
        return
      }

      // ── 合成服务进程控制（"常驻"开关的手动入口）─────────────────────────
      //
      // `POST /pet/speech/service {action:'start'|'stop'|'status'}`
      //
      // 为什么需要手动入口：常驻模式决定的是"要不要一直占着显存"，
      // 用户应该能**立刻**要它起来或释放，而不是等空闲超时。
      //
      // ⚠️ 动作走**白名单**（与番茄钟/互动同一纪律：绝不把用户串透传到内部）。
      // ⚠️ 这个分支必须排在 `/speech/<name>` 之前 —— 否则 `service` 会被
      // 当成"要取名为 service 的语音"（与 `/speech/probe` 同一个坑）。
      if (route === '/speech/service') {
        if (deps.speech === undefined || deps.speech === null ||
            typeof deps.speech.service !== 'function') {
          sendJson(res, 503, { error: 'unavailable', reason: '宿主未装配服务监管' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        let parsed
        try {
          parsed = JSON.parse(await readBody(req))
        } catch {
          sendJson(res, 400, { error: 'invalid json' })
          return
        }
        const action = String(parsed?.action ?? '')
        if (action !== 'start' && action !== 'stop' && action !== 'status') {
          sendJson(res, 400, { error: 'bad action', allowed: ['start', 'stop', 'status'] })
          return
        }
        const result = await deps.speech.service(action)
        sendJson(res, 200, result)
        return
      }

      // ── 动态语音字节（契约 §3 新增）───────────────────────────────────
      //
      // `GET /pet/speech/<name>` → audio/wav
      //
      // 与 `/pet/voice/<name>` 同一纪律：名字走**白名单**（这里是 16 位十六
      // 进制缓存键），绝不把用户串拼进路径。语音由 host 合成后落在
      // `$DSH_HOME/zhuang-fangyi-pet/speech/`。
      if (route.startsWith('/speech/')) {
        if (deps.speech === undefined || deps.speech === null) {
          sendJson(res, 503, { error: 'unavailable', reason: '宿主未装配动态语音' })
          return
        }
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const name = route.slice('/speech/'.length)
        const hit = deps.speech.read(name)
        if (hit === null) {
          sendJson(res, 404, { error: 'no-such-speech' })
          return
        }
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': String(hit.length),
          // 合成结果按文本哈希命名 → 内容永不变 → 可长缓存。
          'cache-control': 'private, max-age=86400',
          'x-content-type-options': 'nosniff'
        })
        res.end(hit)
        return
      }

      // ── 记忆（契约 §3 新增）───────────────────────────────────────────
      //
      // `GET  /pet/memory` → 记忆全文（设置页要显示/编辑它）
      // `POST /pet/memory {text}` → 整体替换（用户手编）
      //
      // ⚠️ 替换是**整体**语义（不是追加）：设置页给的是一个文本框，
      // 用户按保存就该看到自己写的那份。追加语义会让"删掉一行"变成不可能。
      if (route === '/memory') {
        if (deps.memory === undefined || deps.memory === null) {
          sendJson(res, 503, { error: 'unavailable', reason: '宿主未装配记忆' })
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, deps.memory.get())
          return
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          let parsed
          try {
            parsed = JSON.parse(await readBody(req))
          } catch {
            sendJson(res, 400, { error: 'invalid json' })
            return
          }
          if (typeof parsed?.text !== 'string') {
            sendJson(res, 400, { error: 'text must be a string' })
            return
          }
          const result = deps.memory.set(parsed.text)
          if (result.ok !== true) {
            sendJson(res, 500, { error: result.reason ?? 'write-failed' })
            return
          }
          sendJson(res, 200, result)
          return
        }
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }

      // ── 互动（契约 §3 新增）───────────────────────────────────────────
      //
      // `GET  /pet/interact` → 可用动作 + 当前好感度（exe 右键菜单据此建菜单）
      // `POST /pet/interact {kind}` → 记一次互动，返回新好感度
      //
      // ⚠️ 动作名走**白名单**（`INTERACT_KINDS`），与番茄钟同一纪律：
      // 绝不把用户串透传到内部。
      if (route === '/interact') {
        if (deps.interact === undefined || deps.interact === null) {
          sendJson(res, 503, { error: 'unavailable', reason: '宿主未装配互动' })
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, deps.interact.list())
          return
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          let parsed
          try {
            parsed = JSON.parse(await readBody(req))
          } catch {
            sendJson(res, 400, { error: 'invalid json' })
            return
          }
          const kind = String(parsed?.kind ?? '')
          // ⚠️ 白名单校验在**路由层**做（不只依赖 `do()` 返回 null）：
          // 动作串绝不允许到达内部。`__proto__`/`toString` 这类原型链名字
          // 尤其危险 —— 回退验证实测：只在 `do()` 里挡是不够的，
          // 因为那时串已经进了内部，任何一层"顺手查表"都可能踩到原型。
          if (!Array.isArray(deps.interact.kinds) ||
              !deps.interact.kinds.includes(kind)) {
            sendJson(res, 400, {
              error: 'bad kind',
              allowed: deps.interact.kinds ?? []
            })
            return
          }
          /**
           * v10：长按级数（1..3）。**在路由层就夹**，理由与动作白名单相同 ——
           * 跨进程信任边界，exe 侧夹过一次不代表这里可以信。
           *
           * ⚠️ 用 `Number.isFinite` 而不是 `|| 1`：后者会把 0 也当成"没传"
           * （而 0 与 NaN 都该归到第 1 级，这是对的），但也会把字符串 `'2'`
           * 悄悄转成数字放行 —— 这里显式只认数字。
           */
          const rawLevel = parsed?.level
          const level = Number.isFinite(Number(rawLevel)) && rawLevel !== null && rawLevel !== ''
            ? Math.min(3, Math.max(1, Math.trunc(Number(rawLevel))))
            : 1
          const result = deps.interact.do(kind, level)
          if (result === null || result.ok !== true) {
            sendJson(res, 400, {
              error: 'bad kind',
              allowed: result?.allowed ?? []
            })
            return
          }
          sendJson(res, 200, result)
          return
        }
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }

      // ── 成长与今日统计（v10，additive）────────────────────────────────
      //
      // `GET /pet/growth` → 好感度 + 成长 + 今日统计（exe 的右键菜单与诊断用）。
      //
      // 为什么单独一个端点而不是塞进 `/pet/state`：快照是**每帧广播**的，
      // 而成长数据（连续天数、里程碑、7 天趋势）变化很慢 —— 塞进快照等于
      // 每次状态变化都重算一遍 `recentDays`。菜单打开时才拉一次更合适。
      //
      // ⚠️ 数据仍然**同时**在快照里（`growth` / `today` 块）—— 那是给
      // overlay 与设置页用的，它们没有令牌、拉不了这个端点之外的东西。
      if (route === '/growth' && req.method === 'GET') {
        if (deps.growth === undefined || deps.growth === null) {
          sendJson(res, 503, { error: 'unavailable', reason: '宿主未装配成长' })
          return
        }
        sendJson(res, 200, deps.growth.snapshot())
        return
      }

      // ── 语音（契约 §3 新增）───────────────────────────────────────────
      //
      // `GET /pet/voice/<name>` → 播放用的 mp3 字节。
      //
      // ⚠️ **运行时绝不合成**：实测 GPT-SoVITS 冷启动 30.6 秒、热态 5 秒/句，
      // 而桌宠要在一秒内回应点击 —— 运行时合成等于"按了没反应"。
      // 台词是封闭集合，构建期已压成 mp3（见 `tools/build-voice.ps1`），
      // 这里只做一件事：**查白名单，把文件流出去**。
      //
      // 白名单而非拼路径：`resolveVoice()` 只从清单里查表，路径不参与拼接；
      // 清单里没有的 name 一律 404。比素材路由更严（那边还有 `../` 要挡）。
      if (route.startsWith('/voice/') && req.method === 'GET') {
        let name
        try {
          name = decodeURIComponent(route.slice('/voice/'.length))
        } catch {
          sendJson(res, 400, { error: 'bad encoding' })
          return
        }
        const abs = deps.resolveVoice?.(name)
        if (abs === null || abs === undefined) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        let stat
        try {
          stat = fs.statSync(abs)
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        if (!stat.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        res.writeHead(200, {
          'content-type': 'audio/mpeg',
          'content-length': stat.size,
          // 文件名随内容变化（重建语音包会换文件），可以长缓存。
          'cache-control': 'public, max-age=604800, immutable'
        })
        fs.createReadStream(abs).pipe(res)
        return
      }

      // ── 语音清单（`GET /pet/voices`）─────────────────────────────────
      //
      // exe 启动时拉一次，知道"有哪些台词、多长、对应哪个事件"。
      // 清单本身不含文件内容，很小（~2KB）。
      if (route === '/voices' && req.method === 'GET') {
        sendJson(res, 200, deps.voiceManifest?.() ?? { count: 0, lines: [] })
        return
      }

      // ── 命令 ────────────────────────────────────────────────────────────
      if (route === '/command' && (req.method === 'POST' || req.method === 'PUT')) {
        let parsed
        try {
          parsed = JSON.parse(await readBody(req))
        } catch {
          sendJson(res, 400, { error: 'invalid json' })
          return
        }
        const command = String(parsed?.command ?? '')
        if (command === '') {
          sendJson(res, 400, { error: 'missing command' })
          return
        }
        const result = deps.onCommand(command)
        sendJson(res, 200, { ok: true, command, result: result ?? null })
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 路由失败（${error?.message ?? error}）`)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.end()
    }
  }
}

export { resolveArt, artForState, path }
