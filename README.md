# 小红书评论 Agent（DeepSeek Harness 插件）

按关键词找笔记 → 抓一级/二级评论 → 按规则筛选 → 生成回复草稿 → **人工点一下才发**。

UI 就在 DSH 里：**右侧栏「小红书评论」标签页**（待审草稿 / 规则 / 导入清单），
另有一个本地面板 `http://127.0.0.1:18765/` 作为兜底与 API。

> 不是爬虫框架，也不是群控工具：默认干跑、有配额、有去重、有熔断，发送必须经过人。

---

## 它解决什么

运营要在自己领域的小红书笔记下**真实地参与讨论**，但手工做有三件事很痛：

1. 找帖：关键词一搜几十篇，逐篇点开看评论，费时间；
2. 判断：几百条评论里只有少数值得回，肉眼筛容易漏也容易回错；
3. 分寸：回快了、回多了、话术重复，账号容易被限流。

这个插件把 1、2 自动化，把 3 做成硬约束（配额/去重/间隔/熔断），把「发不发」留给人。

---

## 快速开始

### 方式一：下载部署包（推荐）

1. 到 [Releases](../../releases) 下载 `xhs-comment-agent-v*.zip`
2. 解压，在**管理员 PowerShell** 里：

```powershell
cd <解压目录>\xhs-comment-agent
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\install.ps1
```

3. 首次扫码登录（只一次，必须在该目录下运行）：

```powershell
cd "$env:USERPROFILE\.dsh\xhs-agent"
& "$env:USERPROFILE\.dsh\runtimes\xiaohongshu-login.exe"
```

4. 托盘退出 DSH 再打开
5. 右侧栏出现「小红书评论」标签

完整步骤与排错见 [deploy/部署说明.md](deploy/部署说明.md)。

### 方式二：从源码装

```powershell
git clone <this-repo>; cd <repo>
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\install.ps1 -SkipDownload
```

安装器是**幂等**的：重复执行只覆盖同一行配置，写前备份、写后校验、
失败自动回滚；所有文本文件都以 **UTF-8 无 BOM** 写入（BOM 会让 DSH 宿主启动崩溃，
见 [docs/INCIDENT-2026-11-03-bom-crash.md](docs/INCIDENT-2026-11-03-bom-crash.md)）。

### 方式三：改完代码，同步到本地插件

在仓库里改完 `bundle/src` 后，不用重跑安装器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\sync.ps1          # 同步
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\sync.ps1 -DryRun  # 只看会改什么
```

它只复制 `bundle/src\*` 与 `bundle/package.json`，顺手删掉插件目录里仓库已不存在的残留文件，
再做哈希比对与 BOM 校验；**不碰** `rules.json` / `drafts.jsonl` / `cookies.json`。
同步完需要重启一次 DSH（托盘右键 → 退出 → 打开）才会加载新代码。

---

## 装了之后有什么

### DSH 对话里的 6 个工具

| 工具 | 作用 |
|---|---|
| `xhs_status` | 服务/登录/配额/熔断状态 |
| `xhs_login` | 取登录二维码（PNG），扫码后自动确认 |
| `xhs_search` | 关键词搜索 + 笔记预筛（点赞/标题词） |
| `xhs_comments` | 抓评论，自动展开「展开 N 条回复」，返回一/二级候选 |
| `xhs_plan` | 把候选 + 文案写成草稿（不发送） |
| `xhs_reply` | 回复指定评论；干跑只回显，真发需 `confirm` |

### 右侧栏面板

- 状态条：服务在线、登录账号、今日/本小时配额、是否熔断
- **主控**：开始（持续跑）/ 跑一轮 / 暂停 / 继续 / 终止，实时显示当前在做什么、轮次进度与 token 消耗
- **待审草稿**：评论原文 + 可改的回复 + 「发送这条」/「跳过」
- **规则**：必含词、黑名单、字数、单篇/小时/天上限、最小间隔、每轮间隔（保存即生效）

---

## 安全与合规

**默认是安全的：**

- 干跑（`dry_run: true`）时任何发送请求都会被拒绝；
- **发送强门禁**：非干跑时还需要一张「人工批准票据」——只有面板/右侧栏的「发送这条」能签发，
  一次性、5 分钟有效、绑定文案哈希。`xhs_reply` 工具没有票据会被拒绝（`need_human_approval`），
  **agent 无法自行发送**；
- 禁用词（`banned_words`）在发送前强制校验，命中即拒绝并指出是哪个词；
- 以 `comment_id` 为键去重，同一条评论永不重复回复；
- 小时/天双配额 + 最小间隔 45s（可调）；
- 检测到验证码/频繁/未登录，立即**全局熔断**停止发送；
- 面板只监听 `127.0.0.1`，不对外提供服务；`cookies.json` 只存在本机，不上传任何地方。

**风险提示：**

- 自动化互动违反平台用户协议的边界，批量评论是平台重点治理对象；账号受限的风险由使用者承担。
- 别关配额、别发模板文案、别在回复里导流或报价。
- 本仓库不包含任何账号凭据；issue 里也不要贴 cookie 或二维码截图。

---

## 目录结构

```
bundle/src/            插件源码（零运行时依赖）
  index.js             宿主半侧：工具注册、sidecar 托管、配额/去重/熔断
  client.js            客户端半侧：右侧栏标签页（手写 ESM，无打包）
  panel.js/.html       本地面板（兜底 UI + HTTP API）
  run.js               执行器：一轮/持续两种模式，暂停/继续/终止，token 统计
deploy/                安装器 / 卸载器 / 急救脚本 / 部署说明
docs/                  事故记录
```

## 依赖

- Windows 10/11 x64，DeepSeek Harness 桌面端（至少启动过一次）
- [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) 预编译二进制（安装器自动下载，Apache-2.0）
- 不需要 Node / Python / Docker —— 插件跑在 DSH 宿主进程里

## License

见 [LICENSE](LICENSE)。本仓库不分发 xiaohongshu-mcp 源码，仅按其许可证在安装时下载官方二进制。
### 「跑一轮」与「开始」

规则页顶部填 `搜索关键词`（标签式，最多生效前 3 个），然后在「主控」页：

- **跑一轮**：搜索 → 逐篇抓评论 → 规则筛 → 调模型生成回复 → 进「回复清单」，跑完即停；
- **开始**：同样的流程，但一轮结束后按「每轮间隔」自动开下一轮，**一直跑**，直到点「终止」；
- **暂停 / 继续**：暂停会把当前这一轮挂起（不再发起新的搜索/抓取/生成），继续后从断点接着跑；
- **终止**：立即结束整个任务，已生成的草稿保留。

主控页还会实时显示：当前在做什么（搜索哪个词 / 抓哪篇 / 给谁生成）、第几轮、笔记与草稿计数、
**本轮与累计 token**（来自模型返回的真实 usage，不是估算）。

人工复核（默认开）下生成后停住等人点「发送这条」；关掉则边生成边发（仍受配额/去重/间隔约束）。
