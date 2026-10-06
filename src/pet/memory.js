/**
 * 庄方宜桌宠 · 跨会话记忆（**不同会话共享**）
 *
 * ── 用户要的是什么 ────────────────────────────────────────────────────────
 *
 * "不同会话能共享 memory"。
 *
 * 聊天会话本身的历史由 DSH 管（同一个 sessionId 就能接着聊），
 * 但只要开一个新会话，之前聊过的内容就"失忆"了。所以需要一份
 * **独立于任何会话**的记忆文件：所有聊天会话都往里读、往里写。
 *
 * ── 机制 ──────────────────────────────────────────────────────────────────
 *
 *   · 存储：`$DSH_HOME/zhuang-fangyi-pet/memory.md` —— 一个纯文本文件，
 *     用户随时可以自己打开编辑（它就是普通 markdown）。
 *   · 注入：作为系统提示词的一个 section（`zf-pet:memory`）挂到聊天会话上 ——
 *     和人设同一条路（见 `index.js` 的 `applyChatPersona`），只在聊天生效。
 *   · 写入：两条路。
 *       1. 用户手写/设置页编辑（POST /pet/memory）；
 *       2. **自动提炼**：每次收到聊天回复后，用宿主的 `ctx.llm` 把
 *          "这轮对话里值得长期记住的事"提炼成几行追加进去
 *          （设置 `memoryAuto`，默认开）。
 *   · 容量：文件超上限时**裁掉最旧的行** —— 记忆是滚动的，不是无底洞。
 *
 * ── 纯函数与 IO 的边界 ─────────────────────────────────────────────────────
 *
 * 提炼 prompt 的拼装、LLM 输出的解析、追加时的容量裁剪都是**纯函数**
 * （可单测）；文件读写与 LLM 调用留给 `index.js` 装配层。
 *
 * @module src/pet/memory.js
 */

import fs from 'node:fs'
import path from 'node:path'

/** 记忆文件名（相对 dataDir）。 */
export const MEMORY_FILE_NAME = 'memory.md'

/** 记忆文件默认容量上限（字节）。超过就裁最旧的行。 */
export const MEMORY_CAP_BYTES = 24 * 1024

/** 单条记忆的最大长度（字符）。超长的提炼结果按条截断。 */
export const MEMORY_LINE_MAX_CHARS = 200

/** 记忆条数的软上限（裁剪时按行数兜底）。 */
export const MEMORY_MAX_LINES = 200

/**
 * 记忆文件的头（写空文件时带上，给用户看格式）。
 */
export const MEMORY_HEADER = [
  '<!-- 庄方宜的长期记忆：所有聊天会话共享。 -->',
  '<!-- 每行一条（"- 2026-01-01 事实"）。可以在设置里编辑，也可以直接改这个文件。 -->',
  '<!-- 文件超过容量上限时，最旧的行会被裁掉。 -->',
  ''
].join('\n')

/**
 * 本地日期键（`YYYY-MM-DD`）。记忆条目前缀用它 —— 用户感知的"哪天"是本地日期。
 *
 * @param {number} at - epoch ms
 * @returns {string}
 */
export function memoryDayKey (at) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return 'unknown'
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 拼装"从这轮对话提炼记忆"的 LLM 提示词。
 *
 * ⚠️ 提炼的对象是**这一轮**（用户说了什么 + 她答了什么），不是整段历史 ——
 * 每轮全量提炼既贵又会重复。已有记忆由注入的 section 提供（模型自己能看到），
 * 这里只问"有什么**新的**值得记"。
 *
 * @param {string} userText - 用户这轮说的话
 * @param {string} replyText - 庄方宜这轮的回复
 * @returns {string}
 */
export function memoryExtractionPrompt (userText, replyText) {
  const u = String(userText ?? '').slice(0, 1000)
  const r = String(replyText ?? '').slice(0, 1000)
  return [
    '下面是庄方宜与用户的一轮对话。请从中提炼 0 到 3 条值得**长期记住**的事实，',
    '例如：用户的称呼与偏好、正在进行的项目、重要的决定、明确的约定。',
    '不要记：寒暄、情绪表达、一次性的问题、庄方宜人设里已有的设定。',
    '每条一行，以 "- " 开头；一条都提炼不出来就只输出 NONE，不要解释。',
    '',
    '【用户】' + u,
    '【庄方宜】' + r
  ].join('\n')
}

/**
 * 从 LLM 输出里解析记忆条目。
 *
 * 规则：
 *   · 取 `- ` 开头的行（模型被要求这么输出）；
 *   · 去掉空行/序号行/解释行；
 *   · 整体输出 `NONE`（或只含 NONE）→ 没有新记忆；
 *   · 每条截断到 `MEMORY_LINE_MAX_CHARS`，最多 3 条（提炼提示词说了 0~3 条，
 *     这里兜住模型不听话的情况）。
 *
 * @param {string} llmText
 * @returns {string[]} 记忆条目（可能为空数组）
 */
export function parseMemoryFacts (llmText) {
  if (typeof llmText !== 'string') return []
  const lines = llmText.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l !== '')
  // 整体只输出 NONE（大小写/句号容忍）→ 没有新记忆
  if (lines.length > 0 && lines.every(l => /^none[。.!！]?$/i.test(l))) return []
  const facts = []
  for (const line of lines) {
    let m = line.match(/^[-*•]\s+(.+)$/)
    if (m === null) {
      // 模型偶尔忘了加 "- "。这时**不能靠长度猜**（"用户叫小明"只有 5 个字，
      // 但它是好记忆）—— 靠**形状**：解释性句子几乎都以冒号结尾、
      // 或以"好的/以下/没有/以上/总结"开头。这两条挡掉就够。
      if (/[：:]$/.test(line)) continue
      if (/^(好的|以下|以上|没有|总结|解释|说明|无|共)/.test(line)) continue
      m = [line, line]
    }
    let fact = m[1].trim()
    if (fact === '') continue
    if (/^none[。.!！]?$/i.test(fact)) continue
    // 太短的多半是"好的""嗯"这类应答，不是事实（2 字以内直接丢）。
    if (fact.length <= 2) continue
    if (fact.length > MEMORY_LINE_MAX_CHARS) fact = fact.slice(0, MEMORY_LINE_MAX_CHARS - 1) + '…'
    facts.push(fact)
    if (facts.length >= 3) break
  }
  return facts
}

/**
 * 追加记忆并做容量裁剪（**纯字符串运算**，不碰文件）。
 *
 * @param {string} current - 现有记忆文件内容（'' = 空文件）
 * @param {string[]} facts - 新记忆条目
 * @param {number} at - epoch ms（条目日期前缀用）
 * @param {object} [opts]
 * @param {number} [opts.capBytes]
 * @returns {string} 新的文件内容
 */
export function mergeMemory (current, facts, at, opts = {}) {
  const cap = Number.isFinite(opts.capBytes) ? opts.capBytes : MEMORY_CAP_BYTES
  if (!Array.isArray(facts) || facts.length === 0) return current ?? ''
  const day = memoryDayKey(at)
  const added = facts.map(f => `- ${day} ${f}`)
  let base = current ?? ''
  if (base.trim() === '') base = MEMORY_HEADER
  let lines = base.split(/\r?\n/)
  const headerLines = []
  while (lines.length > 0) {
    const l = lines[0]
    if (l.trim() === '' || l.trim().startsWith('<!--')) {
      headerLines.push(lines.shift())
      continue
    }
    break
  }
  lines = lines.filter(l => l.trim() !== '')
  lines.push(...added)
  // 容量裁剪：从**最旧**（最前）的行开始丢，直到字节数达标或只剩本次新增。
  let out = ''
  const render = ls => [...headerLines, ...ls].join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
  for (;;) {
    out = render(lines)
    const bytes = Buffer.byteLength(out, 'utf8')
    if (bytes <= cap || lines.length <= added.length) break
    lines.shift()
    // 行数软上限：内容太老就别无限堆积
    if (lines.length > MEMORY_MAX_LINES) lines = lines.slice(-MEMORY_MAX_LINES)
  }
  return out
}

/**
 * 读记忆文件（**绝不抛**：缺失/读失败 → null）。
 *
 * @param {string} dataDir
 * @returns {string|null}
 */
export function readMemoryFile (dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, MEMORY_FILE_NAME), 'utf8')
  } catch {
    return null
  }
}

/**
 * 写记忆文件（原子写：临时文件 + rename，与 JsonStore 同一做法）。
 * 返回是否成功；失败由调用方记日志（写不进不该影响聊天）。
 *
 * @param {string} dataDir
 * @param {string} text
 * @returns {boolean}
 */
export function writeMemoryFile (dataDir, text) {
  try {
    const file = path.join(dataDir, MEMORY_FILE_NAME)
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 确保记忆文件存在（不存在就建一个带头注释的空文件，用户才知道去哪看）。
 * 返回当前内容（'' = 新建）。
 *
 * @param {string} dataDir
 * @returns {string}
 */
export function ensureMemoryFile (dataDir) {
  const existing = readMemoryFile(dataDir)
  if (existing !== null) return existing
  writeMemoryFile(dataDir, MEMORY_HEADER)
  return MEMORY_HEADER
}
