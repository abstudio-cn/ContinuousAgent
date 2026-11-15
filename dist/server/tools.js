import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { NOTES_MAX_CHARS, TIP_MAX_CHARS } from '../shared/prompt.js';
import { WorkNotesService, WorkRecordService } from './record.js';
import { ensureDir, isInsideWorkspace, normalizePath, stamp } from './paths.js';
import { ChangedBackupStore } from './backup.js';
function err(msg) {
    return { text: msg, isError: true };
}
function ok(msg, display) {
    return { text: msg, isError: false, display };
}
/**
 * 字面量片段替换：只替换第一处，返回新文本与命中次数。
 *
 * 为什么不用 String.prototype.replace(片段, 新文本)：新文本会被当作替换模式解析，
 * 其中「美元符 + and 符号」「美元符 + 反引号」「美元符 + 单引号」「美元符 + 数字」等组合
 * 会被展开成匹配内容或匹配点之后的全文，把原文整段复制进结果（曾把 1300 行的文件写成一式两份）。
 * 这里用 indexOf/slice 拼接，替换文本永远逐字插入。
 */
function replaceLiteralOnce(haystack, find, replacement) {
    // 空片段会让 indexOf 原地踏步成死循环，直接原样返回
    if (!find)
        return { text: haystack, count: 0 };
    const first = haystack.indexOf(find);
    if (first < 0)
        return { text: haystack, count: 0 };
    let count = 0;
    let at = 0;
    while ((at = haystack.indexOf(find, at)) >= 0) {
        count++;
        at += find.length;
    }
    return { text: haystack.slice(0, first) + replacement + haystack.slice(first + find.length), count };
}
/** 字面量片段替换：替换全部匹配处（replace_all 用）。 */
function replaceLiteralAll(haystack, find, replacement) {
    if (!find)
        return { text: haystack, count: 0 };
    const parts = haystack.split(find);
    return { text: parts.join(replacement), count: parts.length - 1 };
}
function asString(v) {
    return typeof v === 'string' ? v : undefined;
}
function asInt(v, def) {
    if (typeof v === 'number' && Number.isFinite(v))
        return Math.trunc(v);
    if (typeof v === 'string') {
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n))
            return n;
    }
    return def;
}
/** 把模型给的标题清洗成单行短标题：去引号/井号/列表符，压缩空白，最多 24 字。 */
/** 把模型给的标题清洗成单行短标题：去 markdown 强调符与引号，压缩空白，最多 24 字。 */
function cleanSessionTitle(raw) {
    let s = String(raw || '')
        .replace(/\r?\n/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^[\s>#\-+•\d.、)（(]+/, '')
        .replace(/[*~`]+/g, '')
        .replace(/["'“”‘’]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    s = s.replace(/^[\s:：,，、;；]+/, '').replace(/[。！？；，、:：\s]+$/g, '').trim();
    return Array.from(s).slice(0, 24).join('').trim();
}
function asBool(v, def) {
    if (typeof v === 'boolean')
        return v;
    if (typeof v === 'string')
        return v.toLowerCase() === 'true';
    return def;
}
function looksBinary(buf) {
    const n = Math.min(buf.length, 4096);
    for (let i = 0; i < n; i++)
        if (buf[i] === 0)
            return true;
    return false;
}
function truncate(s, n) {
    return s.length <= n ? s : s.slice(0, n) + '…';
}
/** PowerShell 单引号字符串转义。 */
function psQuote(s) {
    return "'" + String(s).replace(/'/g, "''") + "'";
}
/** HTML → 纯文本（保留段落与链接文本，去掉脚本与样式）。 */
function htmlToText(html) {
    let s = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, ' ');
    s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
    return s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}
/** 启动子进程并收集输出（输出上限 512KB，超时或中断会 kill）。 */
/** 单个子进程的实时句柄：结束前也能读当前输出，可强杀整棵进程树。 */
class Proc {
    child = null;
    outText = '';
    errText = '';
    done = false;
    code = null;
    timedOut = false;
    truncated = false;
    result;
    constructor(cmd, args, opts = {}) {
        let resolveResult = () => { };
        this.result = new Promise((res) => {
            resolveResult = res;
        });
        const outDecoder = new StringDecoder('utf8');
        const errDecoder = new StringDecoder('utf8');
        const limit = 512 * 1024;
        let outBytes = 0;
        let errBytes = 0;
        let timer = null;
        let onAbort = null;
        const finish = (code, extra = '') => {
            if (this.done)
                return;
            this.done = true;
            this.code = code;
            if (timer)
                clearTimeout(timer);
            if (opts.signal && onAbort)
                opts.signal.removeEventListener('abort', onAbort);
            if (!this.truncated) {
                this.outText += outDecoder.end();
                this.errText += errDecoder.end();
            }
            resolveResult({ code, stdout: this.outText, stderr: this.errText + extra, timedOut: this.timedOut });
        };
        onAbort = () => this.killTree();
        try {
            this.child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        }
        catch (e) {
            this.done = true;
            this.code = -1;
            resolveResult({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false });
            return;
        }
        const child = this.child;
        timer = setTimeout(() => {
            this.timedOut = true;
            this.killTree();
        }, Math.max(1000, opts.timeoutMs ?? 60_000));
        if (opts.signal) {
            if (opts.signal.aborted)
                onAbort();
            else
                opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        child.stdout?.on('data', (b) => {
            if (outBytes >= limit) {
                this.truncated = true;
                return;
            }
            outBytes += b.length;
            this.outText += outDecoder.write(b);
        });
        child.stderr?.on('data', (b) => {
            if (errBytes >= limit)
                return;
            errBytes += b.length;
            this.errText += errDecoder.write(b);
        });
        child.on('error', (e) => finish(-1, '\n' + e.message));
        child.on('close', (code) => finish(code ?? 0));
        try {
            if (opts.stdin !== undefined)
                child.stdin?.write(opts.stdin);
            child.stdin?.end();
        }
        catch {
            /* ignore */
        }
    }
    /** 强杀整棵进程树：Windows 用 taskkill /T /F，其他平台 SIGKILL。 */
    killTree() {
        const child = this.child;
        if (!child || this.done)
            return;
        if (process.platform === 'win32' && child.pid) {
            try {
                spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            }
            catch {
                /* ignore */
            }
        }
        try {
            child.kill('SIGKILL');
        }
        catch {
            /* ignore */
        }
    }
}
/** 启动子进程并收集输出（结束才返回；调用方也可以直接用 Proc 拿实时句柄）。 */
function runProcess(cmd, args, opts = {}) {
    return new Proc(cmd, args, opts).result;
}
/** 解析多行路径列表（忽略空行与注释）。 */
function parsePathList(raw) {
    return (raw || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'))
        .map((s) => normalizePath(s));
}
/** 同时运行的后台任务上限与已完成任务保留数。 */
const MAX_RUNNING_JOBS = 12;
const KEEP_FINISHED_JOBS = 10;
export class ToolExecutor {
    settings;
    native;
    tips;
    targetInfo = null;
    origin = { hwnd: '', x: 0, y: 0, at: 0 };
    session = { id: '', title: '', recordPath: '', notesPath: '' };
    /** 本会话已授权的额外可写目录（由外层按会话注入并持久化）。 */
    grantedPaths = [];
    /** 本会话已授权的额外可读目录（仅在「读取申请（严格模式）」开启时生效）。 */
    readGrantedPaths = [];
    broker = null;
    /** 插件注册表：null 表示插件系统未接线（此时插件工具一律不存在）。 */
    plugins = null;
    /**
     * 插件调用审计代理：每次插件执行前都要经过它拿到用户确认。
     * 没有它（例如没有界面连接）时插件一律拒绝执行——审计不可绕过。
     */
    pluginAuditor = null;
    /** 会话改名回调：由外层注入（写 SessionStore 并广播），供模型在收尾时给会话命名。 */
    sessionRenamer = null;
    /** 后台命令任务（background / wait_ms 转后台），键为 exec-N。 */
    jobs = new Map();
    jobSeq = 0;
    /** 改动前备份（目录由工作空间解析，故不占用构造参数）。 */
    backupsStore = null;
    constructor(settings, native, 
    /** 跨会话共享的全局技巧库（脱敏、频次与容量淘汰封装在 GlobalTipsStore 内）。 */
    tips) {
        this.settings = settings;
        this.native = native;
        this.tips = tips;
    }
    /** 改动前备份存储：懒加载，目录跟随当前工作空间设置。 */
    get backups() {
        if (!this.backupsStore)
            this.backupsStore = new ChangedBackupStore(() => this.settings);
        return this.backupsStore;
    }
    /** 备份成功时的统一提示后缀（没有备份则空串）。 */
    backupNote(entry) {
        return entry ? '，原文件已备份为 changed_backup/' + entry.id : '';
    }
    /** 注册目录授权代理；没有 UI 连接时为 null。 */
    setAccessBroker(broker) {
        this.broker = broker;
    }
    /** 注册会话改名回调；返回最终标题，会话不存在时返回 null。 */
    setSessionRenamer(fn) {
        this.sessionRenamer = fn;
    }
    /** 覆盖本会话的授权白名单。 */
    setGrants(paths) {
        this.grantedPaths = paths.map((p) => normalizePath(p)).filter((p) => !!p);
    }
    get grants() {
        return [...this.grantedPaths];
    }
    addGrant(target) {
        const p = normalizePath(target);
        if (!p)
            return;
        if (!this.grantedPaths.some((g) => g.toLowerCase() === p.toLowerCase()))
            this.grantedPaths.push(p);
    }
    setReadGrants(paths) {
        this.readGrantedPaths = paths.map((p) => normalizePath(p)).filter((p) => !!p);
    }
    get readGrants() {
        return [...this.readGrantedPaths];
    }
    addReadGrant(target) {
        const p = normalizePath(target);
        if (!p)
            return;
        if (!this.readGrantedPaths.some((g) => g.toLowerCase() === p.toLowerCase()))
            this.readGrantedPaths.push(p);
    }
    /** 写权限判定：工作空间、设置里的永久白名单、本会话已授权目录。 */
    isWritable(target) {
        if (!target)
            return false;
        if (isInsideWorkspace(target, this.settings.workspacePath))
            return true;
        const extra = parsePathList(this.settings.extraWritePaths);
        for (const root of [...extra, ...this.grantedPaths]) {
            if (root && isInsideWorkspace(target, root))
                return true;
        }
        return false;
    }
    /** 读权限判定：严格模式关闭时任意路径可读；开启后限工作空间、永久可读白名单、本会话已授权目录。 */
    isReadable(target) {
        if (!target)
            return false;
        if (!this.settings.strictReadMode)
            return true;
        if (isInsideWorkspace(target, this.settings.workspacePath))
            return true;
        const extra = parsePathList(this.settings.extraReadPaths);
        for (const root of [...extra, ...this.readGrantedPaths]) {
            if (root && isInsideWorkspace(target, root))
                return true;
        }
        return false;
    }
    /** 读取被严格模式拦下时的统一错误文案。 */
    readDenied(target) {
        return err('严格读取模式：' + target + ' 不在工作空间或已授权可读目录内。请先调用 request_read_access 申请（用户确认后本会话有效），或在正文说明需要用户手动放行。');
    }
    /** 绑定当前会话：记录与笔记按会话路径读写，实现隔离。 */
    bindSession(session) {
        this.session = session;
    }
    get sessionId() {
        return this.session.id;
    }
    get record() {
        return new WorkRecordService(this.session.recordPath, this.settings.workspacePath);
    }
    get notes() {
        return new WorkNotesService(this.session.notesPath, this.settings.workspacePath);
    }
    updateSettings(settings) {
        this.settings = settings;
        this.origin.at = 0;
    }
    get target() {
        return this.targetInfo;
    }
    async selectWindow(pid, titleContains, activate = true) {
        if (!this.native.available)
            return null;
        let win;
        if (pid > 0) {
            const list = await this.native.listWindows();
            win = list.find((w) => Number(w.pid) === pid);
        }
        if (!win && titleContains) {
            const list = await this.native.listWindows();
            win = list.find((w) => (w.title || '').toLowerCase().includes(titleContains.toLowerCase()));
        }
        if (!win)
            return null;
        const target = {
            pid: Number(win.pid),
            hwnd: String(win.hwnd),
            title: win.title,
            processName: win.processName,
            width: Number(win.width),
            height: Number(win.height),
        };
        this.targetInfo = target;
        // activate=false：只选定、不抢前台，供多会话并行时使用
        if (activate)
            await this.native.activate(target.hwnd).catch(() => false);
        const info = await this.native.windowInfo(target.hwnd).catch(() => null);
        if (info) {
            target.width = Number(info.width) || target.width;
            target.height = Number(info.height) || target.height;
            target.title = info.title || target.title;
        }
        return target;
    }
    setTarget(target) {
        this.targetInfo = target;
    }
    clearWindow() {
        this.targetInfo = null;
    }
    runtimeContext(notesLength) {
        const s = this.settings;
        const lines = [];
        lines.push('- 当前会话: ' + (this.session.title || '(未命名)') + '（各会话的工作记录与笔记互相隔离）');
        lines.push('- 工作空间（唯一允许写入的目录）: ' + s.workspacePath);
        lines.push('- 工作记录文件: ' + this.record.recordPath);
        lines.push('- 工作笔记文件: ' + this.notes.notesPath + '（长期知识库，上限 ' + NOTES_MAX_CHARS +
            ' 字符，当前 ' + (notesLength ?? this.notes.currentLength) + ' 字符）');
        const tipStats = this.tips.stats();
        lines.push(s.globalTipsEnabled
            ? '- 全局技巧库: 已启用（跨会话共享，' + tipStats.count + ' 条 / ' + tipStats.chars + '/' + tipStats.max +
                ' 字符；已附在本请求末尾）'
            : '- 全局技巧库: 用户已在设置中关闭，本次请求不附带（仍可用 global_tips 读写，但内容不会注入提示词）');
        if (s.gameSavePath)
            lines.push('- 用户提供的存档路径提示: ' + s.gameSavePath);
        if (!this.native.available) {
            lines.push('- 原生控制不可用: ' + this.native.detail);
            lines.push('- 因此 screenshot / OCR / 鼠标 / 键盘 / 窗口工具都会失败；改用文件、命令、网页与记录工具，并在正文中说明受限原因。');
        }
        else if (this.targetInfo) {
            const t = this.targetInfo;
            lines.push('- 目标窗口: PID=' + t.pid + ' | ' + t.processName + ' | ' + t.title);
            lines.push('- 客户区尺寸: ' + t.width + 'x' + t.height + '（坐标范围 0..' + Math.max(0, t.width - 1) +
                ', 0..' + Math.max(0, t.height - 1) + '）');
            lines.push('- 鼠标/键盘/OCR 坐标均使用客户区坐标（左上角为 0,0），不需要考虑屏幕位置。');
        }
        else {
            lines.push('- 尚未选择目标窗口。请先调用 list_windows，再用 select_window 选择。');
        }
        if (!s.sendScreenshots) {
            lines.push('- 当前会话不发送截图图像：请使用 ocr 读取画面文字；screenshot 只返回窗口尺寸等元信息，不要依赖其视觉内容。');
        }
        if (this.native.available) {
            lines.push('- 多会话并行或不想切窗口时用 screenshot_background 观察目标窗口：它只走 PrintWindow，不激活、不改前后台与叠放顺序，被遮挡也能拿到窗口自己的画面；screenshot 在窗口被遮挡时可能抓到上层窗口的画面。');
        }
        lines.push(s.continuousMode
            ? '- 运行模式：持续托管。完成一轮后会自动继续。'
            : '- 运行模式：单轮任务。完成用户本次要求后立即输出最终答复并停止；不要再调用工具、不要自行继续观察。');
        lines.push('- 中断由用户在网页上点击“中断运行”，你不需要也不应该模拟它。');
        lines.push('- 通用工具：exec_command（PowerShell 命令；支持 background / wait_ms 后台运行）、exec_output / exec_kill（取后台输出、终止任务）、read_file / list_directory / find_files / search_files（只读）、write_file / edit_file / apply_patch（仅工作空间可写）、web_fetch、clipboard_read / clipboard_write、process_list、view_image、launch_app、wait。');
        lines.push(s.allowShell
            ? '- shell 已启用：exec_command 默认在工作空间执行，单条超时 ' + Math.round(s.shellTimeoutMs / 1000) + ' 秒。'
            : '- shell 已禁用：不要调用 exec_command。');
        if (s.allowShell)
            lines.push('- 长命令不要死等：background=true 立即拿回任务 ID 继续做下一件事；或 wait_ms 限时等（到期自动转后台，不中断）。之后用 exec_output {job_id, wait_ms} 取增量输出，exec_kill 终止。');
        ;
        const grants = this.grantedPaths;
        lines.push(grants.length > 0
            ? '- 本会话额外可写目录（用户已授权）: ' + grants.join('、')
            : '- 本会话没有额外可写目录。若确实需要修改工作空间外的文件，先调用 request_write_access 申请一次（用户确认后本会话有效），不要直接尝试写入。');
        if (s.strictReadMode) {
            const rg = this.readGrantedPaths;
            lines.push('- 读取申请（严格模式）已开启：读取工作空间外的路径（read_file / list_directory / find_files / search_files / view_image）前先调用 request_read_access 申请，用户确认后本会话有效。本会话已授权可读: ' +
                (rg.length > 0 ? rg.join('、') : '（暂无）') +
                '。注意 exec_command 以当前用户身份执行，本模式不拦截 shell 的读取。');
        }
        if (s.pluginsEnabled) {
            // 只有开启插件时才多这一段：关闭时提示词与没有插件功能时逐字一致。
            let pluginLine = "";
            try {
                const available = this.plugins ? this.plugins.availableToolCount : 0;
                pluginLine = available > 0
                    ? '- 插件：已启用（' + available + ' 个插件工具，名称以 ' + 'plugin__ 开头）。每个插件工具在被执行前都会弹出审计卡片，展示插件用途并等用户确认；用户拒绝/超时就不要反复重试，改在正文说明。'
                    : '- 插件：已在设置中启用，但插件目录里没有可用插件（缺 plugin.json、缺 purpose、清单错误或未启用）。不要编造插件工具名。';
            }
            catch {
                pluginLine = '- 插件：读取插件清单失败，本次不要调用任何 plugin__ 工具。';
            }
            lines.push(pluginLine);
        }
        if (!s.allowLaunch)
            lines.push('- 启动程序已禁用：不要调用 launch_app。');
        return lines.join('\n') + '\n';
    }
    /** 注册插件注册表（null = 关闭插件系统）。 */
    setPluginRegistry(registry) {
        this.plugins = registry;
    }
    /** 注册插件审计代理（由外层 HTTP/UI 实现“问用户一次”）。 */
    setPluginAuditor(fn) {
        this.pluginAuditor = fn;
    }
    /**
     * 工具清单 = 核心工具 + 插件工具。
     * 插件关闭或出任何异常时都回退成纯核心清单：核心永远不因插件而少一个工具。
     */
    catalog() {
        const core = buildToolCatalog();
        try {
            if (!this.settings.pluginsEnabled || !this.plugins)
                return core;
            const extra = this.plugins.toolSpecs();
            return extra.length > 0 ? core.concat(extra) : core;
        }
        catch {
            return core;
        }
    }
    async execute(name, argsJson, signal) {
        let args;
        try {
            const parsed = argsJson && argsJson.trim() ? JSON.parse(argsJson) : {};
            args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        }
        catch (e) {
            return err('工具参数不是合法 JSON: ' + (e instanceof Error ? e.message : String(e)) + '\n原始内容: ' + argsJson);
        }
        try {
            switch (name) {
                case 'list_windows': return await this.listWindows();
                case 'select_window': return await this.selectWindowTool(args);
                case 'select_game_window': return await this.selectWindowTool(args);
                case 'get_window_info': return await this.getWindowInfo();
                case 'screenshot': return await this.screenshot(args);
                case 'screenshot_background': return await this.screenshotBackground(args);
                case 'mouse_move': return await this.mouseMove(args);
                case 'mouse_click': return await this.mouseClick(args);
                case 'mouse_drag': return await this.mouseDrag(args);
                case 'scroll': return await this.scroll(args);
                case 'key_press': return await this.keyPress(args);
                case 'key_down': return await this.keyDown(args);
                case 'key_up': return await this.keyUp(args);
                case 'type_text': return await this.typeText(args);
                case 'ocr': return await this.ocr(args, signal);
                case 'read_file': return this.readFile(args);
                case 'list_directory': return this.listDirectory(args);
                case 'find_files': return this.findFiles(args, signal);
                case 'write_file': return this.writeFile(args);
                case 'delete_path': return this.deletePath(args);
                case 'update_work_record': return this.updateRecord(args);
                case 'read_work_record': return this.readRecord();
                case 'update_work_notes': return this.updateNotes(args);
                case 'append_work_notes': return this.appendNotes(args);
                case 'read_work_notes': return this.readNotes();
                case 'rename_session': return this.renameSessionTool(args);
                case 'global_tips': return this.globalTipsTool(args);
                // 兼容旧会话历史里的工具名
                case 'update_game_record': return this.updateRecord(args);
                case 'read_game_record': return this.readRecord();
                case 'update_game_notes': return this.updateNotes(args);
                case 'append_game_notes': return this.appendNotes(args);
                case 'read_game_notes': return this.readNotes();
                case 'get_environment': return await this.getEnvironment();
                case 'wait': return await this.wait(args, signal);
                // ---- OpenClaw 对齐工具 ----
                case 'exec_command': return await this.execCommand(args, signal);
                case 'exec_output': return await this.execOutput(args, signal);
                case 'exec_kill': return this.execKill(args);
                case 'web_fetch': return await this.webFetch(args, signal);
                case 'edit_file': return this.editFile(args);
                case 'apply_patch': return this.applyPatch(args);
                case 'changed_backup': return this.changedBackupTool(args);
                case 'search_files': return this.searchFiles(args, signal);
                case 'clipboard_read': return await this.clipboardRead();
                case 'clipboard_write': return await this.clipboardWrite(args);
                case 'launch_app': return await this.launchApp(args);
                case 'process_list': return await this.processList(args);
                case 'view_image': return this.viewImage(args);
                case 'request_write_access': return await this.requestWriteAccess(args);
                case 'request_read_access': return await this.requestReadAccess(args);
                default: return await this.executePluginTool(name, args, signal);
            }
        }
        catch (e) {
            if (signal.aborted)
                throw e;
            return err(name + ' 执行失败: ' + (e instanceof Error ? e.message : String(e)));
        }
    }
    /**
     * 插件工具的执行入口：审计 -> 执行。
     * 整段包在 try/catch 里，任何异常都只变成一条错误结果，绝不冒泡到 agent 主循环。
     */
    async executePluginTool(name, args, signal) {
        const registry = this.plugins;
        if (!this.settings.pluginsEnabled || !registry)
            return err('未知工具: ' + name);
        const found = registry.find(name);
        if (!found)
            return err('未知工具: ' + name);
        const { plugin, tool } = found;
        const label = plugin.name + ' / ' + tool.localName;
        // 审计不可绕过：没有确认界面就直接拒绝
        if (!this.pluginAuditor) {
            return err('插件「' + label + '」需要用户审计确认后才能执行，但当前没有可用的确认界面，已拒绝执行。');
        }
        const preview = registry.preview(plugin, tool, args);
        if (preview.error)
            return err('插件「' + label + '」参数不合法：' + preview.error);
        let allowed = false;
        try {
            allowed = await this.pluginAuditor({
                pluginId: plugin.id,
                pluginName: plugin.name,
                version: plugin.version,
                purpose: tool.purpose || plugin.purpose,
                tool: tool.localName,
                argsJson: safeJson(args),
                command: preview.command,
                dir: plugin.dir,
            });
        }
        catch (e) {
            if (signal.aborted)
                throw e;
            return err('插件「' + label + '」审计流程出错，已拒绝执行：' + (e instanceof Error ? e.message : String(e)));
        }
        if (!allowed) {
            return err('用户未批准本次插件调用（插件「' + label + '」，用途：' + (tool.purpose || plugin.purpose) + '），未执行。不要重试，改在正文说明需要用户手动执行。');
        }
        let out;
        try {
            out = await registry.run(plugin, tool, args, signal);
        }
        catch (e) {
            if (signal.aborted)
                throw e;
            return err('插件「' + label + '」执行异常（已隔离，不影响其它功能）：' + (e instanceof Error ? e.message : String(e)));
        }
        if (out.error)
            return err('插件「' + label + '」未能执行：' + out.error);
        const head = [
            '插件「' + plugin.name + (plugin.version ? ' v' + plugin.version : '') + '」工具 ' + tool.localName,
            '用途：' + (tool.purpose || plugin.purpose),
            '命令：' + out.command,
            '退出码：' + out.code + (out.timedOut ? '（已超时，进程树已终止）' : '') + ' · 耗时 ' + out.ms + 'ms',
        ];
        const parts = [head.join('\n')];
        const stdout = (out.stdout || '').replace(/\s+$/, '');
        const stderr = (out.stderr || '').replace(/\s+$/, '');
        if (stdout)
            parts.push('--- stdout ---\n' + stdout);
        if (stderr)
            parts.push('--- stderr ---\n' + stderr);
        if (out.truncated)
            parts.push('（输出超过上限已截断）');
        if (!stdout && !stderr)
            parts.push('（没有输出）');
        const text = parts.join('\n');
        return { text, isError: !out.ok, display: plugin.name + ' · ' + tool.localName };
    }
    requireNative() {
        if (!this.native.available) {
            return '原生控制不可用：' + this.native.detail + '。请改用文件/记录/笔记工具。';
        }
        return null;
    }
    /** 客户区 (0,0) 在屏幕上的位置：原生层换算并缓存 5 秒。 */
    async toScreen(cx, cy) {
        const t = this.targetInfo;
        if (!t)
            return { x: cx, y: cy };
        if (this.origin.hwnd !== t.hwnd || Date.now() - this.origin.at > 5000) {
            try {
                const o = await this.native.request('client-origin', { hwnd: t.hwnd }, 10_000);
                this.origin = { hwnd: t.hwnd, x: Number(o.x) || 0, y: Number(o.y) || 0, at: Date.now() };
            }
            catch {
                this.origin = { hwnd: t.hwnd, x: 0, y: 0, at: Date.now() };
            }
        }
        return { x: this.origin.x + cx, y: this.origin.y + cy };
    }
    async listWindows() {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        const list = await this.native.listWindows();
        if (list.length === 0)
            return ok('没有找到可见窗口。');
        const lines = ['可见窗口列表（pid | 进程 | 标题 | 客户区）：'];
        for (const w of list) {
            const mark = this.targetInfo && String(w.hwnd) === this.targetInfo.hwnd ? '  ← 当前目标' : '';
            lines.push('- pid=' + w.pid + ' | ' + w.processName + ' | ' + truncate(w.title || '', 90) +
                ' | ' + w.width + 'x' + w.height + (w.isForeground ? ' | 前台' : '') + mark);
        }
        return ok(lines.join('\n'), list.length + ' 个可见窗口');
    }
    async selectWindowTool(args) {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        const pid = asInt(args.pid, 0);
        const title = asString(args.title_contains);
        const activate = asBool(args.activate, true);
        const target = await this.selectWindow(pid, title, activate);
        if (!target)
            return err('未找到匹配的窗口。请调用 list_windows 查看 pid 与标题。');
        return ok('已选择窗口: PID=' + target.pid + ' | ' + target.processName + ' | ' + target.title +
            '\n客户区 ' + target.width + 'x' + target.height +
            (activate ? '，已尝试置于前台。' : '，未激活窗口（保持原前后台，适合多会话并行）。'), 'PID ' + target.pid + ' · ' + target.processName);
    }
    async getWindowInfo() {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        if (!this.targetInfo)
            return err('尚未选择有效窗口。');
        const info = await this.native.windowInfo(this.targetInfo.hwnd);
        this.targetInfo.width = Number(info.width) || this.targetInfo.width;
        this.targetInfo.height = Number(info.height) || this.targetInfo.height;
        return ok('PID=' + info.pid + '\n进程=' + info.processName + '\n标题=' + info.title +
            '\n客户区=' + info.width + 'x' + info.height +
            '\n是否前台=' + (info.isForeground ? '是' : '否') +
            '\n当前坐标基准=客户区左上角 (0,0)');
    }
    async screenshot(args) {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        const t = this.targetInfo;
        if (!t)
            return err('尚未选择窗口，无法截图。请先 list_windows + select_window。');
        const maxW = Math.min(1280, Math.max(320, asInt(args.max_width, this.settings.maxScreenshotWidth)));
        const shot = await this.native.capture(t.hwnd, maxW, 'jpeg');
        if (!shot.buffer.length)
            return err('截图失败（窗口可能最小化或不支持捕获）。');
        this.targetInfo = { ...t, width: shot.clientWidth || t.width, height: shot.clientHeight || t.height };
        const text = '截图已捕获。窗口客户区 ' + this.targetInfo.width + 'x' + this.targetInfo.height +
            '，图像 ' + shot.width + 'x' + shot.height +
            '。 操作坐标请使用客户区坐标 0..' + (this.targetInfo.width - 1) + ' / 0..' + (this.targetInfo.height - 1) +
            '，截图为缩放观察用。';
        if (!this.settings.sendScreenshots) {
            return ok(text + '\n（当前会话不发送截图图像；请改用 ocr 读取画面文字，并结合窗口信息判断。）', '截图（未发送）');
        }
        const b64 = shot.buffer.toString('base64');
        return { text, images: [b64], isError: false, display: '截图（JPEG ' + shot.width + 'x' + shot.height + '）' };
    }
    /**
     * 后台截图：只走 PrintWindow 抽目标窗口自身画面，不激活窗口、不改前后台与 z 序。
     * 多会话并行时的安全观察手段；被遮挡的窗口也能拿到它自己的内容。
     */
    async screenshotBackground(args) {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        // 目标：显式 hwnd/pid/title 优先（只读解析，不 activate、不改 targetInfo）
        const hwndArg = asString(args.hwnd);
        const pid = asInt(args.pid, 0);
        const title = asString(args.title_contains);
        let hwnd = hwndArg && /^\d+$/.test(hwndArg.trim()) ? hwndArg.trim() : '';
        let label = '';
        if (!hwnd && (pid > 0 || title)) {
            const list = await this.native.listWindows();
            const win = pid > 0
                ? list.find((w) => Number(w.pid) === pid)
                : list.find((w) => (w.title || '').toLowerCase().includes(String(title).toLowerCase()));
            if (!win)
                return err('未找到匹配的窗口。请调用 list_windows 查看 pid、hwnd 与标题。');
            hwnd = String(win.hwnd);
            label = 'PID=' + win.pid + ' | ' + win.processName + ' | ' + win.title + '\n';
        }
        if (!hwnd) {
            const t = this.targetInfo;
            if (!t)
                return err('尚未选择窗口。请先 list_windows + select_window，或用 pid / hwnd / title_contains 直接指定。');
            hwnd = t.hwnd;
            label = 'PID=' + t.pid + ' | ' + t.processName + ' | ' + t.title + '\n';
        }
        const maxW = Math.min(1280, Math.max(320, asInt(args.max_width, this.settings.maxScreenshotWidth)));
        const shot = await this.native.captureBackground(hwnd, maxW, 'jpeg');
        if (!shot.buffer.length)
            return err('后台截图失败：没有拿到图像数据。');
        if (shot.blank) {
            return err('后台截图疑似纯色空白：目标窗口可能已最小化或该程序不支持后台渲染（PrintWindow）。\n' +
                '可先用 get_window_info 确认状态；确实需要画面时改用 screenshot（会激活窗口，可能影响其它会话）。');
        }
        const text = '后台截图完成（PrintWindow：未激活窗口、未改变前后台与叠放顺序）。\n' + label +
            '客户区 ' + (shot.clientWidth || 0) + 'x' + (shot.clientHeight || 0) +
            '，图像 ' + shot.width + 'x' + shot.height + '\n' +
            '状态: 前台=' + (shot.isForeground ? '是' : '否') +
            ' · 被遮挡=' + (shot.occluded ? '是' : '否') +
            ' · 最小化=' + (shot.minimized ? '是' : '否') + '\n' +
            '坐标基准仍是该窗口客户区左上角 (0,0)；截图仅用于观察。';
        if (!this.settings.sendScreenshots) {
            return ok(text + '\n（当前会话不发送截图图像；请改用 ocr 读取画面文字。）', '后台截图（未发送）');
        }
        return { text, images: [shot.buffer.toString('base64')], isError: false, display: '后台截图（JPEG ' + shot.width + 'x' + shot.height + '）' };
    }
    async mouseMove(args) {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        const x = asInt(args.x, 0), y = asInt(args.y, 0);
        const p = await this.toScreen(x, y);
        await this.native.request('mouse-move', { x: p.x, y: p.y }, 15_000);
        return ok('鼠标已移动到客户区 (' + x + ', ' + y + ')。');
    }
    async mouseClick(args) {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        const hasXY = args.x !== undefined && args.y !== undefined;
        const button = (asString(args.button) || 'left').toLowerCase();
        const count = Math.min(3, Math.max(1, asInt(args.count, 1)));
        const hold = Math.min(3000, Math.max(10, asInt(args.hold_ms, 45)));
        if (hasXY) {
            const x = asInt(args.x, 0), y = asInt(args.y, 0);
            const p = await this.toScreen(x, y);
            await this.native.request('mouse-click', { x: p.x, y: p.y, button, count, holdMs: hold }, 30_000);
            return ok('已在客户区 (' + x + ',' + y + ') 执行 ' + button + ' 点击 x' + count + '。');
        }
        await this.native.request('mouse-click', { button, count, holdMs: hold }, 30_000);
        return ok('已在当前鼠标位置执行 ' + button + ' 点击 x' + count + '。');
    }
    async mouseDrag(args) {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        const x1 = asInt(args.x1, 0), y1 = asInt(args.y1, 0);
        const x2 = asInt(args.x2, 0), y2 = asInt(args.y2, 0);
        const button = (asString(args.button) || 'left').toLowerCase();
        const steps = Math.min(120, Math.max(4, asInt(args.steps, 24)));
        const p1 = await this.toScreen(x1, y1);
        const p2 = await this.toScreen(x2, y2);
        await this.native.request('mouse-drag', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, button, steps }, 60_000);
        return ok('已从客户区 (' + x1 + ',' + y1 + ') 拖拽到 (' + x2 + ',' + y2 + ')。');
    }
    async scroll(args) {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        if (args.x !== undefined && args.y !== undefined) {
            const p = await this.toScreen(asInt(args.x, 0), asInt(args.y, 0));
            await this.native.request('mouse-move', { x: p.x, y: p.y }, 15_000);
        }
        const delta = Math.min(30, Math.max(-30, asInt(args.delta, 3)));
        const horizontal = asBool(args.horizontal, false);
        await this.native.request('scroll', { delta, horizontal }, 20_000);
        return ok('已滚动 ' + (delta > 0 ? '上/右' : '下/左') + ' ' + Math.abs(delta) + ' 格。');
    }
    async keyPress(args) {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        const keys = asString(args.keys) || '';
        if (!keys.trim())
            return err('缺少 keys，例如 "ctrl+shift+a" 或 "enter"。');
        const hold = Math.min(10_000, Math.max(0, asInt(args.hold_ms, 0)));
        await this.native.request('keys', { action: 'press', keys, holdMs: hold }, 30_000);
        return ok(hold > 0 ? '已按住 ' + keys + ' ' + hold + 'ms 后释放。' : '已发送按键: ' + keys);
    }
    async keyDown(args) {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        const keys = asString(args.keys) || '';
        if (!keys.trim())
            return err('缺少 keys。');
        await this.native.request('keys', { action: 'down', keys }, 15_000);
        return ok('已按下并保持: ' + keys + '（记得稍后调用 key_up 释放）。');
    }
    async keyUp(args) {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        const keys = asString(args.keys) || '';
        if (!keys.trim())
            return err('缺少 keys。');
        await this.native.request('keys', { action: 'up', keys }, 15_000);
        return ok('已释放: ' + keys);
    }
    async typeText(args) {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        let text = asString(args.text) || '';
        if (!text.length)
            return err('text 为空。');
        if (text.length > 4000)
            text = text.slice(0, 4000);
        const interval = Math.min(250, Math.max(0, asInt(args.interval_ms, 0)));
        await this.native.request('type', { text, intervalMs: interval }, 120_000);
        return ok('已输入 ' + text.length + ' 个字符。');
    }
    async ocr(args, signal) {
        const missing = this.requireNative();
        if (missing)
            return err(missing);
        const t = this.targetInfo;
        if (!t)
            return err('尚未选择窗口，无法 OCR。请先 list_windows + select_window。');
        // OCR 用更高的分辨率提升识别率
        const shot = await this.native.capture(t.hwnd, 2400, 'png');
        if (!shot.buffer.length)
            return err('OCR 截图失败。');
        if (signal.aborted)
            throw new Error('已中断');
        const clientW = shot.clientWidth || t.width;
        const clientH = shot.clientHeight || t.height;
        const sx = clientW > 0 ? shot.width / clientW : 1;
        const sy = clientH > 0 ? shot.height / clientH : 1;
        const rx = asInt(args.x, 0), ry = asInt(args.y, 0);
        const rw = asInt(args.width, 0), rh = asInt(args.height, 0);
        const hasRegion = rw > 0 && rh > 0;
        const tmp = await this.native.saveTemp(shot.buffer, '.png');
        let result;
        try {
            result = await this.native.ocr(tmp, asString(args.language) || this.settings.ocrLanguage);
        }
        finally {
            await this.native.removeTemp(tmp);
        }
        let lines = Array.isArray(result.lines) ? result.lines : [];
        if (hasRegion) {
            lines = lines.filter((l) => {
                const cx = l.x + l.width / 2;
                const cy = l.y + l.height / 2;
                return cx >= rx * sx && cx <= (rx + rw) * sx && cy >= ry * sy && cy <= (ry + rh) * sy;
            });
        }
        if (lines.length === 0)
            return ok('OCR 未识别到文字。');
        const out = ['OCR 结果（' + (result.engine || 'Windows.Media.Ocr') + '，' + lines.length +
                ' 行）。坐标已换算为客户区坐标：'];
        for (const line of lines) {
            const x = Math.round(line.x / (sx || 1));
            const y = Math.round(line.y / (sy || 1));
            const w = Math.round(line.width / (sx || 1));
            const h = Math.round(line.height / (sy || 1));
            out.push('[' + x + ',' + y + ' ' + w + 'x' + h + '] ' + line.text);
        }
        return ok(out.join('\n'), 'OCR ' + lines.length + ' 行');
    }
    readFile(args) {
        const p = normalizePath(asString(args.path) || '');
        if (!p)
            return err('缺少 path。');
        if (!this.isReadable(p))
            return this.readDenied(p);
        if (!fs.existsSync(p))
            return err('文件不存在: ' + p);
        const stat = fs.statSync(p);
        if (stat.isDirectory())
            return err('这是一个目录，请用 list_directory: ' + p);
        const asBase64 = asBool(args.as_base64, false);
        const max = Math.min(1024 * 1024, Math.max(1024, asInt(args.max_bytes, 262144)));
        if (stat.size > max && !asBase64) {
            return err('文件大小 ' + stat.size + ' 字节，超过 max_bytes=' + max + '。可提高 max_bytes 或使用 as_base64。');
        }
        const fd = fs.openSync(p, 'r');
        let buf;
        try {
            const len = Math.min(stat.size, max);
            buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, 0);
        }
        finally {
            fs.closeSync(fd);
        }
        if (asBase64 || looksBinary(buf)) {
            return ok('文件 ' + p + '（' + stat.size + ' 字节，已返回 Base64，截断到 ' + buf.length + ' 字节）:\n' +
                buf.toString('base64'), path.basename(p) + ' · Base64');
        }
        return ok('文件 ' + p + '（' + stat.size + ' 字节）:\n' + buf.toString('utf8'), path.basename(p) + ' · ' + stat.size + ' 字节');
    }
    listDirectory(args) {
        const p = normalizePath(asString(args.path) || this.settings.workspacePath);
        if (!this.isReadable(p))
            return this.readDenied(p);
        if (!fs.existsSync(p))
            return err('目录不存在: ' + p);
        const pattern = asString(args.pattern) || '*';
        const matcher = simpleGlob(pattern);
        const lines = ['目录 ' + p + '（pattern=' + pattern + '）：'];
        let count = 0;
        for (const d of fs.readdirSync(p, { withFileTypes: true })) {
            if (d.isDirectory()) {
                lines.push('[DIR] ' + d.name);
                count++;
                if (count >= 200)
                    break;
            }
        }
        let files = 0;
        for (const d of fs.readdirSync(p, { withFileTypes: true })) {
            if (!d.isFile())
                continue;
            if (!matcher(d.name))
                continue;
            const full = path.join(p, d.name);
            let size = 0;
            try {
                size = fs.statSync(full).size;
            }
            catch { /* ignore */ }
            lines.push('[FILE] ' + d.name + '  ' + size + ' B');
            files++;
            if (files >= 400)
                break;
        }
        return ok(lines.join('\n'), '目录列表');
    }
    findFiles(args, signal) {
        const root = normalizePath(asString(args.root) || this.settings.workspacePath);
        if (!this.isReadable(root))
            return this.readDenied(root);
        if (!fs.existsSync(root))
            return err('目录不存在: ' + root);
        const pattern = asString(args.pattern) || '*';
        const matcher = simpleGlob(pattern);
        const max = Math.min(300, Math.max(1, asInt(args.max_results, 60)));
        const results = [];
        const queue = [{ dir: root, depth: 0 }];
        const skip = new Set(['$Recycle.Bin', 'System Volume Information', 'Windows', 'node_modules', '.git']);
        while (queue.length > 0 && results.length < max) {
            if (signal.aborted)
                throw new Error('已中断');
            const { dir, depth } = queue.shift();
            if (depth > 6)
                continue;
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const e of entries) {
                if (results.length >= max)
                    break;
                const full = path.join(dir, e.name);
                if (e.isFile() && matcher(e.name))
                    results.push(full);
                if (e.isDirectory() && !skip.has(e.name))
                    queue.push({ dir: full, depth: depth + 1 });
            }
        }
        return ok(results.length === 0 ? '未找到匹配文件。' : '找到以下文件：\n' + results.join('\n'), '找到 ' + results.length + ' 个文件');
    }
    writeFile(args) {
        const p = normalizePath(asString(args.path) || '');
        const content = asString(args.content) ?? '';
        if (!p)
            return err('缺少 path。');
        if (!this.isWritable(p)) {
            return err('拒绝写入：目标不在工作空间或已授权目录内。可写范围：' + this.settings.workspacePath +
                (this.grantedPaths.length > 0 ? '、' + this.grantedPaths.join('、') : '') +
                '。如确需写入其他目录，请先调用 request_write_access 申请。');
        }
        if (content.length > 2_000_000)
            return err('内容超过 2MB，拒绝写入。');
        ensureDir(path.dirname(p));
        // 覆盖已有文件前先备份原内容；新建文件没有旧内容可备份
        let backupNote = '';
        if (fs.existsSync(p)) {
            try {
                backupNote = this.backupNote(this.backups.snapshot(p, fs.readFileSync(p, 'utf8'), 'write_file', this.session.id));
            }
            catch {
                /* 读不到旧内容就跳过备份，不阻断写入 */
            }
        }
        fs.writeFileSync(p, content, 'utf8');
        return ok('已写入 ' + p + '（' + content.length + ' 字符）' + backupNote + '。', '写入 ' + path.basename(p));
    }
    deletePath(args) {
        const p = normalizePath(asString(args.path) || '');
        if (!p)
            return err('缺少 path。');
        if (!this.isWritable(p))
            return err('拒绝删除：目标不在工作空间或已授权目录内。确需删除时先调用 request_write_access 申请。');
        const ws = path.resolve(this.settings.workspacePath);
        if (path.resolve(p).toLowerCase() === ws.toLowerCase())
            return err('拒绝删除工作空间根目录。');
        if (!fs.existsSync(p))
            return err('目标不存在。');
        const trash = path.join(ws, '.trash');
        ensureDir(trash);
        const name = path.basename(p.replace(/[\\/]+$/, ''));
        const dest = path.join(trash, stamp() + '_' + name);
        fs.renameSync(p, dest);
        return ok('已移入工作空间回收站: ' + dest + '（可在 7 天内恢复）', '移至回收站 ' + name);
    }
    updateRecord(args) {
        const content = asString(args.content) ?? '';
        if (!content.trim())
            return err('content 为空。请提供完整的 Markdown 内容（整份替换）。');
        this.record.replace(content);
        return ok('工作记录已整份更新（' + content.length + ' 字符），旧内容已被完全替换。', '工作记录已更新');
    }
    readRecord() {
        return ok('当前工作记录：\n' + this.record.read(), '读取工作记录');
    }
    updateNotes(args) {
        const content = asString(args.content) ?? '';
        if (!content.trim())
            return err('content 为空。请提供完整的 Markdown 笔记（整份替换）。');
        try {
            this.notes.replace(content);
            return ok('工作笔记已整份更新（' + this.notes.currentLength + '/' + NOTES_MAX_CHARS +
                ' 字符），旧内容已被完全替换。', '工作笔记已更新');
        }
        catch (e) {
            return err(e instanceof Error ? e.message : String(e));
        }
    }
    appendNotes(args) {
        const content = asString(args.content) ?? '';
        if (!content.trim())
            return err('content 为空。请提供要追加的 Markdown 文本。');
        try {
            this.notes.append(content);
            const len = this.notes.currentLength;
            return ok('已追加到工作笔记（当前 ' + len + '/' + NOTES_MAX_CHARS + ' 字符，剩余 ' +
                (NOTES_MAX_CHARS - len) + '）。', '工作笔记已追加');
        }
        catch (e) {
            return err(e instanceof Error ? e.message : String(e));
        }
    }
    /** 给当前会话起一个简短名称：模型在收尾、输出完成标记之前调用。 */
    renameSessionTool(args) {
        if (!this.session.id)
            return err('当前没有绑定会话，无法命名。');
        if (!this.sessionRenamer)
            return err('当前环境不支持会话改名。');
        const title = cleanSessionTitle(asString(args.title) ?? '');
        if (!title)
            return err('title 不能为空：请给一个 6~16 字、概括这次任务的简短名称，不要带标点。');
        const applied = this.sessionRenamer(this.session.id, title);
        if (!applied)
            return err('会话改名失败：会话可能已被删除。');
        this.session.title = applied;
        return ok('会话已命名为「' + applied + '」。', '命名 ' + applied);
    }
    readNotes() {
        const md = this.notes.read();
        return ok('当前工作笔记（' + md.length + '/' + NOTES_MAX_CHARS + ' 字符）：\n' + md, '读取工作笔记');
    }
    // ------------------------------------------------------------ OpenClaw 对齐工具
    /** 在工作空间（或指定目录）执行一条命令。默认 PowerShell，其他平台用 /bin/sh。 */
    // ------------------------------------------------------------ 命令执行（可后台）
    /**
     * 全局技巧库（跨会话共享）：add / use / list / remove。
     * add 会强制脱敏；内容涉及项目信息时直接拒绝，不静默写入。
     */
    globalTipsTool(args) {
        const action = (asString(args.action) || 'list').trim().toLowerCase();
        const stats = this.tips.stats();
        if (action === 'add') {
            const text = asString(args.text) ?? '';
            if (!text.trim())
                return err('text 不能为空：请用一两句话写下通用工具技巧。');
            const r = this.tips.add(text, [this.session.id, this.session.title]);
            if (!r.ok)
                return err(r.reason || '写入技巧库失败。');
            const parts = [];
            parts.push(r.reinforced
                ? '已合并到既有条目 ' + r.id + '（内容等价，利用频次 +1）'
                : '已加入全局技巧库：' + r.id);
            if (r.redactions && r.redactions.length > 0)
                parts.push('已脱敏：' + r.redactions.join('、') + '（替换为占位符）');
            if (r.truncated)
                parts.push('内容过长，已截断到 ' + TIP_MAX_CHARS + ' 字符');
            if (r.evicted && r.evicted.length > 0) {
                parts.push('容量超限，已按利用频次从低到高清除 ' + r.evicted.length + ' 条：' + r.evicted.join('、'));
            }
            parts.push('当前 ' + r.stats.count + ' 条 / ' + r.stats.chars + '/' + r.stats.max + ' 字符。');
            return ok(parts.join('\n'), '技巧库 ' + r.stats.count + ' 条');
        }
        if (action === 'use') {
            const ids = [];
            const one = asString(args.id);
            if (one && one.trim())
                ids.push(one.trim());
            if (Array.isArray(args.ids)) {
                for (const v of args.ids)
                    if (typeof v === 'string' && v.trim())
                        ids.push(v.trim());
            }
            if (ids.length === 0)
                return err('use 需要 id（或 ids 数组）：请传入技巧条目的 id。');
            const times = asInt(args.times, 1);
            const hit = [];
            const miss = [];
            for (const id of ids) {
                const r = this.tips.markUsed(id, times);
                if (r.ok && r.tip)
                    hit.push(id + '（累计 ' + r.tip.uses + ' 次）');
                else
                    miss.push(id);
            }
            const msg = [];
            if (hit.length > 0)
                msg.push('已记录利用频次：' + hit.join('、'));
            if (miss.length > 0)
                msg.push('未找到条目：' + miss.join('、') + '（可能已被容量淘汰，可用 list 确认）');
            return ok(msg.join('\n'), '记录频次 ' + hit.length + ' 条');
        }
        if (action === 'remove') {
            const id = (asString(args.id) || '').trim();
            if (!id)
                return err('remove 需要 id。');
            const removed = this.tips.remove(id);
            if (!removed)
                return err('未找到条目 ' + id + '。');
            const now = this.tips.stats();
            return ok('已删除 ' + id + '，当前 ' + now.count + ' 条 / ' + now.chars + '/' + now.max + ' 字符。', '删除 ' + id);
        }
        if (action === 'list') {
            const entries = this.tips.list();
            const head = '全局技巧库：' + stats.count + ' 条 / ' + stats.chars + '/' + stats.max + ' 字符' +
                (this.settings.globalTipsEnabled ? '（已启用，会附加到每次请求）' : '（用户已关闭，不会附加到请求）');
            if (entries.length === 0)
                return ok(head + '\n（暂无条目）');
            const body = entries.map((e) => '- [' + e.id + '] 用 ' + e.uses + ' 次｜' + e.text).join('\n');
            return ok(head + '\n' + body, '技巧库 ' + stats.count + ' 条');
        }
        return err('未知 action: ' + action + '。可用 add / use / list / remove。');
    }
    runningJobCount() {
        let n = 0;
        for (const j of this.jobs.values())
            if (!j.proc.done)
                n++;
        return n;
    }
    /** 登记任务：已完成任务只保留最近 N 条，避免无限增长。 */
    registerJob(command, cwd, proc) {
        const job = {
            id: 'exec-' + ++this.jobSeq,
            command,
            cwd,
            startedAt: Date.now(),
            endedAt: 0,
            proc,
            seenOut: 0,
            seenErr: 0,
        };
        this.jobs.set(job.id, job);
        void proc.result.then(() => {
            job.endedAt = Date.now();
        });
        const finished = [...this.jobs.values()].filter((j) => j.proc.done).sort((a, b) => a.startedAt - b.startedAt);
        while (finished.length > KEEP_FINISHED_JOBS) {
            const dead = finished.shift();
            if (dead)
                this.jobs.delete(dead.id);
        }
        return job;
    }
    /** 等任务结束，最多等 waitMs；返回是否已结束（waitMs<=0 立即返回当前状态）。 */
    async waitJob(job, waitMs, signal) {
        if (job.proc.done)
            return true;
        if (waitMs <= 0)
            return false;
        return await new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            const onAbort = () => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                if (signal)
                    signal.removeEventListener('abort', onAbort);
                reject(new Error('已中断'));
            };
            const settle = (v) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                if (signal)
                    signal.removeEventListener('abort', onAbort);
                resolve(v);
            };
            timer = setTimeout(() => settle(false), waitMs);
            void job.proc.result.then(() => settle(true));
            if (signal) {
                if (signal.aborted)
                    onAbort();
                else
                    signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }
    /** 任务状态文本；drain=true 时把本次返回的输出记入游标（下次只给增量）。 */
    jobText(job, drain) {
        const p = job.proc;
        const lines = [];
        lines.push('任务 ID: ' + job.id);
        lines.push('命令: ' + truncate(job.command, 400));
        lines.push('工作目录: ' + job.cwd);
        const endAt = p.done ? job.endedAt || Date.now() : Date.now();
        const secs = ((endAt - job.startedAt) / 1000).toFixed(1);
        lines.push(p.done
            ? '状态: 已结束 · 退出码 ' + p.code + (p.timedOut ? '（已超时并终止）' : '') + ' · 用时 ' + secs + ' 秒'
            : '状态: 运行中 · 已运行 ' + secs + ' 秒');
        const newOut = p.outText.slice(job.seenOut);
        const newErr = p.errText.slice(job.seenErr);
        if (drain) {
            job.seenOut = p.outText.length;
            job.seenErr = p.errText.length;
        }
        if (newOut.trim())
            lines.push('--- 新增 stdout ---\n' + truncate(newOut.trim(), 200_000));
        else
            lines.push(p.done ? '（没有新增 stdout）' : '（暂无新增 stdout）');
        if (newErr.trim())
            lines.push('--- 新增 stderr ---\n' + truncate(newErr.trim(), 40_000));
        if (p.truncated)
            lines.push('（输出超过 512KB 上限，更早的内容已被丢弃）');
        if (!p.done) {
            lines.push('任务仍在后台运行，不影响继续做别的事：用 exec_output {job_id:"' + job.id +
                '", wait_ms:5000} 取新输出，或用 exec_kill {job_id:"' + job.id + '"} 终止。');
        }
        return lines.join('\n');
    }
    /** 同步结束的常规输出（与旧版一致）。 */
    foregroundResult(res, cwd) {
        const parts = [];
        parts.push('退出码: ' + res.code + (res.timedOut ? '（已超时并终止）' : ''));
        parts.push('工作目录: ' + cwd);
        if (res.stdout.trim())
            parts.push('--- stdout ---\n' + truncate(res.stdout.trim(), 200_000));
        if (res.stderr.trim())
            parts.push('--- stderr ---\n' + truncate(res.stderr.trim(), 40_000));
        return { text: parts.join('\n'), isError: res.code !== 0 };
    }
    /** 删除任务记录。 */
    forgetJob(job) {
        this.jobs.delete(job.id);
    }
    /** 服务退出时终止所有后台任务，避免留下孤儿进程。 */
    dispose() {
        for (const j of this.jobs.values())
            j.proc.killTree();
        this.jobs.clear();
    }
    /**
     * 在工作空间（或指定目录）执行一条命令。
     * background=true 或 wait_ms 到期都会立即返回任务 ID，命令继续在后台跑，
     * 模型可以接着做下一件事，再用 exec_output / exec_kill 处理。
     */
    async execCommand(args, signal) {
        if (!this.settings.allowShell) {
            return err('shell 工具已被禁用：设置 → 工具权限 → 允许执行命令 打开后再试。');
        }
        const command = (asString(args.command) || '').trim();
        if (!command)
            return err('command 不能为空');
        const cwdRaw = asString(args.cwd);
        const cwd = cwdRaw && cwdRaw.trim() ? normalizePath(cwdRaw) : this.settings.workspacePath;
        if (!fs.existsSync(cwd))
            return err('工作目录不存在: ' + cwd);
        const background = asBool(args.background, false);
        const waitMs = background ? 0 : Math.min(600_000, Math.max(0, asInt(args.wait_ms, 0)));
        const defaultTimeout = background || waitMs > 0
            ? Math.max(this.settings.shellTimeoutMs, 600_000)
            : this.settings.shellTimeoutMs;
        const timeout = Math.min(1_800_000, Math.max(1000, asInt(args.timeout_ms, defaultTimeout)));
        if (background && this.runningJobCount() >= MAX_RUNNING_JOBS) {
            return err('后台任务已达上限 ' + MAX_RUNNING_JOBS + ' 个：先用 exec_output 查看，exec_kill 结束不再需要的任务。');
        }
        const win = process.platform === 'win32';
        const proc = new Proc(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command], { cwd, timeoutMs: timeout, signal: background ? undefined : signal });
        const job = this.registerJob(command, cwd, proc);
        if (background) {
            // 只给极短窗口，尽量把“立刻失败”的报错带回去，但绝不阻塞模型
            await this.waitJob(job, 200, signal).catch(() => false);
            return {
                text: '已在后台启动，不会阻塞后续操作。\n' + this.jobText(job, true),
                isError: false,
                display: '后台任务 ' + job.id,
            };
        }
        if (waitMs > 0) {
            const finished = await this.waitJob(job, waitMs, signal);
            if (!finished) {
                return {
                    text: '命令在 ' + waitMs + ' 毫秒内没有结束，已转入后台继续执行（没有中断）。可以先去干别的，稍后用 exec_output 取输出。\n' +
                        this.jobText(job, true),
                    isError: false,
                    display: '后台任务 ' + job.id,
                };
            }
            return this.foregroundResult(await proc.result, cwd);
        }
        const res = await proc.result;
        this.forgetJob(job);
        return this.foregroundResult(res, cwd);
    }
    /** 查看后台任务：不带 job_id 列出全部；带 job_id 取状态 + 增量输出，可用 wait_ms 等一会儿。 */
    async execOutput(args, signal) {
        const idRaw = (asString(args.job_id) || '').trim();
        if (!idRaw) {
            const list = [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
            if (!list.length)
                return ok('当前没有后台任务。');
            const lines = list.map((j) => '· ' + j.id + ' [' + (j.proc.done ? '已结束 ' + j.proc.code : '运行中') + '] ' +
                truncate(j.command.replace(/\s+/g, ' '), 80));
            return ok('后台任务（' + list.length + ' 个）：\n' + lines.join('\n'), '后台任务列表');
        }
        const job = this.jobs.get(idRaw);
        if (!job)
            return err('未找到任务 ' + idRaw + '（不带 job_id 调用 exec_output 可以列出全部任务）');
        const waitMs = Math.min(600_000, Math.max(0, asInt(args.wait_ms, 0)));
        if (waitMs > 0 && !job.proc.done)
            await this.waitJob(job, waitMs, signal);
        return ok(this.jobText(job, true), job.id);
    }
    /** 终止后台任务（整棵进程树）。 */
    execKill(args) {
        const id = (asString(args.job_id) || '').trim();
        if (!id)
            return err('job_id 不能为空');
        const job = this.jobs.get(id);
        if (!job)
            return err('未找到任务 ' + id);
        if (job.proc.done)
            return ok('任务 ' + id + ' 已经结束（退出码 ' + job.proc.code + '），无需终止。');
        job.proc.killTree();
        return ok('已发送终止信号：' + id + '（整棵进程树）。稍后用 exec_output 确认退出码。', '终止 ' + id);
    }
    /** 抓取网页并转成纯文本。 */
    async webFetch(args, signal) {
        const url = (asString(args.url) || '').trim();
        if (!url)
            return err('url 不能为空');
        if (!/^https?:\/\//i.test(url))
            return err('只支持 http/https 链接');
        const maxChars = Math.min(400_000, Math.max(500, asInt(args.max_chars, 60_000)));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const onAbort = () => controller.abort();
        if (signal.aborted)
            onAbort();
        else
            signal.addEventListener('abort', onAbort, { once: true });
        try {
            const resp = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ContinuousAgent/1.0',
                    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                },
                redirect: 'follow',
                signal: controller.signal,
            });
            const ctype = resp.headers.get('content-type') || '';
            const raw = await resp.text();
            let text = raw;
            let title = '';
            if (/html|xml/i.test(ctype) || /^\s*</.test(raw)) {
                const m = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
                if (m && m[1])
                    title = htmlToText(m[1]);
                text = htmlToText(raw);
            }
            const head = [
                'URL: ' + url + '（最终 ' + (resp.url || url) + '）',
                '状态: HTTP ' + resp.status,
                title ? '标题: ' + title : '',
                ctype ? '类型: ' + ctype : '',
            ].filter(Boolean).join('\n');
            const body = truncate(text.trim(), maxChars);
            return { text: head + '\n\n' + (body || '（正文为空）'), isError: !resp.ok };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err('抓取失败: ' + (msg.includes('abort') ? '请求超时或已中断' : msg));
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        }
    }
    /** 精确替换片段（默认要求唯一匹配）。 */
    editFile(args) {
        const rawPath = asString(args.path) || '';
        if (!rawPath.trim())
            return err('path 不能为空');
        const file = normalizePath(rawPath);
        if (!this.isWritable(file)) {
            return err('edit_file 只允许修改工作空间或已授权目录内的文件。可写范围：' + this.settings.workspacePath +
                '。如确需修改其他目录，请先调用 request_write_access 申请。');
        }
        if (!fs.existsSync(file))
            return err('文件不存在: ' + file);
        const oldText = asString(args.old_text) ?? '';
        const newText = asString(args.new_text) ?? '';
        if (!oldText)
            return err('old_text 不能为空');
        const replaceAll = asBool(args.replace_all, false);
        const content = fs.readFileSync(file, 'utf8');
        const count = content.split(oldText).length - 1;
        if (count === 0)
            return err('未找到要替换的片段（空白与缩进必须完全一致）');
        if (count > 1 && !replaceAll) {
            return err('该片段出现 ' + count + ' 次，请提供更长的唯一片段，或设 replace_all=true');
        }
        const replaced = replaceAll
            ? replaceLiteralAll(content, oldText, newText)
            : replaceLiteralOnce(content, oldText, newText);
        const next = replaced.text;
        // 防御：结果长度必须等于「原文 - 旧片段 + 新片段」的算术预期；
        // 不一致说明替换文本被当成模式展开了，宁可报错也不写盘。
        const expectedLen = content.length + replaced.count * (newText.length - oldText.length);
        if (next.length !== expectedLen) {
            return err('替换结果长度异常（预期 ' + expectedLen + '，实际 ' + next.length + '），已放弃写入以免损坏文件');
        }
        const backup = this.backups.snapshot(file, content, 'edit_file', this.session.id);
        fs.writeFileSync(file, next, 'utf8');
        return ok('已修改 ' + file + '（替换 ' + (replaceAll ? count : 1) + ' 处；' + content.length + ' → ' + next.length + ' 字符）' +
            this.backupNote(backup), 'edit_file');
    }
    /** 批量精确替换：一次提交多组 old/new。 */
    applyPatch(args) {
        const rawPath = asString(args.path) || '';
        if (!rawPath.trim())
            return err('path 不能为空');
        const file = normalizePath(rawPath);
        if (!this.isWritable(file)) {
            return err('apply_patch 只允许修改工作空间或已授权目录内的文件。可写范围：' + this.settings.workspacePath +
                '。如确需修改其他目录，请先调用 request_write_access 申请。');
        }
        if (!fs.existsSync(file))
            return err('文件不存在: ' + file);
        const edits = Array.isArray(args.edits) ? args.edits : null;
        if (!edits || edits.length === 0)
            return err('edits 不能为空（数组，元素为 {old_text,new_text}）');
        let content = fs.readFileSync(file, 'utf8');
        // 整批改动前只备份一次：一次工具调用对应一份可撤回状态
        const backup = this.backups.snapshot(file, content, 'apply_patch', this.session.id);
        const applied = [];
        for (let i = 0; i < edits.length; i++) {
            const raw = edits[i];
            if (!raw || typeof raw !== 'object')
                return err('第 ' + (i + 1) + ' 个 edit 不是对象');
            const item = raw;
            const oldText = asString(item.old_text) ?? '';
            const newText = asString(item.new_text) ?? '';
            if (!oldText)
                return err('第 ' + (i + 1) + ' 个 edit 缺少 old_text');
            const count = content.split(oldText).length - 1;
            if (count === 0) {
                fs.writeFileSync(file, content, 'utf8');
                return err('第 ' + (i + 1) + ' 个 edit 未找到片段；已写入前面的 ' + applied.length + ' 处修改');
            }
            if (count > 1 && !asBool(item.replace_all, false)) {
                fs.writeFileSync(file, content, 'utf8');
                return err('第 ' + (i + 1) + ' 个 edit 匹配到 ' + count + ' 处，请补充上下文或设 replace_all=true');
            }
            const replaced = asBool(item.replace_all, false)
                ? replaceLiteralAll(content, oldText, newText)
                : replaceLiteralOnce(content, oldText, newText);
            // 防御：长度必须等于算术预期，否则放弃写入（见 replaceLiteralOnce 注释）
            const expectedLen = content.length + replaced.count * (newText.length - oldText.length);
            if (replaced.text.length !== expectedLen) {
                fs.writeFileSync(file, content, 'utf8');
                return err('第 ' + (i + 1) + ' 个 edit 的替换结果长度异常，已放弃写入以免损坏文件');
            }
            content = replaced.text;
            applied.push('#' + (i + 1) + ' 替换 ' + (asBool(item.replace_all, false) ? count : 1) + ' 处');
        }
        fs.writeFileSync(file, content, 'utf8');
        return ok('已更新 ' + file + '：\n' + applied.join('\n') + this.backupNote(backup), 'apply_patch');
    }
    /**
     * 文件改动备份管理：list 列出、restore 回滚、clear 清空。
     * 备份由 write_file 覆盖 / edit_file / apply_patch 在写盘前自动产生。
     */
    changedBackupTool(args) {
        const action = (asString(args.action) || 'list').trim().toLowerCase();
        const store = this.backups;
        if (action === 'list') {
            const entries = store.list();
            const st = store.stats();
            const head = '改动备份：' + st.count + ' 份 / ' + st.bytes + ' 字节，目录 ' + st.folder +
                (st.enabled ? '（上限 ' + st.max + ' 份）' : '（已关闭，不再产生新备份）');
            if (entries.length === 0)
                return ok(head + '\n（暂无备份）');
            const shown = entries.slice(0, 40).map((e) => '- ' + e.id + '｜原文件 ' + e.originalPath +
                '｜' + new Date(e.time).toLocaleString('zh-CN') + '｜' + e.size + ' 字节｜' + e.tool);
            const more = entries.length > 40 ? '\n…另有 ' + (entries.length - 40) + ' 份未列出' : '';
            return ok(head + '\n' + shown.join('\n') + more);
        }
        if (action === 'restore') {
            const id = (asString(args.id) || '').trim();
            if (!id) {
                const avail = store.list().slice(0, 10).map((e) => e.id);
                return err('restore 需要 id（备份文件名）。' +
                    (avail.length > 0 ? '可用的备份：' + avail.join('、') : '当前没有任何备份。'));
            }
            const r = store.restore(id, (p) => this.isWritable(p));
            return r.ok ? ok(r.text) : err(r.text);
        }
        if (action === 'clear') {
            const r = store.clear();
            return ok('已清空 ' + r.removed + ' 份改动备份（' + r.bytes + ' 字节）。');
        }
        return err('未知 action: ' + action + '。可用 list / restore / clear。');
    }
    /** 按正则搜索文件内容（跳过 node_modules/.git/dist 等）。 */
    searchFiles(args, signal) {
        const rawRoot = asString(args.root);
        const root = normalizePath(rawRoot && rawRoot.trim() ? rawRoot : this.settings.workspacePath);
        if (!this.isReadable(root))
            return this.readDenied(root);
        if (!fs.existsSync(root))
            return err('目录不存在: ' + root);
        const patternRaw = asString(args.pattern) || '';
        if (!patternRaw.trim())
            return err('pattern 不能为空（正则）');
        const flags = asBool(args.case_sensitive, false) ? '' : 'i';
        let re;
        try {
            re = new RegExp(patternRaw, flags);
        }
        catch (e) {
            return err('正则无效: ' + (e instanceof Error ? e.message : String(e)));
        }
        const glob = simpleGlob(asString(args.file_pattern) || '*');
        const maxResults = Math.min(300, Math.max(1, asInt(args.max_results, 80)));
        const maxBytes = Math.min(5_000_000, Math.max(1000, asInt(args.max_file_bytes, 512_000)));
        const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '.trash', '.venv', '__pycache__']);
        const results = [];
        const walk = (dir, depth) => {
            if (results.length >= maxResults || depth > 12 || signal.aborted)
                return;
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const ent of entries) {
                if (results.length >= maxResults || signal.aborted)
                    return;
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    if (!skipDirs.has(ent.name))
                        walk(full, depth + 1);
                    continue;
                }
                if (!ent.isFile() || !glob(ent.name))
                    continue;
                try {
                    const st = fs.statSync(full);
                    if (st.size > maxBytes)
                        continue;
                    const buf = fs.readFileSync(full);
                    if (looksBinary(buf))
                        continue;
                    const text = buf.toString('utf8');
                    const lines = text.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i] ?? '';
                        if (!re.test(line))
                            continue;
                        results.push(full + ':' + (i + 1) + ': ' + truncate(line.trim(), 240));
                        if (results.length >= maxResults)
                            return;
                    }
                }
                catch {
                    /* 跳过无法读取的文件 */
                }
            }
        };
        walk(root, 0);
        if (results.length === 0)
            return ok('未匹配到内容（根目录 ' + root + '）');
        return ok('共 ' + results.length + ' 条匹配:\n' + results.join('\n'), 'search_files ' + results.length + ' 条');
    }
    async clipboardRead() {
        if (process.platform !== 'win32')
            return err('剪贴板工具仅支持 Windows');
        const res = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], { timeoutMs: 15_000 });
        if (res.code !== 0)
            return err('读取剪贴板失败: ' + (res.stderr.trim() || res.stdout.trim()));
        const value = res.stdout.replace(/\r\n$/, '');
        return ok(value.trim() ? truncate(value, 100_000) : '（剪贴板为空）');
    }
    async clipboardWrite(args) {
        if (process.platform !== 'win32')
            return err('剪贴板工具仅支持 Windows');
        const text = asString(args.text) ?? '';
        if (!text)
            return err('text 不能为空');
        const res = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$in = [Console]::In.ReadToEnd(); Set-Clipboard -Value $in'], { timeoutMs: 15_000, stdin: text });
        if (res.code !== 0)
            return err('写入剪贴板失败: ' + (res.stderr.trim() || res.stdout.trim()));
        return ok('已写入剪贴板（' + text.length + ' 字符）');
    }
    async launchApp(args) {
        if (!this.settings.allowLaunch) {
            return err('启动程序已被禁用：设置 → 工具权限 → 允许启动程序 打开后再试。');
        }
        const target = (asString(args.target) || '').trim();
        if (!target)
            return err('target 不能为空（可执行文件、文档或 URL）');
        const extra = asString(args.args) || '';
        const cwdRaw = asString(args.cwd);
        const cwd = cwdRaw && cwdRaw.trim() ? normalizePath(cwdRaw) : this.settings.workspacePath;
        if (process.platform === 'win32') {
            const ps = 'Start-Process -FilePath ' + psQuote(target) +
                (extra ? ' -ArgumentList ' + psQuote(extra) : '') +
                (fs.existsSync(cwd) ? ' -WorkingDirectory ' + psQuote(cwd) : '');
            const res = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 20_000 });
            if (res.code !== 0)
                return err('启动失败: ' + (res.stderr.trim() || res.stdout.trim()));
            return ok('已启动: ' + target + (extra ? ' ' + extra : ''));
        }
        const res = await runProcess(target, extra ? extra.split(/\s+/) : [], { cwd, timeoutMs: 5000 });
        return res.code === 0 ? ok('已启动: ' + target) : err('启动失败: ' + (res.stderr.trim() || 'exit ' + res.code));
    }
    async processList(args) {
        const filter = (asString(args.filter) || '').trim();
        if (process.platform !== 'win32') {
            const res = await runProcess('/bin/sh', ['-c', 'ps -eo pid,comm ' + (filter ? '| grep -i ' + psQuote(filter) : '')], { timeoutMs: 15_000 });
            return ok(truncate(res.stdout.trim() || '（无结果）', 100_000));
        }
        const where = filter
            ? '| Where-Object { $_.ProcessName -like ' + psQuote('*' + filter + '*') + ' -or $_.MainWindowTitle -like ' + psQuote('*' + filter + '*') + ' } '
            : '| Where-Object { $_.MainWindowTitle -ne \'\' } ';
        const ps = 'Get-Process ' + where +
            '| Sort-Object ProcessName | Select-Object -First 120 Id,ProcessName,MainWindowTitle ' +
            '| Format-Table -AutoSize | Out-String -Width 200';
        const res = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 20_000 });
        if (res.code !== 0)
            return err('枚举进程失败: ' + (res.stderr.trim() || res.stdout.trim()));
        return ok(truncate(res.stdout.trim() || '（无结果）', 100_000), 'process_list');
    }
    /** 申请工作空间外的可写目录：用户在对话里确认一次，本会话内该目录（含子目录）即可写。 */
    async requestWriteAccess(args) {
        const raw = asString(args.path) || '';
        if (!raw.trim())
            return err('path 不能为空');
        const target = normalizePath(raw);
        if (this.isWritable(target))
            return ok('该路径已可写（工作空间或已授权目录）：' + target);
        const s = this.settings;
        if (!s.allowPathRequests) {
            return err('已禁用“申请工作空间外目录”。请用户在 设置 → 工具权限 里手动添加白名单目录，或打开该开关。');
        }
        if (!this.broker)
            return err('当前没有可用的授权交互（浏览器未连接）。请用户在设置里添加白名单目录。');
        if (!fs.existsSync(target))
            return err('路径不存在，无法授权: ' + target);
        const reason = asString(args.reason) || '';
        const granted = await this.broker.ask(target, reason, 'write');
        if (!granted) {
            return err('用户拒绝了对该路径的写权限：' + target + '。不要反复重试，改为在正文说明需要用户手动放行。');
        }
        this.addGrant(target);
        return ok('已获得写权限（本会话有效，含子目录）：' + target +
            '。现在可以对它使用 write_file / edit_file / apply_patch / delete_path。', '已授权 ' + target);
    }
    /** 申请工作空间外的可读路径（仅严格读取模式生效）：用户确认一次，本会话内该路径（含子目录）即可读。 */
    async requestReadAccess(args) {
        if (!this.settings.strictReadMode) {
            return ok('当前未开启「读取申请（严格模式）」，读取工作空间外的路径无需申请，可直接调用 read_file / list_directory 等。');
        }
        const raw = asString(args.path) || '';
        if (!raw.trim())
            return err('path 不能为空');
        const target = normalizePath(raw);
        if (this.isReadable(target))
            return ok('该路径已可读（工作空间或已授权目录）：' + target);
        if (!this.settings.allowReadRequests) {
            return err('已禁用「读取申请」。请用户在 设置 → 工具权限 里手动添加可读白名单目录，或打开该开关。');
        }
        if (!this.broker)
            return err('当前没有可用的授权交互（浏览器未连接）。请用户在设置里添加可读白名单目录。');
        if (!fs.existsSync(target))
            return err('路径不存在，无法授权: ' + target);
        const reason = asString(args.reason) || '';
        const granted = await this.broker.ask(target, reason, 'read');
        if (!granted) {
            return err('用户拒绝了对该路径的读权限：' + target + '。不要反复重试，改为在正文说明需要用户手动放行。');
        }
        this.addReadGrant(target);
        return ok('已获得读权限（本会话有效，含子目录）：' + target +
            '。现在可以用 read_file / list_directory / find_files / search_files / view_image 读取它。', '已授权读取 ' + target);
    }
    viewImage(args) {
        const rawPath = asString(args.path) || '';
        if (!rawPath.trim())
            return err('path 不能为空');
        const file = normalizePath(rawPath);
        if (!this.isReadable(file))
            return this.readDenied(file);
        if (!fs.existsSync(file))
            return err('文件不存在: ' + file);
        const ext = path.extname(file).toLowerCase();
        const mime = ext === '.png' ? 'image/png'
            : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                : ext === '.webp' ? 'image/webp'
                    : ext === '.gif' ? 'image/gif' : '';
        if (!mime)
            return err('不支持的图片类型: ' + (ext || '(无扩展名)'));
        const st = fs.statSync(file);
        if (st.size > 8_000_000)
            return err('图片过大（>8MB）: ' + st.size + ' 字节');
        const b64 = fs.readFileSync(file).toString('base64');
        return {
            text: '已载入图片: ' + file + '（' + mime + ', ' + st.size + ' 字节）',
            images: [b64],
            isError: false,
            display: path.basename(file),
        };
    }
    async getEnvironment() {
        const lines = [];
        lines.push('工作空间: ' + this.settings.workspacePath);
        lines.push('工作记录: ' + this.record.recordPath);
        lines.push('工作笔记: ' + this.notes.notesPath + '（' + this.notes.currentLength + '/' + NOTES_MAX_CHARS + ' 字符）');
        lines.push('存档提示路径: ' + (this.settings.gameSavePath || '(未设置)'));
        lines.push('运行平台: ' + process.platform + ' · 原生桥接: ' + (this.native.available ? '可用' : '不可用'));
        lines.push('目标窗口: ' + (this.targetInfo
            ? 'PID=' + this.targetInfo.pid + ' ' + this.targetInfo.processName + ' ' + this.targetInfo.title
            : '未选择'));
        lines.push('OCR 语言: ' + this.settings.ocrLanguage);
        return ok(lines.join('\n'), '环境信息');
    }
    async wait(args, signal) {
        const ms = Math.min(10_000, Math.max(0, asInt(args.ms, 500)));
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new Error('已中断'));
            };
            if (signal.aborted)
                onAbort();
            else
                signal.addEventListener('abort', onAbort, { once: true });
        });
        return ok('已等待 ' + ms + ' 毫秒。');
    }
}
function simpleGlob(pattern) {
    if (!pattern || pattern === '*')
        return () => true;
    const escaped = pattern.replace(/[.+^${\}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    const re = new RegExp('^' + escaped + '$', 'i');
    return (name) => re.test(name);
}
export function buildToolCatalog() {
    const S = (description) => ({ type: 'string', description });
    const I = (description) => ({ type: 'integer', description });
    const B = (description) => ({ type: 'boolean', description });
    const tool = (name, description, props, required = []) => ({
        type: 'function',
        function: {
            name,
            description,
            parameters: { type: 'object', properties: props, required },
        },
    });
    return [
        tool('list_windows', '列出当前所有可见的顶层窗口（含 PID、进程名、标题、客户区尺寸）。用于定位目标应用窗口。', {}),
        tool('select_window', '选择并激活目标窗口。之后所有坐标都相对该窗口客户区；等价旧名 select_game_window。', {
            pid: I('目标进程 ID（推荐）'),
            title_contains: S('或在窗口标题中匹配的关键字'),
            activate: B('是否置于前台，默认 true；多会话并行时传 false 可避免抢焦点'),
        }),
        tool('get_window_info', '获取当前目标窗口的 PID、进程、标题、客户区尺寸与前台状态。', {}),
        tool('screenshot', '截取目标窗口画面并作为图像返回。坐标基准是客户区像素，截图可能被缩放仅供观察。操作后务必截图确认结果。', {
            max_width: I('截图最大宽度，默认 1600'),
        }),
        tool('screenshot_background', '后台截图：仅用 PrintWindow 抽取目标窗口自身画面，不激活窗口、不改前后台与叠放顺序；多会话并行时用它观察窗口，不会抢焦点，被其它窗口遮挡时也能拿到自己的内容。', {
            max_width: I('截图最大宽度，默认取设置值'),
            pid: I('可选：直接指定进程 PID（不激活、不改当前目标窗口）'),
            hwnd: S('可选：直接指定窗口句柄（见 list_windows）'),
            title_contains: S('可选：按标题关键字找窗口（不激活）'),
        }),
        tool('mouse_move', '把鼠标移动到目标窗口客户区坐标 (x,y)。', {
            x: I('客户区 X 像素'), y: I('客户区 Y 像素'),
        }, ['x', 'y']),
        tool('mouse_click', '在客户区坐标点击鼠标；不传坐标则在当前鼠标位置点击。', {
            x: I('客户区 X'), y: I('客户区 Y'),
            button: S('left / right / middle，默认 left'),
            count: I('点击次数 1-3'),
            hold_ms: I('按住毫秒数，默认 45'),
        }),
        tool('mouse_drag', '从客户区 (x1,y1) 拖拽到 (x2,y2)，用于拖动、框选等操作。', {
            x1: I('起点 X'), y1: I('起点 Y'), x2: I('终点 X'), y2: I('终点 Y'),
            button: S('left / right / middle'),
            steps: I('插值步数，默认 24'),
        }, ['x1', 'y1', 'x2', 'y2']),
        tool('scroll', '滚动鼠标滚轮，可指定客户区位置。', {
            x: I('客户区 X（可选）'), y: I('客户区 Y（可选）'),
            delta: I('滚轮格数，正数向上/向右'),
            horizontal: B('是否水平滚动'),
        }, ['delta']),
        tool('key_press', '发送按键组合，如 enter、esc、ctrl+shift+a、alt+f4、space。用于快捷键与菜单操作。', {
            keys: S('按键组合，例如 ctrl+alt+1'),
            hold_ms: I('按住时长（毫秒），用于蓄力/持续移动；0 表示快速点按'),
        }, ['keys']),
        tool('key_down', '按下并保持一组按键（不释放），用于需要持续按住的操作；必须稍后用 key_up 释放。', {
            keys: S('按键组合，例如 w 或 shift+w'),
        }, ['keys']),
        tool('key_up', '释放由 key_down 按下的按键。', {
            keys: S('按键组合，与 key_down 相同'),
        }, ['keys']),
        tool('type_text', '输入一段文本（支持中文，使用 Unicode 注入，不是剪贴板）。', {
            text: S('要输入的文本'),
            interval_ms: I('字符间隔毫秒'),
        }, ['text']),
        tool('ocr', '对当前窗口或指定客户区区域做 OCR，返回文本及其客户区坐标。读取任务、对话、UI 文本时使用。', {
            x: I('区域左上 X（默认全窗口）'), y: I('区域左上 Y'),
            width: I('区域宽'), height: I('区域高'),
            language: S('OCR 语言，如 zh-Hans、en-US'),
        }),
        tool('read_file', '读取本机任意文件（只读）。文本返回内容；二进制/存档可设 as_base64=true 读取原始字节。', {
            path: S('文件绝对路径'),
            max_bytes: I('最大读取字节数，默认 262144'),
            as_base64: B('是否以 Base64 返回'),
        }, ['path']),
        tool('list_directory', '列出目录内容（只读，可访问任意目录）。', {
            path: S('目录路径，默认工作空间'),
            pattern: S('文件通配符，默认 *'),
        }),
        tool('find_files', '在指定目录递归查找文件（只读），用于定位配置、日志、产物等文件。', {
            root: S('搜索根目录，默认工作空间'),
            pattern: S('通配符，如 *.json、*.log、config*'),
            max_results: I('最多结果数，默认 60'),
        }),
        tool('write_file', '在工作空间内新建或覆盖文件（仅工作空间允许写入）。', {
            path: S('工作空间内的绝对路径'),
            content: S('完整文本内容'),
        }, ['path', 'content']),
        tool('delete_path', '删除工作空间内的文件/目录（移入工作空间 .trash 回收站）。', {
            path: S('工作空间内的绝对路径'),
        }, ['path']),
        tool('update_work_record', '整份覆盖更新工作记录 Markdown。必须包含：任务目标、当前进度、关键环境、已改动文件、待办、决策与风险。不要追加历史，只写当前最新状态。', {
            content: S('完整的新 Markdown 内容（整份替换旧文件）'),
        }, ['content']),
        tool('read_work_record', '读取当前工作记录 Markdown。', {}),
        tool('update_work_notes', '整份覆盖更新长期工作笔记 Markdown。笔记保存跨任务稳定知识（环境约定、命令、项目结构、坑与解法），不是逐轮流水；上限 100000 字符，超限会被拒绝。', {
            content: S('完整的新笔记 Markdown（整份替换旧文件）'),
        }, ['content']),
        tool('append_work_notes', '向长期工作笔记追加新知识。适合记录刚确认的环境约定、可用命令、坑与解法；上限 100000 字符，超限时先整理压缩。', {
            content: S('要追加的 Markdown 片段'),
        }, ['content']),
        tool('read_work_notes', '读取当前长期工作笔记 Markdown 与已用字符数。', {}),
        tool('rename_session', '给当前会话起一个简短名称（6~16 字，概括这次任务，不带标点/日期）。在任务收尾、输出 [[DONE]] 之前调用一次；新建会话不再向用户索要标题，命名由你负责。', {
            title: S('新的会话名称，例如 修复命令行后台执行'),
        }, ['title']),
        tool('global_tips', '全局技巧库（跨会话共享的长期工具技巧）：action=add 写入（自动脱敏，含项目/路径/密钥等专有信息会被拒绝）、use 记录一次利用频次、list 查看、remove 删除。只写通用工具技巧，不写项目信息。容量超限时按利用频次从低到高自动清除。', {
            action: { type: 'string', enum: ['add', 'use', 'list', 'remove'], description: '要执行的操作' },
            text: S('add 时的技巧正文（一两句话，只含通用工具经验）'),
            id: S('use/remove 时的条目 id，如 t3'),
            ids: { type: 'array', items: { type: 'string' }, description: 'use 时批量传入的条目 id 列表' },
            times: I('use 时累加的频次，默认 1'),
        }, ['action']),
        tool('get_environment', '获取工作空间、记录路径、存档提示、屏幕尺寸与目标窗口信息。', {}),
        tool('wait', '等待指定毫秒（最多 10 秒），用于等界面加载、动画或任务完成。', {
            ms: I('毫秒，0-10000'),
        }, ['ms']),
        tool('exec_command', '在工作空间（或指定目录）执行一条命令，默认 Windows PowerShell，其他平台 /bin/sh。默认同步等待，返回退出码 + stdout + stderr。长任务建议不要死等：background=true 立即拿回任务 ID，或用 wait_ms 限时等待（到期自动转后台且不中断执行），随后用 exec_output 取增量输出、exec_kill 终止。', {
            command: S('要执行的命令，例如 npm run build 或 Get-ChildItem'),
            cwd: S('工作目录（默认工作空间）'),
            timeout_ms: I('超时毫秒，默认取设置里的 shell 超时（后台任务默认至少 10 分钟，上限 30 分钟）'),
            background: B('true 则立刻返回任务 ID、命令在后台继续跑，之后用 exec_output 查看输出；默认 false'),
            wait_ms: I('最多等待多少毫秒：到期仍未结束就转入后台并返回任务 ID（不终止进程）；默认 0 = 一直等到结束'),
        }, ['command']),
        tool('exec_output', '查看后台命令任务的状态与输出。不带 job_id 时列出所有后台任务；带 job_id 返回退出码与“新增”输出（已返回过的不会重复），可用 wait_ms 最多再等一会儿。', {
            job_id: S('exec_command 返回的任务 ID，如 exec-1；省略则列出全部任务'),
            wait_ms: I('最多等待多少毫秒等任务产出新输出，默认 0 = 立即返回当前状态'),
        }),
        tool('exec_kill', '终止后台命令任务（连同整棵子进程树）。', {
            job_id: S('要终止的任务 ID'),
        }, ['job_id']),
        tool('web_fetch', '抓取一个 http/https 网页或接口，HTML 会转成纯文本返回。用于查资料、读文档。', {
            url: S('完整 URL'),
            max_chars: I('最多返回字符数，默认 60000'),
        }, ['url']),
        tool('edit_file', '在工作空间内对文件做精确片段替换（默认要求片段唯一）。比整份重写更安全，适合改代码。', {
            path: S('工作空间内的绝对路径'),
            old_text: S('要替换的原始片段（需与文件内容完全一致，含缩进）'),
            new_text: S('替换后的新内容'),
            replace_all: B('是否替换全部匹配，默认 false'),
        }, ['path', 'old_text', 'new_text']),
        tool('apply_patch', '一次提交多组精确替换修改同一个文件；任一组失败会保留已成功的部分并报错。', {
            path: S('工作空间内的绝对路径'),
            edits: { type: 'array', description: '替换列表，元素为 {old_text, new_text, replace_all?}', items: { type: 'object' } },
        }, ['path', 'edits']),
        tool('changed_backup', '文件改动备份管理：list 列出现有备份、restore 回滚到指定备份、clear 立即清空。改动文件（write_file 覆盖 / edit_file / apply_patch）前会自动把原文件备份到 <工作空间>/changed_backup，文件名 = 原文件名__时间戳.bak；任务彻底结束时自动清空。', {
            action: { type: 'string', enum: ['list', 'restore', 'clear'], description: 'list 列出 / restore 回滚 / clear 清空' },
            id: S('restore 时的备份文件名（见 list 输出）'),
        }, ['action']),
        tool('search_files', '在目录里按正则搜索文件内容（默认工作空间，自动跳过 node_modules/.git/dist）。返回 文件:行:内容。', {
            pattern: S('正则表达式'),
            root: S('搜索根目录，默认工作空间'),
            file_pattern: S('文件名通配符，如 *.ts，默认 *'),
            case_sensitive: B('是否区分大小写，默认 false'),
            max_results: I('最多结果条数，默认 80'),
            max_file_bytes: I('单个文件最大读取字节，默认 512000'),
        }, ['pattern']),
        tool('clipboard_read', '读取 Windows 剪贴板文本。', {}),
        tool('clipboard_write', '把文本写入 Windows 剪贴板。', {
            text: S('要写入的文本'),
        }, ['text']),
        tool('launch_app', '启动程序、打开文档或 URL（Start-Process）。受设置中的“允许启动程序”开关控制。', {
            target: S('可执行文件路径、文档路径或 URL'),
            args: S('命令行参数（可选）'),
            cwd: S('工作目录（可选）'),
        }, ['target']),
        tool('process_list', '列出进程（默认只列有主窗口的进程），可按名称或窗口标题过滤。', {
            filter: S('过滤关键字（进程名或窗口标题）'),
        }),
        tool('view_image', '读取本机图片文件（png/jpg/webp/gif）并作为图像返回，用于看截图、图标、素材。', {
            path: S('图片绝对路径'),
        }, ['path']),
        tool('request_write_access', '申请工作空间外的可写目录。用户在对话中确认一次后，本会话内该目录（含子目录）即可写。仅当确实需要改动工作空间外的文件时调用一次，不要反复申请。', {
            path: S('需要写入的目录或文件绝对路径'),
            reason: S('为什么需要写这个目录（给用户看的一句话）'),
        }, ['path']),
        tool('request_read_access', '申请工作空间外的可读路径（仅在「读取申请（严格模式）」开启时有效）。用户在对话中确认一次后，本会话内该路径（含子目录）即可读。仅在读取被拒时调用一次，不要反复申请。', {
            path: S('需要读取的目录或文件绝对路径'),
            reason: S('为什么需要读这个路径（给用户看的一句话）'),
        }, ['path']),
    ];
}
/** 审计卡片上展示参数用：任何序列化失败都不抛。 */
function safeJson(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return '(参数无法序列化)';
    }
}
//# sourceMappingURL=tools.js.map