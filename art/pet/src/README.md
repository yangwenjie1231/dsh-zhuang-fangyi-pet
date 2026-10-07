# 素材工作台（`art/pet/src/`）

本目录是**素材管线的输入与暂存区**。产物（精灵条带、气泡池、缩略图、`pet.json`）
全部由 `tools/prepare-pet.py` 自动生成，请勿手改 —— 手改会在下次重跑时被覆盖。

> 📖 **要查"某张图用在哪"**：看生成的 **`docs/素材台账.md`**，或双击
> **`docs/素材看板.html`**（每张图都会动）。
> 这份文件只讲**你需要动手的部分**。

---

## 0. 素材知识只有一处：`assets/catalog.json`

改归属、加素材、改气泡情境 —— **只改台账**（`assets/catalog.json`），然后：

```powershell
& $py tools/prepare-pet.py          # 全量重建（幂等）
```

台账每条素材的形状：

```jsonc
{ "id": "smile",                    // 语义键，全局唯一；产物名 = <state>-<id>.png
  "source": "QQ表情/表情包_07_微笑.gif",  // 相对「庄方宜素材\10-表情包」
  "family": "F1", "role": "body",   // role: body / bubble / anim
  "caption": "平静微笑，日常待机",      // ⭐ 认图结果（看中间帧写的，不是照抄文件名）
  "mood": "calm",
  "states": ["idle"] }              // body 必填；第 1 个是主图；一图一状态
```

- `source` 支持四种前缀：`wx/`、`QQ表情/`、`cutout/`（**你抠的图**）、`新表情包/`。
- 台账里**故意没有** `opaque` / `frames` / `frameWidth` / `minT` —— 这些由管线
  **按指标算**。手写 `opaque` 历史上猜错过 3 张。
- 校验不过会**直接报错退出**（id 重复、源文件不存在、跨状态重复、状态名非法…），
  不会"跳过坏的继续跑" —— 那样会悄悄少几张图，症状要等桌宠少了表情才看得出来。

### 一图一状态

一条素材默认**只服务一个状态**（`states` 里只能有一个）。这不是洁癖：
此前 5 张素材跨 2~3 个状态共用（"微笑"同时出现在 waking/idle/happy），
于是"每个状态的表情都不一样"从根上就不成立，而且没人看得出来。
真要复用就写 `"shared": true`，并想清楚为什么。

---

## 1. 你要动手的部分

### A. 换气泡贴纸 → 覆盖 `cutout\<语义名>.png`

| 文件名 | 说明 |
|---|---|
| `08-love-you.png` … `23-you-are-the-best.png` | 16 张鲨鱼睡衣贴纸（**已就位**） |
| `25-reading.png` | 简笔看书图（**已就位**） |

抠图要求：**透明底 PNG，保留 alpha**。四角与人物轮廓外必须真透明（alpha=0）。
白色残留会在桌面上显出一圈白边。尺寸不限，脚本会等比缩放到 256px。

### B. `raw/` 是你的工作台，脚本**绝不覆盖**它

`src/raw/` 里是 `QQ表情\*.png` 的原图（0% 不透明），你**正是在那里抠图的**。
所以脚本对它只在**目标不存在时**写入；已有文件一律不动。
要强制重刷（**会丢掉你在 raw/ 里的改动**）：

```powershell
& $py tools/prepare-pet.py --refresh-raw
```

> 如果你的抠图只放在 `raw/` 里，请**同时**复制一份到 `cutout/` ——
> 管线只从 `cutout/` 取图。

---

## 2. 命令速查

```powershell
$py = 'C:\Users\A\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'

& $py tools/prepare-pet.py                  # 全量重建（幂等，不碰 raw/）
& $py tools/prepare-pet.py --check          # 只报台账与覆盖率，不写文件
& $py tools/prepare-pet.py --audit          # 一致性审计；有问题退出码 1
& $py tools/prepare-pet.py --clean          # 重建前清掉 art/pet 下的旧产物
& $py tools/prepare-pet.py --refresh-raw    # ⚠️ 覆盖 raw/ 里的抠图

node tools/build-asset-review.mjs           # 重新生成 docs/素材看板.html
node tools/gen-voice-lines.cjs              # 重新生成 tools/voice-lines.json + docs/语音台账.md
node tools/test-pet-assets.mjs              # 台账 ↔ 产物 ↔ 清单 一致性测试
```

---

## 3. 产物（自动生成，勿手改）

| 路径 | 内容 |
|---|---|
| `art\pet\<state>-<id>.png` | 状态精灵条带（**主体**）。文件名带语义 id：看得懂、测得准 |
| `art\pet\thumbs\<state>.png` | 48px 缩略图（UI 预览用） |
| `art\pet\bubble\…<id>.png` | 气泡表情池（≤256px，1:1 不裁切） |
| `art\pet\pet.json` | **素材清单**（契约 §4，Host 与 exe 的唯一契约） |
| `src\png\` `src\gif\` | 源素材暂存（按内容幂等刷新） |
| `src\raw\` | **你的工作台**（只写不覆盖） |
| `src\cutout\` | **取图来源**（你抠好的图） |

**单帧不是方的**：各素材 bbox 纵横比不同（0.85~1.13），帧高统一 256 后，
单帧宽落在 **239~288**。所以清单为每个文件写出 `frameWidth`（契约 §4 必需字段）。
条带宽 = `frames × frameWidth`，**不是** `frames × frameHeight`。

`pet.json` 的 `assets` 段是**身份映射**（产物路径 → 语义 id / 画面说明），
纯附加字段，旧消费者忽略也能跑。它的存在让"这张图画的是什么"有据可查，
也让测试能**按名字断言归属**（此前只能数张数 —— 素材一换版就红，
且看不出哪张挪去了哪）。

---

## 4. 不再作为门槛的两条判据（用户决定，**别加回来**）

1. **不透明度**：`minT%`（全部帧里最小的完全透明像素占比）照样算、照样进报告，
   但**不再据此排除任何素材**。原话："透不透明影响不大呀，背景又不是无意义"。
   （`muscle` 明黄满幅底、`sunglasses` 眼睛特写满幅都在用。）
2. **画风家族**：F2/F3 不得当主体、F5 不得当气泡 —— 这类判断**已由用户推翻**。
   现在 `role` 直接写明这张图当什么用，风格判断不再由脚本猜。

---

## 5. 已弃用与已解决（别再翻旧账）

| 事项 | 结论 |
|---|---|
| 根目录 6 张单帧 GIF（`1.gif`、`88401DDC….gif` 等） | 与 `wx\*.png` 重复，弃用 |
| `05_星空公式` 的"待抠背景"问题 | 不抠：它是**思考主体**（满屏公式就是画面内容） |
| 深色模式变体（`-dark.png`） | **已废弃**：白纸墨线翻明度 = 底片，观感诡异。深色模式直接用原图 |
| `listening` 状态 | 保留在契约 §1 的值域里（向后兼容），但**运行时不再产出** —— 它只有 1.2 秒闩锁、优先级又低于 thinking，实际几乎不作为主体出现。收到消息现在只弹气泡 |
| 主体素材的"待抠清单" | 已清空：不透明度判据取消后没有"做不了主体"的素材了 |