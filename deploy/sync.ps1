#requires -Version 5.1
<#
.SYNOPSIS
  把仓库里的插件代码同步到 DSH 的插件目录（~/.dsh/plugins/xhs-comment-agent）。

.DESCRIPTION
  开发流程用：在仓库里改完代码 → 跑本脚本 → 重启 DSH。
  做四件事：
    1. 校验仓库里 bundle\src 的必需文件齐全
    2. 把 bundle\src\* 与 bundle\package.json 复制到插件目录
    3. 删掉插件目录里仓库已不存在的残留文件（例如 v0.6.0 移除的 xlsx.js / mapping.js）
    4. 复制后逐个比对哈希，并校验 package.json 可解析、无 BOM

  不做：不重启 DSH、不动 rules.json / drafts.jsonl / cookies.json 等状态文件。

.PARAMETER DryRun
  只打印将要做的改动，不写任何文件。

.PARAMETER Target
  自定义插件目录，默认 %USERPROFILE%\.dsh\plugins\xhs-comment-agent
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$Target
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Step($n, $m) { Write-Host "`n[$n] $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "    OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    !   $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "    X   $m" -ForegroundColor Red; exit 1 }

function HasBom([string]$Path) {
  $b = [IO.File]::ReadAllBytes($Path)
  return ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
}

$RepoRoot = Split-Path $PSScriptRoot -Parent
$SrcDir = Join-Path $RepoRoot 'bundle\src'
$PkgJson = Join-Path $RepoRoot 'bundle\package.json'
if (-not $Target) { $Target = Join-Path $env:USERPROFILE '.dsh\plugins\xhs-comment-agent' }
$TargetSrc = Join-Path $Target 'src'

Step 1 '检查仓库与目标目录'

if (-not (Test-Path $SrcDir)) { Die "找不到 $SrcDir（请在仓库的 deploy 目录下运行）" }
if (-not (Test-Path $PkgJson)) { Die "找不到 $PkgJson" }
Ok "仓库 $RepoRoot"

if (-not (Test-Path $Target)) {
  Die "插件目录不存在：$Target`n    先跑一次 deploy\install.ps1 完成首次安装。"
}
if (-not (Test-Path $TargetSrc)) { Die "插件目录里没有 src：$TargetSrc" }
Ok "目标 $Target"

$required = 'index.js', 'run.js', 'panel.js', 'panel.html', 'client.js', 'scripts.js', 'sidecar.js', 'scripts.default.json'
foreach ($f in $required) {
  if (-not (Test-Path (Join-Path $SrcDir $f))) { Die "仓库缺文件：bundle\src\$f" }
}
Ok "必需文件齐全（$($required.Count) 个）"

$version = (Get-Content $PkgJson -Raw | ConvertFrom-Json).version
Ok "版本 $version"

Step 2 '复制代码'

$srcFiles = Get-ChildItem $SrcDir -File
foreach ($f in $srcFiles) {
  $dst = Join-Path $TargetSrc $f.Name
  if ($DryRun) { Warn "DryRun：$($f.Name) → $TargetSrc" }
  else { Copy-Item $f.FullName $dst -Force }
}
if ($DryRun) { Warn "DryRun：package.json → $Target" }
else { Copy-Item $PkgJson (Join-Path $Target 'package.json') -Force }
Ok "已复制 $($srcFiles.Count) 个源文件 + package.json"

Step 3 '清理残留文件'

$stale = Get-ChildItem $TargetSrc -File | Where-Object { $_.Name -notin $srcFiles.Name }
if (-not $stale) {
  Ok '无残留'
} else {
  foreach ($f in $stale) {
    if ($DryRun) { Warn "DryRun：将删除残留 $($f.Name)" }
    else { Remove-Item $f.FullName -Force; Warn "已删除残留 $($f.Name)" }
  }
}

Step 4 '校验'

if ($DryRun) {
  Warn 'DryRun：跳过校验'
} else {
  $bad = 0
  foreach ($f in $srcFiles) {
    $a = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
    $b = (Get-FileHash (Join-Path $TargetSrc $f.Name) -Algorithm SHA256).Hash
    if ($a -ne $b) { Warn "哈希不一致：$($f.Name)"; $bad += 1 }
  }
  $pkgTarget = Join-Path $Target 'package.json'
  if ($bad) { Die "$bad 个文件校验失败" }
  if (HasBom $pkgTarget) { Die 'package.json 带 BOM（会导致 DSH 启动崩溃），请检查' }
  try { $null = Get-Content $pkgTarget -Raw | ConvertFrom-Json } catch { Die "package.json 解析失败：$($_.Exception.Message)" }
  Ok "全部 $($srcFiles.Count) 个文件哈希一致；package.json 无 BOM、可解析"
}

Step 5 '完成'

Say ''
Say '接下来：' 'White'
Say '  1) 完全退出 DSH（托盘右键 → 退出），再打开' 'White'
Say '  2) 打开右侧栏「小红书评论」→ 主控页确认状态正常' 'White'
Say '  3) 网页兜底 http://127.0.0.1:18765/' 'Gray'
Say ''
Say '注：本脚本只同步代码，不动 rules.json / drafts.jsonl / cookies.json 等状态文件。' 'DarkGray'
