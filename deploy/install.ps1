<#
.SYNOPSIS
  小红书评论 Agent —— 客户机一键安装器（Windows + DSH 桌面端）

.DESCRIPTION
  做四件事：
    1. 把插件代码复制到 %USERPROFILE%\.dsh\plugins\xhs-comment-agent
    2. 下载 xiaohongshu-mcp 的两个 exe 到 %USERPROFILE%\.dsh\runtimes
    3. 在 DSH profile 的 cordis.patch.yml 里登记插件（幂等，可重复执行）
    4. 尝试给 Defender 加排除目录（不需要可加 -SkipDefender）

  不重启 DSH、不登录小红书——那两步要人工做，脚本最后会打印步骤。

.PARAMETER Preview
  只检查、只打印将要做什么，不写任何文件。

.PARAMETER SkipDownload
  二进制已就位时跳过下载。

.PARAMETER SkipDefender
  不动 Defender 排除项。

.PARAMETER RunLogin
  装完立刻打开扫码登录窗口（扫码后 cookies 落在 ~/.dsh/xhs-agent）。
#>
[CmdletBinding()]
param(
  [switch]$Preview,
  [switch]$SkipDownload,
  [switch]$SkipDefender,
  [switch]$RunLogin
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------- 常量 ----------
$DshHome    = Join-Path $env:USERPROFILE '.dsh'
$PluginDir  = Join-Path $DshHome 'plugins\xhs-comment-agent'
$StateDir   = Join-Path $DshHome 'xhs-agent'
$RuntimeDir = Join-Path $DshHome 'runtimes'
$McpExe     = Join-Path $RuntimeDir 'xiaohongshu-mcp.exe'
$LoginExe   = Join-Path $RuntimeDir 'xiaohongshu-login.exe'
$Mirrors    = @(
  'https://ghfast.top/https://github.com/xpzouying/xiaohongshu-mcp/releases/latest/download',
  'https://gh-proxy.com/https://github.com/xpzouying/xiaohongshu-mcp/releases/latest/download',
  'https://github.com/xpzouying/xiaohongshu-mcp/releases/latest/download'
)
$PanelPort  = 18765
$SidecarPort = 18060

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    !   $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "    X   $msg" -ForegroundColor Red; exit 1 }

# ---------- 1. 环境检查 ----------
Step 1 '检查 DSH 安装'

if (-not (Test-Path $DshHome)) { Die "没找到 $DshHome，这台机器看起来没装 DSH 桌面端。" }

$profilesRoot = Join-Path $DshHome 'profiles'
if (-not (Test-Path $profilesRoot)) { Die "没找到 profiles 目录：$profilesRoot" }

$all = Get-ChildItem $profilesRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'cordis.patch.yml') }
if (-not $all) { Die "没有任何 profile（需要 cordis.patch.yml）。先启动一次 DSH，让它生成 profile。" }

$profile = $all | Where-Object Name -eq 'desktop' | Select-Object -First 1
if (-not $profile) { $profile = $all | Where-Object Name -eq 'web' | Select-Object -First 1 }
if (-not $profile) { $profile = $all | Select-Object -First 1 }

$patchFile = Join-Path $profile.FullName 'cordis.patch.yml'
Ok "profile = $($profile.Name)"
Ok "patch   = $patchFile"

# ---------- 2. 插件文件 ----------
Step 2 '复制插件代码'

$srcDir = Join-Path $PSScriptRoot '..\bundle\src'
if (-not (Test-Path $srcDir)) { Die "安装包不完整：找不到 $srcDir（应与 deploy 目录同级）" }
foreach ($f in 'index.js','panel.js','panel.html','xlsx.js','mapping.js') {
  if (-not (Test-Path (Join-Path $srcDir $f))) { Die "安装包缺文件：bundle\src\$f" }
}

if ($Preview) {
  Warn "Preview：跳过写入，将把 $srcDir 复制到 $PluginDir"
} else {
  New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
  Copy-Item (Join-Path $srcDir '*') $PluginDir -Recurse -Force
  Ok "已复制到 $PluginDir"
}

# ---------- 3. 运行时二进制 ----------
Step 3 '准备 xiaohongshu-mcp 二进制'

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$need = @()
if (-not (Test-Path $McpExe))   { $need += @{ name = 'xiaohongshu-mcp.exe';   asset = 'xiaohongshu-mcp-windows-amd64.exe' } }
if (-not (Test-Path $LoginExe)) { $need += @{ name = 'xiaohongshu-login.exe'; asset = 'xiaohongshu-login-windows-amd64.exe' } }

if (-not $need.Count) {
  Ok "已存在：xiaohongshu-mcp.exe / xiaohongshu-login.exe"
} elseif ($SkipDownload) {
  Warn "缺文件但指定了 -SkipDownload：$($need.name -join ', ')"
} else {
  foreach ($n in $need) {
    $target = Join-Path $RuntimeDir $n.name
    if ($Preview) { Warn "Preview：将下载 $($n.asset)"; continue }
    $done = $false
    foreach ($m in $Mirrors) {
      try {
        Say "    下载 $($n.asset)  ← $m" DarkGray
        Invoke-WebRequest -Uri "$m/$($n.asset)" -OutFile $target -TimeoutSec 600 -UseBasicParsing
        if ((Get-Item $target).Length -gt 5MB) { Ok "$($n.name)  $([math]::Round((Get-Item $target).Length/1MB,1)) MB"; $done = $true; break }
      } catch { Warn "该源失败：$($_.Exception.Message)" }
    }
    if (-not $done) { Die "下载失败（所有镜像都不通）。可手动下载 $($n.asset) 放到 $RuntimeDir" }
  }
}

# ---------- 4. 登记到 profile ----------
Step 4 '在 profile 里登记插件'

$pluginEntry = Join-Path $PluginDir 'index.js'
$blockRaw = @"
- insert:
    - id: xhs-comment-agent
      name: '$pluginEntry'
      config:
        binaryPath: '$McpExe'
        manageProcess: true
        port: $SidecarPort
        panelPort: $PanelPort
        headless: true
        cwd: '$StateDir'
        dryRun: true
        stateDir: '$StateDir'
        rulesPath: '$StateDir\rules.json'
"@
$block = ($blockRaw -replace "`r`n", "`n").TrimEnd()

$existing = Get-Content $patchFile -Raw
if (-not $existing) { $existing = '' }

# 幂等：先摘掉旧的同 id 块，再追加新块
$lines = $existing -split "`r?`n"
$startIdx = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\s*-\s*id:\s*xhs-comment-agent\s*$') { $startIdx = $i; break }
}
if ($startIdx -ge 0) {
  $insIdx = $startIdx
  for ($j = $startIdx - 1; $j -ge 0; $j--) {
    if ($lines[$j] -match '^\s*-\s*insert:\s*$') { $insIdx = $j; break }
    if ($lines[$j] -match '^\S') { break }
  }
  $endIdx = $lines.Count
  for ($k = $startIdx + 1; $k -lt $lines.Count; $k++) {
    if ($lines[$k] -match '^-\s' -or $lines[$k] -match '^[a-zA-Z]') { $endIdx = $k; break }
  }
  $newLines = @()
  if ($insIdx -gt 0) { $newLines += $lines[0..($insIdx - 1)] }
  if ($endIdx -lt $lines.Count) { $newLines += $lines[$endIdx..($lines.Count - 1)] }
  $existing = ($newLines -join "`n").TrimEnd()
  Warn "发现已存在的 xhs-comment-agent 配置，将用新路径覆盖"
}

$merged = ($existing.TrimEnd() + "`n`n" + $block).TrimEnd() + "`n"

if ($Preview) {
  Warn 'Preview：将写入以下片段'
  Write-Host $block -ForegroundColor DarkGray
} else {
  $backup = "$patchFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $patchFile $backup -Force
  Set-Content -Path $patchFile -Value $merged -Encoding utf8
  Ok "已写入（备份：$(Split-Path $backup -Leaf)）"
}

# ---------- 5. 运行目录 ----------
Step 5 '准备状态目录'
if ($Preview) { Warn "Preview：将创建 $StateDir" }
else {
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  Ok $StateDir
}

# ---------- 6. Defender 排除 ----------
Step 6 'Defender 排除（可选）'
if ($SkipDefender) {
  Warn '已跳过（-SkipDefender）'
} else {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Warn '当前不是管理员，跳过；若登录时闪退，见部署文档「Defender 拦截」一节'
  } elseif ($Preview) {
    Warn "Preview：将排除 $RuntimeDir、$(Join-Path $env:LOCALAPPDATA 'xiaohongshu-mcp')"
  } else {
    try {
      Add-MpPreference -ExclusionPath @($RuntimeDir, (Join-Path $env:LOCALAPPDATA 'xiaohongshu-mcp')) -ErrorAction Stop
      Ok '已加入排除目录（仅这两处，不动整个磁盘）'
    } catch {
      Warn "加排除失败：$($_.Exception.Message)"
    }
  }
}

# ---------- 7. 收尾 ----------
Step 7 '完成'

Say ''
Say '接下来人工做三步：' 'White'
Say '  1) 首次扫码登录（只需一次）：' 'White'
Say "     cd `"$StateDir`"; & `"$LoginExe`"" 'Gray'
Say '  2) 完全退出 DSH 桌面端再打开（托盘右键退出，不是关窗口）' 'White'
Say '  3) 浏览器打开面板：' 'White'
Say "     http://127.0.0.1:$PanelPort/" 'Gray'
Say ''
Say '验证顺序：面板显示「服务在线 / 已登录」→ 导入客户配置清单 → 干跑三天 → 再关干跑。' 'DarkGray'

if ($RunLogin -and -not $Preview) {
  Say ''
  Say '正在打开登录窗口，请用手机小红书扫码…' 'Yellow'
  Start-Process -FilePath $LoginExe -WorkingDirectory $StateDir -Wait
  Say '登录流程已结束，检查 ~/.dsh/xhs-agent/cookies.json 是否有内容。' 'Yellow'
}
