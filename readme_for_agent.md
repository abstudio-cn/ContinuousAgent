# ContinuousAgent（TypeScript · 浏览器版）

常驻本机的通用智能体：以工具为核心完成工作——读写文件、执行命令、抓取网页、操作桌面与剪贴板，并维护一份持续更新的**工作记录**与一份长期**工作笔记**。本项目从 GameAgent Web 分支而来（`..\gameragent_web` 保持原样，两者互不依赖）。

技术栈是 **TypeScript**：服务端负责 agent 循环、LLM 流式调用、工具执行与文件沙箱，浏览器端提供完整 UI。桌面版的原生能力（窗口截图、键鼠注入、Windows OCR）通过一个 **PowerShell 原生桥** 保留，因此浏览器版依然可以真正操作 GUI 应用。

支持**多会话**：左侧会话列表可新建/切换/重命名/删除；每个会话拥有独立的对话时间线、`work_state.md`（工作记录）与 `work_notes.md`（工作笔记）（存放在 `<工作空间>/sessions/<会话ID>/`），互不干扰。

> 安全提示：服务默认只监听 `127.0.0.1`。它能在你的机器上移动鼠标、按键、读文件，**不要**直接暴露到公网。要远程访问请走 SSH 隧道 / Tailscale，并设置 `CONTINUOUS_AGENT_TOKEN`（兼容旧的 `GAMEAGENT_TOKEN`）。

---

## 快速开始

```powershell
cd "$env:USERPROFILE\Documents\ContinuousAgent"   # cmd.exe 写法：cd %USERPROFILE%\Documents\ContinuousAgent
npm install
npm start            # 构建产物需先 npm run build（或直接 .\start-windows.ps1 / ./start-linux.sh）
```

一键脚本（构建 + 启动 + 打开浏览器）：

```powershell
.\start-windows.ps1      # 默认 7800 端口
.\start-windows.ps1 -Port 8080 -NoBuild
```

Linux / macOS 用参数风格对应的 `start-linux.sh`（POSIX sh 编写，`sh start-linux.sh` 也能跑，不依赖 bash）：

```sh
chmod +x start-linux.sh          # 首次使用给执行位
./start-linux.sh                 # 构建 + 前台启动，默认 7800
./start-linux.sh --port 8080 --no-build
./start-linux.sh --host 0.0.0.0  # 需要局域网访问时
./start-linux.sh --daemon        # 后台运行（nohup），日志进数据目录
./start-linux.sh --status        # 查看状态
./start-linux.sh --stop          # 停止后台实例
```

两个脚本首次运行都会先做**运行环境检测**：确认 Node.js ≥ 20（口径来自 `package.json` 的 `engines.node`）与 `npm` 可用。缺失或版本过低时自动安装：

- **Windows**：优先 `winget install --id OpenJS.NodeJS.LTS`，失败则下载官方 MSI 静默安装（需管理员权限；非管理员会给出提示与下载地址，不会静默失败）
- **Linux/macOS**：下载 nodejs.org 官方发行包（`.tar.gz`，避免依赖 xz），校验 SHA256 后解压到 `~/.local/lib/node`（`CA_NODE_HOME` 可改），**无需 root**；只对本次运行前置 PATH，不动系统目录与 shell 配置

安装前会打印「检测到什么 / 要装到哪里」，安装完成后重新校验一遍才继续构建。需要排障时：

```sh
./start-linux.sh --check-env         # 只检测环境，不安装也不启动（可用=0，不可用=1）
./start-linux.sh --no-auto-install   # 缺 Node.js 时直接报错，不自动装
```

```powershell
.\start-windows.ps1 -CheckEnv        # 只检测环境（会打印修复方案与官方安装包地址）
.\start-windows.ps1 -NoAutoInstall   # 缺 Node.js 时报错，不自动装
```

然后：

1. 打开 <http://127.0.0.1:7800>
2. 右上「设置 → 多模型」点「+ 添加模型」，填 OpenAI 兼容地址、Key、模型名（可加多行，随时切当前模型）
3. （需要操作 GUI 时）顶部「目标窗口」下拉选择目标进程（列出 PID / 进程 / 客户区尺寸）
4. 按需选一下输入框下方的**场景**标签（默认「通用」），只影响本会话的工具提示词
5. 输入框写托管目标，Enter 或「开始托管」
6. 随时「中断运行」（页面内快捷键 `F12` / `Ctrl+Shift+X`；浏览器无法注册全局热键）；运行中输入框不被禁，按钮变「插入消息」，内容在下一轮请求生效

环境变量：`PORT`（默认 7800）、`HOST`（默认 127.0.0.1）、`CONTINUOUS_AGENT_DATA_DIR`（默认 `%APPDATA%\ContinuousAgent`，兼容 `GAMEAGENT_DATA_DIR`）、`CONTINUOUS_AGENT_TOKEN`（可选访问令牌）。

首次启动若发现旧版 `%APPDATA%\GameAgentWeb\settings.json`，会自动迁移一份设置（含 Key）到新目录，工作空间改用 `Documents\ContinuousAgentWorkspace`。

---

## 功能对照

| 桌面版 (C#/WPF) | 浏览器版 (TypeScript) |
| --- | --- |
| WPF 深色 UI / 三栏 | 单页 Web UI：时间线 + 记录/笔记侧栏 + 设置弹窗 |
| `AgentRunner` 主循环 | `src/server/agent.ts`（同语义：轮次、工具调用、记录强制更新、自动续跑、历史裁剪、指数退避） |
| `LlmClient` SSE 流式 | `src/server/llm.ts`（`reasoning_content`、tool_calls 增量、图片预算、阅后即焚、token 估算） |
| `ToolExecutor` + `ToolCatalog` | `src/server/tools.ts`（45 个同名工具、同一套中文描述；另可按场景追加提示） |
| `InputSimulator` / `ScreenCapture` / `WindowManager` / `OcrService` | `scripts/native-host.ps1` + `src/server/native.ts`（PowerShell 常驻进程，行协议 JSON） |
| Windows DPAPI 存 Key | 只存服务端 `settings.json`，浏览器只见「已保存/未设置」 |
| SAPI / 云端 TTS / sherpa-onnx | 浏览器 `speechSynthesis` + 云端 `/audio/speech` 代理 |
| 全局中断热键 | 页面按钮 + 页面内快捷键（浏览器限制） |
| 单文档 | **多会话**：每会话独立时间线 + 独立记录/笔记，可切换、重命名、删除 |

**未移植**：sherpa-onnx 离线神经网络语音（Kokoro / ZipVoice）、DPAPI、全局热键、WPF 专属主题细节。朗读改用系统语音或云端 TTS。

---

## 目录结构

```
ContinuousAgent/
├── package.json / tsconfig.json / tsconfig.client.json
├── start-windows.ps1            # 一键构建 + 启动（Windows，含环境检测/自动安装）
├── start-linux.sh               # 一键构建 + 启动（Linux/macOS，POSIX sh，含环境检测/自动安装）
├── README.md                    # 介绍向文档（定位、效率、token 账）
├── readme_for_agent.md          # 本文件：完整手册
├── public/
│   ├── index.html
│   ├── styles.css               # 深色主题（另有一块 html[data-theme=light] 白天主题覆盖）
│   └── assets/logo.svg          # 顶栏品牌图标，同时作为 favicon
├── src/
│   ├── shared/                  # 前后端共用（不含 Node API，客户端一起编译）
│   │   ├── types.ts
│   │   ├── prompt.ts            # STATIC_SYSTEM_PROMPT / 记录与笔记模板 / 完成标记
│   │   ├── pricing.ts           # 输入两段拆分 + 用量计价 + 金额格式化
│   │   └── scenes.ts            # 七档工具场景的提示词数据（纯数据 + 纯函数）
│   ├── server/
│   │   ├── index.ts             # HTTP + SSE + REST + 静态服务
│   │   ├── agent.ts             # 主循环 + 时间线 + 提示词装配
│   │   ├── llm.ts               # OpenAI 兼容流式客户端
│   │   ├── tools.ts             # 45 个工具调度 + 清单 + 沙箱/授权
│   │   ├── record.ts            # 工作记录 / 笔记服务（按会话路径）+ 开工规划提醒
│   │   ├── history.ts           # 历史裁剪 + 工具调用配对修复（防 HTTP 400）
│   │   ├── sessions.ts          # 会话元数据、时间线、历史、字数、历史检索、场景
│   │   ├── settings.ts          # 设置读写与校验
│   │   ├── paths.ts             # 路径规范化 + 工作空间沙箱
│   │   ├── native.ts            # 原生桥客户端（掉线指数退避重连）
│   │   ├── imagestore.ts        # 截图短期存储（SSE 只发 URL）
│   │   ├── backup.ts            # 改动前自动备份 + 回滚
│   │   ├── tips.ts              # 全局技巧库（脱敏、拦截、频次、容量淘汰）
│   │   ├── plugins.ts           # 插件隔离层（清单校验 + 子进程执行 + 审计）
│   │   └── repeat-guard.ts      # 重复工具调用熔断（滑窗指纹计数）
│   └── client/
│       ├── main.ts              # 时间线渲染、设置面板、事件流、三栏拖拽
│       ├── markdown.ts          # 轻量 Markdown（先转义再渲染）+ 流式增量渲染
│       └── tts.ts               # 朗读队列
├── scripts/                     # 原生宿主 + 34 个回归/基准脚本（见「测试」）
│   └── native-host.ps1          # Win32 截图/键鼠/OCR 常驻宿主
├── examples/plugins/sys-info/   # 插件示例（拷到 <数据目录>/plugins/ 即可加载）
└── tools/mock-model.mjs         # 本地 mock 模型（无 Key 时演示/测试）
```

---

## 工具清单

共 **45 个**（`buildToolCatalog()` 可数）。旧名 `select_game_window`、`update_game_record` 等仍兼容。

| 分组 | 工具 |
| --- | --- |
| 窗口与视图 | `list_windows`、`select_window`、`get_window_info`、`screenshot`、`screenshot_background`、`ocr` |
| 键鼠 | `mouse_move`、`mouse_click`、`mouse_drag`、`scroll`、`key_press`、`key_down`、`key_up`、`type_text` |
| 文件 | `read_file`、`list_directory`、`find_files`、`search_files`、`write_file`、`edit_file`、`apply_patch`、`delete_path`、`view_image` |
| 命令与网络 | `exec_command`、`exec_output`、`exec_kill`、`web_fetch`、`launch_app`、`process_list`、`clipboard_read`、`clipboard_write` |
| 记录 / 会话 / 设置 | `update_work_record`、`read_work_record`、`update_work_notes`、`append_work_notes`、`read_work_notes`、`rename_session`、`search_sessions`、`set_scene`、`global_tips`、`changed_backup`、`get_environment`、`wait` |
| 权限申请 | `request_write_access`、`request_read_access` |

- 坐标：目标窗口**客户区像素**，左上 (0,0)；截图只用于观察，可能等比缩放。
- 读：本机任意路径；写/删：仅工作空间；删除进 `<工作空间>/.trash`（7 天可恢复）。
- 截图默认转 JPEG(60) 且宽度上限 1280，只带最近 2 张图，读过即焚。`screenshot_background` 只走 `PrintWindow`：不激活窗口、不改前后台与叠放顺序，窗口被遮挡也能拿到它自己的画面；拿到的若是纯色图会明确报错并建议改用 `screenshot`。
- `read_file` 支持分页：超窗口**不再报错**，而是截到 UTF-8 字符边界与行首，并在末尾提示「[已截断] 本次返回第 A–B 字节（文件共 S 字节），还剩 R 字节，继续读请传 offset=B」；单次上限 1 MB，`offset` 到末尾时提示「[已到末尾]」。
- `exec_command` 支持 `background` / `wait_ms` 后台执行，配 `exec_output`（取**增量**输出）与 `exec_kill`（Windows 用 `taskkill /T /F`，POSIX 杀整个进程组）。Windows 上是 PowerShell，Linux/macOS 上是 `/bin/sh -lc`。
- 会改文件的三个工具（`write_file` 覆盖 / `edit_file` / `apply_patch`）先把原文件备份到 `<工作空间>/changed_backup`，需要时用 `changed_backup {action:'restore', id}` 撤回。
- 历史检索：`search_sessions`（必填 `query`，可选 `scope=chat|all`、`limit`）——跨会话翻过往对话，用来看「上次类似问题是怎么处理的」；只读，不改任何历史数据。
- `set_scene`（`scene` 必填：`general`/`coding`/`research`/`chat`/`game`/`slides`/`security`）只改**当前会话**的工具场景；`global_tips`（`action=add|use|list|remove`）维护跨会话的工具技巧库。

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
| 设置（含 Key，仅服务端） | `%APPDATA%\ContinuousAgent\settings.json` |
| 工作空间（默认） | `Documents\ContinuousAgentWorkspace` |
| 工作记录 / 笔记 | `<工作空间>\sessions\<会话ID>\work_state.md` / `work_notes.md`（按会话隔离，笔记上限 100000 字符） |
| 会话列表与运行数据 | `%APPDATA%\ContinuousAgent\sessions\index.json`（会话标题与场景设置）、`<会话ID>/timeline.json`、`history.json`、`runtime.json` |
| 目录授权 | `<工作空间>\sessions\<会话ID>\grants.json`（可写）、`read_grants.json`（只读） |
| 全局技巧库 | `%APPDATA%\ContinuousAgent\global_tips.json` |
| 插件 | `%APPDATA%\ContinuousAgent\plugins\<插件id>\plugin.json`；开关 `plugins_state.json`；审计 `plugin_audit.jsonl`；卸载进 `plugins_trash\` |
| 改动备份 | `<工作空间>\changed_backup\`（回滚用，任务结束时清本会话的条目） |
| 截图临时文件 | `%TEMP%\gameagent-web`（原生宿主即时清理） |

浏览器拿到的设置永远是脱敏副本（`hasApiKey / hasCloudTtsApiKey`），Key 不回传。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state?session=<id>` | 该会话的设置（脱敏）、运行状态、目标窗口、记录、笔记、时间线、场景（`scene`）；不带 `session` 时取最近活跃会话 |
| GET | `/api/sessions` | 会话列表（含运行状态与字数） |
| GET | `/api/sessions/search?q=&scope=chat\|all&max=&per=` | **历史对话检索**（只读）：多关键词按空白拆分、**全部命中**才算命中，大小写不敏感、中文按子串；返回按会话分组的命中片段；`max`/`per` 限分组数与每会话片段数，被截断时 `truncated=true` |
| POST | `/api/sessions` | 新建会话 `{title?}`（不传标题时先给默认名，事后自动命名）；新会话默认场景为「通用」 |
| POST | `/api/sessions/:id/rename` \| `/scene` \| `/delete` | 重命名 / 改本会话工具场景（`{toolScene?, sceneGuideEnabled?}`，部分更新）/ 删除（记录移入 .trash） |
| GET | `/api/events` | SSE：`state/item_add/item_update/clear/record/notes/target/native` + `scene`/`sessions`/`grants`/`readGrants`/`plugins` |
| GET | `/api/record` \| `/api/notes` | 当前会话的工作记录 / 工作笔记原文 |
| POST | `/api/settings` | 局部更新设置。这里的 `toolScene`/`sceneGuideEnabled` 只作**新会话的默认值**，改当前会话要走 `/scene` |
| GET | `/api/tips` | 全局技巧库（条目名单 + 容量统计）；文本不会随 `/api/state` 下发 |
| POST | `/api/model/select` | 切换当前模型（多模型配置；id 无效则回落全局模型） |
| GET | `/api/windows` | 可见窗口列表 |
| POST | `/api/window/select` | `{pid}` 或 `{title}` |
| POST | `/api/window/clear` | 清除目标 |
| POST | `/api/agent/start` \| `stop` \| `reset` \| `clear-timeline` | 运行控制（需带 `sessionId`）；同会话**运行中**调 `start` 不再 409，改为把 `prompt` 当作插入消息 |
| POST | `/api/agent/message` | **执行中插入对话**：`{sessionId, prompt, attachments?}`。运行中 → 注入并回 `{ok, injected:true, turn}`；未运行 → `409 {notRunning:true}`（客户端退化走 start） |
| POST | `/api/access/respond` | 目录读/写申请答复：`{requestId, decision: allow\|session\|deny}` |
| GET | `/api/plugins` | 插件清单与状态（是否启用、可用工具数、审计条数） |
| POST | `/api/plugins/reload` \| `/toggle` \| `/remove` | 重新扫描 / 开关某个插件 `{id, enabled}` / 卸载到 `plugins_trash` |
| POST | `/api/plugin/respond` | 插件工具审计答复：`{requestId, decision: allow\|session\|deny}` |
| POST | `/api/test-connection` | 模型连通性 |
| POST | `/api/tts` | 云端 TTS 代理（Key 不出服务端） |
| GET | `/api/images/:id` | 工具截图 |

---

## 测试

大多数回归**自带隔离实例**（随机端口 + 临时数据目录），不需要先启服务、不需要模型；统一先 `npm run build` 再跑。

```powershell
# 工具层：原生截图/OCR/键鼠 + 文件沙箱（无需模型）
node scripts/tool-smoke.mjs GameAgent

# 会话隔离：在 A 会话跑一轮，确认 B 会话记录不变
node scripts/session-test.mjs --url http://127.0.0.1:7789

# 执行中插入对话：运行中注入消息 → 下一轮请求生效（隔离实例 + SSE mock，无需真实模型）
npm run build && node scripts/inject-message-test.mjs

# 历史对话检索：search() 语义 + 工具层 + HTTP 路由 + 只读校验（61 项）
npm run build && node scripts/session-search-test.mjs

# 端到端：需要先启动 mock 或真实模型
npm start
$env:MOCK_PORT=18766; $env:MOCK_MODE='native'; node tools/mock-model.mjs   # 另开窗口
# 设置里把 API 地址指向 http://127.0.0.1:18766/v1
node scripts/selftest.mjs --title GameAgent --prompt "原生链路自检"
```

`selftest.mjs` 会检查：原生桥可用、窗口选择、运行结束、无错误项、记录与笔记已更新、工具全部成功。

### 回归脚本索引（`scripts/`，34 个）

| 脚本 | 覆盖 |
| --- | --- |
| `tool-verify.mjs` | 离线工具链自检（不起 HTTP、不需要模型） |
| `tool-smoke.mjs` | 工具冒烟：原生链路 + 文件沙箱 |
| `bench.mjs` | 性能基准（`--root` 可对比别的构建，`--json` 机读） |
| `token-report.mjs` | token 报告：固定开销占比、全量重发倍数、工具清单体积 |
| `native-probe.mjs` | 原生宿主逐命令压测（ping / 窗口 / 截图 / OCR） |
| `native-resilience-test.mjs` | 原生桥被外部杀掉后的退避重连（22 项） |
| `background-shot-test.mjs` | 后台截图：不抢前台、遮挡下内容正确、纯色图标记（55 项） |
| `exec-bg-test.mjs` | 后台命令：不阻塞、增量输出、`wait_ms` 转后台、kill（31 项） |
| `exec-timeout-force-test.mjs` | 超时且输出管道被占时 3 秒内强制结算（17 项） |
| `edit-safety-test.mjs` | 替换串里的 `$` 模式与改写安全（45 项） |
| `read-file-large-test.mjs` | `read_file` 分页 / 截断 / UTF-8 边界（60 项） |
| `read-access-test.mjs` | 读权限严格模式与申请流程（70 项） |
| `markdown-test.mjs` | Markdown 渲染 + 流式增量一致性（79 项） |
| `pricing-test.mjs` | 计价与输入两段拆分（99 项） |
| `scene-profile-test.mjs` | 七档工具场景 + 会话级存储（148 项） |
| `prompt-order-test.mjs` | 提示词顺序（抓真实请求体，23 项） |
| `plan-first-test.mjs` | 开工先规划提醒（53 项） |
| `repeat-guard-test.mjs` | 重复调用熔断（68 项） |
| `global-tips-test.mjs` | 全局技巧库：脱敏 / 拦截 / 淘汰 / 注入（73 项） |
| `changed-backup-test.mjs` | 改动备份与回滚（67 项） |
| `done-notice-test.mjs` | 完成提示文案与历史兼容（19 项） |
| `session-title-test.mjs` | 会话标题清洗与自动命名（33 项） |
| `multi-model-test.mjs` | 多模型设置与切换 |
| `first-turn-pin-test.mjs` | 历史裁剪时首轮任务消息不被裁掉 |
| `history-sequence-test.mjs` | 历史消息序列合法（`tool_calls` 与 `tool` 结果配对） |
| `history-400-repro.mjs` | 用假服务复现/回归「tool 消息无前置 tool_calls」的 400 |
| `thinking-usage-test.mjs` | 流式 usage 与思考开关（mock，27 项） |
| `thinking-usage-e2e.mjs` | 直连真实模型的 TTFT / 耗时 / usage 对比 |
| `inject-message-test.mjs` | 执行中插入对话（56 项） |
| `session-search-test.mjs` | 历史对话检索：语义 + 工具 + 路由 + 只读（61 项） |
| `plugin-test.mjs` | 插件系统：清单校验、隔离执行、审计（127 项） |
| `plugin-manage-test.mjs` | 插件开关与卸载（81 项） |
| `session-test.mjs` | 会话隔离（A 跑一轮，B 不变） |
| `selftest.mjs` | 端到端（需运行中的服务 + 模型） |

---

## 已知限制

- 独占全屏 / GPU 合成窗口可能截不到图，建议目标应用用无边框窗口。
- Windows OCR 依赖系统语言包，识别率与字号、缩放有关；截图上限 2400 宽。
- 浏览器不能注册全局热键，中断只在页面聚焦时有效。
- 同一时间只允许**一个会话**运行（否则两个会话会抢同一套键鼠），切换会话不会中断正在跑的会话。
- 执行中的消息插入是「下一轮请求生效」：当前轮请求已经发出，无法中途改它的上下文；界面文案也按这个口径写。
- 历史检索有上限：默认最多扫 120 个会话、每会话返回 3 条片段、共 20 个分组，单条文本只扫前 200k 字符；结果被裁剪时 `truncated=true`，此时「另有 N 条命中未列出」会在每组下方标出。
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
- 侧栏新增**历史对话搜索**：输入关键词即跨会话检索，结果按会话分组、带命中片段与关键词高亮，点一下直接跳到该会话并把命中的那条消息滚到屏幕中间闪一下；右上角可切「对话 / 全部」范围（全部含工具输出与工作记录/笔记）。`Esc` 清空恢复会话列表。

### 工具（对齐 OpenClaw agent 能力）

在原有 25 个桌面/文件工具之上补齐 10 个通用工具（当时合计 35 个；**当前共 45 个**，见前文「工具清单」）：

| 工具 | 用途 |
| --- | --- |
| `exec_command` | 执行 shell 命令（Windows 用 PowerShell，Linux/macOS 用 `/bin/sh -lc`；默认工作目录为工作空间，超时可配，支持后台运行） |
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

持续托管模式默认会一直续跑（直到 `maxTurns`，默认 500）。现在模型可以在真正完工时主动收尾，或在「只有用户能定」的分叉上主动中断等答复：

- 系统提示词要求：确认全部要求已完成并验证过 → 先 `update_work_record` 写最终状态 → 在回复**最后单独一行**输出 `[[DONE]]`。
- 服务端只在「本轮没有任何工具调用」时才认这个标记，并从正文里剥掉，状态变为 **已完成**，自动续跑立即停止，页面弹出「✅ 模型确认任务完成」。
- 防误判：标记必须在消息最末尾且不在未闭合的代码块里；出现在中间、后面还有内容、或在代码块示例中都不算。
- 需要用户做选择时也走这个标记：遇到方案取舍 / 口径不明 / 是否执行不可逆或有外部影响的操作 / 缺必要信息时，先只读侦察把事实摆清，把 2~3 个明确选项（各写清影响与代价）列给用户并给出推荐，然后在回复**最后单独一行**输出 `[[DONE]]` 中断自动续跑，等用户答复。这不算「提前结束」：用户答复后从当时状态继续，不重复已完成步骤。
- 单轮模式（`continuousMode=false`）本来就会在完成一轮后停止，标记同样会显示为“已完成”。

### 重复工具调用熔断（模型原地打转就刹车）

模型偶尔会「原地打转」：同一个工具、完全相同的参数反复调用，既不产生新信息也不推进任务。服务端会主动刹车：

- **判定口径**：`工具名 + 规范化参数` 构成调用指纹。参数先 `JSON.parse` 再按键名递归排序后重新序列化，所以 `{"a":1,"b":2}` 与 `'{ "b": 2, "a": 1 }'` 视为同一次调用；不是合法 JSON 的参数退回「压缩空白后的原文」。
- **滑动窗口**：只看**最近 30 次**工具调用；同一指纹在窗口内已出现 **10 次**，第 11 次立即熔断。用滑窗而不是整轮累计，是为了不误伤持续托管的长会话（`list_windows` 这类无参工具本来就会被反复正常使用）。
- **熔断后**：该次调用不执行，剩余调用按既有规则补「工具调用已中断，未执行」占位结果（历史仍是 tool_calls 与结果一一对应的合法序列，不会引发 HTTP 400），时间线插入一条系统提示说明是哪个工具、已出现几次，状态变为 **重复调用，已中断**，自动续跑停止。
- 系统提示词同步写入该规则，引导模型「同一操作重复两三次没有新信息，就换参数、换工具或换思路」。
- 实现：`src/server/repeat-guard.ts`（`RepeatGuard` / `toolCallKey` / `normalizeToolArgs`，常量 `REPEAT_LIMIT = 10`、`REPEAT_WINDOW = 30`）；`src/server/agent.ts` 主循环在 `tools.execute()` **之前**判定，判定点与占位补齐的顺序不可调换。
- 回归：`npm run build && node scripts/repeat-guard-test.mjs`（68 项：单元 / 产物接线 / 真实循环 e2e —— 10 次不中断、第 11 次熔断、熔断后同一会话仍能续跑）。

### 更近的改动（2026-11-19 / 11-20）

- **工具场景（七档）**：通用 / 程序开发 / 科研 / 对话 / 游戏操作 / PPT 处理 / 网络安全维护。数据与纯函数在 `src/shared/scenes.ts`，每档含推荐工具链、操作要点、常见失效，并给对应工具描述追加【本场景】提示；场景块注入在「静态系统提示之后、历史之前」。入口三处：`set_scene` 工具、设置面板「工具场景」分区、输入框下方场景标签。
- **场景按会话存**：落在 `sessions/index.json`（`toolScene` / `sceneGuideEnabled`）；新会话默认「通用」；老会话无字段时回落全局值并标 `inherited`；`POST /api/sessions/<id>/scene` 只改本会话。
- **提示词按变更频率排序**：`[静态系统提示] → [工作笔记 + 场景] → [历史] → [工作记录 + 运行上下文 + 技巧库]`。原先动态块排在历史之后，历史每轮增长会把它们一路往后推，于是永远不可能是任何一次请求的前缀。
- **`read_file` 大文件分页**：超窗口不再报错，改为截到 UTF-8 字符边界与行首并给出 `offset` 续读指引（单次上限 1 MB）。回归 `node scripts/read-file-large-test.mjs`（60 项）。
- **三栏宽度可拖拽**：会话列表 / 对话 / 工作记录之间两条 14px 手柄，支持拖拽、双击复位、方向键微调（16px，Shift 48px），宽度存 `localStorage`；窄屏自动隐藏右栏与右手柄，并保证对话区最小宽度。
- **设置面板重排**：「接口与模型 + 价格统计」并入「多模型」，分区卡片化、字段多列网格、textarea 跨列；多模型行内字段直接编辑（全局字段已移除，行内留空则回落旧全局值），并设有「还没有添加模型」空态与初始化提示。
- **输入框计量精简**：下方只显示「入 N · 出 N · 金额」，命中/未命中拆分保留在顶部用量与悬浮算式里；左侧多一个场景标签（点击直达设置）。
- **内部提醒不渲染**：「提醒模型先规划任务」「已压缩较早的对话历史」仍写入时间线，但界面不显示（数据不改，只在渲染层过滤）。
- **工作记录侧栏增强**：会话路径、清单进度胶囊（`x/y`）、字符数胶囊与底部进度线；笔记页的进度线表示容量占用（≥0.9 变黄）。
- **其他能力**（详见对应回归）：改动前自动备份与回滚（`changed_backup`）、读权限严格模式（`request_read_access`）、后台命令、全局技巧库、插件系统（含单插件开关与卸载）、历史对话检索、执行中插入对话、价格统计与输入两段拆分、Markdown 渲染重写与流式增量、白天主题、顶栏品牌图标与授权悬停浮层。
