# 事故记录：安装器写入 BOM 导致 DSH 宿主启动崩溃

- **时间**：2026-11-03 02:13（本地）
- **影响**：DSH 桌面端无法启动（host 启动阶段直接退出）
- **级别**：P0（阻断启动），已修复
- **发现人**：用户（自行用去 BOM 脚本恢复）

## 现象

```
DesktopHostFatalError: Unexpected token '\uFEFF', "﻿{
    "n"... is not valid JSON
    at ChildProcess.<anonymous> (.../lib/main.js:3831:49)

SyntaxError: Unexpected token '\uFEFF', ...
    at JSON.parse (<anonymous>)
    at readProfileManifest (.../dsh-app-boot/lib/index.js:913)
    at loadProfileDirectory (.../dsh-app-boot/lib/index.js:1016)
```

崩溃日志：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-11-02T18-13-11-404Z-host.log`

## 根因

安装器用 PowerShell 5.1 的 `Set-Content -Encoding utf8` 写 `profiles/<name>/package.json`。
**5.1 的 utf8 是「带 BOM 的 UTF-8」**，而 DSH 用 `JSON.parse` 读 profile manifest，
`\uFEFF` 不是合法 JSON 开头，直接抛错；宿主在启动阶段 fatal，整窗打不开。

同一处还用同样方式写过 `cordis.patch.yml`（YAML 通常容忍 BOM，但同样不该带）。

## 修复

1. 安装器新增 `Write-Utf8NoBom()`：一律 `[IO.File]::WriteAllText(path, text, UTF8Encoding($false))`；
2. 写 `package.json` 后**立即用 `ConvertFrom-Json` 再解析一次**，失败则从 `.bak-*` 回滚并中止；
3. 写 `cordis.patch.yml` 后校验：无 BOM + 含插件行，否则回滚；
4. 安装器启动时先体检：发现已有 BOM 的历史文件，先备份再清除；
5. `uninstall.ps1` 同样改为无 BOM 写入；
6. 安装器自身 `.ps1` 保留 BOM（PowerShell 5.1 读中文脚本需要），这与"它写的产物不能带 BOM"不冲突。

## 验证

```
package.json       BOM=False  解析 OK（deps 含 dsh-xhs-comment-agent）
cordis.patch.yml   BOM=False  js-yaml 解析 5 个条目，含插件行
junction           node_modules\dsh-xhs-comment-agent -> 插件目录，可解析
```

## 教训 / 后续约束

- **凡是 DSH 会 JSON.parse 的文件（profile/package.json、compatibility.json 等）一律禁止 BOM**；
- PowerShell 5.1 下禁止用 `Set-Content -Encoding utf8` / `Out-File -Encoding utf8` 写机器可读文件；
- 安装器类脚本必须"写完即校验 + 失败回滚"，不能假设写成功；
- 现场恢复只需把 `cordis.patch.yml` 的 `xhs-comment-agent` 行摘掉（`deploy/uninstall.ps1`），
  插件只是可选增强，不应有能力阻断 DSH 启动。
