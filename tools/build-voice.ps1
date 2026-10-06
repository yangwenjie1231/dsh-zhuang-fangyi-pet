# 庄方宜桌宠 · 语音包构建（**构建期一次性生成，运行时只播放**）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-voice.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-voice.ps1 -Force
#
# ── 为什么必须预生成（这不是优化，是可行性问题）─────────────────────────────
#
# 实测 GPT-SoVITS（`D:\A\voiceclone\synth.py`）：
#   · 冷启动 30.6 秒（加载两个模型）
#   · 热态约 5 秒/句（2 句 23.3 秒）
#
# 桌宠要在一秒内回应一次点击。**运行时合成 = 按了没反应**，没有别的可能。
# 所以把封闭集合的台词在构建期压成 mp3，运行时只做一件事：播放。
#
# ── 两类来源（见 tools/voice-lines.json）────────────────────────────────────
#
#   real  官方配音（`新素材/音频/语音合集_分条`）—— **优先**，比合成自然得多。
#         且那批素材里有几条简直是为桌宠写的（「休整」→ 番茄钟该休息了）。
#   synth GPT-SoVITS 合成 —— 只在官方素材确实没有合适台词时用。
#
# ── 幂等性 ─────────────────────────────────────────────────────────────────
#
# 已存在的产物**跳过**。`-Force` 强制重做。
# 合成很慢（每条约 5 秒），改一条台词不该把 19 条全部重跑。
#
# ── 产物 ───────────────────────────────────────────────────────────────────
#
#   art/voice/<name>.mp3    单声道 64kbps（音色本身信息量低，64k 够用且省一半体积）
#   art/voice/voice.json    运行时清单（name → 文件 + 时长 + 事件）

[CmdletBinding()]
param(
    [switch]$Force,
    # 官方语音素材目录（real 来源）
    [string]$RealDir = "D:\Users\A\Downloads\仿通行证\新素材\音频\语音合集_分条\音频_MP3_320k",
    # 合成环境（GPT-SoVITS 依赖装在这里）
    [string]$Python = "C:\Users\A\miniconda3\envs\voice\python.exe",
    [string]$SynthPy = "D:\A\voiceclone\synth.py",
    [string]$WorkDir = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($WorkDir)) {
    $WorkDir = Join-Path $env:TEMP "zf-pet-voice"
}

$LinesJson = Join-Path $PSScriptRoot "voice-lines.json"
$OutDir = Join-Path $Root "art\voice"
$ManifestPath = Join-Path $OutDir "voice.json"

function Info($m) { Write-Host "  $m" }
function Head($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

# ── 找 ffmpeg ───────────────────────────────────────────────────────────────
function Resolve-Ffmpeg {
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # winget 装的 ffmpeg 不一定在 PATH 上（新 shell 才刷新）—— 兜底找一遍
    $cand = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($cand) { return $cand.FullName }
    return $null
}

$Ffmpeg = Resolve-Ffmpeg
if (-not $Ffmpeg) {
    Write-Host "找不到 ffmpeg（需要它转 mp3）" -ForegroundColor Red
    exit 1
}
Info "ffmpeg: $Ffmpeg"

if (-not (Test-Path $LinesJson)) {
    Write-Host "缺 $LinesJson" -ForegroundColor Red
    exit 1
}
$spec = Get-Content $LinesJson -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $spec.lines -or $spec.lines.Count -eq 0) {
    Write-Host "voice-lines.json 里没有 lines" -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

Head "检查源"
$realLines = @($spec.lines | Where-Object { $_.source -eq "real" })
$synthLines = @($spec.lines | Where-Object { $_.source -eq "synth" })
Info "real  $($realLines.Count) 条（官方配音，优先）"
Info "synth $($synthLines.Count) 条（GPT-SoVITS 合成）"

# real 来源的**存在性必须在这里挡住**，不能等到运行时 404。
# 那批素材是外部目录，可能被移走/改名；不检查的话产物里会留下一条指向
# 空气的清单，运行时表现为"某句台词永远不响"且毫无报错。
$missing = @()
foreach ($l in $realLines) {
    $src = Join-Path $RealDir $l.real
    if (-not (Test-Path $src)) { $missing += "$($l.name) -> $($l.real)" }
}
if ($missing.Count -gt 0) {
    Write-Host "官方素材缺以下文件（real 来源）：" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "     $_" }
    Write-Host "   素材目录：$RealDir"
    exit 1
}
Info "real 来源全部就位"

# ── 转码：任意输入 → 单声道 64k mp3 ─────────────────────────────────────────
#
# ⚠️ 形参名**绝不能叫 `$input`** —— 那是 PowerShell 的自动变量（管道输入枚举器），
# 同名形参会静默失效：`-i $input` 展开成空，ffmpeg 于是报
# "Error opening input file -ac"（把下一个开关当成了输入路径）。
# 实测踩过一次：合成 6 条全成功、转码 0 条成功。
function Convert-ToMp3([string]$src, [string]$dst) {
    # -ac 1    单声道：音色信息量低，立体声是纯浪费
    # -b:a 64k 对这个用途足够（实测听不出与 320k 的差别）
    # -y       覆盖（幂等由调用方的跳过逻辑保证，不靠 ffmpeg 报错）
    $ffargs = @("-hide_banner", "-loglevel", "error", "-y",
        "-i", $src, "-ac", "1", "-b:a", "64k", "-ar", "44100", $dst)
    & $Ffmpeg @ffargs
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg 转码失败（exit $LASTEXITCODE）：$src" }
}

# ── 合成（**一次批量调用**，不要每条起一次进程）─────────────────────────────
#
# 每条台词起一次 python 的话，每条都要付一次 30 秒冷启动 ——
# 19 条就是 10 分钟。批量调用只加载一次模型，之后每条约 5 秒。
if ($synthLines.Count -gt 0) {
    $pending = @()
    # ⭐ 已合成的 wav 直接复用（`art/voice-src/<name>.wav`）。
    #
    # 为什么：`tools/synth-voice.ps1` 是**改台词时的工作流**（抽文本 → 批量合成 →
    # 落成按名字命名的 wav）。改一条台词就重跑整批合成是浪费（每次冷启动 30 秒+）。
    # 有现成 wav 就直接转码 —— 与 real 来源同一套处理，只是源目录不同。
    $srcWavDir = Join-Path $Root "art\voice-src"
    $reuseWav = @{}
    $needSynth = @()
    foreach ($l in $synthLines) {
        $target = Join-Path $OutDir "$($l.name).mp3"
        if ((-not $Force) -and (Test-Path $target)) {
            Info "跳过（已存在）：$($l.name)"
            continue
        }
        $pre = Join-Path $srcWavDir "$($l.name).wav"
        if ((-not $Force) -and (Test-Path $pre)) {
            $reuseWav[$l.name] = $pre
            Info "复用已合成音频：$($l.name)"
            continue
        }
        $needSynth += $l
    }
    # ① 先转码现成的
    foreach ($name in $reuseWav.Keys) {
        Convert-ToMp3 $reuseWav[$name] (Join-Path $OutDir "$name.mp3")
        Info "转码 OK $name  <- art/voice-src"
    }
    $pending = $needSynth
    if ($pending.Count -gt 0) {
        $txt = Join-Path $WorkDir "lines.txt"
        $outWav = Join-Path $WorkDir "wav"
        New-Item -ItemType Directory -Force -Path $outWav | Out-Null
        # UTF-8 **无 BOM**：synth.py 用 encoding="utf-8" 读，带 BOM 会把首行
        # 第一个字污染成 "\ufeff好" —— 那个字符会被念出来或导致首字吞掉。
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllLines($txt, ($pending | ForEach-Object { $_.text }), $utf8NoBom)

        # ⭐ **缓存复用**：合成很慢（6 条约 90 秒 + 冷启动 30 秒）。
        # 若上次跑到一半失败（比如转码环节），重跑不该再合成一遍。
        # 判定"缓存可用"必须同时满足：① 台词表与上次**逐字相同**；
        # ② 每条 wav 都在。只判文件在不在是不够的 —— 改了台词但文件还在时
        # 会拿旧音频配新名字，那是**静默的错误内容**，比重新合成糟得多。
        $hash = (Get-FileHash -Path $txt -Algorithm SHA256).Hash
        $stampFile = Join-Path $outWav ".lines.sha256"
        $reuse = $false
        if ((-not $Force) -and (Test-Path $stampFile)) {
            $prev = (Get-Content $stampFile -Raw).Trim()
            if ($prev -eq $hash) {
                $allThere = $true
                for ($i = 0; $i -lt $pending.Count; $i++) {
                    if (-not (Test-Path (Join-Path $outWav ("{0:000}.wav" -f ($i + 1))))) { $allThere = $false; break }
                }
                $reuse = $allThere
            }
        }

        if ($reuse) {
            Info "复用已合成的音频（台词表未变，共 $($pending.Count) 条）"
        } else {
            Head "合成 $($pending.Count) 条（约 $([math]::Round($pending.Count * 5)) 秒 + 冷启动 30 秒）"
            if (-not (Test-Path $Python)) {
                Write-Host "找不到合成环境 python：$Python" -ForegroundColor Red
                exit 1
            }
            if (-not (Test-Path $SynthPy)) {
                Write-Host "找不到 synth.py：$SynthPy" -ForegroundColor Red
                exit 1
            }
            Info "台词表：$txt"
            & $Python $SynthPy --file $txt --out $outWav
            if ($LASTEXITCODE -ne 0) {
                Write-Host "合成失败（exit $LASTEXITCODE）" -ForegroundColor Red
                exit 1
            }
            [System.IO.File]::WriteAllText($stampFile, $hash, $utf8NoBom)
        }

        # synth.py 按 1-based 序号命名（001.wav、002.wav…），顺序与输入一致。
        for ($i = 0; $i -lt $pending.Count; $i++) {
            $wav = Join-Path $outWav ("{0:000}.wav" -f ($i + 1))
            if (-not (Test-Path $wav)) {
                Write-Host "合成产物缺失：$wav（第 $($i + 1) 条）" -ForegroundColor Red
                exit 1
            }
            $target = Join-Path $OutDir "$($pending[$i].name).mp3"
            Convert-ToMp3 $wav $target
            Info "合成 OK $($pending[$i].name)"
        }
    }
}

# ── real 来源转码 ───────────────────────────────────────────────────────────
Head "转码官方配音 $($realLines.Count) 条"
foreach ($l in $realLines) {
    $target = Join-Path $OutDir "$($l.name).mp3"
    if ((-not $Force) -and (Test-Path $target)) {
        Info "跳过（已存在）：$($l.name)"
        continue
    }
    Convert-ToMp3 (Join-Path $RealDir $l.real) $target
    Info "转码 OK $($l.name)  <- $($l.real)"
}

# ── 生成清单 ────────────────────────────────────────────────────────────────
#
# **时长由 ffprobe 实测**，不是估算：exe 需要知道每条多长才能做
# "上一句没播完就别播下一句"的去重。写死一个猜的时长会让短句被误判成
# 还在播、或长句被截断。
Head "生成清单"
$ffprobe = Join-Path (Split-Path -Parent $Ffmpeg) "ffprobe.exe"
if (-not (Test-Path $ffprobe)) { $ffprobe = "ffprobe" }

$entries = @()
foreach ($l in $spec.lines) {
    $file = "$($l.name).mp3"
    $path = Join-Path $OutDir $file
    if (-not (Test-Path $path)) {
        Write-Host "产物缺失：$file" -ForegroundColor Red
        exit 1
    }
    $dur = 0.0
    try {
        $probe = & $ffprobe -v error -show_entries format=duration -of csv=p=0 $path 2>$null
        $dur = [double]::Parse($probe.Trim(), [System.Globalization.CultureInfo]::InvariantCulture)
    } catch {
        Write-Host "读不出时长，按 0 处理：$file" -ForegroundColor Yellow
    }
    $size = (Get-Item $path).Length
    $entries += [ordered]@{
        name       = $l.name
        file       = $file
        event      = $l.event
        source     = $l.source
        # 台词原文进清单：① 诊断时能一眼看出"这条到底念的是什么"；
        # ② 测试能比对"源与产物是否一致"（改了台词忘了重建 → 听到旧词，
        #    而名字与事件都对得上，只比名字测不出来）。
        text       = $l.text
        durationMs = [int][math]::Round($dur * 1000)
        bytes      = [int]$size
    }
}

$manifest = [ordered]@{
    version     = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    count       = $entries.Count
    # 总时长与总体积：桌宠要长时间挂着，用户有权知道它占多少。
    #
    # ⚠️ 用显式循环求和，**不用 `Measure-Object -Property durationMs`** ——
    # `[ordered]@{}` 是字典，`Measure-Object` 按**属性**取值取不到字典键，
    # 会抛 "The property durationMs cannot be found"（实测踩过：
    # 19 个 mp3 全部生成成功，却卡在最后一步汇总）。
    totalMs     = 0
    totalBytes  = 0
    lines       = $entries
}
foreach ($e in $entries) {
    $manifest.totalMs += $e.durationMs
    $manifest.totalBytes += $e.bytes
}
$json = $manifest | ConvertTo-Json -Depth 5
# UTF-8 **无 BOM**：这个文件由 Node（Host）读，Node 的 readFileSync(..., 'utf8')
# **不会**去掉 BOM —— 带 BOM 会让 JSON.parse 抛错。
# （与 .ps1 脚本本身要求带 BOM 相反，这里写清楚免得混淆。）
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ManifestPath, $json, $utf8NoBom)

Head "完成"
Info "清单：$ManifestPath"
Info "条数：$($entries.Count)"
Info "总时长：$([math]::Round($manifest.totalMs / 1000, 1)) 秒"
Info "总体积：$([math]::Round($manifest.totalBytes / 1KB, 1)) KB"

# 体积守卫：桌宠语音包不该膨胀到几十 MB
$maxBytes = 4MB
if ($manifest.totalBytes -gt $maxBytes) {
    Write-Host "语音包 $([math]::Round($manifest.totalBytes / 1MB, 2)) MB 超过 $([math]::Round($maxBytes / 1MB, 1)) MB" -ForegroundColor Yellow
    Write-Host "   考虑降低码率或删掉用得少的台词。" -ForegroundColor Yellow
}

exit 0
