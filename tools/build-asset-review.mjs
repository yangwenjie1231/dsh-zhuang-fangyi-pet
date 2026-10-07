#!/usr/bin/env node
/**
 * 生成**素材看板** → `docs/素材看板.html`
 *
 * ── 它是什么 ──────────────────────────────────────────────────────────────
 *
 * 台账 `assets/catalog.json` 的可视化视图：每张图都会动（精灵条带），一眼看清
 * "哪张图、画的是什么、用在哪个状态/情境"。**数据全部来自台账与真实产物**，
 * 不手写、不复制 —— 改台账 + 重跑管线 → 重跑本脚本 → 页面即刷新。
 *
 * 为什么要有它：认图必须看**中间帧**（这批 GIF 的文件名描述的是首帧印象，
 * 而用户看到的是中后段 —— 历史上按文件名认错过一次，把吐彩虹认成了 stunned）。
 * 文字表格说不清这些，会动的条带能。
 *
 * 前身是 2026-10-07 的「素材归属建议表」评审页（用来让用户逐条拍板归属）。
 * 归属定稿后按位置命名的产物已重命名+清理，旧页面成了断链的历史稿，
 * 所以改成现在这个**常驻看板**（对着台账生成，不再过期）。
 *
 * 用法：node tools/build-asset-review.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMOTE_BY_KEY } from '../src/pet/emotes.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const ART = path.join(ROOT, 'art', 'pet')
const OUT = path.join(ROOT, 'docs', '素材看板.html')

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'catalog.json'), 'utf8'))
const manifest = JSON.parse(fs.readFileSync(path.join(ART, 'pet.json'), 'utf8'))

const BODY_STATES = ['waking', 'idle', 'thinking', 'working', 'waiting', 'happy', 'error', 'sleeping']
const body = catalog.assets.filter(a => a.role === 'body')
const bubbles = catalog.assets.filter(a => a.role === 'bubble' || a.role === 'anim')

// 按台账里的归属分组；组内顺序 = 台账顺序（第 1 个是主图，与 variants[state][0] 一致）
const bodyByState = {}
for (const st of BODY_STATES) bodyByState[st] = []
for (const a of body) {
  for (const st of a.states ?? []) {
    if (bodyByState[st] === undefined) continue
    bodyByState[st].push(a)
  }
}

const payload = { frameHeight: manifest.frameHeight }

/** 某个状态下的变体卡片（每张一个会动的精灵条带）。 */
function spriteHtml (state) {
  return (bodyByState[state] ?? []).map((a, i) => {
    const file = `${state}-${a.id}.png`
    const g = manifest.files?.[file] ?? {}
    return `<div class="item">
  <div class="sprite" data-file="${esc(file)}" data-frames="${g.frames ?? 1}" data-fw="${g.frameWidth ?? 256}" data-ms="${g.frameMs ?? 40}"></div>
  <div class="meta">
    <div class="name">${esc(a.id)}${i === 0 ? '<span class="badge">主图</span>' : ''}</div>
    <div class="cap">${esc(a.caption)}</div>
    <div class="geo">${esc(a.source)} · ${g.frames ?? 1}帧×${g.frameWidth ?? '?'}@${g.frameMs ?? 0}ms</div>
  </div>
</div>`
  }).join('\n')
}
function bodyHtml (state) {
  const list = bodyByState[state] ?? []
  return `<div class="card">
  <h2>${state}<span class="sub" style="font-weight:400"> · ${list.length} 张</span></h2>
  <div class="grid">${list.length > 0 ? spriteHtml(state) : '<div class="sub">（无）</div>'}</div>
</div>`
}

const bubbleHtml = bubbles.map(b => {
  const ext = b.role === 'anim' ? 'gif' : 'png'
  const file = `bubble/${b.dir ? b.dir + '/' : ''}${b.id}.${ext}`
  return `<div class="bcell">
  <img src="../art/pet/${esc(file)}" alt="${esc(b.id)}">
  <div class="k"><b>${esc(b.id)}</b></div>
  <div class="k">${esc(b.caption)}</div>
  <div class="k">${esc((b.keys ?? []).join(' / ')) || '（无情境）'}${b.random === false ? ' ⊘' : ''}</div>
</div>`
}).join('\n')

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>庄方宜桌宠 · 素材看板</title>
<style>
:root { --bg:#f6f6f8; --card:#fff; --ink:#1b1d21; --dim:#6b7280; --line:#e3e4e8; --prop:#2563eb; }
@media (prefers-color-scheme: dark) { :root { --bg:#15171b; --card:#1d2025; --ink:#e8eaed; --dim:#9aa1ab; --line:#2c313a; --prop:#7aa2f7; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px 20px 60px; background:var(--bg); color:var(--ink);
  font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
h1 { font-size:20px; margin:0 0 6px; }
h2 { font-size:16px; margin:0 0 10px; }
.sub { color:var(--dim); }
.stats { display:flex; gap:10px; flex-wrap:wrap; margin:16px 0; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:8px 14px; font-size:12px; color:var(--dim); }
.stat b { color:var(--ink); font-size:15px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:14px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:10px; }
.item { display:flex; gap:10px; align-items:center; border:1px solid var(--line); border-radius:10px; padding:8px; }
.sprite { flex:0 0 auto; border-radius:8px; background-color:#ececf1; background-repeat:no-repeat; cursor:pointer; }
@media (prefers-color-scheme: dark) { .sprite { background-color:#2a2e35; } }
.meta { min-width:0; }
.name { font-weight:600; }
.cap { color:var(--dim); font-size:12px; }
.geo { color:var(--dim); font-size:11px; font-family:ui-monospace,Consolas,monospace; word-break:break-all; }
.badge { display:inline-block; font-size:11px; padding:1px 6px; border-radius:999px; border:1px solid currentColor; color:var(--prop); margin-left:6px; }
.bgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:10px; }
.bcell { border:1px solid var(--line); border-radius:10px; padding:8px; text-align:center; }
.bcell img { max-width:100%; border-radius:6px; }
.bcell .k { font-size:11px; color:var(--dim); margin-top:3px; }
code { font-family:ui-monospace,Consolas,monospace; font-size:12px; background:color-mix(in srgb,var(--ink) 8%,transparent); padding:1px 5px; border-radius:4px; }
</style>
</head>
<body>
<h1>庄方宜桌宠 · 素材看板</h1>
<div class="sub">
  数据来自 <code>assets/catalog.json</code>（素材台账，唯一真相）与真实产物 <code>art/pet/pet.json</code>。
  每格都是<strong>会动的精灵条带</strong>（点一下暂停）—— 认图以<strong>中间帧</strong>为准。
  重新生成：先 <code>python tools/prepare-pet.py</code>，再 <code>node tools/build-asset-review.mjs</code>。
</div>
<div class="stats">
  <div class="stat"><b>${body.length}</b> 主体素材（一图一状态，零复用）</div>
  <div class="stat"><b>${BODY_STATES.length}</b> 个状态</div>
  <div class="stat"><b>${bubbles.length}</b> 气泡素材</div>
  <div class="stat"><b>${Object.keys(EMOTE_BY_KEY).length}</b> 个气泡情境</div>
</div>
${BODY_STATES.map(bodyHtml).join('\n')}
<div class="card">
  <h2>气泡池<span class="sub" style="font-weight:400"> · ${bubbles.length} 张（⊘ = 不参与「全池随机」兜底）</span></h2>
  <div class="bgrid">${bubbleHtml}</div>
</div>
<script id="payload" type="application/json">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>
<script>
const D = JSON.parse(document.getElementById('payload').textContent);
const FH = D.frameHeight || 256;
const H = 72;                       // 缩略显示高度（px）
document.querySelectorAll('.sprite[data-file]').forEach(el => {
  const n = Math.max(1, Number(el.dataset.frames) | 0);
  const fw = Number(el.dataset.fw) || 256;
  const ms = Math.max(30, Number(el.dataset.ms) || 40);
  const scale = H / FH;
  el.style.width = Math.round(H * fw / FH) + 'px';
  el.style.height = H + 'px';
  el.style.backgroundImage = 'url("../art/pet/' + el.dataset.file + '")';
  el.style.backgroundSize = Math.round(n * fw * scale) + 'px ' + H + 'px';
  if (n > 1) {
    el.style.setProperty('--end', -Math.round((n - 1) * fw * scale) + 'px');
    el.style.animation = 'play ' + (ms * n / 1000) + 's steps(' + n + ') infinite';
  }
  el.title = el.dataset.file + ' · 点击暂停/继续';
  el.addEventListener('click', () => {
    el.style.animationPlayState = el.style.animationPlayState === 'paused' ? 'running' : 'paused';
  });
});
</script>
<style>@keyframes play { from { background-position-x: 0; } to { background-position-x: var(--end); } }</style>
</body>
</html>
`

fs.writeFileSync(OUT, html, 'utf8')
const stale = path.join(ROOT, 'docs', '素材归属评审.html')
if (fs.existsSync(stale)) fs.rmSync(stale)
console.log('已生成：' + path.relative(ROOT, OUT).replace(/\\/g, '/') +
  `（${Math.round(html.length / 1024)} KB；主体 ${body.length} / 气泡 ${bubbles.length}）`)

function esc (s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}