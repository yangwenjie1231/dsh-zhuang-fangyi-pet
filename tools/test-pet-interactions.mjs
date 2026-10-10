/**
 * 庄方宜桌宠 · 互动与好感度单测
 *
 * 用法：`node tools/test-pet-interactions.mjs`
 *
 * ── 这套测试在防什么 ──────────────────────────────────────────────────────
 *
 * 好感度这类"数值"最容易被刷穿，而刷穿的后果是**整个功能失去意义**
 * （满级之后她的反应永远一样）。所以重点盯三件事：
 *   · 冷却**真的**生效，且冷却期内的点击不会把冷却一直往后推；
 *   · 边际递减**真的**递减到 0；
 *   · 每日上限**真的**封顶，且跨天**真的**重置。
 *
 * 另外一条容易被忽略的：**冷却中也要有反应**。点了没反应比"没涨分"更像坏了。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createAffection,
  tierOf,
  interactConfig,
  interactLabel,
  interactText,
  dayKeyFor,
  INTERACT_KINDS,
  INTERACT_CONFIG,
  AFFECTION_TIERS,
  DAILY_CAP
} from '../src/pet/interactions.js'
import { STATE_TEXT } from '../src/pet/state.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

/** 假时钟。 */
function makeClock (start = 1_700_000_000_000) {
  let t = start
  return { now: () => t, advance (ms) { t += ms; return t }, set (v) { t = v; return t } }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 契约值域
 * ══════════════════════════════════════════════════════════════════════════ */

section('1. 契约值域（exe / 路由 / 语音共用）')

/** v10 新增的**纯反应类**动作：收益恒为 0，只有"反应间隔"没有冷却。 */
const REACT_ONLY_KINDS = ['fling', 'hover']

/** 有收益的动作（会涨好感的那批）—— 防刷的三道闸只对它们有意义。 */
const GAINING_KINDS = INTERACT_KINDS.filter(k => !REACT_ONLY_KINDS.includes(k))

ok('⭐ 互动动作值域：4 个经典 + 3 个手势（v10 扩到 7 个）', () => {
  assert.deepEqual([...INTERACT_KINDS].sort(),
    ['click', 'feed', 'fling', 'hover', 'pat', 'praise', 'pet-head'].sort())
  for (const k of INTERACT_KINDS) {
    const cfg = interactConfig(k)
    assert.ok(cfg !== null, `${k} 缺配置`)
    assert.equal(typeof cfg.gain, 'number', `${k} 的 gain 必须是数字`)
    assert.equal(typeof cfg.label, 'string')
    assert.equal(typeof cfg.voice, 'string', `${k} 必须绑语音事件`)
    assert.ok(Array.isArray(cfg.diminish) && cfg.diminish.length > 0, `${k} 缺递减序列`)
  }
})

ok('⭐ 有收益的动作必须有正冷却与递减（纯反应类不需要）', () => {
  // v10 把断言按类别拆开：`fling`/`hover` 收益恒为 0，给它们"正冷却"
  // 是**没有意义**的（冷却保护的是"别一直涨分"，而它们不涨分）——
  // 它们要的是 `reactGapMs`（别一直冒气泡）。
  // 原先把这两条混在一起断言，加新动作时必然误报。
  for (const k of GAINING_KINDS) {
    const cfg = interactConfig(k)
    assert.ok(cfg.cooldownMs > 0, `${k} 必须有正冷却（否则可以按住刷）`)
    assert.ok(cfg.gain > 0, `${k} 必须有正收益（否则不该在"有收益"这一类里）`)
  }
  for (const k of REACT_ONLY_KINDS) {
    const cfg = interactConfig(k)
    assert.equal(cfg.gain, 0, `${k} 是纯反应类，收益必须恒为 0`)
    assert.ok(cfg.reactGapMs > 0, `${k} 必须有反应间隔（否则气泡刷屏）`)
  }
})

ok('⭐ 递减序列真的在递减（否则"递减"是假的）', () => {
  // ⚠️ 这条断言被改过一次。原先断言"序列必须以 0 结尾"，但那个口径
  // 与"档位要能升上去"直接冲突：序列尾为 0 时，每个动作每天的总收益
  // 只有十几分，而第二档门槛 20 —— **用户永远到不了第二档**。
  // （测试自己抓到了这个设计缺陷：断言"跨过 20 应报 tierChanged"永远失败。）
  //
  // 正确的不变式是"**非递增**"，而且**必须真的递减过**（不能全是同一个数，
  // 那等于没有递减）。总量由 DAILY_CAP 兜住 —— 两道闸各管一件事。
  //
  // v10：只对**有收益**的动作断言。`fling`/`hover` 的序列是 `[0]`
  //（只有一个元素，首尾相同）—— 它们根本没有收益可递减，拿这条去要求
  // 它们只会逼着人往表里塞一个假的递减序列。
  for (const k of GAINING_KINDS) {
    const seq = interactConfig(k).diminish
    for (let i = 1; i < seq.length; i++) {
      assert.ok(seq[i] <= seq[i - 1],
        `${k} 的递减序列必须非递增，实际 ${JSON.stringify(seq)}`)
    }
    assert.ok(seq[seq.length - 1] < seq[0],
      `${k} 的序列必须真的递减过（首尾相同等于没递减），实际 ${JSON.stringify(seq)}`)
  }
})

ok('⭐ 三个"正经互动"每天的潜在收益足够跨过第二档（否则好感度是个装饰）', () => {
  // 这一条是**设计不变式**：把"档位能不能升上去"变成可执行的断言。
  //
  // ⚠️ 只对 pet-head/feed/praise 断言，**不含 click** ——
  // click 是"打招呼"，故意设计成收益极低（它太容易触发，一秒能点十下）。
  // 让它也能升级等于把"互动"退化成"点鼠标"。它存在的意义是**有反应**
  // （气泡/语音），不是攒分。
  const tier2 = AFFECTION_TIERS[1].min
  for (const k of ['pet-head', 'feed', 'praise']) {
    const cfg = interactConfig(k)
    const perDay = Math.floor((24 * 60 * 60 * 1000) / cfg.cooldownMs)
    let total = 0
    for (let i = 0; i < perDay; i++) {
      total += cfg.diminish[Math.min(i, cfg.diminish.length - 1)]
    }
    const effective = Math.min(total, DAILY_CAP)
    assert.ok(effective >= tier2,
      `${k} 单日最多只能拿 ${effective} 分，跨不过第二档门槛 ${tier2} —— ` +
      '用户永远升不了档，好感度形同虚设')
  }
  // click 反向断言：它**必须**是低收益的（防止将来有人"顺手"把它调高）
  const clickPerDay = Math.floor((24 * 60 * 60 * 1000) / INTERACT_CONFIG.click.cooldownMs)
  let clickTotal = 0
  for (let i = 0; i < clickPerDay; i++) {
    clickTotal += INTERACT_CONFIG.click.diminish[
      Math.min(i, INTERACT_CONFIG.click.diminish.length - 1)]
  }
  assert.ok(Math.min(clickTotal, DAILY_CAP) < tier2,
    `click 单日收益 ${clickTotal} 分，不该能单独跨过第二档 —— ` +
    '那会让"点鼠标"成为最快的升级方式')
})

ok('未知动作返回 null（调用方据此拒绝，不抛）', () => {
  for (const bad of ['nope', '', null, undefined, 42, {}, '__proto__', 'toString']) {
    assert.equal(interactConfig(bad), null, `${JSON.stringify(bad)} 应返回 null`)
  }
})

ok('档位门槛递增且首档为 0', () => {
  assert.equal(AFFECTION_TIERS[0].min, 0)
  for (let i = 1; i < AFFECTION_TIERS.length; i++) {
    assert.ok(AFFECTION_TIERS[i].min > AFFECTION_TIERS[i - 1].min,
      `第 ${i} 档门槛必须严格大于前一档`)
  }
  // 每个档位都要有中英标签（界面与诊断都用）
  for (const t of AFFECTION_TIERS) {
    assert.ok(t.label && typeof t.label.zh === 'string' && typeof t.label.en === 'string',
      `${t.key} 缺标签`)
  }
})

/* ══════════════════════════════════════════════════════════════════════════
 * 2. tierOf（纯函数）
 * ══════════════════════════════════════════════════════════════════════════ */

section('2. tierOf（档位判定）')

ok('门槛边界：刚好达到就算进档', () => {
  assert.equal(tierOf(0).key, 'stranger')
  assert.equal(tierOf(19).key, 'stranger')
  assert.equal(tierOf(20).key, 'familiar', '刚好 20 应进 familiar')
  assert.equal(tierOf(59).key, 'familiar')
  assert.equal(tierOf(60).key, 'close')
  assert.equal(tierOf(149).key, 'close')
  assert.equal(tierOf(150).key, 'trusted')
  assert.equal(tierOf(99999).key, 'trusted')
})

ok('进度：档内 0~1，满级为 1', () => {
  assert.equal(tierOf(0).progress, 0)
  assert.equal(tierOf(10).progress, 0.5, '0→20 的中点应是 0.5')
  assert.equal(tierOf(20).progress, 0, '刚进档 → 进度归零（下一档是 60）')
  assert.equal(tierOf(40).progress, 0.5)
  assert.equal(tierOf(150).progress, 1, '满级 → 1')
})

ok('next 指向下一档，满级为 null', () => {
  assert.equal(tierOf(0).next.key, 'familiar')
  assert.equal(tierOf(150).next, null)
})

ok('非法输入回落 0（不抛、不产生 NaN）', () => {
  for (const bad of [NaN, -5, null, undefined, 'x', {}]) {
    const t = tierOf(bad)
    assert.equal(t.key, 'stranger', `${JSON.stringify(bad)} 应回落初识`)
    assert.ok(Number.isFinite(t.progress), 'progress 必须是有限数')
  }
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 互动：收益 / 冷却 / 递减
 * ══════════════════════════════════════════════════════════════════════════ */

section('3. 互动（收益 / 冷却 / 递减）')

ok('第一次互动拿到全额收益', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  const r = a.interact('praise', clock.now())
  assert.equal(r.accepted, true)
  assert.equal(r.gain, INTERACT_CONFIG.praise.gain)
  assert.equal(r.points, INTERACT_CONFIG.praise.gain)
  assert.equal(r.cooling, false)
})

ok('⭐ 冷却期内**不涨**好感，但**仍然有反应**（点了没反应比没涨分更像坏了）', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  a.interact('praise', clock.now())
  clock.advance(1000)   // 冷却 120 秒，现在还在冷却
  const r = a.interact('praise', clock.now())
  assert.equal(r.accepted, true, '冷却中也要 accepted（调用方要给出反应）')
  assert.equal(r.gain, 0, '冷却中不该涨')
  assert.equal(r.cooling, true, '应如实报 cooling')
  // 反应文案与语音**必须还在**（否则就是"点了没反应"）
  assert.ok(r.voice, '冷却中仍要给出语音事件')
})

ok('⭐ 冷却期内的点击**不会**把冷却一直往后推（否则永远进不了冷却）', () => {
  // 这是最容易写错的一处：如果每次调用都更新 lastAt，那么"每秒点一下"
  // 会让 lastAt 永远停在最新时刻，冷却永远不结束 → 好感永远涨不了。
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  a.interact('praise', clock.now())
  const firstGainAt = clock.now()
  // 每秒点一次，连点 119 秒（冷却 120 秒，还没到）
  for (let i = 0; i < 119; i++) {
    clock.advance(1000)
    a.interact('praise', clock.now())
  }
  assert.equal(a.internals.points, INTERACT_CONFIG.praise.gain, '冷却期内不该有任何收益')
  // 现在刚好越过冷却（从**第一次成功**算起）
  clock.set(firstGainAt + INTERACT_CONFIG.praise.cooldownMs + 1)
  const r = a.interact('praise', clock.now())
  assert.ok(r.gain > 0, `冷却结束后应恢复收益（实际 gain=${r.gain}）—— 若为 0 说明 lastAt 被冷却期内的点击推后了`)
})

ok('⭐ 边际递减：连续重复同一动作，收益逐步降到序列末尾并保持', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  const seq = INTERACT_CONFIG.praise.diminish
  const gains = []
  for (let i = 0; i < seq.length + 3; i++) {
    // 每次跨过冷却，确保不是被冷却挡下的
    clock.advance(INTERACT_CONFIG.praise.cooldownMs + 1)
    gains.push(a.interact('praise', clock.now()).gain)
  }
  assert.deepEqual(gains.slice(0, seq.length), seq,
    `收益序列应等于配置的递减序列，实际 ${gains}`)
  // 序列用完后**保持尾项**（不是 0 —— 见"档位要能升上去"那条设计不变式）
  assert.deepEqual(gains.slice(seq.length), new Array(gains.length - seq.length).fill(seq[seq.length - 1]),
    '递减序列用完后应保持尾项（收益不再降，但也不会回到首项）')
  // 关键：它必须**低于**首次收益（否则"递减"是假的）
  assert.ok(gains[gains.length - 1] < gains[0],
    `稳定后的收益（${gains[gains.length - 1]}）必须低于首次（${gains[0]}）`)
})

ok('不同动作各自独立记账（喂完立刻夸，夸奖该涨）', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  a.interact('feed', clock.now())
  const r = a.interact('praise', clock.now())   // 同一时刻，不同动作
  assert.equal(r.gain, INTERACT_CONFIG.praise.gain,
    '不同动作的冷却互不影响（否则"连续做不同的事"会被当成刷）')
})

ok('未知动作 → accepted:false（唯一会拒绝的情况）', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  for (const bad of ['nope', '', null, '__proto__']) {
    const r = a.interact(bad, clock.now())
    assert.equal(r.accepted, false, `${JSON.stringify(bad)} 应被拒绝`)
    assert.equal(r.reason, 'unknown-kind')
  }
})

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 档位升级与每日上限
 * ══════════════════════════════════════════════════════════════════════════ */

section('4. 档位升级与每日上限')

ok('⭐ 跨过门槛时 tierChanged=true（调用方据此给更强的反馈）', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  // 反复"夸奖"直到跨过 20（每轮都要跨冷却）
  let sawChange = false
  let guard = 0
  while (a.internals.points < 20 && guard++ < 50) {
    clock.advance(INTERACT_CONFIG.praise.cooldownMs + 1)
    const r = a.interact('praise', clock.now())
    if (r.tierChanged) {
      sawChange = true
      assert.equal(r.tier.key, 'familiar')
    }
  }
  assert.ok(sawChange, '跨过 20 时应报 tierChanged')
})

ok('⭐ 每日上限真的封顶（防挂机刷）', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  let guard = 0
  // 用不同动作交替刷（绕开递减），直到触顶
  const kinds = ['praise', 'feed', 'pet-head']
  while (a.internals.todayGain < DAILY_CAP && guard++ < 2000) {
    clock.advance(200 * 1000)   // 跨过最长冷却（120s）
    a.interact(kinds[guard % kinds.length], clock.now())
  }
  assert.ok(a.internals.todayGain >= DAILY_CAP, `应能刷到上限（实际 ${a.internals.todayGain}）`)
  const before = a.internals.points
  clock.advance(200 * 1000)
  const r = a.interact('praise', clock.now())
  assert.equal(r.gain, 0, '触顶后不该再涨')
  assert.equal(r.dailyCapped, true, '应如实报 dailyCapped')
  assert.equal(a.internals.points, before, '分数不该变')
  assert.equal(r.accepted, true, '触顶也要有反应')
})

ok('⭐ 跨天重置：第二天的计数与已得都清零', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  // 先刷一些
  for (let i = 0; i < 5; i++) {
    clock.advance(200 * 1000)
    a.interact('praise', clock.now())
  }
  const day1Points = a.internals.points
  const day1Gain = a.internals.todayGain
  assert.ok(day1Gain > 0)
  // 跨到第二天（+25 小时，保证跨过本地午夜）
  clock.advance(25 * 60 * 60 * 1000)
  const snap = a.snapshot(clock.now())
  assert.equal(snap.remainingToday, DAILY_CAP, '跨天后今日额度应重置')
  // 好感**总分不重置**（那是累计的），只有"今天得了多少"重置
  assert.equal(a.internals.points, day1Points, '累计好感跨天不该丢')
  assert.equal(a.internals.todayGain, 0, '今日已得应清零')
  // 递减也重置（否则"昨天点满了今天第一次就 +0"）
  const r = a.interact('praise', clock.now())
  assert.equal(r.gain, INTERACT_CONFIG.praise.diminish[0],
    '跨天后第一次互动应拿全额（递减计数重置）')
})

ok('snapshot 的形状与一致性', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  a.interact('praise', clock.now())
  const s = a.snapshot(clock.now())
  for (const key of ['points', 'tier', 'tierLabel', 'nextMin', 'progress', 'remainingToday']) {
    assert.ok(key in s, `快照缺 ${key}`)
  }
  assert.equal(s.tier, tierOf(s.points).key, 'tier 必须与 points 一致')
  assert.ok(s.progress >= 0 && s.progress <= 1)
  assert.ok(s.remainingToday >= 0 && s.remainingToday <= DAILY_CAP)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 持久化与跨重启
 * ══════════════════════════════════════════════════════════════════════════ */

section('5. 持久化与跨重启')

ok('persist/adopt 往返：累计好感与冷却都保留', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  a.interact('praise', clock.now())
  clock.advance(5000)
  a.interact('feed', clock.now())
  const saved = a.persist(clock.now())

  const b = createAffection({ now: clock.now })
  assert.equal(b.adopt(saved), true)
  assert.equal(b.internals.points, a.internals.points, '累计好感必须跨重启保留')
  assert.equal(b.internals.todayGain, a.internals.todayGain, '今日已得也要保留（同一天）')
  // 冷却也要保留：重启不该变成"刷新冷却"的后门
  const r = b.interact('praise', clock.now())
  assert.equal(r.gain, 0, '重启不该重置冷却（否则重启一次就能再刷一遍）')
})

ok('⭐ 同一天重启：递减计数也要接着算（否则重启 = 刷分后门）', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  clock.advance(INTERACT_CONFIG.praise.cooldownMs + 1)
  a.interact('praise', clock.now())        // 第 1 次 → 全额
  clock.advance(INTERACT_CONFIG.praise.cooldownMs + 1)
  a.interact('praise', clock.now())        // 第 2 次 → 递减
  const saved = a.persist(clock.now())
  const expect3rd = INTERACT_CONFIG.praise.diminish[2]

  const b = createAffection({ now: clock.now })
  b.adopt(saved)
  clock.advance(INTERACT_CONFIG.praise.cooldownMs + 1)
  const r = b.interact('praise', clock.now())
  assert.equal(r.gain, expect3rd,
    `重启后应接着第 3 次（gain=${expect3rd}），实际 ${r.gain} —— 若是全额说明递减被重启重置了`)
})

ok('跨天重启：递减与今日已得都重置', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  for (let i = 0; i < 3; i++) {
    clock.advance(200 * 1000)
    a.interact('praise', clock.now())
  }
  const saved = a.persist(clock.now())

  clock.advance(25 * 60 * 60 * 1000)   // 停机跨天
  const b = createAffection({ now: clock.now })
  b.adopt(saved)
  assert.equal(b.internals.points, a.internals.points, '累计好感保留')
  assert.equal(b.internals.todayGain, 0, '跨天后今日已得应清零')
  const r = b.interact('praise', clock.now())
  assert.equal(r.gain, INTERACT_CONFIG.praise.diminish[0], '跨天后第一次应拿全额')
})

ok('adopt 对垃圾输入安全（返回 false，不破坏现状）', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  a.interact('praise', clock.now())
  const before = a.internals.points
  for (const bad of [null, undefined, 42, 'x']) {
    assert.equal(a.adopt(bad), false)
  }
  assert.equal(a.internals.points, before, '现状不该被破坏')
})

ok('adopt 忽略未知动作与非法值（不产生 NaN）', () => {
  const clock = makeClock()
  const a = createAffection({ now: clock.now })
  a.adopt({
    points: 30,
    lastAt: { praise: clock.now(), __proto__: 1, bogus: 2, feed: 'x' },
    todayCount: { praise: 2, bogus: 5 },
    todayGain: 10,
    dayKey: dayKeyFor(clock.now())
  })
  assert.equal(a.internals.points, 30)
  assert.ok(!a.internals.lastAt.has('bogus'), '未知动作不该进记账')
  assert.ok(!a.internals.lastAt.has('feed'), '非法时间戳不该进记账')
  assert.ok(Number.isFinite(a.internals.points))
})

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 文案与标签
 * ══════════════════════════════════════════════════════════════════════════ */

section('6. 文案与标签')

ok('每个动作都有界面标签（未知动作回落动作名，不返回 undefined）', () => {
  for (const k of INTERACT_KINDS) {
    const l = interactLabel(k)
    assert.ok(typeof l === 'string' && l !== '', `${k} 的标签不该为空`)
  }
  assert.equal(interactLabel('nope'), 'nope', '未知动作回落动作名本身')
  assert.equal(interactLabel(null), '')
})

ok('文案：click 故意没有气泡文案（它太频繁，弹气泡会刷屏）', () => {
  assert.equal(interactText('click', 'zh'), null, 'click 不该有气泡文案')
  for (const k of ['pet-head', 'feed', 'praise']) {
    const zh = interactText(k, 'zh')
    const en = interactText(k, 'en')
    assert.ok(typeof zh === 'string' && zh !== '', `${k} 缺中文文案`)
    assert.ok(typeof en === 'string' && en !== '', `${k} 缺英文文案`)
  }
  assert.equal(interactText('nope', 'zh'), null)
})

ok('dayKeyFor 用本地日期（用户感知的"今天"是本地的）', () => {
  // 同一天内的两个时刻应得同一个 key
  const d = new Date(2026, 9, 6, 0, 30)      // 本地 2026-10-06 00:30
  const d2 = new Date(2026, 9, 6, 23, 30)    // 本地 2026-10-06 23:30
  assert.equal(dayKeyFor(d.getTime()), dayKeyFor(d2.getTime()))
  assert.equal(dayKeyFor(d.getTime()), '2026-10-06')
  // 跨过本地午夜 → 不同 key
  const d3 = new Date(2026, 9, 7, 0, 30)
  assert.notEqual(dayKeyFor(d.getTime()), dayKeyFor(d3.getTime()))
  assert.equal(dayKeyFor(NaN), 'unknown')
})

/* ══════════════════════════════════════════════════════════════════════════
 * v10：手势动作（pat / fling / hover）
 * ══════════════════════════════════════════════════════════════════════════ */

section('v10 手势动作：共用记账 / 反应间隔 / 分级文案')

ok('⭐⭐ pat 与 pet-head 共用冷却与递减（不是新的加分水龙头）', () => {
  // 为什么这条最重要：`pat` 是"按住不放"触发的，一次按下最多报 3 级。
  // 给它独立的递减序列 = 开一个新水龙头，而好感度的设计不变式是
  // "单日潜在收益要能跨过第二档、又不能靠一个动作刷满"。
  const a = createAffection()
  const t = 1_000_000
  // 先摸头（pet-head），再长按摸头（pat）—— 第二次必须落在**同一条**递减线上
  const r1 = a.interact('pet-head', t)
  const r2 = a.interact('pat', t + 1000)
  assert.equal(r1.gain, 2, '第一次摸头应该是满额')
  assert.equal(r2.gain, 0, '紧接着长按摸头必须被同一个冷却挡住')
  assert.equal(r2.accountKind, 'pet-head', 'pat 的记账键必须落到 pet-head')
  assert.equal(r2.cooling, true, '应该报"冷却中"')
  // 冷却期过了之后，递减序列接着往下走（第 2 次 → 2）
  const r3 = a.interact('pat', t + 25_000)
  assert.equal(r3.gain, 2, '第 2 次应该是序列的第 2 项')
  const r4 = a.interact('pet-head', t + 50_000)
  assert.equal(r4.gain, 1, '第 3 次应该掉到 1（证明两边共用同一条计数）')
})

ok('⭐⭐ 纯反应类动作不涨好感（甩她不是亲昵）', () => {
  const a = createAffection()
  const t = 2_000_000
  for (const k of ['fling', 'hover']) {
    const r = a.interact(k, t)
    assert.equal(r.gain, 0, `${k} 不该涨好感`)
    assert.equal(r.accepted, true, `${k} 仍必须"有反应"`)
    assert.equal(a.internals.points, 0)
  }
})

ok('⭐⭐ fling 的反应间隔：连甩只给一次反应，其余是"安静的确认"', () => {
  const a = createAffection()
  const t = 3_000_000
  const r1 = a.interact('fling', t)
  assert.equal(r1.quiet, false, '第一次应该有反应')
  assert.ok(r1.text !== null, '第一次应该有文案')
  assert.ok(r1.voice !== null, '第一次应该有语音')
  // 1 秒后再甩（间隔 3000ms 没到）→ 安静
  const r2 = a.interact('fling', t + 1000)
  assert.equal(r2.quiet, true, '连甩应该被限速')
  assert.equal(r2.text, null, '安静时不该有文案（否则气泡刷屏）')
  assert.equal(r2.voice, null, '安静时不该有语音')
  assert.equal(r2.accepted, true, '限速不等于拒绝（动作本身是成立的）')
  // 过了间隔 → 又有反应
  const r3 = a.interact('fling', t + 3500)
  assert.equal(r3.quiet, false, '过了反应间隔应该恢复')
})

ok('hover 的反应间隔更长（20 秒，鼠标蹭来蹭去不该一直冒气泡）', () => {
  const a = createAffection()
  const t = 4_000_000
  assert.equal(a.interact('hover', t).quiet, false)
  assert.equal(a.interact('hover', t + 5000).quiet, true, '5 秒内应该被限速')
  assert.equal(a.interact('hover', t + 19_000).quiet, true, '19 秒仍在限速窗口内')
  assert.equal(a.interact('hover', t + 21_000).quiet, false, '超过 20 秒应该恢复')
})

ok('⭐ 反应间隔是**按动作**各算各的（甩一下不该把悬停也静音）', () => {
  const a = createAffection()
  const t = 5_000_000
  assert.equal(a.interact('fling', t).quiet, false)
  assert.equal(a.interact('hover', t + 100).quiet, false, 'hover 有它自己的间隔')
})

ok('⭐⭐ pat 的分级文案：1/2/3 级不同，越界夹到合法范围', () => {
  const a = createAffection()
  const t = 6_000_000
  const seen = new Set()
  for (const lv of [1, 2, 3]) {
    const r = a.interact('pat', t + lv * 30_000, { level: lv })
    seen.add(r.text.zh)
  }
  assert.equal(seen.size, 3, '三级文案应该互不相同')
  // 越界：0/NaN → 第 1 级；99 → 最高级
  const r0 = a.interact('pat', t + 200_000, { level: 0 })
  assert.equal(r0.text.zh, '嗯…？', 'level=0 该回落第 1 级')
  const r99 = a.interact('pat', t + 300_000, { level: 99 })
  assert.equal(r99.text.zh, '好啦好啦，我快睡着了。', 'level=99 该夹到最高级')
})

ok('⭐ 情境倍率真的打折（且只作用在收益上，不改记账口径）', () => {
  const a = createAffection()
  const t = 7_000_000
  // 满额摸头是 2；倍率 0.5 → 1
  const r = a.interact('pet-head', t, { gainMul: 0.5 })
  assert.equal(r.gain, 1, '0.5 倍应该得到 1 分')
  assert.equal(r.gainMul, 0.5)
  assert.equal(a.internals.points, 1, '点数必须是折后值（不是先记满再扣）')
  assert.equal(a.internals.todayGain, 1, '今日已得也必须是折后值（两者不能分叉）')
})

ok('⭐⭐ 倍率被夹进 [0,1]（情境只能打折，绝不能加成）', () => {
  // 允许加成的话，"单日潜在收益能跨过第二档"那条设计不变式就要按
  // "所有情境同时生效"重算 —— 而那是算不出来的（情境互斥，组合未知）。
  const a = createAffection()
  const t = 8_000_000
  const r1 = a.interact('praise', t, { gainMul: 99 })
  assert.equal(r1.gain, 8, '倍率超过 1 必须被夹回 1（praise 满额 8）')
  assert.equal(r1.gainMul, 1)
  const r2 = a.interact('praise', t + 200_000, { gainMul: -5 })
  assert.equal(r2.gain, 0, '负倍率夹到 0')
  const r3 = a.interact('feed', t, { gainMul: NaN })
  assert.equal(r3.gain, 5, 'NaN 倍率回落 1（不打折），而不是 0')
})

ok('倍率 0 时仍然"有反应"（睡着了摸她：不给分，但说话）', () => {
  const a = createAffection()
  const t = 9_000_000
  const r = a.interact('pet-head', t, { gainMul: 0 })
  assert.equal(r.gain, 0)
  assert.equal(r.accepted, true)
  assert.ok(r.text !== null, '倍率 0 不该把反应也一起吃掉')
})

ok('⭐ 未知动作仍然拒绝（不因为加了新动作就放宽）', () => {
  const a = createAffection()
  for (const bad of ['__proto__', 'toString', 'PRAISE', 'pat ', '', null]) {
    const r = a.interact(bad, 1_000_000)
    assert.equal(r.accepted, false, `${bad} 不该被接受`)
    assert.equal(r.reason, 'unknown-kind')
  }
})

/* ══════════════════════════════════════════════════════════════════════════
 * v13.5：右键菜单「切换她的姿势」的中文状态名
 *
 * 用户原话："表情预览，为什么那几个全都是英文"。
 * exe 侧现在有一份 `StateLabelsZh` 表（`pet/Program.cs`），
 * 而**唯一真相**是 Host 的 `src/pet/state.js` 的 `STATE_TEXT`。
 * 这里逐条比对，**漂移直接变红** —— 本项目对"重复一份"的一贯要求。
 * ══════════════════════════════════════════════════════════════════════════ */

section('v13.5 菜单里的状态中文名与 Host 一致')

/** 从 C# 源码里抠出 `StateLabelsZh` 的 {状态 → 中文}。 */
function parseStateLabelsZh () {
  const src = fs.readFileSync(path.join(ROOT, 'pet', 'Program.cs'), 'utf8')
  const start = src.indexOf('StateLabelsZh = new string[][]')
  assert.ok(start > 0, 'Program.cs 里找不到 StateLabelsZh（表被删了？）')
  const body = src.slice(start, src.indexOf('};', start))
  const out = {}
  for (const m of body.matchAll(/new string\[\]\s*\{\s*"([a-z-]+)"\s*,\s*"([^"]+)"\s*\}/g)) {
    out[m[1]] = m[2]
  }
  return out
}

ok('⭐ 菜单里的每个状态名都与 Host 的 STATE_TEXT 中文一致', () => {
  const labels = parseStateLabelsZh()
  assert.ok(Object.keys(labels).length >= 9, `只解析到 ${Object.keys(labels).length} 条，表被改坏了`)
  const mismatched = []
  for (const [state, zh] of Object.entries(labels)) {
    const host = STATE_TEXT[state]
    if (!host) { mismatched.push(`${state}：Host 里没有这个状态`); continue }
    if (host.zh !== zh) mismatched.push(`${state}：exe="${zh}" vs Host="${host.zh}"`)
  }
  assert.deepEqual(mismatched, [],
    `exe 的中文状态名与 Host 漂移了（改一边要改另一边）：\n      ${mismatched.join('\n      ')}`)
})

ok('⭐ 菜单覆盖 Host 的全部状态（漏一个就会在菜单里露出英文）', () => {
  const labels = parseStateLabelsZh()
  const missing = Object.keys(STATE_TEXT).filter(s => labels[s] === undefined)
  assert.deepEqual(missing, [],
    `这些状态没有中文名，菜单里会直接显示英文：${missing.join(', ')}`)
})

ok('⭐ 中文名里不含 ASCII 状态名（防"中文 + 英文"半吊子）', () => {
  const labels = parseStateLabelsZh()
  const bad = Object.entries(labels).filter(([, zh]) => /^[\x00-\x7F]+$/.test(zh))
  assert.deepEqual(bad.map(([s]) => s), [], '有状态名仍是纯 ASCII（等于没翻译）')
})

ok('⭐⭐ 子菜单**真的用了**中文名（不是只在旁边放了一张没用的表）', () => {
  // ⚠️ 为什么需要这条（回滚 N1 全绿）：上面三条只验"表本身对不对"，
  // 而把 `mi.Header = StateLabelZh(st)` 改回 `= st`（菜单又变英文）时，
  // **表还在、也仍然正确** → 三条断言照样全绿。判据必须落在**接线**上。
  const src = fs.readFileSync(path.join(ROOT, 'pet', 'Program.cs'), 'utf8')
  assert.ok(src.includes('mi.Header = StateLabelZh(st)'),
    '状态子菜单没有用 StateLabelZh（菜单里会显示 idle/thinking 这些英文）')
})

/* ══════════════════════════════════════════════════════════════════════════
 * v13.5：三个「表情」入口的命名（用户："这几个命名让人很困惑呀"）
 *
 * 原来三处都带"表情"，但**指的是两样东西**：
 *   · 表情包…       → 气泡里那张贴图（bubble 素材）
 *   · 表情预览 / 切换表情预览 → 她本人的姿势（sprite 状态）
 * 现在按"动的是谁"分开：气泡叫「表情包」，她本人叫「姿势」。
 * ══════════════════════════════════════════════════════════════════════════ */

section('v13.5 三个入口的命名不再撞车')

ok('⭐⭐ 右键菜单里「姿势」与「表情包」各司其职，不再都叫"表情"', () => {
  // ⚠️ 为什么扫源码（回滚 N3 全绿）：菜单项是 `Program.BuildPetMenu` 里
  // 逐个 new 出来的，没有可枚举的"菜单清单"数据。而 `BuildPetMenu` 是私有方法、
  // 需要一个活的 `PetApp` 才能跑 —— 所以这里以**源码字面量**为判据。
  // 它不精确（可能匹配到注释），但足以挡住"改回旧名"这类真实回归，
  // 与 `test-pet-assets.mjs` 验"台词有没有接线"用的是同一手法。
  const src = fs.readFileSync(path.join(ROOT, 'pet', 'Program.cs'), 'utf8')
  const needed = [
    ['gallery.Header = "表情包…(_G)"', '气泡贴图那个入口应叫「表情包」'],
    ['preview.Header = "切换她的姿势(_E)"', '换她本人姿势那个入口应叫「切换她的姿势」'],
    ['next.Header = "换下一个姿势(_N)"', '轮换那个入口应叫「换下一个姿势」']
  ]
  const missing = needed.filter(([lit]) => !src.includes(lit)).map(([, why]) => why)
  assert.deepEqual(missing, [], `菜单命名不符：\n      ${missing.join('\n      ')}`)
})

ok('⭐ 不再有两个入口共用同一个词（"表情"只留给气泡贴图）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pet', 'Program.cs'), 'utf8')
  // 旧名必须消失 —— 它们正是用户说"困惑"的那两个
  const stale = ['"表情预览(_E)"', '"切换表情预览(_N)"']
  const left = stale.filter(s => src.includes(s))
  assert.deepEqual(left, [], `旧名还在（用户已明确说困惑）：${left.join(', ')}`)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败项'}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
