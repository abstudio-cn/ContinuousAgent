#!/usr/bin/env node
/**
 * 端到端自检：连接正在运行的 GameAgent Web，选择窗口（可选）→ 启动一轮托管 → 校验时间线/记录/笔记。
 *
 *   node scripts/selftest.mjs --url http://127.0.0.1:7800 --title ContinuousAgent --prompt "原生链路自检"
 */

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const BASE = arg('url', 'http://127.0.0.1:7800');
const TITLE = arg('title', '');
const PROMPT = arg('prompt', '自检：观察画面并更新游戏记录');
const TIMEOUT = Number(arg('timeout', '120')) * 1000;

async function api(path, method = 'GET', body) {
  const resp = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!resp.ok) throw new Error(path + ' -> HTTP ' + resp.status + ' ' + (data?.error || text));
  return data;
}

function line(s) { console.log(s); }

const failures = [];
function check(name, ok, extra = '') {
  line((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) failures.push(name);
}

async function main() {
  const state = await api('/api/state');
  line('服务: ' + BASE + '  平台: ' + state.platform + '  原生桥接: ' + (state.nativeAvailable ? '可用' : '不可用'));
  check('原生桥接可用', state.nativeAvailable, state.nativeDetail);

  if (TITLE) {
    const sel = await api('/api/window/select', 'POST', { pid: 0, title: TITLE });
    check('选择目标窗口', !!sel.target, sel.target ? sel.target.processName + ' ' + sel.target.width + 'x' + sel.target.height : '');
  }

  await api('/api/agent/reset', 'POST', {});
  await api('/api/agent/start', 'POST', { prompt: PROMPT });

  const started = Date.now();
  let last = null;
  while (Date.now() - started < TIMEOUT) {
    await new Promise((r) => setTimeout(r, 700));
    last = await api('/api/state');
    if (!last.status.running) break;
  }
  check('运行结束', !!last && !last.status.running, last ? last.status.status : 'no state');

  const items = last.timeline || [];
  const kinds = items.map((i) => i.kind);
  line('时间线: ' + items.length + ' 项  kinds=' + [...new Set(kinds)].join(','));
  check('有时间线内容', items.length > 0);
  check('无错误项', !items.some((i) => i.kind === 'error'), items.filter((i) => i.kind === 'error').map((i) => i.text).join(' | '));
  check('游戏记录非空', (last.record || '').length > 50, (last.record || '').length + ' 字符');
  check('游戏笔记非空', (last.notes || '').length > 20, (last.notesLength || 0) + ' 字符');

  const tools = items.filter((i) => i.kind === 'tool');
  if (tools.length) {
    line('工具调用:');
    for (const t of tools) {
      line('  - ' + t.title + ' · ' + (t.status || '') + ' · ' + (t.meta || '') +
        (t.imageUrl ? ' · 截图 ' + t.imageUrl : ''));
    }
    check('工具全部成功', tools.every((t) => t.status === '完成'));
  }
  if (process.env.EXPECT_TOOLS) {
    const want = process.env.EXPECT_TOOLS.split(',').map((s) => s.trim()).filter(Boolean);
    for (const w of want) check('调用了 ' + w, tools.some((t) => t.title === w));
  }

  line('');
  line(failures.length === 0 ? '自检通过 ✅' : '自检失败 ❌ ' + failures.join(', '));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('自检异常: ' + e.message);
  process.exit(2);
});
