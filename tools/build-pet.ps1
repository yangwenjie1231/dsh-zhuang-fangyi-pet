#Requires -Version 5.1
<#
.SYNOPSIS
  编译 dsh-zhuang-fangyi-pet 原生桌宠 exe（C# / WPF / .NET Framework 4.8）。

.DESCRIPTION
  主路径：Roslyn（dotnet SDK 自带的 csc.dll）——支持 -langversion:latest。
  回落路径：in-box C# 5 编译器 %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
            （必须带 -noconfig，否则 CS1703；源码保持 C#5 兼容）。
  不需要 .exe.config，只产出单个 exe。

.PARAMETER OutDir
  输出目录，默认 <包根>\bin。

.PARAMETER ForceCsc
  强制使用 in-box csc 回落编译器（用于验证 C#5 兼容性）。

.PARAMETER NoManifest
  不嵌入 app.manifest（DPI 感知会丢失，仅排障用）。

.PARAMETER Clean
  编译前清空输出目录里的旧 exe。

.EXAMPLE
  pwsh -File tools/build-pet.ps1
.EXAMPLE
  pwsh -File tools/build-pet.ps1 -OutDir D:\tmp\out -ForceCsc
#>
[CmdletBinding()]
param(
    [string]$OutDir,
    [switch]$ForceCsc,
    [switch]$NoManifest,
    [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PkgRoot = Split-Path -Parent $PSScriptRoot
$PetDir  = Join-Path $PkgRoot 'pet'
$ExeName = 'dsh-zhuang-fangyi-pet.exe'

if (-not (Test-Path -LiteralPath $PetDir)) { throw "找不到源码目录: $PetDir" }

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $PkgRoot 'bin'
} elseif (-not [System.IO.Path]::IsPathRooted($OutDir)) {
    $OutDir = Join-Path $PkgRoot $OutDir
}
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$OutExe = Join-Path $OutDir $ExeName

if ($Clean -and (Test-Path -LiteralPath $OutExe)) { Remove-Item -LiteralPath $OutExe -Force }

# ---------------------------------------------------------------- 引用程序集
function Find-RefDir {
    $roots = @(
        'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework',
        'C:\Program Files\Reference Assemblies\Microsoft\Framework\.NETFramework'
    )
    $cands = New-Object System.Collections.Generic.List[string]
    foreach ($r in $roots) {
        if (-not (Test-Path -LiteralPath $r)) { continue }
        foreach ($v in @('v4.8', 'v4.7.2', 'v4.7.1', 'v4.7', 'v4.6.2', 'v4.6.1', 'v4.6')) {
            $d = Join-Path $r $v
            if (Test-Path -LiteralPath (Join-Path $d 'mscorlib.dll')) { $cands.Add($d) }
        }
    }
    if ($cands.Count -eq 0) { return $null }
    return $cands[0]
}

$RefDir = Find-RefDir
if (-not $RefDir) {
    throw '找不到 .NET Framework 引用程序集（需要 v4.6+ 的 Reference Assemblies）。请安装 .NET Framework 4.8 Developer Pack。'
}
Write-Host "[build] 引用程序集: $RefDir"

$RefAssemblies = @(
    'mscorlib.dll',
    'System.dll',
    'System.Core.dll',
    'System.Xaml.dll',
    'WindowsBase.dll',
    'PresentationCore.dll',
    'PresentationFramework.dll',
    'System.Windows.Forms.dll',
    'System.Drawing.dll'
)
$RefArgs = New-Object System.Collections.Generic.List[string]
foreach ($a in $RefAssemblies) {
    $p = Join-Path $RefDir $a
    if (-not (Test-Path -LiteralPath $p)) { throw "缺少引用程序集: $p" }
    $RefArgs.Add('-r:' + $p)
}

# ---------------------------------------------------------------- 源码
$Sources = @(Get-ChildItem -LiteralPath $PetDir -Filter '*.cs' -File | Sort-Object Name | ForEach-Object { $_.FullName })
if ($Sources.Count -eq 0) { throw "在 $PetDir 下找不到任何 .cs 源文件" }
Write-Host "[build] 源文件 $($Sources.Count) 个: $((($Sources | ForEach-Object { Split-Path -Leaf $_ }) -join ', '))"

# ---------------------------------------------------------------- 编译器
function Find-Roslyn {
    $sdkRoots = @(
        'C:\Program Files\dotnet\sdk',
        (Join-Path $env:ProgramFiles 'dotnet\sdk'),
        (Join-Path ${env:ProgramFiles(x86)} 'dotnet\sdk')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

    $found = New-Object System.Collections.Generic.List[object]
    foreach ($root in $sdkRoots) {
        foreach ($sdk in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
            $dll = Join-Path $sdk.FullName 'Roslyn\bincore\csc.dll'
            if (Test-Path -LiteralPath $dll) {
                $found.Add([pscustomobject]@{ Path = $dll; Version = $sdk.Name })
            }
        }
    }
    if ($found.Count -eq 0) { return $null }
    # 取版本最高的 SDK（简单字符串排序足够，因为 SDK 目录名是 x.y.zzz）
    return ($found | Sort-Object -Property Version -Descending | Select-Object -First 1).Path
}

function Find-InBoxCsc {
    $cands = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    )
    foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return $null
}

$RoslynDll = $null
if (-not $ForceCsc) { $RoslynDll = Find-Roslyn }

$ManifestPath = Join-Path $PetDir 'app.manifest'
$UseManifest = (-not $NoManifest) -and (Test-Path -LiteralPath $ManifestPath)

$CommonArgs = New-Object System.Collections.Generic.List[string]
foreach ($a in @(
    '-nologo', '-noconfig', '-nostdlib+',
    '-target:winexe', '-optimize+', '-debug-',
    '-platform:anycpu',
    '-out:' + $OutExe
)) { $CommonArgs.Add($a) }
if ($UseManifest) { $CommonArgs.Add('-win32manifest:' + $ManifestPath) }
foreach ($a in $RefArgs) { $CommonArgs.Add($a) }
foreach ($s in $Sources) { $CommonArgs.Add($s) }

function Invoke-Compiler([string]$FilePath, [string[]]$ArgumentList, [string]$Label) {
    Write-Host "[build] $Label"
    Write-Host "[build] $FilePath $($ArgumentList -join ' ')"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $FilePath @ArgumentList
    $code = $LASTEXITCODE
    $sw.Stop()
    Write-Host ("[build] $Label 退出码 $code，耗时 {0:n2}s" -f $sw.Elapsed.TotalSeconds)
    return $code
}

$usedCompiler = $null
$exit = 1

if ($RoslynDll) {
    $dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue)
    if (-not $dotnet) { throw '找到 Roslyn csc.dll 但 PATH 上没有 dotnet，无法执行' }
    $roslynArgs = New-Object System.Collections.Generic.List[string]
    $roslynArgs.Add($RoslynDll)
    $roslynArgs.Add('-langversion:latest')
    foreach ($a in $CommonArgs) { $roslynArgs.Add($a) }
    $exit = Invoke-Compiler -FilePath $dotnet.Source -ArgumentList $roslynArgs.ToArray() -Label 'Roslyn csc (langversion:latest)'
    $usedCompiler = "roslyn:$RoslynDll"
} else {
    $csc = Find-InBoxCsc
    if (-not $csc) { throw '既没有 Roslyn csc.dll，也没有 in-box csc.exe' }
    # in-box csc 是 C# 5：必须 -noconfig（否则 CS1703），且不能传 -langversion:latest
    $cscArgs = New-Object System.Collections.Generic.List[string]
    $cscArgs.Add('-langversion:5')
    foreach ($a in $CommonArgs) { $cscArgs.Add($a) }
    $exit = Invoke-Compiler -FilePath $csc -ArgumentList $cscArgs.ToArray() -Label 'in-box csc (C#5 回落)'
    $usedCompiler = "csc:$csc"
}

if ($exit -ne 0) {
    throw "编译失败（退出码 $exit）。若错误与 -win32manifest 有关，试 -NoManifest 重跑。"
}
if (-not (Test-Path -LiteralPath $OutExe)) { throw "编译器返回 0 但没有产出 $OutExe" }

# ---------------------------------------------------------------- 结果
$fi = Get-Item -LiteralPath $OutExe
$kb = [math]::Round($fi.Length / 1024.0, 1)
Write-Host ''
Write-Host '========================================'
Write-Host "[build] 成功"
Write-Host "[build] 编译器   : $usedCompiler"
Write-Host "[build] 产物     : $($fi.FullName)"
Write-Host "[build] 大小     : $($fi.Length) 字节 ($kb KB)"
Write-Host "[build] 清单嵌入 : $(if ($UseManifest) { 'app.manifest (PerMonitorV2 DPI)' } else { '否' })"
Write-Host "[build] 时间     : $($fi.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Host '========================================'
Write-Host ''
Write-Host "下一步自检: & '$($fi.FullName)' --selftest"

# 供调用方消费的机器可读结果
[pscustomobject]@{
    Exe         = $fi.FullName
    Bytes       = $fi.Length
    KB          = $kb
    Compiler    = $usedCompiler
    Manifest    = $UseManifest
    Sources     = $Sources.Count
} | Write-Output