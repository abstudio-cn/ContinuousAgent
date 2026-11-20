// P6b：用 streamChat（即 CA 真实请求路径）直连本地模型，量化三项改动
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PROJ = 'C:/Users/abstudio/Documents/ContinuousAgent';
const imp = (p) => import(pathToFileURL(path.join(PROJ, p)).href);

const { streamChat } = await imp('dist/server/llm.js');
const { buildToolCatalog } = await imp('dist/server/tools.js');
const { STATIC_SYSTEM_PROMPT } = await imp('dist/shared/prompt.js');
const { defaultSettings, mergeSettings } = await imp('dist/server/settings.js');

const mk = (disableThinking) => mergeSettings(defaultSettings(), {
  apiBaseUrl: 'http://192.168.157.1:8080/v1',
  apiKey: '',
  model: 'models\\Qwen3.8-27B-UD-Q4_K_M.gguf',
  temperature: 0.6,
  maxOutputTokens: 30000,
  disableThinking,
});

const tools = buildToolCatalog();
const messages = [
  { role: 'system', content: STATIC_SYSTEM_PROMPT },
  { role: 'user', content: '用 list_directory 列出工作空间根目录的文件名。只调用一次工具。' },
];

async function run(label, disableThinking) {
  const t0 = Date.now();
  let ttft = 0;
  let usage = null;
  let reasoning = '';
  let text = '';
  const calls = new Map();
  let finish = null;
  let err = null;
  try {
    for await (const ev of streamChat(mk(disableThinking), messages, tools, new AbortController().signal)) {
      if (ev.type === 'usage') usage = ev;
      else if (ev.type === 'reasoning') { if (!ttft) ttft = Date.now() - t0; reasoning += ev.text; }
      else if (ev.type === 'text') { if (!ttft) ttft = Date.now() - t0; text += ev.text; }
      else if (ev.type === 'tool_call') {
        if (!ttft && (ev.name || ev.args)) ttft = Date.now() - t0;
        const cur = calls.get(ev.index) ?? { name: '', args: '' };
        if (ev.name) cur.name = ev.name;
        if (ev.args) cur.args += ev.args;
        calls.set(ev.index, cur);
      } else if (ev.type === 'finished') finish = ev.reason;
    }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const ms = Date.now() - t0;
  const callList = [...calls.values()];
  let argsOk = null;
  if (callList.length) {
    try { JSON.parse(callList[0].args || '{}'); argsOk = true; } catch { argsOk = false; }
  }
  console.log(`[${label}] ${ms}ms ttft=${ttft}ms finish=${finish} thinking=${disableThinking}`);
  console.log(`   usage=${usage ? JSON.stringify({ p: usage.promptTokens, c: usage.completionTokens, cached: usage.cachedTokens }) : 'NONE'}`);
  console.log(`   reasoning=${reasoning.length}字 text=${text.length}字 tools=${callList.length} ${JSON.stringify(callList.map((c) => c.name))} argsValid=${argsOk}`);
  if (err) console.log('   ERR ' + err.slice(0, 300));
  return { label, ms, ttft, usage, reasoning: reasoning.length, text: text.length, tools: callList.map((c) => c.name), argsOk, finish, err };
}

console.log('=== P6b 实机：CA 真实请求路径 → 本地 Qwen3 27B ===');
const a = await run('A-思考开-冷', false);
const b = await run('B-思考开-热', false);   // 同请求重发：验证前缀缓存
const c = await run('C-思考关', true);
const d = await run('D-思考关-热', true);

console.log('\n=== 对比 ===');
console.log(`思考开: 冷 TTFT ${a.ttft}ms → 热 ${b.ttft}ms | completion ${a.usage?.completionTokens}/${b.usage?.completionTokens} | cached ${a.usage?.cachedTokens}/${b.usage?.cachedTokens}`);
console.log(`思考关: 冷 TTFT ${c.ttft}ms → 热 ${d.ttft}ms | completion ${c.usage?.completionTokens}/${d.usage?.completionTokens} | cached ${c.usage?.cachedTokens}/${d.usage?.cachedTokens}`);
console.log(`总耗时: A=${a.ms} B=${b.ms} C=${c.ms} D=${d.ms}`);
console.log(`usage 全部拿到=${[a, b, c, d].every((x) => x.usage)} 工具调用合法=${[a, b, c, d].every((x) => x.argsOk !== false)}`);
