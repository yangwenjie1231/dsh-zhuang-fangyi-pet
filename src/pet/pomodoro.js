/**
 * 庄方宜桌宠 · 番茄钟（**纯函数 + 显式时间源**，无 IO、无定时器）
 *
 * ── 用户要的是什么 ────────────────────────────────────────────────────────
 *
 * "增加番茄钟提醒我休息" + "还要每 4 轮一次长休息（15 分）"。
 *
 * 所以是三段循环：专注 25 分 → 短休 5 分 →（每满 4 轮专注）长休 15 分。
 *
 * ── 为什么单独一个纯模块（而不是塞进 `state.js`）──────────────────────────
 *
 * 番茄钟与"AI 在干什么"是**两条完全独立的时间线**：AI 空闲时番茄钟照样在走，
 * 番茄钟休息时 AI 可能正在跑。把它们揉进一个状态机会让两边的判定互相污染
 * （`petState` 是"AI 状态"，不该被"你该休息了"改写）。
 *
 * 所以：`state.js` 只管 AI；本模块只管计时；两者在 Host 里各走各的，
 * 只在"阶段结束"这一个时刻交汇 —— Host 收到回调，让桌宠说一句话。
 *
 * ── 设计约束（每条都是踩过的坑）──────────────────────────────────────────
 *
 * 1. **时间只能从 `now()` 来**。绝不内联 `Date.now()`：测试要能用假时钟
 *    把 25 分钟在毫秒内跑完，否则"每 4 轮长休息"这种逻辑根本没法验。
 * 2. **暂停必须真的冻结剩余时间**。只记 `endsAt` 的话，暂停 10 分钟再恢复
 *    会瞬间跳掉 10 分钟 —— 用 `remainingMs` 才是真相，`endsAt` 只是它的投影。
 * 3. **阶段结束只能触发一次**。`tick()` 会被反复调用，而"剩余 <= 0"若保持为真
 *    就会把同一次结束通知十几遍。真正的守卫是 **`enter()` 把 `remainingMs`
 *    重置为整段时长** —— 阶段一结束就立刻离开"<= 0"这个条件。
 *    （曾经这里有一个 `firedFor` 标记，回退验证证明它**从未参与任何判定**：
 *    把它换成常量，43 条断言全绿。假守卫比没有守卫更危险 —— 它会让人以为
 *    删掉 `enter()` 里的重置也没事。所以它被删了，并留下这条断言兜底。）
 * 4. **暂停必须真的冻结**。守卫是 `advance()` 开头的 `if (!running) return null`
 *    —— 回退验证过：去掉它，"暂停 10 分钟不跳表"那条断言立刻失败。
 * 5. **跨重启要能恢复**，但**不能复活一个早就过期的阶段**：关了 DSH 三天
 *    再打开，不该立刻弹"休息结束"。超过本阶段剩余时长的空档按"作废本轮、
 *    从头开始、且不补通知"处理，见 `adopt()`。
 * 6. **通知顺序：先 end 后 start**。反了的话调用方先收到"开始休息"、
 *    再收到"专注结束"，无从判断该不该提醒。
 *
 * @module src/pet/pomodoro.js
 */

/** 阶段名。`focus` = 专注；`break` = 短休；`long-break` = 长休。 */
export const POMODORO_PHASES = ['focus', 'break', 'long-break']

/** 默认参数（用户点名的 25/5/15 + 每 4 轮）。 */
export const DEFAULT_POMODORO = {
  enabled: false,
  /** 专注时长（ms）。 */
  focusMs: 25 * 60 * 1000,
  /** 短休（ms）。 */
  breakMs: 5 * 60 * 1000,
  /** 长休（ms）。 */
  longBreakMs: 15 * 60 * 1000,
  /** 每几轮专注后来一次长休。 */
  roundsPerLongBreak: 4,
  /**
   * 一个阶段结束后**自动**进入下一个阶段。
   *
   * 关掉它 = 每个阶段结束后停在下一个阶段的开头等你手动开始
   *（"我不想被自动拖着走"）。
   */
  autoNext: true,
  /** 阶段结束/切换时让桌宠提醒（气泡 + 表情 + 语音）。 */
  notify: true
}

/** 各字段的合法范围（Host 归一化与测试共用）。 */
export const POMODORO_LIMITS = {
  focusMs: [60 * 1000, 4 * 60 * 60 * 1000],
  // 短休下限必须与 src/settings.js 的 POMODORO_BREAK_MIN 一致（曾经这里是 30s
  // 而设置那边是 60s，是真实的三方口径不一致：设置页拖不到、直接构造却可以）。
  breakMs: [60 * 1000, 60 * 60 * 1000],
  longBreakMs: [60 * 1000, 2 * 60 * 60 * 1000],
  roundsPerLongBreak: [2, 12]
}

/** 把任意输入归一化成合法参数（**逐字段回落，不整体丢弃**）。 */
export function normalizePomodoro (input) {
  const base = { ...DEFAULT_POMODORO }
  if (input === null || typeof input !== 'object') return base
  const out = { ...base }
  for (const key of ['enabled', 'autoNext', 'notify']) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }
  for (const [key, [min, max]] of Object.entries(POMODORO_LIMITS)) {
    const n = Number(input[key])
    if (!Number.isFinite(n)) continue
    out[key] = Math.min(max, Math.max(min, Math.round(n)))
  }
  return out
}

/** 某个阶段的时长（ms）。未知阶段按专注处理（前向兼容，绝不返回 NaN）。 */
export function phaseDuration (phase, cfg) {
  if (phase === 'break') return cfg.breakMs
  if (phase === 'long-break') return cfg.longBreakMs
  return cfg.focusMs
}

/**
 * 专注轮次 → 该轮之后的休息类型。
 *
 * 非有限/越界的 `roundsPerLongBreak` 一律回落默认值：`NaN` 参与取模会得到
 * `NaN`，而 `NaN === 0` 为 false —— 那会静默变成"永远短休"，长休再也不会出现。
 * 这类"参数坏掉导致某个分支永不触发"的缺陷在真机上极难发现，所以在这里挡住。
 *
 * @param {number} completed - 刚完成的专注轮数（1-based 语义）
 * @param {number} roundsPerLongBreak
 * @returns {'break'|'long-break'}
 */
export function breakAfter (completed, roundsPerLongBreak) {
  const raw = Math.trunc(Number(roundsPerLongBreak))
  const n = Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_POMODORO.roundsPerLongBreak
  const c = Math.max(1, Math.trunc(Number(completed)) || 1)
  return c % n === 0 ? 'long-break' : 'break'
}

/**
 * 人类可读的剩余时间（`24:59` / `1:05:00`）。
 *
 * 抽成导出函数是为了**两端（exe 与诊断文本）用同一套格式化**，
 * 免得 exe 显示 `24:59`、日志里却是 `25:00`，对不上时无法判断谁错。
 *
 * **向上取整**：剩 0.4 秒时显示 `00:01` 而不是 `00:00` —— 显示 `00:00`
 * 而阶段还没结束会让用户以为卡住了。
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatRemaining (ms) {
  const total = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = n => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/**
 * 创建一个番茄钟。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - 时间源（测试注入假时钟）
 * @param {object} [options.config] - 参数覆盖
 * @param {(event: object) => void} [options.onTransition] - 阶段结束/开始回调
 * @returns {object} 番茄钟实例
 */
export function createPomodoro (options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  let cfg = normalizePomodoro(options.config)
  const onTransition = typeof options.onTransition === 'function' ? options.onTransition : null

  let phase = 'focus'
  let running = false
  /**
   * 剩余时间（ms）。**这是唯一真相**；`endsAt` 由它投影出来。
   *
   * 为什么不是"只记 endsAt"：暂停时无法表达"冻结在还剩 12:34"。
   * 记剩余时间后，暂停 = 停止推进，恢复 = 用新 now 重算 endsAt。
   */
  let remainingMs = phaseDuration(phase, cfg)
  /** 本阶段开始的时刻（暂停期间不推进）。 */
  let startedAt = null
  /** 已完成的专注轮数（累计，跨重启保留）。 */
  let completed = 0
  /** 当前阶段的总时长（显示进度用；暂停/恢复期间不变）。 */
  let totalMs = phaseDuration(phase, cfg)
  /** 上次推进到的时刻（把"过了多少毫秒"算成差值）。 */
  let lastTickAt = now()

  /** 安全调用回调：回调坏了绝不能拖垮计时。 */
  function emit (event) {
    if (onTransition === null) return
    try { onTransition(event) } catch { /* 回调坏不拖垮计时 */ }
  }

  /** 用当前 `remainingMs` 与 `now` 重算 `endsAt`；不运行时返回 null。 */
  function endsAtOf () {
    return running ? now() + remainingMs : null
  }

  /**
   * 当前是"第几轮专注"（1-based）。
   * 专注中 = 正在进行的这一轮；休息中 = 刚完成的那一轮。
   */
  function currentRound () {
    const per = Math.max(1, cfg.roundsPerLongBreak)
    const inCycle = completed % per
    if (phase === 'focus') return inCycle + 1
    return inCycle === 0 ? per : inCycle
  }

  /**
   * 进入一个阶段（只切状态，不结算"结束"）。
   *
   * ⚠️ `remainingMs = totalMs` 这一行是**"阶段结束只通知一次"的真正守卫**：
   * 阶段一结束就立刻把剩余时间重置为整段，于是 `tick()` 里那个
   * "`remainingMs <= 0` → 结算"的条件不再成立。删掉它会让同一次结束
   * 被每个 tick 重复通知（回退验证：43 → 40 通过，3 条断言失败）。
   *
   * @param {string} nextPhase
   * @param {number} at
   * @param {object} [opts]
   * @param {boolean} [opts.announce] - 是否发 `start` 事件
   * @param {boolean} [opts.keepRunning] - 是否保持当前 running 位
   */
  function enter (nextPhase, at, opts = {}) {
    const announce = opts.announce !== false
    phase = POMODORO_PHASES.includes(nextPhase) ? nextPhase : 'focus'
    totalMs = phaseDuration(phase, cfg)
    remainingMs = totalMs          // ← 去重靠这一行，见上方注释
    startedAt = at
    if (opts.keepRunning !== true) running = false
    lastTickAt = at
    if (announce) emit({ kind: 'start', phase, completed, round: currentRound(), at })
  }

  /**
   * 阶段自然结束 → 结算并决定下一个阶段。
   *
   * @param {number} at
   * @returns {object|null} 触发的事件
   */
  function finishPhase (at) {
    const endedPhase = phase
    if (endedPhase === 'focus') completed += 1
    const next = endedPhase === 'focus'
      ? breakAfter(completed, cfg.roundsPerLongBreak)
      : 'focus'

    const event = {
      kind: 'end',
      phase: endedPhase,
      next,
      completed,
      round: currentRound(),
      at
    }
    // ⚠️ 顺序：**先 end 后 start**。反过来的话调用方先收到"开始休息"、
    // 再收到"专注结束"，就无从判断"这条提醒到底该不该发"。
    emit(event)

    if (cfg.autoNext) {
      enter(next, at, { keepRunning: true })
      running = true
    } else {
      // 不自动续：切到下一个阶段但**不开始计时**，停在整段时长等你按开始。
      enter(next, at, { announce: false })
      running = false
    }
    return event
  }

  /** 把时间推进到 `at`，必要时结算阶段结束。 */
  function advance (at) {
    if (!running) return null
    const delta = at - lastTickAt
    lastTickAt = at
    if (remainingMs > 0) remainingMs = Math.max(0, remainingMs - delta)
    if (remainingMs > 0) return null
    return finishPhase(at)
  }

  return {
    /**
     * 推进计时（Host 的 ticker 与测试的假时钟都走这里）。
     *
     * @param {number} [at]
     * @returns {object|null} 若本帧发生了阶段结束，返回该事件
     */
    tick (at = now()) {
      if (!Number.isFinite(at)) return null
      // 时钟回拨（用户改系统时间 / NTP 校正）不该让 remaining 变负或暴涨：
      // 只接受向前的时间。回拨时把基准拉回当前值，不做任何推进。
      if (at < lastTickAt) { lastTickAt = at; return null }
      return advance(at)
    },

    /**
     * 开始 / 继续。
     *
     * 三种情况都要对：
     *   · 已停且还有剩余（暂停过）→ 从剩余继续；
     *   · 已停且剩余为 0（上一阶段刚结束且没自动续）→ 从本阶段整段开始；
     *   · 正在跑 → 什么都不做（幂等）。
     */
    start (at = now()) {
      if (running) return false
      if (remainingMs <= 0) {
        remainingMs = phaseDuration(phase, cfg)
        totalMs = remainingMs
        startedAt = at
      } else if (startedAt === null) {
        startedAt = at
      }
      running = true
      lastTickAt = at
      return true
    },

    /** 暂停（冻结剩余时间）。 */
    pause () {
      if (!running) return false
      running = false
      return true
    },

    /** 暂停 ⇄ 继续。 */
    toggle (at = now()) {
      return running ? this.pause() : this.start(at)
    },

    /**
     * 跳过当前阶段，直接进下一个。
     *
     * **跳过的专注不计入轮数** —— 否则连点四下"跳过"就能刷出一次长休，
     * 那个"每 4 轮"就失去意义了。
     */
    skip (at = now()) {
      const endedPhase = phase
      const wasRunning = running
      // 判定下一个阶段时，把"本次专注"当作已完成来算休息类型，
      // 但**不写回 completed**（跳过不算完成）。
      const next = endedPhase === 'focus'
        ? breakAfter(completed + 1, cfg.roundsPerLongBreak)
        : 'focus'
      const event = {
        kind: 'skip',
        phase: endedPhase,
        next,
        completed,
        round: currentRound(),
        at
      }
      emit(event)
      // 跳过时保持原来的运行位：本来在跑就继续跑下一段，本来停着就还停着
      //（不偷偷开始计时，也不偷偷停下来）。
      enter(next, at, { keepRunning: true })
      running = wasRunning
      return event
    },

    /** 重置回第一轮专注（清空累计轮数），并停表。 */
    reset (at = now()) {
      completed = 0
      enter('focus', at, { announce: false })
      running = false
      remainingMs = phaseDuration('focus', cfg)
      totalMs = remainingMs
      return true
    },

    /**
     * 热更新参数（设置页改时长要立刻生效，不必重启）。
     *
     * 规则（两条边界都要对）：
     *   · **正在跑** → 只改"下一个阶段"的时长，**不动当前阶段的剩余时间**。
     *     否则用户拖一下滑块就把当前专注砍掉一半，那是数据丢失。
     *   · **停着且本阶段一点都没走过**（剩余 == 总时长，或上一阶段刚结束）
     *     → 直接对齐到新时长。这正是"我就想改成 30 分钟再开始"的场景，
     *     不对齐的话用户得先开始再重置，很别扭。
     *   · **停着但已经走过一部分**（暂停中）→ 保留剩余时间（那是他的进度），
     *     只把超过新时长的部分夹掉。
     */
    setConfig (patch) {
      const next = normalizePomodoro({ ...cfg, ...patch })
      const changed = JSON.stringify(next) !== JSON.stringify(cfg)
      // 先判定"本阶段是否一点都没走过"，**必须在 cfg 被替换前算**。
      const untouched = remainingMs >= totalMs || remainingMs <= 0
      cfg = next
      if (!running) {
        const full = phaseDuration(phase, cfg)
        if (untouched) {
          remainingMs = full
        } else if (remainingMs > full) {
          remainingMs = full
        }
        totalMs = full
      }
      return changed
    },

    get config () {
      return { ...cfg }
    },

    /**
     * 契约 §2 `pomodoro` 块（exe 与 overlay 共用）。
     *
     * `endsAt` 与 `remainingMs` **都给**：exe 用 `endsAt` 自己每秒倒计时
     *（不必让 Host 每秒推一帧），断线重连后 `remainingMs` 兜底。
     */
    snapshot (at = now()) {
      return {
        enabled: cfg.enabled,
        phase,
        running,
        /** 剩余毫秒（暂停时冻结值；未开始时为整段时长）。 */
        remainingMs: Math.max(0, Math.round(remainingMs)),
        /** 本阶段总时长（进度条/比例用）。 */
        totalMs: Math.round(totalMs),
        /** 阶段结束的绝对时刻（epoch ms）；未运行时为 null。 */
        endsAt: endsAtOf(),
        /** 已完成的专注轮数（累计）。 */
        completed,
        /** 当前是第几轮专注（1-based）。 */
        round: currentRound(),
        roundsPerLongBreak: cfg.roundsPerLongBreak,
        autoNext: cfg.autoNext,
        notify: cfg.notify,
        /** 显示用文本（两端一致，见 `formatRemaining`）。 */
        text: formatRemaining(remainingMs),
        /** 该不该显示倒计时：关掉总开关就完全不显示。 */
        show: cfg.enabled === true
      }
    },

    /**
     * 跨重启恢复。
     *
     * ⚠️ **不能无脑复活**：关了 DSH 三天再打开，"专注还剩 12 分钟"是荒谬的，
     * 而"立刻弹一条休息提醒"更糟（用户刚打开就被吼）。
     * 规则：
     *   · 停机时长 < 本阶段剩余 → 按真实经过时间扣减（真的在走）；
     *   · 停机时长 ≥ 本阶段剩余 → 认为那一轮已经作废，**停在"本阶段从头"**
     *     且 `running=false` —— 不跑就不会结算，自然也不会补发通知。
     *
     * @param {object} saved - `persist()` 的产物
     * @param {number} [at]
     * @returns {boolean} 是否成功恢复
     */
    adopt (saved, at = now()) {
      if (saved === null || typeof saved !== 'object') return false
      // 轮次与阶段先恢复（`completed` 与长休判定相关，必须跟着回来）。
      if (Number.isFinite(Number(saved.completed))) {
        completed = Math.max(0, Math.trunc(Number(saved.completed)))
      }
      phase = POMODORO_PHASES.includes(saved.phase) ? saved.phase : 'focus'
      totalMs = phaseDuration(phase, cfg)
      const savedRemaining = Number(saved.remainingMs)
      let remain = Number.isFinite(savedRemaining) && savedRemaining > 0 ? savedRemaining : totalMs
      if (remain > totalMs) remain = totalMs

      const savedAt = Number(saved.savedAt)
      const wasRunning = saved.running === true
      startedAt = at
      lastTickAt = at

      if (wasRunning && Number.isFinite(savedAt) && savedAt > 0) {
        const gap = Math.max(0, at - savedAt)
        if (gap >= remain) {
          // 阶段在停机期间就走完了：作废本轮，从头开始，**且不跑起来** ——
          // `running=false` 是"不补通知"的守卫（`advance` 见 !running 直接返回，
          // 根本不会走到结算）。用户看到的是"新的一轮，还没开始"。
          remainingMs = totalMs
          running = false
          return true
        }
        remain -= gap
      }
      remainingMs = remain
      running = wasRunning
      return true
    },

    /** 持久化用（**不含** `endsAt` —— 它是投影，重启后无意义）。 */
    persist (at = now()) {
      return {
        phase,
        remainingMs: Math.max(0, Math.round(remainingMs)),
        running,
        completed,
        roundsPerLongBreak: cfg.roundsPerLongBreak,
        savedAt: at
      }
    },

    /** 供测试与诊断读取内部状态。 */
    internals: {
      get phase () { return phase },
      get running () { return running },
      get remainingMs () { return remainingMs },
      get totalMs () { return totalMs },
      get completed () { return completed },
      get startedAt () { return startedAt },
      get config () { return cfg },
      get lastTickAt () { return lastTickAt }
    }
  }
}