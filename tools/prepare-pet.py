#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
庄方宜桌宠 · 素材管线（`prepare-pet.py`）

从 `庄方宜素材\\10-表情包\\` 取表情素材，产出 Host 半边与原生 exe **共用**的
精灵条带、气泡表情池、缩略图与素材清单 `art/pet/pet.json`（契约 §4）。

可重复运行：每次覆盖 `art/pet/` 下同名产物，**绝不修改源素材**；连跑两次结果一致（幂等）。

用法：
    python tools/prepare-pet.py                  # 全量重建（默认）
    python tools/prepare-pet.py --check          # 只报覆盖率与每张图的透明占比；不写文件
    python tools/prepare-pet.py --clean          # 重建前先清掉 art/pet 下的旧产物
    python tools/prepare-pet.py --refresh-raw    # 强制重刷 src/raw/（默认**不覆盖**已有文件！）

**角色划分（Lead 逐张看图判定，见 `art/pet/src/README.md` §0）**：
素材实际有**三个风格家族**，脚本按「文字是否 baked-in 在图上」把它们分到两个角色：

  | 家族 | 画面 | 角色 | hasText |
  |---|---|---|---|
  | **F1** 细笔触半身像 · 深色作战服 · **无文字** | `gif 01/02/03/04/06/07` + `wx 1..8` | **主体**（`states`） | — |
  | **F2** 鲨鱼睡衣贴纸 · **中文印在图上** | 用户抠的 16 张（`08`~`23`） | **表情包**（`bubble`） | `true` |
  | **F3** 简笔场景 · 无文字 · 风格自成一派 | `gif 24/26/28/29` + 用户抠的 `25_看书` | **表情包**（`bubble`） | `false` |
  | **F3b** 有实心帧的动画 · **整段保留为动态气泡** | `gif 05_星空公式` / `27_生气指人` | **表情包**（`bubble`） | `false` |
  | **F5** 新收的一整批 Q 版动态表情（20 张，另一画风） | `QQ表情\表情包_30..49_*.gif` | **表情包**（`bubble`） | 见下 |
  | **F4** 黑白线稿贴纸 · **白底铺满整图** · 中文大字 | `fromQQ/新表情包/庄方宜(未扣背景)/*.png` 20 张 | **表情包**（`bubble`） | `true` |

  F5 是 2026-10 晚新收的一整批（文件名是 QQ 的 base64 混淆串，语义只能看图定）。
  它和 F1（现主体）**不是同一个画风**：F5 是白绿作战服 + 粗描边 + 平涂 + Q 版胸像，
  F1 是细笔触 + 深色作战服 + 半身像。所以按上面那条纪律（F2/F3 不得进 `states`），
  **F5 全部进气泡池、不进主体** —— 主体是连续播放的，混画风会让人物在桌面上
  "变装跳帧"。用户要求这批都要用上，进气泡池即满足（气泡是一张张独立贴纸，
  风格自成一派没问题）。

  F3b 是「判据拒了、但**根本不用手工抠图**」的那一类（2026-10 补，原先挂在 `missing`
  里等人工抠图）。关键要把两件事分开：

    · **判据拦的是"当主体动画用"** —— `min_transparent_ratio` 要求任何一帧都不能铺满
      不透明像素，否则播到那一帧，桌面上会出现一个矩形色块（那是对**本体**的要求）；
    · **气泡没有这条约束** —— 气泡本来就是一张卡片/贴纸，满幅不透明正是"贴纸"的语义
      （F4 那 20 张就是 0% 透明的满幅贴纸，一直在用）。

  所以这两张**整段原样当动态气泡**（`opaque` 各按画面内容定），既不用抠图也不用挑帧：

    · `05_星空公式`（33 帧，`frameMs` 30）：深蓝紫渐变底 + **满屏手写数学公式**，
      模仿 "Confused Math Lady" —— **公式就是画面内容**，抠掉反而毁梗 →
      按 F4 那套「不透明满幅贴纸」用（不抠、不键控、不 flatten，`opaque=true`）；
    · `27_生气指人`（18 帧，`frameMs` 60）：蓄力→能量爆发→怒意高潮。它有 10 帧"实心"，
      那是**满屏爆炸特效**（白闪/蓝光/烟尘），不是背景板；其余帧背景本来就透明
      （帧 0 实测 43% 像素 alpha=0）→ `opaque=false`，照常套气泡底。

  交付方式：GIF **整文件原样拷贝**到 `art/pet/bubble/<语义名>.gif`，清单写
  `frames` / `frameMs`（契约 §4 v-next）；播放能力在原生窗（`GifBitmapDecoder`
  解全部帧 + 一只 DispatcherTimer 推进）。overlay 冻结、只显示首帧，这是**已知降级**。

  为什么 F2 只能当表情包：它每张都 baked-in 一句中文（"晚安啦"）。当**主体**会让桌宠
  永远挂着同一句话；当**气泡**时若 Host 再叠一句 `bubble.text`，屏幕上会**出现两段
  打架的文字** —— 这正是契约 §4 新增 `bubble[].hasText` 的原因。F1 不得进气泡池
  （主体重复出现没意义），F2/F3 不得进 `states`（风格会跳）。

  F4 是后加的一批（`fromQQ/新表情包/庄方宜(未扣背景)/*.png`，20 张 1254² 线稿贴纸），
  同样只能当表情包。它与 F2/F3 的**根本差别**在于：

    · **不透明**（0% alpha、白底铺满整图）→ 契约 §4 新增 `bubble[].opaque = true`，
      渲染方**不得再套气泡底/内边距**，否则会出现「白纸贴在浅色框里」的双层边框；
    · **绝不能抠白底**：白色既是背景、**也是脸/衣服的填充色**，键控白底实测透明占比
      72.7%~78.6%，脸上会破出透明洞（原图直接满幅用，不抠、不键控、不 flatten）；
    · **深色模式直接用原图**（v2 起不再产出深色变体）—— 见下方「深色变体」处的说明。

设计要点：
  · **不抠图**。`QQ表情\\*.png` 是四角纯白的不透明图，用户明确要求**手动抠图**；
    本脚本只把它们原样暂存到 `art/pet/src/raw/` 供取用，并记进 `missing`，
    绝不键控背景、绝不 `flatten()`。
  · **保留 alpha**。所有输出都是 RGBA。缩放前先裁掉四周全透明留白
    —— 裁 alpha 不丢任何可见信息，还能让主体撑满帧高（240×240 里人物只占中间一块）。
  · **动画是否可用由「逐帧透明占比」自动判定**，不靠人工名单（见 `min_transparent_ratio`）：
    桌宠的硬要求是**任何一帧都不能铺满不透明像素**，否则播到那一帧就会出现一个矩形色块。
    判据直接来自这条需求，不需要阈值猜测，用户以后丢新 GIF 进来也能自动判定。
    实测被它拦下的只有 `05_星空公式`（33/33 帧全实心）与 `27_生气指人`（10/18 帧实心）。
  · **帧高 256px**（本机 150% DPI，小了会糊）。`frameMs` 取该 GIF 各帧时长的**中位数**，
    所以 30/60ms 交错的动画取 30ms（快帧才是视觉主体）。
  · **单帧不是方的**：各素材内容 bbox 的纵横比不同（0.85~1.13），所以「帧高统一 256、
    宽度保纵横比」后单帧宽落在 239~288 之间。清单必须为每个状态写出 `frameWidth`
    （契约 §4 必需字段），否则两侧会拿 `frameHeight` 当帧宽，把图横向压扁。
    条带宽 = `frames × frameWidth`，**不是** `frames × frameHeight`。
  · **几何按文件给出**：`variants` 是文件名数组，但变体之间帧数差异极大
    （静态 PNG 1 帧 vs 动态 GIF 44 帧），套用 `states` 的 `frames` 去切会切出碎条。
    所以顶层另有 `files` 映射，登记 **canonical + 全部 variants** 每个文件自己的
    `frames`/`frameWidth`/`frameMs`（纯附加字段，旧消费者忽略也能跑）。
  · **清单是唯一契约**。`pet.json` 严格照契约 §4；`states` 的键只能取 §1 的 9 个状态名，
    缺状态时 Host 回落 `idle`，**缺失不得导致任何一方报错**。
  · **用户手动抠图自动纳入**。`art/pet/src/cutout/<语义名>.png` 会被自动纳入（见 §F2/F3
    的两张显式表），抠完丢进去重跑即可，无需改代码；这些图同样会过一遍透明占比检查。
  · **`src/raw/` 是「用户的工作台」，写一次就不再动**（重要，防数据丢失）：
    用户**正是在 `raw/` 里手动抠的图**，而源素材仍是 0% 透明的原图。旧版无条件
    `copy_if_different(源素材, raw/同名)` 会把抠图**覆盖回不透明原图、静默丢失**。
    现在 `raw/` 只在目标**不存在**时才写入；要强制重刷得显式给 `--refresh-raw`。
    （`src/png/` 与 `src/gif/` 不涉及人工编辑，仍按内容幂等刷新。）
"""

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ART = os.path.join(ROOT, 'art', 'pet')
SRC = os.path.join(ART, 'src')
# 源素材目录：与 dsh-zhuang-fangyi-pet\ 同级
ASSETS = os.path.join(os.path.dirname(ROOT), '庄方宜素材', '10-表情包')
ASSETS_WX = os.path.join(ASSETS, 'wx')
ASSETS_QQ = os.path.join(ASSETS, 'QQ表情')
# F4 源素材目录（用户 2026-10 从 QQ 新收的一批，**未抠背景**）。
# 与 `庄方宜素材\` 不同级，是 `fromQQ\新表情包\庄方宜(未扣背景)\`。
ASSETS_NEW = os.path.join(os.path.dirname(ROOT), 'fromQQ', '新表情包', '庄方宜(未扣背景)')

# ── 契约常量（不得单方面改动，见 docs/接口契约.md §1 / §4）────────────────────
# §1 的 9 个合法状态名；`states` 的键只能取其中之一。
PET_STATES = ('waking', 'idle', 'listening', 'thinking',
              'working', 'waiting', 'happy', 'error', 'sleeping')
MANIFEST_VERSION = 1
FRAME_HEIGHT = 256          # 契约 §4 / §6：精灵条带的帧高
THUMB_HEIGHT = 48           # 缩略图高（仅 UI 预览用）
BUBBLE_MAX = 256            # 气泡最长边上限（1:1 缩放，不裁切）
SOLID_EPS = 0.005           # 透明占比低于 0.5% 即视为「实心帧」→ 判为有背景板

# ── 已透明的 8 张 wx PNG：语义名 → 源文件名 ──────────────────────────────────
# 这 8 张是**首选素材**（用户明确要求 PNG 优先）：240×240 RGBA，四角 alpha=0，已实测干净。
# 语义名按实际画面逐张看图判定（不是猜的）：
#   1 捂嘴害羞 / 2 开心抱绿植 / 3 眨眼比耶 / 4 吃东西 / 5 星空比耶 /
#   6 趴桌睡着 / 7 双手比耶 / 8 写字
WX_NAMES = {
    'shy':     '1.png',
    'joy':     '2.png',
    'wink':    '3.png',
    'snack':   '4.png',
    'starry':  '5.png',
    'sleepy':  '6.png',
    'cheer':   '7.png',
    'writing': '8.png',
}

# ── 状态映射计划（**主体**，只从 F1 取）─────────────────────────────────────
# 候选按优先级排列，取第一个可用的；一个状态给多个候选 → 写进 `variants` 轮换，
# 避免同状态永远一张图、显得呆板。
# `gif:NN` 指 `QQ表情\\表情包_NN_*.gif`；其余是 `WX_NAMES` 的语义名。
#
# ⚠️ **这里只能出现 F1**（细笔触半身像、无文字）。F2（鲨鱼睡衣贴纸、baked-in 中文）
# 与 F3（简笔场景）一律不得进来 —— 前者会让桌宠永远挂着同一句话，后者风格会跳。
# F2/F3 全部归 `BUBBLE_F2` / `BUBBLE_F3`，进气泡池。
# 9 个状态**全部覆盖**（sleeping 由 wx6 趴桌睡着撑起）。
STATE_PLAN = (
    ('waking',    ('cheer', 'gif:07')),
    ('idle',      ('gif:07', 'shy', 'wink')),
    ('listening', ('wink', 'gif:01')),
    ('thinking',  ('gif:04', 'starry')),
    ('working',   ('writing', 'gif:03')),
    ('waiting',   ('gif:01', 'shy')),
    ('happy',     ('gif:06', 'joy', 'cheer', 'gif:07')),
    ('error',     ('gif:02',)),
    ('sleeping',  ('sleepy',)),
)

# ── 气泡池（**表情包**）= F2 + F3 ────────────────────────────────────────────
# F2：用户手动抠好的 16 张鲨鱼睡衣贴纸，每张都 baked-in 一句中文 → `hasText: true`。
#     文件名 → `hasText` 显式表，**不靠猜**。用户抠图放在 `src/cutout/`（语义名）。
# F3：简笔场景，无文字 → `hasText: false`。其中 `25_看书` 也是用户抠的。
#
# `hasText` 判定规则（契约 §4，已冻结）：
#   · 用户抠的 `08`~`23` 这 16 张 → `true`（每张都印着中文）
#   · `25_看书` → `false`（简笔，无文字）
#   · F3 的 GIF `24/26/28/29` → `false`
#   · **未知/新增文件的默认值 → `false`**（安全侧：允许 Host 配文字）
BUBBLE_F2 = (
    # (语义名, cutout 文件名, hasText)
    ('08-love-you',          '08-love-you.png',          True),   # 爱你哦
    ('09-finger-heart',      '09-finger-heart.png',      True),   # 比心
    ('10-blep',              '10-blep.png',              True),   # 略略略
    ('11-hi',                '11-hi.png',                True),   # hi～
    ('12-good-night',        '12-good-night.png',        True),   # 晚安啦
    ('13-wink',              '13-wink.png',              True),   # 眨眼
    ('14-kiss',              '14-kiss.png',              True),   # 么么哒
    ('15-cheer-up',          '15-cheer-up.png',          True),   # 加油
    ('16-comfort',           '16-comfort.png',           True),   # 开心点嘛
    ('17-yay',               '17-yay.png',               True),   # 好耶
    ('18-confused',          '18-confused.png',          True),   # 有点懵
    ('19-thanks',            '19-thanks.png',            True),   # 谢谢哦
    ('20-thumbs-up',         '20-thumbs-up.png',         True),   # 默大契
    ('21-at-work',           '21-at-work.png',           True),   # 工作中
    ('22-annoyed',           '22-annoyed.png',           True),   # 好气人哦
    ('23-you-are-the-best',  '23-you-are-the-best.png',  True),   # 你最好了
)

BUBBLE_F3 = (
    # F3 的 4 张 GIF（自动判定通过的动画；气泡取首帧静态图）
    ('gif:24', '表情包_24_睡觉zzz.gif', False),
    ('gif:26', '表情包_26_趴面.gif',    False),
    ('gif:28', '表情包_28_挂件吊坠.gif', False),
    ('gif:29', '表情包_29_抱小宠.gif',  False),
)

# F3 里用户手动抠的那张（简笔，无文字）。它不覆盖任何状态 —— 只进气泡池。
CUTOUT_EXTRA = (
    ('25-reading', '25-reading.png', False),
)

# ── F3b：整段动画里有「实心帧」→ 不能当**主体动画**，但可以直接当**动态气泡** ──
# 见文件上方 F3b 那一行的说明。判据（`min_transparent_ratio`）拦的是"当状态动画用"：
# 只要有一帧铺满不透明像素，播到那一帧桌面上就会出现矩形色块 —— 那是对**本体**的要求。
# 气泡不同：**气泡本来就是一张卡片/贴纸**，满幅不透明在气泡里正是"贴纸"的语义
# （F4 那 20 张就是 0% 透明的满幅贴纸，早就在用了）。
#
# 所以这两张**整段保留为动画**，不做任何抠图、也不取单帧。
BUBBLE_ANIM = (
    # (语义名, 源文件名, hasText)   —— `opaque` 由指标自动判定，见 OPAQUE_MIN
    ('starry-formula', '表情包_05_星空公式.gif', False),   # 33/33 帧铺满 → 自动判为 opaque
    ('angry-charge',   '表情包_27_生气指人.gif', False),  # 半数帧透明 → 自动判为不 opaque
)

# 源文件名 → 语义名（`scan_sources` 用它把「被判据拒掉」换成「登记为动态气泡」）。
ANIM_BY_FILE = {
    fname: {'semantic': semantic}
    for semantic, fname, _has_text in BUBBLE_ANIM
}

# ── F5：新收的一整批 Q 版动态表情（20 张 GIF，2026-10 晚）────────────────────
#
# ⚠️ 素材来源有个坑值得记一笔：`fromQQ\表情包\庄方宜表情包\` 里那 49 个文件
# 用的是 QQ 的 base64 **混淆名**（`NR8AVjViQ2dBeE1EQTVOekF3...gif`），
# 而**同一批字节**在 `庄方宜素材\10-表情包\QQ表情\` 里已有可读名
# （实测 49/49 内容完全相同，sha256 逐一比对）。所以这里引用**可读名那份**：
# 名字能读、能 diff、出问题能一眼看出是哪张 —— 混淆名除了能对上号以外毫无价值。
#
# 与 F3b 同一个机制（`ANIM_BY_FILE`），单独一张表只是为了**看得清来源与批次**。
#
# ⚠️ 关于"要不要放进 `states`（人物主体）"：**不放**。这批是**另一个画风家族**
# —— 白绿作战服、粗描边、平涂、Q 版胸像；而 F1（现主体）是细笔触、深色作战服、
# 半身像。本文件上方那条"F2/F3 不得进 states（风格会跳）"的纪律就是为这个写的：
# 主体是**连续播放**的，混画风会让人物在桌面上"变装跳帧"。
# 用户明确表示这批都要用上 → 全部进**气泡池**（气泡本来就是一张张独立贴纸，
# 风格自成一派没问题，F3/F4 早有先例）。
#
# `opaque` 不写死 —— 由 `median_opaque_ratio` 按指标判定（见 `OPAQUE_MIN`）。
BUBBLE_F5 = (
    # (语义名, 源文件名, hasText)
    ('stunned',      '表情包_30_圆睁大眼嘴巴张成小小.gif', False),   # 惊呆、冷汗
    ('muscle',       '表情包_31_明黄背景眯眼咧嘴吐舌.gif', False),   # 秀肌肉（明黄底 → 自动判 opaque）
    ('content',      '表情包_32_闭眼弯月笑脸颊泛红双.gif', False),   # 满足、乖巧
    ('sunglasses',   '表情包_33_戴黑色墨镜单手推镜敬.gif', False),   # 墨镜流泪（强颜欢笑）
    ('cat-paws',     '表情包_34_头顶冒出粉色猫耳脸颊.gif', False),   # 猫耳猫爪、卖萌
    ('listless',     '表情包_35_双眼半睁无精打采嘴巴.gif', False),   # 无精打采、咸鱼
    ('cheerful',     '表情包_36_微笑着张嘴脸颊泛红四.gif', False),   # 开心、招手
    ('watermelon',   '表情包_37_双手抱着一大块西瓜眯.gif', False),   # 吃瓜、围观
    ('sleepy-zzz',   '表情包_38_躺床上盖粉色被子闭眼.gif', False),   # 盖被睡觉（Zzz 是装饰，按既有先例不算 hasText）
    ('star-eyes',    '表情包_39_变成金色星星眼脸红张.gif', False),   # 星星眼、崇拜
    ('smile-soft',   '表情包_40_空白背景中人物歪头冒.gif', False),   # 歪头温柔微笑
    ('knife',        '表情包_41_举着一把小刀挡在脸前.gif', False),   # 持刀威胁、杀气
    ('please',       '表情包_42_闭眼低头脸颊通红双手.gif', False),   # 双手合十拜托
    ('dizzy',        '表情包_43_双眼变成绿色蚊香漩涡.gif', False),   # 晕头转向
    ('follow-me',    '表情包_44_双手高举一块白牌牌上.gif', True),    # 举牌「求关注！」→ 文字 baked-in
    ('hungry',       '表情包_45_双手端着一只白碗闭眼.gif', False),   # 端碗、求投喂
    ('megaphone',    '表情包_46_举着蓝白扩音喇叭用力.gif', False),   # 拿喇叭喊话
    ('road-rage',    '表情包_47_驾浅蓝小车从远处一路.gif', False),   # 开车路怒、赶路
    ('excited',      '表情包_48_先睁着大眼微笑后半段.gif', False),   # 惊喜、期待
    ('all-ok',       '表情包_49_闭眼开心地笑脸颊泛红.gif', False),   # 双手 OK、搞定
)

# 与 F3b 合流：`scan_sources` 只认一张「文件名 → 语义名」的表。
F5_BY_FILE = {
    fname: {'semantic': semantic}
    for semantic, fname, _has_text in BUBBLE_F5
}
BUBBLE_ANIM = BUBBLE_ANIM + BUBBLE_F5
ANIM_BY_FILE.update(F5_BY_FILE)

# `opaque`（要不要套气泡底）**由指标判定，不手写**。
#
# 为什么：一开始我按"看图印象"手写了 20 个标志位，然后量了一遍 —— 猜错了 3 个
# （26/28/37 我以为满幅，实际中位不透明占比 0.90/0.78/0.89，大部分帧是透明的）。
# 这种事不该靠印象：**"满幅"是个可以量的属性**（不透明像素占比），
# 判据用**中位数**（取中位而非最大值：个别特效帧满幅不算"整张都是背景板"）。
OPAQUE_MIN = 0.95

# ── F4：黑白线稿贴纸（20 张，**不透明满幅**，带深色变体）────────────────────
# 语义名**逐张看图**取自图上 baked-in 的中文大字（不是照抄 `1 (1).png` 这类文件名）。
# 第 1 项是输出序号 `NN`（决定文件名排序与清单顺序），第 2 项是源文件名。
#
# ⚠️ 这批**绝不能抠白底**：白色既是背景、也是脸/衣服的填充色。实测键控白底后
# 透明占比 72.7%~78.6%，脸上会破出透明洞（眼睛、脸颊变透明）。所以原图直接当
# 「不透明满幅贴纸」用 —— 不抠、不键控、不 `flatten()`。
BUBBLE_F4 = (
    # (NN, 语义名,            源文件名,     图上文字)
    ('01', 'bored',          '1 (1).png',  '庄很无聊'),
    ('02', 'good-morning',   '1 (2).png',  '早上好'),
    ('03', 'dazed',          '10.png',     '哦呀斯密'),
    ('04', 'definitely',     '2 (1).png',  '宜定可以'),
    ('05', 'wink',           '2 (2).png',  'Wink'),
    ('06', 'brain-overload', '3 (1).png',  '庄脑过载'),
    ('07', 'wants',          '3 (2).png',  '庄想要'),
    ('08', 'miss-you',       '4 (1).png',  '庄想你了'),
    ('09', 'got-it',         '4 (2).png',  '庄得到'),
    ('10', 'hate-you',       '5 (1).png',  '庄讨厌你'),
    ('11', 'sneak-snack',    '5 (2).png',  '庄偷吃外卖'),
    ('12', 'wake-up',        '5.png',      '起床！别过少爷生活'),
    ('13', 'so-good',        '6 (1).png',  '太中啦'),
    ('14', 'so-strong',      '6.png',      '！强强！'),
    ('15', 'so-loud',        '7 (1).png',  '庄一直响'),
    ('16', 'knock-knock',    '7.png',      '庄门戳你'),
    ('17', 'crying',         '8 (1).png',  '庄一直哭'),
    ('18', 'disgusted',      '8.png',      '庄感到恶心'),
    ('19', 'slacking',       '9 (1).png',  '摸鱼ing'),
    ('20', 'unhappy',        '9.png',      '庄不开心'),
)

# F4 深色变体的输出子目录（契约 §4 示例即 `bubble/new/01.png` / `bubble/new/01-dark.png`）。
F4_SUBDIR = 'new'

# ── 深色变体：**已废弃**（用户决定，v2）──────────────────────────────────────
#
# 曾经这里生成过 `-dark.png`：把黑白线稿贴纸做「饱和感知明度翻转」，
# 想让白底→黑底、黑线→白线以贴合深色界面。
#
# **用户实测反馈：观感诡异，不如原图。** 这是对的，而且原因是结构性的：
# 这批贴纸是**白纸上的墨线**，白色不只是背景，**还是脸和衣服的填充色**。
# 翻明度之后整张脸变成黑的、只有轮廓线发白 —— 那不是"深色模式的贴纸"，
# 那是**底片**（照片负像）。人眼对"脸是黑的"极度敏感，所以一眼就不对。
#
# 用户原话："深色模式气泡表情反转太诡异了，直接原图还挺好的"
#          "深色模式不用单独的表情包"。
#
# 所以：**深色模式直接用原图**，不再产出任何深色变体。
# 契约 §4 的 `fileDark` 字段**保留**（可选字段，缺省即"用原图"），
# 旧清单与新清单都能被两侧消费者正确解析 —— 删字段会破坏向后兼容。
#
# 顺带的好处：少 20 个产物文件、少一条"深浅尺寸必须一致"的校验、
# 少一个每次新增素材都要重算的算法。

# 用户手动抠图目录。**注意**：这里的文件名是**语义名**（如 `08-love-you.png`），
# 不再是状态名 —— F2/F3 只当气泡，不当主体。
CUTOUT = os.path.join(SRC, 'cutout')

# 用户手动抠图的「原始工作台」。用户在这里面抠图，所以**只在目标不存在时写入**。
RAW = os.path.join(SRC, 'raw')


# ── 基础工具 ────────────────────────────────────────────────────────────────

def ensure_dirs():
    """建好全部输出目录（含用户手动抠图的 `cutout/` 与 F4 的 `bubble/new/`）。"""
    for d in (ART, os.path.join(ART, 'bubble'), os.path.join(ART, 'bubble', F4_SUBDIR),
              os.path.join(ART, 'thumbs'),
              SRC, os.path.join(SRC, 'png'), os.path.join(SRC, 'gif'),
              os.path.join(SRC, 'raw'), CUTOUT):
        os.makedirs(d, exist_ok=True)


def read_rgba(path):
    """读图并**保留 alpha**，返回 RGBA。

    绝不能无条件 `convert('RGB')`：透明底素材一旦丢掉 alpha，
    透明区的残留 RGB 会变成彩色噪点（契约 §6 明确禁止）。
    """
    return Image.open(path).convert('RGBA')


def gif_frames(path):
    """拆出 GIF 全部帧（RGBA）与每帧时长（ms）。

    Pillow 的 GIF 帧可能是 `P` 模式且靠上一帧增量合成，
    必须先 `seek()` 再 `convert('RGBA')`，否则拿到的是错帧。
    """
    im = Image.open(path)
    frames, durations = [], []
    for i in range(getattr(im, 'n_frames', 1)):
        im.seek(i)
        frames.append(im.convert('RGBA'))
        durations.append(int(im.info.get('duration') or 0))
    return frames, durations


def min_transparent_ratio(frames):
    """**核心判据**：全部帧里最小的「alpha==0 像素占比」。

    桌宠的硬要求是：任何一帧都不能铺满不透明像素 —— 否则播到那一帧，
    桌面上就会出现一个矩形色块。所以只要**存在一帧**几乎无透明像素，
    这张素材就不能直接用于动画（判据直接来自需求，不需要阈值猜测）。

    @return 0.0~1.0；越小越可疑。返回值 < `SOLID_EPS` 即判为「有背景板」。
    """
    worst = 1.0
    for f in frames:
        a = f.getchannel('A')
        # 用直方图数 0 的像素，比逐像素比较快一个数量级
        zeros = a.histogram()[0]
        worst = min(worst, zeros / float(f.width * f.height))
    return worst


def median_transparent_ratio(frames):
    """全部帧「alpha==0 像素占比」的**中位数**。

    与 `min_transparent_ratio`（取最小）分工不同，别混用：
      · **min** 回答"能不能当主体动画播" —— 只要有一帧铺满就不能（那帧会露出矩形块）；
      · **中位** 回答"这张图整体是不是满幅背景板" —— 个别特效帧满幅不算数，
        要看**多数帧**。`opaque`（要不要套气泡底）该用后者。
    """
    vals = []
    for f in frames:
        zeros = f.getchannel('A').histogram()[0]
        vals.append(zeros / float(f.width * f.height))
    vals.sort()
    if not vals:
        return 1.0
    return vals[len(vals) // 2]


def median_opaque_ratio(frames):
    """全部帧「不透明像素（alpha>248）占比」的中位数 —— `opaque` 判据。"""
    vals = []
    for f in frames:
        a = f.getchannel('A').histogram()
        vals.append(sum(a[248:]) / float(f.width * f.height))
    vals.sort()
    if not vals:
        return 0.0
    return vals[len(vals) // 2]


def median_ms(durations, fallback=60):
    """取帧时长中位数作为 `frameMs`。

    实测 7 张 GIF 是 30/60ms 交错，中位数取到 30ms —— 比取均值更贴近视觉节奏
    （快帧才是主体，慢帧只是个别停顿）。
    """
    vals = sorted(d for d in durations if d > 0)
    return vals[len(vals) // 2] if vals else fallback


def union_bbox(frames):
    """求**所有帧共用**的 alpha 包围盒（并集）。

    这里必须用并集而不是逐帧各自的 bbox：逐帧裁切会让每一帧的裁切偏移都不同，
    合成成条带后人物会在帧间**抖动**（位置跳来跳去）。用同一个盒子裁，
    既去掉了四周留白，又完整保留了动画位移。
    """
    boxes = [b for b in (f.getbbox() for f in frames) if b]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def to_height(im, height):
    """等比缩放到**精确** `height` 高（保持长宽比）。

    这里允许放大：契约 §6 要求条带是 `frames × frameHeight` 的规整网格，
    若某一帧矮于 frameHeight，取帧就会错位。wx 图是 240px，放大到 256 只有 1.07×，
    LANCZOS 下肉眼无损；相比「几何不规整」这个代价小得多。
    """
    if im.height == 0 or im.height == height:
        return im
    w = max(1, round(im.width * height / float(im.height)))
    return im.resize((w, height), Image.LANCZOS)


def load_state_cutouts(state):
    """取用户为**某个状态**手动抠的图（可选逃生通道），按文件名排序返回全部匹配项。

    命名规则：`state-<状态名>.png` 是主变体，`state-<状态名>-2.png`… 是轮换变体
    （契约 §4 的 `variants`）。用 `state-` 前缀是为了**不与气泡贴纸的语义名冲突**
    —— `cutout/` 现在主要装 F2/F3 的气泡图（如 `08-love-you.png`），
    旧版按 `<状态名>.png` 匹配会与它们混在一起，语义不清。
    """
    if not os.path.isdir(CUTOUT):
        return []
    hits = sorted(glob.glob(os.path.join(CUTOUT, 'state-%s*.png' % state)))
    exact = os.path.join(CUTOUT, 'state-%s.png' % state)
    if os.path.isfile(exact):
        hits = [exact] + [h for h in hits if h != exact]
    return hits


def copy_if_different(src, dst):
    """按内容比较后再拷贝：内容一致就**不动 mtime**，保证幂等可验证。"""
    if os.path.isfile(dst) and os.path.getsize(dst) == os.path.getsize(src):
        with open(src, 'rb') as f1, open(dst, 'rb') as f2:
            if f1.read() == f2.read():
                return False
    shutil.copy2(src, dst)
    return True


def f4_source(fname):
    """返回 F4 源文件路径；不存在返回 None（缺失只警告，不报错）。"""
    p = os.path.join(ASSETS_NEW, fname)
    return p if os.path.isfile(p) else None


def resolve_bubble_pool(by_semantic):
    """解析气泡池 = F2（用户抠的 16 张贴纸）+ F3（4 张简笔 GIF + 用户抠的 25_看书）
    + F4（20 张**不透明满幅**黑白线稿贴纸，带深色变体）。

    返回 `(pool, miss)`：`pool` 是 `[(item, hasText), …]`，`hasText` 直接来自上面
    三张**显式表**，不靠对图像做 OCR / 猜测。顺序固定为 F2 → F3 → F3 抠图 → F4，
    保证 `pet.json` 的 `bubble` 数组稳定（幂等可校验）。

    F4 的 item 额外带 `opaque=True`（见 `write_bubble()`）——
    它是契约 §4 的可选字段 `opaque` 的来源。**不再带 `dark`**：
    深色模式直接用原图，`fileDark` 保持缺省。

    **默认值规则**：不在表里的一律按 `false`（安全侧 —— 允许 Host 叠加 `bubble.text`）。
    以后新增素材必须显式登记 `hasText`，否则会以 `false` 进池。
    """
    pool, miss = [], []
    for semantic, fname, has_text in BUBBLE_F2:
        p = os.path.join(CUTOUT, fname)
        if os.path.isfile(p):
            pool.append(({'kind': 'png', 'semantic': semantic, 'name': fname,
                          'path': p, 'cutout': p}, has_text))
        else:
            miss.append({'name': fname, 'reason': 'needsCutout',
                         'detail': 'F2 气泡贴纸（文字 baked-in）；请抠好后放入 src/cutout/'})
    for semantic, fname, has_text in BUBBLE_F3:
        it = by_semantic.get(semantic)
        if it is not None:
            pool.append((it, has_text))
        else:
            miss.append({'name': fname, 'reason': 'needsCutout',
                         'detail': 'F3 简笔场景 GIF；未通过透明占比判据或源文件缺失'})
    for semantic, fname, has_text in CUTOUT_EXTRA:
        p = os.path.join(CUTOUT, fname)
        if os.path.isfile(p):
            pool.append(({'kind': 'png', 'semantic': semantic, 'name': fname,
                          'path': p, 'cutout': p}, has_text))
        else:
            miss.append({'name': fname, 'reason': 'needsCutout',
                         'detail': 'F3 用户手动抠图（简笔、无文字）'})
    for semantic, fname, has_text in BUBBLE_ANIM:
        it = by_semantic.get(semantic)
        if it is not None:
            pool.append((it, has_text))
        else:
            miss.append({'name': fname, 'reason': 'missing',
                         'detail': 'F3b/F5 动态气泡的源 GIF 不存在'})
    for nn, semantic, fname, text in BUBBLE_F4:
        p = f4_source(fname)
        if p is None:
            miss.append({'name': fname, 'reason': 'missing',
                         'detail': 'F4 黑白线稿贴纸源文件不存在（%s）' % ASSETS_NEW})
            continue
        # `opaque=True`：0% alpha、白底铺满整图 → 渲染方不套气泡底/内边距。
        # **没有 `dark=True`** —— 深色模式直接用原图，不再产深色变体。
        pool.append(({'kind': 'png', 'semantic': '%s-%s' % (nn, semantic), 'name': fname,
                      'path': p, 'opaque': True, 'subdir': F4_SUBDIR, 'label': text}, True))
    return pool, miss


def has_text_of(semantic):
    """按语义名查 `hasText`；**未知语义名一律 False**（契约 §4 的安全侧默认）。"""
    for s, _, ht in BUBBLE_F2:
        if s == semantic:
            return ht
    for s, _, ht in BUBBLE_F3:
        if s == semantic:
            return ht
    for s, _, ht in CUTOUT_EXTRA:
        if s == semantic:
            return ht
    for s, _f, ht in BUBBLE_ANIM:
        if s == semantic:
            return ht
    for _nn, s, _f, _t in BUBBLE_F4:
        if s == semantic or '%s-%s' % (_nn, s) == semantic:
            return True
    return False


# ── 素材发现与自动分类 ──────────────────────────────────────────────────────

def discover():
    """扫源素材并**自动分类**，返回 (可用列表, 待抠列表, 弃用列表)。

    可用 = 已透明的 wx PNG + 通过透明占比判据的动态 GIF（**主体候选，即 F1 与 F3 的
    GIF** —— 是否真的当主体由 `STATE_PLAN` 决定，F3 只进气泡池）；
    待抠 = 未通过判据的 GIF（`05_星空公式` / `27_生气指人`）+ 缺失的 wx PNG；
    弃用 = 根目录 6 张单帧 GIF（与 wx PNG 重复，实测配对见 README）。

    ⚠️ `QQ表情\\*.png`（F2 的 17 张贴纸）**不在这里**判「待抠」：它们已经由用户抠好
    放进 `src/cutout/`，角色与 `hasText` 由 `resolve_bubble_pool()` 按显式表决定。
    """
    usable, needs_cutout, dropped = [], [], []

    # ── wx 的 8 张已透明 PNG（首选，F1 主体）──
    for semantic, fname in sorted(WX_NAMES.items()):
        p = os.path.join(ASSETS_WX, fname)
        if os.path.isfile(p):
            usable.append({'kind': 'wx', 'semantic': semantic,
                           'name': fname, 'path': p, 'minT': 1.0})
        else:
            needs_cutout.append({'name': 'wx/%s（%s）' % (fname, semantic),
                                 'reason': 'missing', 'detail': '源文件不存在'})

    # ── 动态 GIF：逐帧透明占比自动判定，不依赖人工名单 ──
    for p in sorted(glob.glob(os.path.join(ASSETS_QQ, '*.gif'))):
        base = os.path.basename(p)
        idx = base.split('_')[1] if '_' in base else ''
        frames, durations = gif_frames(p)
        mt = min_transparent_ratio(frames)
        still = ANIM_BY_FILE.get(base)
        if still is not None:
            # F3b / F5：这张登记为**动态气泡** → 跳过「当状态动画」的判据。
            # 不是放水：它不进 `states`（不在 STATE_PLAN 里），只作为**气泡**出现；
            # 而气泡本来就允许满幅不透明（F4 那批全是）。
            #
            # `opaque` 在这里**按指标算**（不写死）：多数帧都铺满 → 不套气泡底。
            # 手写过一版，20 张里猜错 3 张 —— 能量的属性就别靠印象。
            usable.append({'kind': 'anim', 'semantic': still['semantic'], 'name': base,
                           'path': p, 'minT': mt, 'frames': len(frames),
                           'frameMs': median_ms(durations),
                           'opaque': median_opaque_ratio(frames) >= OPAQUE_MIN})
            continue
        if mt < SOLID_EPS:
            solid = sum(1 for f in frames
                        if f.getchannel('A').histogram()[0] / float(f.width * f.height) < SOLID_EPS)
            needs_cutout.append({
                'name': base, 'reason': 'needsCutout',
                'detail': '有实心帧（%d/%d 帧铺满不透明），播放会出现矩形块；'
                          '已排除动画，等手动抠图' % (solid, len(frames))})
            continue
        usable.append({'kind': 'gif', 'semantic': 'gif:' + idx, 'name': base,
                       'path': p, 'minT': mt, 'frames': len(frames)})

    # ── F5 的 20 张**不在这里单独扫** ──
    #
    # 它们在 `ASSETS_QQ` 里（可读名那份），上面那个 glob 已经会遍历到，
    # 且因为已登记进 `ANIM_BY_FILE`，会走"登记为动态气泡"那条分支。
    # 第一版在这里又按表扫了一遍 → 同一批被加进 `usable` 两次
    # （`src/gif/` 暂存数从 32 变成 52 才发现）。
    # 去重虽然由 `by_semantic` 兜住了（按语义名建索引），但重复本身没有意义，
    # 而且会让"暂存了几个文件"这种计数失真 —— 所以只留 glob 一条路。

    # ── 根目录 6 张单帧 GIF：与 wx PNG 重复，弃用 ──
    for p in sorted(glob.glob(os.path.join(ASSETS, '*.gif'))):
        dropped.append({'name': os.path.basename(p), 'reason': 'duplicate',
                        'detail': '与 wx PNG 重复的单帧 GIF，弃用'})

    return usable, needs_cutout, dropped


def build_mapping(usable):
    """把可用素材索引成 {语义名: 素材}，再按 `STATE_PLAN` 展开成 {状态名: [素材…]}。"""
    by_semantic = {u['semantic']: u for u in usable}
    mapping = {}
    for state, cands in STATE_PLAN:
        picked = [by_semantic[c] for c in cands if c in by_semantic]
        if picked:
            mapping[state] = picked
    return by_semantic, mapping


# ── 产出 ────────────────────────────────────────────────────────────────────

def strip_name(state, index):
    """条带文件名：首个变体是 `<state>.png`（契约 §4 示例即 `idle.png`），
    其余是 `<state>-2.png`、`<state>-3.png`（契约 §4 的 variants 示例写法）。"""
    return '%s.png' % state if index == 0 else '%s-%d.png' % (state, index + 1)


def render_tiles(item):
    """把一份素材渲染成**规整化的帧列表**，返回 `(tiles, frame_ms)`。

    主流程与 `--check` **共用这一个函数**，保证 `--check` 打印的单帧尺寸
    就是产出条带的真实尺寸，不会因为两份逻辑各自演化而漂移。

    规整化两步：
      1. 用**并集**包围盒统一裁切 —— 逐帧各自裁切会让偏移不同，动画会抖动；
      2. 等比缩放到精确 `FRAME_HEIGHT` 高。
    """
    src = item.get('cutout') or item['path']
    if item['kind'] == 'gif':
        frames, durations = gif_frames(src)
        frame_ms = median_ms(durations)
    else:
        frames, frame_ms = [read_rgba(src)], 0

    box = union_bbox(frames)
    if box:
        frames = [f.crop(box) for f in frames]
    return [to_height(f, FRAME_HEIGHT) for f in frames], frame_ms


def write_strip(state, item, index, report, cache, want_thumb=False):
    """产出某状态的横向精灵条带 `art/pet/<state>.png`。

    条带 = `frames × frameHeight` 宽、`frameHeight` 高（契约 §6）：
    一份产物同时喂 WPF 的 `CroppedBitmap` 与 overlay 的 CSS `steps(N)`。
    单帧素材也输出条带（frames=1），让两端走同一条代码路径。

    `cache` 按素材去重：同一张素材被多个状态用作变体时（如 07_微笑 同时喂
    `happy` 与 `listening`），只**编码一次**，其余变体直接复制字节 ——
    否则 3MB 级的 GIF 条带会被重复编码好几遍。
    """
    rel = strip_name(state, index)
    key = (item['kind'], item['name'])
    if key in cache:
        # 素材已编码过：复制字节到本变体的文件名，保证清单里每个路径都真实存在
        prev = cache[key]
        shutil.copy2(os.path.join(ART, prev['file']), os.path.join(ART, rel))
        report['made'].append((rel, None, os.path.getsize(os.path.join(ART, rel))))
        return dict(prev, file=rel)

    tiles, frame_ms = render_tiles(item)

    # 帧宽取最大值，窄帧水平居中 —— 保证条带是规整网格，取帧不会错位
    cell_w = max(t.width for t in tiles)
    strip = Image.new('RGBA', (cell_w * len(tiles), FRAME_HEIGHT), (0, 0, 0, 0))
    for i, t in enumerate(tiles):
        strip.paste(t, (i * cell_w + (cell_w - t.width) // 2, 0), t)

    path = os.path.join(ART, rel)
    strip.save(path, 'PNG', optimize=True)
    report['made'].append((rel, strip.size, os.path.getsize(path)))

    # `frameWidth` 是**契约 §4 的必需字段**：单帧不是方的（各素材 bbox 纵横比
    # 0.85~1.13 不同），两侧必须靠它才能在图片加载前算对布局。
    # 它必须与 `strip.width / frames` 严格相等 —— 所以直接取 `cell_w`（整数），
    # 不做任何二次取整，避免与实测值出现偏差。
    entry = {'file': rel, 'frames': len(tiles), 'frameWidth': cell_w,
             'frameMs': frame_ms, 'frameHeight': FRAME_HEIGHT, 'anchorY': 1.0}
    cache[key] = entry
    return entry


def write_thumb(state, entry, report):
    """产出 `art/pet/thumbs/<state>.png`：主变体条带的**首帧**等比缩到 48px 高。

    缩略图只给每个状态的**主变体**（`states[state]`）出一张，供 UI 列表预览；
    变体条带本身不单独出缩略图，避免产出无意义的几十张小图。
    """
    src = os.path.join(ART, entry['file'])
    im = Image.open(src).convert('RGBA')
    # 取首帧：条带宽 = cell_w × frames，帧高固定，首帧即左侧 cell_w 宽那一块
    cell = im.crop((0, 0, im.width // max(1, entry['frames']), im.height))
    thumb = to_height(cell, THUMB_HEIGHT)
    rel = os.path.join('thumbs', '%s.png' % state)
    path = os.path.join(ART, rel)
    thumb.save(path, 'PNG', optimize=True)
    report['made'].append((rel, thumb.size, os.path.getsize(path)))


def fit_bubble(im):
    """气泡按 **1:1 等比缩到最长边 ≤ `BUBBLE_MAX`**（不裁切、不拉伸）。

    气泡里常带文字或装饰，裁 bbox 或改比例都会破坏构图。
    深浅两版**必须共用这一个函数**，否则尺寸会不一致，切主题时气泡会跳。
    """
    if max(im.size) > BUBBLE_MAX:
        s = BUBBLE_MAX / float(max(im.size))
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))),
                       Image.LANCZOS)
    return im


def write_bubble(item, has_text, report):
    """产出气泡表情池图，并返回契约 §4 的条目。

    输出路径：
      · 一般素材 → `art/pet/bubble/<语义名>.png`（透明抠图，`opaque` 缺省 false）；
      · F4 线稿贴纸 → `art/pet/bubble/new/<NN>-<语义名>.png` **外加**一份
        `...-dark.png` 深色变体（契约 §4 的 `fileDark`）。

    `hasText` 原样带进清单：`true` = 该图**自己已经把文字画进去了**（F2 贴纸 / F4 线稿），
    Host 必须用 `kind: 'image'` 且**不再叠** `bubble.text`，否则屏幕上会出现两段
    打架的文字（契约 §4）。判定来自 `BUBBLE_F2`/`BUBBLE_F3`/`CUTOUT_EXTRA`/`BUBBLE_F4`
    显式表。

    `opaque`：F4 是 0% alpha、白底铺满整图 → `true`，渲染方**不套气泡底/内边距**
    （否则白纸贴在浅色框里会出现双层边框）。**不抠、不键控、不 flatten**：
    白色既是背景也是脸/衣服的填充色，键控会把角色内部掏空。

    **深色模式直接用原图**（v2 起不再产深色变体，`fileDark` 缺省）。
    """
    src = item.get('cutout') or item['path']

    # ── F3b：动态气泡 —— **整个 GIF 原样交付**，不取帧、不抠图 ──────────────
    #
    # 为什么不转成"PNG 条带"（精灵那套）：气泡动图的帧**不共享画布**（GIF 每帧
    # 可以只覆盖一部分），拼条带要先统一成网格，还得逐帧合成；而 WPF 的
    # `GifBitmapDecoder` 本来就会解出全部帧 —— 直接给 GIF 最省事也最不失真。
    # 契约 §4（v-next）用 `frames` / `frameMs` 声明它，渲染方据此做动画。
    if item.get('kind') == 'anim':
        rel = os.path.join('bubble', '%s.gif' % item['semantic'])
        path = os.path.join(ART, rel)
        shutil.copy2(src, path)                       # 原字节直传：GIF 已经是最终格式
        report['made'].append((rel, 'copy', os.path.getsize(path)))
        return {'file': rel.replace(os.sep, '/'), 'w': BUBBLE_MAX, 'h': BUBBLE_MAX,
                'hasText': bool(has_text), 'opaque': bool(item.get('opaque')),
                'frames': int(item.get('frames') or 1),
                'frameMs': int(item.get('frameMs') or 60)}

    if item['kind'] == 'gif':
        im = gif_frames(src)[0][0]              # 气泡用首帧（静态）
    else:
        im = read_rgba(src)

    if item.get('opaque'):
        # 满幅不透明贴纸（F4 线稿 + F3b 的 `05_星空公式`）。原图**原样保留 alpha**
        # （其实是 0% 透明，即整幅不透明），只做等比缩放 —— 绝不抠底、绝不 flatten。
        #
        # **不再产出深色变体**（用户决定，见文件上方「深色变体：已废弃」处的说明）：
        # 深色模式直接用这张原图。所以契约 §4 的 `fileDark` 为**缺省**。
        base = fit_bubble(im).convert('RGB')
        rel = os.path.join('bubble', item.get('subdir') or '',
                           '%s.png' % item['semantic'].replace(':', '-'))
        path = os.path.join(ART, rel)
        base.save(path, 'PNG', optimize=True)
        report['made'].append((rel, base.size, os.path.getsize(path)))

        return {'file': rel.replace(os.sep, '/'), 'w': base.width, 'h': base.height,
                'hasText': bool(has_text), 'opaque': True}

    im = fit_bubble(im)
    rel = os.path.join('bubble', '%s.png' % item['semantic'].replace(':', '-'))
    path = os.path.join(ART, rel)
    im.save(path, 'PNG', optimize=True)
    report['made'].append((rel, im.size, os.path.getsize(path)))
    return {'file': rel.replace(os.sep, '/'), 'w': im.width, 'h': im.height,
            'hasText': bool(has_text), 'opaque': False}


def stage_sources(usable, report, refresh_raw=False):
    """把源素材暂存进 `art/pet/src/`（**只拷贝，绝不修改源素材**）。

    ⚠️ **数据丢失防线**：`src/raw/` 是**用户手动抠图的工作台**（用户就是在那里把
    `QQ表情\\*.png` 抠成透明底的），而源素材仍是 0% 透明的原图 —— 两者内容不同。
    旧版对 `raw/` 也无条件 `copy_if_different`，于是**重跑一次就把用户的抠图覆盖回
    不透明原图、静默丢失**。所以现在：

      · `raw/` **只在目标不存在时**写入（视为「原始参考图，写一次就不再动」）；
      · 要强制重刷必须显式给 `--refresh-raw`（见 `main()`），默认永不覆盖。

    `src/png/` 与 `src/gif/` 不承载人工编辑，仍按内容幂等刷新。
    """
    staged = {'png': 0, 'gif': 0, 'raw': 0, 'rawSkipped': 0}
    for u in usable:
        sub = {'wx': 'png', 'gif': 'gif', 'anim': 'gif'}[u['kind']]
        copy_if_different(u['path'], os.path.join(SRC, sub, u['name']))
        staged[sub] += 1
    for p in sorted(glob.glob(os.path.join(ASSETS_QQ, '*.png'))):
        dst = os.path.join(RAW, os.path.basename(p))
        if os.path.isfile(dst) and not refresh_raw:
            # 已存在 → 这是用户的工作台文件，**绝不覆盖**
            staged['rawSkipped'] += 1
            continue
        copy_if_different(p, dst)
        staged['raw'] += 1
    report['staged'] = staged


def prune_unreferenced(referenced, report):
    """删掉 art/pet 下**清单已不再引用**的旧产物。

    必要性：变体数量会随素材变化（例如你删掉 `cutout/happy-2.png` 后，
    `variants.happy` 从 7 项缩回 5 项），旧的高序号文件会留在磁盘上变成孤儿。
    宿主是按 `pet.json` 派生 URL 白名单的，孤儿文件既占体积又容易让人误以为还在用。

    清理范围严格限定在脚本自管的三个目录（顶层 `*.png`、`bubble/**`、`thumbs/`），
    **绝不碰 `src/`（含用户手动抠图）与 `pet.json`**。

    `bubble/` 用 `**` 递归（F4 的产物在 `bubble/new/` 子目录里），否则子目录里的
    孤儿文件永远清不掉。
    """
    removed = []
    for pat in ('*.png', os.path.join('bubble', '**', '*.png'),
                os.path.join('thumbs', '*.png')):
        for p in sorted(glob.glob(os.path.join(ART, pat))):
            rel = os.path.relpath(p, ART)
            if rel not in referenced:
                os.remove(p)
                removed.append(rel)
    report['pruned'] = removed
    return removed


def write_manifest(states, variants, bubbles, missing, files, report):
    """写 `art/pet/pet.json`（契约 §4 的唯一素材清单）。

    `generatedAt` 故意**不写真实时间**：它会让每次重跑产生不同字节、破坏幂等。
    这里写一个固定占位值，让「连跑两次结果一致」可被 sha256 验证。

    `files` 是**每个文件自己的几何**（canonical + 全部 variants）：
    `variants` 只是文件名数组，而变体之间帧数差异极大（静态 PNG 1 帧 vs 动态 GIF 44 帧），
    拿 `states` 的 `frames` 去切变体会切出碎条 —— 所以几何必须按**文件**给出。
    该字段是纯附加的，旧消费者忽略它也能跑。
    """
    manifest = {
        'version': MANIFEST_VERSION,
        'generatedAt': '1970-01-01T00:00:00.000Z',
        'frameHeight': FRAME_HEIGHT,
        'states': states,
        'variants': variants,
        'files': files,
        'bubble': bubbles,
        'missing': missing,
    }
    path = os.path.join(ART, 'pet.json')
    text = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text + '\n')
    report['made'].append(('pet.json', (0, 0), os.path.getsize(path)))
    return manifest


# ── 报告 ────────────────────────────────────────────────────────────────────

def print_check(mapping, gif_rows, dropped, bubbles, usable, states_light,
                variant_geo, missing):
    """`--check`：只报覆盖率与透明占比，**缺图只警告不报错**，退出码恒为 0。

    报告**明确分成两块角色**，让人一眼看出哪张图被用在哪：
      · **主体（states）** —— 只列 F1 素材，并逐项标出 `gif:NN` / `wxN` 来源；
      · **表情包（bubble）** —— 逐项打印 `hasText`，并把 F4 新增的 20 张
        **单独标出** `opaque` / `fileDark` 是否齐全，再打印每张深色变体的生成方式。
    """
    print('素材覆盖率报告（--check，只读，未写任何文件）')
    print('=' * 70)
    print('源素材目录：%s' % ASSETS)
    print('可用素材 %d 项；待抠/缺失 %d 项；弃用 %d 项'
          % (len(usable), len(missing), len(dropped)))
    print()
    print('动态 GIF 透明占比判定（minT%% = 全部帧里最小的 alpha==0 占比；'
          '<%.1f%% 判为有背景板）' % (SOLID_EPS * 100))
    for name, n, ok, mt in gif_rows:
        role = '主体' if any(name == u['name'] for s in mapping.values() for u in s) \
            else ('气泡' if any(name == b[0].get('name') for b in bubbles) else '—')
        print('  %s %-26s %2d 帧  minT=%6.2f%%  %s  [%s]'
              % ('[OK]  ' if ok else '[待抠]', name, n, mt * 100,
                 '可用于动画' if ok else '★有实心帧 → 排除动画', role))
    print()
    print('弃用（与 wx PNG 重复的单帧 GIF）：%d 张' % len(dropped))
    print()

    # ── 块 1：主体（states）──────────────────────────────────────────────
    print('━' * 70)
    print('【主体（states）】= F1 细笔触半身像 · 深色作战服 · 无文字')
    print('  候选一律取自 F1：gif 01/02/03/04/06/07 + wx 1..8；'
          '**F2/F3 不得出现在这里**。')
    print('━' * 70)
    print('  %-4s %-10s %-14s %5s %6s %11s %6s %8s' % (
        '', '状态', '文件', '帧数', '帧宽', '单帧(宽x高)', 'frameMs', 'variants'))
    for s in PET_STATES:
        if s in states_light:
            st = states_light[s]
            print('  [OK] %-10s %-14s %5d %6d %5dx%-5d %6d %8d'
                  % (s, st['file'], st['frames'], st['frameWidth'],
                     st['frameWidth'], FRAME_HEIGHT, st['frameMs'],
                     len(mapping.get(s, []))))
        else:
            print('  [缺] %-10s → Host 回落 idle' % s)
    print()
    print('各状态用到的素材（来源语义名，全部应为 F1）：')
    for s in PET_STATES:
        items = mapping.get(s, [])
        if not items:
            continue
        print('  %-10s ← %s' % (s, ', '.join(
            '%s(%s)' % (it['semantic'], it['name']) for it in items)))
    print()
    print('各变体几何（变体之间帧数差异极大：静态 PNG 1 帧 vs 动态 GIF 几十帧，')
    print('必须按文件各自的几何切帧，不能套用 states 的 frames）：')
    for s in PET_STATES:
        if s not in states_light:
            continue
        rows = variant_geo.get(s, [])
        if len(rows) <= 1:
            continue
        print('  %s:' % s)
        for vfile, n, fw, fms in rows:
            mark = '  ← canonical' if vfile == states_light[s]['file'] else ''
            print('    %-18s %3d 帧 x %4dpx = %6dpx 宽  @%dms%s'
                  % (vfile, n, fw, n * fw, fms, mark))
    print()

    # ── 块 2：表情包（bubble）────────────────────────────────────────────
    print('━' * 70)
    print('【表情包（bubble）】= F2 鲨鱼睡衣贴纸（文字 baked-in）+ F3 简笔场景')
    print('                     + F4 黑白线稿贴纸（**不透明满幅** + 深色变体）')
    print('  hasText=true → Host 必须 kind=image，**不再叠 bubble.text**（否则两段文字打架）')
    print('  hasText=false → 可配 Host 文字（kind=both）')
    print('  opaque=true  → 渲染方**不套气泡底/内边距**（图片自带白底，满幅绘制）')
    print('  深色模式     → **直接用原图**（v2 起不再产深色变体）')
    print('━' * 70)
    n_text = sum(1 for _, ht in bubbles if ht)
    n_opaque = sum(1 for it, _ in bubbles if it.get('opaque'))
    print('  气泡池共 %d 张：hasText=true %d 张，hasText=false %d 张'
          % (len(bubbles), n_text, len(bubbles) - n_text))
    print('  其中 F4 不透明满幅贴纸 %d 张（深色模式用原图）' % n_opaque)
    print('  %-4s %-24s %-16s %-12s %7s %7s' % (
        '', '语义名', '来源文件', '家族', 'hasText', 'opaque'))
    for it, ht in bubbles:
        fam = 'F2 贴纸' if ht else ('F3 场景' if not it['semantic'].startswith('gif:')
                                    else 'F3 GIF')
        if it.get('opaque'):
            fam = 'F4 线稿'
        print('  [OK] %-24s %-16s %-12s %7s %7s'
              % (it['semantic'], it['name'], fam, 'true' if ht else 'false',
                 'true' if it.get('opaque') else 'false'))
    print('  未在显式表里的新文件 → 默认 hasText=false（安全侧：允许配文字）')
    print()

    # F4 单独一块：逐张标出 opaque / fileDark 是否齐全 + 深色变体怎么生成的
    f4_rows = [(it, ht) for it, ht in bubbles if it.get('opaque')]
    if f4_rows:
        print('━' * 70)
        print('【F4 新增：黑白线稿贴纸 %d 张】语义名逐张看图取自图上中文；'
              '**不抠白底**' % len(f4_rows))
        print('  不抠的理由：白色既是背景**也是脸/衣服的填充色**，键控白底实测透明占比')
        print('  72.7%~78.6%，脸上会破出透明洞 → 原图直接当「不透明满幅贴纸」，不键控、不 flatten。')
        print('━' * 70)
        print('  %-4s %-24s %-14s %8s %-10s' % (
            '', '语义名', '图上文字', 'opaque', '尺寸'))
        for it, _ht in f4_rows:
            rel = os.path.join('bubble', F4_SUBDIR, '%s.png' % it['semantic'])
            p = os.path.join(ART, rel)
            size_txt = '%dx%d' % Image.open(p).size if os.path.isfile(p) else '★缺'
            print('  [OK] %-24s %-14s %8s %-10s'
                  % (it['semantic'], it.get('label', ''), 'true', size_txt))
        print()
        print('  ⚠️ 深色模式**直接用原图**，不产深色变体（用户决定）。')
        print('     原因：这批贴纸是**白纸上的墨线**，白色不只是背景，')
        print('     **还是脸和衣服的填充色**。翻明度之后整张脸变黑、只有轮廓发白 ——')
        print('     那不是"深色贴纸"，是**底片**。人眼对"脸是黑的"极度敏感。')
        print('     契约 §4 的 `fileDark` 因此为**缺省**（缺省语义 = 用原图）。')
        print()

    print('待抠 / 缺失（%d 项，仅警告）：' % len(missing))
    for m in missing:
        print('  · %s（%s）%s' % (m['name'], m.get('reason', '?'), m.get('detail', '')))
    print()
    covered = sum(1 for s in PET_STATES if s in states_light)
    print('覆盖率：主体 %d/%d 状态有专属素材（缺 %d 个，仅警告）；气泡池 %d 张'
          % (covered, len(PET_STATES), len(PET_STATES) - covered, len(bubbles)))
    print('提示：气泡贴纸按语义名放进 art/pet/src/cutout/（如 17-yay.png）后重跑即可；'
          '给某状态换主体请放 state-<状态名>.png。')
    return 0


# ── 主流程 ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='庄方宜桌宠素材管线（不抠图、保留 alpha）')
    parser.add_argument('--check', action='store_true', help='只报覆盖率，不写文件；缺图只警告')
    parser.add_argument('--clean', action='store_true', help='重建前清掉 art/pet 下的旧产物')
    parser.add_argument('--refresh-raw', action='store_true',
                        help='强制重刷 src/raw/（默认**不覆盖**已有文件：那里是用户抠图的工作台）')
    args = parser.parse_args()

    if not os.path.isdir(ASSETS):
        print('找不到素材目录：%s' % ASSETS, file=sys.stderr)
        print('请确认 庄方宜素材\\ 与 dsh-zhuang-fangyi-pet\\ 在同一级目录下。', file=sys.stderr)
        return 1

    usable, missing, dropped = discover()
    by_semantic, mapping = build_mapping(usable)

    # 主体可选逃生通道：用户放进 cutout/state-<状态名>.png 的图优先于内置 F1 映射。
    for state in PET_STATES:
        for i, p in enumerate(load_state_cutouts(state)):
            frames = gif_frames(p)[0] if p.lower().endswith('.gif') else [read_rgba(p)]
            mt = min_transparent_ratio(frames)
            # 手动图也过一遍同一判据：有实心帧就警告，但不拦（用户明确认可的东西由他决定）
            if mt < SOLID_EPS:
                print('警告：cutout/%s 有实心帧（透明占比 %.2f%%），'
                      '播放可能出现矩形块' % (os.path.basename(p), mt * 100),
                      file=sys.stderr)
            item = {'kind': 'png' if not p.lower().endswith('.gif') else 'gif',
                    'semantic': 'state-%s-cut%d' % (state, i), 'name': os.path.basename(p),
                    'path': p, 'cutout': p, 'minT': mt, 'frames': len(frames)}
            mapping.setdefault(state, []).insert(i, item)
            by_semantic[item['semantic']] = item

    # 气泡池 = F2 + F3（**F1 不进池**：它是主体，重复出现没意义）。
    # 每项都带 `hasText`，来自显式表；未知语义名默认 False。
    bubble_pool, bubble_missing = resolve_bubble_pool(by_semantic)
    missing = missing + bubble_missing

    if args.check:
        # 只读：不写任何文件。单帧尺寸走 render_tiles（与主流程同一函数），
        # 所以这里打印的就是产出条带的真实单帧宽高。
        light, variant_geo = {}, {}
        for state, items in mapping.items():
            rows = []
            for i, it in enumerate(items):
                tiles, frame_ms = render_tiles(it)
                rows.append((strip_name(state, i), len(tiles),
                             max(t.width for t in tiles), frame_ms))
            light[state] = {'file': rows[0][0], 'frames': rows[0][1],
                            'frameWidth': rows[0][2], 'frameMs': rows[0][3]}
            variant_geo[state] = rows
        gif_rows = [(u['name'], u['frames'], True, u['minT'])
                    for u in usable if u['kind'] == 'gif']
        # 被排除的 GIF 也列出来，让用户看清为什么被排除
        for p in sorted(glob.glob(os.path.join(ASSETS_QQ, '*.gif'))):
            base = os.path.basename(p)
            if any(base == g[0] for g in gif_rows):
                continue
            fr, _ = gif_frames(p)
            gif_rows.append((base, len(fr), False, min_transparent_ratio(fr)))
        return print_check(mapping, gif_rows, dropped, bubble_pool,
                           usable, light, variant_geo, missing)

    ensure_dirs()
    if args.clean:
        # art/pet 整棵树都是本脚本的产出范围，清掉旧图后重生成
        # （`bubble/**` 递归，覆盖 F4 的 `bubble/new/` 子目录）
        for pat in ('*.png', os.path.join('bubble', '**', '*.png'),
                    os.path.join('thumbs', '*.png')):
            for p in glob.glob(os.path.join(ART, pat), recursive=True):
                os.remove(p)

    report = {'made': []}
    stage_sources(usable, report, refresh_raw=args.refresh_raw)

    states, variants, files, cache = {}, {}, {}, {}
    for state, items in mapping.items():
        entries = [write_strip(state, it, i, report, cache)
                   for i, it in enumerate(items)]
        states[state] = entries[0]                       # 契约 §4：variants 必须含 states
        variants[state] = [e['file'] for e in entries]
        write_thumb(state, entries[0], report)
        # `files`：每个文件自己的几何。同一素材被多个状态复用时文件名不同但几何相同，
        # 逐个登记即可（键就是文件路径）。
        for e in entries:
            files[e['file']] = {'frames': e['frames'],
                                'frameWidth': e['frameWidth'],
                                'frameMs': e['frameMs']}

    bubbles = [write_bubble(it, ht, report) for it, ht in bubble_pool]
    manifest = write_manifest(states, variants, bubbles, missing, files, report)

    # 清掉不再被清单引用的旧产物（变体缩水时的高序号文件等）
    referenced = set()
    for e in states.values():
        referenced.add(e['file'])
    for vs in variants.values():
        referenced.update(vs)
    for b in bubbles:
        referenced.add(b['file'].replace('/', os.sep))
        # ⚠️ 深色变体也必须登记！否则 `prune_unreferenced()` 会把它当孤儿删掉
        # —— 它不在 `b['file']` 里，只在 `b['fileDark']` 里（实测踩过一次）。
        if b.get('fileDark'):
            referenced.add(b['fileDark'].replace('/', os.sep))
    for s in states:
        referenced.add(os.path.join('thumbs', '%s.png' % s))
    prune_unreferenced(referenced, report)

    # ── 汇总 ──
    total = sum(n for _, _, n in report['made'])
    print('产出 %d 个文件到 art/pet/（合计 %.2f MB）'
          % (len(report['made']), total / 1024.0 / 1024.0))
    for name, size, nbytes in report['made']:
        if size == 'copy':
            print('  %-30s %s' % (name, '原样交付（GIF 不重编码） %8.0f KB' % (nbytes / 1024.0)))
        elif size is None:
            print('  %-30s %s' % (name, '（同素材复用）'))
        elif size == (0, 0):
            print('  %-30s %s' % (name, '清单'))
        else:
            print('  %-30s %5dx%-5d %8.0f KB' % (name, size[0], size[1], nbytes / 1024.0))
    print()
    st = report['staged']
    print('暂存源素材：png/ %d 张，gif/ %d 张；raw/ 新写入 %d 张，**跳过（保护用户抠图）%d 张**'
          % (st['png'], st['gif'], st['raw'], st.get('rawSkipped', 0)))
    if st.get('rawSkipped'):
        print('  ↑ raw/ 里的已有文件一律不动（那是你抠图的工作台）；'
              '要强制重刷请加 --refresh-raw')
    print('状态覆盖（主体，只取 F1）：%d/%d' % (len(states), len(PET_STATES)))
    for s in PET_STATES:
        n = len(variants.get(s, []))
        print('  %s %-10s variants=%d' % ('[OK]' if s in states else '[缺]', s, n))
    n_text = sum(1 for b in bubbles if b['hasText'])
    n_opaque = sum(1 for b in bubbles if b.get('opaque'))
    n_dark = sum(1 for b in bubbles if b.get('fileDark'))
    print('气泡池（表情包，F2+F3+F3b+F4+F5）：%d 张；其中 hasText=true %d 张、false %d 张'
          % (len(bubbles), n_text, len(bubbles) - n_text))
    print('  不透明满幅贴纸（F4 + F3b/F5 里判为满幅的）：opaque=true %d 张' % n_opaque)
    # 深色变体已废弃：这里断言"清单里一个都没有"，防止将来又有人加回来。
    if n_dark != 0:
        print('  ★★ 意外：仍有 %d 张带 fileDark —— 深色模式应直接用原图（v2 决定）' % n_dark)
    print('待抠/缺失：%d 项；弃用：%d 项' % (len(manifest['missing']), len(dropped)))
    if report.get('pruned'):
        print('清理旧产物 %d 个（清单已不再引用）：%s'
              % (len(report['pruned']), ', '.join(report['pruned'])))
    print('（缺失不影响运行：Host 对缺席状态回落 idle，契约 §4）')
    return 0


if __name__ == '__main__':
    sys.exit(main())