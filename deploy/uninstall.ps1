<#
.SYNOPSIS
  卸载小红书评论 Agent（可保留数据）

.DESCRIPTION
  1. 从 profile 的 cordis.patch.yml 里摘掉插件行
  2. 删除 %USERPROFILE%\.dsh\plugins\xhs-comment-agent
  3. -Purge 时额外删除状态目录和两个二进制

  不重启 DSH；卸载完需要重启才不加载。
#>
[CmdletBinding()]
param([switch]$Purge, [switch]$Preview)

$ErrorActionPreference = 'Stop'
$DshHome   = Join-Path $env:USERPROFILE '.dsh'
$PluginDir = Join-Path $DshHome 'plugins\xhs-comment-agent'
$StateDir  = Join-Path $DshHome 'xhs-agent'
$RuntimeDir = Join-Path $DshHome 'runtimes'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

$profilesRoot = Join-Path $DshHome 'profiles'
$patched = @()
foreach ($p in Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue) {
  $f = Join-Path $p.FullName 'cordis.patch.yml'
  if ((Test-Path $f) -and ((Get-Content $f -Raw) -match 'xhs-comment-agent')) { $patched += $f }
}
if (-not $patched) { Say '没有找到已登记的插件行。' Yellow }

foreach ($f in $patched) {
  $lines = (Get-Content $f -Raw) -split "`r?`n"
  $start = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*-\s*id:\s*xhs-comment-agent\s*$') { $start = $i; break } }
  if ($start -lt 0) { continue }
  $ins = $start
  for ($j = $start - 1; $j -ge 0; $j--) {
    if ($lines[$j] -match '^\s*-\s*insert:\s*$') { $ins = $j; break }
    if ($lines[$j] -match '^\S') { break }
  }
  $end = $lines.Count
  for ($k = $start + 1; $k -lt $lines.Count; $k++) {
    if ($lines[$k] -match '^-\s' -or $lines[$k] -match '^[a-zA-Z]') { $end = $k; break }
  }
  $out = @()
  if ($ins -gt 0) { $out += $lines[0..($ins - 1)] }
  if ($end -lt $lines.Count) { $out += $lines[$end..($lines.Count - 1)] }
  $text = (($out -join "`n").TrimEnd()) + "`n"

  if ($Preview) { Say "Preview：将从 $f 摘掉插件行" Yellow }
  else {
    Copy-Item $f "$f.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
    Set-Content $f $text -Encoding utf8
    Say "已清理：$f" Green
  }
}

if ($Preview) {
  Say "Preview：将删除 $PluginDir" Yellow
  if ($Purge) { Say "Preview：将删除 $StateDir 与运行目录里的两个 exe" Yellow }
} else {
  if (Test-Path $PluginDir) { Remove-Item $PluginDir -Recurse -Force; Say "已删除 $PluginDir" Green }
  if ($Purge) {
    if (Test-Path $StateDir) { Remove-Item $StateDir -Recurse -Force; Say "已删除 $StateDir" Green }
    foreach ($n in 'xiaohongshu-mcp.exe', 'xiaohongshu-login.exe') {
      $f = Join-Path $RuntimeDir $n
      if (Test-Path $f) { Remove-Item $f -Force; Say "已删除 $f" Green }
    }
  }
}

Say ''
Say '重启 DSH 后插件才会真正卸载。浏览器里已打开的面板直接关掉即可。' White
