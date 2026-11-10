<#
.SYNOPSIS
  小红书评论 Agent —— 客户机安装器（Windows + DSH 桌面端）

.DESCRIPTION
  做五件事：
    1. 复制插件到 %USERPROFILE%\.dsh\plugins\xhs-comment-agent（src\ + package.json）
    2. 下载 xiaohongshu-mcp 两个 exe 到 %USERPROFILE%\.dsh\runtimes
    3. 把插件软链进 profile 的 node_modules，并登记依赖（客户端右侧栏需要"包"形态）
    4. 在 profile 的 cordis.patch.yml 登记插件行（幂等，写前备份，写后校验）
    5. 尝试添加 Defender 排除（可跳过）

  重要：所有文本文件都以「UTF-8 无 BOM」写入。
  DSH 用 JSON.parse 读 profile/package.json，带 BOM 会直接让宿主启动崩溃
  （crash 日志表现为 Unexpected token '\uFEFF'）。

  不重启 DSH、不登录小红书——那两步人工做，脚本最后会打印步骤。

.PARAMETER Preview
  只检查、只打印，不写任何文件。

.PARAMETER SkipDownload
  二进制已就位时跳过下载。

.PARAMETER SkipDefender
  不动 Defender 排除项。

.PARAMETER RunLogin
  装完立刻打开扫码登录窗口。
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
$DshHome     = Join-Path $env:USERPROFILE '.dsh'
$PluginDir   = Join-Path $DshHome 'plugins\xhs-comment-agent'
$StateDir    = Join-Path $DshHome 'xhs-agent'
$RuntimeDir  = Join-Path $DshHome 'runtimes'
$McpExe      = Join-Path $RuntimeDir 'xiaohongshu-mcp.exe'
$LoginExe    = Join-Path $RuntimeDir 'xiaohongshu-login.exe'
$PkgName     = 'dsh-xhs-comment-agent'
$PanelPort   = 18765
$SidecarPort = 18060
$Mirrors = @(
  'https://ghfast.top/https://github.com/xpzouying/xiaohongshu-mcp/releases/latest/download',
  'https://gh-proxy.com/https://github.com/xpzouying/xiaohongshu-mcp/releases/latest/download',
  'https://github.com/xpzouying/xiaohongshu-mcp/releases/latest/download'
)

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    !   $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "    X   $msg" -ForegroundColor Red; exit 1 }

# 关键：UTF-8 无 BOM。绝不能用 Set-Content -Encoding utf8（5.1 下会写 BOM）
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}
function Test-HasBom([string]$Path) {
  $b = [System.IO.File]::ReadAllBytes($Path)
  return ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
}

# ---------- 1. 环境 ----------
Step 1 '检查 DSH 安装'

if (-not (Test-Path $DshHome)) { Die "没找到 $DshHome，这台机器看起来没装 DSH 桌面端。" }
$profilesRoot = Join-Path $DshHome 'profiles'
if (-not (Test-Path $profilesRoot)) { Die "没找到 profiles 目录：$profilesRoot" }

$all = Get-ChildItem $profilesRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'cordis.patch.yml') }
if (-not $all) { Die "没有任何 profile。先启动一次 DSH，让它生成 profile。" }

$profile = $all | Where-Object Name -eq 'desktop' | Select-Object -First 1
if (-not $profile) { $profile = $all | Where-Object Name -eq 'web' | Select-Object -First 1 }
if (-not $profile) { $profile = $all | Select-Object -First 1 }

$patchFile = Join-Path $profile.FullName 'cordis.patch.yml'
$profPkg   = Join-Path $profile.FullName 'package.json'
$profNodeModules = Join-Path $profile.FullName 'node_modules'
$link      = Join-Path $profNodeModules $PkgName

Ok "profile = $($profile.Name)"
Ok "patch   = $patchFile"

# 先体检：现有 manifest 带 BOM 的话先修，否则一会儿重启照样崩
foreach ($f in $patchFile, $profPkg) {
  if ((Test-Path $f) -and (Test-HasBom $f)) {
    if ($Preview) { Warn "Preview：$f 带 BOM，将清除" }
    else {
      Copy-Item $f "$f.bak-bom-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
      $t = [System.IO.File]::ReadAllText($f).TrimStart([char]0xFEFF)
      Write-Utf8NoBom $f $t
      Ok "已清除 BOM：$(Split-Path $f -Leaf)"
    }
  }
}

# ---------- 2. 插件文件 ----------
Step 2 '复制插件代码'

$srcDir = Join-Path $PSScriptRoot '..\bundle\src'
$pkgJson = Join-Path $PSScriptRoot '..\bundle\package.json'
if (-not (Test-Path $srcDir)) { Die "安装包不完整：找不到 $srcDir" }
if (-not (Test-Path $pkgJson)) { Die "安装包不完整：找不到 bundle\package.json" }
foreach ($f in 'index.js','panel.js','panel.html','client.js','run.js','scripts.js','sidecar.js','scripts.default.json') {
  if (-not (Test-Path (Join-Path $srcDir $f))) { Die "安装包缺文件：bundle\src\$f" }
}

if ($Preview) {
  Warn "Preview：将把 $srcDir 复制到 $PluginDir\src"
} else {
  New-Item -ItemType Directory -Force -Path (Join-Path $PluginDir 'src') | Out-Null
  Copy-Item (Join-Path $srcDir '*') (Join-Path $PluginDir 'src') -Recurse -Force
  Copy-Item $pkgJson (Join-Path $PluginDir 'package.json') -Force
  foreach ($legacy in 'index.js','panel.js','panel.html','xlsx.js','mapping.js','client.js') {
    $old = Join-Path $PluginDir $legacy
    if (Test-Path $old) { Remove-Item $old -Force }
  }
  Ok "已复制到 $PluginDir"
}

# ---------- 3. 二进制 ----------
Step 3 '准备 xiaohongshu-mcp 二进制'

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$need = @()
if (-not (Test-Path $McpExe))   { $need += @{ name = 'xiaohongshu-mcp.exe';   asset = 'xiaohongshu-mcp-windows-amd64.exe' } }
if (-not (Test-Path $LoginExe)) { $need += @{ name = 'xiaohongshu-login.exe'; asset = 'xiaohongshu-login-windows-amd64.exe' } }

if (-not $need.Count) {
  Ok "已存在：xiaohongshu-mcp.exe / xiaohongshu-login.exe"
} elseif ($SkipDownload) {
  Warn "缺文件但指定了 -SkipDownload：$(($need | ForEach-Object { $_.name }) -join ', ')"
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

# ---------- 4. 包形态装配 ----------
Step 4 '装配插件包（客户端半侧需要包形态）'

if ($Preview) {
  Warn "Preview：将创建软链 $link，并在 profile/package.json 登记依赖"
} else {
  New-Item -ItemType Directory -Force -Path $profNodeModules | Out-Null
  if (Test-Path $link) { (Get-Item $link).Delete() }
  New-Item -ItemType Junction -Path $link -Target $PluginDir | Out-Null

  if (Test-Path $profPkg) {
    $backupPkg = "$profPkg.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $profPkg $backupPkg -Force
    try {
      $pj = Get-Content $profPkg -Raw | ConvertFrom-Json
      if (-not $pj.PSObject.Properties['dependencies']) {
        $pj | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
      }
      $spec = 'file:' + ($PluginDir -replace '\\', '/')
      $pj.dependencies | Add-Member -NotePropertyName $PkgName -NotePropertyValue $spec -Force
      $text = ($pj | ConvertTo-Json -Depth 12)
      Write-Utf8NoBom $profPkg $text
      # 写完立刻再解析一次，坏就回滚
      $null = Get-Content $profPkg -Raw | ConvertFrom-Json
      if (Test-HasBom $profPkg) { throw '写入后仍带 BOM' }
      Ok '已登记依赖（JSON 校验通过）'
    } catch {
      Copy-Item $backupPkg $profPkg -Force
      Die "写 profile/package.json 失败，已回滚：$($_.Exception.Message)"
    }
  }
}

# ---------- 5. 补丁行 ----------
Step 5 '在 profile 里登记插件行'

$blockRaw = @"
- insert:
    - id: xhs-comment-agent
      name: '$PkgName'
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

$existing = ''
if (Test-Path $patchFile) {
  $existing = [System.IO.File]::ReadAllText($patchFile).TrimStart([char]0xFEFF)
}

# 幂等：摘掉旧的同 id 块，再追加新块
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
  Warn '发现已有的 xhs-comment-agent 行，将覆盖'
}

$merged = ($existing.TrimEnd() + "`n`n" + $block).TrimEnd() + "`n"

if ($Preview) {
  Warn 'Preview：将写入以下片段'
  Write-Host $block -ForegroundColor DarkGray
} else {
  $backup = "$patchFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  if (Test-Path $patchFile) { Copy-Item $patchFile $backup -Force }
  try {
    Write-Utf8NoBom $patchFile $merged
    if (Test-HasBom $patchFile) { throw '写入后仍带 BOM' }
    if ((Get-Content $patchFile -Raw) -notmatch 'xhs-comment-agent') { throw '写入后找不到插件行' }
    Ok '已写入补丁（无 BOM，已校验）'
  } catch {
    if (Test-Path $backup) { Copy-Item $backup $patchFile -Force }
    Die "写 cordis.patch.yml 失败，已回滚：$($_.Exception.Message)"
  }
}

# ---------- 6. 状态目录 ----------
Step 6 '准备状态目录'
if ($Preview) { Warn "Preview：将创建 $StateDir" }
else {
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  Ok $StateDir
}

# ---------- 7. Defender ----------
Step 7 'Defender 排除（可选）'
if ($SkipDefender) {
  Warn '已跳过（-SkipDefender）'
} else {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Warn '当前不是管理员，跳过；若登录闪退见部署文档「Defender 拦截」'
  } elseif ($Preview) {
    Warn "Preview：将排除 $RuntimeDir 与 %LOCALAPPDATA%\xiaohongshu-mcp"
  } else {
    try {
      Add-MpPreference -ExclusionPath @($RuntimeDir, (Join-Path $env:LOCALAPPDATA 'xiaohongshu-mcp')) -ErrorAction Stop
      Ok '已加入排除目录（仅这两处）'
    } catch {
      Warn "加排除失败：$($_.Exception.Message)"
    }
  }
}

# ---------- 8. 收尾 ----------
Step 8 '完成'

Say ''
Say '接下来人工做三步：' 'White'
Say '  1) 首次扫码登录（只需一次）：' 'White'
Say "     cd `"$StateDir`"; & `"$LoginExe`"" 'Gray'
Say '  2) 完全退出 DSH 桌面端再打开（托盘右键退出）' 'White'
Say '  3) 右侧栏会出现「小红书评论」标签；网页兜底 http://127.0.0.1:18765/' 'White'
Say ''
Say '万一 DSH 起不来：用同目录下的 cordis.patch.yml.bak-* 覆盖回去即可。' 'DarkGray'

if ($RunLogin -and -not $Preview) {
  Say ''
  Say '正在打开登录窗口，请用手机小红书扫码…' 'Yellow'
  Start-Process -FilePath $LoginExe -WorkingDirectory $StateDir -Wait
  Say '登录流程已结束，检查 cookies.json 是否有内容。' 'Yellow'
}
