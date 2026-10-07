/**
 * 庄方宜桌宠 · 情境感应（**纯函数，无 IO、无定时器**）
 *
 * ── 用户要的是什么 ────────────────────────────────────────────────────────
 *
 * "互动当前方式，通过右键就点个按钮，很奇怪，能不能加一些更有意思的。"
 *
 * 奇怪在哪：三个动作在机制上**完全相同** —— 固定加分、固定台词、固定表情。
 * 结果不随"什么时候、她当时在干什么"变化，所以它确实就是三个按钮。
 *
 * 这个模块补的就是那一维：**同一个动作，在不同情境下结果不同**。
 *
 * ── 为什么单独一个模块（而不是把 if 塞进 index.js）────────────────────────
 *
 * 情境判定是"输入 → 输出"的纯映射，而它**几乎全部的价值在于可穷举**：
 * 7 个情境 × 7 个动作 = 49 种组合，每一种都得有一句说得通的话。塞进 Host 的
 * 事件回调里就变成了"上线之后靠用户碰出来"。
 *
 * 而且 `index.js` 已经 3000 行、其中大半是装配与副作用 —— 往那儿再加一张
 * 49 行的表，等于把唯一能被穷举验证的东西埋进唯一不能被穷举验证的地方。
 *
 * ── 三条设计约束 ─────────────────────────────────────────────────────────
 *
 * 1. **`gainMul` 只在 [0, 1] 之间**。情境只能**打折**，不能加成 ——
 *    好感度的设计不变式是"单日潜在收益要能跨过第二档"（那条断言按
 *    `gainMul = 1` 求值），若允许加成，不变式就要按"所有情境同时生效"
 *    重算，而那是算不出来的（情境互斥，但谁也不知道用户会怎么组合）。
 *    只允许打折则不变式恒成立：最坏情况是少赚，不会多赚。
 * 2. **未知输入一律回落 `default`，绝不抛**。一个写错的情境 id 不该让
 *    "摸她一下"整个失灵 —— 那是最难查的一类故障（动作有反应，但反应是空的）。
 * 3. **文案是数据，不是拼出来的字符串**。`zh`/`en` 两份都在这里，
 *    `index.js` 只按 `locale` 取一条 —— 与 `interactions.js` 同一纪律。
 *
 * @module src/pet/mood.js
 */

/**
 * 情境 id。**顺序即优先级**（`moodContext` 从前往后匹配，命中即停）。
 *
 * 排序的依据是"哪一种解释对用户更有用"，不是严重程度：
 *   · `asleep` 最前 —— 她睡着了是**最需要被解释**的状态（不然用户会以为
 *     自己点坏了：点一下没反应、或者反应很奇怪）；
 *   · `busy` / `trouble` 次之 —— 这是"她现在的心情"，比"她在计时"更直接；
 *   · `focus` / `rest` 再次 —— 番茄钟阶段；
 *   · `close` 最后（在 `default` 之前）—— 它是**关系档位**，只有当上面
 *     几条都不成立时才轮得到它（在忙的时候"我们很熟"不该改变她的反应）。
 */
export const MOOD_IDS = ['asleep', 'busy', 'trouble', 'focus', 'rest', 'close', 'default']

/** 各情境的收益倍率。**必须在 [0,1]**（见文件头约束 1）。 */
export const MOOD_GAIN_MUL = {
  asleep: 0,
  busy: 0.5,
  trouble: 1,
  focus: 0.5,
  rest: 1,
  close: 1,
  default: 1
}

/**
 * 情境 → 各动作的文案 / 语音 / 表情情境键覆盖。
 *
 * 形状：`MOOD_TEXT[情境][动作] = { text: {zh,en}, voice, emoteKey }`。
 *
 * **只写与默认不同的那些**。没写的组合自动回落 `interactions.js` 的默认文案 ——
 * 这一点很重要：49 种组合全写一遍的话，改一句默认台词要改 7 个地方，
 * 而"改了一处、另外六处还是旧的"在本项目已经发生过（人设注入那次）。
 *
 * `voice` 为空表示**沿用动作自己的语音事件**（多数情况如此 —— 情境改变的是
 * 语气，不是"说什么事件"）。只有真的需要另一条录音时才写。
 */
export const MOOD_TEXT = {
  // ── 睡着了 ────────────────────────────────────────────────────────────
  //
  // 收益 0：她睡着了，摸她不该涨好感（否则"等她睡着再摸"成了最优解，
  // 而那是明显的刷分路子）。但仍然**有反应** —— 被吵醒本身就是反应。
  asleep: {
    'pet-head': { text: { zh: '……唔。（她翻了个身）', en: '…mm. (she rolls over)' } },
    pat: {
      1: { text: { zh: '……唔？', en: '…mm?' } },
      2: { text: { zh: '（她把脸埋进胳膊里）', en: '(she buries her face in her arms)' } },
      3: { text: { zh: '……别闹了，我真的很困。', en: "…stop it, I'm really sleepy." } }
    },
    click: { text: { zh: '……（没醒）', en: '…(still asleep)' } },
    fling: { text: { zh: '——！？（她惊醒了）', en: '—!? (she wakes with a jolt)' } },
    hover: { text: { zh: '……（睡着）', en: '…(asleep)' } },
    praise: { text: { zh: '……嗯，梦里也听到了。', en: '…mm, heard it in my dream.' } },
    feed: { text: { zh: '……不吃了，想睡。', en: "…not eating. Sleepy." } }
  },

  // ── 在忙（working / thinking / waiting）──────────────────────────────
  //
  // 收益 0.5：她在干活的时候摸她，算是打扰，但也不该完全没有回报
  //（用户是在表达关心）。半价是"有回应、但别指望这样刷分"。
  busy: {
    'pet-head': { text: { zh: '轻点……我在忙。', en: "Easy — I'm busy." } },
    pat: {
      1: { text: { zh: '嗯？', en: 'Mm?' } },
      2: { text: { zh: '等我这段跑完。', en: 'Let me finish this bit.' } },
      3: { text: { zh: '……好啦，我知道你在。', en: "…okay, I know you're there." } }
    },
    click: { text: { zh: '在忙，等一下。', en: 'Busy — one sec.' } },
    fling: { text: { zh: '喂——！我还在算呢！', en: "Hey—! I'm still computing!" } },
    praise: { text: { zh: '……记下了，等我忙完再高兴。', en: "…noted. I'll be pleased later." } },
    feed: { text: { zh: '放着吧，我一会儿吃。', en: "Leave it there, I'll eat later." } }
  },

  // ── 出错了 ────────────────────────────────────────────────────────────
  //
  // 收益 1（不打折）：她刚出错的时候摸她，是**安慰**，不该打折。
  trouble: {
    'pet-head': { text: { zh: '……没事。再来一次就好。', en: "…it's fine. Just run it again." } },
    pat: {
      1: { text: { zh: '……嗯。', en: '…mm.' } },
      2: { text: { zh: '再摸一会儿也行。', en: 'You can keep going.' } },
      3: { text: { zh: '……好多了。谢谢。', en: '…better now. Thanks.' } }
    },
    praise: { text: { zh: '……别夸了，这次是我没做好。', en: "…don't. That one was on me." } },
    feed: { text: { zh: '……吃点东西确实好受些。', en: '…eating does help.' } }
  },

  // ── 番茄钟 · 专注中 ───────────────────────────────────────────────────
  //
  // 收益 0.5，并且**这一支是"摸鱼计数"的判定依据**（见 index.js）：
  // 专注期间的互动会被记下来，阶段结束时她按次数点评。
  focus: {
    'pet-head': { text: { zh: '……专心。（她没抬头）', en: "…focus. (she doesn't look up)" } },
    pat: {
      1: { text: { zh: '……？', en: '…?' } },
      2: { text: { zh: '别闹，计时还在走。', en: "Don't — the clock's running." } },
      3: { text: { zh: '……你确定现在是摸我的时候吗？', en: '…sure this is the moment?' } }
    },
    click: { text: { zh: '（她指了指倒计时）', en: '(she points at the countdown)' } },
    fling: { text: { zh: '喂！这一轮要被你甩没了！', en: 'Hey! You just threw my round away!' } },
    praise: { text: { zh: '……专心，等结束再夸。', en: '…focus. Praise me after.' } },
    feed: { text: { zh: '……（她摆摆手，没接）', en: '…(she waves it away)' } }
  },

  // ── 番茄钟 · 休息中 ───────────────────────────────────────────────────
  //
  // 收益 1：休息就是用来被打扰的（她本来就在等你）。
  rest: {
    'pet-head': { text: { zh: '歇着呢，正好。', en: 'Resting — good timing.' } },
    pat: {
      1: { text: { zh: '嗯～', en: 'Mm~' } },
      2: { text: { zh: '再摸一会儿吧，反正还有时间。', en: "Keep going, there's time." } },
      3: { text: { zh: '……呼。差点睡着。', en: '…phew. Almost fell asleep.' } }
    },
    click: { text: { zh: '休息中，随便聊。', en: 'On break — talk to me.' } },
    praise: { text: { zh: '这话我收下了。', en: "I'll take that." } },
    feed: { text: { zh: '正好饿了，谢谢。', en: 'Perfect timing — thanks.' } },
    fling: { text: { zh: '哇——休息时间也不能这么玩啊！', en: 'Whoa—! Not even on break!' } }
  },

  // ── 关系够近（close / trusted）────────────────────────────────────────
  //
  // 收益 1（与默认相同 —— 档位不是收益倍率，是**语气**）。
  close: {
    'pet-head': { text: { zh: '嗯，是你啊。', en: 'Mm — it’s you.' } },
    pat: {
      1: { text: { zh: '又来？', en: 'Again?' } },
      2: { text: { zh: '……好吧，就一会儿。', en: "…fine, just a bit." } },
      3: { text: { zh: '你手不酸吗。', en: "Isn't your arm tired?" } }
    },
    click: { text: { zh: '在呢。', en: 'Here.' } },
    praise: { text: { zh: '……你就会说这个。', en: "…that's all you ever say." } }
  },

  // ── 兜底 ──────────────────────────────────────────────────────────────
  //
  // **空对象**：全部沿用 `interactions.js` 的默认文案。
  // 写一份"复制的默认文案"在这里会变成第二个真相 —— 改默认台词时
  // 只改了 `interactions.js`，而 `default` 这一支永远停在旧版本。
  default: {}
}

/**
 * 判定当前情境。**纯函数**。
 *
 * @param {object} ctx
 * @param {string} [ctx.petState] - 状态机当前状态（`sleeping`/`working`/…）
 * @param {string} [ctx.pomodoroPhase] - `focus` | `break` | `long-break`
 * @param {boolean} [ctx.pomodoroRunning] - 番茄钟是否在跑（暂停时不算"专注中"）
 * @param {string} [ctx.tier] - 好感度档位 key
 * @returns {string} `MOOD_IDS` 之一（永不返回 undefined）
 */
export function moodContext (ctx) {
  const c = (ctx !== null && typeof ctx === 'object') ? ctx : {}
  const state = typeof c.petState === 'string' ? c.petState : ''
  const phase = typeof c.pomodoroPhase === 'string' ? c.pomodoroPhase : ''
  const running = c.pomodoroRunning === true
  const tier = typeof c.tier === 'string' ? c.tier : ''

  if (state === 'sleeping') return 'asleep'
  if (state === 'working' || state === 'thinking' || state === 'waiting') return 'busy'
  if (state === 'error') return 'trouble'
  // ⚠️ `running` 必须为 true：暂停中的番茄钟不是"专注中"。
  // 只看 phase 的话，"暂停了 20 分钟"期间摸她会一直被记成摸鱼。
  if (running && phase === 'focus') return 'focus'
  if (running && (phase === 'break' || phase === 'long-break')) return 'rest'
  if (tier === 'close' || tier === 'trusted') return 'close'
  return 'default'
}

/** 该情境的收益倍率（未知情境回落 1 = 不打折）。 */
export function moodGainMul (context) {
  const v = MOOD_GAIN_MUL[context]
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
}

/**
 * 取一条情境化的反应。**纯函数，永不抛**（见文件头约束 2）。
 *
 * @param {string} kind - `INTERACT_KINDS` 之一
 * @param {object} ctx - 见 `moodContext`
 * @param {object} [opts]
 * @param {string} [opts.locale] - `'zh'` | `'en'`
 * @param {number} [opts.level] - 长按级数（只对 `pat` 有意义）
 * @param {object} [opts.fallback] - 默认文案/语音（`interactions.js` 给的那份）
 * @returns {{context: string, gainMul: number, text: object|null, voice: string|null}}
 *   `text` 是 `{zh, en}` 或 null；`voice` 为 null 表示沿用动作自己的语音事件。
 */
export function moodFor (kind, ctx, opts = {}) {
  const context = moodContext(ctx)
  const gainMul = moodGainMul(context)
  const table = MOOD_TEXT[context]
  const bucket = (table !== null && typeof table === 'object') ? table[kind] : null

  let text = null
  let voice = null

  if (bucket !== null && typeof bucket === 'object') {
    /**
     * `pat` 的文案是**按级数分的**（`{1:{…}, 2:{…}, 3:{…}}`），其余动作是
     * `{text, voice}`。两者的形状不能靠"有没有 text 字段"去猜 —— 那等于
     * 用一个字段的存在与否去推断类型，加一个字段就悄悄换了分支。
     * 直接看有没有数字键，判据就写在脸上。
     */
    const byLevel = bucket['1'] !== undefined || bucket['2'] !== undefined || bucket['3'] !== undefined
    if (byLevel) {
      // ⚠️ 级数要**夹到实际存在的最大级**，不是原样去查表。
      // 原样查的后果：`level=99` 查不到 → text 为 null → 回落 fallback；
      // 而 `pat` 没有 fallback 时就是**什么都不弹** —— 一次"摸到第 99 级"
      // 的畸形请求变成"摸了没反应"，且毫无报错。
      // （exe 侧 `PetHttp.PostInteract` 已经夹了一次，但那是跨进程信任边界
      // 的另一侧；宿主侧必须自己再挡一次 —— 路由白名单同一条纪律。）
      const maxLevel = byLevel ? Math.max(...Object.keys(bucket).map(k => Math.trunc(Number(k))).filter(Number.isFinite)) : 1
      const want = Math.max(1, Math.trunc(Number(opts.level)) || 1)
      const lv = Math.min(want, maxLevel)
      const one = bucket[String(lv)]
      if (one !== null && typeof one === 'object') {
        text = one.text ?? null
        voice = one.voice ?? null
      }
    } else {
      text = bucket.text ?? null
      voice = bucket.voice ?? null
    }
  }

  // 回落：情境没写文案就用默认那份（**不是**返回 null —— null 意味着"不弹
  // 气泡"，而"情境没配"与"故意不弹"是两回事）。
  const fallback = (opts.fallback !== null && typeof opts.fallback === 'object') ? opts.fallback : null
  if (text === null && fallback !== null) text = fallback.text ?? null
  if (voice === null && fallback !== null) voice = fallback.voice ?? null

  return { context, gainMul, text, voice }
}

/** 本地化一条情境文案。`text` 为 null 时返回 null（= 不弹气泡）。 */
export function moodText (text, locale = 'zh') {
  if (text === null || typeof text !== 'object') return null
  return text[locale] ?? text.zh ?? null
}
