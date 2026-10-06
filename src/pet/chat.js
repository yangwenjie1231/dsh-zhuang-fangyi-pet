/**
 * 庄方宜桌宠 · 聊天（**专用工作区 + 专用会话**）
 *
 * ── 用户的原话 ────────────────────────────────────────────────────────────
 *
 * "可以与桌宠聊天" + "新建一个工作区（就叫庄方宜），由 DSH 的 AI 回答，
 *  人设那些信息，我晚点发给你。注意，人设、性格要作为可调的。"
 *
 * 所以聊天**不是**另起一套 LLM 调用，而是：
 *   1. 建一个专用工作区（默认 `~/Downloads/庄方宜`，可设置）；
 *   2. 把人设同步进它的 `AGENTS.md`（见 `persona.js`）；
 *   3. 在里面建一个专用会话，往里 `prompt()`；
 *   4. 听 `assistant/message` 事件，把回复文本送回桌宠气泡。
 *
 * ── 为什么复用真实会话而不是 `ctx.llm.stream()` ────────────────────────────
 *
 * `ctx.llm.stream()` 更轻（无会话、无 token 记账），但它**不读 `AGENTS.md`** ——
 * 人设得自己拼进 system，而用户明确要求"人设作为可调的"（他有很多套提示词）。
 * 走真实会话 + `AGENTS.md` 就把"切换人设"变成了"换个文件"，
 * 而且用户能在 DSH 界面里看到这段对话、接着聊、翻历史 —— 那才是"聊天"。
 *
 * ── 本模块的边界（重要）───────────────────────────────────────────────────
 *
 * 它**不做 IO、不碰 ctx**：只负责"会话 id 的记账"与"事件 → 回复文本"的解析。
 * 真正的 `create`/`prompt` 调用在 `index.js`（那里才有 `ctx.sessionController`）。
 * 这样这部分逻辑能被单测覆盖，而服务调用留在装配层。
 *
 * @module src/pet/chat.js
 */

/** 默认工作区目录名（放在用户下载目录下，用户一眼能找到）。 */
export const DEFAULT_WORKSPACE_NAME = '庄方宜'

/** 一次聊天消息的长度上限（与气泡输入框一致）。 */
export const CHAT_MAX_CHARS = 2000

/**
 * 从 `assistant/message` 事件里抽出**纯文本**。
 *
 * 事件形状（`dsh-session` 实测）大致是：
 *   `{ type: 'assistant/message', data: { message: { content: [{type:'text',text:'...'}] } } }`
 * 但不同版本可能把内容放在不同层，所以这里**容错地**逐层找：
 * 只要能找到 text 块就拼起来。
 *
 * ⚠️ **只取 text 块**：工具调用、思考块、图片块都不该进气泡
 *（气泡只有一行，塞进去全是乱码）。
 *
 * @param {object} payload - 事件 data（或整个事件）
 * @returns {string|null} 纯文本；没有文本返回 null
 */
export function extractAssistantText (payload) {
  if (payload === null || typeof payload !== 'object') return null
  // 逐层下钻找到那个"有 content 数组"的对象。
  const candidates = [
    payload?.message?.content,
    payload?.content,
    payload?.data?.message?.content,
    payload?.data?.content,
    payload?.message
  ]
  for (const c of candidates) {
    const text = joinTextBlocks(c)
    if (text !== null && text !== '') return text
  }
  // 有些版本直接把整条消息放成字符串。
  if (typeof payload?.text === 'string' && payload.text.trim() !== '') return payload.text.trim()
  if (typeof payload?.message === 'string' && payload.message.trim() !== '') return payload.message.trim()
  return null
}

/**
 * 把 content 数组（或单个块 / 字符串）拼成纯文本。
 *
 * @param {unknown} content
 * @returns {string|null}
 */
export function joinTextBlocks (content) {
  if (typeof content === 'string') {
    const t = content.trim()
    return t === '' ? null : t
  }
  if (!Array.isArray(content)) return null
  const parts = []
  for (const block of content) {
    if (block === null || typeof block === 'undefined') continue
    if (typeof block === 'string') {
      const t = block.trim()
      if (t !== '') parts.push(t)
      continue
    }
    if (typeof block !== 'object') continue
    // **只取 text 类型**：`tool_use`/`thinking`/`image` 一律跳过。
    const type = typeof block.type === 'string' ? block.type : ''
    if (type !== '' && type !== 'text') continue
    const t = typeof block.text === 'string' ? block.text : null
    if (t !== null && t.trim() !== '') parts.push(t.trim())
  }
  if (parts.length === 0) return null
  return parts.join('\n')
}

/**
 * 回复文本 → 气泡文案（**截断**）。
 *
 * 气泡只有一行、宽度固定，整段回复塞进去会溢出来。所以：
 *   · 去掉换行（气泡不换行）；
 *   · 超过 `max` 个字符就截断并加省略号；
 *   · 空文本返回 null（调用方据此不弹气泡 —— 弹一个空气泡很怪）。
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string|null}
 */
export function bubbleText (text, max = 120) {
  if (typeof text !== 'string') return null
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return null
  if (flat.length <= max) return flat
  return flat.slice(0, max - 1) + '…'
}

/**
 * 聊天会话记账（**纯状态**，不含任何服务调用）。
 *
 * 职责：
 *   · 记住"聊天会话是哪个 id"（跨重启持久化）；
 *   · 判断"这个事件是不是我们那条会话的"（否则别的会话的回复会漏进气泡）；
 *   · 防止同一回合重复投递（`turnId` 去重）。
 */
export function createChatState (options = {}) {
  /** 聊天专用会话 id（null = 还没建）。 */
  let sessionId = null
  /** 已处理过的回复回合（去重；只留最近若干条，避免无限增长）。 */
  const seen = new Set()
  const seenOrder = []
  const MAX_SEEN = 64
  /** 统计（诊断用）。 */
  let sentCount = 0
  let replyCount = 0
  let lastError = null

  const adopt = saved => {
    if (saved === null || typeof saved !== 'object') return false
    if (typeof saved.sessionId === 'string' && saved.sessionId !== '') {
      sessionId = saved.sessionId
    }
    if (Number.isFinite(Number(saved.sentCount))) sentCount = Math.max(0, Math.trunc(Number(saved.sentCount)))
    if (Number.isFinite(Number(saved.replyCount))) replyCount = Math.max(0, Math.trunc(Number(saved.replyCount)))
    return true
  }

  return {
    adopt,

    /** 当前聊天会话 id（null = 未建）。 */
    get sessionId () {
      return sessionId
    },

    /** 记住（新建或采纳）的会话 id。 */
    setSession (id) {
      if (typeof id !== 'string' || id === '') return false
      if (id === sessionId) return false
      sessionId = id
      // 换了会话 → 去重表要清（新会话的回合 id 可能重复）
      seen.clear()
      seenOrder.length = 0
      return true
    },

    /** 记一次"用户发了消息"。 */
    markSent () {
      sentCount += 1
    },

    /** 记一次错误（诊断用；下次成功会清掉）。 */
    markError (message) {
      lastError = message === null || message === undefined ? null : String(message)
    },

    /**
     * 判断一个事件是否属于聊天会话，并且是**新的一条回复**。
     *
     * @param {string} eventSessionId - 事件带的 sessionId
     * @param {string} turnKey - 回合标识（用于去重；null = 不去重）
     * @returns {boolean} true = 应该处理
     */
    accept (eventSessionId, turnKey) {
      if (sessionId === null) return false
      if (eventSessionId !== sessionId) return false
      if (turnKey === null || turnKey === undefined || turnKey === '') return true
      const key = String(turnKey)
      if (seen.has(key)) return false
      seen.add(key)
      seenOrder.push(key)
      // 环形裁剪：只留最近 MAX_SEEN 条
      while (seenOrder.length > MAX_SEEN) {
        const old = seenOrder.shift()
        seen.delete(old)
      }
      return true
    },

    /** 记一次成功投递的回复。 */
    markReply () {
      replyCount += 1
      lastError = null
    },

    /** 快照（给路由/诊断）。 */
    snapshot () {
      return {
        sessionId,
        sentCount,
        replyCount,
        lastError,
        /** 去重表里记了多少回合（诊断：异常增长说明去重没生效）。 */
        seenCount: seen.size
      }
    },

    /** 持久化用。 */
    persist () {
      return { sessionId, sentCount, replyCount, savedAt: Date.now() }
    },

    /** 供测试读内部。 */
    internals: {
      get sessionId () { return sessionId },
      get sentCount () { return sentCount },
      get replyCount () { return replyCount },
      get seenCount () { return seen.size }
    }
  }
}

/**
 * 校验一条待发送的聊天文本。
 *
 * @param {unknown} raw
 * @returns {{ok: true, text: string}|{ok: false, reason: string}}
 */
export function validateChatText (raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-string' }
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'empty' }
  if (text.length > CHAT_MAX_CHARS) return { ok: false, reason: 'too-long' }
  return { ok: true, text }
}
