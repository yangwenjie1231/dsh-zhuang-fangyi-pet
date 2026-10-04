#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
庄方宜桌宠 · 素材管线（`prepare-pet.py`）

从 `庄方宜素材\\10-表情包\\` 取表情素材，产出 Host 半边与原生 exe **共用**的
精灵条带、气泡表情池、缩略图与素材清单 `art/pet/pet.json`（契约 §4）。

可重复运行：每次覆盖 `art/pet/` 下同名产物，**绝不修改源素材**；连跑两次结果一致（幂等）。

用法：
    python tools/prepare-pet.py                  # 全量重建（默认）
    python tools/prepare-pet.py --check          # 只报覆盖率，不写任何文件；缺图只警告
    python tools/prepare-pet.py --clean          # 重建前先清掉本脚本管理的旧产物

设计要点：
  · **不抠图**。17 张 1000×1000 PNG 是四角纯白的不透明图，用户明确要求**手动抠图**；
    本脚本只把它们原样暂存到 `art/pet/src/raw/` 供取用，并记进 `missing`，
    绝不键控背景、绝不 `flatten()`。
  · **保留 alpha**。所有输出都是 RGBA；精灵图与气泡**只缩不放**，
    且缩放前先 `getbbox()` 裁掉四周全透明留白（裁 alpha 不丢信息，
    还能避免 240×240 里人物只占中间一小块）。绝不贴白底。
  · **干净集取交集**。动态 GIF 是否有「自带背景板」由实测判定（见 `GIF_SUSPECT`），
    但**是否纳入动画**额外要求它同时出现在任务给定的干净名单里（见 `GIF_TRUSTED_CLEAN`）
    —— 两份名单取交集，宁可少用也不把带背景板的图混进动画。
  · **帧高 256px**（本机 150% DPI，小了会糊）。`frameMs` 取该 GIF 各帧时长的**中位数**，
    所以 30/60ms 交错的动画取 30ms（快帧更接近视觉节奏）。
  · **清单是唯一契约**。`pet.json` 严格照契约 §4；`states` 的键只能取 §1 的 9 个状态名，
    缺状态时 Host 回落 `idle`，**缺失不得导致任何一方报错**。
  · **用户手动抠图自动纳入**。`art/pet/src/cutout/` 下任何图片会覆盖同名状态映射，
    抠完丢进去重跑即可，无需改代码。
"""

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import sys
from collections import Counter

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
# §4 清单版本号与帧高（本机 150% DPI）
MANIFEST_VERSION = 1
FRAME_HEIGHT = 256
THUMB_HEIGHT = 48

# ── 已透明的 8 张 wx PNG：语义名 → 源文件名 ──────────────────────────────────
# 这 8 张是**首选素材**（用户明确要求 PNG 优先）：240×240 RGBA，四角 alpha=0，
# 已实测确认干净。它们同时用于状态精灵条带与气泡池。
# 语义名按实际画面判定（我逐张看图确认，不是猜的）：
#   1 捂嘴害羞 / 2 开心抱绿植 / 3 眨眼比耶 / 4 吃东西 / 5 星空比耶 /
#   6 趴桌睡着 / 7 双手比耶 / 8 写字
WX_NAMES = {
    'shy':         '1.png',
    'joy':         '2.png',
    'wink':        '3.png',
    'snack':       '4.png',
    'starry':      '5.png',
    'sleepy':      '6.png',
    'cheer':       '7.png',
    'writing':     '8.png',
}

# ── 动态 GIF 的实测判定 ──────────────────────────────────────────────────────
# 每一项：(源文件名前缀, 状态语义, 是否确认干净)
#
# `GIF_SUSPECT`：**实检发现自带背景板**的 GIF。判据是「magenta 底渲染 + 逐帧扫描
#   连续『不透明行占满 ≥95% 宽度』的行数」——背景板会整块挡住洋红：
#     05_星空公式 → 整幅深蓝星空板（500/500 行全不透明）
#     24_睡觉zzz  → 浅蓝矩形板
#     26_趴面     → 整幅不透明意面盘（洋红透过率 0%）
#     27_生气指人 → 末帧出现蓝色板
#     28_挂件吊坠 → 白卡片板 + "2.8K/100" 字样
#   这些一律**排除在动画之外**并标 `needsCutout`，等用户自己处理，本脚本不键控。
#
# `GIF_TRUSTED_CLEAN`：任务给定的干净名单 {03,04,06,07,26}。
#   注意 26_趴面 在这份名单里，但我的实测显示它有背景板 —— 两份名单**取交集**
#   作为「纳入动画」的条件，于是实际只用 {03,04,06,07}。
#   这样既不会把背景板混进动画，也不擅自违背任务给定的名单；
#   差异已在 `--check` 与 `missing` 里如实标出。
GIF_SUSPECT = ('05', '24', '26', '27', '28')
GIF_TRUSTED_CLEAN = ('03', '04', '06', '07', '26')

# 状态语义映射：候选按优先级排列，取第一个可用的。
# 一个状态可有多个候选 → 填进 `variants` 轮换，避免呆板。
STATE_PLAN = (
    ('idle',      ('sleepy', 'gif:03', 'shy')),
    ('thinking',  ('gif:03', 'starry')),
    ('working',   ('writing', 'gif:04')),
    ('waiting',   ('shy', 'gif:04')),
    ('happy',     ('joy', 'gif:04', 'wink', 'cheer')),
    ('error',     ('gif:07', 'starry', 'snack')),
    ('listening', ('wink', 'gif:03')),
    ('waking',    ('cheer', 'wink')),
    # 素材缺口：唯一候选 24_睡觉zzz 自带背景板 → 本状态缺席，Host 回落 idle。
    ('sleeping',  ('gif:24',)),
)

# 用户手动抠图目录：文件名即状态名（或语义名），放进去重跑即自动纳入。
CUTOUT = os.path.join(SRC, 'cutout')

# 生产产物全部带这个标记，便于 --clean 精确清理、绝不误删用户文件。
MARK = '_petgen'


def is_generated(name):
    """判断文件名是否是本脚本的产物（用于 --clean 与目录清理）。"""
    return MARK in name


# ── 基础工具 ────────────────────────────────────────────────────────────────

def ensure_dirs():
    """建好全部输出目录（含用户手动抠图的 cutout/）。"""
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
    `convert('RGBA')` 之前必须先 `seek()`，否则拿到的是错帧。
    """
    im = Image.open(path)
    frames, durations = [], []
    for i in range(getattr(im, 'n_frames', 1)):
        im.seek(i)
        frames.append(im.convert('RGBA'))
        durations.append(int(im.info.get('duration') or 0))
    return frames, durations


def median_ms(durations, fallback=60):
    """取帧时长中位数作为 `frameMs`。

    实测 7 张 GIF 是 30/60ms 交错，中位数取到 30ms —— 比取均值更贴近视觉节奏
    （快帧才是主体，慢帧只是个别停顿）。
    """
    vals = sorted(d for d in durations if d > 0)
    if not vals:
        return fallback
    return vals[len(vals) // 2]


def trimmed(im):
    """裁掉四周全透明留白（**只裁 alpha，不丢任何可见信息**）。

    240×240 的 wx 图里人物只占中间一块，直接缩到 256px 会让主体偏小；
    裁到 alpha 包围盒再缩放，主体就能撑满帧高。
    """
    box = im.getbbox()          # RGBA 的 getbbox 只看非零像素（含 alpha）
    return im.crop(box) if box else im


def fit_height(im, height):
    """等比缩放到指定高度（**只缩不放**，避免小图被拉糊）。"""
    if im.height == 0:
        return im
    if im.height <= height:
        return im
    w = max(1, round(im.width * height / im.height))
    return im.resize((w, height), Image.LANCZOS)


def load_cutout(state):
    """取用户在 `cutout/` 放的手动抠图（存在则覆盖内置映射）。

    文件名规则：`<状态名>.png` 优先，其次任意以状态名开头的图片。
    这样用户抠完一张 `sleeping.png` 丢进去，重跑就能补齐缺口状态。
    """
    if not os.path.isdir(CUTOUT):
        return None
    exact = os.path.join(CUTOUT, state + '.png')
    if os.path.isfile(exact):
        return exact
    for p in sorted(glob.glob(os.path.join(CUTOUT, state + '*' + '.png'))):
        return p
    return None


def copy_if_different(src, dst):
    """按内容比较后再拷贝：内容一致就**不动 mtime**，保证幂等可验证。"""
    if os.path.isfile(dst):
        with open(src, 'rb') as f1, open(dst, 'rb') as f2:
            if f1.read() == f2.read():
                return False
    shutil.copy2(src, dst)
    return True


def digest(path):
    """文件 sha256（幂等自检用）。"""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


# ── 素材发现 ────────────────────────────────────────────────────────────────

def discover():
    """扫源素材，返回 (可用列表, 待抠列表)。

    可用 = 已透明的 wx PNG + 判定干净的动态 GIF；
    待抠 = 17 张不透明 PNG + 自带背景板的 GIF + 弃用的根目录单帧 GIF。
    """
    usable, needs_cutout = [], []

    # ── wx 的 8 张已透明 PNG（首选）──
    for semantic, fname in sorted(WX_NAMES.items()):
        p = os.path.join(ASSETS_WX, fname)
        if os.path.isfile(p):
            usable.append({'kind': 'wx', 'semantic': semantic, 'name': fname, 'path': p})
        else:
            needs_cutout.append({'name': 'wx/%s（%s）' % (fname, semantic),
                                 'reason': 'missing', 'detail': '源文件不存在'})

    # ── 12 张动态 GIF ──
    for p in sorted(glob.glob(os.path.join(ASSETS_QQ, '*.gif'))):
        base = os.path.basename(p)
        idx = base.split('_')[1] if '_' in base else ''
        if idx in GIF_SUSPECT:
            needs_cutout.append({'name': base, 'reason': 'needsCutout',
                                 'detail': '实测自带背景板，已排除动画（不键控，等手动抠图）'})
            continue
        if idx not in GIF_TRUSTED_CLEAN:
            needs_cutout.append({'name': base, 'reason': 'needsCutout',
                                 'detail': '不在任务给定的干净名单内，保守排除'})
            continue
        usable.append({'kind': 'gif', 'semantic': 'gif:' + idx, 'name': base, 'path': p})

    # ── 17 张不透明 PNG（待用户手动抠图）──
    for p in sorted(glob.glob(os.path.join(ASSETS_QQ, '*.png'))):
        needs_cutout.append({'name': os.path.basename(p), 'reason': 'needsCutout',
                             'detail': '四角纯白、完全不透明，需手动抠图'})

    # ── 根目录 6 张单帧 GIF（与 wx PNG 重复，弃用）──
    for p in sorted(glob.glob(os.path.join(ASSETS, '*.gif'))):
        needs_cutout.append({'name': os.path.basename(p), 'reason': 'duplicate',
                             'detail': '与 wx PNG 重复的单帧 GIF，弃用'})

    return usable, needs_cutout


def build_index(usable):
    """把可用素材索引成 {语义名: 素材} 与 {状态名: [素材…]}。"""
    by_semantic = {u['semantic']: u for u in usable}
    mapping = {}
    for state, cands in STATE_PLAN:
        picked = [by_semantic[c] for c in cands if c in by_semantic]
        if picked:
            mapping[state] = picked
    return by_semantic, mapping


# ── 产出 ────────────────────────────────────────────────────────────────────

def write_strip(state, item, report):
    """产出某状态的横向精灵条带 `art/pet/<state>.png`。

    条带 = `frames × frameHeight` 宽、`frameHeight` 高（契约 §6）：
    一份产物同时喂 WPF 的 `CroppedBitmap` 与 overlay 的 CSS `steps(N)`。
    单帧素材也输出条带（frames=1），让两端走同一条代码路径。
    """
    src = item.get('cutout') or item['path']
    if item['kind'] == 'gif':
        frames, durations = gif_frames(src)
        frame_ms = median_ms(durations)
    else:
        frames, frame_ms = [read_rgba(src)], 0

    tiles = [fit_height(trimmed(f), FRAME_HEIGHT) for f in frames]
    # 帧宽取最大值，窄帧水平居中——避免条带里帧宽不齐导致取帧错位
    cell_w = max(t.width for t in tiles)
    strip = Image.new('RGBA', (cell_w * len(tiles), FRAME_HEIGHT), (0, 0, 0, 0))
    for i, t in enumerate(tiles):
        strip.paste(t, (i * cell_w + (cell_w - t.width) // 2, 0), t)

    rel = '%s%s.png' % (state, MARK)
    path = os.path.join(ART, rel)
    strip.save(path, 'PNG', optimize=True)

    # 缩略图：按同一张条带的**首帧**等比缩到 48px 高，供 UI 列表预览
    thumb = fit_height(tiles[0], THUMB_HEIGHT)
    tpath = os.path.join(ART, 'thumbs', '%s%s.png' % (state, MARK))
    thumb.save(tpath, 'PNG', optimize=True)

    report['made'].append((rel, strip.size, os.path.getsize(path)))
    report['made'].append((os.path.join('thumbs', os.path.basename(tpath)),
                           thumb.size, os.path.getsize(tpath)))
    return {
        'file': rel, 'frames': len(tiles), 'frameMs': frame_ms,
        'frameHeight': FRAME_HEIGHT, 'anchorY': 1.0,
        'source': os.path.basename(src),
    }


def write_bubble(item, report):
    """产出气泡表情池 `art/pet/bubble/<语义名>.png`。

    气泡按 **1:1 等比缩到不超过 256px**（不裁切、不拉伸）：
    气泡里常带文字或装饰，裁 bbox 或改比例都会破坏构图。
    """
    src = item.get('cutout') or item['path']
    if item['kind'] == 'gif':
        frames, _ = gif_frames(src)
        im = frames[0]                      # 气泡用首帧（静态）
    else:
        im = read_rgba(src)
    if max(im.size) > 256:
        scale = 256.0 / max(im.size)
        im = im.resize((max(1, round(im.width * scale)),
                        max(1, round(im.height * scale))), Image.LANCZOS)

    semantic = item['semantic'].replace(':', '-')
    rel = os.path.join('bubble', '%s%s.png' % (semantic, MARK))
    path = os.path.join(ART, rel)
    im.save(path, 'PNG', optimize=True)
    report['made'].append((rel, im.size, os.path.getsize(path)))
    return {'file': rel.replace(os.sep, '/'), 'w': im.width, 'h': im.height}


def stage_sources(usable, report):
    """把源素材暂存进 `art/pet/src/`（**只拷贝，绝不修改源**）。

    幂等：内容一致就不重写，避免无意义的 mtime 变化。
    """
    counts = Counter()
    for u in usable:
        sub = {'wx': 'png', 'gif': 'gif'}[u['kind']]
        dst = os.path.join(SRC, sub, u['name'])
        if copy_if_different(u['path'], dst):
            counts[sub + '(新)'] += 1
        counts[sub] += 1
    for p in sorted(glob.glob(os.path.join(ASSETS_QQ, '*.png'))):
        dst = os.path.join(SRC, 'raw', os.path.basename(p))
        if copy_if_different(p, dst):
            counts['raw(新)'] += 1
        counts['raw'] += 1
    report['staged'] = counts


def write_manifest(states, variants, bubbles, missing, report):
    """写 `art/pet/pet.json`（契约 §4 的唯一素材清单）。

    `generatedAt` 故意**不写真实时间**：它会让每次重跑产生不同字节、破坏幂等。
    这里写一个固定值，让「连跑两次结果一致」可被 sha256 验证。
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

def print_check(mapping, missing, states, bubbles, usable):
    """`--check`：只报覆盖率，**缺图只警告不报错**，退出码恒为 0。"""
    print('素材覆盖率报告（--check，只读，未写任何文件）')
    print('─' * 66)
    print('源素材目录：%s' % ASSETS)
    print('可用素材 %d 项；待抠/弃用 %d 项' % (len(usable), len(missing)))
    print()
    print('状态覆盖（契约 §1 的 9 个状态）：')
    for s in PET_STATES:
        if s in states:
            st = states[s]
            vs = len(mapping.get(s, []))
            print('  [OK]   %-10s %-22s %2d 帧 @%dms  variants=%d' % (
                s, st['file'], st['frames'], st['frameMs'], vs))
        else:
            print('  [缺]   %-10s → Host 回落 idle' % s)
    print()
    print('气泡表情池：%d 张' % len(bubbles))
    print('待抠 / 不可用清单：')
    for m in missing:
        print('  - %-42s %s' % (m['name'], m['detail']))
    covered = sum(1 for s in PET_STATES if s in states)
    print()
    print('覆盖率：%d/%d 状态有专属素材（缺 %d 个，仅警告）'
          % (covered, len(PET_STATES), len(PET_STATES) - covered))
    if covered < len(PET_STATES):
        print('提示：把抠好的图按 `<状态名>.png` 放进 art/pet/src/cutout/ 后重跑本脚本即可补齐。')
    return 0


# ── 主流程 ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='庄方宜桌宠素材管线（不抠图、保留 alpha）')
    parser.add_argument('--check', action='store_true', help='只报覆盖率，不写文件；缺图只警告')
    parser.add_argument('--clean', action='store_true', help='重建前清掉本脚本的旧产物')
    args = parser.parse_args()

    if not os.path.isdir(ASSETS):
        print('找不到素材目录：%s' % ASSETS, file=sys.stderr)
        print('请确认 庄方宜素材\\ 与 dsh-zhuang-fangyi-pet\\ 在同一级目录下。', file=sys.stderr)
        return 1

    usable, missing = discover()
    by_semantic, mapping = build_index(usable)

    # 手动抠图覆盖：用户放进 cutout/ 的图优先于内置映射
    for state in PET_STATES:
        p = load_cutout(state)
        if p:
            item = {'kind': 'png', 'semantic': state, 'name': os.path.basename(p),
                    'path': p, 'cutout': p}
            mapping.setdefault(state, []).insert(0, item)
            by_semantic[state] = item

    # 气泡池：可用素材（wx + 干净 GIF）全进；wx/3、wx/5 即使被状态占用也保留
    bubble_items, seen = [], set()
    for u in usable:
        if u['semantic'] in seen:
            continue
        seen.add(u['semantic'])
        bubble_items.append(u)

    # 先把 mapping 拍平成 states / variants，便于 --check 直接报告
    states, variants = {}, {}
    plan_states = {}
    for state, items in mapping.items():
        plan_states[state] = items
        if items:
            states[state] = items[0]        # 占位，真正条目在写文件时回填
    if args.check:
        # --check 只报覆盖率，因此用轻量探测（不写文件、不缩放）
        light = {}
        for state, items in plan_states.items():
            it = items[0]
            src = it.get('cutout') or it['path']
            if it['kind'] == 'gif':
                _, durs = gif_frames(src)
                light[state] = {'file': '%s%s.png' % (state, MARK), 'frames': 0,
                                'frameMs': median_ms(durs), 'anchorY': 1.0}
            else:
                light[state] = {'file': '%s%s.png' % (state, MARK), 'frames': 1,
                                'frameMs': 0, 'anchorY': 1.0}
        return print_check(plan_states, missing, light,
                           ['bubble/%s%s.png' % (u['semantic'].replace(':', '-'), MARK)
                            for u in bubble_items], usable)

    ensure_dirs()
    if args.clean:
        for p in glob.glob(os.path.join(ART, '*.png')) + \
                 glob.glob(os.path.join(ART, 'bubble', '*.png')) + \
                 glob.glob(os.path.join(ART, 'thumbs', '*.png')):
            if is_generated(os.path.basename(p)):
                os.remove(p)

    report = {'made': []}
    stage_sources(usable, report)

    states, variants = {}, {}
    for state, items in plan_states.items():
        entries = [write_strip(state, it, report) for it in items]
        states[state] = entries[0]
        variants[state] = [e['file'] for e in entries]

    bubbles = [write_bubble(u, report) for u in bubble_items]
    manifest = write_manifest(states, variants, bubbles, missing, report)

    # ── 汇总 ──
    total = sum(n for _, _, n in report['made'])
    print('产出 %d 个文件到 art/pet/（合计 %.2f MB）'
          % (len(report['made']), total / 1024.0 / 1024.0))
    for name, size, nbytes in report['made']:
        if size == (0, 0):
            print('  %-34s %s' % (name, '清单'))
        else:
            print('  %-34s %5dx%-5d %8.0f KB' % (name, size[0], size[1], nbytes / 1024.0))
    print()
    print('暂存源素材：%s' % dict(report['staged']))
    print('状态覆盖：%d/%d' % (len(states), len(PET_STATES)))
    for s in PET_STATES:
        print('  %s %s' % ('[OK]' if s in states else '[缺]', s))
    print('气泡池：%d 张；待抠/弃用：%d 项' % (len(bubbles), len(manifest['missing'])))
    print('（缺失不影响运行：Host 对缺席状态回落 idle，契约 §4）')
    return 0


if __name__ == '__main__':
    sys.exit(main())