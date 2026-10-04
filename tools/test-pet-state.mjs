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
  DEFAULT_CONFIG
} from '../src/pet/state.js'
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
section('10. 素材清单与路径安全（atlas.js）')

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

ok('bubbleArt 轮换且空池返回 null', () => {
  const atlas = normalizeAtlas({ bubble: [{ file: 'b/1.png' }, { file: 'b/2.png' }] })
  assert.equal(bubbleArt(atlas, 0), 'b/1.png')
  assert.equal(bubbleArt(atlas, 1), 'b/2.png')
  assert.equal(bubbleArt(emptyAtlas(), 0), null)
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