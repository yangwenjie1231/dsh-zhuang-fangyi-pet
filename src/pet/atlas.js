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
// `emotes.js` 不 import 任何东西（纯数据 + 纯函数），所以这里不会形成循环依赖。
// 覆盖率的**唯一真相**在 emotes 的池表里，atlas 只做报告，不再抄一份。
import { emoteCoverage, EMOTE_EXCLUDE_FROM_RANDOM } from './emotes.js'

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
    /** 每个文件自己的几何（契约 §4 的 `files`）。见 `geometryFor()`。 */
    files: {},
    bubble: [],
    missing: [],
    /** 白名单：相对 `art/pet/` 的路径集合，由清单派生。 */
    allowed: new Set()
  }
}

/** 解析一条几何记录；非法时返回 null。 */
function parseGeom (entry) {
  if (entry === null || typeof entry !== 'object') return null
  const frames = Number.isFinite(entry.frames) && entry.frames > 0 ? Math.round(entry.frames) : null
  if (frames === null) return null
  return {
    frames,
    frameWidth: Number.isFinite(entry.frameWidth) && entry.frameWidth > 0
      ? Math.round(entry.frameWidth)
      : null,
    frameMs: Number.isFinite(entry.frameMs) && entry.frameMs > 0 ? Math.round(entry.frameMs) : 36
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
    out.allowed.add(file.replace(/\\/g, '/'))
    return true
  }

  // ── files：每个文件自己的几何（契约 §4）。**先解析**，这样 states/variants
  //    可以引用它来修正自己的几何。 ────────────────────────────────────────
  if (raw.files !== null && typeof raw.files === 'object' && !Array.isArray(raw.files)) {
    for (const [file, entry] of Object.entries(raw.files)) {
      if (!isSafeRel(file)) continue
      const geom = parseGeom(entry)
      if (geom === null) continue
      out.files[file.replace(/\\/g, '/')] = geom
      addFile(file)
    }
  }

  // ── states：键必须是合法状态名，条目必须含合法文件名与帧数 ──────────────
  if (raw.states !== null && typeof raw.states === 'object') {
    for (const [state, entry] of Object.entries(raw.states)) {
      if (!VALID_STATES.includes(state)) continue
      if (entry === null || typeof entry !== 'object') continue
      const file = entry.file
      if (!addFile(file)) continue
      const key = file.replace(/\\/g, '/')
      // 几何优先级：files[<文件名>] → states 自己的声明 → 默认值。
      // 这样即使 states 的声明与文件实际不符（实测发生过），也能被 files 修正。
      const geom = out.files[key] ?? parseGeom(entry) ?? { frames: 1, frameWidth: null, frameMs: 36 }
      out.states[state] = {
        file: key,
        frames: geom.frames,
        frameMs: geom.frameMs,
        frameWidth: geom.frameWidth,
        anchorY: Number.isFinite(entry.anchorY) ? entry.anchorY : 1.0
      }
    }
  }

  // ── variants：同状态多素材轮换。只保留既安全又真实存在的条目 ─────────────
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
      const file = String(entry.file).replace(/\\/g, '/')
      // 深色变体（可选）：相对 `art/pet/` 的路径，也必须进白名单才服务。
      let fileDark = null
      if (isSafeRel(entry.fileDark)) {
        fileDark = String(entry.fileDark).replace(/\\/g, '/')
        addFile(entry.fileDark)
      }
      out.bubble.push({
        file,
        w: Number.isFinite(entry.w) ? Math.round(entry.w) : 0,
        h: Number.isFinite(entry.h) ? Math.round(entry.h) : 0,
        // 该图**自己已经把文字画进去了**（聊天贴纸）。
        // 缺字段按 false（旧清单仍可用，只是可能叠字）。
        hasText: entry.hasText === true,
        // 该图**没有 alpha、铺满整个画布**（黑白线稿自带白底）。
        // 渲染侧据此**不套气泡自己的底/内边距**，避免"白纸贴在浅色框里"的双层边框。
        opaque: entry.opaque === true,
        fileDark
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
      const geom = out.files[list[0]] ?? { frames: 1, frameWidth: null, frameMs: 36 }
      out.states[state] = {
        file: list[0],
        frames: geom.frames,
        frameMs: geom.frameMs,
        frameWidth: geom.frameWidth,
        anchorY: 1.0
      }
    }
  }

  return out
}

/**
 * 取某个素材文件的几何。
 *
 * **这是几何的唯一解析入口**，优先级与契约 §4 一致：
 *
 * ```
 * files[<文件名>]  →  states[<state>]（若该文件就是该状态的 canonical）  →  默认值
 * ```
 *
 * 为什么需要它：`variants` 里的素材几何**差异极大**（实测 24 个变体里 14 个
 * 与所属 state 的声明不符 —— 因为混了「静态 PNG 1 帧」与「动态 GIF N 帧」）。
 * 按 state 声明的 `frames` 去切变体，会切出 7px 的**碎条**。
 *
 * @param {object} atlas
 * @param {string} file - 相对 `art/pet/` 的路径
 * @returns {{frames: number, frameWidth: number|null, frameMs: number}}
 */
export function geometryFor (atlas, file) {
  const fallback = { frames: 1, frameWidth: null, frameMs: 36 }
  if (atlas === null || atlas === undefined || typeof file !== 'string') return fallback
  const key = file.replace(/\\/g, '/')
  const fromFiles = atlas.files?.[key]
  if (fromFiles !== undefined && fromFiles !== null) return fromFiles
  // 该文件若是某状态的 canonical，用该状态的声明。
  for (const entry of Object.values(atlas.states ?? {})) {
    if (entry?.file === key) {
      return { frames: entry.frames, frameWidth: entry.frameWidth, frameMs: entry.frameMs }
    }
  }
  return fallback
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
  if (atlas !== undefined && atlas !== null && atlas.allowed instanceof Set) {
    if (!atlas.allowed.has(normalized)) return null
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
 * 调用方若要拿该文件的几何，用 {@link geometryFor} —— **不要**用 `states[state]`
 * 的声明，因为轮换到的变体可能与之不符（实测 24 个变体里 14 个不符）。
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
 * @returns {{file: string, w: number, h: number, hasText: boolean}|null}
 *   **返回整条记录而不只是文件名** —— 调用方需要 `hasText` 来决定要不要叠文字。
 *   见 {@link bubbleHasText}。
 */
export function bubbleArt (atlas, seed = 0) {
  const pool = atlas?.bubble
  if (!Array.isArray(pool) || pool.length === 0) return null
  const i = Math.abs(Math.trunc(seed)) % pool.length
  return pool[i] ?? null
}

/**
 * 按**文件路径**取气泡记录（用于"表情结合状态"：映射给出文件，这里取回整条记录）。
 *
 * 为什么要这个：`bubbleArt` 只能按下标取，而状态→表情的映射是按**文件**写的
 * （可读、可评审）。返回整条记录而不是只回文件名，是因为调用方还需要
 * `hasText`（决定要不要叠文案）与 `opaque`/`fileDark`（决定呈现与深色变体）。
 *
 * 找不到返回 null（**不抛**）：素材被换掉时应当回落到全池，而不是让气泡哑掉。
 *
 * @param {object} atlas
 * @param {string} file - 相对 `art/pet/` 的路径
 * @returns {{file: string, w: number, h: number, hasText: boolean}|null}
 */
export function bubbleArtByFile (atlas, file) {
  const pool = atlas?.bubble
  if (!Array.isArray(pool) || typeof file !== 'string' || file === '') return null
  const key = file.replace(/\\/g, '/')
  for (const entry of pool) {
    if (entry?.file === key) return entry
  }
  return null
}

/**
 * 取某张气泡图是否**自带文字**。
 *
 * 素材里有一整类「中文已经印在图上」的聊天贴纸（实测 16 张，如「好耶！」「工作中…」）。
 * 这类图当气泡时，**绝不能再叠 Host 的文字** —— 否则屏幕上会出现两段互相打架的文字。
 *
 * 找不到该文件时按 `false`（安全侧：允许配文字）。
 *
 * @param {object} atlas
 * @param {string} file - 相对 `art/pet/` 的路径
 * @returns {boolean}
 */
export function bubbleHasText (atlas, file) {
  const pool = atlas?.bubble
  if (!Array.isArray(pool) || typeof file !== 'string') return false
  const key = file.replace(/\\/g, '/')
  for (const entry of pool) {
    if (entry?.file === key) return entry.hasText === true
  }
  return false
}

/**
 * 按当前主题挑出该气泡图**实际要加载的文件**。
 *
 * 深色模式由**渲染方自己判断**（原生 exe 读系统深色模式；overlay 用
 * `prefers-color-scheme`），因为只有渲染方知道自己的实际主题 —— Host 在服务端
 * 无从知晓。所以 Host 只负责把两条路径都给出去，由渲染方选。
 *
 * @param {{file: string, fileDark?: string|null}} entry
 * @param {boolean} dark
 * @returns {string|null}
 */
export function resolveBubbleFile (entry, dark) {
  if (entry === null || entry === undefined) return null
  if (dark === true && typeof entry.fileDark === 'string' && entry.fileDark !== '') {
    return entry.fileDark
  }
  return entry.file ?? null
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
  const bubbles = Array.isArray(atlas.bubble) ? atlas.bubble : []
  // 覆盖率：哪些气泡图**永远不会被按状态挑中**（只能靠全池兜底或画廊看到）。
  // 这不是错误（全池与画廊仍会展示它们），但新增素材后值得一眼看见 ——
  // 否则"加了图却从不出现"只能靠用户反馈才发现。
  const { used, unused } = emoteCoverage(bubbles.map(b => b.file))
  return {
    version: atlas.version ?? 0,
    generatedAt: atlas.generatedAt ?? null,
    frameHeight: atlas.frameHeight ?? 0,
    files: atlas.allowed instanceof Set ? atlas.allowed.size : 0,
    /** `files` 映射的条目数（每个文件自己的几何）。 */
    fileGeometry: Object.keys(atlas.files ?? {}).length,
    bubbleCount: bubbles.length,
    coveredStates: covered,
    uncoveredStates: uncovered,
    missingCount: Array.isArray(atlas.missing) ? atlas.missing.length : 0,
    missing: atlas.missing ?? [],
    /** 表情覆盖率（诊断用）：被状态池引用的 / 只能靠兜底看到的。 */
    emotes: {
      usedCount: used.length,
      unusedCount: unused.length,
      unused
    },
    /** 全池兜底时会被跳过的图（语义太强，见 `EMOTE_EXCLUDE_FROM_RANDOM`）。 */
    excludedCount: EMOTE_EXCLUDE_FROM_RANDOM.length
  }
}