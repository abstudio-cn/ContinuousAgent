/**
 * 界面用 Markdown 渲染（零依赖）。
 *
 * 支持：标题、段落（软换行/硬换行）、有序/无序/嵌套列表、任务列表、引用、分割线、
 * 围栏与缩进代码块（带语言标签 + 复制按钮）、GFM 表格（含对齐）、图片、链接（含裸 URL 自动链接）、
 * 行内代码、粗体/斜体/粗斜体、删除线、反斜杠转义。
 *
 * 安全策略：先转义 HTML 再解析，从不透传原始 HTML；链接/图片 URL 走白名单协议。
 *
 * 流式：`MarkdownStream` 与 `renderMarkdown` 共用同一套块解析（`renderBlocks`），
 * 保证流式中间态与最终结果排版一致，且只处理新增行（避免 O(n²) 重渲染）。
 */

const NEEDS_ESCAPE = /[&<>"']/;
const ESCAPE_ALL = /[&<>"']/g;
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const CRLF = /\r\n/g;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?/;
const LIST_LINE = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const TASK_PREFIX = /^\[([ xX])\][ \t]+/;
const SLOT = /\u0000(\d+)\u0000/g;
const LINK_OR_IMAGE = /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^\s()]+)(?:\s+["']([^"']*)["'])?\s*\)/g;
const AUTOLINK = /(^|[\s(（「【])((?:https?:\/\/|www\.)[^\s<>"'）)】」]+)/g;
const BOLD_ITALIC = /\*\*\*([^*]+)\*\*\*/g;
const BOLD_STAR = /\*\*([^*]+)\*\*/g;
const BOLD_UNDER = /__([^_]+)__/g;
const ITALIC_STAR = /(^|[^\w*])\*([^*\n]+)\*(?!\w)/g;
const ITALIC_UNDER = /(^|[^\w_])_([^_\n]+)_(?!\w)/g;
const STRIKE = /~~([^~]+)~~/g;
const INLINE_CODE = /(`+)([\s\S]*?[^`])\1(?!`)/g;
const BACKSLASH_ESCAPE = /\\([\\`*_{}[\]()#+\-.!>~|])/g;
const HARD_BREAK_SPACES = / {2,}\n/g;
const HARD_BREAK_BACKSLASH = /\\\n/g;

function escapeHtml(text: string): string {
  // 快路径：绝大多数行里没有需要转义的字符，直接返回省掉一次全量替换
  if (!NEEDS_ESCAPE.test(text)) return text;
  return text.replace(ESCAPE_ALL, (ch) => ESCAPES[ch] as string);
}

/** 只允许安全协议与站内相对路径，其余（javascript:、data:text/html…）一律丢弃。 */
function safeUrl(raw: string, kind: 'link' | 'image'): string | null {
  let url = (raw || '').trim().replace(/^<|>$/g, '');
  if (!url) return null;
  if (/^(?:https?:\/\/|mailto:)/i.test(url)) return url;
  if (/^(?:\/|\.{1,2}\/|#|\?)/.test(url)) return url;
  if (kind === 'image' && /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(url)) return url;
  return null;
}

/** 行内占位符：保护已生成的片段不被后续行内规则二次处理。 */
class Slots {
  private items: string[] = [];

  add(html: string): string {
    this.items.push(html);
    return '\u0000' + (this.items.length - 1) + '\u0000';
  }

  restore(text: string): string {
    if (this.items.length === 0) return text;
    return text.replace(SLOT, (_m, idx: string) => this.items[Number(idx)] ?? '');
  }
}

/** 行内语法。输入为单行（或已用 \n 连接的段落文本），返回 HTML。 */
function inline(text: string): string {
  if (!text) return '';
  const slots = new Slots();
  // 1) 反斜杠转义（\* 之类按字面量输出）—— 在转义 HTML 之前做，才能识别“反斜杠+字符”
  let s = text.replace(BACKSLASH_ESCAPE, (_m, ch: string) => slots.add(escapeHtml(ch)));
  // 2) 行内代码优先，避免内部被当成强调/链接（内部单独转义）
  s = s.replace(INLINE_CODE, (_m, _ticks: string, code: string) =>
    slots.add('<code>' + escapeHtml(code).replace(/\n/g, ' ') + '</code>'));
  // 3) 图片与链接（在未转义文本上解析，因此标题里的引号、URL 里的 & 都能正确处理）
  s = s.replace(LINK_OR_IMAGE, (match, bang: string, label: string, rawUrl: string, title?: string) => {
    const isImage = bang === '!';
    const url = safeUrl(rawUrl, isImage ? 'image' : 'link');
    if (!url) return match;
    const href = escapeHtml(url);
    const titleAttr = title ? ' title="' + escapeHtml(title) + '"' : '';
    if (isImage) {
      return slots.add('<img class="md-img" src="' + href + '" alt="' + escapeHtml(label) + '"' + titleAttr +
        ' loading="lazy" referrerpolicy="no-referrer" />');
    }
    return slots.add('<a href="' + href + '"' + titleAttr +
      ' target="_blank" rel="noreferrer noopener">' + (escapeHtml(label) || href) + '</a>');
  });
  // 4) 剩下的普通文本一律转义（从不透传原始 HTML）
  s = escapeHtml(s);
  // 5) 裸 URL 自动链接（已转义，不会破坏属性）
  s = s.replace(AUTOLINK, (_m, lead: string, url: string) =>
    lead + slots.add('<a href="' + (url.startsWith('www.') ? 'https://' + url : url) +
      '" target="_blank" rel="noreferrer noopener">' + url + '</a>'));
  // 6) 强调 / 删除线
  s = s.replace(BOLD_ITALIC, '<strong><em>$1</em></strong>');
  s = s.replace(BOLD_STAR, '<strong>$1</strong>');
  s = s.replace(BOLD_UNDER, '<strong>$1</strong>');
  s = s.replace(STRIKE, '<del>$1</del>');
  s = s.replace(ITALIC_STAR, '$1<em>$2</em>');
  s = s.replace(ITALIC_UNDER, '$1<em>$2</em>');
  // 7) 硬换行：行尾两个空格 / 行尾反斜杠
  s = s.replace(HARD_BREAK_BACKSLASH, '<br />\n');
  s = s.replace(HARD_BREAK_SPACES, '<br />\n');
  return slots.restore(s);
}

function isBlockStart(line: string): boolean {
  return FENCE_OPEN.test(line) || HEADING.test(line) || HR.test(line) ||
    QUOTE.test(line) || LIST_LINE.test(line) || INDENTED_CODE.test(line);
}

function codeBlockHtml(lang: string, codeLines: string[], presetHtml?: string): string {
  const langSafe = (lang || '').replace(/[^\w+#.-]/g, '').slice(0, 20);
  const body = presetHtml ?? codeLines.map((l) => escapeHtml(l)).join('\n');
  return '<div class="md-code">' +
    '<div class="md-code-head">' +
    '<span class="md-code-lang">' + (langSafe || 'text') + '</span>' +
    '<button type="button" class="md-code-copy" data-md-copy="1" title="复制代码">复制</button>' +
    '</div>' +
    '<pre><code' + (langSafe ? ' class="language-' + langSafe + '"' : '') + '>' + body + '</code></pre>' +
    '</div>';
}

interface RawItem {
  indent: number;
  ordered: boolean;
  start: number;
  text: string;
  task: boolean | null;
  checked: boolean;
}

function parseListItem(line: string): RawItem | null {
  const m = LIST_LINE.exec(line);
  if (!m) return null;
  const marker = m[2]!;
  const ordered = /\d/.test(marker);
  let text = m[4] ?? '';
  let task: boolean | null = null;
  let checked = false;
  const t = TASK_PREFIX.exec(text);
  if (t) {
    task = true;
    checked = t[1]!.toLowerCase() === 'x';
    text = text.slice(t[0].length);
  }
  return {
    indent: (m[1] ?? '').replace(/\t/g, '    ').length,
    ordered,
    start: ordered ? Number.parseInt(marker, 10) || 1 : 1,
    text,
    task,
    checked,
  };
}

function renderList(items: RawItem[]): string {
  interface Node { item: RawItem; children: Node[] }
  const roots: Node[] = [];
  const stack: Array<{ node: Node; indent: number }> = [];
  for (const it of items) {
    const node: Node = { item: it, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= it.indent) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1]!.node.children.push(node);
    stack.push({ node, indent: it.indent });
  }

  const render = (nodes: Node[]): string => {
    let html = '';
    let k = 0;
    while (k < nodes.length) {
      const ordered = nodes[k]!.item.ordered;
      let j = k;
      while (j < nodes.length && nodes[j]!.item.ordered === ordered) j++;
      const group = nodes.slice(k, j);
      const tag = ordered ? 'ol' : 'ul';
      const start = group[0]!.item.start;
      html += '<' + tag + (ordered && start !== 1 ? ' start="' + start + '"' : '') + '>';
      for (const n of group) {
        const it = n.item;
        const cls = it.task === null ? '' : ' class="task' + (it.checked ? ' checked' : '') + '"';
        const box = it.task === null
          ? ''
          : '<input type="checkbox" disabled' + (it.checked ? ' checked' : '') + ' /> ';
        html += '<li' + cls + '>' + box + inline(it.text) +
          (n.children.length > 0 ? render(n.children) : '') + '</li>';
      }
      html += '</' + tag + '>';
      k = j;
    }
    return html;
  };

  return render(roots);
}

function splitRow(line: string): string[] {
  let s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const sep = lines[i + 1];
  if (!head || !sep) return false;
  return head.includes('|') && sep.includes('|') && sep.includes('-') && TABLE_SEP.test(sep);
}

function renderTable(head: string[], align: string[], body: string[][]): string {
  const cell = (tag: 'th' | 'td', text: string, idx: number) => {
    const a = align[idx];
    return '<' + tag + (a && a !== 'left' ? ' class="' + a + '"' : '') + '>' + inline(text) + '</' + tag + '>';
  };
  const headRow = '<tr>' + head.map((c, i) => cell('th', c, i)).join('') + '</tr>';
  const bodyRows = body.map((row) => '<tr>' + row.map((c, i) => cell('td', c, i)).join('') + '</tr>').join('');
  return '<div class="md-table"><table><thead>' + headRow + '</thead><tbody>' + bodyRows + '</tbody></table></div>';
}

/** 把一组（不含空行的连续）行渲染成块级 HTML。流式与全量共用。 */
function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    // 围栏代码块
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = (fence[2] || '').trim().split(/[ \t]/)[0] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = FENCE_CLOSE.exec(lines[i]!);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
          i++;
          break;
        }
        body.push(lines[i]!);
        i++;
      }
      out.push(codeBlockHtml(lang, body));
      continue;
    }

    // 缩进代码块
    if (INDENTED_CODE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        if (INDENTED_CODE.test(cur)) {
          body.push(cur.replace(INDENTED_CODE, ''));
          i++;
          continue;
        }
        if (!cur.trim()) {
          body.push('');
          i++;
          continue;
        }
        break;
      }
      while (body.length > 0 && !body[body.length - 1]!.trim()) body.pop();
      out.push(codeBlockHtml('', body));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push('<h' + level + '>' + inline(heading[2]!) + '</h' + level + '>');
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // 引用（支持懒续行与嵌套）
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        if (QUOTE.test(cur)) {
          body.push(cur.replace(QUOTE, ''));
          i++;
          continue;
        }
        if (!cur.trim() || isBlockStart(cur)) break;
        body.push(cur);
        i++;
      }
      out.push('<blockquote>' + renderBlocks(body) + '</blockquote>');
      continue;
    }

    // GFM 表格
    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]!);
      const align = splitRow(lines[i + 1]!).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      });
      i += 2;
      const body: string[][] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        if (!cur.trim() || !cur.includes('|')) break;
        if (FENCE_OPEN.test(cur) || HEADING.test(cur) || QUOTE.test(cur)) break;
        body.push(splitRow(cur));
        i++;
      }
      out.push(renderTable(head, align, body));
      continue;
    }

    // 列表（含嵌套与任务项）
    if (LIST_LINE.test(line)) {
      const items: RawItem[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const item = parseListItem(cur);
        if (item) {
          items.push(item);
          i++;
          continue;
        }
        if (!cur.trim()) break;
        // 缩进的续行并入上一项
        if (/^[ \t]{2,}/.test(cur) && items.length > 0 && !isBlockStart(cur)) {
          items[items.length - 1]!.text += '\n' + cur.trim();
          i++;
          continue;
        }
        break;
      }
      out.push(renderList(items));
      continue;
    }

    // 段落：连续的非空行，遇到新的块起始则中断
    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i]!;
      if (!cur.trim()) break;
      if (para.length > 0 && isBlockStart(cur)) break;
      if (para.length > 0 && isTableStart(lines, i)) break;
      para.push(cur);
      i++;
    }
    out.push('<p>' + inline(para.join('\n')) + '</p>');
  }

  return out.join('\n');
}

/**
 * 增量 Markdown 渲染器：把流式增长的文本喂进来，只处理新增的完整行。
 *
 * 提交策略：空行是安全的块边界，整段行在遇到空行时渲染并提交；
 * 围栏代码块单独维护行缓冲，避免长代码块反复整体转义。
 */
export class MarkdownStream {
  /** 已提交块的 HTML。 */
  private committed: string[] = [];
  /** 尚未提交的行（自上一个空行起）。 */
  private buffer: string[] = [];
  /** 未闭合的围栏代码块。 */
  private fence: { marker: string; lang: string; lines: string[]; html: string } | null = null;
  private source = '';
  private consumed = 0;
  private finished = false;

  /** 接受增长中的全文，返回当前可显示的 HTML（末行按预览渲染）。 */
  push(markdown: string): string {
    const text = (markdown || '').replace(CRLF, '\n');
    if (!text.startsWith(this.source) || this.finished) this.reset();
    this.source = text;
    const completeEnd = text.lastIndexOf('\n') + 1;
    if (completeEnd > this.consumed) {
      this.consume(text.slice(this.consumed, completeEnd));
      this.consumed = completeEnd;
    }
    return this.preview();
  }

  /** 收尾：把剩下的半行按完整行处理，闭合未闭合的块。 */
  finish(): string {
    if (!this.finished) {
      // 末尾那一行（最后一个换行之后，可能为空串）也要按完整行处理
      this.consume(this.source.slice(this.consumed) + '\n');
      this.consumed = this.source.length;
      if (this.fence) this.closeFence();
      this.flushBuffer();
      this.finished = true;
    }
    return this.committed.join('\n');
  }

  /** 重置状态（文本不再是上次的延长时自动调用）。 */
  reset(): void {
    this.committed = [];
    this.buffer = [];
    this.fence = null;
    this.source = '';
    this.consumed = 0;
    this.finished = false;
  }

  private consume(body: string): void {
    const lines = body.split('\n');
    for (let i = 0; i < lines.length - 1; i++) this.line(lines[i] ?? '');
  }

  private line(raw: string): void {
    // 注意：不能裁剪行尾空白——行尾两个空格是 Markdown 的硬换行标记
    const line = raw;
    if (this.fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === this.fence.marker[0] && close[1]!.length >= this.fence.marker.length) {
        this.closeFence();
        return;
      }
      this.fence.lines.push(raw);
      this.fence.html += (this.fence.lines.length > 1 ? '\n' : '') + escapeHtml(raw);
      return;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      this.flushBuffer();
      this.fence = {
        marker: open[1]!,
        lang: (open[2] || '').trim().split(/[ \t]/)[0] ?? '',
        lines: [],
        html: '',
      };
      return;
    }
    if (!line.trim()) {
      this.flushBuffer();
      return;
    }
    this.buffer.push(line);
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0) return;
    const html = renderBlocks(this.buffer);
    this.buffer = [];
    if (html) this.committed.push(html);
  }

  private closeFence(): void {
    if (!this.fence) return;
    this.committed.push(codeBlockHtml(this.fence.lang, this.fence.lines, this.fence.html));
    this.fence = null;
  }

  private preview(): string {
    const parts = this.committed.slice();
    if (this.fence) {
      parts.push(codeBlockHtml(this.fence.lang, this.fence.lines, this.fence.html));
    } else if (this.buffer.length > 0) {
      const html = renderBlocks(this.buffer);
      if (html) parts.push(html);
    }
    return parts.join('\n');
  }
}

const RENDER_CACHE = new Map<string, string>();
const RENDER_CACHE_MAX = 16;

/** 完整渲染（非流式）。相同文本命中缓存。 */
export function renderMarkdown(markdown: string): string {
  const text = markdown || '';
  const cached = RENDER_CACHE.get(text);
  if (cached !== undefined) return cached;
  const stream = new MarkdownStream();
  stream.push(text);
  const html = stream.finish();
  if (RENDER_CACHE.size >= RENDER_CACHE_MAX) RENDER_CACHE.clear();
  RENDER_CACHE.set(text, html);
  return html;
}

/** 纯文本摘要：用于卡片折叠标题与朗读过滤。 */
export function plainText(markdown: string): string {
  return (markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/gm, ' ')
    .replace(/^\s*#{1,6}\s+/gm, ' ')
    .replace(/[#>*_`~|[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
