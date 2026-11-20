/**
 * 工具场景（scene）：把「程序开发 / 科研 / 对话 / 游戏操作 / PPT 处理 / 网络安全维护」六类典型任务的
 * 工具用法差异收敛成**结构化数据**，由服务端按当前场景注入提示词、增强工具描述，客户端只做预览。
 *
 * 约定：
 * 1. 本文件是纯数据 + 纯函数。`src/shared/**` 会被客户端一起编译（tsconfig.client.json，types: []），
 *    这里禁止出现 process / fs 等 Node API。
 * 2. 静态系统提示词（prompt.ts 的 STATIC_SYSTEM_PROMPT）保持字节稳定以吃满前缀缓存，
 *    场景内容一律走动态块（见 sceneGuideBlock）。
 * 3. 场景只改变「提示与描述」，不改变工具清单本身：跨场景任务不会突然丢工具。
 */
/** 顺序即设置面板下拉顺序；第一项是默认档。 */
export const SCENES = [
    {
        id: 'general',
        label: '通用',
        tagline: '默认档：没有特定技术栈的任务。工具全开，按需取用，不套用别的场景的套路。',
        tools: ['read_file', 'list_directory', 'exec_command', 'update_work_record', 'update_work_notes'],
        rules: [
            '先只读侦察再动手：文件内容、目录结构、命令输出一律以实测为准。',
            '任务性质明确后（写代码、做 PPT、操作界面……）用 set_scene 切到对应场景，能显著减少试错。',
        ],
        pitfalls: ['把某一场景的固定套路（例如「改完必跑构建」）硬套到不相关的任务上。'],
        toolHints: {},
    },
    {
        id: 'coding',
        label: '程序开发',
        tagline: '改代码 ≠ 改文本：先定位、最小改动、立刻验证。',
        tools: ['search_files', 'find_files', 'read_file', 'edit_file', 'apply_patch', 'exec_command', 'changed_backup'],
        rules: [
            '定位先行：search_files / find_files 找定义与调用点，再 read_file 读目标片段；不凭记忆假设文件内容。',
            '最小 diff：优先 edit_file / apply_patch 精确锚点替换；write_file 只用于新建或确需整体重写。',
            '锚点必须唯一且逐字节一致（含缩进与全角标点）；片段不唯一就先扩大上下文。',
            '大文件多处改动：写一次性补丁脚本，每处断言「命中次数恰为 1」，全部通过后再写盘。',
            '改完立刻验证：typecheck / build / test，读退出码与 stderr 关键行；「命令跑过了」不等于「通过了」。',
            '改坏了先 changed_backup restore 回到基线，不要在破损文件上继续编辑。',
        ],
        pitfalls: [
            '用 write_file 整体重写大文件，结果丢内容或重复写入。',
            '在 PowerShell 里写 bash 语法（或反之），报错信息与真实原因无关，白试几轮。',
            '只改源码不重建、不重启，就宣称「已生效」。',
            '用反复试跑代替测试，把「这次没报错」当成修好了。',
        ],
        toolHints: {
            read_file: '先读目标片段再改；大文件用 max_bytes 限流，需要看中段时用 offset 跳过开头。',
            edit_file: 'old_text 必须与文件逐字节一致且唯一（含全角标点）；替换串含 $ 时不会被当成模式展开，但仍建议先小改再验证。',
            apply_patch: '多组替换一次提交；任一组锚点不唯一会整体失败，报错后先查唯一性再重试。',
            search_files: '正则搜内容；用 file_pattern 缩小范围（如 *.ts），默认已跳过 node_modules/.git/dist。',
            exec_command: '构建/测试把 cwd 指向项目根；长任务用 background=true 拿任务 ID，再用 exec_output 取增量输出。',
            changed_backup: '改动前的原文件会自动备份；改坏时先 list 找到条目再 restore，不要在破损文件上继续改。',
            write_file: '只用于新建文件或确需整体重写；覆盖已有文件会自动备份原内容。',
        },
    },
    {
        id: 'research',
        label: '科研',
        tagline: '先取证再结论：每条结论都要能指回来源与时间。',
        tools: ['web_fetch', 'read_file', 'find_files', 'search_files', 'exec_command', 'append_work_notes'],
        rules: [
            '检索式先宽后窄：先拿术语与同义词摸清领域，再收窄到具体问题。',
            '来源优先原始材料（官方文档、论文原文、标准文本）；二手总结只当线索，不当作结论依据。',
            '每条结论标注「出处 + 抓取时间」；抓不到就写「未找到」，不要用模型常识补齐。',
            '数据处理写成可复跑脚本（exec_command），中间结果落盘到工作空间，便于复核与重跑。',
            '区分「事实 / 推断 / 猜测」三档表述；两个来源冲突时并列陈述差异，不静默择一。',
            '稳定结论追加到工作笔记（append_work_notes），含来源；一次性数据放工作记录。',
        ],
        pitfalls: [
            '没抓取就写「根据资料显示」，把模型记忆当成检索结果。',
            '只读摘要不复核原文数字（单位、口径、年份错位）。',
            '一次没抓到就断言「不存在」或「没有相关研究」。',
            '把原始大数据整份读进上下文，而不是先脚本聚合再读摘要。',
        ],
        toolHints: {
            web_fetch: 'HTML 自动转文本；用 max_chars 控制体积，长文档分段抓取。',
            exec_command: '统计/解析用脚本一次算完并打印摘要（计数、均值、异常项），不要把原始数据全量读进上下文。',
            append_work_notes: '只记「可复用结论 + 来源 + 复跑命令」，不记检索流水。',
            read_file: '先看体积；论文/日志类大文件用 offset + max_bytes 分段读，避免一次塞满上下文。',
        },
    },
    {
        id: 'chat',
        label: '对话',
        tagline: '以回答为主：不为凑流程而调工具，不写长计划。',
        tools: ['read_file', 'web_fetch', 'search_sessions'],
        rules: [
            '先直接回答，结论先行；只有需要外部事实（实时信息、本机文件、历史对话）时才调工具查证。',
            '不为了「走流程」而写工作记录、不拆 8 步计划；一句话能答清的别拆成三段。',
            '不确定就直说不确定，并给出可验证的下一步（要查什么、跑什么命令）。',
            '用户转为「动手做事」（改文件、操作界面、生成文档）时，用 set_scene 切到对应场景再执行。',
        ],
        pitfalls: [
            '简单问题也写整套计划与工作记录，响应慢且噪音大。',
            '没验证就断言「已修复 / 已生效」。',
            '用工具刷存在感：读一堆无关文件再回答。',
        ],
        toolHints: {
            read_file: '只在需要核对具体文件内容时读；只读需要的片段，不要整份扫。',
            web_fetch: '只在问题依赖实时/外部信息时抓，抓完给结论与链接，不要把整页粘回去。',
            search_sessions: '用户提到「之前聊过 / 上次说的」时按关键词检索历史会话；命中就摘出结论，没命中别猜。',
        },
    },
    {
        id: 'game',
        label: '游戏操作',
        tagline: '桌面与游戏操作：观察 → 单步执行 → 立刻回看。',
        tools: ['list_windows', 'select_window', 'screenshot_background', 'ocr', 'mouse_click', 'key_press', 'wait'],
        rules: [
            '定位：先 list_windows 看 pid / 标题 / 客户区尺寸，再 select_window 选定；多会话并行时用 activate:false 或 screenshot_background，避免抢前台。',
            '坐标一律是目标窗口**客户区像素**（左上 0,0）；截图可能被缩放，按「客户区宽 ÷ 截图宽」换算后再点。',
            '单步验证：每次点击/按键后立刻 screenshot_background 复核，不要连着盲点一串。',
            '长按与移动：key_down 与 key_up 必须配对（异常中断也要补 key_up）；持续移动用 key_press 的 hold_ms。',
            '等待：动画/加载用 wait（≤10 秒）或轮询截图，不要空转连点。',
            'OCR 只用来定位控件坐标，不用来当文案证据（中文识别常有错字）。',
        ],
        pitfalls: [
            '用整屏坐标（或高 DPI 缩放后的坐标）点客户区控件，必偏。',
            '连续点击一长串、最后才截图，出错无法定位是哪一步。',
            'PrintWindow 抓到纯色图（窗口最小化/输入法隐形浮层）仍当成有效画面。',
            '把 key_down 后忘了 key_up，导致后续操作全被按住状态污染。',
        ],
        toolHints: {
            screenshot_background: '不激活窗口、被遮挡也能拿到窗口自身画面；返回 blank=true 时改用 screenshot 或先恢复窗口。',
            mouse_click: '坐标是客户区像素；点击后立刻截图确认，不要连续盲点。',
            key_down: '必须稍后用 key_up 释放同一组键；中断前也要补释放。',
            ocr: '用于定位控件坐标；中文识别有错字，别当文案级证据。',
            wait: '上限 10 秒；等加载/动画用它，别用连点代替等待。',
            list_windows: '先看 pid/标题/客户区尺寸再选窗口；同标题多窗口要靠 client 尺寸或截图区分。',
        },
    },
    {
        id: 'slides',
        label: 'PPT 处理',
        tagline: '演示文稿：能程序化改就别点界面，改完必须渲染核对。',
        tools: ['exec_command', 'read_file', 'write_file', 'view_image', 'find_files'],
        rules: [
            '优先程序化：python-pptx 或 PowerPoint COM 生成/修改，可重复、可版本化；手工点界面只用于最终视觉微调。',
            '数据与模板分离：内容放数据文件（JSON/CSV），版式放模板；批量生成用同一份脚本跑。',
            '永不覆盖原稿：动手前 Copy-Item 备份，输出另存新文件（带版本号或时间戳）。',
            '校验必须看图：导出 PNG/PDF 后用 view_image 逐页看溢出、遮挡、字体替换；只数页数不算验证。',
            '中文字体显式指定（如微软雅黑），给文本框留余量，避免渲染端替换字体后溢出。',
            'pptx 就是 zip：需要精确核对文本/页数时，用 exec_command 解包读 XML 比肉眼更硬。',
        ],
        pitfalls: [
            'COM 脚本没 Quit / 没释放对象，PowerPoint 进程残留并锁住文件。',
            '直接改用户原稿同名保存，出问题无法回退。',
            '只改数据不看渲染，交付时才发现文字溢出。',
            '在 PowerShell 里内联长 COM 脚本，引号与转义把脚本写坏（应落成 .ps1 再执行）。',
        ],
        toolHints: {
            exec_command: 'PowerPoint COM / python-pptx 脚本先写成 .ps1 / .py 落盘再执行，避开内联引号；脚本末尾 Quit 并释放对象。',
            view_image: '导出的页面 PNG 必须逐页查看，检查溢出/遮挡/字体替换；缩略图不够，按页读。',
            write_file: '生成脚本与数据文件放在工作空间；覆盖已有文件会先备份。',
            find_files: '先找模板与数据源文件，确认版式口径再写生成脚本。',
        },
    },
    {
        id: 'security',
        label: '网络安全维护',
        tagline: '安全排查：只读优先、留证据、不越权、不动生产。',
        tools: ['exec_command', 'read_file', 'search_files', 'process_list', 'get_environment', 'append_work_notes'],
        rules: [
            '范围：只排查用户明确授权的本机/自有资产；对第三方目标的扫描、爆破、利用一律拒绝并说明原因。',
            '只读优先：先用 Get-Process / Get-NetTCPConnection / 事件日志 / 配置读取这类只读命令；装工具、改配置、改权限必须先说明影响并取得确认。',
            '证据链：每条结论附「命令原文 + 关键输出行 + 时间」；无法验证的写「待确认」，不写推测当结论。',
            '凭据红线：不读取、不回显、不落盘口令/令牌/密钥；发现明文凭据只报「位置 + 类型 + 建议轮换」。',
            '处置顺序：风险 → 影响面 → 修复建议 → 回滚方式；动生产配置前先备份并留恢复步骤。',
            '结论要区分「已确认」与「未排查」：没查的项写清楚没查，不默认安全。',
        ],
        pitfalls: [
            '为「先止血」直接删文件/停服务，扩大影响面。',
            '把一次失败的扫描（超时、被拦）当成「没有漏洞」。',
            '报告里贴出完整密钥、内网拓扑或用户隐私数据。',
            '用带写操作的命令做诊断（改注册表、重置 ACL）。',
        ],
        toolHints: {
            exec_command: '诊断命令只用只读动词；输出用 Select-Object -First N / Measure-Object 控制体积，别把整份日志读进上下文。',
            process_list: '先看有主窗口的进程；要全量与命令行参数时配合 exec_command 的 Get-CimInstance Win32_Process 过滤。',
            read_file: '读配置/日志只取需要的片段（offset + max_bytes），避免把整份含敏感字段的文件读进上下文。',
            append_work_notes: '只沉淀「可复用的排查命令与判断口径」，不要记具体凭据、内网地址或主机名。',
        },
    },
];
export const SCENE_IDS = SCENES.map((s) => s.id);
/** 默认场景：行为与「没有场景功能」时一致（既不注入指引，也不增强工具描述）。 */
export const DEFAULT_SCENE = 'general';
export function isSceneId(value) {
    return typeof value === 'string' && SCENE_IDS.indexOf(value.trim().toLowerCase()) >= 0;
}
/** 宽松取值：未知 id 一律回落到默认档，调用方不需要处理异常。 */
export function getScene(id) {
    const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
    return SCENES.find((s) => s.id === key) || SCENES[0];
}
/**
 * 场景指引块：拼进请求的动态 system 消息最前面。
 * `enabled=false` 或默认档时返回空串 —— 此时提示词与「没有本功能」逐字节一致。
 */
export function sceneGuideBlock(id, enabled = true) {
    if (!enabled)
        return '';
    const scene = getScene(id);
    if (scene.id === DEFAULT_SCENE)
        return '';
    const lines = [];
    lines.push('## 当前工具场景：' + scene.label);
    lines.push(scene.tagline);
    if (scene.tools.length > 0)
        lines.push('- 推荐工具链：' + scene.tools.join(' → '));
    if (scene.rules.length > 0) {
        lines.push('- 操作要点：');
        for (const rule of scene.rules)
            lines.push('  - ' + rule);
    }
    if (scene.pitfalls.length > 0) {
        lines.push('- 常见失效：');
        for (const item of scene.pitfalls)
            lines.push('  - ' + item);
    }
    lines.push('- 任务性质变了（例如从写代码转成操作界面）就用 set_scene 切换场景，不要硬套当前档的工具栈。');
    return lines.join('\n');
}
/** 工具级提示：默认档或未命中时返回空串。 */
export function sceneToolHint(id, toolName) {
    const scene = getScene(id);
    if (scene.id === DEFAULT_SCENE)
        return '';
    return scene.toolHints[toolName] || '';
}
/** 工具描述增强：命中场景提示时在描述末尾追加一段，否则原样返回。 */
export function enhanceToolDescription(id, toolName, description) {
    const hint = sceneToolHint(id, toolName);
    if (!hint)
        return description;
    return description + '\n【' + getScene(id).label + '场景】' + hint;
}
/** 设置面板下拉选项（中文名 + 一句话定位写进 hint，避免用户不知道各档差别）。 */
export function sceneSelectOptions() {
    return SCENES.map((s) => ({ value: s.id, label: s.label, hint: s.tagline }));
}
//# sourceMappingURL=scenes.js.map