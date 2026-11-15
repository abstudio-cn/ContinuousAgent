#!/usr/bin/env node
/**
 * 性能基准（不依赖模型或网络服务）。
 *
 * 用法：
 *   node scripts/bench.mjs                    # 测当前项目（读 dist/）
 *   node scripts/bench.mjs --root <项目根>    # 测另一个项目根（用于优化前后对比）
 *   node scripts/bench.mjs --json             # 只输出 JSON
 *
 * 覆盖四个热点：
 *   1) llm.estimateTokens —— 每次请求对整个 payload（含 base64 截图）逐字符估算
 *   2) client renderMarkdown —— 单次渲染 + “流式逐步增长、每步重渲染全文”的模拟
 *   3) AgentRunner 流式回放 —— 统计 SSE 事件条数与字节数（客户端渲染压力）
 *   4) SessionStore.infos —— 会话列表的字数统计（每次状态推送都要跑）
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const ROOT = path.resolve(flag('--root', process.env.CA_ROOT || path.resolve(here, '..')));
const JSON_ONLY = argv.includes('--json');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const results = [];
const add = (name, metrics, note = '') => results.push({ name, ...metrics, note });

/** 生成一段约 targetChars 的 Markdown（标题/列表/代码块/行内强调/链接混排）。 */
function bigDoc(targetChars) {
  const block = [
    '## 小结 ',
    '',
    '这一节说明当前的进度与风险，包含**加粗**、*斜体*、`code` 与 [链接](https://example.com/a)。',
    '',
    '- 第一条：目录 `C:\\Users\\abstudio\\Documents` 已复制完成',
    '- 第二条：`npm run typecheck` 退出码 0',
    '1. 有序项一',
    '2. 有序项二',
    '',
    '> 引用：工具实测优先于工作记录。',
    '',
    '```ts',
    'const x: number = 1;',
    'export function f(a: string): string {',
    "  return a + 'x';",
    '}',
    '```',
    '',
  ].join('\n');
  let doc = '# 工作记录\n\n';
  let i = 0;
  while (doc.length < targetChars) {
    doc += block.replace('## 小结 ', '## 小结 ' + ++i) + '\n';
  }
  return doc;
}

async function benchTokens() {
  const { estimateTokens } = await load('dist/server/llm.js');
  const messages = [];
  for (let k = 0; k < 40; k++) {
    messages.push({ role: k % 2 ? 'assistant' : 'user', content: '这是用于估算 token 的中文文本片段。'.repeat(10) });
  }
  const img = 'A'.repeat(340_000);
  const payload = JSON.stringify({ model: 'm', messages, images: [img, img] });
  const bytes = Buffer.byteLength(payload, 'utf8');
  const N = 20;
  let sum = 0;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) sum += estimateTokens(payload);
  const ms = (performance.now() - t0) / N;
  add('estimateTokens(≈0.7MB payload)', { msPerOp: round(ms, 3), bytes, tokens: Math.round(sum / N) },
    '每次 LLM 请求估算一次');
}

async function benchMarkdown() {
  const { renderMarkdown } = await load('dist/public/client/markdown.js');
  const doc = bigDoc(20_000);
  const N = 40;
  let t0 = performance.now();
  for (let k = 0; k < N; k++) renderMarkdown(doc);
  const msDoc = (performance.now() - t0) / N;

  // 流式模拟：文本按 100 步增长，每步把增长后的全文重渲染（旧客户端 item 更新行为）
  const steps = 100;
  const chunk = Math.ceil(doc.length / steps);
  t0 = performance.now();
  for (let k = 1; k <= steps; k++) renderMarkdown(doc.slice(0, k * chunk));
  const msStream = performance.now() - t0;

  add('renderMarkdown(20k 文档)', { msPerOp: round(msDoc, 2), chars: doc.length });
  add('renderMarkdown 流式重渲染', { totalMs: round(msStream, 1), renders: steps },
    '100 步增长、每步全文重渲染（旧客户端行为）');
}

/** 增量流式渲染：只处理新增的完整行（新版 MarkdownStream）。旧版没有这个 API，会跳过。 */
async function benchStreamRender() {
  const mod = await load('dist/public/client/markdown.js');
  if (typeof mod.MarkdownStream !== 'function') {
    add('MarkdownStream 流式增量渲染', { skipped: 1 }, '旧版无 MarkdownStream API');
    return;
  }
  const doc = bigDoc(20_000);
  const steps = 100;
  const chunk = Math.ceil(doc.length / steps);
  const t0 = performance.now();
  const stream = new mod.MarkdownStream();
  let html = '';
  for (let k = 1; k <= steps; k++) html = stream.push(doc.slice(0, k * chunk));
  html = stream.finish();
  const ms = performance.now() - t0;
  add('MarkdownStream 流式增量渲染', {
    totalMs: round(ms, 1), renders: steps, htmlKB: round(html.length / 1024, 1),
  }, '100 步增长、每步只处理新增行（新客户端行为）');
}

async function benchStream() {
  const { AgentRunner } = await load('dist/server/agent.js');
  const DELTAS = 200;
  const INTERVAL = 12;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= DELTAS) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      sent++;
      const content = '流式文本片段' + String(sent).padStart(3, '0') + '，用于测试渲染压力。';
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
    }, INTERVAL);
    req.on('close', () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const settings = {
    apiBaseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', model: 'mock',
    maxOutputTokens: 1024, temperature: 0, reasoningEffort: 'auto', screenshotBurnAfterRead: true,
    maxTurns: 1, continuousMode: false, continueDelayMs: 300, continuePrompt: '继续',
    historyMaxMessages: 40, clickDelayMs: 0,
  };
  const stats = { events: 0, itemUpdates: 0, bytes: 0, byType: {} };
  const tools = {
    updateSettings() {},
    bindSession() {},
    async execute() { return { text: 'ok', isError: false }; },
    runtimeContext: () => 'ctx',
    target: null,
    record: { read: () => 'rec', ensureExists: () => 'rec', buildPromptBlock: () => 'REC', recordPath: '/tmp/rec.md' },
    notes: {
      read: () => 'n', ensureExists: () => 'n', buildPromptBlock: () => 'N',
      notesPath: '/tmp/notes.md', currentLength: 1,
    },
  };
  const runner = new AgentRunner({
    sessionId: 's1',
    getSettings: () => settings,
    tools,
    emit: (ev) => {
      stats.events++;
      stats.byType[ev.type] = (stats.byType[ev.type] || 0) + 1;
      if (ev.type === 'item_update') stats.itemUpdates++;
      stats.bytes += JSON.stringify(ev).length;
    },
    onPersist: () => {},
  });
  const t0 = performance.now();
  await runner.start('基准测试', { title: 't', recordPath: '/tmp/rec.md', notesPath: '/tmp/notes.md' });
  const ms = performance.now() - t0;
  server.close();
  add('流式 200 delta 的 SSE 事件量', {
    ms: round(ms), events: stats.events, itemUpdates: stats.itemUpdates,
    sseKB: round(stats.bytes / 1024, 1),
  }, JSON.stringify(stats.byType));
}

async function benchSessions() {
  const { SessionStore } = await load('dist/server/sessions.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-bench-'));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const settings = { workspacePath: ws, gameRecordFileName: 'work_state.md', gameNotesFileName: 'work_notes.md' };
  const store = new SessionStore(path.join(tmp, 'data'), () => settings);
  const bigMd = '# 记录\n' + '这是一行工作记录内容，用于测试字数统计开销。\n'.repeat(1500);
  for (let k = 0; k < 5; k++) {
    const meta = store.create('会话' + k);
    fs.writeFileSync(store.recordPath(meta.id), bigMd, 'utf8');
    fs.writeFileSync(store.notesPath(meta.id), bigMd, 'utf8');
  }
  const N = 50;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) store.infos(new Set());
  const ms = (performance.now() - t0) / N;
  add('sessions.infos(5 会话×2 文件)', { msPerOp: round(ms, 3), charsPerFile: bigMd.length },
    '每次 /api/state 与 sessions 广播都会调用');
  fs.rmSync(tmp, { recursive: true, force: true });
}

const benches = [benchTokens, benchMarkdown, benchStreamRender, benchStream, benchSessions];
for (const bench of benches) {
  try {
    await bench();
  } catch (e) {
    add(bench.name, { error: e instanceof Error ? e.message : String(e) });
  }
}

if (JSON_ONLY) {
  console.log(JSON.stringify({ root: ROOT, results }, null, 2));
} else {
  console.log('基准根目录: ' + ROOT + '\n');
  for (const r of results) {
    const metrics = Object.entries(r)
      .filter(([k]) => k !== 'name' && k !== 'note')
      .map(([k, v]) => k + '=' + v).join('  ');
    console.log('- ' + r.name + ': ' + metrics + (r.note ? '\n    ' + r.note : ''));
  }
}
