# 批量合成 voice-lines.json 里所有 source=synth 的台词（构建期一次性）
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\synth-voice.ps1
#
# 为什么批量：synth.py 每次启动要加载模型（实测 55.7 秒含加载，热态每句 2~8 秒）。
# 30 句分开调 = 30 × 55 秒 ≈ 28 分钟；一次批量 ≈ 2 分钟。

$ErrorActionPreference = 'Stop'
$PY = 'C:\Users\A\miniconda3\envs\voice\python.exe'
$SYNTH = 'D:\A\voiceclone\synth.py'
$ROOT = Split-Path -Parent $PSScriptRoot
$OUT = Join-Path $env:TEMP 'zf-synth-voice'
$NODE = 'C:\Users\A\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

if (-not (Test-Path $PY)) { throw "找不到 python: $PY" }
if (-not (Test-Path $SYNTH)) { throw "找不到 synth.py: $SYNTH" }

# 1) 从 voice-lines.json 抽出待合成清单（保持顺序：synth.py 按行号输出 001.wav…）
$listFile = Join-Path $OUT 'lines.txt'
$mapFile = Join-Path $OUT 'map.json'
New-Item -ItemType Directory -Force -Path $OUT | Out-Null

& $NODE -e @"
const fs=require('node:fs');
const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const want=j.lines.filter(l=>l.source==='synth');
fs.writeFileSync(process.argv[2], want.map(l=>l.text).join('\n')+'\n','utf8');
fs.writeFileSync(process.argv[3], JSON.stringify(want.map((l,i)=>({idx:i+1,name:l.name,text:l.text})),null,2),'utf8');
console.log('待合成 '+want.length+' 条');
"@ (Join-Path $ROOT 'tools\voice-lines.json') $listFile $mapFile

# 2) 批量合成
#
# ⚠️ 原生命令的 stderr 不能当错误：synth.py 把进度打到 stderr，
# 而 `$ErrorActionPreference='Stop'` 会让 PS 5.1 把它当致命错误直接中断
#（症状是 "python.exe :" 后面一片空白 + NativeCommandError，其实合成成功了）。
Write-Host "合成中（首次会加载模型，约 1 分钟）..."
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $PY $SYNTH --file $listFile --out $OUT 2>&1 | Select-Object -Last 6
$ErrorActionPreference = $prev

# 3) 把 001.wav 按名字重命名到 art/voice-src/
$srcDir = Join-Path $ROOT 'art\voice-src'
New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
$map = Get-Content $mapFile -Raw -Encoding UTF8 | ConvertFrom-Json
$n = 0
foreach ($m in $map) {
  $wav = Join-Path $OUT ('{0:D3}.wav' -f $m.idx)
  if (Test-Path $wav) {
    Copy-Item $wav (Join-Path $srcDir ($m.name + '.wav')) -Force
    $n++
  } else {
    Write-Host "  !! 缺输出: $($m.name)"
  }
}
Write-Host "已就位 $n / $($map.Count) 条 → $srcDir"
