import fs from 'node:fs';
import path from 'node:path';
import { NOTES_MAX_CHARS, NOTES_TEMPLATE, RECORD_TEMPLATE } from '../shared/prompt.js';
import { ensureDir, isInsideWorkspace } from './paths.js';

/** 「## 任务计划」里的一条勾选项：`- [ ] P1 …` / `- [x] P1 …`。 */
const PLAN_ITEM_RE = /^\s*[-*]\s+\[([ xX])\]\s*\S/;

/** 取「## 任务计划」小节的正文行（到下一个二级标题或文末为止）。 */
export function taskPlanLines(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s*任务计划/.test(l.trim()));
  if (start < 0) return [];
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^##\s/.test(line.trim())) break;
    body.push(line);
  }
  return body;
}

/** 工作记录里是否已有真正的任务计划（模板占位不算）。 */
export function hasTaskPlan(markdown: string): boolean {
  const items = taskPlanLines(markdown).filter((l) => PLAN_ITEM_RE.test(l));
  if (items.length === 0) return false;
  // 初始模板只有一条占位项，不算“已规划”
  return !(items.length === 1 && /待填|把任务拆成/.test(items[0] ?? ''));
}

/** 任务计划里是否还有未勾选的步骤。 */
export function hasOpenPlanStep(markdown: string): boolean {
  return taskPlanLines(markdown).some((l) => {
    const m = PLAN_ITEM_RE.exec(l);
    return !!m && m[1] === ' ';
  });
}

/**
 * 需要「先规划」提醒时返回提醒文案，否则返回 null。
 * 用于 agent 主循环的开工守卫：光靠提示词是软约束，这里保证最低限度的提醒。
 */
export function planNudge(markdown: string): string | null {
  if (!hasTaskPlan(markdown)) {
    return '先别动手：请先规划任务——调用 update_work_record，在工作记录的「## 任务计划」下写出 2~8 个有序、可验证的步骤'
      + '（每条一行 `- [ ] P1 …`），并在「## 任务目标」写清完成标准；计划落盘之后再开始第一步。';
  }
  if (!hasOpenPlanStep(markdown)) {
    return '工作记录「## 任务计划」里的步骤已全部勾选。如果这是新任务（或旧计划已不适用），请先重新规划：'
      + '把「## 任务计划」改写成接下来的步骤（`- [ ] P1 …`）再动手；确实没有后续步骤时，直接给出结论并收尾。';
  }
  return null;
}

/** 单个会话的工作记录文件。每次更新整文件覆盖，不保留历史。 */
export class WorkRecordService {
  constructor(
    private readonly filePath: string,
    private readonly workspacePath: string,
  ) {}

  get recordPath(): string {
    return this.filePath;
  }

  ensureExists(): string {
    try {
      ensureDir(path.dirname(this.filePath));
      if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, RECORD_TEMPLATE, 'utf8');
      return fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      return '(读取工作记录失败: ' + (err instanceof Error ? err.message : String(err)) + ')';
    }
  }

  read(): string {
    try {
      if (!fs.existsSync(this.filePath)) return this.ensureExists();
      return fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      return '(读取工作记录失败: ' + (err instanceof Error ? err.message : String(err)) + ')';
    }
  }

  replace(markdown: string): void {
    if (!markdown.trim()) throw new Error('工作记录内容为空，已拒绝写入。');
    const full = path.resolve(this.filePath);
    if (!isInsideWorkspace(full, this.workspacePath)) throw new Error('工作记录路径不在工作空间内。');
    ensureDir(path.dirname(full));
    const text = markdown.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
    fs.writeFileSync(full, text, 'utf8');
  }

  /**
   * 附加在请求末尾的动态系统提示块。
   * markdown 可由调用方预先读好传进来（每轮只读一次文件，避免重复 IO）。
   */
  buildPromptBlock(runtimeContext: string, markdown?: string): string {
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
  constructor(
    private readonly filePath: string,
    private readonly workspacePath: string,
  ) {}

  get notesPath(): string {
    return this.filePath;
  }

  ensureExists(): string {
    try {
      ensureDir(path.dirname(this.filePath));
      if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, NOTES_TEMPLATE, 'utf8');
      return fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      return '(读取工作笔记失败: ' + (err instanceof Error ? err.message : String(err)) + ')';
    }
  }

  read(): string {
    try {
      if (!fs.existsSync(this.filePath)) return this.ensureExists();
      return fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      return '(读取工作笔记失败: ' + (err instanceof Error ? err.message : String(err)) + ')';
    }
  }

  get currentLength(): number {
    return this.read().length;
  }

  replace(markdown: string): void {
    if (!markdown.trim()) throw new Error('工作笔记内容为空，已拒绝写入。');
    const text = normalize(markdown);
    if (text.length > NOTES_MAX_CHARS) {
      throw new Error('工作笔记长度 ' + text.length + ' 字符，超过上限 ' + NOTES_MAX_CHARS +
        '。请合并去重、压缩为更短的完整版本后再写入。');
    }
    this.write(text);
  }

  append(markdown: string): void {
    if (!markdown.trim()) throw new Error('追加内容为空。');
    const addition = normalize(markdown);
    const current = this.ensureExists().replace(/\r\n/g, '\n').replace(/\s+$/, '');
    const combined = current ? current + '\n\n' + addition.replace(/^\s+/, '') : addition;
    if (combined.length > NOTES_MAX_CHARS) {
      throw new Error('追加后工作笔记将达到 ' + combined.length + ' 字符，超过上限 ' + NOTES_MAX_CHARS +
        '。请先调用 update_work_notes 整份合并去重、压缩旧内容，再追加。');
    }
    this.write(combined);
  }

  private write(normalizedText: string): void {
    const full = path.resolve(this.filePath);
    if (!isInsideWorkspace(full, this.workspacePath)) throw new Error('工作笔记路径不在工作空间内。');
    ensureDir(path.dirname(full));
    const text = normalizedText.replace(/\s+$/, '');
    if (text.length > NOTES_MAX_CHARS) throw new Error('工作笔记超过 ' + NOTES_MAX_CHARS + ' 字符上限。');
    fs.writeFileSync(full, text, 'utf8');
  }

  /** 同上：markdown 可预先读好传入，省掉一次文件读取。 */
  buildPromptBlock(markdown?: string): string {
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

function normalize(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n').trim();
}
