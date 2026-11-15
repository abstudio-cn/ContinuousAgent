import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** 把请求 JSON 里的非 ASCII 字符转义，避免 PowerShell 控制台编码干扰。 */
function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}
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
    supported = process.platform === 'win32';
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
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => this.onData(chunk));
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => {
                const text = chunk.trim();
                if (text)
                    this.lastError = text.slice(0, 500);
            });
            child.on('exit', (code) => {
                this.child = null;
                this.ready = false;
                if (code !== 0)
                    this.lastError = this.lastError || '原生桥接进程退出，代码 ' + code;
                for (const [, p] of this.pending) {
                    clearTimeout(p.timer);
                    p.reject(new Error('原生桥接已退出'));
                }
                this.pending.clear();
            });
            child.on('error', (err) => {
                this.lastError = '原生桥接错误: ' + err.message;
            });
            const probe = this.request('ping', {}, 20_000);
            probe.then(() => {
                this.ready = true;
                this.lastError = '';
                settled = true;
                resolve(true);
            }).catch((err) => {
                if (!settled) {
                    this.lastError = '原生桥接初始化失败: ' + err.message;
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
    request(cmd, args = {}, timeoutMs = 30_000) {
        return new Promise((resolve, reject) => {
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