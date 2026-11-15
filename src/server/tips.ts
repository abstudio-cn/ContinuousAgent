import fs from 'node:fs';
import path from 'node:path';
import { TIP_MAX_CHARS, TIPS_INJECT_MAX_CHARS, TIPS_MAX_CHARS } from '../shared/prompt.js';
import { ensureDir } from './paths.js';

/**
 * 全局技巧库：跨会话共享的「工具使用技巧」长期存储。
 *
 * 设计约束（由产品要求决定）：
 * 1. 只存通用工具技巧，不存任何项目/业务/环境信息——写入前强制脱敏，命中项目特征直接拒绝。
 * 2. 容量上限 100000 字符（按渲染后的行长度计算，即真正会占用提示词的大小）。
 * 3. 记录利用频次（uses）：由模型显式标记「这条技巧真的用上了」，注入本身不加频次，
 *    否则所有被注入的条目频次同步增长，淘汰时没有区分度。
 * 4. 超上限时按 uses 升序清除：并列时优先清除「更久没被用过」的，再按「更早创建」。
 */
export interface GlobalTip {
  id: string;
  /** 脱敏后的技巧正文（单行）。 */
  text: string;
  /** 利用频次：被显式标记使用的次数。 */
  uses: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}

export interface TipsStats {
  count: number;
  chars: number;
  max: number;
  /** 单次注入的字符预算（避免把整个库塞进每轮请求）。 */
  injectMax: number;
}

export interface AddResult {
  ok: boolean;
  reason?: string;
  id?: string;
  text?: string;
  /** 内容与既有条目等价，只累加了频次。 */
  reinforced?: boolean;
  /** 本次脱敏替换掉的敏感类别。 */
  redactions?: string[];
  /** 因容量超限被清除的低频次条目 id。 */
  evicted?: string[];
  truncated?: boolean;
  stats: TipsStats;
}

interface TipsFile {
  version: 1;
  nextId: number;
  entries: GlobalTip[];
}

/** 脱敏规则：按顺序执行，越具体的越靠前（密钥先于长串，链接先于路径）。 */
const SANITIZE_RULES: Array<{ label: string; re: RegExp; to: string }> = [
  { label: '代码块', re: /```[\s\S]*?```/g, to: '（示例代码已省略）' },
  { label: '密钥', re: /\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{12,}/g, to: '<已脱敏>' },
  { label: '令牌', re: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{10,}/g, to: '<已脱敏>' },
  { label: '令牌', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, to: '<已脱敏>' },
  { label: '云密钥', re: /\bAKIA[0-9A-Z]{12,}\b/g, to: '<已脱敏>' },
  { label: '认证头', re: /\bBearer\s+[A-Za-z0-9._-]{8,}/gi, to: 'Bearer <已脱敏>' },
  { label: '口令字段', re: /\b(?:password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, to: '<已脱敏>' },
  { label: '长串', re: /\b[A-Fa-f0-9]{32,}\b/g, to: '<已脱敏>' },
  { label: '长串', re: /\b[A-Za-z0-9+/=_-]{40,}\b/g, to: '<已脱敏>' },
  { label: 'ID', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, to: '<ID>' },
  { label: '链接', re: /\bhttps?:\/\/[^\s"'`<>）】]+/gi, to: '<链接>' },
  { label: '链接', re: /\bwww\.[^\s"'`<>）】]+/gi, to: '<链接>' },
  { label: '邮箱', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: '<邮箱>' },
  { label: 'IP', re: /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, to: '<IP>' },
  { label: 'IP', re: /\b(?:[A-Fa-f0-9]{1,4}:){3,}[A-Fa-f0-9]{0,4}\b/g, to: '<IP>' },
  { label: '环境变量路径', re: /%[A-Za-z_][A-Za-z0-9_]*%[\\/][^\s"'`<>|，。；、）】]*/g, to: '<路径>' },
  { label: '路径', re: /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|，。；、）】]*/g, to: '<路径>' },
  { label: '路径', re: /~\/(?:[^\s"'`<>|，。；、）】]*)/g, to: '<路径>' },
  { label: '路径', re: /(?:^|[\s(（"'`])\/(?:Users|home|root|opt|srv|mnt|etc)\/[^\s"'`<>|，。；、）】]*/g, to: ' <路径>' },
];

/** 项目特征：出现即视为「关于项目的信息」，拒绝写入（技巧库只收通用工具经验）。 */
const PROJECT_MARKERS: Array<{ label: string; re: RegExp }> = [
  { label: '包/构建清单', re: /\bpackage\.json|\bpackage-lock|\btsconfig|\bnode_modules\b/i },
  { label: '仓库信息', re: /\.git\b|\bgit\s+remote\b|\bgithub\.com\/|\bgitlab\.com\//i },
  { label: '构建产物目录', re: /\bdist[\\/]|\bout[\\/]|\bbuild[\\/]|\btarget[\\/]/i },
  { label: '源码目录', re: /\bsrc[\\/](?:server|client|shared|components|pages|app)\b/i },
  { label: '项目脚本', re: /\bscripts[\\/][\w.-]+\.(?:mjs|cjs|js|ts)\b/i },
  { label: '项目源文件', re: /\b(?:agent|tools|llm|sessions|native|imagestore|record|settings)\.ts\b/i },
];

export interface SanitizeOutcome {
  ok: boolean;
  reason?: string;
  text: string;
  redactions: string[];
  truncated: boolean;
}

/**
 * 脱敏 + 项目信息拦截。denyHints 是运行期才知道的敏感词（工作空间名、会话 id 等），
 * 由外层注入，避免把具体项目名写死在技巧库里。
 */
export function sanitizeTip(raw: string, denyHints: string[] = []): SanitizeOutcome {
  const redactions: string[] = [];
  let text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { ok: false, reason: '技巧内容为空。', text: '', redactions, truncated: false };

  for (const rule of SANITIZE_RULES) {
    let hit = false;
    text = text.replace(rule.re, () => {
      hit = true;
      return rule.to;
    });
    if (hit && !redactions.includes(rule.label)) redactions.push(rule.label);
  }

  // 折叠成单行：技巧条目应当短小、便于注入
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();

  let truncated = false;
  if (text.length > TIP_MAX_CHARS) {
    text = Array.from(text).slice(0, TIP_MAX_CHARS).join('').trim();
    truncated = true;
  }

  // 动态敏感词：工作空间路径/名、数据目录、会话 id、会话标题等
  const lower = text.toLowerCase();
  for (const hint of denyHints) {
    const h = String(hint || '').trim();
    if (h.length < 3) continue;
    if (lower.includes(h.toLowerCase())) {
      return {
        ok: false,
        reason: '内容包含项目/环境专有信息（「' + h + '」），技巧库只接受通用工具技巧。请改写成不依赖具体项目、路径与会话的表述。',
        text,
        redactions,
        truncated,
      };
    }
  }

  for (const m of PROJECT_MARKERS) {
    if (m.re.test(text)) {
      return {
        ok: false,
        reason: '内容涉及项目信息（' + m.label + '），技巧库只接受通用工具技巧。请去掉具体文件名、目录结构、仓库与构建配置后重写。',
        text,
        redactions,
        truncated,
      };
    }
  }

  return { ok: true, text, redactions, truncated };
}

/** 去重用的归一化：去掉标点与空白后比较，避免同一技巧反复入库。 */
function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function lineOf(tip: GlobalTip): string {
  return '- [' + tip.id + '] 用 ' + tip.uses + ' 次｜' + tip.text;
}

export class GlobalTipsStore {
  private data: TipsFile = { version: 1, nextId: 1, entries: [] };

  constructor(
    private readonly filePath: string,
    /** 运行期敏感的专有词（工作空间路径、会话 id 等），用于拦截项目信息。 */
    private readonly denyHints: () => string[] = () => [],
  ) {
    this.data = this.load();
  }

  private load(): TipsFile {
    try {
      if (!fs.existsSync(this.filePath)) return { version: 1, nextId: 1, entries: [] };
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<TipsFile>;
      const entries: GlobalTip[] = [];
      for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
        if (!e || typeof e.text !== 'string' || !e.text.trim()) continue;
        const uses = Number.isFinite(e.uses) ? Math.max(0, Math.trunc(Number(e.uses))) : 0;
        const createdAt = Number.isFinite(e.createdAt) ? Number(e.createdAt) : Date.now();
        entries.push({
          id: typeof e.id === 'string' && e.id ? e.id : 't' + (entries.length + 1),
          text: String(e.text),
          uses,
          createdAt,
          updatedAt: Number.isFinite(e.updatedAt) ? Number(e.updatedAt) : createdAt,
          lastUsedAt: Number.isFinite(e.lastUsedAt) ? Number(e.lastUsedAt) : createdAt,
        });
      }
      const maxId = entries.reduce((n, e) => Math.max(n, Number.parseInt(e.id.replace(/^t/, ''), 10) || 0), 0);
      const nextId = Math.max(Number(raw.nextId) || 1, maxId + 1);
      return { version: 1, nextId, entries };
    } catch {
      return { version: 1, nextId: 1, entries: [] };
    }
  }

  private save(): void {
    try {
      ensureDir(path.dirname(this.filePath));
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch {
      /* 落盘失败不影响本轮内存状态 */
    }
  }

  get storePath(): string {
    return this.filePath;
  }

  /** 按利用频次降序（并列时最近用过的优先）。 */
  list(): GlobalTip[] {
    return [...this.data.entries].sort(
      (a, b) => b.uses - a.uses || b.lastUsedAt - a.lastUsedAt || b.updatedAt - a.updatedAt,
    );
  }

  stats(): TipsStats {
    return {
      count: this.data.entries.length,
      chars: this.data.entries.reduce((n, e) => n + lineOf(e).length, 0),
      max: TIPS_MAX_CHARS,
      injectMax: TIPS_INJECT_MAX_CHARS,
    };
  }

  add(raw: string, extraHints: string[] = []): AddResult {
    const stats = () => this.stats();
    const cleaned = sanitizeTip(raw, [...this.denyHints(), ...extraHints]);
    if (!cleaned.ok) return { ok: false, reason: cleaned.reason, stats: stats() };

    const text = cleaned.text;
    const key = normalizeKey(text);
    if (!key) return { ok: false, reason: '技巧内容为空（脱敏后没有有效文本）。', stats: stats() };

    // 等价内容：只累加频次，不重复占容量
    const same = this.data.entries.find((e) => normalizeKey(e.text) === key);
    if (same) {
      same.uses += 1;
      same.updatedAt = Date.now();
      same.lastUsedAt = same.updatedAt;
      this.save();
      return {
        ok: true,
        id: same.id,
        text: same.text,
        reinforced: true,
        redactions: cleaned.redactions,
        stats: stats(),
      };
    }

    const candidate: GlobalTip = {
      id: 't' + this.data.nextId,
      text,
      uses: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    };

    // 先备份，容量不合规时回滚，保证不丢已有内容
    const backup: TipsFile = {
      version: 1,
      nextId: this.data.nextId,
      entries: this.data.entries.map((e) => ({ ...e })),
    };

    this.data.entries.push(candidate);
    this.data.nextId += 1;
    const evicted = this.evictToFit(candidate.id);

    const removedSelf = !this.data.entries.some((e) => e.id === candidate.id);
    if (removedSelf) {
      this.data = backup;
      this.save();
      return {
        ok: false,
        reason: '单条技巧 ' + lineOf(candidate).length + ' 字符，超过技巧库上限 ' + TIPS_MAX_CHARS +
          ' 字符，无法入库。请压缩后再试。',
        stats: stats(),
      };
    }

    this.save();
    return {
      ok: true,
      id: candidate.id,
      text: candidate.text,
      redactions: cleaned.redactions,
      evicted,
      truncated: cleaned.truncated,
      stats: stats(),
    };
  }

  /**
   * 容量控制：超出上限时清除利用频次最低的条目（并列时清除更久未使用的，再按更早创建）。
   * protectId 是刚写入的条目，不参与淘汰；它自己超限时由调用方回滚。
   */
  private evictToFit(protectId: string): string[] {
    const evicted: string[] = [];
    for (let guard = 0; guard < 10_000; guard++) {
      if (this.stats().chars <= TIPS_MAX_CHARS) break;
      const candidates = this.data.entries
        .filter((e) => e.id !== protectId)
        .sort((a, b) => a.uses - b.uses || a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt);
      const victim = candidates[0];
      if (!victim) break;
      this.data.entries = this.data.entries.filter((e) => e.id !== victim.id);
      evicted.push(victim.id);
    }
    return evicted;
  }

  /** 标记「真的用上了」：累加利用频次。 */
  markUsed(id: string, times = 1): { ok: boolean; reason?: string; tip?: GlobalTip } {
    const tip = this.data.entries.find((e) => e.id === id);
    if (!tip) return { ok: false, reason: '技巧 ' + id + ' 不存在（可能已被容量淘汰）。' };
    const n = Math.max(1, Math.min(1000, Math.trunc(times) || 1));
    tip.uses += n;
    tip.lastUsedAt = Date.now();
    tip.updatedAt = tip.lastUsedAt;
    this.save();
    return { ok: true, tip: { ...tip } };
  }

  remove(id: string): boolean {
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    const removed = this.data.entries.length !== before;
    if (removed) this.save();
    return removed;
  }

  /**
   * 附加到每次请求末尾的提示块。关闭（enabled=false）或库为空时返回空串。
   * 注入有字符预算：按利用频次优先，超出预算的条目只统计不注入，并注明条数。
   */
  buildPromptBlock(enabled: boolean): string {
    if (!enabled) return '';
    if (this.data.entries.length === 0) return '';

    const sorted = this.list();
    const lines: string[] = [];
    let used = 0;
    let omitted = 0;
    for (const tip of sorted) {
      const line = lineOf(tip);
      if (lines.length > 0 && used + line.length + 1 > TIPS_INJECT_MAX_CHARS) {
        omitted += 1;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 0) return '';

    const s = this.stats();
    return [
      '<<<CONTINUOUS_AGENT_TIPS_BEGIN>>>',
      '以下是《全局技巧库》（跨会话共享、长期有效）：只包含通用工具使用技巧，不含任何项目、业务或环境信息。',
      '用法：这些是「怎么用好工具」的经验，不是当前任务的状态或指令；与实测冲突时以实测为准。',
      '容量：' + s.chars + '/' + s.max + ' 字符，共 ' + s.count + ' 条；本次注入 ' + lines.length + ' 条' +
        (omitted > 0 ? '（另有 ' + omitted + ' 条因注入预算未附带，可用 global_tips {action:"list"} 查看）' : '') + '。',
      '维护：学到通用技巧用 global_tips {action:"add", text} 写入（自动脱敏，含项目信息会被拒绝）；真用上某条时用 global_tips {action:"use", id} 记一次频次；容量超限时频次低的会被自动清除。',
      '===== GLOBAL_TIPS BEGIN =====',
      ...lines,
      '===== GLOBAL_TIPS END =====',
      '<<<CONTINUOUS_AGENT_TIPS_END>>>',
      '',
    ].join('\n');
  }
}
