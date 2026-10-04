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
  · **清单是唯一契约**。`pet.json` 严格照契约 §4；`states` 的键只能取 §1 的 9 个状态名，
    缺状态时 Host 回落 `idle`，**缺失不得导致任何一方报错**。
  · **用户手动抠图自动纳入**。`art/pet/src/cutout/<状态名>.png` 会覆盖同名状态映射，
    抠完丢进去重跑即可，无需改代码；这些图同样会过一遍透明占比检查。
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

# ── 状态映射计划：候选按优先级排列，取第一个可用的 ──────────────────────────
# 一个状态给多个候选 → 写进 `variants` 轮换，避免同状态永远一张图、显得呆板。
# `gif:NN` 指 `QQ表情\\表情包_NN_*.gif`；其余是 `WX_NAMES` 的语义名。
# 9 个状态**全部覆盖**（sleeping 由 24_睡觉zzz 撑起）。
STATE_PLAN = (
    ('waking',    ('cheer', 'gif:29')),
    ('idle',      ('sleepy', 'gif:28', 'gif:26')),
    ('listening', ('wink', 'gif:07')),
    ('thinking',  ('starry', 'gif:03', 'gif:28')),
    ('working',   ('writing', 'gif:26', 'gif:04')),
    ('waiting',   ('shy', 'gif:01')),
    ('happy',     ('gif:06', 'joy', 'gif:29', 'cheer', 'gif:07')),
    ('error',     ('gif:02', 'snack')),
    ('sleeping',  ('gif:24', 'sleepy')),
)

# 用户手动抠图目录：文件名即状态名，放进去重跑即自动纳入并覆盖内置映射。
CUTOUT = os.path.join(SRC, 'cutout')


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


def load_cutouts(state):
    """取用户在 `cutout/` 放的手动抠图，**按文件名排序返回全部匹配项**。

    命名规则：`<状态名>.png` 是主变体，`<状态名>-2.png`、`<状态名>-3.png`…
    作为同状态的轮换变体（契约 §4 的 `variants`）。用户抠多少张就纳入多少张，
    重跑即可生效，无需改代码。
    """
    if not os.path.isdir(CUTOUT):
        return []
    exact = os.path.join(CUTOUT, state + '.png')
    hits = sorted(glob.glob(os.path.join(CUTOUT, state + '*.png')))
    if os.path.isfile(exact):
        # 主变体排最前，其余按名字序跟在后面
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


# ── 素材发现与自动分类 ──────────────────────────────────────────────────────

def discover():
    """扫源素材并**自动分类**，返回 (可用列表, 待抠列表, 弃用列表)。

    可用 = 已透明的 wx PNG + 通过透明占比判据的动态 GIF；
    待抠 = 17 张 `QQ表情\\*.png`（用户手动抠图）+ 未通过判据的 GIF；
    弃用 = 根目录 6 张单帧 GIF（与 wx PNG 重复，实测配对见 README）。
    """
    usable, needs_cutout, dropped = [], [], []

    # ── wx 的 8 张已透明 PNG（首选）──
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

    # ── QQ表情 的 17 张 PNG：用户明确要求手动抠图，只暂存不处理 ──
    for p in sorted(glob.glob(os.path.join(ASSETS_QQ, '*.png'))):
        base = os.path.basename(p)
        im = Image.open(p)
        detail = '四角纯白、完全不透明，需手动抠图'
        if im.mode in ('RGBA', 'LA'):
            mt = min_transparent_ratio([im.convert('RGBA')])
            if mt >= SOLID_EPS:
                # 25_看书.png 是唯一例外：它自带部分 alpha（含不透明桌面场景）。
                # 仍按用户意愿列入待抠，但如实说明它其实已有 alpha。
                detail = ('已含部分 alpha（透明占比 %.0f%%），但带不透明桌面场景；'
                          '用户认可即可直接放入 src/cutout/' % (mt * 100))
        needs_cutout.append({'name': base, 'reason': 'needsCutout', 'detail': detail})

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

    src = item.get('cutout') or item['path']
    if item['kind'] == 'gif':
        frames, durations = gif_frames(src)
        frame_ms = median_ms(durations)
    else:
        frames, frame_ms = [read_rgba(src)], 0

    # 用**并集**包围盒统一裁切，避免逐帧偏移不同导致动画抖动
    box = union_bbox(frames)
    if box:
        frames = [f.crop(box) for f in frames]
    tiles = [to_height(f, FRAME_HEIGHT) for f in frames]

    # 帧宽取最大值，窄帧水平居中 —— 保证条带是规整网格，取帧不会错位
    cell_w = max(t.width for t in tiles)
    strip = Image.new('RGBA', (cell_w * len(tiles), FRAME_HEIGHT), (0, 0, 0, 0))
    for i, t in enumerate(tiles):
        strip.paste(t, (i * cell_w + (cell_w - t.width) // 2, 0), t)

    path = os.path.join(ART, rel)
    strip.save(path, 'PNG', optimize=True)
    report['made'].append((rel, strip.size, os.path.getsize(path)))

    entry = {'file': rel, 'frames': len(tiles), 'frameMs': frame_ms,
             'frameHeight': FRAME_HEIGHT, 'anchorY': 1.0}
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


def write_bubble(item, report):
    """产出气泡表情池 `art/pet/bubble/<语义名>.png`。

    气泡按 **1:1 等比缩到不超过 256px**（不裁切、不拉伸）：
    气泡里常带文字或装饰，裁 bbox 或改比例都会破坏构图。
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
    return {'file': rel.replace(os.sep, '/'), 'w': im.width, 'h': im.height}


def stage_sources(usable, report):
    """把源素材暂存进 `art/pet/src/`（**只拷贝，绝不修改源素材**）。

    幂等：内容一致就不重写，避免无意义的 mtime 变化。
    """
    staged = {'png': 0, 'gif': 0, 'raw': 0}
    for u in usable:
        sub = {'wx': 'png', 'gif': 'gif'}[u['kind']]
        copy_if_different(u['path'], os.path.join(SRC, sub, u['name']))
        staged[sub] += 1
    for p in sorted(glob.glob(os.path.join(ASSETS_QQ, '*.png'))):
        copy_if_different(p, os.path.join(SRC, 'raw', os.path.basename(p)))
        staged['raw'] += 1
    report['staged'] = staged


def write_manifest(states, variants, bubbles, missing, report):
    """写 `art/pet/pet.json`（契约 §4 的唯一素材清单）。

    `generatedAt` 故意**不写真实时间**：它会让每次重跑产生不同字节、破坏幂等。
    这里写一个固定占位值，让「连跑两次结果一致」可被 sha256 验证。
    """
    manifest = {
        'version': MANIFEST_VERSION,
        'generatedAt': '1970-01-01T00:00:00.000Z',
        'frameHeight': FRAME_HEIGHT,
        'states': states,
        'variants': variants,
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

def print_check(mapping, gif_rows, png_rows, dropped, bubbles, usable, states_light):
    """`--check`：只报覆盖率与透明占比，**缺图只警告不报错**，退出码恒为 0。"""
    print('素材覆盖率报告（--check，只读，未写任何文件）')
    print('=' * 70)
    print('源素材目录：%s' % ASSETS)
    print('可用素材 %d 项；待抠 %d 项；弃用 %d 项'
          % (len(usable), len(png_rows) + sum(1 for g in gif_rows if not g[2]), len(dropped)))
    print()
    print('动态 GIF 透明占比判定（minT%% = 全部帧里最小的 alpha==0 占比；'
          '<%.1f%% 判为有背景板）' % (SOLID_EPS * 100))
    for name, n, ok, mt in gif_rows:
        print('  %s %-26s %2d 帧  minT=%6.2f%%  %s'
              % ('[OK]  ' if ok else '[待抠]', name, n, mt * 100,
                 '可用于动画' if ok else '★有实心帧 → 排除动画'))
    print()
    print('QQ表情 PNG（用户手动抠图，本次不处理）：')
    for name, mt in png_rows:
        note = '  ← 已含部分 alpha' if mt >= SOLID_EPS else ''
        print('  [待抠] %-26s minT=%6.2f%%%s' % (name, mt * 100, note))
    print()
    print('弃用（与 wx PNG 重复的单帧 GIF）：%d 张' % len(dropped))
    print()
    print('状态覆盖（契约 §1 的 9 个状态）：')
    for s in PET_STATES:
        if s in states_light:
            st = states_light[s]
            print('  [OK] %-10s %-14s %2d 帧 @%dms  variants=%d'
                  % (s, st['file'], st['frames'], st['frameMs'], len(mapping.get(s, []))))
        else:
            print('  [缺] %-10s → Host 回落 idle' % s)
    print()
    print('气泡表情池：%d 张' % len(bubbles))
    covered = sum(1 for s in PET_STATES if s in states_light)
    print('覆盖率：%d/%d 状态有专属素材（缺 %d 个，仅警告）'
          % (covered, len(PET_STATES), len(PET_STATES) - covered))
    print('提示：把抠好的图按 `<状态名>.png` 放进 art/pet/src/cutout/ 后重跑本脚本即可纳入。')
    return 0


# ── 主流程 ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='庄方宜桌宠素材管线（不抠图、保留 alpha）')
    parser.add_argument('--check', action='store_true', help='只报覆盖率，不写文件；缺图只警告')
    parser.add_argument('--clean', action='store_true', help='重建前清掉 art/pet 下的旧产物')
    args = parser.parse_args()

    if not os.path.isdir(ASSETS):
        print('找不到素材目录：%s' % ASSETS, file=sys.stderr)
        print('请确认 庄方宜素材\\ 与 dsh-zhuang-fangyi-pet\\ 在同一级目录下。', file=sys.stderr)
        return 1

    usable, missing, dropped = discover()
    by_semantic, mapping = build_mapping(usable)

    # 手动抠图覆盖：用户放进 cutout/ 的图**优先于**内置映射（主变体排最前）
    for state in PET_STATES:
        for i, p in enumerate(load_cutouts(state)):
            frames = gif_frames(p)[0] if p.lower().endswith('.gif') else [read_rgba(p)]
            mt = min_transparent_ratio(frames)
            # 手动图也过一遍同一判据：有实心帧就警告，但不拦（用户明确认可的东西由他决定）
            if mt < SOLID_EPS:
                print('警告：cutout/%s 有实心帧（透明占比 %.2f%%），'
                      '播放可能出现矩形块' % (os.path.basename(p), mt * 100),
                      file=sys.stderr)
            item = {'kind': 'png' if not p.lower().endswith('.gif') else 'gif',
                    'semantic': '%s-cut%d' % (state, i), 'name': os.path.basename(p),
                    'path': p, 'cutout': p, 'minT': mt, 'frames': len(frames)}
            mapping.setdefault(state, []).insert(i, item)
            by_semantic[item['semantic']] = item

    # 气泡池：全部可用素材（8 张 wx + 通过判据的 GIF）都进池
    bubble_items, seen = [], set()
    for u in usable:
        if u['semantic'] not in seen:
            seen.add(u['semantic'])
            bubble_items.append(u)

    if args.check:
        # 只报覆盖率：轻量探测（不写文件、不缩放、不裁切）
        light = {}
        for state, items in mapping.items():
            it = items[0]
            src = it.get('cutout') or it['path']
            if it['kind'] == 'gif':
                _, durs = gif_frames(src)
                light[state] = {'file': '%s.png' % state,
                                'frames': it.get('frames') or 1,
                                'frameMs': median_ms(durs)}
            else:
                light[state] = {'file': '%s.png' % state, 'frames': 1, 'frameMs': 0}
        gif_rows = [(u['name'], u['frames'], True, u['minT'])
                    for u in usable if u['kind'] == 'gif']
        # 被排除的 GIF 也列出来，让用户看清为什么被排除
        for p in sorted(glob.glob(os.path.join(ASSETS_QQ, '*.gif'))):
            base = os.path.basename(p)
            if any(base == g[0] for g in gif_rows):
                continue
            fr, _ = gif_frames(p)
            gif_rows.append((base, len(fr), False, min_transparent_ratio(fr)))
        png_rows = []
        for p in sorted(glob.glob(os.path.join(ASSETS_QQ, '*.png'))):
            im = Image.open(p)
            mt = min_transparent_ratio([im.convert('RGBA')]) \
                if im.mode in ('RGBA', 'LA') else 0.0
            png_rows.append((os.path.basename(p), mt))
        return print_check(mapping, gif_rows, png_rows, dropped, bubble_items,
                           usable, light)

    ensure_dirs()
    if args.clean:
        # art/pet 整棵树都是本脚本的产出范围，清掉旧图后重生成
        for pat in ('*.png', os.path.join('bubble', '*.png'), os.path.join('thumbs', '*.png')):
            for p in glob.glob(os.path.join(ART, pat)):
                os.remove(p)

    report = {'made': []}
    stage_sources(usable, report)

    states, variants, cache = {}, {}, {}
    for state, items in mapping.items():
        entries = [write_strip(state, it, i, report, cache)
                   for i, it in enumerate(items)]
        states[state] = entries[0]                       # 契约 §4：variants 必须含 states
        variants[state] = [e['file'] for e in entries]
        write_thumb(state, entries[0], report)

    bubbles = [write_bubble(u, report) for u in bubble_items]
    manifest = write_manifest(states, variants, bubbles, missing, report)

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
    print('暂存源素材：png/ %d 张，gif/ %d 张，raw/ %d 张'
          % (report['staged']['png'], report['staged']['gif'], report['staged']['raw']))
    print('状态覆盖：%d/%d' % (len(states), len(PET_STATES)))
    for s in PET_STATES:
        n = len(variants.get(s, []))
        print('  %s %-10s variants=%d' % ('[OK]' if s in states else '[缺]', s, n))
    print('气泡池：%d 张；待抠：%d 项；弃用：%d 项'
          % (len(bubbles), len(manifest['missing']), len(dropped)))
    print('（缺失不影响运行：Host 对缺席状态回落 idle，契约 §4）')
    return 0


if __name__ == '__main__':
    sys.exit(main())