import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 数据目录（设置、会话、日志）。默认 %APPDATA%\\ContinuousAgent，可用 CONTINUOUS_AGENT_DATA_DIR（兼容 GAMEAGENT_DATA_DIR）覆盖。 */
export function dataDir(): string {
  const custom = process.env.CONTINUOUS_AGENT_DATA_DIR || process.env.GAMEAGENT_DATA_DIR;
  const dir = custom && custom.trim()
    ? path.resolve(custom.trim())
    : path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'ContinuousAgent');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 旧版（GameAgent Web）数据目录：仅用于一次性迁移设置。 */
export function legacyDataDir(): string {
  return path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'GameAgentWeb');
}

export function settingsPath(): string {
  return path.join(dataDir(), 'settings.json');
}

export function defaultWorkspace(): string {
  return path.join(os.homedir(), 'Documents', 'ContinuousAgentWorkspace');
}

/** 展开 %VAR% 与开头的 ~，并转成绝对路径。 */
export function normalizePath(input: string): string {
  if (!input) return '';
  let p = input.trim().replace(/^"(.*)"$/, '$1');
  if (p.startsWith('~')) {
    const rest = p.slice(1).replace(/^[\\/]+/, '');
    p = path.join(os.homedir(), rest);
  }
  p = p.replace(/%([^%]+)%/g, (m, name: string) => process.env[name] ?? m);
  return path.resolve(p);
}

function canonical(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * 目标是否位于工作空间内。除字符串前缀检查外，还解析真实路径（符号链接/联接点），
 * 防止通过链接逃逸出工作空间。
 */
export function isInsideWorkspace(target: string, workspace: string): boolean {
  if (!workspace || !workspace.trim()) return false;
  try {
    const ws = canonical(path.resolve(workspace));
    const full = path.resolve(target);
    const norm = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s;
    const fullNorm = norm(full);
    const wsNorm = norm(ws);
    if (fullNorm === wsNorm) return true;
    if (!fullNorm.startsWith(wsNorm.endsWith(path.sep) ? wsNorm : wsNorm + path.sep)) return false;

    // 已存在路径解析真实位置；不存在时向上找最近的存在祖先
    let probe = full;
    for (let i = 0; i < 32 && probe; i++) {
      if (fs.existsSync(probe)) {
        const real = norm(canonical(probe));
        if (real === wsNorm) return true;
        return real.startsWith(wsNorm.endsWith(path.sep) ? wsNorm : wsNorm + path.sep);
      }
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    return true;
  } catch {
    return false;
  }
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function stamp(d = new Date()): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

export function timeLabel(d = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
