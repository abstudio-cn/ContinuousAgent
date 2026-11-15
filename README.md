# ContinuousAgent（TypeScript · 浏览器版）

常驻本机的通用智能体：以工具为核心完成工作——读写文件、执行命令、抓取网页、操作桌面与剪贴板，并维护一份持续更新的**工作记录**与一份长期**工作笔记**。本项目从 GameAgent Web 分支而来（`..\gameragent_web` 保持原样，两者互不依赖）。

技术栈是 **TypeScript**：服务端负责 agent 循环、LLM 流式调用、工具执行与文件沙箱，浏览器端提供完整 UI。桌面版的原生能力（窗口截图、键鼠注入、Windows OCR）通过一个 **PowerShell 原生桥** 保留，因此浏览器版依然可以真正操作 GUI 应用。

支持**多会话**：左侧会话列表可新建/切换/重命名/删除；每个会话拥有独立的对话时间线、`work_state.md`（工作记录）与 `work_notes.md`（工作笔记）（存放在 `<工作空间>/sessions/<会话ID>/`），互不干扰。

> 安全提示：服务默认只监听 `127.0.0.1`。它能在你的机器上移动鼠标、按键、读文件，**不要**直接暴露到公网。要远程访问请走 SSH 隧道 / Tailscale，并设置 `CONTINUOUS_AGENT_TOKEN`（兼容旧的 `GAMEAGENT_TOKEN`）。

---

## 快速开始

```powershell
cd C:\Users\abstudio\Documents\ContinuousAgent
npm install
npm start            # 构建产物需先 npm run build（或直接 .\start.ps1）
```

一键脚本（构建 + 启动 + 打开浏览器）：

```powershell
.\start.ps1              # 默认 7800 端口
.\start.ps1 -Port 8080 -NoBuild
```

然后：

1. 打开 <http://127.0.0.1:7800>
2. 右上「设置 → 接口与模型」填 OpenAI 兼容地址、Key、模型名
3. （需要操作 GUI 时）顶部「目标窗口」下拉选择目标进程（列出 PID / 进程 / 客户区尺寸）
4. 输入框写托管目标，Enter 或「开始托管」
5. 随时「中断运行」（页面内快捷键 `F12` / `Ctrl+Shift+X`；浏览器无法注册全局热键）

环境变量：`PORT`（默认 7800）、`HOST`（默认 127.0.0.1）、`CONTINUOUS_AGENT_DATA_DIR`（默认 `%APPDATA%\ContinuousAgent`，兼容 `GAMEAGENT_DATA_DIR`）、`CONTINUOUS_AGENT_TOKEN`（可选访问令牌）。

首次启动若发现旧版 `%APPDATA%\GameAgentWeb\settings.json`，会自动迁移一份设置（含 Key）到新目录，工作空间改用 `Documents\ContinuousAgentWorkspace`。

---

## 功能对照

| 桌面版 (C#/WPF) | 浏览器版 (TypeScript) |
| --- | --- |
| WPF 深色 UI / 三栏 | 单页 Web UI：时间线 + 记录/笔记侧栏 + 设置弹窗 |
| `AgentRunner` 主循环 | `src/server/agent.ts`（同语义：轮次、工具调用、记录强制更新、自动续跑、历史裁剪、指数退避） |
| `LlmClient` SSE 流式 | `src/server/llm.ts`（`reasoning_content`、tool_calls 增量、图片预算、阅后即焚、token 估算） |
| `ToolExecutor` + `ToolCatalog` | `src/server/tools.ts`（43 个同名工具、同一套中文描述） |
| `InputSimulator` / `ScreenCapture` / `WindowManager` / `OcrService` | `scripts/native-host.ps1` + `src/server/native.ts`（PowerShell 常驻进程，行协议 JSON） |
| Windows DPAPI 存 Key | 只存服务端 `settings.json`，浏览器只见「已保存/未设置」 |
| SAPI / 云端 TTS / sherpa-onnx | 浏览器 `speechSynthesis` + 云端 `/audio/speech` 代理 |
| 全局中断热键 | 页面按钮 + 页面内快捷键（浏览器限制） |
| 单文档 | **多会话**：每会话独立时间线 + 独立记录/笔记，可切换、重命名、删除 |

**未移植**：sherpa-onnx 离线神经网络语音（Kokoro / ZipVoice）、DPAPI、全局热键、WPF 专属主题细节。朗读改用系统语音或云端 TTS。

---

## 目录结构

```
web/
├── package.json / tsconfig.json / tsconfig.client.json
├── start.ps1                    # 一键构建 + 启动
├── public/
│   ├── index.html
│   └── styles.css               # 深色主题
├── src/
│   ├── shared/                  # 前后端共用类型与系统提示词
│   │   ├── types.ts
│   │   └── prompt.ts            # STATIC_SYSTEM_PROMPT / 记录与笔记模板
│   ├── server/
│   │   ├── index.ts             # HTTP + SSE + REST
│   │   ├── agent.ts             # 主循环 + 时间线
│   │   ├── llm.ts               # OpenAI 兼容流式客户端
│   │   ├── tools.ts             # 工具调度 + 工具清单
│   │   ├── record.ts            # 工作记录 / 工作笔记服务（按会话路径）
│   │   ├── history.ts           # 历史裁剪 + 工具调用配对修复（防 HTTP 400）
│   │   ├── settings.ts          # 设置读写与校验
│   │   ├── paths.ts             # 路径规范化 + 工作空间沙箱
│   │   ├── native.ts            # 原生桥客户端
│   │   └── imagestore.ts        # 截图短期存储（SSE 只发 URL）
│   └── client/
│       ├── main.ts              # 时间线渲染、设置面板、事件流
│       ├── markdown.ts          # 轻量 Markdown（先转义再渲染）
│       └── tts.ts               # 朗读队列
├── scripts/
│   ├── native-host.ps1          # Win32 截图/键鼠/OCR 常驻宿主
│   ├── selftest.mjs             # 端到端自检（需模型服务）
│   ├── session-test.mjs         # 会话隔离自检
│   ├── history-sequence-test.mjs # 历史工具调用配对自检（纯本地）
│   ├── history-400-repro.mjs    # 历史截断导致 HTTP 400 的复现/回归自检
│   └── tool-smoke.mjs           # 工具层冒烟（原生链路 + 文件沙箱）
└── tools/mock-model.mjs         # 本地 mock 模型（无 Key 时演示/测试）
```

---

## 工具清单

基础工具：`list_windows`、`select_window`（旧名 `select_game_window` 仍可用）、`get_window_info`、`screenshot`、`screenshot_background`（后台截图：只走 PrintWindow，不激活窗口、不改前后台与叠放顺序，多会话并行不抢焦点）、`mouse_move`、`mouse_click`、`mouse_drag`、`scroll`、`key_press`、`key_down`、`key_up`、`type_text`、`ocr`、`read_file`、`list_directory`、`find_files`、`write_file`、`delete_path`、`update_work_record`、`read_work_record`、`update_work_notes`、`append_work_notes`、`read_work_notes`、`get_environment`、`wait`（旧名 `update_game_record` 等仍兼容）。

- 坐标：目标窗口**客户区像素**，左上 (0,0)；截图只用于观察，可能等比缩放。
- 读：本机任意路径；写/删：仅工作空间；删除进 `<工作空间>/.trash`（7 天可恢复）。
- 截图默认转 JPEG(60) 且宽度上限 1280，只带最近 2 张图，读过即焚。

## 输入与热键

| 动作 | 方式 |
| --- | --- |
| 开始托管 | `Enter`（`Shift+Enter` 换行）或按钮 |
| 中断 | 按钮 / `F12` / `Ctrl+Shift+X` |
| 关闭设置 | `Esc` |

---

## 原生桥（Windows）

`scripts/native-host.ps1` 由服务端以 `powershell.exe -NoProfile` 常驻启动，通过 stdin/stdout 传递行 JSON：

```
{"id":1,"cmd":"list-windows","args":{}}
{"id":2,"cmd":"screenshot","args":{"hwnd":"123456","maxWidth":900,"format":"jpeg"}}
{"id":3,"cmd":"capture-bg","args":{"hwnd":"123456","maxWidth":900,"format":"jpeg"}}
{"id":3,"cmd":"mouse-click","args":{"x":100,"y":200,"button":"left","count":1,"holdMs":45}}
{"id":4,"cmd":"keys","args":{"action":"down","keys":"shift+w"}}
{"id":5,"cmd":"ocr","args":{"path":"C:\\...\\shot.png","language":"zh-Hans"}}
```

- 截图优先 `PrintWindow(PW_RENDERFULLCONTENT)` 并按客户区裁剪，失败回退屏幕 `BitBlt`。
- OCR 走 WinRT `Windows.Media.Ocr`（需系统已安装对应语言包）。
- 键鼠走 `SendInput` / `mouse_event`，文本走 Unicode 注入（支持中文/emoji）。
- 非 Windows 平台：`nativeAvailable=false`，界面顶部显示提示，文件/记录/笔记工具仍可用。
- 权限：与桌面版一样，**不能**操作以管理员权限运行的窗口（UIPI 限制）。

---

## 设置与数据

| 内容 | 位置 |
| --- | --- |
| 设置（含 Key，仅服务端） | `%APPDATA%\GameAgentWeb\settings.json` |
| 工作空间（默认） | `Documents\GameAgentWorkspace` |
| 工作记录 / 笔记 | `<工作空间>\sessions\<会话ID>\work_state.md` / `work_notes.md`（按会话隔离，笔记上限 100000 字符） |
| 会话列表与运行数据 | `%APPDATA%\GameAgentWeb\sessions\index.json`、`<会话ID>/timeline.json`、`history.json`、`runtime.json` |
| 截图临时文件 | `%TEMP%\gameagent-web`（原生宿主即时清理） |

浏览器拿到的设置永远是脱敏副本（`hasApiKey / hasCloudTtsApiKey`），Key 不回传。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state?session=<id>` | 该会话的设置（脱敏）、运行状态、目标窗口、记录、笔记、时间线 |
| GET | `/api/sessions` | 会话列表（含运行状态与字数） |
| POST | `/api/sessions` | 新建会话 `{title}` |
| POST | `/api/sessions/:id/rename` \| `/delete` | 重命名 / 删除（记录移入 .trash） |
| GET | `/api/events` | SSE：`state/item_add/item_update/clear/record/notes/target/native` |
| POST | `/api/settings` | 局部更新设置 |
| GET | `/api/windows` | 可见窗口列表 |
| POST | `/api/window/select` | `{pid}` 或 `{title}` |
| POST | `/api/window/clear` | 清除目标 |
| POST | `/api/agent/start` \| `stop` \| `reset` \| `clear-timeline` | 运行控制（需带 `sessionId`） |
| POST | `/api/test-connection` | 模型连通性 |
| POST | `/api/tts` | 云端 TTS 代理（Key 不出服务端） |
| GET | `/api/images/:id` | 工具截图 |

---

## 测试

```powershell
# 工具层：原生截图/OCR/键鼠 + 文件沙箱（无需模型）
node scripts/tool-smoke.mjs GameAgent

# 会话隔离：在 A 会话跑一轮，确认 B 会话记录不变
node scripts/session-test.mjs --url http://127.0.0.1:7789

# 端到端：需要先启动 mock 或真实模型
npm start
$env:MOCK_PORT=18766; $env:MOCK_MODE='native'; node tools/mock-model.mjs   # 另开窗口
# 设置里把 API 地址指向 http://127.0.0.1:18766/v1
node scripts/selftest.mjs --title GameAgent --prompt "原生链路自检"
```

`selftest.mjs` 会检查：原生桥可用、窗口选择、运行结束、无错误项、记录与笔记已更新、工具全部成功。

---

## 已知限制

- 独占全屏 / GPU 合成窗口可能截不到图，建议目标应用用无边框窗口。
- Windows OCR 依赖系统语言包，识别率与字号、缩放有关；截图上限 2400 宽。
- 浏览器不能注册全局热键，中断只在页面聚焦时有效。
- 同一时间只允许**一个会话**运行（否则两个会话会抢同一套键鼠），切换会话不会中断正在跑的会话。
- 截图/目标窗口是机器级状态，不随会话切换而重置。
- 页面刷新会重放服务端时间线；服务重启后对话历史（内存）丢失，但工作记录/笔记在磁盘上不受影响。
- 不做反检测：在线竞技游戏使用自动化可能违反服务条款（游戏场景仍可用，但请自行判断合规性）。

---

## ContinuousAgent 分支改动

### 界面

- 聊天栏**取消语音开关**：语音改到每条回复结尾的「🔊 朗读」按钮（再点变「⏹ 停止」），按需朗读，不再自动播报。
- 输入框新增**附件**：📎 按钮 / 拖拽进输入区 / 在输入框粘贴图片。图片作为图像发给模型，文本文件（md/txt/json/code…）拼进提示词；最多 8 个，单个 ≤ 6MB。
- 新增**思考强度**下拉（reasoning_effort：auto/minimal/low/medium/high），改动立即存到服务端设置。
- 新增 **Token 输入/输出** 显示：顶栏汇总 + 输入区实时计量 + 每条回复脚注的本轮用量。
- 品牌、页面标题、系统提示词、数据目录统一改为 **ContinuousAgent**。

### 工具（对齐 OpenClaw agent 能力）

在原有 25 个桌面/文件工具之上补齐 10 个通用工具（合计 35 个）：

| 工具 | 用途 |
| --- | --- |
| `exec_command` | 执行 PowerShell 命令（默认工作空间，超时可配） |
| `web_fetch` | 抓网页 / 接口，HTML 转纯文本 |
| `edit_file` | 精确片段替换（要求唯一匹配） |
| `apply_patch` | 一次提交多组替换 |
| `search_files` | 正则搜索文件内容（跳过 node_modules/.git/dist） |
| `clipboard_read` / `clipboard_write` | 读写 Windows 剪贴板 |
| `launch_app` | Start-Process 启动程序 / 打开文档 |
| `process_list` | 列出进程（可按名称或窗口标题过滤） |
| `view_image` | 读取本机图片并作为图像返回 |

设置 → **工具权限** 可分别关闭 `exec_command`（allowShell）与 `launch_app`（allowLaunch），并设置单条命令超时。

离线验证：`node scripts/tool-verify.mjs`（不启动 HTTP 服务，直接驱动 ToolExecutor）。

### 目录写权限（工作空间外）

默认只有工作空间可写。需要改外部目录时：

1. 模型调用 `request_write_access(path, reason)`，对话里出现一张「目录写权限申请」卡片；
2. 用户点「允许写入」一次 — 该目录（含子目录）加入**本会话**白名单并持久化到 `%APPDATA%\ContinuousAgent\sessions\<会话ID>\grants.json`；
3. 之后同一会话内对该目录的 `write_file / edit_file / apply_patch / delete_path` 直接放行，不再询问；点「拒绝」则本次写入失败且不会重复弹窗（模型会改为说明）。

设置 → 工具权限：

- `允许申请工作空间外目录`（`allowPathRequests`，默认开）— 关掉后模型只能读写工作空间；
- `永久放行的可写目录`（`extraWritePaths`）— 每行一个绝对路径，长期生效、无需逐次确认。

申请卡片 5 分钟未确认会自动失效；进程重启后残留的"待确认"卡片在页面上显示为已失效。

### 完成标记（让 agent 自己停止）

持续托管模式默认会一直续跑（直到 `maxTurns`，默认 500）。现在模型可以在真正完工时主动收尾：

- 系统提示词要求：确认全部要求已完成并验证过 → 先 `update_work_record` 写最终状态 → 在回复**最后单独一行**输出 `[[DONE]]`。
- 服务端只在「本轮没有任何工具调用」时才认这个标记，并从正文里剥掉，状态变为 **已完成**，自动续跑立即停止，页面弹出「✅ 模型确认任务完成」。
- 防误判：标记必须在消息最末尾且不在未闭合的代码块里；出现在中间、后面还有内容、或在代码块示例中都不算。
- 单轮模式（`continuousMode=false`）本来就会在完成一轮后停止，标记同样会显示为“已完成”。

### 重复工具调用熔断（模型原地打转就刹车）

模型偶尔会「原地打转」：同一个工具、完全相同的参数反复调用，既不产生新信息也不推进任务。服务端会主动刹车：

- **判定口径**：`工具名 + 规范化参数` 构成调用指纹。参数先 `JSON.parse` 再按键名递归排序后重新序列化，所以 `{"a":1,"b":2}` 与 `'{ "b": 2, "a": 1 }'` 视为同一次调用；不是合法 JSON 的参数退回「压缩空白后的原文」。
- **滑动窗口**：只看**最近 30 次**工具调用；同一指纹在窗口内已出现 **10 次**，第 11 次立即熔断。用滑窗而不是整轮累计，是为了不误伤持续托管的长会话（`list_windows` 这类无参工具本来就会被反复正常使用）。
- **熔断后**：该次调用不执行，剩余调用按既有规则补「工具调用已中断，未执行」占位结果（历史仍是 tool_calls 与结果一一对应的合法序列，不会引发 HTTP 400），时间线插入一条系统提示说明是哪个工具、已出现几次，状态变为 **重复调用，已中断**，自动续跑停止。
- 系统提示词同步写入该规则，引导模型「同一操作重复两三次没有新信息，就换参数、换工具或换思路」。
- 实现：`src/server/repeat-guard.ts`（`RepeatGuard` / `toolCallKey` / `normalizeToolArgs`，常量 `REPEAT_LIMIT = 10`、`REPEAT_WINDOW = 30`）；`src/server/agent.ts` 主循环在 `tools.execute()` **之前**判定，判定点与占位补齐的顺序不可调换。
- 回归：`npm run build && node scripts/repeat-guard-test.mjs`（68 项：单元 / 产物接线 / 真实循环 e2e —— 10 次不中断、第 11 次熔断、熔断后同一会话仍能续跑）。
