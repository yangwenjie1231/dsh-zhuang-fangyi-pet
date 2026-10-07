#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
庄方宜桌宠 · 素材管线（`prepare-pet.py`）

从**素材台账** `assets/catalog.json` 读取"哪张图归谁"，产出 Host 半边与原生 exe
**共用**的精灵条带、气泡表情池、缩略图与素材清单 `art/pet/pet.json`（契约 §4）。

可重复运行：每次覆盖 `art/pet/` 下同名产物，**绝不修改源素材**；连跑两次结果一致（幂等）。

用法：
    python tools/prepare-pet.py                  # 全量重建（默认）
    python tools/prepare-pet.py --check          # 只报覆盖率与每张图的透明占比；不写文件
    python tools/prepare-pet.py --audit          # 机器可读的一致性审计；有问题退出码 1
    python tools/prepare-pet.py --clean          # 重建前先清掉 art/pet 下的旧产物
    python tools/prepare-pet.py --refresh-raw    # 强制重刷 src/raw/（默认**不覆盖**已有文件！）

── 为什么素材清单是台账（`assets/catalog.json`）而不是脚本里的若干张表 ────────

这一版之前，素材的知识散在**三处**：`prepare-pet.py` 里 8 张表（`WX_NAMES` /
`BUBBLE_F2` / `BUBBLE_F3` / `CUTOUT_EXTRA` / `BUBBLE_ANIM` / `F5_BODY` /
`BUBBLE_F4` / `BODY_EXTRA_BY_FILE`）+ `STATE_PLAN`，以及 `src/pet/emotes.js` 里的
`EMOTE_BY_KEY`。改一次归属要同时动三处，而三处之间没有任何一致性校验 —— 于是
"这张图到底用在哪"只能靠人记。

台账把这一件事收进**一个可读、可 diff、可校验的 JSON**：

    { "id": "smile", "source": "QQ表情/表情包_07_微笑.gif",
      "role": "body", "states": ["idle"], "caption": "平静微笑，日常待机" }

并且**产物文件名也带上 id**（`idle-smile.png` 而不是 `idle.png`）。此前产物按位置
编号（`idle-4.png`），导致：清单里没有身份字段 → 看图认不出画的是什么 → 测试只能
"数张数"（e2e 里 4 处 `variants.happy.length === 8`）。命名带 id 之后，断言可以按
名字写，以后再挪图不用改测试。

── 角色划分（用户拍板，不再是本脚本的判断）─────────────────────────────

台账的 `role` 字段直接写明这张图当什么用：

  | role       | 产物                                  | 说明 |
  |---|---|---|
  | `body`     | `art/pet/<state>-<id>.png`（精灵条带） | 桌宠本体，按 `states[]` 归属 |
  | `bubble`   | `art/pet/bubble/…<id>.png`             | 气泡表情池，按 `keys[]` 归属情境 |
  | `anim`     | `art/pet/bubble/<id>.gif`              | 整段保留的动态气泡（GIF 不重编码） |

历史上"哪批该当主体、哪批只当气泡"由脚本按画风家族 + 中文 baked-in 推断过，
期间反复摇摆（星空公式在气泡与主体之间来回、muscle/sunglasses 被透明占比判据挡住
又放回）。**那些都是用户决定的，现在写进台账，不再由脚本猜。**

── 台账里**故意没有**的字段 ───────────────────────────────────────────

`opaque` / `frames` / `frameWidth` / `frameMs` / `minT` 全部**按指标算**，不进台账。
原因：手写过 20 个 `opaque` 标志位，量完发现猜错 3 个 —— 能量的属性就别靠印象。

设计要点：
  · **不抠图**。用户手动抠好的图在 `art/pet/src/cutout/`（台账里写
    `source: "cutout/xxx.png"`）；脚本只原样使用，绝不键控背景、绝不 `flatten()`。
  · **保留 alpha**。所有输出都是 RGBA。缩放前先裁掉四周全透明留白
    —— 裁 alpha 不丢任何可见信息，还能让主体撑满帧高（240×240 里人物只占中间一块）。
  · **帧高 256px**（本机 150% DPI，小了会糊）。`frameMs` 取该 GIF 各帧时长的**中位数**，
    所以 30/60ms 交错的动画取 30ms（快帧才是视觉主体）。
  · **单帧不是方的**：各素材内容 bbox 的纵横比不同（0.85~1.13），所以「帧高统一 256、
    宽度保纵横比」后单帧宽落在 239~288 之间。清单为每个文件写出 `frameWidth`
    （契约 §4 必需字段），否则两侧会拿 `frameHeight` 当帧宽，把图横向压扁。
    条带宽 = `frames × frameWidth`，**不是** `frames × frameHeight`。
  · **几何按文件给出**：`variants` 是文件名数组，但变体之间帧数差异极大
    （静态 PNG 1 帧 vs 动态 GIF 44 帧），套用 `states` 的 `frames` 去切会切出碎条。
    所以顶层另有 `files` 映射，登记 **canonical + 全部 variants** 每个文件自己的
    `frames`/`frameWidth`/`frameMs`（纯附加字段，旧消费者忽略也能跑）。
  · **一张素材只服务一个状态**（台账校验；确需复用写 `"shared": true`）。
    此前 5 张素材跨 2~3 个状态被复用（"微笑"同时出现在 waking/idle/happy），
    于是"每个状态的表情都不一样"这件事从根上就不成立。
  · **`raw/` 是用户的工作台，写一次就不再动**（防数据丢失，见 `stage_sources()`）。
"""

import argparse
import glob
import json
import os
import shutil
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ART = os.path.join(ROOT, 'art', 'pet')
SRC = os.path.join(ART, 'src')
CUTOUT = os.path.join(SRC, 'cutout')      # 用户手动抠图（台账 source: "cutout/xxx.png"）
RAW = os.path.join(SRC, 'raw')           # 原始参考图工作台，只写不覆盖
DOCS = os.path.join(ROOT, 'docs')

# **素材台账（唯一真相）**。人手维护，本脚本只读。
CATALOG_PATH = os.path.join(ROOT, 'assets', 'catalog.json')

# 源素材根目录：与 dsh-zhuang-fangyi-pet\ 同级
ASSETS = os.path.join(os.path.dirname(ROOT), '庄方宜素材', '10-表情包')
ASSETS_WX = os.path.join(ASSETS, 'wx')
ASSETS_QQ = os.path.join(ASSETS, 'QQ表情')
# F4 线稿贴纸的源素材在 `fromQQ\新表情包\庄方宜(未扣背景)\`（台账写 "新表情包/xxx.png"）
ASSETS_NEW = os.path.join(os.path.dirname(ROOT), 'fromQQ', '新表情包', '庄方宜(未扣背景)')

# ── 契约常量（不得单方面改动，见 docs/接口契约.md §1 / §4）────────────────────
# §1 的 9 个合法状态名；台账里 `states[]` 只能取其中之一。
# `listening` **保留在值域里但运行时不再产出**（用户 2026-10-07：它只有 1.2 秒闩锁、
# 优先级又低于 thinking，实际几乎不作为主体出现；改为只弹气泡，不切状态）。
# 保留是为了向后兼容 —— 老客户端/老设置照常工作，Host 不产出而已。
PET_STATES = ('waking', 'idle', 'listening', 'thinking',
              'working', 'waiting', 'happy', 'error', 'sleeping')
# 实际**分配素材**的状态（listening 不在其中，见上）。
BODY_STATES = ('waking', 'idle', 'thinking', 'working',
               'waiting', 'happy', 'error', 'sleeping')
MANIFEST_VERSION = 1
FRAME_HEIGHT = 256          # 契约 §4 / §6：精灵条带的帧高
THUMB_HEIGHT = 48           # 缩略图高（仅 UI 预览用）
BUBBLE_MAX = 256            # 气泡最长边上限（1:1 缩放，不裁切）
SOLID_EPS = 0.005           # 透明占比低于 0.5% 即视为「实心帧」（**只报告，不拦截**）
OPAQUE_MIN = 0.95           # `opaque`（要不要套气泡底）判据：多数帧满幅才算满幅
# 气泡情境分组顺序（台账按此顺序生成 `emotes.data.js`，让清单顺序稳定可 diff）。
BUBBLE_KEY_ORDER = ('happy', 'notify-complete', 'working', 'thinking', 'waiting',
                    'error', 'tool/failed', 'inbox/inserted', 'idle', 'sleeping', 'waking')


# ── 台账 ────────────────────────────────────────────────────────────────────

class CatalogError(Exception):
    """台账本身有问题（结构不合法 / 素材重复登记 / 跨状态重复）。**直接报错退出**，不静默跳过。"""


def load_catalog(path=CATALOG_PATH):
    """读 `assets/catalog.json` 并做**全部**结构校验。

    校验失败一律抛 `CatalogError`：台账是唯一真相，宁可停下也不要"跳过坏的继续跑"
    —— 那样会悄悄少几张图，而症状要等到桌面上少了表情才看得出来。
    """
    if not os.path.isfile(path):
        raise CatalogError('找不到素材台账：%s' % path)
    with open(path, 'r', encoding='utf-8') as f:
        doc = json.load(f)
    entries = doc.get('assets')
    if not isinstance(entries, list) or len(entries) == 0:
        raise CatalogError('台账里没有 assets 数组（或为空）：%s' % path)

    problems, seen = [], {}
    by_id = {}
    for raw in entries:
        if not isinstance(raw, dict):
            problems.append('非对象条目：%r' % (raw,))
            continue
        aid = raw.get('id')
        if not isinstance(aid, str) or aid == '':
            problems.append('条目缺 id：%r' % (raw,))
            continue
        if aid in seen:
            problems.append('id 重复：%s（第 %d 条与第 %d 条）'
                            % (aid, seen[aid], len(by_id) + 1))
            continue
        seen[aid] = len(by_id) + 1
        role = raw.get('role')
        if role not in ('body', 'bubble', 'anim'):
            problems.append('%s：role 非法（%r），只能是 body / bubble / anim' % (aid, role))
            continue
        if not isinstance(raw.get('source'), str) or raw['source'] == '':
            problems.append('%s：缺 source（相对素材根目录的路径）' % aid)
            continue
        if role == 'body':
            states = raw.get('states')
            if not isinstance(states, list) or not states:
                problems.append('%s：role=body 必须给 states[]（第 1 个是主图）' % aid)
                continue
            bad = [s for s in states if s not in PET_STATES]
            if bad:
                problems.append('%s：states 含非法状态名 %s' % (aid, bad))
                continue
            if 'listening' in states:
                problems.append('%s：listening 已降级为纯气泡（只弹气泡、不切主体），'
                                '不能再分配主体素材' % aid)
                continue
            # 「一张素材只服务一个状态」——**同一条 states[] 里不能有重复**
            # （跨条目的重复由 id 唯一性挡住）。
            if len(set(states)) != len(states):
                problems.append('%s：states 里有重复状态名 %s' % (aid, states))
                continue
        else:
            keys = raw.get('keys')
            if keys is not None and not isinstance(keys, list):
                problems.append('%s：keys 必须是数组' % aid)
                continue
        by_id[aid] = raw

    if problems:
        raise CatalogError('台账有 %d 处问题：\n  · %s'
                           % (len(problems), '\n  · '.join(problems)))

    body = [a for a in by_id.values() if a['role'] == 'body']
    bubbles = [a for a in by_id.values() if a['role'] in ('bubble', 'anim')]
    if not bubbles:
        raise CatalogError('台账里没有任何气泡素材（role=bubble/anim）')
    for st in BODY_STATES:
        if not any(st in a['states'] for a in body):
            raise CatalogError('台账里状态 %s 没有任何主体素材（该状态会回落到 idle）' % st)
    for a in bubbles:
        if not a.get('keys'):
            raise CatalogError('%s：气泡素材必须至少给一个 keys[]（气泡情境）' % a['id'])
    return by_id, body, bubbles


def resolve_source(source):
    r"""台账 `source` → 绝对路径（不存在返回 None）。

    四种来源前缀：
      · `wx/xxx.png`        → `庄方宜素材\10-表情包\wx\`（已透明的单帧 PNG）
      · `QQ表情/xxx.gif`    → `庄方宜素材\10-表情包\QQ表情\`（动态 GIF）
      · `cutout/xxx.png`    → `art/pet/src/cutout\`（**用户手动抠好的图**）
      · `新表情包/xxx.png`  → `fromQQ\新表情包\庄方宜(未扣背景)\`（线稿贴纸，未抠底）
    """
    head, tail = source.replace('\\', '/').split('/', 1)
    if head == 'wx':
        return os.path.join(ASSETS_WX, tail)
    if head == 'QQ表情':
        return os.path.join(ASSETS_QQ, tail)
    if head == 'cutout':
        return os.path.join(CUTOUT, tail)
    if head == '新表情包':
        return os.path.join(ASSETS_NEW, tail)
    raise CatalogError('%s：source 前缀不认识（%r）' % (source, head))


# ── 基础工具 ────────────────────────────────────────────────────────────────

def ensure_dirs(bubble_dirs=()):
    """建好全部输出目录（含用户手动抠图的 `cutout/` 与气泡子目录）。"""
    dirs = [ART, os.path.join(ART, 'bubble'), os.path.join(ART, 'thumbs'),
            SRC, os.path.join(SRC, 'png'), os.path.join(SRC, 'gif'),
            os.path.join(SRC, 'raw'), CUTOUT]
    for d in bubble_dirs:
        dirs.append(os.path.join(ART, 'bubble', d))
    for d in dirs:
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
    """全部帧里最小的「alpha==0 像素占比」。

    ⚠️ **只用于报告，不再作为门槛**（用户 2026-10-07："管线关于不透明的要求，
    直接去掉"、"透不透明影响不大呀，背景又不是无意义"）。`--check` 与台账文档里
    仍能看到每张图的透明占比，但**不再据此排除任何素材**。别把它加回来。
    """
    worst = 1.0
    for f in frames:
        a = f.getchannel('A')
        # 用直方图数 0 的像素，比逐像素比较快一个数量级
        zeros = a.histogram()[0]
        worst = min(worst, zeros / float(f.width * f.height))
    return worst


def median_opaque_ratio(frames):
    """全部帧「不透明像素（alpha>248）占比」的中位数 —— `opaque` 判据。

    为什么是**中位数**而不是最大值/最小值：个别特效帧满幅（白闪、爆炸）不算
    "整张都是背景板"，要看**多数帧**。
    """
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
    if im.height == height:
        return im
    w = max(1, round(im.width * height / float(im.height)))
    return im.resize((w, height), Image.LANCZOS)


def copy_if_different(src, dst):
    """内容不同才拷贝（幂等，且不刷新 mtime —— 免得触发无谓的下游重建）。"""
    if os.path.isfile(dst):
        try:
            if open(src, 'rb').read() == open(dst, 'rb').read():
                return False
        except OSError:
            pass
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    return True


# ── 素材发现 ────────────────────────────────────────────────────────────────

def discover(body, bubbles, by_id):
    """按台账把每个条目的源文件找出来并**量指标**。

    返回 `(items, missing)`：`items` 是 `{id: 素材}`，找不到源文件的进 `missing`
    （进清单的 `missing[]`，供报告；不报错 —— 少一张图不该让整条管线崩）。
    """
    items, missing = {}, []

    def make(entry):
        path = resolve_source(entry['source'])
        if path is None or not os.path.isfile(path):
            missing.append({'name': entry['id'], 'reason': 'missing',
                            'detail': '源文件不存在：%s' % entry['source']})
            return None
        is_gif = path.lower().endswith('.gif')
        kind = 'anim' if entry['role'] == 'anim' else ('gif' if is_gif else 'png')
        if kind in ('gif', 'anim'):
            frames, durations = gif_frames(path)
        else:
            frames, durations = [read_rgba(path)], [0]
        it = {
            'id': entry['id'], 'role': entry['role'], 'family': entry['family'],
            'source': entry['source'], 'path': path, 'name': os.path.basename(path),
            'kind': kind, 'frames': len(frames),
            'minT': min_transparent_ratio(frames),
            'frameMs': median_ms(durations),
            'caption': entry.get('caption', ''), 'mood': entry.get('mood', ''),
            'states': list(entry.get('states') or []),
        }
        if entry['source'].startswith('cutout/'):
            it['cutout'] = path
        # `opaque` **由指标判定**（不手写）：手写过一版 20 个标志位，量完猜错 3 个。
        it['opaque'] = median_opaque_ratio(frames) >= OPAQUE_MIN
        return it

    for entry in body + bubbles:
        it = make(entry)
        if it is not None:
            items[entry['id']] = it
    return items, missing


def build_mapping(body, items):
    """按台账 `states[]` 展开成 `{状态名: [素材…]}`（顺序即台账顺序 = canonical 在前）。"""
    mapping = {}
    for entry in body:
        it = items.get(entry['id'])
        if it is None:
            continue
        for state in entry['states']:
            mapping.setdefault(state, []).append(it)
    return mapping


def bubble_pool(bubbles, items):
    """气泡池 = 台账里 `role=bubble/anim` 的条目，**按台账顺序**（顺序稳定 → 清单可 diff）。"""
    pool = []
    for entry in bubbles:
        it = items.get(entry['id'])
        if it is None:
            continue
        it = dict(it)
        if entry.get('dir'):
            it['subdir'] = entry['dir']
        it['keys'] = list(entry.get('keys') or [])
        it['random'] = entry.get('random') is not False
        pool.append((it, bool(entry.get('hasText'))))
    return pool


# ── 产出 ────────────────────────────────────────────────────────────────────

def strip_name(state, asset_id):
    """条带文件名 = `<state>-<id>.png`（**canonical 也带 id**）。

    为什么改：此前按位置编号（`idle.png` / `idle-2.png` …），产物名里没有任何
    身份信息 —— 看一眼文件名认不出画的是什么，清单里也没有对应字段，于是
    测试只能"数张数"来断言归属。带上 id 之后：
      · 调试/日志一眼看出当前播的是哪张；
      · 断言可以按名字写（`variants.error` 必须含 `error-listless.png`），
        以后再挪图**不用改测试**。
    exe 与 overlay 都不解析文件名（全部由 `pet.json` 驱动），重命名是安全的。
    """
    return '%s-%s.png' % (state, asset_id)


def render_tiles(item):
    """把一份素材渲染成**规整化的帧列表**，返回 `(tiles, frame_ms)`。

    主流程与 `--check` **共用这一个函数**，保证 `--check` 打印的单帧尺寸
    就是产出条带的真实尺寸，不会因为两份逻辑各自演化而漂移。

    规整化两步：
      1. 用**并集**包围盒统一裁切 —— 逐帧各自裁切会让偏移不同，动画会抖动；
      2. 等比缩放到精确 `FRAME_HEIGHT` 高。
    """
    src = item.get('cutout') or item['path']
    if item['kind'] in ('gif', 'anim'):
        frames, durations = gif_frames(src)
        frame_ms = median_ms(durations)
    else:
        frames, frame_ms = [read_rgba(src)], 0

    box = union_bbox(frames)
    if box:
        frames = [f.crop(box) for f in frames]
    return [to_height(f, FRAME_HEIGHT) for f in frames], frame_ms


def write_strip(state, item, report, cache, want_thumb=False):
    """产出某状态的横向精灵条带 `art/pet/<state>-<id>.png`。

    条带 = `frames × frameHeight` 宽、`frameHeight` 高（契约 §6）：
    一份产物同时喂 WPF 的 `CroppedBitmap` 与 overlay 的 CSS `steps(N)`。
    单帧素材也输出条带（frames=1），让两端走同一条代码路径。

    `cache` 按素材去重：同一张素材被多个状态用作变体时（仅 `shared: true`），
    只**编码一次**，其余变体直接复制字节 —— 否则 3MB 级的 GIF 条带会被重复编码。
    """
    rel = strip_name(state, item['id'])
    key = (item['kind'], item['source'])
    if key in cache:
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
    """
    if max(im.size) > BUBBLE_MAX:
        s = BUBBLE_MAX / float(max(im.size))
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))),
                       Image.LANCZOS)
    return im


def write_bubble(item, has_text, report):
    """产出气泡表情池图，并返回契约 §4 的条目。

    输出路径：`art/pet/bubble/[<dir>/]<id>.<png|gif>`（`<dir>` 来自台账，如 F4 的 `new`）。

    `hasText` 原样带进清单：`true` = 该图**自己已经把文字画进去了**（F2 贴纸 / F4 线稿），
    Host 必须用 `kind: 'image'` 且**不再叠** `bubble.text`，否则屏幕上会出现两段
    打架的文字（契约 §4）。

    `opaque` **由指标判定**（`OPAQUE_MIN`），不手写：多数帧满幅 → 渲染方不套气泡底
    /内边距（否则白纸贴在浅色框里会出现双层边框）。**不抠、不键控、不 flatten**：
    白色既是背景也是脸/衣服的填充色，键控会把角色内部掏空。

    **深色模式直接用原图**（v2 起不再产深色变体，`fileDark` 缺省）。
    """
    src = item.get('cutout') or item['path']

    # ── 动态气泡 —— **整个 GIF 原样交付**，不取帧、不抠图 ────────────────────
    #
    # 为什么不转成"PNG 条带"（精灵那套）：气泡动图的帧**不共享画布**（GIF 每帧
    # 可以只覆盖一部分），拼条带要先统一成网格；而 WPF 的 `GifBitmapDecoder`
    # 本来就会解出全部帧 —— 直接给 GIF 最省事也最不失真。
    if item['kind'] == 'anim':
        rel = os.path.join('bubble', '%s.gif' % item['id'])
        path = os.path.join(ART, rel)
        shutil.copy2(src, path)                       # 原字节直传：GIF 已是最终格式
        report['made'].append((rel, 'copy', os.path.getsize(path)))
        return {'file': rel.replace(os.sep, '/'), 'w': BUBBLE_MAX, 'h': BUBBLE_MAX,
                'hasText': bool(has_text), 'opaque': bool(item.get('opaque')),
                'frames': int(item.get('frames') or 1),
                'frameMs': int(item.get('frameMs') or 60)}

    if item['kind'] == 'gif':
        im = gif_frames(src)[0][0]              # 气泡用首帧（静态）
    else:
        im = read_rgba(src)

    subdir = item.get('subdir') or ''
    if item.get('opaque'):
        # 满幅不透明贴纸（F4 线稿等）。原图**原样保留 alpha**（其实是 0% 透明，
        # 即整幅不透明），只做等比缩放 —— 绝不抠底、绝不 flatten。
        out_im = fit_bubble(im).convert('RGB')
        rel = os.path.join('bubble', subdir, '%s.png' % item['id'])
        path = os.path.join(ART, rel)
        out_im.save(path, 'PNG', optimize=True)
        report['made'].append((rel, out_im.size, os.path.getsize(path)))
        return {'file': rel.replace(os.sep, '/'), 'w': out_im.width, 'h': out_im.height,
                'hasText': bool(has_text), 'opaque': True}

    out_im = fit_bubble(im)
    rel = os.path.join('bubble', subdir, '%s.png' % item['id'])
    path = os.path.join(ART, rel)
    out_im.save(path, 'PNG', optimize=True)
    report['made'].append((rel, out_im.size, os.path.getsize(path)))
    return {'file': rel.replace(os.sep, '/'), 'w': out_im.width, 'h': out_im.height,
            'hasText': bool(has_text), 'opaque': False}


def stage_sources(items, report, refresh_raw=False):
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
    for it in items.values():
        if it['role'] != 'body':
            continue
        sub = {'png': 'png', 'gif': 'gif', 'anim': 'gif'}[it['kind']]
        copy_if_different(it['path'], os.path.join(SRC, sub, it['name']))
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

    必要性：改归属后旧的高序号文件（`idle-4.png` 之类）会留在磁盘上变成孤儿 ——
    占体积、还会被 `deploy.ps1` 拷进部署副本。"清单里没有了"和"磁盘上没有了"是两件事。
    本次重命名（产物带语义 id）就是靠这一步把旧的 `idle.png`/`idle-2.png` 清掉的。

    清理范围严格限定在脚本自管的三个目录（顶层 `*.png`、`bubble/**`、`thumbs/`），
    **绝不碰 `src/`（含用户手动抠图）与 `pet.json`**。

    ⚠️ **两个坑都踩过，缺一个都会静默失效**：
    ① **扩展名**：只写 `*.png` → **动图气泡**（`.gif`）的孤儿永远清不掉。
    ② **`recursive=True`**：`bubble/**/*.gif` 在**不加** `recursive=True` 时返回
       **0 个**（`**` 只当普通目录名），所以子目录里的孤儿（F4 的 `bubble/new/`）
       一个都删不掉。
    """
    removed = []
    for pat in ('*.png', '*.gif',
                os.path.join('bubble', '**', '*.png'),
                os.path.join('bubble', '**', '*.gif'),
                os.path.join('thumbs', '*.png')):
        for p in sorted(glob.glob(os.path.join(ART, pat), recursive=True)):
            rel = os.path.relpath(p, ART)
            if rel not in referenced:
                os.remove(p)
                removed.append(rel)
    report['pruned'] = removed
    return removed


def write_manifest(states, variants, bubbles, missing, files, assets_meta, report):
    """写 `art/pet/pet.json`（契约 §4 的唯一素材清单）。

    `generatedAt` 故意**不写真实时间**：它会让每次重跑产生不同字节、破坏幂等。
    这里写一个固定占位值，让「连跑两次结果一致」可被 sha256 验证。

    `files` 是**每个文件自己的几何**（canonical + 全部 variants）：
    `variants` 只是文件名数组，而变体之间帧数差异极大（静态 PNG 1 帧 vs 动态 GIF 44 帧），
    拿 `states` 的 `frames` 去切变体会切出碎条 —— 所以几何必须按**文件**给出。
    该字段是纯附加的，旧消费者忽略它也能跑。

    `assets` 是**身份映射**（台账派生的附加段，契约 §4 v-next）：
    `文件路径 → {id, role, family, caption, mood, states?, keys?, hasText?, random?}`。
    它解决的是"产物按名字认不出画的是什么" —— exe / overlay / 测试 / 诊断都能据此
    把 `error-listless.png` 和"吐彩虹"对上号。纯附加字段，旧消费者忽略也能跑。
    """
    manifest = {
        'version': MANIFEST_VERSION,
        'generatedAt': '1970-01-01T00:00:00.000Z',
        'frameHeight': FRAME_HEIGHT,
        'states': states,
        'variants': variants,
        'files': files,
        'bubble': bubbles,
        'assets': assets_meta,
        'missing': missing,
    }
    path = os.path.join(ART, 'pet.json')
    text = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text + '\n')
    report['made'].append(('pet.json', (0, 0), os.path.getsize(path)))
    return manifest


def write_emotes_data(bubbles):
    """由台账生成 `src/pet/emotes.data.js`（`emotes.js` 从它 re-export）。

    为什么生成而不是手写：气泡情境归属（`keys`）在台账里已经有一份真相，
    `emotes.js` 里再抄一份就是两处真相 —— 改了一处另一处悄悄过期，正是这次要治的病。

    **只输出数据**（两张表）；挑选逻辑（`pickEmoteFile` 等纯函数）仍手写在
    `emotes.js`，那里的逻辑有测试覆盖，不该被生成物覆盖。
    """
    by_key = {k: [] for k in BUBBLE_KEY_ORDER}
    extra_keys = set()
    for entry in bubbles:
        for k in entry.get('keys') or []:
            if k not in by_key:
                extra_keys.add(k)
                by_key[k] = []
    for entry in bubbles:
        ext = 'gif' if entry['role'] == 'anim' else 'png'
        rel = 'bubble/%s%s%s' % (entry['dir'] + '/' if entry.get('dir') else '',
                                 entry['id'], '.' + ext)
        for k in entry.get('keys') or []:
            if rel not in by_key[k]:
                by_key[k].append(rel)
    exclude = ['bubble/%s.png' % e['id'] for e in bubbles if e.get('random') is False]
    exclude += ['bubble/%s.gif' % e['id'] for e in bubbles
                if e.get('random') is False and e['role'] == 'anim']

    lines = [
        '/**',
        ' * 庄方宜桌宠 · 气泡情境映射（**自动生成，勿手改**）。',
        ' *',
        ' * 由 `tools/prepare-pet.py` 从 `assets/catalog.json` 的 `keys[]` 生成 ——',
        ' * 台账是唯一真相，改归属请改台账再重跑管线，不要改这个文件。',
        ' *',
        ' * `emotes.js` 从这里 re-export，挑选逻辑仍手写在那里。',
        ' * @module src/pet/emotes.data.js',
        ' */',
        '',
        '/** 情境 key → 该情境下合适的表情文件（相对 `art/pet/`）。 */',
        'export const EMOTE_BY_KEY = {',
    ]
    for k in by_key:
        files = by_key[k]
        if not files:
            lines.append('  %s: [],' % json.dumps(k, ensure_ascii=False))
            continue
        lines.append('  %s: [' % json.dumps(k, ensure_ascii=False))
        for f in files:
            lines.append('    %s,' % json.dumps(f, ensure_ascii=False))
        lines.append('  ],')
    lines.append('}')
    lines.append('')
    lines.append('/** 全池回落时排除掉这些 —— 它们语义太强，随机撒容易莫名其妙。 */')
    lines.append('export const EMOTE_EXCLUDE_FROM_RANDOM = [')
    for f in exclude:
        lines.append('  %s,' % json.dumps(f, ensure_ascii=False))
    lines.append(']')
    lines.append('')
    if extra_keys:
        sys.stderr.write('警告：台账里有情境 key 不在 BUBBLE_KEY_ORDER 中，已一并生成：%s\n'
                         % ', '.join(sorted(extra_keys)))

    path = os.path.join(ROOT, 'src', 'pet', 'emotes.data.js')
    text = '\n'.join(lines)
    old = open(path, encoding='utf-8').read() if os.path.isfile(path) else None
    if old != text:
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
    return path


def write_ledger(catalog_path, body, bubbles, items, mapping, pool, manifest):
    """生成 `docs/素材台账.md`（**勿手改** —— 重跑管线会覆盖）。

    存在的意义：这一版之前，"某张图用在哪"只能读脚本源码或猜文件名。
    台账文档 + `pet.json` 的 `assets` 段一起回答这个问题，而且**都能被测试校验**
    （`tools/test-pet-assets.mjs`）。
    """
    man_files = manifest.get('files') or {}
    out = []
    out.append('# 素材台账（自动生成，勿手改）')
    out.append('')
    out.append('> 由 `tools/prepare-pet.py` 从 `%s` 生成。重跑管线即刷新。'
               % os.path.relpath(catalog_path, ROOT).replace('\\', '/'))
    out.append('>')
    out.append('> 改归属 / 加素材 / 改气泡情境 = **只改台账**（`assets/catalog.json`），'
               '然后 `python tools/prepare-pet.py`。')
    out.append('')
    out.append('- 主体 %d 张（%d 个状态），气泡 %d 张。'
               % (len(body), len([s for s in BODY_STATES if mapping.get(s)]), len(bubbles)))
    out.append('- 产物命名：主体 `<state>-<id>.png`（**主图也带 id**），气泡 `bubble/[dir/]<id>.<png|gif>`。')
    out.append('- `minT%` = 全部帧里最小的「完全透明像素占比」，**仅供参考，不是门槛**'
               '（用户决定：不再因不透明排除素材）。')
    out.append('')

    out.append('## 主体（按状态）')
    out.append('')
    out.append('| 状态 | 序 | 语义键 | 源文件 | 画面 | 产物 | 帧×帧宽@ms | minT% |')
    out.append('|---|---|---|---|---|---|---|---|')
    for state in BODY_STATES:
        its = mapping.get(state) or []
        if not its:
            out.append('| `%s` | | | | | | | |' % state)
            continue
        for i, it in enumerate(its):
            geom = man_files.get(strip_name(state, it['id']), {})
            out.append('| `%s` | %s | `%s` | `%s` | %s | `%s` | %d×%d@%d | %.1f%% |'
                       % (state if i == 0 else '', i + 1, it['id'], it['source'],
                          it['caption'], strip_name(state, it['id']),
                          geom.get('frames', it['frames']),
                          geom.get('frameWidth', 0), geom.get('frameMs', it['frameMs']),
                          it['minT'] * 100))
    out.append('')

    by_key = {}
    for entry in bubbles:
        for k in entry.get('keys') or []:
            by_key.setdefault(k, []).append(entry)
    out.append('## 气泡（按情境）')
    out.append('')
    out.append('| 情境 | 语义键 | 产物 | 图上文字 | hasText | opaque | 尺寸 |')
    out.append('|---|---|---|---|---|---|---|')
    man_bub = {b['file']: b for b in (manifest.get('bubble') or [])}
    for k in BUBBLE_KEY_ORDER:
        entries = by_key.get(k) or []
        if not entries:
            continue
        for i, entry in enumerate(entries):
            ext = 'gif' if entry['role'] == 'anim' else 'png'
            rel = 'bubble/%s%s.%s' % (entry['dir'] + '/' if entry.get('dir') else '',
                                      entry['id'], ext)
            rec = man_bub.get(rel, {})
            size = ('%d×%d' % (rec['w'], rec['h'])) if rec else '—'
            out.append('| `%s` | %s | `%s` | %s | %s | %s | %s |'
                       % (k if i == 0 else '', '`%s`' % entry['id'], rel,
                          entry.get('caption', ''),
                          'true' if entry.get('hasText') else 'false',
                          'true' if rec.get('opaque') else 'false', size))
    out.append('')

    # 审计小节：让"不对劲"写在文档里，而不是等人发现
    problems, warnings = audit(mapping, pool, bubbles, items)
    out.append('## 审计')
    out.append('')
    if problems:
        out.append('**问题（`--audit` 会退出码 1）**')
        out.append('')
        for p in problems:
            out.append('- %s' % p)
    else:
        out.append('- 一致性检查全过：每个状态都有素材、每张素材只服务一个状态、'
                   '每个气泡都归属至少一个情境。')
    out.append('')
    thin = [s for s in BODY_STATES if len(mapping.get(s) or []) <= 1]
    if thin:
        out.append('- 变体只有 1 张的状态：%s —— 每次切到它都播同一张图。'
                   % '、'.join('`%s`' % s for s in thin))
    unused = [e['id'] for e in bubbles
              if not any(k for k in (e.get('keys') or []))]
    if unused:
        out.append('- 气泡未归属任何情境：%s' % '、'.join(unused))
    out.append('')

    path = os.path.join(DOCS, '素材台账.md')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(out))
    return path


def audit(mapping, pool, bubbles, items):
    """一致性审计，返回 `(problems, warnings)`。

    `problems` = 会让"素材用不上 / 归属漂移"的硬伤；`warnings` = 可疑但不致命。
    `--audit` 只对 `problems` 退出码 1。
    """
    problems, warnings = [], []

    for state in BODY_STATES:
        if not mapping.get(state):
            problems.append('状态 %s 没有任何主体素材（会回落到 idle）' % state)
        elif len(mapping[state]) <= 1:
            warnings.append('状态 %s 只有 1 张变体，切到它时永远播同一张' % state)

    # 同一张素材出现在多个状态 = 身份漂移（一图多态会让"每个状态表情不同"不成立）
    owner = {}
    for state, its in mapping.items():
        for it in its:
            owner.setdefault(it['id'], []).append(state)
    for aid, sts in sorted(owner.items()):
        if len(sts) > 1:
            problems.append('素材 %s 同时服务多个状态：%s' % (aid, '、'.join(sts)))

    for entry in bubbles:
        if not entry.get('keys'):
            problems.append('气泡 %s 没有归属任何情境（永远不会被按情境挑中）' % entry['id'])
        if entry.get('hasText') is None:
            warnings.append('气泡 %s 没写 hasText（按安全侧缺省 false 处理）' % entry['id'])

    return problems, warnings


# ── 报告 ────────────────────────────────────────────────────────────────────

def print_check(catalog_path, mapping, pool, items, missing, bubbles_entries):
    """`--check`：只报覆盖率与透明占比，**缺图只警告不报错**，退出码恒为 0。"""
    print('素材台账：%s' % os.path.relpath(catalog_path, ROOT))
    print('=' * 78)
    print('台账 %d 条：主体 %d 张、气泡 %d 张'
          % (len(items), len([i for i in items.values() if i['role'] == 'body']),
             len([i for i in items.values() if i['role'] != 'body'])))
    print()
    print('【主体】一张素材只服务一个状态（第 1 个是主图）')
    print('  %-10s %-4s %-18s %-34s %6s %10s' % ('状态', '序', '语义键', '源文件', 'minT%', '产物'))
    for state in BODY_STATES:
        its = mapping.get(state) or []
        if not its:
            print('  %-10s [缺] → Host 回落 idle' % state)
            continue
        for i, it in enumerate(its):
            print('  %-10s %-4d %-18s %-34s %6.2f %10s'
                  % (state if i == 0 else '', i + 1, it['id'], it['source'],
                     it['minT'] * 100, strip_name(state, it['id'])))
    print()
    print('【气泡】hasText=true → Host 必须 kind=image，**不再叠 bubble.text**')
    print('  %-4s %-22s %-34s %-9s %-9s %8s %s'
          % ('', '语义键', '源文件', '家族', 'hasText', 'opaque', '情境'))
    for it, ht in pool:
        ext = 'gif' if it['kind'] == 'anim' else 'png'
        print('  [OK] %-22s %-34s %-9s %-9s %8s %s'
              % (it['id'], it['source'], it['family'], 'true' if ht else 'false',
                 'true' if it.get('opaque') else 'false', ','.join(it['keys'])))
    print()
    print('  排除名单（不参与「全池随机」兜底）：%s'
          % ('、'.join(e['id'] for e in bubbles_entries if e.get('random') is False) or '（空）'))
    print()
    print('待抠 / 缺失（%d 项，仅警告）：' % len(missing))
    for m in missing:
        print('  · %s（%s）%s' % (m['name'], m.get('reason', '?'), m.get('detail', '')))
    print()
    problems, warnings = audit(mapping, pool, bubbles_entries, items)
    if problems:
        print('★★ 一致性问题 %d 处（`--audit` 会退出码 1）：' % len(problems))
        for p in problems:
            print('  · %s' % p)
    if warnings:
        print('可疑（不阻塞）：')
        for w in warnings:
            print('  · %s' % w)
    print()
    return 0


# ── 主流程 ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='庄方宜桌宠素材管线（不抠图、保留 alpha）')
    parser.add_argument('--check', action='store_true', help='只报台账与覆盖率，不写文件；缺图只警告')
    parser.add_argument('--audit', action='store_true', help='一致性审计；有问题退出码 1')
    parser.add_argument('--clean', action='store_true', help='重建前清掉 art/pet 下的旧产物')
    parser.add_argument('--refresh-raw', action='store_true',
                        help='强制重刷 src/raw/（默认**不覆盖**已有文件：那里是用户抠图的工作台）')
    args = parser.parse_args()

    if not os.path.isdir(ASSETS):
        print('找不到素材目录：%s' % ASSETS, file=sys.stderr)
        print('请确认 庄方宜素材\\ 与 dsh-zhuang-fangyi-pet\\ 在同一级目录下。', file=sys.stderr)
        return 1

    try:
        catalog_path = CATALOG_PATH
        by_id, body_entries, bubble_entries = load_catalog(catalog_path)
    except CatalogError as e:
        print('★★ 台账有误：%s' % e, file=sys.stderr)
        return 2

    bubble_dirs = sorted({e['dir'] for e in bubble_entries if e.get('dir')})

    items, missing = discover(body_entries, bubble_entries, by_id)
    mapping = build_mapping(body_entries, items)
    pool = bubble_pool(bubble_entries, items)

    if args.check:
        return print_check(catalog_path, mapping, pool, items, missing, bubble_entries)

    if args.audit:
        problems, warnings = audit(mapping, pool, bubble_entries, items)
        # 产物孤儿：磁盘上没人引用 = 上一次改归属留下的垃圾
        manifest_path = os.path.join(ART, 'pet.json')
        if os.path.isfile(manifest_path):
            with open(manifest_path, encoding='utf-8') as f:
                man = json.load(f)
            referenced = set(man.get('files', {}).keys())
            for vs in (man.get('variants') or {}).values():
                referenced.update(vs)
            for s in (man.get('states') or {}):
                referenced.add('thumbs/%s.png' % s)
            for b in man.get('bubble', []):
                referenced.add(b['file'])
                if b.get('fileDark'):
                    referenced.add(b['fileDark'])
            for pat in ('*.png', '*.gif', os.path.join('bubble', '**', '*.png'),
                        os.path.join('bubble', '**', '*.gif'),
                        os.path.join('thumbs', '*.png')):
                for p in glob.glob(os.path.join(ART, pat), recursive=True):
                    rel = os.path.relpath(p, ART).replace(os.sep, '/')
                    if rel not in referenced:
                        problems.append('产物孤儿：%s 不在清单里（重跑一次管线即可清掉）' % rel)
        print('审计：%d 个问题，%d 条可疑' % (len(problems), len(warnings)))
        for p in problems:
            print('  ✗ %s' % p)
        for w in warnings:
            print('  ! %s' % w)
        return 1 if problems else 0

    ensure_dirs(bubble_dirs)
    if args.clean:
        # art/pet 下的图都是本脚本的产出范围，清掉旧图后重生成
        # （`bubble/**` 递归，覆盖带子目录的气泡）
        # ⚠️ 与 `prune_unreferenced` 同一组坑：`.gif` 要一起清，
        #    且 `**` **必须**配 `recursive=True`（否则子目录一个都匹配不到）。
        for pat in ('*.png', '*.gif',
                    os.path.join('bubble', '**', '*.png'),
                    os.path.join('bubble', '**', '*.gif'),
                    os.path.join('thumbs', '*.png')):
            for p in glob.glob(os.path.join(ART, pat), recursive=True):
                os.remove(p)

    report = {'made': []}
    stage_sources(items, report, refresh_raw=args.refresh_raw)

    states, variants, files, cache, assets_meta = {}, {}, {}, {}, {}
    for state in BODY_STATES:
        its = mapping.get(state) or []
        if not its:
            continue
        entries = [write_strip(state, it, report, cache) for it in its]
        states[state] = entries[0]                       # 契约 §4：variants 必须含 states
        variants[state] = [e['file'] for e in entries]
        write_thumb(state, entries[0], report)
        for e, it in zip(entries, its):
            # `files`：每个文件自己的几何。`files` 的键就是文件路径。
            files[e['file']] = {'frames': e['frames'],
                                'frameWidth': e['frameWidth'],
                                'frameMs': e['frameMs']}
            # `assets`：身份映射（附加段）——把产物路径与"画的是什么"对上号。
            assets_meta[e['file']] = {
                'id': it['id'], 'role': 'body', 'family': it['family'],
                'caption': it['caption'], 'mood': it['mood'],
                'states': list(it['states']) or [state],
            }

    bubbles = []
    for it, ht in pool:
        rec = write_bubble(it, ht, report)
        bubbles.append(rec)
        assets_meta[rec['file']] = {
            'id': it['id'], 'role': it['role'], 'family': it['family'],
            'caption': it['caption'], 'mood': it['mood'],
            'hasText': bool(ht), 'opaque': bool(rec.get('opaque')),
            'keys': list(it['keys']), 'random': bool(it['random']),
        }

    manifest = write_manifest(states, variants, bubbles, missing, files, assets_meta, report)
    emotes_path = write_emotes_data(bubble_entries)
    ledger_path = write_ledger(catalog_path, body_entries, bubble_entries, items,
                               mapping, pool, manifest)

    # 清掉不再被清单引用的旧产物（改归属 / 改命名后必然产生孤儿）
    referenced = set()
    for e in states.values():
        referenced.add(e['file'])
    for vs in variants.values():
        referenced.update(vs)
    for b in bubbles:
        referenced.add(b['file'].replace('/', os.sep))
        # ⚠️ 深色变体也必须登记（已废弃，但逻辑留着：契约仍支持 fileDark）
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
            print('  %-34s %s' % (name, '原样交付（GIF 不重编码） %8.0f KB' % (nbytes / 1024.0)))
        elif size is None:
            print('  %-34s %s' % (name, '（同素材复用）'))
        elif size == (0, 0):
            print('  %-34s %s' % (name, '清单'))
        else:
            print('  %-34s %5dx%-5d %8.0f KB' % (name, size[0], size[1], nbytes / 1024.0))
    if report['pruned']:
        print('清理旧产物 %d 个：%s' % (len(report['pruned']), ', '.join(report['pruned'])))
    print()
    st = report['staged']
    print('暂存源素材：png/ %d 张，gif/ %d 张；raw/ 新写入 %d 张，**跳过（保护用户抠图）%d 张**'
          % (st['png'], st['gif'], st['raw'], st.get('rawSkipped', 0)))
    print('状态覆盖（主体）：%d/%d' % (len(states), len(BODY_STATES)))
    for s in BODY_STATES:
        n = len(variants.get(s, []))
        print('  %-10s %s variants=%d' % ('[OK]' if s in states else '[缺]', s, n))
    print('气泡池：%d 张；其中 hasText=true %d 张'
          % (len(bubbles), sum(1 for b in bubbles if b['hasText'])))
    n_dark = sum(1 for b in bubbles if b.get('fileDark'))
    if n_dark != 0:
        print('  ★★ 意外：仍有 %d 张带 fileDark —— 深色模式应直接用原图（v2 决定）' % n_dark)
    print('待抠/缺失：%d 项' % len(manifest['missing']))
    print('生成：%s、%s、docs/素材台账.md'
          % (os.path.relpath(emotes_path, ROOT).replace('\\', '/'),
             os.path.relpath(ledger_path, ROOT).replace('\\', '/')))
    problems, warnings = audit(mapping, pool, bubble_entries, items)
    if problems:
        print('★★ 一致性问题 %d 处（跑 --audit 看详情）' % len(problems))
    print('（缺失不影响运行：Host 对缺席状态回落 idle，契约 §4）')
    return 0


if __name__ == '__main__':
    sys.exit(main())