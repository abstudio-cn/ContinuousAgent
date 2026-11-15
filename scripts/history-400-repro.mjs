#!/usr/bin/env node
/**
 * HTTP 400 复现 / 回归自检（不依赖真实模型）：
 *   "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
 *
 * 做法：起一个假 OpenAI 兼容服务，严格校验请求里的消息配对；把被旧逻辑截断过的
 * history.json（以 tool 消息开头）塞进临时数据目录；启动真实服务跑一轮。
 * 旧代码会在第一轮就收到 400；修复后请求应全部合法。
 *
 * 用法：node scripts/history-400-repro.mjs [--history <历史文件>] [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const KEEP = args.includes('--keep');

const failures = [];
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) failures.push(name);
};

function validate(messages) {
  const errors = [];
  let pending = null;
  const flush = () => {
    if (!pending) return;
    for (const [id, answered] of pending) if (!answered) errors.push('missing tool result: ' + id);
    pending = null;
  };
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      flush();
      pending = new Map(m.tool_calls.map((c) => [c.id, false]));
      if (new Set(m.tool_calls.map((c) => c.id)).size !== m.tool_calls.length) errors.push('dup ids @' + i);
      if (m.tool_calls.some((c) => !c.id)) errors.push('empty id @' + i);
      return;
    }
    if (m.role === 'tool') {
      if (!pending) { errors.push('orphan tool @' + i + ' id=' + m.tool_call_id); return; }
      if (!pending.has(m.tool_call_id)) { errors.push('unknown tool_call_id @' + i + ' ' + m.tool_call_id); return; }
      pending.set(m.tool_call_id, true);
      return;
    }
    flush();
  });
  flush();
  return errors;
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function pickSourceHistory(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const root = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'ContinuousAgent', 'sessions');
  if (!fs.existsSync(root)) return null;
  const files = fs.readdirSync(root)
    .map((d) => path.join(root, d, 'history.json'))
    .filter((f) => fs.existsSync(f))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return files[0] || null;
}

async function waitFor(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-history-400-'));
let child = null;
let mock = null;

try {
  const sessionId = 'stest';
  const dataDir = path.join(tmp, 'data');
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(dataDir, 'sessions', sessionId), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  const source = pickSourceHistory(arg('history', ''));
  let history;
  if (source) {
    history = JSON.parse(fs.readFileSync(source, 'utf8'));
    console.log('种子历史: ' + source + '（' + history.length + ' 条）');
  } else {
    history = [{ role: 'tool', toolCallId: 'call_old', content: '被截断后残留的工具结果' }];
    for (let i = 0; i < 12; i++) {
      history.push({ role: 'assistant', content: '', toolCalls: [{ id: 'c' + i, name: 'noop', arguments: '{}' }] });
      history.push({ role: 'tool', toolCallId: 'c' + i, content: '结果 ' + i });
    }
    console.log('种子历史: 内建（以 tool 开头）');
  }
  fs.writeFileSync(path.join(dataDir, 'sessions', sessionId, 'history.json'), JSON.stringify(history), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'sessions', 'index.json'), JSON.stringify([
    { id: sessionId, title: '历史修复自检', createdAt: Date.now(), updatedAt: Date.now() },
  ]), 'utf8');

  const modelBase = 'http://127.0.0.1:' + (await freePort()) + '/v1';
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    apiBaseUrl: modelBase,
    apiKey: 'test-key',
    model: 'mock-model',
    workspacePath: workspace,
    continuousMode: false,
    maxTurns: 6,
    historyMaxMessages: 24,
    sendScreenshots: false,
    screenshotBurnAfterRead: true,
    ttsEnabled: false,
    changedBackupEnabled: false,
  }, null, 2), 'utf8');

  // ---- 假模型服务：非法消息序列直接回 400（与线上错误一致） ----
  const seen = { requests: 0, invalid: [], errors: [] };
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const errors = validate(messages);
      seen.requests++;
      seen.errors.push(errors);
      if (errors.length > 0) {
        seen.invalid.push(errors);
        const payload = JSON.stringify({
          error: {
            message: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls' (request_id: mock-" + seen.requests + ')',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_request_error',
          },
        });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(payload);
        return;
      }
      // 合法：回一段普通文本（不带 [[DONE]]，让流程走“提醒更新记录 → 单轮结束”）
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const chunk = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
      chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '自检回复。' }, finish_reason: null }] });
      chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => mock.listen(Number(new URL(modelBase).port), '127.0.0.1', resolve));

  // ---- 启动真实服务 ----
  const appPort = await freePort();
  const base = 'http://127.0.0.1:' + appPort;
  const logFile = path.join(tmp, 'server.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', CONTINUOUS_AGENT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  const up = await waitFor(base + '/api/state', 30_000);
  check('服务启动', up, 'port=' + appPort);

  if (up) {
    const state = await (await fetch(base + '/api/state?session=' + sessionId)).json();
    const startResp = await fetch(base + '/api/agent/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, prompt: '继续（历史修复自检）' }),
    });
    check('启动一轮返回 200', startResp.status === 200, 'HTTP ' + startResp.status);

    const deadline = Date.now() + 60_000;
    let last = state;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      last = await (await fetch(base + '/api/state?session=' + sessionId)).json();
      if (!last.status.running) break;
    }
    check('运行结束', !last.status.running, last.status.status);
    check('模型收到了请求', seen.requests > 0, 'requests=' + seen.requests);
    check('请求消息全部合法（无 400）', seen.invalid.length === 0,
      seen.invalid.length ? JSON.stringify(seen.invalid[0].slice(0, 3)) : '');
    const errors = (last.timeline || []).filter((i) => i.kind === 'error');
    check('时间线无错误项', errors.length === 0, errors.map((e) => e.text).join(' | ').slice(0, 200));
    const statusText = last.status.status || '';
    check('未因非法序列停止', !/HTTP 400/.test(statusText), statusText);

    // 落盘后的历史也要合法（重启不会再炸）。落盘有 600ms 防抖，等文件真正被重写。
    const savedRaw = path.join(dataDir, 'sessions', sessionId, 'history.json');
    const seeded = fs.readFileSync(savedRaw, 'utf8');
    const saveDeadline = Date.now() + 8_000;
    let savedText = seeded;
    while (Date.now() < saveDeadline) {
      savedText = fs.readFileSync(savedRaw, 'utf8');
      if (savedText !== seeded) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    check('历史已重新落盘', savedText !== seeded);
    const saved = JSON.parse(savedText);
    check('落盘历史不以 tool 开头', saved.length > 0 && saved[0].role !== 'tool', saved[0]?.role || 'empty');
    const { buildMessages } = await import(pathToFileURL(path.join(ROOT, 'dist', 'server', 'llm.js')).href);
    const savedPayloadErrors = validate(buildMessages(saved, false));
    check('落盘历史重建请求合法', savedPayloadErrors.length === 0, savedPayloadErrors.slice(0, 3).join('; '));
  }

  if (failures.length) {
    console.log('--- server.log ---');
    try { console.log(fs.readFileSync(logFile, 'utf8').slice(-3000)); } catch { /* ignore */ }
  }
} catch (e) {
  console.error('自检异常: ' + (e instanceof Error ? e.stack : String(e)));
  failures.push('exception');
} finally {
  if (child) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch { /* ignore */ }
  }
  if (mock) mock.close();
  if (KEEP) console.log('临时目录保留: ' + tmp);
  else {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log('');
console.log(failures.length === 0 ? 'HTTP 400 回归自检通过 [OK]' : 'HTTP 400 回归自检失败 [FAIL] ' + failures.join(', '));
process.exit(failures.length === 0 ? 0 : 1);
