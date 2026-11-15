#!/usr/bin/env node
/**
 * 会话隔离自检：在会话 A 跑一轮，确认 A 的记录被更新、会话 B 的记录保持不变。
 * 用法：node scripts/session-test.mjs [--url http://127.0.0.1:7789]
 */
const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = arg('url', 'http://127.0.0.1:7789');
const failures = [];
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) failures.push(name);
};

async function api(path, method = 'GET', body) {
  const resp = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!resp.ok) throw new Error(path + ' -> ' + resp.status + ' ' + (data?.error || text));
  return data;
}

const list = (await api('/api/sessions')).sessions;
console.log('会话: ' + list.map((s) => s.title + '(' + s.id + ')').join(', '));
if (list.length < 2) {
  await api('/api/sessions', 'POST', { title: '隔离测试 B' });
}
const all = (await api('/api/sessions')).sessions;
const a = all[0];
const b = all[1];

const beforeA = await api('/api/record?session=' + a.id);
const beforeB = await api('/api/record?session=' + b.id);
console.log('A 记录路径: ' + beforeA.path);
console.log('B 记录路径: ' + beforeB.path);
check('两会话记录路径不同', beforeA.path !== beforeB.path);

await api('/api/agent/reset', 'POST', { sessionId: a.id });
await api('/api/agent/start', 'POST', { sessionId: a.id, prompt: '隔离自检：更新我的记录' });

const started = Date.now();
let stateA = null;
while (Date.now() - started < 120_000) {
  await new Promise((r) => setTimeout(r, 700));
  stateA = await api('/api/state?session=' + a.id);
  if (!stateA.status.running) break;
}
check('A 运行结束', !!stateA && !stateA.status.running, stateA ? stateA.status.status : '');
check('A 时间线非空', (stateA?.timeline?.length || 0) > 0, String(stateA?.timeline?.length));

const afterA = await api('/api/record?session=' + a.id);
const afterB = await api('/api/record?session=' + b.id);
check('A 记录被更新', afterA.markdown !== beforeA.markdown, afterA.markdown.length + ' 字符');
check('B 记录未受影响', afterB.markdown === beforeB.markdown, afterB.markdown.length + ' 字符');
check('A 笔记已写入', (await api('/api/notes?session=' + a.id)).length > 0);
check('B 时间线为空', ((await api('/api/state?session=' + b.id)).timeline || []).length === 0);

console.log('');
console.log(failures.length === 0 ? '会话隔离自检通过 [OK]' : '会话隔离自检失败 [FAIL] ' + failures.join(', '));
process.exit(failures.length === 0 ? 0 : 1);
