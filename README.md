# 朝这儿练 · 全真模拟自动答题

针对 <https://www.zacy.top> 的全真模拟考试，一次运行完成：
**选择答题方式 → 登录 → 选当天「全真模拟」→ 取题作答 → 满 40 分钟交卷 → 等待 AI 批阅 → 学回标准答案 → 截图成绩。**

答题方式二选一：

- **本地逻辑**：题库 + 规则推理，不联网、不需要 Key；
- **大模型辅助**：题目交给 LLM 作答。首次启用会引导填写接口地址、模型、API Key 并保存，之后每次启动问一句是否沿用。

> 仅适用于 **Windows 10/11**。首次运行会从国内镜像自动补齐 Node.js 与无头浏览器，开箱即用。
> 仅供个人学习与自动化测试使用，请勿用于任何违规用途。

## 快速开始

1. 双击 `启动答题.bat`
2. 首次运行会自动检查环境，缺什么装什么（见下）
3. 用数字选择答题方式
4. 按提示输入考号、密码（密码不回显）

```
==== 朝这儿练 · 全真模拟自动答题 ====

请选择答题方式：
  1) 本地逻辑：题库 + 规则推理（不联网、不需要 Key）
  2) 大模型辅助：题目交给 LLM 作答
  3) 配置 / 修改大模型参数
  0) 退出
  输入序号 [1]：
==== 答题方式：本地逻辑 ====
考号：
```

## 大模型配置

第一次选 `2` 时：

```
请填写大模型接口配置（直接回车使用默认值）：
  接口地址 [https://api.deepseek.com]：
  模型名称 [deepseek-chat]：
  API Key：
  已保存到 D:\work-space\1\llm-config.json
  正在验证连通性…
  连接正常 √
```

再次启动选 `2` 时，会先验证连通性，正常就直接用；失败则当场引导重填：

```
  已加载配置：https://api.deepseek.com / deepseek-chat / sk-****1234
  正在验证连通性…
  连接失败：HTTP 401（Key 无效或无权访问）
  是否重新填写配置？[Y/n]：
请填写大模型接口配置（直接回车使用默认值）：
  接口地址 [https://api.deepseek.com]：
  …
  正在验证连通性…
  连接正常 √
```

- 选 `n` 表示放弃大模型，本次自动改用本地逻辑，不影响答题。
- 配置保存在项目目录的 `llm-config.json`，**Key 是明文**，已加入 `.gitignore`。
- 随时可以在菜单里选 `3` 修改配置（保存后同样会验证一次）。
- 临时覆盖（不改文件）：环境变量 `ZACY_LLM_KEY` / `ZACY_LLM_BASE` / `ZACY_LLM_MODEL`，或参数 `--llm-key` / `--llm-base` / `--llm-model`。
- 非交互运行（定时任务）验证失败时会直接报错退出，不会卡在输入上。

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
| 网络 | 能访问 `www.zacy.top:443` | 直连即可，证书正常；脚本不走系统代理，需要代理请用 TUN/全局模式 |
| 磁盘 | 约 200 MB（含自动装的运行时） | 纯脚本约 10 MB |
| 权限 | 用户目录可写、`%TEMP%` 可写 | 不需要管理员 |
| 本地端口 | `127.0.0.1:9300-9599` | 无头浏览器调试端口，仅本机回环 |
| 第三方依赖 | **无** | 不用 `npm install`；LLM 走内置 `fetch` |

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
| `--mode local\|llm` | 跳过菜单直接指定答题方式 |
| `--llm` / `--no-llm` | 同上，分别是 `--mode llm` / `--mode local` |
| `--llm-key <key>` | 临时覆盖 Key |
| `--llm-base <url>` | 临时覆盖接口地址 |
| `--llm-model <name>` | 临时覆盖模型名 |
| `--probe <题干>` | 只做本地推理自测，不登录、不消耗考试次数 |
| `--probe-type <type>` | 自测题型，默认 `single_choice` |
| `--probe-options "A.…\|B.…"` | 自测选项，用 `\|` 分隔 |

```bat
启动答题.bat --user 你的考号 --pass "你的密码" --min-minutes 40
启动答题.bat --dry-run
启动答题.bat --mode llm --user 你的考号 --pass "你的密码"
启动答题.bat --probe "生产经营单位的主要负责人对本单位的安全生产工作（）" --probe-options "A.全面负责|B.部分负责|C.间接负责|D.不负责"
```

非交互运行（没有控制台）时不会弹菜单：没指定 `--llm` 就走本地逻辑，避免定时任务卡住。

## 两种答题方式

**本地逻辑**（默认）：

1. 题库 `answer-bank.json` 命中 → 直接用批阅学回的标准答案；
2. 没命中 → 规则推理：按题型给选项打分（法定表述、绝对化措辞、与题干关键词重合、选项完整度），判断题识别「免除/减轻…责任」「不必/无需/先上岗」等典型错误表述；
3. 仍无把握 → 固定兜底（单选/判断 A，多选 A,B,C，主观题结构化模板）。

**大模型辅助**：

1. 进入前先验证连通性（发一次最小请求），失败就引导重填；重填后仍失败可继续重试，或选 `n` 放弃、本次改用本地逻辑；
2. 题库命中仍然优先，不浪费额度；
3. 其余题目把题干、选项交给 LLM，要求返回 JSON（`{"answer":"A"}`），答案会按题型校验；
4. 作答过程中模型连续失败 3 次、或遇到 401/403，自动停止调用，剩余题目转规则推理，不会卡住整场考试。

除 LLM 接口外，脚本不访问任何第三方站点（已去掉网页搜索答案的逻辑）。

## 它是怎么做的

1. **选方式**：启动时选择本地逻辑 / 大模型；首次选大模型时引导配置并写 `llm-config.json`，之后每次启用都先验证连通性，失败则重填。
2. **登录**：`POST /api/login`；服务端要求图形验证码时，自动存图并打开，提示输入。
3. **选考试**：`GET /api/user/daily-exams`，筛标题含「全真模拟」且 `can_enter` 的场次；多场优先当天，仍多则让你选。
4. **取题**：`GET /api/user/daily-exams/{id}/questions`，同时创建/恢复作答记录。
5. **作答**：题库优先，其次 LLM（开启时）或规则推理。
6. **计时**：每 15 秒 `heartbeat`（服务端每次计 15 秒），每 5 分钟 `save-progress`；「累计 ≥ 40 分钟」且「实际 ≥ 40 分钟」才交卷，接近 150 分钟时限自动提前交。
7. **交卷**：`POST .../submit`。
8. **学习**：轮询 `GET /api/user/exam-records/{id}`，把标准答案写回题库，下次同题直接答对。
9. **截图**：无头浏览器注入 token 打开「考试记录」，点开成绩弹窗截图到 `shots/`。

## 文件说明

| 文件 | 作用 | 是否提交 |
|---|---|---|
| `启动答题.bat` | 入口：调用引导脚本 | ✔ |
| `bootstrap.ps1` | 环境检查 / 自动下载安装 / 启动答题 | ✔ |
| `mock-exam.js` | 答题主逻辑（单文件，无第三方依赖） | ✔ |
| `answer-bank.json` | 题库：题目 id → 标准答案，随批阅自动增长 | ✔（初始为空） |
| `llm-config.json` | 大模型接口配置（含明文 Key） | ✘ 忽略（首次配置时生成） |
| `shots/` | 成绩截图输出目录 | ✘ 忽略（运行时生成） |

## 注意事项

- 账号密码只用于本次登录，不写入磁盘；`llm-config.json` 里的 Key 是明文，别提交、别外传。
- 每天的全真模拟通常只有一次机会，已有作答记录会提示「不可进入」。
- 「满 40 分钟」按站点心跳累计规则实现；若站点调整心跳计分方式，需同步修改 `mock-exam.js` 的 `heartbeat` 逻辑。
- 自动下载的是便携版运行时，只影响本脚本；若公司网络禁用了 npmmirror，可手动安装 Node 22+ 与 Chrome 后直接 `node mock-exam.js`。
- 大模型只把题干和选项发出去，不发考号、密码或 token；但请自行确认所用服务商的数据政策。
- 仅供个人练习与自动化测试使用。
