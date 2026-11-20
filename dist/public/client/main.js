import { computeCost, formatMoney, hasPricing, splitInputTokens } from '../shared/pricing.js';
import { getScene, sceneSelectOptions } from '../shared/scenes.js';
import { MarkdownStream, renderMarkdown } from './markdown.js';
import { TtsPlayer } from './tts.js';
const $ = (id) => {
    const el = document.getElementById(id);
    if (!el)
        throw new Error('缺少元素 #' + id);
    return el;
};
let state = null;
let sessionId = '';
let dragTimer;
const itemEls = new Map();
/** 流式渲染器：每条流式消息一个，只处理新增的完整行（见 markdown.ts 的 MarkdownStream）。 */
const streamRenderers = new Map();
/** 思考区的流式渲染器（按 item id 索引，单独一份）。 */
const thinkRenderers = new Map();
/** 待应用的状态补丁：同一帧内的多次更新合并成一次 DOM 写入。 */
const pendingPatches = new Map();
let frameHandle = 0;
const tts = new TtsPlayer(() => state.settings);
/** 当前正在朗读的消息（消息级播放按钮） */
let speakingId = '';
/** 上一次的状态文本，用于“已完成”提示只弹一次 */
let lastStatusText = '';
const MAX_ATTACHMENTS = 8;
const MAX_ATTACH_BYTES = 6 * 1024 * 1024;
let pendingAttachments = [];
function fmtNum(n) {
    return (Number.isFinite(n) ? n : 0).toLocaleString('en-US');
}
// ---------------------------------------------------------------- 价格统计
/** 多模型里被选中的那套配置；未选中（用全局模型）或找不到时返回 null。 */
function activeModelProfile() {
    const s = state?.settings;
    if (!s || !s.activeModelId)
        return null;
    return s.modelProfiles.find((m) => m.id === s.activeModelId) || null;
}
/** 三项单价：当前模型的覆盖优先，未覆盖则回落全局（与服务端 resolveModelSettings 同口径）。 */
function priceTable() {
    const s = state?.settings;
    const p = activeModelProfile();
    return {
        cacheHit: Number(p?.priceCacheHit ?? s?.priceCacheHit) || 0,
        input: Number(p?.priceInput ?? s?.priceInput) || 0,
        output: Number(p?.priceOutput ?? s?.priceOutput) || 0,
    };
}
/** 货币符号同样「当前模型优先」，留空则用全局。 */
function priceCurrency() {
    const p = activeModelProfile();
    return p?.priceCurrency || state?.settings.priceCurrency || '¥';
}
/** 把一条用量换算成金额文本；未配置单价则返回空串（界面不显示金额）。 */
function fmtCost(usage) {
    if (!usage || !state)
        return '';
    const prices = priceTable();
    if (!hasPricing(prices))
        return '';
    return formatMoney(computeCost(usage, prices).total, priceCurrency());
}
/** 输入的两段后缀：命中时给出「命中 X / 未命中 Y」；无命中则返回空串（此时输入全为未命中）。 */
function cacheSplitSuffix(usage, estimated = false) {
    const s = splitInputTokens(usage);
    if (s.hitTokens <= 0)
        return '';
    return '（命中 ' + (estimated ? '≈' : '') + fmtNum(s.hitTokens) + ' / 未命中 ' + fmtNum(s.missTokens) + '）';
}
/**
 * 渲染输入框旁的模型下拉。
 * 只有配置了多模型时才显示；选项第一项是「默认」（用设置里的全局模型）。
 * 服务端已经把每条配置的密钥剥成 hasApiKey，这里不会碰到密钥。
 */
function renderModelSelect() {
    const ctl = document.getElementById('modelCtl');
    const sel = document.getElementById('modelSelect');
    if (!ctl || !sel || !state)
        return;
    const profiles = state.settings.modelProfiles || [];
    if (profiles.length === 0) {
        ctl.classList.add('hidden');
        sel.innerHTML = '';
        return;
    }
    ctl.classList.remove('hidden');
    sel.innerHTML = '';
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = '默认（' + (state.settings.model || '未设置') + '）';
    sel.appendChild(fallback);
    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = (p.name || p.model) + ' · ' + p.model + (p.hasApiKey ? '' : '（无密钥）');
        opt.title = [p.model, p.apiBaseUrl || state.settings.apiBaseUrl].filter(Boolean).join(' @ ');
        sel.appendChild(opt);
    }
    // 服务端会把无效 id 回落成 ''，这里直接采用它的结果，界面不保留非法选中项
    sel.value = profiles.some((p) => p.id === state.settings.activeModelId) ? state.settings.activeModelId : '';
}
/** 一条用量的展示文本：入（命中 X / 未命中 Y）· 出 Z tokens。 */
function usageText(usage) {
    const s = splitInputTokens(usage);
    return '入 ' + fmtNum(s.totalTokens) + cacheSplitSuffix(usage, !!usage.cachedEstimated) +
        ' · 出 ' + fmtNum(usage.completionTokens) + ' tokens';
}
/** 悬浮提示：把「输入 = 命中 + 未命中」写成算式，方便逐项对价格。 */
function usageTitle(usage) {
    const s = splitInputTokens(usage);
    return '输入合计 ' + fmtNum(s.totalTokens) + ' = 缓存命中 ' + fmtNum(s.hitTokens) +
        ' + 未命中 ' + fmtNum(s.missTokens) + '；输出 ' + fmtNum(usage.completionTokens) + ' tokens';
}
function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0)
        return '0 B';
    if (n < 1024)
        return n + ' B';
    if (n < 1024 * 1024)
        return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
}
function resetSpeakButtons() {
    speakingId = '';
    document.querySelectorAll('.play-btn').forEach((b) => {
        b.textContent = '\u{1F50A} 朗读';
        b.classList.remove('playing');
    });
}
function toggleSpeak(item, btn) {
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
function toast(message, isError = false) {
    const el = $('toast');
    el.textContent = message;
    el.className = 'toast' + (isError ? ' err' : '');
    window.clearTimeout(dragTimer);
    dragTimer = window.setTimeout(() => el.classList.add('hidden'), 3800);
}
async function api(url, method = 'GET', body) {
    const resp = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await resp.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    }
    catch {
        data = { error: text };
    }
    if (!resp.ok)
        throw new Error(data?.error || ('HTTP ' + resp.status));
    return data;
}
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
/** 复制文本（优先异步剪贴板，失败回退 execCommand）。 */
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    }
    catch {
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
        }
        catch {
            return false;
        }
    }
}
// Markdown 渲染结果里的交互：代码块“复制”、图片点击放大（事件委托，动态内容无需重新绑定）
document.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!target)
        return;
    const copyBtn = target.closest('[data-md-copy]');
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
    const img = target.closest('img.md-img');
    if (img && img.src) {
        ev.preventDefault();
        window.open(img.src, '_blank');
    }
});
// ---------------------------------------------------------------- 时间线渲染
/** 是否已添加过模型配置（没有时各处提示先去「设置 → 多模型」添加） */
function hasModelConfigured() {
    return (state?.settings.modelProfiles || []).length > 0;
}
function emptyHint() {
    const box = el('div', 'empty-hint');
    box.appendChild(el('div', 'big', '\u{1F41B}'));
    if (!hasModelConfigured()) {
        box.appendChild(el('div', 'title', '还没有添加模型'));
        box.appendChild(el('div', '', '打开右上角「⚙ 设置」→「多模型」→「+ 添加模型」，填模型名、API 地址与密钥后即可开始对话。'));
        const go = el('button', 'btn primary', '去添加模型');
        go.type = 'button';
        go.addEventListener('click', () => openSettings());
        box.appendChild(go);
        return box;
    }
    box.appendChild(el('div', 'title', '还没有对话'));
    box.appendChild(el('div', '', '描述任务后按 Enter 开始；需要操作界面时先选上方目标窗口。'));
    return box;
}
function toolCard(item) {
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
        const img = el('img', 'tool-shot');
        img.src = item.imageUrl;
        img.alt = '截图';
        img.addEventListener('click', () => window.open(item.imageUrl, '_blank'));
        body.appendChild(img);
    }
    // 有截图时默认展开，否则折叠（点击标题切换）
    if (item.expanded || item.imageUrl || item.status === '失败')
        body.classList.remove('hidden');
    else
        body.classList.add('hidden');
    wrap.appendChild(head);
    wrap.appendChild(body);
    head.addEventListener('click', () => {
        const expanded = body.classList.toggle('hidden') === false;
        const cur = state?.timeline.find((i) => i.id === item.id);
        if (cur)
            cur.expanded = expanded;
    });
    return wrap;
}
/**
 * 插件调用审计卡片：把「哪个插件、用途是什么、要执行什么命令」摊开给用户看，
 * 用户点「允许本次 / 本会话允许 / 拒绝」之后才会真正执行。
 */
function pluginAuditCard(item) {
    const wrap = el('div', 'item access plugin');
    const head = el('div', 'access-head');
    head.appendChild(el('span', 'access-title', '\u{1F9E9} 插件调用审计：' + (item.pluginName || item.pluginId || '')));
    const status = item.accessStatus || 'pending';
    head.appendChild(el('span', 'pill ' + (status === 'granted' ? 'ok' : status === 'denied' ? 'err' : ''), status === 'granted' ? '已允许' : status === 'denied' ? '已拒绝' : '待确认'));
    wrap.appendChild(head);
    const meta = el('div', 'plugin-meta');
    meta.appendChild(el('span', 'plugin-tag', (item.pluginName || '') + (item.pluginVersion ? ' v' + item.pluginVersion : '')));
    if (item.pluginId)
        meta.appendChild(el('span', 'plugin-tag', 'id: ' + item.pluginId));
    if (item.pluginTool)
        meta.appendChild(el('span', 'plugin-tag', '工具: ' + item.pluginTool));
    wrap.appendChild(meta);
    wrap.appendChild(el('div', 'access-reason', '用途：' + (item.pluginPurpose || item.accessReason || '（插件未声明用途）')));
    if (item.pluginArgs)
        wrap.appendChild(el('div', 'access-path plugin-args', '参数：' + item.pluginArgs));
    if (item.pluginCommand)
        wrap.appendChild(el('pre', 'plugin-cmd', item.pluginCommand));
    if (item.pluginDir)
        wrap.appendChild(el('div', 'plugin-dir', '插件目录：' + item.pluginDir));
    if (status === 'pending' && item.accessRequestId) {
        const actions = el('div', 'access-actions');
        const onceBtn = el('button', 'btn primary', '允许本次');
        const sessionBtn = el('button', 'btn', '本会话允许');
        const denyBtn = el('button', 'btn ghost', '拒绝');
        for (const b of [onceBtn, sessionBtn, denyBtn])
            b.type = 'button';
        const send = async (decision) => {
            onceBtn.disabled = true;
            sessionBtn.disabled = true;
            denyBtn.disabled = true;
            try {
                await api('/api/plugin/respond', 'POST', { requestId: item.accessRequestId, decision });
            }
            catch (e) {
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
function accessCard(item) {
    if (item.accessKind === 'plugin')
        return pluginAuditCard(item);
    const wrap = el('div', 'item access');
    const head = el('div', 'access-head');
    const kind = item.accessKind === 'read' ? 'read' : 'write';
    const verb = kind === 'read' ? '读取' : '写入';
    head.appendChild(el('span', 'access-title', '\u{1F513} 目录' + verb + '权限申请'));
    const status = item.accessStatus || 'pending';
    head.appendChild(el('span', 'pill ' + (status === 'granted' ? 'ok' : status === 'denied' ? 'err' : ''), status === 'granted' ? '已允许' : status === 'denied' ? '已拒绝' : '待确认'));
    wrap.appendChild(head);
    const pathLine = el('div', 'access-path', item.accessPath || '');
    wrap.appendChild(pathLine);
    if (item.accessReason)
        wrap.appendChild(el('div', 'access-reason', item.accessReason));
    if (status === 'pending' && item.accessRequestId) {
        const actions = el('div', 'access-actions');
        const allow = el('button', 'btn primary', '允许' + verb);
        allow.type = 'button';
        const deny = el('button', 'btn ghost', '拒绝');
        deny.type = 'button';
        const send = async (value) => {
            allow.disabled = true;
            deny.disabled = true;
            try {
                await api('/api/access/respond', 'POST', { requestId: item.accessRequestId, allow: value });
            }
            catch (e) {
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
function thinkingCard(item) {
    const wrap = el('div', 'item thinking');
    const head = el('div', 'thinking-head');
    head.appendChild(el('span', '', '\u{1F9E0} ' + (item.title || '思考')));
    if (item.streaming)
        head.appendChild(el('span', '', '· 进行中'));
    const body = el('div', 'thinking-body md' + (item.expanded ? '' : ' hidden'));
    body.innerHTML = renderMarkdown(item.text);
    wrap.appendChild(head);
    wrap.appendChild(body);
    wrap.addEventListener('click', (e) => {
        if (e.target.closest('a'))
            return;
        const isHidden = body.classList.toggle('hidden');
        const cur = state?.timeline.find((i) => i.id === item.id);
        if (cur)
            cur.expanded = !isHidden;
    });
    return wrap;
}
/** 旧版时间线的完成提示带「收到完成标记 [[DONE]]」前缀：界面上只保留后半句。 */
function systemItemText(text) {
    const t = String(text || '');
    const m = t.match(/^收到完成标记\s*\[\[DONE\]\]\s*[：:]?\s*/);
    if (!m)
        return t;
    const rest = t.slice(m[0].length).trim();
    return rest || '任务结束，已停止自动续跑。';
}
/**
 * 这类 system 项只是运行时给模型/用户的过程信号：界面上不展示（历史时间线里的旧项一并隐藏）。
 * 只按文案前缀判断，服务端数据保持原样，便于回归脚本核对时间线。
 */
const HIDDEN_SYSTEM_PREFIXES = ['提醒模型先规划任务', '已压缩较早的对话历史'];
function isHiddenItem(item) {
    if (item.kind !== 'system')
        return false;
    const text = String(item.text || '').trim();
    return HIDDEN_SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix));
}
function renderItem(item) {
    let node;
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
                const img = el('img', 'att-thumb');
                img.src = item.imageUrl;
                img.alt = '附件图片';
                img.addEventListener('click', () => window.open(item.imageUrl, '_blank'));
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
                const play = el('button', 'play-btn', '\u{1F50A} 朗读');
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
                    if (cost)
                        foot.appendChild(el('span', 'msg-cost', cost));
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
function timelineEl() {
    return $('timeline');
}
function isNearBottom() {
    const t = timelineEl();
    return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function scrollToBottom(force = false) {
    const t = timelineEl();
    if (force || isNearBottom())
        t.scrollTop = t.scrollHeight;
}
function renderTimeline(items, forceScroll = false) {
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
    const visible = items.filter((item) => !isHiddenItem(item));
    if (visible.length === 0) {
        host.appendChild(emptyHint());
        return;
    }
    const frag = document.createDocumentFragment();
    for (const item of visible) {
        const node = renderItem(item);
        itemEls.set(item.id, node);
        frag.appendChild(node);
    }
    host.appendChild(frag);
    if (forceScroll)
        host.scrollTop = host.scrollHeight;
}
function upsertItem(item, forceScroll = false) {
    if (isHiddenItem(item))
        return;
    const host = timelineEl();
    if (itemEls.size === 0 && host.querySelector('.empty-hint'))
        host.innerHTML = '';
    const old = itemEls.get(item.id);
    const node = renderItem(item);
    itemEls.set(item.id, node);
    if (old && old.parentElement)
        old.parentElement.replaceChild(node, old);
    else
        host.appendChild(node);
    scrollToBottom(forceScroll);
}
function patchItem(id, patch) {
    const cur = pendingPatches.get(id);
    pendingPatches.set(id, cur ? { ...cur, ...patch } : { ...patch });
    if (frameHandle)
        return;
    frameHandle = requestAnimationFrame(() => {
        frameHandle = 0;
        flushPatches();
    });
}
function flushPatches() {
    if (pendingPatches.size === 0)
        return;
    const batch = [...pendingPatches];
    pendingPatches.clear();
    // 流式文本追加时保持折叠状态与滚动位置
    const wasNear = isNearBottom();
    for (const [id, patch] of batch)
        applyPatch(id, patch);
    if (wasNear)
        scrollToBottom(true);
}
function applyPatch(id, patch) {
    const item = state?.timeline.find((i) => i.id === id);
    if (!item)
        return;
    Object.assign(item, patch);
    const old = itemEls.get(id);
    if (isHiddenItem(item)) {
        if (old) {
            old.remove();
            itemEls.delete(id);
        }
        return;
    }
    // 流式追加：只就地更新文本节点，不重建整段 DOM
    if (old && patch.streaming !== false && updateStreamingNode(old, item))
        return;
    streamRenderers.delete(item.id);
    thinkRenderers.delete(item.id);
    const node = renderItem(item);
    itemEls.set(id, node);
    if (old && old.parentElement)
        old.parentElement.replaceChild(node, old);
    if (item.kind === 'assistant' && patch.streaming === false && item.text.trim()) {
        resetSpeakButtons();
    }
}
/** 就地更新流式文本节点；不支持就地更新的类型返回 false（回退为整节点重建）。 */
function updateStreamingNode(node, item) {
    if (item.kind === 'assistant') {
        const content = node.querySelector('.content');
        if (!content)
            return false;
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
        const body = node.querySelector('.thinking-body');
        if (!body)
            return false;
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
function applyStatus() {
    if (!state)
        return;
    const chip = $('statusChip');
    const text = state.status.status || '空闲';
    chip.textContent = text;
    chip.className = 'status ' + (state.status.running ? 'running'
        : /已完成/.test(text) ? 'done'
            : /错误|停止/.test(text) ? 'error' : 'idle');
    if (text !== lastStatusText) {
        if (/已完成/.test(text))
            toast('\u2705 模型确认任务完成，运行已停止');
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
    // 输入框下方只留「入 · 出 · 金额」，命中/未命中明细放进悬浮提示（顶部 #usage 仍保留明细）
    const meter = document.getElementById('tokenMeter');
    if (meter) {
        meter.textContent = '入 ' + inTok + ' · 出 ' + outTok + costSuffix;
        meter.title = usageEl.title;
    }
    // 价格左侧：当前工具场景档位（含注入开关状态），随状态刷新同步
    renderSceneMode();
    // 运行中不再禁用发送：改为「插入消息」，点了就把当前输入插进正在跑的任务（下一轮请求生效）
    const startBtn = $('startBtn');
    const running = !!state.status.running;
    startBtn.disabled = false;
    const label = running ? '插入消息' : '开始任务';
    if (startBtn.textContent !== label)
        startBtn.textContent = label;
    startBtn.title = running
        ? '当前任务正在运行：发送的内容会插入本任务，并在下一轮请求生效（不会打断本轮）'
        : '开始一个新任务';
    $('stopBtn').disabled = !state.status.running;
}
/**
 * 当前会话的工具场景。场景是**每个对话单独**的：会话有覆盖记录就用它；
 * 没有记录时回落到全局设置（新会话默认值），此时 inherited=true。
 */
function currentScene() {
    if (state && state.scene)
        return state.scene;
    const s = state ? state.settings : null;
    return {
        toolScene: s ? s.toolScene : 'general',
        sceneGuideEnabled: s ? s.sceneGuideEnabled : true,
        inherited: true,
    };
}
/** 保存会话级场景：只写当前会话的元数据，绝不改全局设置，因此不影响其它对话 */
async function saveScene(patch) {
    const sid = state ? state.session.id : '';
    if (!sid)
        return;
    try {
        const res = await api('/api/sessions/' + encodeURIComponent(sid) + '/scene', 'POST', patch);
        if (state && res && res.scene)
            state.scene = res.scene;
        renderSceneMode();
        if (!($('settingsOverlay').classList.contains('hidden')) && activeSection === 'scene')
            buildSettings();
        toast('已更新本会话的工具场景（只影响当前对话）');
    }
    catch (err) {
        let msg = err instanceof Error ? err.message : String(err);
        // 改了代码但服务端没重启时该路由还不存在：直接说清原因，别让用户看到裸的 HTTP 404
        if (/^\s*HTTP 404\s*$|not found/i.test(msg))
            msg = '服务端尚未重启，会话级场景接口暂不可用（重启后生效）';
        toast('更新场景失败：' + msg, true);
    }
}
/** 输入框下方价格左侧的场景标记：显示**当前会话**的工具场景档位，点击打开设置「工具场景」分区 */
function renderSceneMode() {
    const host = document.getElementById('sceneMode');
    if (!host || !state)
        return;
    const cur = currentScene();
    const scene = getScene(cur.toolScene);
    const general = cur.toolScene === 'general';
    const guided = !general && !!cur.sceneGuideEnabled;
    host.textContent = general
        ? '场景 通用'
        : '场景 ' + scene.label + (cur.sceneGuideEnabled ? '' : '（未注入）');
    host.classList.toggle('on', guided);
    host.classList.toggle('off', !guided);
    const scope = cur.inherited
        ? '；本会话尚未单独设置，沿用全局默认值（改动只影响本会话）'
        : '；本会话单独设置，其它对话不受影响';
    host.title = general
        ? '当前工具场景：通用（不注入场景工具指引，工具描述也不做场景增强；点击打开设置）' + scope
        : (cur.sceneGuideEnabled
            ? '当前工具场景：' + scene.label + '（' + scene.tagline + '）；每轮请求会注入该场景的工具用法指引' + scope
            : '当前工具场景：' + scene.label + '，但注入开关已关闭，只保留工具描述增强' + scope);
}
function renderGrants() {
    const chip = document.getElementById('grantsChip');
    if (!chip || !state)
        return;
    const list = state.grants || [];
    const readable = state.readGrants || [];
    const count = document.getElementById('grantsCount');
    const pop = document.getElementById('grantsPop');
    const total = list.length + readable.length;
    if (total === 0) {
        chip.classList.add('hidden');
        if (count)
            count.textContent = '0';
        if (pop)
            pop.innerHTML = '';
        chip.title = '';
        return;
    }
    chip.classList.remove('hidden');
    if (count)
        count.textContent = String(total);
    if (!pop)
        return;
    const host = pop;
    host.innerHTML = '';
    host.appendChild(el('div', 'grants-pop-head', '本会话已授权 ' + total + ' 个目录'));
    const addGroup = (title, items, cls) => {
        const box = el('div', 'grants-group ' + cls);
        box.appendChild(el('div', 'grants-group-title', title + ' · ' + items.length));
        for (const p of items)
            box.appendChild(el('div', 'grants-path', p));
        host.appendChild(box);
    };
    if (list.length > 0)
        addGroup('可写目录', list, 'write');
    if (readable.length > 0)
        addGroup('只读目录', readable, 'read');
    host.appendChild(el('div', 'grants-pop-foot', '仅本会话内有效；删除会话后失效'));
}
let docTab = 'record';
/** 统计「## 任务计划」小节内的清单完成度；没有该小节时统计全文。 */
function countPlanTasks(md) {
    const lines = md.split(/\r?\n/);
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
        if (!/^##\s/.test(lines[i]))
            continue;
        if (start < 0) {
            if (/^##\s*任务计划/.test(lines[i]))
                start = i + 1;
            continue;
        }
        end = i;
        break;
    }
    const scope = start >= 0 ? lines.slice(start, end) : lines;
    let done = 0;
    let total = 0;
    for (const line of scope) {
        const m = /^\s*[-*+]\s*\[([ xX])\]/.exec(line);
        if (!m)
            continue;
        total += 1;
        if (m[1] !== ' ')
            done += 1;
    }
    return { done, total };
}
/** 字符数胶囊文案：1234 → 1.2k。 */
function fmtChars(n) {
    if (n < 1000)
        return String(n);
    const k = n / 1000;
    return (k < 10 ? k.toFixed(1) : String(Math.round(k))) + 'k';
}
function renderDoc() {
    if (!state)
        return;
    const md = docTab === 'record' ? state.record : state.notes;
    const meta = $('docMeta');
    meta.innerHTML = '';
    let ratio = 0;
    if (docTab === 'record') {
        const pathEl = el('span', 'doc-meta-path', 'sessions/' + state.session.id + '/');
        pathEl.title = 'sessions/' + state.session.id + '/ · 阶段性整份覆盖';
        meta.appendChild(pathEl);
        const tasks = countPlanTasks(state.record);
        if (tasks.total > 0) {
            const allDone = tasks.done >= tasks.total;
            meta.appendChild(el('span', 'doc-meta-pill' + (allDone ? ' ok' : ''), '清单 ' + tasks.done + '/' + tasks.total));
            ratio = tasks.done / tasks.total;
        }
        meta.appendChild(el('span', 'doc-meta-pill', fmtChars(state.record.length) + ' 字'));
    }
    else {
        const label = el('span', 'doc-meta-path', '长期工作笔记');
        label.title = '长期工作笔记 · 上限 ' + state.notesMax + ' 字符';
        meta.appendChild(label);
        ratio = state.notesMax > 0 ? Math.min(1, state.notesLength / state.notesMax) : 0;
        const cls = ratio >= 0.9 ? ' warn' : ratio >= 0.7 ? ' ok' : '';
        meta.appendChild(el('span', 'doc-meta-pill' + cls, fmtChars(state.notesLength) + ' / ' + fmtChars(state.notesMax)));
    }
    // 底部 2px 进度线：工作记录=清单完成度，工作笔记=容量占用
    const bar = el('div', 'doc-progress');
    const fill = el('i', '');
    fill.style.width = Math.round(ratio * 100) + '%';
    bar.appendChild(fill);
    meta.appendChild(bar);
    $('docView').innerHTML = renderMarkdown(md || '（空）');
}
function setDocTab(tab) {
    docTab = tab;
    document.querySelectorAll('.tab').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    renderDoc();
}
// ---------------------------------------------------------------- 目标窗口
function applyTarget() {
    if (!state)
        return;
    const t = state.target;
    const select = $('windowSelect');
    if (t) {
        const exists = [...select.options].some((o) => o.value === String(t.pid));
        if (!exists) {
            const opt = new Option(t.processName + ' · ' + t.title + ' (' + t.pid + ')', String(t.pid));
            select.appendChild(opt);
        }
        select.value = String(t.pid);
    }
    else {
        select.value = '';
    }
}
async function refreshWindows() {
    const select = $('windowSelect');
    try {
        const data = await api('/api/windows');
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
            if (!exists)
                select.appendChild(new Option('当前: PID ' + current, String(current)));
            select.value = String(current);
        }
        if (state)
            state.nativeAvailable = data.nativeAvailable;
        renderNativeBanner(data.nativeAvailable, data.detail);
    }
    catch (e) {
        toast('刷新窗口失败: ' + (e instanceof Error ? e.message : String(e)), true);
    }
}
function nativeDetail() {
    return state?.nativeDetail || '';
}
function renderNativeBanner(available, detail) {
    const banner = $('nativeBanner');
    if (available === undefined)
        available = state?.nativeAvailable ?? false;
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
function handleEvent(event) {
    if (!state)
        return;
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
        if (event.available)
            void refreshWindows();
        return;
    }
    // 其它事件都属于某个会话：不是当前会话就忽略（避免串台）
    if ('sessionId' in event && event.sessionId !== sessionId)
        return;
    switch (event.type) {
        case 'state':
            state.status = event.status;
            applyStatus();
            break;
        case 'item_add':
            state.timeline.push(event.item);
            if (state.timeline.length > 400)
                state.timeline.splice(0, state.timeline.length - 400);
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
            if (docTab === 'record')
                renderDoc();
            break;
        case 'notes':
            state.notes = event.markdown;
            state.notesLength = event.length;
            if (docTab === 'notes')
                renderDoc();
            break;
        case 'target':
            state.target = event.target;
            applyTarget();
            break;
        case 'scene':
            // 会话级场景被改（本窗口或模型调用 set_scene）：同步标记与设置面板
            state.scene = event.scene;
            renderSceneMode();
            if (activeSection === 'scene' && !$('settingsOverlay').classList.contains('hidden'))
                buildSettings();
            break;
        default:
            break;
    }
}
function connectEvents() {
    const es = new EventSource('/api/events');
    es.onmessage = (msg) => {
        try {
            handleEvent(JSON.parse(msg.data));
        }
        catch {
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
/** 价格统计的口径说明（原「价格统计」分区的说明文字，并入多模型后仍完整保留） */
const PRICING_NOTE = '价格统计：单价按「每百万 tokens」填写（与主流厂商报价口径一致），金额 = tokens / 1000000 × 单价。输入 token 拆成两段分别计价：命中的部分按「缓存命中单价」、未命中的部分按「缓存未命中单价」，输出单独计价；三项都填 0 表示不计费，界面上不显示金额。缓存命中数优先采用服务商上报值（OpenAI 的 prompt_tokens_details.cached_tokens、DeepSeek 的 prompt_cache_hit_tokens）；接口未上报时按「上一条请求的输入前缀被复用」估算，属于预估值（界面显示为 ≈）。';
const SECTIONS = [
    {
        id: 'appearance',
        title: '外观',
        note: '切换界面主题。选择后立即预览，点下面的保存按钮才会持久化到服务端设置。',
        fields: [
            {
                key: 'theme', label: '主题', type: 'select',
                options: [
                    { value: 'dark', label: '深色（默认）' },
                    { value: 'light', label: '白天' },
                ],
                hint: '白天主题适合强光环境；深色主题适合长时间阅读',
            },
        ],
    },
    {
        id: 'scene',
        title: '工具场景',
        // 场景是会话级设置（每个对话各存一份），因此这里没有全局字段：控件由 buildSettings 单独渲染，
        // 改动立即写入当前会话，不经过「保存设置」按钮，也不会覆盖其它对话。
        note: '场景是每个对话单独的设置：在这里改动只影响当前会话，多会话并行时各对话按各自的场景注入指引，互不干扰。不同任务类型适用不同的工具组合与操作套路；选定场景后，该会话每轮请求的提示词会注入对应指引（推荐工具链 / 操作要点 / 常见失效），并据此增强相关工具描述。选「通用」不注入指引。',
        fields: [],
    },
    {
        id: 'models',
        title: '多模型',
        note: '模型都在下面这张清单里配置：每套模型自带 API 地址、模型名、密钥、思考强度、Temperature、最大输出 tokens、是否关闭思考与单价，保存后即可在聊天输入框旁的下拉里切换。密钥只保存在服务端，不会回传到浏览器。',
        fields: [],
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
let activeSection = 'models';
/** 设置面板「全局技巧库」分区：拉取并列出条目名单（只读，不改写磁盘）。 */
async function loadTipsList(host) {
    let data = null;
    try {
        data = await api('/api/tips');
    }
    catch (e) {
        if (!host.isConnected)
            return;
        host.innerHTML = '';
        host.appendChild(el('p', 'section-note', '读取条目失败：' + (e instanceof Error ? e.message : String(e))));
        return;
    }
    if (!host.isConnected)
        return;
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
/** 数字型覆盖的草稿文本：undefined（没覆盖）显示为空，让用户一眼看出「用默认值」 */
function overrideNumText(v) {
    return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}
/** 设置面板里的多模型草稿：打开面板时从 state 同步，保存时整体回传 */
let modelDrafts = [];
/** 草稿里当前选中的模型 id（空字符串 = 用默认配置） */
let modelActiveId = '';
/** 是否真的编辑过多模型（没打开过该分区就不提交，避免误清空已有配置） */
let modelDirty = false;
/** 多模型分区是否渲染过（决定保存时是否收集 DOM 里的编辑） */
let modelSectionRendered = false;
function syncModelDrafts() {
    const list = state?.settings.modelProfiles || [];
    modelDrafts = list.map((m) => ({
        id: m.id, name: m.name, apiBaseUrl: m.apiBaseUrl, model: m.model, hasApiKey: m.hasApiKey,
        reasoningEffort: m.reasoningEffort || '',
        temperature: overrideNumText(m.temperature),
        maxOutputTokens: overrideNumText(m.maxOutputTokens),
        disableThinking: m.disableThinking === undefined ? '' : (m.disableThinking ? 'on' : 'off'),
        priceCacheHit: overrideNumText(m.priceCacheHit),
        priceInput: overrideNumText(m.priceInput),
        priceOutput: overrideNumText(m.priceOutput),
        priceCurrency: m.priceCurrency || '',
    }));
    modelActiveId = state?.settings.activeModelId || '';
    modelDirty = false;
}
function nextModelId() {
    let n = 1;
    while (modelDrafts.some((d) => d.id === 'm' + n))
        n += 1;
    return 'm' + n;
}
/** 把界面上的编辑读回草稿（切换分区、增删条目之前调用，避免丢编辑） */
function readModelRows() {
    const rows = document.querySelectorAll('.model-row');
    if (rows.length === 0)
        return;
    const byId = new Map();
    rows.forEach((row) => {
        const id = row.dataset.id || '';
        if (!id)
            return;
        const get = (sel) => (row.querySelector(sel)?.value ?? '');
        byId.set(id, {
            id,
            name: get('.model-name').trim(),
            apiBaseUrl: get('.model-base').trim(),
            model: get('.model-id').trim(),
            hasApiKey: modelDrafts.find((d) => d.id === id)?.hasApiKey ?? false,
            reasoningEffort: get('.model-effort'),
            temperature: get('.model-temp').trim(),
            maxOutputTokens: get('.model-out').trim(),
            disableThinking: get('.model-nothink'),
            priceCacheHit: get('.model-price-hit').trim(),
            priceInput: get('.model-price-input').trim(),
            priceOutput: get('.model-price-output').trim(),
            priceCurrency: get('.model-currency').trim(),
        });
    });
    modelDrafts = modelDrafts.map((d) => byId.get(d.id) || d);
}
function modelField(label, cls, value, placeholder, type = 'text', hint = '') {
    const wrap = el('div', 'field');
    wrap.appendChild(el('label', '', label));
    const input = el('input');
    input.type = type;
    input.className = cls;
    input.value = value;
    if (placeholder)
        input.placeholder = placeholder;
    input.addEventListener('input', () => {
        modelDirty = true;
    });
    wrap.appendChild(input);
    if (hint)
        wrap.appendChild(el('div', 'hint', hint));
    return wrap;
}
/** 下拉型覆盖项：value 为空串 = 用默认值（与文本框留空同义） */
function modelSelect(label, cls, value, options, hint = '') {
    const wrap = el('div', 'field');
    wrap.appendChild(el('label', '', label));
    const sel = el('select');
    sel.className = cls;
    for (const [v, text] of options) {
        const opt = el('option', '', text);
        opt.value = v;
        sel.appendChild(opt);
    }
    sel.value = value;
    sel.addEventListener('change', () => {
        modelDirty = true;
    });
    wrap.appendChild(sel);
    if (hint)
        wrap.appendChild(el('div', 'hint', hint));
    return wrap;
}
function renderModelSection(body) {
    modelSectionRendered = true;
    body.appendChild(el('p', 'section-note', '保存后，聊天输入框旁会出现「模型」下拉，可随时切换，切换后下一轮请求即用新模型。' +
        '每套模型的密钥只保存在服务端；留空的项（思考强度、Temperature、最大输出 tokens、' +
        '是否关闭思考、三项单价与货币符号）用输入框占位文案里显示的默认值。'));
    const host = el('div', 'model-list');
    host.id = 'modelList';
    body.appendChild(host);
    renderModelList(host);
}
/** 清掉上一次「多 API 测试」留在模型行头的标记。 */
function clearTestMarks() {
    for (const old of Array.from(document.querySelectorAll('.model-row-test')))
        old.remove();
}
/** 把每条测试结果标到对应的模型行头；清单外的目标（全局配置）只体现在面板底部汇总里。 */
function paintTestResults(results) {
    clearTestMarks();
    for (const r of results) {
        if (!r.id)
            continue;
        const row = document.querySelector('.model-row[data-id="' + r.id + '"]');
        const head = row ? row.querySelector('.model-row-head') : null;
        if (!head)
            continue;
        const tag = el('span', 'model-row-test ' + (r.ok ? 'ok' : 'bad'), (r.ok ? '可用 ' : '失败 ') + r.keyTail + ' · ' + r.ms + 'ms');
        tag.title = r.message;
        head.appendChild(tag);
    }
}
/** 只重画模型清单：增删、切换当前都不重画整个分区，避免丢掉上面字段里未保存的编辑 */
function renderModelList(host) {
    host.innerHTML = '';
    if (modelDrafts.length === 0) {
        const empty = el('div', 'model-empty');
        empty.appendChild(el('div', 'model-empty-title', '还没有添加模型'));
        empty.appendChild(el('div', 'model-empty-text', '点下面「+ 添加模型」新增一套：填模型名、API 地址和密钥即可开始使用；名称、参数与单价可按需填写。'));
        host.appendChild(empty);
    }
    for (const d of modelDrafts) {
        const row = el('div', 'model-row' + (d.id === modelActiveId ? ' current' : ''));
        row.dataset.id = d.id;
        const head = el('div', 'model-row-head');
        head.appendChild(el('span', 'model-row-id', d.id));
        if (d.id === modelActiveId)
            head.appendChild(el('span', 'model-row-badge', '当前使用'));
        // 行头的密钥来源提示已按要求隐藏；同样的信息由下方密钥输入框的 placeholder 承担
        const actions = el('div', 'model-row-actions');
        const useBtn = el('button', 'model-row-btn', d.id === modelActiveId ? '已在使用' : '设为当前');
        useBtn.type = 'button';
        useBtn.disabled = d.id === modelActiveId;
        useBtn.addEventListener('click', () => {
            readModelRows();
            modelActiveId = d.id;
            modelDirty = true;
            renderModelList(host);
        });
        const delBtn = el('button', 'model-row-btn danger', '删除');
        delBtn.type = 'button';
        delBtn.addEventListener('click', () => {
            readModelRows();
            modelDrafts = modelDrafts.filter((x) => x.id !== d.id);
            if (modelActiveId === d.id)
                modelActiveId = '';
            modelDirty = true;
            renderModelList(host);
        });
        actions.appendChild(useBtn);
        actions.appendChild(delBtn);
        head.appendChild(actions);
        row.appendChild(head);
        const fields = el('div', 'model-row-fields');
        const g = state?.settings;
        // 占位文案统一写成「默认（当前值）」：留空即用该默认值（界面上不再有独立的全局输入项）
        const defNum = (v) => '默认（' + String(v ?? 0) + '）';
        fields.appendChild(modelField('名称', 'model-name', d.name, '例如 快速 / 深思'));
        fields.appendChild(modelField('模型名', 'model-id', d.model, '必填，例如 gpt-4o-mini'));
        fields.appendChild(modelField('API 地址', 'model-base', d.apiBaseUrl, '必填，例如 https://api.deepseek.com/v1'));
        fields.appendChild(modelField('密钥', 'model-key', '', d.hasApiKey ? '已保存（留空不修改）' : '必填，例如 sk-…', 'password'));
        // ---- 可选项：留空 / 选「默认」即用括号里显示的默认值 ----
        fields.appendChild(modelSelect('思考强度', 'model-effort', d.reasoningEffort, [
            ['', '默认（' + String(g?.reasoningEffort || 'auto') + '）'],
            ['auto', 'auto（不附带 reasoning_effort）'],
            ['minimal', 'minimal'],
            ['low', 'low'],
            ['medium', 'medium'],
            ['high', 'high'],
        ]));
        fields.appendChild(modelField('Temperature', 'model-temp', d.temperature, '默认（' + String(g?.temperature ?? 1) + '）', 'number', '留空 = 用默认值'));
        fields.appendChild(modelField('最大输出 tokens', 'model-out', d.maxOutputTokens, '默认（' + String(g?.maxOutputTokens ?? 8192) + '）', 'number', '留空 = 用默认值'));
        fields.appendChild(modelSelect('关闭模型思考', 'model-nothink', d.disableThinking, [
            ['', '默认（' + (g?.disableThinking ? '关闭' : '保留') + '）'],
            ['on', '关闭思考'],
            ['off', '保留思考'],
        ]));
        fields.appendChild(modelField('缓存命中输入单价', 'model-price-hit', d.priceCacheHit, defNum(g?.priceCacheHit), 'number', '每百万 tokens；留空 = 用默认值'));
        fields.appendChild(modelField('缓存未命中输入单价', 'model-price-input', d.priceInput, defNum(g?.priceInput), 'number', '每百万 tokens；留空 = 用默认值'));
        fields.appendChild(modelField('输出单价', 'model-price-output', d.priceOutput, defNum(g?.priceOutput), 'number', '每百万 tokens；留空 = 用默认值'));
        fields.appendChild(modelField('货币符号', 'model-currency', d.priceCurrency, '默认（' + String(g?.priceCurrency || '¥') + '）', 'text', '留空 = 用默认值'));
        row.appendChild(fields);
        host.appendChild(row);
    }
    const addBtn = el('button', 'model-add', '+ 添加模型');
    addBtn.type = 'button';
    addBtn.disabled = modelDrafts.length >= 12;
    addBtn.title = modelDrafts.length >= 12 ? '最多 12 套配置' : '新增一套模型配置';
    addBtn.addEventListener('click', () => {
        readModelRows();
        modelDrafts = modelDrafts.concat({
            id: nextModelId(), name: '', apiBaseUrl: '', model: '', hasApiKey: false,
            // 新行与第一行字段完全一致，初始全部留空 = 用默认值
            reasoningEffort: '', temperature: '', maxOutputTokens: '', disableThinking: '',
            priceCacheHit: '', priceInput: '', priceOutput: '', priceCurrency: '',
        });
        modelDirty = true;
        renderModelList(host);
    });
    host.appendChild(addBtn);
}
/** 收集多模型编辑结果；没碰过这个分区就返回 null（不提交，保持服务端原值） */
function collectModelProfiles() {
    if (!modelDirty && !modelSectionRendered)
        return null;
    readModelRows();
    const keyById = new Map();
    document.querySelectorAll('.model-row').forEach((row) => {
        const id = row.dataset.id || '';
        const key = (row.querySelector('.model-key')?.value ?? '').trim();
        if (id && key)
            keyById.set(id, key);
    });
    const profiles = [];
    for (const d of modelDrafts) {
        if (!d.model.trim())
            continue;
        const item = {
            id: d.id, name: d.name, apiBaseUrl: d.apiBaseUrl, model: d.model,
            // 覆盖项原样回传：空串由服务端 sanitize 解析成「不覆盖（用默认值）」
            reasoningEffort: d.reasoningEffort,
            temperature: d.temperature,
            maxOutputTokens: d.maxOutputTokens,
            priceCacheHit: d.priceCacheHit,
            priceInput: d.priceInput,
            priceOutput: d.priceOutput,
            priceCurrency: d.priceCurrency,
        };
        if (d.disableThinking === 'on')
            item.disableThinking = true;
        if (d.disableThinking === 'off')
            item.disableThinking = false;
        const key = keyById.get(d.id);
        if (key)
            item.apiKey = key;
        profiles.push(item);
    }
    return { modelProfiles: profiles, activeModelId: modelActiveId };
}
function buildSettings() {
    if (!state)
        return;
    const nav = $('settingsNav');
    const body = $('settingsBody');
    nav.innerHTML = '';
    body.innerHTML = '';
    for (const section of SECTIONS) {
        const btn = el('button', section.id === activeSection ? 'active' : '', section.title);
        btn.type = 'button';
        btn.addEventListener('click', () => {
            if (modelSectionRendered)
                readModelRows();
            activeSection = section.id;
            buildSettings();
        });
        nav.appendChild(btn);
    }
    const section = SECTIONS.find((s) => s.id === activeSection) || SECTIONS[0];
    body.appendChild(el('h3', 'section-title', section.title));
    if (section.note)
        body.appendChild(el('p', 'section-note', section.note));
    if (section.id === 'tips' && state.tips) {
        const t = state.tips;
        body.appendChild(el('p', 'section-note', '当前：' + t.count + ' 条 / ' + t.chars + ' 字符（上限 ' + t.max + '）；' +
            (state.settings.globalTipsEnabled ? '已开启，会附加到每次请求末尾。' : '已关闭，不会附加。')));
        const host = el('div', 'tips-list');
        host.appendChild(el('p', 'section-note', '正在读取条目名单…'));
        body.appendChild(host);
        void loadTipsList(host);
    }
    if (section.id === 'scene') {
        // 会话级场景：控件改动立即写当前会话（不走全局「保存设置」），避免多会话互相覆盖
        const cur = currentScene();
        const sc = getScene(cur.toolScene);
        const sid = state.session ? state.session.id : '';
        body.appendChild(el('p', 'section-note', '作用范围：仅当前会话「' + (state.session ? (state.session.title || sid) : '未选择') + '」（' + sid + '）' +
            (cur.inherited ? '；尚未单独设置，当前沿用全局默认值' : '；已单独设置，其它对话保持各自的场景')));
        const grid = el('div', 'settings-grid');
        const selWrap = el('div', 'field');
        const selLabel = el('label', '', '本会话场景');
        selLabel.htmlFor = 'f_scene_toolScene';
        selWrap.appendChild(selLabel);
        const sel = el('select');
        sel.id = 'f_scene_toolScene';
        for (const o of sceneSelectOptions())
            sel.appendChild(new Option(o.label, o.value));
        sel.value = cur.toolScene;
        sel.addEventListener('change', () => { void saveScene({ toolScene: sel.value }); });
        selWrap.appendChild(sel);
        selWrap.appendChild(el('div', 'hint', '改动立即写入本会话；模型也可用 set_scene 工具在本会话内运行时切换（例如从调研转到改代码）'));
        grid.appendChild(selWrap);
        const boxWrap = el('div', 'field check');
        const box = el('input');
        box.type = 'checkbox';
        box.id = 'f_scene_guide';
        box.checked = !!cur.sceneGuideEnabled;
        box.addEventListener('change', () => { void saveScene({ sceneGuideEnabled: box.checked }); });
        const boxText = el('div', 'check-text');
        const boxLabel = el('label', '', '注入场景工具指引');
        boxLabel.htmlFor = box.id;
        boxText.appendChild(boxLabel);
        boxText.appendChild(el('div', 'hint', '关闭后本会话只保留「按场景增强工具描述」，不再在提示词里注入场景指引段落'));
        boxWrap.appendChild(box);
        boxWrap.appendChild(boxText);
        grid.appendChild(boxWrap);
        body.appendChild(grid);
        // 预览：本会话实际会注入的内容
        body.appendChild(el('p', 'section-note', cur.toolScene === 'general'
            ? '当前场景：通用（不注入场景指引，工具描述也不做场景增强）'
            : (cur.sceneGuideEnabled
                ? '当前按「' + sc.label + '」注入：' + sc.tagline
                : '当前档位「' + sc.label + '」，但注入开关已关闭（只保留工具描述增强）')));
        if (sc.tools.length > 0) {
            body.appendChild(el('p', 'section-note', '推荐工具链：' + sc.tools.join(' → ')));
        }
        if (sc.rules.length > 0) {
            body.appendChild(el('p', 'section-note', '操作要点：' + sc.rules.join('；')));
        }
        if (sc.pitfalls.length > 0) {
            body.appendChild(el('p', 'section-note', '常见失效：' + sc.pitfalls.join('；')));
        }
        body.appendChild(el('p', 'section-note', '模型也可以在任务性质变化时用 set_scene 工具在本会话内自行切换，切换会立即落盘并广播到所有窗口。'));
    }
    if (section.id === 'backup' && state.backups) {
        const b = state.backups;
        body.appendChild(el('p', 'section-note', '目录：' + b.folder + '；当前 ' + b.count + ' 份 / ' + fmtBytes(b.bytes) +
            '（上限 ' + b.max + ' 份）' + (b.enabled ? '；已开启。' : '；已关闭，不再产生新备份。')));
    }
    if (section.id === 'plugins' && state.plugins) {
        const p = state.plugins;
        body.appendChild(el('p', 'section-note', '目录：' + p.dir + '；插件 ' + p.items.length + ' 个，可用工具 ' +
            p.items.reduce((n, it) => n + (it.enabled ? it.tools.length : 0), 0) + ' 个；累计审计 ' + p.auditCount + ' 次' +
            (p.enabled ? '；已启用。' : '；已关闭，插件工具不会下发给模型。')));
        body.appendChild(el('p', 'section-note', '每个插件可以单独开启/关闭（立即生效；关闭后其工具从工具清单与提示词中撤下），也可以删除——目录会移入回收站 ' +
            p.trashDir + '，需要时可手工拷回。'));
        const reloadBtn = el('button', 'tips-refresh', '重新扫描插件目录');
        reloadBtn.type = 'button';
        reloadBtn.addEventListener('click', () => {
            reloadBtn.disabled = true;
            void (async () => {
                try {
                    const data = await api('/api/plugins/reload', 'POST', {});
                    if (state && data?.plugins)
                        state.plugins = data.plugins;
                    buildSettings();
                    toast('已重新扫描：' + (data?.plugins?.items.length ?? 0) + ' 个插件');
                }
                catch (e) {
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
            rowHead.appendChild(el('span', 'pill ' + (item.error ? 'err' : item.enabled ? 'ok' : ''), item.error ? '加载失败' : item.enabled ? '启用' : '已禁用'));
            // 独立开关：加载失败的插件不允许开启；切换后服务端立即重建工具清单
            const toggleBtn = el('button', 'plugin-row-btn', item.enabled ? '关闭' : '开启');
            toggleBtn.type = 'button';
            toggleBtn.disabled = !!item.error;
            toggleBtn.title = item.error
                ? '该插件加载失败，无法开启'
                : item.enabled ? '关闭该插件：立即把它的工具从清单里撤下' : '开启该插件：立即把它的工具加入清单';
            toggleBtn.addEventListener('click', () => {
                toggleBtn.disabled = true;
                void (async () => {
                    try {
                        const data = await api('/api/plugins/toggle', 'POST', { id: item.id, enabled: !item.enabled });
                        if (state && data?.plugins)
                            state.plugins = data.plugins;
                        buildSettings();
                        toast((item.enabled ? '已关闭插件：' : '已开启插件：') + item.id +
                            '（当前可用工具 ' + (data?.availableToolCount ?? 0) + ' 个）');
                    }
                    catch (e) {
                        toast(e instanceof Error ? e.message : String(e), true);
                        toggleBtn.disabled = false;
                    }
                })();
            });
            rowHead.appendChild(toggleBtn);
            // 删除：移入回收站，必须二次确认
            const delBtn = el('button', 'plugin-row-btn danger', '删除');
            delBtn.type = 'button';
            delBtn.title = '删除该插件：目录移入回收站，可手工找回';
            delBtn.addEventListener('click', () => {
                if (!window.confirm('删除插件「' + item.name + '」（' + item.id + '）？\n插件目录会移入回收站：' + p.trashDir + '\n需要时可以手工拷回。'))
                    return;
                delBtn.disabled = true;
                void (async () => {
                    try {
                        const data = await api('/api/plugins/remove', 'POST', { id: item.id });
                        if (state && data?.plugins)
                            state.plugins = data.plugins;
                        buildSettings();
                        toast('已删除插件：' + item.id + '（已移入回收站，可手工找回）');
                    }
                    catch (e) {
                        toast(e instanceof Error ? e.message : String(e), true);
                        delBtn.disabled = false;
                    }
                })();
            });
            rowHead.appendChild(delBtn);
            row.appendChild(rowHead);
            row.appendChild(el('div', 'plugin-row-purpose', item.error ? '错误：' + item.error : '用途：' + item.purpose));
            row.appendChild(el('div', 'plugin-row-tools', '工具：' +
                (item.tools.length ? item.tools.map((t) => t.globalName).join('、') : '（无）')));
            if (item.overridden && !item.error) {
                row.appendChild(el('div', 'plugin-row-tools', '开关来源：手动设置（清单声明为' + (item.manifestEnabled ? '启用' : '禁用') + '）'));
            }
            host.appendChild(row);
        }
        body.appendChild(host);
    }
    const grid = el('div', 'settings-grid');
    let i = 0;
    for (const f of section.fields) {
        const value = f.secret ? '' : state.settings[f.key];
        if (f.type === 'checkbox') {
            const wrap = el('div', 'field check');
            const input = el('input');
            input.type = 'checkbox';
            input.id = 'f_' + f.key;
            input.checked = !!value;
            const label = el('label', '', f.label);
            label.htmlFor = input.id;
            // 勾选框靠左，标题与说明竖排在右：长 hint 不再被丢弃
            const text = el('div', 'check-text');
            text.appendChild(label);
            if (f.hint)
                text.appendChild(el('div', 'hint', f.hint));
            wrap.appendChild(input);
            wrap.appendChild(text);
            grid.appendChild(wrap);
            continue;
        }
        const wrap = el('div', 'field');
        const label = el('label', '', f.label);
        label.htmlFor = 'f_' + f.key;
        wrap.appendChild(label);
        let input;
        if (f.type === 'select') {
            input = el('select');
            for (const o of f.options || []) {
                const opt = new Option(o.label, o.value);
                input.appendChild(opt);
            }
            input.value = String(value ?? '');
            if (f.key === 'theme') {
                // 主题不需要等保存，选完立刻预览
                input.addEventListener('change', () => applyTheme(input.value));
            }
        }
        else if (f.type === 'textarea') {
            input = el('textarea');
            input.value = String(value ?? '');
            // 长文本跨满整行，避免被挤在半栏里
            wrap.classList.add('wide');
        }
        else {
            input = el('input');
            input.type = f.type;
            if (f.min !== undefined)
                input.min = String(f.min);
            if (f.max !== undefined)
                input.max = String(f.max);
            if (f.step !== undefined)
                input.step = String(f.step);
            if (f.secret) {
                input.value = '';
                input.placeholder = f.secret === 'apiKey'
                    ? (state.settings.hasApiKey ? '已保存（留空不修改）' : '未设置')
                    : (state.settings.hasCloudTtsApiKey ? '已保存（留空不修改）' : '未设置');
            }
            else {
                input.value = String(value ?? '');
            }
        }
        input.id = 'f_' + f.key;
        input.dataset.key = String(f.key);
        if (f.type === 'number')
            input.classList.add('num');
        wrap.appendChild(input);
        if (f.hint)
            wrap.appendChild(el('div', 'hint', f.hint));
        grid.appendChild(wrap);
        i++;
    }
    // 没有声明字段的分区（如「多模型」）不挂空容器，否则会渲染出一张空白边框卡片
    if (section.fields.length > 0)
        body.appendChild(grid);
    if (section.id === 'models') {
        // 价格统计（原「价格统计」分区，已并入本分区）：先给口径说明，再给本次会话累计
        body.appendChild(el('p', 'section-note', PRICING_NOTE));
        const prices = priceTable();
        const st = state.status;
        if (!hasPricing(prices)) {
            body.appendChild(el('p', 'section-note', '尚未填写单价，界面不显示金额。'));
        }
        else {
            const c = computeCost({
                promptTokens: st.promptTokens,
                completionTokens: st.completionTokens,
                cachedTokens: st.cachedTokens,
            }, prices);
            const cur = state.settings.priceCurrency || '¥';
            body.appendChild(el('p', 'section-note', '本次会话累计：缓存命中输入 ' + fmtNum(c.cacheHitTokens) + ' + 缓存未命中输入 ' + fmtNum(c.cacheMissTokens) +
                ' + 输出 ' + fmtNum(c.outputTokens) + ' tokens → 合计 ' + formatMoney(c.total, cur) +
                '（命中 ' + formatMoney(c.cacheCost, cur) + ' + 未命中 ' + formatMoney(c.inputCost, cur) +
                ' + 输出 ' + formatMoney(c.outputCost, cur) + '）'));
        }
        renderModelSection(body);
    }
}
/** 打开设置面板（默认分区「多模型」）；空态按钮与顶栏按钮共用 */
function openSettings() {
    syncModelDrafts();
    buildSettings();
    $('settingsOverlay').classList.remove('hidden');
}
function collectSettings() {
    const patch = {};
    for (const section of SECTIONS) {
        for (const f of section.fields) {
            const input = document.getElementById('f_' + f.key);
            if (!input)
                continue;
            if (f.type === 'checkbox') {
                patch[f.key] = input.checked;
            }
            else if (f.secret) {
                const v = input.value.trim();
                if (v)
                    patch[f.key] = v;
            }
            else if (f.type === 'number') {
                const n = Number(input.value);
                if (Number.isFinite(n))
                    patch[f.key] = n;
            }
            else {
                patch[f.key] = input.value;
            }
        }
    }
    const models = collectModelProfiles();
    if (models)
        Object.assign(patch, models);
    return patch;
}
// ---------------------------------------------------------------- 会话
function timeAgo(ms) {
    const diff = Date.now() - ms;
    if (diff < 60_000)
        return '刚刚';
    if (diff < 3_600_000)
        return Math.floor(diff / 60_000) + ' 分钟前';
    if (diff < 86_400_000)
        return Math.floor(diff / 3_600_000) + ' 小时前';
    const d = new Date(ms);
    return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function renderSessions() {
    const host = $('sessionList');
    if (!state)
        return;
    host.innerHTML = '';
    for (const s of state.sessions) {
        const item = el('div', 'session-item' + (s.id === sessionId ? ' active' : ''));
        item.dataset.id = s.id;
        const title = el('div', 'session-title');
        if (s.running)
            title.appendChild(el('span', 'session-dot'));
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
async function switchSession(id) {
    if (!id || id === sessionId)
        return;
    tts.stop();
    resetSpeakButtons();
    sessionId = id;
    localStorage.setItem('continuousagent.session', id);
    itemEls.clear();
    try {
        await reloadState(id);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
    }
}
async function newSession() {
    try {
        const data = await api('/api/sessions', 'POST', {});
        sessionId = data.state.session.id;
        localStorage.setItem('continuousagent.session', sessionId);
        itemEls.clear();
        await reloadState(sessionId);
        toast('已新建会话，任务结束时会自动命名（也可在侧栏手动重命名）');
    }
    catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
    }
}
async function renameSession(id, current) {
    const title = window.prompt('重命名会话', current);
    if (title === null)
        return;
    try {
        await api('/api/sessions/' + encodeURIComponent(id) + '/rename', 'POST', { title });
        await reloadState(sessionId);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
    }
}
async function deleteSession(id, title) {
    if (!window.confirm('删除会话「' + title + '」？\n其工作记录与笔记会移入工作空间 .trash（7 天内可恢复）。'))
        return;
    try {
        const data = await api('/api/sessions/' + encodeURIComponent(id) + '/delete', 'POST');
        if (sessionId === id) {
            sessionId = data.state.session.id;
            localStorage.setItem('continuousagent.session', sessionId);
            itemEls.clear();
        }
        await reloadState(sessionId);
        toast('会话已删除');
    }
    catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
    }
}
// ---------------------------------------------------------------- 历史检索
/** 搜索请求序号：只渲染最后一次请求的结果，避免慢响应覆盖新结果。 */
let searchSeq = 0;
let searchTimer;
/** 把命中片段按关键词切成 <mark>（用文本节点拼接，不拼 HTML，天然免疫注入）。 */
function highlightSnippet(snippet, terms) {
    const box = el('span', 'search-snippet');
    const lower = snippet.toLowerCase();
    const ranges = [];
    for (const t of terms) {
        const term = t.toLowerCase();
        if (!term)
            continue;
        let from = 0;
        while (from <= lower.length) {
            const at = lower.indexOf(term, from);
            if (at < 0)
                break;
            ranges.push([at, at + term.length]);
            from = at + Math.max(1, term.length);
        }
    }
    if (ranges.length === 0) {
        box.textContent = snippet;
        return box;
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1])
            last[1] = Math.max(last[1], r[1]);
        else
            merged.push([r[0], r[1]]);
    }
    let cursor = 0;
    for (const [start, end] of merged) {
        if (start > cursor)
            box.appendChild(document.createTextNode(snippet.slice(cursor, start)));
        box.appendChild(el('mark', '', snippet.slice(start, end)));
        cursor = end;
    }
    if (cursor < snippet.length)
        box.appendChild(document.createTextNode(snippet.slice(cursor)));
    return box;
}
/** 命中来源的中文标签。 */
function hitKindLabel(kind) {
    switch (kind) {
        case 'session-title': return '标题';
        case 'user': return '我';
        case 'assistant': return '回复';
        case 'system': return '系统';
        case 'thinking': return '思考';
        case 'tool': return '工具';
        case 'record': return '记录';
        case 'notes': return '笔记';
        default: return kind;
    }
}
/** 跳到命中所属会话，并把命中条目滚到中间闪一下（记录/笔记/标题命中只切会话）。 */
async function jumpToHit(targetSession, itemId) {
    try {
        if (targetSession && targetSession !== sessionId)
            await switchSession(targetSession);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
        return;
    }
    if (!itemId)
        return;
    const node = itemEls.get(itemId);
    if (!node) {
        toast('该条消息已不在当前时间线（可能已被裁剪），已切换到会话', true);
        return;
    }
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.remove('hit-flash');
    // 重排一次，让同一节点连续点击时动画能重新播放
    void node.offsetWidth;
    node.classList.add('hit-flash');
    window.setTimeout(() => node.classList.remove('hit-flash'), 2400);
}
/** 渲染检索结果；搜索框清空时恢复会话列表（两个容器互斥显示）。 */
function renderSearchResults(report, query) {
    const host = $('searchResults');
    const list = $('sessionList');
    host.innerHTML = '';
    host.classList.remove('hidden');
    list.classList.add('hidden');
    if (report.groups.length === 0) {
        host.appendChild(el('div', 'search-head', '「' + query + '」没有命中'));
        const hint = el('div', 'search-empty', '已扫描 ' + report.scanned + ' 个会话。' +
            (report.scope === 'chat' ? '把右上角范围切到「全部」可以连工具输出与工作记录/笔记一起搜。' : '换个关键词试试。'));
        host.appendChild(hint);
        return;
    }
    host.appendChild(el('div', 'search-head', '命中 ' + report.groups.length + ' 个会话 · ' + report.totalHits + ' 条' +
        (report.truncated ? '（已截断）' : '')));
    for (const g of report.groups) {
        const box = el('div', 'search-group' + (g.sessionId === sessionId ? ' active' : ''));
        const head = el('div', 'search-group-head');
        head.appendChild(el('span', 'search-group-title', g.title)).title = g.title;
        head.appendChild(el('span', 'search-group-count', g.hitCount + ' 条'));
        head.title = '切换到会话「' + g.title + '」';
        head.addEventListener('click', () => void jumpToHit(g.sessionId, ''));
        box.appendChild(head);
        for (const hit of g.hits) {
            const row = el('div', 'search-hit');
            const kind = hitKindLabel(hit.kind);
            row.appendChild(el('span', 'search-hit-kind', hit.time ? kind + ' ' + hit.time : kind));
            row.appendChild(highlightSnippet(hit.snippet, report.terms));
            row.title = hit.itemId ? '跳转并定位到这条消息' : '切换到该会话';
            row.addEventListener('click', () => void jumpToHit(g.sessionId, hit.itemId));
            box.appendChild(row);
        }
        if (g.hitCount > g.hits.length) {
            box.appendChild(el('div', 'search-more', '另有 ' + (g.hitCount - g.hits.length) + ' 条命中未列出'));
        }
        host.appendChild(box);
    }
}
/** 清空检索：恢复会话列表。 */
function clearSearch() {
    searchSeq++;
    window.clearTimeout(searchTimer);
    $('sessionSearch').value = '';
    const host = $('searchResults');
    host.innerHTML = '';
    host.classList.add('hidden');
    $('sessionList').classList.remove('hidden');
}
async function runSearch() {
    const box = $('sessionSearch');
    const query = box.value.trim();
    if (!query) {
        clearSearch();
        return;
    }
    const scope = $('searchScope').value === 'all' ? 'all' : 'chat';
    const seq = ++searchSeq;
    try {
        const report = await api('/api/sessions/search?q=' + encodeURIComponent(query) + '&scope=' + scope);
        if (seq !== searchSeq)
            return; // 期间又输入了新内容，丢弃这次结果
        renderSearchResults(report, query);
    }
    catch (e) {
        if (seq !== searchSeq)
            return;
        const msg = e instanceof Error ? e.message : String(e);
        const host = $('searchResults');
        host.innerHTML = '';
        host.classList.remove('hidden');
        $('sessionList').classList.add('hidden');
        // 改了代码但服务端没重启时该路由还不存在：直接说清原因，别让用户看到裸的 HTTP 404
        if (/^\s*HTTP 404\s*$|not found/i.test(msg)) {
            host.appendChild(el('div', 'search-empty', '历史搜索要重启服务后才可用：当前服务进程还是旧版本，接口尚未注册；输入内容已保留。'));
            return;
        }
        host.appendChild(el('div', 'search-empty', '搜索失败：' + msg));
    }
}
// ---------------------------------------------------------------- 状态加载
/** 应用界面主题：写到 <html data-theme>，并镜像到 localStorage（首屏内联脚本据此防闪）。 */
function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
        localStorage.setItem('continuousagent.theme', next);
    }
    catch {
        /* 隐私模式下 localStorage 可能不可写，忽略即可 */
    }
}
async function reloadState(id) {
    const target = id || sessionId;
    const fresh = await api('/api/state' + (target ? '?session=' + encodeURIComponent(target) : ''));
    const first = state === null;
    const switched = !!state && state.session.id !== fresh.session.id;
    state = fresh;
    applyTheme(fresh.settings.theme);
    sessionId = fresh.session.id;
    localStorage.setItem('continuousagent.session', sessionId);
    renderSessions();
    applyStatus();
    applyTarget();
    renderTimeline(fresh.timeline, true);
    if (switched || first)
        timelineEl().scrollTop = timelineEl().scrollHeight;
    const effort = document.getElementById('effortSelect');
    if (effort)
        effort.value = fresh.settings.reasoningEffort || 'auto';
    renderModelSelect();
    renderGrants();
    renderNativeBanner(fresh.nativeAvailable, fresh.nativeDetail);
    renderDoc();
}
// ---------------------------------------------------------------- 交互绑定
function bind() {
    $('refreshWindows').addEventListener('click', () => void refreshWindows());
    $('newSession').addEventListener('click', () => void newSession());
    // ---- 历史检索 ----
    const searchBox = $('sessionSearch');
    searchBox.addEventListener('input', () => {
        window.clearTimeout(searchTimer);
        // 空输入立刻恢复列表；有内容则防抖 220ms 再发请求，避免逐字符打服务端
        if (!searchBox.value.trim()) {
            clearSearch();
            return;
        }
        searchTimer = window.setTimeout(() => void runSearch(), 220);
    });
    searchBox.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
            ev.preventDefault();
            clearSearch();
            searchBox.blur();
        }
        else if (ev.key === 'Enter') {
            ev.preventDefault();
            window.clearTimeout(searchTimer);
            void runSearch();
        }
    });
    $('searchScope').addEventListener('change', () => {
        if (searchBox.value.trim())
            void runSearch();
    });
    $('clearWindow').addEventListener('click', async () => {
        try {
            await api('/api/window/clear', 'POST', { sessionId });
            if (state)
                state.target = null;
            applyTarget();
            toast('已清除目标窗口');
        }
        catch (e) {
            toast(e instanceof Error ? e.message : String(e), true);
        }
    });
    $('windowSelect').addEventListener('change', async (e) => {
        const value = e.target.value;
        if (!value)
            return;
        try {
            const data = await api('/api/window/select', 'POST', { pid: Number(value), sessionId });
            if (state)
                state.target = data.state.target;
            applyTarget();
            toast('已选择目标: ' + (data.state.target?.processName || value));
        }
        catch (err) {
            toast(err instanceof Error ? err.message : String(err), true);
        }
    });
    document.querySelectorAll('.tab').forEach((tab) => {
        tab.addEventListener('click', () => setDocTab(tab.dataset.tab === 'notes' ? 'notes' : 'record'));
    });
    $('startBtn').addEventListener('click', () => void start());
    $('stopBtn').addEventListener('click', () => void stop());
    $('resetBtn').addEventListener('click', () => void reset());
    $('prompt').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void start();
        }
    });
    const effortSelect = $('effortSelect');
    effortSelect.addEventListener('change', async () => {
        const value = effortSelect.value;
        try {
            await api('/api/settings', 'POST', { reasoningEffort: value });
            if (state)
                state.settings.reasoningEffort = value;
            toast('思考强度已设为 ' + value);
        }
        catch (err) {
            toast(err instanceof Error ? err.message : String(err), true);
        }
    });
    const modelSelect = $('modelSelect');
    modelSelect.addEventListener('change', async () => {
        const wanted = modelSelect.value;
        modelSelect.disabled = true;
        try {
            const r = await api('/api/model/select', 'POST', { id: wanted });
            state = r.state;
            renderModelSelect();
            toast(wanted ? '已切换模型：' + r.model + '（下一轮生效）' : '已回到默认模型：' + r.model);
        }
        catch (err) {
            // 失败时把下拉拨回服务端当前值，避免界面显示成功但实际没切换
            renderModelSelect();
            toast(err instanceof Error ? err.message : String(err), true);
        }
        finally {
            modelSelect.disabled = false;
        }
    });
    const fileInput = $('fileInput');
    $('attachBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        if (fileInput.files)
            void addFiles(fileInput.files);
        fileInput.value = '';
    });
    const composer = document.querySelector('.composer');
    if (composer) {
        composer.addEventListener('dragover', (e) => {
            e.preventDefault();
            composer.classList.add('drag-over');
        });
        composer.addEventListener('dragleave', () => composer.classList.remove('drag-over'));
        composer.addEventListener('drop', (e) => {
            e.preventDefault();
            composer.classList.remove('drag-over');
            if (e.dataTransfer && e.dataTransfer.files.length > 0)
                void addFiles(e.dataTransfer.files);
        });
        document.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items)
                return;
            const files = [];
            for (const item of items) {
                if (item.kind === 'file') {
                    const f = item.getAsFile();
                    if (f)
                        files.push(f);
                }
            }
            if (files.length > 0 && document.activeElement === $('prompt')) {
                e.preventDefault();
                void addFiles(files);
            }
        });
    }
    $('settingsBtn').addEventListener('click', () => openSettings());
    $('sceneMode').addEventListener('click', () => {
        activeSection = 'scene';
        openSettings();
    });
    $('closeSettings').addEventListener('click', () => $('settingsOverlay').classList.add('hidden'));
    $('settingsOverlay').addEventListener('click', (e) => {
        if (e.target === $('settingsOverlay'))
            $('settingsOverlay').classList.add('hidden');
    });
    $('saveSettings').addEventListener('click', async () => {
        try {
            const patch = collectSettings();
            const data = await api('/api/settings', 'POST', patch);
            state = data.state;
            syncModelDrafts();
            applyTheme(data.state.settings.theme);
            applyStatus();
            applyTarget();
            const effort = document.getElementById('effortSelect');
            if (effort)
                effort.value = state.settings.reasoningEffort || 'auto';
            renderModelSelect();
            buildSettings();
            renderDoc();
            toast('设置已保存');
        }
        catch (e) {
            toast(e instanceof Error ? e.message : String(e), true);
        }
    });
    $('testConnection').addEventListener('click', async () => {
        const hint = $('settingsHint');
        hint.textContent = '正在测试…';
        try {
            // 先保存当前表单，测试才用得上新填入的 Key
            await api('/api/settings', 'POST', collectSettings());
            const r = await api('/api/test-connection', 'POST');
            const results = r.results || [];
            // 多 API 测试：汇总写底部提示，逐条结果标在对应模型行头
            hint.textContent = r.message;
            paintTestResults(results);
            const failed = results.filter((x) => !x.ok).length;
            const title = r.ok
                ? (results.length > 1 ? results.length + ' 个 API 全部连接成功' : '连接成功')
                : (results.length > 1 ? failed + '/' + results.length + ' 个 API 测试失败' : '连接失败: ' + r.message);
            toast(title, !r.ok);
        }
        catch (e) {
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
function isTextFile(file) {
    if (file.type.startsWith('text/'))
        return true;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return TEXT_EXTS.includes(ext);
}
function renderAttachments() {
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
        const remove = el('button', 'att-remove', '\u00D7');
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
async function addFiles(files) {
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
            }
            else if (isTextFile(file)) {
                const text = (await readAsText(file)).slice(0, 60_000);
                pendingAttachments.push({ name: file.name, mime: mime === 'application/octet-stream' ? 'text/plain' : mime, size: file.size, kind: 'text', text });
            }
            else {
                toast('暂不支持该类型：' + file.name + '（仅图片与文本）', true);
            }
        }
        catch (err) {
            toast('读取失败: ' + file.name, true);
        }
    }
    renderAttachments();
}
function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}
function readAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
    });
}
async function start() {
    const box = $('prompt');
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
    // 正在跑：插入消息（不打断当前轮，下一轮请求带上）而不是开新任务
    const inserting = !!state?.status.running;
    try {
        await api(inserting ? '/api/agent/message' : '/api/agent/start', 'POST', { prompt, sessionId, attachments });
        box.value = '';
        pendingAttachments = [];
        renderAttachments();
        if (inserting)
            toast('已插入消息，将在下一轮请求生效');
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 服务端进程还是旧版本（改了代码但没重启）：该路由还不存在，直接说清原因，别让用户看到裸的 404
        if (inserting && /^\s*HTTP 404\s*$|not found/i.test(msg)) {
            toast('服务端尚未重启，「插入消息」要重启服务后才可用（输入内容已保留）', true);
            return;
        }
        // 服务端说「没在运行」时（状态刚变更的竞态），退化成正常开始任务
        if (inserting && /没有运行|无法插入/.test(msg)) {
            try {
                await api('/api/agent/start', 'POST', { prompt, sessionId, attachments });
                box.value = '';
                pendingAttachments = [];
                renderAttachments();
                return;
            }
            catch (e2) {
                toast(e2 instanceof Error ? e2.message : String(e2), true);
                return;
            }
        }
        toast(msg, true);
    }
}
async function stop() {
    try {
        await api('/api/agent/stop', 'POST', { sessionId });
        tts.stop();
    }
    catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
    }
}
async function reset() {
    try {
        await api('/api/agent/reset', 'POST', { sessionId });
        tts.stop();
        itemEls.clear();
        if (state)
            state.timeline = [];
        renderTimeline([]);
        toast('已重置对话');
    }
    catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
    }
}
/* ---------------------------------------------------------------- 三栏宽度拖拽（会话列表 / 对话 / 工作记录） */
const LAYOUT_KEY = 'continuousagent.layout';
const LAYOUT_SPLIT = 14;
const LAYOUT_DEFAULTS = { sessions: 216, side: 380 };
const LAYOUT_MIN = { sessions: 150, side: 280 };
const LAYOUT_MAX = { sessions: 520, side: 820 };
const LAYOUT_CHAT_MIN = 360;
function numPx(raw, fallback) {
    const v = Number.parseFloat(raw);
    return Number.isFinite(v) ? v : fallback;
}
/** 读 localStorage 里保存的布局；坏数据/隐私模式一律回退默认值。 */
function readLayoutSize() {
    const fallback = { sessions: LAYOUT_DEFAULTS.sessions, side: LAYOUT_DEFAULTS.side };
    try {
        const raw = localStorage.getItem(LAYOUT_KEY);
        if (!raw)
            return fallback;
        const p = JSON.parse(raw);
        const pick = (v, def, pane) => {
            const n = typeof v === 'number' ? v : Number(v);
            if (!Number.isFinite(n))
                return def;
            return Math.min(LAYOUT_MAX[pane], Math.max(LAYOUT_MIN[pane], Math.round(n)));
        };
        return { sessions: pick(p?.sessions, fallback.sessions, 'sessions'), side: pick(p?.side, fallback.side, 'side') };
    }
    catch {
        return fallback;
    }
}
function saveLayoutSize(size) {
    try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(size));
    }
    catch {
        /* 隐私模式下写不了就算了，不影响本次拖拽 */
    }
}
/** main 的可用内容宽度（已去掉左右 padding）。 */
function mainAvailWidth() {
    const main = document.querySelector('main');
    if (!main)
        return window.innerWidth;
    const cs = window.getComputedStyle(main);
    return Math.max(0, main.clientWidth - numPx(cs.paddingLeft, 0) - numPx(cs.paddingRight, 0));
}
/** 该栏在当前视口下是否真的可见（窄屏时 .side / .sessions 会被隐藏）。 */
function paneVisible(selector) {
    const el = document.querySelector(selector);
    return !!el && window.getComputedStyle(el).display !== 'none';
}
/** 夹取目标宽度：不小于本栏最小值，且给中间对话区留够 LAYOUT_CHAT_MIN。 */
function clampPaneWidth(pane, want, other) {
    const avail = mainAvailWidth();
    const otherSelector = pane === 'sessions' ? 'main > .side' : 'main > .sessions';
    const otherVisible = paneVisible(otherSelector);
    const splitters = otherVisible ? LAYOUT_SPLIT * 2 : LAYOUT_SPLIT;
    const room = avail - (otherVisible ? other : 0) - splitters - LAYOUT_CHAT_MIN;
    const max = Math.max(LAYOUT_MIN[pane], Math.min(LAYOUT_MAX[pane], room));
    return Math.round(Math.min(max, Math.max(LAYOUT_MIN[pane], want)));
}
function applyLayoutSize(size) {
    const root = document.documentElement;
    root.style.setProperty('--w-sessions', size.sessions + 'px');
    root.style.setProperty('--w-side', size.side + 'px');
}
function currentLayoutSize() {
    const cs = window.getComputedStyle(document.documentElement);
    return {
        sessions: numPx(cs.getPropertyValue('--w-sessions'), LAYOUT_DEFAULTS.sessions),
        side: numPx(cs.getPropertyValue('--w-side'), LAYOUT_DEFAULTS.side),
    };
}
/** 两个宽度都按当前视口夹取一次（窗口缩小后不能把对话区挤成 0）。 */
function fitLayoutSize(size) {
    const sessions = clampPaneWidth('sessions', size.sessions, size.side);
    const side = clampPaneWidth('side', size.side, sessions);
    return { sessions, side };
}
/** 绑定一条分隔条：拖拽改宽、双击复位、方向键微调。 */
function bindSplitter(el, pane) {
    if (!el)
        return;
    let drag = null;
    const onMove = (ev) => {
        if (!drag)
            return;
        const delta = pane === 'sessions' ? ev.clientX - drag.startX : drag.startX - ev.clientX;
        const width = clampPaneWidth(pane, drag.startW + delta, drag.other);
        const size = currentLayoutSize();
        if (pane === 'sessions')
            size.sessions = width;
        else
            size.side = width;
        applyLayoutSize(size);
    };
    const onUp = () => {
        if (!drag)
            return;
        drag = null;
        el.classList.remove('dragging');
        document.body.classList.remove('col-resizing');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        saveLayoutSize(currentLayoutSize());
    };
    el.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0)
            return;
        ev.preventDefault();
        const size = currentLayoutSize();
        drag = {
            startX: ev.clientX,
            startW: pane === 'sessions' ? size.sessions : size.side,
            other: pane === 'sessions' ? size.side : size.sessions,
        };
        el.classList.add('dragging');
        document.body.classList.add('col-resizing');
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });
    el.addEventListener('dblclick', () => {
        const size = currentLayoutSize();
        const width = clampPaneWidth(pane, LAYOUT_DEFAULTS[pane], pane === 'sessions' ? size.side : size.sessions);
        if (pane === 'sessions')
            size.sessions = width;
        else
            size.side = width;
        applyLayoutSize(size);
        saveLayoutSize(size);
    });
    el.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight')
            return;
        ev.preventDefault();
        const step = (ev.shiftKey ? 48 : 16) * (ev.key === 'ArrowRight' ? 1 : -1);
        const size = currentLayoutSize();
        const width = clampPaneWidth(pane, (pane === 'sessions' ? size.sessions : size.side) + (pane === 'sessions' ? step : -step), pane === 'sessions' ? size.side : size.sessions);
        if (pane === 'sessions')
            size.sessions = width;
        else
            size.side = width;
        applyLayoutSize(size);
        saveLayoutSize(size);
    });
}
/** 初始化三栏可调宽度：恢复上次尺寸 + 绑定两条分隔条 + 视口变化时重新夹取。 */
function initLayoutResizers() {
    applyLayoutSize(fitLayoutSize(readLayoutSize()));
    bindSplitter(document.getElementById('splitterSessions'), 'sessions');
    bindSplitter(document.getElementById('splitterSide'), 'side');
    let raf = 0;
    window.addEventListener('resize', () => {
        if (raf)
            return;
        raf = window.requestAnimationFrame(() => {
            raf = 0;
            const cur = currentLayoutSize();
            const next = fitLayoutSize(cur);
            if (next.sessions !== cur.sessions || next.side !== cur.side) {
                applyLayoutSize(next);
                saveLayoutSize(next);
            }
        });
    });
}
async function boot() {
    bind();
    initLayoutResizers();
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('session') || '';
    const saved = fromUrl || localStorage.getItem('continuousagent.session') || localStorage.getItem('gameagent.session') || '';
    try {
        await reloadState(saved || undefined);
    }
    catch (e) {
        toast('加载状态失败: ' + (e instanceof Error ? e.message : String(e)), true);
    }
    if (params.get('settings') === '1') {
        openSettings();
    }
    // 初始化提示：还没添加任何模型时，提醒先去「设置 → 多模型」添加
    if (state && !hasModelConfigured()) {
        toast('还没有添加模型：请在「⚙ 设置」→「多模型」点「+ 添加模型」，填模型名、API 地址与密钥后再开始对话。');
    }
    connectEvents();
    void refreshWindows();
    window.setInterval(() => {
        if (!state?.status.running)
            void refreshWindows();
    }, 8000);
}
void boot();
//# sourceMappingURL=main.js.map