# 朝这儿练 · 全真模拟自动答题

针对 <https://www.zacy.top> 的全真模拟考试，一次运行完成：
**环境自检 → 登录 → 选当天「全真模拟」→ 取题作答 → 满 40 分钟交卷 → 等待 AI 批阅 → 学回标准答案 → 截图成绩。**

> 仅适用于 **Windows 10/11**。首次运行会从国内镜像自动补齐 Node.js 与无头浏览器，开箱即用。
> 仅供个人学习与自动化测试使用，请勿用于任何违规用途。

## 快速开始

1. 双击 `启动答题.bat`
2. 首次运行会自动检查环境，缺什么装什么（见下）
3. 按提示输入考号、密码（密码不回显）

```
==== 朝这儿练 · 环境检查 ====
   安装目录：C:\Users\<你>\AppData\Local\zacy-mock-exam
   √ Node.js v24.22.1  ...\zacy-mock-exam\node\node.exe
   √ 浏览器 ...\zacy-mock-exam\chrome\chrome-headless-shell.exe
   √ www.zacy.top:443 可访问
```

之后进入答题，结束时输出成绩并生成截图。

## 首次运行：自动检查与安装

引导脚本 `bootstrap.ps1`（Windows 自带 PowerShell 5.1 即可运行，无需管理员权限）：

| 检查项 | 缺失时的处理 | 来源（国内镜像优先） |
|---|---|---|
| Node.js 22+ | 自动下载约 36MB 便携版 zip，解压到 `%LOCALAPPDATA%\zacy-mock-exam\node`，不改系统 PATH、不写注册表 | `cdn.npmmirror.com` → `npmmirror.com` → 华为云镜像 → `nodejs.org` |
| Chrome / Edge | 优先用本机已有的浏览器；都没有才下载 Chrome Headless Shell（约 100–125MB），解压到 `...\chrome` | `registry.npmmirror.com` 版本列表 + `cdn.npmmirror.com` 二进制 |
| 站点连通性 | 只提示，不阻塞（可能是临时网络问题） | TCP 443 探测 `www.zacy.top` |

细节：

- 下载用 `curl.exe`（Win10 1803+ 自带）优先，失败自动回退 `Invoke-WebRequest`；每个源失败自动换下一个。
- Node 版本从镜像的 `index.json` 动态选最新 22/24 LTS，取不到就回退到固定版本 `v22.20.0`。
- 已有可用 Node（≥22）和浏览器时，检查只花不到 1 秒，不会重复下载。
- 安装全部在用户目录，删除 `%LOCALAPPDATA%\zacy-mock-exam` 即可完全卸载。

引导脚本参数（一般用不到）：

```bat
powershell -ExecutionPolicy Bypass -File bootstrap.ps1 -CheckOnly     :: 只体检不启动
powershell -ExecutionPolicy Bypass -File bootstrap.ps1 -NoBrowser     :: 不下载浏览器
powershell -ExecutionPolicy Bypass -File bootstrap.ps1 -ForceNode     :: 忽略系统 Node，强制装本地
powershell -ExecutionPolicy Bypass -File bootstrap.ps1 -ForceBrowser  :: 忽略本机浏览器，强制装无头版
powershell -ExecutionPolicy Bypass -File bootstrap.ps1 -Root D:\zacy   :: 指定安装目录
```

## 运行环境

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11 | `.bat` + PowerShell 5.1；脚本核心也可在 macOS/Linux 跑 |
| Node.js | 22+（缺了会自动装） | 截图依赖内置 `WebSocket`；18/20 加 `--no-shot` 只能答题 |
| 浏览器 | Chrome / Edge（缺了会自动装） | 仅截图需要；实在没有就跳过截图 |
| 网络 | 能访问 `www.zacy.top:443` 和 npmmirror | 直连即可，证书正常；脚本不走系统代理，需要代理请用 TUN/全局模式 |
| 磁盘 | 约 200 MB（含自动装的运行时） | 纯脚本约 10 MB |
| 权限 | 用户目录可写、`%TEMP%` 可写 | 不需要管理员 |
| 本地端口 | `127.0.0.1:9300-9599` | 无头浏览器调试端口，仅本机回环 |
| 第三方依赖 | **无** | 不用 `npm install` |

## 答题参数

`启动答题.bat` 会把参数原样传给 `mock-exam.js`：

| 参数 | 说明 |
|---|---|
| `--user <考号>` / `--pass <密码>` | 非交互运行，适合定时任务 |
| `--min-minutes 40` | 最短答题时长（分钟），默认 40 |
| `--exam <id>` | 指定考试 id，默认按标题自动匹配 |
| `--match 全真模拟` | 标题匹配关键字 |
| `--out shots` | 截图输出目录 |
| `--no-shot` | 不截图 |
| `--dry-run` | 只登录并列出可用考试，不开始答题 |

```bat
启动答题.bat --user 你的考号 --pass "你的密码" --min-minutes 40
启动答题.bat --dry-run
```

## 它是怎么做的

1. **登录**：`POST /api/login`；服务端要求图形验证码时，自动存图并打开，提示输入。
2. **选考试**：`GET /api/user/daily-exams`，筛标题含「全真模拟」且 `can_enter` 的场次；多场优先当天，仍多则让你选。
3. **取题**：`GET /api/user/daily-exams/{id}/questions`，同时创建/恢复作答记录。
4. **作答**：题库 `answer-bank.json` 命中直接用标准答案；未命中按题型规则（单选/判断 A，多选/不定项 A,B,C，主观题结构化模板）。
5. **计时**：每 15 秒 `heartbeat`（服务端每次计 15 秒），每 5 分钟 `save-progress`；「累计 ≥ 40 分钟」且「实际 ≥ 40 分钟」才交卷，接近 150 分钟时限自动提前交。
6. **交卷**：`POST .../submit`。
7. **学习**：轮询 `GET /api/user/exam-records/{id}`，把标准答案写回题库，下次同题直接答对。
8. **截图**：无头浏览器注入 token 打开「考试记录」，点开成绩弹窗截图到 `shots/`。

## 文件说明

| 文件 | 作用 | 是否提交 |
|---|---|---|
| `启动答题.bat` | 入口：调用引导脚本 | ✔ |
| `bootstrap.ps1` | 环境检查 / 自动下载安装 / 启动答题 | ✔ |
| `mock-exam.js` | 答题主逻辑（单文件，无第三方依赖） | ✔ |
| `answer-bank.json` | 题库：题目 id → 标准答案，随批阅自动增长 | ✔（初始为空） |
| `shots/` | 成绩截图输出目录 | ✘ 忽略（运行时生成） |

## 注意事项

- 账号密码只用于本次登录，不写入磁盘。
- 每天的全真模拟通常只有一次机会，已有作答记录会提示「不可进入」。
- 「满 40 分钟」按站点心跳累计规则实现；若站点调整心跳计分方式，需同步修改 `mock-exam.js` 的 `heartbeat` 逻辑。
- 自动下载的是便携版运行时，只影响本脚本；若公司网络禁用了 npmmirror，可手动安装 Node 22+ 与 Chrome 后直接 `node mock-exam.js`。
- 仅供个人练习与自动化测试使用。
