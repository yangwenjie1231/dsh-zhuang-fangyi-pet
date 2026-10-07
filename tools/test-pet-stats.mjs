/**
 * src/pet/stats.js 的单测（番茄钟统计）。
 *
 * 重点在三条**容易写错、且错了不会报错**的地方：
 *   1. 跨天用本地日期（用 UTC 的话东八区早上 8 点前"今天"是昨天）；
 *   2. **今天还没番茄不算断签**（写错了表现是"打卡永远归零"）；
 *   3. 里程碑只发一次、且用**累计值**判定（增量式判定在跳级时会漏）。
 *
 * 时间全部注入假时钟 —— 真的等一天是不可能测的。
 */
import assert from 'node:assert/strict'
import {
  createStats, normalizeTask, recentDays, MILESTONES, KEEP_DAYS, TASK_MAX_CHARS, TASK_MAX_ENTRIES
} from '../src/pet/stats.js'
import { dayKeyFor } from '../src/pet/interactions.js'

let pass = 0
let fail = 0
function ok (name, fn) {
  try { fn(); pass++; console.log(`[ok]   ${name}`) } catch (e) {
    fail++
    console.log(`[FAIL] ${name} — ${e?.message ?? e}`)
  }
}

console.log('=== stats.js 番茄钟统计 ===')

/** 构造一个可控的假时钟（本地时间，避免时区把测试搞成 flaky）。 */
function clock (iso) {
  let t = new Date(iso).getTime()
  return {
    now: () => t,
    set (iso2) { t = new Date(iso2).getTime() },
    advance (ms) { t += ms },
    get value () { return t }
  }
}

const DAY = 24 * 60 * 60 * 1000

/* ── 记账 ─────────────────────────────────────────────────────────────── */

ok('记一轮专注：次数 / 时长 / 任务桶都对', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  s.setTask('桌宠开发')
  s.record({ focusMs: 25 * 60 * 1000 }, c.value)
  const snap = s.snapshot(c.value)
  assert.equal(snap.pomodoroCount, 1)
  assert.equal(snap.focusMs, 25 * 60 * 1000)
  assert.equal(snap.byTask.length, 1)
  assert.equal(snap.byTask[0].task, '桌宠开发')
  assert.equal(snap.byTask[0].ms, 25 * 60 * 1000)
})

ok('同一任务累加、不同任务分开记', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  s.record({ focusMs: 1000, task: 'A' }, c.value)
  s.record({ focusMs: 2000, task: 'A' }, c.value)
  s.record({ focusMs: 500, task: 'B' }, c.value)
  const by = Object.fromEntries(s.snapshot(c.value).byTask.map(x => [x.task, x.ms]))
  assert.equal(by.A, 3000)
  assert.equal(by.B, 500)
})

ok('byTask 按耗时降序（界面直接渲染，不必再排一次）', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  s.record({ focusMs: 100, task: 'small' }, c.value)
  s.record({ focusMs: 900, task: 'big' }, c.value)
  s.record({ focusMs: 500, task: 'mid' }, c.value)
  assert.deepEqual(s.snapshot(c.value).byTask.map(x => x.task), ['big', 'mid', 'small'])
})

ok('任务名归一化：去空白、合并空格、截断到 24 字', () => {
  assert.equal(normalizeTask('  桌宠   开发  '), '桌宠 开发')
  assert.equal(normalizeTask(''), '')
  assert.equal(normalizeTask('   '), '')
  assert.equal(normalizeTask(null), '')
  assert.equal(normalizeTask(123), '')
  assert.equal(normalizeTask('x'.repeat(100)).length, TASK_MAX_CHARS)
})

ok('任务桶限数：超出丢最小的，**保住刚记的那个**', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  for (let i = 0; i < TASK_MAX_ENTRIES + 3; i++) {
    s.record({ focusMs: 100 * (i + 1), task: `t${i}` }, c.value)
  }
  const by = s.snapshot(c.value).byTask
  assert.ok(by.length <= TASK_MAX_ENTRIES, `桶数 ${by.length} 超过上限`)
  // 刚记的那个（耗时最大）必须在
  assert.ok(by.some(x => x.task === `t${TASK_MAX_ENTRIES + 2}`), '最新的任务被丢掉了')
})

/* ── 跨天 ─────────────────────────────────────────────────────────────── */

ok('⭐⭐ 跨天用**本地日期**（不是 UTC）', () => {
  // 东八区 2026-10-08 07:00 = UTC 2026-10-07 23:00。
  // 用 UTC 的话会被记到 10-07 —— 而用户眼里的"今天"是 10-08。
  const c = clock('2026-10-08T07:00:00+08:00')
  const s = createStats({ now: c.now })
  s.record({ focusMs: 1000 }, c.value)
  const snap = s.snapshot(c.value)
  assert.equal(snap.dayKey, dayKeyFor(c.value))
  const local = new Date(c.value)
  assert.equal(snap.dayKey, `2026-10-08`, `本地日期算错了：${snap.dayKey}`)
  assert.ok(local.getHours() === 7, '测试前提：本地时间是早上 7 点')
})

ok('跨天之后今日计数清零（昨天的留在昨天）', () => {
  const c = clock('2026-10-07T23:00:00+08:00')
  const s = createStats({ now: c.now })
  s.record({ focusMs: 1000 }, c.value)
  s.record({ focusMs: 1000 }, c.value)
  assert.equal(s.snapshot(c.value).pomodoroCount, 2)
  c.set('2026-10-08T09:00:00+08:00')
  assert.equal(s.snapshot(c.value).pomodoroCount, 0, '新的一天应该从 0 开始')
  assert.equal(s.snapshot(c.value).dayKey, '2026-10-08')
})

ok('保留最近 30 天，更早的被裁掉', () => {
  const c = clock('2026-09-01T10:00:00+08:00')
  const s = createStats({ now: c.now })
  for (let i = 0; i < KEEP_DAYS + 10; i++) {
    c.set(new Date(new Date('2026-09-01T10:00:00+08:00').getTime() + i * DAY).toISOString())
    s.record({ focusMs: 1000 }, c.value)
  }
  assert.ok(s.internals.days.size <= KEEP_DAYS, `留了 ${s.internals.days.size} 天`)
})

/* ── 连续天数（最容易写错的一处）──────────────────────────────────────── */

ok('⭐⭐ 今天还没番茄 → **不算断签**（从昨天往回数）', () => {
  const c = clock('2026-10-05T10:00:00+08:00')
  const s = createStats({ now: c.now })
  // 10-05、10-06 各来一轮，然后跳到 10-07 早上（还没开始）
  s.record({ focusMs: 1000 }, c.value)
  c.set('2026-10-06T10:00:00+08:00')
  s.record({ focusMs: 1000 }, c.value)
  c.set('2026-10-07T08:00:00+08:00')
  // 今天 0 轮，但昨天有 —— 连续应该是 2，不是 0
  assert.equal(s.snapshot(c.value).streakDays, 2,
    '今天还没开始就被判成断签 —— 这是本模块最容易犯的错')
})

ok('⭐⭐ 断了一天就归零（隔天的缺口必须被发现）', () => {
  const c = clock('2026-10-05T10:00:00+08:00')
  const s = createStats({ now: c.now })
  s.record({ focusMs: 1000 }, c.value)
  // 跳过 10-06，直接在 10-07 记一轮
  c.set('2026-10-07T10:00:00+08:00')
  s.record({ focusMs: 1000 }, c.value)
  assert.equal(s.snapshot(c.value).streakDays, 1, '中间断了一天，连续应该是 1')
})

ok('连着三天 → streak 3；今天记了第 4 天 → 4', () => {
  const c = clock('2026-10-05T10:00:00+08:00')
  const s = createStats({ now: c.now })
  for (const d of ['2026-10-05', '2026-10-06', '2026-10-07']) {
    c.set(`${d}T10:00:00+08:00`)
    s.record({ focusMs: 1000 }, c.value)
  }
  assert.equal(s.snapshot(c.value).streakDays, 3)
  c.set('2026-10-08T10:00:00+08:00')
  s.record({ focusMs: 1000 }, c.value)
  assert.equal(s.snapshot(c.value).streakDays, 4)
})

/* ── 摸鱼计数 ─────────────────────────────────────────────────────────── */

ok('⭐ 摸鱼计数：本阶段累计，阶段结束（record）后清零', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  assert.equal(s.interrupt(), 1)
  assert.equal(s.interrupt(), 2)
  assert.equal(s.interrupt(), 3)
  assert.equal(s.phaseInterrupts(), 3)
  s.record({ focusMs: 1000, interrupts: 3 }, c.value)
  assert.equal(s.phaseInterrupts(), 0, '阶段结束后必须清零，否则下一轮会累加')
  // 今日总数保留
  assert.equal(s.snapshot(c.value).interrupts, 3)
})

ok('⭐⭐ 摸鱼次数**不许双重计数**（interrupt 已经写了今日总数）', () => {
  // 这条断言来自一个真实缺陷：`interrupt()` 是实时事件、它已经写了今日总数；
  // `record()` 若再写一次，一轮里摸 3 次会显示成"今天摸了 6 次" ——
  // 不报错，只让那个数字悄悄偏大一倍。
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  s.interrupt(); s.interrupt(); s.interrupt()
  s.record({ focusMs: 1000, interrupts: 3 }, c.value)
  assert.equal(s.snapshot(c.value).interrupts, 3, '摸 3 次就该是 3 次')
  // 显式传的 interrupts 只影响 cleanStreak，不该再改今日总数
  s.record({ focusMs: 1000, interrupts: 5 }, c.value)
  assert.equal(s.snapshot(c.value).interrupts, 3, 'record 的入参不该改今日总数')
})

ok('⭐⭐ 摸鱼次数要**先读再记账**（顺序反了点评永远是 0）', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  s.interrupt(); s.interrupt()
  // 正确的顺序：先读
  const readFirst = s.phaseInterrupts()
  s.record({ focusMs: 1000, interrupts: readFirst }, c.value)
  assert.equal(readFirst, 2)
  // 错误的顺序（先 record 再读）会拿到 0 —— 这条断言把那个坑钉住
  s.interrupt()
  s.record({ focusMs: 1000 }, c.value)
  assert.equal(s.phaseInterrupts(), 0)
})

/* ── 里程碑 ───────────────────────────────────────────────────────────── */

ok('⭐ 第一个番茄 → 达成 pomodoro-1，且**只发一次**', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  const r1 = s.record({ focusMs: 1000 }, c.value)
  assert.deepEqual(r1.milestones.map(m => m.key), ['pomodoro-1'])
  const r2 = s.record({ focusMs: 1000 }, c.value)
  assert.equal(r2.milestones.length, 0, '第二个番茄不该再发一次"第一个番茄"')
})

ok('⭐⭐ 里程碑用**累计值**判定（一次跳两级也不漏）', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  // 直接恢复成"已经 9 个"，再来一轮 → 应该同时达成 10（而 1 早已达成）
  s.adopt({ days: { '2026-10-06': { count: 9, focusMs: 0, interrupts: 0, byTask: {} } }, milestones: { 'pomodoro-1': 1 } })
  const r = s.record({ focusMs: 1000 }, c.value)
  assert.deepEqual(r.milestones.map(m => m.key), ['pomodoro-10'])
})

ok('累计专注时长里程碑（10 小时）', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  // 先记 9.5 小时
  s.record({ focusMs: 9.5 * 60 * 60 * 1000 }, c.value)
  const r = s.record({ focusMs: 40 * 60 * 1000 }, c.value)
  assert.ok(r.milestones.some(m => m.key === 'focus-10h'), '累计超过 10 小时该达成')
})

ok('连续天数里程碑（3 天）', () => {
  const c = clock('2026-10-05T10:00:00+08:00')
  const s = createStats({ now: c.now })
  s.record({ focusMs: 1000 }, c.value)
  c.set('2026-10-06T10:00:00+08:00'); s.record({ focusMs: 1000 }, c.value)
  c.set('2026-10-07T10:00:00+08:00')
  const r = s.record({ focusMs: 1000 }, c.value)
  assert.ok(r.milestones.some(m => m.key === 'streak-3'), '连续三天该达成')
})

ok('零打断里程碑（连续 5 轮干净）', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  let hit = false
  for (let i = 0; i < 5; i++) {
    const r = s.record({ focusMs: 1000, interrupts: 0 }, c.value)
    if (r.milestones.some(m => m.key === 'clean-5')) hit = true
  }
  assert.ok(hit, '连续 5 轮零打断该达成')
  // 被打断一次 → 计数归零，不该再次达成（但它已经达成过了，所以这里只验内部值）
  s.record({ focusMs: 1000, interrupts: 2 }, c.value)
  assert.equal(s.internals.cleanStreak, 0)
})

ok('里程碑定义：key 唯一、门槛是正数、中英文案齐全', () => {
  const keys = MILESTONES.map(m => m.key)
  assert.equal(new Set(keys).size, keys.length, '有重复的里程碑 key')
  for (const m of MILESTONES) {
    assert.ok(m.at > 0, `${m.key} 的门槛不是正数`)
    assert.ok(typeof m.label.zh === 'string' && m.label.zh !== '', `${m.key} 缺中文`)
    assert.ok(typeof m.label.en === 'string' && m.label.en !== '', `${m.key} 缺英文`)
  }
})

/* ── 持久化 ───────────────────────────────────────────────────────────── */

ok('persist → adopt 往返不丢数据', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  s.setTask('往返测试')
  s.record({ focusMs: 1234, task: '往返测试', interrupts: 2 }, c.value)
  const saved = s.persist(c.value)

  const c2 = clock('2026-10-07T11:00:00+08:00')
  const s2 = createStats({ now: c2.now })
  assert.equal(s2.adopt(saved), true)
  const a = s.snapshot(c.value)
  const b = s2.snapshot(c2.value)
  assert.equal(b.pomodoroCount, a.pomodoroCount)
  assert.equal(b.focusMs, a.focusMs)
  assert.equal(b.interrupts, a.interrupts)
  assert.equal(b.byTask[0].task, '往返测试')
  assert.equal(s2.task(), '往返测试')
  assert.deepEqual(s2.milestones(), s.milestones())
})

ok('adopt 对坏数据逐字段回落（不整体丢弃）', () => {
  const s = createStats({ now: () => Date.now() })
  // 怪键、坏值、非对象 —— 都不该让它抛
  const okAdopt = s.adopt({
    days: {
      '2026-10-07': { count: 'x', focusMs: -5, interrupts: 2, byTask: { A: 'bad', B: 100 } },
      'not-a-date': { count: 5 },
      '2026-10-06': null
    },
    milestones: { 'pomodoro-1': 123, '不存在的里程碑': 456 },
    cleanStreak: -3
  })
  assert.equal(okAdopt, true)
  assert.equal(s.internals.days.has('not-a-date'), false, '怪日期键不该进表')
  assert.equal(s.internals.days.has('2026-10-06'), false, 'null 的天不该进表')
  const d = s.internals.days.get('2026-10-07')
  assert.equal(d.count, 0, 'count 坏值该回落 0')
  assert.equal(d.focusMs, 0, '负的 focusMs 该回落 0')
  assert.equal(d.interrupts, 2)
  assert.equal(d.byTask.B, 100)
  assert.equal(d.byTask.A, undefined, '坏的 byTask 值该被丢掉')
  // 未定义的里程碑 key 不该进表（进了会让"新里程碑"永不触发）
  assert.deepEqual(Object.keys(s.milestones()), ['pomodoro-1'])
})

ok('adopt 非对象 → false（不抛）', () => {
  const s = createStats()
  for (const bad of [null, undefined, 42, 'x', []]) {
    // 数组是对象，adopt 会走进去；关键是**不抛**
    assert.doesNotThrow(() => s.adopt(bad))
  }
  assert.equal(s.adopt(null), false)
  assert.equal(s.adopt(42), false)
})

/* ── 快照 ─────────────────────────────────────────────────────────────── */

ok('⭐⭐ recent 趋势图**必须有真实数据**（全 0 是静默失败）', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  c.set('2026-10-05T10:00:00+08:00'); s.record({ focusMs: 1000 }, c.value)
  c.set('2026-10-06T10:00:00+08:00'); s.record({ focusMs: 2000 }, c.value)
  c.set('2026-10-07T10:00:00+08:00'); s.record({ focusMs: 3000 }, c.value)
  const recent = s.snapshot(c.value).recent
  assert.equal(recent.length, 7, '应该给 7 天')
  const map = Object.fromEntries(recent.map(r => [r.dayKey, r]))
  assert.equal(map['2026-10-05'].count, 1)
  assert.equal(map['2026-10-06'].focusMs, 2000)
  assert.equal(map['2026-10-07'].count, 1)
  // 升序
  const keys = recent.map(r => r.dayKey)
  assert.deepEqual(keys, [...keys].sort())
  // 没数据的补 0（趋势图不该有断点）
  assert.equal(map['2026-10-01'].count, 0)
})

ok('recentDays 不重复同一天（夏令时/时区边界）', () => {
  const at = new Date('2026-10-07T10:00:00+08:00').getTime()
  const days = recentDays(at, 7)
  assert.equal(new Set(days.map(d => d.dayKey)).size, days.length, '出现了重复的日期')
})

ok('goalCount 归一化：负数/非数字 → 0', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  assert.equal(s.snapshot(c.value, { goalCount: 8 }).goalCount, 8)
  assert.equal(s.snapshot(c.value, { goalCount: -3 }).goalCount, 0)
  assert.equal(s.snapshot(c.value, { goalCount: 'x' }).goalCount, 0)
  assert.equal(s.snapshot(c.value).goalCount, 0)
})

ok('focusMs 坏值不影响计数（计数与时长是两件事）', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  s.record({ focusMs: NaN }, c.value)
  s.record({ focusMs: -100 }, c.value)
  const snap = s.snapshot(c.value)
  assert.equal(snap.pomodoroCount, 2, '时长算不出来也该记一轮')
  assert.equal(snap.focusMs, 0)
})

ok('reset 清空一切', () => {
  const c = clock('2026-10-07T10:00:00+08:00')
  const s = createStats({ now: c.now })
  s.record({ focusMs: 1000 }, c.value)
  s.interrupt()
  s.reset()
  const snap = s.snapshot(c.value)
  assert.equal(snap.pomodoroCount, 0)
  assert.equal(snap.phaseInterrupts, 0)
  assert.deepEqual(s.milestones(), {})
})

console.log(`\n=== stats: ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
