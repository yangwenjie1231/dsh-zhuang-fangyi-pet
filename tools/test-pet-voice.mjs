/**
 * 庄方宜桌宠 · 语音模块单测
 *
 * 用法：`node tools/test-pet-voice.mjs`
 *
 * ── 这套测试在防什么 ──────────────────────────────────────────────────────
 *
 * 语音的**安全面**比功能面更重要：`/pet/voice/<name>` 会把名字映射到磁盘文件，
 * 一个写错的映射就是一个任意文件读取漏洞。所以这里重点是白名单与路径校验，
 * 而不是"能不能播出声音"（那个自检与真机验证覆盖）。
 *
 * 另外盯住**清单与磁盘的一致性**：清单说有条目、磁盘上却没有文件，
 * 运行时表现为"某句台词永远不响"且毫无报错 —— 那是最难查的一类缺陷。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadVoice,
  isSafeName,
  resolveVoice,
  pickVoiceForEvent,
  voiceReport,
  VOICE_DIR_NAME,
  MANIFEST_NAME
} from '../src/pet/voice.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VOICE_DIR = path.join(ROOT, 'art', 'voice')

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

/** 建一个临时语音目录（测加载容错用，不碰真实产物）。 */
function makeTmpVoice (manifest, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-voice-'))
  if (manifest !== null) {
    fs.writeFileSync(path.join(dir, MANIFEST_NAME),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8')
  }
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 1))
  }
  return dir
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. isSafeName（纯函数，安全面的第一道闸）
 * ══════════════════════════════════════════════════════════════════════════ */

section('1. isSafeName（名字白名单）')

ok('接受真实用到的名字（我们自己起的那些）', () => {
  for (const good of ['click-1', 'pomodoro-focus-end', 'wake', 'done-2',
    'error-1', 'pet-head', 'chat-reply', 'a', 'A1', 'x.y', 'x_y', 'sleepy']) {
    assert.equal(isSafeName(good), true, `${good} 应该合法`)
  }
})

ok('⭐ 拒绝一切路径穿越写法', () => {
  // 这一条是安全面的核心：只要这些进不来，就没有任意文件读取。
  for (const evil of [
    '..', '.', '../index.js', '../../package.json',
    'a/../b', '..\\..\\win.ini', 'a\\b', '/etc/passwd', 'C:\\x',
    'sub/dir', 'x/../y', '....//x', '...', 'a..b', '.hidden'
  ]) {
    assert.equal(isSafeName(evil), false, `${JSON.stringify(evil)} 必须被拒`)
  }
})

ok('拒绝空 / 非字符串 / 超长', () => {
  for (const bad of ['', null, undefined, 42, {}, [], 'a'.repeat(65)]) {
    assert.equal(isSafeName(bad), false, `${JSON.stringify(bad)} 必须被拒`)
  }
  // 边界：64 位以内可以
  assert.equal(isSafeName('a'.repeat(64)), true, '64 位应合法（边界内）')
})

ok('拒绝首字符是 . 或 - 的名字（避免隐藏文件与选项注入）', () => {
  assert.equal(isSafeName('.hidden'), false)
  assert.equal(isSafeName('-rf'), false)
  assert.equal(isSafeName('_x'), false, '下划线开头也拒（不是我们起的名字形态）')
})

ok('拒绝控制字符与空白', () => {
  for (const bad of ['a b', 'a\tb', 'a\nb', 'a\0b', 'a;b', 'a|b', 'a*b', 'a?b']) {
    assert.equal(isSafeName(bad), false, `${JSON.stringify(bad)} 必须被拒`)
  }
})

/* ══════════════════════════════════════════════════════════════════════════
 * 2. loadVoice 容错（缺失不是错误）
 * ══════════════════════════════════════════════════════════════════════════ */

section('2. loadVoice 容错（语音包是可选的）')

ok('⭐ 目录不存在 → 空清单且**不抛**（没跑过构建脚本是正常情况）', () => {
  const missing = path.join(os.tmpdir(), 'zf-voice-does-not-exist-' + Date.now())
  let result
  assert.doesNotThrow(() => { result = loadVoice(missing) })
  assert.equal(result.count, 0)
  assert.equal(result.lines.length, 0)
  assert.equal(result.byName.size, 0)
})

ok('清单 JSON 坏掉 → 空清单且不抛', () => {
  const dir = makeTmpVoice('{ this is not json')
  let result
  assert.doesNotThrow(() => { result = loadVoice(dir) })
  assert.equal(result.count, 0)
})

ok('清单结构不对（无 lines / lines 不是数组）→ 空清单', () => {
  for (const bad of [{}, { lines: null }, { lines: 'x' }, { lines: 42 }, []]) {
    const dir = makeTmpVoice(bad)
    assert.equal(loadVoice(dir).count, 0, `${JSON.stringify(bad)} 应得空清单`)
  }
})

ok('⭐ 清单里的非法条目被逐条跳过（不是整份丢弃）', () => {
  const dir = makeTmpVoice({
    version: 1,
    lines: [
      { name: 'good', file: 'good.mp3', event: 'pet/click', durationMs: 100 },
      { name: '../evil', file: 'evil.mp3', event: 'pet/click' },     // name 非法
      { name: 'evil2', file: '../../x.mp3', event: 'pet/click' },    // file 非法
      { name: '', file: 'x.mp3' },                                   // 空名
      null,                                                          // 非对象
      'string',                                                      // 非对象
      { name: 'good2', file: 'good2.mp3', event: 'pet/click', durationMs: 200 }
    ]
  })
  const result = loadVoice(dir)
  assert.equal(result.count, 2, `应保留 2 条合法条目，实际 ${result.count}`)
  assert.ok(result.byName.has('good'))
  assert.ok(result.byName.has('good2'))
  assert.ok(!result.byName.has('../evil'), '非法 name 不许进白名单')
  assert.ok(!result.byName.has('evil2'), '非法 file 不许进白名单')
})

ok('⭐ 重名条目保留先到的（静默覆盖会让"改了台词没生效"很难查）', () => {
  const dir = makeTmpVoice({
    lines: [
      { name: 'dup', file: 'first.mp3', event: 'a', durationMs: 1 },
      { name: 'dup', file: 'second.mp3', event: 'b', durationMs: 2 }
    ]
  })
  const result = loadVoice(dir)
  assert.equal(result.count, 1)
  assert.equal(result.byName.get('dup').file, 'first.mp3', '应保留先出现的那条')
})

ok('超大条目被忽略（清单被改成指向巨物时不至于拖垮）', () => {
  const dir = makeTmpVoice({
    lines: [{ name: 'huge', file: 'huge.mp3', event: 'a', bytes: 99 * 1024 * 1024 }]
  })
  assert.equal(loadVoice(dir).count, 0)
})

ok('缺 durationMs / bytes 时回落 0 而不是 NaN', () => {
  const dir = makeTmpVoice({ lines: [{ name: 'x', file: 'x.mp3', event: 'e' }] })
  const rec = loadVoice(dir).byName.get('x')
  assert.equal(rec.durationMs, 0)
  assert.equal(rec.bytes, 0)
  assert.ok(Number.isFinite(rec.durationMs))
})

ok('source 非法值回落 synth（值域只有 real/synth）', () => {
  const dir = makeTmpVoice({
    lines: [
      { name: 'a', file: 'a.mp3', source: 'real' },
      { name: 'b', file: 'b.mp3', source: 'bogus' },
      { name: 'c', file: 'c.mp3' }
    ]
  })
  const m = loadVoice(dir)
  assert.equal(m.byName.get('a').source, 'real')
  assert.equal(m.byName.get('b').source, 'synth')
  assert.equal(m.byName.get('c').source, 'synth')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3. resolveVoice（白名单查表 + 二次路径校验）
 * ══════════════════════════════════════════════════════════════════════════ */

section('3. resolveVoice（白名单查表，不拼路径）')

ok('清单内的名字解析成目录内的绝对路径', () => {
  const dir = makeTmpVoice({ lines: [{ name: 'ok', file: 'ok.mp3' }] }, { 'ok.mp3': 10 })
  const m = loadVoice(dir)
  const abs = resolveVoice(dir, 'ok', m)
  assert.ok(abs !== null, '应解析出路径')
  assert.ok(abs.startsWith(path.resolve(dir)), '必须落在语音目录内')
  assert.ok(fs.existsSync(abs), '解析出的文件应真实存在')
})

ok('⭐ 清单外的名字一律 null（不拼路径，就没有穿越）', () => {
  const dir = makeTmpVoice({ lines: [{ name: 'ok', file: 'ok.mp3' }] }, { 'ok.mp3': 10 })
  const m = loadVoice(dir)
  // 注意：`'ok'` **不在这里** —— 它是清单里的合法名字，必须能解析出来
  //（下一节有正向断言）。把合法值混进"必须拒绝"的列表会让测试自相矛盾。
  for (const evil of ['../index.js', '..', '.', 'nope', '', 'ok.mp3',
    'OK', 'ok ', '/etc/passwd', 'C:\\Windows\\win.ini', 'ok/../ok']) {
    assert.equal(resolveVoice(dir, evil, m), null,
      `${JSON.stringify(evil)} 应返回 null（清单里没有它）`)
  }
})

ok('⭐ 正向：清单里的名字**确实**能解析出来（否则上面的断言是空的）', () => {
  // 没有这一条，"清单外的名字都返回 null"可能只是因为**什么都解析不出来**
  // —— 那样断言毫无意义。这是本项目反复踩过的"假断言"模式。
  const dir = makeTmpVoice({ lines: [{ name: 'ok', file: 'ok.mp3' }] }, { 'ok.mp3': 10 })
  const m = loadVoice(dir)
  const abs = resolveVoice(dir, 'ok', m)
  assert.ok(abs !== null, '清单里的名字必须能解析出路径')
  assert.ok(abs.endsWith('ok.mp3'))
})

ok('manifest 为 null/undefined 时安全返回 null（不抛）', () => {
  for (const bad of [null, undefined, {}, { byName: null }]) {
    assert.equal(resolveVoice(VOICE_DIR, 'wake', bad), null)
  }
})

ok('名字非字符串 → null', () => {
  const dir = makeTmpVoice({ lines: [{ name: 'ok', file: 'ok.mp3' }] })
  const m = loadVoice(dir)
  for (const bad of [null, 42, {}, [], undefined]) {
    assert.equal(resolveVoice(dir, bad, m), null)
  }
})

ok('⭐ 二次路径校验：清单条目绕过 name 检查时，解析仍被挡在目录内', () => {
  // 为什么需要这一条：`resolveVoice` 里有两道闸 —— ① `isSafeName` 过滤
  //（在 `loadVoice` 阶段），② 解析后再确认落在 root 内。
  //
  // 回退验证发现：把 ② 删掉，28 条断言**全绿** —— 因为 ① 已经把
  // `../` 挡在清单之外了，② 从来没被走到。但 ② 不是冗余：它是
  // **纵深防御**，防的是"清单被别的东西构造出来"（比如测试、或将来
  // 某个绕过 `loadVoice` 的调用方）。所以这里**手工造一份带穿越路径的
  // manifest**，跳过 ① 直接喂给 ②，验证它单独也挡得住。
  const dir = makeTmpVoice(null, { 'ok.mp3': 10 })
  const evilManifest = {
    byName: new Map([
      ['escape', { name: 'escape', file: '../outside.mp3' }],
      ['abs', { name: 'abs', file: 'C:\\Windows\\win.ini' }],
      ['deep', { name: 'deep', file: 'sub/../../x.mp3' }]
    ])
  }
  for (const name of ['escape', 'abs', 'deep']) {
    assert.equal(resolveVoice(dir, name, evilManifest), null,
      `${name} 的 file 指向目录外，二次校验必须挡住`)
  }
  // 反向确认：同目录内的正常条目仍然能解析（证明上面不是"什么都拒绝"）
  const good = { byName: new Map([['ok', { name: 'ok', file: 'ok.mp3' }]]) }
  assert.ok(resolveVoice(dir, 'ok', good) !== null, '同目录内的条目应能解析')
})

ok('⭐ 清单里的非对象条目被跳过（不许把 null/字符串当条目）', () => {
  // 回退验证发现：把 `typeof item !== 'object'` 去掉后断言仍全绿 ——
  // 因为后续字段访问恰好对 null/字符串也"安全地"产出了空名，
  // 再被 `isSafeName` 挡掉。那是**巧合**，不是设计。
  //
  // 所以除了断言"只保留 1 条"，还要断言 **skipped 计数**：那是这条分支
  // 独有的可观测结果 —— 把跳过改成"继续往下走"，计数就会对不上。
  const dir = makeTmpVoice({
    lines: [
      { name: 'real', file: 'real.mp3', event: 'e' },
      null,
      undefined,
      'a string',
      42,
      true,
      ['array']
    ]
  })
  const m = loadVoice(dir)
  assert.equal(m.count, 1, `只该保留 1 条真条目，实际 ${m.count}：${JSON.stringify(m.lines)}`)
  assert.deepEqual([...m.byName.keys()], ['real'])
  assert.equal(m.skipped, 6, `应报告 6 条被跳过，实际 ${m.skipped}`)
})

ok('skipped 计数覆盖各类拒绝原因（非法名/非法 file/超体积/重名）', () => {
  const dir = makeTmpVoice({
    lines: [
      { name: 'good', file: 'good.mp3', event: 'e' },
      { name: '../bad', file: 'x.mp3' },                    // 非法 name
      { name: 'bad2', file: '../x.mp3' },                   // 非法 file
      { name: 'huge', file: 'huge.mp3', bytes: 99 * 1024 * 1024 },   // 超体积
      { name: 'good', file: 'again.mp3' }                   // 重名
    ]
  })
  const m = loadVoice(dir)
  assert.equal(m.count, 1, `应只留 1 条，实际 ${m.count}`)
  assert.equal(m.skipped, 4, `应报告 4 条被跳过，实际 ${m.skipped}`)
})

ok('⭐ 重名保留先到的（后到者不许覆盖）', () => {
  // 静默覆盖会让"改了台词却没生效"极难查：清单里明明是新文件名，
  // 跑起来放的还是旧的。
  const dir = makeTmpVoice({
    lines: [
      { name: 'dup', file: 'first.mp3', event: 'a', durationMs: 1 },
      { name: 'dup', file: 'second.mp3', event: 'b', durationMs: 2 }
    ]
  })
  const m = loadVoice(dir)
  assert.equal(m.count, 1, `重名应只留一条，实际 ${m.count}`)
  assert.equal(m.byName.get('dup').file, 'first.mp3', '必须保留先出现的那条')
  assert.equal(m.byName.get('dup').event, 'a', '事件也应是先到那条的')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 4. pickVoiceForEvent / voiceReport
 * ══════════════════════════════════════════════════════════════════════════ */

section('4. 按事件挑选与诊断报告')

ok('同名事件多条时轮换（避免每次点击都一样）', () => {
  const dir = makeTmpVoice({
    lines: [
      { name: 'c1', file: 'c1.mp3', event: 'pet/click', durationMs: 1 },
      { name: 'c2', file: 'c2.mp3', event: 'pet/click', durationMs: 1 },
      { name: 'c3', file: 'c3.mp3', event: 'pet/click', durationMs: 1 }
    ]
  })
  const m = loadVoice(dir)
  const names = [0, 1, 2, 3, 4, 5].map(s => pickVoiceForEvent(m, 'pet/click', s)?.name)
  assert.deepEqual(names, ['c1', 'c2', 'c3', 'c1', 'c2', 'c3'], '应按 seed 轮换')
})

ok('没有该事件的语音 → null（不抛）', () => {
  const dir = makeTmpVoice({ lines: [{ name: 'x', file: 'x.mp3', event: 'pet/click' }] })
  const m = loadVoice(dir)
  assert.equal(pickVoiceForEvent(m, 'nope/event', 0), null)
  assert.equal(pickVoiceForEvent(null, 'pet/click', 0), null)
  assert.equal(pickVoiceForEvent(undefined, 'pet/click', 0), null)
})

ok('voiceReport 汇总正确（条数/时长/体积/来源/事件分布）', () => {
  const dir = makeTmpVoice({
    lines: [
      { name: 'a', file: 'a.mp3', event: 'pet/click', source: 'real', durationMs: 1000, bytes: 100 },
      { name: 'b', file: 'b.mp3', event: 'pet/click', source: 'real', durationMs: 2000, bytes: 200 },
      { name: 'c', file: 'c.mp3', event: 'pet/wake', source: 'synth', durationMs: 3000, bytes: 300 }
    ]
  })
  const rep = voiceReport(loadVoice(dir))
  assert.equal(rep.available, true)
  assert.equal(rep.count, 3)
  assert.equal(rep.totalMs, 6000)
  assert.equal(rep.totalBytes, 600)
  assert.equal(rep.realCount, 2)
  assert.equal(rep.synthCount, 1)
  assert.deepEqual(rep.byEvent, { 'pet/click': 2, 'pet/wake': 1 })
  assert.deepEqual(rep.names, ['a', 'b', 'c'])
})

ok('空清单的报告是 available:false（而不是崩）', () => {
  const rep = voiceReport(loadVoice(path.join(os.tmpdir(), 'nope-' + Date.now())))
  assert.equal(rep.available, false)
  assert.equal(rep.count, 0)
  assert.equal(rep.totalMs, 0)
  assert.deepEqual(rep.names, [])
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 真实产物（art/voice/）—— 清单与磁盘必须一致
 * ══════════════════════════════════════════════════════════════════════════ */

section('5. 真实语音产物（art/voice/voice.json）')

ok('真实清单存在且能被加载（若未构建则跳过并提示）', () => {
  const m = loadVoice(VOICE_DIR)
  if (m.count === 0) {
    // 语音包是可选的。但既然仓库里提交了产物，这条应当通过 ——
    // 失败信息要说清楚怎么办，而不是一句"count=0"。
    throw new Error(`art/voice/${MANIFEST_NAME} 加载出 0 条。` +
      '若尚未构建，请跑 tools/build-voice.ps1；若是构建后仍为 0，说明清单格式与 voice.js 不匹配。')
  }
  assert.ok(m.count >= 10, `条数偏少（${m.count}），像是构建不完整`)
})

ok('⭐⭐ 清单里每一条的文件都**真的在磁盘上**且大小与清单一致', () => {
  // 这是最难查的一类缺陷：清单说有条目、文件却不在，运行时表现为
  // "某句台词永远不响"且毫无报错。
  const m = loadVoice(VOICE_DIR)
  assert.ok(m.count > 0, '清单为空，无法验证')
  for (const rec of m.lines) {
    const abs = resolveVoice(VOICE_DIR, rec.name, m)
    assert.ok(abs !== null, `${rec.name} 解析不出路径`)
    assert.ok(fs.existsSync(abs), `${rec.name} 的文件不存在：${abs}`)
    const stat = fs.statSync(abs)
    assert.ok(stat.isFile(), `${rec.name} 不是文件`)
    assert.ok(stat.size > 100, `${rec.name} 太小（${stat.size}B），像是空文件`)
    if (rec.bytes > 0) {
      assert.equal(stat.size, rec.bytes,
        `${rec.name} 清单说 ${rec.bytes}B、磁盘上 ${stat.size}B —— 清单过期了`)
    }
  }
})

ok('⭐ 清单里每条都有非零时长（exe 靠它做"上一句没播完别播下一句"）', () => {
  const m = loadVoice(VOICE_DIR)
  assert.ok(m.count > 0, '清单为空，无法验证')
  for (const rec of m.lines) {
    assert.ok(rec.durationMs > 0,
      `${rec.name} 的 durationMs=${rec.durationMs} —— ffprobe 没读到时长，播放去重会失灵`)
  }
})

ok('⭐⭐ exe 会说的每个事件，台词表里都有语音（无静默缺口）', () => {
  // 为什么必须有这条（v2 加的）：
  // exe 的 `Speak()` 找不到语音时**静默返回 false** —— 那是正常设计
  //（有些事件就是没有语音）。于是"改了事件名 / 删了台词"这类错误
  // 在运行时**完全无声**：用户只会觉得"某些时候她不出声"，永远定位不到。
  //
  // 这份清单与 pet/Program.cs 的 Speak("...") 调用点一一对应，
  // exe 自检里也有一份同样的断言（两侧都挡住）。
  const spokenEvents = [
    'pet/wake', 'pet/click', 'agent/working', 'agent/thinking',
    'turn/complete', 'agent/error', 'attention/approval',
    'attention/cleared', 'pomodoro/start', 'pomodoro/focus-end',
    'pomodoro/break-end', 'pomodoro/long-start', 'pomodoro/long-end',
    'pet/feed', 'pet/praise', 'pet/pet-head', 'pet/sleeping',
    'chat/reply', 'session/start', 'pet/idle-long'
  ]
  const m = loadVoice(VOICE_DIR)
  assert.ok(m.count > 0, '清单为空，无法验证')
  const events = new Set(m.lines.map(l => l.event))
  const gap = spokenEvents.filter(e => !events.has(e))
  assert.deepEqual(gap, [],
    `这些事件在代码里会被说、但台词表里没有：${gap.join(', ')} —— ` +
    '运行时表现为"某些时候她不出声"且毫无报错')
})

ok('⭐ 台词表与清单一致（改了表没重新构建 → 立刻发现）', () => {
  // `tools/voice-lines.json` 是源，`art/voice/voice.json` 是产物。
  // 两者不一致的典型症状：改了台词、忘了跑 build-voice.ps1，
  // 于是听感与预期不同却查不出原因。
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'voice-lines.json'), 'utf8'))
  const m = loadVoice(VOICE_DIR)
  assert.ok(m.count > 0, '清单为空，无法验证')
  const srcNames = src.lines.map(l => l.name).sort()
  const outNames = m.lines.map(l => l.name).sort()
  assert.deepEqual(outNames, srcNames,
    '清单与 voice-lines.json 的名字集合不一致 —— 请重跑 tools/build-voice.ps1')
  // 事件也要一致（改了 event 却忘了重建，症状是"语音在错误的时机响"）
  const srcByName = new Map(src.lines.map(l => [l.name, l]))
  for (const rec of m.lines) {
    const s = srcByName.get(rec.name)
    assert.equal(rec.event, s.event,
      `${rec.name} 的事件不一致：清单 ${rec.event} vs 源 ${s.event}`)
    // ⭐ 文本也要比：改了台词不重建，症状是"念的还是旧词"，
    // 而名字与事件都对得上 —— 只比名字/事件**测不出**这种情况（实测漏过）。
    assert.equal(rec.text, s.text,
      `${rec.name} 的文本不一致（清单 ${JSON.stringify(rec.text)} vs 源 ${JSON.stringify(s.text)}）` +
      ' —— 改了台词没重建产物，听到的会是旧词。请重跑 tools/build-voice.ps1')
  }
})

ok('⭐⭐ 台词表里没有语义错位的组合（v1 踩过的坑，防回归）', () => {
  // v1 的毛病：把官方**战斗**语音硬套到日常事件上。用户直接反馈"台词太奇怪"。
  // 这里把踩过的具体错配钉成断言 —— 它们是"看起来能用、听着很怪"的那类错误，
  // 单看代码永远发现不了。
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'voice-lines.json'), 'utf8'))
  const byEvent = new Map()
  for (const l of src.lines) {
    if (!byEvent.has(l.event)) byEvent.set(l.event, [])
    byEvent.get(l.event).push(l)
  }
  // ① 出错时不能说"没事，不用管我"（负伤台词 —— 语义相反）
  const errTexts = (byEvent.get('agent/error') ?? []).map(l => l.text)
  assert.ok(!errTexts.some(t => t.includes('不用管我')),
    '出错时不该说「没事，不用管我」（那是负伤台词，语义相反）')
  // ② 回复**到达**时不能说"让我想想"（时序倒置：话都说完了）
  const replyTexts = (byEvent.get('chat/reply') ?? []).map(l => l.text)
  assert.ok(!replyTexts.some(t => t.includes('让我想想')),
    '回复到达时不该说「让我想想」—— 那是思考时的台词，时序倒置')
  // ③ "让我想想"应该在 agent/thinking 上
  const thinkTexts = (byEvent.get('agent/thinking') ?? []).map(l => l.text)
  assert.ok(thinkTexts.some(t => t.includes('让我想想')),
    '「让我想想」应挂在 agent/thinking（思考时机）')
  // ④ 完成时不能说作战胜利那类（"赢这一次"）
  const doneTexts = (byEvent.get('turn/complete') ?? []).map(l => l.text)
  assert.ok(!doneTexts.some(t => t.includes('赢这一次')),
    '完成时不该说「赢这一次，其实不算很难」（作战胜利台词，与干活无关）')
  // ⑤ 高频事件必须有多条轮换（只有一条会听腻）
  for (const evt of ['pet/click', 'turn/complete', 'agent/error', 'chat/reply']) {
    const n = (byEvent.get(evt) ?? []).length
    assert.ok(n >= 2, `${evt} 只有 ${n} 条 —— 高频事件应有多条轮换`)
  }
})

ok('⭐ 每条文件都是真 MP3（ID3 或帧同步头），不是被改名的别的东西', () => {
  const m = loadVoice(VOICE_DIR)
  assert.ok(m.count > 0, '清单为空，无法验证')
  for (const rec of m.lines) {
    const abs = resolveVoice(VOICE_DIR, rec.name, m)
    const head = Buffer.alloc(3)
    const fd = fs.openSync(abs, 'r')
    try { fs.readSync(fd, head, 0, 3, 0) } finally { fs.closeSync(fd) }
    const isId3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33   // "ID3"
    // 帧同步：11 个 1 位（0xFF 且高 3 位为 1）
    const isFrame = head[0] === 0xFF && (head[1] & 0xE0) === 0xE0
    assert.ok(isId3 || isFrame,
      `${rec.name} 不是 MP3（头三字节 ${head.toString('hex')}）`)
  }
})

ok('真实清单的总时长与总体积在合理范围（防"语音包悄悄膨胀"）', () => {
  const rep = voiceReport(loadVoice(VOICE_DIR))
  assert.ok(rep.totalMs > 0, '总时长应为正')
  assert.ok(rep.totalMs < 10 * 60 * 1000, `总时长 ${rep.totalMs}ms 超过 10 分钟，太多了`)
  assert.ok(rep.totalBytes < 4 * 1024 * 1024,
    `总体积 ${rep.totalBytes}B 超过 4MB（构建脚本里有同一条守卫）`)
})

ok('⭐ 关键事件都有语音（番茄钟与完成提醒是用户点名的功能）', () => {
  const m = loadVoice(VOICE_DIR)
  assert.ok(m.count > 0, '清单为空，无法验证')
  // 这几个事件缺了就是功能残废，不是"少一句台词"。
  for (const ev of ['pomodoro/focus-end', 'turn/complete', 'agent/error', 'pet/click']) {
    const rec = pickVoiceForEvent(m, ev, 0)
    assert.ok(rec !== null, `事件 ${ev} 没有任何语音 —— 该功能会静音`)
  }
})

ok('⭐ 台词表里没有"结尾中文省略号"（合成会得到近乎静音的音频）', () => {
  // ⚠️ **这条断言基于一个错误的诊断，已改成反向记录。**
  //
  // 原判断：`让我想想……` 合成出来是 -45.7 dB（近乎静音），改成 `让我想想...`
  // 就正常，于是认为"结尾的中文省略号会触发静音"，还加了构建期守卫拒绝生成。
  //
  // 错在哪：`synth.py` 的 **seed 固定为 42**，所以"重合成两次结果一样"只是
  // 同一个种子跑了两遍 —— 我把"同种子可复现"误读成了"文本触发"。
  // 用户一句"这个是种子的问题"点破。换 seed 实测：
  //
  //     seed=42    -45.7 dB / 0.78s   ❌ 静音
  //     seed=1     -24.5 dB / 2.10s   ✅
  //     seed=7     -24.2 dB / 1.38s   ✅
  //
  // 所以省略号无辜，真正的坑是**固定种子**（seed=42 时某些文本会踩到静音）。
  // 修法在合成侧（`tools/synth-voice.ps1` 多 seed + 静音检测重试），不在台词表。
  //
  // 这条断言改成验**真正的修法**：产物里不许有近乎静音的条目。
  // （音量从 `voice.json` 的 durationMs 侧面反映不了，所以查"异常短"的条目 ——
  //   静音条目实测只有 0.78 秒，而正常同句 1.2~2.1 秒。）
  const m = loadVoice(VOICE_DIR)
  assert.ok(m.count > 0, '清单为空，无法验证')
  const tooShort = m.lines.filter(l => l.source === 'synth' && l.durationMs > 0 && l.durationMs < 700)
  assert.deepEqual(tooShort.map(l => `${l.name} ${l.durationMs}ms`), [],
    '这些合成条目短得可疑（<700ms），很可能是 seed 踩到静音 —— 需要重新合成')
})

ok('⭐ 台词条数足够"换着说"（高频事件 ≥3 条，防单调）', () => {
  // 用户反馈："当前主体的变化度还是比较少（包括语音），就是比较单调吧"。
  // 改前 `agent/thinking` 只有 **2 条**，而它恰恰每次思考都放 —— 精确地循环，
  // 听两次就腻。另有 9 个事件各只有 1 条。
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'voice-lines.json'), 'utf8'))
  const by = {}
  for (const l of src.lines) by[l.event] = (by[l.event] ?? 0) + 1

  // 高频事件：思考 / 干活 / 完成 / 回复 / 出错 / 点击 —— 每条都得有得换
  for (const ev of ['agent/thinking', 'agent/working', 'turn/complete',
    'chat/reply', 'agent/error', 'pet/click']) {
    assert.ok((by[ev] ?? 0) >= 3,
      `高频事件 ${ev} 只有 ${by[ev] ?? 0} 条台词，会明显重复（应 ≥3）`)
  }
  // 事件**类型**覆盖：exe 会说的每个事件都不该是"独一句"
  const singles = Object.entries(by).filter(([, n]) => n === 1).map(([k]) => k)
  assert.ok(singles.length <= 1,
    `这些事件只有 1 条台词，听两次就腻：${singles.join(', ')}`)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败项'}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
