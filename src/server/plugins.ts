import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { PluginInfo } from '../shared/types.js';
import type { ToolSpec } from './llm.js';

/**
 * 插件系统（隔离层）。
 *
 * 设计上的硬约束：
 * 1. 插件**只以「JSON 清单 + 外部子进程」形式存在**：核心进程从不 import / require 插件代码，
 *    因此插件写错、死循环、崩溃、乱打印都只会影响它自己那一次调用的结果，绝不会拖垮 agent 核心。
 * 2. 本模块的任何函数**不向外抛异常**：加载失败写进 error 字段，执行失败变成结构化结果，
 *    调用方（tools.ts）据此生成 ToolResult。
 * 3. 工具名强制命名空间 `plugin__<id>__<tool>`，插件永远无法覆盖核心工具。
 * 4. 数量、超时、输出、参数长度都有硬上限，清单里写多大都无效。
 */

/** 插件工具名的统一前缀：与核心工具名彻底隔开。 */
export const PLUGIN_TOOL_PREFIX = 'plugin__';

/** 无论插件清单怎么写都不可突破的边界。 */
export const PLUGIN_LIMITS = {
  maxPlugins: 40,
  maxTools: 20,
  maxPurposeChars: 400,
  maxDescChars: 1000,
  maxArgValueChars: 8000,
  maxArgvItems: 64,
  minTimeoutMs: 1000,
  maxTimeoutMs: 600_000,
  maxOutputChars: 200_000,
} as const;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const TOOL_RE = /^[A-Za-z0-9_]{1,40}$/;
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)(\?)?\s*\}\}/g;

export interface PluginParam {
  type: string;
  description: string;
}

export interface PluginTool {
  /** 全局工具名 plugin__<插件id>__<工具名> */
  globalName: string;
  localName: string;
  description: string;
  /** 工具级用途（审计卡片优先展示它，缺省用插件用途） */
  purpose: string;
  parameters: Record<string, PluginParam>;
  required: string[];
  /** 直接传给 spawn 的参数数组（推荐，无需转义） */
  argv: string[] | null;
  /** 交给 shell 的命令串（兼容写法；占位符会按 shell 规则转义） */
  command: string | null;
  timeoutMs: number;
}

export interface PluginDef {
  id: string;
  name: string;
  version: string;
  purpose: string;
  dir: string;
  enabled: boolean;
  tools: PluginTool[];
  /** 空串表示加载正常；否则是给用户看的失败原因 */
  error: string;
}

/** 一次插件调用的审计请求：审计界面必须能回答「这插件要来干什么」。 */
export interface PluginAuditRequest {
  pluginId: string;
  pluginName: string;
  version: string;
  purpose: string;
  tool: string;
  argsJson: string;
  /** 即将执行的命令（预览用，已按最终形态展开参数） */
  command: string;
  dir: string;
}

export interface PluginRunOutcome {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
  command: string;
  error: string;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function clampTimeout(v: unknown, def: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  const base = Number.isFinite(n) ? n : def;
  return Math.min(PLUGIN_LIMITS.maxTimeoutMs, Math.max(PLUGIN_LIMITS.minTimeoutMs, Math.trunc(base)));
}

/** shell 参数转义（用于 command 形式的占位符替换与命令预览）。 */
function shellQuote(value: string): string {
  const s = String(value ?? '');
  if (s === '') return process.platform === 'win32' ? "''" : "''";
  if (process.platform === 'win32') {
    // PowerShell 单引号：内部的 ' 写成 ''
    if (/^[A-Za-z0-9_:\\/.@%+=,-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "''") + "'";
  }
  if (/^[A-Za-z0-9_:\\/.@%+=,-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** 参数值统一转成字符串（对象/数组走 JSON，长度受限）。 */
function argToString(key: string, raw: unknown, type: string): { value: string; error: string } {
  if (raw === undefined || raw === null) return { value: '', error: '' };
  let s: string;
  if (typeof raw === 'string') s = raw;
  else if (typeof raw === 'number' || typeof raw === 'boolean') s = String(raw);
  else {
    try {
      s = JSON.stringify(raw);
    } catch {
      return { value: '', error: '参数 ' + key + ' 无法序列化为字符串' };
    }
  }
  if (s.length > PLUGIN_LIMITS.maxArgValueChars) {
    return { value: '', error: '参数 ' + key + ' 过长（上限 ' + PLUGIN_LIMITS.maxArgValueChars + ' 字符）' };
  }
  if (type === 'string') return { value: s, error: '' };
  return { value: s, error: '' };
}

function normalizeParameters(raw: unknown): Record<string, PluginParam> {
  const out: Record<string, PluginParam> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;
  // 兼容两种写法：{name: "说明"} 或 {name: {type, description}}
  for (const [key, val] of Object.entries(src)) {
    if (!TOOL_RE.test(key)) continue;
    if (val && typeof val === 'object') {
      const o = val as Record<string, unknown>;
      out[key] = {
        type: typeof o.type === 'string' ? o.type.slice(0, 20) : 'string',
        description: text(o.description, PLUGIN_LIMITS.maxDescChars),
      };
    } else {
      out[key] = { type: 'string', description: text(val, PLUGIN_LIMITS.maxDescChars) };
    }
  }
  return out;
}

function loadTool(raw: unknown, plugin: { id: string; purpose: string }, defaultTimeout: number): { tool?: PluginTool; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '工具体必须是 JSON 对象' };
  const m = raw as Record<string, unknown>;
  const localName = typeof m.name === 'string' ? m.name.trim() : '';
  if (!TOOL_RE.test(localName)) return { error: '工具 name 不合法：「' + localName + '」（只允许字母数字下划线，1~40 字符）' };

  const parameters = normalizeParameters(m.parameters);
  const requiredRaw = Array.isArray(m.required) ? m.required : [];
  const required = requiredRaw
    .filter((x): x is string => typeof x === 'string' && !!x)
    .filter((x) => x in parameters)
    .slice(0, 32);

  let argv: string[] | null = null;
  if (Array.isArray(m.argv)) {
    const arr = m.argv.filter((x): x is string => typeof x === 'string').slice(0, PLUGIN_LIMITS.maxArgvItems);
    if (arr.length > 0) argv = arr;
  }
  const commandRaw = typeof m.command === 'string' ? m.command.trim() : '';
  const command = commandRaw ? commandRaw.slice(0, 4000) : null;
  if (!argv && !command) return { error: '工具 ' + localName + ' 必须提供 argv（推荐）或 command' };

  // 占位符必须都是已知参数，避免「静默替换成空」导致插件行为与声明不符
  const known = new Set([...Object.keys(parameters), 'pluginDir']);
  const pieces = argv ?? [command ?? ''];
  for (const piece of pieces) {
    for (const match of piece.matchAll(PLACEHOLDER_RE)) {
      const name = match[1] ?? '';
      if (!known.has(name)) {
        return { error: '工具 ' + localName + ' 使用了未声明的占位符 {{' + name + '}}（先把它写进 parameters）' };
      }
    }
  }

  return {
    tool: {
      globalName: PLUGIN_TOOL_PREFIX + plugin.id + '__' + localName,
      localName,
      description: text(m.description, PLUGIN_LIMITS.maxDescChars),
      purpose: text(m.purpose, PLUGIN_LIMITS.maxPurposeChars) || plugin.purpose,
      parameters,
      required,
      argv,
      command,
      timeoutMs: clampTimeout(m.timeoutMs, defaultTimeout),
    },
  };
}

/** 解析单个插件目录；任何异常都收敛成 error 字段，绝不向外抛。 */
function loadPlugin(dirPath: string, fallbackId: string, defaultTimeout: number): PluginDef {
  const base: PluginDef = {
    id: fallbackId,
    name: fallbackId,
    version: '',
    purpose: '',
    dir: dirPath,
    enabled: false,
    tools: [],
    error: '',
  };
  try {
    const file = path.join(dirPath, 'plugin.json');
    if (!fs.existsSync(file)) return { ...base, error: '缺少 plugin.json' };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...base, error: 'plugin.json 必须是 JSON 对象' };
    const m = parsed as Record<string, unknown>;

    const id = typeof m.id === 'string' && m.id.trim() ? m.id.trim() : fallbackId;
    if (!ID_RE.test(id)) return { ...base, id, error: 'id 不合法（字母数字开头，只含字母数字 _ -，≤32 字符）' };

    // 用途是审计的必要信息：没写用途的插件一律不加载
    const purpose = text(m.purpose, PLUGIN_LIMITS.maxPurposeChars);
    if (!purpose) return { ...base, id, error: '缺少 purpose（用途说明）：未声明用途的插件不允许加载' };

    const name = text(m.name, 80) || id;
    const version = text(m.version, 32);
    const enabled = m.enabled !== false;

    const rawTools = Array.isArray(m.tools) ? m.tools : [];
    if (rawTools.length === 0) return { ...base, id, name, version, purpose, error: '没有声明任何 tools' };

    const tools: PluginTool[] = [];
    const seen = new Set<string>();
    for (const rt of rawTools.slice(0, PLUGIN_LIMITS.maxTools)) {
      const one = loadTool(rt, { id, purpose }, defaultTimeout);
      if (!one.tool) return { ...base, id, name, version, purpose, error: one.error || '工具解析失败' };
      if (seen.has(one.tool.globalName)) return { ...base, id, name, version, purpose, error: '工具重名：' + one.tool.localName };
      seen.add(one.tool.globalName);
      tools.push(one.tool);
    }
    return { id, name, version, purpose, dir: dirPath, enabled, tools, error: '' };
  } catch (e) {
    return { ...base, error: '解析失败：' + msgOf(e) };
  }
}

/**
 * 把清单里的 argv / command 展开成真实可执行参数。
 * 纯函数，可单测；出问题只返回 error，不抛。
 */
export function buildInvocation(
  tool: Pick<PluginTool, 'argv' | 'command' | 'parameters' | 'required' | 'localName'>,
  args: Record<string, unknown>,
  pluginDir: string,
): { argv: string[] | null; command: string; display: string; error: string } {
  const values = new Map<string, string>();
  values.set('pluginDir', pluginDir);

  const paramNames = Object.keys(tool.parameters);
  const unknown = Object.keys(args).filter((k) => !paramNames.includes(k));
  if (unknown.length > 0) {
    return {
      argv: null,
      command: '',
      display: '',
      error: '未知参数：' + unknown.join('、') + '（允许的参数：' + (paramNames.join('、') || '无') + '）',
    };
  }
  for (const key of paramNames) {
    const raw = args[key];
    if (raw === undefined || raw === null || raw === '') {
      if (tool.required.includes(key)) {
        return { argv: null, command: '', display: '', error: '缺少必填参数：' + key };
      }
      continue;
    }
    const conv = argToString(key, raw, tool.parameters[key]?.type || 'string');
    if (conv.error) return { argv: null, command: '', display: '', error: conv.error };
    values.set(key, conv.value);
  }

  const expand = (tpl: string, quote: (s: string) => string): { text: string; error: string } => {
    let error = '';
    const out = tpl.replace(PLACEHOLDER_RE, (whole, name: string, optional?: string) => {
      if (!values.has(name)) {
        if (optional) return '';
        error = '占位符 {{' + name + '}} 没有对应的参数值';
        return '';
      }
      return quote(values.get(name) || '');
    });
    return { text: out, error };
  };

  if (tool.argv && tool.argv.length > 0) {
    const argv: string[] = [];
    for (const piece of tool.argv) {
      const one = expand(piece, (s) => s);
      if (one.error) return { argv: null, command: '', display: '', error: one.error };
      argv.push(one.text);
    }
    const display = argv.map(shellQuote).join(' ');
    return { argv, command: '', display, error: '' };
  }

  const one = expand(tool.command || '', shellQuote);
  if (one.error) return { argv: null, command: '', display: '', error: one.error };
  return { argv: null, command: one.text, display: one.text, error: '' };
}

/** 子进程收集：输出上限 + 超时整树杀。与核心的 Proc 独立，互不影响。 */
function spawnCollect(
  cmd: string,
  argv: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    let timedOut = false;
    let truncated = false;
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    let outLen = 0;
    let errLen = 0;
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let child: ReturnType<typeof spawn> | null = null;
    let timer: NodeJS.Timeout | null = null;
    const limit = PLUGIN_LIMITS.maxOutputChars;

    const killTree = () => {
      const pid = child?.pid;
      if (!pid) return;
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } catch {
          /* ignore */
        }
      }
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };

    const finish = (code: number) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (!truncated) {
        outChunks.push(outDecoder.end());
        errChunks.push(errDecoder.end());
      }
      resolve({ code, stdout: outChunks.join(''), stderr: errChunks.join(''), timedOut, truncated });
    };

    const onAbort = () => killTree();

    try {
      child = spawn(cmd, argv, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: '无法启动插件进程：' + msgOf(e), timedOut: false, truncated: false });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, Math.max(PLUGIN_LIMITS.minTimeoutMs, opts.timeoutMs));
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout?.on('data', (b: Buffer) => {
      if (outLen >= limit) {
        truncated = true;
        return;
      }
      // 单块就可能超过剩余预算（例如一次写出 260KB）：必须按剩余量截断，
      // 只在“下一个数据块到来时”判断会漏掉这种一次性大输出。
      const room = limit - outLen;
      const chunk = b.length > room ? b.subarray(0, room) : b;
      outLen += b.length;
      if (b.length > room) truncated = true;
      outChunks.push(outDecoder.write(chunk));
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (errLen >= limit) {
        truncated = true;
        return;
      }
      const room = limit - errLen;
      const chunk = b.length > room ? b.subarray(0, room) : b;
      errLen += b.length;
      if (b.length > room) truncated = true;
      errChunks.push(errDecoder.write(chunk));
    });
    child.on('error', (e: Error) => {
      errChunks.push('\n' + msgOf(e));
      finish(-1);
    });
    child.on('close', (code: number | null) => finish(code ?? 0));
  });
}

/** 插件注册表：加载清单、给出工具清单、执行（带审计前置于调用方）。 */
export class PluginRegistry {
  private plugins: PluginDef[] = [];
  private byTool = new Map<string, { plugin: PluginDef; tool: PluginTool }>();
  private errors: string[] = [];
  private coreNames = new Set<string>();

  loadedAt = 0;

  constructor(
    /** 插件根目录（<数据目录>/plugins） */
    private readonly root: string,
    /** 默认超时（跟设置联动） */
    private readonly defaultTimeout: () => number,
    /** 核心工具名，用于防御性判重 */
    coreToolNames: string[] = [],
  ) {
    this.coreNames = new Set(coreToolNames);
  }

  get directory(): string {
    return this.root;
  }

  get loadErrors(): string[] {
    return [...this.errors];
  }

  /** 重新扫描插件目录。无论发生什么都不抛异常。 */
  reload(): void {
    const plugins: PluginDef[] = [];
    const errors: string[] = [];
    const seenIds = new Set<string>();
    this.loadedAt = Date.now();
    try {
      fs.mkdirSync(this.root, { recursive: true });
    } catch {
      /* 目录建不出来也不影响核心：下面按空清单处理 */
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch (e) {
      this.plugins = [];
      this.byTool = new Map();
      this.errors = ['插件目录不可读取：' + msgOf(e)];
      return;
    }
    let timeout = 60_000;
    try {
      timeout = clampTimeout(this.defaultTimeout(), 60_000);
    } catch {
      /* 读设置失败就用默认超时 */
    }
    const dirs = entries.filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const name of dirs) {
      if (plugins.length >= PLUGIN_LIMITS.maxPlugins) {
        errors.push('插件数量超过上限 ' + PLUGIN_LIMITS.maxPlugins + '，其余目录已忽略');
        break;
      }
      let def: PluginDef;
      try {
        def = loadPlugin(path.join(this.root, name), name, timeout);
      } catch (e) {
        def = {
          id: name, name, version: '', purpose: '', dir: path.join(this.root, name),
          enabled: false, tools: [], error: '加载异常：' + msgOf(e),
        };
      }
      if (seenIds.has(def.id)) {
        def = { ...def, enabled: false, tools: [], error: def.error || '插件 id 重复：' + def.id };
      }
      seenIds.add(def.id);
      if (def.error) errors.push(def.id + '：' + def.error);
      plugins.push(def);
    }

    const byTool = new Map<string, { plugin: PluginDef; tool: PluginTool }>();
    for (const p of plugins) {
      if (p.error || !p.enabled) continue;
      for (const t of p.tools) {
        if (this.coreNames.has(t.globalName) || byTool.has(t.globalName)) {
          errors.push(p.id + '：工具名冲突已跳过 ' + t.globalName);
          continue;
        }
        byTool.set(t.globalName, { plugin: p, tool: t });
      }
    }

    this.plugins = plugins;
    this.byTool = byTool;
    this.errors = errors;
  }

  /** 下发给界面的清单（不含可执行细节）。 */
  list(): PluginInfo[] {
    return this.plugins.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      purpose: p.purpose,
      dir: p.dir,
      enabled: p.enabled,
      error: p.error,
      tools: p.tools.map((t) => ({ name: t.localName, globalName: t.globalName, purpose: t.purpose })),
    }));
  }

  /** 可用工具数（只算已启用且加载成功的）。 */
  get availableToolCount(): number {
    return this.byTool.size;
  }

  /** 转成 OpenAI 工具清单；插件异常时返回空数组，调用方照常用核心清单。 */
  toolSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    try {
      for (const { plugin, tool } of this.byTool.values()) {
        const purpose = tool.purpose || plugin.purpose;
        const desc = '【插件：' + plugin.name + '】用途：' + purpose +
          (tool.description ? '；' + tool.description : '') +
          '（注意：每次调用都会先让用户在界面上审计确认，用户拒绝时不要反复重试）';
        specs.push({
          type: 'function',
          function: {
            name: tool.globalName,
            description: desc.slice(0, 2000),
            parameters: {
              type: 'object',
              properties: tool.parameters,
              required: tool.required,
            },
          },
        });
      }
    } catch {
      return [];
    }
    return specs;
  }

  find(globalName: string): { plugin: PluginDef; tool: PluginTool } | null {
    try {
      return this.byTool.get(globalName) || null;
    } catch {
      return null;
    }
  }

  /** 审计预览：给出真实将要执行的命令；参数不合法时 error 非空（此时不要问用户）。 */
  preview(plugin: PluginDef, tool: PluginTool, args: Record<string, unknown>): { command: string; error: string } {
    try {
      const inv = buildInvocation(tool, args, plugin.dir);
      return { command: inv.display, error: inv.error };
    } catch (e) {
      return { command: '', error: '参数展开失败：' + msgOf(e) };
    }
  }

  /** 执行插件工具。所有失败都变成结构化结果，不抛异常。 */
  async run(plugin: PluginDef, tool: PluginTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<PluginRunOutcome> {
    const started = Date.now();
    const fail = (error: string): PluginRunOutcome => ({
      ok: false, code: -1, stdout: '', stderr: '', timedOut: false, truncated: false,
      ms: Date.now() - started, command: '', error,
    });
    try {
      const inv = buildInvocation(tool, args, plugin.dir);
      if (inv.error) return fail(inv.error);
      const shellCmd = process.platform === 'win32' ? 'powershell' : '/bin/sh';
      const cmd = inv.argv ? inv.argv[0] : shellCmd;
      const argv = inv.argv
        ? inv.argv.slice(1)
        : (process.platform === 'win32'
          ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', inv.command]
          : ['-c', inv.command]);
      const res = await spawnCollect(cmd, argv, { cwd: plugin.dir, timeoutMs: tool.timeoutMs, signal });
      return {
        ok: res.code === 0 && !res.timedOut,
        code: res.code,
        stdout: res.stdout,
        stderr: res.stderr,
        timedOut: res.timedOut,
        truncated: res.truncated,
        ms: Date.now() - started,
        command: inv.display,
        error: '',
      };
    } catch (e) {
      return fail('插件执行异常：' + msgOf(e));
    }
  }
}
