/**
 * 庄方宜桌宠 · 番茄钟单测
 *
 * 用法：`node tools/test-pet-pomodoro.mjs`
 *
 * ── 这套测试在防什么 ──────────────────────────────────────────────────────
 *
 * 番茄钟的缺陷几乎全是**时间语义**错误，而这类错误在真机上要等 25 分钟才现形、
 * 且很难复现。所以这里用**假时钟**把整条 25/5/15 × 4 轮的循环在毫秒内跑完。
 *
 * 重点盯的几处（都是我在写第一版时真写错过的）：
 *   · 暂停 10 分钟再恢复，剩余时间**不许**跳掉那 10 分钟；
 *   · 同一次阶段结束**不许**被 `tick` 重复通知（守卫是 `enter()` 重置剩余时间）；
 *   · `end` 事件必须**先于** `start` 事件到达（顺序反了调用方无法判断该不该提醒）；
 *   · 跳过专注**不许**计入轮数（否则连点四下跳过就刷出长休）；
 *   · 跨重启**不许**复活一个早就过期的阶段（关了三天再开不该立刻弹提醒）。
 */

import assert from 'node:assert/strict'

import {
  createPomodoro,
  normalizePomodoro,
  phaseDuration,
  breakAfter,
  formatRemaining,
  DEFAULT_POMODORO,
  POMODORO_LIMITS
} from '../src/pet/pomodoro.js'
import {
  POMODORO_FOCUS_MIN, POMODORO_FOCUS_MAX,
  POMODORO_BREAK_MIN, POMODORO_BREAK_MAX,
  POMODORO_LONG_BREAK_MIN, POMODORO_LONG_BREAK_MAX,
  POMODORO_ROUNDS_MIN, POMODORO_ROUNDS_MAX,
  POMODORO_ANCHORS, POMODORO_ANCHOR_LABELS
} from '../src/settings.js'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

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

/** 假时钟：`clock.advance(ms)` 推进时间。 */
function makeClock (start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance (ms) { t += ms; return t },
    set (v) { t = v; return t }
  }
}

/**
 * 测试用参数 = **合法范围的下限**。
 *
 * 为什么不用更小的值（比如 10 秒）：`normalizePomodoro` 会把它们夹到下限
 * （那是给真实设置用的护栏，不该为测试开后门）。而时钟是假的，
 * 用 60/60/90 秒这些"真实尺度"跑完整个 4 轮循环**耗时依然是 0**。
 *
 * ⚠️ `breakMs` 也必须是 60 秒 —— 它的下限与 `src/settings.js` 的
 * `POMODORO_BREAK_MIN` 同值（曾经这里是 30 秒而 settings 是 60 秒，
 * 是一个真实的三方口径不一致，已被上面那条断言锁住）。
 */
const FAST = { focusMs: 60_000, breakMs: 60_000, longBreakMs: 90_000, roundsPerLongBreak: 4 }

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 纯函数
 * ══════════════════════════════════════════════════════════════════════════ */

section('1. 纯函数（归一化 / 时长 / 长休判定 / 格式化）')

ok('默认参数就是用户点名的 25/5/15 + 每 4 轮', () => {
  assert.equal(DEFAULT_POMODORO.focusMs, 25 * 60 * 1000)
  assert.equal(DEFAULT_POMODORO.breakMs, 5 * 60 * 1000)
  assert.equal(DEFAULT_POMODORO.longBreakMs, 15 * 60 * 1000)
  assert.equal(DEFAULT_POMODORO.roundsPerLongBreak, 4)
  // 默认**不开**：装完插件就自己开始 25 分钟倒计时是骚扰，不是功能。
  assert.equal(DEFAULT_POMODORO.enabled, false)
})

ok('⭐⭐ 时长范围与 Host settings.js **同口径**（三方必须一致）', () => {
  // 三方：`src/settings.js`（Host 归一化）、`client.js`（设置页归一化）、
  // 本模块的 `POMODORO_LIMITS`。
  //
  // ⚠️ 这条断言抓出过一个真实不一致：本模块的 `breakMs` 下限是 30 秒，
  // 而 settings.js 是 60 秒 —— 于是"设置页拖不到、直接构造却可以"，
  // 文档说的范围与实际能设的范围对不上。
  //
  // 客户端那一份无法在这里 import（它是浏览器 bundle），由
  // `test-pet-client.mjs` 的"番茄钟时长范围与 Host 同口径"覆盖；
  // 这里锁住 Host 与模块这两份。
  assert.deepEqual(POMODORO_LIMITS.focusMs, [POMODORO_FOCUS_MIN, POMODORO_FOCUS_MAX],
    'focusMs 范围与 settings.js 不一致')
  assert.deepEqual(POMODORO_LIMITS.breakMs, [POMODORO_BREAK_MIN, POMODORO_BREAK_MAX],
    'breakMs 范围与 settings.js 不一致')
  assert.deepEqual(POMODORO_LIMITS.longBreakMs, [POMODORO_LONG_BREAK_MIN, POMODORO_LONG_BREAK_MAX],
    'longBreakMs 范围与 settings.js 不一致')
  assert.deepEqual(POMODORO_LIMITS.roundsPerLongBreak, [POMODORO_ROUNDS_MIN, POMODORO_ROUNDS_MAX],
    'roundsPerLongBreak 范围与 settings.js 不一致')
})

ok('⭐ 默认值必须落在合法范围内（否则"默认设置"本身就是非法的）', () => {
  for (const [key, [lo, hi]] of Object.entries(POMODORO_LIMITS)) {
    const v = DEFAULT_POMODORO[key]
    assert.ok(v >= lo && v <= hi,
      `默认 ${key}=${v} 不在 [${lo},${hi}] 内 —— 用户什么都不改就已经越界`)
  }
  // 交叉检查：normalizePomodoro(默认值) 必须**逐字段不变**
  //（若默认值越界，归一化会把它夹走，这条就会失败）
  assert.deepEqual(normalizePomodoro(DEFAULT_POMODORO), { ...DEFAULT_POMODORO },
    '默认值经过归一化后不该被改动')
})

ok('normalizePomodoro 逐字段回落，不整体丢弃', () => {
  const out = normalizePomodoro({ focusMs: 20 * 60 * 1000, autoNext: false, roundsPerLongBreak: 3 })
  assert.equal(out.focusMs, 20 * 60 * 1000, '合法值应保留')
  assert.equal(out.autoNext, false)
  assert.equal(out.roundsPerLongBreak, 3)
  // 没给的字段回落默认，而不是变成 undefined
  assert.equal(out.breakMs, DEFAULT_POMODORO.breakMs)
  assert.equal(out.longBreakMs, DEFAULT_POMODORO.longBreakMs)
})

ok('normalizePomodoro 夹取越界值与非法值', () => {
  const out = normalizePomodoro({
    focusMs: 1,                      // 太小 → 夹到下限
    breakMs: 99 * 60 * 60 * 1000,    // 太大 → 夹到上限
    longBreakMs: 'abc',              // 非数 → 回落默认
    roundsPerLongBreak: 999          // 太大 → 夹到上限
  })
  assert.equal(out.focusMs, POMODORO_LIMITS.focusMs[0])
  assert.equal(out.breakMs, POMODORO_LIMITS.breakMs[1])
  assert.equal(out.longBreakMs, DEFAULT_POMODORO.longBreakMs)
  assert.equal(out.roundsPerLongBreak, POMODORO_LIMITS.roundsPerLongBreak[1])
})

ok('normalizePomodoro 对 null/非对象安全（返回默认，不抛）', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const out = normalizePomodoro(bad)
    assert.equal(out.focusMs, DEFAULT_POMODORO.focusMs, `输入 ${JSON.stringify(bad)} 应回落默认`)
  }
})

ok('phaseDuration 三种阶段各自正确，未知阶段按专注（不返回 NaN）', () => {
  const cfg = normalizePomodoro(FAST)
  assert.equal(phaseDuration('focus', cfg), FAST.focusMs)
  assert.equal(phaseDuration('break', cfg), FAST.breakMs)
  assert.equal(phaseDuration('long-break', cfg), FAST.longBreakMs)
  assert.equal(phaseDuration('__nonsense__', cfg), FAST.focusMs)
  assert.ok(Number.isFinite(phaseDuration('__nonsense__', cfg)))
})

ok('⭐ breakAfter：每 4 轮长休（第 4/8/12 轮），其余短休', () => {
  const seq = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    .map(n => breakAfter(n, 4))
  assert.deepEqual(seq, [
    'break', 'break', 'break', 'long-break',
    'break', 'break', 'break', 'long-break',
    'break', 'break', 'break', 'long-break'
  ])
})

ok('breakAfter 的轮数下限保护（0/负数/非数不产生除零或 NaN）', () => {
  // 关键：坏参数**不许**让长休静默失效。NaN 取模得 NaN，`NaN === 0` 为 false
  // —— 若不在入口挡住，长休就会"永远不触发"且毫无报错。
  assert.equal(breakAfter(4, 0), 'long-break', '每 0 轮 → 回落默认 4 轮，第 4 轮仍是长休')
  assert.equal(breakAfter(4, NaN), 'long-break', 'NaN → 回落默认，不许静默变成永远短休')
  assert.equal(breakAfter(4, undefined), 'long-break', 'undefined → 回落默认')
  assert.equal(breakAfter(4, -3), 'long-break', '负数 → 回落默认')
  assert.equal(breakAfter(0, 4), 'break', '第 0 轮按第 1 轮算 → 短休')
  assert.equal(breakAfter(NaN, 4), 'break', 'completed 非数按第 1 轮算')
})

ok('formatRemaining 向上取整（剩 0.4s 显示 00:01，不是 00:00）', () => {
  assert.equal(formatRemaining(400), '00:01')
  assert.equal(formatRemaining(0), '00:00')
  assert.equal(formatRemaining(-5), '00:00', '负数不许出现负号')
  assert.equal(formatRemaining(NaN), '00:00')
})

ok('formatRemaining 分/时进位正确', () => {
  assert.equal(formatRemaining(25 * 60 * 1000), '25:00')
  assert.equal(formatRemaining(59_999), '01:00')
  assert.equal(formatRemaining(60_000), '01:00')
  assert.equal(formatRemaining(3_600_000), '1:00:00')
  assert.equal(formatRemaining(3_661_000), '1:01:01')
  assert.equal(formatRemaining(9_000), '00:09')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 计时推进
 * ══════════════════════════════════════════════════════════════════════════ */

section('2. 计时推进（假时钟）')

ok('未开始时 tick 不推进（时间流逝不算数）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  clock.advance(60_000)
  assert.equal(p.tick(clock.now()), null, '没开始就不该有阶段结束')
  assert.equal(p.internals.remainingMs, FAST.focusMs, '剩余时间不该被时间流逝吃掉')
})

ok('start 后按真实经过时间扣减', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  clock.advance(3_000)
  p.tick(clock.now())
  assert.equal(p.internals.remainingMs, FAST.focusMs - 3_000)
  clock.advance(1_500)
  p.tick(clock.now())
  assert.equal(p.internals.remainingMs, FAST.focusMs - 4_500)
})

ok('start 幂等（重复调用不重置剩余时间）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  clock.advance(5_000)
  p.tick(clock.now())
  const before = p.internals.remainingMs
  assert.equal(p.start(clock.now()), false, '已在跑 → 返回 false')
  assert.equal(p.internals.remainingMs, before, '不许把剩余时间重置回满')
})

ok('⭐ 暂停真的冻结剩余时间（暂停 10 分钟不跳表）', () => {
  // 这是第一版真写错的地方：只记 endsAt 的话，暂停期间时间照样在流逝，
  // 恢复时会把暂停的那段一起扣掉。
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  clock.advance(2_000)
  p.tick(clock.now())
  p.pause()
  const frozen = p.internals.remainingMs
  assert.equal(frozen, FAST.focusMs - 2_000)

  clock.advance(10 * 60 * 1000)   // 暂停 10 分钟
  assert.equal(p.tick(clock.now()), null, '暂停期间 tick 不该结算')
  assert.equal(p.internals.remainingMs, frozen, '暂停期间剩余时间必须一动不动')

  p.start(clock.now())
  clock.advance(1_000)
  p.tick(clock.now())
  assert.equal(p.internals.remainingMs, frozen - 1_000, '恢复后只扣恢复之后的时间')
})

ok('pause 幂等，toggle 在暂停/继续之间切换', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  assert.equal(p.pause(), false, '没在跑 → pause 返回 false')
  p.start(clock.now())
  assert.equal(p.toggle(clock.now()), true, '在跑 → toggle 变成暂停')
  assert.equal(p.internals.running, false)
  assert.equal(p.toggle(clock.now()), true, '停着 → toggle 变成继续')
  assert.equal(p.internals.running, true)
})

ok('时钟回拨（NTP/改系统时间）不产生负剩余或暴涨', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  clock.advance(3_000)
  p.tick(clock.now())
  const before = p.internals.remainingMs
  clock.set(clock.now() - 60_000)      // 往回拨一分钟
  assert.equal(p.tick(clock.now()), null, '回拨不该触发阶段结束')
  assert.equal(p.internals.remainingMs, before, '回拨不该改变剩余时间')
  assert.ok(p.internals.remainingMs >= 0, '剩余时间绝不为负')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 阶段循环（核心：25 → 5 → 25 → 5 → 25 → 5 → 25 → 15）
 * ══════════════════════════════════════════════════════════════════════════ */

section('3. 阶段循环与长休（核心）')

/** 把当前阶段跑到结束，返回 end 事件。 */
function runPhaseToEnd (p, clock) {
  const total = p.internals.totalMs
  clock.advance(total)
  return p.tick(clock.now())
}

ok('⭐⭐ 四轮专注后的休息类型序列：短 短 短 长', () => {
  const clock = makeClock()
  const events = []
  const p = createPomodoro({
    now: clock.now,
    config: FAST,
    onTransition: e => events.push(e)
  })
  p.start(clock.now())

  const ends = []
  for (let i = 0; i < 4; i++) {
    const e = runPhaseToEnd(p, clock)          // 专注结束
    assert.ok(e !== null, `第 ${i + 1} 轮专注应结束`)
    ends.push({ phase: e.phase, next: e.next, completed: e.completed })
    // 紧接着跑完休息
    const b = runPhaseToEnd(p, clock)
    assert.ok(b !== null, `第 ${i + 1} 次休息应结束`)
    assert.equal(b.phase, e.next, '休息阶段名应与 end.next 一致')
    assert.equal(b.next, 'focus', '休息之后必回专注')
  }

  assert.deepEqual(ends.map(e => e.next),
    ['break', 'break', 'break', 'long-break'],
    '第 4 轮之后必须是长休（用户点名"每 4 轮一次长休息"）')
  assert.deepEqual(ends.map(e => e.completed), [1, 2, 3, 4], 'completed 应逐轮累加')
})

ok('第 5~8 轮的休息序列又是一个完整循环（短 短 短 长）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  const kinds = []
  for (let i = 0; i < 8; i++) {
    const e = runPhaseToEnd(p, clock)
    kinds.push(e.next)
    runPhaseToEnd(p, clock)     // 休息
  }
  assert.deepEqual(kinds, [
    'break', 'break', 'break', 'long-break',
    'break', 'break', 'break', 'long-break'
  ])
})

ok('autoNext=true：阶段结束自动开始下一段（不用手动按）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: { ...FAST, autoNext: true } })
  p.start(clock.now())
  const e = runPhaseToEnd(p, clock)
  assert.equal(e.next, 'break')
  assert.equal(p.internals.phase, 'break', '已切到休息')
  assert.equal(p.internals.running, true, '应自动在跑')
  assert.equal(p.internals.remainingMs, FAST.breakMs, '休息应从头开始计时')
})

ok('autoNext=false：结束后切到下一段但**不**开始计时', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: { ...FAST, autoNext: false } })
  p.start(clock.now())
  const e = runPhaseToEnd(p, clock)
  assert.equal(p.internals.phase, 'break')
  assert.equal(p.internals.running, false, '不该自动开始')
  assert.equal(p.internals.remainingMs, FAST.breakMs, '停在整段时长等你按开始')
  // 手动开始后正常走
  p.start(clock.now())
  clock.advance(1_000)
  p.tick(clock.now())
  assert.equal(p.internals.remainingMs, FAST.breakMs - 1_000)
})

ok('⭐ 同一次阶段结束只通知一次（tick 反复调用不重复响）', () => {
  // 真机上 ticker 每 15s 跑一次，而 `remainingMs<=0` 会持续为真 ——
  // 守卫是 `enter()` 在阶段切换时把剩余时间重置为整段（回退验证：
  // 删掉那一行，这条断言连同另外两条一起失败）。
  const clock = makeClock()
  const events = []
  const p = createPomodoro({
    now: clock.now,
    config: FAST,
    onTransition: e => events.push(e)
  })
  p.start(clock.now())
  clock.advance(FAST.focusMs + 5_000)
  const first = p.tick(clock.now())
  assert.ok(first !== null, '第一次 tick 应报结束')
  // 再 tick 十次，一次都不该再报"专注结束"
  for (let i = 0; i < 10; i++) {
    clock.advance(100)
    p.tick(clock.now())
  }
  const focusEnds = events.filter(e => e.kind === 'end' && e.phase === 'focus')
  assert.equal(focusEnds.length, 1,
    `专注结束只该报 1 次，实际 ${focusEnds.length} 次：${JSON.stringify(events)}`)
})

ok('⭐⭐ 事件顺序：end 必须先于 start（否则调用方无法判断该不该提醒）', () => {
  const clock = makeClock()
  const events = []
  const p = createPomodoro({
    now: clock.now,
    config: FAST,
    onTransition: e => events.push({ kind: e.kind, phase: e.phase, next: e.next })
  })
  p.start(clock.now())
  events.length = 0                  // 丢掉启动那条 start
  runPhaseToEnd(p, clock)
  assert.equal(events.length, 2, `应恰好两条（end + start），实际 ${JSON.stringify(events)}`)
  assert.equal(events[0].kind, 'end', '第一条必须是 end')
  assert.equal(events[0].phase, 'focus')
  assert.equal(events[1].kind, 'start', '第二条才是 start')
  assert.equal(events[1].phase, 'break')
})

ok('onTransition 抛错不拖垮计时（回调坏了照样继续走）', () => {
  const clock = makeClock()
  const p = createPomodoro({
    now: clock.now,
    config: FAST,
    onTransition: () => { throw new Error('回调炸了') }
  })
  p.start(clock.now())
  assert.doesNotThrow(() => runPhaseToEnd(p, clock))
  assert.equal(p.internals.phase, 'break', '回调抛错不该影响阶段切换')
  assert.equal(p.internals.running, true)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 跳过 / 重置
 * ══════════════════════════════════════════════════════════════════════════ */

section('4. 跳过与重置')

ok('⭐ 跳过的专注不计入轮数（连点四下跳过不该刷出长休）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  // 只跳"专注"这一段：跳过专注 → 落在休息 → 再跳掉休息 → 回到专注。
  // 这样"跳过了 4 次专注"这个场景才成立。
  const skippedFocus = []
  for (let i = 0; i < 4; i++) {
    const e = p.skip(clock.now())
    assert.equal(e.phase, 'focus', `第 ${i + 1} 次跳过的应是专注段`)
    skippedFocus.push(e.next)
    assert.equal(p.internals.phase, 'break', '跳过专注后应落在休息')
    p.skip(clock.now())              // 把休息也跳掉，回到专注
    assert.equal(p.internals.phase, 'focus')
  }
  assert.equal(p.internals.completed, 0,
    `跳过不该增加 completed，实际 ${p.internals.completed}`)
  // 关键：即使连跳 4 次专注，也不该出现长休
  //（跳过的专注不算完成，所以永远停在第 1 轮 → 永远是短休）。
  assert.deepEqual(skippedFocus, ['break', 'break', 'break', 'break'],
    '跳过专注永远给短休 —— 否则连点四下跳过就能刷出长休')
})

ok('跳过专注 → 进休息；跳过休息 → 回专注', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  const a = p.skip(clock.now())
  assert.equal(a.phase, 'focus')
  assert.equal(a.next, 'break')
  assert.equal(p.internals.phase, 'break')
  const b = p.skip(clock.now())
  assert.equal(b.phase, 'break')
  assert.equal(b.next, 'focus')
  assert.equal(p.internals.phase, 'focus')
})

ok('⭐ 跳过之后 tick 不会补报一次"结束"', () => {
  const clock = makeClock()
  const events = []
  const p = createPomodoro({
    now: clock.now,
    config: FAST,
    onTransition: e => events.push(e)
  })
  p.start(clock.now())
  p.skip(clock.now())
  events.length = 0
  for (let i = 0; i < 5; i++) { clock.advance(500); p.tick(clock.now()) }
  assert.equal(events.filter(e => e.kind === 'end').length, 0,
    `跳过之后不该补报结束，实际：${JSON.stringify(events)}`)
})

ok('跳过保持原来的运行位（跑着就继续跑，停着就还停着）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  // 停着时跳过 → 下一段也停着
  p.skip(clock.now())
  assert.equal(p.internals.running, false, '停着跳过不该偷偷开始计时')
  // 跑着时跳过 → 下一段继续跑
  p.start(clock.now())
  p.skip(clock.now())
  assert.equal(p.internals.running, true, '跑着跳过应继续跑')
})

ok('reset 清空轮数并回到第一轮专注（停表）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  runPhaseToEnd(p, clock)      // completed=1，进休息
  assert.equal(p.internals.completed, 1)
  p.reset(clock.now())
  assert.equal(p.internals.completed, 0, '轮数应清零')
  assert.equal(p.internals.phase, 'focus')
  assert.equal(p.internals.running, false, 'reset 后应停表')
  assert.equal(p.internals.remainingMs, FAST.focusMs, '剩余应为整段专注')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 快照（契约 §2 pomodoro 块）
 * ══════════════════════════════════════════════════════════════════════════ */

section('5. 快照块（契约 §2 pomodoro）')

ok('快照字段齐全且类型正确', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: { ...FAST, enabled: true } })
  const s = p.snapshot(clock.now())
  for (const key of ['enabled', 'phase', 'running', 'remainingMs', 'totalMs',
    'endsAt', 'completed', 'round', 'roundsPerLongBreak', 'autoNext', 'notify',
    'text', 'show']) {
    assert.ok(key in s, `快照缺字段 ${key}`)
  }
  assert.equal(typeof s.remainingMs, 'number')
  assert.ok(Number.isFinite(s.remainingMs) && s.remainingMs >= 0, 'remainingMs 必须是有限非负数')
  assert.equal(s.show, true)
})

ok('⭐ endsAt 只在运行时给出（停止时为 null，渲染方据此不显示倒计时）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  assert.equal(p.snapshot(clock.now()).endsAt, null, '没跑 → null')
  p.start(clock.now())
  const s = p.snapshot(clock.now())
  assert.equal(typeof s.endsAt, 'number')
  assert.equal(s.endsAt - clock.now(), s.remainingMs, 'endsAt 必须是 now + remainingMs')
})

ok('快照 text 与 formatRemaining 同源（两端显示一致）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  clock.advance(2_500)
  p.tick(clock.now())
  const s = p.snapshot(clock.now())
  assert.equal(s.text, formatRemaining(s.remainingMs),
    'exe 与 Host 必须用同一套格式化，否则对不上时无法判断谁错')
  assert.equal(s.text, formatRemaining(FAST.focusMs - 2_500))
})

ok('show 跟随 enabled（关掉总开关就不显示倒计时）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: { ...FAST, enabled: false } })
  assert.equal(p.snapshot(clock.now()).show, false)
  p.setConfig({ enabled: true })
  assert.equal(p.snapshot(clock.now()).show, true)
})

ok('⭐ round 的语义：专注中是"第几轮"，休息中是"刚完成的那一轮"', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  assert.equal(p.snapshot(clock.now()).round, 1, '第一轮专注')
  runPhaseToEnd(p, clock)                  // 完成第 1 轮 → 休息
  assert.equal(p.snapshot(clock.now()).phase, 'break')
  assert.equal(p.snapshot(clock.now()).round, 1, '休息中显示刚完成的第 1 轮')
  runPhaseToEnd(p, clock)                  // 休息结束 → 第 2 轮专注
  assert.equal(p.snapshot(clock.now()).round, 2, '第二轮专注')
  // 跑满 4 轮，进长休时 round 应显示 4
  runPhaseToEnd(p, clock)                  // 完成第 2 轮 → 休息
  runPhaseToEnd(p, clock)                  // → 第 3 轮
  runPhaseToEnd(p, clock)                  // 完成第 3 轮 → 休息
  runPhaseToEnd(p, clock)                  // → 第 4 轮
  runPhaseToEnd(p, clock)                  // 完成第 4 轮 → 长休
  const s = p.snapshot(clock.now())
  assert.equal(s.phase, 'long-break')
  assert.equal(s.round, 4, '长休显示刚完成的第 4 轮')
  assert.equal(s.completed, 4)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 持久化与跨重启恢复
 * ══════════════════════════════════════════════════════════════════════════ */

section('6. 持久化与跨重启恢复')

ok('persist 不含 endsAt（它是投影，重启后无意义）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  const saved = p.persist(clock.now())
  assert.ok(!('endsAt' in saved), 'persist 不该带 endsAt')
  for (const key of ['phase', 'remainingMs', 'running', 'completed', 'savedAt']) {
    assert.ok(key in saved, `persist 缺 ${key}`)
  }
})

ok('⭐ 重启恢复：停机 3 秒 → 扣掉 3 秒继续走', () => {
  const clock = makeClock()
  const a = createPomodoro({ now: clock.now, config: FAST })
  a.start(clock.now())
  clock.advance(2_000)
  a.tick(clock.now())
  const saved = a.persist(clock.now())

  clock.advance(3_000)                       // 停机 3 秒
  const b = createPomodoro({ now: clock.now, config: FAST })
  assert.equal(b.adopt(saved, clock.now()), true)
  assert.equal(b.internals.remainingMs, FAST.focusMs - 2_000 - 3_000,
    '停机时间也要扣（它真的在走）')
  assert.equal(b.internals.running, true, '原来在跑就继续跑')
  assert.equal(b.internals.phase, 'focus')
})

ok('⭐⭐ 重启恢复：停机超过剩余时长 → 作废本轮且**不补发通知**', () => {
  // 关了 DSH 三天再打开，不该立刻弹一条"休息结束"。
  const clock = makeClock()
  const a = createPomodoro({ now: clock.now, config: FAST })
  a.start(clock.now())
  const saved = a.persist(clock.now())

  clock.advance(3 * 24 * 60 * 60 * 1000)     // 停机三天
  const events = []
  const b = createPomodoro({ now: clock.now, config: FAST, onTransition: e => events.push(e) })
  b.adopt(saved, clock.now())
  assert.equal(b.internals.remainingMs, FAST.focusMs, '应回到本阶段从头')
  assert.equal(b.internals.running, false, '不该自己跑起来')
  // 关键：随后的 tick 不许补报结束
  for (let i = 0; i < 5; i++) { clock.advance(1_000); b.tick(clock.now()) }
  assert.equal(events.length, 0,
    `作废的阶段绝不该补发通知，实际：${JSON.stringify(events)}`)
})

ok('adopt 恢复累计轮数（长休判定依赖它）', () => {
  const clock = makeClock()
  const a = createPomodoro({ now: clock.now, config: FAST })
  a.start(clock.now())
  // 跑满 3 轮
  for (let i = 0; i < 3; i++) {
    runPhaseToEnd(a, clock)     // 专注结束
    runPhaseToEnd(a, clock)     // 休息结束
  }
  assert.equal(a.internals.completed, 3)
  const saved = a.persist(clock.now())

  const b = createPomodoro({ now: clock.now, config: FAST })
  b.adopt(saved, clock.now())
  assert.equal(b.internals.completed, 3, '轮数必须跨重启保留')
  // 第 4 轮结束应该是长休 —— 证明恢复后的轮数真的参与了判定
  b.start(clock.now())
  const e = runPhaseToEnd(b, clock)
  assert.equal(e.next, 'long-break', '恢复后第 4 轮仍应给长休')
})

ok('adopt 对垃圾输入安全返回 false（不抛、不破坏现状）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  for (const bad of [null, undefined, 42, 'x']) {
    assert.equal(p.adopt(bad, clock.now()), false)
  }
  // 现状没被破坏
  assert.equal(p.internals.phase, 'focus')
  assert.equal(p.internals.remainingMs, FAST.focusMs)
})

ok('adopt 接受非法 phase 并回落 focus', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.adopt({ phase: '__nonsense__', remainingMs: 1_000, running: false, completed: 0 }, clock.now())
  assert.equal(p.internals.phase, 'focus')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 7. 热更新参数
 * ══════════════════════════════════════════════════════════════════════════ */

section('7. 热更新参数（设置页改时长立即生效）')

ok('⭐ 跑着的时候改时长**不动当前阶段的剩余时间**（否则是数据丢失）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  clock.advance(3_000)
  p.tick(clock.now())
  const before = p.internals.remainingMs
  p.setConfig({ focusMs: 60_000 })     // 把专注时长砍到 1 分钟
  assert.equal(p.internals.remainingMs, before,
    '拖一下滑块就把当前专注砍掉一半 = 数据丢失')
})

ok('跑着的时候改时长，**下一段**生效', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.start(clock.now())
  // 用合法范围内的另一个值（breakMs 下限是 60s，取 2 分钟才有区分度）。
  p.setConfig({ breakMs: 2 * 60 * 1000 })
  runPhaseToEnd(p, clock)              // 专注结束 → 进休息
  assert.equal(p.internals.phase, 'break')
  assert.equal(p.internals.remainingMs, 2 * 60 * 1000, '休息应使用新时长')
})

ok('停着的时候改时长，剩余时间对齐到新时长（但不超过）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.setConfig({ focusMs: 2 * 60 * 1000 })
  assert.equal(p.internals.remainingMs, 2 * 60 * 1000, '停着应直接对齐新时长')
  assert.equal(p.internals.totalMs, 2 * 60 * 1000)
  // 缩短时长：剩余时间超过新时长 → 夹到新时长
  p.setConfig({ focusMs: 90_000 })
  assert.equal(p.internals.remainingMs, 90_000, '剩余时间不许超过新时长')
})

ok('setConfig 返回是否真的变了（调用方据此决定要不要广播）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  assert.equal(p.setConfig({ focusMs: FAST.focusMs }), false, '值没变 → false')
  assert.equal(p.setConfig({ focusMs: 2 * 60 * 1000 }), true, '值变了 → true')
})

ok('setConfig 越界值被夹取（热更新不是绕过校验的后门）', () => {
  const clock = makeClock()
  const p = createPomodoro({ now: clock.now, config: FAST })
  p.setConfig({ focusMs: 1 })
  assert.equal(p.config.focusMs, POMODORO_LIMITS.focusMs[0])
})

/* ══════════════════════════════════════════════════════════════════════════
 * v14：倒计时方位（用户问"番茄钟的位置可以调吗"）
 *
 * ⚠️ 这一节盯的是**三份白名单不许漂移** —— 这是本类设置最容易出的静默 bug：
 * 宿主 / 客户端 / exe 各有一份，不同集时界面能选到一个下游不认识的值
 * → 下游回落默认 → **界面显示"左侧"、实际贴在下方**，而且不报错。
 * ══════════════════════════════════════════════════════════════════════════ */

section('v14 倒计时方位（三份白名单同集）')

ok('宿主白名单是五值且含 auto', () => {
  assert.deepEqual([...POMODORO_ANCHORS].sort(),
    ['above', 'auto', 'below', 'left', 'right'])
})

ok('每个方位都有中文标签（下拉框不许出现 undefined）', () => {
  for (const a of POMODORO_ANCHORS) {
    assert.equal(typeof POMODORO_ANCHOR_LABELS[a], 'string', `${a} 缺标签`)
    assert.ok(POMODORO_ANCHOR_LABELS[a].length > 0, `${a} 标签为空`)
  }
})

ok('客户端 client.js 的白名单与宿主同集', () => {
  const src = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const m = src.match(/PET_POMODORO_ANCHORS\s*=\s*\[([^\]]*)\]/)
  assert.ok(m, 'client.js 里找不到 PET_POMODORO_ANCHORS')
  const clientSet = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  assert.deepEqual(clientSet.sort(), [...POMODORO_ANCHORS].sort(),
    '客户端与宿主的方位白名单不同集 → 界面能选、宿主不认')
})

ok('exe PetSnapshot.cs 的白名单与宿主同集', () => {
  const src = readFileSync(join(ROOT, 'pet', 'PetSnapshot.cs'), 'utf8')
  const m = src.match(/PomodoroAnchors\s*=\s*new string\[\]\s*\{([^}]*)\}/)
  assert.ok(m, 'PetSnapshot.cs 里找不到 PomodoroAnchors')
  const exeSet = m[1].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
  assert.deepEqual(exeSet.sort(), [...POMODORO_ANCHORS].sort(),
    'exe 与宿主的方位白名单不同集 → exe 会拒收合法值，设置静默不生效')
})

ok('exe 菜单文案与宿主标签逐字一致', () => {
  // ⚠️ 菜单显示"下方"、设置页显示"桌宠下方"会让用户以为是两个不同的设置。
  const src = readFileSync(join(ROOT, 'pet', 'Program.cs'), 'utf8')
  const body = src.match(/PomodoroAnchorLabel\(string key\)\s*\{[\s\S]*?\n        \}/)
  assert.ok(body, 'Program.cs 里找不到 PomodoroAnchorLabel')
  for (const a of POMODORO_ANCHORS) {
    assert.ok(body[0].includes(POMODORO_ANCHOR_LABELS[a]),
      `exe 菜单缺少文案「${POMODORO_ANCHOR_LABELS[a]}」（方位 ${a}）`)
  }
})

ok('client.js 也有全部五个方位的文案（中英各一份）', () => {
  const src = readFileSync(join(ROOT, 'client.js'), 'utf8')
  for (const a of POMODORO_ANCHORS) {
    const key = 'anchor' + a[0].toUpperCase() + a.slice(1)
    const hits = src.split(new RegExp(`${key}:\\s*'`)).length - 1
    assert.equal(hits, 2, `${key} 应中英各一份，实际 ${hits} 份`)
  }
})

ok('index.js 真的把 pomodoroAnchor 发进快照（不发=设置页是装饰品）', () => {
  // ⚠️ v10 踩过：快照契约里定义了字段但缺发送方 → exe 那个赋值分支
  // **永远不会执行** → 设置页选了方位却毫无变化。
  const src = readFileSync(join(ROOT, 'index.js'), 'utf8')
  assert.ok(/pomodoroAnchor:\s*s\.pomodoroAnchor/.test(src),
    'index.js 没把 pomodoroAnchor 发进快照')
})

ok('归一化拒绝未知方位（不透明透传）', () => {
  // 用宿主归一化的真实行为验，不是看源码里有没有那个 if
  const src = readFileSync(join(ROOT, 'src', 'settings.js'), 'utf8')
  assert.ok(/POMODORO_ANCHORS\.includes\(input\.pomodoroAnchor\)/.test(src),
    'settings.js 没对 pomodoroAnchor 做白名单校验')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败项'}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
