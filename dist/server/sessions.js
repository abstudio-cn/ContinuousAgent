import fs from 'node:fs';
import path from 'node:path';
import { NOTES_TEMPLATE, RECORD_TEMPLATE } from '../shared/prompt.js';
import { isSceneId, DEFAULT_SCENE } from '../shared/scenes.js';
import { ensureDir, stamp } from './paths.js';
import { sanitizeHistory, trimHistoryMessages } from './history.js';
const MAX_TIMELINE_ITEMS = 240;
const MAX_HISTORY_MESSAGES = 80;
// ---- 历史检索上限（防止一次搜索把全部会话无界读入）----
/** 单次检索最多拆多少个关键词 */
const MAX_SEARCH_TERMS = 8;
/** 单次检索最多扫多少个会话 */
const DEFAULT_SEARCH_SESSIONS = 120;
/** 每个会话最多返回几条命中片段 */
const DEFAULT_SEARCH_PER_SESSION = 3;
/** 最多返回多少个会话分组 */
const DEFAULT_SEARCH_GROUPS = 20;
/** 单条候选文本最多扫多长（超长助手回复/工具输出只扫前段，避免放大成 O(全量字符)） */
const MAX_SEARCH_SCAN_CHARS = 200_000;
/** 片段前后各留多少字符 */
const SNIPPET_RADIUS = 40;
function clampInt(v, min, max, fallback) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}
/** 截取命中点周围的一段文本：折叠空白、两端补省略号。命中点取「最早出现的那个关键词」。 */
function searchSnippet(text, terms) {
    const lower = text.toLowerCase();
    let at = -1;
    for (const t of terms) {
        const i = lower.indexOf(t);
        if (i >= 0 && (at < 0 || i < at))
            at = i;
    }
    const flat = (s) => s.replace(/\s+/g, ' ').trim();
    if (at < 0)
        return flat(text).slice(0, SNIPPET_RADIUS * 2);
    // 命中点向左扩展时，若正好落在词中间也无需精细对齐：片段只用于展示
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(text.length, at + SNIPPET_RADIUS * 2);
    return (start > 0 ? '…' : '') + flat(text.slice(start, end)) + (end < text.length ? '…' : '');
}
/** 会话元数据与运行数据存储。记录/笔记落在工作空间的 sessions/<id>/ 下，做到会话隔离。 */
export class SessionStore {
    rootDir;
    getSettings;
    meta = [];
    /** 记录/笔记字数缓存（按文件 stat 校验），见 safeLength。 */
    lengthCache = new Map();
    constructor(rootDir, getSettings) {
        this.rootDir = rootDir;
        this.getSettings = getSettings;
        ensureDir(this.rootDir);
        this.readIndex();
    }
    indexFile() {
        return path.join(this.rootDir, 'index.json');
    }
    readIndex() {
        try {
            const raw = fs.readFileSync(this.indexFile(), 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                this.meta = parsed.filter((m) => m && typeof m.id === 'string');
            }
        }
        catch {
            this.meta = [];
        }
    }
    writeIndex() {
        ensureDir(this.rootDir);
        fs.writeFileSync(this.indexFile(), JSON.stringify(this.meta, null, 2), 'utf8');
    }
    /** 工作空间下的会话数据目录（记录、笔记）。 */
    dataDirFor(id) {
        return path.join(this.getSettings().workspacePath, 'sessions', id);
    }
    recordPath(id) {
        return this.preferExisting(id, this.getSettings().gameRecordFileName || 'game_state.md', 'game_state.md');
    }
    notesPath(id) {
        return this.preferExisting(id, this.getSettings().gameNotesFileName || 'game_notes.md', 'game_notes.md');
    }
    /** 兼容改名前的旧文件名：新名字不存在但旧文件在时，继续用旧文件，避免历史内容“消失”。 */
    preferExisting(id, fileName, legacyName) {
        const dir = this.dataDirFor(id);
        const full = path.join(dir, fileName);
        if (fileName === legacyName)
            return full;
        if (fs.existsSync(full))
            return full;
        const legacy = path.join(dir, legacyName);
        return fs.existsSync(legacy) ? legacy : full;
    }
    list() {
        return [...this.meta].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    get(id) {
        return this.meta.find((m) => m.id === id) ?? null;
    }
    create(title) {
        const now = Date.now();
        const id = 's' + now.toString(36) + Math.random().toString(36).slice(2, 6);
        const meta = {
            id,
            title: (title || '').trim() || defaultTitle(now),
            createdAt: now,
            updatedAt: now,
            // 新会话的默认场景固定为「通用」：不跟随全局设置，避免新建的对话凭空带上
            // 之前为某个对话选过的场景。全局 toolScene 只对更早的「无场景字段」会话生效。
            toolScene: DEFAULT_SCENE,
        };
        this.meta.push(meta);
        this.writeIndex();
        this.ensureFiles(id);
        return meta;
    }
    /**
     * 读取会话的生效场景：会话里单独设置过的字段优先，其余回落全局设置。
     * 这样旧会话（没有这两个字段）行为与改动前一致，新会话各自独立。
     */
    sceneOf(id) {
        const s = this.getSettings();
        const meta = this.get(id);
        const base = {
            toolScene: s.toolScene || DEFAULT_SCENE,
            sceneGuideEnabled: !!s.sceneGuideEnabled,
            inherited: true,
        };
        if (!meta)
            return base;
        const hasScene = isSceneId(meta.toolScene);
        const hasGuide = typeof meta.sceneGuideEnabled === 'boolean';
        if (!hasScene && !hasGuide)
            return base;
        return {
            toolScene: hasScene ? meta.toolScene : base.toolScene,
            sceneGuideEnabled: hasGuide ? !!meta.sceneGuideEnabled : base.sceneGuideEnabled,
            inherited: false,
        };
    }
    /** 设置会话级场景（只写传进来的字段）；会话不存在返回 null。 */
    setScene(id, patch) {
        const meta = this.get(id);
        if (!meta)
            return null;
        if (patch.toolScene !== undefined) {
            const scene = typeof patch.toolScene === 'string' ? patch.toolScene.trim().toLowerCase() : '';
            if (isSceneId(scene))
                meta.toolScene = scene;
        }
        if (patch.sceneGuideEnabled !== undefined)
            meta.sceneGuideEnabled = !!patch.sceneGuideEnabled;
        meta.updatedAt = Date.now();
        this.writeIndex();
        return this.sceneOf(id);
    }
    rename(id, title) {
        const meta = this.get(id);
        if (!meta)
            return null;
        const next = title.trim();
        if (next)
            meta.title = next.slice(0, 80);
        meta.updatedAt = Date.now();
        this.writeIndex();
        return meta;
    }
    touch(id) {
        const meta = this.get(id);
        if (!meta)
            return;
        meta.updatedAt = Date.now();
        this.writeIndex();
    }
    /**
     * 删除会话：运行数据移入回收站，元数据移除。
     * 记录与笔记所在的会话目录整体移入 <工作空间>/.trash，7 天内可恢复。
     */
    remove(id) {
        const meta = this.get(id);
        if (!meta)
            return false;
        const sessionDir = this.dataDirFor(id);
        if (fs.existsSync(sessionDir)) {
            const trash = path.join(this.getSettings().workspacePath, '.trash');
            ensureDir(trash);
            try {
                fs.renameSync(sessionDir, path.join(trash, stamp() + '_session-' + id));
            }
            catch {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        }
        const runtimeDir = path.join(this.rootDir, id);
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        this.meta = this.meta.filter((m) => m.id !== id);
        this.writeIndex();
        return true;
    }
    /** 为新会话准备记录/笔记模板文件。 */
    ensureFiles(id) {
        const dir = this.dataDirFor(id);
        ensureDir(dir);
        const rec = this.recordPath(id);
        if (!fs.existsSync(rec))
            fs.writeFileSync(rec, RECORD_TEMPLATE, 'utf8');
        const notes = this.notesPath(id);
        if (!fs.existsSync(notes))
            fs.writeFileSync(notes, NOTES_TEMPLATE, 'utf8');
    }
    readRecord(id) {
        this.ensureFiles(id);
        try {
            return fs.readFileSync(this.recordPath(id), 'utf8');
        }
        catch (e) {
            return '(读取工作记录失败: ' + (e instanceof Error ? e.message : String(e)) + ')';
        }
    }
    readNotes(id) {
        this.ensureFiles(id);
        try {
            return fs.readFileSync(this.notesPath(id), 'utf8');
        }
        catch (e) {
            return '(读取工作笔记失败: ' + (e instanceof Error ? e.message : String(e)) + ')';
        }
    }
    /** 只读读取文本文件：不存在/读失败一律空串，且**不**建目录、不写模板（检索必须是纯只读）。 */
    readTextIfExists(file) {
        try {
            return fs.readFileSync(file, 'utf8');
        }
        catch {
            return '';
        }
    }
    timelineFile(id) {
        return path.join(this.rootDir, id, 'timeline.json');
    }
    /**
     * 跨会话检索历史（纯只读：不建目录、不写盘、不改任何历史数据）。
     * 关键词按空白拆分，**全部命中**才算命中（AND）；大小写不敏感，中文按子串。
     * 结果按「命中词数 → 命中条目数 → 最近更新」排序，并带上限避免一次读爆。
     */
    search(query, opts = {}) {
        const terms = Array.from(new Set(String(query ?? '')
            .toLowerCase()
            .split(/\s+/)
            .map((t) => t.trim())
            .filter((t) => t.length > 0))).slice(0, MAX_SEARCH_TERMS);
        const scope = opts.scope === 'all' ? 'all' : 'chat';
        const report = {
            query: String(query ?? '').trim(),
            terms,
            scope,
            scanned: 0,
            totalHits: 0,
            groups: [],
            truncated: false,
        };
        if (terms.length === 0)
            return report;
        const maxSessions = clampInt(opts.maxSessions, 1, 500, DEFAULT_SEARCH_SESSIONS);
        const maxPerSession = clampInt(opts.maxPerSession, 1, 20, DEFAULT_SEARCH_PER_SESSION);
        const maxGroups = clampInt(opts.maxGroups, 1, 100, DEFAULT_SEARCH_GROUPS);
        for (const meta of this.list()) {
            if (report.scanned >= maxSessions) {
                report.truncated = true;
                break;
            }
            report.scanned++;
            const hits = [];
            const matchedTerms = new Set();
            let hitCount = 0;
            // 单条候选文本：全部关键词命中才计入；只取前若干条命中做片段，其余仅计数
            const consider = (kind, itemId, time, raw) => {
                if (!raw)
                    return;
                const text = raw.length > MAX_SEARCH_SCAN_CHARS ? raw.slice(0, MAX_SEARCH_SCAN_CHARS) : raw;
                const lower = text.toLowerCase();
                for (const t of terms)
                    if (!lower.includes(t))
                        return;
                hitCount++;
                for (const t of terms)
                    matchedTerms.add(t);
                if (hits.length < maxPerSession) {
                    hits.push({ itemId, kind, time, matched: [...terms], snippet: searchSnippet(text, terms) });
                }
            };
            consider('session-title', '', '', meta.title);
            const timelineRaw = this.readTextIfExists(this.timelineFile(meta.id));
            if (timelineRaw) {
                let items = [];
                try {
                    const arr = JSON.parse(timelineRaw);
                    if (Array.isArray(arr))
                        items = arr;
                }
                catch {
                    items = []; // 时间线损坏：跳过该会话的对话部分，不影响其它会话
                }
                for (const item of items) {
                    if (!item || typeof item.text !== 'string')
                        continue;
                    const isChat = item.kind === 'user' || item.kind === 'assistant' || item.kind === 'system';
                    if (scope === 'chat' && !isChat)
                        continue;
                    // 对话范围只搜正文；范围 all 时把工具产物/详情也纳入（对比「当时到底跑了什么」很有用）
                    const raw = scope === 'all'
                        ? [item.title, item.text, item.detail, item.meta].filter(Boolean).join('\n')
                        : item.text;
                    consider(item.kind, item.id || '', item.time || '', raw);
                }
            }
            if (scope === 'all') {
                consider('record', '', '', this.readTextIfExists(this.recordPath(meta.id)));
                consider('notes', '', '', this.readTextIfExists(this.notesPath(meta.id)));
            }
            if (hitCount > 0) {
                report.totalHits += hitCount;
                report.groups.push({
                    sessionId: meta.id,
                    title: meta.title,
                    updatedAt: meta.updatedAt,
                    hitCount,
                    score: matchedTerms.size,
                    hits,
                });
            }
        }
        // 每会话命中片段数被 per 截断时，整体结果同样不完整，必须如实标记；
        // 否则调用方会把「每组只剩 N 条」当成「一共只有 N 条命中」。
        if (report.groups.some((g) => g.hitCount > g.hits.length))
            report.truncated = true;
        report.groups.sort((a, b) => b.score - a.score || b.hitCount - a.hitCount || b.updatedAt - a.updatedAt);
        if (report.groups.length > maxGroups) {
            report.groups = report.groups.slice(0, maxGroups);
            report.truncated = true;
        }
        return report;
    }
    // ---- 运行数据（时间线/历史/用量） ----
    runtimeDir(id) {
        const dir = path.join(this.rootDir, id);
        ensureDir(dir);
        return dir;
    }
    loadTimeline(id) {
        try {
            const raw = fs.readFileSync(path.join(this.runtimeDir(id), 'timeline.json'), 'utf8');
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        }
        catch {
            return [];
        }
    }
    saveTimeline(id, items) {
        try {
            const trimmed = items.slice(-MAX_TIMELINE_ITEMS);
            fs.writeFileSync(path.join(this.runtimeDir(id), 'timeline.json'), JSON.stringify(trimmed), 'utf8');
        }
        catch {
            /* 持久化失败不影响运行 */
        }
    }
    loadHistory(id) {
        try {
            const raw = fs.readFileSync(path.join(this.runtimeDir(id), 'history.json'), 'utf8');
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr))
                return [];
            // 截图不持久化：重启后靠新截图，避免文件膨胀
            const restored = arr.map((m) => ({ ...m, images: null, imageConsumed: true }));
            // 旧版本按条数硬截断历史时，文件里可能以 tool 消息开头（前置 assistant.tool_calls 被截掉），
            // 也可能是“有 tool_calls 但没有结果”。不修的话下一次请求直接被判非法消息序列（HTTP 400）。
            const repaired = sanitizeHistory(restored);
            if (repaired.droppedToolMessages || repaired.synthesizedToolResults || repaired.remappedToolCallIds) {
                console.warn('[history] 修复历史消息序列 ' + id + '：丢弃孤儿工具结果 ' +
                    repaired.droppedToolMessages + ' 条，补占位结果 ' + repaired.synthesizedToolResults +
                    ' 条，重置调用 id ' + repaired.remappedToolCallIds + ' 个');
            }
            return repaired.messages;
        }
        catch {
            return [];
        }
    }
    saveHistory(id, messages) {
        try {
            // 不能直接 slice(-N)：裁剪点落在 tool 消息上时，重启加载后第一次请求就是
            // “role='tool' 没有前置 tool_calls”的非法序列。改成按完整消息组裁剪并兜底修复。
            const kept = trimHistoryMessages(messages, MAX_HISTORY_MESSAGES).messages;
            const trimmed = kept.map((m) => ({
                role: m.role,
                content: m.content,
                reasoning: m.reasoning ?? null,
                toolCalls: m.toolCalls ?? null,
                toolCallId: m.toolCallId ?? null,
                // 任务首轮保留标记随历史落盘：服务重启后仍能保住本次任务的首轮对话
                pinned: m.pinned ?? null,
            }));
            fs.writeFileSync(path.join(this.runtimeDir(id), 'history.json'), JSON.stringify(trimmed), 'utf8');
        }
        catch {
            /* ignore */
        }
    }
    loadRuntime(id) {
        try {
            const raw = fs.readFileSync(path.join(this.runtimeDir(id), 'runtime.json'), 'utf8');
            const obj = JSON.parse(raw);
            return {
                turn: Number(obj.turn) || 0,
                promptTokens: Number(obj.promptTokens) || 0,
                completionTokens: Number(obj.completionTokens) || 0,
                cachedTokens: Number(obj.cachedTokens) || 0,
            };
        }
        catch {
            return { turn: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
        }
    }
    saveRuntime(id, runtime) {
        try {
            fs.writeFileSync(path.join(this.runtimeDir(id), 'runtime.json'), JSON.stringify(runtime), 'utf8');
        }
        catch {
            /* ignore */
        }
    }
    /** 会话列表（含长度统计，供侧栏显示）。 */
    infos(runningIds) {
        return this.list().map((m) => ({
            id: m.id,
            title: m.title,
            createdAt: m.createdAt,
            updatedAt: m.updatedAt,
            running: runningIds.has(m.id),
            recordLength: this.safeLength(this.recordPath(m.id)),
            notesLength: this.safeLength(this.notesPath(m.id)),
        }));
    }
    safeLength(file) {
        try {
            const st = fs.statSync(file);
            const cached = this.lengthCache.get(file);
            // 字数只用于侧栏展示：文件没变（mtime/size/ctime 一致）就复用上次的统计，
            // 避免每次 /api/state 与 sessions 广播都把全部会话的记录/笔记整体读一遍。
            if (cached && cached.mtimeMs === st.mtimeMs && cached.ctimeMs === st.ctimeMs && cached.size === st.size) {
                return cached.length;
            }
            const length = fs.readFileSync(file, 'utf8').length;
            if (this.lengthCache.size > 256)
                this.lengthCache.clear();
            this.lengthCache.set(file, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, length });
            return length;
        }
        catch {
            this.lengthCache.delete(file);
            return 0;
        }
    }
    /**
     * 确保至少有一个会话；把旧版本放在工作空间根目录的工作记录/笔记文件
     * 复制进「默认会话」，实现会话隔离且不丢数据。
     */
    ensureDefault() {
        if (this.meta.length > 0) {
            const first = this.list()[0];
            this.ensureFiles(first.id);
            return this.get(first.id);
        }
        const meta = this.create('默认会话');
        const s = this.getSettings();
        const legacyRecord = path.join(s.workspacePath, s.gameRecordFileName);
        const legacyNotes = path.join(s.workspacePath, s.gameNotesFileName);
        try {
            if (fs.existsSync(legacyRecord)) {
                fs.copyFileSync(legacyRecord, this.recordPath(meta.id));
            }
            if (fs.existsSync(legacyNotes)) {
                fs.copyFileSync(legacyNotes, this.notesPath(meta.id));
            }
        }
        catch {
            /* 迁移失败则保留模板 */
        }
        return meta;
    }
}
/** 标题是否仍是系统给的默认值（「会话 M-D HH:MM」或「默认会话」）。 */
export function isDefaultTitle(title) {
    const t = String(title || '').trim();
    return t === '默认会话' || /^会话\s+\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}$/.test(t);
}
/** 从首条用户消息推断一个可读短标题（模型没有自行命名时的兜底）。 */
/** 从首条用户消息推断一个可读短标题（模型没有自行命名时的兜底）。 */
export function deriveTitleFromPrompt(text) {
    const firstLine = String(text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => !!l) || '';
    let s = firstLine
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^[\s>#\-+•\d.、)（(]+/, '')
        .replace(/[*~`]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    // 反复剥离口语前缀：请 / 帮我 / 麻烦 / 可以 … 直到没有为止
    for (let i = 0; i < 4; i++) {
        const next = s.replace(/^(请|麻烦|帮我|帮忙|能不能|可以|能否|我想|我要|需要|帮忙)\s*/, '');
        if (next === s)
            break;
        s = next;
    }
    s = s.replace(/^[\s:：,，、;；]+/, '').replace(/[。！？；，、.!?;,:\s]+$/g, '').trim();
    return Array.from(s).slice(0, 20).join('').trim();
}
function defaultTitle(now) {
    const d = new Date(now);
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return '会话 ' + (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
//# sourceMappingURL=sessions.js.map