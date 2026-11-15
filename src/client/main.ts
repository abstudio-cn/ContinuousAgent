import type { AppState, ChatItem, PluginState, PublicSettings, ServerEvent, WindowInfo } from '../shared/types.js';
import { computeCost, formatMoney, hasPricing, splitInputTokens, type PriceTable } from '../shared/pricing.js';
import { MarkdownStream, renderMarkdown } from './markdown.js';
import { TtsPlayer } from './tts.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error('缺少元素 #' + id);
  return el as T;
};

let state: AppState | null = null;
let sessionId = '';
let dragTimer: number | undefined;
const itemEls = new Map<string, HTMLElement>();
/** 流式渲染器：每条流式消息一个，只处理新增的完整行（见 markdown.ts 的 MarkdownStream）。 */
const streamRenderers = new Map<string, MarkdownStream>();
/** 思考区的流式渲染器（按 item id 索引，单独一份）。 */
const thinkRenderers = new Map<string, MarkdownStream>();
/** 待应用的状态补丁：同一帧内的多次更新合并成一次 DOM 写入。 */
const pendingPatches = new Map<string, Partial<ChatItem>>();
let frameHandle = 0;
const tts = new TtsPlayer(() => state!.settings);

/** 当前正在朗读的消息（消息级播放按钮） */
let speakingId = '';
/** 上一次的状态文本，用于“已完成”提示只弹一次 */
let lastStatusText = '';
const MAX_ATTACHMENTS = 8;
const MAX_ATTACH_BYTES = 6 * 1024 * 1024;

interface PendingAttachment {
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'text';
  dataUrl?: string;
  text?: string;
}

let pendingAttachments: PendingAttachment[] = [];

function fmtNum(n: number): string {
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-US');
}

// ---------------------------------------------------------------- 价格统计
/** 从当前设置里取单价表（三项全 0 表示不计费）。 */
function priceTable(): PriceTable {
  const s = state?.settings;
  return {
    cacheHit: Number(s?.priceCacheHit) || 0,
    input: Number(s?.priceInput) || 0,
    output: Number(s?.priceOutput) || 0,
  };
}

/** 把一条用量换算成金额文本；未配置单价则返回空串（界面不显示金额）。 */
function fmtCost(usage: { promptTokens: number; completionTokens: number; cachedTokens?: number | null } | null | undefined): string {
  if (!usage || !state) return '';
  const prices = priceTable();
  if (!hasPricing(prices)) return '';
  return formatMoney(computeCost(usage, prices).total, state.settings.priceCurrency || '¥');
}

/** 输入的两段后缀：命中时给出「命中 X / 未命中 Y」；无命中则返回空串（此时输入全为未命中）。 */
function cacheSplitSuffix(usage: { promptTokens: number; cachedTokens?: number | null }, estimated = false): string {
  const s = splitInputTokens(usage);
  if (s.hitTokens <= 0) return '';
  return '（命中 ' + (estimated ? '≈' : '') + fmtNum(s.hitTokens) + ' / 未命中 ' + fmtNum(s.missTokens) + '）';
}

/** 一条用量的展示文本：入（命中 X / 未命中 Y）· 出 Z tokens。 */
function usageText(usage: {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number | null;
  cachedEstimated?: boolean | null;
}): string {
  const s = splitInputTokens(usage);
  return '入 ' + fmtNum(s.totalTokens) + cacheSplitSuffix(usage, !!usage.cachedEstimated) +
    ' · 出 ' + fmtNum(usage.completionTokens) + ' tokens';
}

/** 悬浮提示：把「输入 = 命中 + 未命中」写成算式，方便逐项对价格。 */
function usageTitle(usage: { promptTokens: number; completionTokens: number; cachedTokens?: number | null }): string {
  const s = splitInputTokens(usage);
  return '输入合计 ' + fmtNum(s.totalTokens) + ' = 缓存命中 ' + fmtNum(s.hitTokens) +
    ' + 未命中 ' + fmtNum(s.missTokens) + '；输出 ' + fmtNum(usage.completionTokens) + ' tokens';
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function resetSpeakButtons(): void {
  speakingId = '';
  document.querySelectorAll<HTMLButtonElement>('.play-btn').forEach((b) => {
    b.textContent = '\u{1F50A} 朗读';
    b.classList.remove('playing');
  });
}

function toggleSpeak(item: ChatItem, btn: HTMLButtonElement): void {
  if (speakingId === item.id) {
    tts.stop();
    resetSpeakButtons();
    return;
  }
  resetSpeakButtons();
  tts.speakNow(item.text);
  speakingId = item.id;
  btn.textContent = '\u23F9 停止';
  btn.classList.add('playing');
}

// ---------------------------------------------------------------- 基础工具
function toast(message: string, isError = false): void {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' err' : '');
  window.clearTimeout(dragTimer);
  dragTimer = window.setTimeout(() => el.classList.add('hidden'), 3800);
}

async function api<T = any>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const resp = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!resp.ok) throw new Error(data?.error || ('HTTP ' + resp.status));
  return data as T;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 复制文本（优先异步剪贴板，失败回退 execCommand）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// Markdown 渲染结果里的交互：代码块“复制”、图片点击放大（事件委托，动态内容无需重新绑定）
document.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement | null;
  if (!target) return;
  const copyBtn = target.closest('[data-md-copy]') as HTMLButtonElement | null;
  if (copyBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    const box = copyBtn.closest('.md-code');
    const code = box ? box.querySelector('pre code') : null;
    const text = code ? code.textContent || '' : '';
    void copyText(text).then((ok) => {
      copyBtn.textContent = ok ? '已复制' : '复制失败';
      copyBtn.classList.toggle('copied', ok);
      window.setTimeout(() => {
        copyBtn.textContent = '复制';
        copyBtn.classList.remove('copied');
      }, 1500);
    });
    return;
  }
  const img = target.closest('img.md-img') as HTMLImageElement | null;
  if (img && img.src) {
    ev.preventDefault();
    window.open(img.src, '_blank');
  }
});

// ---------------------------------------------------------------- 时间线渲染
function emptyHint(): HTMLElement {
  const box = el('div', 'empty-hint');
  box.appendChild(el('div', 'big', '\u{1F41B}'));
  box.appendChild(el('div', 'title', '还没有对话'));
  box.appendChild(el('div', '', '描述任务后按 Enter 开始；需要操作界面时先选上方目标窗口。'));
  return box;
}

function toolCard(item: ChatItem): HTMLElement {
  const wrap = el('div', 'item tool');
  const head = el('div', 'tool-head');
  head.appendChild(el('span', 'tool-name', item.title || 'tool'));
  if (item.status) {
    const pill = el('span', 'pill ' + (item.status === '完成' ? 'ok' : item.status === '失败' ? 'err' : ''), item.status);
    head.appendChild(pill);
  }
  head.appendChild(el('span', 'tool-meta', item.meta || ''));

  const body = el('div', 'tool-body');
  const argsLabel = el('div', 'tool-section-label', '参数');
  const argsPre = el('pre', 'tool-pre', item.text || '{}');
  body.appendChild(argsLabel);
  body.appendChild(argsPre);

  if (item.detail) {
    const resLabel = el('div', 'tool-section-label', item.status === '失败' ? '错误' : '结果');
    const resPre = el('pre', 'tool-pre', item.detail);
    body.appendChild(resLabel);
    body.appendChild(resPre);
  }
  if (item.imageUrl) {
    const img = el('img', 'tool-shot') as HTMLImageElement;
    img.src = item.imageUrl;
    img.alt = '截图';
    img.addEventListener('click', () => window.open(item.imageUrl!, '_blank'));
    body.appendChild(img);
  }

  // 有截图时默认展开，否则折叠（点击标题切换）
  if (item.expanded || item.imageUrl || item.status === '失败') body.classList.remove('hidden');
  else body.classList.add('hidden');
  wrap.appendChild(head);
  wrap.appendChild(body);

  head.addEventListener('click', () => {
    const expanded = body.classList.toggle('hidden') === false;
    const cur = state?.timeline.find((i) => i.id === item.id);
    if (cur) cur.expanded = expanded;
  });
  return wrap;
}

/**
 * 插件调用审计卡片：把「哪个插件、用途是什么、要执行什么命令」摊开给用户看，
 * 用户点「允许本次 / 本会话允许 / 拒绝」之后才会真正执行。
 */
function pluginAuditCard(item: ChatItem): HTMLElement {
  const wrap = el('div', 'item access plugin');
  const head = el('div', 'access-head');
  head.appendChild(el('span', 'access-title', '\u{1F9E9} 插件调用审计：' + (item.pluginName || item.pluginId || '')));
  const status = item.accessStatus || 'pending';
  head.appendChild(el('span', 'pill ' + (status === 'granted' ? 'ok' : status === 'denied' ? 'err' : ''),
    status === 'granted' ? '已允许' : status === 'denied' ? '已拒绝' : '待确认'));
  wrap.appendChild(head);

  const meta = el('div', 'plugin-meta');
  meta.appendChild(el('span', 'plugin-tag', (item.pluginName || '') + (item.pluginVersion ? ' v' + item.pluginVersion : '')));
  if (item.pluginId) meta.appendChild(el('span', 'plugin-tag', 'id: ' + item.pluginId));
  if (item.pluginTool) meta.appendChild(el('span', 'plugin-tag', '工具: ' + item.pluginTool));
  wrap.appendChild(meta);

  wrap.appendChild(el('div', 'access-reason', '用途：' + (item.pluginPurpose || item.accessReason || '（插件未声明用途）')));
  if (item.pluginArgs) wrap.appendChild(el('div', 'access-path plugin-args', '参数：' + item.pluginArgs));
  if (item.pluginCommand) wrap.appendChild(el('pre', 'plugin-cmd', item.pluginCommand));
  if (item.pluginDir) wrap.appendChild(el('div', 'plugin-dir', '插件目录：' + item.pluginDir));

  if (status === 'pending' && item.accessRequestId) {
    const actions = el('div', 'access-actions');
    const onceBtn = el('button', 'btn primary', '允许本次') as HTMLButtonElement;
    const sessionBtn = el('button', 'btn', '本会话允许') as HTMLButtonElement;
    const denyBtn = el('button', 'btn ghost', '拒绝') as HTMLButtonElement;
    for (const b of [onceBtn, sessionBtn, denyBtn]) b.type = 'button';
    const send = async (decision: 'allow' | 'session' | 'deny') => {
      onceBtn.disabled = true;
      sessionBtn.disabled = true;
      denyBtn.disabled = true;
      try {
        await api('/api/plugin/respond', 'POST', { requestId: item.accessRequestId, decision });
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
        onceBtn.disabled = false;
        sessionBtn.disabled = false;
        denyBtn.disabled = false;
      }
    };
    onceBtn.addEventListener('click', () => void send('allow'));
    sessionBtn.addEventListener('click', () => void send('session'));
    denyBtn.addEventListener('click', () => void send('deny'));
    actions.appendChild(onceBtn);
    actions.appendChild(sessionBtn);
    actions.appendChild(denyBtn);
    wrap.appendChild(actions);
  }
  return wrap;
}

function accessCard(item: ChatItem): HTMLElement {
  if (item.accessKind === 'plugin') return pluginAuditCard(item);
  const wrap = el('div', 'item access');
  const head = el('div', 'access-head');
  const kind = item.accessKind === 'read' ? 'read' : 'write';
  const verb = kind === 'read' ? '读取' : '写入';
  head.appendChild(el('span', 'access-title', '\u{1F513} 目录' + verb + '权限申请'));
  const status = item.accessStatus || 'pending';
  head.appendChild(el('span', 'pill ' + (status === 'granted' ? 'ok' : status === 'denied' ? 'err' : ''),
    status === 'granted' ? '已允许' : status === 'denied' ? '已拒绝' : '待确认'));
  wrap.appendChild(head);

  const pathLine = el('div', 'access-path', item.accessPath || '');
  wrap.appendChild(pathLine);
  if (item.accessReason) wrap.appendChild(el('div', 'access-reason', item.accessReason));

  if (status === 'pending' && item.accessRequestId) {
    const actions = el('div', 'access-actions');
    const allow = el('button', 'btn primary', '允许' + verb) as HTMLButtonElement;
    allow.type = 'button';
    const deny = el('button', 'btn ghost', '拒绝') as HTMLButtonElement;
    deny.type = 'button';
    const send = async (value: boolean) => {
      allow.disabled = true;
      deny.disabled = true;
      try {
        await api('/api/access/respond', 'POST', { requestId: item.accessRequestId, allow: value });
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
        allow.disabled = false;
        deny.disabled = false;
      }
    };
    allow.addEventListener('click', () => void send(true));
    deny.addEventListener('click', () => void send(false));
    actions.appendChild(allow);
    actions.appendChild(deny);
    wrap.appendChild(actions);
  }
  return wrap;
}

function thinkingCard(item: ChatItem): HTMLElement {
  const wrap = el('div', 'item thinking');
  const head = el('div', 'thinking-head');
  head.appendChild(el('span', '', '\u{1F9E0} ' + (item.title || '思考')));
  if (item.streaming) head.appendChild(el('span', '', '· 进行中'));
  const body = el('div', 'thinking-body md' + (item.expanded ? '' : ' hidden'));
  body.innerHTML = renderMarkdown(item.text);
  wrap.appendChild(head);
  wrap.appendChild(body);
  wrap.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) return;
    const isHidden = body.classList.toggle('hidden');
    const cur = state?.timeline.find((i) => i.id === item.id);
    if (cur) cur.expanded = !isHidden;
  });
  return wrap;
}

/** 旧版时间线的完成提示带「收到完成标记 [[DONE]]」前缀：界面上只保留后半句。 */
function systemItemText(text: string): string {
  const t = String(text || '');
  const m = t.match(/^收到完成标记\s*\[\[DONE\]\]\s*[：:]?\s*/);
  if (!m) return t;
  const rest = t.slice(m[0].length).trim();
  return rest || '任务结束，已停止自动续跑。';
}

function renderItem(item: ChatItem): HTMLElement {
  let node: HTMLElement;
  switch (item.kind) {
    case 'user': {
      node = el('div', 'item user');
      const bubble = el('div', 'bubble');
      bubble.appendChild(document.createTextNode(item.text));
      if (item.attachments && item.attachments.length > 0) {
        const list = el('div', 'att-list');
        for (const a of item.attachments) {
          const chip = el('span', 'att-chip', (a.kind === 'image' ? '\u{1F5BC} ' : '\u{1F4C4} ') + a.name);
          chip.title = a.mime + ' · ' + fmtBytes(a.size);
          list.appendChild(chip);
        }
        bubble.appendChild(list);
      }
      node.appendChild(bubble);
      if (item.imageUrl) {
        const img = el('img', 'att-thumb') as HTMLImageElement;
        img.src = item.imageUrl;
        img.alt = '附件图片';
        img.addEventListener('click', () => window.open(item.imageUrl!, '_blank'));
        node.appendChild(img);
      }
      break;
    }
    case 'assistant': {
      node = el('div', 'item assistant');
      const content = el('div', 'content md' + (item.streaming ? ' streaming' : ''));
      content.innerHTML = renderMarkdown(item.text);
      node.appendChild(content);
      if (item.text.trim() && !item.streaming) {
        const foot = el('div', 'msg-foot');
        const play = el('button', 'play-btn', '\u{1F50A} 朗读') as HTMLButtonElement;
        play.type = 'button';
        play.title = '朗读这条回复';
        play.addEventListener('click', (ev) => {
          ev.stopPropagation();
          toggleSpeak(item, play);
        });
        foot.appendChild(play);
        if (item.usage) {
          const usageEl = el('span', 'msg-usage', usageText(item.usage));
          usageEl.title = usageTitle(item.usage);
          foot.appendChild(usageEl);
          const cost = fmtCost(item.usage);
          if (cost) foot.appendChild(el('span', 'msg-cost', cost));
        }
        node.appendChild(foot);
      }
      break;
    }
    case 'thinking':
      node = thinkingCard(item);
      break;
    case 'access':
      node = accessCard(item);
      break;
    case 'tool':
      node = toolCard(item);
      break;
    case 'error': {
      node = el('div', 'item error');
      const box = el('div', 'errbox');
      box.textContent = item.text;
      node.appendChild(box);
      break;
    }
    default: {
      node = el('div', 'item system');
      const tag = el('span', 'tag', systemItemText(item.text));
      node.appendChild(tag);
      break;
    }
  }
  node.dataset.id = item.id;
  return node;
}

function timelineEl(): HTMLElement {
  return $('timeline');
}

function isNearBottom(): boolean {
  const t = timelineEl();
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}

function scrollToBottom(force = false): void {
  const t = timelineEl();
  if (force || isNearBottom()) t.scrollTop = t.scrollHeight;
}

function renderTimeline(items: ChatItem[], forceScroll = false): void {
  const host = timelineEl();
  host.innerHTML = '';
  itemEls.clear();
  streamRenderers.clear();
  thinkRenderers.clear();
  pendingPatches.clear();
  if (frameHandle) {
    cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }
  if (items.length === 0) {
    host.appendChild(emptyHint());
    return;
  }
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const node = renderItem(item);
    itemEls.set(item.id, node);
    frag.appendChild(node);
  }
  host.appendChild(frag);
  if (forceScroll) host.scrollTop = host.scrollHeight;
}

function upsertItem(item: ChatItem, forceScroll = false): void {
  const host = timelineEl();
  if (itemEls.size === 0 && host.querySelector('.empty-hint')) host.innerHTML = '';
  const old = itemEls.get(item.id);
  const node = renderItem(item);
  itemEls.set(item.id, node);
  if (old && old.parentElement) old.parentElement.replaceChild(node, old);
  else host.appendChild(node);
  scrollToBottom(forceScroll);
}

function patchItem(id: string, patch: Partial<ChatItem>): void {
  const cur = pendingPatches.get(id);
  pendingPatches.set(id, cur ? { ...cur, ...patch } : { ...patch });
  if (frameHandle) return;
  frameHandle = requestAnimationFrame(() => {
    frameHandle = 0;
    flushPatches();
  });
}

function flushPatches(): void {
  if (pendingPatches.size === 0) return;
  const batch = [...pendingPatches];
  pendingPatches.clear();
  // 流式文本追加时保持折叠状态与滚动位置
  const wasNear = isNearBottom();
  for (const [id, patch] of batch) applyPatch(id, patch);
  if (wasNear) scrollToBottom(true);
}

function applyPatch(id: string, patch: Partial<ChatItem>): void {
  const item = state?.timeline.find((i) => i.id === id);
  if (!item) return;
  Object.assign(item, patch);
  const old = itemEls.get(id);
  // 流式追加：只就地更新文本节点，不重建整段 DOM
  if (old && patch.streaming !== false && updateStreamingNode(old, item)) return;
  streamRenderers.delete(item.id);
  thinkRenderers.delete(item.id);
  const node = renderItem(item);
  itemEls.set(id, node);
  if (old && old.parentElement) old.parentElement.replaceChild(node, old);

  if (item.kind === 'assistant' && patch.streaming === false && item.text.trim()) {
    resetSpeakButtons();
  }
}

/** 就地更新流式文本节点；不支持就地更新的类型返回 false（回退为整节点重建）。 */
function updateStreamingNode(node: HTMLElement, item: ChatItem): boolean {
  if (item.kind === 'assistant') {
    const content = node.querySelector('.content') as HTMLElement | null;
    if (!content) return false;
    let renderer = streamRenderers.get(item.id);
    if (!renderer) {
      renderer = new MarkdownStream();
      streamRenderers.set(item.id, renderer);
    }
    content.classList.add('streaming');
    content.innerHTML = renderer.push(item.text);
    return true;
  }
  if (item.kind === 'thinking') {
    const body = node.querySelector('.thinking-body') as HTMLElement | null;
    if (!body) return false;
    let renderer = thinkRenderers.get(item.id);
    if (!renderer) {
      renderer = new MarkdownStream();
      thinkRenderers.set(item.id, renderer);
    }
    body.innerHTML = renderer.push(item.text);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- 状态栏 / 文档
function applyStatus(): void {
  if (!state) return;
  const chip = $('statusChip');
  const text = state.status.status || '空闲';
  chip.textContent = text;
  chip.className = 'status ' + (state.status.running ? 'running'
    : /已完成/.test(text) ? 'done'
      : /错误|停止/.test(text) ? 'error' : 'idle');
  if (text !== lastStatusText) {
    if (/已完成/.test(text)) toast('\u2705 模型确认任务完成，运行已停止');
    lastStatusText = text;
  }
  const inTok = fmtNum(state.status.promptTokens);
  const outTok = fmtNum(state.status.completionTokens);
  // 单价未配置时 fmtCost 返回空串，状态栏保持原样
  const totalCost = fmtCost({
    promptTokens: state.status.promptTokens,
    completionTokens: state.status.completionTokens,
    cachedTokens: state.status.cachedTokens,
  });
  const costSuffix = totalCost ? ' · ' + totalCost : '';
  // 输入拆成两段展示：命中缓存的部分与未命中（走输入单价）的部分，与价格明细一一对应
  const hitTok = Number(state.status.cacheHitTokens ?? state.status.cachedTokens) || 0;
  const missTok = Math.max(0, state.status.promptTokens - hitTok);
  const cacheSuffix = hitTok > 0 ? '（命中 ' + fmtNum(hitTok) + ' / 未命中 ' + fmtNum(missTok) + '）' : '';
  const usageEl = $('usage');
  usageEl.textContent = '入 ' + inTok + cacheSuffix + ' · 出 ' + outTok + ' tokens' + costSuffix;
  usageEl.title = '输入合计 ' + inTok + ' = 缓存命中 ' + fmtNum(hitTok) + ' + 未命中 ' + fmtNum(missTok) +
    '；输出 ' + outTok + ' tokens';
  const meter = document.getElementById('tokenMeter');
  if (meter) meter.textContent = '入 ' + inTok + cacheSuffix + ' · 出 ' + outTok + costSuffix;
  ($('startBtn') as HTMLButtonElement).disabled = state.status.running;
  ($('stopBtn') as HTMLButtonElement).disabled = !state.status.running;
}

function renderGrants(): void {
  const chip = document.getElementById('grantsChip');
  if (!chip || !state) return;
  const list = state.grants || [];
  const readable = state.readGrants || [];
  if (list.length === 0 && readable.length === 0) {
    chip.classList.add('hidden');
    chip.textContent = '';
    chip.title = '';
    return;
  }
  chip.classList.remove('hidden');
  chip.textContent = '\u{1F513} ' + (list.length + readable.length);
  chip.title = [
    list.length > 0 ? '本会话已授权可写：\n' + list.join('\n') : '',
    readable.length > 0 ? '本会话已授权可读：\n' + readable.join('\n') : '',
  ].filter(Boolean).join('\n');
}

let docTab: 'record' | 'notes' = 'record';

function renderDoc(): void {
  if (!state) return;
  const md = docTab === 'record' ? state.record : state.notes;
  const meta = $('docMeta');
  meta.innerHTML = '';
  if (docTab === 'record') {
    meta.appendChild(el('span', '', 'sessions/' + state.session.id + '/ · 阶段性整份覆盖'));
    meta.appendChild(el('span', '', state.record.length + ' 字符'));
  } else {
    meta.appendChild(el('span', '', '长期工作笔记 · 上限 ' + state.notesMax));
    meta.appendChild(el('span', '', state.notesLength + ' / ' + state.notesMax));
  }
  $('docView').innerHTML = renderMarkdown(md || '（空）');
}

function setDocTab(tab: 'record' | 'notes'): void {
  docTab = tab;
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  renderDoc();
}

// ---------------------------------------------------------------- 目标窗口
function applyTarget(): void {
  if (!state) return;
  const t = state.target;
  const select = $('windowSelect') as HTMLSelectElement;
  if (t) {
    const exists = [...select.options].some((o) => o.value === String(t.pid));
    if (!exists) {
      const opt = new Option(t.processName + ' · ' + t.title + ' (' + t.pid + ')', String(t.pid));
      select.appendChild(opt);
    }
    select.value = String(t.pid);
  } else {
    select.value = '';
  }
}

async function refreshWindows(): Promise<void> {
  const select = $('windowSelect') as HTMLSelectElement;
  try {
    const data = await api<{ windows: WindowInfo[]; nativeAvailable: boolean; detail?: string }>('/api/windows');
    const current = state?.target?.pid;
    select.innerHTML = '';
    select.appendChild(new Option('（未选择）', ''));
    for (const w of data.windows) {
      const label = w.processName + ' · ' + (w.title.length > 40 ? w.title.slice(0, 40) + '…' : w.title) +
        '  (' + w.pid + ')  ' + w.width + 'x' + w.height;
      select.appendChild(new Option(label, String(w.pid)));
    }
    if (current) {
      const exists = [...select.options].some((o) => o.value === String(current));
      if (!exists) select.appendChild(new Option('当前: PID ' + current, String(current)));
      select.value = String(current);
    }
    if (state) state.nativeAvailable = data.nativeAvailable;
    renderNativeBanner(data.nativeAvailable, data.detail);
  } catch (e) {
    toast('刷新窗口失败: ' + (e instanceof Error ? e.message : String(e)), true);
  }
}

function nativeDetail(): string {
  return state?.nativeDetail || '';
}

function renderNativeBanner(available?: boolean, detail?: string): void {
  const banner = $('nativeBanner');
  if (available === undefined) available = state?.nativeAvailable ?? false;
  const text = detail ?? state?.nativeDetail ?? '';
  if (available) {
    banner.textContent = '';
    banner.classList.add('hidden');
    return;
  }
  banner.textContent = '原生控制不可用：' + (text || '原生桥接未启动') + '（文件、记录、笔记工具仍可用）';
  banner.classList.remove('hidden');
}

// ---------------------------------------------------------------- 事件流
function handleEvent(event: ServerEvent): void {
  if (!state) return;
  if (event.type === 'sessions') {
    state.sessions = event.sessions;
    renderSessions();
    return;
  }
  if (event.type === 'grants') {
    state.grants = event.grants;
    renderGrants();
    return;
  }
  if (event.type === 'readGrants') {
    state.readGrants = event.readGrants;
    renderGrants();
    return;
  }
  if (event.type === 'plugins') {
    state.plugins = event.plugins;
    return;
  }
  if (event.type === 'native') {
    state.nativeAvailable = event.available;
    state.nativeDetail = event.detail;
    renderNativeBanner(event.available, event.detail);
    if (event.available) void refreshWindows();
    return;
  }
  // 其它事件都属于某个会话：不是当前会话就忽略（避免串台）
  if ('sessionId' in event && event.sessionId !== sessionId) return;
  switch (event.type) {
    case 'state':
      state.status = event.status;
      applyStatus();
      break;
    case 'item_add':
      state.timeline.push(event.item);
      if (state.timeline.length > 400) state.timeline.splice(0, state.timeline.length - 400);
      upsertItem(event.item);
      break;
    case 'item_update':
      patchItem(event.id, event.patch);
      break;
    case 'clear':
      state.timeline = [];
      renderTimeline([]);
      break;
    case 'record':
      state.record = event.markdown;
      if (docTab === 'record') renderDoc();
      break;
    case 'notes':
      state.notes = event.markdown;
      state.notesLength = event.length;
      if (docTab === 'notes') renderDoc();
      break;
    case 'target':
      state.target = event.target;
      applyTarget();
      break;
    default:
      break;
  }
}

function connectEvents(): void {
  const es = new EventSource('/api/events');
  es.onmessage = (msg) => {
    try {
      handleEvent(JSON.parse(msg.data) as ServerEvent);
    } catch {
      /* ignore malformed */
    }
  };
  es.onerror = () => {
    // EventSource 会自动重连；断线期间状态以 REST 快照补齐
    window.setTimeout(() => {
      void reloadState();
    }, 3000);
  };
}

// ---------------------------------------------------------------- 设置
interface FieldDef {
  key: keyof PublicSettings | 'apiKey' | 'cloudTtsApiKey';
  label: string;
  type: 'text' | 'password' | 'number' | 'checkbox' | 'select' | 'textarea';
  options?: Array<{ value: string; label: string }>;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  secret?: 'apiKey' | 'cloudTtsApiKey';
}

const SECTIONS: Array<{ id: string; title: string; note?: string; fields: FieldDef[] }> = [
  {
    id: 'api',
    title: '接口与模型',
    note: 'OpenAI 兼容的 /chat/completions 接口。密钥只保存在服务端，不会回传到浏览器。',
    fields: [
      { key: 'apiBaseUrl', label: 'API 地址', type: 'text', hint: '例如 https://api.openai.com/v1 或 https://api.deepseek.com/v1' },
      { key: 'apiKey', label: 'API Key', type: 'password', secret: 'apiKey', hint: '留空表示保持当前密钥不变' },
      { key: 'model', label: '模型名称', type: 'text' },
      {
        key: 'reasoningEffort', label: '思考强度', type: 'select',
        options: [
          { value: 'auto', label: 'auto（不发送 reasoning_effort）' },
          { value: 'minimal', label: 'minimal' },
          { value: 'low', label: 'low' },
          { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' },
        ],
      },
      { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1 },
      { key: 'maxOutputTokens', label: '最大输出 tokens', type: 'number', min: 256, max: 384000, step: 256 },
    ],
  },
  {
    id: 'backup',
    title: '改动备份',
    note: '改动文件前会自动把原文件复制到 <工作空间>/changed_backup，文件名 = 原文件名__时间戳.bak，便于撤回。用 changed_backup 工具可以 list 查看、restore 回滚。任务彻底结束（模型输出完成标记）时会自动清空这些备份。',
    fields: [
      {
        key: 'changedBackupEnabled', label: '改动前自动备份', type: 'checkbox',
        hint: 'write_file 覆盖已有文件、edit_file、apply_patch 之前都会先备份原内容；新建文件无需备份',
      },
      {
        key: 'changedBackupMaxFiles', label: '最多保留份数', type: 'number',
        min: 1, max: 5000, step: 1, hint: '超出后按时间从旧到新删除'
      },
    ],
  },
  {
    id: 'pricing',
    title: '价格统计',
    note: '单价按「每百万 tokens」填写（与主流厂商报价口径一致），金额 = tokens / 1000000 × 单价。输入 token 拆成两段分别计价：命中的部分按「缓存命中单价」、未命中的部分按「缓存未命中单价」，输出单独计价；三项都填 0 表示不计费，界面上不显示金额。缓存命中数优先采用服务商上报值（OpenAI 的 prompt_tokens_details.cached_tokens、DeepSeek 的 prompt_cache_hit_tokens）；接口未上报时按「上一条请求的输入前缀被复用」估算，属于预估值（界面显示为 ≈）。',
    fields: [
      {
        key: 'priceCacheHit', label: '缓存命中输入单价（每百万 tokens）', type: 'number',
        min: 0, max: 10000, step: 0.01, hint: '命中缓存的那部分输入按此价，通常远低于未命中单价',
      },
      {
        key: 'priceInput', label: '缓存未命中输入单价（每百万 tokens）', type: 'number',
        min: 0, max: 10000, step: 0.01, hint: '未命中缓存的输入（输入总量 - 命中）按此价',
      },
      { key: 'priceOutput', label: '输出单价（每百万 tokens）', type: 'number', min: 0, max: 10000, step: 0.01 },
      { key: 'priceCurrency', label: '货币符号', type: 'text', hint: '默认 ¥；用美元可填 $' },
    ],
  },
  {
    id: 'workspace',
    title: '工作空间',
    note: '读文件默认可访问本机任意路径（开启“读取申请（严格模式）”后需逐目录申请）；写、删、工作记录与笔记只允许在工作空间内。',
    fields: [
      { key: 'workspacePath', label: '工作空间目录', type: 'text', hint: '默认 Documents\\ContinuousAgentWorkspace' },
      { key: 'gameRecordFileName', label: '工作记录文件名', type: 'text' },
      { key: 'gameNotesFileName', label: '工作笔记文件名', type: 'text' },
      { key: 'gameSavePath', label: '存档路径提示（可选）', type: 'text', hint: '仅作为提示交给模型，不会自动写入' },
    ],
  },
  {
    id: 'tips',
    title: '全局技巧库',
    note: '跨会话共享的工具使用技巧（命令参数、快捷键、调用顺序、易错点与解法）。写入时自动脱敏：路径、链接、邮箱、IP、密钥、长串、ID 会先被替换为占位符；含项目/环境专有信息的内容会被拒绝，只保留通用工具经验。上限 100000 字符，超出后按利用频次从低到高自动清除。',
    fields: [
      {
        key: 'globalTipsEnabled',
        label: '把全局技巧库附加到提示词',
        type: 'checkbox',
        hint: '默认开启。关闭后提示词不再附加这份内容，已存条目仍保留，可随时重新开启',
      },
    ],
  },
  {
    id: 'tools',
    title: '工具权限',
    note: 'exec_command 会以当前 Windows 用户身份执行 PowerShell；launch_app 可启动任意程序。写入默认只在工作空间内，需临时改外部目录时由模型申请、用户在对话中确认一次（本会话有效）。读取默认不限制；打开“读取申请（严格模式）”后，读取工作空间外的路径也需在对话中确认一次。服务默认只监听 127.0.0.1。',
    fields: [
      { key: 'allowShell', label: '允许执行命令（exec_command）', type: 'checkbox' },
      { key: 'shellTimeoutMs', label: '单条命令超时（毫秒）', type: 'number', min: 1000, max: 1800000, step: 1000 },
      { key: 'allowLaunch', label: '允许启动程序（launch_app）', type: 'checkbox' },
      {
        key: 'allowPathRequests', label: '允许申请工作空间外目录', type: 'checkbox',
        hint: '开启后模型可调用 request_write_access；对话中允许一次，本会话内该目录即可写',
      },
      {
        key: 'extraWritePaths', label: '永久放行的可写目录', type: 'textarea',
        hint: '每行一个绝对路径；这些目录无需再逐次申请（注意：放行即长期生效）',
      },
      {
        key: 'strictReadMode', label: '读取申请（严格模式）', type: 'checkbox',
        hint: '默认关闭。开启后读取工作空间外的路径需在对话中确认一次（本会话有效）；关闭时本机任意路径都可直接读',
      },
      {
        key: 'allowReadRequests', label: '严格模式下允许申请读取', type: 'checkbox',
        hint: '关闭后模型不能调用 request_read_access，只能靠下面的可读目录白名单',
      },
      {
        key: 'extraReadPaths', label: '永久放行的可读目录', type: 'textarea',
        hint: '每行一个绝对路径；仅在严格模式下生效，这些目录无需逐次申请',
      },
    ],
  },
  {
    id: 'run',
    title: '运行',
    fields: [
      { key: 'continuousMode', label: '持续托管（每轮结束后自动继续）', type: 'checkbox' },
      { key: 'continueDelayMs', label: '继续前等待（毫秒）', type: 'number', min: 300, max: 60000, step: 100 },
      { key: 'continuePrompt', label: '继续提示词', type: 'textarea' },
      { key: 'maxTurns', label: '最大轮数（0 表示不限）', type: 'number', min: 0, max: 100000, step: 1 },
      { key: 'historyMaxMessages', label: '保留历史消息条数', type: 'number', min: 10, max: 400, step: 1, hint: '保留首条需求 + 最近 N 条，裁剪点落在 user 边界' },
      { key: 'clickDelayMs', label: '每个工具后的间隔（毫秒）', type: 'number', min: 0, max: 5000, step: 10 },
    ],
  },
  {
    id: 'vision',
    title: '视觉与 OCR',
    fields: [
      { key: 'sendScreenshots', label: '把窗口截图发送给模型', type: 'checkbox' },
      { key: 'screenshotBurnAfterRead', label: '截图阅后即焚（读过不再发送）', type: 'checkbox' },
      { key: 'maxScreenshotWidth', label: '截图最大宽度（像素）', type: 'number', min: 320, max: 2400, step: 40 },
      { key: 'ocrLanguage', label: 'OCR 语言', type: 'text', hint: '例如 zh-Hans / en-US，需要系统已安装对应语言包' },
    ],
  },
  {
    id: 'tts',
    title: '语音朗读',
    note: '聊天栏不再自动朗读：每条回复结尾有“朗读”按钮，点击才会朗读（自动朗读开关仅作为朗读按钮的默认可用状态）。',
    fields: [
      { key: 'ttsEnabled', label: '启用朗读', type: 'checkbox' },
      {
        key: 'ttsEngine', label: '引擎', type: 'select',
        options: [
          { value: 'Browser', label: '浏览器语音（离线，系统语音）' },
          { value: 'Cloud', label: '云端 /audio/speech（OpenAI 兼容）' },
        ],
      },
      { key: 'ttsVoice', label: '浏览器语音名称（可选）', type: 'text', hint: '留空使用系统默认中文语音' },
      { key: 'ttsRate', label: '语速偏移（-10 到 10）', type: 'number', min: -10, max: 10, step: 1 },
      { key: 'ttsVolume', label: '音量（0 到 1）', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'ttsQueueMode', label: '排队策略', type: 'select', options: [
        { value: 'latest', label: 'latest · 只读最新（忙时丢弃）' },
        { value: 'limit', label: 'limit · 队列上限' },
        { value: 'off', label: 'off · 全部排队' },
      ] },
      { key: 'ttsQueueLimit', label: '队列上限（limit 模式）', type: 'number', min: 1, max: 20, step: 1 },
      { key: 'cloudTtsBaseUrl', label: '云端 TTS 地址', type: 'text', hint: '例如 https://api.openai.com/v1' },
      { key: 'cloudTtsApiKey', label: '云端 TTS Key', type: 'password', secret: 'cloudTtsApiKey', hint: '留空表示保持当前密钥不变' },
      { key: 'cloudTtsModel', label: '云端 TTS 模型', type: 'text' },
      { key: 'cloudTtsVoice', label: '云端 TTS 音色', type: 'text' },
    ],
  },
  {
    id: 'plugins',
    title: '插件',
    note: '插件用「JSON 清单 + 外部命令」扩展工具，与核心完全隔离：插件没装、写坏清单或执行崩溃，核心工具照常工作。默认关闭；开启后插件的每个工具在被执行前都会弹出审计卡片，写明插件用途与将要执行的命令，必须由你确认才会真正运行。',
    fields: [
      { key: 'pluginsEnabled', label: '启用插件（默认关闭）', type: 'checkbox', hint: '关闭时插件工具完全不出现在工具清单与提示词里' },
      { key: 'pluginTimeoutMs', label: '单次执行超时（毫秒）', type: 'number', min: 1000, max: 600000, step: 1000, hint: '超时会连同整棵子进程树一起终止' },
    ],
  },
];

let activeSection = 'api';

interface TipEntryView {
  id: string;
  text: string;
  uses: number;
  createdAt: number;
  lastUsedAt: number;
}

/** 设置面板「全局技巧库」分区：拉取并列出条目名单（只读，不改写磁盘）。 */
async function loadTipsList(host: HTMLElement): Promise<void> {
  let data: { enabled: boolean; entries: TipEntryView[] } | null = null;
  try {
    data = await api<{ enabled: boolean; entries: TipEntryView[] }>('/api/tips');
  } catch (e) {
    if (!host.isConnected) return;
    host.innerHTML = '';
    host.appendChild(el('p', 'section-note', '读取条目失败：' + (e instanceof Error ? e.message : String(e))));
    return;
  }
  if (!host.isConnected) return;
  const entries = data?.entries || [];
  host.innerHTML = '';

  const head = el('div', 'tips-head');
  head.appendChild(el('span', 'tips-count', '条目名单：' + entries.length + ' 条（按利用频次降序）'));
  const refresh = el('button', 'tips-refresh', '刷新');
  refresh.type = 'button';
  refresh.addEventListener('click', () => void loadTipsList(host));
  head.appendChild(refresh);
  host.appendChild(head);

  if (entries.length === 0) {
    host.appendChild(el('p', 'section-note', '库里还没有条目。模型调用 global_tips {action:"add"} 写入后会出现在这里。'));
    return;
  }

  for (const t of entries) {
    const row = el('div', 'tip-row');
    const meta = el('div', 'tip-meta');
    meta.appendChild(el('span', 'tip-id', t.id));
    meta.appendChild(el('span', 'tip-uses', '用 ' + fmtNum(t.uses) + ' 次'));
    meta.appendChild(el('span', 'tip-time', t.lastUsedAt ? '最近 ' + timeAgo(t.lastUsedAt) : '未使用'));
    row.appendChild(meta);
    const text = el('div', 'tip-text', t.text || '（空）');
    text.title = t.text || '';
    row.appendChild(text);
    host.appendChild(row);
  }
}

function buildSettings(): void {
  if (!state) return;
  const nav = $('settingsNav');
  const body = $('settingsBody');
  nav.innerHTML = '';
  body.innerHTML = '';

  for (const section of SECTIONS) {
    const btn = el('button', section.id === activeSection ? 'active' : '', section.title);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      activeSection = section.id;
      buildSettings();
    });
    nav.appendChild(btn);
  }

  const section = SECTIONS.find((s) => s.id === activeSection) || SECTIONS[0]!;
  body.appendChild(el('h3', 'section-title', section.title));
  if (section.note) body.appendChild(el('p', 'section-note', section.note));
  if (section.id === 'tips' && state.tips) {
    const t = state.tips;
    body.appendChild(el('p', 'section-note',
      '当前：' + t.count + ' 条 / ' + t.chars + ' 字符（上限 ' + t.max + '）；' +
      (state.settings.globalTipsEnabled ? '已开启，会附加到每次请求末尾。' : '已关闭，不会附加。')));
    const host = el('div', 'tips-list');
    host.appendChild(el('p', 'section-note', '正在读取条目名单…'));
    body.appendChild(host);
    void loadTipsList(host);
  }
  if (section.id === 'pricing') {
    const prices = priceTable();
    const st = state.status;
    if (!hasPricing(prices)) {
      body.appendChild(el('p', 'section-note', '尚未填写单价，界面不显示金额。'));
    } else {
      const c = computeCost({
        promptTokens: st.promptTokens,
        completionTokens: st.completionTokens,
        cachedTokens: st.cachedTokens,
      }, prices);
      const cur = state.settings.priceCurrency || '¥';
      body.appendChild(el('p', 'section-note',
        '本次会话累计：缓存命中输入 ' + fmtNum(c.cacheHitTokens) + ' + 缓存未命中输入 ' + fmtNum(c.cacheMissTokens) +
        ' + 输出 ' + fmtNum(c.outputTokens) + ' tokens → 合计 ' + formatMoney(c.total, cur) +
        '（命中 ' + formatMoney(c.cacheCost, cur) + ' + 未命中 ' + formatMoney(c.inputCost, cur) +
        ' + 输出 ' + formatMoney(c.outputCost, cur) + '）'));
    }
  }

  if (section.id === 'backup' && state.backups) {
    const b = state.backups;
    body.appendChild(el('p', 'section-note',
      '目录：' + b.folder + '；当前 ' + b.count + ' 份 / ' + fmtBytes(b.bytes) +
      '（上限 ' + b.max + ' 份）' + (b.enabled ? '；已开启。' : '；已关闭，不再产生新备份。')));
  }
  if (section.id === 'plugins' && state.plugins) {
    const p = state.plugins;
    body.appendChild(el('p', 'section-note',
      '目录：' + p.dir + '；插件 ' + p.items.length + ' 个，可用工具 ' +
      p.items.reduce((n, it) => n + (it.error ? 0 : it.tools.length), 0) + ' 个；累计审计 ' + p.auditCount + ' 次' +
      (p.enabled ? '；已启用。' : '；已关闭，插件工具不会下发给模型。')));
    const reloadBtn = el('button', 'tips-refresh', '重新扫描插件目录') as HTMLButtonElement;
    reloadBtn.type = 'button';
    reloadBtn.addEventListener('click', () => {
      reloadBtn.disabled = true;
      void (async () => {
        try {
          const data = await api<{ plugins: PluginState }>('/api/plugins/reload', 'POST', {});
          if (state && data?.plugins) state.plugins = data.plugins;
          buildSettings();
          toast('已重新扫描：' + (data?.plugins?.items.length ?? 0) + ' 个插件');
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), true);
          reloadBtn.disabled = false;
        }
      })();
    });
    body.appendChild(reloadBtn);
    const host = el('div', 'plugin-list');
    if (p.items.length === 0) {
      host.appendChild(el('p', 'section-note', '还没有插件。在插件目录下新建 <插件id>/plugin.json 即可（可参考项目里的 examples/plugins 范本），改完点上面的「重新扫描插件目录」。'));
    }
    for (const item of p.items) {
      const row = el('div', 'plugin-row' + (item.error ? ' bad' : ''));
      const rowHead = el('div', 'plugin-row-head');
      rowHead.appendChild(el('span', 'plugin-row-name', item.name + (item.version ? ' v' + item.version : '') + '（' + item.id + '）'));
      rowHead.appendChild(el('span', 'pill ' + (item.error ? 'err' : item.enabled ? 'ok' : ''),
        item.error ? '加载失败' : item.enabled ? '启用' : '已禁用'));
      row.appendChild(rowHead);
      row.appendChild(el('div', 'plugin-row-purpose', item.error ? '错误：' + item.error : '用途：' + item.purpose));
      row.appendChild(el('div', 'plugin-row-tools', '工具：' +
        (item.tools.length ? item.tools.map((t) => t.globalName).join('、') : '（无）')));
      host.appendChild(row);
    }
    body.appendChild(host);
  }
  const grid = el('div', '');
  let i = 0;
  for (const f of section.fields) {
    const value = f.secret ? '' : state.settings[f.key as keyof PublicSettings];
    if (f.type === 'checkbox') {
      const wrap = el('div', 'field check');
      const input = el('input') as HTMLInputElement;
      input.type = 'checkbox';
      input.id = 'f_' + f.key;
      input.checked = !!value;
      const label = el('label', '', f.label);
      label.htmlFor = input.id;
      wrap.appendChild(input);
      wrap.appendChild(label);
      grid.appendChild(wrap);
      continue;
    }
    const wrap = el('div', 'field');
    const label = el('label', '', f.label);
    label.htmlFor = 'f_' + f.key;
    wrap.appendChild(label);

    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (f.type === 'select') {
      input = el('select') as HTMLSelectElement;
      for (const o of f.options || []) {
        const opt = new Option(o.label, o.value);
        input.appendChild(opt);
      }
      input.value = String(value ?? '');
    } else if (f.type === 'textarea') {
      input = el('textarea') as HTMLTextAreaElement;
      input.value = String(value ?? '');
    } else {
      input = el('input') as HTMLInputElement;
      input.type = f.type;
      if (f.min !== undefined) input.min = String(f.min);
      if (f.max !== undefined) input.max = String(f.max);
      if (f.step !== undefined) input.step = String(f.step);
      if (f.secret) {
        input.value = '';
        input.placeholder = f.secret === 'apiKey'
          ? (state.settings.hasApiKey ? '已保存（留空不修改）' : '未设置')
          : (state.settings.hasCloudTtsApiKey ? '已保存（留空不修改）' : '未设置');
      } else {
        input.value = String(value ?? '');
      }
    }
    input.id = 'f_' + f.key;
    input.dataset.key = String(f.key);
    if (f.type === 'number') input.classList.add('num');
    wrap.appendChild(input);
    if (f.hint) wrap.appendChild(el('div', 'hint', f.hint));
    grid.appendChild(wrap);
    i++;
  }
  body.appendChild(grid);
}

function collectSettings(): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const section of SECTIONS) {
    for (const f of section.fields) {
      const input = document.getElementById('f_' + f.key) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
      if (!input) continue;
      if (f.type === 'checkbox') {
        patch[f.key] = (input as HTMLInputElement).checked;
      } else if (f.secret) {
        const v = (input as HTMLInputElement).value.trim();
        if (v) patch[f.key] = v;
      } else if (f.type === 'number') {
        const n = Number((input as HTMLInputElement).value);
        if (Number.isFinite(n)) patch[f.key] = n;
      } else {
        patch[f.key] = (input as HTMLInputElement).value;
      }
    }
  }
  return patch;
}

// ---------------------------------------------------------------- 会话
function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  const d = new Date(ms);
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function renderSessions(): void {
  const host = $('sessionList');
  if (!state) return;
  host.innerHTML = '';
  for (const s of state.sessions) {
    const item = el('div', 'session-item' + (s.id === sessionId ? ' active' : ''));
    item.dataset.id = s.id;
    const title = el('div', 'session-title');
    if (s.running) title.appendChild(el('span', 'session-dot'));
    title.appendChild(document.createTextNode(s.title));
    const meta = el('div', 'session-meta');
    meta.appendChild(el('span', '', timeAgo(s.updatedAt)));
    meta.appendChild(el('span', '', s.recordLength + ' 字符'));

    const actions = el('div', 'session-actions');
    const rename = el('button', '', '\u270E');
    rename.title = '重命名';
    rename.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void renameSession(s.id, s.title);
    });
    const del = el('button', 'del', '\u00D7');
    del.title = '删除会话';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void deleteSession(s.id, s.title);
    });
    actions.appendChild(rename);
    actions.appendChild(del);

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(actions);
    item.addEventListener('click', () => void switchSession(s.id));
    host.appendChild(item);
  }
}

async function switchSession(id: string): Promise<void> {
  if (!id || id === sessionId) return;
  tts.stop();
  resetSpeakButtons();
  sessionId = id;
  localStorage.setItem('continuousagent.session', id);
  itemEls.clear();
  try {
    await reloadState(id);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
}

async function newSession(): Promise<void> {
  try {
    const data = await api<{ state: AppState }>('/api/sessions', 'POST', {});
    sessionId = data.state.session.id;
    localStorage.setItem('continuousagent.session', sessionId);
    itemEls.clear();
    await reloadState(sessionId);
    toast('已新建会话，任务结束时会自动命名（也可在侧栏手动重命名）');
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
}

async function renameSession(id: string, current: string): Promise<void> {
  const title = window.prompt('重命名会话', current);
  if (title === null) return;
  try {
    await api('/api/sessions/' + encodeURIComponent(id) + '/rename', 'POST', { title });
    await reloadState(sessionId);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
}

async function deleteSession(id: string, title: string): Promise<void> {
  if (!window.confirm('删除会话「' + title + '」？\n其工作记录与笔记会移入工作空间 .trash（7 天内可恢复）。')) return;
  try {
    const data = await api<{ state: AppState }>('/api/sessions/' + encodeURIComponent(id) + '/delete', 'POST');
    if (sessionId === id) {
      sessionId = data.state.session.id;
      localStorage.setItem('continuousagent.session', sessionId);
      itemEls.clear();
    }
    await reloadState(sessionId);
    toast('会话已删除');
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
}

// ---------------------------------------------------------------- 状态加载
async function reloadState(id?: string): Promise<void> {
  const target = id || sessionId;
  const fresh = await api<AppState>('/api/state' + (target ? '?session=' + encodeURIComponent(target) : ''));
  const first = state === null;
  const switched = !!state && state.session.id !== fresh.session.id;
  state = fresh;
  sessionId = fresh.session.id;
  localStorage.setItem('continuousagent.session', sessionId);

  renderSessions();
  applyStatus();
  applyTarget();
  renderTimeline(fresh.timeline, true);
  if (switched || first) timelineEl().scrollTop = timelineEl().scrollHeight;
  const effort = document.getElementById('effortSelect') as HTMLSelectElement | null;
  if (effort) effort.value = fresh.settings.reasoningEffort || 'auto';
  renderGrants();
  renderNativeBanner(fresh.nativeAvailable, fresh.nativeDetail);
  renderDoc();
}

// ---------------------------------------------------------------- 交互绑定
function bind(): void {
  ($('refreshWindows') as HTMLButtonElement).addEventListener('click', () => void refreshWindows());
  ($('newSession') as HTMLButtonElement).addEventListener('click', () => void newSession());

  ($('clearWindow') as HTMLButtonElement).addEventListener('click', async () => {
    try {
      await api('/api/window/clear', 'POST', { sessionId });
      if (state) state.target = null;
      applyTarget();
      toast('已清除目标窗口');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  });

  ($('windowSelect') as HTMLSelectElement).addEventListener('change', async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    if (!value) return;
    try {
      const data = await api<{ state: AppState }>('/api/window/select', 'POST', { pid: Number(value), sessionId });
      if (state) state.target = data.state.target;
      applyTarget();
      toast('已选择目标: ' + (data.state.target?.processName || value));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    }
  });

  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setDocTab(tab.dataset.tab === 'notes' ? 'notes' : 'record'));
  });

  ($('startBtn') as HTMLButtonElement).addEventListener('click', () => void start());
  ($('stopBtn') as HTMLButtonElement).addEventListener('click', () => void stop());
  ($('resetBtn') as HTMLButtonElement).addEventListener('click', () => void reset());
  ($('prompt') as HTMLTextAreaElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void start();
    }
  });

  const effortSelect = $('effortSelect') as HTMLSelectElement;
  effortSelect.addEventListener('change', async () => {
    const value = effortSelect.value;
    try {
      await api('/api/settings', 'POST', { reasoningEffort: value });
      if (state) state.settings.reasoningEffort = value;
      toast('思考强度已设为 ' + value);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    }
  });

  const fileInput = $('fileInput') as HTMLInputElement;
  ($('attachBtn') as HTMLButtonElement).addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) void addFiles(fileInput.files);
    fileInput.value = '';
  });

  const composer = document.querySelector<HTMLElement>('.composer');
  if (composer) {
    composer.addEventListener('dragover', (e) => {
      e.preventDefault();
      composer.classList.add('drag-over');
    });
    composer.addEventListener('dragleave', () => composer.classList.remove('drag-over'));
    composer.addEventListener('drop', (e) => {
      e.preventDefault();
      composer.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
    });
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0 && document.activeElement === ($('prompt') as HTMLElement)) {
        e.preventDefault();
        void addFiles(files);
      }
    });
  }

  $('settingsBtn').addEventListener('click', () => {
    buildSettings();
    $('settingsOverlay').classList.remove('hidden');
  });
  $('closeSettings').addEventListener('click', () => $('settingsOverlay').classList.add('hidden'));
  $('settingsOverlay').addEventListener('click', (e) => {
    if (e.target === $('settingsOverlay')) $('settingsOverlay').classList.add('hidden');
  });

  $('saveSettings').addEventListener('click', async () => {
    try {
      const patch = collectSettings();
      const data = await api<{ state: AppState }>('/api/settings', 'POST', patch);
      state = data.state;
      applyStatus();
      applyTarget();
      const effort = document.getElementById('effortSelect') as HTMLSelectElement | null;
      if (effort) effort.value = state.settings.reasoningEffort || 'auto';
      buildSettings();
      renderDoc();
      toast('设置已保存');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  });

  $('testConnection').addEventListener('click', async () => {
    const hint = $('settingsHint');
    hint.textContent = '正在测试…';
    try {
      // 先保存当前表单，测试才用得上新填入的 Key
      await api('/api/settings', 'POST', collectSettings());
      const r = await api<{ ok: boolean; message: string }>('/api/test-connection', 'POST');
      hint.textContent = r.message;
      toast(r.ok ? '连接成功' : '连接失败: ' + r.message, !r.ok);
    } catch (e) {
      hint.textContent = e instanceof Error ? e.message : String(e);
      toast('测试失败', true);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('settingsOverlay').classList.add('hidden');
    }
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'x')) {
      // 页面内中断快捷键（浏览器无法注册全局热键）
      e.preventDefault();
      void stop();
    }
  });
}

// ---------------------------------------------------------------- 附件
const TEXT_EXTS = ['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'ts', 'tsx', 'js', 'jsx', 'css', 'html',
  'xml', 'csv', 'log', 'py', 'cs', 'cpp', 'h', 'ini', 'toml', 'sql', 'ps1', 'sh'];

function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return TEXT_EXTS.includes(ext);
}

function renderAttachments(): void {
  const host = $('attachList');
  host.innerHTML = '';
  if (pendingAttachments.length === 0) {
    host.classList.add('hidden');
    return;
  }
  host.classList.remove('hidden');
  pendingAttachments.forEach((a, index) => {
    const chip = el('span', 'att-chip pending');
    chip.appendChild(document.createTextNode((a.kind === 'image' ? '\u{1F5BC} ' : '\u{1F4C4} ') + a.name));
    const size = el('span', 'att-size', fmtBytes(a.size));
    chip.appendChild(size);
    const remove = el('button', 'att-remove', '\u00D7') as HTMLButtonElement;
    remove.type = 'button';
    remove.title = '移除附件';
    remove.addEventListener('click', () => {
      pendingAttachments.splice(index, 1);
      renderAttachments();
    });
    chip.appendChild(remove);
    host.appendChild(chip);
  });
  host.appendChild(el('span', 'att-hint', pendingAttachments.length + ' / ' + MAX_ATTACHMENTS + ' · 图片会作为图像发送，文本会拼进提示词'));
}

async function addFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  for (const file of list) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      toast('最多只能添加 ' + MAX_ATTACHMENTS + ' 个附件', true);
      break;
    }
    if (file.size > MAX_ATTACH_BYTES) {
      toast('附件过大（上限 6MB）：' + file.name, true);
      continue;
    }
    const mime = file.type || 'application/octet-stream';
    try {
      if (mime.startsWith('image/')) {
        const dataUrl = await readAsDataUrl(file);
        pendingAttachments.push({ name: file.name, mime, size: file.size, kind: 'image', dataUrl });
      } else if (isTextFile(file)) {
        const text = (await readAsText(file)).slice(0, 60_000);
        pendingAttachments.push({ name: file.name, mime: mime === 'application/octet-stream' ? 'text/plain' : mime, size: file.size, kind: 'text', text });
      } else {
        toast('暂不支持该类型：' + file.name + '（仅图片与文本）', true);
      }
    } catch (err) {
      toast('读取失败: ' + file.name, true);
    }
  }
  renderAttachments();
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function start(): Promise<void> {
  const box = $('prompt') as HTMLTextAreaElement;
  const prompt = box.value.trim();
  if (!prompt && pendingAttachments.length === 0) {
    toast('请先描述任务', true);
    return;
  }
  const attachments = pendingAttachments.map((a) => ({ ...a }));
  if (!prompt) {
    toast('请先描述要让 ContinuousAgent 做什么', true);
    return;
  }
  try {
    await api('/api/agent/start', 'POST', { prompt, sessionId, attachments });
    box.value = '';
    pendingAttachments = [];
    renderAttachments();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
}

async function stop(): Promise<void> {
  try {
    await api('/api/agent/stop', 'POST', { sessionId });
    tts.stop();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
}

async function reset(): Promise<void> {
  try {
    await api('/api/agent/reset', 'POST', { sessionId });
    tts.stop();
    itemEls.clear();
    if (state) state.timeline = [];
    renderTimeline([]);
    toast('已重置对话');
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
}

async function boot(): Promise<void> {
  bind();
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('session') || '';
  const saved = fromUrl || localStorage.getItem('continuousagent.session') || localStorage.getItem('gameagent.session') || '';
  try {
    await reloadState(saved || undefined);
  } catch (e) {
    toast('加载状态失败: ' + (e instanceof Error ? e.message : String(e)), true);
  }
  if (params.get('settings') === '1') {
    buildSettings();
    $('settingsOverlay').classList.remove('hidden');
  }
  connectEvents();
  void refreshWindows();
  window.setInterval(() => {
    if (!state?.status.running) void refreshWindows();
  }, 8000);
}

void boot();