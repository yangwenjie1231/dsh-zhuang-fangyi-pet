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
export const INTERACT_KINDS = ['pet-head', 'feed', 'praise', 'click', 'pat', 'fling', 'hover']

/**
 * 各动作的默认参数。
 *
 * `gain` = 首次收益；`cooldownMs` = 冷却；`diminish` = 连续重复时的收益序列
 * （第 n 次取第 n 个，用完取最后一个 —— 最后一个是 0 表示"再点也不涨"）。
 *
 * v10 新增两个可选字段：
 *   · `sharesWith` = **与另一个动作共用冷却与递减记账**（防开新的加分水龙头）；
 *   · `reactGapMs` = 纯反应类动作（收益恒为 0）的最小反应间隔。
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
  },

  // ── v10：手势动作（用户："通过右键就点个按钮，很奇怪"）─────────────────

  pat: {
    /**
     * 长按摸头。**复用 `pet-head` 的冷却与递减**（`sharesWith`）。
     *
     * 为什么必须共用而不是自己一套：`pat` 是"按住不放"触发的，一次按下最多
     * 报 3 级。给它独立的递减序列等于开了一个**新的加分水龙头** —— 而好感度
     * 的设计不变式是"单日潜在收益要能跨过第二档、又不能靠一个动作刷满"。
     * 两个动作各算各的，那个不变式就废了。
     *
     * 共用之后：按住摸 3 下 ≡ 在菜单里点三次摸摸头（第 3 次起收益掉到 1）。
     */
    gain: 2,
    cooldownMs: 20 * 1000,
    diminish: [2, 2, 1, 1, 1],
    sharesWith: 'pet-head',
    label: '摸摸头',
    voice: 'pet/pat',
    /** 按级数换文案（1=刚碰到、2=蹭、3=彻底放松）。 */
    textByLevel: {
      1: { zh: '嗯…？', en: 'Mm…?' },
      2: { zh: '……再摸一会儿。', en: '…a little longer.' },
      3: { zh: '好啦好啦，我快睡着了。', en: "Okay, okay — I'm falling asleep." }
    },
    text: { zh: '嗯…这样也挺好的。', en: 'Mm… this is nice.' }
  },
  fling: {
    /**
     * 抛掷。**收益恒为 0** —— 把她甩出去不是亲昵。
     *
     * 但它仍然是一条**有反应的**互动（气泡 + 语音 + 表情）：用户主动做的动作
     * 必须有回应，否则就是"甩了没反应"（已有纪律：冷却期不许挡住反应）。
     *
     * `reactGapMs`：连续甩时最多每 3 秒给一次**新**反应，其余请求返回
     * "安静的确认"（`text`/`voice` 为 null，但 `accepted` 仍为 true）。
     */
    gain: 0,
    cooldownMs: 0,
    diminish: [0],
    reactGapMs: 3000,
    label: '抛掷',
    voice: 'pet/fling',
    text: { zh: '哇——放我下来！', en: 'Whoa — put me down!' }
  },
  hover: {
    /**
     * 悬停。**收益恒为 0**，而且**默认不发**（`settings.hoverReact` 关着时
     * exe 根本不报）—— 这是唯一"她主动找你"的动作，默认开就是骚扰。
     *
     * `reactGapMs` 给到 20 秒：鼠标在桌宠上来回蹭不该一直冒气泡。间隔由
     * **宿主**判定（与所有其它判定同一条纪律），exe 只负责"这次悬停值不值得报"。
     */
    gain: 0,
    cooldownMs: 0,
    diminish: [0],
    reactGapMs: 20000,
    label: '看一眼',
    voice: 'pet/hover',
    text: { zh: '……嗯？', en: '…hm?' }
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
  /**
   * 纯反应类动作（`fling` / `hover`）上次**真的给了反应**的时刻（v10）。
   *
   * 为什么不复用 `lastAt`：那张表只在"真的涨了分"时才更新（那是刻意的，
   * 否则冷却期内的点击会把时间一直往后推）。而 `fling`/`hover` 收益恒为 0，
   * 永远进不了那张表 —— 复用等于没有限速。
   */
  const reactAt = new Map()
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
    interact (kind, at = now(), opts = {}) {
      const cfg = interactConfig(kind)
      if (cfg === null) {
        return { accepted: false, reason: 'unknown-kind', kind, points, tier: tierOf(points) }
      }
      rollDayIfNeeded(at)

      /**
       * 记账键：`pat` 与 `pet-head` 共用一套冷却与递减（见 `sharesWith`）。
       *
       * ⚠️ 共用的是**记账**，不是**文案** —— 两边的 `text`/`voice` 各归各的。
       * 把文案也一起共用的话，按住摸头会说出"在菜单里点摸摸头"那句，
       * 手势与菜单就分辨不出来了。
       */
      const key = typeof cfg.sharesWith === 'string' && interactConfig(cfg.sharesWith) !== null
        ? cfg.sharesWith
        : kind

      const last = lastAt.get(key)
      const cooling = Number.isFinite(last) && at - last < cfg.cooldownMs
      const n = todayCount.get(key) ?? 0
      const capped = todayGain >= DAILY_CAP

      // 收益：取递减序列（用完后保持最后一个值）。
      const seq = Array.isArray(cfg.diminish) && cfg.diminish.length > 0 ? cfg.diminish : [cfg.gain]
      const rawGain = seq[Math.min(n, seq.length - 1)]

      /**
       * 情境倍率（v10）。**在这里乘、而不是在 Host 里事后扣**。
       *
       * 事后扣（"先按满额记账，再把差值减回去"）看起来更简单，但它让
       * `points` 与 `todayGain` 有两条写入路径 —— 少减一次就是"显示 37 分、
       * 今天却只涨了 20"，而那种分叉没有任何断言能自动发现。
       * 在这里乘则只有一个数字，记账天然一致。
       *
       * 倍率被夹进 [0,1]：情境只能打折，不能加成（见 `mood.js` 约束 1）。
       */
      const mul = Number.isFinite(opts.gainMul) ? Math.min(1, Math.max(0, opts.gainMul)) : 1
      const scaled = rawGain * mul

      // 冷却中 / 触顶 → 不涨（但仍有反应）。
      const gain = (cooling || capped) ? 0 : Math.max(0, Math.round(scaled))

      const before = tierOf(points)
      if (gain > 0) {
        points += gain
        todayGain += gain
        // 只有**真的涨了**才更新冷却与计数：
        // 否则冷却期内的点击会把 lastAt 一直往后推，等于永远进不了冷却。
        lastAt.set(key, at)
        todayCount.set(key, n + 1)
      }
      const after = tierOf(points)

      // ── 纯反应类动作的反应间隔（v10）────────────────────────────────────
      //
      // `fling` / `hover` 收益恒为 0，所以它们**永远走不到**上面那段"真的涨了
      // 才更新 lastAt"的逻辑 —— 也就是没有任何东西在限速。按住不放会连报、
      // 鼠标蹭来蹭去会连报，于是气泡刷屏。
      //
      // 所以这里给它们一条**独立的**反应闸：距离上次反应不足 `reactGapMs`
      // 就返回"安静的确认"（`accepted` 仍为 true、`quiet: true`、text/voice
      // 为 null）—— 调用方据此不发气泡、不播语音，但**不报错**。
      // 为什么不直接拒绝：拒绝会让 exe 侧记一条"互动失败"日志，而它其实
      // 什么都没做错（用户确实甩了她，只是我们决定这次不出声）。
      const reactGapMs = Number.isFinite(cfg.reactGapMs) ? cfg.reactGapMs : 0
      let quiet = false
      if (reactGapMs > 0) {
        const lastReact = reactAt.get(kind)
        quiet = Number.isFinite(lastReact) && at - lastReact < reactGapMs
        if (!quiet) reactAt.set(kind, at)
      }

      // 按级数换文案（`pat` 的 1/2/3 级）。级数由 exe 上报、这里夹到合法范围。
      //
      // ⚠️ 级数要**夹到表里实际存在的最大级**，不是原样去查。
      // 原样查的后果：`level=99` 查不到 → 保留 `cfg.text`（默认那句）——
      // 于是"摸到第 99 级"说出的是默认台词，与第 1 级**听起来一样**，
      // 而分级文案看起来"生效了"（有文案），只是永远停在最普通的那句。
      // `mood.js` 的 `moodFor` 有一模一样的夹取 —— 两处必须同口径。
      let text = cfg.text ?? null
      if (cfg.textByLevel !== null && typeof cfg.textByLevel === 'object') {
        const levels = Object.keys(cfg.textByLevel)
          .map(k => Math.trunc(Number(k)))
          .filter(Number.isFinite)
        const maxLevel = levels.length > 0 ? Math.max(...levels) : 1
        const want = Math.max(1, Math.trunc(Number(opts.level)) || 1)
        const lv = Math.min(want, maxLevel)
        const byLevel = Object.prototype.hasOwnProperty.call(cfg.textByLevel, String(lv))
          ? cfg.textByLevel[String(lv)]
          : null
        if (byLevel !== null) text = byLevel
      }

      return {
        accepted: true,
        kind,
        /** 记账用的动作（`pat` 报 `pet-head` —— 诊断与测试靠它看共用是否生效）。 */
        accountKind: key,
        gain,
        /** 情境倍率（1 = 没打折）。诊断用。 */
        gainMul: mul,
        points,
        /** 档位是否**刚刚**升级（调用方据此给一个更强的反馈）。 */
        tierChanged: after.key !== before.key,
        tier: after,
        /** 冷却中（调用方可以据此让文案更短）。 */
        cooling,
        /** 今日已触顶。 */
        dailyCapped: capped,
        /** 本次是"安静的确认"：不发气泡、不播语音（但动作本身是成立的）。 */
        quiet,
        /** 该动作的文案（null = 不弹气泡，如 click；quiet 时也为 null）。 */
        text: quiet ? null : text,
        /** 该动作的语音事件名（quiet 时为 null）。 */
        voice: quiet ? null : (cfg.voice ?? null),
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
      reactAt.clear()
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

/**
 * 某动作的**记账键**（v10）。
 *
 * `pat` 与 `pet-head` 共用一套冷却/递减 —— 判定逻辑与持久化都要用同一个键，
 * 两处各算一次的话，重启后 `pat` 的计数会记到一个不存在的桶里。
 * 未知动作返回动作名本身（不返回 null —— 调用方不该为了取键先判空）。
 */
export function interactAccountKind (kind) {
  const cfg = interactConfig(kind)
  if (cfg === null) return String(kind ?? '')
  return typeof cfg.sharesWith === 'string' && interactConfig(cfg.sharesWith) !== null
    ? cfg.sharesWith
    : kind
}

/** 跨天判断（导出供测试与 Host 用）。 */
export function dayKeyFor (at) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return 'unknown'
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export { DAY_MS }
