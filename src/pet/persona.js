/**
 * 庄方宜桌宠 · 人设（**可切换**，用户点名要求）
 *
 * ── 用户的原话 ────────────────────────────────────────────────────────────
 *
 * "新建一个工作区（就叫庄方宜），由 DSH 的 AI 回答，人设那些信息，我晚点发给你。
 *  注意，人设、性格要作为可调的，因为我有好多种提示词"
 *
 * 所以核心要求不是"写死一个人设"，而是**切换机制**：
 *   · 人设是磁盘上的 md 文件（用户自己往里加）；
 *   · 切换 = 把选中那份同步到工作区的 `AGENTS.md`；
 *   · 为什么走 `AGENTS.md`：`dsh-agent-instructions` 会自动加载
 *     项目根 → cwd 的 `AGENTS.md`/`CLAUDE.md` 链（65536 字节预算），
 *     这是**上游已经做好的机制**，不自己发明一套提示词注入。
 *
 * ── 三条设计约束 ──────────────────────────────────────────────────────────
 *
 * 1. **绝不覆盖用户手写的 `AGENTS.md`**：工作区里那份是我们生成的，
 *    带一个明确的标记头；没有标记就说明是用户自己写的 → 拒绝覆盖并如实报错。
 * 2. **人设名走白名单**（`[A-Za-z0-9._-]` 且不含 `..`）：与语音名同一纪律 ——
 *    它会被拼成文件路径。
 * 3. **默认人设内置**：`personas/` 为空时也要能用（不能让"没有文件"变成
 *    "聊天功能不可用"）。内置一份写进代码，作为 `default` 提供。
 *
 * @module src/pet/persona.js
 */

import fs from 'node:fs'
import path from 'node:path'

/** 人设文件后缀。 */
export const PERSONA_EXT = '.md'

/**
 * 生成物标记（**必须存在才允许覆盖工作区的 `AGENTS.md`**）。
 *
 * 放在文件**第一行**，因为 `AGENTS.md` 会被整份读给模型 ——
 * 标记本身也是给模型看的（"这部分是桌宠插件生成的"）。
 */
export const GENERATED_MARK = '<!-- dsh-zhuang-fangyi-pet: persona (auto-generated) -->'

/** 内置默认人设（`personas/` 为空时的兜底，保证功能永远可用）。 */
export const DEFAULT_PERSONA_NAME = 'default'

export const DEFAULT_PERSONA = `你是「庄方宜」，一个住在用户桌面上的桌宠。

## 说话方式
- 简短、自然，像熟人聊天。**一次回复控制在两三句话内** —— 你的话会显示在
  一个小小的气泡里，长篇大论会溢出来。
- 不用 markdown 标题、列表、代码块。就是平常说话。
- 语气温和但有自己的判断，不谄媚、不堆砌感叹号。

## 边界
- 你是桌宠，不是万能助手：用户问的如果是正经技术问题，照常认真回答，
  但保持简短。
- 不确定的事就说不知道，不要编。
`

/**
 * 人设名是否安全（只允许 `[A-Za-z0-9._-]`，不许 `.`/`..`/`..` 子串）。
 *
 * 纯函数。**故意严格**：人设名会被拼成文件路径，放宽就是路径穿越。
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSafePersonaName (name) {
  if (typeof name !== 'string' || name === '') return false
  if (name.length > 64) return false
  if (name === '.' || name === '..') return false
  if (name.includes('..')) return false
  // 反斜杠也挡（Windows 上 `a\\b` 也是路径分隔符）。
  return /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5._-]*$/.test(name)
}

/** 人设文件绝对路径；名字非法返回 null。 */
export function personaPath (dir, name) {
  if (!isSafePersonaName(name)) return null
  const abs = path.join(dir, name + PERSONA_EXT)
  // 二次校验：解析结果必须落在目录内（纵深防御，与 voice.js 同一纪律）。
  const root = path.resolve(dir)
  const resolved = path.resolve(abs)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

/**
 * 加载全部人设（**绝不抛**：目录不存在 → 只有内置默认）。
 *
 * @param {string} dir - `personas/` 绝对路径
 * @param {object} [logger]
 * @returns {{items: object[], byName: Map<string, object>, dir: string}}
 */
export function loadPersonas (dir, logger) {
  const items = []
  const byName = new Map()

  // 内置默认永远在（哪怕磁盘上什么都没有）。
  const builtin = {
    name: DEFAULT_PERSONA_NAME,
    builtin: true,
    title: '默认（内置）',
    bytes: Buffer.byteLength(DEFAULT_PERSONA, 'utf8'),
    preview: firstLine(DEFAULT_PERSONA)
  }
  items.push(builtin)
  byName.set(builtin.name, builtin)

  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`zhuang-fangyi-pet: 人设目录读取失败（${error?.message ?? error}）`)
    }
    return { items, byName, dir }
  }

  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith(PERSONA_EXT)) continue
    const name = entry.slice(0, -PERSONA_EXT.length)
    if (!isSafePersonaName(name)) {
      logger?.warn?.(`zhuang-fangyi-pet: 人设文件名不合法（已跳过）：${entry}`)
      continue
    }
    // ⚠️ 与内置默认**同名**时，磁盘上的那份**覆盖**内置，而不是被跳过。
    //
    // 这里踩过一次：原先写的是 `if (byName.has(name)) continue`，
    // 结果 `default.md` 永远进不来（内置那份已经占了名字），
    // 用户改了默认人设却毫无效果 —— 而且没有任何报错。
    // 正确语义是"磁盘优先，内置只是兜底"。
    const existing = byName.get(name)
    if (existing !== undefined && existing.builtin !== true) continue   // 真重复才跳过
    let text = ''
    try {
      text = fs.readFileSync(path.join(dir, entry), 'utf8')
    } catch (error) {
      logger?.warn?.(`zhuang-fangyi-pet: 人设读取失败（已跳过）：${entry}（${error?.message ?? error}）`)
      continue
    }
    const rec = {
      name,
      builtin: false,
      title: titleOf(text, name),
      bytes: Buffer.byteLength(text, 'utf8'),
      preview: firstLine(text)
    }
    if (existing !== undefined && existing.builtin === true) {
      // 覆盖内置：**替换数组里那一项**（不能 push，否则列表里会出现两个同名项，
      // 用户看到重复的名字会以为其中一个坏了）。
      const idx = items.indexOf(existing)
      if (idx !== -1) items[idx] = rec
    } else {
      items.push(rec)
    }
    byName.set(name, rec)
  }
  return { items, byName, dir }
}

/** 取人设正文。**内置名回落内置内容**（磁盘上没有也能用）。 */
export function readPersona (dir, name, logger) {
  if (name === DEFAULT_PERSONA_NAME) {
    const p = personaPath(dir, name)
    if (p !== null && fs.existsSync(p)) {
      try { return fs.readFileSync(p, 'utf8') } catch { /* 回落内置 */ }
    }
    return DEFAULT_PERSONA
  }
  const p = personaPath(dir, name)
  if (p === null) return null
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (error) {
    logger?.debug?.(`zhuang-fangyi-pet: 人设读取失败：${name}（${error?.message ?? error}）`)
    return null
  }
}

/**
 * 标题：第一行 `# xxx` 里的 xxx；没有就用文件名。
 * 抽出来是为了"列表里显示的名字"与"文件里写的名字"不会两处不一致。
 */
export function titleOf (text, fallback) {
  if (typeof text !== 'string') return fallback
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const m = line.match(/^#\s+(.+)$/)
    if (m !== null) return m[1].trim().slice(0, 60)
    // 第一行不是标题就用它（截断），总比显示文件名好
    return line.slice(0, 60)
  }
  return fallback
}

/** 首行摘要（列表预览用）。 */
function firstLine (text) {
  if (typeof text !== 'string') return ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    return line.slice(0, 80)
  }
  return ''
}

/**
 * 工作区 `AGENTS.md` 是不是**我们生成的**。
 *
 * ⚠️ 这是"绝不覆盖用户手写文件"那道闸。判据是**标记必须在第一行** ——
 * 放宽成"文件里含这个字符串"的话，用户只要在文末引用一次就会被误判成
 * 我们的产物，然后被覆盖。
 *
 * @param {string} file - `AGENTS.md` 绝对路径
 * @returns {boolean}
 */
export function isGeneratedAgentsMd (file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const firstLine = text.split(/\r?\n/, 1)[0].trim()
    return firstLine === GENERATED_MARK
  } catch {
    return false   // 不存在 / 读不了 → 不是我们的产物（保守）
  }
}

/**
 * 生成要写入工作区的 `AGENTS.md` 内容。
 *
 * @param {string} personaName
 * @param {string} body - 人设正文
 * @returns {string}
 */
export function renderAgentsMd (personaName, body) {
  return [
    GENERATED_MARK,
    `<!-- persona: ${personaName} -->`,
    '<!-- 这份文件由桌宠插件生成。手动编辑会在切换人设时被覆盖； -->',
    '<!-- 想保留自己的内容，请把第一行的标记删掉（那样插件就不会再动它）。 -->',
    '',
    body.trim(),
    ''
  ].join('\n')
}

/**
 * 把选中的人设同步到工作区的 `AGENTS.md`。
 *
 * @param {object} opts
 * @param {string} opts.workspaceDir - 工作区目录（不存在会创建）
 * @param {string} opts.personaDir - `personas/` 目录
 * @param {string} opts.name - 人设名
 * @param {object} [opts.logger]
 * @returns {{ok: boolean, reason?: string, file?: string, bytes?: number, persona?: string}}
 */
export function applyPersona (opts) {
  const { workspaceDir, personaDir, name } = opts
  const logger = opts.logger
  if (typeof workspaceDir !== 'string' || workspaceDir === '') {
    return { ok: false, reason: 'no-workspace' }
  }
  const body = readPersona(personaDir, name, logger)
  if (body === null) return { ok: false, reason: 'unknown-persona' }

  const file = path.join(workspaceDir, 'AGENTS.md')
  // ⚠️ **绝不覆盖用户手写的 AGENTS.md**。没有我们的标记就是用户的文件，
  // 覆盖它等于毁掉他可能写了很久的东西。
  if (fs.existsSync(file) && !isGeneratedAgentsMd(file)) {
    return { ok: false, reason: 'user-file', file }
  }

  const content = renderAgentsMd(name, body)
  try {
    fs.mkdirSync(workspaceDir, { recursive: true })
    // 临时文件 + rename：与 JsonStore 同一做法，崩溃不会留下半截文件。
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    logger?.warn?.(`zhuang-fangyi-pet: 写入 AGENTS.md 失败（${error?.message ?? error}）`)
    return { ok: false, reason: 'write-failed', message: String(error?.message ?? error) }
  }
  return { ok: true, file, bytes: Buffer.byteLength(content, 'utf8'), persona: name }
}

/** 诊断摘要。 */
export function personaReport (personas, current) {
  return {
    count: personas?.items?.length ?? 0,
    current: current ?? null,
    names: (personas?.items ?? []).map(p => p.name),
    dir: personas?.dir ?? null
  }
}
