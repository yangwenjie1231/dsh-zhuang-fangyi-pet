# dsh-zhuang-fangyi-pet · 庄方宜桌宠

**真的浮在桌面上的桌宠** —— 不是一个待在 DSH 窗口里的悬浮层。

表情随 agent 的实时状态变化（思考 / 调工具 / 等你审批 / 完成 / 出错 / 睡觉…），
气泡用**表情图 + 文字**把其余表情也带出来。零安装运行时，跨平台自动回落窗口内。

> 官方素材，非官方同人作品。

---

## 一、它和 `dsh-zhuang-fangyi`（主题插件）的关系

**零耦合，各自独立。**

| | 主题插件 | 桌宠 |
|---|---|---|
| 包名 | `dsh-zhuang-fangyi` | `dsh-zhuang-fangyi-pet` |
| 设置 | `$DSH_HOME/zhuang-fangyi/settings.json` | `$DSH_HOME/zhuang-fangyi-pet/settings.json` |
| 路由 | `/api/zhuang-fangyi/*` | `/api/zhuang-fangyi/pet/*` |
| 依赖对方？ | 否 | 否 |

可以只装桌宠不装主题。桌宠会读主题写在 CSS 变量上的配色（`--dsw-alias-*`）做联动，
**但不读主题的设置文件** —— 那是实现细节，会锁死两个插件的版本关系。

---

## 二、为什么能浮在桌面上（而不只是窗口内）

原先的调研把候选限定为「窗口内 overlay / 自带 Electron / Tauri / 借主进程开窗 / koffi」，
于是得出「只能待在窗口内」。**这个选择集漏了最优解**：

> 由插件宿主用官方 `ctx.subprocess` 接缝，启动一个**我们自己编译的 .NET Framework 4.8 小 exe**，
> 由它自建无边框 + 透明 + 置顶 + **alpha 点击穿透**的窗口，经 HTTP/SSE 连回宿主拿状态。

| 维度 | 窗口内 overlay | 自带 Electron | **本方案（net48 小 exe）** |
|---|---|---|---|
| 浮在桌面 | ❌ | ✅ | ✅ |
| 额外内存 | 0 | +80~150 MB | ~50 MB |
| 交付体积 | 0 | 一整个 Electron | **~12 KB 空壳** |
| 需装运行时 | — | 需打包 | **不需要**（net48 是 Win10 1903+/Win11 自带） |
| 需联网构建 | — | — | **不需要**（离线编译已验证） |
| 跨平台 | ✅ 全平台 | 差 | Windows 优先；其它平台回落 overlay |

**关键：这不碰 DSH 的主进程 IPC 白名单。** 那条白名单限制的是"让 DSH 替我开窗"，
不限制"我自己 spawn 一个进程"。用的是官方受管的子进程接缝（服务 dispose 时会自动
终止受管进程，所以关掉 DSH 不会留孤儿）。

### 它怎么知道该摆什么表情（零桥接）

桌宠**不需要任何人转发状态**，宿主自己就能读到：

- 宿主在**根 Context** 上监听 `agent/status` / `session/event` / `agent/error` 等事件；
- `@deepseek-ai/dsh-scope` 的作用域过滤器对**无 tag 的根监听者一律放行**，
  所以根监听者能收到**全部**会话的事件 —— 不需要按会话 `retain()`，
  因此也不存在引用计数泄漏（这是原设计文档担心的头号风险）。
- `session/event` 里的 `turn/end` 带 `reason.kind`（`completed` / `error` /
  `max-tokens` / `aborted`…），这正是"完成"与"出错"的权威来源。

**绝不读会话消息正文** —— 只消费事件元数据与 `reason.kind`。

---

## 三、安装

> **`.ps1` 一律用 UTF-8 **with BOM**。** 本机同时有 Windows PowerShell 5.1 与
> `pwsh` 7.6.6，而 5.1 会把**无 BOM** 的 UTF-8 `.ps1` 当 ANSI/GBK 解码，
> 中文注释会让脚本**语法都过不了**。用 `powershell -NoProfile -File ...` 调 5.1
> 时尤其要注意（`edit`/`write` 工具会剥掉 BOM，改完脚本要确认 BOM 还在）。

```powershell
# 1. 编译原生窗口（离线，只需系统自带的 .NET Framework 4.8）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-pet.ps1

# 2. 装进 profile（与主题插件同样的做法）
dsh plugin --profile desktop add <本目录的绝对路径>

# 3. 部署（会一起搬运 exe 与素材）
powershell -NoProfile -File tools\deploy.ps1

# 4. 重载
#    plugin_manager set_plugin target=include:zhuang-fangyi-pet enabled=false → true
```

**没有 exe 也能用**：桌宠会自动回落到窗口内悬浮层（`shell.overlay`），
`/api/zhuang-fangyi/pet/diag` 会给出确切原因。

> ### ⚠️ v2：窗口内 overlay 已**冻结**，不再补新功能
>
> 起因是**维护成本实测**：历史上 **12 次提交**是"两半边必须同步"的税，
> 而 overlay 这半边还要额外维护 464 行 CSS、自己判断主题、自己存位置，
> 以及一堆 DSH 内部知识（`position:fixed` 绕 grid 自动放置、
> `pointer-events:auto` 陷阱、`z-index:20` 上限）。
> 最严重的一次真机事故（客户端整片崩溃、设置页空白**且不报错**）
> **只可能发生在 overlay 上** —— 原生窗根本没有 slot 机制可崩。
>
> 决定性事实：**DSH 的 webServer 只绑 loopback**（实测 `127.0.0.1:19387`），
> 所以"用网页版"的用户 DSH 也在本地跑，exe 永远连得上。
>
> 所以 `mode` 的默认值从 `auto` 改为 `native`（语义不变：**优先**桌面窗，
> exe 不可用时**仍回落** overlay —— 逃生舱留着，否则非 Windows 或
> exe 被杀软拦的机器上，用户会看到"什么都没有，也不报错"）。
> 旧设置文件里的 `auto` 会**自动归一化成 `native`**，不会丢配置。
>
> **overlay 从此只修 bug、不加功能。** 它缺的这四项是有意为之：
>
> | 功能 | 桌面窗 | 窗口内 overlay |
> |---|---|---|
> | 滚轮缩放 / 右键菜单 / 表情包画廊 / 托盘 | ✓ | **✗ 冻结** |
> | 拖动 / 穿透 / 气泡 / 状态文字 / ✎ 发消息 / 双击 | ✓ | ✓ |

---

## 四、素材：PNG 优先，抠图交给你

素材来源 `庄方宜素材\10-表情包\` 与 `fromQQ\新表情包\`，分四类：

| 类别 | 文件 | 处置 |
|---|---|---|
| **已透明 PNG** | `wx\*.png`（8 张，240×240） | **首选**，直接用 |
| **已透明 GIF** | `QQ表情\*.gif` 中干净的 **10 张** | 本体动画 |
| **已抠图** | `cutout\`（17 张，1000×1000） | ✅ **已全部进池**（`bubble/08…25`） |
| **黑白线稿贴纸** | `fromQQ\新表情包\庄方宜(未扣背景)\*.png`（20 张） | ✅ **已进池**（`bubble/new/*`） |

### 哪些 GIF 能用，哪些不能用

判据是**逐帧统计「alpha==0 的像素占比」** —— 因为桌宠的硬要求是
「**任何一帧都不能铺满不透明像素**」，否则播放到那一帧会出现一个矩形色块。

```
干净（10 张，可用）：01 02 03 04 06 07 24 26 28 29
有实心帧（2 张，排除）：05_星空公式（33/33 帧实心）、27_生气指人（10/18 帧实心）
```

> 这个判据是踩过坑才定下来的：bbox 会被"主体画到画面边缘"骗，
> 洋红透过率会被"主体占满宽度"骗（02/26/29 都曾被误判为脏）。
> 只有逐帧透明占比能直接回答"这一帧会不会显示成一个块"。

### 当前素材状态

**17 张手动抠图已全部完成并进池**（`art/pet/src/cutout/` → `bubble/08…25`）。
`pet.json` 的 `missing` 只剩 **2 项**，都卡在同一件事上：

```
表情包_05_星空公式.gif   33/33 帧铺满不透明 → 播放会出现矩形块
表情包_27_生气指人.gif   10/18 帧铺满不透明 → 同上
```

这两张是**动画**，不能像静态图那样只抠一张 —— 要**逐帧**抠（33 帧 / 18 帧），
成本比静态图高得多，所以一直挂着。**不做也不影响使用**：41 张气泡表情已覆盖
全部 12 个情境池，9/9 状态都有主素材。

### 还想加图的话

抠好后**保留 alpha**（RGBA PNG，**不要 flatten、不要贴白底** —— 否则透明区
残留 RGB 会变成彩色噪点），放进 `art/pet/src/cutout/`。

⚠️ **只丢文件进去是没用的** —— 管线按**显式表**收录，不扫目录。两种用途：

```
art/pet/src/cutout/
  state-sleeping.png    ← 覆盖该状态的主素材（`state-` 前缀，不会被当气泡图）
  state-happy-2.png     ← 该状态的轮换变体
  26-new-emote.png      ← 气泡表情，但**必须**在 prepare-pet.py 里登记
```

气泡表情要在 `tools/prepare-pet.py` 的表里加一行，**并且显式写 `hasText`**：

```python
BUBBLE_F2 = (
    ...
    ('new-emote', '26-new-emote.png', True),   # (语义名, 文件名, 图里是否自带文字)
)
```

`hasText` **不能猜**：写 `True` 表示"文字已印在图上"，Host 就不会再叠一句
（否则屏幕上会出现两段互相打架的文字）；不在表里的一律按 `False`。

然后重跑管线并重载：

```powershell
python tools/prepare-pet.py
# 然后在 DSH 里 POST /api/zhuang-fangyi/pet/command  {"command":"reload-art"}
```

详细规则见 `art/pet/src/README.md`。

### ⚠️ 变体几何：`pet.json` 的 `files` 映射

`variants` 里的素材**几何差异极大** —— 它混了「静态 PNG（1 帧）」与
「动态 GIF（N 帧）」。实测 24 个变体里 **14 个**与所属状态的声明不符：

```
happy 声明 33帧 × 256px，但 happy-2 = 274px（1 帧）、happy-4 = 239px（1 帧）
```

若按状态的 `frames` 去切变体，`happy-4.png` 会变成 `239/33 = 7px` 的**碎条**。

所以 `pet.json` 有一个顶层 **`files` 映射**，给**每个文件自己的**几何：

```jsonc
"files": {
  "happy.png":   { "frames": 33, "frameWidth": 256, "frameMs": 30 },
  "happy-2.png": { "frames": 1,  "frameWidth": 274, "frameMs": 0  }
}
```

**几何解析优先级**（Host / exe / overlay 三方统一）：

```
files[<文件名>]  →  states[<state>]  →  图片实测（naturalWidth / frames）
```

`files` 缺失时自动回落后两级，**旧清单仍可用**。

---

## 五、状态机

| 状态 | 触发 |
|---|---|
| `waking` | 插件加载后的亮相（~1.5s，有真实活动即提前结束） |
| `idle` | 默认 |
| `listening` | 收到用户消息 / 新消息入队 |
| `thinking` | `agent/status→running` 且无在飞工具 |
| `working` | `tool/call` 在飞（按 `callId` 去重计数） |
| `waiting` | 在等你审批 |
| `happy` | `turn/end` 且 `reason.kind === 'completed'` |
| `error` | `agent/error` / `api-session/error` / `turn/end` 失败 |
| `sleeping` | 全局空闲超过设定时长 |

**优先级**（跨会话取最大者，表现"最需要被看到"的那个会话）：

```
working(90) > waiting(80) > thinking(70) > error(60)
           > happy(50) > listening(40) > waking(30) > idle(20) > sleeping(10)
```

两个刻意的排序，都有依据：

- **`error` 低于 `thinking`/`waiting`** —— 实现"历史错误不该覆盖当前回合"。
  配合"`running` 会清除该会话的错误闩锁"，`error` 只在该会话**真的停在错误上**时生效。
  否则一次失败之后桌宠会一直生气，与外壳行为不一致。
- **`waiting` 高于 `thinking`** —— 被审批卡住的会话最该被看到，
  否则它看起来只是"在忙"。

**常亮提醒（attention，契约 §2）**：状态之上的另一层。`approval/asked`（等审批）
或 `ask_user_question`（等你回答）期间，气泡**一直亮着直到处理完**，
不受 `bubbleMs` 影响；`approval` 压过 `question`，同时多处待处理显示计数徽标。
兜底上限 30 分钟（超时自动放下，绝不永久钉死）。设置项
`attentionReminder` 独立于 `bubble` 总开关 —— 关普通气泡不等于不要审批提醒。

---

## 六、配置

设置页在 DSH 的「外观」里，或直接改
`$DSH_HOME/zhuang-fangyi-pet/settings.json`：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `mode` | `'native'` | `native`（桌面窗为主，exe 不可用时回落）/ `overlay`（只在窗口内） |
| `scale` | `1.0` | 大小，0.3~3.0（设置页滑杆、滚轮缩放、exe 三处同范围） |
| `opacity` | `1.0` | 不透明度，0.3~1.0 |
| `topmost` | `true` | 总在最前 |
| `clickThrough` | `false` | 整窗穿透（纯装饰） |
| `bubble` | `true` | 气泡总开关 |
| `bubbleImages` | `true` | 气泡是否显示表情图 |
| `bubbleMs` | `6000` | 气泡一次显示多久（1~20s） |
| `bubbleGapMs` | `8000` | 两条气泡最小间隔（0~60s，0=不限） |
| `notifyComplete` | `true` | AI 完成一回合时强制弹一条提醒 |
| `attentionReminder` | `true` | **授权/提问常亮提醒**（气泡一直亮到处理完；独立于 `bubble`） |
| `activity` | `'normal'` | 活跃度：`quiet` 安静 / `normal` 正常 / `playful` 调皮 |
| `doubleClick` | `'focus-dsh'` | 双击桌宠：`focus-dsh` / `emote` 换表情 / `none` |
| `theme` | `'auto'` | **气泡外壳**的深浅色：`auto` / `light` / `dark`（**不影响表情图本身**，见下） |
| `hint` / `statusAlways` | `true` / `false` | 悬停显示状态 / 桌宠下方常显状态（**原生窗与窗口内 overlay 都生效**） |
| `happyMs` | `3000` | "完成"开心多久 |
| `sleepMs` | `300000` | 空闲多久后睡觉 |
| `x` / `y` | `null` | **仅原生窗口**的位置 |

> `x`/`y` **只属于原生窗口**。窗口内 overlay 用视口坐标、原生窗用桌面坐标，
> 混写同一组字段会互相覆盖导致位置乱跳 —— 所以 overlay 自己记 `localStorage`。

> **`theme` 改的是气泡外壳，不是表情图。** 深色模式**直接用原图**，
> 不再生成单独的深色表情包 —— 用户实测反馈"反转太诡异了，直接原图还挺好的"。
>
> 原因是结构性的，调算法救不回来：那批黑白线稿贴纸是**白纸上的墨线**，
> 白色不只是背景、**还是脸和衣服的填充色**。翻明度之后整张脸变黑、
> 只有轮廓发白 —— 那是**底片**（照片负像），不是"深色贴纸"。
> 人眼对"脸是黑的"极度敏感，所以一眼就不对。
>
> 契约 §4 的 `fileDark` 字段**保留**（可选、缺省即"用原图"），
> 所以旧清单与新清单两侧消费者都能正确解析 —— 删字段会破坏向后兼容。

---

## 七、交互

- **拖动**：按住桌宠拖到任意位置，重启后保持（拖出屏幕会被夹回工作区）。
- **滚轮缩放**：鼠标悬停在桌宠上直接滚轮缩放（0.3×~3×，去抖后持久化）。
- **双击**：默认唤起并前置 DSH 主窗口（可在设置里换成"换一个随机表情"或"什么都不做"）。
- **悬停 ✎**：鼠标移到桌宠上出现小 ✎ 按钮，点开输入条**直接给会话发消息**
  （排队语义，不打断当前回合；宿主没提供发消息能力时不显示这个入口）。
- **透明处点击穿透**：鼠标能点到桌宠"身后"的桌面图标与窗口 ——
  这是靠 `WM_NCHITTEST` 按像素 alpha 判定的（已实测）。
- **授权/提问常亮提醒**：AI 要你审批或回答问题时，气泡常亮到你处理完；
  桌面窗口版带「去处理」按钮一键聚焦 DSH（overlay 用户已在 DSH 内，不加按钮）。
- **状态显示**：桌宠下方显示当前状态（待机中 / 正在思考… / 在等你审批）。
  默认**悬停时**显示；设置里可改成**常驻下方**或完全关闭。
  托盘「显示状态」也能随时切（开着点击穿透时本体收不到鼠标，托盘是唯一入口）。
- **表情包画廊**：右键桌宠 →「表情包…」（或托盘）→ 网格铺开**全部表情**，
  点一张立刻用它当气泡。此前表情只能靠状态变化被动随机撒，看不到全貌。
- **表情结合状态**：气泡表情按情境挑 —— 出错配生气、完成配庆祝、干活配摸鱼，
  不再随机乱撒（映射表见 `src/pet/emotes.js`）。
- **指定对话发送**：✎ 输入条上方有「发给」下拉（多个对话时才出现），
  按**项目分组**、在跑的带圆点、同名带短 id 消歧。
- **托盘图标**：显示/隐藏、点击穿透开关、缩放档位、状态显示、深浅色主题、表情包、
  番茄钟、语音、重置位置、退出。
- **右键桌宠**：互动（摸摸头 / 投喂 / 夸奖）、好感度、切换表情预览、打开 DSH 窗口、隐藏。

### v3 新增

- **番茄钟**：25 分专注 → 5 分短休 →（每 4 轮）15 分长休。倒计时显示在桌宠下方，
  阶段结束时气泡 + 表情 + 语音提醒。托盘或设置页都能开始/暂停/跳过。
  **默认关闭** —— 装完就自己开始 25 分钟倒计时是骚扰，不是功能。
  跨重启会接着走（停机超过本阶段时长的按"作废本轮、从头开始"处理，不补发提醒）。
- **语音**：点击、完成、出错、番茄钟到点时播一句。**默认关闭**（突然出声容易吓人）。
  19 条台词里 **13 条是官方原声**（`新素材/音频/语音合集_分条`）—— 那批素材里有几条
  简直是为这个功能写的：「休整」正好是番茄钟该休息了、「危险提醒」0.71 秒正适合报错。
  ⚠️ **运行时绝不合成**：实测 GPT-SoVITS 冷启动 30.6 秒、热态 5 秒/句，
  而桌宠要在一秒内回应点击 —— 所以台词是封闭集合，构建期压成 mp3（412KB），运行时只播。
- **互动与好感度**：点一下桌宠、右键摸摸头/投喂/夸奖，会累积好感度（四档：
  初识 / 熟悉 / 亲近 / 信赖）。防刷有三道闸：冷却、边际递减、每日上限 + 跨天重置。
  **冷却中仍然有反应**（只是不涨分）—— 点了没反应比没涨分更像坏了。
- **聊天**：✎ 输入条多了「聊天 / 指定对话」两种投递目标。聊天走**真实 DSH 会话**
  （专用工作区 `~/Downloads/庄方宜`），所以你能在 DSH 界面里看到这段对话、
  接着聊、翻历史 —— 而不是一个藏在桌宠里的黑盒。回复会显示在桌宠气泡里。
- **可切换人设（加法）**：人设 = **共享背景** + **语言风格**。
  - `personas/shared/*.md` 是共享背景（世界观、身份、称呼、背景锚点、行为准则），
    按文件名序**全部拼接**在每种风格前面 —— **改一次，所有风格一起变**；
  - `personas/<风格>.md` 只写"她怎么说话"（语气、用词、句法、禁忌、口头禅、场景示例）；
  - 设置页里能看到共享背景的文件清单、当前风格拼了几份，也能一键重新扫描；
  - 没有 `shared/` 目录时行为完全不变（旧式自包含人设兼容）。
  - 切换 = 把组合后的文本作为系统提示词 section 挂到聊天会话上。
  ⚠️ **绝不覆盖你手写的 `AGENTS.md`**：判据是"插件标记必须在第一行"，
  没有标记就说明那是你的文件，插件会拒绝并如实报错。
- **念出 AI 的回答（动态语音）**：接独立的合成子插件
  （[`dsh-zhuang-fangyi-voice`](../dsh-zhuang-fangyi-voice)，HTTP `POST /tts`），
  把回复**清洗成可朗读文本**（去代码块/链接/markdown/emoji）后合成播放。
  异步：气泡先显示文字、语音好了再播；服务不在就**退回固定台词**，聊天不受影响。
  设置页有「试一句」按钮直接验证子插件通没通。见 `docs/语音子插件对接.md`。
- **跨会话共享的长期记忆**：`$DSH_HOME/zhuang-fangyi-pet/memory.md`，
  以 `zf-pet:memory` section 注入到**每个**聊天会话 —— 换会话、重开会话都不会失忆。
  每次回复后可用宿主默认模型**自动提炼** 0~3 条值得长期记住的事
  （称呼、项目、约定…）追加进去；文件超 24KB 时裁掉**最旧**的行。
  设置页里可以直接编辑这份记忆（整体替换，空串 = 清空）。

---

## 八、开发

```
src/pet/state.js      纯函数状态机（9 状态 + 气泡），唯一真相
src/pet/events.js     DSH 事件 → 状态机信封（唯一翻译点）
src/pet/atlas.js      素材清单加载 + URL 白名单（唯一素材入口）
src/pet/hub.js        SSE 推送
src/pet/routes.js     /pet/* 路由 + 三道围栏
src/pet/launcher.js   exe 启动 / 观测 / 终止
src/pet/pomodoro.js   番茄钟（纯逻辑 + 假时钟可测）
src/pet/voice.js      语音白名单（只读清单，运行时绝不合成）
src/pet/interactions.js  互动与好感度（防刷三道闸）
src/pet/persona.js    人设（可切换，绝不覆盖用户手写的 AGENTS.md）
src/pet/chat.js       聊天记账与回复解析（真实会话，不另起 LLM）
pet/*.cs              原生窗口（C# / WPF / net48）
client.js             窗口内 overlay 兜底 + 设置页
tools/prepare-pet.py  素材管线
tools/build-voice.ps1 语音包构建（官方原声优先，合成补缺）
tools/build-pet.ps1   离线编译 exe
```

### 测试

```powershell
node tools/test-pet-state.mjs        # 状态机 + 事件翻译 + 素材清单（162 项）
node tools/test-pet-route.mjs        # 路由 + 三道安全围栏 + SSE 帧格式（98 项）
node tools/test-pet-client.mjs       # 浏览器半边 + 渲染约束 + 外壳真实 props（85 项）
node tools/test-pet-e2e.mjs          # 真实装配端到端（47 项）
node tools/test-pet-pomodoro.mjs     # 番茄钟（假时钟跑完整 4 轮循环）（45 项）
node tools/test-pet-voice.mjs        # 语音白名单 + 清单/磁盘一致性（32 项）
node tools/test-pet-interactions.mjs # 互动防刷三道闸（27 项）
node tools/test-pet-chat.mjs         # 加法人设 + 写入安全 + 回复解析（50 项）
node tools/test-pet-memory.mjs       # 长期记忆：解析/裁剪/文件 IO（21 项）
node tools/test-pet-tts.mjs          # 动态语音：清洗/WAV 解析/客户端容错（40 项）
node tools/test-pet-native-e2e.mjs   # 真起 exe、真连宿主的集成测试（12 项）
bin\dsh-zhuang-fangyi-pet.exe --selftest --dark 0   # exe 自检（173 项）
```

十一套共 **654 项断言** + exe 自检 **173 项**，无框架依赖（纯 `node:assert`）。
端到端那套用**真实** `apply()` + **真实** `pet.json` + 真读 SSE 帧，
验证「宿主事件 → 状态机 → 推送」整条链路；
`native-e2e` 那套更进一步 —— 用真实 `index.js` 起宿主、经 `ctx.subprocess`
**真实 spawn exe**，断言 exe 真的连上了、真的拉到了语音清单与番茄钟块。
它堵住的是前三套测不到的盲区：「两边各自都对、接起来不对」——
而这正是本项目历史上最常见、最难查的一类缺陷（502 那次就是）。

### 回退验证（这个项目的核心纪律）

**每条新断言都要先证明它能失败。** 具体做法：把被测的守卫/逻辑临时改坏
（探针），确认断言真的报红，再还原。本轮 v3 共做了 **~70 次**回退验证，
抓出的问题分三类：

1. **假守卫**（代码里有、实际从没参与判定）：
   番茄钟的 `firedFor` 去重标记 —— 把它换成常量，43 条断言全绿。
   真正的守卫是 `enter()` 把剩余时间重置为整段。假守卫比没有守卫更危险：
   它会让人以为删掉真守卫也没事。已删，注释改成指向真守卫。
2. **假断言**（断言测的是别的东西）：
   · 路由白名单那条原本断言"非法动作返回 400"，但删掉白名单后测试照样全绿 ——
     因为 `do()` 对未知动作返回 null，第二个检查把 400 补上了。
     改法：让测试记录**每一个到达内部的动作串**，断言"非法的从没见过、合法的确实到过"。
   · "空字节不播"那条删掉守卫后仍通过 —— `File.WriteAllBytes(path, null)`
     会抛、被 catch 兜住又返回 false。那是巧合式安全。
     改法：断言**独立可观测的差别**（节流表里没有记录 = 在碰状态之前就被挡下）。
3. **探针自身的假阴性**：exe 是 `-target:winexe`，
   PowerShell 的 `$out = & exe` **抓到 0 行输出**，于是每条探针都"通过"。
   换 `cmd /c "... > 文件"` 才拿到 21373 字符。
   **验证工具本身也要先验证**（喂一个已知会失败的探针，确认它真的报红）。

这套纪律本轮抓出的**真实缺陷**（不是测试问题，是代码问题）：
语音路由的绝对路径穿越（`C:\Windows\win.ini` 绕过 `startsWith(root)`）、
互动配置的原型污染（`INTERACT_CONFIG['__proto__']` 返回 `Object.prototype`）、
番茄钟时长三方口径不一致（模块 30s vs 设置 60s）、
好感度档位永远升不上去（递减序列以 0 结尾 → 一天最多 12 分，门槛却是 20）。

> **测组件必须用「外壳真实的调用形状」。** 真机上炸过一次：测试一直写
> `Pet({ runtime })`，而外壳渲染 slot 条目时传的是
> `{ ...kit, ...entry.inject, ...slotInjected.props, ...ownerProps }` —— **没有 `runtime`**。
> 于是测试绿、真机上条目一渲染就抛错并被外壳 `abdicate`（逐出单元格），
> 症状是桌宠不出现 + 设置页空白且不报错。现在 `test-pet-client.mjs` 的第 7b 节
> 专门按外壳的形状（`Pet({})`、`Section({ close })`）断言。

### 两道接口契约

改任何跨半边的东西前，先读 **`docs/接口契约.md`** —— 它是
Host / exe / overlay 三方之间的唯一契约（状态名、快照 payload、SSE 帧格式、
HTTP 路由、`pet.json` schema、exe argv 与退出码）。改契约要先改文档再改三方。

### 两个容易踩的坑

1. **改了 `index.js` / `src/*.js` 后，disable→enable 不够。** 宿主进程缓存 ESM 模块，
   重载只重跑 `apply()`，不会重新 `import` 依赖模块。用
   `GET /api/zhuang-fangyi/pet/diag` 的 `build` 字段确认跑的是哪一版；不匹配就重启 DSH。
2. **`.ps1` 必须是 UTF-8 with BOM。** 本机 shell 是 Windows PowerShell 5.1，
   它把无 BOM 的 UTF-8 当 ANSI/GBK 解码，中文注释会让脚本**语法都过不了**。

---

## 九、安全

三道围栏，各管一件事：

1. **准入**：令牌 **或** 同源信任围栏。原生 exe 带令牌；浏览器半边带不了
   （`EventSource` 不允许设置请求头），所以走围栏（仅 loopback Host、
   拒 cross-site、Origin/Referer 同 authority）。
2. **一次性令牌**：每次启动 exe 随机生成、经 argv 传递、**不落盘**、常量时间比较。
3. **素材白名单**：由 `pet.json` 派生，绝不拼接客户端路径，并二次校验
   `path.resolve` 仍在 `art/pet` 内（防目录遍历）。

**诚实说明边界**：围栏挡的是**网页**（跨站读取 / DNS 重绑定）。
它**挡不住本机任意进程**（任何进程都能伪造 loopback Host）。这与本 profile 的
既有事实一致（主题插件的路由本来就是无令牌、仅靠 loopback 暴露的），
而桌宠快照**不含任何消息正文**，只有 `thinking/working/…` 这类状态词。

---

## 十、已知限制

- **非 Windows 平台只有窗口内 overlay**（原生窗本版本只做 Windows）。
- **exe 未签名**，首次运行可能被 SmartScreen 拦一次。
- 需要 Windows 10 1903+ / Windows 11（net48 自带）。更老的系统需自行安装 .NET Framework 4.8。
- `turn/end` 是 post-commit 事件，状态有毫秒级延迟（对表现无影响）。

---

## 许可

MIT。素材版权归原作者/发行方所有，本插件仅作本地展示用途。