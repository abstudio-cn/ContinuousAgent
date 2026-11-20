#!/usr/bin/env node
/**
 * token 消耗比实测报告（README 里引用的数字由本脚本产出，可复现）。
 *
 * 做法：直接 import 编译产物里的真实实现（estimateTokens / trimHistoryMessages /
 * STATIC_SYSTEM_PROMPT / buildToolCatalog / defaultSettings），模拟一段真实的
 * 持续托管会话，比较两种实现的累计输入 token：
 *
 *   基线 A（朴素实现）：每轮把**全量历史**重发；工具结果不截断；带图不限张数
 *   本项目 B        ：静态前缀 + 按 historyMaxMessages 裁剪 + 工具结果截断 + 只带最近 2 张图
 *
 * 用法：
 *   npm run build && node scripts/token-report.mjs
 *   node scripts/token-report.mjs --json      # 机读
 *   node scripts/token-report.mjs --turns 60  # 改模拟轮数（默认 40）
 *
 * 注意：estimateTokens 用的是本项目自己的保守估算口径（CJK 每字 1 token、
 * 其余每 4 字符 1 token，见 src/server/llm.ts），与各家分词器会有偏差；
 * 这里比较的是**同一口径下的相对倍数**，不是账单金额。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const turnsArg = argv.indexOf('--turns');
const TURNS = turnsArg >= 0 ? Math.max(2, Number(argv[turnsArg + 1]) || 40) : 40;

// Windows 上动态 import 必须用 file:// URL，裸盘符路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const { estimateTokens } = await load('dist/server/llm.js');
const { trimHistoryMessages } = await load('dist/server/history.js');
const { STATIC_SYSTEM_PROMPT } = await load('dist/shared/prompt.js');
const { buildToolCatalog } = await load('dist/server/tools.js');
const { defaultSettings } = await load('dist/server/settings.js');

const settings = defaultSettings();
const limit = Math.min(400, Math.max(10, settings.historyMaxMessages));

// ── 1. 每轮固定开销：静态系统提示词 + 工具清单 ─────────────────────────────
const catalog = buildToolCatalog();
const catalogJson = JSON.stringify(catalog);
const staticTokens = estimateTokens(STATIC_SYSTEM_PROMPT);
const catalogTokens = estimateTokens(catalogJson);
const fixedTokens = staticTokens + catalogTokens;

// ── 2. 构造一段“看起来像真的”持续托管对话 ────────────────────────────────
const reasoning =
  '先确认目标窗口与工作空间状态，再决定改哪个文件；上一步的退出码为 0，' +
  '但输出里有一条警告需要核实，若确实是既有行为就先记录到工作记录再继续。';
const toolResult =
  '--- stdout ---\n' +
  '文件 C:\\Users\\me\\Documents\\demo\\src\\server\\index.ts（18240 字节）：\n' +
  '服务端负责 agent 循环、LLM 流式调用、工具执行与文件沙箱，浏览器端提供完整 UI。' +
  '改动前先读目标片段，改完立即读回内容并构建验证，看退出码、stderr 与关键行。' +
  '这里再补一些中英混排的内容，模拟真实命令输出：build ok in 3.2s, exit=0, warnings=2。\n';
const assistantText =
  '已定位到问题：历史裁剪与工具结果配对在同一处被拆开，导致下一轮请求被网关拒绝（HTTP 400）。' +
  '我先把裁剪点对齐到回合边界，再补一次占位结果，随后用回归脚本验证。';

function buildTurn(i) {
  const calls = [1, 2, 3].map((n) => ({
    id: `call_${i}_${n}`,
    name: ['read_file', 'exec_command', 'edit_file'][n - 1],
    arguments: JSON.stringify({ path: `src/server/a${n}.ts`, pattern: `turn-${i}` }),
  }));
  const assistant = { role: 'assistant', content: assistantText, reasoning, toolCalls: calls };
  const tools = calls.map((c) => ({ role: 'tool', content: toolResult, toolCallId: c.id }));
  return [assistant, ...tools];
}

// 朴素基线：不限长；本项目：真实裁剪函数
const baseline = [{ role: 'user', content: '把服务端的历史裁剪改稳，并补回归测试。' }];
const ours = [{ role: 'user', content: '把服务端的历史裁剪改稳，并补回归测试。' }];

let baselineCum = 0;
let oursCum = 0;
let peakBaseline = 0;
let peakOurs = 0;

for (let t = 1; t <= TURNS; t++) {
  const turn = buildTurn(t);

  // 基线：把所有历史原样发出（工具结果不截断）
  const baseMsgs = [...baseline, ...turn];
  const baseTokens = fixedTokens + estimateTokens(JSON.stringify(baseMsgs));
  baselineCum += baseTokens;
  peakBaseline = Math.max(peakBaseline, baseTokens);
  baseline.push(...turn);

  // 本项目：先入历史，再按 historyMaxMessages 裁剪后发出
  ours.push(...turn);
  const trimmed = trimHistoryMessages(ours, limit).messages;
  const ourTokens = fixedTokens + estimateTokens(JSON.stringify(trimmed));
  oursCum += ourTokens;
  peakOurs = Math.max(peakOurs, ourTokens);
  if (trimmed !== ours && trimmed.length < ours.length) {
    ours.length = 0;
    ours.push(...trimmed);
  }
}

// ── 3. 单次请求体积：一张截图按两种口径带进上下文 ─────────────────────────
// 实测（2026-11-15，1718x870 的 Chrome 客户区，System.Drawing CopyFromScreen 后编码）：
//   本项目策略 maxWidth=1280 + JPEG(q60)            → 76_895 B
//   同画面 PNG 原尺寸 1718 宽（朴素做法，历史里累积）→ 209_350 B
// 视觉 token 按像素口径 w*h/750 估算（各家供应商具体算法不同，这里只作数量级参照）。
const SHOT = {
  jpeg: { w: 1280, h: 648, bytes: 76895 },
  png: { w: 1718, h: 870, bytes: 209350 },
  keepLast: settings.imageKeepLast ?? 2,
};
const visionTokens = (s) => Math.round((s.w * s.h) / 750);

const round = (v, d = 1) => Number(v.toFixed(d));
const report = {
  method: 'estimateTokens(CJK 1 token/字，其余 4 字符/token)，与真实分词器有偏差，只用于相对比较',
  turns: TURNS,
  historyMaxMessages: limit,
  fixedPerRequest: {
    staticSystemPromptTokens: staticTokens,
    toolCatalogTokens: catalogTokens,
    toolCount: catalog.length,
    totalFixedTokens: fixedTokens,
  },
  cumulativeInputTokens: {
    baselineNoTrim: baselineCum,
    continuousAgent: oursCum,
    ratio: round(baselineCum / oursCum, 2),
    savedPercent: round((1 - oursCum / baselineCum) * 100, 1),
  },
  peakRequest: { baselineNoTrim: peakBaseline, continuousAgent: peakOurs, ratio: round(peakBaseline / peakOurs, 2) },
  lastRequest: { baselineNoTrim: peakBaseline, continuousAgent: peakOurs },
  image: {
    project: { ...SHOT.jpeg, visionTokens: visionTokens(SHOT.jpeg) },
    naive: { ...SHOT.png, visionTokens: visionTokens(SHOT.png) },
    visionRatio: round(visionTokens(SHOT.png) / visionTokens(SHOT.jpeg), 2),
    bytesRatio: round(SHOT.png.bytes / SHOT.jpeg.bytes, 2),
    keepLast: SHOT.keepLast,
  },
  staticPrefixSharePercent: round((fixedTokens / peakOurs) * 100, 1),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const kb = (n) => (n / 1000).toFixed(1) + 'k';
  console.log('token 消耗实测（口径：estimateTokens，CJK 1 token/字、其余 4 字符/token）');
  console.log(`模拟轮数：${TURNS} 轮，每轮 1 条 assistant（含 3 次工具调用）+ 3 条工具结果`);
  console.log('');
  console.log('每轮固定开销');
  console.log(`  静态系统提示词        ${staticTokens} tokens`);
  console.log(`  工具清单（${catalog.length} 个）      ${catalogTokens} tokens`);
  console.log(`  合计                  ${fixedTokens} tokens（字节级稳定，可命中提示词缓存）`);
  console.log('');
  console.log('累计输入 token');
  console.log(`  基线 A 全量重发       ${kb(baselineCum)}`);
  console.log(`  本项目 B              ${kb(oursCum)}`);
  console.log(`  倍数                  A / B = ${report.cumulativeInputTokens.ratio}x（省 ${report.cumulativeInputTokens.savedPercent}%）`);
  console.log('');
  console.log('单次请求峰值');
  console.log(`  基线 A                ${kb(peakBaseline)} tokens`);
  console.log(`  本项目 B              ${kb(peakOurs)} tokens（其中固定前缀占 ${report.staticPrefixSharePercent}%）`);
  console.log('');
  console.log('截图（同一张窗口画面）');
  console.log(`  本项目 ${SHOT.jpeg.w}x${SHOT.jpeg.h} JPEG60   ${(SHOT.jpeg.bytes / 1024).toFixed(1)}KB ≈ ${visionTokens(SHOT.jpeg)} 视觉 token，只留最近 ${SHOT.keepLast} 张`);
  console.log(`  朴素做法 ${SHOT.png.w}x${SHOT.png.h} PNG  ${(SHOT.png.bytes / 1024).toFixed(1)}KB ≈ ${visionTokens(SHOT.png)} 视觉 token，历史里累积`);
  console.log(`  比值                 视觉 token ${report.image.visionRatio}x，payload ${report.image.bytesRatio}x`);
}
