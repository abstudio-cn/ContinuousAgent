// 价格统计回归测试：金额换算、格式化、缓存命中解析、设置校验、产物接线。
//   npm run build && node scripts/pricing-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeCost, formatMoney, hasPricing, splitInputTokens } from '../dist/shared/pricing.js';
import { readCachedTokens } from '../dist/server/llm.js';
import { defaultSettings, mergeSettings } from '../dist/server/settings.js';

const results = [];
let failed = 0;
function check(name, cond, extra) {
  results.push(!!cond);
  if (cond) return;
  failed++;
  if (extra !== undefined) console.log('FAIL ' + name + '\n     ' + String(extra).slice(0, 400));
  else console.log('FAIL ' + name);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const PRICES = { cacheHit: 0.1, input: 1, output: 2 };

// ---------------------------------------------------------------- 1) 金额换算
{
  const c = computeCost({ promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 }, PRICES);
  check('全额输入按输入价', near(c.inputCost, 1), c.inputCost);
  check('输出按输出价', near(c.outputCost, 2), c.outputCost);
  check('合计相加', near(c.total, 3), c.total);
  check('无缓存时缓存费为 0', near(c.cacheCost, 0), c.cacheCost);
}

{
  // 80% 命中缓存
  const c = computeCost({ promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 800_000 }, PRICES);
  check('缓存 tokens 正确', c.cachedTokens === 800_000, c.cachedTokens);
  check('未命中部分按输入价', c.inputTokens === 200_000, c.inputTokens);
  check('缓存费 = 命中 × 缓存价', near(c.cacheCost, 0.08), c.cacheCost);
  check('输入费 = 未命中 × 输入价', near(c.inputCost, 0.2), c.inputCost);
  check('合计 = 缓存 + 输入', near(c.total, 0.28), c.total);
}

{
  // 脏数据：命中数大于输入总量 → 裁剪，不出现负输入
  const c = computeCost({ promptTokens: 1000, completionTokens: 10, cachedTokens: 5000 }, PRICES);
  check('命中数被裁剪到输入总量', c.cachedTokens === 1000, c.cachedTokens);
  check('输入量不为负', c.inputTokens === 0, c.inputTokens);
  check('输出仍按实计', c.outputTokens === 10, c.outputTokens);
}

{
  const c = computeCost({ promptTokens: 1000, completionTokens: 10 }, PRICES);
  check('cachedTokens 缺省按 0', c.cachedTokens === 0 && c.inputTokens === 1000, JSON.stringify(c));
  const c2 = computeCost({ promptTokens: 1000, completionTokens: 10, cachedTokens: null }, PRICES);
  check('cachedTokens 为 null 按 0', c2.cachedTokens === 0, c2.cachedTokens);
}

{
  const c = computeCost({ promptTokens: -5, completionTokens: -1, cachedTokens: -3 }, PRICES);
  check('负用量归零', c.total === 0 && c.cachedTokens === 0 && c.outputTokens === 0, JSON.stringify(c));
}

{
  // 只填输出价：输入不计费
  const c = computeCost({ promptTokens: 500_000, completionTokens: 1_000_000, cachedTokens: 0 }, { cacheHit: 0, input: 0, output: 3 });
  check('仅输出计价时输入为 0', near(c.inputCost, 0) && near(c.total, 3), JSON.stringify(c));
}

{
  const zero = computeCost({ promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 500_000 }, { cacheHit: 0, input: 0, output: 0 });
  check('全部单价为 0 时金额为 0', zero.total === 0, zero.total);
}

// ---------------------------------------------------------------- 2) 输入两段拆分（命中 / 未命中）
{
  const s = splitInputTokens({ promptTokens: 1000, cachedTokens: 400 });
  check('拆分：命中 = cachedTokens', s.hitTokens === 400, JSON.stringify(s));
  check('拆分：未命中 = 总量 - 命中', s.missTokens === 600, s.missTokens);
  check('拆分：两段相加等于总量', s.totalTokens === 1000 && s.hitTokens + s.missTokens === s.totalTokens, JSON.stringify(s));

  const noCache = splitInputTokens({ promptTokens: 800 });
  check('未上报缓存 → 命中 0', noCache.hitTokens === 0, noCache.hitTokens);
  check('未上报缓存 → 全算未命中', noCache.missTokens === 800 && noCache.totalTokens === 800, JSON.stringify(noCache));

  const nullCache = splitInputTokens({ promptTokens: 800, cachedTokens: null });
  check('cachedTokens 为 null → 命中 0，全算未命中', nullCache.hitTokens === 0 && nullCache.missTokens === 800,
    JSON.stringify(nullCache));

  const over = splitInputTokens({ promptTokens: 500, cachedTokens: 900 });
  check('命中数裁剪到总量', over.hitTokens === 500, over.hitTokens);
  check('裁剪后未命中不为负', over.missTokens === 0, over.missTokens);

  const neg = splitInputTokens({ promptTokens: -10, cachedTokens: -3 });
  check('负输入 → 两段均为 0', neg.totalTokens === 0 && neg.hitTokens === 0 && neg.missTokens === 0, JSON.stringify(neg));

  const none = splitInputTokens(null);
  check('null 用量 → 两段均为 0', none.totalTokens === 0 && none.missTokens === 0, JSON.stringify(none));

  // 不变量：任意脏数据下 hit + miss === total 且 miss >= 0
  let invariant = true;
  for (const u of [
    { promptTokens: 0, cachedTokens: 0 },
    { promptTokens: 1, cachedTokens: 1 },
    { promptTokens: 1, cachedTokens: 7 },
    { promptTokens: 12_345, cachedTokens: 12_344 },
    { promptTokens: 99_999, cachedTokens: 0 },
    { promptTokens: 7, cachedTokens: 3 },
  ]) {
    const r = splitInputTokens(u);
    if (r.hitTokens + r.missTokens !== r.totalTokens || r.missTokens < 0 || r.hitTokens < 0) {
      invariant = false;
      console.log('     bad split ' + JSON.stringify(u) + ' -> ' + JSON.stringify(r));
    }
  }
  check('不变量：命中 + 未命中 = 输入总量', invariant, '');
}

// ---------------------------------------------------------------- 2b) 定价与拆分段一一对应
{
  // 命中 800k × 缓存价、未命中 200k × 输入价：两段各自独立计价，不得互串
  const c = computeCost({ promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 800_000 }, PRICES);
  check('分项：cacheHitTokens 显式存在', c.cacheHitTokens === 800_000, c.cacheHitTokens);
  check('分项：cacheMissTokens 显式存在', c.cacheMissTokens === 200_000, c.cacheMissTokens);
  check('分项：输入总量 = 命中 + 未命中', c.inputTotalTokens === 1_000_000 &&
    c.cacheHitTokens + c.cacheMissTokens === c.inputTotalTokens, JSON.stringify(c));
  check('旧字段名与新字段一致', c.cachedTokens === c.cacheHitTokens && c.inputTokens === c.cacheMissTokens,
    JSON.stringify([c.cachedTokens, c.cacheHitTokens, c.inputTokens, c.cacheMissTokens]));
  check('命中段单价 = 缓存价', near(c.cacheCost, 0.08) && near(c.cacheCost, (c.cacheHitTokens / 1e6) * PRICES.cacheHit),
    c.cacheCost);
  check('未命中段单价 = 输入价', near(c.inputCost, 0.2) && near(c.inputCost, (c.cacheMissTokens / 1e6) * PRICES.input),
    c.inputCost);

  // 只填输入价（缓存价 0）：命中段免费，未命中段照收
  const onlyInput = computeCost({ promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 600_000 },
    { cacheHit: 0, input: 5, output: 0 });
  check('缓存价为 0 时命中段不计费', near(onlyInput.cacheCost, 0), onlyInput.cacheCost);
  check('未命中段仍按输入价计费', near(onlyInput.inputCost, 2), onlyInput.inputCost);

  // 只填缓存价：未命中段免费，命中段照收
  const onlyCache = computeCost({ promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 250_000 },
    { cacheHit: 4, input: 0, output: 0 });
  check('输入价为 0 时未命中段不计费', near(onlyCache.inputCost, 0), onlyCache.inputCost);
  check('命中段仍按缓存价计费', near(onlyCache.cacheCost, 1), onlyCache.cacheCost);

  // 全部命中：未命中段为 0，输入费为 0
  const allHit = computeCost({ promptTokens: 1000, completionTokens: 100, cachedTokens: 1000 }, PRICES);
  check('全部命中 → 未命中段为 0', allHit.cacheMissTokens === 0 && near(allHit.inputCost, 0), JSON.stringify(allHit));
  check('全部命中 → 输出照常', allHit.outputTokens === 100, allHit.outputTokens);

  // 全部未命中：命中段为 0，缓存费为 0
  const allMiss = computeCost({ promptTokens: 1000, completionTokens: 100 }, PRICES);
  check('全部未命中 → 命中段为 0', allMiss.cacheHitTokens === 0 && near(allMiss.cacheCost, 0), JSON.stringify(allMiss));
}

// ---------------------------------------------------------------- 3) hasPricing
check('全 0 → 不计费', hasPricing({ cacheHit: 0, input: 0, output: 0 }) === false);
check('任一项 > 0 → 计费', hasPricing({ cacheHit: 0, input: 0, output: 0.01 }) === true);
check('缓存价单独 > 0 也算计费', hasPricing({ cacheHit: 0.05, input: 0, output: 0 }) === true);
check('负值不算计费', hasPricing({ cacheHit: -1, input: 0, output: 0 }) === false);

// ---------------------------------------------------------------- 3) 金额格式化
check('0 → 两位小数', formatMoney(0) === '¥0.00', formatMoney(0));
check('大额两位小数', formatMoney(1.234) === '¥1.23', formatMoney(1.234));
check('小额三位小数', formatMoney(0.5) === '¥0.500', formatMoney(0.5));
check('极小值四位小数', formatMoney(0.005) === '¥0.0050', formatMoney(0.005));
check('自定义货币符号', formatMoney(1.5, '$') === '$1.50', formatMoney(1.5, '$'));
check('负数按 0 显示', formatMoney(-3) === '¥0.00', formatMoney(-3));
check('NaN 按 0 显示', formatMoney(Number.NaN) === '¥0.00', formatMoney(Number.NaN));

// ---------------------------------------------------------------- 4) 缓存命中解析
check('OpenAI prompt_tokens_details', readCachedTokens({ prompt_tokens_details: { cached_tokens: 512 } }) === 512, '');
check('DeepSeek prompt_cache_hit_tokens', readCachedTokens({ prompt_cache_hit_tokens: 300 }) === 300, '');
check('Anthropic cache_read_input_tokens', readCachedTokens({ cache_read_input_tokens: 200 }) === 200, '');
check('通用 cached_tokens', readCachedTokens({ cached_tokens: 100 }) === 100, '');
check('细节字段优先', readCachedTokens({ prompt_tokens_details: { cached_tokens: 7 }, prompt_cache_hit_tokens: 999 }) === 7, '');
check('都没有 → null', readCachedTokens({ prompt_tokens: 100 }) === null, '');
check('空对象 → null', readCachedTokens({}) === null, '');
check('null usage → null', readCachedTokens(null) === null, '');
check('字符串数字也接受', readCachedTokens({ cached_tokens: '42' }) === 42, '');
check('负数归零', readCachedTokens({ cached_tokens: -5 }) === 0, '');

// ---------------------------------------------------------------- 5) 设置
{
  const d = defaultSettings();
  check('默认缓存价 0', d.priceCacheHit === 0, String(d.priceCacheHit));
  check('默认输入价 0', d.priceInput === 0, String(d.priceInput));
  check('默认输出价 0', d.priceOutput === 0, String(d.priceOutput));
  check('默认货币符号 ¥', d.priceCurrency === '¥', d.priceCurrency);

  const m = mergeSettings(d, { priceCacheHit: 0.15, priceInput: 2.5, priceOutput: 10, priceCurrency: '$' });
  check('可写入小数单价', m.priceCacheHit === 0.15 && m.priceInput === 2.5 && m.priceOutput === 10,
    JSON.stringify([m.priceCacheHit, m.priceInput, m.priceOutput]));
  check('可改货币符号', m.priceCurrency === '$', m.priceCurrency);

  const neg = mergeSettings(d, { priceInput: -8 });
  check('负单价被夹到 0', neg.priceInput === 0, String(neg.priceInput));

  const big = mergeSettings(d, { priceOutput: 999_999 });
  check('超上限被夹到 10000', big.priceOutput === 10_000, String(big.priceOutput));

  const bad = mergeSettings({ ...d, priceInput: 3 }, { priceInput: 'abc' });
  check('非法值保持原值', bad.priceInput === 3, String(bad.priceInput));

  const trimCur = mergeSettings(d, { priceCurrency: '  $  ' });
  check('货币符号去空白', trimCur.priceCurrency === '$', JSON.stringify(trimCur.priceCurrency));

  const emptyCur = mergeSettings({ ...d, priceCurrency: '$' }, { priceCurrency: '' });
  check('空货币符号回退 ¥', emptyCur.priceCurrency === '¥', JSON.stringify(emptyCur.priceCurrency));

  const longCur = mergeSettings(d, { priceCurrency: 'ABCDEFGHIJKL' });
  check('货币符号截断到 8 字', longCur.priceCurrency.length <= 8, String(longCur.priceCurrency.length));
}

// ---------------------------------------------------------------- 6) 类型与产物接线
{
  const types = fs.readFileSync(new URL('../dist/shared/types.js', import.meta.url), 'utf8');
  check('types 产物可读', types.length > 0, '');

  // 客户端产物：金额展示与设置分区必须真实存在
  const clientJs = fs.readFileSync(new URL('../dist/public/client/main.js', import.meta.url), 'utf8');
  check('客户端含 priceTable', (clientJs.match(/function priceTable/g) || []).length === 1, '');
  check('客户端含 fmtCost', (clientJs.match(/function fmtCost/g) || []).length === 1, '');
  check('回复卡片渲染 msg-cost', clientJs.includes('msg-cost'), '');
  check('状态栏含缓存与金额后缀', clientJs.includes('cacheSuffix') && clientJs.includes('costSuffix'), '');
  check('设置含价格统计分区', clientJs.includes("id: 'pricing'") && clientJs.includes('价格统计'), '');
  check('设置含四项价格字段',
    clientJs.includes('priceCacheHit') && clientJs.includes('priceInput') &&
    clientJs.includes('priceOutput') && clientJs.includes('priceCurrency'), '');
  check('设置页含费用明细行', clientJs.includes('本次会话累计'), '');

  // 服务端产物：缓存命中链路
  const agentJs = fs.readFileSync(new URL('../dist/server/agent.js', import.meta.url), 'utf8');
  check('agent 累计 cachedTokens', (agentJs.match(/cachedTokens/g) || []).length >= 8, '');
  check('agent 下发命中/未命中两段', agentJs.includes('cacheHitTokens') && agentJs.includes('cacheMissTokens'), '');
  check('agent 用 splitInputTokens 拆输入', agentJs.includes('splitInputTokens'), '');
  const sharedJs = fs.readFileSync(new URL('../dist/shared/pricing.js', import.meta.url), 'utf8');
  check('共享层导出 splitInputTokens', sharedJs.includes('export function splitInputTokens'), '');
  check('共享层分项字段齐全', sharedJs.includes('cacheHitTokens') && sharedJs.includes('cacheMissTokens') &&
    sharedJs.includes('inputTotalTokens'), '');
  const indexJs = fs.readFileSync(new URL('../dist/server/index.js', import.meta.url), 'utf8');
  check('/api/state 状态也带两段', indexJs.includes('cacheHitTokens') && indexJs.includes('cacheMissTokens'), '');
  check('agent 标记预估', agentJs.includes('cachedEstimated'), '');
  check('agent 用上一条请求输入量估算', agentJs.includes('lastPromptTokens'), '');
  const llmJs = fs.readFileSync(new URL('../dist/server/llm.js', import.meta.url), 'utf8');
  check('llm 导出缓存解析', llmJs.includes('readCachedTokens'), '');
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  check('样式含 msg-cost', css.includes('.msg-cost'), '');
}

// ---------------------------------------------------------------- 7) 一条完整链路的算术自洽
{
  // 三轮真实形状的用量：第一轮无缓存，之后前缀复用
  const turns = [
    { promptTokens: 20_000, completionTokens: 800, cachedTokens: 0 },
    { promptTokens: 21_000, completionTokens: 900, cachedTokens: 20_000 },
    { promptTokens: 22_000, completionTokens: 700, cachedTokens: 21_000 },
  ];
  const prices = { cacheHit: 0.3, input: 3, output: 15 }; // 元/百万 tokens
  const sum = turns.reduce((acc, u) => {
    const c = computeCost(u, prices);
    return {
      cached: acc.cached + c.cachedTokens,
      input: acc.input + c.inputTokens,
      output: acc.output + c.outputTokens,
      total: acc.total + c.total,
    };
  }, { cached: 0, input: 0, output: 0, total: 0 });
  check('三轮缓存累加', sum.cached === 41_000, sum.cached);
  check('三轮输入累加', sum.input === 22_000, sum.input);
  check('三轮输出累加', sum.output === 2400, sum.output);
  // 41_000×0.3 + 22_000×3 + 2400×15 每百万
  const expect = (41_000 * 0.3 + 22_000 * 3 + 2400 * 15) / 1_000_000;
  check('合计等于分项之和', near(sum.total, expect), sum.total + ' vs ' + expect);
  // 0.114 落在 [0.01, 1) 区间 → 3 位小数
  check('合计可被格式化', formatMoney(sum.total) === '¥0.114', formatMoney(sum.total));
}

console.log('\n' + (failed === 0 ? 'OK' : 'FAIL') + ': ' + (results.length - failed) + '/' + results.length + ' 项通过');
process.exit(failed === 0 ? 0 : 1);
