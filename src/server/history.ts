import type { ChatMessage, ToolCall } from '../shared/types.js';

/**
 * 历史消息序列修复工具。
 *
 * OpenAI 兼容接口（含 DeepSeek、各类网关）要求：
 * 1. 每条 role='tool' 的消息，必须紧跟在一条带 tool_calls 的 assistant 消息之后，
 *    且 tool_call_id 必须能在该 assistant 的 tool_calls 里找到；
 * 2. assistant.tool_calls 里的每个 id 都必须有对应的 tool 结果消息。
 *
 * 违反任一条会直接返回 HTTP 400：
 * "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"。
 *
 * 历史被裁剪（按条数截断）、请求中断（工具没执行完）、持久化文件兼容旧格式时，
 * 都可能破坏上面的配对关系，所以请求前与落盘前都过一遍这里的清理。
 */

export interface HistoryRepair {
  messages: ChatMessage[];
  /** 丢弃的孤儿 tool 消息（前面没有配套的 assistant tool_calls） */
  droppedToolMessages: number;
  /** 为缺失的工具结果补的占位消息 */
  synthesizedToolResults: number;
  /** 重排/补全的工具调用 id 数量 */
  remappedToolCallIds: number;
}

let syntheticSeq = 0;

function syntheticToolCallId(): string {
  syntheticSeq++;
  return 'call_recovered_' + syntheticSeq.toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 缺失工具结果时补的占位内容：明确告诉模型“这次调用没有结果”，避免它误读。 */
const MISSING_TOOL_RESULT = '[工具结果缺失：该调用被中断或旧历史被裁剪，请按需重新调用]';

/**
 * 把任意历史整理成合法序列：
 * - 丢弃没有配对 assistant 的 tool 消息；
 * - 给空/重复的 tool_call id 重新编号；
 * - 给缺失结果的 tool_call 补占位结果；
 * - 孤立（id 对不上）但组内只剩一个待匹配时按顺序认领，尽量不丢内容。
 */
export function sanitizeHistory(messages: ChatMessage[]): HistoryRepair {
  const out: ChatMessage[] = [];
  let droppedToolMessages = 0;
  let synthesizedToolResults = 0;
  let remappedToolCallIds = 0;
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === 'tool') {
      // 前面没有 assistant tool_calls：这条结果是孤儿
      droppedToolMessages++;
      i++;
      continue;
    }

    if (msg.role !== 'assistant' || !msg.toolCalls || msg.toolCalls.length === 0) {
      out.push(msg);
      i++;
      continue;
    }

    const seen = new Set<string>();
    const calls: ToolCall[] = msg.toolCalls.map((tc) => {
      let id = typeof tc.id === 'string' ? tc.id.trim() : '';
      if (!id || seen.has(id)) {
        id = syntheticToolCallId();
        remappedToolCallIds++;
      }
      seen.add(id);
      return {
        id,
        name: typeof tc.name === 'string' ? tc.name : '',
        arguments: typeof tc.arguments === 'string' ? tc.arguments : '{}',
      };
    });

    out.push({ ...msg, toolCalls: calls });
    i++;

    const remaining = new Set(calls.map((c) => c.id));
    // 紧跟在 assistant 后面的 tool 消息才是这次调用的结果
    while (i < messages.length && messages[i]!.role === 'tool') {
      const toolMsg = messages[i]!;
      let id = typeof toolMsg.toolCallId === 'string' ? toolMsg.toolCallId.trim() : '';
      if (!id) {
        // 旧数据可能没有 tool_call_id：只剩一个未匹配时按顺序认领
        if (remaining.size === 1) id = [...remaining][0]!;
        else { droppedToolMessages++; i++; continue; }
      }
      if (!remaining.has(id)) {
        droppedToolMessages++;
        i++;
        continue;
      }
      remaining.delete(id);
      out.push({ ...toolMsg, toolCallId: id });
      i++;
    }

    for (const call of calls) {
      if (!remaining.has(call.id)) continue;
      remaining.delete(call.id);
      out.push({ role: 'tool', toolCallId: call.id, content: MISSING_TOOL_RESULT, images: null });
      synthesizedToolResults++;
    }
  }

  return { messages: out, droppedToolMessages, synthesizedToolResults, remappedToolCallIds };
}

export interface TrimResult {
  messages: ChatMessage[];
  removed: number;
}

/** 首轮最多固定保留多少条（防止首轮异常庞大时既钉住又吃掉整个预算）。 */
const MAX_PINNED_MESSAGES = 40;

/**
 * 首轮保留块超限时按「完整消息组」收缩：组 = 一条 user/普通 assistant，
 * 或「带 tool_calls 的 assistant + 它的全部 tool 结果」。
 * 不能简单从尾部逐条剔除——那会把「assistant+tool 交替」的长块一路削到只剩首条，
 * 白白浪费预算；按组累加则能保住尽量多的完整回合，且截断点永远合法。
 */
function capPinned(list: ChatMessage[], cap: number): ChatMessage[] {
  let end = 0;
  let i = 0;
  while (i < list.length) {
    const start = i;
    const m = list[i]!;
    i++;
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // 吞掉这组的全部工具结果，保证不把 tool_calls 与结果拆开
      while (i < list.length && list[i]!.role === 'tool') i++;
    }
    if (i > cap && start > 0) break; // 这一组会超限：停在上一个完整边界
    end = i;
  }
  return list.slice(0, end);
}

/**
 * 按条数裁剪历史：保留首条用户需求 + 本次任务首轮（pinned）+ 最近 max 条，
 * 裁剪点必须落在一个完整消息组的起点（优先 user 边界），不能把
 * assistant.tool_calls 与它的 tool 结果拆散；最后再过一遍 sanitizeHistory 兜底。
 */
export function trimHistoryMessages(messages: ChatMessage[], max: number): TrimResult {
  const cleaned = sanitizeHistory(messages).messages;
  const limit = Math.min(400, Math.max(2, Math.trunc(Number.isFinite(max) ? max : 24)));
  if (cleaned.length <= limit) return { messages: cleaned, removed: 0 };

  // 任务首轮保留：这些消息（本次任务的第一轮对话）不参与「最近 N 条」的淘汰，
  // 否则长任务跑到几十轮后，最初的用户需求会被裁掉，模型只能靠工作记录猜任务是什么。
  const pinnedAll = cleaned.filter((m) => m.pinned === true);
  const pinned = pinnedAll.length > MAX_PINNED_MESSAGES
    ? capPinned(pinnedAll, MAX_PINNED_MESSAGES)
    : pinnedAll;
  const pinnedSet = new Set(pinned);

  // 首轮块是「额外保留」，不占「最近 N 条」的预算：用户设置 historyMaxMessages
  // 的语义必须稳定为「最近 N 条照常保留」，不能因为钉住首轮而让最近窗口缩水。
  // 膨胀上限由 MAX_PINNED_MESSAGES 与 llm.ts 的 token 预算兜住。
  const target = cleaned.length - limit;
  let cut = -1;

  // 1) 优先切在 user 边界：语义最完整（整个回合一起保留/丢弃）
  for (let i = Math.max(1, target); i < cleaned.length; i++) {
    if (cleaned[i]!.role === 'user') {
      cut = i;
      break;
    }
  }
  // 2) 没有 user：退到任意非 tool 消息（assistant 组起点或普通 assistant）
  if (cut < 0) {
    for (let i = Math.max(1, target); i < cleaned.length; i++) {
      if (cleaned[i]!.role !== 'tool') {
        cut = i;
        break;
      }
    }
  }
  // 3) 窗口内全是工具结果：向前回退到这个工具组的 assistant 起点
  if (cut < 0) {
    for (let i = Math.max(1, target) - 1; i >= 1; i--) {
      const m = cleaned[i]!;
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        cut = i;
        break;
      }
      if (m.role !== 'tool') break;
    }
  }
  if (cut <= 1) return { messages: cleaned, removed: 0 };

  // 拼装：首轮保留块 + 最近窗口；被裁掉的中间段跳过。
  // 有 pinned 时不再单独保留 cleaned[0]：首轮块已经承载了「本次任务的需求」，
  // 而 cleaned[0] 往往是上一个任务的首条消息，钉住它只是白占预算。
  // 窗口内若还有 pinned（首轮恰好落在窗口内），从窗口里剔除，避免同一消息出现两次。
  const window = cleaned.slice(cut).filter((m) => !pinnedSet.has(m));
  const next: ChatMessage[] = pinned.length > 0 ? [] : [cleaned[0]!];
  const seen = new Set<ChatMessage>(next);
  for (const m of pinned) {
    if (seen.has(m)) continue;
    seen.add(m);
    next.push(m);
  }
  for (const m of window) {
    if (seen.has(m)) continue;
    seen.add(m);
    next.push(m);
  }
  const removed = cleaned.length - next.length;
  if (removed <= 0) return { messages: cleaned, removed: 0 };
  return { messages: sanitizeHistory(next).messages, removed };
}
