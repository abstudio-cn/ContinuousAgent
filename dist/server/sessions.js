import fs from 'node:fs';
import path from 'node:path';
import { NOTES_TEMPLATE, RECORD_TEMPLATE } from '../shared/prompt.js';
import { ensureDir, stamp } from './paths.js';
import { sanitizeHistory, trimHistoryMessages } from './history.js';
const MAX_TIMELINE_ITEMS = 240;
const MAX_HISTORY_MESSAGES = 80;
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
        return this.preferExisting(id, this.getSettings().gameRecordFileName, 'game_state.md');
    }
    notesPath(id) {
        return this.preferExisting(id, this.getSettings().gameNotesFileName, 'game_notes.md');
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
        };
        this.meta.push(meta);
        this.writeIndex();
        this.ensureFiles(id);
        return meta;
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