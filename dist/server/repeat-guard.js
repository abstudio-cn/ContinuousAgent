/**
 * 重复工具调用熔断。
 *
 * 模型「原地打转」时的典型表现：同一个工具、用完全相同的参数反复调用（例如一直
 * 用同样的参数截图、反复读同一个文件），既不产生新信息也不推进任务。
 * 这里用滑动窗口统计：同一「工具名 + 规范化参数」在最近 REPEAT_WINDOW 次调用里
 * 出现次数达到 REPEAT_LIMIT，下一次（第 REPEAT_LIMIT+1 次）就判为死循环并熔断。
 *
 * 之所以用滑窗而不是「整轮累计」：持续托管模式下一次 start() 可能跑几百轮，
 * list_windows、get_window_info 这类无参工具被反复正常使用会误伤；
 * 只看最近 30 次调用既不会误伤长会话，又能抓住真正的死循环。
 */
/** 滑动窗口长度：只看最近这么多次工具调用。 */
export const REPEAT_WINDOW = 30;
/** 同一调用在窗口内允许出现的最大次数；再出现一次（第 11 次）即熔断。 */
export const REPEAT_LIMIT = 10;
function sortValue(value) {
    if (Array.isArray(value))
        return value.map(sortValue);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = sortValue(value[key]);
        }
        return out;
    }
    return value;
}
/**
 * 参数规范化：JSON 解析后按键名递归排序再序列化，抹平空白/键序差异，
 * 让 `{"a":1,"b":2}` 与 `'{ "b": 2, "a": 1 }'` 落到同一个指纹上。
 * 参数不是合法 JSON（模型偶尔给出残片或纯文本）时，退回「压缩空白后的原文」。
 */
export function normalizeToolArgs(raw) {
    const text = (raw ?? '').trim();
    if (text === '' || text === '{}')
        return '{}';
    try {
        return JSON.stringify(sortValue(JSON.parse(text)));
    }
    catch {
        return text.replace(/\s+/g, ' ');
    }
}
/** 调用指纹：工具名 + 规范化参数，用作滑窗里的比较键。 */
export function toolCallKey(name, rawArgs) {
    return (name || '').trim() + ' ' + normalizeToolArgs(rawArgs);
}
/** 滑动窗口计数器：每次执行工具前调一次 observe()。 */
export class RepeatGuard {
    limit;
    window;
    recent = [];
    constructor(limit = REPEAT_LIMIT, window = REPEAT_WINDOW) {
        this.limit = limit;
        this.window = window;
    }
    /** 清空历史（新一轮 start() 开始时调用）。 */
    reset() {
        this.recent.length = 0;
    }
    /** 当前窗口内的调用指纹（从旧到新），便于排查与测试。 */
    get history() {
        return [...this.recent];
    }
    /**
     * 记录一次即将执行的调用。
     * 未超限时把指纹压入窗口并返回 blocked=false；超限时不入窗（该调用会被中断）。
     */
    observe(name, rawArgs) {
        const key = toolCallKey(name, rawArgs);
        const count = this.recent.reduce((n, item) => (item === key ? n + 1 : n), 0);
        if (count >= this.limit)
            return { key, count, blocked: true };
        this.recent.push(key);
        if (this.recent.length > this.window)
            this.recent.splice(0, this.recent.length - this.window);
        return { key, count, blocked: false };
    }
}
//# sourceMappingURL=repeat-guard.js.map