/**
 * 庄方宜桌宠 · SSE 推送 hub
 *
 * ── 为什么是 SSE 而不是 WebSocket ─────────────────────────────────────────
 *
 * 本 profile 里已有**已验证的先例** `dsh-our-free-model/src/push.js`：
 * 一条挂住的 `text/event-stream` 响应 + 注释心跳 + close 清理。`webServer` 明确
 * 允许 handler 挂住响应，其 gzip 层也跳过事件流，不需要任何特例。
 *
 * 状态推送是**单向**的（宿主 → 桌宠），所以 SSE 完全够用，且比 WebSocket 省事：
 *   · 不需要 `registerUpgrade`（exact path、重复即抛、未匹配直接 destroy socket）；
 *   · 不需要引 `ws` 包，C# 侧也不需要 `ClientWebSocket`（少一个 Facades 引用坑）；
 *   · 断线重连语义由浏览器/C# 侧自己实现即可。
 *
 * 上行只有两个极小的 POST（位置、命令），用普通 HTTP 就行。
 *
 * ── 语义：快照，不是队列 ─────────────────────────────────────────────────
 *
 * 事件是**fire-and-forget 的快照**。中途连上的客户端从 `hello` 那一帧就知道
 * 全部现状，不需要回放历史 —— 这让 hub 保持无状态（照抄 push.js 的取舍）。
 *
 * @module src/pet/hub.js
 */

/** 心跳间隔。25s 与 push.js 一致：足够短以击穿常见的空闲超时。 */
export const HEARTBEAT_MS = 25000

/**
 * 创建一个 hub。
 *
 * @param {object} [options]
 * @param {object} [options.logger]
 * @param {number} [options.heartbeatMs]
 * @returns {object}
 */
export function createHub (options = {}) {
  const logger = options.logger ?? console
  const heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : HEARTBEAT_MS

  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set()
  let heartbeat = null
  let lastSnapshot = null
  let disposed = false

  function startHeartbeat () {
    if (heartbeat !== null || clients.size === 0) return
    heartbeat = setInterval(() => {
      for (const res of clients) {
        if (res.writableEnded === true || res.destroyed === true) {
          clients.delete(res)
          continue
        }
        try {
          // 注释帧：不触发事件，只为保活。
          res.write(': ping\n\n')
        } catch {
          clients.delete(res)
        }
      }
      if (clients.size === 0) stopHeartbeat()
    }, heartbeatMs)
    // 不阻止进程退出：宿主该退就退，别被一个心跳定时器吊住。
    heartbeat.unref?.()
  }

  function stopHeartbeat () {
    if (heartbeat === null) return
    clearInterval(heartbeat)
    heartbeat = null
  }

  /** 写一个 SSE 帧。`data` 必须是**单行** JSON（契约 §2）。 */
  function writeFrame (res, event, data) {
    if (res.writableEnded === true || res.destroyed === true) {
      clients.delete(res)
      return false
    }
    try {
      const payload = JSON.stringify(data ?? {})
      // 防御：JSON.stringify 不会产生裸换行，但万一上游塞了含 \n 的字符串，
      // 这里会破坏「空行 = 帧结束」的解析。显式挡一下。
      const safe = payload.replace(/[\r\n]+/g, ' ')
      res.write(`event: ${event}\ndata: ${safe}\n\n`)
      return true
    } catch (error) {
      clients.delete(res)
      logger.debug?.(`zhuang-fangyi-pet hub: 丢弃一个客户端（${error?.message ?? error}）`)
      return false
    }
  }

  return {
    /** 当前挂着的客户端数（诊断用）。 */
    get size () {
      return clients.size
    },

    /** 最近一次广播的快照（新客户端连上时立刻发它）。 */
    get last () {
      return lastSnapshot
    },

    /**
     * 收养一个请求为事件流。
     *
     * **调用方必须已经通过信任围栏与令牌校验** —— hub 不做鉴权。
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    attach (req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      })
      res.write(': connected\n\n')
      // 建议重连间隔：断线后 3s 再试（C# 侧也读这一行，但自己有退避）。
      res.write('retry: 3000\n\n')
      // 连上立刻给一帧全量现状：新客户端不需要回放历史。
      if (lastSnapshot !== null) writeFrame(res, 'hello', lastSnapshot)
      else res.write('event: hello\ndata: {}\n\n')

      clients.add(res)
      startHeartbeat()

      const drop = () => {
        clients.delete(res)
        if (clients.size === 0) stopHeartbeat()
      }
      req.on('close', drop)
      res.on('close', drop)
      res.on('error', drop)
    },

    /** 广播一份快照；同时记为 `last` 供后续客户端 `hello` 使用。 */
    broadcast (snapshot) {
      if (disposed) return
      lastSnapshot = snapshot
      for (const res of [...clients]) writeFrame(res, 'state', snapshot)
    },

    /**
     * 关闭全部流。
     *
     * 由 fiber 的 disposer 调用：**热重载或卸载绝不能留下半开的响应**
     * （否则浏览器/桌宠会挂在那里等一个永远不来的帧）。
     */
    dispose () {
      disposed = true
      for (const res of [...clients]) {
        try {
          res.end()
        } catch { /* 已经没了 */ }
      }
      clients.clear()
      stopHeartbeat()
    }
  }
}