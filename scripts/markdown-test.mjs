#!/usr/bin/env node
/**
 * Markdown 渲染回归测试（不需要浏览器、不需要服务）。
 *
 *   npm run build && node scripts/markdown-test.mjs
 *
 * 覆盖：标题/段落/嵌套列表/任务列表/表格/代码块/图片/链接/删除线/转义/
 *       XSS 逃逸尝试/流式与全量一致性/plainText。
 * 全部通过退出码 0；任一失败打印差异并以 1 退出。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '..', 'dist', 'public', 'client', 'markdown.js')).href);
const { renderMarkdown, MarkdownStream, plainText } = mod;

let failed = 0;
const results = [];

function check(name, actual, expected) {
  const ok = actual === expected;
  results.push({ name, ok });
  if (!ok) {
    failed++;
    console.log('FAIL ' + name);
    console.log('  期望: ' + JSON.stringify(expected));
    console.log('  实际: ' + JSON.stringify(actual));
  }
}

function checkContains(name, html, needles) {
  const missing = needles.filter((n) => !html.includes(n));
  const ok = missing.length === 0;
  results.push({ name, ok });
  if (!ok) {
    failed++;
    console.log('FAIL ' + name + '，缺少: ' + JSON.stringify(missing));
    console.log('  实际: ' + JSON.stringify(html));
  }
}

function checkNotContains(name, html, needles) {
  const present = needles.filter((n) => html.includes(n));
  const ok = present.length === 0;
  results.push({ name, ok });
  if (!ok) {
    failed++;
    console.log('FAIL ' + name + '，不该出现: ' + JSON.stringify(present));
    console.log('  实际: ' + JSON.stringify(html));
  }
}

// ---------------------------------------------------------------- 块级
check('空输入', renderMarkdown(''), '');
check('纯文本段落', renderMarkdown('hello'), '<p>hello</p>');
check('软换行合并为一段', renderMarkdown('第一行\n第二行'), '<p>第一行\n第二行</p>');
check('硬换行（两个空格）', renderMarkdown('第一行  \n第二行'), '<p>第一行<br />\n第二行</p>');
check('硬换行（反斜杠）', renderMarkdown('第一行\\\n第二行'), '<p>第一行<br />\n第二行</p>');
check('两个段落', renderMarkdown('段一\n\n段二'), '<p>段一</p>\n<p>段二</p>');
check('标题', renderMarkdown('## 二级'), '<h2>二级</h2>');
check('分割线', renderMarkdown('---'), '<hr />');

check('无序列表', renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
check('有序列表从 1', renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
check('有序列表自定义起始', renderMarkdown('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>');
check('嵌套两层的列表',
  renderMarkdown('- a\n  - b\n  - c\n- d'),
  '<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>');
check('四空格缩进也算嵌套',
  renderMarkdown('1. a\n    1. b'),
  '<ol><li>a<ol><li>b</li></ol></li></ol>');
check('任务列表',
  renderMarkdown('- [ ] 待办\n- [x] 已完成'),
  '<ul><li class="task"><input type="checkbox" disabled /> 待办</li>' +
  '<li class="task checked"><input type="checkbox" disabled checked /> 已完成</li></ul>');
check('列表项续行',
  renderMarkdown('- 第一行\n  续行'),
  '<ul><li>第一行\n续行</li></ul>');

check('引用', renderMarkdown('> 引用内容'), '<blockquote><p>引用内容</p></blockquote>');
check('嵌套引用', renderMarkdown('> 外层\n> > 内层'),
  '<blockquote><p>外层</p>\n<blockquote><p>内层</p></blockquote></blockquote>');

const fence = renderMarkdown('```ts\nconst a = 1;\n```');
checkContains('围栏代码块结构', fence, [
  '<div class="md-code">', 'md-code-lang', '>ts<', 'data-md-copy="1"',
  '<pre><code class="language-ts">', 'const a = 1;',
]);
check('波线围栏', renderMarkdown('~~~\nplain\n~~~').includes('<pre><code>plain</code></pre>'), true);
check('缩进代码块', renderMarkdown('    indented'), 
  '<div class="md-code"><div class="md-code-head"><span class="md-code-lang">text</span>' +
  '<button type="button" class="md-code-copy" data-md-copy="1" title="复制代码">复制</button></div>' +
  '<pre><code>indented</code></pre></div>');
const codeWithTag = renderMarkdown('```\n<script>alert(1)</script>\n```');
checkNotContains('代码块内的 HTML 被转义', codeWithTag, ['<script>']);
checkContains('代码块内 HTML 显示为文本', codeWithTag, ['&lt;script&gt;']);
check('代码块保留缩进与空行', renderMarkdown('```\na\n\n  b\n```').includes('a\n\n  b'), true);

// ---------------------------------------------------------------- 表格
const table = renderMarkdown('| 名称 | 数量 |\n|:---|---:|\n| a | 1 |\n| b | 2 |');
checkContains('表格结构', table, ['<div class="md-table"><table><thead><tr><th>名称</th><th class="right">数量</th></tr></thead>',
  '<tbody><tr><td>a</td><td class="right">1</td></tr>']);
check('表格居中对齐',
  renderMarkdown('| a |\n|:--:|\n| 1 |').includes('<th class="center">a</th>'), true);
check('表格单元格内联语法',
  renderMarkdown('| a |\n|---|\n| **粗** |').includes('<td><strong>粗</strong></td>'), true);
check('表格里的竖线转义',
  renderMarkdown('| a |\n|---|\n| x \\| y |').includes('<td>x | y</td>'), true);
check('表格与后续段落分开',
  renderMarkdown('| a |\n|---|\n| 1 |\n\n段落').endsWith('<p>段落</p>'), true);

// ---------------------------------------------------------------- 行内
check('粗体', renderMarkdown('**粗**'), '<p><strong>粗</strong></p>');
check('斜体', renderMarkdown('*斜*'), '<p><em>斜</em></p>');
check('粗斜体', renderMarkdown('***都有***'), '<p><strong><em>都有</em></strong></p>');
check('下划线粗体', renderMarkdown('__粗__'), '<p><strong>粗</strong></p>');
check('删除线', renderMarkdown('~~删~~'), '<p><del>删</del></p>');
check('行内代码', renderMarkdown('`code`'), '<p><code>code</code></p>');
check('snake_case 不被斜体', renderMarkdown('a_b_c'), '<p>a_b_c</p>');
check('行内代码内的星号不生效', renderMarkdown('`*x*`'), '<p><code>*x*</code></p>');
check('转义星号', renderMarkdown('\\*字面量\\*'), '<p>*字面量*</p>');
check('链接',
  renderMarkdown('[文本](https://example.com/a)'),
  '<p><a href="https://example.com/a" target="_blank" rel="noreferrer noopener">文本</a></p>');
check('链接带标题',
  renderMarkdown('[x](https://e.com "标题")'),
  '<p><a href="https://e.com" title="标题" target="_blank" rel="noreferrer noopener">x</a></p>');
checkContains('裸 URL 自动链接', renderMarkdown('见 https://example.com/x 页面'),
  ['<a href="https://example.com/x" target="_blank" rel="noreferrer noopener">https://example.com/x</a>']);
checkContains('图片', renderMarkdown('![图](https://e.com/a.png)'),
  ['<img class="md-img" src="https://e.com/a.png" alt="图"', 'loading="lazy"']);
checkContains('站内图片路径可用', renderMarkdown('![图](/api/images/abc)'), ['src="/api/images/abc"']);

// ---------------------------------------------------------------- 安全
check('原始 HTML 被转义', renderMarkdown('<b>x</b>'), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
checkNotContains('javascript: 链接被丢弃', renderMarkdown('[点我](javascript:alert(1))'),
  ['href="javascript']);
checkNotContains('data:text/html 图片被丢弃', renderMarkdown('![x](data:text/html;base64,PHNjcmlwdD4=)'),
  ['<img']);
checkNotContains('事件属性注入', renderMarkdown('![x" onerror="alert(1)](https://e.com/a.png)'), ['onerror="alert(1)"']);
checkNotContains('script 标签注入', renderMarkdown('<script>alert(1)</script>'), ['<script>']);
checkNotContains('iframe 注入', renderMarkdown('<iframe src="x"></iframe>'), ['<iframe']);
check('引号被转义', renderMarkdown('他说 "你好"'), '<p>他说 &quot;你好&quot;</p>');

// ---------------------------------------------------------------- 流式一致性
const samples = [
  '# 标题\n\n段落一\n段落一续\n\n- a\n  - b\n- c\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
  '文字**粗**和`code`与~~删~~\n\n```py\nprint("hi")\n\nprint(1)\n```\n尾部段落\n',
  '> 引用\n> > 内层\n\n1. 一\n2. 二\n   - 子\n',
  '- [ ] 未完成\n- [x] 完成\n',
  '```\n未闭合代码块\n``` x\n仍在块内\n',
  '',
  '单行',
  'a\n\n\n\nb',
  '![img](https://e.com/i.png) 与 [l](https://e.com)\n\n---\n',
];
for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  const want = renderMarkdown(s);
  const stream = new MarkdownStream();
  let k = 0;
  while (k < s.length) {
    k = Math.min(s.length, k + 1 + (k % 5));
    stream.push(s.slice(0, k));
  }
  check('流式==全量 #' + i, stream.finish(), want);

  // 预览态不应抛错，且必须是字符串
  const preview = new MarkdownStream().push(s.slice(0, Math.ceil(s.length / 2)));
  check('流式预览可用 #' + i, typeof preview, 'string');

  // 文本被替换（非追加）时应自动重置
  const reset = new MarkdownStream();
  reset.push('旧的\n\n内容');
  reset.push('全新的文本');
  check('非追加文本自动重置 #' + i, reset.finish(), renderMarkdown('全新的文本'));
}

// ---------------------------------------------------------------- 缓存与 plainText
const doc = '# 缓存测试\n\n段落';
check('重复渲染结果一致（命中缓存）', renderMarkdown(doc), renderMarkdown(doc));
check('plainText 去标记', plainText('# 标题\n\n- **项** `x` [l](https://e.com)'), '标题 项 x l');
check('plainText 去代码块', plainText('```ts\nconst a=1;\n```\n正文'), '正文');

// ---------------------------------------------------------------- 输出
const pass = results.filter((r) => r.ok).length;
console.log('\n' + (failed === 0 ? 'OK' : 'FAIL') + ': ' + pass + '/' + results.length + ' 项通过');
process.exit(failed === 0 ? 0 : 1);
