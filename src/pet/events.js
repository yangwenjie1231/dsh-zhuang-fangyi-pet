/**
 * 庄方宜桌宠 · 宿主事件 → 状态机信封
 *
 * ── 为什么要有这一层 ──────────────────────────────────────────────────────
 *
 * `state.js` 只认**扁平的、与 DSH 无关的**信封（`{type, sessionId, …}`）。
 * 这个文件是唯一的翻译点，好处有两个：
 *
 *   1. `state.js` 可以被穷举单测，不需要伪造 DSH 的 `Agent`/`Session` 对象；
 *   2. DSH 事件签名变了只改这一个文件 —— 而且**翻译函数是纯的**，同样可单测。
 *
 * ── 所有事件签名都是本机实测核实过的（不是推测）──────────────────────────
 *
 *   'agent/status'       (this: Scoped<Agent>, payload: { agent, status: 'idle'|'running' })
 *   'agent/error'        (this: Scoped<Agent>, payload: { agent, turn, step, error })
 *   'session/event'      (this: Scoped<Session>, session: Session, event: SessionEvent)
 *   'api-session/status' (sessionId: SessionId, running: boolean)          ← 非 scoped
 *   'api-session/error'  (sessionId: SessionId, message: string)           ← 非 scoped
 *   'api-session/removed'(sessionId: SessionId)                            ← 非 scoped
 *
 * ── 根 Context 能收到全部 scoped 事件（关键，已从源码核实）────────────────
 *
 * `@deepseek-ai/dsh-scope` 的 `scopeTarget` 过滤器里：
 *
 *     const tag = scopeOf(ctx)
 *     if (tag === void 0) return true      // ← 根监听者无 tag，一律放行
 *
 * 所以宿主在**根 Context** 上 `ctx.on('agent/status', …)` 就能收到**所有**会话的事件，
 * 不需要按会话逐个 `retain()`。这直接消掉了 `桌宠开发文档.md` §2.2 担心的
 * 引用计数泄漏（`retain()` 忘 `release()` 会阻止会话卸载）—— 本插件压根不用 `retain`。
 *
 * 作用域语义是「事件沿父链向上流动，绝不向下」：agent 作用域的监听者只收到那一个 agent，
 * 根监听者收到全部。我们要的正是后者。
 *
 * @module src/pet/events.js
 */

/**
 * `session/event` 里我们关心的事件类型 → 信封类型。
 *
 * 其余类型（`assistant/chunk`、`tool/call` 之外的一大堆）**故意不映射**：
 * 桌宠是表现层，读得越少越稳、越不涉隐私。
 *
 * ⚠️ `assistant/message` **故意不在这个集合里**：它带**消息正文**，
 * 而 `state.js` 的红线是"绝不读正文"（`桌宠开发文档.md` §十）。
 * 聊天要正文，所以走**单独的回调**（`bridgeHostEvents` 的 `onChatMessage`），
 * 由 `index.js` 决定只对**聊天会话**生效 —— 两条通道，互不污染。
 */
const SESSION_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'tool/call',
  'tool/result',
  'user/message',
  'approval/asked',
  'approval/decided'
])

/** 从一个可能是 `Agent`/`Session`/字符串的入参里取出会话 id。 */
export function sessionIdOf (value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    // Agent 是 `{ id: SessionId }`；Session 也以 `id` 暴露身份。
    if (typeof value.id === 'string') return value.id
    if (typeof value.sessionId === 'string') return value.sessionId
  }
  return undefined
}

/** 工具调用 id：`CallId` 是 branded string，但也容忍数字。 */
function callIdOf (value) {
  if (value === null || value === undefined) return undefined
  return String(value)
}

/**
 * 把 `session/event` 的载荷翻译成信封。
 *
 * `SessionEvent` 的形状是 `{ type, data, seq, time }`，其中 `data` 是
 * `SessionEventMap[type]`。这里**只碰元数据，绝不碰消息正文** ——
 * 这是 `桌宠开发文档.md` §十 的红线（隐私 + DOM/格式易碎）。
 *
 * @param {object} session - 事件里的 `session`
 * @param {object} event - 事件里的 `event`
 * @returns {object|null} 信封；不关心的事件返回 null
 */
export function fromSessionEvent (session, event) {
  if (event === null || typeof event !== 'object') return null
  const type = String(event.type ?? '')
  if (!SESSION_EVENT_TYPES.has(type)) return null
  const sessionId = sessionIdOf(session)
  const data = event.data ?? {}

  switch (type) {
    case 'turn/start':
      // 新回合开始：等同于「跑起来了」，顺便清掉错误闩锁。
      return { type: 'step/start', sessionId }

    case 'turn/end':
      return {
        type: 'turn/end',
        sessionId,
        reason: data.reason,
        // `error` 原因里带结构化 `LlmFailure`；只取人类可读的 message，不深挖。
        message: data.reason?.error?.message
      }

    case 'step/start':
      return { type: 'step/start', sessionId }

    case 'step/end':
      // 步骤结束不代表回 idle（可能还有下一步）；不改状态，只算一次活动。
      return { type: 'tick', sessionId }

    case 'tool/call':
      return { type: 'tool/call', sessionId, callId: callIdOf(data.callId), name: data.name }

    case 'tool/result':
      return {
        type: 'tool/result',
        sessionId,
        // 契约上 `tool/result` 没有 callId（只有 turn/step），所以按「移除一个」处理。
        // `state.js` 对缺 callId 的情况有保守分支，不会把在飞计数算成负数。
        callId: undefined,
        isError: data.error !== undefined && data.error !== null
      }

    case 'user/message':
      // 用户消息 = 桌宠该有反应。**不读 content。**
      return { type: 'inbox/inserted', sessionId }

    case 'approval/asked':
      return { type: 'approval/asked', sessionId }

    case 'approval/decided':
      return { type: 'approval/decided', sessionId }

    default:
      return null
  }
}

/** `agent/status` → 信封。 */
export function fromAgentStatus (payload) {
  if (payload === null || typeof payload !== 'object') return null
  return {
    type: 'agent/status',
    sessionId: sessionIdOf(payload.agent),
    status: payload.status === 'running' ? 'running' : 'idle'
  }
}

/** `agent/error` → 信封。 */
export function fromAgentError (payload) {
  if (payload === null || typeof payload !== 'object') return null
  return {
    type: 'agent/error',
    sessionId: sessionIdOf(payload.agent),
    message: messageOf(payload.error)
  }
}

/** 从任意 error 值里取一条短消息；绝不抛错、绝不把整棵对象塞进快照。 */
export function messageOf (error) {
  if (error === null || error === undefined) return undefined
  if (typeof error === 'string') return error.slice(0, 200)
  if (typeof error === 'object') {
    const m = error.message ?? error.reason
    if (typeof m === 'string') return m.slice(0, 200)
  }
  return undefined
}

/**
 * 把宿主 ctx 接上状态机。
 *
 * 每个 `ctx.on` 都单独 try/catch：**某个事件名在旧版本不存在时不该让整个插件瘫掉**
 * （`ctx.on` 对未声明事件的行为不保证）。这与主题插件「一个可选装饰位冲突不该
 * 让整个 `apply()` 中断」的教训是同一个道理。
 *
 * @param {object} ctx - cordis Context
 * @param {object} machine - `createPetState()` 的产物
 * @param {object} [logger]
 * @param {object} [opts]
 * @param {(sessionId: string, payload: object) => void} [opts.onChatMessage]
 *   **聊天正文通道**：`session/event` 里的 `assistant/message` 原样交给它。
 *   与状态机通道**分开**，因为状态机红线是不读正文；由调用方决定只对聊天会话生效。
 * @returns {() => void} 取消全部监听
 */
export function bridgeHostEvents (ctx, machine, logger = console, opts = {}) {
  const disposers = []
  const onChatMessage = typeof opts.onChatMessage === 'function' ? opts.onChatMessage : null

  const wire = (name, handler) => {
    try {
      const off = ctx.on(name, handler)
      if (typeof off === 'function') disposers.push(off)
      else disposers.push(() => {})
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 事件 ${name} 订阅失败（已跳过）：${error?.message ?? error}`)
      disposers.push(() => {})
    }
  }

  const feed = envelope => {
    if (envelope === null) return
    try {
      machine.apply(envelope)
    } catch (error) {
      logger.warn?.(`zhuang-fangyi-pet: 状态机处理失败（已忽略）：${error?.message ?? error}`)
    }
  }

  // ── scoped 事件：根监听者收全部（见文件头说明）──────────────────────────
  wire('agent/status', payload => feed(fromAgentStatus(payload)))
  wire('agent/error', payload => feed(fromAgentError(payload)))
  wire('session/event', (session, event) => {
    // ⭐ 聊天正文通道（**独立于状态机**）。
    //
    // 这里踩过一个真实的坑：原先用 `ctx.on('assistant/message', …)` 订阅，
    // 而 `assistant/message` 是 **SessionEventMap 里的事件**（经 `session/event`
    // 派发），**cordis 上没有同名事件** —— 于是订阅永远不触发，
    // 用户看到的现象是"气泡只提示已发送，回复从不出现"，而且**没有任何报错**
    //（`ctx.on` 对未知事件名不抛）。
    if (onChatMessage !== null && event !== null && typeof event === 'object' &&
        event.type === 'assistant/message') {
      try {
        onChatMessage(sessionIdOf(session), event)
      } catch (error) {
        logger.warn?.(`zhuang-fangyi-pet: 聊天正文回调失败（已忽略）：${error?.message ?? error}`)
      }
    }
    feed(fromSessionEvent(session, event))
  })

  // ── 非 scoped 事件：直接拿 sessionId ───────────────────────────────────
  wire('api-session/status', (sessionId, running) => {
    feed({ type: 'agent/status', sessionId: sessionIdOf(sessionId), status: running === true ? 'running' : 'idle' })
  })
  wire('api-session/error', (sessionId, message) => {
    feed({ type: 'agent/error', sessionId: sessionIdOf(sessionId), message: messageOf(message) })
  })
  wire('api-session/removed', sessionId => {
    feed({ type: 'session/gone', sessionId: sessionIdOf(sessionId) })
  })

  return () => {
    for (const off of disposers) {
      try {
        off()
      } catch { /* 已卸载 */ }
    }
    disposers.length = 0
  }
}