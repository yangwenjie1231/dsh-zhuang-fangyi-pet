/**
 * 庄方宜桌宠 · 「表情结合状态」映射
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────────
 *
 * 原先挑气泡图是 `bubbleArt(atlas, seed)` —— **只按索引取模，完全忽略状态**。
 * 后果是"AI 报错了"和"AI 干完了"从同一个池子里随机抽：
 * 可能刚出错就弹「好耶！」、刚完成就弹「庄一直哭」。用户明确要求
 * "表情能够结合实际的状态"，这个文件就是那份对应关系。
 *
 * ── 设计原则 ──────────────────────────────────────────────────────────────
 *
 * 1. **按语义分组，不按文件名序号**。每张图的语义来自 `tools/prepare-pet.py`
 *    里逐张看图写下的注释（例如 `17-yay` = 好耶、`19-slacking` = 摸鱼ing），
 *    不是猜文件名。
 * 2. **每个状态都要有图**。宁可某组图少一点，也不能让某个状态退化成"没表情"——
 *    分组为空时调用方会回落到全池（见 `pickBubbleForState`）。
 * 3. **情绪要对得上**：出错不该配「好耶」，完成不该配「庄一直哭」。
 * 4. **同组内轮换**，不重复到腻：用 `seed` 做偏移，并且**避开上一张**
 *    （见 `pickBubbleForState` 的 avoid 参数）。
 *
 * 纯数据 + 纯函数，无 IO —— 三端（Host/overlay/exe）与测试共用同一份认知。
 */

/**
 * 情境映射表与排除名单：**自动生成，见 `emotes.data.js`**。
 *
 * 归属（哪张图在哪些情境下出现）现在由 `assets/catalog.json` 决定，
 * `tools/prepare-pet.py` 从台账生成 `emotes.data.js`。改归属请改台账再重跑管线，
 * **不要改这两张表** —— 以前它们手写在这里、旁边还另有一份 Python 表，
 * 两处真相各改一半是常态（现已消除）。
 *
 * 情境 key 的取值来自状态机的 `requestBubble` 调用点：9 个状态名（`listening`
 * 2026-10-07 起只弹气泡、不再作为主体状态）、`notify-complete`、`tool/failed`、
 * `inbox/inserted`、`idle-emote-*`（前缀归到 `idle`）。
 *
 * 这里**重新导出**（而不是改调用方的 import）是有意的：现有 4 处 import
 * （`index.js` / `atlas.js` / 两个测试）一个字都不用动。
 */
export { EMOTE_BY_KEY, EMOTE_EXCLUDE_FROM_RANDOM } from './emotes.data.js'
import { EMOTE_BY_KEY, EMOTE_EXCLUDE_FROM_RANDOM } from './emotes.data.js'

/**
 * 从**候选文件**里挑一张，跳过「语义太强、不该随机撒」的那些。
 *
 * 这是 `EMOTE_EXCLUDE_FROM_RANDOM` 的**唯一消费点**。此前那个名单只导出、
 * 只被测试引用，**运行时从没读过它** —— 于是"全池随机"这条兜底路径
 * 仍然可能随机撒出「么么哒」或「晚安啦」，名单形同虚设。
 *
 * 语义：`candidates` 是**已经按某个顺序排好**的文件列表（调用方决定轮换顺序），
 * 本函数返回其中第一个不在排除名单里的。**全部都在名单里**时返回 null ——
 * 此时调用方应回落到原始候选（宁可撒语义强的，也不要没表情）。
 *
 * @param {string[]} candidates
 * @returns {string|null}
 */
export function firstAllowedEmote (candidates) {
  if (!Array.isArray(candidates)) return null
  for (const f of candidates) {
    if (typeof f !== 'string' || f === '') continue
    if (!EMOTE_EXCLUDE_FROM_RANDOM.includes(f)) return f
  }
  return null
}

/**
 * 从**全池**里按 seed 轮换挑一张，并跳过排除名单。
 *
 * 供 Host 的兜底路径使用（`pickEmoteFile` 返回 null 时）。
 * 从 `seed` 开始往后找，找到第一个可用的；整个池都被排除时退回 `pool[seed]`
 * ——「有表情」比「守名单」重要。
 *
 * @param {{file: string}[]} pool - 清单里的气泡数组
 * @param {number} seed
 * @returns {{file: string, [k: string]: unknown}|null}
 */
export function pickPoolEmote (pool, seed = 0) {
  if (!Array.isArray(pool) || pool.length === 0) return null
  const start = Math.abs(Math.trunc(seed)) % pool.length
  for (let i = 0; i < pool.length; i += 1) {
    const rec = pool[(start + i) % pool.length]
    if (rec === null || rec === undefined) continue
    if (!EMOTE_EXCLUDE_FROM_RANDOM.includes(rec.file)) return rec
  }
  return pool[start] ?? null
}

/**
 * 把状态机的 key 归一到 `EMOTE_BY_KEY` 的键。
 *
 * `idle-emote-3` 这类带序号的 key 要归到 `idle`；未知 key 返回 null
 * （调用方回落全池，而不是"没表情"）。
 *
 * @param {string} key
 * @returns {string|null}
 */
export function normalizeEmoteKey (key) {
  if (typeof key !== 'string' || key === '') return null
  if (Object.prototype.hasOwnProperty.call(EMOTE_BY_KEY, key)) return key
  // `idle-emote-<seq>` → idle
  if (key.startsWith('idle-emote')) return 'idle'
  return null
}

/**
 * 取某个 key 对应的表情池。未知 key → 空数组（调用方回落）。
 *
 * @param {string} key
 * @returns {string[]}
 */
export function emotePool (key) {
  const norm = normalizeEmoteKey(key)
  if (norm === null) return []
  return EMOTE_BY_KEY[norm] ?? []
}

/**
 * 按状态挑一张表情。
 *
 * 规则：
 *   1. 该 key 有专属池 → 在池内轮换（`seed` 偏移），并**避开 avoid**；
 *   2. 没有专属池（未知 key）→ 返回 null，**由调用方回落到全池**；
 *      这里不自己回落到全池，是为了让"映射缺失"在测试里可见，而不是被悄悄掩盖。
 *
 * 返回的是**文件路径**（相对 `art/pet/`）；调用方再到清单里查 `hasText`/`opaque`
 * —— 本模块不复制清单数据，避免两处真相。
 *
 * @param {string} key
 * @param {number} seed
 * @param {string|null} [avoid] - 上一张用过、这次尽量不重复的文件
 * @returns {string|null}
 */
export function pickEmoteFile (key, seed = 0, avoid = null) {
  const pool = emotePool(key)
  if (pool.length === 0) return null
  const start = Math.abs(Math.trunc(seed)) % pool.length
  // 先按 seed 取；若正好撞上 avoid 且池里还有别的，就顺延一个。
  const first = pool[start]
  if (pool.length === 1) return first
  if (avoid !== null && first === avoid) return pool[(start + 1) % pool.length]
  return first
}

/**
 * 覆盖率自检：清单里每张气泡图是否都被某个状态的池子用到。
 *
 * 用途：新增素材后能立刻发现"这张图永远不会被按状态挑中"。
 * 注意"未被状态池引用"**不等于**没用 —— 全池回落与画廊仍会展示它，
 * 所以这只是一个诊断数字，不是错误。
 *
 * @param {string[]} allFiles - 清单里的全部气泡文件
 * @returns {{used: string[], unused: string[]}}
 */
export function emoteCoverage (allFiles) {
  const usedSet = new Set()
  for (const files of Object.values(EMOTE_BY_KEY)) {
    for (const f of files) usedSet.add(f)
  }
  const used = []
  const unused = []
  for (const f of allFiles ?? []) {
    if (usedSet.has(f)) used.push(f)
    else unused.push(f)
  }
  return { used, unused }
}
