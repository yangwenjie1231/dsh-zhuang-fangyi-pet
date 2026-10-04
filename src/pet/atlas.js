/**
 * 庄方宜桌宠 · 素材清单（`art/pet/pet.json`）加载与校验
 *
 * ── 职责边界 ──────────────────────────────────────────────────────────────
 *
 * 这个文件是**素材目录的唯一入口**。任何要用素材的地方（路由白名单、气泡选图、
 * 状态回落）都必须经过它，绝不自己拼路径 —— 拼路径就是目录遍历漏洞
 * （`桌宠开发文档.md` §十 红线，主题插件已用 `artWhitelist()` 踩过）。
 *
 * 清单由 `tools/prepare-pet.py` 产出，schema 冻结在 `docs/接口契约.md` §4。
 *
 * ── 容错原则 ──────────────────────────────────────────────────────────────
 *
 * **缺图不是错误。** 用户可能还没手动抠图，`prepare-pet.py` 也可能没跑过。
 * 所以清单缺失/损坏时回落为空清单，桌宠退化成"没有表情"但仍能运行 ——
 * 绝不因为素材问题让插件瘫掉。
 *
 * @module src/pet/atlas.js
 */

import fs from 'node:fs'
import path from 'node:path'

/** 合法状态名。**故意在这里重复一份**，而不是 import `state.js`：
 *  这个模块要能在极小的依赖面下被单测，且契约是三方共用的稳定值域。 */
export const VALID_STATES = [
  'waking', 'idle', 'listening', 'thinking',
  'working', 'waiting', 'happy', 'error', 'sleeping'
]

/** 空清单：任何素材都不可用时的回落。 */
export function emptyAtlas () {
  return {
    version: 0,
    generatedAt: null,
    frameHeight: 0,
    states: {},
    variants: {},
    bubble: [],
    missing: [],
    /** 白名单：相对 `art/pet/` 的路径集合，由清单派生。 */
    files: new Set()
  }
}

/** 相对路径是否安全：不许绝对路径、不许 `..`、不许反斜杠穿越。 */
export function isSafeRel (rel) {
  if (typeof rel !== 'string' || rel.trim() === '') return false
  if (path.isAbsolute(rel)) return false
  // 统一分隔符后再判：Windows 下 `a\..\b` 也要挡住。
  const normalized = rel.replace(/\\/g, '/')
  if (normalized.split('/').includes('..')) return false
  if (normalized.startsWith('/')) return false
  return true
}

/**
 * 归一化一份清单：只保留合法条目，并派生白名单。
 *
 * @param {unknown} raw - `JSON.parse` 的结果
 * @returns {object} 归一化后的清单（含 `files: Set<string>`）
 */
export function normalizeAtlas (raw) {
  const out = emptyAtlas()
  if (raw === null || typeof raw !== 'object') return out

  out.version = Number.isFinite(raw.version) ? raw.version : 0
  out.generatedAt = typeof raw.generatedAt === 'string' ? raw.generatedAt : null
  out.frameHeight = Number.isFinite(raw.frameHeight) && raw.frameHeight > 0
    ? Math.round(raw.frameHeight)
    : 0

  const addFile = file => {
    if (!isSafeRel(file)) return false
    out.files.add(file.replace(/\\/g, '/'))
    return true
  }

  // ── states：键必须是合法状态名，条目必须含合法文件名与帧数 ──────────────
  if (raw.states !== null && typeof raw.states === 'object') {
    for (const [state, entry] of Object.entries(raw.states)) {
      if (!VALID_STATES.includes(state)) continue
      if (entry === null || typeof entry !== 'object') continue
      const file = entry.file
      if (!addFile(file)) continue
      const frames = Number.isFinite(entry.frames) && entry.frames > 0 ? Math.round(entry.frames) : 1
      const frameMs = Number.isFinite(entry.frameMs) && entry.frameMs > 0 ? Math.round(entry.frameMs) : 36
      // 单帧宽度：**单帧不是方的**（实测 204~288px），所以必须显式带上，
      // 否则客户端只能拿 frameHeight 当宽度 → 横向压扁 + 切状态时宽度跳变。
      // 缺该字段时回落 frameHeight（旧清单仍可用，只是方形假设）。
      const frameWidth = Number.isFinite(entry.frameWidth) && entry.frameWidth > 0
        ? Math.round(entry.frameWidth)
        : null
      out.states[state] = {
        file: file.replace(/\\/g, '/'),
        frames,
        frameMs,
        frameWidth,
        anchorY: Number.isFinite(entry.anchorY) ? entry.anchorY : 1.0
      }
    }
  }

  // ── variants：同状态多素材轮换。只保留既安全又真实存在于 states 里的 ─────
  if (raw.variants !== null && typeof raw.variants === 'object') {
    for (const [state, list] of Object.entries(raw.variants)) {
      if (!VALID_STATES.includes(state)) continue
      if (!Array.isArray(list)) continue
      const kept = []
      for (const file of list) {
        if (!isSafeRel(file)) continue
        kept.push(file.replace(/\\/g, '/'))
        addFile(file)
      }
      if (kept.length > 0) out.variants[state] = kept
    }
  }

  // ── bubble：气泡表情池 ──────────────────────────────────────────────────
  if (Array.isArray(raw.bubble)) {
    for (const entry of raw.bubble) {
      if (entry === null || typeof entry !== 'object') continue
      if (!addFile(entry.file)) continue
      out.bubble.push({
        file: String(entry.file).replace(/\\/g, '/'),
        w: Number.isFinite(entry.w) ? Math.round(entry.w) : 0,
        h: Number.isFinite(entry.h) ? Math.round(entry.h) : 0
      })
    }
  }

  // ── missing：待人工抠图的素材，仅供报告，不参与白名单 ────────────────────
  if (Array.isArray(raw.missing)) {
    for (const entry of raw.missing) {
      if (entry === null || typeof entry !== 'object') continue
      out.missing.push({
        name: typeof entry.name === 'string' ? entry.name : '未知',
        reason: typeof entry.reason === 'string' ? entry.reason : 'unknown'
      })
    }
  }

  // 若 `states` 为空但 `variants` 有内容，用 variants 兜底，避免"完全没表情"。
  if (Object.keys(out.states).length === 0) {
    for (const [state, list] of Object.entries(out.variants)) {
      if (list.length === 0) continue
      out.states[state] = { file: list[0], frames: 1, frameMs: 36, frameWidth: null, anchorY: 1.0 }
    }
  }

  return out
}

/**
 * 从磁盘读清单。**任何失败都回落空清单**，不抛错。
 *
 * @param {string} artDir - `art/pet/` 绝对路径
 * @param {object} [logger]
 * @returns {object} 归一化后的清单
 */
export function loadAtlas (artDir, logger = console) {
  const file = path.join(artDir, 'pet.json')
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.warn?.(`zhuang-fangyi-pet: 素材清单读取失败（${error?.message ?? error}）`)
    }
    return emptyAtlas()
  }
  return normalizeAtlas(raw)
}

/**
 * 解析一个相对素材路径为绝对路径，并**二次确认它仍在 artDir 内**。
 *
 * 双保险：清单归一化时已过滤过一次，这里再按真实路径校验一次 ——
 * 万一日后有人绕过 `normalizeAtlas` 直接塞路径进来，仍然挡得住
 * （主题插件 `readArt()` 用的就是这个套路）。
 *
 * @param {string} artDir
 * @param {string} rel
 * @param {object} atlas - 归一化清单（用于白名单校验）
 * @returns {string|null} 绝对路径；不合法返回 null
 */
export function resolveArt (artDir, rel, atlas) {
  if (!isSafeRel(rel)) return null
  const normalized = String(rel).replace(/\\/g, '/')
  // 白名单优先：清单里没有的文件一律不服务。
  if (atlas !== undefined && atlas !== null && atlas.files instanceof Set) {
    if (!atlas.files.has(normalized)) return null
  }
  const base = path.resolve(artDir)
  const abs = path.resolve(base, normalized)
  if (abs !== base && !abs.startsWith(base + path.sep)) return null
  return abs
}

/**
 * 为某个状态挑一个素材文件（支持 `variants` 轮换）。
 *
 * 缺该状态时**回落 idle**；连 idle 都没有时返回 null
 * （客户端与 exe 都要能优雅处理"没有图"）。
 *
 * @param {object} atlas
 * @param {string} state
 * @param {number} seed - 轮换种子（状态机每次状态变化会推进它）
 * @returns {string|null}
 */
export function artForState (atlas, state, seed = 0) {
  if (atlas === null || atlas === undefined) return null
  const list = atlas.variants?.[state]
  if (Array.isArray(list) && list.length > 0) {
    const i = Math.abs(Math.trunc(seed)) % list.length
    return list[i]
  }
  const entry = atlas.states?.[state]
  if (entry !== undefined && entry !== null) return entry.file
  // 回落：idle → 第一个可用状态 → null
  const idle = atlas.states?.idle
  if (idle !== undefined && idle !== null) return idle.file
  const first = Object.values(atlas.states ?? {})[0]
  return first !== undefined && first !== null ? first.file : null
}

/**
 * 为气泡挑一张表情图（轮换）。
 *
 * @param {object} atlas
 * @param {number} seed
 * @returns {string|null}
 */
export function bubbleArt (atlas, seed = 0) {
  const pool = atlas?.bubble
  if (!Array.isArray(pool) || pool.length === 0) return null
  const i = Math.abs(Math.trunc(seed)) % pool.length
  return pool[i].file
}

/**
 * 覆盖率报告（`--check` 与 `/diag` 都用它）。
 *
 * @param {object} atlas
 * @returns {object}
 */
export function atlasReport (atlas) {
  const covered = VALID_STATES.filter(s => atlas.states?.[s] !== undefined)
  const uncovered = VALID_STATES.filter(s => atlas.states?.[s] === undefined)
  return {
    version: atlas.version ?? 0,
    generatedAt: atlas.generatedAt ?? null,
    frameHeight: atlas.frameHeight ?? 0,
    files: atlas.files instanceof Set ? atlas.files.size : 0,
    bubbleCount: Array.isArray(atlas.bubble) ? atlas.bubble.length : 0,
    coveredStates: covered,
    uncoveredStates: uncovered,
    missingCount: Array.isArray(atlas.missing) ? atlas.missing.length : 0,
    missing: atlas.missing ?? []
  }
}