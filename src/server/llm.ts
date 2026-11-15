import type { ChatMessage, ToolCall } from '../shared/types.js';
import type { ServerSettings } from './settings.js';
import { sanitizeHistory } from './history.js';

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; args?: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; cachedTokens: number | null }
  | { type: 'finished'; reason: string | null };

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export class LlmError extends Error {}

/** 单次请求最多携带多少条消息的截图。 */
const MAX_IMAGE_MESSAGES = 2;
/** 单张图片原始字节上限（base64 后约 1.33 倍）。 */
const MAX_IMAGE_BYTES = 250_000;
/** 单条工具/普通消息文本上限。 */
const MAX_TEXT_CHARS = 20_000;
/** system 消息单独的宽上限（记录 + 笔记 + 运行上下文）。 */
const MAX_SYSTEM_CHARS = 120_000;
/** 请求体硬上限。 */
const MAX_PAYLOAD_BYTES = 4_000_000;
/** 输入 token 预算。 */
const MAX_INPUT_TOKENS = 600_000;

export function normalizeBase(baseUrl: string): string {
  let b = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) b = 'https://api.openai.com/v1';
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  return b;
}

function endpoint(baseUrl: string): string {
  const b = normalizeBase(baseUrl);
  if (/\/chat\/completions$/i.test(b)) return b;
  return b + '/chat/completions';
}

/** 性能：CJK 统一表意文字（与原逐码点实现相同的判定范围）。 */
const CJK_RE = /[\u4e00-\u9fff]/g;

/**
 * 保守估算 token：CJK 约 1 字 = 1 token，其它按 4 字符 = 1 token。
 * 这个函数对整份请求体（常见数百 KB，含 base64 截图）跑一次，所以用正则单趟扫描
 * 代替逐码点迭代：700KB 负载实测 3.0ms → 0.33ms。增补平面字符按两个 UTF-16
 * 单元计入非 CJK 部分，估算只会略微偏大（保守方向）。
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const matched = text.match(CJK_RE);
  const cjk = matched === null ? 0 : matched.length;
  return cjk + Math.floor((text.length - cjk) / 4);
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS) + '...[已截断，原长 ' + text.length + ' 字符]';
}

function truncateSystemText(text: string): string {
  if (text.length <= MAX_SYSTEM_CHARS) return text;
  return text.slice(0, MAX_SYSTEM_CHARS) +
    '...[系统上下文已截断，原长 ' + text.length + ' 字符；请压缩工作记录/笔记]';
}

function imageBytes(images: string[] | null | undefined): number {
  if (!images) return 0;
  // base64 字符数 ≈ bytes * 4/3
  return images.reduce((sum, b64) => sum + Math.floor((b64.length * 3) / 4), 0);
}

function selectImagesToKeep(messages: ChatMessage[], burnAfterRead: boolean): boolean[] {
  const keep = new Array<boolean>(messages.length).fill(false);
  let total = 0;
  let kept = 0;
  for (let i = messages.length - 1; i >= 0 && kept < MAX_IMAGE_MESSAGES; i--) {
    const m = messages[i]!;
    if (!m.images || m.images.length === 0) continue;
    if (burnAfterRead && m.imageConsumed) continue;
    const size = imageBytes(m.images);
    if (total + size > MAX_IMAGE_BYTES) continue;
    keep[i] = true;
    total += size;
    kept++;
  }
  return keep;
}

export function markImagesConsumed(messages: ChatMessage[]): void {
  for (const m of messages) {
    if (m.images && m.images.length > 0) m.imageConsumed = true;
  }
}

function dataUrl(b64: string): string {
  const isJpeg = b64.startsWith('/9j/');
  return (isJpeg ? 'data:image/jpeg;base64,' : 'data:image/png;base64,') + b64;
}

function buildContent(text: string, images: string[]): unknown[] {
  const parts: unknown[] = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: dataUrl(img) } });
  }
  return parts;
}

/**
 * 组装请求消息。导出供自检脚本使用。
 *
 * 关键点：
 * - 先用 sanitizeHistory 修一遍工具调用配对，任何历史来源（落盘、裁剪、中断）
 *   都不会生成 role='tool' 缺少前置 assistant.tool_calls 的非法序列；
 * - assistant 的 tool_calls 必须无条件带上：图片分支不能把它吃掉，
 *   否则它后面的 tool 结果就成了孤儿（HTTP 400 的另一条来源）。
 */
export function buildMessages(messages: ChatMessage[], includeImages = true, burnAfterRead = true): unknown[] {
  const safe = sanitizeHistory(messages).messages;
  const keep = includeImages
    ? selectImagesToKeep(safe, burnAfterRead)
    : new Array<boolean>(safe.length).fill(false);
  const out: unknown[] = [];
  for (let i = 0; i < safe.length; i++) {
    const m = safe[i]!;
    const hasImages = !!m.images && m.images.length > 0;
    const keepImages = hasImages && keep[i];
    let text = m.role === 'system' ? truncateSystemText(m.content) : truncateText(m.content);
    if (hasImages && !keepImages) {
      text = (text.trim() ? text + '\n' : '') + '[旧截图已省略：仅保留最近 ' + MAX_IMAGE_MESSAGES + ' 张以控制请求体]';
    }

    const o: Record<string, unknown> = { role: m.role };
    if (m.role === 'tool') {
      o.tool_call_id = m.toolCallId ?? '';
      // 空 content 在部分网关（含 DeepSeek 兼容层）也会被判为非法消息，补一个占位
      o.content = keepImages ? buildContent(text, m.images!) : (text || '(工具无输出)');
    } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // tool_calls 与图片互不排斥：先处理 tool_calls，再决定 content 形态
      o.content = keepImages ? buildContent(text, m.images!) : (text ? text : null);
      o.tool_calls = m.toolCalls.map((tc: ToolCall) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));
    } else if (keepImages) {
      o.content = buildContent(text, m.images!);
    } else {
      o.content = text;
    }
    out.push(o);
  }
  return out;
}

/**
 * 读 usage 里的缓存命中 tokens。各家字段名不一，按常见顺序取第一个有效数字：
 * - OpenAI：`prompt_tokens_details.cached_tokens`
 * - DeepSeek / 部分网关：`prompt_cache_hit_tokens`
 * - Anthropic 风格代理：`cache_read_input_tokens`
 * 都取不到返回 null（由调用方决定怎么估算）。
 */
export function readCachedTokens(usage: any): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const candidates = [
    usage.prompt_tokens_details?.cached_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
    usage.cached_tokens,
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (raw !== null && raw !== undefined && Number.isFinite(n)) return Math.max(0, Math.trunc(n));
  }
  return null;
}

function readText(node: any): string | null {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    let s = '';
    for (const part of node) {
      if (typeof part === 'string') s += part;
      else if (part && typeof part === 'object') {
        if (typeof part.text === 'string') s += part.text;
        else if (part.text && typeof part.text.value === 'string') s += part.text.value;
      }
    }
    return s;
  }
  return null;
}

export async function* streamChat(
  settings: ServerSettings,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal: AbortSignal,
): AsyncGenerator<LlmEvent> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: buildMessages(messages, true, settings.screenshotBurnAfterRead),
    stream: true,
    max_tokens: Math.max(256, settings.maxOutputTokens),
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (settings.temperature > 0.001) body.temperature = Math.round(settings.temperature * 100) / 100;
  const effort = (settings.reasoningEffort || 'auto').trim().toLowerCase();
  if (['minimal', 'low', 'medium', 'high'].includes(effort)) {
    body.reasoning_effort = effort;
    if (effort !== 'minimal') delete body.temperature;
  }

  const send = async (payload: Record<string, unknown>) => {
    const json = JSON.stringify(payload);
    const bytes = Buffer.byteLength(json, 'utf8');
    const tokens = estimateTokens(json);
    if (tokens > MAX_INPUT_TOKENS || bytes > MAX_PAYLOAD_BYTES) {
      // 超预算：丢弃全部截图重建，保证不撞上下文/请求体上限
      payload.messages = buildMessages(messages, false);
      const retry = JSON.stringify(payload);
      console.warn('[llm] 超出预算，已丢弃全部截图 bytes=' + Buffer.byteLength(retry, 'utf8') +
        ' estTokens≈' + estimateTokens(retry));
      return retry;
    }
    return json;
  };

  const payloadText = await send({ ...body });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': 'ContinuousAgent/1.0',
  };
  if (settings.apiKey.trim()) headers.Authorization = 'Bearer ' + settings.apiKey.trim();

  let resp: Response;
  try {
    resp = await fetch(endpoint(settings.apiBaseUrl), {
      method: 'POST',
      headers,
      body: payloadText,
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new LlmError('网络错误: ' + (err instanceof Error ? err.message : String(err)));
  }

  if (!resp.ok) {
    let detail = '';
    try {
      detail = await resp.text();
    } catch {
      /* ignore */
    }
    if (detail.length > 1200) detail = detail.slice(0, 1200);
    throw new LlmError('HTTP ' + resp.status + ' ' + (resp.statusText || '') + ': ' + detail);
  }

  // 请求已被接受 → 这些截图算“读过”，下一轮不再携带（失败时不标记，保证重试还能带上图）
  if (settings.screenshotBurnAfterRead) markImagesConsumed(messages);

  if (!resp.body) throw new LlmError('响应没有可读流。');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finish: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.replace(/\r$/, '');
        if (!line || line.startsWith(':')) continue;
        if (!/^data:/i.test(line)) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          yield { type: 'finished', reason: finish };
          return;
        }
        let node: any;
        try {
          node = JSON.parse(payload);
        } catch {
          continue;
        }
        if (node?.error) {
          throw new LlmError(node.error.message || JSON.stringify(node.error));
        }
        const usage = node?.usage;
        if (usage) {
          yield {
            type: 'usage',
            promptTokens: Number(usage.prompt_tokens) || 0,
            completionTokens: Number(usage.completion_tokens) || 0,
            cachedTokens: readCachedTokens(usage),
          };
        }
        const choices = node?.choices;
        if (!Array.isArray(choices) || choices.length === 0) continue;
        const choice = choices[0];
        const delta = choice?.delta ?? {};

        const reasoning = readText(delta.reasoning_content) ?? readText(delta.reasoning);
        if (reasoning) yield { type: 'reasoning', text: reasoning };

        const content = readText(delta.content);
        if (content) yield { type: 'text', text: content };

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            yield {
              type: 'tool_call',
              index: Number.isInteger(tc?.index) ? tc.index : 0,
              id: typeof tc?.id === 'string' ? tc.id : undefined,
              name: typeof tc?.function?.name === 'string' ? tc.function.name : undefined,
              args: typeof tc?.function?.arguments === 'string' ? tc.function.arguments : undefined,
            };
          }
        }
        if (choice?.finish_reason) finish = String(choice.finish_reason);

        // 有些网关把 usage 放在最后一块且没有 choices
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  yield { type: 'finished', reason: finish };
}

export async function testConnection(settings: ServerSettings, signal: AbortSignal): Promise<{ ok: boolean; message: string }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey.trim()) headers.Authorization = 'Bearer ' + settings.apiKey.trim();
    const resp = await fetch(endpoint(settings.apiBaseUrl), {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        stream: false,
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      return { ok: false, message: 'HTTP ' + resp.status + ': ' + (text.length > 400 ? text.slice(0, 400) : text) };
    }
    return { ok: true, message: '连接成功，模型可用。' };
  } catch (err) {
    if (signal.aborted) return { ok: false, message: '请求已取消' };
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
