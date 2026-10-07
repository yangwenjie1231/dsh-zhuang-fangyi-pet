/**
 * 庄方宜桌宠 · 动态语音（TTS）单测
 *
 * 用法：`node tools/test-pet-tts.mjs`
 *
 * ── 这套测试在防什么 ──────────────────────────────────────────────────────
 *
 * 这条链路接的是**外部服务**（`dsh-zhuang-fangyi-voice`），有两大风险：
 *
 *   1. **朗读文本清洗不够** —— AI 回复是 markdown。念出"星号星号加粗"、
 *      代码块、URL 会难听到不能用。清洗规则是纯函数，可以穷举。
 *   2. **服务不可用时的行为** —— 没启动 / 超时 / 返回垃圾 / 返回非 WAV。
 *      每一种都必须**返回 null 而不是抛**：聊天链路绝不能因为语音挂掉。
 *
 * 还有一个隐蔽的：**缓存键必须带服务身份**。换了音色/后端之后同一句话
 * 应该是不同音频；只按文本做键会让换音色后仍播旧音色，而且毫无报错。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  sanitizeForSpeech,
  chunkForSpeech,
  speechCacheKey,
  wavDurationMs,
  createTtsClient,
  DEFAULT_TTS_URL,
  DEFAULT_MAX_SPEECH_CHARS,
  DEFAULT_TTS_TIMEOUT_MS,
  MAX_SPEECH_BYTES
} from '../src/pet/tts.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

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

async function okAsync (label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${error?.message ?? error}`)
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 朗读文本清洗（markdown → 能念的话）
 * ══════════════════════════════════════════════════════════════════════════ */

section('1. 朗读文本清洗')

ok('加粗/斜体标记去掉，保留文字', () => {
  assert.equal(sanitizeForSpeech('**好的**，我看看。'), '好的，我看看。')
  assert.equal(sanitizeForSpeech('*稍等*一下。'), '稍等一下。')
  assert.equal(sanitizeForSpeech('__真的__吗？'), '真的吗？')
  assert.equal(sanitizeForSpeech('~~删掉~~这句。'), '删掉这句。')
})

ok('⭐ 围栏代码块整段删掉（念代码毫无意义）', () => {
  const r = sanitizeForSpeech('```js\nconst x = 1\n```\n就这样。')
  assert.equal(r, '就这样。')
  assert.ok(!r.includes('const'), '不该残留代码内容')
})

ok('⭐ 未闭合的围栏也删掉（流式回复会被截断）', () => {
  const r = sanitizeForSpeech('先看这个：\n```python\nprint(1)\n')
  assert.ok(!r.includes('print'), `不该残留未闭合代码，实际 ${JSON.stringify(r)}`)
})

ok('⭐ 全是代码 → null（没东西可念，别硬念）', () => {
  assert.equal(sanitizeForSpeech('```\n全是代码\n```'), null)
  assert.equal(sanitizeForSpeech(''), null)
  assert.equal(sanitizeForSpeech('   \n  \n'), null)
  assert.equal(sanitizeForSpeech(null), null)
  assert.equal(sanitizeForSpeech(undefined), null)
  assert.equal(sanitizeForSpeech(42), null)
})

ok('行内代码去掉反引号（短标识符保留文字）', () => {
  assert.equal(sanitizeForSpeech('我改好了 `index.js`。'), '我改好了 index.js。')
})

ok('⭐ 链接只留文字（念 URL 是灾难）', () => {
  const r = sanitizeForSpeech('见 [文档](https://example.com/a/b) 第 3 节。')
  assert.ok(r.includes('文档'), '应保留链接文字')
  assert.ok(!r.includes('http'), `不该念出 URL，实际 ${JSON.stringify(r)}`)
  assert.ok(!r.includes('example.com'), '不该残留域名')
})

ok('裸 URL 与图片也删掉', () => {
  const r1 = sanitizeForSpeech('参考 https://example.com/x?y=1 这里。')
  assert.ok(!r1.includes('example'), `实际 ${JSON.stringify(r1)}`)
  const r2 = sanitizeForSpeech('![截图](img/a.png)看图。')
  assert.ok(!r2.includes('png'), `实际 ${JSON.stringify(r2)}`)
})

ok('列表符号去掉，项之间用停顿连接', () => {
  assert.equal(sanitizeForSpeech('- 第一点\n- 第二点'), '第一点，第二点')
  assert.equal(sanitizeForSpeech('1. 甲\n2. 乙'), '甲，乙')
})

ok('标题与引用标记去掉', () => {
  assert.equal(sanitizeForSpeech('## 结论\n\n没问题。'), '结论，没问题。')
  assert.equal(sanitizeForSpeech('> 她说过这句话。'), '她说过这句话。')
})

ok('表格：分隔行删掉、竖线变停顿', () => {
  const r = sanitizeForSpeech('| A | B |\n|---|---|\n| 1 | 2 |')
  assert.equal(r, 'A，B，1，2')
})

ok('水平线删掉', () => {
  assert.equal(sanitizeForSpeech('上一段\n\n---\n\n下一段'), '上一段，下一段')
})

ok('emoji 删掉（否则会被念成"笑脸"）', () => {
  assert.equal(sanitizeForSpeech('😀 完成啦！🎉'), '完成啦！')
})

ok('⭐ 超长在**句子边界**截断（不截半个词）', () => {
  const long = '第一句话在这里。第二句话在这里。第三句话在这里。'
  const r = sanitizeForSpeech(long, { maxChars: 12 })
  assert.ok(r.length <= 13, `应截断，实际 ${r.length} 字：${r}`)
  assert.ok(r.endsWith('。'), `应在句末截断，实际 ${JSON.stringify(r)}`)
})

ok('没有句末标点时退回逗号，再没有才硬截 + 补句号', () => {
  const noStop = '这是一个很长很长的句子没有任何句末标点只有逗号，后面还有很多很多内容继续下去'
  const r = sanitizeForSpeech(noStop, { maxChars: 20 })
  assert.ok(r.length <= 21, `实际 ${r.length}：${r}`)
  assert.ok(/[。]$/.test(r), `应补句号收尾，实际 ${JSON.stringify(r)}`)
})

ok('maxChars 可配置，默认 60', () => {
  assert.equal(DEFAULT_MAX_SPEECH_CHARS, 60)
  const long = '啊'.repeat(200)
  assert.ok(sanitizeForSpeech(long).length <= DEFAULT_MAX_SPEECH_CHARS + 1)
  assert.ok(sanitizeForSpeech(long, { maxChars: 10 }).length <= 11)
})

ok('正常中文短句原样通过（不误伤）', () => {
  assert.equal(sanitizeForSpeech('我看看，这个思路可行。'), '我看看，这个思路可行。')
  assert.equal(sanitizeForSpeech('好。'), '好。')
})

/* ── 1b. 分段（"别限制 60 字"这件事的实现）──────────────────────────────── */

ok('⭐⭐ truncate:false → 不截断（整段都要念）', () => {
  // 用户问："为什么一次只能念 60 个字，别限制啊，它在 GPU 上很快。"
  // 旧行为是**硬截断**（后半句直接丢），实测 122 字的回复只念了 55 字。
  // 现在改为分段念完，所以清洗阶段不能截断。
  const long = '第一句话在这里。第二句话在这里。第三句话在这里。第四句话在这里。'
  const cut = sanitizeForSpeech(long, { maxChars: 12 })
  const full = sanitizeForSpeech(long, { maxChars: 12, truncate: false })
  assert.ok(cut.length <= 13, `默认应截断，实际 ${cut.length}`)
  assert.equal(full, long, 'truncate:false 应原样保留全文')
  // 兼容性：默认行为不变（还有调用方依赖截断）
  assert.equal(sanitizeForSpeech(long, { maxChars: 12 }), cut, '不传 truncate 时行为必须与从前一致')
})

ok('⭐⭐ 分段：按句切开，且**一个字都不丢**', () => {
  const text = '第一句。第二句长一点点。第三句。'
  const chunks = chunkForSpeech(text, 8)
  assert.ok(chunks.length > 1, `应切成多段，实际 ${chunks.length}`)
  for (const c of chunks) assert.ok(c.length <= 8, `每段应 ≤ 8 字，实际 ${c.length}：${c}`)
  assert.equal(chunks.join(''), text, '拼回去必须与原文完全一致（一个字都不许丢）')
  // 每段都该是完整句子（以句末标点收尾），而不是半句
  for (const c of chunks.slice(0, -1)) {
    assert.ok(/[。！？；]$/.test(c), `非末段应在句末断开，实际 ${JSON.stringify(c)}`)
  }
})

ok('⭐ 分段：空/纯空白 → 空数组（不产生空合成请求）', () => {
  assert.deepEqual(chunkForSpeech('', 60), [])
  assert.deepEqual(chunkForSpeech('   ', 60), [])
  assert.deepEqual(chunkForSpeech(null, 60), [])
})

ok('⭐ 分段：单句超过上限时退到逗号断，不会把句子切碎成几个字', () => {
  const one = '这是一个非常长的句子没有句末标点只有逗号，后面还有更多内容继续说下去，再补一点让它更长一些'
  const chunks = chunkForSpeech(one, 20)
  assert.ok(chunks.length >= 2, '超长单句应被切开')
  assert.equal(chunks.join(''), one, '拼回去仍要一字不差')
  for (const c of chunks) {
    assert.ok(c.length <= 20, `每段 ≤ 20，实际 ${c.length}`)
    assert.ok(c.length >= 8, `不该切得太碎（软停顿太靠前就不用），实际 ${c.length}：${c}`)
  }
})

ok('⭐⭐ 分段：真实长度的回复不再被砍掉一半', () => {
  // 复刻实测那条 122 字回复：旧行为只念 55 字（不到一半）。
  const long = '管理员今天要检查第三批的成型曲线，昨天那条线终于压稳了。实验室的温度一直保持在二十二度左右，湿度也没有大波动。我把数据重新跑了一遍，结果和上次一致，误差在千分之三以内。接下来要写一份简短的报告，把这三天的曲线放在一起对比，标出异常点并给出解释。'
  const old = sanitizeForSpeech(long, { maxChars: 60 })
  const chunks = chunkForSpeech(sanitizeForSpeech(long, { maxChars: 60, truncate: false }), 60)
  const spoken = chunks.join('')
  assert.ok(old.length < long.length, '（前置事实）旧行为确实截断了')
  assert.equal(spoken.length, long.length, `现在应念完整段（${long.length} 字），实际 ${spoken.length}`)
  assert.ok(chunks.length >= 2, '应切成多段（这正是"能边合成边播"的前提）')
  for (const c of chunks) assert.ok(c.length <= 60, `每段 ≤ 60，实际 ${c.length}`)
})

ok('⭐ 客户端暴露 chunk / sanitizeFull（宿主走的是这条）', () => {
  const client = createTtsClient({ baseUrl: 'http://127.0.0.1:1', maxChars: 10 })
  assert.equal(typeof client.chunk, 'function', '应有 chunk()')
  assert.equal(typeof client.sanitizeFull, 'function', '应有 sanitizeFull()')
  const long = '一二三四五六。七八九十甲乙。'
  assert.equal(client.sanitizeFull(long), long, 'sanitizeFull 不截断')
  assert.ok(client.sanitize(long).length <= 11, 'sanitize 仍截断（旧接口不变）')
  assert.equal(client.chunk(long).join(''), long, 'chunk 拼回去一字不差')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 缓存键
 * ══════════════════════════════════════════════════════════════════════════ */

section('2. 缓存键')

ok('同文本同身份 → 同键（稳定）', () => {
  assert.equal(speechCacheKey('你好', 'onnx'), speechCacheKey('你好', 'onnx'))
})

ok('文本不同 → 键不同', () => {
  assert.notEqual(speechCacheKey('甲', 'onnx'), speechCacheKey('乙', 'onnx'))
})

ok('⭐⭐ 服务身份不同 → 键不同（换音色后不会播旧音频）', () => {
  // 这是最容易漏的一条：换了后端/参考音频，同一个文本应该是**新**音频。
  // 只按文本做键的话，换音色后仍播旧的 —— 而且毫无报错，听起来只是"没生效"。
  assert.notEqual(speechCacheKey('你好', 'onnx'), speechCacheKey('你好', 'torch'))
})

ok('键形状固定（16 位十六进制，可安全当文件名）', () => {
  const k = speechCacheKey('任何文本', 'x')
  assert.match(k, /^[0-9a-f]{16}$/)
})

ok('空/异常输入不抛', () => {
  assert.match(speechCacheKey(null), /^[0-9a-f]{16}$/)
  assert.match(speechCacheKey(undefined, undefined), /^[0-9a-f]{16}$/)
})

/* ══════════════════════════════════════════════════════════════════════════
 * 3. WAV 时长解析（exe 靠它做"没播完别播下一句"）
 * ══════════════════════════════════════════════════════════════════════════ */

section('3. WAV 时长解析')

/** 造一个最小合法 WAV：44 字节头 + 静音数据。 */
function makeWav (samples, sr = 32000, channels = 1, bits = 16) {
  const dataLen = samples * channels * (bits / 8)
  const b = Buffer.alloc(44 + dataLen)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(36 + dataLen, 4)
  b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(channels, 22)
  b.writeUInt32LE(sr, 24)
  b.writeUInt32LE(sr * channels * (bits / 8), 28)
  b.writeUInt16LE(channels * (bits / 8), 32)
  b.writeUInt16LE(bits, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(dataLen, 40)
  return b
}

ok('解析单声道 16-bit：32000 样本 @32kHz = 1000ms', () => {
  assert.equal(wavDurationMs(makeWav(32000)), 1000)
})

ok('解析立体声：32000 样本/声道 @32kHz(2ch) = 1000ms', () => {
  // 立体声的 dataLen = 样本数 × 声道数 × 位深/8；
  // 时长 = dataLen / byteRate，其中 byteRate = sr × ch × 位深/8。
  // 32000 样本/声道 @32kHz 就是 1 秒（与单声道一致 —— 声道数在分子分母各出现一次）。
  assert.equal(wavDurationMs(makeWav(32000, 32000, 2)), 1000)
})

ok('解析立体声 2 秒：64000 样本/声道 @32kHz(2ch) = 2000ms', () => {
  assert.equal(wavDurationMs(makeWav(64000, 32000, 2)), 2000)
})

ok('解析 8-bit：32000 样本 @32kHz = 1000ms', () => {
  assert.equal(wavDurationMs(makeWav(32000, 32000, 1, 8)), 1000)
})

ok('⭐ 真实合成产物：解析值与字节数手工计算一致', () => {
  // 用 art/voice-src 里的真实文件对照 —— 手工算 (len-44)/byteRate，
  // 解析器必须与它一致（差一点就说明字段偏移读错了）。
  const f = path.join(ROOT, 'art', 'voice-src', 'click-1.wav')
  if (!fs.existsSync(f)) return   // 没有产物时跳过（CI 上可能没跑合成）
  const b = fs.readFileSync(f)
  const sr = b.readUInt32LE(24)
  const ch = b.readUInt16LE(22)
  const bits = b.readUInt16LE(34)
  const manual = Math.round((b.length - 44) / (sr * ch * bits / 8) * 1000)
  const got = wavDurationMs(b)
  assert.ok(Math.abs(got - manual) <= 1, `解析 ${got}ms vs 手工 ${manual}ms`)
})

ok('坏输入一律 0（不抛）', () => {
  assert.equal(wavDurationMs(null), 0)
  assert.equal(wavDurationMs(undefined), 0)
  assert.equal(wavDurationMs(Buffer.from('not a wav')), 0)
  assert.equal(wavDurationMs(Buffer.alloc(10)), 0)
  assert.equal(wavDurationMs(Buffer.alloc(100)), 0)          // 全零头
  const mp3 = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00')
  assert.equal(wavDurationMs(mp3), 0, 'mp3 字节应解析不出（不是 WAV）')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 客户端：健康检查与合成（全部失败路径都不抛）
 * ══════════════════════════════════════════════════════════════════════════ */

section('4. TTS 客户端')

function jsonRes (body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}
function binRes (buf, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
}

await okAsync('健康检查：正常服务 → 后端名', async () => {
  const c = createTtsClient({
    fetchImpl: async url => {
      assert.ok(url.endsWith('/health'), `应请求 /health，实际 ${url}`)
      return jsonRes({ ok: true, backend: 'onnx', version: '0.1.0', ready: true })
    }
  })
  const h = await c.health()
  assert.equal(h.ok, true)
  assert.equal(h.backend, 'onnx')
  assert.equal(c.identity, 'onnx', '身份应被记下（缓存键用）')
})

await okAsync('健康检查：服务没起 → null（不抛）', async () => {
  const c = createTtsClient({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(await c.health(), null)
})

await okAsync('健康检查：ok=false / 非 200 → null', async () => {
  const c1 = createTtsClient({ fetchImpl: async () => jsonRes({ ok: false }) })
  assert.equal(await c1.health(), null)
  const c2 = createTtsClient({ fetchImpl: async () => jsonRes({}, 500) })
  assert.equal(await c2.health(), null)
})

await okAsync('合成：正常 → 字节 + 时长（从 WAV 头解析，不再多请求一次）', async () => {
  const wav = makeWav(32000)
  let sawBody = null
  const c = createTtsClient({
    fetchImpl: async (url, init) => {
      sawBody = JSON.parse(init.body)
      return binRes(wav)
    }
  })
  const r = await c.synthesize('你好')
  assert.ok(r !== null, '应返回结果')
  assert.equal(r.bytes.length, wav.length)
  assert.equal(r.durationMs, 1000, '时长应从 WAV 头解析出来')
  assert.deepEqual(sawBody, { text: '你好' }, 'body 应是 {text}')
})

await okAsync('⭐⭐ 合成：服务没起 → null（不抛，聊天不受影响）', async () => {
  const c = createTtsClient({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(await c.synthesize('你好'), null)
})

await okAsync('⭐ 合成：HTTP 500 / 空响应 → null', async () => {
  const c1 = createTtsClient({ fetchImpl: async () => binRes(Buffer.alloc(0), 500) })
  assert.equal(await c1.synthesize('你好'), null)
  const c2 = createTtsClient({ fetchImpl: async () => binRes(Buffer.alloc(0), 200) })
  assert.equal(await c2.synthesize('你好'), null, '空体应被挡下')
})

await okAsync('⭐⭐ 合成：返回的不是 WAV → null（不能把垃圾丢给播放器）', async () => {
  const notWav = Buffer.from('{"ok":false,"error":"模型未就绪"}')
  const c = createTtsClient({ fetchImpl: async () => binRes(notWav) })
  const r = await c.synthesize('你好')
  assert.equal(r, null, '非 RIFF 应被拒绝')
})

await okAsync('⭐⭐ 合成：超大响应被挡下（不能把 100MB 塞进快照目录）', async () => {
  // 上限存在的理由：合成结果会落盘到 `speech/`。服务要是发疯返回一个巨大
  // buffer（或错误地返回了一整段音频文件），不加限制会写爆磁盘。
  const huge = Buffer.alloc(MAX_SPEECH_BYTES + 1)
  huge.write('RIFF', 0, 'ascii')
  huge.write('WAVE', 8, 'ascii')
  const c = createTtsClient({ fetchImpl: async () => binRes(huge) })
  assert.equal(await c.synthesize('你好'), null, '超过上限应被拒绝')
  // 反向：刚好在上限内要能通过（证明不是"一律拒绝"的假绿）
  const okSize = Buffer.alloc(1024)
  okSize.write('RIFF', 0, 'ascii')
  okSize.write('WAVE', 8, 'ascii')
  const c2 = createTtsClient({ fetchImpl: async () => binRes(okSize) })
  const r = await c2.synthesize('你好')
  assert.ok(r !== null && r.bytes.length === 1024, '上限内的响应应通过')
})

await okAsync('合成：空文本不发请求', async () => {
  let called = 0
  const c = createTtsClient({ fetchImpl: async () => { called += 1; return binRes(makeWav(100)) } })
  assert.equal(await c.synthesize(''), null)
  assert.equal(await c.synthesize('   '), null)
  assert.equal(await c.synthesize(null), null)
  assert.equal(called, 0, '空文本不该发请求')
})

await okAsync('⭐ 超时：服务不响应 → null（AbortController 生效）', async () => {
  const c = createTtsClient({
    timeoutMs: 80,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      // 模拟"服务卡住"：只在 abort 时 reject。
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  })
  const r = await c.synthesize('你好')
  assert.equal(r, null, '超时应返回 null 而不是永远挂着')
})

await okAsync('客户端暴露清洗与缓存键（带服务身份）', async () => {
  const c = createTtsClient({
    maxChars: 20,
    fetchImpl: async () => jsonRes({ ok: true, backend: 'torch' })
  })
  await c.health()
  assert.equal(c.identity, 'torch')
  assert.equal(c.sanitize('**你好**，世界。'), '你好，世界。')
  assert.equal(c.sanitize('啊'.repeat(100)).length <= 21, true, 'maxChars 应生效')
  // 缓存键带上了 backend=torch
  assert.equal(c.cacheKey('你好'), speechCacheKey('你好', 'torch'))
})

await okAsync('默认值：URL / 超时 / 清洗上限都有合理默认', async () => {
  const c = createTtsClient({})
  assert.equal(c.baseUrl, DEFAULT_TTS_URL)
  assert.equal(c.maxChars, DEFAULT_MAX_SPEECH_CHARS)
  assert.equal(DEFAULT_TTS_URL, 'http://127.0.0.1:8765')
  assert.ok(DEFAULT_TTS_TIMEOUT_MS >= 10000, '超时要给慢后端留余量')
})

await okAsync('baseUrl 尾部斜杠被归一（不会拼出 //tts）', async () => {
  let seen = null
  const c = createTtsClient({
    baseUrl: 'http://127.0.0.1:9999/',
    fetchImpl: async url => { seen = url; return jsonRes({ ok: true, backend: 'onnx' }) }
  })
  await c.health()
  assert.equal(seen, 'http://127.0.0.1:9999/health')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败项'}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
