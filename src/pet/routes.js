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
 * @param {(command: string) => object} deps.onCommand - 命令处理
 * @param {() => object} deps.getSettings - 取当前设置
 * @param {(next: object) => object} deps.setSettings - 覆盖设置（归一化后返回）
 * @param {() => object|undefined} deps.connection - 取 `connection` 服务
 * @param {object} [deps.logger]
 * @returns {(req, res) => Promise<void>}
 */
export function createHandler (deps) {
  const logger = deps.logger ?? console

  const sendJson = (res, code, body) => {
    const text = JSON.stringify(body)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text)
    })
    res.end(text)
  }

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
          diag: deps.diagnostics?.() ?? null
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
          'content-type': 'image/png',
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
