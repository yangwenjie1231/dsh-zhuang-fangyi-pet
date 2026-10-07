// 用脚本生成 voice-lines.json，避免手写 JSON 的引号转义问题。
const fs = require('node:fs')
const path = require('node:path')

const BASE_LINES = [
  { name: 'wake', event: 'pet/wake', source: 'real', real: '018_打招呼1.mp3',
    text: '我正好要去实验室，顺路的话一起走？',
    why: '桌宠刚出现。官方原声，最自然。' },

  { name: 'click-1', event: 'pet/click', source: 'synth', text: '嗯？我在呢。',
    why: '单击。合成：官方 0.9~2.5 秒的短句全是战斗喊招（灭 / 我这就来），套到点击上很奇怪。' },
  { name: 'click-2', event: 'pet/click', source: 'synth', text: '怎么啦，实验卡住了？',
    why: '点击轮换。她第一反应总是关心你的课题 —— 符合人设。' },
  { name: 'click-3', event: 'pet/click', source: 'synth', text: '别急，我在听。',
    why: '点击轮换。' },
  { name: 'click-4', event: 'pet/click', source: 'real', real: '060_回应激励1.mp3',
    text: '过奖了。',
    why: '点击轮换。官方原声 0.92 秒 —— 被夸时摆手推辞的语气，对得上。' },
  { name: 'click-5', event: 'pet/click', source: 'real', real: '015_待命1.mp3',
    text: '你刚刚……叫我名字了？',
    why: '点击轮换。官方「待命」—— 被叫名字时恍惚片刻，是人设里的细节。' },

  { name: 'work-start-1', event: 'agent/working', source: 'synth', text: '好，交给我吧。',
    why: 'AI 开始干活。合成：官方「作战开始1」是不怕苦战只怕无谓之战，与日常干活无关。' },
  { name: 'work-start-2', event: 'agent/working', source: 'synth', text: '我看看……嗯，思路有了。',
    why: '干活轮换。她的典型节奏：先看，再给方向。' },
  { name: 'work-start-3', event: 'agent/working', source: 'real', real: '017_进驻设施.mp3',
    text: '你要是信我，可以直接放手让我做。都是小事，我一个人就够。',
    why: '干活轮换。官方「进驻设施」—— 接手任务时的口吻，语义对得上。' },

  { name: 'done-1', event: 'turn/complete', source: 'synth', text: '做完了，你看看。',
    why: 'AI 干完活（用户点名的完成时提醒）。合成：官方「作战胜利1」是赢这一次其实不算很难，套到改代码上很奇怪。' },
  { name: 'done-2', event: 'turn/complete', source: 'synth', text: '好了，结果都在这里。',
    why: '完成轮换。' },
  { name: 'done-3', event: 'turn/complete', source: 'synth', text: '成了。比预想的顺利。',
    why: '完成轮换 —— 她的风暴平息语气。' },
  { name: 'done-4', event: 'turn/complete', source: 'real', real: '066_作战胜利3.mp3',
    text: '辛苦诸位了。',
    why: '完成轮换。官方原声 1.21 秒，收尾道谢的语气对得上（不涉战斗语义）。' },

  { name: 'error-1', event: 'agent/error', source: 'synth', text: '出问题了，我看一下。',
    why: '出错。合成：官方只有「小心！」一条短提示，语义太窄。' },
  { name: 'error-2', event: 'agent/error', source: 'real', real: '055_危险提醒.mp3',
    text: '小心！',
    why: '出错轮换。官方原声 0.71 秒最短最醒目 —— 出错要立刻被注意到。' },
  { name: 'error-3', event: 'agent/error', source: 'synth', text: '别慌，先看看报错。',
    why: '出错轮换。她的风格是遇事不慌、先定位问题。' },

  { name: 'waiting-1', event: 'attention/approval', source: 'real', real: '074_连携技就绪1.mp3',
    text: '嗯，就等你了。',
    why: '等你审批。官方原声，语义完全对得上（1.53 秒）。' },
  { name: 'waiting-2', event: 'attention/approval', source: 'synth', text: '管理员，这里需要你定一下。',
    why: '审批轮换。说清为什么叫你，比只说等你更有用。' },

  { name: 'thinking-1', event: 'agent/thinking', source: 'synth', text: '让我想想……',
    why: '这条才是「让我想想」的正确位置 —— v1 把它放在回复到达时，时序倒置（话都说完了才说这句）。' },
  { name: 'thinking-2', event: 'agent/thinking', source: 'synth', text: '嗯……我理一理。',
    why: '思考轮换。' },

  { name: 'pomodoro-start', event: 'pomodoro/start', source: 'synth',
    text: '好，开始专注。这段时间就交给我吧。', why: '开始专注。' },
  { name: 'pomodoro-focus-end', event: 'pomodoro/focus-end', source: 'real', real: '052_休整.mp3',
    text: '暂且歇歇吧，留着精力，更难的还在后面呢。',
    why: '专注结束 → 该休息了。官方「休整」台词，为这个功能量身定做。' },
  { name: 'pomodoro-break-end', event: 'pomodoro/break-end', source: 'synth',
    text: '歇够了，我们继续吧。', why: '休息结束 → 回来干活。官方素材里没有回来继续的短句。' },
  { name: 'pomodoro-long-end', event: 'pomodoro/long-end', source: 'synth',
    text: '长休息结束了，状态不错，接着来。', why: '长休结束。' },
  { name: 'pomodoro-long-start', event: 'pomodoro/long-start', source: 'synth',
    text: '这一轮做得很扎实，去好好休息一下吧。',
    why: '进入长休息（每 4 轮一次，用户点名的功能）—— v1 完全没覆盖这个时机。' },

  { name: 'feed-1', event: 'pet/feed', source: 'real', real: '043_发现资源1.mp3',
    text: '有些好东西，我们不算白来。',
    why: '投喂。官方「发现资源」，收到好东西的语气，对得上。' },
  { name: 'feed-2', event: 'pet/feed', source: 'synth', text: '给我的？那我不客气了。',
    why: '投喂轮换 —— 比发现资源更像被投喂的反应。' },

  { name: 'praise-1', event: 'pet/praise', source: 'real', real: '058_小队激励1.mp3',
    text: '干净利落，真漂亮。',
    why: '夸奖她。官方「小队激励」—— 她习惯把夸奖转回给别人，是人设细节。' },
  { name: 'praise-2', event: 'pet/praise', source: 'real', real: '061_回应激励2.mp3',
    text: '哪里，都是大家的功劳。',
    why: '夸奖轮换。官方原声 —— 谦而不虚，正是人设第 5 条。' },
  { name: 'praise-3', event: 'pet/praise', source: 'synth', text: '好了好了，可别再夸了。',
    why: '夸奖轮换。她摆手推辞的典型反应。' },

  { name: 'pet-head-1', event: 'pet/pet-head', source: 'synth', text: '嗯……这样也挺好的。',
    why: '摸摸头。官方素材里没有亲密互动的短句。' },
  { name: 'pet-head-2', event: 'pet/pet-head', source: 'synth', text: '别闹，我还有份报告要写呢。',
    why: '摸头轮换 —— 她守不住闲又其实受用，比一味顺从更像她。' },

  { name: 'sleepy-1', event: 'pet/sleeping', source: 'synth', text: '有点困了，我先眯一会儿。',
    why: '进入睡眠。' },
  { name: 'sleepy-2', event: 'pet/sleeping', source: 'synth', text: '呼……就十分钟。',
    why: '睡眠轮换 —— 她的分秒必争连打盹都要限时。' },

  { name: 'chat-reply-1', event: 'chat/reply', source: 'synth', text: '嗯，我说完了。',
    why: '聊天回复到达时的提示音（正文在气泡里）。v1 用的是让我想想 —— 时序倒置。' },
  { name: 'chat-reply-2', event: 'chat/reply', source: 'synth', text: '你看这样行吗？',
    why: '回复轮换。' },
  { name: 'chat-reply-3', event: 'chat/reply', source: 'synth', text: '喏，都在上面了。',
    why: '回复轮换 —— 指向气泡里的正文。' },

  { name: 'session-start', event: 'session/start', source: 'synth',
    text: '新的对话，我们从头理一理。', why: '新会话出现 —— v1 没覆盖。' },
  { name: 'approval-done', event: 'attention/cleared', source: 'synth',
    text: '好，那我继续了。', why: '你处理完审批后她接着干 —— 有始有终，v1 没覆盖。' },
  { name: 'idle-long', event: 'pet/idle-long', source: 'synth',
    text: '闲下来反而有点不习惯……要不要找点事做？',
    why: '长时间空闲时的一句（低频，避免吵闹）。' },

  // ── v3 扩充（用户 2026-10-07："当前主体的变化度还是比较少（包括语音），
  //    就是比较单调吧"）────────────────────────────────────────────────────
  //
  // 实测痛点：`agent/thinking` **只有 2 条**，而它恰恰是最高频的（每次思考都放）；
  // 另有 9 个事件各只有 1 条 —— 听两次就腻。
  //
  // 写作纪律与既有 29 条一致：人设是"冷静、务实、话少、关心你的课题"，
  // 短句为主（8~20 字，合成 2~8 秒；且 `speechMaxChars` 默认 60 字会截断）。
  // **不重复既有句的意思** —— 补台词是为了"换着说"，不是换词说同一件事。

  // 思考（2 → 6）：最高频，最需要变化
  { name: 'thinking-3', event: 'agent/thinking', source: 'synth', text: '这个问题……有点意思。',
    why: '思考轮换。她遇到有意思的难题会来精神 —— 不是抱怨，是起兴致。' },
  { name: 'thinking-4', event: 'agent/thinking', source: 'synth', text: '先别打断，我快抓到了。',
    why: '思考轮换。她的思考是"抓线索"式的，与"我理一理"不同。' },
  { name: 'thinking-5', event: 'agent/thinking', source: 'synth', text: '让我把条件捋一遍。',
    why: '思考轮换 —— 研究员本能：先摆条件再下判断。' },
  { name: 'thinking-6', event: 'agent/thinking', source: 'synth', text: '嗯，有个想法，验证一下。',
    why: '思考轮换。她的口头禅是"验证"而不是"我觉得"。' },

  // 干活（3 → 6）
  { name: 'work-start-4', event: 'agent/working', source: 'synth', text: '在做了，稍等。',
    why: '干活轮换 —— 最短的一句，适合连轴转时不啰嗦。' },
  { name: 'work-start-5', event: 'agent/working', source: 'synth', text: '这部分交给我，你去忙别的。',
    why: '干活轮换。她的担当：主动分走一半，不让你守着。' },
  { name: 'work-start-6', event: 'agent/working', source: 'synth', text: '思路通了，剩下的就是体力活。',
    why: '干活轮换 —— 把"难"和"烦"分开说，是她评估任务的方式。' },

  // 完成（4 → 7）
  { name: 'done-5', event: 'turn/complete', source: 'synth', text: '喏，按你要的改好了。',
    why: '完成轮换。呼应"按你要的"—— 强调是照你的要求做的。' },
  { name: 'done-6', event: 'turn/complete', source: 'synth', text: '这一版应该没有问题了。',
    why: '完成轮换 —— 她的措辞留有余地（"应该"），不把话说满。' },
  { name: 'done-7', event: 'turn/complete', source: 'synth', text: '收工。你验收一下。',
    why: '完成轮换 —— 交付口吻，把最后一步交回给你。' },

  // 聊天回复（3 → 6）
  { name: 'chat-reply-4', event: 'chat/reply', source: 'synth', text: '我说完了，你怎么想？',
    why: '回复轮换 —— 说完了还问一句，把话头递回去。' },
  { name: 'chat-reply-5', event: 'chat/reply', source: 'synth', text: '大概就是这个意思。',
    why: '回复轮换 —— 口语化的收束，比"我说完了"更轻。' },
  { name: 'chat-reply-6', event: 'chat/reply', source: 'synth', text: '先这样，不够再问我。',
    why: '回复轮换 —— 留个口子，不把对话做死。' },

  // 出错（3 → 6）
  { name: 'error-4', event: 'agent/error', source: 'synth', text: '等一下，这里不对劲。',
    why: '出错轮换 —— 先叫停再排查，比"出问题了"更急一点。' },
  { name: 'error-5', event: 'agent/error', source: 'synth', text: '报错了。别急，我看看。',
    why: '出错轮换 —— 一半报信一半安抚，符合她稳住场面的习惯。' },
  { name: 'error-6', event: 'agent/error', source: 'synth', text: '这个错我见过，有办法。',
    why: '出错轮换 —— 给出"能解决"的信号，而不是只报告坏消息。' },

  // ── 原先各只有 1 条的事件（1 → 3）：听两次就腻 ──────────────────────────
  { name: 'wake-2', event: 'pet/wake', source: 'synth', text: '来了。今天从哪儿开始？',
    why: '出现轮换 —— 直接问进度，符合她一上来就想干活。' },
  { name: 'wake-3', event: 'pet/wake', source: 'synth', text: '我在这儿。有什么要做的？',
    why: '出现轮换 —— 报到 + 待命，简洁。' },
  { name: 'session-start-2', event: 'session/start', source: 'synth', text: '新的一页，从哪儿说起？',
    why: '新会话轮换。' },
  { name: 'session-start-3', event: 'session/start', source: 'synth', text: '好，我准备好了。',
    why: '新会话轮换 —— 最短的一条，不打扰。' },
  { name: 'idle-long-2', event: 'pet/idle-long', source: 'synth', text: '安静了这么久……在想什么呢？',
    why: '空闲轮换 —— 关心你在想什么，而不是催你干活。' },
  { name: 'idle-long-3', event: 'pet/idle-long', source: 'synth', text: '没事做的话，我陪你待会儿。',
    why: '空闲轮换 —— 她的陪伴是不打扰式的。' },
  { name: 'approval-done-2', event: 'attention/cleared', source: 'synth', text: '好，那这件事翻篇了。',
    why: '审批结束轮换。' },
  { name: 'approval-done-3', event: 'attention/cleared', source: 'synth', text: '收到，我接着做。',
    why: '审批结束轮换 —— 最短，衔接回工作。' },
  { name: 'pomodoro-start-2', event: 'pomodoro/start', source: 'synth', text: '计时开始了，专心。',
    why: '专注开始轮换 —— 计时场景下她的话要短。' },
  { name: 'pomodoro-break-end-2', event: 'pomodoro/break-end', source: 'synth', text: '休息结束，回来吧。',
    why: '短休息结束轮换。' },
  { name: 'pomodoro-long-end-2', event: 'pomodoro/long-end', source: 'synth', text: '睡饱了，继续。',
    why: '长休息结束轮换。' },
  { name: 'pomodoro-long-start-2', event: 'pomodoro/long-start', source: 'synth',
    text: '这一轮辛苦你了，去放松一下。',
    why: '长休息开始轮换 —— 认可这一轮的付出。' },
  { name: 'feed-3', event: 'pet/feed', source: 'synth', text: '谢谢，我正好有点饿。',
    why: '投喂轮换 —— 接受得自然，不像客套。' },
  { name: 'sleepy-3', event: 'pet/sleeping', source: 'synth', text: '撑不住了……我睡一小会儿。',
    why: '睡眠轮换 —— "撑不住"比"有点困"更累一档，对应更长的空闲。' },
  { name: 'pet-head-3', event: 'pet/pet-head', source: 'synth', text: '嗯……就一下。',
    why: '摸头轮换 —— 嘴上设限、其实没躲，与 pet-head-2 的"别闹"同一路子但更软。' },
  { name: 'praise-4', event: 'pet/praise', source: 'synth', text: '这话我记下了。',
    why: '被夸轮换 —— 不推辞也不得意，收下。' },
  { name: 'click-6', event: 'pet/click', source: 'synth', text: '在的，你说。',
    why: '点击轮换 —— 最短的应答，高频点击时不啰嗦。' },
  { name: 'click-7', event: 'pet/click', source: 'synth', text: '嗯？需要我做什么？',
    why: '点击轮换 —— 把点击理解成"有活要派"，符合她随时待命的状态。' }
]

/**
 * ── 语音丰富化：同一句台词生成**多个 seed 变体** ──────────────────────────
 *
 * 用户 2026-10-07："你让音频再丰富一点吧"。
 *
 * 实测同一句换 seed，产出**时长与波形都不同**：
 *
 *     "做完了，你看看。"  seed1=2.58s / seed2=2.06s / seed3=2.42s（sha256 全不同）
 *
 * 那是真实的语气差异（重音、停顿、语调），不是噪声 —— 正是"丰富"的来源。
 *
 * 做法：给每条 `synth` 台词**复制**出 `VARIANTS-1` 个同文本、不同 `name` 的条目
 *（`thinking-1` / `thinking-1-2`）。于是：
 *   · `tools/synth-voice.ps1` 按"第几个变体"选不同 seed 合成（同文本只合成一次）；
 *   · `build-voice.ps1` 照常转码成多个 mp3；
 *   · 运行时那套**既有的**"按事件轮换"逻辑自动换着播 —— exe 与 host **都不用改**。
 *
 * 这也是那个"静音坑"的正解：seed=42 时某些文本会踩到近乎静音，
 * 而多 seed 变体天然绕开了它（`synth-voice.ps1` 还会额外做静音检测重试）。
 *
 * ⚠️ 只对 `synth` 生效 —— `real` 是官方原声，一句就一条，没法"多录几遍"。
 */
const VARIANTS = 2

function expandVariants (all) {
  const expanded = []
  for (const l of all) {
    expanded.push(l)
    if (l.source !== 'synth') continue
    for (let k = 2; k <= VARIANTS; k++) {
      // ⚠️ 后缀用 `v2` 而不是 `-2`：台词表里本来就有 `click-2` / `thinking-3`
      // 这类**手写编号**，用 `-2` 会撞名（实测 6 处冲突）。
      // `v2` 既不会撞（手写名里没有 `v` 前缀的编号），也保持"纯字母数字 + 连字符"，
      // 在文件名 / URL / 白名单里都最省事。
      expanded.push({ ...l, name: `${l.name}v${k}`, variant: k })
    }
  }
  return expanded
}
const lines = expandVariants(BASE_LINES)

const doc = {
  version: 2,
  _说明: [
    '庄方宜桌宠 · 语音台词表（封闭集合，构建期一次性生成）。',
    '',
    '为什么必须预生成、绝不在运行时合成：实测 synth.py 冷启动 30.6 秒、',
    '热态约 5 秒/句。桌宠要在一秒内回应一次点击 —— 运行时合成等于按了没反应。',
    '所以：构建期把全部台词压成 mp3，运行时只播放。',
    '',
    'source=real  用素材里现成的真人语音（官方配音，最自然）。',
    'source=synth 用 D:\\A\\voiceclone\\synth.py（庄方宜专属音色，e4+e6）。',
    '',
    '── v2 为什么大改（用户反馈台词太奇怪）──────────────────────────────',
    '',
    'v1 的毛病：把官方战斗语音硬套到日常事件上。最刺眼的几条：',
    '  · AI 干完活 →「赢这一次，其实不算很难」（作战胜利）',
    '  · 出错     →「没事，不用管我」（负伤）—— 语义完全相反',
    '  · 聊天回复到达 →「让我想想……」—— 话都说完了才说这句，时序倒置',
    '',
    'v2 的原则：',
    '  1. 语义优先于音源 —— 对不上的就用合成，不要为了用真人原声而错配；',
    '  2. 时序要对 —— 回复到达时说的话，不能是让我想想；',
    '  3. 同一事件多条轮换 —— 高频事件（点击/完成）听多了会腻；',
    '  4. 多带语音（用户要求）—— 覆盖更多时机，而不是只在那 3 个状态里出声。',
    '',
    'name 就是 /pet/voice/<name> 的文件名（白名单，见 routes.js）。',
    'event 是触发时机（exe 侧据此播放）。'
  ],
  lines
}

const out = path.join(__dirname, 'voice-lines.json')

/**
 * ── 语音丰富化：同一句台词生成**多个 seed 变体** ──────────────────────────
 *
 * 用户 2026-10-07："你让音频再丰富一点吧"。
 *
 * 实测同一句换 seed，产出**时长与波形都不同**：
 *
 *     "做完了，你看看。"  seed1=2.58s / seed2=2.06s / seed3=2.42s（sha256 全不同）
 *
 * 那是真实的语气差异（重音、停顿、语调），不是噪声 —— 正是"丰富"的来源。
 *
 * 做法：给每条 `synth` 台词**复制**出 `VARIANTS-1` 个同文本、不同 `name` 的条目
 *（`thinking-1` / `thinking-1-2`）。于是：
 *   · `tools/synth-voice.ps1` 按"第几个变体"选不同 seed 合成（同名文本只合成一次）；
 *   · `build-voice.ps1` 照常转码成多个 mp3；
 *   · 运行时那套**既有的**"按事件轮换"逻辑自动换着播 —— exe 与 host **都不用改**。
 *
 * 这也是那个"静音坑"的正解：seed=42 时某些文本会踩到近乎静音，
 * 而多 seed 变体天然绕开了它（`synth-voice.ps1` 还会额外做静音检测重试）。
 *
 * ⚠️ 只对 `synth` 生效 —— `real` 是官方原声，一句就一条，没法"多录几遍"。
 */

fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8')

const real = lines.filter(l => l.source === 'real').length
const synth = lines.filter(l => l.source === 'synth').length
const names = lines.map(l => l.name)
const dup = names.filter((n, i) => names.indexOf(n) !== i)
const events = {}
for (const l of lines) events[l.event] = (events[l.event] ?? 0) + 1
console.log(`总 ${lines.length} 条 | real ${real} | synth ${synth}`)
console.log('重名:', dup.length ? dup : '无')
console.log('事件覆盖:')
for (const [k, v] of Object.entries(events)) console.log('  ' + k.padEnd(24) + v + ' 条')
