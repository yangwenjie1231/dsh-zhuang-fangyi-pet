/**
 * 庄方宜桌宠 · 会话短标识（用于"同名消歧"）
 *
 * ── 这个文件为什么存在（两次返工的产物）────────────────────────────────────
 *
 * 会话标题常常重复：真机上 385 个会话里，标题默认取自首条消息，
 * 用户反复发同一句话就得到一堆同名项。所以选择器需要给重名项补一个**唯一后缀**。
 *
 * **第一次错**：`id.slice(0, 8)`。真实 id 形如
 * `session-001d93a5-52f0-477e-b58b-b2d9a2862236` —— 全部以 `session-` 开头，
 * 切出来恒为 `"session-"`，于是"消歧后缀"每一项都相同，**等于没消歧**。
 *
 * **第二次错（更隐蔽）**：改成剥掉固定的 `session-` 前缀。能跑，但
 * `session-` 是 DSH 的**实现细节，没有任何契约保证**；上游一换 id 形式，
 * 剥不掉前缀 → 后缀又全一样 → 静默退回"没消歧"。
 * 这类"猜上游格式"的代码坏了**不报错**，最难查。
 *
 * ── 现在的规则：完全从数据推导，不假设任何字面格式 ────────────────────────
 *
 *   ① 去掉所有 id 的**公共前缀**（共享部分不携带区分信息）；
 *   ② 取固定长度（默认 6）—— 长度是**展示**选择，不是格式假设；
 *   ③ 若仍撞车（罕见，例如 id 只有末尾不同）就加长重试，直到两两不同；
 *   ④ 实在区分不开就退回完整 id（**宁长勿撞**）。
 *
 * 对 `session-001d93a5-…` / `session-007ce55a-…`：
 * 公共前缀 = `session-00`，取余下的 `1d93a5` / `7ce55a`。
 * 换成 `abc-1111` / `abc-2222` 同样成立 —— 全程没有格式假设。
 */

/** 期望长度（会被按需加长）。 */
const DEFAULT_LEN = 6
/** 加长重试的上限，避免病态输入下无限循环。 */
const MAX_LEN = 64
const GROW_STEP = 2

/**
 * 求一组字符串的公共前缀。
 * @param {string[]} list - 非空数组
 * @returns {string}
 */
function commonPrefix (list) {
  let common = list[0]
  for (const s of list) {
    let k = 0
    const max = Math.min(common.length, s.length)
    while (k < max && common[k] === s[k]) k++
    common = common.slice(0, k)
    if (common === '') break
  }
  // ⚠️ 必须**留最后一个字符**不当作前缀：
  // 单个 id（或全部相同时）公共前缀会吃掉整串，余下为空 → 短标识变空串 →
  // 界面上标题变成空白（调用方用 `?? id` 判断，而空串不是 nullish，挡不住）。
  if (common.length >= list[0].length) {
    common = common.slice(0, Math.max(0, common.length - 1))
  }
  return common
}

/**
 * 给一组 id 算**互不相同**的短标识。
 *
 * @param {Iterable<string>} ids
 * @param {number} [want] - 期望长度（会按需要加长）
 * @returns {Map<string, string>} id → 短标识
 */
export function shortIdsFor (ids, want = DEFAULT_LEN) {
  const out = new Map()
  const list = [...(ids ?? [])].filter(id => typeof id === 'string' && id !== '')
  if (list.length === 0) return out

  const common = commonPrefix(list)
  // 去重后再判断撞车：同一个 id 出现两次不算撞车（它本来就该映射到同一个短标识）
  const unique = [...new Set(list)]

  let len = Math.max(1, Math.trunc(want) || DEFAULT_LEN)
  while (true) {
    const seen = new Map()   // short → id
    let collide = false
    for (const id of unique) {
      const body = id.slice(common.length)
      const key = body.length > len ? body.slice(0, len) : body
      if (seen.has(key)) { collide = true; break }
      seen.set(key, id)
    }
    if (!collide) {
      for (const entry of seen) out.set(entry[1], entry[0])
      return out
    }
    if (len >= MAX_LEN) break
    len += GROW_STEP
  }

  // 兜底：区分不开就用完整 id（宁长勿撞 —— 撞了会让用户发错对话）
  for (const id of unique) out.set(id, id)
  return out
}
