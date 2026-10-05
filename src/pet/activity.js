/**
 * 庄方宜桌宠 · 活跃度档位（安静 / 正常 / 调皮）
 *
 * 用户点名的功能："调成安静、正常、调皮来改变它的活跃度"。
 *
 * **设计原则：档位是一层预设，不是又一套开关。**
 * 用户已经能单独调气泡时长、间隔、完成提醒……如果档位再把它们各复制一份，
 * 就会出现"我在设置页把间隔调成 60s，档位又说 4s"这种打架状态，谁也说不清
 * 最终生效的是哪个。所以这里的规则很窄：
 *
 *   · 档位只决定**三件事** —— 哪些状态值得弹气泡、气泡间隔的倍率、
 *     空闲时要不要主动蹦表情；
 *   · 用户的显式数值（`bubbleMs` / `bubbleGapMs`）**仍然是基准**，
 *     档位只是在这个基准上乘一个倍率；
 *   · 完成提醒的**开关**（`notifyComplete`）永远归用户，档位不篡改它 ——
 *     "跑完了告诉我"是用户要不要被通知的问题，不是性格问题。
 *
 * 本文件被 Host 与测试共用，是这套语义的**唯一真相**；客户端只显示档位名。
 */

/** 档位清单（与 `src/settings.js` 的 `ACTIVITY_MODES` 同值，此处不复导出以免循环依赖）。 */
export const ACTIVITY_PRESETS = {
  /**
   * 安静：只在**需要你知道**的时候出声。
   *
   * 保留 `waiting`（在等你审批 —— 不提醒你就会一直卡着）与 `error`（出错了），
   * 其余状态（thinking/working/listening/happy）一律不弹 —— 它们在跑是常态，
   * 每次都弹就是噪音。间隔拉长、绝不主动卖萌。
   */
  quiet: {
    /** 只有这两个状态弹气泡。 */
    states: ['waiting', 'error'],
    /** 气泡间隔倍率（乘在用户的 `bubbleGapMs` 上）。 */
    gapScale: 2.5,
    /** 空闲时主动蹦表情的中位间隔（ms）。null = 永不。 */
    idleEmoteMs: null
  },

  /**
   * 正常：默认行为 —— 各状态都弹，间隔按用户设定，不主动卖萌。
   *
   * `states: null` 表示"用状态机自己的默认列表"，而不是在这里抄一份 ——
   * 抄一份的话，状态机以后加了状态，档位表就悄悄过期了。
   */
  normal: {
    states: null,
    gapScale: 1,
    idleEmoteMs: null
  },

  /**
   * 调皮：爱表现。所有状态都弹，间隔缩短一半，空闲时**会主动蹦表情**。
   *
   * `idleEmoteMs: 60000` = 空闲每 ~60s 蹦一次随机气泡（带抖动，见 `nextIdleEmoteDelay`）。
   * 不用更短是因为用户在看屏幕工作时，频繁弹窗会真的烦 —— "调皮"是活泼，不是骚扰。
   */
  playful: {
    states: null,
    gapScale: 0.5,
    idleEmoteMs: 60000
  }
}

/** 取档位预设；未知/缺失一律回落到 `normal`（安全侧：不改变现状）。 */
export function activityPreset (activity) {
  return ACTIVITY_PRESETS[activity] ?? ACTIVITY_PRESETS.normal
}

/**
 * 把档位换算成状态机 `config` 要的字段。
 *
 * @param {string} activity - 'quiet' | 'normal' | 'playful'
 * @param {object} base - 用户设置（`bubbleGapMs` 为基准，`bubbleStates` 为默认列表）
 * @param {string[]} defaultStates - 状态机的默认气泡状态列表
 * @returns {{bubbleStates: string[], bubbleSilenceMs: number, idleEmoteMs: number|null}}
 */
export function activityConfig (activity, base, defaultStates) {
  const preset = activityPreset(activity)
  const states = preset.states === null
    ? defaultStates
    // 与状态机的合法状态求交集：档位表写了错名字也不该让气泡彻底失灵。
    : defaultStates.filter(s => preset.states.includes(s))
  const gap = Number.isFinite(base?.bubbleGapMs) ? base.bubbleGapMs : 8000
  return {
    bubbleStates: states,
    // 倍率只拉长/缩短，不允许为负；0 倍（用户设了 0 = 不限）保持 0。
    bubbleSilenceMs: gap === 0 ? 0 : Math.round(gap * preset.gapScale),
    idleEmoteMs: preset.idleEmoteMs
  }
}

/**
 * 下一次"主动蹦表情"的延后（ms）—— 在基准上抖动，避免像节拍器一样准点。
 *
 * 精确的周期性会让人觉得是机器在闹；±35% 的抖动更像"它自己想起来"。
 * 纯函数（传入随机源）便于测试。
 *
 * @param {number} baseMs
 * @param {() => number} [rand] - 返回 [0,1) 的随机源
 * @returns {number} 整数 ms
 */
export function nextIdleEmoteDelay (baseMs, rand = Math.random) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return Infinity
  const jitter = (rand() * 0.7) - 0.35 // [-0.35, 0.35)
  return Math.max(1000, Math.round(baseMs * (1 + jitter)))
}
