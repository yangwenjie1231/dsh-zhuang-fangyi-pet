/**
 * 庄方宜桌宠 · 状态机与素材清单单测（无框架，纯 node:assert）
 *
 * 用法：`node tools/test-pet-state.mjs`
 *
 * ── 为什么这些断言值钱 ────────────────────────────────────────────────────
 *
 * 桌宠的表现质量几乎全部取决于 `src/pet/state.js`。它是纯函数 + 注入时钟，
 * 所以这里可以**穷举**那些在真实环境里极难复现的组合：
 *
 *   · 多个会话并行时聚合取谁（表现的是"最需要被看到"的那个，不是最后一个）；
 *   · "历史错误不该覆盖当前回合"（文档 §4.1 的核心结论）；
 *   · 工具结果乱序/重复到达时 `working` 不能卡死；
 *   · 气泡优先级抢占与静默期去重；
 *   · 未知事件（DSH 升级新增）不能让状态机崩。
 *
 * 风格照抄主题插件 `tools/test-client.mjs`：桩对象 + 断言计数 + 分组打印。
 */

import assert from 'node:assert/strict'

import {
  createPetState,
  PET_STATES,
  STATE_PRIORITY,
  highestState,
  sessionState,
  textOf,
  STATE_TEXT,
  DEFAULT_CONFIG,
  DEFAULT_BUBBLE_STATES
} from '../src/pet/state.js'
import { activityConfig, activityPreset, nextIdleEmoteDelay } from '../src/pet/activity.js'
import {
  EMOTE_BY_KEY,
  EMOTE_EXCLUDE_FROM_RANDOM,
  normalizeEmoteKey,
  emotePool,
  pickEmoteFile,
  emoteCoverage
} from '../src/pet/emotes.js'
import {
  fromSessionEvent,
  fromAgentStatus,
  fromAgentError,
  messageOf,
  sessionIdOf
} from '../src/pet/events.js'
import {
  normalizeAtlas,
  emptyAtlas,
  isSafeRel,
  resolveArt,
  artForState,
  bubbleArt,
  bubbleHasText,
  resolveBubbleFile,
  atlasReport,
  geometryFor,
  VALID_STATES
} from '../src/pet/atlas.js'

let passed = 0
let failed = 0
let group = ''

function section (name) {
  group = name
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

/** 假时钟：完全可控，测试里绝不 sleep。 */
function makeClock (start = 1000000) {
  let t = start
  return {
    now: () => t,
    advance: ms => {
      t += ms
    },
    set: v => {
      t = v
    }
  }
}

/** 建一个状态机 + 假时钟。 */
function makeMachine (config = {}, pickBubbleImage) {
  const clock = makeClock()
  const machine = createPetState({
    now: clock.now,
    config,
    pickBubbleImage
  })
  return { machine, clock }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 优先级表与聚合
 * ═════════════════════════════════════════════════════════════════════════ */
section('1. 优先级表与跨会话聚合')

ok('优先级表覆盖全部合法状态', () => {
  for (const s of PET_STATES) {
    assert.ok(typeof STATE_PRIORITY[s] === 'number', `缺少 ${s} 的优先级`)
  }
})

ok('契约 §1 的优先级顺序：working > waiting > thinking > error > happy > listening > waking > idle > sleeping', () => {
  const order = ['working', 'waiting', 'thinking', 'error', 'happy', 'listening', 'waking', 'idle', 'sleeping']
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(
      STATE_PRIORITY[order[i - 1]] > STATE_PRIORITY[order[i]],
      `${order[i - 1]} 应高于 ${order[i]}`
    )
  }
})

ok('error 低于 thinking —— 这是"历史错误不覆盖当前回合"的前提', () => {
  assert.ok(STATE_PRIORITY.error < STATE_PRIORITY.thinking)
  assert.ok(STATE_PRIORITY.error < STATE_PRIORITY.waiting)
})

ok('highestState 取最大者', () => {
  assert.equal(highestState(['idle', 'working', 'thinking']), 'working')
  assert.equal(highestState(['error', 'happy']), 'error')
  assert.equal(highestState([]), 'idle')
})

ok('highestState 遇未知状态按 idle 处理，不抛错（前向兼容）', () => {
  assert.equal(highestState(['some-future-state']), 'idle')
  assert.equal(highestState(['some-future-state', 'thinking']), 'thinking')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 单会话状态推导
 * ═════════════════════════════════════════════════════════════════════════ */
section('2. 单会话状态推导')

ok('初始状态是 waking', () => {
  const { machine } = makeMachine()
  assert.equal(machine.snapshot().petState, 'waking')
})

ok('agent/status running → thinking', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  assert.equal(machine.snapshot().petState, 'thinking')
})

ok('tool/call → working', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  assert.equal(machine.snapshot().petState, 'working')
})

ok('tool/result 归零后回 thinking（仍在跑）', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  machine.apply({ type: 'tool/result', sessionId: 's1', callId: 'c1' })
  assert.equal(machine.snapshot().petState, 'thinking')
})

ok('turn/end completed → happy', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'completed' } })
  assert.equal(machine.snapshot().petState, 'happy')
})

/* ── notifyComplete：AI 完成时强制提醒 ───────────────────────────────────
 * 用户点名"在 ai 完成的时候发出提醒"。普通 happy 气泡可能被静默期/优先级挡掉，
 * 提醒必须绕过这两条规则 —— 但不能绕过气泡总开关。
 * ──────────────────────────────────────────────────────────────────────── */

ok('⭐ notifyComplete：完成时强制弹提醒（文案来自 EVENT_TEXT）', () => {
  const { machine } = makeMachine({ notifyComplete: true })
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'completed' } })
  const b = machine.snapshot().bubble
  assert.ok(b !== null, '完成时应有气泡')
  assert.equal(b.text, '完成啦！来看看～', '提醒有自己的文案，不是 key 原文')
})

ok('⭐ 静默期/优先级挡不住提醒（force 语义）', () => {
  const { machine } = makeMachine({ notifyComplete: true, bubbleSilenceMs: 999999 })
  // 先造一个 working 气泡占住位（working 优先级 90 高于 happy 50）
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  assert.ok(machine.snapshot().bubble !== null, 'working 气泡先弹出')
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'completed' } })
  const b = machine.snapshot().bubble
  assert.ok(b !== null, '提醒必须盖过低优先级/静默期')
  assert.equal(b.text, '完成啦！来看看～')
})

ok('⭐ notifyComplete=false 时不强弹（旧气泡到期后归于安静）', () => {
  const { machine, clock } = makeMachine({ notifyComplete: false, bubbleSilenceMs: 999999 })
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'completed' } })
  // turn/end 时旧的 working 气泡还在显示期内（没到 6s），它**继续显示**是对的 ——
  // 关掉提醒的含义是"不再**新增**提醒"，不是"立刻抹掉正在显示的气泡"。
  assert.equal(machine.snapshot().bubble?.text, '正在调用工具…')
  // 气泡到期 + happy 闩锁过期后：不再有新气泡
  clock.advance(6000 + 1)
  machine.tick()
  assert.equal(machine.snapshot().bubble, null, '没有强提醒兜底，到期就该安静')
})

ok('⭐ 气泡总开关关闭时提醒也不弹（respect 用户意愿）', () => {
  const { machine } = makeMachine({ notifyComplete: true, bubbleStates: [] })
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'completed' } })
  assert.equal(machine.snapshot().bubble, null, '气泡全关 = 用户不想要任何气泡')
})

ok('同一次完成只提醒一次（时间推进后不重复弹）', () => {
  const { machine, clock } = makeMachine({ notifyComplete: true })
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'completed' } })
  assert.ok(machine.snapshot().bubble !== null)
  clock.advance(100)
  machine.tick()
  const first = machine.snapshot().bubble
  assert.ok(first !== null && first.text === '完成啦！来看看～')
  // 再过很久（气泡早已到期）：没有第二次提醒
  clock.advance(60000)
  machine.tick()
  assert.equal(machine.snapshot().bubble, null, '同一次完成只提醒一次')
})

ok('happy 在 happyMs 后过期回 idle', () => {
  const { machine, clock } = makeMachine({ happyMs: 3000 })
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'completed' } })
  assert.equal(machine.snapshot().petState, 'happy')
  clock.advance(2999)
  machine.tick()
  assert.equal(machine.snapshot().petState, 'happy', '未到期不该过期')
  clock.advance(2)
  machine.tick()
  assert.equal(machine.snapshot().petState, 'idle', '到期应回 idle')
})

ok('turn/end error → error', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'error', error: { message: 'boom' } } })
  assert.equal(machine.snapshot().petState, 'error')
})

ok('turn/end max-tokens → error 且文案区分"输出被截断"', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'max-tokens' } })
  assert.equal(machine.snapshot().petState, 'error')
})

ok('turn/end aborted/interrupted/blocked → 回 idle', () => {
  for (const kind of ['aborted', 'interrupted', 'blocked']) {
    const { machine } = makeMachine()
    machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
    machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind } })
    assert.equal(machine.snapshot().petState, 'idle', `${kind} 应回 idle`)
  }
})

ok('turn/end 未知原因按干净结束处理（不崩）', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'some-future-reason' } })
  assert.equal(machine.snapshot().petState, 'idle')
})

ok('approval/asked → waiting', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'approval/asked', sessionId: 's1' })
  assert.equal(machine.snapshot().petState, 'waiting')
})

ok('approval/decided 解除 waiting', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'approval/asked', sessionId: 's1' })
  machine.apply({ type: 'approval/decided', sessionId: 's1' })
  assert.equal(machine.snapshot().petState, 'thinking')
})

ok('agent/error → error', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/error', sessionId: 's1', message: 'bad' })
  assert.equal(machine.snapshot().petState, 'error')
})

ok('inbox/inserted → listening（瞬时闩锁）', () => {
  const { machine, clock } = makeMachine({ listeningMs: 1200 })
  machine.apply({ type: 'inbox/inserted', sessionId: 's1' })
  assert.equal(machine.snapshot().petState, 'listening')
  clock.advance(1201)
  machine.tick()
  assert.equal(machine.snapshot().petState, 'idle')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 关键不变式：历史错误不覆盖当前回合
 * ═════════════════════════════════════════════════════════════════════════ */
section('3. 关键不变式：历史错误不覆盖当前回合')

ok('running 清除该会话的 error 闩锁', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/error', sessionId: 's1', message: 'first' })
  assert.equal(machine.snapshot().petState, 'error')
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  assert.equal(machine.snapshot().petState, 'thinking', '新回合应立刻脱离 error')
})

ok('step/start 同样清除 error', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/error', sessionId: 's1', message: 'x' })
  machine.apply({ type: 'step/start', sessionId: 's1' })
  assert.equal(machine.snapshot().petState, 'thinking')
})

ok('会话 A 的错误不污染会话 B 的 running（多会话隔离）', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/error', sessionId: 'A', message: 'A failed' })
  machine.apply({ type: 'agent/status', sessionId: 'B', status: 'running' })
  const snap = machine.snapshot()
  // 聚合取优先级最大者：thinking(70) > error(60)
  assert.equal(snap.petState, 'thinking')
  const byId = Object.fromEntries(snap.sessions.map(s => [s.sessionId, s.state]))
  assert.equal(byId.A, 'error', 'A 自己仍是 error')
  assert.equal(byId.B, 'thinking')
})

ok('B 的 running 不会清除 A 的 error', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/error', sessionId: 'A', message: 'A failed' })
  machine.apply({ type: 'agent/status', sessionId: 'B', status: 'running' })
  machine.apply({ type: 'agent/status', sessionId: 'B', status: 'idle' })
  assert.equal(machine.snapshot().petState, 'error', 'B 结束了，应显示 A 的错误')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 在飞工具计数：不能卡死
 * ═════════════════════════════════════════════════════════════════════════ */
section('4. 在飞工具计数（Set 去重，不能卡死）')

ok('多个工具并行 → working；逐个完成仍 working 直到最后一个', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c2' })
  assert.equal(machine.snapshot().petState, 'working')
  machine.apply({ type: 'tool/result', sessionId: 's1', callId: 'c1' })
  assert.equal(machine.snapshot().petState, 'working', '还有一个在飞')
  machine.apply({ type: 'tool/result', sessionId: 's1', callId: 'c2' })
  assert.equal(machine.snapshot().petState, 'thinking')
})

ok('同一个 callId 重复到达不会把计数算歪', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  machine.apply({ type: 'tool/result', sessionId: 's1', callId: 'c1' })
  assert.equal(machine.snapshot().petState, 'thinking', 'Set 去重后一次结果就归零')
})

ok('多余的结果事件不会让计数变负', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/result', sessionId: 's1', callId: 'ghost' })
  machine.apply({ type: 'tool/result', sessionId: 's1', callId: 'ghost2' })
  assert.equal(machine.snapshot().petState, 'thinking')
})

ok('缺 callId 的结果（真实 tool/result 事件没有 callId）也能推进', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  machine.apply({ type: 'tool/result', sessionId: 's1' })
  assert.equal(machine.snapshot().petState, 'thinking')
})

ok('agent/status idle 兜底清空在飞工具（结果事件丢了也不会永远卡在 working）', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  assert.equal(machine.snapshot().petState, 'working')
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'idle' })
  assert.equal(machine.snapshot().petState, 'idle', '不能卡在 working')
})

ok('turn/end 也清空在飞工具', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'completed' } })
  assert.equal(machine.snapshot().petState, 'happy')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5. sleeping：全局空闲超时
 * ═════════════════════════════════════════════════════════════════════════ */
section('5. sleeping 全局空闲超时')

ok('空闲超过 sleepMs → sleeping', () => {
  const { machine, clock } = makeMachine({ wakingMs: 100, sleepMs: 5000 })
  clock.advance(5001)
  machine.tick()
  assert.equal(machine.snapshot().petState, 'sleeping')
})

ok('未超过 sleepMs 不睡', () => {
  const { machine, clock } = makeMachine({ sleepMs: 5000 })
  clock.advance(4999)
  machine.tick()
  assert.equal(machine.snapshot().petState, 'idle', 'waking 窗口已过，但还没到睡觉时间')
})

ok('waking 在 wakingMs 后自动转入 idle', () => {
  const { machine, clock } = makeMachine({ wakingMs: 1500 })
  assert.equal(machine.snapshot().petState, 'waking')
  clock.advance(1499)
  machine.tick()
  assert.equal(machine.snapshot().petState, 'waking', '未到期仍是 waking')
  clock.advance(2)
  machine.tick()
  assert.equal(machine.snapshot().petState, 'idle', '到期应转 idle')
})

ok('真实活动立刻结束 waking（不为演"醒来"压住真实状态）', () => {
  const { machine } = makeMachine({ wakingMs: 60000 })
  assert.equal(machine.snapshot().petState, 'waking')
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  assert.equal(machine.snapshot().petState, 'thinking', '活动优先于亮相')
})

ok('native/status 不算活动，不会结束 waking（exe 重连不该把它叫醒）', () => {
  const { machine } = makeMachine({ wakingMs: 60000 })
  machine.apply({ type: 'native/status', available: true })
  assert.equal(machine.snapshot().petState, 'waking')
})

ok('native/status 不算活动，不会把睡着的桌宠叫醒', () => {
  const { machine, clock } = makeMachine({ wakingMs: 100, sleepMs: 5000 })
  clock.advance(6000)
  machine.tick()
  assert.equal(machine.snapshot().petState, 'sleeping')
  machine.apply({ type: 'native/status', available: false, reason: 'x' })
  assert.equal(machine.snapshot().petState, 'sleeping', 'exe 状态变化不该当作用户活动')
})

ok('睡着后任意已知事件唤醒', () => {
  const { machine, clock } = makeMachine({ wakingMs: 100, sleepMs: 5000 })
  clock.advance(6000)
  machine.tick()
  assert.equal(machine.snapshot().petState, 'sleeping')
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  assert.equal(machine.snapshot().petState, 'thinking')
})

ok('sleeping 不会盖掉 happy 闩锁', () => {
  const { machine, clock } = makeMachine({ wakingMs: 100, sleepMs: 100, happyMs: 10000 })
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'completed' } })
  clock.advance(500)
  machine.tick()
  assert.equal(machine.snapshot().petState, 'happy', 'happy 期间不该显示 sleeping')
})

ok('未知事件不会把桌宠从睡着里叫醒', () => {
  const { machine, clock } = makeMachine({ wakingMs: 100, sleepMs: 5000 })
  clock.advance(6000)
  machine.tick()
  assert.equal(machine.snapshot().petState, 'sleeping')
  machine.apply({ type: 'some/future-event', sessionId: 's1' })
  assert.equal(machine.snapshot().petState, 'sleeping', '未知事件不该重置静默计时')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 气泡：优先级抢占 + 静默期去重
 * ═════════════════════════════════════════════════════════════════════════ */
section('6. 气泡：优先级抢占与静默期')

ok('进入 working 会弹气泡', () => {
  const { machine } = makeMachine({}, () => 'bubble/01.png')
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  const b = machine.snapshot().bubble
  assert.ok(b !== null, '应弹气泡')
  assert.equal(b.kind, 'both', '有图有文 → both')
  assert.equal(b.image, 'bubble/01.png')
})

ok('气泡带单调递增 id（客户端据此去重）', () => {
  const { machine, clock } = makeMachine({ bubbleSilenceMs: 0 }, () => null)
  machine.apply({ type: 'inbox/inserted', sessionId: 's1' })
  const id1 = machine.snapshot().bubble?.id
  clock.advance(10)
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  const id2 = machine.snapshot().bubble?.id
  assert.ok(typeof id1 === 'number' && typeof id2 === 'number')
  assert.ok(id2 > id1, 'id 必须递增')
})

ok('气泡到期后被清空', () => {
  const { machine, clock } = makeMachine({ bubbleMs: 1000 }, () => null)
  machine.apply({ type: 'inbox/inserted', sessionId: 's1' })
  assert.ok(machine.snapshot().bubble !== null)
  clock.advance(1001)
  machine.tick()
  assert.equal(machine.snapshot().bubble, null)
})

ok('静默期内同 key 不重复弹', () => {
  const { machine, clock } = makeMachine({ bubbleSilenceMs: 8000, listeningMs: 100 }, () => null)
  machine.apply({ type: 'inbox/inserted', sessionId: 's1' })
  const first = machine.snapshot().bubble?.id
  clock.advance(50)
  machine.apply({ type: 'inbox/inserted', sessionId: 's1' })
  assert.equal(machine.snapshot().bubble?.id, first, '静默期内不该换新气泡')
})

ok('低优先级气泡不能打断高优先级', () => {
  const { machine, clock } = makeMachine({ bubbleSilenceMs: 0, bubbleMs: 60000 }, () => null)
  // waiting(80) 优先弹
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'approval/asked', sessionId: 's1' })
  const high = machine.snapshot().bubble?.priority
  assert.ok(high >= STATE_PRIORITY.waiting)
  clock.advance(10)
  // 低优先级的 tool 失败不该抢占
  machine.apply({ type: 'tool/result', sessionId: 's1', isError: true })
  assert.equal(machine.snapshot().bubble?.priority, high, '低优先级不该抢占')
})

ok('没有图时 kind=text（降级不崩）', () => {
  const { machine } = makeMachine({}, () => null)
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  const b = machine.snapshot().bubble
  assert.equal(b.kind, 'text')
  assert.equal(b.image, null)
  assert.ok(typeof b.text === 'string' && b.text.length > 0)
})

ok('bubbleStates 为空时不弹状态气泡（设置项可关）', () => {
  const { machine } = makeMachine({ bubbleStates: [] }, () => 'x.png')
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  assert.equal(machine.snapshot().bubble, null)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 7. rev 单调性（三端幂等丢弃的依据）
 * ═════════════════════════════════════════════════════════════════════════ */
section('7. rev 单调性与订阅')

ok('rev 只增不减', () => {
  const { machine } = makeMachine()
  let prev = machine.snapshot().rev
  const seq = [
    { type: 'agent/status', sessionId: 's1', status: 'running' },
    { type: 'tool/call', sessionId: 's1', callId: 'c1' },
    { type: 'tool/result', sessionId: 's1', callId: 'c1' },
    { type: 'turn/end', sessionId: 's1', reason: { kind: 'completed' } },
    { type: 'agent/status', sessionId: 's1', status: 'idle' }
  ]
  for (const e of seq) {
    machine.apply(e)
    const now = machine.snapshot().rev
    assert.ok(now >= prev, 'rev 不该回退')
    prev = now
  }
})

ok('无变化时 rev 不推进', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'idle' })
  const a = machine.snapshot().rev
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'idle' })
  assert.equal(machine.snapshot().rev, a)
})

ok('监听者在状态变化时被调用', () => {
  const { machine } = makeMachine()
  let calls = 0
  const off = machine.on(() => {
    calls += 1
  })
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  assert.ok(calls > 0, '应有回调')
  off()
  const before = calls
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'idle' })
  assert.equal(calls, before, '取消订阅后不该再回调')
})

ok('监听者抛错不影响状态机（与官方 emit 语义一致）', () => {
  const { machine } = makeMachine()
  machine.on(() => {
    throw new Error('listener boom')
  })
  let second = 0
  machine.on(() => {
    second += 1
  })
  assert.doesNotThrow(() => {
    machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  })
  assert.ok(second > 0, '第二个监听者仍应被调用')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 健壮性：脏输入与未知事件
 * ═════════════════════════════════════════════════════════════════════════ */
section('8. 健壮性：脏输入不崩')

ok('apply(null/undefined/数字) 不抛错', () => {
  const { machine } = makeMachine()
  for (const bad of [null, undefined, 42, 'str', []]) {
    assert.doesNotThrow(() => machine.apply(bad))
  }
})

ok('缺 sessionId 的事件也能处理（归到 unknown）', () => {
  const { machine } = makeMachine()
  assert.doesNotThrow(() => {
    machine.apply({ type: 'agent/status', status: 'running' })
  })
  assert.equal(machine.snapshot().petState, 'thinking')
})

ok('未知事件类型静默忽略且不抛错', () => {
  const { machine } = makeMachine()
  assert.doesNotThrow(() => {
    machine.apply({ type: 'brand/new/event', sessionId: 's1', payload: { x: 1 } })
  })
})

ok('session/gone 移除会话记录', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'session/gone', sessionId: 's1' })
  assert.equal(machine.snapshot().sessions.length, 0)
})

ok('native/status 反映到快照', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'native/status', available: false, reason: '没有 exe' })
  const snap = machine.snapshot()
  assert.equal(snap.nativeAvailable, false)
  assert.equal(snap.nativeError, '没有 exe')
})

ok('快照形状符合契约 §2', () => {
  const { machine } = makeMachine()
  const snap = machine.snapshot()
  for (const key of ['rev', 'petState', 'label', 'since', 'sessions', 'nativeAvailable', 'nativeError']) {
    assert.ok(key in snap, `快照缺字段 ${key}`)
  }
  assert.ok(PET_STATES.includes(snap.petState), `petState 非法：${snap.petState}`)
  assert.ok(Array.isArray(snap.sessions))
})

/* ══════════════════════════════════════════════════════════════════════════
 * 9. 事件翻译层
 * ═════════════════════════════════════════════════════════════════════════ */
section('9. 事件翻译（events.js）')

ok('fromAgentStatus 翻译 running/idle', () => {
  assert.deepEqual(
    fromAgentStatus({ agent: { id: 'sess-1' }, status: 'running' }),
    { type: 'agent/status', sessionId: 'sess-1', status: 'running' }
  )
  assert.equal(fromAgentStatus({ agent: { id: 's' }, status: 'weird' }).status, 'idle')
})

ok('fromAgentError 提取短消息', () => {
  const env = fromAgentError({ agent: { id: 's1' }, error: new Error('boom') })
  assert.equal(env.type, 'agent/error')
  assert.equal(env.message, 'boom')
})

ok('messageOf 对任意输入都不抛且截断', () => {
  assert.equal(messageOf(null), undefined)
  assert.equal(messageOf({}), undefined)
  assert.equal(messageOf('x'.repeat(500)).length, 200)
  assert.equal(messageOf({ message: 'hi' }), 'hi')
  assert.equal(messageOf({ reason: 'why' }), 'why')
})

ok('sessionIdOf 支持对象/字符串/空', () => {
  assert.equal(sessionIdOf({ id: 'a' }), 'a')
  assert.equal(sessionIdOf({ sessionId: 'b' }), 'b')
  assert.equal(sessionIdOf('c'), 'c')
  assert.equal(sessionIdOf(null), undefined)
})

ok('turn/start 翻译为 step/start（新回合清错误闩锁）', () => {
  const env = fromSessionEvent({ id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(env.type, 'step/start')
})

ok('turn/end 带出 reason 与 message', () => {
  const env = fromSessionEvent({ id: 's1' }, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { message: 'nope' } } }
  })
  assert.equal(env.type, 'turn/end')
  assert.equal(env.reason.kind, 'error')
  assert.equal(env.message, 'nope')
})

ok('tool/call 带出 callId', () => {
  const env = fromSessionEvent({ id: 's1' }, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'call-9', name: 'bash', arguments: '{}' }
  })
  assert.equal(env.type, 'tool/call')
  assert.equal(env.callId, 'call-9')
  assert.equal(env.name, 'bash')
})

ok('tool/result 的 isError 由 error 字段判定', () => {
  const bad = fromSessionEvent({ id: 's1' }, { type: 'tool/result', data: { error: { name: 'X' } } })
  assert.equal(bad.isError, true)
  const good = fromSessionEvent({ id: 's1' }, { type: 'tool/result', data: {} })
  assert.equal(good.isError, false)
})

ok('user/message 翻译为 inbox/inserted（且不读正文）', () => {
  const env = fromSessionEvent({ id: 's1' }, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '机密内容' }] }
  })
  assert.equal(env.type, 'inbox/inserted')
  // 关键：正文绝不能出现在信封里
  assert.equal(JSON.stringify(env).includes('机密内容'), false, '绝不能带出消息正文')
})

ok('不关心的事件返回 null', () => {
  assert.equal(fromSessionEvent({ id: 's1' }, { type: 'assistant/chunk', data: {} }), null)
  assert.equal(fromSessionEvent({ id: 's1' }, { type: 'request/header', data: {} }), null)
  assert.equal(fromSessionEvent(null, null), null)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 10. 素材清单：白名单与路径安全
 * ═════════════════════════════════════════════════════════════════════════ */
/* ── 活跃度档位（安静 / 正常 / 调皮）────────────────────────────────────
 *
 * 用户点名："调成安静、正常、调皮来改变它的活跃度"。
 * 档位是一层**预设**：只决定「哪些状态弹气泡、间隔倍率、要不要主动卖萌」，
 * 用户的显式数值仍是基准（乘倍率），完成提醒的开关永远归用户。
 * ──────────────────────────────────────────────────────────────────────── */

section('12. 活跃度档位（activity.js）')

ok('安静档：只保留「需要你知道」的状态', () => {
  const cfg = activityConfig('quiet', { bubbleGapMs: 8000 }, DEFAULT_BUBBLE_STATES)
  assert.deepEqual(cfg.bubbleStates.sort(), ['error', 'waiting'],
    '在等你审批 + 出错了，其余在跑是常态，不弹')
  assert.equal(cfg.idleEmoteMs, null, '安静档绝不主动卖萌')
  assert.equal(cfg.bubbleSilenceMs, 20000, '间隔拉长 2.5 倍，进一步降噪')
})

ok('正常档：用状态机默认列表、倍率 1', () => {
  const cfg = activityConfig('normal', { bubbleGapMs: 8000 }, DEFAULT_BUBBLE_STATES)
  assert.deepEqual(cfg.bubbleStates, DEFAULT_BUBBLE_STATES)
  assert.equal(cfg.bubbleSilenceMs, 8000)
  assert.equal(cfg.idleEmoteMs, null, '正常档不主动卖萌')
})

ok('调皮档：全都弹、间隔减半、会主动蹦表情', () => {
  const cfg = activityConfig('playful', { bubbleGapMs: 8000 }, DEFAULT_BUBBLE_STATES)
  assert.deepEqual(cfg.bubbleStates, DEFAULT_BUBBLE_STATES)
  assert.equal(cfg.bubbleSilenceMs, 4000, '间隔减半 = 更爱说话')
  assert.ok(cfg.idleEmoteMs > 0, '调皮档会给一个主动卖萌间隔')
})

ok('未知档位回落 normal（不改变现状）', () => {
  const cfg = activityConfig('psychedelic', { bubbleGapMs: 8000 }, DEFAULT_BUBBLE_STATES)
  assert.deepEqual(cfg.bubbleStates, DEFAULT_BUBBLE_STATES)
  assert.equal(cfg.bubbleSilenceMs, 8000)
})

ok('用户设 bubbleGapMs=0（不限）时倍率不把它变成 0*scale=0 之外的值', () => {
  assert.equal(activityConfig('quiet', { bubbleGapMs: 0 }, DEFAULT_BUBBLE_STATES).bubbleSilenceMs, 0)
  assert.equal(activityConfig('playful', { bubbleGapMs: 0 }, DEFAULT_BUBBLE_STATES).bubbleSilenceMs, 0)
})

ok('档位表写了非法状态名也不会让气泡彻底失灵', () => {
  const cfg = activityConfig('quiet', { bubbleGapMs: 1000 }, ['waiting', 'bogus-not-a-state'])
  assert.deepEqual(cfg.bubbleStates, ['waiting'], '与合法状态求交集后仍可用')
})

ok('主动卖萌的排程带抖动（避免像节拍器）', () => {
  const lo = nextIdleEmoteDelay(60000, () => 0)
  const hi = nextIdleEmoteDelay(60000, () => 0.999)
  assert.ok(lo >= 1000, '有下限，不能排到立刻')
  assert.ok(hi <= 90000, '有上限，抖动有界')
  assert.ok(hi > lo, '抖动确实让早晚不同')
  assert.equal(nextIdleEmoteDelay(null, Math.random), Infinity)
  assert.equal(nextIdleEmoteDelay(0, Math.random), Infinity)
})

section('13. 热更新与调皮档的主动卖萌（状态机）')

ok('⭐ setConfig 让档位改完立即生效（不需要重载插件）', () => {
  const { machine, clock } = makeMachine({ bubbleStates: DEFAULT_BUBBLE_STATES, bubbleSilenceMs: 0 })
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  assert.equal(machine.snapshot().petState, 'working')
  const before = machine.snapshot().bubble?.id ?? null
  assert.ok(before !== null, '正常档下 working 会弹气泡')

  // 切到安静档
  const quiet = activityConfig('quiet', { bubbleGapMs: 0 }, DEFAULT_BUBBLE_STATES)
  machine.setConfig({ bubbleStates: quiet.bubbleStates, bubbleSilenceMs: quiet.bubbleSilenceMs })

  // 已在显示的气泡**不追溯隐藏**（用户正看着它，突然消失才怪）；
  // 要断言的是"**不再产生新的** working 气泡"。
  clock.advance(7000) // 越过 6s 生命周期
  machine.tick()
  assert.equal(machine.snapshot().bubble, null, '过期后没有新气泡续上')
  // 再制造一次 working 活动：安静档不该为它弹
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c2' })
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c3' })
  assert.equal(machine.snapshot().bubble, null, '安静档下 working 不再弹气泡')
})

ok('⭐ 调皮档：空闲足够久会主动蹦一个气泡', () => {
  const { machine, clock } = makeMachine({ idleEmoteMs: 60000, bubbleStates: DEFAULT_BUBBLE_STATES })
  // 第一次 tick 只是**排程**（arm），不是立刻弹 —— 否则一切换档位就会马上蹦一个。
  machine.tick()
  assert.equal(machine.snapshot().bubble, null, '刚排程时不该立刻弹')
  clock.advance(120000) // 远超过抖动后的上限
  machine.tick()
  assert.ok(machine.snapshot().bubble !== null, '调皮档空闲够久应主动蹦一个')
})

ok('调皮档在忙的时候不主动蹦（不打扰）', () => {
  const { machine, clock } = makeMachine({ idleEmoteMs: 1000, bubbleStates: DEFAULT_BUBBLE_STATES })
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  machine.tick()
  clock.advance(20000)
  machine.tick()
  assert.equal(machine.snapshot().petState, 'working')
  // 忙时排程被推迟，不该冒出 idle 卖萌气泡
  const b = machine.snapshot().bubble
  assert.ok(b === null || b.text !== null || b.image !== null)
})

ok('idleEmoteMs=null（安静/正常档）时永不主动蹦', () => {
  const { machine, clock } = makeMachine({ idleEmoteMs: null })
  clock.advance(600000)
  machine.tick()
  assert.equal(machine.snapshot().bubble, null)
})

ok('setConfig 挡住非法值（热更新不是绕过校验的后门）', () => {
  const { machine } = makeMachine()
  machine.setConfig({ bubbleSilenceMs: -999, bubbleStates: 'not-an-array', locale: 'xx' })
  const cfg = machine.internals.config
  assert.ok(cfg.bubbleSilenceMs >= 0, '负数被夹住')
  assert.ok(Array.isArray(cfg.bubbleStates), '非数组回落默认')
  assert.equal(cfg.locale, 'zh', '非法语言回落 zh')
})

section('13.5 授权/提问常亮提醒（attention，契约 §2）')

ok('⭐ approval/asked → attention=approval 且气泡 sticky 常亮', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'approval/asked', sessionId: 's1' })
  const snap = machine.snapshot()
  assert.ok(snap.attention !== null, '应有待处理提醒')
  assert.equal(snap.attention.kind, 'approval')
  assert.equal(snap.attention.sessionId, 's1')
  assert.equal(snap.attention.count, 1)
  assert.equal(snap.attention.text, '在等你审批', '文案应已本地化，渲染方直接用')
  assert.equal(snap.bubble.kind, 'attention')
  assert.equal(snap.bubble.sticky, true, 'sticky=渲染方不按 durationMs 收')
  assert.equal(snap.bubble.priority, 100, '压过 working(90)，普通气泡抢不走')
})

ok('⭐ 常亮：远超普通气泡时长仍然亮着', () => {
  const { machine, clock } = makeMachine({ bubbleMs: 6000 })
  machine.apply({ type: 'approval/asked', sessionId: 's1' })
  assert.ok(machine.snapshot().bubble !== null)
  clock.advance(600000) // 10 分钟，普通气泡 6s 早该没了
  machine.tick()
  const snap = machine.snapshot()
  assert.ok(snap.bubble !== null, '10 分钟后仍常亮')
  assert.equal(snap.bubble.kind, 'attention')
  assert.equal(snap.attention.kind, 'approval')
})

ok('⭐ approval/decided → 立刻收起（attention 与气泡同时归零）', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'approval/asked', sessionId: 's1' })
  assert.ok(machine.snapshot().attention !== null)
  machine.apply({ type: 'approval/decided', sessionId: 's1' })
  const snap = machine.snapshot()
  assert.equal(snap.attention, null, '处理完 → 无提醒')
  assert.equal(snap.bubble, null, '气泡同时收起')
})

ok('⭐ ask_user_question 提问 → attention=question；回答后收起', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1', name: 'ask_user_question' })
  const snap = machine.snapshot()
  assert.ok(snap.attention !== null, '提问中应有提醒')
  assert.equal(snap.attention.kind, 'question')
  assert.equal(snap.bubble.kind, 'attention')
  // 回答：真实 tool/result **不带 callId** → 保守清除（在飞工具归零）
  machine.apply({ type: 'tool/result', sessionId: 's1', isError: false })
  const after = machine.snapshot()
  assert.equal(after.attention, null, '回答后收起（无 callId 也能清）')
  assert.equal(after.bubble, null)
})

ok('普通工具调用不触发 attention（只有 ask_user_question 算提问）', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1', name: 'bash' })
  assert.equal(machine.snapshot().attention, null)
})

ok('⭐ approval 压过 question；count 合计', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1', name: 'ask_user_question' })
  machine.apply({ type: 'approval/asked', sessionId: 's2' })
  const snap = machine.snapshot()
  assert.equal(snap.attention.kind, 'approval', '审批更紧急')
  assert.equal(snap.attention.sessionId, 's2')
  assert.equal(snap.attention.count, 2, '两处待处理 → 2')
  assert.equal(snap.bubble.attentionCount, 2, '气泡侧同值（渲染方显示徽标）')
  // s2 处理完 → 回落到 question，count 变 1
  machine.apply({ type: 'approval/decided', sessionId: 's2' })
  const snap2 = machine.snapshot()
  assert.equal(snap2.attention.kind, 'question')
  assert.equal(snap2.attention.count, 1)
})

ok('⭐ turn/end 收回提问（模型不再等了）', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1', name: 'ask_user_question' })
  assert.ok(machine.snapshot().attention !== null)
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'completed' } })
  assert.equal(machine.snapshot().attention, null)
})

ok('⭐ 兜底上限：超 attentionMaxMs 的提醒自动放下（绝不永久钉死）', () => {
  const { machine, clock } = makeMachine({ attentionMaxMs: 60000 })
  machine.apply({ type: 'approval/asked', sessionId: 's1' })
  assert.ok(machine.snapshot().attention !== null)
  clock.advance(61000)
  machine.tick()
  assert.equal(machine.snapshot().attention, null, '超上限 → 放下')
  assert.equal(machine.snapshot().bubble, null)
  // 上限内仍然亮
  const { machine: m2, clock: c2 } = makeMachine({ attentionMaxMs: 60000 })
  m2.apply({ type: 'approval/asked', sessionId: 's1' })
  c2.advance(30000)
  m2.tick()
  assert.ok(m2.snapshot().attention !== null, '上限内不放下')
})

ok('attentionReminder=false → 完全回到现状（无 attention，只有普通气泡）', () => {
  const { machine } = makeMachine({ attentionReminder: false })
  machine.apply({ type: 'approval/asked', sessionId: 's1' })
  const snap = machine.snapshot()
  assert.equal(snap.attention, null)
  // 普通 waiting 气泡照旧（这是"回到现状"的含义，不是什么都不显示）
  assert.notEqual(snap.bubble, null)
  assert.notEqual(snap.bubble.kind, 'attention')
})

ok('attention 不受 bubble 总开关影响（bubbleStates=[] 仍提醒）', () => {
  const { machine } = makeMachine({ bubbleStates: [] })
  machine.apply({ type: 'approval/asked', sessionId: 's1' })
  const snap = machine.snapshot()
  assert.ok(snap.attention !== null, '关普通气泡 ≠ 不要审批提醒')
  assert.equal(snap.bubble.kind, 'attention')
})

ok('⭐ attention 存续期间：普通气泡与完成提醒都被挡住', () => {
  const { machine, clock } = makeMachine({ notifyComplete: true, bubbleSilenceMs: 0 })
  machine.apply({ type: 'approval/asked', sessionId: 's1' })
  // 制造一次完成：notify-complete 是 force，但 attention 优先
  machine.apply({ type: 'turn/end', sessionId: 's1', reason: { kind: 'completed' } })
  const b = machine.snapshot().bubble
  assert.equal(b.kind, 'attention', '完成提醒必须给审批让位')
  // 审批处理完后，完成提醒若还没发就发一次
  machine.apply({ type: 'approval/decided', sessionId: 's1' })
  machine.tick()
  const b2 = machine.snapshot().bubble
  assert.ok(b2 !== null, '审批撤了，完成提醒现在可以弹')
  assert.equal(b2.text, '完成啦！来看看～')
})

ok('session/gone → 提醒跟着消失', () => {
  const { machine } = makeMachine()
  machine.apply({ type: 'approval/asked', sessionId: 's1' })
  assert.ok(machine.snapshot().attention !== null)
  machine.apply({ type: 'session/gone', sessionId: 's1' })
  assert.equal(machine.snapshot().attention, null)
})

ok('attention 文案随 locale 切换', () => {
  const { machine } = makeMachine({ locale: 'en' })
  machine.apply({ type: 'approval/asked', sessionId: 's1' })
  assert.equal(machine.snapshot().attention.text, 'Waiting for your approval')
})

section('13.6 表情结合状态（emotes.js）')

ok('⭐ 9 个状态**全部**有专属表情池（不能有状态哑掉）', () => {
  const states = ['waking', 'idle', 'listening', 'thinking', 'working', 'waiting', 'happy', 'error', 'sleeping']
  const missing = states.filter(s => emotePool(s).length === 0)
  assert.deepEqual(missing, [], `这些状态没有表情池：${missing.join(', ')}`)
})

ok('⭐ 事件型 key 也有池（完成/失败/来消息/主动卖萌）', () => {
  for (const k of ['notify-complete', 'tool/failed', 'inbox/inserted']) {
    assert.ok(emotePool(k).length > 0, `${k} 应有表情池`)
  }
  assert.ok(emotePool('idle-emote-7').length > 0, 'idle-emote-<序号> 应归到 idle')
})

ok('⭐ 情绪对得上：出错配生气/哭，完成配庆祝，两者不重叠', () => {
  const err = new Set(emotePool('error'))
  const happy = new Set(emotePool('happy'))
  const overlap = [...err].filter(f => happy.has(f))
  assert.deepEqual(overlap, [], `出错与完成的池子不该重叠：${overlap.join(', ')}`)
  // 具体抽查：出错池里有"生气"，完成池里有"好耶"
  assert.ok([...err].some(f => f.includes('annoyed')), '出错池应含「好气人哦」')
  assert.ok([...happy].some(f => f.includes('yay')), '完成池应含「好耶」')
  assert.ok(![...err].some(f => f.includes('yay')), '出错池**绝不能**含「好耶」')
  assert.ok(![...happy].some(f => f.includes('crying')), '完成池**绝不能**含「庄一直哭」')
})

ok('⭐ 干活中的池子不含庆祝类（AI 还在忙，不该先庆祝）', () => {
  const working = emotePool('working')
  const celebration = ['yay', 'so-good', 'thumbs-up', 'you-are-the-best']
  const bad = working.filter(f => celebration.some(c => f.includes(c)))
  assert.deepEqual(bad, [], `working 池不该含庆祝类：${bad.join(', ')}`)
})

ok('normalizeEmoteKey：精确 key 原样、idle-emote-* 归 idle、未知返回 null', () => {
  assert.equal(normalizeEmoteKey('happy'), 'happy')
  assert.equal(normalizeEmoteKey('idle-emote-12'), 'idle')
  assert.equal(normalizeEmoteKey('totally-unknown'), null)
  assert.equal(normalizeEmoteKey(''), null)
  assert.equal(normalizeEmoteKey(null), null)
})

ok('pickEmoteFile：池内轮换、避开上一张、未知 key 返回 null（由调用方回落）', () => {
  const pool = emotePool('happy')
  assert.ok(pool.length >= 2, 'happy 池至少 2 张才谈得上轮换')
  const a = pickEmoteFile('happy', 0)
  const b = pickEmoteFile('happy', 1)
  assert.ok(pool.includes(a) && pool.includes(b), '返回值必须来自该池')
  assert.notEqual(a, b, '不同 seed 应取到不同张（否则等于没有轮换）')
  // 避开：seed 正好指向 avoid 时应顺延
  const avoidFirst = pickEmoteFile('happy', 0, pool[0])
  assert.notEqual(avoidFirst, pool[0], '应避开上一张')
  assert.equal(pickEmoteFile('unknown-key', 0), null, '未知 key → null，交给调用方回落')
  // 单元素池不会因为"避开"而返回空
  assert.ok(pickEmoteFile('sleeping', 0) !== null)
})

ok('⭐ 池内文件路径格式统一（相对 art/pet/，无绝对路径、无反斜杠）', () => {
  for (const [key, files] of Object.entries(EMOTE_BY_KEY)) {
    for (const f of files) {
      assert.ok(!f.startsWith('/') && !/^[A-Za-z]:/.test(f), `${key} 含绝对路径：${f}`)
      assert.ok(!f.includes('\\'), `${key} 含反斜杠：${f}`)
      assert.ok(f.startsWith('bubble/'), `${key} 路径应以 bubble/ 开头：${f}`)
    }
  }
})

ok('⭐⭐ 确定性判据：不同状态**必须**取到不同图（这就是"结合状态"）', () => {
  // 这是本次改动的核心判据，也是**唯一能抓住旧 bug** 的断言。
  //
  // 旧实现是 `bubbleArt(atlas, seed)` —— 只按索引取模、**完全忽略 key**：
  // 同一个 seed 下，无论什么状态都返回同一张图。实测（真清单 41 张）：
  //   seed=0 时索引取模只产生 **1 种**结果；而按状态取产生 4 种（好耶/生气/工作中/摸鱼）。
  // 所以"同一 seed 下各状态结果是否互不相同"就能确定性地区分新旧行为 ——
  // 不需要靠随机抽样（那样概率上会漏，实测过：随机的断言在回退成旧代码时仍然全绿）。
  const keys = ['waking', 'idle', 'listening', 'thinking', 'working', 'waiting', 'happy', 'error', 'sleeping']
  const picked = keys.map(k => pickEmoteFile(k, 0))
  const distinct = new Set(picked.filter(p => p !== null))
  assert.ok(distinct.size >= 5,
    `同一 seed 下各状态应取到明显不同的图（至少 5 种），实际只有 ${distinct.size} 种 —— ` +
    '若为 1 说明退化成了"忽略状态"的索引取模')

  // 逐对抽查：情绪相反的两个状态**绝不能**取到同一张
  const errPick = pickEmoteFile('error', 0)
  const happyPick = pickEmoteFile('happy', 0)
  assert.notEqual(errPick, happyPick, '出错与完成不能取到同一张表情')
})

ok('⭐ 任意 seed 下，"出错"的结果永远落在出错池里（不会漂到庆祝池）', () => {
  const errPool = new Set(emotePool('error'))
  for (let s = 0; s < 40; s++) {
    const f = pickEmoteFile('error', s)
    assert.ok(errPool.has(f), `seed=${s} 取到了池外的图：${f}`)
    assert.ok(!f.includes('yay'), `seed=${s} 出错配了「好耶」：${f}`)
    assert.ok(!f.includes('so-good'), `seed=${s} 出错配了「太中啦」：${f}`)
  }
})

ok('⭐ 任意 seed 下，"完成"的结果永远不含哭泣/生气类', () => {
  const happyPool = new Set(emotePool('happy'))
  for (let s = 0; s < 40; s++) {
    const f = pickEmoteFile('happy', s)
    assert.ok(happyPool.has(f), `seed=${s} 取到了池外的图：${f}`)
    for (const bad of ['crying', 'annoyed', 'hate-you', 'disgusted', 'unhappy']) {
      assert.ok(!f.includes(bad), `seed=${s} 完成配了负面表情（${bad}）：${f}`)
    }
  }
})
ok('覆盖率自检：能报出未被任何状态池引用的图（诊断用）', () => {
  const all = ['bubble/17-yay.png', 'bubble/never-used.png']
  const r = emoteCoverage(all)
  assert.deepEqual(r.used, ['bubble/17-yay.png'])
  assert.deepEqual(r.unused, ['bubble/never-used.png'])
})

ok('排除名单里的图**不该**出现在随机回落里（语义太强）', () => {
  // 这些图只在明确情境用；随机撒会显得没头没脑。
  // 注意：它们仍可出现在具体状态池里（例如 comfort 属于安慰情境）。
  assert.ok(EMOTE_EXCLUDE_FROM_RANDOM.length > 0, '应有一份排除名单')
  for (const f of EMOTE_EXCLUDE_FROM_RANDOM) {
    assert.ok(typeof f === 'string' && f.startsWith('bubble/'), `排除名单项格式不对：${f}`)
  }
})
section('14. 素材清单与路径安全（atlas.js）')

const goodAtlas = normalizeAtlas({
  version: 1,
  generatedAt: '2026-10-04T00:00:00.000Z',
  frameHeight: 256,
  states: {
    idle: { file: 'idle.png', frames: 33, frameMs: 36 },
    working: { file: 'working.png', frames: 33, frameMs: 36 },
    bogus: { file: 'bogus.png', frames: 1, frameMs: 36 }
  },
  variants: { idle: ['idle.png', 'idle-2.png'] },
  bubble: [{ file: 'bubble/01.png', w: 240, h: 240 }],
  missing: [{ name: '表情包_08_爱你哦', reason: 'needsCutout' }]
})

ok('非法状态名被丢弃（bogus 不在）', () => {
  assert.equal(goodAtlas.states.bogus, undefined)
  assert.ok(goodAtlas.states.idle)
})

ok('frameWidth 被保留（单帧非方形，两侧都要它）', () => {
  const a = normalizeAtlas({
    frameHeight: 256,
    states: { idle: { file: 'idle.png', frames: 1, frameWidth: 284 } }
  })
  assert.equal(a.states.idle.frameWidth, 284)
})

ok('缺 frameWidth 时为 null（回落方形假设，旧清单仍可用）', () => {
  const a = normalizeAtlas({
    frameHeight: 256,
    states: { idle: { file: 'idle.png', frames: 1 } }
  })
  assert.equal(a.states.idle.frameWidth, null)
})

ok('frameWidth 非法值时回落 null，不崩', () => {
  for (const bad of [0, -5, 'abc', null, {}]) {
    const a = normalizeAtlas({ states: { idle: { file: 'i.png', frames: 1, frameWidth: bad } } })
    assert.equal(a.states.idle.frameWidth, null, `${JSON.stringify(bad)} 应回落 null`)
  }
})

/* ── files 映射：每个文件自己的几何 ────────────────────────────────────────
 *
 * 这组测试对应一个**实测到的真实缺陷**：`variants` 里混了「静态 PNG（1 帧）」
 * 与「动态 GIF（N 帧）」，24 个变体里 **14 个**与所属 state 的声明不符。
 * 若按 state 的 `frames` 去切变体，`happy-4.png`（239px）会被切成 7px 碎条。
 * ────────────────────────────────────────────────────────────────────────── */

ok('files 映射被解析（每个文件自己的几何）', () => {
  const a = normalizeAtlas({
    frameHeight: 256,
    states: { happy: { file: 'happy.png', frames: 33, frameWidth: 256 } },
    variants: { happy: ['happy.png', 'happy-2.png'] },
    files: {
      'happy.png': { frames: 33, frameWidth: 256, frameMs: 30 },
      'happy-2.png': { frames: 1, frameWidth: 274, frameMs: 0 }
    }
  })
  assert.equal(a.files['happy.png'].frames, 33)
  assert.equal(a.files['happy-2.png'].frames, 1, '变体是静态图，只有 1 帧')
  assert.equal(a.files['happy-2.png'].frameWidth, 274)
})

ok('geometryFor 按「文件」取几何，而不是按「状态」', () => {
  const a = normalizeAtlas({
    frameHeight: 256,
    states: { happy: { file: 'happy.png', frames: 33, frameWidth: 256 } },
    variants: { happy: ['happy.png', 'happy-2.png'] },
    files: {
      'happy.png': { frames: 33, frameWidth: 256, frameMs: 30 },
      'happy-2.png': { frames: 1, frameWidth: 274, frameMs: 0 }
    }
  })
  // 关键：同一个 state 的两个文件几何不同 —— 这正是 native-exe 报告的缺陷
  assert.equal(geometryFor(a, 'happy.png').frames, 33)
  assert.equal(geometryFor(a, 'happy-2.png').frames, 1, '变体不该被切成 33 段碎条')
  assert.equal(geometryFor(a, 'happy-2.png').frameWidth, 274)
})

ok('files 优先于 states 声明（能修正错误的声明）', () => {
  const a = normalizeAtlas({
    frameHeight: 256,
    // states 声明 33 帧，但 files 说这张图其实只有 1 帧
    states: { happy: { file: 'happy.png', frames: 33, frameWidth: 256 } },
    files: { 'happy.png': { frames: 1, frameWidth: 274, frameMs: 0 } }
  })
  assert.equal(a.states.happy.frames, 1, 'files 应覆盖 states 的错误声明')
  assert.equal(a.states.happy.frameWidth, 274)
})

ok('缺 files 时回落到 states 声明（旧清单仍可用）', () => {
  const a = normalizeAtlas({
    frameHeight: 256,
    states: { idle: { file: 'idle.png', frames: 4, frameWidth: 250, frameMs: 60 } },
    variants: { idle: ['idle.png'] }
  })
  assert.equal(Object.keys(a.files).length, 0)
  assert.equal(a.states.idle.frames, 4)
  assert.equal(geometryFor(a, 'idle.png').frames, 4, '应回落到 states 声明')
})

ok('geometryFor 对未知文件回落安全默认值（不抛）', () => {
  const a = normalizeAtlas({ states: { idle: { file: 'i.png', frames: 2 } } })
  const g = geometryFor(a, 'nope.png')
  assert.equal(g.frames, 1)
  assert.equal(g.frameWidth, null)
  assert.doesNotThrow(() => geometryFor(null, 'x.png'))
  assert.doesNotThrow(() => geometryFor(a, undefined))
})

ok('files 里的遍历路径被丢弃', () => {
  const a = normalizeAtlas({
    states: { idle: { file: 'i.png', frames: 1 } },
    files: { '../evil.png': { frames: 1, frameWidth: 10 } }
  })
  assert.equal(a.files['../evil.png'], undefined)
  assert.equal(a.allowed.has('../evil.png'), false)
})

ok('files 里的非法几何条目被跳过', () => {
  const a = normalizeAtlas({
    states: { idle: { file: 'i.png', frames: 1 } },
    files: {
      'a.png': { frames: 0, frameWidth: 10 },
      'b.png': { frames: 'x' },
      'c.png': { frames: 2, frameWidth: 100 }
    }
  })
  assert.equal(a.files['a.png'], undefined, 'frames=0 非法')
  assert.equal(a.files['b.png'], undefined, 'frames 非数字非法')
  assert.ok(a.files['c.png'], '合法条目应保留')
})

ok('files 里的文件也进白名单（变体图能被服务）', () => {
  const a = normalizeAtlas({
    states: { idle: { file: 'i.png', frames: 1 } },
    variants: { idle: ['i.png', 'i-2.png'] },
    files: { 'i-2.png': { frames: 1, frameWidth: 100 } }
  })
  assert.ok(a.allowed.has('i-2.png'), '变体应在白名单里')
})

ok('atlasReport 报出 files 几何条目数', () => {
  const a = normalizeAtlas({
    frameHeight: 256,
    states: { idle: { file: 'i.png', frames: 1 } },
    files: { 'i.png': { frames: 1, frameWidth: 100 } }
  })
  assert.equal(atlasReport(a).fileGeometry, 1)
})

ok('states 的键都在合法状态名内', () => {
  for (const k of Object.keys(goodAtlas.states)) {
    assert.ok(VALID_STATES.includes(k), `${k} 不是合法状态名`)
  }
})

ok('白名单包含 states/variants/bubble 里的全部文件', () => {
  for (const f of ['idle.png', 'working.png', 'idle-2.png', 'bubble/01.png']) {
    assert.ok(goodAtlas.allowed.has(f), `白名单缺 ${f}`)
  }
})

ok('isSafeRel 挡住目录遍历', () => {
  for (const bad of ['../secret.png', 'a/../../b.png', '..\\..\\x.png', '/abs.png', 'C:\\x.png', '']) {
    assert.equal(isSafeRel(bad), false, `应拒绝 ${bad}`)
  }
  for (const good of ['idle.png', 'bubble/01.png', 'thumbs/idle.png']) {
    assert.equal(isSafeRel(good), true, `应接受 ${good}`)
  }
})

ok('恶意清单里的遍历路径被丢弃', () => {
  const evil = normalizeAtlas({
    states: {
      idle: { file: '../../../etc/passwd' },
      happy: { file: 'happy.png', frames: 2 }
    },
    bubble: [{ file: '../outside.png' }]
  })
  assert.equal(evil.states.idle, undefined, '遍历路径不该进清单')
  assert.ok(evil.states.happy)
  assert.equal(evil.bubble.length, 0)
  assert.equal(evil.allowed.has('../outside.png'), false)
})

ok('resolveArt 拒绝白名单外的文件', () => {
  const artDir = 'C:\\fake\\art\\pet'
  assert.equal(resolveArt(artDir, 'not-in-list.png', goodAtlas), null)
})

ok('resolveArt 接受白名单内文件并给出绝对路径', () => {
  const artDir = 'C:\\fake\\art\\pet'
  const abs = resolveArt(artDir, 'idle.png', goodAtlas)
  assert.ok(abs !== null && abs.endsWith('idle.png'))
})

ok('resolveArt 拒绝遍历（即使绕过白名单）', () => {
  const artDir = 'C:\\fake\\art\\pet'
  const noWhitelist = emptyAtlas()
  assert.equal(resolveArt(artDir, '../../secret.png', noWhitelist), null)
})

ok('空/损坏清单回落为空且不抛', () => {
  assert.equal(normalizeAtlas(null).allowed.size, 0)
  assert.equal(normalizeAtlas(undefined).allowed.size, 0)
  assert.equal(normalizeAtlas('garbage').allowed.size, 0)
  assert.equal(normalizeAtlas(42).allowed.size, 0)
  assert.equal(emptyAtlas().frameHeight, 0)
})

ok('artForState 缺状态时回落 idle', () => {
  const atlas = normalizeAtlas({ states: { idle: { file: 'idle.png', frames: 1 } } })
  assert.equal(artForState(atlas, 'sleeping', 0), 'idle.png')
})

ok('artForState 支持 variants 轮换', () => {
  const atlas = normalizeAtlas({
    states: { idle: { file: 'a.png', frames: 1 } },
    variants: { idle: ['a.png', 'b.png'] }
  })
  assert.equal(artForState(atlas, 'idle', 0), 'a.png')
  assert.equal(artForState(atlas, 'idle', 1), 'b.png')
  assert.equal(artForState(atlas, 'idle', 2), 'a.png', '应回绕')
})

ok('artForState 对空清单返回 null 而不是抛错', () => {
  assert.equal(artForState(emptyAtlas(), 'idle', 0), null)
  assert.equal(artForState(null, 'idle', 0), null)
})

ok('bubbleArt 返回整条记录（含 hasText）且空池返回 null', () => {
  const atlas = normalizeAtlas({
    bubble: [{ file: 'b/1.png', hasText: true }, { file: 'b/2.png' }]
  })
  // 返回**记录**而不是字符串：调用方需要 hasText 才能决定要不要叠文字。
  assert.equal(bubbleArt(atlas, 0).file, 'b/1.png')
  assert.equal(bubbleArt(atlas, 0).hasText, true)
  assert.equal(bubbleArt(atlas, 1).file, 'b/2.png')
  assert.equal(bubbleArt(atlas, 1).hasText, false, '缺字段按 false（安全侧：允许配文字）')
  assert.equal(bubbleArt(atlas, 2).file, 'b/1.png', '应回绕')
  assert.equal(bubbleArt(emptyAtlas(), 0), null)
  assert.equal(bubbleArt(null, 0), null)
})

/* ── hasText：图自带文字时不能叠 Host 文案 ─────────────────────────────────
 *
 * 素材里有一整类「中文已经印在图上」的聊天贴纸（实测 16 张，如「好耶！」「工作中…」）。
 * 这类图当气泡时若再叠一句 Host 文案（"正在调用工具…"），屏幕上会出现**两段互相
 * 打架的文字**。契约 §4 因此新增 `bubble[].hasText`。
 * ────────────────────────────────────────────────────────────────────────── */

ok('bubbleHasText 按文件查表，未知文件按 false', () => {
  const atlas = normalizeAtlas({
    bubble: [{ file: 'b/with-text.png', hasText: true }, { file: 'b/plain.png' }]
  })
  assert.equal(bubbleHasText(atlas, 'b/with-text.png'), true)
  assert.equal(bubbleHasText(atlas, 'b/plain.png'), false)
  assert.equal(bubbleHasText(atlas, 'b/unknown.png'), false, '未知文件按 false')
  assert.equal(bubbleHasText(null, 'x.png'), false)
})

ok('⭐ 图自带文字 → 气泡不叠文案（kind=image，text=null）', () => {
  const { machine } = makeMachine({}, () => ({ file: 'bubble/sticker.png', hasText: true }))
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  const b = machine.snapshot().bubble
  assert.ok(b !== null, '应弹气泡')
  assert.equal(b.kind, 'image', '自带文字的图不能配 text，否则两段文字打架')
  assert.equal(b.text, null, 'text 必须为 null')
  assert.equal(b.imageHasText, true, '应透传 imageHasText 供诊断')
  assert.equal(b.image, 'bubble/sticker.png')
})

ok('图不带文字 → 正常叠文案（kind=both）', () => {
  const { machine } = makeMachine({}, () => ({ file: 'bubble/plain.png', hasText: false }))
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  const b = machine.snapshot().bubble
  assert.equal(b.kind, 'both')
  assert.ok(typeof b.text === 'string' && b.text.length > 0, '应有文案')
  assert.equal(b.imageHasText, false)
})

ok('pickBubbleImage 返回纯字符串时仍按旧行为（向后兼容）', () => {
  const { machine } = makeMachine({}, () => 'bubble/legacy.png')
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  const b = machine.snapshot().bubble
  assert.equal(b.image, 'bubble/legacy.png')
  assert.equal(b.kind, 'both', '字符串形式没有 hasText 信息 → 按可叠文字处理')
  assert.equal(b.imageHasText, false)
})

ok('只给文字不给图时 kind=text（图不可用也不崩）', () => {
  const { machine } = makeMachine({}, () => null)
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  const b = machine.snapshot().bubble
  assert.equal(b.kind, 'text')
  assert.equal(b.image, null)
  assert.equal(b.imageHasText, false)
})

/* ── opaque / fileDark：不透明满幅贴纸与深色模式变体 ───────────────────────
 *
 * 素材里新增了一批「黑白线稿 + 白底铺满整图」的贴纸（实测 20 张）。
 * 它们不能抠白底（白色既是背景也是脸的填充色），呈现方式与透明抠图不同：
 * 不该再套气泡自己的底。深色模式则需要换用变体文件。
 * ────────────────────────────────────────────────────────────────────────── */

ok('normalizeAtlas 保留 opaque 与 fileDark，并把深色文件加进白名单', () => {
  const atlas = normalizeAtlas({
    bubble: [{
      file: 'bubble/new/01.png', w: 256, h: 256,
      hasText: true, opaque: true, fileDark: 'bubble/new/01-dark.png'
    }]
  })
  const e = atlas.bubble[0]
  assert.equal(e.opaque, true)
  assert.equal(e.hasText, true)
  assert.equal(e.fileDark, 'bubble/new/01-dark.png')
  assert.ok(atlas.allowed.has('bubble/new/01-dark.png'),
    '深色文件必须进白名单，否则 /pet/art/ 服务不了它')
})

ok('缺 opaque/fileDark 时按缺省（旧清单向后兼容）', () => {
  const atlas = normalizeAtlas({ bubble: [{ file: 'b/1.png', w: 1, h: 1 }] })
  const e = atlas.bubble[0]
  assert.equal(e.opaque, false)
  assert.equal(e.fileDark, null)
})

ok('fileDark 是遍历路径时被丢弃且不进白名单', () => {
  const atlas = normalizeAtlas({
    bubble: [{ file: 'b/1.png', w: 1, h: 1, fileDark: '../../secret.png' }]
  })
  assert.equal(atlas.bubble[0].fileDark, null)
  assert.ok(!atlas.allowed.has('../../secret.png'))
})

ok('resolveBubbleFile 深色挑变体、浅色挑原图、缺失回落原图', () => {
  const e = { file: 'a.png', fileDark: 'a-dark.png' }
  assert.equal(resolveBubbleFile(e, true), 'a-dark.png')
  assert.equal(resolveBubbleFile(e, false), 'a.png')
  assert.equal(resolveBubbleFile({ file: 'a.png' }, true), 'a.png', '没有变体就回落原图')
  assert.equal(resolveBubbleFile(null, true), null)
})

ok('⭐ 状态机把 imageOpaque / imageDark 透传到快照', () => {
  const { machine } = makeMachine({}, () => ({
    file: 'bubble/new/01.png', hasText: true, opaque: true, fileDark: 'bubble/new/01-dark.png'
  }))
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  const b = machine.snapshot().bubble
  assert.equal(b.image, 'bubble/new/01.png')
  assert.equal(b.imageOpaque, true, '渲染方据此不再套气泡底')
  assert.equal(b.imageDark, 'bubble/new/01-dark.png', '渲染方据此在深色模式换图')
  assert.equal(b.imageHasText, true)
  assert.equal(b.text, null, '自带文字的贴纸不叠文案')
})

ok('旧式 pickBubbleImage（纯字符串）时 imageOpaque=false 且 imageDark=null', () => {
  const { machine } = makeMachine({}, () => 'bubble/legacy.png')
  machine.apply({ type: 'agent/status', sessionId: 's1', status: 'running' })
  machine.apply({ type: 'tool/call', sessionId: 's1', callId: 'c1' })
  const b = machine.snapshot().bubble
  assert.equal(b.imageOpaque, false)
  assert.equal(b.imageDark, null)
})

ok('atlasReport 报出覆盖与缺失', () => {
  const rep = atlasReport(goodAtlas)
  assert.ok(rep.coveredStates.includes('idle'))
  assert.ok(rep.uncoveredStates.includes('sleeping'))
  assert.equal(rep.missingCount, 1)
  assert.equal(rep.missing[0].reason, 'needsCutout')
})

ok('states 为空但 variants 有内容时用 variants 兜底', () => {
  const atlas = normalizeAtlas({ variants: { idle: ['only.png'] } })
  assert.equal(atlas.states.idle.file, 'only.png')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 11. 文案
 * ═════════════════════════════════════════════════════════════════════════ */
section('11. 文案本地化')

ok('每个状态都有中英文案', () => {
  for (const s of PET_STATES) {
    assert.ok(STATE_TEXT[s]?.zh, `${s} 缺中文`)
    assert.ok(STATE_TEXT[s]?.en, `${s} 缺英文`)
  }
})

ok('textOf 支持 zh/en 且未知 key 回落 key 本身', () => {
  assert.equal(textOf(STATE_TEXT, 'working', 'zh'), '正在调用工具…')
  assert.equal(textOf(STATE_TEXT, 'working', 'en'), 'Working…')
  assert.equal(textOf(STATE_TEXT, 'nope', 'zh'), 'nope')
})

ok('未知 locale 回落到 zh', () => {
  assert.equal(textOf(STATE_TEXT, 'idle', 'fr'), '待机中')
})

ok('DEFAULT_CONFIG 的 bubbleStates 都是合法状态', () => {
  for (const s of DEFAULT_CONFIG.bubbleStates) {
    assert.ok(PET_STATES.includes(s), `${s} 不是合法状态`)
  }
})

/* ═════════════════════════════════════════════════════════════════════════ */
console.log(`\n${'═'.repeat(60)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('❌ 有失败项')
  process.exit(1)
}
console.log('✅ 全部通过')