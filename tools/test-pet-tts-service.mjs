/**
 * 庄方宜桌宠 · 合成服务监管单测（"语音模型常驻"开关）
 *
 * 用法：`node tools/test-pet-tts-service.mjs`
 *
 * ── 这套测试在防什么 ──────────────────────────────────────────────────────
 *
 * 这个开关的两个坏行为都**很贵**，而且都发生在用户看不见的地方：
 *
 *   1. **该释放时不释放** —— 非常驻模式下服务一直活着，显存被占着。
 *      用户以为关掉了常驻，实际没关（从现象上完全看不出来）。
 *   2. **不该杀时杀了** —— 用户自己在终端起的服务被桌宠杀掉。
 *      这比"没释放"更糟：别人的进程不该被我们终止。
 *
 * 所以 `nextServiceAction` 被抽成**纯函数**，穷举那张决策矩阵；
 * 而"只停自己起的"（`ours`）是第一条断言。
 */

import assert from 'node:assert/strict'

import {
  buildServeCommand,
  nextServiceAction,
  createTtsSupervisor,
  DEFAULT_IDLE_STOP_SEC,
  RAPID_EXIT_MS
} from '../src/pet/tts-service.js'

let passed = 0
let failed = 0

function section (name) { console.log(`\n── ${name} ──`) }
function ok (label, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${label}`) } catch (e) {
    failed += 1; console.log(`  ✗ ${label}\n      ${e?.message ?? e}`)
  }
}
async function okAsync (label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`) } catch (e) {
    failed += 1; console.log(`  ✗ ${label}\n      ${e?.message ?? e}`)
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 启动命令组装
 * ══════════════════════════════════════════════════════════════════════════ */

section('1. 启动命令组装')

ok('缺 python 或 repoDir → null（绝不拼一个半截命令）', () => {
  assert.equal(buildServeCommand({}), null)
  assert.equal(buildServeCommand({ python: 'py' }), null)
  assert.equal(buildServeCommand({ repoDir: 'D:\\x' }), null)
  assert.equal(buildServeCommand({ python: '  ', repoDir: 'D:\\x' }), null)
})

ok('⭐ CLI 形状：全局参数在 `serve` **之前**（子插件的参数结构）', () => {
  const c = buildServeCommand({
    python: 'py.exe', repoDir: 'D:\\vf', backend: 'torch', gsvRoot: 'D:\\gsv', port: 8765
  })
  const argv = c.argv
  const iServe = argv.indexOf('serve')
  assert.ok(iServe > 0, '必须有 serve 子命令')
  assert.ok(argv.indexOf('--backend') < iServe, '--backend 必须在 serve 前（全局参数）')
  assert.ok(argv.indexOf('--gsv-root') < iServe, '--gsv-root 必须在 serve 前')
  assert.ok(argv.indexOf('--port') > iServe, '--port 属于 serve 子命令')
  assert.deepEqual(argv.slice(0, 3), ['py.exe', '-m', 'zfh_voice'])
})

ok('backend 只接受 torch/onnx（其它值不传，用子插件默认）', () => {
  const a = buildServeCommand({ python: 'p', repoDir: 'D:\\x', backend: 'torch' })
  assert.ok(a.argv.includes('--backend') && a.argv.includes('torch'))
  const b = buildServeCommand({ python: 'p', repoDir: 'D:\\x', backend: 'onnx' })
  assert.ok(b.argv.includes('onnx'))
  for (const bad of ['', 'cuda', 'TORCH', 'torch;rm', null, undefined]) {
    const c = buildServeCommand({ python: 'p', repoDir: 'D:\\x', backend: bad })
    assert.ok(!c.argv.includes('--backend'), `非法 backend ${JSON.stringify(bad)} 不该被传下去`)
  }
})

ok('可选参数：没给就不传（不传空串给子插件）', () => {
  const c = buildServeCommand({ python: 'p', repoDir: 'D:\\x' })
  assert.ok(!c.argv.includes('--gsv-root'))
  assert.ok(!c.argv.includes('--model-dir'))
})

ok('port 默认 8765；非法值回落默认（不是 NaN 传给子插件）', () => {
  const d = buildServeCommand({ python: 'p', repoDir: 'D:\\x' })
  assert.equal(d.argv[d.argv.length - 1], '8765')
  for (const bad of [0, -1, NaN, 'abc', null]) {
    const c = buildServeCommand({ python: 'p', repoDir: 'D:\\x', port: bad })
    assert.equal(c.argv[c.argv.length - 1], '8765', `port=${JSON.stringify(bad)} 应回落 8765`)
  }
  const good = buildServeCommand({ python: 'p', repoDir: 'D:\\x', port: 9000 })
  assert.equal(good.argv[good.argv.length - 1], '9000')
})

ok('⭐⭐ 自动带 PYTHONPATH=src（子插件是 src 布局，不装也能跑）', () => {
  // 这条能让用户**不必先 pip install -e .**。不带的话
  // `python -m zfh_voice` 直接 ModuleNotFoundError —— 而错误信息在
  // stdio:'ignore' 下根本看不到，用户只会看到"服务起不来"。
  const c = buildServeCommand({ python: 'p', repoDir: 'D:\\vf' })
  assert.equal(c.env.PYTHONPATH, 'D:\\vf\\src')
  const fwd = buildServeCommand({ python: 'p', repoDir: 'D:/vf' })
  assert.equal(fwd.env.PYTHONPATH, 'D:/vf/src', '正斜杠路径不该被改成反斜杠')
  const trailing = buildServeCommand({ python: 'p', repoDir: 'D:\\vf\\' })
  assert.equal(trailing.env.PYTHONPATH, 'D:\\vf\\src', '结尾分隔符不该变双斜杠')
})

ok('cwd 设成仓库根（相对导入与缓存目录都相对它）', () => {
  const c = buildServeCommand({ python: 'p', repoDir: 'D:\\vf' })
  assert.equal(c.cwd, 'D:\\vf')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 决策矩阵（纯函数，穷举）
 * ══════════════════════════════════════════════════════════════════════════ */

section('2. 决策矩阵')

const base = {
  resident: false, ours: true, healthy: true,
  idleMs: 0, idleLimitMs: 300000, launchable: true, rapidExit: false
}
const decide = patch => nextServiceAction({ ...base, ...patch })

ok('⭐⭐ 不是我们起的 → 永远不动它（用户自己开的服务）', () => {
  // 最要紧的一条：别人的进程不该被我们终止。
  for (const patch of [
    { ours: false, healthy: true, resident: false, idleMs: 99999999 },
    { ours: false, healthy: false, resident: true },
    { ours: false, healthy: true, resident: true }
  ]) {
    const d = decide(patch)
    assert.equal(d.action, 'none', `${JSON.stringify(patch)} → ${d.action}`)
    assert.equal(d.why, 'not-ours')
  }
})

ok('⭐⭐ 非常驻 + 空闲超限 → stop（释放显存）', () => {
  const d = decide({ resident: false, idleMs: 300001, idleLimitMs: 300000 })
  assert.equal(d.action, 'stop')
  assert.equal(d.why, 'idle-stop')
})

ok('非常驻 + 还没到空闲上限 → 留着（还在用）', () => {
  assert.equal(decide({ resident: false, idleMs: 1000, idleLimitMs: 300000 }).action, 'none')
})

ok('⭐ 空闲上限为 0 = 不自动停（用户明确要它一直活着）', () => {
  assert.equal(decide({ resident: false, idleMs: 99999999, idleLimitMs: 0 }).action, 'none')
})

ok('⭐⭐ 常驻 + 健康 → 永远不因空闲而停', () => {
  const d = decide({ resident: true, idleMs: 99999999, idleLimitMs: 1000 })
  assert.equal(d.action, 'none')
  assert.equal(d.why, 'resident-keep')
})

ok('⭐ 常驻 + 不健康 → restart（挂了自动拉起）', () => {
  const d = decide({ resident: true, healthy: false })
  assert.equal(d.action, 'restart')
})

ok('⭐⭐ 短命退出 → 不重启（防重启风暴）', () => {
  // 与 launcher.js 同一条教训：起不来时自动重启会变成无限重启，
  // 用户看到的是 CPU 打满 + 一堆僵尸进程。
  const d = decide({ resident: true, healthy: false, rapidExit: true })
  assert.equal(d.action, 'none')
  assert.equal(d.why, 'down-rapid-exit')
})

ok('非常驻 + 不健康 → 不自动重启（等下次真要合成时再起）', () => {
  const d = decide({ resident: false, healthy: false })
  assert.equal(d.action, 'none')
  assert.equal(d.why, 'down-not-resident')
})

ok('没有启动命令 + 不健康 → 不重启（想重启也重启不了）', () => {
  const d = decide({ resident: true, healthy: false, launchable: false })
  assert.equal(d.action, 'none')
  assert.equal(d.why, 'down-no-launch')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 监管器（注入 spawn / health）
 * ══════════════════════════════════════════════════════════════════════════ */

section('3. 监管器')

function makeSpawn () {
  const calls = []
  const spawned = []
  const spawn = spec => {
    calls.push(spec)
    const h = {
      pid: 4242 + spawned.length,
      terminated: false,
      done: new Promise(() => {}),   // 永不退出（模拟常驻）
      terminate () { this.terminated = true; spawned.push(this) }
    }
    spawned.push(h)
    return h
  }
  return { spawn, calls, spawned }
}

/**
 * 造一个"**spawn 之后才健康**"的桩。
 *
 * ⚠️ 这不是可选的花样：第一版测试直接把 health 写死成"一直健康"，
 * 于是 `ensure()` 正确地走了"服务已在跑、不 spawn"分支 ——
 * 四个测试全都在测"不是我们起的"这条路径，而不是它们以为的那条。
 * 桩必须复刻真实时序（起进程 → 加载模型 → 才健康）。
 */
function spawnGatedHealth (backend = 'torch') {
  const state = { started: false }
  const health = async () => (state.started ? { ok: true, backend } : null)
  const spawn = spec => {
    state.calls.push(spec)
    state.started = true          // 起进程后（模拟加载完成）才健康
    const h = {
      pid: 9000 + state.handles.length,
      terminated: false,
      done: new Promise(() => {}),
      terminate () { this.terminated = true }
    }
    state.handles.push(h)
    return h
  }
  state.calls = []
  state.handles = []
  return { health, spawn, state }
}

await okAsync('没有启动命令 → ensure 返回 false，且**不 spawn**', async () => {
  const { spawn, calls } = makeSpawn()
  const sup = createTtsSupervisor({ spawn, health: async () => null, logger: null })
  sup.configure({ launch: null })
  assert.equal(await sup.ensure(), false)
  assert.equal(calls.length, 0, '没有命令就不该起进程')
})

await okAsync('服务已在跑（用户自己起的）→ ensure 直接用，**不 spawn**', async () => {
  const { spawn, calls } = makeSpawn()
  const sup = createTtsSupervisor({ spawn, health: async () => ({ ok: true, backend: 'torch' }) })
  sup.configure({ launch: { argv: ['p'], cwd: 'c', env: {} } })
  assert.equal(await sup.ensure(), true)
  assert.equal(calls.length, 0, '已健康就不该再起一个')
  assert.equal(sup.status().backend, 'torch')
  assert.equal(sup.status().ours, false, '不是我们起的 → ours=false（绝不停止它）')
})

await okAsync('⭐ 服务没跑 → 按命令启动，并等它就绪', async () => {
  const { spawn, calls } = makeSpawn()
  let probes = 0
  const sup = createTtsSupervisor({
    spawn,
    health: async () => (++probes >= 2 ? { ok: true, backend: 'onnx' } : null),
    logger: null
  })
  sup.configure({ launch: { argv: ['py', '-m', 'zfh_voice', 'serve'], cwd: 'D:\\vf', env: {} } })
  assert.equal(await sup.ensure(), true)
  assert.equal(calls.length, 1, '应启动一次')
  assert.deepEqual(calls[0].argv, ['py', '-m', 'zfh_voice', 'serve'])
  assert.equal(calls[0].cwd, 'D:\\vf')
  assert.equal(sup.status().ours, true, '我们起的 → ours=true')
  assert.ok(sup.status().pid > 0, '应记下 pid')
})

await okAsync('⭐⭐ stop 只终止**自己起的**（用户的服务碰都不碰）', async () => {
  // ① 用户自己起的（health 一开始就健康 → 我们不 spawn）→ stop 不发终止
  const a = makeSpawn()
  const supA = createTtsSupervisor({ spawn: a.spawn, health: async () => ({ ok: true }) })
  await supA.ensure()
  assert.equal(supA.status().ours, false, '用户自己起的 → ours=false')
  assert.equal(supA.stop(), false, '不是我们起的不该终止')
  assert.equal(a.spawned.filter(h => h.terminated).length, 0)

  // ② 我们起的（spawn 后才健康）→ stop 要真终止
  const g = spawnGatedHealth()
  const supB = createTtsSupervisor({ spawn: g.spawn, health: g.health })
  supB.configure({ launch: { argv: ['p'], cwd: 'c', env: {} } })
  assert.equal(await supB.ensure(), true)
  assert.equal(supB.status().ours, true, '我们起的 → ours=true')
  assert.equal(supB.stop(), true, '我们起的应该能停')
  assert.equal(g.state.handles.filter(h => h.terminated).length, 1, '应真的终止了进程')
})

await okAsync('⭐ tick：非常驻 + 空闲超限 → 自动停掉释放显存', async () => {
  const g = spawnGatedHealth()
  let t = 1000
  const sup = createTtsSupervisor({ spawn: g.spawn, health: g.health, now: () => t })
  sup.configure({ launch: { argv: ['p'], cwd: 'c', env: {} }, resident: false, idleStopSec: 60 })
  assert.equal(await sup.ensure(), true)
  assert.equal(g.state.handles.length, 1, '应是我们起的')
  t += 30000
  assert.equal((await sup.tick()).action, 'none', '30 秒还没到（上限 60）')
  t += 40000                       // 累计 70 秒 > 60
  const d = await sup.tick()
  assert.equal(d.action, 'stop')
  assert.equal(g.state.handles.filter(h => h.terminated).length, 1, '应真的停掉了')
})

await okAsync('⭐⭐ 常驻模式：空闲再久也不停（这就是"常驻"的意思）', async () => {
  const g = spawnGatedHealth()
  let t = 1000
  const sup = createTtsSupervisor({ spawn: g.spawn, health: g.health, now: () => t })
  sup.configure({ launch: { argv: ['p'], cwd: 'c', env: {} }, resident: true, idleStopSec: 1 })
  assert.equal(await sup.ensure(), true)
  assert.equal(g.state.handles.length, 1, '应是我们起的')
  t += 3600000                     // 一小时没说话
  const d = await sup.tick()
  assert.equal(d.action, 'none')
  assert.equal(d.why, 'resident-keep')
  assert.equal(g.state.handles.filter(h => h.terminated).length, 0, '常驻就不该被停')
})

await okAsync('⭐ 常驻 + 服务被杀 → tick 重新拉起', async () => {
  const g = spawnGatedHealth()
  const sup = createTtsSupervisor({ spawn: g.spawn, health: g.health, logger: null })
  sup.configure({ launch: { argv: ['p'], cwd: 'c', env: {} }, resident: true })
  assert.equal(await sup.ensure(), true)
  assert.equal(g.state.calls.length, 1)
  g.state.started = false           // 服务崩了（健康检查不再通过）
  const d = await sup.tick()
  assert.equal(d.action, 'restart')
})

await okAsync('⭐⭐ 短命退出后不再自动重启（只记最后一次错误）', async () => {
  const spawn = () => ({
    pid: 1,
    terminated: false,
    // 立刻退出 —— 模拟"依赖没装/模型缺失"
    done: Promise.resolve({ exitCode: 1 }),
    terminate () { this.terminated = true }
  })
  let healthCalls = 0
  const sup = createTtsSupervisor({
    spawn,
    health: async () => { healthCalls += 1; return null },
    logger: null
  })
  sup.configure({ launch: { argv: ['p'], cwd: 'c', env: {} }, resident: true, startTimeoutMs: 2000 })
  assert.equal(await sup.ensure(), false, '起不来就该如实返回 false')
  assert.ok(sup.status().lastError !== null, '必须记下失败原因（用户要能查）')
  await new Promise(r => setTimeout(r, 50))   // 让 done 回调记账
  const d = await sup.tick()
  assert.equal(d.action, 'none', '短命退出后不该再重启')
  assert.equal(d.why, 'down-rapid-exit')
})

await okAsync('status 暴露设置页需要的一切（不含秘密）', async () => {
  const sup = createTtsSupervisor({ spawn: makeSpawn().spawn, health: async () => null })
  sup.configure({ launch: null, resident: true, idleStopSec: 120 })
  const st = sup.status()
  for (const k of ['resident', 'launchable', 'ours', 'ready', 'idleMs', 'idleStopSec']) {
    assert.ok(k in st, `status 缺字段 ${k}`)
  }
  assert.equal(st.resident, true)
  assert.equal(st.launchable, false, '没命令 → launchable=false')
  assert.equal(st.idleStopSec, 120)
})

await okAsync('configure 过滤非法值（不把 NaN 灌进决策）', async () => {
  const sup = createTtsSupervisor({ spawn: makeSpawn().spawn, health: async () => null })
  sup.configure({ idleStopSec: 'abc', resident: 'yes', launch: undefined })
  const st = sup.status()
  assert.equal(st.idleStopSec, DEFAULT_IDLE_STOP_SEC, 'idleStopSec 非法应保持默认')
  assert.equal(st.resident, false, '非布尔不该被当成 true')
})

ok('默认空闲释放时间是 5 分钟（够一次对话，又不长期占显存）', () => {
  assert.equal(DEFAULT_IDLE_STOP_SEC, 300)
})

ok('短命退出阈值是 10 秒（与 launcher.js 同一纪律）', () => {
  assert.equal(RAPID_EXIT_MS, 10000)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败项'}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
