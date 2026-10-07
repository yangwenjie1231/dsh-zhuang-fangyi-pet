# 批量合成 voice-lines.json 里所有 source=synth 的台词（构建期一次性）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\synth-voice.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\synth-voice.ps1 -Only thinking-1
#
# ── 两个关键设计（都是踩坑换来的）────────────────────────────────────────────
#
# ① **同一句文本合成多个 seed 变体**（丰富度来源）
#
#    用户 2026-10-07："你让音频再丰富一点吧"。
#    实测同一句换 seed，产出**时长与波形都不同**（"做完了，你看看。"：
#    seed1=2.58s / seed2=2.06s / seed3=2.42s，sha256 全不同）—— 是真实的语气差异
#    （重音、停顿、语调），不是噪声。
#
#    台词表里已经把每条 synth 台词复制成 `name` / `namev2`（见 `gen-voice-lines.cjs`
#    的 `expandVariants`）—— 同事件多条目 → 运行时那套**既有的**"按事件轮换"
#    自动换着播，**exe 与 host 都不用改**。
#
#    这里按 **name 后缀** 决定 seed：`xxx` → seed 42（默认，兼容既有产物）、
#    `xxxv2` → seed 池里的下一个。
#
# ② **静音检测 + 换 seed 重试**（修一个真 bug）
#
#    `synth.py` 的 seed 固定在 42。seed=42 时**某些文本会踩到近乎静音**
#    （实测 `让我想想……` → -45.7 dB / 0.78 秒，而其余 73 条都在 -20~-27 dB）。
#
#    ⚠️ 我最初把它误判成"结尾中文省略号触发"，因为"重合成两次结果完全一样"——
#    其实那只是**同一个种子跑了两遍**。用户一句"这个是种子的问题"点破。
#    对照实验：同句换 seed 1/7/123/2024 全部正常（-24.2 ~ -24.7 dB）。
#
#    所以这里**逐个测音量**（ffmpeg volumedetect），低于阈值就换 seed 重合成。
#    修在合成侧，而不是让写台词的人避开某些标点。

[CmdletBinding()]
param(
  # 只重合成这些名字（调试用，匹配 `name` 前缀）；空 = 全部
  [string[]]$Only = @(),
  # 音量下限（dB）：低于它判为"踩到静音"，换 seed 重试
  [double]$MinVolumeDb = -35.0,
  # 强制重合成（默认跳过已有 wav）
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$PY = 'C:\Users\A\miniconda3\envs\voice\python.exe'
$SYNTH = 'D:\A\voiceclone\synth.py'
$ROOT = Split-Path -Parent $PSScriptRoot
$OUT = Join-Path $env:TEMP 'zf-synth-voice'
$NODE = 'C:\Users\A\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

if (-not (Test-Path $PY)) { throw "找不到 python: $PY" }
if (-not (Test-Path $SYNTH)) { throw "找不到 synth.py: $SYNTH" }

function Resolve-Ffmpeg {
    $c = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $cand = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($cand) { return $cand.FullName }
    return $null
}
$Ffmpeg = Resolve-Ffmpeg
if (-not $Ffmpeg) { Write-Host "警告：找不到 ffmpeg，将跳过静音检测" -ForegroundColor Yellow }

function Get-MeanVolumeDb([string]$path) {
    if (-not $Ffmpeg -or -not (Test-Path $path)) { return $null }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $o = & $Ffmpeg -hide_banner -i $path -af "volumedetect" -f null NUL 2>&1
    $ErrorActionPreference = $prev
    $m = [regex]::Match(($o -join ' '), 'mean_volume:\s*(-?[\d.]+)')
    if ($m.Success) { return [double]$m.Groups[1].Value }
    return $null
}

# 一次批量合成（模型只加载一次）。
# ⚠️ 原生命令的 stderr 不能当错误：synth.py 把进度打到 stderr，
# 而 `$ErrorActionPreference='Stop'` 会让 PS 5.1 把它当致命错误直接中断
#（症状是 "python.exe :" 后面一片空白 + NativeCommandError，其实合成成功了）。
function Invoke-SynthBatch([string[]]$texts, [int]$seed) {
    $dir = Join-Path $OUT ("seed$seed")
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Get-ChildItem $dir -Filter '*.wav' -ErrorAction SilentlyContinue | Remove-Item -Force
    $lf = Join-Path $dir 'lines.txt'
    # UTF-8 **无 BOM**：synth.py 用 encoding="utf-8" 读，带 BOM 会把首行第一个字
    # 污染成 "\ufeff好" —— 那个字符会被念出来或导致首字吞掉。
    [IO.File]::WriteAllText($lf, ($texts -join "`n") + "`n", (New-Object Text.UTF8Encoding($false)))
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $PY $SYNTH --file $lf --out $dir --seed $seed 2>&1 | Out-Null
    $ErrorActionPreference = $prev
    return $dir
}

# 1) 读台词表，按"变体序号"分组
$spec = Get-Content (Join-Path $ROOT 'tools\voice-lines.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$synthLines = @($spec.lines | Where-Object { $_.source -eq 'synth' })
if ($Only.Count -gt 0) {
    $synthLines = @($synthLines | Where-Object { $n = $_.name; @($Only | Where-Object { $n -like "$_*" }).Count -gt 0 })
}
# variant 字段：1 或缺失 = 第 1 个变体
$byVariant = @{}
foreach ($l in $synthLines) {
    $v = if ($null -ne $l.variant) { [int]$l.variant } else { 1 }
    if (-not $byVariant.ContainsKey($v)) { $byVariant[$v] = @() }
    $byVariant[$v] += $l
}
$variantKeys = @($byVariant.Keys | Sort-Object)

$srcDir = Join-Path $ROOT 'art\voice-src'
New-Item -ItemType Directory -Force -Path $srcDir | Out-Null

# seed：变体 1 用 42（synth.py 默认，保持与既有产物一致），其余从池里取
$seedPool = @(1, 7, 123, 2024, 31337)
function Seed-ForVariant([int]$v) {
    if ($v -le 1) { return 42 }
    return $seedPool[($v - 2) % $seedPool.Count]
}

$written = 0
$reused = 0
$retried = 0
$failed = @()

foreach ($v in $variantKeys) {
    $group = $byVariant[$v]
    # 跳过已有 wav 的（除非 -Force）
    $todo = @()
    foreach ($l in $group) {
        $dst = Join-Path $srcDir "$($l.name).wav"
        if ((-not $Force) -and (Test-Path $dst)) { $reused++ } else { $todo += $l }
    }
    if ($todo.Count -eq 0) { continue }

    $seed = Seed-ForVariant $v
    Write-Host "── 变体 $v（$($todo.Count) 条，seed=$seed）──"
    $dir = Invoke-SynthBatch ($todo | ForEach-Object { $_.text }) $seed

    for ($i = 0; $i -lt $todo.Count; $i++) {
        $l = $todo[$i]
        $wav = Join-Path $dir ('{0:D3}.wav' -f ($i + 1))
        if (-not (Test-Path $wav)) { $failed += "$($l.name) 无输出"; continue }
        $db = Get-MeanVolumeDb $wav
        if ($null -ne $db -and $db -lt $MinVolumeDb) {
            # 踩到静音 → 换 seed 重试
            $ok = $false
            foreach ($alt in $seedPool) {
                if ($alt -eq $seed) { continue }
                $d2 = Invoke-SynthBatch @($l.text) $alt
                $w2 = Join-Path $d2 '001.wav'
                if (-not (Test-Path $w2)) { continue }
                $db2 = Get-MeanVolumeDb $w2
                if ($null -ne $db2 -and $db2 -ge $MinVolumeDb) {
                    Write-Host ("   ↻ {0} 静音({1:N1}dB,seed={2}) → seed={3} 正常({4:N1}dB)" -f `
                        $l.name, $db, $seed, $alt, $db2)
                    $wav = $w2; $ok = $true; $retried++
                    break
                }
            }
            if (-not $ok) { $failed += "$($l.name) 试遍 seed 仍静音"; continue }
        }
        Copy-Item $wav (Join-Path $srcDir "$($l.name).wav") -Force
        $written++
    }
}

Write-Host ""
Write-Host "新合成 $written 个，复用 $reused 个 → $srcDir"
if ($retried -gt 0) { Write-Host "  其中 $retried 个是**静音重试**救回来的（seed=42 的坑）" -ForegroundColor Yellow }
if ($failed.Count -gt 0) {
    Write-Host "  以下未成功：" -ForegroundColor Red
    $failed | ForEach-Object { Write-Host "     $_" -ForegroundColor Red }
    exit 1
}
