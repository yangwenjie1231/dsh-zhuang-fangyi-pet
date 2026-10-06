# 庄方宜桌宠 · 部署到 DSH profile
#
# 用法（**注意：本机只有 Windows PowerShell 5.1，没有 pwsh 7**）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1
#   powershell -NoProfile -File tools\deploy.ps1 -Profile web
#   powershell -NoProfile -File tools\deploy.ps1 -DryRun          # 只看会做什么
#   powershell -NoProfile -File tools\deploy.ps1 -SkipExe         # 不复制 bin/
#
# ── 为什么需要脚本而不是一句 Copy-Item ────────────────────────────────────
#
# `Copy-Item -Recurse 源目录 已存在的目标目录` **不会合并**，而是在目标下再建一层
# 同名目录（`art\` → `art\art\`）。旧的同名文件留在原地不动，于是"部署成功"但
# 页面跑的还是旧代码 —— 主题插件实测踩过这个坑（头像改了却没生效，因为真正被读的
# `art\avatar.webp` 还是旧文件）。
#
# 所以这里显式做四件事：先删旧目录再整体复制、复制后逐文件校验大小、
# 打构建标记、打印清单让人能一眼看出是否真的更新了。
#
# ── 与主题插件的 deploy.ps1 的关键差异 ────────────────────────────────────
#
# 桌宠多两个必须一起搬的东西，漏掉任何一个都会"部署成功但不工作"：
#
#   · `pet/`      —— C# 源码（供人查阅；运行不需要，但漏了会让人以为源码丢了）
#   · `bin/`      —— **编译好的 exe。漏掉它 = 桌宠永远回落窗口内 overlay**
#   · `art/pet/`  —— 精灵图与 `pet.json`。漏掉它 = 没有表情
#
# 尤其 `art/pet/` 里有**用户手动抠的图**（`src/cutout/`），绝不能被清掉。

[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$DryRun,
  [switch]$SkipExe
)

$ErrorActionPreference = 'Stop'

$Src = Split-Path -Parent $PSScriptRoot          # dsh-zhuang-fangyi-pet\
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$Dst = Join-Path $DshHome "profiles\$Profile\node_modules\dsh-zhuang-fangyi-pet"

# 顶层文件（与 package.json 的 files 字段一致）
$Files = @('index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'README.md')
# 目录。`bin` 单独处理（可 -SkipExe 跳过）。
# `personas-seed` 是**首次运行播种**用的内置人设（Host 把它复制进 $DSH_HOME），
# 漏拷的症状：新机器上人设目录永远为空，聊天没有角色（且毫无报错）。
$Dirs = @('src', 'tools', 'docs', 'art', 'pet', 'personas-seed')

Write-Host "源:   $Src"
Write-Host "目标: $Dst"
Write-Host ''

if (-not (Test-Path $Dst)) {
  throw "目标不存在：$Dst`n请先确认插件已安装到该 profile（见 README 的安装步骤）。"
}

if ($DryRun) {
  Write-Host '[DryRun] 将执行：'
  foreach ($d in $Dirs) { Write-Host "  删除并重建 $d\" }
  if (-not $SkipExe) { Write-Host "  删除并重建 bin\" }
  foreach ($f in $Files) { Write-Host "  覆盖 $f" }
  Write-Host "  打构建标记（index.js 的 __ZF_PET_BUILD__）"
  exit 0
}

# ── 0. 先让正在运行的桌宠退出 ────────────────────────────────────────────
#
# 为什么必须：桌宠 exe 在跑时**文件被占用**，删除/覆盖 `bin\` 会 "Access denied"。
# 而删除是"先删后建"的第一步 —— 一旦在这里失败，目标目录就留下**半成品**
#（bin 被删掉、新的没建回来）。这正是真机上"桌宠不出现、日志只报 started=false"
# 的历史成因：部署时桌宠正在跑。
#
# 处理：检测到就结束它。桌宠是纯展示进程，退出不丢任何状态；
# 宿主会在下次启动时按 settings 重新拉起（或重启 DSH 即可）。
if (-not $SkipExe) {
  $running = Get-Process -Name 'dsh-zhuang-fangyi-pet' -ErrorAction SilentlyContinue
  if ($running) {
    Write-Host ("  停止正在运行的桌宠（{0} 个进程）—— 否则 exe 被占用，删除会失败" -f @($running).Count)
    foreach ($p in $running) {
      try { $p.Kill(); $p.WaitForExit(3000) | Out-Null } catch { }
    }
    Start-Sleep -Milliseconds 400   # 等文件句柄真正释放
    $still = Get-Process -Name 'dsh-zhuang-fangyi-pet' -ErrorAction SilentlyContinue
    if ($still) {
      Write-Host "  ⚠️ 仍有桌宠进程未退出，删除 bin\ 可能失败" -ForegroundColor Yellow
    }
  }
}

# ── 1. 目录：先删后建，避免嵌套与残留 ─────────────────────────────────────
#
# 注意 `art` 整体复制 —— 它包含 `art/pet/src/cutout/`（用户手动抠的图）。
# 那些图无法从源素材自动重建，所以**绝不能**只复制 `art/pet/*.png`。
foreach ($d in $Dirs) {
  $from = Join-Path $Src $d
  if (-not (Test-Path $from)) { Write-Host "  跳过 $d\（源不存在）"; continue }
  $to = Join-Path $Dst $d
  if (Test-Path $to) { Remove-Item $to -Recurse -Force }
  Copy-Item $from $to -Recurse -Force
  $n = (Get-ChildItem $to -Recurse -File).Count
  Write-Host ("  {0,-10} {1,3} 个文件" -f "$d\", $n)
}

# ── 1b. exe ──────────────────────────────────────────────────────────────
if ($SkipExe) {
  Write-Host "  跳过 bin\（-SkipExe：桌宠将回落窗口内 overlay）" -ForegroundColor Yellow
} else {
  $from = Join-Path $Src 'bin'
  if (Test-Path $from) {
    $to = Join-Path $Dst 'bin'
    if (Test-Path $to) { Remove-Item $to -Recurse -Force }
    Copy-Item $from $to -Recurse -Force
    $exe = Get-ChildItem $to -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($exe) {
      Write-Host ("  {0,-10} {1}" -f 'bin\', ("$($exe.Name)  $([int]($exe.Length/1KB)) KB"))
    } else {
      Write-Host "  警告：bin\ 里没有 .exe —— 桌宠将回落窗口内 overlay" -ForegroundColor Yellow
      Write-Host "        请先跑：powershell -NoProfile -File tools\build-pet.ps1" -ForegroundColor Yellow
    }
  } else {
    Write-Host "  警告：bin\ 不存在 —— 桌宠将回落窗口内 overlay" -ForegroundColor Yellow
    Write-Host "        请先跑：powershell -NoProfile -File tools\build-pet.ps1" -ForegroundColor Yellow
  }
}

# ── 2. 顶层文件 ──────────────────────────────────────────────────────────
foreach ($f in $Files) {
  $from = Join-Path $Src $f
  if (-not (Test-Path $from)) { Write-Host "  跳过 $f（源不存在）"; continue }
  Copy-Item $from (Join-Path $Dst $f) -Force
  Write-Host ("  {0,-22} {1,8} B" -f $f, (Get-Item (Join-Path $Dst $f)).Length)
}

# ── 2b. 打构建标记 ───────────────────────────────────────────────────────
#
# 宿主进程缓存 ESM 模块：disable → enable 只重跑 apply()，**不会**重新 import
# `src/pet/*.js`。所以在 index.js 里写一个时间戳标记，之后用
#   GET /api/zhuang-fangyi/pet/diag  ->  {"diag":{"build":"..."}}
# 就能确认运行中的进程跑的是哪一版；标记不匹配说明需要重启宿主。
#
# 这个坑主题插件实测踩过（见 `双壳适配说明.md` §七），是"最容易误判为代码写错"的地方。
$indexPath = Join-Path $Dst 'index.js'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$indexText = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8)
if ($indexText.Contains("'__ZF_PET_BUILD__'")) {
  $indexText = $indexText.Replace("'__ZF_PET_BUILD__'", "'$stamp'")
  [System.IO.File]::WriteAllText($indexPath, $indexText, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  构建标记                 $stamp"
} else {
  Write-Host "  警告：index.js 里没有 __ZF_PET_BUILD__ 占位符，跳过打标" -ForegroundColor Yellow
}

# ── 3. 校验：源与目标逐文件比对大小 ──────────────────────────────────────
# index.js 例外：部署时写了构建标记，长度必然不同。
Write-Host "`n校验（源 vs 目标）："
$bad = 0
$relList = @($Files | Where-Object { $_ -ne 'index.js' })
foreach ($d in $Dirs) {
  $dirPath = Join-Path $Src $d
  if (Test-Path $dirPath) {
    $relList += Get-ChildItem $dirPath -Recurse -File
  }
}
if (-not $SkipExe -and (Test-Path (Join-Path $Src 'bin'))) {
  $relList += Get-ChildItem (Join-Path $Src 'bin') -Recurse -File
}
foreach ($rel in $relList) {
  $relPath = if ($rel -is [string]) { $rel } else { $rel.FullName.Substring($Src.Length + 1) }
  $a = Join-Path $Src $relPath
  $b = Join-Path $Dst $relPath
  if (-not (Test-Path $a)) { continue }
  if (-not (Test-Path $b)) {
    Write-Host "  缺失 $relPath" -ForegroundColor Red
    $bad++
    continue
  }
  if ((Get-Item $a).Length -ne (Get-Item $b).Length) {
    Write-Host ("  大小不符 {0}（源 {1} / 目标 {2}）" -f $relPath, (Get-Item $a).Length, (Get-Item $b).Length) -ForegroundColor Red
    $bad++
  }
}

# 残留的嵌套目录是上一次错误复制的痕迹，必须清掉
foreach ($d in $Dirs) {
  $nested = Join-Path (Join-Path $Dst $d) $d
  if (Test-Path $nested) {
    Write-Host "  清除嵌套目录 $d\$d\" -ForegroundColor Yellow
    Remove-Item $nested -Recurse -Force
  }
}

if ($bad -gt 0) {
  Write-Host "`n校验失败：$bad 个文件不一致" -ForegroundColor Red
  exit 1
}

# ── 4. 目标必须"完整"，且 exe 必须真能跑 ─────────────────────────────────
#
# 为什么加这道：部署是"先删后建"。若某次执行在删完之后被打断（文件锁、杀进程、
# 磁盘抖动），目标目录会留下**半成品**：脚本看起来跑完了，但 `bin/`（或
# `tools/`、`docs/`）没了。宿主的表现是 `started=false` —— **不抛错**，
# 只是静默回落窗口内 overlay，于是"桌宠不出现"且毫无线索。
# 实测踩过：真机上桌宠一直不出来，最后发现部署包里根本没有 bin/。
$missing = @()
foreach ($d in $Dirs) {
  if ((Test-Path (Join-Path $Src $d)) -and -not (Test-Path (Join-Path $Dst $d))) {
    $missing += "$d\"
  }
}
if (-not $SkipExe -and (Test-Path (Join-Path $Src 'bin')) -and -not (Test-Path (Join-Path $Dst 'bin'))) {
  $missing += 'bin\'
}
foreach ($f in $Files) {
  if (-not (Test-Path (Join-Path $Dst $f))) { $missing += $f }
}
if ($missing.Count -gt 0) {
  Write-Host "`n❌ 目标缺东西：$($missing -join ', ')" -ForegroundColor Red
  Write-Host "   目标目录处于**半成品**状态（多半是上一次部署被中断）。" -ForegroundColor Red
  Write-Host "   请重跑本脚本；仍失败就先跑 tools\build-pet.ps1 再重试。" -ForegroundColor Yellow
  exit 1
}

if (-not $SkipExe) {
  $exePath = Join-Path $Dst 'bin\dsh-zhuang-fangyi-pet.exe'
  # 真跑一次自检：文件在 ≠ 能用（可能被截断/杀软隔离）。
  $probe = & $exePath --selftest 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Write-Host "`n❌ 部署后的 exe 自检失败（EXIT=$LASTEXITCODE）——文件可能被截断或隔离。" -ForegroundColor Red
    Write-Host $probe
    exit 1
  }
  $verdict = ($probe -split "`n" | Select-String '自检全部通过|自检存在失败' | Select-Object -Last 1)
  Write-Host ("  exe 自检    {0}" -f ($verdict -replace '\s+', ' ').Trim()) -ForegroundColor Green
}

Write-Host "`n部署完成，全部一致。" -ForegroundColor Green
Write-Host "重载插件：plugin_manager set_plugin target=include:zhuang-fangyi-pet enabled=false → true"
Write-Host "探活：Invoke-WebRequest http://127.0.0.1:<port>/api/zhuang-fangyi/pet/diag"
Write-Host ''
Write-Host "注意：改了 index.js / src/*.js 后，disable→enable **不够**（宿主缓存 ESM 模块），"
Write-Host "      需要用 diag 的 build 字段确认；不匹配就重启 DSH。"