/**
 * 庄方宜桌宠 · **素材台账一致性**测试
 *
 * 用法：`node tools/test-pet-assets.mjs`
 *
 * ── 这套测试在防什么 ──────────────────────────────────────────────────────
 *
 * 素材的知识曾经散在**三处**：`tools/prepare-pet.py` 里 8 张表 + `STATE_PLAN`、
 * `src/pet/emotes.js` 的 `EMOTE_BY_KEY`、以及产物文件名（按位置编号）。
 * 三处之间没有任何交叉校验，于是这些缺陷能长期存在且**毫无症状**：
 *
 *   · 同一张图被 2~3 个状态共用（"微笑"同时在 waking/idle/happy）——
 *     于是"每个状态表情都不一样"从根上不成立，而**没人看得出来**；
 *   · 一张素材闲置（`吃东西`一次没用上）；
 *   · 台词表里 27 条（20%）永远不会被播 —— `Speak()` 找不到就静默返回，
 *     没有日志、没有报错。
 *
 * 现在素材知识收在 `assets/catalog.json` 一处，产物名带语义 id，
 * 于是上面每一条都能**静态校验**，不必等用户反馈。
 *
 * ⚠️ 本文件只读：它不跑管线、不写文件。产物要与台账一致，
 * 由 `python tools/prepare-pet.py`（重跑）+ `--audit`（校验）负责。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMOTE_BY_KEY, EMOTE_EXCLUDE_FROM_RANDOM } from '../src/pet/emotes.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ART = path.join(ROOT, 'art', 'pet')
const CATALOG = path.join(ROOT, 'assets', 'catalog.json')
const VALID_STATES = ['waking', 'idle', 'listening', 'thinking', 'working',
  'waiting', 'happy', 'error', 'sleeping']
/** 实际分配素材的主体状态（`listening` 2026-10-07 起降级为纯气泡）。 */
const BODY_STATES = ['waking', 'idle', 'thinking', 'working', 'waiting', 'happy', 'error', 'sleeping']

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

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'))
const manifest = JSON.parse(fs.readFileSync(path.join(ART, 'pet.json'), 'utf8'))
const assets = catalog.assets ?? []
const body = assets.filter(a => a.role === 'body')
const bubbles = assets.filter(a => a.role === 'bubble' || a.role === 'anim')
const idOf = f => manifest.assets?.[f]?.id ?? null

/** 台账 `source` → 绝对路径（前缀与 `prepare-pet.py` 的 `resolve_source` 一致）。 */
function resolveSource (source) {
  const [head, ...rest] = String(source).split('/')
  const tail = rest.join('/')
  const base = path.dirname(ROOT)
  switch (head) {
    case 'wx': return path.join(base, '庄方宜素材', '10-表情包', 'wx', tail)
    case 'QQ表情': return path.join(base, '庄方宜素材', '10-表情包', 'QQ表情', tail)
    case 'cutout': return path.join(ART, 'src', 'cutout', tail)
    case '新表情包': return path.join(base, 'fromQQ', '新表情包', '庄方宜(未扣背景)', tail)
    default: return null
  }
}

/** 台账里登记的产物路径（与管线的命名规则一致）。 */
function productOf (a) {
  if (a.role === 'body') return `${a.states[0]}-${a.id}.png`
  const ext = a.role === 'anim' ? 'gif' : 'png'
  return `bubble/${a.dir ? a.dir + '/' : ''}${a.id}.${ext}`
}

section('1. 台账结构')

ok('台账存在且有 assets 数组', () => {
  assert.ok(Array.isArray(assets) && assets.length > 0, 'assets/catalog.json 里应有非空 assets 数组')
  assert.equal(catalog.version, 1, '台账 version 应为 1')
})

ok('id 全局唯一（主体与气泡共用命名空间）', () => {
  const seen = new Map()
  const dup = []
  for (const a of assets) {
    if (seen.has(a.id)) dup.push(`${a.id}（第 ${seen.get(a.id) + 1} 条与第 ${assets.indexOf(a) + 1} 条）`)
    else seen.set(a.id, assets.indexOf(a))
  }
  assert.deepEqual(dup, [], `id 重复：${dup.join(', ')}`)
})

ok('每个条目的 role / source / caption 都齐', () => {
  for (const a of assets) {
    assert.ok(['body', 'bubble', 'anim'].includes(a.role), `${a.id}: role 非法（${a.role}）`)
    assert.ok(typeof a.source === 'string' && a.source.length > 0, `${a.id}: 缺 source`)
    assert.ok(typeof a.caption === 'string' && a.caption.length > 0,
      `${a.id}: 缺 caption（"这张图画的是什么"必须写下来，否则台账等于没写）`)
  }
})

ok('台账里登记的源文件**都真实存在**（不存在 = 少一张图，且症状延迟到运行时）', () => {
  const missing = []
  for (const a of assets) {
    const p = resolveSource(a.source)
    if (p === null) { missing.push(`${a.id}: source 前缀不认识（${a.source}）`); continue }
    if (!fs.existsSync(p)) missing.push(`${a.id}: ${a.source}`)
  }
  assert.deepEqual(missing, [], `源文件缺失：\n      ${missing.join('\n      ')}`)
})

section('2. 归属：一图一状态')

ok('⭐ 一张主体素材只服务一个状态（否则"每个状态表情都不同"从根上不成立）', () => {
  const owners = new Map()
  for (const a of body) {
    for (const st of a.states ?? []) {
      owners.set(a.id, [...(owners.get(a.id) ?? []), st])
    }
  }
  const shared = [...owners].filter(([, st]) => st.length > 1)
  assert.deepEqual(shared, [],
    `这些素材被多个状态共用：${shared.map(([id, st]) => `${id}→${st.join('/')}`).join(', ')}`)
})

ok('每个实际使用的状态都有素材（缺一个 = 该状态回落到 idle）', () => {
  const missing = BODY_STATES.filter(st => !body.some(a => (a.states ?? []).includes(st)))
  assert.deepEqual(missing, [], `这些状态在台账里没有素材：${missing.join(', ')}`)
})

ok('listening 不分配任何主体素材（2026-10-07 起降级为纯气泡）', () => {
  const bad = body.filter(a => (a.states ?? []).includes('listening'))
  assert.deepEqual(bad.map(a => a.id), [], 'listening 不该再分到主体素材')
  assert.ok(!manifest.variants?.listening, '清单里也不该有 listening 的变体')
  assert.ok(!manifest.states?.listening, '清单里也不该有 listening 的 canonical 条目')
})

ok('气泡素材至少归属一个情境（否则永远不会被按情境挑中）', () => {
  const bad = bubbles.filter(a => !Array.isArray(a.keys) || a.keys.length === 0)
  assert.deepEqual(bad.map(a => a.id), [], '这些气泡没有 keys[]')
})

section('3. 台账 ↔ 产物 ↔ 清单 三者一致')

ok('⭐ 产物名带语义 id，且与清单里的 id 对得上', () => {
  for (const a of body) {
    for (const st of a.states ?? []) {
      const file = `${st}-${a.id}.png`
      assert.ok(fs.existsSync(path.join(ART, file)), `产物 ${file} 不存在（管线没跑或归属刚改）`)
      assert.ok((manifest.variants?.[st] ?? []).includes(file),
        `${file} 不在 variants.${st} 里`)
      assert.equal(idOf(file), a.id, `清单 assets 里 ${file} 的 id 应为 ${a.id}`)
      const meta = manifest.assets?.[file]
      assert.deepEqual(meta?.states, [st], `${file} 的 states 应为 [${st}]`)
    }
  }
})

ok('气泡产物与台账登记一致（双向无孤儿）', () => {
  const declared = new Set(manifest.bubble.map(b => b.file))
  const fromCatalog = new Set(bubbles.map(productOf))
  const missingOnDisk = [...fromCatalog].filter(f => !fs.existsSync(path.join(ART, f)))
  assert.deepEqual([...missingOnDisk], [], `台账登记但磁盘上没有：${missingOnDisk.join(', ')}`)
  const orphanProduct = [...declared].filter(f => !fromCatalog.has(f))
  assert.deepEqual(orphanProduct, [],
    `清单里有、台账里没有的气泡产物（孤儿）：${orphanProduct.join(', ')}`)
  const notInManifest = [...fromCatalog].filter(f => !declared.has(f))
  assert.deepEqual(notInManifest, [], `台账登记但清单里没有：${notInManifest.join(', ')}`)
})

ok('旧的按序号命名不许复活（idle-2.png 那种）', () => {
  const legacy = []
  for (const files of Object.values(manifest.variants ?? {})) {
    for (const f of files) {
      if (/^[a-z]+-[2-9]\.png$/.test(path.basename(f))) legacy.push(f)
    }
  }
  assert.deepEqual(legacy, [], `不该再有按序号命名的产物：${legacy.join(', ')}`)
})

ok('canonical 必须是 variants[0]（契约 §4；exe 按 variants[0] 取第一张）', () => {
  for (const st of Object.keys(manifest.states ?? {})) {
    assert.equal(manifest.variants?.[st]?.[0], manifest.states[st].file,
      `${st}: states.file 与 variants[0] 不一致`)
  }
})

ok('每个文件的 `files` 几何齐全（帧数/帧宽 ≥ 1；缺了会被切出碎条）', () => {
  for (const f of Object.keys(manifest.files ?? {})) {
    const g = manifest.files[f]
    assert.ok(Number.isFinite(g.frames) && g.frames >= 1, `${f}: frames 非法`)
    assert.ok(Number.isFinite(g.frameWidth) && g.frameWidth >= 1, `${f}: frameWidth 非法`)
  }
})

ok('磁盘上没有未引用的孤儿产物（改归属/改名后必须清干净）', () => {
  const referenced = new Set([
    ...Object.values(manifest.variants ?? {}).flat(),
    ...(manifest.bubble ?? []).map(b => b.file),
    ...Object.keys(manifest.states ?? {}).map(s => `thumbs/${s}.png`)
  ])
  const strays = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      // ⚠️ **必须跳过 `src/`**：那是用户的抠图工作台（`raw/` 里是原图、
      // `cutout/` 里是抠好的图），不是产物 —— 管线也不清它，清了就是丢数据。
      // 这与 `prune_unreferenced` 的清理范围保持一致。
      if (e.isDirectory()) {
        if (e.name === 'src') continue
        walk(full)
        continue
      }
      if (!e.name.endsWith('.png') && !e.name.endsWith('.gif')) continue
      const rel = path.relative(ART, full).split(path.sep).join('/')
      if (!referenced.has(rel)) strays.push(rel)
    }
  }
  walk(ART)
  assert.deepEqual(strays, [], `这些产物没人引用（重跑 prepare-pet.py 会清掉）：${strays.join(', ')}`)
})

section('4. 气泡情境（生成物与台账同源）')

ok('emotes.data.js 与台账的 keys 完全一致（生成物没过期）', () => {
  const expected = {}
  for (const a of bubbles) {
    const f = productOf(a)
    for (const k of a.keys ?? []) (expected[k] ??= []).push(f)
  }
  for (const k of Object.keys(expected)) {
    const got = (EMOTE_BY_KEY[k] ?? []).slice().sort()
    const want = expected[k].slice().sort()
    assert.deepEqual(got, want, `情境 ${k} 与台账不一致\n      实际：${got.join(', ')}\n      台账：${want.join(', ')}`)
  }
  for (const k of Object.keys(EMOTE_BY_KEY)) {
    assert.ok(expected[k] !== undefined, `emotes.data.js 里的 ${k} 在台账中已不存在`)
  }
})

ok('排除名单 == 台账里 random:false 的那些', () => {
  const want = bubbles.filter(a => a.random === false).map(productOf).sort()
  assert.deepEqual(EMOTE_EXCLUDE_FROM_RANDOM.slice().sort(), want,
    `排除名单应与台账一致：${want.join(', ')}`)
})

ok('EMOTE_BY_KEY 里没有悬空文件引用（清单里必须有这张图）', () => {
  const files = new Set(manifest.bubble.map(b => b.file))
  const dangling = []
  for (const [k, list] of Object.entries(EMOTE_BY_KEY)) {
    for (const f of list) if (!files.has(f)) dangling.push(`${k} → ${f}`)
  }
  assert.deepEqual(dangling, [], `情境引用了气泡池里没有的文件：${dangling.join(', ')}`)
})

section('5. 语音可达性（闲置台词）')

ok('⭐ 台词表里的每个事件都有触发点（否则那些台词永远不会播）', () => {
  const voice = JSON.parse(fs.readFileSync(path.join(ROOT, 'art', 'voice', 'voice.json'), 'utf8'))
  const events = new Set()
  for (const l of voice.lines ?? []) if (typeof l.event === 'string' && l.event !== '') events.add(l.event)
  // 触发点有两处可能：exe 的 C# 源码、Host/overlay 的 JS 源码。
  // 用"源码里出现该字面量"作为可达的判据 —— 它不精确（可能出现在注释里），
  // 但足以挡住"加了台词却忘了接线"这类真实发生过的漏接。
  const sources = [
    ...fs.readdirSync(path.join(ROOT, 'pet')).filter(f => f.endsWith('.cs'))
      .map(f => fs.readFileSync(path.join(ROOT, 'pet', f), 'utf8')),
    fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'),
    ...walkJs(path.join(ROOT, 'src'))
  ].join('\n')
  const orphans = [...events].filter(ev => !sources.includes(`"${ev}"`))
  assert.deepEqual(orphans, [],
    `这些事件在代码里找不到任何 Speak()/voice 引用（台词是死资源）：${orphans.join(', ')}`)
})

ok('台词表里没有异常短/静音的条目（固定占位 0.78s，seed 问题）', () => {
  const voice = JSON.parse(fs.readFileSync(path.join(ROOT, 'art', 'voice', 'voice.json'), 'utf8'))
  const tooShort = (voice.lines ?? []).filter(l => (l.durationMs ?? 0) < 700)
  assert.deepEqual(tooShort.map(l => `${l.name}(${l.durationMs}ms)`), [],
    '有近乎静音的条目（多半是合成踩到了坏 seed）：重新合成这几条')
})

ok('台词清单与产物一致（改了台词忘了合成会红）', () => {
  const lines = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'voice-lines.json'), 'utf8'))
  const voice = JSON.parse(fs.readFileSync(path.join(ROOT, 'art', 'voice', 'voice.json'), 'utf8'))
  const built = new Set((voice.lines ?? []).map(l => l.name))
  const missing = (lines.lines ?? []).map(l => l.name).filter(n => !built.has(n))
  assert.deepEqual(missing, [],
    `台词表里有、产物里没有（没跑 build-voice.ps1 或合成失败）：${missing.join(', ')}`)
})

function walkJs (dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkJs(p))
    else if (e.name.endsWith('.js')) out.push(fs.readFileSync(p, 'utf8'))
  }
  return out
}

console.log('\n' + '═'.repeat(70))
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.error('❌ 有失败项')
  process.exit(1)
}
console.log('✅ 全部通过')