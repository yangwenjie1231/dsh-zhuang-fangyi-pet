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

  为什么 F2 只能当表情包：它每张都 baked-in 一句中文（"晚安啦"）。当**主体**会让桌宠
  永远挂着同一句话；当**气泡**时若 Host 再叠一句 `bubble.text`，屏幕上会**出现两段
  打架的文字** —— 这正是契约 §4 新增 `bubble[].hasText` 的原因。F1 不得进气泡池
  （主体重复出现没意义），F2/F3 不得进 `states`（风格会跳）。

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

# 用户手动抠图目录。**注意**：这里的文件名是**语义名**（如 `08-love-you.png`），
# 不再是状态名 —— F2/F3 只当气泡，不当主体。
CUTOUT = os.path.join(SRC, 'cutout')

# 用户手动抠图的「原始工作台」。用户在这里面抠图，所以**只在目标不存在时写入**。
RAW = os.path.join(SRC, 'raw')


# ── 基础工具 ────────────────────────────────────────────────────────────────

def ensure_dirs():
    """建好全部输出目录（含用户手动抠图的 `cutout/`）。"""
    for d in (ART, os.path.join(ART, 'bubble'), os.path.join(ART, 'thumbs'),
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


def resolve_bubble_pool(by_semantic):
    """解析气泡池 = F2（用户抠的 16 张贴纸）+ F3（4 张简笔 GIF + 用户抠的 25_看书）。

    返回 `(pool, miss)`：`pool` 是 `[(item, hasText), …]`，`hasText` 直接来自上面
    两张**显式表**，不靠对图像做 OCR / 猜测。顺序固定为 F2 → F3 → F3 抠图，
    保证 `pet.json` 的 `bubble` 数组稳定（幂等可校验）。

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
        frames, _ = gif_frames(p)
        mt = min_transparent_ratio(frames)
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


def write_bubble(item, has_text, report):
    """产出气泡表情池 `art/pet/bubble/<语义名>.png`，并返回契约 §4 的条目。

    气泡按 **1:1 等比缩到不超过 256px**（不裁切、不拉伸）：
    气泡里常带文字或装饰，裁 bbox 或改比例都会破坏构图。

    `hasText` 原样带进清单：`true` = 该图**自己已经把文字画进去了**（F2 贴纸），
    Host 必须用 `kind: 'image'` 且**不再叠** `bubble.text`，否则屏幕上会出现两段
    打架的文字（契约 §4）。判定来自 `BUBBLE_F2`/`BUBBLE_F3`/`CUTOUT_EXTRA` 显式表。
    """
    src = item.get('cutout') or item['path']
    if item['kind'] == 'gif':
        im = gif_frames(src)[0][0]              # 气泡用首帧（静态）
    else:
        im = read_rgba(src)
    if max(im.size) > BUBBLE_MAX:
        s = BUBBLE_MAX / float(max(im.size))
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))),
                       Image.LANCZOS)

    rel = os.path.join('bubble', '%s.png' % item['semantic'].replace(':', '-'))
    path = os.path.join(ART, rel)
    im.save(path, 'PNG', optimize=True)
    report['made'].append((rel, im.size, os.path.getsize(path)))
    return {'file': rel.replace(os.sep, '/'), 'w': im.width, 'h': im.height,
            'hasText': bool(has_text)}


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
        sub = {'wx': 'png', 'gif': 'gif'}[u['kind']]
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

    清理范围严格限定在脚本自管的三个目录（顶层 `*.png`、`bubble/`、`thumbs/`），
    **绝不碰 `src/`（含用户手动抠图）与 `pet.json`**。
    """
    removed = []
    for pat in ('*.png', os.path.join('bubble', '*.png'), os.path.join('thumbs', '*.png')):
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
      · **表情包（bubble）** —— 逐项打印 `hasText`（F2 贴纸 true / F3 场景 false）。
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
    print('  hasText=true → Host 必须 kind=image，**不再叠 bubble.text**（否则两段文字打架）')
    print('  hasText=false → 可配 Host 文字（kind=both）')
    print('━' * 70)
    n_text = sum(1 for _, ht in bubbles if ht)
    print('  气泡池共 %d 张：hasText=true %d 张，hasText=false %d 张'
          % (len(bubbles), n_text, len(bubbles) - n_text))
    print('  %-4s %-24s %-16s %-14s %6s' % ('', '语义名', '来源文件', '家族', 'hasText'))
    for it, ht in bubbles:
        fam = 'F2 贴纸' if ht else ('F3 场景' if not it['semantic'].startswith('gif:')
                                    else 'F3 GIF')
        print('  [OK] %-24s %-16s %-14s %6s'
              % (it['semantic'], it['name'], fam, 'true' if ht else 'false'))
    print('  未在显式表里的新文件 → 默认 hasText=false（安全侧：允许配文字）')
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
        for pat in ('*.png', os.path.join('bubble', '*.png'), os.path.join('thumbs', '*.png')):
            for p in glob.glob(os.path.join(ART, pat)):
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
    for s in states:
        referenced.add(os.path.join('thumbs', '%s.png' % s))
    prune_unreferenced(referenced, report)

    # ── 汇总 ──
    total = sum(n for _, _, n in report['made'])
    print('产出 %d 个文件到 art/pet/（合计 %.2f MB）'
          % (len(report['made']), total / 1024.0 / 1024.0))
    for name, size, nbytes in report['made']:
        if size is None:
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
    print('气泡池（表情包，F2+F3）：%d 张；其中 hasText=true %d 张、false %d 张'
          % (len(bubbles), n_text, len(bubbles) - n_text))
    print('待抠/缺失：%d 项；弃用：%d 项' % (len(manifest['missing']), len(dropped)))
    if report.get('pruned'):
        print('清理旧产物 %d 个（清单已不再引用）：%s'
              % (len(report['pruned']), ', '.join(report['pruned'])))
    print('（缺失不影响运行：Host 对缺席状态回落 idle，契约 §4）')
    return 0


if __name__ == '__main__':
    sys.exit(main())