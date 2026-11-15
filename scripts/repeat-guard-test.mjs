/**
 * 重复工具调用熔断（repeat-guard）回归测试。
 *
 * 用法：npm run build && node scripts/repeat-guard-test.mjs
 *
 * 覆盖：
 *  1) 单元：参数规范化/指纹/滑动窗口/阈值/重置
 *  2) 接线：产物里确实接上了熔断（agent.ts、prompt.ts）
 *  3) 端到端（真实循环 + 本地 SSE mock 模型，隔离数据目录与端口）：
 *     a. 同一调用连续 10 次 → 不中断，正常走到完成
 *     b. 同一调用第 11 次 → 立即中断，状态「重复调用，已中断」，turn=11，历史仍合法
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];

function ok(cond, name, detail = '') {
  if (cond) {
    pass++;
    return true;
  }
  fails.push(name + (detail ? ' → ' + detail : ''));
  return false;
}
function eq(actual, expected, name) {
  return ok(actual === expected, name, '実际=' + JSON.stringify(actual) + ' 期待=' + JSON.stringify(expected));
}

console.log('== 1) 单元：规范化 / 指纹 / 滑动窗口 ==');
const mod = await import(pathToFileURL(path.join(ROOT, 'dist/server/repeat-guard.js')).href);
const { RepeatGuard, REPEAT_LIMIT, REPEAT_WINDOW, normalizeToolArgs, toolCallKey } = mod;

eq(REPEAT_LIMIT, 10, '1.1 上限为 10 次');
eq(REPEAT_WINDOW, 30, '1.2 滑动窗口为 30 次');
eq(normalizeToolArgs('{"b":2,"a":1}'), '{"a":1,"b":2}', '1.3 键序被规范化');
eq(normalizeToolArgs('{ "a" : 1 }'), '{"a":1}', '1.4 空白被规范化');
eq(normalizeToolArgs(''), '{}', '1.5 空参数归一为 {}');
eq(normalizeToolArgs('   {}  '), '{}', '1.6 "{}" 归一');
eq(normalizeToolArgs('{"x":{"b":1,"a":[{"d":4,"c":3}]}}'), '{"x":{"a":[{"c":3,"d":4}],"b":1}}', '1.7 嵌套对象/数组递归规范化');
eq(normalizeToolArgs('not   json here'), 'not json here', '1.8 非 JSON 退回压缩空白原文');
ok(toolCallKey('read_file', '{"a":1}') === toolCallKey(' read_file ', '{ "a": 1 }'), '1.9 工具名 trim 后同指纹');
ok(toolCallKey('read_file', '{"a":1}') !== toolCallKey('write_file', '{"a":1}'), '1.10 不同工具不同指纹');
ok(toolCallKey('read_file', '{"a":1}') !== toolCallKey('read_file', '{"a":2}'), '1.11 不同参数不同指纹');

{
  const g = new RepeatGuard();
  let blockedAt = -1;
  const counts = [];
  for (let i = 1; i <= 11; i++) {
    const r = g.observe('read_file', '{"path":"a.txt"}');
    counts.push(r.count);
    if (r.blocked && blockedAt < 0) blockedAt = i;
  }
  eq(blockedAt, 11, '1.12 第 11 次触发熔断');
  eq(counts.slice(0, 10).join(','), '0,1,2,3,4,5,6,7,8,9', '1.13 前 10 次的 count 递增');
  eq(counts[10], 10, '1.14 熔断时窗口内已出现 10 次');
}
{
  const g = new RepeatGuard();
  let blocked = false;
  for (let i = 0; i < 10; i++) blocked = g.observe('read_file', '{"path":"a.txt"}').blocked || blocked;
  ok(!blocked, '1.15 恰好 10 次不熔断');
  eq(g.history.length, 10, '1.16 未熔断的调用都入窗');
}
{
  const g = new RepeatGuard();
  for (let i = 0; i < 10; i++) g.observe('read_file', '{"path":"a.txt"}');
  const other = g.observe('read_file', '{"path":"b.txt"}');
  ok(!other.blocked, '1.17 参数不同则各自计数');
  eq(other.count, 0, '1.18 新参数 count 从 0 起');
  ok(g.observe('read_file', '{"path":"a.txt"}').blocked, '1.19 换了参数也不影响原调用已到上限');
}
{
  // 窗口滑出：limit=2 window=3，A,A,B,C 之后 A 的旧记录已被挤出窗口
  const g = new RepeatGuard(2, 3);
  g.observe('t', '{"k":1}');
  g.observe('t', '{"k":1}');
  g.observe('t', '{"k":2}');
  g.observe('t', '{"k":3}');
  const r = g.observe('t', '{"k":1}');
  ok(!r.blocked, '1.20 窗口外的旧调用不再计数');
  eq(r.count, 1, '1.21 窗口内只剩 1 次同指纹');
  eq(g.history.length, 3, '1.22 窗口长度受 window 限制');
}
{
  const g = new RepeatGuard();
  for (let i = 0; i < 9; i++) g.observe('t', '{}');
  g.reset();
  eq(g.history.length, 0, '1.23 reset 清空窗口');
  let blocked = false;
  for (let i = 0; i < 10; i++) blocked = g.observe('t', '{}').blocked || blocked;
  ok(!blocked, '1.24 reset 后重新计数');
}
{
  const g = new RepeatGuard();
  g.observe('t', '{}');
  const hist = g.history;
  hist.push('x');
  eq(g.history.length, 1, '1.25 history 返回副本');
}
{
  // 交替 A/B 各 11 次也会熔断（死循环的另一种形态）
  const g = new RepeatGuard();
  let blockedA = false;
  for (let i = 0; i < 11; i++) {
    const a = g.observe('t', '{"k":"a"}');
    if (a.blocked) blockedA = true;
    if (blockedA) break;
    const b = g.observe('t', '{"k":"b"}');
    if (b.blocked) break;
  }
  ok(blockedA, '1.26 交替重复同一组调用也会熔断');
}

console.log('== 2) 接线：产物里确实接上了熔断 ==');
const agentJs = fs.readFileSync(path.join(ROOT, 'dist/server/agent.js'), 'utf8');
const promptJs = fs.readFileSync(path.join(ROOT, 'dist/shared/prompt.js'), 'utf8');
const countOf = (s, sub) => s.split(sub).length - 1;
ok(fs.existsSync(path.join(ROOT, 'dist/server/repeat-guard.js')), '2.1 产物含 repeat-guard.js');
eq(countOf(agentJs, 'new RepeatGuard('), 1, '2.2 主循环只建一个熔断器');
eq(countOf(agentJs, 'repeatGuard.observe('), 1, '2.3 每次工具调用都过熔断判定');
ok(agentJs.includes('检测到重复的工具调用：'), '2.4 中断时会生成系统提示项');
ok(agentJs.includes("'重复调用，已中断'"), '2.5 中断后状态文案正确');
ok(agentJs.includes('REPEAT_LIMIT') && agentJs.includes('REPEAT_WINDOW'), '2.6 文案引用上下限常量');
ok(agentJs.includes('repeatStop = { name: call.name, count: repeated.count };'), '2.7 记录触发熔断的调用');
{
  const iObserve = agentJs.indexOf('repeatGuard.observe(');
  const iExec = agentJs.indexOf('await this.deps.tools.execute(');
  ok(iObserve > 0 && iExec > iObserve, '2.8 判定发生在真正执行之前');
  const iStop = agentJs.indexOf('if (repeatStop) {');
  // 编译产物会把 `if (signal.aborted)\n    throw …` 折成两行，压平空白后再比顺序
  const flat = agentJs.replace(/\s+/g, ' ');
  const iThrow = flat.indexOf("if (signal.aborted) throw new Error('已中断');");
  const iStopFlat = flat.indexOf('if (repeatStop) {');
  ok(iThrow > 0 && iStopFlat > iThrow, '2.9 熔断收尾在占位结果补齐（finally）之后');
  const iPlaceholder = agentJs.indexOf('[工具调用已中断，未执行]');
  ok(iPlaceholder > 0 && iPlaceholder < iStop, '2.10 未执行的调用仍补占位结果（历史合法）');
}
ok(promptJs.includes('原地打转会被熔断'), '2.11 系统提示词已告知熔断规则');
ok(promptJs.includes('最近 30 次调用里同一调用出现超过 10 次'), '2.12 提示词写明阈值口径');

console.log('== 3) 端到端：真实循环 + SSE mock 模型 ==');
const waitPort = (port, ms = 20000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + ms;
  const tick = () => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/state', timeout: 1500 }, (res) => {
      res.resume();
      if (res.statusCode === 200) resolve(true);
      else retry();
    });
    req.on('error', retry);
    req.on('timeout', () => req.destroy());
    function retry() {
      if (Date.now() > deadline) reject(new Error('等待端口 ' + port + ' 超时'));
      else setTimeout(tick, 250);
    }
  };
  tick();
});

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-repeat-'));
const dataDir = path.join(tmp, 'data');
const ws = path.join(tmp, 'ws');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
const probeFile = path.join(ws, 'probe.txt');
const probeBody = 'REPEAT_PROBE_CONTENT';
fs.writeFileSync(probeFile, probeBody, 'utf8');

const post = (port, p, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 10000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
    let t = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (t += c));
    res.on('end', () => {
      try { resolve(JSON.parse(t || '{}')); } catch { resolve({ raw: t }); }
    });
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('POST 超时 ' + p)));
  req.end(data);
});
const getJson = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, timeout: 10000 }, (res) => {
    let t = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (t += c));
    res.on('end', () => {
      try { resolve(JSON.parse(t || '{}')); } catch { reject(new Error('非 JSON: ' + t.slice(0, 200))); }
    });
  }).on('error', reject);
});

// mock 模型：始终用同一工具同一参数；stopAt=10 时第 10 次工具结果后返回 [[DONE]]
let mockMode = 'loop';
let mockRequests = 0;
// 历史合法性：某条 assistant.tool_calls 之后没有齐全的 tool 结果时记为非法 id
const badHistory = [];
const findDanglingToolCalls = (bodyText) => {
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { return null; }
  const msgs = parsed?.messages;
  if (!Array.isArray(msgs)) return null;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    const got = new Set();
    for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j++) got.add(msgs[j].tool_call_id);
    for (const c of m.tool_calls) if (!got.has(c.id)) return c.id;
  }
  return null;
};
const readJson = (file) => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw)) return raw;
  return raw.messages || raw.history || raw.items || [];
};

const mock = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    mockRequests++;
    const toolMsgs = countOf(body, '"role":"tool"');
    // 服务端真实接口会因「tool_calls 没有对应结果」判 400；mock 也照此校验，
    // 这样后续续跑能跑通就说明熔断轮次的历史是合法序列
    const dangling = findDanglingToolCalls(body);
    if (dangling) {
      badHistory.push(dangling);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'HTTP 400 非法历史: tool_call ' + dangling + ' 没有对应结果' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    if (mockMode === 'finish' || (mockMode === 'stopAt' && toolMsgs >= 10)) {
      send({ choices: [{ delta: { content: '已重复 10 次，收尾 [[DONE]]' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    } else {
      send({ choices: [{ delta: { content: '再读一次同一个文件。' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + mockRequests, type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: probeFile }) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    }
    send({ usage: { prompt_tokens: 1000, completion_tokens: 12 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

let srv = null;
const cleanup = () => {
  try { if (srv && !srv.killed) execFileSync('taskkill', ['/PID', String(srv.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  try { mock.close(); } catch {}
};

try {
  const mockPort = await freePort();
  await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));

  const settings = {
    apiBaseUrl: 'http://127.0.0.1:' + mockPort + '/v1',
    apiKey: 'test-key',
    model: 'mock-model',
    workspacePath: ws,
    continuousMode: false,
    maxTurns: 0,
    clickDelayMs: 0,
    sendScreenshots: false,
    screenshotBurnAfterRead: false,
    ttsEnabled: false,
    changedBackupEnabled: false,
    shellTimeoutMs: 20000,
  };
  // 注意：writeFileSync 写 'utf8' 不带 BOM，settings.json 才能被 JSON.parse
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');

  const port = await freePort();
  srv = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CONTINUOUS_AGENT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvErr = '';
  srv.stderr.on('data', (c) => (srvErr += c.toString()));
  await waitPort(port);
  ok(true, '3.1 隔离实例已启动');

  const runOnce = async (mode, prompt) => {
    mockMode = mode;
    const created = await post(port, '/api/sessions', { title: 'repeat-' + mode });
    const sessionId = created?.session?.id || created?.state?.session?.id;
    ok(!!sessionId, '3.x 新建会话 (' + mode + ')', JSON.stringify(created).slice(0, 160));
    const before = mockRequests;
    await post(port, '/api/agent/start', { sessionId, prompt });
    const deadline = Date.now() + 60000;
    let st = null;
    let timeline = [];
    while (Date.now() < deadline) {
      const state = await getJson(port, '/api/state?session=' + encodeURIComponent(sessionId));
      st = state.status || {};
      timeline = state.timeline || [];
      if (st.running === false && (st.turn || 0) > 0) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // 状态里没有时间线的情况再补一次（拿最终快照）
    if (timeline.length === 0) {
      const state = await getJson(port, '/api/state?session=' + encodeURIComponent(sessionId));
      timeline = state.timeline || [];
    }
    return { sessionId, status: st, timeline, requests: mockRequests - before };
  };

  // a) 恰好 10 次：不熔断，正常收尾
  const a = await runOnce('stopAt', '重复 10 次不中断');
  eq(a.requests, 11, '3.2 十次重复发送了 11 次请求（10 次工具 + 1 次收尾）');
  eq(a.status.turn, 11, '3.3 十次重复共 11 轮');
  eq(a.status.status, '已完成', '3.4 达到 10 次不中断，正常完成');
  eq(a.status.running, false, '3.5 完成后 running=false');
  {
    const tl = a.timeline;
    ok(tl.length > 0, '3.6 取到时间线快照');
    ok(!tl.some((it) => String(it.text || '').includes('检测到重复的工具调用')), '3.7 十次重复不产生熔断提示');
    const toolItems = tl.filter((it) => it.kind === 'tool');
    eq(toolItems.length, 10, '3.8 十次调用都真正执行了');
    ok(toolItems.every((it) => it.status === '完成'), '3.9 每次工具调用都成功');
    ok(toolItems.every((it) => String(it.detail || '').includes(probeBody)), '3.10 每次调用都拿到文件内容');
    eq(badHistory.length, 0, '3.11 十次重复的历史始终合法');
  }

  // b) 第 11 次：立即熔断
  const b = await runOnce('loop', '重复 11 次应中断');
  eq(b.requests, 11, '3.9 第 11 轮请求后即中断，不再发请求');
  eq(b.status.turn, 11, '3.10 中断发生在第 11 轮');
  eq(b.status.status, '重复调用，已中断', '3.11 状态文案为「重复调用，已中断」');
  eq(b.status.running, false, '3.12 熔断后 running=false');
  {
    const tl = b.timeline;
    const sys = tl.filter((it) => it.kind === 'system' && String(it.text || '').includes('检测到重复的工具调用'));
    eq(sys.length, 1, '3.13 时间线里有 1 条熔断提示');
    ok(String(sys[0]?.text || '').includes('read_file'), '3.14 提示里点明是哪个工具');
    ok(String(sys[0]?.text || '').includes('已出现 10 次'), '3.15 提示里点明已出现次数');
    ok(String(sys[0]?.text || '').includes('超过 10 次上限'), '3.16 提示里点明上限口径');
    const toolItems = tl.filter((it) => it.kind === 'tool');
    eq(toolItems.length, 10, '3.17 只执行了前 10 次，第 11 次没有生成工具项');
    ok(toolItems.every((it) => it.status === '完成'), '3.18 前 10 次都正常完成');
    // 断言顺序：熔断提示出现在第 10 个工具项之后
    const idxLastTool = tl.findIndex((it) => it.id === toolItems[9]?.id);
    const idxSys = tl.findIndex((it) => it.id === sys[0]?.id);
    ok(idxSys > idxLastTool, '3.19 熔断提示排在最后一次真实调用之后');
    ok(!tl.some((it) => it.kind === 'error'), '3.20 熔断不产生错误项');
  }
  eq(badHistory.length, 0, '3.21 熔断轮次的历史仍合法（无人被判 400）');

  // c) 熔断后在同一会话继续跑：历史合法才能续跑成功（mock 会对悬空 tool_call 回 400）
  {
    mockMode = 'finish';
    await post(port, '/api/agent/start', { sessionId: b.sessionId, prompt: '熔断后继续' });
    const deadline = Date.now() + 30000;
    let st = {};
    while (Date.now() < deadline) {
      const state = await getJson(port, '/api/state?session=' + encodeURIComponent(b.sessionId));
      st = state.status || {};
      if (st.running === false && (st.turn || 0) > b.status.turn) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    eq(st.status, '已完成', '3.22 熔断后同一会话可继续运行');
    eq(st.turn, (b.status.turn || 0) + 1, '3.23 续跑只用了 1 轮');
    eq(badHistory.length, 0, '3.24 续跑请求里的历史没有悬空 tool_call');
  }
  ok(!/\bError\b/.test(srvErr), '3.25 服务端 stderr 无 Error', srvErr.slice(0, 300));
} finally {
  cleanup();
  if (fails.length === 0) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  } else {
    console.log('（临时数据保留以便排查：' + tmp + '）');
  }
}

console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length > 0) {
  for (const f of fails) console.log('  FAIL ' + f);
  process.exitCode = 1;
} else {
  console.log('全部通过');
}
