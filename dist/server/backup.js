import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './paths.js';
/** 单份备份上限：超过就不备份（宁可跳过也不让工作空间膨胀）。 */
const MAX_BACKUP_CHARS = 4_000_000;
/** 文件名里不允许出现的字符。 */
const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;
function pad(n, width = 2) {
    return String(n).padStart(width, '0');
}
/** 时间戳：YYYYMMDD_HHmmss_SSS（本地时间），文件名可读且天然有序。 */
export function backupStamp(now = new Date()) {
    return '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
        '_' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) +
        '_' + pad(now.getMilliseconds(), 3);
}
function contentHash(text) {
    return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}
function normKey(p) {
    const abs = path.resolve(p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
}
export class ChangedBackupStore {
    getSettings;
    writeSeq = 0;
    constructor(getSettings) {
        this.getSettings = getSettings;
    }
    /** 备份目录（始终在工作空间内）。 */
    folder() {
        const ws = (this.getSettings().workspacePath || '').trim();
        return path.join(ws || process.cwd(), 'changed_backup');
    }
    indexFile() {
        return path.join(this.folder(), 'index.json');
    }
    enabled() {
        return this.getSettings().changedBackupEnabled !== false;
    }
    maxFiles() {
        const n = Number(this.getSettings().changedBackupMaxFiles);
        return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 200;
    }
    /** 目标是否落在备份目录内（自身不备份，避免无限套娃）。 */
    isInsideBackupDir(file) {
        const dir = normKey(this.folder());
        const key = normKey(file);
        return key === dir || key.startsWith(dir + path.sep);
    }
    readIndex() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.indexFile(), 'utf8'));
            if (!raw || !Array.isArray(raw.entries))
                return [];
            return raw.entries.filter((e) => e && typeof e.id === 'string' && typeof e.originalPath === 'string');
        }
        catch {
            return [];
        }
    }
    /** 原子写：先写临时文件再 rename，避免半截 JSON。 */
    writeIndex(entries) {
        const dir = this.folder();
        ensureDir(dir);
        const target = this.indexFile();
        const tmp = target + '.tmp';
        const body = { version: 1, entries };
        fs.writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
        fs.renameSync(tmp, target);
    }
    /** 已有备份条目（按时间倒序，过滤掉磁盘上已消失的文件）。 */
    list() {
        const dir = this.folder();
        const alive = this.readIndex().filter((e) => {
            try {
                return fs.existsSync(path.join(dir, e.id));
            }
            catch {
                return false;
            }
        });
        return alive.sort((a, b) => b.time - a.time);
    }
    stats() {
        const entries = this.list();
        return {
            count: entries.length,
            bytes: entries.reduce((n, e) => n + (Number(e.size) || 0), 0),
            folder: this.folder(),
            max: this.maxFiles(),
            enabled: this.enabled(),
        };
    }
    /**
     * 写盘前存档。返回备份条目；未启用、内容为空、超上限、
     * 或与「该文件最近一次备份」内容完全相同时返回 null（不重复存档）。
     */
    snapshot(file, content, tool, session = '') {
        if (!this.enabled())
            return null;
        if (this.isInsideBackupDir(file))
            return null;
        if (typeof content !== 'string')
            return null;
        if (content.length === 0)
            return null;
        if (content.length > MAX_BACKUP_CHARS)
            return null;
        const key = normKey(file);
        const hash = contentHash(content);
        const entries = this.list();
        // 同一文件、内容一致 → 已是最新备份，跳过（连续多次写同一版本不产生垃圾）
        const latestSame = entries.find((e) => normKey(e.originalPath) === key);
        if (latestSame && latestSame.hash === hash)
            return null;
        const dir = this.folder();
        ensureDir(dir);
        const base = path.basename(file).replace(UNSAFE_NAME, '_') || 'file';
        const stamp = backupStamp();
        let id = base + '__' + stamp + '.bak';
        // 同一毫秒内多次备份：加递增序号
        while (fs.existsSync(path.join(dir, id))) {
            this.writeSeq++;
            id = base + '__' + stamp + '_' + this.writeSeq + '.bak';
        }
        const entry = {
            id,
            name: path.basename(file),
            originalPath: path.resolve(file),
            time: Date.now(),
            size: Buffer.byteLength(content, 'utf8'),
            hash,
            tool,
            session,
        };
        // 先落备份文件，再记索引：中途失败不会留下指向空文件的索引
        fs.writeFileSync(path.join(dir, id), content, 'utf8');
        const next = [entry, ...entries];
        this.prune(next);
        this.writeIndex(next);
        return entry;
    }
    /** 超出上限时按时间从旧到新删除（就地修改传入数组）。 */
    prune(entries) {
        const max = this.maxFiles();
        if (entries.length <= max)
            return;
        const dir = this.folder();
        const keep = entries.slice(0, max);
        for (const e of entries.slice(max)) {
            try {
                fs.rmSync(path.join(dir, e.id), { force: true });
            }
            catch {
                /* 删不掉就留着，下轮再试 */
            }
        }
        entries.length = 0;
        entries.push(...keep);
    }
    /** 按备份 id 回滚。回滚本身也会先备份当前内容（可再用一次撤回）。 */
    restore(id, writable) {
        const entries = this.list();
        const entry = entries.find((e) => e.id === id);
        if (!entry)
            return { ok: false, text: '未找到备份 ' + id + '，可用 action=list 查看现有备份。' };
        const src = path.join(this.folder(), entry.id);
        let content;
        try {
            content = fs.readFileSync(src, 'utf8');
        }
        catch (e) {
            return { ok: false, text: '备份文件读取失败: ' + (e instanceof Error ? e.message : String(e)) };
        }
        const target = entry.originalPath;
        if (!writable(target)) {
            return { ok: false, text: '拒绝回滚：' + target + ' 不在可写范围内。' };
        }
        // 回滚前把当前内容也存一份，避免「回滚错了」无法再回来
        try {
            if (fs.existsSync(target)) {
                this.snapshot(target, fs.readFileSync(target, 'utf8'), 'restore', entry.session);
            }
        }
        catch {
            /* 存档失败不阻断回滚 */
        }
        try {
            ensureDir(path.dirname(target));
            fs.writeFileSync(target, content, 'utf8');
        }
        catch (e) {
            return { ok: false, text: '回滚写入失败: ' + (e instanceof Error ? e.message : String(e)) };
        }
        return { ok: true, text: '已回滚 ' + target + '（来自备份 ' + entry.id + '，' + content.length + ' 字符）' };
    }
    /**
     * 清空备份。传 sessionId 时只清该会话的（任务结束时用，避免误删其它会话的撤回材料）；
     * 不传则全清（用户/模型显式要求时用）。
     */
    clear(sessionId) {
        const dir = this.folder();
        const all = this.list();
        const scope = (sessionId || '').trim();
        const inScope = (e) => (scope ? e.session === scope : true);
        let removed = 0;
        let bytes = 0;
        const survivors = [];
        for (const e of all) {
            if (!inScope(e)) {
                survivors.push(e);
                continue;
            }
            try {
                fs.rmSync(path.join(dir, e.id), { force: true });
                removed++;
                bytes += Number(e.size) || 0;
            }
            catch {
                survivors.push(e);
            }
        }
        if (survivors.length > 0) {
            this.writeIndex(survivors);
            return { removed, bytes, kept: survivors.length };
        }
        // 全部清空：连索引一起删，并兜底清掉索引外的孤儿 .bak
        try {
            for (const name of fs.readdirSync(dir)) {
                if (name === 'index.json' || name === 'index.json.tmp')
                    continue;
                const full = path.join(dir, name);
                try {
                    if (fs.statSync(full).isFile())
                        fs.rmSync(full, { force: true });
                }
                catch {
                    /* ignore */
                }
            }
            fs.rmSync(this.indexFile(), { force: true });
        }
        catch {
            /* 目录不存在即视为已清空 */
        }
        return { removed, bytes, kept: 0 };
    }
}
//# sourceMappingURL=backup.js.map