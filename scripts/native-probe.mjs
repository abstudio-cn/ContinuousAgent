// 原生桥接手工复现/压测：用与 NativeBridge 完全相同的 spawn 参数起 native-host.ps1，
// 逐命令压测并打印每一步的耗时与返回，最后送 shutdown 看退出码。
// 用途：判定「脚本自身是否稳定」——若全程正常，则线上那次 code 1 必来自进程被外部终结。
//   node scripts/native-probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'native-host.ps1');
if (!fs.existsSync(script)) {
  console.log('MISSING script: ' + script);
  process.exit(1);
}

const child = spawn('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
], { windowsHide: true, stdio: 'pipe' });

let buf = '';
const stderrChunks = [];
const exitInfo = { code: null, signal: null, at: null };
const t0 = Date.now();
const pend = new Map();
let seq = 0;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('  [非 JSON stdout] ' + line.slice(0, 120));
      continue;
    }
    const p = pend.get(Number(msg.id));
    if (!p) continue;
    pend.delete(Number(msg.id));
    clearTimeout(p.timer);
    msg.ok ? p.resolve(msg.data) : p.reject(new Error(String(msg.error)));
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => stderrChunks.push(d));
child.on('exit', (code, signal) => {
  exitInfo.code = code;
  exitInfo.signal = signal;
  exitInfo.at = Date.now() - t0;
});
child.on('error', (e) => console.log('  [spawn error] ' + e.message));

function req(cmd, args = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (exitInfo.code !== null) {
      reject(new Error('host 已退出 code=' + exitInfo.code));
      return;
    }
    const id = ++seq;
    const timer = setTimeout(() => {
      pend.delete(id);
      reject(new Error('超时 ' + timeoutMs + 'ms'));
    }, timeoutMs);
    pend.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
  });
}

async function step(label, cmd, args = {}, timeoutMs) {
  const s = Date.now();
  try {
    const data = await req(cmd, args, timeoutMs);
    console.log('  OK   ' + label + '  ' + (Date.now() - s) + 'ms  ' + JSON.stringify(data).slice(0, 160));
    return data;
  } catch (e) {
    console.log('  FAIL ' + label + '  ' + (Date.now() - s) + 'ms  ' + e.message);
    return null;
  }
}

console.log('起 host：' + script);
const ping0 = await step('ping', 'ping', {}, 25000);
if (!ping0) {
  console.log('stderr: ' + stderrChunks.join('').slice(0, 800));
  console.log('退出: code=' + exitInfo.code + ' after ' + exitInfo.at + 'ms');
  child.kill();
  process.exit(1);
}
console.log('  ocrReady=' + ping0.ocr + ' hostPid=' + ping0.pid);

const wins = await step('list-windows', 'list-windows');
const list = Array.isArray(wins?.windows) ? wins.windows : [];
console.log('  窗口数=' + list.length);
const expl = list.filter((w) => /explorer|notepad|chrome|Code/i.test(String(w.title || ''))).slice(0, 3);
console.log('  候选=' + expl.map((w) => `${w.hwnd}:${String(w.title).slice(0, 18)}`).join(' | '));

await step('foreground', 'foreground');
for (const w of expl) await step('window-state ' + w.hwnd, 'window-state', { hwnd: w.hwnd });

// 截图 + 后台截图 + OCR：这是历史上最容易崩的三条路径
let shotPath = null;
for (const w of expl) {
  const r = await step('capture-bg ' + w.hwnd, 'capture-bg', { hwnd: w.hwnd, maxWidth: 800, format: 'jpeg' }, 40000);
  if (r?.path && !r.blank) {
    shotPath = r.path;
    break;
  }
  if (r?.path) fs.promises.unlink(r.path).catch(() => undefined);
}
for (const w of expl.slice(0, 1)) await step('screenshot ' + w.hwnd, 'screenshot', { hwnd: w.hwnd, maxWidth: 800, format: 'jpeg' }, 40000);

if (shotPath) {
  for (let i = 1; i <= 2; i++) await step('ocr #' + i, 'ocr', { path: shotPath, language: 'zh-Hans' }, 90000);
  await step('remove temp', 'remove', { path: shotPath });
} else {
  console.log('  SKIP ocr：没有可用非 blank 窗口');
}

// 异常路径：未知命令、坏 hwnd —— 必须只回 error，不能让主循环退出
await step('unknown-cmd', 'definitely-not-a-cmd');
await step('bad-hwnd', 'window-info', { hwnd: 1 });
await step('list-windows 之后仍存活', 'list-windows');

console.log('送 shutdown…');
await step('shutdown', 'shutdown').catch(() => undefined);
// PowerShell 收到 break 后还要收尾（Add-Type / WinRT 组件释放），1.5s 常不够；
// 轮询等 exit 事件最多 8s，等不到就如实报告「未观测到退出」。
for (let i = 0; i < 80 && exitInfo.code === null && exitInfo.signal === null; i++) {
  await new Promise((r) => setTimeout(r, 100));
}
const waited = Date.now() - t0;
console.log('总耗时 ' + waited + 'ms' + (exitInfo.at === null ? '（未观测到 exit 事件）' : '（exit 于 ' + exitInfo.at + 'ms）'));
console.log('退出码 code=' + exitInfo.code + ' signal=' + exitInfo.signal);
console.log('stderr 长度=' + stderrChunks.join('').length + (stderrChunks.length ? '\nstderr: ' + stderrChunks.join('').slice(0, 800) : ''));
const unexpected = exitInfo.code !== 0 && exitInfo.code !== null;
console.log(unexpected ? 'VERDICT: 异常退出（需看 stderr）' : 'VERDICT: 全命令通过，shutdown 后干净退出（code=' + exitInfo.code + '）');
try {
  child.kill();
} catch {
  /* ignore */
}
process.exit(unexpected ? 1 : 0);
