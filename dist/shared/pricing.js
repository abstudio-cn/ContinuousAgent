/**
 * 价格统计：把 token 用量换算成金额。前后端共用（客户端渲染、服务端自检脚本都用同一份）。
 *
 * 单价统一按「每百万 tokens」计（与主流厂商报价口径一致），金额 = tokens / 1e6 * 单价。
 * 三项都为 0 表示不计费，界面上不显示金额。
 */
const MILLION = 1_000_000;
function num(v) {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
/** 单价是否至少有一项大于 0（全 0 → 不计费，界面不显示金额）。 */
export function hasPricing(prices) {
    return num(prices.cacheHit) > 0 || num(prices.input) > 0 || num(prices.output) > 0;
}
/**
 * 把输入 tokens 拆成「缓存命中」与「未命中」两段。
 * 这是唯一的口径来源：展示（界面上的「命中 / 未命中」）与计价都走它，
 * 保证「输入总量 = 命中 + 未命中」恒成立，且命中数永远不超过输入总量。
 */
export function splitInputTokens(usage) {
    if (!usage)
        return { totalTokens: 0, hitTokens: 0, missTokens: 0 };
    const totalTokens = num(usage.promptTokens);
    const hitTokens = Math.min(totalTokens, num(usage.cachedTokens));
    return { totalTokens, hitTokens, missTokens: Math.max(0, totalTokens - hitTokens) };
}
/**
 * 计算一条用量记录的费用。
 * 输入先按 splitInputTokens 拆成两段：命中部分按缓存价，未命中部分按输入价；输出单独计价。
 */
export function computeCost(usage, prices) {
    const split = splitInputTokens(usage);
    const completionTokens = num(usage.completionTokens);
    const cacheCost = (split.hitTokens / MILLION) * num(prices.cacheHit);
    const inputCost = (split.missTokens / MILLION) * num(prices.input);
    const outputCost = (completionTokens / MILLION) * num(prices.output);
    return {
        cachedTokens: split.hitTokens,
        inputTokens: split.missTokens,
        cacheHitTokens: split.hitTokens,
        cacheMissTokens: split.missTokens,
        inputTotalTokens: split.totalTokens,
        outputTokens: completionTokens,
        cacheCost,
        inputCost,
        outputCost,
        total: cacheCost + inputCost + outputCost,
    };
}
/** 金额格式化：自适应小数位，小钱不显示成 0.00。 */
export function formatMoney(value, currency = '¥') {
    const v = Number.isFinite(value) ? Math.max(0, value) : 0;
    const digits = v === 0 ? 2 : v < 0.01 ? 4 : v < 1 ? 3 : 2;
    return currency + v.toFixed(digits);
}
//# sourceMappingURL=pricing.js.map