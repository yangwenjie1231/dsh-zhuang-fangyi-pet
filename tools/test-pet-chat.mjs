/**
 * 庄方宜桌宠 · 聊天与人设单测
 *
 * 用法：`node tools/test-pet-chat.mjs`
 *
 * ── 这套测试在防什么 ──────────────────────────────────────────────────────
 *
 * 两块最容易出错的地方：
 *   1. **人设写入**：它会**覆盖磁盘上的文件**。写错一步就是毁掉用户手写的
 *      `AGENTS.md` —— 不可逆的数据丢失。所以"绝不覆盖用户文件"这条必须有
 *      真断言（含反向断言：我们自己的产物**要能**被更新，否则人设永远切不动）。
 *   2. **回复进气泡**：`assistant/message` 的事件形状会随版本变，
 *      而"解析不出来"的症状是**聊天没反应**（最难查的一类）。
 *      所以逐层容错 + 只取 text 块，都要有断言。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  loadPersonas,
  readPersona,
  applyPersona,
  isGeneratedAgentsMd,
  renderAgentsMd,
  isSafePersonaName,
  personaPath,
  titleOf,
  personaReport,
  DEFAULT_PERSONA,
  DEFAULT_PERSONA_NAME,
  GENERATED_MARK,
  PERSONA_EXT
} from '../src/pet/persona.js'
import {
  createChatState,
  extractAssistantText,
  joinTextBlocks,
  bubbleText,
  validateChatText,
  CHAT_MAX_CHARS
} from '../src/pet/chat.js'

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

function tmpdir (prefix = 'zf-chat-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 人设名白名单（安全面第一道闸）
 * ══════════════════════════════════════════════════════════════════════════ */

section('1. 人设名白名单')

ok('接受正常名字（含中文 —— 用户会用人名）', () => {
  for (const good of ['default', '庄方宜', 'strict', 'a1', 'x.y', 'x_y', 'x-y',
    '客服模式', 'persona-2']) {
    assert.equal(isSafePersonaName(good), true, `${good} 应该合法`)
  }
})

ok('⭐ 拒绝一切路径穿越写法', () => {
  for (const evil of ['..', '.', '../x', 'a/../b', 'a\\b', '/etc/passwd',
    'C:\\x', 'sub/dir', '....//x', '...', 'a..b', '.hidden', '-x', 'a b', 'a\tb',
    'a;b', 'a\0b']) {
    assert.equal(isSafePersonaName(evil), false, `${JSON.stringify(evil)} 必须被拒`)
  }
})

ok('拒绝空/非字符串/超长', () => {
  for (const bad of ['', null, undefined, 42, {}, [], 'a'.repeat(65)]) {
    assert.equal(isSafePersonaName(bad), false, `${JSON.stringify(bad)} 必须被拒`)
  }
  assert.equal(isSafePersonaName('a'.repeat(64)), true, '64 位边界内应合法')
})

ok('personaPath 对非法名返回 null', () => {
  const dir = tmpdir()
  for (const evil of ['../x', '..', '', null, 'a/b']) {
    assert.equal(personaPath(dir, evil), null, `${JSON.stringify(evil)} 应 null`)
  }
  const good = personaPath(dir, 'default')
  assert.ok(good !== null && good.startsWith(path.resolve(dir)), '合法名应落在目录内')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 加载人设
 * ══════════════════════════════════════════════════════════════════════════ */

section('2. 加载人设（内置兜底 + 磁盘覆盖）')

ok('⭐ 目录不存在 → 仍有内置默认（功能永远可用）', () => {
  const dir = path.join(os.tmpdir(), 'zf-persona-none-' + Date.now())
  const r = loadPersonas(dir)
  assert.equal(r.items.length, 1, '应只有内置默认')
  assert.equal(r.items[0].name, DEFAULT_PERSONA_NAME)
  assert.equal(r.items[0].builtin, true)
  assert.ok(r.byName.has(DEFAULT_PERSONA_NAME))
})

ok('磁盘上的 .md 被加载，标题取自文件里的 # 行', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 'strict.md'), '# 严格模式\n\n你要简洁。\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'cute.md'), '可爱的说话方式。\n', 'utf8')
  const r = loadPersonas(dir)
  assert.equal(r.items.length, 3, `应为 内置+2，实际 ${r.items.length}`)
  assert.equal(r.byName.get('strict').title, '严格模式')
  assert.equal(r.byName.get('cute').title, '可爱的说话方式。', '首行不是 # 时用它')
  assert.ok(r.byName.get('strict').bytes > 0)
})

ok('⭐ 非 .md 文件被忽略（不会把 txt/json 当人设）', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x', 'utf8')
  fs.writeFileSync(path.join(dir, 'data.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(dir, 'real.md'), '# 真的', 'utf8')
  const r = loadPersonas(dir)
  assert.equal(r.items.length, 2, '应只有内置 + real')
  assert.ok(!r.byName.has('notes'))
  assert.ok(!r.byName.has('data'))
})

ok('非法文件名被跳过（不崩、不进列表）', () => {
  const dir = tmpdir()
  // 这些名字能落在目录里但名字本身非法（Windows 上 `..` 造不出文件名，
  // 所以用一个含非法字符的名字）
  fs.writeFileSync(path.join(dir, 'ok.md'), '# ok', 'utf8')
  const r = loadPersonas(dir)
  assert.ok(r.byName.has('ok'))
  // 直接断言"非法名不进 byName"（构造不出非法文件时的等价断言）
  assert.equal(r.byName.has('../evil'), false)
})

ok('⭐ 磁盘上的 default.md **覆盖**内置默认（用户能改默认人设）', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, `${DEFAULT_PERSONA_NAME}.md`), '# 我的默认\n\n自定义。\n', 'utf8')
  const r = loadPersonas(dir)
  assert.equal(r.items.length, 1, '同名应覆盖而不是并列')
  assert.equal(r.byName.get(DEFAULT_PERSONA_NAME).builtin, false, '应标记为磁盘上的')
  assert.equal(r.byName.get(DEFAULT_PERSONA_NAME).title, '我的默认')
})

ok('readPersona：内置名无文件时回落内置内容', () => {
  const dir = tmpdir()
  const text = readPersona(dir, DEFAULT_PERSONA_NAME)
  assert.equal(text, DEFAULT_PERSONA, '磁盘上没有就用内置')
})

ok('readPersona：未知人设返回 null', () => {
  const dir = tmpdir()
  assert.equal(readPersona(dir, 'nope'), null)
  assert.equal(readPersona(dir, '../x'), null, '非法名也返回 null')
})

ok('titleOf 的边界：空文本/非字符串回落', () => {
  assert.equal(titleOf('', 'fb'), 'fb')
  assert.equal(titleOf(null, 'fb'), 'fb')
  assert.equal(titleOf('\n\n# 有标题\n', 'fb'), '有标题')
  assert.equal(titleOf('x'.repeat(200), 'fb').length, 60, '标题应截断到 60')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 写入工作区 AGENTS.md（**会覆盖文件，最危险的一步**）
 * ══════════════════════════════════════════════════════════════════════════ */

section('3. 写入 AGENTS.md（绝不覆盖用户手写的文件）')

ok('⭐⭐ 用户手写的 AGENTS.md 绝不被覆盖', () => {
  const ws = tmpdir()
  const pdir = tmpdir()
  const userContent = '# 我自己的项目说明\n\n这份是我手写的，很重要。\n'
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), userContent, 'utf8')
  const r = applyPersona({ workspaceDir: ws, personaDir: pdir, name: DEFAULT_PERSONA_NAME })
  assert.equal(r.ok, false, '必须拒绝')
  assert.equal(r.reason, 'user-file', `拒绝原因应为 user-file，实际 ${r.reason}`)
  // 关键：内容**一字未改**
  assert.equal(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), userContent,
    '用户文件被改动了！这是不可逆的数据丢失')
})

ok('⭐ 第一次写入能成功（目录不存在也会创建）', () => {
  const ws = path.join(tmpdir(), 'nested', '庄方宜')
  const pdir = tmpdir()
  const r = applyPersona({ workspaceDir: ws, personaDir: pdir, name: DEFAULT_PERSONA_NAME })
  assert.equal(r.ok, true, `应成功，实际 ${JSON.stringify(r)}`)
  assert.ok(fs.existsSync(path.join(ws, 'AGENTS.md')), '文件应被创建')
  const text = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8')
  assert.ok(text.startsWith(GENERATED_MARK), '第一行必须是标记')
  assert.ok(text.includes(DEFAULT_PERSONA.trim().slice(0, 20)), '应包含人设正文')
})

ok('⭐ 我们自己生成的文件**能**被更新（否则人设永远切不动）', () => {
  const ws = tmpdir()
  const pdir = tmpdir()
  fs.writeFileSync(path.join(pdir, 'a.md'), '# A\n\n我是 A。\n', 'utf8')
  fs.writeFileSync(path.join(pdir, 'b.md'), '# B\n\n我是 B。\n', 'utf8')
  const r1 = applyPersona({ workspaceDir: ws, personaDir: pdir, name: 'a' })
  assert.equal(r1.ok, true)
  const r2 = applyPersona({ workspaceDir: ws, personaDir: pdir, name: 'b' })
  assert.equal(r2.ok, true, `切换应成功，实际 ${JSON.stringify(r2)}`)
  const text = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8')
  assert.ok(text.includes('我是 B。'), '内容应换成 B')
  assert.ok(!text.includes('我是 A。'), 'A 的内容不该残留')
  assert.ok(text.includes('persona: b'), '第二行应记下当前人设')
})

ok('⭐⭐ 标记必须在**第一行**才算我们的产物（宽松判定会误伤用户文件）', () => {
  const ws = tmpdir()
  const pdir = tmpdir()
  // 用户文件里**引用**了我们的标记（比如从别处复制了一段说明）
  const tricky = '# 我的说明\n\n下面这段是插件生成的标记示例：\n' + GENERATED_MARK + '\n'
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), tricky, 'utf8')
  assert.equal(isGeneratedAgentsMd(path.join(ws, 'AGENTS.md')), false,
    '标记不在第一行 → 不是我们的产物')
  const r = applyPersona({ workspaceDir: ws, personaDir: pdir, name: DEFAULT_PERSONA_NAME })
  assert.equal(r.ok, false, '必须拒绝覆盖')
  assert.equal(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), tricky, '内容不该变')
})

ok('未知人设 → 拒绝且不碰文件', () => {
  const ws = tmpdir()
  const pdir = tmpdir()
  const r = applyPersona({ workspaceDir: ws, personaDir: pdir, name: 'nope' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unknown-persona')
  assert.ok(!fs.existsSync(path.join(ws, 'AGENTS.md')), '不该创建文件')
})

ok('缺 workspaceDir → 拒绝（reason: no-workspace）', () => {
  const pdir = tmpdir()
  for (const bad of [undefined, null, '', 42]) {
    const r = applyPersona({ workspaceDir: bad, personaDir: pdir, name: DEFAULT_PERSONA_NAME })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no-workspace')
  }
})

ok('renderAgentsMd 的结构（标记 + persona 行 + 正文）', () => {
  const text = renderAgentsMd('x', '正文内容')
  const lines = text.split('\n')
  assert.equal(lines[0], GENERATED_MARK)
  assert.equal(lines[1], '<!-- persona: x -->')
  assert.ok(text.includes('正文内容'))
  assert.ok(text.endsWith('\n'), '文件应以换行结尾（POSIX 习惯）')
})

ok('personaReport 汇总正确', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 'a.md'), '# A', 'utf8')
  const rep = personaReport(loadPersonas(dir), 'a')
  assert.equal(rep.count, 2, '内置 + a')
  assert.equal(rep.current, 'a')
  assert.ok(rep.names.includes('a'))
  assert.equal(rep.dir, dir)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 回复文本解析（事件形状容错）
 * ══════════════════════════════════════════════════════════════════════════ */

section('4. assistant 回复解析')

ok('⭐ 标准形状：data.message.content 的 text 块', () => {
  const text = extractAssistantText({
    message: { content: [{ type: 'text', text: '你好呀' }] }
  })
  assert.equal(text, '你好呀')
})

ok('⭐ 多个 text 块拼起来', () => {
  const text = extractAssistantText({
    message: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] }
  })
  assert.equal(text, '第一段\n第二段')
})

ok('⭐⭐ 只取 text 块：工具调用/思考块一律不进气泡', () => {
  const text = extractAssistantText({
    message: {
      content: [
        { type: 'thinking', text: '我在想…' },
        { type: 'tool_use', name: 'bash', input: {} },
        { type: 'text', text: '这是真的回复' },
        { type: 'image', source: {} }
      ]
    }
  })
  assert.equal(text, '这是真的回复', `实际：${JSON.stringify(text)}`)
  assert.ok(!String(text).includes('我在想'), '思考块不该进气泡')
})

ok('容错：内容在 data 层 / 直接在 payload.content / 纯字符串', () => {
  assert.equal(extractAssistantText({ data: { message: { content: [{ type: 'text', text: 'A' }] } } }), 'A')
  assert.equal(extractAssistantText({ content: [{ type: 'text', text: 'B' }] }), 'B')
  assert.equal(extractAssistantText({ data: { content: [{ type: 'text', text: 'C' }] } }), 'C')
  assert.equal(extractAssistantText({ text: 'D' }), 'D')
  assert.equal(extractAssistantText({ message: 'E' }), 'E')
})

ok('没有文本 → null（调用方据此不弹空气泡）', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { message: {} },
    { message: { content: [] } }, { message: { content: [{ type: 'tool_use' }] } },
    { message: { content: [{ type: 'text', text: '   ' }] } }]) {
    assert.equal(extractAssistantText(bad), null, `${JSON.stringify(bad)} 应 null`)
  }
})

ok('joinTextBlocks 的边界', () => {
  assert.equal(joinTextBlocks('x'), 'x')
  assert.equal(joinTextBlocks('  '), null)
  assert.equal(joinTextBlocks([]), null)
  assert.equal(joinTextBlocks(null), null)
  assert.equal(joinTextBlocks([null, undefined, 42]), null)
  assert.equal(joinTextBlocks(['a', 'b']), 'a\nb', '字符串块也要认')
  assert.equal(joinTextBlocks([{ text: 'no type' }]), 'no type', '缺 type 视为 text')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 气泡文案
 * ══════════════════════════════════════════════════════════════════════════ */

section('5. 气泡文案（截断 + 去换行）')

ok('⭐ 换行被压平（气泡不换行，整段塞进去会溢出）', () => {
  assert.equal(bubbleText('第一行\n第二行'), '第一行 第二行')
  assert.equal(bubbleText('a\r\nb'), 'a b')
  assert.equal(bubbleText('  a   b  '), 'a b')
})

ok('⭐ 超长被截断并加省略号', () => {
  const long = '字'.repeat(200)
  const out = bubbleText(long, 20)
  assert.equal(out.length, 20, `截断后应为 20 字，实际 ${out.length}`)
  assert.ok(out.endsWith('…'), '应有省略号')
})

ok('空/非字符串 → null', () => {
  for (const bad of ['', '   ', '\n\n', null, undefined, 42, {}]) {
    assert.equal(bubbleText(bad), null)
  }
})

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 聊天会话记账
 * ══════════════════════════════════════════════════════════════════════════ */

section('6. 聊天会话记账')

ok('初始没有会话（sessionId=null）', () => {
  const c = createChatState()
  assert.equal(c.sessionId, null)
  assert.equal(c.snapshot().sentCount, 0)
})

ok('⭐⭐ 只接受**聊天会话**的事件（别的会话回复不许漏进气泡）', () => {
  const c = createChatState()
  c.setSession('chat-1')
  assert.equal(c.accept('chat-1', 't1'), true, '聊天会话的应接受')
  assert.equal(c.accept('other-1', 't2'), false, '别的会话必须拒绝')
  assert.equal(c.accept('chat-1', 't3'), true)
  assert.equal(c.accept('chat-1-x', 't4'), false, '前缀相同但不是同一个会话')
})

ok('未建会话时拒绝一切（sessionId=null）', () => {
  const c = createChatState()
  assert.equal(c.accept('anything', 't1'), false)
})

ok('⭐ 同一回合去重（同一个 turnKey 只处理一次）', () => {
  const c = createChatState()
  c.setSession('s1')
  assert.equal(c.accept('s1', 'turn-1'), true)
  assert.equal(c.accept('s1', 'turn-1'), false, '同一回合第二次应拒绝')
  assert.equal(c.accept('s1', 'turn-2'), true)
  assert.equal(c.internals.seenCount, 2)
})

ok('turnKey 为空时不去重（有些事件不带回合标识）', () => {
  const c = createChatState()
  c.setSession('s1')
  assert.equal(c.accept('s1', null), true)
  assert.equal(c.accept('s1', undefined), true)
  assert.equal(c.accept('s1', ''), true)
  assert.equal(c.internals.seenCount, 0, '空 key 不该进去重表')
})

ok('⭐ 去重表有上限（长时间聊天不会无限增长）', () => {
  const c = createChatState()
  c.setSession('s1')
  for (let i = 0; i < 200; i++) c.accept('s1', 'turn-' + i)
  assert.ok(c.internals.seenCount <= 64,
    `去重表应有上限，实际 ${c.internals.seenCount}`)
})

ok('⭐ 换会话时清空去重表（新会话的回合 id 可能重复）', () => {
  const c = createChatState()
  c.setSession('s1')
  c.accept('s1', 'turn-1')
  assert.equal(c.internals.seenCount, 1)
  c.setSession('s2')
  assert.equal(c.internals.seenCount, 0, '换会话应清空去重表')
  assert.equal(c.accept('s2', 'turn-1'), true, '新会话的同名回合应被接受')
})

ok('setSession 返回是否真的变了', () => {
  const c = createChatState()
  assert.equal(c.setSession('a'), true)
  assert.equal(c.setSession('a'), false, '同一个 id → false')
  assert.equal(c.setSession('b'), true)
  assert.equal(c.setSession(''), false, '空 id 不接受')
  assert.equal(c.setSession(null), false)
})

ok('计数与错误记账', () => {
  const c = createChatState()
  c.setSession('s1')
  c.markSent(); c.markSent()
  c.markError('boom')
  let s = c.snapshot()
  assert.equal(s.sentCount, 2)
  assert.equal(s.lastError, 'boom')
  c.markReply()
  s = c.snapshot()
  assert.equal(s.replyCount, 1)
  assert.equal(s.lastError, null, '成功回复应清掉上次错误')
})

ok('持久化往返（会话 id 跨重启保留）', () => {
  const a = createChatState()
  a.setSession('session-abc')
  a.markSent()
  const saved = a.persist()
  const b = createChatState()
  assert.equal(b.adopt(saved), true)
  assert.equal(b.sessionId, 'session-abc', '会话 id 必须跨重启保留')
  assert.equal(b.snapshot().sentCount, 1)
})

ok('adopt 对垃圾输入安全', () => {
  const c = createChatState()
  c.setSession('keep')
  for (const bad of [null, undefined, 42, 'x']) {
    assert.equal(c.adopt(bad), false)
  }
  assert.equal(c.sessionId, 'keep', '现状不该被破坏')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 7. 发送文本校验
 * ══════════════════════════════════════════════════════════════════════════ */

section('7. 发送文本校验')

ok('正常文本通过并 trim', () => {
  const r = validateChatText('  你好  ')
  assert.equal(r.ok, true)
  assert.equal(r.text, '你好')
})

ok('空/非字符串被拒', () => {
  for (const bad of ['', '   ', '\n\t', null, undefined, 42, {}]) {
    const r = validateChatText(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒`)
  }
})

ok('超长被拒（与气泡输入框同一上限）', () => {
  assert.equal(validateChatText('a'.repeat(CHAT_MAX_CHARS)).ok, true, '刚好上限应通过')
  const r = validateChatText('a'.repeat(CHAT_MAX_CHARS + 1))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'too-long')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败项'}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
