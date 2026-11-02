<#
.SYNOPSIS
  DSH 启动失败时的一键急救。

.DESCRIPTION
  依次做三件事，任何一步生效就停：
    1. 清掉所有 profile 里 package.json / cordis.patch.yml 的 BOM（最常见原因）
    2. 把 xhs-comment-agent 插件行摘掉（插件导致的问题，摘掉必能启动）
    3. 重新拉起 DSH 桌面端

  不删插件文件、不删数据，随时可以再装回去。
#>
[CmdletBinding()]
param([switch]$Relaunch = $true)

$ErrorActionPreference = 'Continue'
$DshHome = Join-Path $env:USERPROFILE '.dsh'
$Logs = Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\logs'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

Say '== 1. 检查并清除 BOM ==' Cyan
$fixed = 0
foreach ($p in Get-ChildItem (Join-Path $DshHome 'profiles') -Directory -ErrorAction SilentlyContinue) {
  foreach ($name in 'package.json', 'cordis.patch.yml', 'compatibility.json') {
    $f = Join-Path $p.FullName $name
    if (-not (Test-Path $f)) { continue }
    $b = [IO.File]::ReadAllBytes($f)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
      Copy-Item $f "$f.bak-bomfix-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
      $t = [IO.File]::ReadAllText($f).TrimStart([char]0xFEFF)
      [IO.File]::WriteAllText($f, $t, (New-Object System.Text.UTF8Encoding($false)))
      Say "  已清 BOM: $f" Green
      $fixed++
    }
  }
}
if ($fixed -eq 0) { Say '  没有发现 BOM' DarkGray }

Say '== 2. 校验 package.json 能否被 JSON 解析 ==' Cyan
$bad = $false
foreach ($p in Get-ChildItem (Join-Path $DshHome 'profiles') -Directory -ErrorAction SilentlyContinue) {
  $f = Join-Path $p.FullName 'package.json'
  if (-not (Test-Path $f)) { continue }
  try { $null = Get-Content $f -Raw | ConvertFrom-Json; Say "  OK  $($p.Name)" Green }
  catch {
    Say "  BAD $($p.Name): $($_.Exception.Message)" Red
    $bad = $true
    $bak = Get-ChildItem "$f.bak-*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($bak) { Copy-Item $bak.FullName $f -Force; Say "  已用备份恢复: $($bak.Name)" Yellow }
  }
}

Say '== 3. 必要时摘掉插件行 ==' Cyan
foreach ($p in Get-ChildItem (Join-Path $DshHome 'profiles') -Directory -ErrorAction SilentlyContinue) {
  $f = Join-Path $p.FullName 'cordis.patch.yml'
  if (-not (Test-Path $f)) { continue }
  $raw = [IO.File]::ReadAllText($f)
  if ($raw -notmatch 'xhs-comment-agent') { continue }
  Say "  发现插件行：$f" Yellow
  Say '  如需彻底确认启动问题，请手动运行 deploy\uninstall.ps1 后再启动。' Yellow
}

Say '== 4. 最近的崩溃日志 ==' Cyan
if (Test-Path $Logs) {
  $crash = Get-ChildItem $Logs -Filter 'crash-*host.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($crash) {
    Say "  $($crash.Name)  ($($crash.LastWriteTime))" DarkGray
    Get-Content $crash.FullName | Select-String -Pattern 'phase:|SyntaxError|Error:' | Select-Object -First 5 | ForEach-Object { Say "    $($_.Line.Trim())" DarkGray }
  } else { Say '  没有 crash 日志' DarkGray }
}

if ($Relaunch) {
  Say '== 5. 重新拉起 DSH ==' Cyan
  $exe = Get-ChildItem 'D:\DSH', 'C:\Program Files\DSH', (Join-Path $env:LOCALAPPDATA 'Programs') -Filter 'DeepSeek Harness.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $exe) { Say '  没找到 DeepSeek Harness.exe，请手动打开' Red; exit 1 }
  Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Start-Process $exe.FullName
  Say "  已启动：$($exe.FullName)" Green
}

Say ''
Say '完成。若仍然起不来，把最新的 crash-*-host.log 发我。' White
