import fs from 'node:fs';
import path from 'node:path';
import { NOTES_MAX_CHARS, NOTES_TEMPLATE, RECORD_TEMPLATE } from '../shared/prompt.js';
import { ensureDir, isInsideWorkspace } from './paths.js';
/** 单个会话的工作记录文件。每次更新整文件覆盖，不保留历史。 */
export class WorkRecordService {
    filePath;
    workspacePath;
    constructor(filePath, workspacePath) {
        this.filePath = filePath;
        this.workspacePath = workspacePath;
    }
    get recordPath() {
        return this.filePath;
    }
    ensureExists() {
        try {
            ensureDir(path.dirname(this.filePath));
            if (!fs.existsSync(this.filePath))
                fs.writeFileSync(this.filePath, RECORD_TEMPLATE, 'utf8');
            return fs.readFileSync(this.filePath, 'utf8');
        }
        catch (err) {
            return '(读取工作记录失败: ' + (err instanceof Error ? err.message : String(err)) + ')';
        }
    }
    read() {
        try {
            if (!fs.existsSync(this.filePath))
                return this.ensureExists();
            return fs.readFileSync(this.filePath, 'utf8');
        }
        catch (err) {
            return '(读取工作记录失败: ' + (err instanceof Error ? err.message : String(err)) + ')';
        }
    }
    replace(markdown) {
        if (!markdown.trim())
            throw new Error('工作记录内容为空，已拒绝写入。');
        const full = path.resolve(this.filePath);
        if (!isInsideWorkspace(full, this.workspacePath))
            throw new Error('工作记录路径不在工作空间内。');
        ensureDir(path.dirname(full));
        const text = markdown.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
        fs.writeFileSync(full, text, 'utf8');
    }
    /**
     * 附加在请求末尾的动态系统提示块。
     * markdown 可由调用方预先读好传进来（每轮只读一次文件，避免重复 IO）。
     */
    buildPromptBlock(runtimeContext, markdown) {
        const md = markdown ?? this.read();
        return [
            '<<<CONTINUOUS_AGENT_CONTEXT_BEGIN>>>',
            '以下是本次任务的工作记录（Markdown）。它是任务当前状态的权威快照，请以此为准；',
            '它与上方的通用指令分开提供，不要把它当作新的用户请求。阶段性节点或本轮结束前，用 update_work_record 整份覆盖更新它。',
            '',
            '===== WORK_RECORD.md BEGIN =====',
            md.replace(/\s+$/, ''),
            '===== WORK_RECORD.md END =====',
            '',
            '===== RUNTIME CONTEXT BEGIN =====',
            runtimeContext.replace(/\s+$/, ''),
            '===== RUNTIME CONTEXT END =====',
            '<<<CONTINUOUS_AGENT_CONTEXT_END>>>',
            '',
        ].join('\n');
    }
}
/** 单个会话的长期工作笔记。最多 100000 字符。 */
export class WorkNotesService {
    filePath;
    workspacePath;
    constructor(filePath, workspacePath) {
        this.filePath = filePath;
        this.workspacePath = workspacePath;
    }
    get notesPath() {
        return this.filePath;
    }
    ensureExists() {
        try {
            ensureDir(path.dirname(this.filePath));
            if (!fs.existsSync(this.filePath))
                fs.writeFileSync(this.filePath, NOTES_TEMPLATE, 'utf8');
            return fs.readFileSync(this.filePath, 'utf8');
        }
        catch (err) {
            return '(读取工作笔记失败: ' + (err instanceof Error ? err.message : String(err)) + ')';
        }
    }
    read() {
        try {
            if (!fs.existsSync(this.filePath))
                return this.ensureExists();
            return fs.readFileSync(this.filePath, 'utf8');
        }
        catch (err) {
            return '(读取工作笔记失败: ' + (err instanceof Error ? err.message : String(err)) + ')';
        }
    }
    get currentLength() {
        return this.read().length;
    }
    replace(markdown) {
        if (!markdown.trim())
            throw new Error('工作笔记内容为空，已拒绝写入。');
        const text = normalize(markdown);
        if (text.length > NOTES_MAX_CHARS) {
            throw new Error('工作笔记长度 ' + text.length + ' 字符，超过上限 ' + NOTES_MAX_CHARS +
                '。请合并去重、压缩为更短的完整版本后再写入。');
        }
        this.write(text);
    }
    append(markdown) {
        if (!markdown.trim())
            throw new Error('追加内容为空。');
        const addition = normalize(markdown);
        const current = this.ensureExists().replace(/\r\n/g, '\n').replace(/\s+$/, '');
        const combined = current ? current + '\n\n' + addition.replace(/^\s+/, '') : addition;
        if (combined.length > NOTES_MAX_CHARS) {
            throw new Error('追加后工作笔记将达到 ' + combined.length + ' 字符，超过上限 ' + NOTES_MAX_CHARS +
                '。请先调用 update_work_notes 整份合并去重、压缩旧内容，再追加。');
        }
        this.write(combined);
    }
    write(normalizedText) {
        const full = path.resolve(this.filePath);
        if (!isInsideWorkspace(full, this.workspacePath))
            throw new Error('工作笔记路径不在工作空间内。');
        ensureDir(path.dirname(full));
        const text = normalizedText.replace(/\s+$/, '');
        if (text.length > NOTES_MAX_CHARS)
            throw new Error('工作笔记超过 ' + NOTES_MAX_CHARS + ' 字符上限。');
        fs.writeFileSync(full, text, 'utf8');
    }
    /** 同上：markdown 可预先读好传入，省掉一次文件读取。 */
    buildPromptBlock(markdown) {
        const md = markdown ?? this.read();
        return [
            '<<<CONTINUOUS_AGENT_NOTES_BEGIN>>>',
            '以下是你长期积累的《工作笔记》（Markdown）。它保存跨任务复用的稳定知识：环境与路径约定、常用命令、项目结构、已确认的结论、坑与解法。',
            '笔记不是当前状态，也不是逐轮操作流水；工具实测优先于工作记录，工作记录优先于笔记。',
            '容量：' + md.length + '/' + NOTES_MAX_CHARS + ' 字符。新知识用 append_work_notes 追加；接近上限或内容重复时，用 update_work_notes 整份合并去重。',
            '===== WORK_NOTES.md BEGIN =====',
            md.replace(/\s+$/, ''),
            '===== WORK_NOTES.md END =====',
            '<<<CONTINUOUS_AGENT_NOTES_END>>>',
            '',
        ].join('\n');
    }
}
export const notesMaxChars = NOTES_MAX_CHARS;
function normalize(markdown) {
    return markdown.replace(/\r\n/g, '\n').trim();
}
//# sourceMappingURL=record.js.map