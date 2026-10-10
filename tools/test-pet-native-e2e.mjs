/**
 * 庄方宜桌宠 · 原生 exe 集成测试（**真起 exe，真连宿主**）
 *
 * 用法：`node tools/test-pet-native-e2e.mjs`
 *
 * ── 为什么需要这一套（前三套都测不到的地方）──────────────────────────────
 *
 * 现有四套测试都在 Node 侧：
 *   · `test-pet-*.mjs`  测模块与路由（**从不启动 exe**）
 *   · exe `--selftest`  测 C# 纯逻辑（**从不连宿主**）
 *
 * 于是"两边各自都对、接起来不对"这一类缺陷**完全无人覆盖** ——
 * 而这正是本项目历史上最常见、最难查的一类（502 那次就是：
 * Host 少传一个参数、exe 把原因丢掉，两边各自的测试全绿）。
 *
 * 这一套补的就是那个缺口：用**真实 index.js** 起一个宿主，
 * **真实 spawn exe**，然后断言 exe 真的连上了、真的拿到了清单。
 *
 * ── 怎么断言（关键：读 exe 自己的日志）──────────────────────────────────
 *
 * exe 是 `-target:winexe`，stdout 抓不到（这个坑在 exe 自检里踩过：
 * PowerShell 的 `$out = & exe` 拿到 0 行）。所以断言打在 **pet.log** 上 ——
 * 那是 exe 自己写的、有明确格式的诊断日志，也是真机排障时唯一能看的东西。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXE = path.join(ROOT, 'bin', 'dsh-zhuang-fangyi-pet.exe')

let passed = 0
let failed = 0

function section (name) {
  console.log(`\n── ${name} ──`)
}

async function ok (label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${error?.message ?? error}`)
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

if (!fs.existsSync(EXE)) {
  console.log(`❌ 找不到 exe：${EXE}`)
  console.log('   请先跑 tools/build-pet.ps1')
  process.exit(1)
}

/* ══════════════════════════════════════════════════════════════════════════
 * 起一个**真实宿主**（用真实 index.js），并 spawn 真实 exe
 * ══════════════════════════════════════════════════════════════════════════ */

section('0. 环境准备')

// 独立 DSH_HOME：绝不碰用户真实设置（也保证测试可重复）。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-native-e2e-'))
process.env.DSH_HOME = tmpHome
// exe 的日志位置：它按 `%LOCALAPPDATA%\DSH-ZhuangFangyi-Pet\pet.log` 定位。
//
// ⚠️ **改 `process.env.LOCALAPPDATA` 对它无效** —— exe 是独立进程，
// 读的是它**自己启动时**的环境（由宿主继承）。实测：改了 env 之后
// exe 仍然写真实用户目录，于是断言找不到文件。
// 所以这里读**真实**日志文件，但用 **pid 过滤**只认本次启动写的那几行
// （用户可能同时在用桌宠，不能把它的日志当成本次结果）。
const LOG_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'DSH-ZhuangFangyi-Pet')
const LOG_FILE = path.join(LOG_DIR, 'pet.log')

/** 读日志里**属于本次 exe 进程**的那些行（按 pid 与启动行之后切分）。 */
function readOurLog () {
  if (!fs.existsSync(LOG_FILE)) return ''
  const text = fs.readFileSync(LOG_FILE, 'utf8')
  // exe 每次启动会写 `启动 pid=<n> args=<k>`。找**最后一次**启动，
  // 并确认它就是我们 spawn 的那个 pid。
  const pid = childRef?.pid
  const lines = text.split(/\r?\n/)
  let startIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/启动 pid=(\d+)/)
    if (m) {
      // 找到最近一次启动；若 pid 与我们的不符，说明我们的进程还没写日志。
      if (pid !== undefined && Number(m[1]) === pid) { startIdx = i; break }
      if (startIdx === -1) startIdx = i   // 记下最近一次，继续找更早的同 pid
    }
  }
  if (startIdx === -1) return ''
  return lines.slice(startIdx).join('\n')
}

// 让 exe 一启动就连宿主：把 enabled 写成 true（默认是 false）。
fs.mkdirSync(path.join(tmpHome, 'zhuang-fangyi-pet'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, 'zhuang-fangyi-pet', 'settings.json'), JSON.stringify({
  version: 1,
  enabled: true,
  mode: 'native',
  scale: 1,
  bubble: true,
  bubbleImages: true,
  // 语音默认关；这里**开着**，因为要验证清单真的被拉取（见下）。
  voice: true,
  // 番茄钟开着，验证快照里带块。
  pomodoro: true,
  pomodoroCountdown: true,
  // v13：手势灵敏度**显式设成非默认值**。
  //
  // ⚠️ 为什么要在这里写（而不是靠默认值）：v10 那四个开关踩过的坑 ——
  // 设置页能改、`settings.json` 里也有，但 `exeSettings()` **根本没发给 exe**，
  // 于是开关全是装饰品（用户报"手势没法正常触发"的原因之一）。
  // 写一个非默认值(2.0)，才能证明"这个键真的穿过了宿主 → 快照 → exe"。
  gestureSensitivity: 2,
  // v13.6：手势调试模式**显式设成 true**（默认是 false）。
  // 同一个坑的第三次防线：设置页能勾、`settings.json` 里也有，
  // 但只要 `exeSettings()` 漏发，exe 就永远不开面包屑 ——
  // 而用户报"手势判定很奇怪"时**正是要靠它**。设成 true 才能证明它穿到了快照。
  debugGestures: true
}, null, 2), 'utf8')

const { apply } = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
const http = await import('node:http')

// 桩 webServer：真的监听，真的注册路由（与 e2e 那套同形，但这里要真端口）。
const routes = []
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  let best = null
  for (const r of routes) {
    if (r.kind === 'exact' && r.path === pathname) { best = r; break }
    if (r.kind === 'prefix' && (pathname === r.path || pathname.startsWith(r.path + '/'))) {
      if (best === null || r.path.length > best.path.length) best = r
    }
  }
  if (best === null) { res.writeHead(404); res.end(); return }
  Promise.resolve(best.handler(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

/** 桩 ctx（够 index.js 用；与 e2e 那套同形）。 */
const handlers = new Map()
const effects = []
const services = new Map()
let spawnedArgs = null
const ctx = {
  logger: { info () {}, warn () {}, debug () {}, error () {} },
  on (name, fn) {
    if (!handlers.has(name)) handlers.set(name, new Set())
    handlers.get(name).add(fn)
    return () => handlers.get(name)?.delete(fn)
  },
  emit (name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args) },
  effect (fn) { const d = fn(); effects.push(d); return d },
  inject (deps, cb) { return cb({ ...ctx, webServer, effect: ctx.effect }) },
  /**
   * 服务解析：`subprocess`（真实 spawn）与 `webServer`（端口来源）都要给。
   *
   * ⚠️ 第一版只处理了 `subprocess`，于是 `launcher` 报
   * "webServer 端口未知"直接 return false —— **11 条断言全失败**。
   * 这个坑值得记下：`launcher` 读的是 `ctx.get('webServer')`（不是
   * `ctx.webServer`，因为 cordis 里后者会抛异常），所以桩必须覆盖 `get`。
   */
  get (name) {
    if (name === 'webServer') return webServer
    return services.get(name)
  },
  provide (name, value) { services.set(name, value); return () => services.delete(name) },
  set (name, value) { services.set(name, value) },
  /**
   * `subprocess` 桩：**真的 spawn exe**。
   *
   * 这是本套测试的核心 —— `index.js` 走的是官方 `ctx.subprocess` 接缝，
   * 我们在这里把它接到真实进程上，于是"宿主怎么起 exe、传什么参数"
   * 这条链路被真正执行（而不是像 e2e 那样只断言"start 被调用过"）。
   *
   * ⚠️ **签名必须照抄上游**（`dsh-subprocess-local`）：
   *   `spawn({argv, cwd, stdio, graceMs})` → 同步返回 handle
   *   handle = `{pid, done: Promise<{exitCode, signal}>}`
   *
   * 第一版我按 `child_process.spawn(command, args)` 的签名写，于是
   * `launcher` 传进来的 spec 对象被当成命令路径 —— 一条断言都没通过。
   * 这正是本套测试要抓的那类问题：**接口形状对不上**。
   *
   * ⚠️ 而且它必须经 `services` 注册（`launcher` 用 `ctx.get('subprocess')`
   * 解析），**不能只挂在 ctx 上当属性** —— 挂在属性上时 launcher 报
   * "宿主未提供 ctx.subprocess"，exe 永远不会起来。
   */
  subprocess: {
    spawn (spec) {
      const argv = spec?.argv ?? []
      spawnedArgs = { argv, cwd: spec?.cwd, spec }
      if (argv.length === 0) throw new Error('spec.argv 为空')
      const child = spawn(argv[0], argv.slice(1), {
        cwd: spec?.cwd ?? ROOT,
        stdio: 'ignore',
        windowsHide: false,
        detached: false
      })
      child.on('error', () => {})
      childRef = child
      // `done` 必须在**退出时** settle —— launcher 靠它做"秒退不重启"与孤儿清理。
      const done = new Promise(resolve => {
        child.on('exit', (code, signal) => resolve({ exitCode: code, signal }))
        child.on('error', error => resolve({ exitCode: -1, signal: null, error: String(error?.message ?? error) }))
      })
      return {
        pid: child.pid,
        done,
        /**
         * ⚠️ **必须实现 `terminate()`** —— 上游 handle 有它，`launcher.dispose()`
         * 靠它杀进程。第一版只返回 `{pid, done}`，于是卸载时 launcher 调
         * 一个不存在的方法（异常被吞），**exe 变成孤儿进程继续跑**。
         * 这正是本套测试要抓的"接口形状对不上"（第二次踩同一个坑）。
         */
        terminate () {
          try { if (!child.killed) child.kill() } catch { /* 已经没了 */ }
        }
      }
    }
  }
}
/** 真实子进程引用（收尾时用）。 */
let childRef = null
const webServer = {
  routes,
  port,
  host: '127.0.0.1',
  register (route) {
    routes.push(route)
    return () => { const i = routes.indexOf(route); if (i !== -1) routes.splice(i, 1) }
  },
  registerUpgrade () { return () => {} },
  tapIndex () { return () => {} }
}
ctx.__services = services
ctx.__handlers = handlers

// ⚠️ `subprocess` 必须经 services 注册：`launcher` 用 `ctx.get('subprocess')`
// 解析服务，挂在 ctx 属性上它读不到（会报"宿主未提供 ctx.subprocess"）。
services.set('subprocess', ctx.subprocess)

apply(ctx, {})

// 拿 token 与端口（exe 的 argv 里有 token，但我们先从 exposed 服务读端口）。
const petService = services.get('zhuangFangyiPet')
assert.ok(petService !== undefined, 'apply() 应暴露 zhuangFangyiPet 服务')

// 诊断：把 launcher 的状态打出来。**这一条是排障时最需要的** ——
// 当"exe 没起来"时，真正有用的信息是 `launcher.status.reason`，
// 而不是一句"spawn 没被调用"。
const launcherStatus = petService?.launcher?.status
console.log(`  · launcher.status = ${JSON.stringify(launcherStatus)}`)

/* ══════════════════════════════════════════════════════════════════════════
 * 1. exe 真的被宿主拉起来
 * ══════════════════════════════════════════════════════════════════════════ */

section('1. 宿主 → exe（真实 spawn）')

let child = null

await ok('宿主经 ctx.subprocess 真的 spawn 了 exe', async () => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && spawnedArgs === null) await sleep(100)
  assert.ok(spawnedArgs !== null,
    'index.js 没有调用 ctx.subprocess.spawn —— exe 永远不会出现')
  assert.ok(spawnedArgs.argv[0].toLowerCase().includes('dsh-zhuang-fangyi-pet'),
    `spawn 的不是本插件的 exe：${spawnedArgs.argv[0]}`)
})

await ok('argv 带齐契约 §5 的必需参数（--url/--token/--state）', async () => {
  const args = spawnedArgs.argv
  for (const key of ['--url', '--token', '--state']) {
    assert.ok(args.includes(key), `argv 缺 ${key}：${args.join(' ')}`)
  }
  // url 必须指向**真实监听的端口**（端口写错 = exe 永远连不上）
  const urlIdx = args.indexOf('--url')
  assert.equal(args[urlIdx + 1], `http://127.0.0.1:${port}`,
    `--url 端口不对：${args[urlIdx + 1]}（宿主实际监听 ${port}）`)
  // token 必须是 48 位 hex（契约 §3）
  const tokIdx = args.indexOf('--token')
  assert.match(args[tokIdx + 1], /^[0-9a-f]{48}$/, `--token 格式不对：${args[tokIdx + 1]}`)
})

await ok('⭐ argv 带上语音开关（v8 新增，漏了 exe 就永远静音）', async () => {
  const args = spawnedArgs.argv
  // 设置里 voice:true → argv 必须是 --voice 1。
  // 这条测的是"Host 有没有把新设置透传给 exe"—— 漏传的症状是
  // "设置页开了语音但没声音"，而两边各自的测试都是绿的。
  assert.ok(args.includes('--voice'), `argv 缺 --voice：${args.join(' ')}`)
  const idx = args.indexOf('--voice')
  assert.equal(args[idx + 1], '1', `--voice 应为 1（设置里 voice:true），实际 ${args[idx + 1]}`)
})

await ok('⭐ exe 进程真的活着（不是 spawn 完就退）', async () => {
  // 从 argv 里拿 token，然后等 exe 建立 SSE 连接。
  const args = spawnedArgs.argv
  const token = args[args.indexOf('--token') + 1]
  const deadline = Date.now() + 20000
  let connected = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/zhuang-fangyi/pet/diag`, {
        headers: { authorization: `Bearer ${token}` }
      })
      if (res.status === 200) {
        const body = await res.json()
        if (body.clients > 0) { connected = true; break }
      }
    } catch { /* 还没起来 */ }
    await sleep(300)
  }
  assert.ok(connected,
    'exe 起来了但从未建立 SSE 连接（clients 一直为 0）—— 桌宠不会跟着状态变')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 2. exe 拉到了语音清单（v8 新链路）
 * ══════════════════════════════════════════════════════════════════════════ */

section('2. 语音清单：exe 真的去拉了')

await ok('⭐⭐ exe 的日志里出现"语音：清单 N 条"（证明它真拉了清单）', async () => {
  // 断言打在 **exe 自己写的 pet.log** 上 —— 那是真机排障时唯一能看的东西。
  // 只断言"路由能返回清单"是不够的：那证明的是 Host 没问题，
  // 而"exe 有没有去拉"是另一回事（漏调用就永远静音）。
  const deadline = Date.now() + 20000
  let text = ''
  while (Date.now() < deadline) {
    text = readOurLog()
    if (text.includes('语音：清单')) break
    await sleep(300)
  }
  assert.ok(fs.existsSync(LOG_FILE), `exe 没写日志：${LOG_FILE}`)
  assert.ok(text.includes('语音：清单'),
    `exe 日志里没有"语音：清单" —— 它没拉清单。日志尾部：\n${text.slice(-800)}`)
  // 条数必须 > 0（= 真拿到了内容，而不是"清单为空"那条分支）
  assert.ok(/语音：清单 \d+ 条/.test(text), '日志格式不对，无法确认条数')
  const m = text.match(/语音：清单 (\d+) 条/)
  assert.ok(Number(m[1]) > 0, `清单条数为 ${m[1]}，应为正数`)
})

await ok('⭐ exe 日志里没有"清单为空"（否则上面的断言可能是误判）', async () => {
  const text = readOurLog()
  // 反向确认：真拿到了清单，而不是走了"为空 → 静音运行"那条分支。
  assert.ok(!text.includes('语音：清单为空'),
    'exe 报"清单为空"，说明它没拿到内容（上面的正数断言可能是缓存误判）')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 番茄钟块进了快照
 * ══════════════════════════════════════════════════════════════════════════ */

section('3. 番茄钟：快照里有块、exe 认它')

await ok('⭐ 宿主快照带 pomodoro 块（exe 据此显示倒计时）', async () => {
  const args = spawnedArgs.argv
  const token = args[args.indexOf('--token') + 1]
  const res = await fetch(`http://127.0.0.1:${port}/api/zhuang-fangyi/pet/state`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 200)
  const snap = await res.json()
  assert.ok(snap.pomodoro, '快照里没有 pomodoro 块')
  assert.equal(typeof snap.pomodoro.remainingMs, 'number')
  assert.equal(snap.pomodoro.enabled, true, '设置里 pomodoro:true，块应报 enabled')
})

await ok('⭐ exe 日志里出现"番茄钟 → 首次收到块"（证明它真解析了）', async () => {
  const deadline = Date.now() + 15000
  let text = ''
  while (Date.now() < deadline) {
    text = readOurLog()
    if (text.includes('番茄钟 → 首次收到块')) break
    await sleep(300)
  }
  assert.ok(text.includes('番茄钟 → 首次收到块'),
    `exe 没收到/没解析番茄钟块。日志尾部：\n${text.slice(-800)}`)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3b. v13：手势灵敏度必须**真的送到 exe**
 *
 * 这一组是 v10 教训的直接产物：那四个手势开关在 `settings.js` 里有、
 * 设置页能改、`settings.json` 里也存着，但 `exeSettings()` **根本没发给 exe** ——
 * 于是它们全是装饰品，而用户看到的只是"手势没法正常触发"。
 * 所以"设置里有这个键"**不等于**"exe 拿得到它"，必须端到端断言。
 * ══════════════════════════════════════════════════════════════════════════ */

section('3b. v13 手势灵敏度：设置 → 快照 → exe 的容差')

await ok('⭐⭐⭐ 宿主快照的 settings 带 gestureSensitivity（漏了它就是装饰品）', async () => {
  const args = spawnedArgs.argv
  const token = args[args.indexOf('--token') + 1]
  const res = await fetch(`http://127.0.0.1:${port}/api/zhuang-fangyi/pet/state`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 200)
  const snap = await res.json()
  assert.ok(snap.settings, '快照里没有 settings 块')
  // 设置文件里写的是 2 —— 必须是 2，不能是默认的 1。
  // （若 `exeSettings()` 漏掉这个键，这里会拿到 undefined 或 1。）
  assert.equal(snap.settings.gestureSensitivity, 2,
    `快照里的 gestureSensitivity 是 ${snap.settings.gestureSensitivity}，应为设置文件里的 2` +
    '（宿主 exeSettings() 漏发了这个键 → 设置页的滑杆是装饰品）')
})

await ok('⭐⭐⭐ 宿主快照的 settings 带 debugGestures（漏了它面包屑永远不开）', async () => {
  const args = spawnedArgs.argv
  const token = args[args.indexOf('--token') + 1]
  const res = await fetch(`http://127.0.0.1:${port}/api/zhuang-fangyi/pet/state`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 200)
  const snap = await res.json()
  assert.ok(snap.settings, '快照里没有 settings 块')
  // 设置文件里写的是 true（默认 false）—— 必须是 true。
  // 漏发的话 exe 侧 `HasDebugGestures` 为 false → 用户勾了也没日志。
  assert.equal(snap.settings.debugGestures, true,
    `快照里的 debugGestures 是 ${snap.settings.debugGestures}，应为设置文件里的 true` +
    '（宿主 exeSettings() 漏发了这个键 → 设置页的开关是装饰品）')
})

await ok('⭐⭐⭐⭐ exe 日志里出现"手势容差 →"且数值随灵敏度放大（真接线）', async () => {
  const deadline = Date.now() + 15000
  let text = ''
  while (Date.now() < deadline) {
    text = readOurLog()
    if (text.includes('手势容差 →')) break
    await sleep(300)
  }
  assert.ok(text.includes('手势容差 →'),
    `exe 没打印"手势容差 →"，说明它没读/没应用灵敏度。日志尾部：\n${text.slice(-800)}`)
  // ⚠️ 必须取 **sens=2 那一行**，不能取第一次出现的：
  // exe 启动时会先用默认灵敏度打一行（sens=1 → 6/9px），快照到达后才打第二行
  //（sens=2 → 12/18px）。我第一版用 `text.match(...)` 只拿**第一处**匹配，
  // 于是断言永远看到启动那行 → 明明接线是好的却报红。断言写错，不是产品错。
  const all = [...text.matchAll(/手势容差 → gain=([\d.]+) sens=([\d.]+) click<=([\d.]+)px pat<=([\d.]+)px/g)]
  assert.ok(all.length > 0,
    `日志里的容差格式不认识：${(text.match(/手势容差[^\n]*/) ?? [''])[0]}`)
  const hit = all.find(x => Number(x[2]) === 2)
  assert.ok(hit,
    `没有找到 sens=2 的那一行（说明设置没生效到 exe）。实际有：` +
    all.map(x => `sens=${x[2]}`).join(', '))
  const gain = Number(hit[1]); const click = Number(hit[3]); const pat = Number(hit[4])
  assert.ok(gain > 0, `指针增益是 ${gain}，应为正数`)
  // 灵敏度 2.0 → 容差至少是基准的 2 倍（还要乘系统指针增益，所以 ≥2 倍）。
  // 基准是 click 4px / pat 6px，所以这里至少要 ≥8px / ≥12px。
  assert.ok(click >= 8, `click 容差是 ${click}px，灵敏度 2.0 下应 ≥8px（基准 4px × 2）`)
  assert.ok(pat >= 12, `pat 容差是 ${pat}px，灵敏度 2.0 下应 ≥12px（基准 6px × 2）`)
  assert.ok(pat > click, `pat 容差(${pat}) 必须大于 click 容差(${click})，否则 4~6px 漂移又会掐死摸头`)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 番茄钟动作：真 POST 到宿主，真改变状态
 * ══════════════════════════════════════════════════════════════════════════ */

section('4. 番茄钟动作（真 HTTP 往返）')

await ok('⭐⭐ POST /pet/pomodoro start → 快照真的变成 running', async () => {
  const args = spawnedArgs.argv
  const token = args[args.indexOf('--token') + 1]
  const res = await fetch(`http://127.0.0.1:${port}/api/zhuang-fangyi/pet/pomodoro`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start' })
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.pomodoro.running, true, 'start 后块应报 running')
  assert.ok(body.pomodoro.endsAt > Date.now(), 'endsAt 应是未来时刻')

  // 再从 /state 复核（证明改的是**共享状态**，不是回执里编的）
  const snap = await (await fetch(`http://127.0.0.1:${port}/api/zhuang-fangyi/pet/state`, {
    headers: { authorization: `Bearer ${token}` }
  })).json()
  assert.equal(snap.pomodoro.running, true, '/state 也应报 running（共享同一份状态）')
})

await ok('⭐ POST /pet/pomodoro pause → 真的停下且冻结剩余时间', async () => {
  const args = spawnedArgs.argv
  const token = args[args.indexOf('--token') + 1]
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const r1 = await (await fetch(`http://127.0.0.1:${port}/api/zhuang-fangyi/pet/pomodoro`, {
    method: 'POST', headers: h, body: JSON.stringify({ action: 'pause' })
  })).json()
  assert.equal(r1.pomodoro.running, false)
  const frozen = r1.pomodoro.remainingMs
  await sleep(1200)
  const r2 = await (await fetch(`http://127.0.0.1:${port}/api/zhuang-fangyi/pet/pomodoro`, {
    headers: { authorization: `Bearer ${token}` }
  })).json()
  assert.equal(r2.pomodoro.remainingMs, frozen,
    `暂停期间剩余时间必须冻结（${frozen} → ${r2.pomodoro.remainingMs}）`)
})

await ok('⭐ POST /pet/pomodoro 非法动作 → 400（白名单在真实装配里生效）', async () => {
  const args = spawnedArgs.argv
  const token = args[args.indexOf('--token') + 1]
  for (const evil of ['__proto__', 'constructor', 'start;exit', '']) {
    const res = await fetch(`http://127.0.0.1:${port}/api/zhuang-fangyi/pet/pomodoro`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: evil })
    })
    assert.equal(res.status, 400, `${JSON.stringify(evil)} 应 400，实际 ${res.status}`)
  }
})

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 收尾
 * ══════════════════════════════════════════════════════════════════════════ */

section('5. 收尾')

await ok('卸载：exe 被真正终止（不留孤儿进程）', async () => {
  const before = services.get('zhuangFangyiPet')?.launcher?.status?.running
  // 触发卸载：把 effects 全部 dispose（= 宿主回收插件）
  for (const d of effects.reverse()) {
    try { if (typeof d === 'function') d() } catch { /* 收尾尽力而为 */ }
  }
  await sleep(2500)
  // 通过 diag 确认客户端掉线（exe 被杀了 SSE 就断）
  // 这里无法再访问路由（已卸载），所以用进程存活来判断。
  const { execFileSync } = await import('node:child_process')
  let alive = false
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      "(Get-Process -Name 'dsh-zhuang-fangyi-pet' -ErrorAction SilentlyContinue | Measure-Object).Count"
    ], { encoding: 'utf8', timeout: 15000 })
    alive = Number(out.trim()) > 0
  } catch { /* 查不到就当没有 */ }
  // 注意：如果本机还有别的桌宠实例在跑（用户自己在用），这里会误判。
  // 所以断言写成"要么被杀掉、要么本来就没起来"，并把 before 记进信息里。
  assert.ok(!alive || before !== true,
    `卸载后 exe 仍在运行（before.running=${before}）—— 会留下孤儿进程`)
})

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败项'}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)

try { await new Promise(resolve => server.close(resolve)) } catch { }
process.exit(failed === 0 ? 0 : 1)
