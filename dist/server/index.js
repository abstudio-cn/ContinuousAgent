import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirPath, getSettings, updateSettings } from './settings.js';
import { defaultWorkspace } from './paths.js';
import { AgentRunner } from './agent.js';
import { ToolExecutor } from './tools.js';
import { PluginRegistry } from './plugins.js';
import { NativeBridge } from './native.js';
import { SessionStore, deriveTitleFromPrompt, isDefaultTitle } from './sessions.js';
import { GlobalTipsStore } from './tips.js';
import { getImage } from './imagestore.js';
import { NOTES_MAX_CHARS } from '../shared/prompt.js';
import { testConnection } from './llm.js';
import { splitInputTokens } from '../shared/pricing.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..', '..'); // dist/server -> 项目根
const publicDir = path.join(webRoot, 'public');
const clientDir = path.join(webRoot, 'dist', 'public');
const PORT = Number.parseInt(process.env.PORT || '7800', 10);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = (process.env.CONTINUOUS_AGENT_TOKEN || process.env.GAMEAGENT_TOKEN || '').trim();
/** 校验并裁剪浏览器提交的附件，避免超大 base64 进入内存与磁盘。 */
function parseAttachments(input) {
    if (!Array.isArray(input))
        return [];
    const out = [];
    for (const raw of input.slice(0, 12)) {
        if (!raw || typeof raw !== 'object')
            continue;
        const a = raw;
        const name = typeof a.name === 'string' ? a.name.slice(0, 200) : 'attachment';
        const mime = typeof a.mime === 'string' ? a.mime.slice(0, 120) : 'application/octet-stream';
        const size = typeof a.size === 'number' && Number.isFinite(a.size) ? Math.max(0, Math.trunc(a.size)) : 0;
        const kind = a.kind === 'image' ? 'image' : a.kind === 'text' ? 'text' : '';
        if (!kind)
            continue;
        if (kind === 'image') {
            const dataUrl = typeof a.dataUrl === 'string' ? a.dataUrl : '';
            if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl))
                continue;
            if (dataUrl.length > 9_000_000)
                continue;
            out.push({ name, mime, size, kind, dataUrl });
        }
        else {
            const text = typeof a.text === 'string' ? a.text.slice(0, 60_000) : '';
            if (!text)
                continue;
            out.push({ name, mime, size, kind, text });
        }
    }
    return out;
}
const native = new NativeBridge();
// 全局技巧库：跨会话共享，落在数据目录（不随会话隔离）
const tips = new GlobalTipsStore(path.join(dataDirPath(), 'global_tips.json'), () => {
    const s = getSettings();
    const ws = s.workspacePath || '';
    const dd = dataDirPath();
    const cwd = process.cwd();
    return [ws, path.basename(ws), dd, path.basename(dd), cwd, path.basename(cwd)].filter((x) => !!x);
});
const tools = new ToolExecutor(getSettings(), native, tips);
const sessions = new SessionStore(path.join(dataDirPath(), 'sessions'), getSettings);
// 模型可在收尾时用 rename_session 自行命名会话：写回元数据并广播侧栏
tools.setSessionRenamer((sessionId, title) => {
    const meta = sessions.rename(sessionId, title);
    if (!meta)
        return null;
    broadcastSessions();
    return meta.title;
});
// 插件系统：清单 + 子进程，与核心完全隔离（见 server/plugins.ts 顶部说明）
const pluginRegistry = new PluginRegistry(path.join(dataDirPath(), 'plugins'), () => getSettings().pluginTimeoutMs);
tools.setPluginRegistry(pluginRegistry);
try {
    pluginRegistry.reload();
}
catch {
    /* 插件系统初始化失败不能影响核心启动 */
}
const clients = new Set();
const runners = new Map();
let activeRun = null;
let lastSessionId = '';
// ---------------------------------------------------------------- 事件
function broadcast(event) {
    const payload = 'data: ' + JSON.stringify(event) + '\n\n';
    for (const res of clients) {
        try {
            res.write(payload);
        }
        catch {
            clients.delete(res);
        }
    }
}
function runningIds() {
    const set = new Set();
    for (const [id, runner] of runners)
        if (runner.isRunning)
            set.add(id);
    return set;
}
let sessionsTimer = null;
/** 合并高频刷新（运行中每次状态变化都会触发），400ms 内只推一次列表。 */
function broadcastSessions() {
    if (sessionsTimer)
        return;
    sessionsTimer = setTimeout(() => {
        sessionsTimer = null;
        broadcast({ type: 'sessions', sessions: sessions.infos(runningIds()) });
    }, 400);
}
// ---------------------------------------------------------------- 会话
function ensureSession(id) {
    if (id && sessions.get(id))
        return id;
    if (lastSessionId && sessions.get(lastSessionId))
        return lastSessionId;
    return sessions.ensureDefault().id;
}
/** 模型没有在收尾时自行命名、且标题仍是默认值时，用首条用户消息补一个可读标题。 */
function autoNameSession(sessionId, prompt) {
    const meta = sessions.get(sessionId);
    if (!meta || !isDefaultTitle(meta.title))
        return;
    const title = deriveTitleFromPrompt(prompt);
    if (!title)
        return;
    sessions.rename(sessionId, title);
}
const persistTimers = new Map();
// ---------------------------------------------------------------- 目录授权（会话级白名单）
const accessGrants = new Map();
const readAccessGrants = new Map();
const pendingAccess = new Map();
function grantsFile(sessionId) {
    return path.join(dataDirPath(), 'sessions', sessionId, 'grants.json');
}
function readGrantsFile(sessionId) {
    return path.join(dataDirPath(), 'sessions', sessionId, 'read_grants.json');
}
function readGrantsFor(sessionId) {
    const cached = readAccessGrants.get(sessionId);
    if (cached)
        return cached;
    let list = [];
    try {
        const raw = JSON.parse(fs.readFileSync(readGrantsFile(sessionId), 'utf8'));
        if (Array.isArray(raw))
            list = raw.filter((x) => typeof x === 'string');
    }
    catch {
        /* 还没有可读授权文件 */
    }
    readAccessGrants.set(sessionId, list);
    return list;
}
function saveReadGrants(sessionId, list) {
    readAccessGrants.set(sessionId, list);
    try {
        const file = readGrantsFile(sessionId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
    }
    catch {
        /* 落盘失败不影响当前会话 */
    }
    broadcast({ type: 'readGrants', sessionId, readGrants: list });
}
function grantsFor(sessionId) {
    const cached = accessGrants.get(sessionId);
    if (cached)
        return cached;
    let list = [];
    try {
        const raw = JSON.parse(fs.readFileSync(grantsFile(sessionId), 'utf8'));
        if (Array.isArray(raw))
            list = raw.filter((x) => typeof x === 'string');
    }
    catch {
        /* 还没有授权文件 */
    }
    accessGrants.set(sessionId, list);
    return list;
}
function saveGrants(sessionId, list) {
    accessGrants.set(sessionId, list);
    try {
        const file = grantsFile(sessionId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
    }
    catch {
        /* 落盘失败不影响当前会话 */
    }
    broadcast({ type: 'grants', sessionId, grants: list });
}
/** 模型申请工作空间外目录时：在时间线里放一张确认卡片，等用户点“允许/拒绝”。 */
tools.setAccessBroker({
    ask: (target, reason, kind) => new Promise((resolve) => {
        const sessionId = ensureSession(lastSessionId || undefined);
        const runner = getRunner(sessionId);
        const verb = kind === 'read' ? '读取' : '写入';
        const item = runner.timeline.add('access', '申请' + verb + '：' + target, {
            accessPath: target,
            accessReason: reason,
            accessKind: kind,
            accessStatus: 'pending',
            accessRequestId: '',
        });
        item.accessRequestId = item.id;
        const timer = setTimeout(() => {
            pendingAccess.delete(item.id);
            const patch = { accessStatus: 'denied', text: verb + '授权申请已超时（5 分钟未确认）' };
            runner.timeline.update(item.id, patch);
            broadcast({ type: 'item_update', sessionId, id: item.id, patch });
            resolve(false);
        }, 5 * 60_000);
        pendingAccess.set(item.id, { sessionId, path: target, kind, resolve, timer });
        broadcast({ type: 'item_add', sessionId, item });
    }),
});
// ---------------------------------------------------------------- 插件调用审计
/** 待确认的插件调用：key = 时间线卡片 id */
const pendingPluginAudits = new Map();
/** 用户选择「本会话内允许该插件」的集合：仍逐次写审计日志 */
const sessionPluginAllow = new Map();
let pluginAuditCount = 0;
function pluginAuditFile() {
    return path.join(dataDirPath(), 'plugin_audit.jsonl');
}
function countPluginAudit() {
    try {
        const raw = fs.readFileSync(pluginAuditFile(), 'utf8');
        return raw.split('\n').filter((l) => l.trim()).length;
    }
    catch {
        return 0;
    }
}
/** 审计日志：一次插件调用一行 JSON；写盘失败不影响调用本身。 */
function logPluginAudit(entry) {
    try {
        const file = pluginAuditFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8');
        pluginAuditCount++;
    }
    catch {
        /* ignore */
    }
}
pluginAuditCount = countPluginAudit();
function pluginState() {
    let items = [];
    try {
        items = pluginRegistry.list();
    }
    catch {
        items = [];
    }
    return {
        enabled: !!getSettings().pluginsEnabled,
        dir: pluginRegistry.directory,
        auditCount: pluginAuditCount,
        items,
    };
}
/**
 * 插件调用审计：每次执行前都在时间线上放一张卡片，写明插件用途、工具、参数与将执行的命令，
 * 等用户点「允许本次 / 本会话允许 / 拒绝」。没有界面或出错时一律拒绝——审计不可绕过。
 */
tools.setPluginAuditor((req) => new Promise((resolve) => {
    try {
        const sessionId = ensureSession(lastSessionId || undefined);
        const allowed = sessionPluginAllow.get(sessionId);
        if (allowed && allowed.has(req.pluginId)) {
            logPluginAudit({
                sessionId, pluginId: req.pluginId, pluginName: req.pluginName, tool: req.tool,
                args: req.argsJson, command: req.command, decision: 'session-allow',
            });
            resolve(true);
            return;
        }
        const runner = getRunner(sessionId);
        const item = runner.timeline.add('access', '插件调用审计：' + req.pluginName + ' / ' + req.tool, {
            accessKind: 'plugin',
            accessStatus: 'pending',
            accessRequestId: '',
            accessReason: req.purpose,
            pluginId: req.pluginId,
            pluginName: req.pluginName,
            pluginVersion: req.version,
            pluginPurpose: req.purpose,
            pluginTool: req.tool,
            pluginCommand: req.command,
            pluginArgs: req.argsJson,
            pluginDir: req.dir,
        });
        item.accessRequestId = item.id;
        logPluginAudit({
            sessionId, pluginId: req.pluginId, pluginName: req.pluginName, tool: req.tool,
            args: req.argsJson, command: req.command, decision: 'ask',
        });
        const timer = setTimeout(() => {
            pendingPluginAudits.delete(item.id);
            const patch = {
                accessStatus: 'denied',
                text: '插件调用审计超时（2 分钟未确认），已拒绝执行：' + req.pluginName + ' / ' + req.tool,
            };
            runner.timeline.update(item.id, patch);
            broadcast({ type: 'item_update', sessionId, id: item.id, patch });
            logPluginAudit({ sessionId, pluginId: req.pluginId, tool: req.tool, decision: 'timeout' });
            resolve(false);
        }, 2 * 60_000);
        pendingPluginAudits.set(item.id, { sessionId, pluginId: req.pluginId, tool: req.tool, resolve, timer });
        broadcast({ type: 'item_add', sessionId, item });
    }
    catch {
        // 审计链路自身异常：保守拒绝，绝不静默放行
        resolve(false);
    }
}));
function schedulePersist(sessionId, snapshot) {
    const existing = persistTimers.get(sessionId);
    if (existing)
        clearTimeout(existing);
    persistTimers.set(sessionId, setTimeout(() => {
        persistTimers.delete(sessionId);
        sessions.saveTimeline(sessionId, snapshot.timeline);
        sessions.saveHistory(sessionId, snapshot.history);
        sessions.saveRuntime(sessionId, {
            turn: snapshot.turn,
            promptTokens: snapshot.promptTokens,
            completionTokens: snapshot.completionTokens,
            cachedTokens: snapshot.cachedTokens,
        });
        sessions.touch(sessionId);
    }, 600));
}
function getRunner(sessionId) {
    const existing = runners.get(sessionId);
    if (existing)
        return existing;
    const meta = sessions.get(sessionId);
    const runtime = sessions.loadRuntime(sessionId);
    const runner = new AgentRunner({
        sessionId,
        getSettings,
        tools,
        emit: (event) => {
            broadcast(event);
            if (event.type === 'state')
                broadcastSessions();
        },
        onPersist: (snapshot) => schedulePersist(sessionId, snapshot),
    }, {
        timeline: sessions.loadTimeline(sessionId),
        history: sessions.loadHistory(sessionId),
        turn: runtime.turn,
        promptTokens: runtime.promptTokens,
        completionTokens: runtime.completionTokens,
        cachedTokens: runtime.cachedTokens,
    });
    if (!meta)
        runner.reset();
    runners.set(sessionId, runner);
    return runner;
}
function sessionRecord(sessionId) {
    return sessions.readRecord(sessionId);
}
function sessionNotes(sessionId) {
    return sessions.readNotes(sessionId);
}
function currentState(sessionId) {
    const s = getSettings();
    const id = ensureSession(sessionId);
    lastSessionId = id;
    const meta = sessions.get(id);
    const runner = getRunner(id);
    const t = tools.target;
    const target = t
        ? { pid: t.pid, hwnd: t.hwnd, title: t.title, processName: t.processName, width: t.width, height: t.height }
        : null;
    const record = sessionRecord(id);
    const notes = sessionNotes(id);
    const tipsSummary = tips.stats();
    const backupStats = tools.backups.stats();
    return {
        session: { id, title: meta.title },
        grants: grantsFor(id),
        readGrants: readGrantsFor(id),
        sessions: sessions.infos(runningIds()),
        settings: publicSettings(s),
        status: (() => {
            // 输入拆成两段下发：命中 / 未命中（与 AgentRunner.setState 同一口径，均来自 splitInputTokens）
            const input = splitInputTokens({
                promptTokens: runner.usage.promptTokens,
                cachedTokens: runner.usage.cachedTokens,
            });
            return {
                running: runner.isRunning,
                status: runner.currentStatus,
                turn: runner.currentTurn,
                promptTokens: runner.usage.promptTokens,
                completionTokens: runner.usage.completionTokens,
                cachedTokens: runner.usage.cachedTokens,
                cacheHitTokens: input.hitTokens,
                cacheMissTokens: input.missTokens,
                hasSession: runner.hasSession,
            };
        })(),
        target,
        record,
        notes,
        notesLength: notes.length,
        notesMax: NOTES_MAX_CHARS,
        tips: { count: tipsSummary.count, chars: tipsSummary.chars, max: tipsSummary.max },
        backups: {
            count: backupStats.count,
            bytes: backupStats.bytes,
            folder: backupStats.folder,
            max: backupStats.max,
            enabled: backupStats.enabled,
        },
        plugins: pluginState(),
        // 历史里残留的“待确认”授权卡（进程重启后已无对应会话）标记为失效
        timeline: runner.timeline.items.map((it) => it.kind === 'access' && it.accessStatus === 'pending' && !pendingAccess.has(it.id) && !pendingPluginAudits.has(it.id)
            ? { ...it, accessStatus: 'denied', text: it.text + '（申请已失效，请重试）' }
            : it),
        platform: process.platform,
        nativeAvailable: native.available,
        nativeDetail: native.detail,
    };
}
function publicSettings(s) {
    const { apiKey, cloudTtsApiKey, ...rest } = s;
    return { ...rest, hasApiKey: !!apiKey.trim(), hasCloudTtsApiKey: !!cloudTtsApiKey.trim() };
}
function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
}
async function readBody(req, limit = 4 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text.trim())
                return resolve({});
            try {
                resolve(JSON.parse(text));
            }
            catch (e) {
                reject(new Error('JSON 解析失败: ' + (e instanceof Error ? e.message : String(e))));
            }
        });
        req.on('error', reject);
    });
}
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
};
/**
 * 静态文件服务：一次 stat + ETag/Last-Modified 条件请求。
 * 原实现对 JS/CSS 发 no-store，刷新就要重新下载 40KB+ 脚本；
 * 改成 no-cache（可缓存、每次回源校验）后，命中时只回一个空 304。
 */
function serveFile(req, res, file) {
    let stat;
    try {
        stat = fs.statSync(file);
    }
    catch {
        return false;
    }
    if (!stat.isFile())
        return false;
    const ext = path.extname(file).toLowerCase();
    const mtimeMs = Math.round(stat.mtimeMs);
    const etag = 'W/"' + stat.size.toString(16) + '-' + mtimeMs.toString(16) + '"';
    const cacheHeaders = {
        ETag: etag,
        'Last-Modified': new Date(mtimeMs).toUTCString(),
        'Cache-Control': 'no-cache',
    };
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    const fresh = typeof inm === 'string'
        ? inm.split(',').some((v) => v.trim() === etag)
        : typeof ims === 'string' && Date.parse(ims) >= Math.floor(mtimeMs / 1000) * 1000;
    if (fresh) {
        res.writeHead(304, cacheHeaders);
        res.end();
        return true;
    }
    res.writeHead(200, {
        ...cacheHeaders,
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
    });
    if (req.method === 'HEAD') {
        res.end();
        return true;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return true;
}
function authorized(req) {
    if (!TOKEN)
        return true;
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.searchParams.get('token') === TOKEN)
        return true;
    return (req.headers.authorization || '') === 'Bearer ' + TOKEN;
}
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': req.headers.origin || '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        });
        res.end();
        return;
    }
    if (pathname.startsWith('/api/') && !authorized(req)) {
        json(res, 401, { error: '未授权：缺少 token' });
        return;
    }
    try {
        // ---- 静态资源 ----
        if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
            if (serveFile(req, res, path.join(publicDir, 'index.html')))
                return;
            res.writeHead(404).end('index.html 缺失，请先 npm run build');
            return;
        }
        if (req.method === 'GET' && pathname.startsWith('/app/')) {
            const rel = pathname.slice('/app/'.length);
            const file = path.join(clientDir, rel);
            if (!file.startsWith(clientDir)) {
                res.writeHead(403).end('forbidden');
                return;
            }
            if (serveFile(req, res, file))
                return;
            res.writeHead(404).end('not found');
            return;
        }
        if (req.method === 'GET' && (pathname === '/styles.css' || pathname === '/favicon.ico' || pathname.startsWith('/assets/'))) {
            const rel = pathname.slice(1);
            if (serveFile(req, res, path.join(publicDir, rel)))
                return;
            res.writeHead(404).end('not found');
            return;
        }
        // ---- 状态与事件 ----
        if (req.method === 'GET' && pathname === '/api/state') {
            json(res, 200, currentState(url.searchParams.get('session') || undefined));
            return;
        }
        if (req.method === 'GET' && pathname === '/api/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            res.write('retry: 3000\n\n');
            clients.add(res);
            res.write('data: ' + JSON.stringify({ type: 'sessions', sessions: sessions.infos(runningIds()) }) + '\n\n');
            const hb = setInterval(() => {
                try {
                    res.write(': ping\n\n');
                }
                catch {
                    clearInterval(hb);
                }
            }, 15_000);
            req.on('close', () => {
                clearInterval(hb);
                clients.delete(res);
            });
            return;
        }
        if (req.method === 'GET' && pathname.startsWith('/api/images/')) {
            const id = pathname.slice('/api/images/'.length);
            const img = getImage(id);
            if (!img) {
                res.writeHead(404).end('not found');
                return;
            }
            res.writeHead(200, {
                'Content-Type': img.mime,
                'Cache-Control': 'private, max-age=300',
                'Content-Length': img.data.length,
            });
            res.end(img.data);
            return;
        }
        // ---- 会话 CRUD ----
        if (req.method === 'GET' && pathname === '/api/sessions') {
            json(res, 200, { sessions: sessions.infos(runningIds()) });
            return;
        }
        if (req.method === 'POST' && pathname === '/api/sessions') {
            const body = await readBody(req);
            const meta = sessions.create(typeof body?.title === 'string' ? body.title : undefined);
            broadcastSessions();
            json(res, 200, { ok: true, session: meta, state: currentState(meta.id) });
            return;
        }
        if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/rename$/.test(pathname)) {
            const id = pathname.split('/')[3] || '';
            const body = await readBody(req);
            const meta = sessions.rename(id, String(body?.title ?? ''));
            if (!meta) {
                json(res, 404, { error: '会话不存在' });
                return;
            }
            broadcastSessions();
            json(res, 200, { ok: true, session: meta });
            return;
        }
        if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/delete$/.test(pathname)) {
            const id = pathname.split('/')[3] || '';
            if (!sessions.get(id)) {
                json(res, 404, { error: '会话不存在' });
                return;
            }
            const runner = runners.get(id);
            if (runner?.isRunning) {
                runner.stop();
                await new Promise((r) => setTimeout(r, 300));
            }
            runners.delete(id);
            accessGrants.delete(id);
            readAccessGrants.delete(id);
            sessionPluginAllow.delete(id);
            persistTimers.get(id) && clearTimeout(persistTimers.get(id));
            persistTimers.delete(id);
            sessions.remove(id);
            if (activeRun?.sessionId === id)
                activeRun = null;
            if (lastSessionId === id)
                lastSessionId = '';
            broadcastSessions();
            json(res, 200, { ok: true, state: currentState() });
            return;
        }
        // ---- 全局技巧库（跨会话）----
        if (req.method === 'GET' && pathname === '/api/tips') {
            const st = tips.stats();
            json(res, 200, {
                enabled: getSettings().globalTipsEnabled,
                stats: st,
                entries: tips.list().map((t) => ({
                    id: t.id, text: t.text, uses: t.uses, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt,
                })),
            });
            return;
        }
        // ---- 设置 ----
        if (req.method === 'POST' && pathname === '/api/settings') {
            const body = await readBody(req);
            const next = updateSettings(body && typeof body === 'object' ? body : {});
            tools.updateSettings(next);
            // 插件总开关/超时可能刚被改过：重扫一次清单（失败也不影响设置保存）
            try {
                pluginRegistry.reload();
                broadcast({ type: 'plugins', plugins: pluginState() });
            }
            catch {
                /* ignore */
            }
            if (!fs.existsSync(next.workspacePath)) {
                try {
                    fs.mkdirSync(next.workspacePath, { recursive: true });
                }
                catch {
                    /* ignore */
                }
            }
            json(res, 200, { ok: true, state: currentState() });
            return;
        }
        // ---- 窗口 ----
        if (req.method === 'GET' && pathname === '/api/windows') {
            if (!native.available) {
                json(res, 200, { windows: [], nativeAvailable: false, detail: native.detail });
                return;
            }
            try {
                const windows = await native.listWindows();
                json(res, 200, { windows, nativeAvailable: true });
            }
            catch (e) {
                json(res, 200, { windows: [], nativeAvailable: false, detail: e instanceof Error ? e.message : String(e) });
            }
            return;
        }
        if (req.method === 'POST' && pathname === '/api/window/select') {
            const body = await readBody(req);
            const pid = Number(body?.pid) || 0;
            const host = native.available
                ? await tools.selectWindow(pid, typeof body?.title === 'string' ? body.title : undefined)
                : null;
            if (!host) {
                json(res, 400, { error: native.available ? '未找到该窗口' : '原生桥接不可用：' + native.detail });
                return;
            }
            const target = {
                pid: host.pid, hwnd: host.hwnd, title: host.title,
                processName: host.processName, width: host.width, height: host.height,
            };
            broadcast({ type: 'target', sessionId: ensureSession(body?.sessionId), target });
            json(res, 200, { ok: true, target, state: currentState(body?.sessionId) });
            return;
        }
        if (req.method === 'POST' && pathname === '/api/window/clear') {
            tools.clearWindow();
            const body = await readBody(req).catch(() => ({}));
            broadcast({ type: 'target', sessionId: ensureSession(body?.sessionId), target: null });
            json(res, 200, { ok: true });
            return;
        }
        // ---- 运行控制 ----
        if (req.method === 'POST' && pathname === '/api/agent/start') {
            const body = await readBody(req, 24 * 1024 * 1024);
            const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
            const sessionId = ensureSession(body?.sessionId);
            if (!prompt) {
                json(res, 400, { error: '请输入任务描述' });
                return;
            }
            if (activeRun && activeRun.runner.isRunning) {
                json(res, 409, {
                    error: activeRun.sessionId === sessionId
                        ? '该会话正在运行中'
                        : '另一个会话正在运行（同一时间只允许一个会话托管窗口），请先中断它',
                    activeSessionId: activeRun.sessionId,
                });
                return;
            }
            const meta = sessions.get(sessionId) ?? sessions.ensureDefault();
            const runner = getRunner(sessionId);
            // 每次运行前把本会话的授权白名单同步给（共享的）工具执行器
            tools.setGrants(grantsFor(sessionId));
            tools.setReadGrants(readGrantsFor(sessionId));
            activeRun = { sessionId, runner };
            lastSessionId = sessionId;
            void runner.start(prompt, {
                title: meta.title,
                recordPath: sessions.recordPath(sessionId),
                notesPath: sessions.notesPath(sessionId),
            }, parseAttachments(body?.attachments)).finally(() => {
                if (activeRun?.runner === runner)
                    activeRun = null;
                autoNameSession(sessionId, prompt);
                broadcastSessions();
            });
            json(res, 200, { ok: true, sessionId });
            return;
        }
        if (req.method === 'POST' && pathname === '/api/agent/stop') {
            const body = await readBody(req).catch(() => ({}));
            const sessionId = ensureSession(body?.sessionId);
            runners.get(sessionId)?.stop();
            json(res, 200, { ok: true });
            return;
        }
        if (req.method === 'POST' && pathname === '/api/agent/reset') {
            const body = await readBody(req).catch(() => ({}));
            const sessionId = ensureSession(body?.sessionId);
            getRunner(sessionId).reset();
            broadcastSessions();
            json(res, 200, { ok: true, state: currentState(sessionId) });
            return;
        }
        if (req.method === 'POST' && pathname === '/api/agent/clear-timeline') {
            const body = await readBody(req).catch(() => ({}));
            const sessionId = ensureSession(body?.sessionId);
            const runner = getRunner(sessionId);
            runner.timeline.clear();
            broadcast({ type: 'clear', sessionId });
            json(res, 200, { ok: true });
            return;
        }
        // ---- 目录授权响应 ----
        if (req.method === 'POST' && pathname === '/api/access/respond') {
            const body = await readBody(req);
            const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
            const allow = body?.allow === true;
            const pending = pendingAccess.get(requestId);
            if (!pending) {
                json(res, 404, { error: '该授权申请已过期或不存在' });
                return;
            }
            pendingAccess.delete(requestId);
            clearTimeout(pending.timer);
            const sessionId = pending.sessionId;
            const runner = getRunner(sessionId);
            const verb = pending.kind === 'read' ? '读取' : '写入';
            if (allow) {
                const list = (pending.kind === 'read' ? readGrantsFor(sessionId) : grantsFor(sessionId)).slice();
                if (!list.some((p) => p.toLowerCase() === pending.path.toLowerCase()))
                    list.push(pending.path);
                if (pending.kind === 'read') {
                    saveReadGrants(sessionId, list);
                    tools.addReadGrant(pending.path);
                }
                else {
                    saveGrants(sessionId, list);
                    tools.addGrant(pending.path);
                }
            }
            const patch = allow
                ? { accessStatus: 'granted', text: '已授权' + verb + '：' + pending.path }
                : { accessStatus: 'denied', text: '已拒绝' + verb + '：' + pending.path };
            runner.timeline.update(requestId, patch);
            broadcast({ type: 'item_update', sessionId, id: requestId, patch });
            pending.resolve(allow);
            json(res, 200, { ok: true, grants: grantsFor(sessionId), readGrants: readGrantsFor(sessionId) });
            return;
        }
        // ---- 插件 ----
        if (req.method === 'GET' && pathname === '/api/plugins') {
            json(res, 200, pluginState());
            return;
        }
        if (req.method === 'POST' && pathname === '/api/plugins/reload') {
            try {
                pluginRegistry.reload();
            }
            catch {
                /* 重载失败保持原清单，核心不受影响 */
            }
            const payload = pluginState();
            broadcast({ type: 'plugins', plugins: payload });
            json(res, 200, { ok: true, plugins: payload });
            return;
        }
        // ---- 插件调用审计响应 ----
        if (req.method === 'POST' && pathname === '/api/plugin/respond') {
            const body = await readBody(req);
            const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
            const decision = body?.decision === 'allow' ? 'allow' : body?.decision === 'session' ? 'session' : 'deny';
            const pending = pendingPluginAudits.get(requestId);
            if (!pending) {
                json(res, 404, { error: '该审计请求已过期或不存在' });
                return;
            }
            pendingPluginAudits.delete(requestId);
            clearTimeout(pending.timer);
            const sessionId = pending.sessionId;
            const runner = getRunner(sessionId);
            const patch = decision === 'deny'
                ? { accessStatus: 'denied', text: '已拒绝该插件调用' }
                : { accessStatus: 'granted', text: decision === 'session' ? '已允许（本会话内该插件不再逐次询问，仍写审计日志）' : '已允许本次调用' };
            if (decision === 'session') {
                const set = sessionPluginAllow.get(sessionId) || new Set();
                set.add(pending.pluginId);
                sessionPluginAllow.set(sessionId, set);
            }
            runner.timeline.update(requestId, patch);
            broadcast({ type: 'item_update', sessionId, id: requestId, patch });
            logPluginAudit({ sessionId, pluginId: pending.pluginId, tool: pending.tool, decision: 'user-' + decision });
            pending.resolve(decision !== 'deny');
            json(res, 200, { ok: true });
            return;
        }
        if (req.method === 'POST' && pathname === '/api/test-connection') {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30_000);
            try {
                const result = await testConnection(getSettings(), controller.signal);
                json(res, 200, result);
            }
            finally {
                clearTimeout(timer);
            }
            return;
        }
        // ---- TTS 代理 ----
        if (req.method === 'POST' && pathname === '/api/tts') {
            const body = await readBody(req, 200_000);
            const text = typeof body?.text === 'string' ? body.text.trim() : '';
            if (!text) {
                json(res, 400, { error: 'text 为空' });
                return;
            }
            const s = getSettings();
            if (!s.cloudTtsBaseUrl.trim()) {
                json(res, 400, { error: '未配置云端 TTS 地址（设置 → 语音）' });
                return;
            }
            const base = s.cloudTtsBaseUrl.trim().replace(/\/+$/, '');
            const target = /\/audio\/speech$/.test(base) ? base : base + '/audio/speech';
            const headers = { 'Content-Type': 'application/json' };
            if (s.cloudTtsApiKey.trim())
                headers.Authorization = 'Bearer ' + s.cloudTtsApiKey.trim();
            const upstream = await fetch(target, {
                method: 'POST',
                headers,
                body: JSON.stringify({ model: s.cloudTtsModel, voice: s.cloudTtsVoice, input: text, response_format: 'wav' }),
            });
            if (!upstream.ok) {
                const msg = await upstream.text().catch(() => '');
                json(res, 502, { error: '上游 TTS 失败: HTTP ' + upstream.status + ' ' + msg.slice(0, 300) });
                return;
            }
            const buf = Buffer.from(await upstream.arrayBuffer());
            res.writeHead(200, {
                'Content-Type': upstream.headers.get('content-type') || 'audio/wav',
                'Cache-Control': 'no-store',
                'Content-Length': buf.length,
            });
            res.end(buf);
            return;
        }
        // ---- 单个会话的文档 ----
        if (req.method === 'GET' && pathname === '/api/record') {
            const id = ensureSession(url.searchParams.get('session') || undefined);
            json(res, 200, { markdown: sessionRecord(id), path: sessions.recordPath(id), sessionId: id });
            return;
        }
        if (req.method === 'GET' && pathname === '/api/notes') {
            const id = ensureSession(url.searchParams.get('session') || undefined);
            const md = sessionNotes(id);
            json(res, 200, { markdown: md, length: md.length, max: NOTES_MAX_CHARS, path: sessions.notesPath(id), sessionId: id });
            return;
        }
        json(res, 404, { error: 'not found' });
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!res.headersSent)
            json(res, 500, { error: message });
        else
            res.end();
    }
});
server.listen(PORT, HOST, () => {
    const s = getSettings();
    if (!fs.existsSync(s.workspacePath)) {
        try {
            fs.mkdirSync(s.workspacePath, { recursive: true });
        }
        catch {
            /* ignore */
        }
    }
    const first = sessions.ensureDefault();
    tools.bindSession({
        id: first.id,
        title: first.title,
        recordPath: sessions.recordPath(first.id),
        notesPath: sessions.notesPath(first.id),
    });
    console.log('ContinuousAgent 已启动: http://' + HOST + ':' + PORT);
    console.log('数据目录: ' + dataDirPath());
    console.log('工作空间: ' + (s.workspacePath || defaultWorkspace()));
    console.log('会话: ' + sessions.list().length + ' 个（记录与笔记按会话隔离在 sessions/<id>/）');
    if (!native.supported) {
        console.log('原生桥接不可用：当前平台 ' + process.platform);
    }
    else {
        native.start().then((ok) => {
            console.log(ok ? '原生桥接已就绪：' + native.detail : '原生桥接启动失败：' + native.detail);
            broadcast({ type: 'native', available: native.available, detail: native.detail });
        });
    }
});
const shutdown = () => {
    console.log('正在退出…');
    for (const [id, timer] of persistTimers) {
        clearTimeout(timer);
        const runner = runners.get(id);
        if (runner) {
            const snap = runner.snapshot();
            sessions.saveTimeline(id, snap.timeline);
            sessions.saveHistory(id, snap.history);
            sessions.saveRuntime(id, {
                turn: snap.turn,
                promptTokens: snap.promptTokens,
                completionTokens: snap.completionTokens,
                cachedTokens: snap.cachedTokens,
            });
        }
    }
    tools.dispose();
    native.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
//# sourceMappingURL=index.js.map