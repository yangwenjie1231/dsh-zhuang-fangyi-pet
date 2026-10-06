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
 * 状态/事件 key → 该情境下**合适**的表情文件（相对 `art/pet/`）。
 *
 * key 的取值来自状态机的 `requestBubble` 调用点：
 *   · 9 个状态名（waking/idle/listening/thinking/working/waiting/happy/error/sleeping）
 *   · `notify-complete`（一回合干净结束的强提醒）
 *   · `tool/failed`（工具报错）
 *   · `inbox/inserted`（用户发来消息）
 *   · `idle-emote-*`（调皮档空闲主动卖萌）—— 前缀匹配到 `idle`
 */
export const EMOTE_BY_KEY = {
  // ── 完成 / 好消息：庆祝、夸人、比心 ──────────────────────────────────────
  happy: [
    'bubble/17-yay.png',                    // 好耶
    'bubble/09-finger-heart.png',           // 比心
    'bubble/15-cheer-up.png',               // 加油
    'bubble/23-you-are-the-best.png',       // 你最好了
    'bubble/new/13-so-good.png',            // 太中啦
    'bubble/new/14-so-strong.png',          // ！强强！
    'bubble/20-thumbs-up.png',                // 默大契（点赞）
    'bubble/new/04-definitely.png',         // 宜定可以（肯定的回应）
    'bubble/16-comfort.png',                // 开心点嘛（安慰）
    'bubble/14-kiss.png'                    // 么么哒（亲密）
  ],
  'notify-complete': [
    'bubble/17-yay.png',                    // 好耶
    'bubble/new/13-so-good.png',            // 太中啦
    'bubble/23-you-are-the-best.png',       // 你最好了
    'bubble/20-thumbs-up.png',              // 默大契（点赞）
    'bubble/new/09-got-it.png',             // 庄得到
    'bubble/new/05-wink.png',               // Wink
    'bubble/new/04-definitely.png'          // 宜定可以
  ],

  // ── 干活中：工作、摸鱼、脑过载 ───────────────────────────────────────────
  working: [
    'bubble/21-at-work.png',                // 工作中
    'bubble/new/19-slacking.png',           // 摸鱼ing
    'bubble/new/06-brain-overload.png',     // 庄脑过载
    'bubble/new/07-wants.png',              // 庄想要
    'bubble/25-reading.png'                 // 看书（无文字）
  ],

  // ── 思考中：懵、过载、无聊 ───────────────────────────────────────────────
  thinking: [
    'bubble/18-confused.png',               // 有点懵
    'bubble/starry-formula.gif',            // 星空公式（满屏公式的"看不懂"；动图）
    'bubble/new/06-brain-overload.png',
    'bubble/new/01-bored.png',              // 庄很无聊
    'bubble/25-reading.png'
  ],

  // ── 等你处理：想要、得到、无聊（不要用庆祝类，会误导）──────────────────
  waiting: [
    'bubble/new/07-wants.png',              // 庄想要
    'bubble/new/01-bored.png',
    'bubble/new/15-so-loud.png',            // 庄一直响（提醒感）
    'bubble/new/16-knock-knock.png'         // 庄门戳你（提醒感）
  ],

  // ── 出错：生气、不开心、讨厌、哭 ─────────────────────────────────────────
  error: [
    'bubble/22-annoyed.png',                // 好气人哦
    'bubble/angry-charge.gif',              // 生气蓄力→爆发（动图）
    'bubble/new/20-unhappy.png',            // 庄不开心
    'bubble/new/10-hate-you.png',           // 庄讨厌你
    'bubble/new/17-crying.png',             // 庄一直哭
    'bubble/new/18-disgusted.png'           // 庄感到恶心
  ],
  'tool/failed': [
    'bubble/22-annoyed.png',
    'bubble/angry-charge.gif',              // 一肚子火正好对上"工具炸了"
    'bubble/new/20-unhappy.png',
    'bubble/new/18-disgusted.png'
  ],

  // ── 用户发来消息：打招呼、爱心、想你 ─────────────────────────────────────
  'inbox/inserted': [
    'bubble/11-hi.png',                     // hi～
    'bubble/08-love-you.png',               // 爱你哦
    'bubble/09-finger-heart.png',
    'bubble/new/08-miss-you.png',           // 庄想你了
    'bubble/13-wink.png',                   // 眨眼
    'bubble/10-blep.png'                    // 略略略（熟人打趣）
  ],
  listening: [
    'bubble/11-hi.png',
    'bubble/13-wink.png',                   // 眨眼
    'bubble/10-blep.png',                   // 略略略（熟人打趣）
    'bubble/new/16-knock-knock.png',
    'bubble/19-thanks.png'                  // 谢谢哦（回应类）
  ],

  // ── 空闲 / 睡觉：摸鱼、无聊、睡 ──────────────────────────────────────────
  idle: [
    'bubble/new/19-slacking.png',           // 摸鱼ing
    'bubble/new/01-bored.png',
    'bubble/gif-24.png',                    // 睡觉zzz（无文字）
    'bubble/new/11-sneak-snack.png',        // 庄偷吃外卖
    'bubble/25-reading.png',
    'bubble/gif-26.png',                    // 趴面
    'bubble/gif-28.png',                    // 挂件吊坠
    'bubble/gif-29.png'                     // 抱小宠
  ],
  sleeping: [
    'bubble/gif-24.png',                    // 睡觉zzz
    'bubble/new/03-dazed.png'               // 哦呀斯密
  ],

  // ── 刚醒：起床、早上好 ───────────────────────────────────────────────────
  waking: [
    'bubble/new/12-wake-up.png',            // 起床！别过少爷生活
    'bubble/new/02-good-morning.png',       // 早上好
    'bubble/12-good-night.png'              // 晚安啦（时差党用得上）
  ]
}

/** 全池回落时排除掉这些 —— 它们语义太强，随机撒容易莫名其妙。 */
export const EMOTE_EXCLUDE_FROM_RANDOM = [
  'bubble/16-comfort.png',                  // 开心点嘛：安慰语，随机撒会显得没头没脑
  'bubble/14-kiss.png',                     // 么么哒：太亲密，只在明确情境用
  'bubble/19-thanks.png',                   // 谢谢哦：需要上下文
  'bubble/12-good-night.png'                // 晚安啦：时点性强
]

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
