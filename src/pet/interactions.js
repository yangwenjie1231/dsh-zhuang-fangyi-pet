/**
 * 庄方宜桌宠 · 互动与好感度（**纯函数 + 显式时间源**，无 IO）
 *
 * ── 用户要的是什么 ────────────────────────────────────────────────────────
 *
 * "增加一些互动"。落地成四件事（用户点名的四项）：
 *   · **单击反应**：点她一下，她应一声（气泡 + 表情 + 语音）
 *   · **好感度**：互动会累积，分档位，档位变了她的反应不一样
 *   · **右键菜单**：摸摸头 / 投喂 / 夸奖
 *   · **语音**：每次互动配一条（见 `art/voice/` 的 `pet/*` 事件）
 *
 * ── 为什么好感度要"分档"而不是一个数字 ────────────────────────────────────
 *
 * 一个裸数字没有意义（"好感度 137" 是什么感觉？）。真正有用的是**档位**：
 * 它决定了她的反应、以及哪些互动解锁了。所以本模块对外主要给 `tier`，
 * `points` 只是内部记账。
 *
 * ── 三条设计约束（每条都是防"刷好感"这种破坏体验的玩法）──────────────────
 *
 * 1. **冷却**：同一个动作在冷却期内不涨好感（但**仍然有反应** ——
 *    不给她反应等于"点了没反应"，那更像坏了）。
 * 2. **边际递减**：连续重复同一个动作，收益递减到 0（第 1 次 +3、第 2 次 +1、
 *    第 3 次起 +0）。否则按住点一晚上就能满级，那这个数值就没有任何意义。
 * 3. **每天上限**：跨天重置计数。防"挂机刷"。
 *
 * 时间只从注入的 `now()` 来（与 `pomodoro.js` 同一纪律），否则冷却与
 * 跨天重置都没法用假时钟验。
 *
 * @module src/pet/interactions.js
 */

/** 互动动作。**这个值域是契约**：exe 的右键菜单、路由白名单、语音事件都用它。 */
export const INTERACT_KINDS = ['pet-head', 'feed', 'praise', 'click']

/**
 * 各动作的默认参数。
 *
 * `gain` = 首次收益；`cooldownMs` = 冷却；`diminish` = 连续重复时的收益序列
 * （第 n 次取第 n 个，用完取最后一个 —— 最后一个是 0 表示"再点也不涨"）。
 */
export const INTERACT_CONFIG = {
  'pet-head': {
    /** 摸摸头：最容易做，收益最低、冷却最短。 */
    gain: 2,
    cooldownMs: 20 * 1000,
    diminish: [2, 2, 1, 1, 1],
    /** 界面标签（Host 与 exe 共用，避免两处各写一份文案）。 */
    label: '摸摸头',
    /** 语音事件（`art/voice/voice.json` 里的 event）。 */
    voice: 'pet/pet-head',
    /** 互动后的气泡文案 key。 */
    text: { zh: '嗯…这样也挺好的。', en: 'Mm… this is nice.' }
  },
  feed: {
    /** 投喂：收益中等，冷却较长（不能一直喂）。 */
    gain: 5,
    cooldownMs: 60 * 1000,
    diminish: [5, 4, 3, 2, 2],
    label: '投喂',
    voice: 'pet/feed',
    text: { zh: '有些好东西，我们不算白来。', en: 'Good stuff — worth the trip.' }
  },
  praise: {
    /** 夸奖：收益最高，冷却最长。 */
    gain: 8,
    cooldownMs: 120 * 1000,
    diminish: [8, 6, 5, 4, 3],
    label: '夸奖',
    voice: 'pet/praise',
    text: { zh: '干净利落，真漂亮。', en: 'Clean and sharp — beautiful.' }
  },
  click: {
    /** 单击：纯打招呼，收益极低（它太容易触发了）。 */
    gain: 1,
    cooldownMs: 8 * 1000,
    diminish: [1, 1, 0],
    label: '打招呼',
    voice: 'pet/click',
    text: { zh: null, en: null }   // null = 不弹气泡（点击太频繁，弹气泡会刷屏）
  }
}

/**
 * 好感度档位。
 *
 * `min` 是进入该档所需的累计好感。**档位名与门槛都是契约** ——
 * exe 与 overlay 都要显示同一个名字，测试也断言它。
 */
export const AFFECTION_TIERS = [
  { key: 'stranger', min: 0, label: { zh: '初识', en: 'Newly met' } },
  { key: 'familiar', min: 20, label: { zh: '熟悉', en: 'Familiar' } },
  { key: 'close', min: 60, label: { zh: '亲近', en: 'Close' } },
  { key: 'trusted', min: 150, label: { zh: '信赖', en: 'Trusted' } }
]

/** 每日好感上限（防挂机刷）。 */
export const DAILY_CAP = 120

/**
 * ⚠️ **递减序列必须保证"每个动作每天仍有可观的总收益"** ——
 * 否则档位永远升不上去，整个好感度就是个装饰。
 *
 * 这个坑是测试逼出来的：第一版 `praise` 的递减是 `[8, 3, 1, 0]`，
 * 一天最多 12 分；而四档门槛是 0/20/60/150 —— 用户**永远到不了第二档**。
 * 断言"跨过 20 应报 tierChanged"因此永远失败。
 *
 * 现在的口径：每个动作每天的上限约 20~30 分（序列长、尾部不为 0），
 * 三四个动作合计能到 `DAILY_CAP`。这样：
 *   · 单次点击的**边际收益仍在递减**（防"按住点一晚上"）；
 *   · 但**长期互动有积累**（否则档位是死的）。
 *
 * 序列以**非零**结尾，由 `DAILY_CAP` 兜住总量 —— 两道闸各管一件事：
 * 递减管"单次不能无限赚"，日上限管"总量不能无限赚"。
 */

/** 各动作的默认参数。 */

/** 一天的毫秒数（跨天重置用）。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 取好感度档位。纯函数。
 *
 * @param {number} points
 * @returns {{key: string, label: object, min: number, next: object|null, progress: number}}
 *   `progress` = 距离下一档的进度（0~1；已满级为 1）
 */
export function tierOf (points) {
  const p = Number.isFinite(Number(points)) ? Math.max(0, Number(points)) : 0
  let current = AFFECTION_TIERS[0]
  let next = null
  for (let i = 0; i < AFFECTION_TIERS.length; i++) {
    if (p >= AFFECTION_TIERS[i].min) {
      current = AFFECTION_TIERS[i]
      next = AFFECTION_TIERS[i + 1] ?? null
    }
  }
  let progress = 1
  if (next !== null) {
    const span = next.min - current.min
    progress = span <= 0 ? 1 : Math.min(1, Math.max(0, (p - current.min) / span))
  }
  return { key: current.key, label: current.label, min: current.min, next, progress }
}

/**
 * 取某个动作的配置；未知动作返回 null（调用方据此拒绝）。
 *
 * ⚠️ **必须用 `hasOwnProperty` 判定，不能只靠 `?? null`**：
 * `INTERACT_CONFIG['__proto__']` 会返回 `Object.prototype`（原型链上的），
 * `['toString']` 返回函数 —— 于是"未知动作"被当成合法配置，一路传下去。
 * 这是真实的原型污染类缺陷，不是理论问题：探针实测
 * `interact('__proto__')` 返回了 `accepted: true`。
 */
export function interactConfig (kind) {
  if (typeof kind !== 'string') return null
  if (!Object.prototype.hasOwnProperty.call(INTERACT_CONFIG, kind)) return null
  return INTERACT_CONFIG[kind] ?? null
}

/**
 * 创建一个好感度状态机。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - 时间源（测试注入假时钟）
 * @param {object} [options.saved] - `persist()` 的产物（跨重启恢复）
 * @returns {object}
 */
export function createAffection (options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  let points = 0
  /** 各动作上次成功的时刻（冷却用）。 */
  const lastAt = new Map()
  /**
   * 各动作"今天的连续次数"（边际递减用）。
   *
   * 跨天重置 —— 否则昨天点满了、今天第一次就 +0，用户会觉得坏了。
   */
  const todayCount = new Map()
  /** 今天已获得的好感（每日上限用）。 */
  let todayGain = 0
  /** 记账所属的那一天（本地日期，`YYYY-MM-DD`）。 */
  let dayKey = dayKeyOf(now())

  /** 本地日期键。用本地日期而不是 UTC：用户感知的"今天"是本地的。 */
  function dayKeyOf (at) {
    const d = new Date(at)
    if (Number.isNaN(d.getTime())) return 'unknown'
    const pad = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  /** 跨天就把今天的记账清零。**每次交互前都要调**（进程可能跨天不重启）。 */
  function rollDayIfNeeded (at) {
    const key = dayKeyOf(at)
    if (key !== dayKey) {
      dayKey = key
      todayCount.clear()
      todayGain = 0
    }
  }

  /** 从持久化数据恢复。 */
  function adopt (saved) {
    if (saved === null || typeof saved !== 'object') return false
    if (Number.isFinite(Number(saved.points))) {
      points = Math.max(0, Math.trunc(Number(saved.points)))
    }
    if (saved.lastAt !== null && typeof saved.lastAt === 'object') {
      for (const [k, v] of Object.entries(saved.lastAt)) {
        if (INTERACT_KINDS.includes(k) && Number.isFinite(Number(v))) lastAt.set(k, Number(v))
      }
    }
    // 注意：**不恢复今天的计数** —— 它是"今天"的，跨重启后由 `dayKey`
    // 与 `saved.dayKey` 对比决定要不要接着算。同一天重启应接着算
    //（否则重启一次就能重置递减，等于给了刷分后门）。
    if (saved.dayKey === dayKeyOf(now()) && saved.todayCount !== null && typeof saved.todayCount === 'object') {
      for (const [k, v] of Object.entries(saved.todayCount)) {
        if (INTERACT_KINDS.includes(k) && Number.isFinite(Number(v))) {
          todayCount.set(k, Math.max(0, Math.trunc(Number(v))))
        }
      }
      if (Number.isFinite(Number(saved.todayGain))) {
        todayGain = Math.max(0, Math.trunc(Number(saved.todayGain)))
      }
    }
    return true
  }

  return {
    adopt,

    /**
     * 记一次互动。
     *
     * ⚠️ **永远返回一个"有反应"的结果**：即使冷却中、即使不涨好感，
     * `accepted` 也为 true 且给出 `text`/`voice`。理由是体验：
     * 点了没反应比"点了没涨分"更像坏了。
     * 只有**未知动作**才返回 `accepted: false`。
     *
     * @param {string} kind - `INTERACT_KINDS` 之一
     * @param {number} [at]
     * @returns {object} 见下方注释
     */
    interact (kind, at = now()) {
      const cfg = interactConfig(kind)
      if (cfg === null) {
        return { accepted: false, reason: 'unknown-kind', kind, points, tier: tierOf(points) }
      }
      rollDayIfNeeded(at)

      const last = lastAt.get(kind)
      const cooling = Number.isFinite(last) && at - last < cfg.cooldownMs
      const n = todayCount.get(kind) ?? 0
      const capped = todayGain >= DAILY_CAP

      // 收益：取递减序列（用完后保持最后一个值）。
      const seq = Array.isArray(cfg.diminish) && cfg.diminish.length > 0 ? cfg.diminish : [cfg.gain]
      const rawGain = seq[Math.min(n, seq.length - 1)]
      // 冷却中 / 触顶 → 不涨（但仍有反应）。
      const gain = (cooling || capped) ? 0 : Math.max(0, Math.trunc(rawGain))

      const before = tierOf(points)
      if (gain > 0) {
        points += gain
        todayGain += gain
        // 只有**真的涨了**才更新冷却与计数：
        // 否则冷却期内的点击会把 lastAt 一直往后推，等于永远进不了冷却。
        lastAt.set(kind, at)
        todayCount.set(kind, n + 1)
      }
      const after = tierOf(points)

      return {
        accepted: true,
        kind,
        gain,
        points,
        /** 档位是否**刚刚**升级（调用方据此给一个更强的反馈）。 */
        tierChanged: after.key !== before.key,
        tier: after,
        /** 冷却中（调用方可以据此让文案更短）。 */
        cooling,
        /** 今日已触顶。 */
        dailyCapped: capped,
        /** 该动作的文案（null = 不弹气泡，如 click）。 */
        text: cfg.text ?? null,
        /** 该动作的语音事件名。 */
        voice: cfg.voice ?? null,
        label: cfg.label ?? kind,
        at
      }
    },

    /** 当前好感度与档位（只读快照）。 */
    snapshot (at = now()) {
      rollDayIfNeeded(at)
      const t = tierOf(points)
      return {
        points,
        tier: t.key,
        tierLabel: t.label,
        /** 下一档门槛（已满级为 null）。 */
        nextMin: t.next === null ? null : t.next.min,
        /** 距下一档的进度 0~1。 */
        progress: t.progress,
        /** 今天还能涨多少（0 = 触顶）。 */
        remainingToday: Math.max(0, DAILY_CAP - todayGain)
      }
    },

    /** 持久化用。 */
    persist (at = now()) {
      rollDayIfNeeded(at)
      const la = {}
      for (const [k, v] of lastAt) la[k] = v
      const tc = {}
      for (const [k, v] of todayCount) tc[k] = v
      return { points, lastAt: la, todayCount: tc, todayGain, dayKey, savedAt: at }
    },

    /** 重置（诊断/测试用；界面不暴露 —— 好感度不该被一键清空）。 */
    reset () {
      points = 0
      lastAt.clear()
      todayCount.clear()
      todayGain = 0
      return true
    },

    /** 供测试与诊断读取内部记账。 */
    internals: {
      get points () { return points },
      get todayGain () { return todayGain },
      get dayKey () { return dayKey },
      get lastAt () { return new Map(lastAt) },
      get todayCount () { return new Map(todayCount) }
    }
  }
}

/**
 * 互动动作 → 界面标签（Host 与 exe 共用，避免两处各写一份）。
 * 未知动作返回动作名本身（不返回 undefined —— 界面不该出现空洞）。
 */
export function interactLabel (kind) {
  const cfg = interactConfig(kind)
  return cfg === null ? String(kind ?? '') : cfg.label
}

/** 本地化一条互动文案；无文案返回 null。 */
export function interactText (kind, locale = 'zh') {
  const cfg = interactConfig(kind)
  if (cfg === null || cfg.text === null) return null
  return cfg.text[locale] ?? cfg.text.zh ?? null
}

/** 跨天判断（导出供测试与 Host 用）。 */
export function dayKeyFor (at) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return 'unknown'
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export { DAY_MS }
