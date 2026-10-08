# -*- coding: utf-8 -*-
"""
给 `assets/catalog.json` 的互动情境加 `keys[]`（v10）。

## 为什么必须加（这是一个**当前就存在**的真缺陷）

`interact/<kind>` 这些 key **没有专属表情池** → `pickEmoteFile` 返回 null →
回落**全池随机**。而全池 42 张里 **36 张（86%）自带文字**（「爱你哦」「比心」
「略略略」…）。状态机有一条正确性规则：**图自带文字时不叠 Host 文案**（契约 §4
的 `hasText`）—— 于是：

    用户点她一下 → 她该说「嗯…这样也挺好的。」
    实际显示    → 一张写着「略略略」的贴纸，那句话**一个字都没出现**

而且不报错：优先级、时长、`hasText` 全都是对的，指标上完全看不出来。

## 修法：只把**不带文字**的图放进互动池

无文字的气泡只有 6 张：`gif-24`(睡觉zzz) / `gif-26`(趴面) / `gif-28`(挂件吊坠) /
`gif-29`(抱小宠) / `25-reading`(看书) / `angry-charge`(生气蓄力·动图)。

按语义分给各情境（互动不是"她此刻的状态"，所以语义匹配放宽一点，
但**绝不能配到语义冲突的**：被甩了不该配"睡觉 zzz"）：

  · interact/pat    （摸头）→ gif-29(抱小宠) gif-28(挂件)  —— 被抱/被挂，最贴
  · interact/fling  （抛掷）→ angry-charge(生气)          —— 被甩了当然生气
  · interact/hover  （悬停）→ gif-26(趴面)                —— 抬眼看你
  · interact/click  （打招呼）→ gif-26(趴面)
  · interact/pet-head / feed / praise（菜单那两个 + 摸头）→ 与 pat 共用一组

**注意 `interact/click` 本来不弹气泡**（`interactions.js` 里 `text: null`）——
它只在**情境覆盖**下才说话（比如睡着了、在忙）。所以给它也配一张是安全的。

## 为什么不干脆"互动一律不配图"

那会丢掉"她**有表情**"这件事（用户明确要的是"互动"，不只是文字）。
配图与文案可以共存 —— 前提是图**不带文字**。
"""
import json
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CATALOG = os.path.join(ROOT, 'assets', 'catalog.json')

# 情境 → 该情境可用的**无文字**图（按优先级排列，第一张是主图）
INTERACT_KEYS = {
    'interact/pat': ['gif-29', 'gif-28'],
    'interact/pet-head': ['gif-29', 'gif-28'],
    'interact/fling': ['angry-charge'],
    'interact/hover': ['gif-26'],
    'interact/click': ['gif-26'],
    'interact/feed': ['gif-29'],
    'interact/praise': ['gif-28'],
}

# 允许写进互动池的图 —— 白名单，且**必须不带文字**。
# 这是本脚本最重要的一道闸：漏一张带文字的进来，那条互动文案就会被吞掉，
# 而且不会有任何报错。
def load():
    with io.open(CATALOG, encoding='utf-8') as f:
        return json.load(f)


def save(doc):
    with io.open(CATALOG, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write('\n')


def main():
    doc = load()
    by_id = {a['id']: a for a in doc['assets']}

    # ── 先验：目标图必须存在、且**不带文字** ──────────────────────────────
    problems = []
    for key, ids in INTERACT_KEYS.items():
        for i in ids:
            a = by_id.get(i)
            if a is None:
                problems.append('图不存在：%s（%s 要用）' % (i, key))
                continue
            if a.get('hasText') is True:
                problems.append('图自带文字，不能进互动池：%s（%s）' % (i, key))
            if a.get('role') not in ('bubble', 'anim'):
                problems.append('图不是气泡/动图角色：%s（role=%s）' % (i, a.get('role')))
    if problems:
        print('❌ 先验失败：')
        for p in problems:
            print('   - ' + p)
        return 1

    # ── 写入（幂等：重复跑不会重复加）────────────────────────────────────
    changed = 0
    for key, ids in INTERACT_KEYS.items():
        for i in ids:
            a = by_id[i]
            keys = a.setdefault('keys', [])
            if key not in keys:
                keys.append(key)
                changed += 1
    save(doc)
    print('已写入 %d 处 keys 归属（%d 个情境）' % (changed, len(INTERACT_KEYS)))

    # ── 后验：每个互动情境都必须有**非空**且**全不带文字**的池 ────────────
    bad = 0
    for key in INTERACT_KEYS:
        pool = [a for a in doc['assets'] if key in (a.get('keys') or [])]
        texts = [a['id'] for a in pool if a.get('hasText') is True]
        flag = 'ok ' if pool and not texts else 'BAD'
        if not pool or texts:
            bad += 1
        print('  [%s] %-20s %d 张%s' % (flag, key, len(pool),
              ('  带文字：' + ','.join(texts)) if texts else ''))
    if bad:
        print('[FAIL] %d 个情境的池不合格' % bad)
        return 1
    # ⚠️ 这里**不能用 emoji**：Windows 控制台默认 GBK，`print('\u2705')`
    # 会抛 UnicodeEncodeError —— 而那发生在**写文件之后**，于是
    # "文件改对了、脚本却报错退出"，看起来像失败（实测踩过一次）。
    print('[ok] 全部互动情境都有「非空且无文字」的表情池')
    return 0


if __name__ == '__main__':
    sys.exit(main())
