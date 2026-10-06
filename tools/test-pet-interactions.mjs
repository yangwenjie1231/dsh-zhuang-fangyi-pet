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

ok('四个互动动作都有配置（用户点名的四项）', () => {
  assert.deepEqual(INTERACT_KINDS.sort(), ['click', 'feed', 'praise', 'pet-head'].sort())
  for (const k of INTERACT_KINDS) {
    const cfg = interactConfig(k)
    assert.ok(cfg !== null, `${k} 缺配置`)
    assert.equal(typeof cfg.gain, 'number')
    assert.ok(cfg.cooldownMs > 0, `${k} 必须有正冷却（否则可以按住刷）`)
    assert.ok(Array.isArray(cfg.diminish) && cfg.diminish.length > 0, `${k} 缺递减序列`)
    assert.equal(typeof cfg.label, 'string')
    assert.equal(typeof cfg.voice, 'string', `${k} 必须绑语音事件`)
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
  for (const k of INTERACT_KINDS) {
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
 * 汇总
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败项'}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
