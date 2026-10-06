/**
 * 庄方宜桌宠 · 语音清单（**只读白名单 + 只播不合成**）
 *
 * ── 为什么有这个文件 ──────────────────────────────────────────────────────
 *
 * 用户点名要"claude目录下有一个庄方宜专属的语音合成skill"。但**运行时合成
 * 是不可能的**：实测 `synth.py` 冷启动 30.6 秒、热态 5 秒/句，而桌宠要在
 * 一秒内回应一次点击 —— 那等于"按了没反应"。
 *
 * 所以分工是：**构建期生成**（`tools/build-voice.ps1`，封闭集合 19 条），
 * **运行时只播放**。本模块负责把那份清单读进来并提供白名单查询。
 *
 * ── 为什么是白名单而不是拼路径 ────────────────────────────────────────────
 *
 * `/pet/voice/<name>` 会把 name 映射到磁盘文件。若直接拼接，`../../index.js`
 * 就能读到任意文件（素材路由那边正是为此用了 `resolveArt` 的双重校验）。
 * 这里更简单也更严：**清单里没有的 name 一律 404**，路径根本不参与拼接。
 *
 * ── 清单缺失不是错误 ──────────────────────────────────────────────────────
 *
 * 语音包是可选的（没跑过 `build-voice.ps1` 就没有）。缺了只是"没有声音"，
 * 不该影响桌宠其它任何功能 —— 所以加载失败一律返回空清单，绝不抛。
 *
 * @module src/pet/voice.js
 */

import fs from 'node:fs'
import path from 'node:path'

/** 语音包目录名（相对包根）。 */
export const VOICE_DIR_NAME = 'voice'

/** 清单文件名。 */
export const MANIFEST_NAME = 'voice.json'

/** 单条语音的体积上限（防止清单被改成指向一个巨大文件）。 */
export const MAX_CLIP_BYTES = 2 * 1024 * 1024

/**
 * 加载语音清单。
 *
 * **绝不抛**：文件不存在 / JSON 坏 / 结构不对 → 返回空清单。
 * 调用方据此知道"没有语音可用"，而不是崩在加载期。
 *
 * @param {string} voiceDir - `art/voice/` 绝对路径
 * @param {object} [logger]
 * @returns {{version: number, generatedAt: string|null, count: number, lines: object[], byName: Map<string, object>}}
 */
export function loadVoice (voiceDir, logger) {
  const empty = {
    version: 0,
    generatedAt: null,
    count: 0,
    lines: [],
    byName: new Map()
  }
  const file = path.join(voiceDir, MANIFEST_NAME)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    // ENOENT 是**正常情况**（没跑过构建脚本），不值得 warn。
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`zhuang-fangyi-pet: 语音清单读取失败（${error?.message ?? error}）`)
    }
    return empty
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger?.warn?.(`zhuang-fangyi-pet: 语音清单解析失败（${error?.message ?? error}）`)
    return empty
  }

  const list = Array.isArray(parsed?.lines) ? parsed.lines : []
  const lines = []
  const byName = new Map()
  /** 被跳过的条目数（诊断用：让"清单里有东西没被采纳"可见）。 */
  let skipped = 0
  for (const item of list) {
    // ⚠️ 非对象条目必须**显式**跳过，不能指望下游的 `isSafeName('')` 兜住 ——
    // 回退验证证明那种"巧合式安全"是测不出来的（去掉这一行断言仍全绿）。
    // 显式跳过让"清单里有垃圾"这件事在 `skipped` 计数上可见。
    //
    // 数组也归入"非条目"：`Array.isArray` 单看是冗余的（数组的 `.name` 是
    // undefined，下游照样拒），但把它写出来是为了**语义明确** ——
    // 清单条目的形状是对象，数组从来不是合法条目。
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      skipped += 1
      continue
    }
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const file_ = typeof item.file === 'string' ? item.file.trim() : ''
    // ⚠️ **name 与 file 都必须过一遍字符白名单**。清单是我们自己生成的，
    // 但"我们自己生成的"不是安全论证 —— 清单是磁盘上的文件，用户/别的程序
    // 可以改它。真正的防线是"只允许安全字符"，让 `../` 之类的路径根本不可能
    // 被表达出来（而不是事后去检测它）。
    if (!isSafeName(name) || !isSafeName(file_)) {
      skipped += 1
      logger?.warn?.(`zhuang-fangyi-pet: 语音清单里有非法条目（已忽略）：name=${name} file=${file_}`)
      continue
    }
    const rec = {
      name,
      file: file_,
      event: typeof item.event === 'string' ? item.event : null,
      source: item.source === 'real' ? 'real' : 'synth',
      // 台词原文（诊断 + "源与产物是否一致"的比对依据）。可选字段：
      // 旧清单没有它 → null，绝不因此丢弃条目。
      text: typeof item.text === 'string' ? item.text : null,
      durationMs: Number.isFinite(Number(item.durationMs)) ? Math.max(0, Math.round(Number(item.durationMs))) : 0,
      bytes: Number.isFinite(Number(item.bytes)) ? Math.max(0, Math.round(Number(item.bytes))) : 0
    }
    if (rec.bytes > MAX_CLIP_BYTES) {
      skipped += 1
      logger?.warn?.(`zhuang-fangyi-pet: 语音 ${name} 体积异常（${rec.bytes}B），已忽略`)
      continue
    }
    // 重名取先到的：后到的会静默覆盖前者，那会让"改了台词却没生效"很难查。
    if (byName.has(name)) {
      skipped += 1
      logger?.warn?.(`zhuang-fangyi-pet: 语音清单里 ${name} 重复，保留先出现的那条`)
      continue
    }
    lines.push(rec)
    byName.set(name, rec)
  }

  return {
    version: Number.isFinite(Number(parsed?.version)) ? Number(parsed.version) : 1,
    generatedAt: typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : null,
    count: lines.length,
    /** 清单里有但未被采纳的条目数（诊断：让"清单有东西却没生效"可见）。 */
    skipped,
    lines,
    byName
  }
}

/**
 * 名字是否安全（只允许 `[A-Za-z0-9._-]`，且不许是 `.`/`..`、不许有 `..` 子串）。
 *
 * 纯函数，单测直接断言。**故意严格**：语音名是我们自己起的（`click-1`、
 * `pomodoro-focus-end`），完全不需要路径分隔符或其它字符。
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSafeName (name) {
  if (typeof name !== 'string' || name === '') return false
  if (name.length > 64) return false
  if (name === '.' || name === '..') return false
  if (name.includes('..')) return false
  // 反斜杠也挡掉：Windows 上 `a\b` 也是路径分隔符。
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
}

/**
 * 解析一个语音名为绝对文件路径（**白名单查表，不拼路径**）。
 *
 * @param {string} voiceDir
 * @param {string} name
 * @param {object} manifest - `loadVoice()` 的产物
 * @returns {string|null} 绝对路径；不在清单里 → null
 */
export function resolveVoice (voiceDir, name, manifest) {
  if (manifest === null || manifest === undefined) return null
  if (typeof name !== 'string') return null
  const rec = manifest.byName?.get(name)
  if (rec === undefined || rec === null) return null
  // ⚠️ **必须先挡绝对路径**：`path.join(root, 'C:\\Windows\\win.ini')` 在
  // Windows 上返回的就是那个绝对路径本身（join 不"拼接"盘符路径），
  // 于是它**落在 root 之外**。只靠下面那句 `startsWith(root)` 是挡不住的
  // —— 因为这里的 `rec.file` 若已是绝对路径，join 结果也在 root 外，
  // startsWith 会拒绝…… 但 `file` 是绝对路径时同样要拒（那是"外部文件"），
  // 且 Unix 风格 `/etc/passwd` 在 join 下会拼成 root/etc/passwd（看起来在内，
  // 实际指向意外位置）。所以**统一先拒绝对路径与盘符**，语义最清楚。
  if (path.isAbsolute(rec.file) || /^[A-Za-z]:/.test(rec.file)) return null
  const root = path.resolve(voiceDir)
  const resolved = path.resolve(path.join(voiceDir, rec.file))
  // 二次校验：即使清单条目通过了 `isSafeName`，仍然确认解析结果落在目录内。
  // 这是"纵深防御"：任何一层被绕过都还有下一层（照抄素材路由的 `resolveArt`）。
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

/**
 * 按事件挑一条语音（**同名事件多条时轮换**，避免每次点都一样）。
 *
 * @param {object} manifest
 * @param {string} event - 如 `pet/click`
 * @param {number} [seed] - 轮换种子（调用方给个递增数即可）
 * @returns {object|null} 清单条目
 */
export function pickVoiceForEvent (manifest, event, seed = 0) {
  if (manifest === null || manifest === undefined) return null
  const pool = (manifest.lines ?? []).filter(l => l.event === event)
  if (pool.length === 0) return null
  const start = Math.abs(Math.trunc(seed)) % pool.length
  return pool[start]
}

/**
 * 诊断报告（`/pet/diag` 用）：让"语音包到底装上没有"一眼可见。
 *
 * @param {object} manifest
 * @returns {object}
 */
export function voiceReport (manifest) {
  const lines = manifest?.lines ?? []
  const byEvent = {}
  let totalMs = 0
  let totalBytes = 0
  for (const l of lines) {
    totalMs += l.durationMs
    totalBytes += l.bytes
    const key = l.event ?? '(none)'
    byEvent[key] = (byEvent[key] ?? 0) + 1
  }
  return {
    available: lines.length > 0,
    version: manifest?.version ?? 0,
    generatedAt: manifest?.generatedAt ?? null,
    count: lines.length,
    totalMs,
    totalBytes,
    realCount: lines.filter(l => l.source === 'real').length,
    synthCount: lines.filter(l => l.source === 'synth').length,
    byEvent,
    names: lines.map(l => l.name)
  }
}
