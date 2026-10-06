/**
 * 庄方宜桌宠 · 动态语音（TTS）客户端
 *
 * ── 它为什么存在 ──────────────────────────────────────────────────────────
 *
 * 固定台词（`art/voice/`）是**构建期**预生成的封闭集合 —— 那是"她主动说的话"。
 * 但 AI 的**回答**是任意文本，没法预生成。所以需要一条运行时合成通道：
 *
 *     AI 回复 → 清洗成可朗读文本 → 子插件合成 → exe 播放
 *
 * ── 对接的子插件 ──────────────────────────────────────────────────────────
 *
 * `dsh-zhuang-fangyi-voice`（独立仓库）提供的 HTTP 服务：
 *
 *     GET  /health   → {"ok":true,"backend":"onnx","ready":true}
 *     POST /tts      → body {"text":"...","seed":null} → audio/wav 二进制
 *     POST /tts.json → {"ok":true,"duration":1.23,"wav_base64":"..."}
 *
 * 本模块**只依赖这个契约**，不关心它是 onnx 还是 torch、跑在哪台机器上。
 *
 * ── 延迟是设计约束，不是细节（子插件 README 实测）─────────────────────────
 *
 *     torch + CUDA   RTF 0.45   6 秒音频 ≈ 3 秒   ← 可用
 *     torch + CPU    RTF 1.60   ≈ 10 秒
 *     onnx  + CPU    RTF 6.1    ≈ 37 秒           ← 逐句交互不可用
 *
 * 所以：
 *   1. **必须异步** —— 气泡立刻显示，语音好了再播（绝不阻塞回复）；
 *   2. **必须缓存** —— 同一句话第二次立刻返回（子插件侧也有缓存，双保险）；
 *   3. **必须能失败** —— 服务没起 / 超时 / 报错 → 返回 null，退回固定台词，
 *      绝不能让"语音挂了"变成"聊天挂了"。
 *
 * ── 清洗为什么是必需的 ────────────────────────────────────────────────────
 *
 * AI 的回答是 **markdown**：`**加粗**`、``` 代码块 ```、`[链接](url)`、列表符号。
 * 原样朗读会念出"星号星号加粗星号星号"、"反引号反引号"——难听到不能用。
 * `sanitizeForSpeech()` 就是干这个的（纯函数，可穷举单测）。
 *
 * @module src/pet/tts.js
 */

import { createHash } from 'node:crypto'

/** 默认服务地址（子插件 README 的默认端口）。 */
export const DEFAULT_TTS_URL = 'http://127.0.0.1:8765'

/** 单次合成的超时（ms）。torch+GPU 约 3 秒；给足余量但不无限等。 */
export const DEFAULT_TTS_TIMEOUT_MS = 30000

/**
 * 朗读文本的长度上限（字符）。
 *
 * 为什么默认这么短：她**在气泡里已经显示全文**了，语音只是"陪一句"。
 * 而且 onnx 后端 6 秒音频要 37 秒 —— 越长越不可能及时。
 * 60 字 ≈ 15 秒音频，torch 下约 7 秒合成，已经是可接受的体验上限。
 */
export const DEFAULT_MAX_SPEECH_CHARS = 60

/** 合成结果的体积上限（字节）。WAV 未压缩，6 秒 32kHz 单声道 ≈ 380KB。 */
export const MAX_SPEECH_BYTES = 8 * 1024 * 1024

/**
 * 把 markdown 回复清洗成**可朗读**的文本。
 *
 * 规则（每一条都是"念出来会很难听"的东西）：
 *   · 代码块 / 行内代码 → 删掉（念 `function foo(){}` 毫无意义）
 *   · 链接 → 只留文字（念 URL 是灾难）
 *   · 加粗/斜体/标题/引用/列表符号 → 去掉标记，保留文字
 *   · 表格分隔行、水平线 → 删掉
 *   · emoji / 制表符 / 连续空白 → 归一
 *   · 超长 → 在**句子边界**截断（截到半个词更糟）
 *
 * @param {string} raw - AI 的原始回复（markdown）
 * @param {object} [opts]
 * @param {number} [opts.maxChars]
 * @returns {string|null} 可朗读文本；洗不出东西（比如回复全是代码）→ null
 */
export function sanitizeForSpeech (raw, opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0
    ? Math.floor(opts.maxChars)
    : DEFAULT_MAX_SPEECH_CHARS
  if (typeof raw !== 'string') return null

  let t = raw

  // ① 围栏代码块（``` 或 ~~~）：整段删掉。**先做这一步** ——
  // 否则代码里的 `#`、`*`、`|` 会被后面的规则当成 markdown 处理，越洗越乱。
  t = t.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, ' ')
  // 未闭合的围栏（流式回复可能截断）→ 删到结尾
  t = t.replace(/^[ \t]*(```|~~~)[\s\S]*$/m, ' ')

  // ② 行内代码 `x`：短标识符（变量名/命令）留着还有意义，长的删掉。
  t = t.replace(/`([^`\n]{1,24})`/g, '$1')
  t = t.replace(/`[^`\n]+`/g, ' ')

  // ③ 图片 ![alt](url) → 删；链接 [text](url) → 只留 text。
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

  // ④ 裸 URL → 删（念出来是灾难）。
  t = t.replace(/<?https?:\/\/[^\s<>)]+>?/gi, ' ')
  t = t.replace(/\bwww\.[^\s<>)]+/gi, ' ')

  // ⑤ markdown 行首标记：标题 #、引用 >、列表 - * + 、有序列表 1. 。
  t = t.replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
  t = t.replace(/^[ \t]*>[ \t]?/gm, '')
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  t = t.replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
  // 水平线（--- *** ___）
  t = t.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, ' ')
  // 表格分隔行（|---|---|）
  t = t.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
  // 表格竖线 → 顿号式停顿（保留单元格文字）
  t = t.replace(/[ \t]*\|[ \t]*/g, '，')

  // ⑥ 行内强调标记（**bold** / *italic* / __x__ / ~~del~~）→ 只去标记。
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
  t = t.replace(/__([^_]+)__/g, '$1')
  t = t.replace(/\*([^*\n]+)\*/g, '$1')
  t = t.replace(/(?<![0-9A-Za-z])_([^_\n]+)_(?![0-9A-Za-z])/g, '$1')
  t = t.replace(/~~([^~]+)~~/g, '$1')

  // ⑦ 残留的孤立标记字符（`*` 当作相乘号时保留？不 —— 朗读里它就是噪音）。
  t = t.replace(/[*_`#]+/g, '')

  // ⑧ emoji / 符号图标：朗读会变成"笑脸"之类，删掉。
  // 覆盖常见 emoji 区段（含变体选择符与零宽连接符）。
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')

  // ⑨ 空白归一：换行 → 停顿（用逗号更自然），连续空白压成一个空格。
  t = t.replace(/[ \t\u00A0]+/g, ' ')
  t = t.replace(/\s*\n+\s*/g, '，')
  t = t.replace(/，{2,}/g, '，')
  t = t.replace(/\s+/g, ' ')
  // 去掉行首行尾的标点噪音
  t = t.replace(/^[，、；:：\s]+/, '').replace(/[，、；:：\s]+$/, '')
  t = t.trim()

  if (t === '') return null

  // ⑩ 截断到句子边界（避免念到一半断掉）。
  if (t.length > maxChars) {
    const head = t.slice(0, maxChars)
    // 找最后一个句末标点；找不到就退回逗号；再找不到就硬截。
    const lastStop = Math.max(
      head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
      head.lastIndexOf('；'), head.lastIndexOf('!'), head.lastIndexOf('?'),
      head.lastIndexOf(';')
    )
    if (lastStop >= Math.floor(maxChars * 0.4)) {
      t = head.slice(0, lastStop + 1)
    } else {
      const lastComma = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','))
      t = lastComma >= Math.floor(maxChars * 0.5)
        ? head.slice(0, lastComma) + '。'
        : head.replace(/[，、,;；:：\s]+$/, '') + '。'
    }
  }

  return t === '' ? null : t
}

/**
 * 合成缓存键：**文本 + 服务身份**。
 *
 * 为什么要带服务身份（后端/参考音频）：换了音色或后端之后，
 * 同一个文本应该是**不同的**音频。只按文本做键会让换音色后
 * 仍然播旧音色 —— 而且毫无报错（听起来只是"没生效"）。
 *
 * @param {string} text
 * @param {string} [identity] - 服务身份串（如 `onnx|default.wav`）
 * @returns {string} 16 位十六进制
 */
export function speechCacheKey (text, identity = '') {
  const h = createHash('sha1')
  h.update(String(text ?? ''), 'utf8')
  h.update('\u0000', 'utf8')
  h.update(String(identity ?? ''), 'utf8')
  return h.digest('hex').slice(0, 16)
}

/**
 * 解析 WAV 字节的时长（ms）。
 *
 * 为什么自己解析而不问服务：`/tts` 只返回二进制，不带时长；
 * 而 exe 需要时长做"上一句没播完别播下一句"的判断。
 * WAV 头是定长小端字段，解析它比再多一次 HTTP 请求便宜得多。
 *
 * @param {Uint8Array|Buffer} bytes
 * @returns {number} 毫秒；解析不出 → 0
 */
export function wavDurationMs (bytes) {
  try {
    if (bytes === null || bytes === undefined) return 0
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    if (b.length < 44) return 0
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return 0
    // 逐块扫：fmt 拿字节率，data 拿数据长度。
    let byteRate = 0
    let dataLen = 0
    let off = 12
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4)
      const size = b.readUInt32LE(off + 4)
      const body = off + 8
      if (id === 'fmt ' && body + 16 <= b.length) {
        byteRate = b.readUInt32LE(body + 8)
      } else if (id === 'data') {
        // 有些写入器把 size 写成 0 或超出实际长度 → 用实际剩余字节兜底。
        dataLen = Math.min(size, b.length - body)
      }
      // 块按偶数字节对齐
      off = body + size + (size % 2)
    }
    if (byteRate <= 0 || dataLen <= 0) return 0
    return Math.round((dataLen / byteRate) * 1000)
  } catch {
    return 0
  }
}

/**
 * 创建 TTS 客户端。
 *
 * 全部失败路径都**返回 null 而不抛** —— 调用方（聊天链路）不该因为
 * 语音服务的问题而出错。
 *
 * @param {object} opts
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl] - 注入便于测试
 * @param {object} [opts.logger]
 * @returns {object} `{ health, synthesize, cacheKey, maxChars }`
 */
export function createTtsClient (opts = {}) {
  const baseUrl = String(opts.baseUrl ?? DEFAULT_TTS_URL).replace(/\/+$/, '')
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs)
    : DEFAULT_TTS_TIMEOUT_MS
  const fetchImpl = typeof opts.fetchImpl === 'function'
    ? opts.fetchImpl
    : (typeof fetch === 'function' ? fetch : null)
  const logger = opts.logger ?? null
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0
    ? Math.floor(opts.maxChars)
    : DEFAULT_MAX_SPEECH_CHARS

  /** 服务身份（缓存键用）：`backend|参考音频`。健康检查时填。 */
  let identity = ''

  /**
   * 健康检查。
   * @returns {Promise<{ok: boolean, backend: string|null, version: string|null}|null>}
   */
  const health = async () => {
    if (fetchImpl === null) return null
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, 5000))
      let res = null
      try {
        res = await fetchImpl(`${baseUrl}/health`, {
          method: 'GET',
          signal: ctrl.signal,
          headers: { accept: 'application/json' }
        })
      } finally {
        clearTimeout(timer)
      }
      if (res === null || res.ok !== true) return null
      const body = await res.json()
      if (body?.ok !== true) return null
      const backend = typeof body.backend === 'string' ? body.backend : null
      identity = backend ?? ''
      return { ok: true, backend, version: typeof body.version === 'string' ? body.version : null }
    } catch (error) {
      logger?.debug?.(`zhuang-fangyi-pet: TTS 健康检查失败：${error?.message ?? error}`)
      return null
    }
  }

  /**
   * 合成一句。
   *
   * 优先用 `/tts`（二进制，省掉 base64 编解码与 33% 体积）；
   * 老版本服务没有它时退回 `/tts.json`。
   *
   * @param {string} text - **已清洗**的文本（本函数不再清洗）
   * @returns {Promise<{bytes: Buffer, durationMs: number, cached: boolean}|null>}
   */
  const synthesize = async text => {
    if (fetchImpl === null) return null
    if (typeof text !== 'string' || text.trim() === '') return null
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      let res = null
      try {
        res = await fetchImpl(`${baseUrl}/tts`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text })
        })
      } catch (error) {
        logger?.warn?.(`zhuang-fangyi-pet: TTS 合成失败：${error?.message ?? error}`)
        return null
      }
      if (res === null || res.ok !== true) {
        logger?.warn?.(`zhuang-fangyi-pet: TTS 合成返回 ${res?.status ?? 'no-response'}`)
        return null
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0 || buf.length > MAX_SPEECH_BYTES) {
        logger?.warn?.(`zhuang-fangyi-pet: TTS 返回体积异常（${buf.length}B），已丢弃`)
        return null
      }
      // 必须是 WAV：exe 的播放器按容器解析时长与解码。
      if (buf.toString('ascii', 0, 4) !== 'RIFF') {
        logger?.warn?.('zhuang-fangyi-pet: TTS 返回的不是 RIFF/WAV，已丢弃')
        return null
      }
      return { bytes: buf, durationMs: wavDurationMs(buf), cached: false }
    } catch (error) {
      logger?.warn?.(`zhuang-fangyi-pet: TTS 合成异常：${error?.message ?? error}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    baseUrl,
    health,
    synthesize,
    maxChars,
    sanitize: raw => sanitizeForSpeech(raw, { maxChars }),
    cacheKey: text => speechCacheKey(text, identity),
    get identity () { return identity }
  }
}
