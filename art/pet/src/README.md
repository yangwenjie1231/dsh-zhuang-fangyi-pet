# 桌宠素材 · 手动抠图指南

本目录是**素材管线**的输入与输出所在。`art/pet/` 下的精灵条带、气泡池、缩略图与
`pet.json` 清单全部由 `tools/prepare-pet.py` **自动生成**，请勿手改 ——
手改会在下次重跑时被覆盖。

**抠图由你手动完成**：脚本绝不键控背景、绝不 `flatten()`、绝不动你的源图。

---

## 1. 你要做什么

把下面「待抠清单」里的图抠成**透明底 PNG**，放进：

```
dsh-zhuang-fangyi-pet\art\pet\src\cutout\
```

然后跑一次：

```powershell
& 'C:\Users\A\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe' tools/prepare-pet.py
```

脚本会自动把 `cutout\` 里的图**优先纳入**同名状态，覆盖内置映射。

### 命名规则（重要）

| 文件名 | 作用 |
|---|---|
| `idle.png` | 覆盖 `idle` 状态（主变体） |
| `idle-2.png`、`idle-3.png` | 同状态的**轮换变体**（契约 `variants`），抠几张放几张 |
| `happy.png` 等 | 状态名必须是契约 §1 的 9 个之一 |

9 个合法状态名：
`waking` `idle` `listening` `thinking` `working` `waiting` `happy` `error` `sleeping`

> 例：你觉得 `happy` 太单调，就放 `happy-2.png`、`happy-3.png`，
> 重跑后 `pet.json` 的 `variants.happy` 会自动多出这两张。

### 抠图要求

- **透明底 PNG，保留 alpha**。四角与人物轮廓外必须真透明（alpha=0）。
- **尺寸不限**，脚本会等比缩放到帧高 256px（保持长宽比，只裁四周全透明留白）。
- **不要贴白底、不要 flatten**。透明区残留白色 RGB 会在桌面上显出一圈白边。
- 抠好后可直接丢进 `cutout\`，**不用**先手动改名成状态名也行 ——
  但按状态名命名才能保证映射到你要的状态。

---

## 2. 待抠清单（共 19 项）

### A. `QQ表情\*.png` —— 17 张，四角纯白、完全不透明（**主要工作量**）

已原样暂存到 `art\pet\src\raw\`，可直接从那里取用。

| 文件名 | 建议用途 | 文件名 | 建议用途 |
|---|---|---|---|
| `表情包_08_爱你哦.png` | happy / 气泡 | `表情包_17_好耶.png` | happy |
| `表情包_09_比心.png` | happy / 气泡 | `表情包_18_有点懵.png` | thinking |
| `表情包_10_略略略.png` | happy / 气泡 | `表情包_19_谢谢哦.png` | happy |
| `表情包_11_hi～.png` | listening | `表情包_20_默大契.png` | idle |
| `表情包_12_晚安啦.png` | sleeping | `表情包_21_工作中.png` | working |
| `表情包_13_眨眼.png` | listening | `表情包_22_好气人哦.png` | error |
| `表情包_14_么么哒.png` | happy | `表情包_23_你最好了.png` | happy |
| `表情包_15_加油.png` | working | `表情包_25_看书.png` | working（**已含部分 alpha**） |
| `表情包_16_开心点嘛.png` | happy | | |

> `表情包_25_看书.png` 是 500×500 且**已带 31% 透明像素**（四角透明，但含不透明桌面场景）。
> 若你认可它的效果，直接放进 `cutout\working.png` 即可用；否则按普通待抠处理。

### B. 2 张 GIF —— 有实心帧，直接播会出现矩形块

| 文件名 | 问题 |
|---|---|
| `表情包_05_星空公式.gif` | **33/33 帧全实心**（整幅深蓝星空板） |
| `表情包_27_生气指人.gif` | **10/18 帧实心**（后段出现蓝色板） |

这两张要么手动抠掉背景板，要么就不用 —— 桌宠的硬要求是**任何一帧都不能铺满不透明像素**。
抠成透明后放进 `cutout\`，脚本会重新判定并自动纳入。

---

## 3. 现在就能用的素材（无需抠图）

| 来源 | 数量 | 说明 |
|---|---|---|
| `wx\*.png` | 8 张 | 240×240 RGBA，**已透明**，首选素材 |
| `QQ表情\*.gif` 中通过判据的 | 10 张 | 全部帧都含透明像素，可直接做本体动画 |

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

# 全量重建（幂等，可反复跑）
& $py tools/prepare-pet.py

# 只看覆盖率与每张图的透明占比，不写任何文件
& $py tools/prepare-pet.py --check

# 重建前清掉 art/pet 下的旧产物
& $py tools/prepare-pet.py --clean
```

`--check` 会打印每张 GIF 的 `minT%`（全部帧里最小的 `alpha==0` 像素占比）。
**低于 0.5% 即判为「有实心帧」**，脚本会自动把它排除出动画并记进 `pet.json` 的 `missing`
—— 你以后自己丢新图进来也会自动判定，不依赖任何人工名单。

---

## 5. 产物说明（自动生成，勿手改）

| 路径 | 内容 |
|---|---|
| `art\pet\<state>.png` | 状态精灵条带，**横向**：`帧数 × 256px` 宽、256px 高 |
| `art\pet\<state>-2.png` | 同状态的轮换变体 |
| `art\pet\thumbs\<state>.png` | 48px 缩略图（UI 预览用） |
| `art\pet\bubble\*.png` | 气泡表情池（≤256px，1:1 不裁切） |
| `art\pet\pet.json` | **素材清单**，Host 与 exe 的唯一契约（契约 §4） |
| `art\pet\src\` | 源素材暂存：`png\` `gif\` `raw\` `cutout\` |

精灵条带一份产物同时喂 WPF 的 `CroppedBitmap` 与 overlay 的 CSS `steps(N)`；
exe 按 `pet.json` 的 `frameHeight` 缩放，**不得假设固定值**。

`pet.json` 的 `generatedAt` 是固定占位值而非真实时间 —— 这样重跑两次的字节完全一致，
「幂等」才可被校验。