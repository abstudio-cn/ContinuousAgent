import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** 把请求 JSON 里的非 ASCII 字符转义，避免 PowerShell 控制台编码干扰。 */
function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}
/** 桥接异常退出后的重启退避：1s → 2s → 4s → 8s → 16s（上限）。 */
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 16_000;
function hostScript() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/server/native.js -> web/scripts/native-host.ps1
    const candidates = [
        path.resolve(here, '..', '..', 'scripts', 'native-host.ps1'),
        path.resolve(here, '..', '..', '..', 'scripts', 'native-host.ps1'),
        path.resolve(process.cwd(), 'scripts', 'native-host.ps1'),
    ];
    for (const c of candidates)
        if (fs.existsSync(c))
            return c;
    return candidates[0];
}
export class NativeBridge {
    child = null;
    seq = 0;
    pending = new Map();
    ready = false;
    lastError = '';
    buffer = '';
    starting = null;
    /** 主动关闭中：此时退出事件不应触发自动重启。 */
    stopping = false;
    restartTimer = null;
    restartAttempts = 0;
    onChange = null;
    supported = process.platform === 'win32';
    /** 供诊断/测试读取当前宿主进程号。 */
    get pid() {
        return this.child?.pid ?? null;
    }
    /** 桥接可用性变化回调（上线/掉线/重启成功都会触发），用于推送前端横幅。 */
    setChangeListener(fn) {
        this.onChange = fn;
    }
    notify() {
        try {
            this.onChange?.(this.available, this.detail);
        }
        catch {
            /* 回调异常不影响桥接本身 */
        }
    }
    clearRestartTimer() {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
    }
    /**
     * 桥接非正常退出后的自动重启：1s / 2s / 4s / 8s / 16s 指数退避（封顶）。
     * 成功连上后把计数归零，所以偶发崩溃能立刻恢复，反复崩溃也不会打满 CPU。
     */
    scheduleRestart() {
        if (!this.supported || this.stopping || this.restartTimer)
            return;
        const attempt = this.restartAttempts++;
        const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.min(attempt, 4));
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.stopping)
                return;
            void this.start().catch(() => undefined);
        }, delay);
        this.restartTimer.unref?.();
    }
    get available() {
        return this.supported && this.child !== null && this.ready;
    }
    get detail() {
        if (!this.supported)
            return '原生桥接仅支持 Windows（当前 ' + process.platform + '）；键鼠、截图、OCR 不可用。';
        if (this.available)
            return '原生桥接已连接（PowerShell / Win32）。';
        return this.lastError || '原生桥接未启动。';
    }
    async start() {
        if (!this.supported)
            return false;
        if (this.available)
            return true;
        if (this.starting)
            return this.starting;
        this.stopping = false;
        this.clearRestartTimer();
        // 上一代 child 存在却未就绪（探活失败 / 半死）：先清掉再重启，避免留下孤儿进程
        if (this.child) {
            const stale = this.child;
            this.child = null;
            this.ready = false;
            try {
                stale.kill();
            }
            catch {
                /* ignore */
            }
        }
        this.starting = new Promise((resolve) => {
            const script = hostScript();
            if (!fs.existsSync(script)) {
                this.lastError = '找不到 native-host.ps1：' + script;
                resolve(false);
                return;
            }
            let settled = false;
            let child;
            try {
                child = spawn('powershell.exe', [
                    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                    '-File', script,
                ], { windowsHide: true, stdio: 'pipe' });
            }
            catch (err) {
                this.lastError = '无法启动 PowerShell: ' + (err instanceof Error ? err.message : String(err));
                resolve(false);
                return;
            }
            this.child = child;
            this.buffer = '';
            // stdin 出错（桥接刚死时写管道会 EPIPE）必须吞掉：'error' 事件是异步派发的，
            // 外层 try/catch 抓不到，漏了它会变成 uncaughtException 把整个服务带崩。
            child.stdin.on('error', () => {
                /* ignore */
            });
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => this.onData(chunk));
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => {
                const text = chunk.trim();
                if (text)
                    this.lastError = text.slice(0, 500);
            });
            child.on('exit', (code) => {
                // 只认「当前这一代」child：重启时旧 child 的迟到退出事件不能影响新连接
                if (this.child !== child)
                    return;
                this.child = null;
                this.ready = false;
                if (code !== 0)
                    this.lastError = this.lastError || '原生桥接进程退出，代码 ' + code;
                for (const [, p] of this.pending) {
                    clearTimeout(p.timer);
                    p.reject(new Error('原生桥接已退出'));
                }
                this.pending.clear();
                this.notify();
                if (!this.stopping)
                    this.scheduleRestart();
            });
            child.on('error', (err) => {
                this.lastError = '原生桥接错误: ' + err.message;
            });
            // 探活必须走 send()：request() 会先判 available 再调 start()，在这里会自锁
            const probe = this.send('ping', {}, 20_000);
            probe.then(() => {
                this.ready = true;
                this.lastError = '';
                this.restartAttempts = 0;
                settled = true;
                this.notify();
                resolve(true);
            }).catch((err) => {
                if (!settled) {
                    this.lastError = '原生桥接初始化失败: ' + err.message;
                    this.notify();
                    resolve(false);
                }
            });
        }).finally(() => {
            this.starting = null;
        });
        return this.starting;
    }
    onData(chunk) {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                continue;
            }
            const id = Number(msg.id);
            const pending = this.pending.get(id);
            if (!pending)
                continue;
            this.pending.delete(id);
            clearTimeout(pending.timer);
            if (msg.ok)
                pending.resolve(msg.data);
            else
                pending.reject(new Error(String(msg.error || '原生命令失败')));
        }
    }
    /**
     * 对外的请求入口：桥接不在线时先尝试重连（含崩溃后的自动重启），
     * 这样任何一次工具调用都能把桥接「拉起来」，而不是永久卡在不可用状态。
     */
    async request(cmd, args = {}, timeoutMs = 30_000) {
        if (this.stopping)
            throw new Error('原生桥接已关闭');
        if (!this.available) {
            const ok = await this.start();
            if (!ok)
                throw new Error(this.lastError || '原生桥接未运行');
        }
        return this.send(cmd, args, timeoutMs);
    }
    /** 只把一行请求写进宿主并等应答，不做重连（内部使用，避免 start() 递归调 request）。 */
    send(cmd, args = {}, timeoutMs = 30_000) {
        const promise = new Promise((resolve, reject) => {
            const child = this.child;
            if (!child || !child.stdin.writable) {
                reject(new Error(this.lastError || '原生桥接未运行'));
                return;
            }
            const id = ++this.seq;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('原生命令超时（' + cmd + '）'));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                child.stdin.write(asciiJson({ id, cmd, args }) + '\n');
            }
            catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
        // 影子 catch：pending 请求可能在调用方已经放弃（用户中断/上层超时）之后才被 reject，
        // 那种「无人接收」的 rejection 会升级成 unhandledRejection，直接把整个服务进程打崩。
        // 挂一个空的 catch 只是给引擎一个 handler，返回的仍是原来的 promise，await 方照常拿到异常。
        promise.catch(() => undefined);
        return promise;
    }
    async listWindows() {
        const data = await this.request('list-windows', {}, 20_000);
        return Array.isArray(data?.windows) ? data.windows : [];
    }
    async windowInfo(hwnd) {
        return this.request('window-info', { hwnd }, 15_000);
    }
    async activate(hwnd) {
        const data = await this.request('activate', { hwnd }, 15_000);
        return !!data?.activated;
    }
    /** 截图到临时文件，读回 Buffer 后删除临时文件。 */
    /**
     * 后台截图：只走 PrintWindow，不激活窗口、不改变前后台、不抓屏幕像素。
     * 多会话并行时用它观察窗口，永远不会抢焦点。
     */
    async captureBackground(hwnd, maxWidth, format = 'jpeg') {
        const data = await this.request('capture-bg', { hwnd, maxWidth, format }, 30_000);
        try {
            const buffer = await fs.promises.readFile(data.path);
            return {
                buffer,
                width: Number(data.width) || 0,
                height: Number(data.height) || 0,
                clientWidth: Number(data.clientWidth) || 0,
                clientHeight: Number(data.clientHeight) || 0,
                method: String(data.method || 'printwindow'),
                minimized: !!data.minimized,
                isForeground: !!data.isForeground,
                occluded: !!data.occluded,
                blank: !!data.blank,
            };
        }
        finally {
            fs.promises.unlink(data.path).catch(() => undefined);
        }
    }
    /** 目标窗口的前后台/最小化/遮挡状态（只读，不改任何状态）。 */
    async windowState(hwnd) {
        return this.request('window-state', { hwnd }, 15_000);
    }
    /** 当前前台窗口（只读）。 */
    async foreground() {
        return this.request('foreground', {}, 15_000);
    }
    async capture(hwnd, maxWidth, format = 'jpeg') {
        const data = await this.request('screenshot', { hwnd, maxWidth, format }, 30_000);
        try {
            const buffer = await fs.promises.readFile(data.path);
            return {
                buffer,
                width: Number(data.width) || 0,
                height: Number(data.height) || 0,
                clientWidth: Number(data.clientWidth) || 0,
                clientHeight: Number(data.clientHeight) || 0,
            };
        }
        finally {
            fs.promises.unlink(data.path).catch(() => undefined);
        }
    }
    async ocr(imagePath, language) {
        return this.request('ocr', { path: imagePath, language }, 90_000);
    }
    async saveTemp(buffer, ext) {
        const dir = path.join(os.tmpdir(), 'continuous-agent');
        await fs.promises.mkdir(dir, { recursive: true });
        const file = path.join(dir, 'ocr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
        await fs.promises.writeFile(file, buffer);
        return file;
    }
    async removeTemp(file) {
        await fs.promises.unlink(file).catch(() => undefined);
    }
    stop() {
        this.stopping = true;
        this.clearRestartTimer();
        try {
            this.child?.stdin.write(asciiJson({ id: ++this.seq, cmd: 'shutdown', args: {} }) + '\n');
        }
        catch {
            /* ignore */
        }
        setTimeout(() => {
            try {
                this.child?.kill();
            }
            catch {
                /* ignore */
            }
        }, 500).unref();
    }
}
//# sourceMappingURL=native.js.map