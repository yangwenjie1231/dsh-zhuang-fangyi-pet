/**
 * 庄方宜桌宠 · 长期记忆单测（跨会话共享）
 *
 * 用法：`node tools/test-pet-memory.mjs`
 *
 * ── 这套测试在防什么 ──────────────────────────────────────────────────────
 *
 * 记忆是**模型自动写进磁盘的东西**，所以两类风险：
 *   1. **写入污染**：模型输出不可控 —— 它可能回一句解释、可能回 NONE、
 *      可能一次吐 10 条。`parseMemoryFacts` 必须把这些都收拾干净，
 *      否则记忆文件里会混进"好的，我提炼了以下事实："这种垃圾。
 *   2. **无限增长**：记忆会被注入到每一次请求的系统提示词里，
 *      不裁剪的话它迟早撑爆上下文（而且每次调用都在为它付 token）。
 *      `mergeMemory` 的容量裁剪必须真的生效，且**保住最新的**。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  memoryExtractionPrompt,
  parseMemoryFacts,
  mergeMemory,
  memoryDayKey,
  readMemoryFile,
  writeMemoryFile,
  ensureMemoryFile,
  MEMORY_HEADER,
  MEMORY_CAP_BYTES,
  MEMORY_LINE_MAX_CHARS
} from '../src/pet/memory.js'

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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zf-memory-'))

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 提炼提示词
 * ══════════════════════════════════════════════════════════════════════════ */

section('1. 提炼提示词')

ok('提示词包含双方发言，且明确要求 0~3 条 / 无则 NONE', () => {
  const p = memoryExtractionPrompt('我叫小明', '记住了，小明。')
  assert.ok(p.includes('我叫小明'), '应含用户发言')
  assert.ok(p.includes('记住了，小明。'), '应含她的回复')
  assert.ok(p.includes('0 到 3 条'), '应限定条数')
  assert.ok(p.includes('NONE'), '应给出"没有"的约定输出')
})

ok('⭐ 超长输入被截断（记忆提炼不该把整段长文塞进 prompt）', () => {
  const long = 'x'.repeat(5000)
  const p = memoryExtractionPrompt(long, long)
  assert.ok(p.length < 3000, `提示词应被截断，实际 ${p.length} 字`)
})

ok('非字符串输入安全（不抛）', () => {
  assert.doesNotThrow(() => memoryExtractionPrompt(null, undefined))
  assert.doesNotThrow(() => memoryExtractionPrompt(42, {}))
})

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 解析模型输出（模型输出不可控）
 * ══════════════════════════════════════════════════════════════════════════ */

section('2. 解析模型输出')

ok('标准输出：取 "- " 开头的行', () => {
  const facts = parseMemoryFacts('- 用户叫小明\n- 在做 DSH 桌宠插件\n')
  assert.deepEqual(facts, ['用户叫小明', '在做 DSH 桌宠插件'])
})

ok('⭐ NONE 表示没有新记忆（大小写/句号都容忍）', () => {
  for (const t of ['NONE', 'none', 'None.', 'NONE！', 'none\n']) {
    assert.deepEqual(parseMemoryFacts(t), [], `${JSON.stringify(t)} 应得空数组`)
  }
})

ok('⭐ 解释性文字被丢掉（模型爱说"好的，我提炼了以下事实："）', () => {
  const facts = parseMemoryFacts([
    '好的，我提炼了以下事实：',
    '- 用户叫小明',
    '以上。'
  ].join('\n'))
  assert.deepEqual(facts, ['用户叫小明'], `实际 ${JSON.stringify(facts)}`)
})

ok('⭐ 最多 3 条（模型一次吐 10 条也只收前 3）', () => {
  const many = Array.from({ length: 10 }, (_, i) => `- 事实${i}`).join('\n')
  const facts = parseMemoryFacts(many)
  assert.equal(facts.length, 3, `应截到 3 条，实际 ${facts.length}`)
  assert.deepEqual(facts, ['事实0', '事实1', '事实2'], '应取最前面的（模型按重要性排）')
})

ok('单条超长被截断', () => {
  const facts = parseMemoryFacts('- ' + 'y'.repeat(500))
  assert.equal(facts.length, 1)
  assert.ok(facts[0].length <= MEMORY_LINE_MAX_CHARS,
    `单条应截到 ${MEMORY_LINE_MAX_CHARS}，实际 ${facts[0].length}`)
  assert.ok(facts[0].endsWith('…'), '截断应有省略号')
})

ok('容错：模型忘了加 "- " 的短句也收，但排除明显是解释的', () => {
  const facts = parseMemoryFacts([
    '用户喜欢喝茶',
    '以下是我的总结：',
    '没有',
    '好的'
  ].join('\n'))
  assert.deepEqual(facts, ['用户喜欢喝茶'], `实际 ${JSON.stringify(facts)}`)
})

ok('垃圾输入安全返回空数组', () => {
  for (const bad of [null, undefined, 42, '', '   ', '\n\n']) {
    assert.deepEqual(parseMemoryFacts(bad), [], `${JSON.stringify(bad)} 应得 []`)
  }
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 合并与容量裁剪
 * ══════════════════════════════════════════════════════════════════════════ */

section('3. 合并与容量裁剪')

ok('追加到空文件：带上日期前缀', () => {
  const at = new Date(2026, 9, 6, 12).getTime()
  const out = mergeMemory('', ['用户叫小明'], at)
  assert.ok(out.includes('- 2026-10-06 用户叫小明'), `实际：${out}`)
  assert.ok(out.includes('庄方宜的长期记忆'), '应保留头注释（用户才知道这文件是什么）')
})

ok('追加到已有文件：旧内容保留、新的在后', () => {
  const base = MEMORY_HEADER + '- 2026-01-01 旧事实\n'
  const out = mergeMemory(base, ['新事实'], new Date(2026, 9, 6).getTime())
  assert.ok(out.includes('旧事实'), '旧内容不该丢')
  assert.ok(out.includes('- 2026-10-06 新事实'), '新内容应在')
  assert.ok(out.indexOf('旧事实') < out.indexOf('新事实'), '新的应在后面（时间序）')
})

ok('⭐ 超过容量上限时裁掉**最旧**的（保住最新）', () => {
  let text = MEMORY_HEADER
  const at = new Date(2026, 9, 6).getTime()
  // 塞很多旧行把文件撑到接近上限
  for (let i = 0; i < 400; i++) {
    text += `- 2026-01-01 旧记忆第 ${i} 条 ${'x'.repeat(60)}\n`
  }
  const before = Buffer.byteLength(text, 'utf8')
  assert.ok(before > MEMORY_CAP_BYTES, `测试前置：文件应已超上限（${before}）`)
  const out = mergeMemory(text, ['最新的重要事实'], at)
  const after = Buffer.byteLength(out, 'utf8')
  assert.ok(after <= MEMORY_CAP_BYTES, `裁剪后应在上限内，实际 ${after}`)
  assert.ok(out.includes('最新的重要事实'), '最新的那条**必须**保住')
  assert.ok(out.includes('庄方宜的长期记忆'), '头注释要保住（那是给用户的说明）')
})

ok('⭐ 新增内容本身超上限时也不丢（宁可超一点，也不能丢新记忆）', () => {
  const at = new Date(2026, 9, 6).getTime()
  const big = 'z'.repeat(MEMORY_LINE_MAX_CHARS)
  const out = mergeMemory('', [big, big, big], at)
  assert.ok(out.includes(big.slice(0, 50)), '新增内容必须在（哪怕它自己就超上限）')
})

ok('facts 为空/非数组 → 原样返回（不误写）', () => {
  const base = MEMORY_HEADER + '- 已有\n'
  assert.equal(mergeMemory(base, [], 0), base)
  assert.equal(mergeMemory(base, null, 0), base)
  assert.equal(mergeMemory(base, undefined, 0), base)
})

ok('多余空行被压掉（模型输出容易带一堆换行）', () => {
  const out = mergeMemory('', ['一条'], Date.now())
  assert.ok(!/\n{3,}/.test(out), '不该出现连续多个空行')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 日期键
 * ══════════════════════════════════════════════════════════════════════════ */

section('4. 日期键')

ok('本地日期（用户感知的"今天"是本地的）', () => {
  assert.equal(memoryDayKey(new Date(2026, 9, 6, 0, 30).getTime()), '2026-10-06')
  assert.equal(memoryDayKey(new Date(2026, 9, 6, 23, 30).getTime()), '2026-10-06')
  assert.equal(memoryDayKey(new Date(2026, 9, 7, 0, 30).getTime()), '2026-10-07')
  assert.equal(memoryDayKey(NaN), 'unknown')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 文件读写（真实磁盘）
 * ══════════════════════════════════════════════════════════════════════════ */

section('5. 文件读写')

ok('读写往返', () => {
  const dir = tmp()
  assert.equal(readMemoryFile(dir), null, '不存在时应返回 null（不是抛）')
  assert.equal(writeMemoryFile(dir, '内容'), true)
  assert.equal(readMemoryFile(dir), '内容')
})

ok('⭐ ensureMemoryFile：不存在就建（带说明头），已存在则原样返回', () => {
  const dir = tmp()
  const first = ensureMemoryFile(dir)
  assert.ok(first.includes('庄方宜的长期记忆'), '新建时应带头注释')
  assert.ok(fs.existsSync(path.join(dir, 'memory.md')), '文件应真的建出来')
  writeMemoryFile(dir, '用户自己写的')
  assert.equal(ensureMemoryFile(dir), '用户自己写的', '已存在时不该覆盖')
})

ok('写失败返回 false（不抛 —— 记忆写不进不该影响聊天）', () => {
  // 用一个**非法路径**制造失败：把文件路径当成目录用
  const dir = tmp()
  const blocker = path.join(dir, 'memory.md')
  fs.mkdirSync(blocker)   // 建一个**同名目录** → 写文件必然失败
  assert.equal(writeMemoryFile(dir, 'x'), false)
  assert.equal(readMemoryFile(dir), null, '读一个目录应返回 null（不是抛）')
})

ok('原子写：不留下半截文件（临时文件被 rename 掉）', () => {
  const dir = tmp()
  writeMemoryFile(dir, 'a'.repeat(1000))
  writeMemoryFile(dir, 'b'.repeat(1000))
  const leftovers = fs.readdirSync(dir).filter(f => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [], `不该留下临时文件：${JSON.stringify(leftovers)}`)
  assert.equal(readMemoryFile(dir), 'b'.repeat(1000))
})

/* ══════════════════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败项'}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
