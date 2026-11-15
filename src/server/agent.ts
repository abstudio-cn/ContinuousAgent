import type { Attachment, ChatItem, ChatItemKind, ChatMessage, TargetWindow } from '../shared/types.js';
import type { ServerEvent } from '../shared/types.js';
import type { ServerSettings } from './settings.js';
import { DONE_TOKEN, STATIC_SYSTEM_PROMPT } from '../shared/prompt.js';
import { streamChat } from './llm.js';
import type { ToolExecutor } from './tools.js';
import { putImage } from './imagestore.js';
import { trimHistoryMessages } from './history.js';
import { RepeatGuard, REPEAT_LIMIT, REPEAT_WINDOW } from './repeat-guard.js';
import { splitInputTokens } from '../shared/pricing.js';
import { timeLabel } from './paths.js';

let itemSeq = 0;
function nextId(): string {
  return 'i' + (++itemSeq).toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 流式增量事件的合并窗口（毫秒）：窗口内的多个 token 合并成一次 item_update。 */
const STREAM_PATCH_INTERVAL_MS = 60;

/** 服务端时间线：浏览器刷新/重连后可完整重放。 */
export class Timeline {
  items: ChatItem[] = [];

  add(kind: ChatItemKind, text: string, extra: Partial<ChatItem> = {}): ChatItem {
    const item: ChatItem = { id: nextId(), kind, text, time: timeLabel(), ...extra };
    this.items.push(item);
    if (this.items.length > 400) this.items.splice(0, this.items.length - 400);
    return item;
  }

  update(id: string, patch: Partial<ChatItem>): ChatItem | null {
    const item = this.items.find((i) => i.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    return item;
  }

  clear(): void {
    this.items = [];
  }
}

export interface AgentSnapshot {
  timeline: ChatItem[];
  history: ChatMessage[];
  turn: number;
  promptTokens: number;
  completionTokens: number;
  /** 累计命中缓存的输入 tokens（服务端未上报时按前缀复用估算） */
  cachedTokens: number;
}

export interface AgentDeps {
  sessionId: string;
  getSettings: () => ServerSettings;
  tools: ToolExecutor;
  emit: (event: ServerEvent) => void;
  /** 会话持久化：时间线、历史、用量。由外层做防抖写入。 */
  onPersist: (snapshot: AgentSnapshot) => void;
}

/** 单个会话的 agent 主循环：流式对话 → 工具调用 → 工作记录更新 → 自动续跑。 */
export class AgentRunner {
  readonly timeline = new Timeline();
  private history: ChatMessage[] = [];
  private controller: AbortController | null = null;
  private turn = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private cachedTokens = 0;
  /** 上一条请求的输入 tokens：用于在服务端未上报缓存命中时估算前缀复用 */
  private lastPromptTokens = 0;
  private running = false;
  private status = '空闲';
  private recordUpdatedInCycle = false;
  private runSeq = 0;
  /** 待合并的流式 patch（按 item id 合并，保留最新的完整文本）。 */
  private pendingPatches = new Map<string, Partial<ChatItem>>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: AgentDeps,
    initial?: Partial<AgentSnapshot>,
  ) {
    this.timeline.items = initial?.timeline ? [...initial.timeline] : [];
    this.history = initial?.history ? [...initial.history] : [];
    this.turn = initial?.turn ?? 0;
    this.promptTokens = initial?.promptTokens ?? 0;
    this.completionTokens = initial?.completionTokens ?? 0;
    this.cachedTokens = initial?.cachedTokens ?? 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get hasSession(): boolean {
    return this.history.length > 0;
  }

  get usage(): { promptTokens: number; completionTokens: number; cachedTokens: number } {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      cachedTokens: this.cachedTokens,
    };
  }

  get currentTurn(): number {
    return this.turn;
  }

  get currentStatus(): string {
    return this.status;
  }

  snapshot(): AgentSnapshot {
    return {
      timeline: this.timeline.items,
      history: this.history,
      turn: this.turn,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      cachedTokens: this.cachedTokens,
    };
  }

  private persist(): void {
    try {
      this.deps.onPersist(this.snapshot());
    } catch {
      /* 持久化失败不影响运行 */
    }
  }

  private setState(running: boolean, status: string): void {
    this.running = running;
    this.status = status;
    // 输入拆成「缓存命中 / 未命中」两段下发：界面与价格都按这两段分别展示与计价
    const input = splitInputTokens({ promptTokens: this.promptTokens, cachedTokens: this.cachedTokens });
    this.deps.emit({
      type: 'state',
      sessionId: this.deps.sessionId,
      status: {
        running,
        status,
        turn: this.turn,
        promptTokens: this.promptTokens,
        completionTokens: this.completionTokens,
        cachedTokens: this.cachedTokens,
        cacheHitTokens: input.hitTokens,
        cacheMissTokens: input.missTokens,
        hasSession: this.hasSession,
      },
    });
  }

  private pushItem(kind: ChatItemKind, text: string, extra: Partial<ChatItem> = {}): ChatItem {
    const item = this.timeline.add(kind, text, extra);
    this.deps.emit({ type: 'item_add', sessionId: this.deps.sessionId, item });
    return item;
  }

  private patchItem(id: string, patch: Partial<ChatItem>, coalesce = false): void {
    this.timeline.update(id, patch);
    if (coalesce) {
      const cur = this.pendingPatches.get(id);
      this.pendingPatches.set(id, cur ? { ...cur, ...patch } : { ...patch });
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          this.flushPatches();
        }, STREAM_PATCH_INTERVAL_MS);
        this.flushTimer.unref?.();
      }
      return;
    }
    // 非合并 patch 必须排在积压的增量后面，否则客户端会先看到旧文本再回退
    this.flushPatches();
    this.deps.emit({ type: 'item_update', sessionId: this.deps.sessionId, id, patch });
  }

  /** 立即把积压的流式 patch 发出去（每轮结束、重置、中断时调用）。 */
  private flushPatches(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingPatches.size === 0) return;
    const batch = [...this.pendingPatches];
    this.pendingPatches.clear();
    for (const [id, patch] of batch) {
      this.deps.emit({ type: 'item_update', sessionId: this.deps.sessionId, id, patch });
    }
  }

  reset(): void {
    this.runSeq++;
    this.stop();
    this.pendingPatches.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.history = [];
    this.turn = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.cachedTokens = 0;
    this.lastPromptTokens = 0;
    this.timeline.clear();
    this.deps.emit({ type: 'clear', sessionId: this.deps.sessionId });
    this.setState(false, '空闲');
    this.persist();
  }

  stop(): void {
    try {
      this.controller?.abort();
    } catch {
      /* ignore */
    }
  }

  async start(
    userPrompt: string,
    binding: { title: string; recordPath: string; notesPath: string },
    attachments: Attachment[] = [],
  ): Promise<void> {
    if (this.running) return;
    const settings = this.deps.getSettings();
    const tools = this.deps.tools;
    tools.updateSettings(settings);
    tools.bindSession({
      id: this.deps.sessionId,
      title: binding.title,
      recordPath: binding.recordPath,
      notesPath: binding.notesPath,
    });

    const myRun = ++this.runSeq;
    this.controller = new AbortController();
    const signal = this.controller.signal;

    // 附件：图片进 history 的 images（模型可看），文本拼进 user 消息；时间线只留元信息避免臃肿。
    const imageAttachments = attachments.filter((a) => a.kind === 'image' && !!a.dataUrl);
    const textAttachments = attachments.filter((a) => a.kind === 'text' && !!a.text);
    const imageB64 = imageAttachments
      .map((a) => String(a.dataUrl).replace(/^data:[^;]+;base64,/, ''))
      .filter((b64) => b64.length > 0);
    const textBlocks = textAttachments.map((a) =>
      '\n\n===== 附件: ' + a.name + ' =====\n' + (a.text || '').slice(0, 60_000));
    const userContent = textBlocks.length > 0 ? userPrompt + textBlocks.join('') : userPrompt;

    // 非连续模式下历史也会一直增长：新一轮开始前按同一套规则裁剪（裁剪点不拆工具组）
    this.trimHistory(settings);

    this.history.push({
      role: 'user',
      content: userContent,
      images: imageB64.length > 0 ? imageB64 : null,
    });

    const attachmentMeta: Attachment[] = attachments.map((a) => ({
      name: a.name,
      mime: a.mime,
      size: a.size,
      kind: a.kind,
      ...(a.kind === 'image' && a.dataUrl
        ? { imageId: putImage(String(a.dataUrl).replace(/^data:[^;]+;base64,/, '')) }
        : {}),
    }));
    this.pushItem('user', userPrompt, {
      attachments: attachmentMeta.length > 0 ? attachmentMeta : null,
      imageUrl: attachmentMeta.find((a) => a.imageId)?.imageId
        ? '/api/images/' + attachmentMeta.find((a) => a.imageId)!.imageId
        : null,
    });
    this.setState(true, '运行中');
    this.persist();

    let nudges = 0;
    let consecutiveErrors = 0;
    this.recordUpdatedInCycle = false;
    // 重复工具调用熔断：同一调用在最近 REPEAT_WINDOW 次里出现 REPEAT_LIMIT 次后，再一次就中断本轮
    const repeatGuard = new RepeatGuard();

    try {
      while (!signal.aborted) {
        if (myRun !== this.runSeq) break;
        if (settings.maxTurns > 0 && this.turn >= settings.maxTurns) {
          this.pushItem('system', '已达到最大轮数，停止。');
          this.setState(false, '已达到最大轮数');
          break;
        }

        this.turn++;
        this.setState(true, '运行中 · 第 ' + this.turn + ' 轮');

        let assistantText = '';
        let reasoningText = '';
        const calls = new Map<number, { id: string; name: string; arguments: string }>();
        let turnHadError = false;

        const textItem = this.pushItem('assistant', '', { streaming: true });
        const usageBefore = {
          promptTokens: this.promptTokens,
          completionTokens: this.completionTokens,
          cachedTokens: this.cachedTokens,
        };
        let thinkingItem: ChatItem | null = null;
        /** 本轮是否用过「预估」的缓存命中数（服务商未上报时） */
        let cachedEstimated = false;
        const request = this.buildRequestMessages(settings);

        try {
          for await (const ev of streamChat(settings, request, this.deps.tools.catalog(), signal)) {
            if (ev.type === 'text') {
              assistantText += ev.text;
              this.patchItem(textItem.id, { text: assistantText, streaming: true }, true);
            } else if (ev.type === 'reasoning') {
              reasoningText += ev.text;
              if (!thinkingItem) {
                thinkingItem = this.pushItem('thinking', '', { title: '思考', streaming: true, expanded: false });
              }
              this.patchItem(thinkingItem.id, { text: reasoningText, streaming: true }, true);
            } else if (ev.type === 'tool_call') {
              const cur = calls.get(ev.index) ?? { id: '', name: '', arguments: '' };
              if (ev.id) cur.id = ev.id;
              if (ev.name) cur.name += ev.name;
              if (ev.args) cur.arguments += ev.args;
              calls.set(ev.index, cur);
            } else if (ev.type === 'usage') {
              this.promptTokens += ev.promptTokens;
              this.completionTokens += ev.completionTokens;
              // 缓存命中：优先用服务商上报值；未上报时按「上一条请求的输入前缀被复用」保守估算
              const cached = ev.cachedTokens === null
                ? Math.min(this.lastPromptTokens, ev.promptTokens)
                : Math.min(ev.cachedTokens, ev.promptTokens);
              if (ev.cachedTokens === null && cached > 0) cachedEstimated = true;
              this.cachedTokens += cached;
              this.lastPromptTokens = ev.promptTokens;
              this.setState(true, this.status);
            }
          }
        } catch (e) {
          if (signal.aborted) throw e;
          turnHadError = true;
          consecutiveErrors++;
          const message = e instanceof Error ? e.message : String(e);
          this.pushItem('error', message);
          this.patchItem(textItem.id, { streaming: false });
          // 4xx（408/409/429 除外）是请求本身不合法（例如消息序列非法）：重试只会重复失败
          if (/^HTTP 4\d\d/.test(message) && !/^HTTP (408|409|429)\b/.test(message)) {
            this.setState(false, '请求被拒绝，已停止');
            break;
          }
          if (consecutiveErrors >= 5) {
            this.setState(false, '连续错误，已停止');
            break;
          }
          const wait = Math.min(30_000, 1500 * consecutiveErrors);
          this.setState(true, '连接异常，' + Math.round(wait / 1000) + 's 后重试…');
          await sleep(wait, signal);
          continue;
        }

        if (turnHadError) continue;
        consecutiveErrors = 0;

        const usedIds = new Set<string>();
        const list = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
          .filter((c) => c.name.trim() !== '')
          // 先补 id 再写进历史：否则 assistant.tool_calls 里留着空 id，
          // 与它后面 tool 消息的 id 对不上，服务端会判非法序列（HTTP 400）。
          .map((c) => {
            let id = (c.id || '').trim();
            if (!id || usedIds.has(id)) id = 'call_' + Math.random().toString(36).slice(2, 14);
            usedIds.add(id);
            return { id, name: c.name, arguments: c.arguments };
          });

        // 完成标记：只有“本轮没有任何工具调用”时才认，避免模型边干活边说完成
        const completion = list.length === 0 ? extractDoneToken(assistantText) : { text: assistantText, done: false };
        if (completion.done) assistantText = completion.text;

        this.patchItem(textItem.id, {
          streaming: false,
          ...(completion.done ? { text: assistantText } : {}),
          usage: {
            promptTokens: this.promptTokens - usageBefore.promptTokens,
            completionTokens: this.completionTokens - usageBefore.completionTokens,
            cachedTokens: this.cachedTokens - usageBefore.cachedTokens,
            cachedEstimated,
          },
        });
        if (thinkingItem) this.patchItem(thinkingItem.id, { streaming: false });

        if (list.length > 0) {
          this.history.push({
            role: 'assistant',
            content: assistantText,
            reasoning: reasoningText || null,
            toolCalls: list.map((c) => ({ ...c })),
          });

          // 每个 tool_call 必须有且只有一条结果消息。中断/异常退出时也要补齐占位结果，
          // 否则下一轮请求带上“没有结果的 assistant.tool_calls”，会被服务端判为非法序列。
          const answered = new Set<string>();
          /** 本轮是否因「重复调用」熔断（与用户中断区分开） */
          let repeatStop: { name: string; count: number } | null = null;
          try {
            for (const call of list) {
              if (signal.aborted) break;
              const repeated = repeatGuard.observe(call.name, call.arguments);
              if (repeated.blocked) {
                repeatStop = { name: call.name, count: repeated.count };
                break;
              }
              const argsPretty = prettyJson(call.arguments);
              const toolItem = this.pushItem('tool', argsPretty, {
                title: call.name,
                status: '运行中',
                expanded: false,
              });

              const started = Date.now();
              let result;
              try {
                result = await this.deps.tools.execute(call.name, call.arguments, signal);
              } catch (e) {
                if (signal.aborted) break;
                result = { text: '工具异常: ' + (e instanceof Error ? e.message : String(e)), isError: true } as any;
              }
              const elapsed = Date.now() - started;
              const imageB64 = result.images && result.images.length > 0 ? result.images[0]! : null;
              this.history.push({
                role: 'tool',
                toolCallId: call.id,
                content: result.text,
                images: result.images ?? null,
              });
              answered.add(call.id);
              this.patchItem(toolItem.id, {
                status: result.isError ? '失败' : '完成',
                detail: result.text,
                meta: elapsed + ' ms',
                imageUrl: imageB64 ? putImage(imageB64) : null,
              });

              if ((call.name === 'update_work_record' || call.name === 'update_game_record') && !result.isError) {
                this.recordUpdatedInCycle = true;
                this.deps.emit({ type: 'record', sessionId: this.deps.sessionId, markdown: this.deps.tools.record.read() });
              }
              if ((call.name === 'update_work_notes' || call.name === 'append_work_notes' ||
                call.name === 'update_game_notes' || call.name === 'append_game_notes') && !result.isError) {
                const md = this.deps.tools.notes.read();
                this.deps.emit({ type: 'notes', sessionId: this.deps.sessionId, markdown: md, length: md.length });
              }

              if (settings.clickDelayMs > 0) await sleep(settings.clickDelayMs, signal);
            }
          } finally {
            // 没跑到的调用补一条占位结果，保证 tool_calls 与结果一一对应
            for (const call of list) {
              if (answered.has(call.id)) continue;
              this.history.push({
                role: 'tool',
                toolCallId: call.id,
                content: '[工具调用已中断，未执行]',
                images: null,
              });
            }
          }
          if (signal.aborted) throw new Error('已中断');
          if (repeatStop) {
            this.pushItem('system', '检测到重复的工具调用：' + repeatStop.name +
              ' 在最近 ' + REPEAT_WINDOW + ' 次调用里已出现 ' + repeatStop.count +
              ' 次，超过 ' + REPEAT_LIMIT + ' 次上限，已立即中断本轮执行。');
            this.setState(false, '重复调用，已中断');
            this.persist();
            break;
          }
          this.emitTarget();
          this.persist();
          continue;
        }

        this.history.push({ role: 'assistant', content: assistantText, reasoning: reasoningText || null });

        if (completion.done) {
          // 任务彻底结束：清空改动前备份，避免临时备份长期堆积（失败不影响收尾）
          try {
            this.deps.tools.backups.clear(this.deps.sessionId);
          } catch {
            /* 清理失败不阻断结束流程 */
          }
          this.pushItem('system', '任务结束，已停止自动续跑。');
          this.setState(false, '已完成');
          this.persist();
          break;
        }

        // 强制更新工作记录：本轮没有调用 update_work_record 则提醒最多两次
        if (!this.recordUpdatedInCycle && nudges < 2) {
          nudges++;
          const nudge = '在继续之前，请先调用 update_work_record，用完整的 Markdown 整份覆盖工作记录（任务目标、当前进度、关键环境、已改动文件、待办、决策与风险），只保留当前最新状态。';
          this.history.push({ role: 'user', content: nudge });
          this.pushItem('system', '提醒模型更新工作记录（第 ' + nudges + ' 次）');
          this.setState(true, '等待更新工作记录');
          this.persist();
          continue;
        }
        nudges = 0;

        if (!settings.continuousMode) {
          this.setState(false, '本轮完成');
          this.persist();
          break;
        }

        this.setState(true, '等待 ' + Math.max(300, settings.continueDelayMs) + 'ms 后继续');
        await sleep(Math.max(300, settings.continueDelayMs), signal);
        const continuation = settings.continuePrompt.trim() || '继续。';
        this.history.push({ role: 'user', content: continuation });
        this.recordUpdatedInCycle = false;
        nudges = 0;
        this.trimHistory(settings);
        this.emitTarget();
        this.persist();
      }
    } catch (e) {
      if (myRun !== this.runSeq) {
        // 已被 reset 覆盖：丢弃本轮收尾事件
      } else if (signal.aborted) {
        this.pushItem('system', '已中断。');
        this.setState(false, '已中断');
      } else {
        const message = e instanceof Error ? e.message : String(e);
        this.pushItem('error', message);
        this.setState(false, '已停止');
      }
    } finally {
      this.flushPatches();
      if (myRun === this.runSeq) {
        this.running = false;
        this.controller = null;
        if (this.status !== '已中断') this.setState(false, this.status);
      }
      this.persist();
    }
  }

  private emitTarget(): void {
    const t = this.deps.tools.target;
    const target: TargetWindow | null = t
      ? { pid: t.pid, hwnd: t.hwnd, title: t.title, processName: t.processName, width: t.width, height: t.height }
      : null;
    this.deps.emit({ type: 'target', sessionId: this.deps.sessionId, target });
  }

  private buildRequestMessages(settings: ServerSettings): ChatMessage[] {
    const list: ChatMessage[] = [{ role: 'system', content: STATIC_SYSTEM_PROMPT }];
    list.push(...this.history);
    // 每轮只读一次工作记录与笔记：runtimeContext / buildPromptBlock 复用这两次读到的内容
    const recordMd = this.deps.tools.record.ensureExists();
    const notesMd = this.deps.tools.notes.ensureExists();
    const runtime = this.deps.tools.runtimeContext(notesMd.length);
    // 全局技巧库：用户关闭后返回空串，提示词不再附加（内容保留在库里）
    const tipsBlock = this.deps.tools.tips.buildPromptBlock(settings.globalTipsEnabled);
    list.push({
      role: 'system',
      content: this.deps.tools.record.buildPromptBlock(runtime, recordMd) + '\n' +
        this.deps.tools.notes.buildPromptBlock(notesMd) + (tipsBlock ? '\n' + tipsBlock : ''),
    });
    return list;
  }

  /**
   * 历史裁剪：保留首条用户需求 + 最近 N 条消息。裁剪点优先落在 user 边界，
   * 其次落在完整工具组的起点，绝不把 assistant.tool_calls 与对应 tool 结果拆散；
   * 具体规则与兜底修复见 history.ts（trimHistoryMessages / sanitizeHistory）。
   */
  private trimHistory(settings: ServerSettings): void {
    const max = Math.min(400, Math.max(10, settings.historyMaxMessages));
    if (this.history.length <= max) return;
    const { messages, removed } = trimHistoryMessages(this.history, max);
    if (removed <= 0) return;
    this.history = messages;
    this.pushItem('system', '已压缩较早的对话历史（移除 ' + removed + ' 条，保留最近 ' + max + ' 条；工作记录完整）');
  }
}

/**
 * 从回复末尾剥掉完成标记。规则：
 * - 必须位于消息最末尾（允许尾随空白）；
 * - 若标记前有未闭合的代码围栏（奇数个 ```），视为示例文本，不算完成；
 * - 返回剥掉标记后的正文（末尾空白一并清掉）。
 */
export function extractDoneToken(text: string): { text: string; done: boolean } {
  const trailing = text.replace(/\s+$/, '');
  if (!trailing.endsWith(DONE_TOKEN)) return { text, done: false };
  const before = trailing.slice(0, trailing.length - DONE_TOKEN.length);
  const fences = (before.match(/```/g) || []).length;
  if (fences % 2 !== 0) return { text, done: false };
  const cleaned = before.replace(/[\[\]\s]+$/, '').trimEnd();
  return { text: cleaned, done: true };
}

function prettyJson(text: string): string {
  if (!text || !text.trim()) return '{}';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('已中断'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('已中断'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
