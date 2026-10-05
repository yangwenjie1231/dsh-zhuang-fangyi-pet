# 桌宠素材 · 角色划分与手动抠图指南

本目录是**素材管线**的输入与输出所在。`art/pet/` 下的精灵条带、气泡池、缩略图与
`pet.json` 清单全部由 `tools/prepare-pet.py` **自动生成**，请勿手改 ——
手改会在下次重跑时被覆盖。

**抠图由你手动完成**：脚本绝不键控背景、绝不 `flatten()`、绝不动你的源图。

---

## 0. 素材有三个家族，分两个角色（**先读这段**）

素材实测有**三个风格家族**。脚本按一个关键语义信号 ——
「**文字是否 baked-in 印在图上**」—— 把它们分到两个角色：

| 家族 | 画面 | 张数 | 角色 | `hasText` |
|---|---|---|---|---|
| **F1** | 细笔触半身像 · 深色作战服 · **无文字** | `gif 01/02/03/04/06/07` + `wx 1..8` = 14 张 | **主体**（`states`） | — |
| **F2** | 鲨鱼睡衣贴纸 · **中文印在图上** | 你抠好的 `08`~`23` = 16 张 | **表情包**（`bubble`） | `true` |
| **F3** | 简笔场景 · 无文字 · 风格自成一派 | `gif 24/26/28/29` + 你抠的 `25_看书` = 5 张 | **表情包**（`bubble`） | `false` |

```
主体（states）  ← 只用 F1        gif:01 02 03 04 06 07  +  wx 1..8
表情包（bubble）← F2 + F3        16 张贴纸 + 4 张 F3 GIF + 25_看书 = 21 张
```

### 为什么 F2 只能当表情包，不能当主体

F2 每张都 **baked-in 一句中文**（"晚安啦""工作中…""爱你哦"）。后果有两层：

1. **当主体** → 桌宠会**永远挂着同一句话**。`working` 状态顶着一张"晚安啦"，
   或者 `idle` 顶着"好气人哦"，语义直接打架。
2. **当气泡时若再叠 Host 文字** → Host 会推 `bubble.text`（"正在调用工具…"），
   于是屏幕上**同时出现两段文字**（图里的 + Host 的），互相打架。

第 2 条正是契约 §4 新增 `bubble[].hasText` 的原因。规则（契约已冻结）：

> **`hasText === true` 的气泡图，`kind` 必须是 `'image'`（不叠文字）**；
> `hasText === false` 的图可以配文字，`kind` 取 `'both'`。

同理，**F1 不进气泡池** —— 它已经是主体，在气泡里重复出现没有意义；
**F2/F3 不进 `states`** —— 风格会跳。

### `hasText` 是怎么定的

**显式表**，不靠对图像做 OCR 或猜测（见 `tools/prepare-pet.py` 的
`BUBBLE_F2` / `BUBBLE_F3` / `CUTOUT_EXTRA`）：

| 素材 | `hasText` | 理由 |
|---|---|---|
| 你抠的 `08`~`23`（16 张） | `true` | 每张都印着中文 |
| `25_看书` | `false` | 简笔，无文字 |
| F3 的 `gif 24/26/28/29` | `false` | 简笔场景，无文字 |
| **未知 / 新增文件** | **`false`（默认）** | 安全侧：允许 Host 配文字 |

> 以后加新贴纸，请把 `hasText` 显式登记进上面的表；不登记就会按 `false` 进池，
> 于是 Host 可能往一张自带文字的图上再叠一句。

---

## 1. 你要做什么

### A. 气泡贴纸（F2/F3）→ 放进 `cutout\`，**按语义名命名**

```
dsh-zhuang-fangyi-pet\art\pet\src\cutout\
```

| 文件名 | 对应 |
|---|---|
| `08-love-you.png` … `23-you-are-the-best.png` | F2 的 16 张贴纸（**已就位**） |
| `25-reading.png` | F3 的简笔看书图（**已就位**） |

这 17 张**已经在 `cutout\` 里了**，无需再做任何事。要换某张，覆盖同名文件后重跑脚本。

### B. 给某个状态换主体（可选逃生通道）→ `state-<状态名>.png`

如果你想给某个状态手动指定 F1 之外的图（**请确认风格仍是 F1**）：

| 文件名 | 作用 |
|---|---|
| `state-idle.png` | 覆盖 `idle` 的主变体 |
| `state-idle-2.png`、`state-idle-3.png` | 同状态的轮换变体（契约 `variants`） |

9 个合法状态名：
`waking` `idle` `listening` `thinking` `working` `waiting` `happy` `error` `sleeping`

> 用 `state-` 前缀是为了**不与气泡贴纸的语义名冲突**（`cutout\` 里主要装 F2/F3）。

### 抠图要求

- **透明底 PNG，保留 alpha**。四角与人物轮廓外必须真透明（alpha=0）。
- **尺寸不限**，脚本会等比缩放到帧高 256px（保持长宽比，只裁四周全透明留白）。
- **不要贴白底、不要 flatten**。透明区残留白色 RGB 会在桌面上显出一圈白边。

---

## 2. ⚠️ `src\raw\` 是你的工作台，脚本**绝不覆盖**它

`src\raw\` 里存的是 `QQ表情\*.png` 的**原始参考图**（四角纯白、完全不透明），
供你抠图时取用。**你就是在 `raw\` 里手动抠的图** —— 所以：

> **脚本对 `raw\` 只在目标不存在时才写入。已有文件一律不动。**

这条是**数据丢失防线**，不是洁癖。旧版对 `raw\` 也无条件拷贝，而源素材仍是
0% 透明的原图、与你的抠图内容不同 ⇒ **重跑一次就把你的抠图覆盖回不透明原图、
静默丢失**。现在：

- 默认跑：`raw/ 新写入 0 张，跳过（保护用户抠图）17 张`
- 真要强制重刷（**会丢掉你在 `raw\` 里的改动**）：`--refresh-raw`

> 如果你的抠图只放在 `raw\` 里，请**同时**复制一份到 `cutout\` —— 脚本只从
> `cutout\` 取图。`cutout\` 里的 17 张就是 `raw\` 抠图的字节级副本，互为备份。

### 待抠清单（仅 2 项，GIF 有实心帧）

| 文件名 | 问题 |
|---|---|
| `表情包_05_星空公式.gif` | **33/33 帧全实心**（整幅深蓝星空板） |
| `表情包_27_生气指人.gif` | **10/18 帧实心**（后段出现蓝色板） |

桌宠的硬要求是**任何一帧都不能铺满不透明像素**，否则播到那帧桌面出现矩形色块。
这两张要么手动抠掉背景板，要么不用。

---

## 3. 现在就能用的素材（无需抠图）

| 来源 | 数量 | 角色 | 说明 |
|---|---|---|---|
| `wx\*.png` | 8 张 | 主体 | 240×240 RGBA，**已透明**，F1 首选 |
| `QQ表情\*.gif` 通过判据的 | 10 张 | 6 张主体 + 4 张气泡 | 全部帧都含透明像素 |

已暂存到 `art\pet\src\png\`（8 张）与 `art\pet\src\gif\`（10 张），原图仍在
`庄方宜素材\10-表情包\`，**源素材从未被修改**。

### 弃用：根目录 6 张单帧 GIF

`1.gif`、`2.gif`、`88401DDC….gif`、`984FCB81….gif`、`B8F35CC0….gif`、`D227DC3B….gif`
—— 与 `wx\*.png` 重复的 200×200 单帧图（实测配对：`1→wx/2`、`2→wx/8`、
`88401DDC→wx/1`、`984FCB81→wx/4`、`B8F35CC0→wx/6`、`D227DC3B→wx/7`），已弃用。

---

## 4. 命令速查

```powershell
$py = 'C:\Users\A\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'

# 全量重建（幂等，可反复跑；不会碰 raw/ 里你的抠图）
& $py tools/prepare-pet.py

# 只看覆盖率与每张图的透明占比，不写任何文件
& $py tools/prepare-pet.py --check

# 重建前清掉 art/pet 下的旧产物
& $py tools/prepare-pet.py --clean

# 强制重刷 raw/（⚠️ 会覆盖你在 raw/ 里的抠图，慎用）
& $py tools/prepare-pet.py --refresh-raw
```

`--check` 的报告**分成两块角色**：

- **【主体（states）】** —— 只列 F1 素材，并逐项标出每个状态用到的源文件；
- **【表情包（bubble）】** —— 逐项打印 `hasText`（F2 贴纸 `true` / F3 场景 `false`）。

它还会打印每张 GIF 的 `minT%`（全部帧里最小的 `alpha==0` 像素占比）。
**低于 0.5% 即判为「有实心帧」**，脚本自动排除出动画并记进 `pet.json` 的 `missing`
—— 你以后自己丢新图进来也会自动判定，不依赖任何人工名单。

---

## 5. 产物说明（自动生成，勿手改）

| 路径 | 内容 |
|---|---|
| `art\pet\<state>.png` | 状态精灵条带（**主体**），**横向**：`帧数 × frameWidth` 宽、256px 高 |
| `art\pet\<state>-2.png` | 同状态的轮换变体 |
| `art\pet\thumbs\<state>.png` | 48px 缩略图（UI 预览用） |
| `art\pet\bubble\*.png` | 气泡表情池（**表情包**，≤256px，1:1 不裁切） |
| `art\pet\pet.json` | **素材清单**，Host 与 exe 的唯一契约（契约 §4） |
| `art\pet\src\` | 源素材暂存：`png\` `gif\` `raw\`（**你的工作台**）`cutout\`（**取图来源**） |

**单帧不是方的**：各素材内容 bbox 的纵横比不同（0.85~1.13），所以帧高统一 256、
宽度保纵横比后，单帧宽落在 **239~288** 之间。因此 `pet.json` 为每个状态写出
`frameWidth`（契约 §4 必需字段）：

```jsonc
"idle": { "file": "idle.png", "frames": 33, "frameWidth": 256, "frameMs": 30 }
```

条带宽 = `frames × frameWidth`，**不是** `frames × frameHeight` ——
拿 `frameHeight` 当帧宽会把图横向压扁，并在切状态时宽度跳变。
两侧都必须优先用图片实测值（`naturalWidth / frames`），`frameWidth` 用于加载前占位。

**几何按文件给出（`files` 映射）**：`variants` 只是文件名数组，而变体之间帧数
差异极大（静态 PNG 1 帧 vs 动态 GIF 44 帧），套用 `states` 的 `frames` 去切会切出碎条。
所以顶层另有 `files`，登记每个文件自己的几何：

```jsonc
"variants": { "happy": ["happy.png", "happy-2.png", "happy-3.png"] },
"files": {                                    // canonical + 全部 variants
  "happy.png":   { "frames": 33, "frameWidth": 256, "frameMs": 30 },
  "happy-2.png": { "frames": 1,  "frameWidth": 274, "frameMs": 0  },
  "happy-3.png": { "frames": 1,  "frameWidth": 239, "frameMs": 0  }
}
```

切帧一律以 `files[<文件名>]` 为准，**不要**用 `states[<状态>].frames` 去切变体。
`files` 是纯附加字段，旧消费者忽略它也能跑。

**气泡项带 `hasText`**（契约 §4 必需）：

```jsonc
"bubble": [
  { "file": "bubble/17-yay.png",      "w": 256, "h": 256, "hasText": true  },
  { "file": "bubble/25-reading.png",  "w": 256, "h": 256, "hasText": false },
  { "file": "bubble/gif-26.png",      "w": 256, "h": 256, "hasText": false }
]
```

精灵条带一份产物同时喂 WPF 的 `CroppedBitmap` 与 overlay 的 CSS `steps(N)`；
exe 按 `pet.json` 的 `frameHeight` 缩放，**不得假设固定值**。

`pet.json` 的 `generatedAt` 是固定占位值而非真实时间 —— 这样重跑两次的字节完全一致，
「幂等」才可被校验。
