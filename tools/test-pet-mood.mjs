/**
 * src/pet/mood.js 的单测（情境感应）。
 *
 * 为什么这个模块值得一个专门的文件：它是**唯一**能被穷举的组合表
 * （7 情境 × 7 动作），而它的失败方式是静默的 —— 情境判错只会让台词
 * 不太对，不会有任何报错。所以这里断言的重点是"每个组合都有说得通的结果"
 * 与三条设计不变式（gainMul ∈ [0,1]、未知输入不抛、默认文案不被复制）。
 */
import assert from 'node:assert/strict'
import {
  MOOD_IDS, MOOD_GAIN_MUL, MOOD_TEXT, moodContext, moodGainMul, moodFor, moodText
} from '../src/pet/mood.js'
import { INTERACT_KINDS, INTERACT_CONFIG, interactText } from '../src/pet/interactions.js'

let pass = 0
let fail = 0
function ok (name, fn) {
  try { fn(); pass++; console.log(`[ok]   ${name}`) } catch (e) {
    fail++
    console.log(`[FAIL] ${name} — ${e?.message ?? e}`)
  }
}

console.log('=== mood.js 情境感应 ===')

/* ── 情境判定 ─────────────────────────────────────────────────────────── */

ok('⭐ 睡着了优先于一切（包括番茄钟与档位）', () => {
  assert.equal(moodContext({
    petState: 'sleeping', pomodoroPhase: 'focus', pomodoroRunning: true, tier: 'trusted'
  }), 'asleep')
})

ok('⭐ 在忙的三个状态都算 busy（working/thinking/waiting）', () => {
  for (const s of ['working', 'thinking', 'waiting']) {
    assert.equal(moodContext({ petState: s }), 'busy', s)
  }
})

ok('出错了 → trouble', () => {
  assert.equal(moodContext({ petState: 'error' }), 'trouble')
})

ok('⭐ 番茄钟"专注中"要求 running=true（暂停不算）', () => {
  assert.equal(moodContext({ pomodoroPhase: 'focus', pomodoroRunning: true }), 'focus')
  // 暂停中：phase 还是 focus，但没在跑 —— 不该被记成摸鱼
  assert.equal(moodContext({ pomodoroPhase: 'focus', pomodoroRunning: false }), 'default')
})

ok('休息中（break / long-break）→ rest，同样要求 running', () => {
  assert.equal(moodContext({ pomodoroPhase: 'break', pomodoroRunning: true }), 'rest')
  assert.equal(moodContext({ pomodoroPhase: 'long-break', pomodoroRunning: true }), 'rest')
  assert.equal(moodContext({ pomodoroPhase: 'break', pomodoroRunning: false }), 'default')
})

ok('关系档位：close / trusted → close；stranger / familiar → default', () => {
  assert.equal(moodContext({ tier: 'close' }), 'close')
  assert.equal(moodContext({ tier: 'trusted' }), 'close')
  assert.equal(moodContext({ tier: 'stranger' }), 'default')
  assert.equal(moodContext({ tier: 'familiar' }), 'default')
})

ok('⭐⭐ 优先级：在忙 > 番茄钟 > 档位（睡着 > 一切）', () => {
  // 在忙 + 专注中 → busy（"她现在的心情"比"她在计时"更直接）
  assert.equal(moodContext({ petState: 'working', pomodoroPhase: 'focus', pomodoroRunning: true }), 'busy')
  // 专注中 + 关系近 → focus（档位不该改写"她在计时"这件事）
  assert.equal(moodContext({ pomodoroPhase: 'focus', pomodoroRunning: true, tier: 'trusted' }), 'focus')
  // 出错了 + 关系近 → trouble
  assert.equal(moodContext({ petState: 'error', tier: 'trusted' }), 'trouble')
})

ok('未知/缺失输入 → default（永不抛、永不返回 undefined）', () => {
  for (const bad of [undefined, null, {}, { petState: 'nonsense' }, { petState: 123 },
    { pomodoroPhase: 5, pomodoroRunning: 'yes' }, { tier: null }]) {
    const r = moodContext(bad)
    assert.ok(MOOD_IDS.includes(r), `${JSON.stringify(bad)} → ${r}`)
  }
  assert.equal(moodContext(undefined), 'default')
})

/* ── 收益倍率 ─────────────────────────────────────────────────────────── */

ok('⭐⭐ 收益倍率全部落在 [0,1]（只许打折，不许加成）', () => {
  for (const id of MOOD_IDS) {
    const v = MOOD_GAIN_MUL[id]
    assert.ok(Number.isFinite(v), `${id} 的倍率不是有限数`)
    assert.ok(v >= 0 && v <= 1, `${id} 的倍率 ${v} 越界`)
  }
})

ok('睡着了不给分（否则"等她睡着再摸"成了刷分最优解）', () => {
  assert.equal(MOOD_GAIN_MUL.asleep, 0)
})

ok('未知情境的倍率回落 1（不打折，而不是 0 —— 0 会静默吞掉所有收益）', () => {
  assert.equal(moodGainMul('nope'), 1)
  assert.equal(moodGainMul(undefined), 1)
  assert.equal(moodGainMul(null), 1)
})

/* ── 文案 ─────────────────────────────────────────────────────────────── */

ok('⭐ 每个情境 × 每个动作都有文案（或明确回落），不存在空洞', () => {
  for (const context of MOOD_IDS) {
    const table = MOOD_TEXT[context]
    assert.ok(table !== null && typeof table === 'object', `${context} 没有文案表`)
    for (const kind of INTERACT_KINDS) {
      const r = moodFor(kind, ctxOf(context), {
        fallback: { text: INTERACT_CONFIG[kind]?.text ?? null, voice: INTERACT_CONFIG[kind]?.voice ?? null }
      })
      // 允许 quiet 类动作（click/fling/hover 在 default 下可能没文案），
      // 但**每个组合都必须能算出结果且不抛**。
      assert.ok(MOOD_IDS.includes(r.context), `${context}/${kind} → ${r.context}`)
      assert.ok(typeof r.gainMul === 'number', `${context}/${kind} 没有 gainMul`)
      // 有文案时中英必须都在（只有一半的话切语言会掉进 key 名）。
      //
      // ⚠️ 判据是"**解析后**的文案"而不是原始 `text` 对象：`click` 的默认
      // 文案故意是 `{zh:null, en:null}`（不弹气泡），拿原始对象去查会把它
      // 误判成"缺中文" —— 我第一版就是这么写错的。
      const zh = moodText(r.text, 'zh')
      const en = moodText(r.text, 'en')
      if (zh !== null) assert.equal(typeof zh, 'string', `${context}/${kind} 中文不是字符串`)
      if (en !== null) assert.equal(typeof en, 'string', `${context}/${kind} 英文不是字符串`)
      // 中英必须成对：只有一半的话切语言会静默掉回中文（看起来像没翻译）
      assert.equal(zh === null, en === null, `${context}/${kind} 中英不成对（zh=${zh} en=${en}）`)
    }
  }
})

ok('⭐⭐ default 情境**不复制**默认文案（否则改默认台词时这里永远停在旧版本）', () => {
  assert.deepEqual(Object.keys(MOOD_TEXT.default), [])
  // 且真的回落到 interactions.js 的那份
  const r = moodFor('praise', { petState: 'idle' }, {
    fallback: { text: INTERACT_CONFIG.praise.text, voice: INTERACT_CONFIG.praise.voice }
  })
  assert.equal(r.context, 'default')
  assert.equal(r.text.zh, INTERACT_CONFIG.praise.text.zh)
})

ok('⭐ pat 的分级文案：1/2/3 级各不相同', () => {
  const seen = new Set()
  for (const lv of [1, 2, 3]) {
    // ⚠️ 必须在一个**写了分级文案的情境**里测。`default` 情境按设计是空表、
    // 全部回落到 `interactions.js` 的那一句 —— 在 default 里测分级，
    // 测的其实是"回落"，三级当然一样（我第一版就踩了这个）。
    const r = moodFor('pat', { petState: 'sleeping' }, { level: lv })
    assert.equal(r.context, 'asleep')
    const t = moodText(r.text, 'zh')
    assert.ok(typeof t === 'string' && t !== '', `第 ${lv} 级没有中文文案`)
    seen.add(t)
  }
  assert.equal(seen.size, 3, '三级文案应该互不相同（否则分级没有意义）')
})

ok('⭐ pat 级数越界：低于 1 夹到第 1 级，高于上限夹到最高级（都不返回空）', () => {
  // 两个方向是**不同**的夹取，混为一谈会漏掉一个：
  //   · 0 / 负数 / NaN / 非数字 → 第 1 级（当作"刚碰到"）；
  //   · 99（超出上限）→ **最高级**，而不是第 1 级、也不是什么都不弹。
  const first = moodText(moodFor('pat', { petState: 'sleeping' }, { level: 1 }).text, 'zh')
  const top = moodText(moodFor('pat', { petState: 'sleeping' }, { level: 3 }).text, 'zh')
  assert.notEqual(first, top, '第 1 级与第 3 级的文案应该不同（否则这条断言测不出夹取）')
  for (const lv of [0, -5, NaN, undefined, null, 'x', '']) {
    assert.equal(moodText(moodFor('pat', { petState: 'sleeping' }, { level: lv }).text, 'zh'), first, `level=${lv}`)
  }
  for (const lv of [3, 4, 99, 1e9]) {
    assert.equal(moodText(moodFor('pat', { petState: 'sleeping' }, { level: lv }).text, 'zh'), top, `level=${lv}`)
  }
})

ok('⭐⭐ 未知 kind / 未知情境：不抛，回落到 fallback', () => {
  const fb = { text: { zh: '兜底', en: 'fallback' }, voice: 'pet/click' }
  for (const kind of ['nope', '', null, undefined, '__proto__', 'toString']) {
    const r = moodFor(kind, { petState: 'idle' }, { fallback: fb })
    assert.equal(r.context, 'default')
    assert.equal(moodText(r.text, 'zh'), '兜底', `kind=${kind}`)
  }
  // 原型链上的情境 id 不该命中任何表
  assert.equal(moodContext({ petState: 'constructor' }), 'default')
})

ok('⭐ 没有 fallback 时也不抛（text 为 null = 不弹气泡）', () => {
  const r = moodFor('praise', { petState: 'idle' })
  assert.equal(r.context, 'default')
  assert.equal(r.text, null)
  assert.equal(moodText(r.text, 'zh'), null)
})

ok('情境覆盖了语音事件时用它，没覆盖时沿用动作自己的', () => {
  // 没有情境写 voice → 回落 fallback 的 voice
  const r = moodFor('praise', { petState: 'working' }, {
    fallback: { text: INTERACT_CONFIG.praise.text, voice: INTERACT_CONFIG.praise.voice }
  })
  assert.equal(r.context, 'busy')
  assert.equal(r.voice, INTERACT_CONFIG.praise.voice)
})

ok('本地化：zh/en 各取各的，缺一个时回落中文', () => {
  const r = moodFor('praise', { petState: 'sleeping' })
  assert.equal(moodText(r.text, 'zh'), '……嗯，梦里也听到了。')
  assert.equal(moodText(r.text, 'en'), '…mm, heard it in my dream.')
  assert.equal(moodText({ zh: '只有中文' }, 'en'), '只有中文')
  assert.equal(moodText(null, 'zh'), null)
})

ok('⭐⭐ 睡着了摸头：倍率 0 **但仍有反应**（不许"点了没反应"）', () => {
  const r = moodFor('pet-head', { petState: 'sleeping' }, {
    fallback: { text: INTERACT_CONFIG['pet-head'].text, voice: INTERACT_CONFIG['pet-head'].voice }
  })
  assert.equal(r.context, 'asleep')
  assert.equal(r.gainMul, 0)
  assert.ok(moodText(r.text, 'zh') !== null, '睡着了也必须有一句反应')
})

ok('专注中的摸头文案与默认不同（否则"情境感应"是假的）', () => {
  const focus = moodFor('pet-head', { pomodoroPhase: 'focus', pomodoroRunning: true })
  const dflt = moodFor('pet-head', { petState: 'idle' }, {
    fallback: { text: INTERACT_CONFIG['pet-head'].text, voice: INTERACT_CONFIG['pet-head'].voice }
  })
  assert.notEqual(moodText(focus.text, 'zh'), moodText(dflt.text, 'zh'))
})

ok('每个情境至少覆盖了 4 个动作（不许只有一个空壳）', () => {
  for (const id of MOOD_IDS) {
    if (id === 'default') continue
    const n = Object.keys(MOOD_TEXT[id]).length
    assert.ok(n >= 4, `${id} 只覆盖了 ${n} 个动作`)
  }
})

ok('interactText 与 mood 的口径一致（同一份默认文案）', () => {
  assert.equal(interactText('praise', 'zh'), INTERACT_CONFIG.praise.text.zh)
  assert.equal(interactText('click', 'zh'), null, 'click 故意不弹气泡')
  assert.equal(interactText('nope', 'zh'), null)
})

/* ── 情境 id 的构造（把 id 还原成 ctx，用于上面的穷举）──────────────────── */

function ctxOf (context) {
  switch (context) {
    case 'asleep': return { petState: 'sleeping' }
    case 'busy': return { petState: 'working' }
    case 'trouble': return { petState: 'error' }
    case 'focus': return { pomodoroPhase: 'focus', pomodoroRunning: true }
    case 'rest': return { pomodoroPhase: 'break', pomodoroRunning: true }
    case 'close': return { tier: 'trusted' }
    default: return { petState: 'idle' }
  }
}

console.log(`\n=== mood: ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
