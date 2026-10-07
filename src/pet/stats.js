/**
 * 庄方宜桌宠 · 番茄钟统计（**纯函数 + 显式时间源**，无 IO、无定时器）
 *
 * ── 用户要的是什么 ────────────────────────────────────────────────────────
 *
 * "当前的番茄钟太简单了"。它现在只有"倒计时 + 阶段切换" —— 跑完之后
 * 什么都没留下：今天专注了几轮、花了多久、哪一轮被打断过、连着几天在坚持，
 * 全都查不到。这个模块负责把这些**记下来**。
 *
 * ── 为什么单独一个模块（而不是塞进 pomodoro.js）──────────────────────────
 *
 * 两个理由，第二个更重要：
 *
 * 1. **职责不同**。`pomodoro.js` 是"现在还剩多少秒"，本模块是"过去发生过
 *    什么"。前者每秒被调用一次，后者只在阶段结束时写一次。
 * 2. **`pomodoro.js` 的 `persist/adopt` 已经很微妙**。它的 `remainingMs <= 0`
 *    在四处被当作"阶段已结束"（`enter()` 的去重守卫、`start()` 的重置分支、
 *    `adopt()` 的回落），往那份持久化结构里加字段要同时照顾这四处 ——
 *    而统计与它们**毫无关系**。混进去只会让"跨重启恢复"这件本来就难的事
 *    更难验证。
 *
 * 所以：**统计自己一份文件**（`stats.json`），番茄钟的持久化一个字不改。
 *
 * ── 三条设计约束（每条都是这类"记账"功能的典型缺陷）──────────────────────
 *
 * 1. **跨天用本地日期**（与 `interactions.js` 的 `dayKeyFor` 同一口径）。
 *    用 UTC 的话，东八区用户在早上 8 点之前看到的"今天"其实是昨天。
 * 2. **今天还没番茄不算断签**。连续天数从**昨天**往回数 —— 否则每天早上
 *    打开 DSH 都会看到"连续 0 天"，而用户明明昨天刚坚持过。这条是本模块
 *    最容易写错、也最影响体感的一处（写错了表现是"打卡永远归零"）。
 * 3. **里程碑只发一次**。达成时刻记进 `milestones`，之后永不重发 ——
 *    否则每次阶段结束都会再弹一遍"你完成了第一个番茄"。
 *
 * @module src/pet/stats.js
 */

import { dayKeyFor } from './interactions.js'

/** 保留多少天。30 天足够看趋势，又不会让文件无限长。 */
export const KEEP_DAYS = 30

/** 单个任务名的最大长度（与设置页输入框的限制一致）。 */
export const TASK_MAX_CHARS = 24

/** 最多记多少个不同任务（超出丢最旧的）。防"每次专注都起个新名字"把文件撑爆。 */
export const TASK_MAX_ENTRIES = 12

/**
 * 里程碑定义。**key 是契约**（`milestones` 里存的就是它），label 给界面用。
 *
 * `check(snapshot)` 返回 true 表示"此刻达成"。判定用**累计值**而不是
 * "本次增量" —— 增量式判定在"一次跳两级"时会漏掉中间那个里程碑
 *（比如从第 9 个番茄直接到第 11 个）。
 */
export const MILESTONES = [
  { key: 'pomodoro-1', label: { zh: '第一个番茄', en: 'First pomodoro' }, kind: 'count', at: 1 },
  { key: 'pomodoro-10', label: { zh: '第十个番茄', en: 'Ten pomodoros' }, kind: 'count', at: 10 },
  { key: 'pomodoro-50', label: { zh: '第五十个番茄', en: 'Fifty pomodoros' }, kind: 'count', at: 50 },
  { key: 'pomodoro-100', label: { zh: '第一百个番茄', en: 'A hundred pomodoros' }, kind: 'count', at: 100 },
  { key: 'focus-10h', label: { zh: '累计专注十小时', en: 'Ten hours focused' }, kind: 'focusMs', at: 10 * 60 * 60 * 1000 },
  { key: 'focus-50h', label: { zh: '累计专注五十小时', en: 'Fifty hours focused' }, kind: 'focusMs', at: 50 * 60 * 60 * 1000 },
  { key: 'streak-3', label: { zh: '连续三天', en: 'Three days in a row' }, kind: 'streak', at: 3 },
  { key: 'streak-7', label: { zh: '连续七天', en: 'A full week' }, kind: 'streak', at: 7 },
  { key: 'streak-30', label: { zh: '连续三十天', en: 'Thirty days in a row' }, kind: 'streak', at: 30 },
  { key: 'clean-5', label: { zh: '五轮零打断', en: 'Five clean rounds' }, kind: 'cleanStreak', at: 5 }
]

/** 空的一天。**每次都要新造**（共用同一个对象会被就地改写）。 */
function emptyDay () {
  return { count: 0, focusMs: 0, interrupts: 0, byTask: {} }
}

/**
 * 把任务名归一化：去空白、截断、**丢掉空名字**。
 *
 * 返回 `''` 表示"没有任务" —— 调用方据此把它记进 `''` 这个桶（未命名）。
 * 不返回 null：那会让每个调用点都要判空，而漏判一次就是 `byTask[null]`。
 */
export function normalizeTask (raw) {
  if (typeof raw !== 'string') return ''
  const t = raw.trim().replace(/\s+/g, ' ')
  if (t === '') return ''
  return t.length > TASK_MAX_CHARS ? t.slice(0, TASK_MAX_CHARS) : t
}

/**
 * 创建一个统计器。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - 时间源（测试注入假时钟）
 * @param {object} [options.saved] - `persist()` 的产物
 * @returns {object}
 */
export function createStats (options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  /** `{ "YYYY-MM-DD": {count, focusMs, interrupts, byTask} }` */
  const days = new Map()
  /** 已达成里程碑 → 达成时刻。 */
  const milestones = new Map()
  /** 本阶段（当前这一轮专注）的摸鱼数。**不持久化** —— 它只在内存里活一个阶段。 */
  let phaseInterrupts = 0
  /** 当前任务名（由 `setTask` 设置，`record` 时落账）。 */
  let currentTask = ''
  /** 连续无打断的轮数（`clean-5` 里程碑用）。 */
  let cleanStreak = 0

  function dayOf (at) {
    return dayKeyFor(at)
  }

  /** 取（必要时新建）某一天的记录。 */
  function bucket (key) {
    let d = days.get(key)
    if (d === undefined) {
      d = emptyDay()
      days.set(key, d)
    }
    return d
  }

  /**
   * 裁剪：只留最近 `KEEP_DAYS` 天。
   *
   * ⚠️ 按**日期字符串**排序而不是插入顺序：跨天之后"昨天"的键可能比"今天"
   * 更晚被创建（比如用户在 23:59 开始、00:01 结束），插入顺序不等于时间顺序。
   * 字符串排序对 `YYYY-MM-DD` 是正确的（定长、零填充）。
   */
  function prune () {
    if (days.size <= KEEP_DAYS) return
    const keys = [...days.keys()].sort()
    const drop = keys.length - KEEP_DAYS
    for (let i = 0; i < drop; i++) days.delete(keys[i])
  }

  /** 累计值（里程碑判定用）。 */
  function totals () {
    let count = 0
    let focusMs = 0
    for (const d of days.values()) {
      count += d.count
      focusMs += d.focusMs
    }
    return { count, focusMs }
  }

  /**
   * 连续天数。**从昨天往回数**（见文件头约束 2）。
   *
   * 语义：今天有番茄 → 今天算进去；今天还没有 → 从昨天开始数
   *（不能因为"今天还没开始"就把昨天以来的连续记录清零）。
   *
   * 用一个**不依赖系统时区**的办法走日期：拿 `dayKeyFor` 逐日回推，
   * 每次减去 24 小时。夏令时会让某一天只有 23 小时，但我们是按**本地
   * 日期字符串**比的 —— 减 24 小时可能落在同一天或跳过一天，所以这里
   * 用"最多回推 KEEP_DAYS 次"的循环而不是"精确减 N 天"，并且在
   * 日期重复时跳过（不把同一天数两次）。
   */
  function streakDays (at) {
    const dayMs = 24 * 60 * 60 * 1000
    const today = dayOf(at)
    let cursor = at
    // 今天没番茄 → 从昨天开始（否则每天早上都显示断签）
    if ((days.get(today)?.count ?? 0) === 0) cursor = at - dayMs
    let n = 0
    let guard = 0
    let lastKey = null
    while (guard++ < KEEP_DAYS + 2) {
      const key = dayOf(cursor)
      if (key === lastKey) { cursor -= dayMs; continue }   // 夏令时重复日
      lastKey = key
      const d = days.get(key)
      if (d === undefined || d.count === 0) break
      n++
      cursor -= dayMs
    }
    return n
  }

  return {
    /**
     * 记一次**专注阶段完成**。
     *
     * @param {object} info
     * @param {number} info.focusMs - 本阶段实际专注的毫秒数
     * @param {number} [info.interrupts] - 本阶段被打断次数（默认取 `phaseInterrupts()`）
     * @param {string} [info.task] - 任务名（默认取 `setTask` 设的那个）
     * @param {number} [at]
     * @returns {{milestones: object[]}} 本次**新达成**的里程碑（可能为空）
     */
    record (info = {}, at = now()) {
      const focusMs = Math.max(0, Math.round(Number(info.focusMs) || 0))
      /**
       * ⚠️ 这里的打断次数**只用于 `cleanStreak` 判定，不再计入今日总数**。
       *
       * 这是被测试抓出来的真实缺陷：`interrupt()` 是"用户此刻碰了她"的**实时**
       * 事件，它已经写了今日总数；`record()` 再写一次就是**双重计数** ——
       * 一轮里摸 3 次会显示成"今天摸了 6 次"。而且它不会报错，只会让那个
       * 数字悄悄偏大一倍。
       *
       * 现在一个数字只有一个写入者：今日总数归 `interrupt()`，
       * `record()` 只读它（默认值就是当前阶段的计数）。
       */
      const interrupts = Math.max(0, Math.trunc(
        info.interrupts !== undefined ? Number(info.interrupts) || 0 : phaseInterrupts
      ))
      const task = normalizeTask(info.task !== undefined ? info.task : currentTask)

      const d = bucket(dayOf(at))
      d.count += 1
      d.focusMs += focusMs
      d.byTask[task] = (d.byTask[task] ?? 0) + focusMs
      // 任务桶也要限数：超出丢**本次以外的**最小那个（保住刚记的）
      const taskKeys = Object.keys(d.byTask)
      if (taskKeys.length > TASK_MAX_ENTRIES) {
        const sorted = taskKeys.filter(k => k !== task).sort((a, b) => d.byTask[a] - d.byTask[b])
        const dropCount = taskKeys.length - TASK_MAX_ENTRIES
        for (let i = 0; i < dropCount && i < sorted.length; i++) delete d.byTask[sorted[i]]
      }

      if (interrupts === 0) cleanStreak += 1
      else cleanStreak = 0

      phaseInterrupts = 0
      prune()

      // 里程碑：用**累计值**判定（见 MILESTONES 的注释）。
      const t = totals()
      const streak = streakDays(at)
      const fresh = []
      for (const m of MILESTONES) {
        if (milestones.has(m.key)) continue
        let hit = false
        if (m.kind === 'count') hit = t.count >= m.at
        else if (m.kind === 'focusMs') hit = t.focusMs >= m.at
        else if (m.kind === 'streak') hit = streak >= m.at
        else if (m.kind === 'cleanStreak') hit = cleanStreak >= m.at
        if (hit) {
          milestones.set(m.key, at)
          fresh.push({ key: m.key, label: m.label, at })
        }
      }
      return { milestones: fresh }
    },

    /**
     * 记一次"专注期间被打断"（摸鱼）。
     *
     * @returns {number} 本阶段累计的打断次数
     */
    interrupt () {
      phaseInterrupts += 1
      // 打断也落当天账（今日摸鱼总数），但**不影响** `cleanStreak` ——
      // 那要等阶段结束结算时才知道这一轮是不是干净的。
      const d = bucket(dayOf(now()))
      d.interrupts += 1
      return phaseInterrupts
    },

    /** 本阶段累计打断次数（只读）。 */
    phaseInterrupts () {
      return phaseInterrupts
    },

    /** 设置当前任务名（开始专注时调）。返回归一化后的值。 */
    setTask (raw) {
      currentTask = normalizeTask(raw)
      return currentTask
    },

    /** 当前任务名。 */
    task () {
      return currentTask
    },

    /**
     * 今日快照（设置页「今天」页签 + 快照的 `today` 块）。
     *
     * `byTask` 按耗时降序 —— 界面直接渲染，不必再排一次
     *（两处各排一次的话，排序口径会分叉）。
     */
    snapshot (at = now(), opts = {}) {
      const key = dayOf(at)
      const d = days.get(key) ?? emptyDay()
      const byTask = Object.keys(d.byTask)
        .map(task => ({ task, ms: d.byTask[task] }))
        .sort((a, b) => b.ms - a.ms)
      return {
        dayKey: key,
        pomodoroCount: d.count,
        focusMs: d.focusMs,
        interrupts: d.interrupts,
        phaseInterrupts,
        streakDays: streakDays(at),
        goalCount: Math.max(0, Math.trunc(Number(opts.goalCount) || 0)),
        byTask,
        /**
         * 最近 7 天（含今天），按日期升序 —— 界面画趋势用。
         *
         * ⚠️ 必须把**查表函数**传进去。不传的话 `recentDays` 拿不到任何数据，
         * 返回的全是 0 —— 而"全 0 的趋势图"看起来只是"最近没怎么专注"，
         * 不会报错，也不会有人怀疑（我第一版就是这么写的）。
         */
        recent: recentDays(at, 7, key => days.get(key))
      }
    },

    /** 已达成的里程碑（key → 时刻）。 */
    milestones () {
      const out = {}
      for (const [k, v] of milestones) out[k] = v
      return out
    },

    /** 持久化用。 */
    persist (at = now()) {
      const out = {}
      for (const [k, v] of days) {
        out[k] = {
          count: v.count,
          focusMs: v.focusMs,
          interrupts: v.interrupts,
          byTask: { ...v.byTask }
        }
      }
      const ms = {}
      for (const [k, v] of milestones) ms[k] = v
      return {
        days: out,
        milestones: ms,
        currentTask,
        cleanStreak,
        savedAt: at
      }
    },

    /**
     * 从持久化数据恢复。**坏数据逐字段回落**，不整体丢弃。
     *
     * @returns {boolean} 是否恢复成功
     */
    adopt (saved) {
      if (saved === null || typeof saved !== 'object') return false
      days.clear()
      milestones.clear()
      const src = (saved.days !== null && typeof saved.days === 'object') ? saved.days : {}
      for (const [key, raw] of Object.entries(src)) {
        // 只认 `YYYY-MM-DD`（挡住手改文件塞进来的怪键）
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
        if (raw === null || typeof raw !== 'object') continue
        const d = emptyDay()
        if (Number.isFinite(Number(raw.count))) d.count = Math.max(0, Math.trunc(Number(raw.count)))
        if (Number.isFinite(Number(raw.focusMs))) d.focusMs = Math.max(0, Math.round(Number(raw.focusMs)))
        if (Number.isFinite(Number(raw.interrupts))) d.interrupts = Math.max(0, Math.trunc(Number(raw.interrupts)))
        if (raw.byTask !== null && typeof raw.byTask === 'object') {
          for (const [t, ms] of Object.entries(raw.byTask)) {
            const name = normalizeTask(t)
            if (name === '' && t !== '') continue
            if (Number.isFinite(Number(ms))) d.byTask[name] = Math.max(0, Math.round(Number(ms)))
          }
        }
        days.set(key, d)
      }
      const ms = (saved.milestones !== null && typeof saved.milestones === 'object') ? saved.milestones : {}
      for (const [k, v] of Object.entries(ms)) {
        // 只认表里定义过的 key（手改文件塞进来的键会让"新里程碑"永不触发）
        if (MILESTONES.some(m => m.key === k) && Number.isFinite(Number(v))) {
          milestones.set(k, Number(v))
        }
      }
      currentTask = normalizeTask(saved.currentTask)
      if (Number.isFinite(Number(saved.cleanStreak))) {
        cleanStreak = Math.max(0, Math.trunc(Number(saved.cleanStreak)))
      }
      prune()
      return true
    },

    /** 重置（诊断/测试用）。 */
    reset () {
      days.clear()
      milestones.clear()
      phaseInterrupts = 0
      currentTask = ''
      cleanStreak = 0
      return true
    },

    /** 供测试与诊断读取内部状态。 */
    internals: {
      get days () { return new Map(days) },
      get cleanStreak () { return cleanStreak }
    }
  }
}

/** 最近 `n` 天（含 `at` 那天），按日期升序。缺的天补 0（趋势图不该有断点）。 */
export function recentDays (at, n, lookup) {
  const dayMs = 24 * 60 * 60 * 1000
  const out = []
  const seen = new Set()
  for (let i = n - 1; i >= 0; i--) {
    const key = dayKeyFor(at - i * dayMs)
    if (seen.has(key)) continue
    seen.add(key)
    const d = lookup === undefined ? null : lookup(key)
    out.push({
      dayKey: key,
      count: d?.count ?? 0,
      focusMs: d?.focusMs ?? 0
    })
  }
  return out
}
