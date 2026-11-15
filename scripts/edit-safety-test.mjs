// 回归测试：edit_file / apply_patch 的替换必须逐字插入，不得解释 $ 模式
//
// 背景：曾经用 `content.replace(oldText, newText)` 实现替换，而 String.prototype.replace
// 的字符串替换串会解释 $ 模式。new_text 里只要出现「美元符 + 单引号」，就会把「匹配点之后的
// 全部内容」插进结果，导致文件凭空多出一整段（1300 行的 main.ts 被写成一式两份）。
//
//   npm run build && node scripts/edit-safety-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolExecutor } from '../dist/server/tools.js';
import { NativeBridge } from '../dist/server/native.js';
import { GlobalTipsStore } from '../dist/server/tips.js';
import { defaultSettings } from '../dist/server/settings.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-editsafe-'));
const settings = { ...defaultSettings(), workspacePath: ws, allowShell: false };
const tools = new ToolExecutor(settings, new NativeBridge(), new GlobalTipsStore(path.join(ws, 'tips.json')));
const signal = new AbortController().signal;

const results = [];
let failed = 0;
function check(name, cond, extra) {
  results.push(!!cond);
  if (cond) return;
  failed++;
  console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + String(extra).slice(0, 400) : ''));
}

const file = path.join(ws, 'target.txt');
const reset = (text) => fs.writeFileSync(file, text, 'utf8');
const read = () => fs.readFileSync(file, 'utf8');

async function edit(args) {
  return tools.execute('edit_file', JSON.stringify(args), signal);
}
async function patch(args) {
  return tools.execute('apply_patch', JSON.stringify(args), signal);
}

// 造一个 1300 行、结构与真实源码类似的文件（复刻当初 main.ts 的事故现场）
function bigFile(lineCount = 1300) {
  const out = [];
  for (let i = 0; i < lineCount; i++) out.push('const row' + i + ' = ' + i + '; // filler');
  return out;
}

// ---------------------------------------------------------------- 1) 各种 $ 序列必须逐字写入
const DANGER = [
  ['单引号(后缀全文)', 'A' + "$'" + 'B'],
  ['反引号(前缀全文)', 'A' + '$`' + 'B'],
  ['and 符号(匹配原文)', 'A' + '$&' + 'B'],
  ['双美元(转义)', 'A' + '$$' + 'B'],
  ['数字引用', 'A' + '$1' + '$2' + 'B'],
  ['命名引用', 'A' + '$<name>' + 'B'],
  ['组合', "$'$&$$$1" + 'B'],
];

for (const [label, newText] of DANGER) {
  reset('HEAD\n<<MARK>>\nTAIL\n');
  const r = await edit({ path: file, old_text: '<<MARK>>', new_text: newText });
  const got = read();
  check('$ 序列原样写入: ' + label, !r.isError && got === 'HEAD\n' + newText + '\nTAIL\n',
    JSON.stringify(got) + ' | ' + r.text);
  check('$ 序列不膨胀: ' + label, got.split('\n').length === 4, got.split('\n').length);
}

// ---------------------------------------------------------------- 2) 真实事故场景
{
  const lines = bigFile();
  // 真实 main.ts 里那一行（价格分区）就长这样：结尾是 hint: '...可填 $'
  const priceLine = "      { key: 'priceCurrency', label: '货币符号', type: 'text', hint: '默认 ¥；用美元可填 $' },";
  lines.splice(600, 0, '    id: MARKER_NONE_HERE,');
  reset(lines.join('\n') + '\n');
  const before = read().split('\n').length;

  // 在唯一锚点处替换成带 $ 的单引号文本
  const r = await edit({
    path: file,
    old_text: '    id: MARKER_NONE_HERE,',
    new_text: priceLine,
  });
  const got = read();
  const after = got.split('\n').length;
  check('真实场景: 替换成功', !r.isError, r.text);
  check('真实场景: 行数只 +0（1 行换 1 行）', after === before, before + ' → ' + after);
  check('真实场景: 结果含字面量 $', got.includes("可填 $'") === true, '');
  check('真实场景: 文件尾唯一', got.split('const row1299 = 1299;').length - 1 === 1, '');
  check('真实场景: 没有出现两份尾部', got.split('const row0 = 0;').length - 1 === 1, '');
}

// ---------------------------------------------------------------- 3) 大文件不做无关改动
{
  const lines = bigFile(1300);
  reset(lines.join('\n') + '\n');
  const before = read();
  const r = await edit({
    path: file,
    old_text: 'const row42 = 42; // filler',
    new_text: 'const row42 = 42; // filler\n  bonus: ' + "$'" + 'hint',
  });
  const got = read();
  check('大文件: 替换成功', !r.isError, r.text);
  check('大文件: 行数 +1', got.split('\n').length === before.split('\n').length + 1,
    before.split('\n').length + ' → ' + got.split('\n').length);
  check('大文件: 其余行未被复制', got.split('const row1299 = 1299;').length - 1 === 1, '');
  check('大文件: 内容逐字', got.includes("bonus: $'hint") === true, '');
}

// ---------------------------------------------------------------- 4) replace_all 同样安全
{
  reset('x=<<T>> ; y=<<T>> ; z=<<T>>\n');
  const r = await edit({ path: file, old_text: '<<T>>', new_text: "[$' ok]", replace_all: true });
  const got = read();
  check('replace_all: 三处全替换', !r.isError && got === "x=[$' ok] ; y=[$' ok] ; z=[$' ok]\n", JSON.stringify(got) + ' | ' + r.text);
  check('replace_all: 返回替换 3 处', /替换 3 处/.test(r.text), r.text);
}

// ---------------------------------------------------------------- 5) 重叠片段的长度算术
{
  reset('aaaa');
  const r = await edit({ path: file, old_text: 'aa', new_text: 'X', replace_all: true });
  const got = read();
  // 'aaaa'.split('aa') = ['','',''] → join('X') = 'XX'
  check('重叠片段: 全替换结果正确', !r.isError && got === 'XX', JSON.stringify(got) + ' | ' + r.text);
}

// ---------------------------------------------------------------- 6) apply_patch 多组混合
{
  reset('AAA\nBBB\nCCC\n');
  const r = await patch({
    path: file,
    edits: [
      { old_text: 'AAA', new_text: 'A1' + '$&' + 'A2' },
      { old_text: 'BBB', new_text: 'B1' + "$'" + 'B2' },
      { old_text: 'CCC', new_text: 'CCC' },
    ],
  });
  const got = read();
  const want = 'A1' + '$&' + 'A2' + '\nB1' + "$'" + 'B2' + '\nCCC\n';
  check('apply_patch: 多组逐字', !r.isError && got === want, JSON.stringify(got) + ' | ' + r.text);
  check('apply_patch: 行数不变', got.split('\n').length === 4, got.split('\n').length);
}

// ---------------------------------------------------------------- 7) 拒绝情况且不写盘
{
  const origin = 'one\ntwo\nthree\n';
  reset(origin);

  const empty = await edit({ path: file, old_text: '', new_text: 'zzz' });
  check('空 old_text 被拒', empty.isError === true, empty.text);
  check('空 old_text 未改文件', read() === origin, JSON.stringify(read()));

  const missing = await edit({ path: file, old_text: 'not-exist', new_text: 'zzz' });
  check('未找到片段被拒', missing.isError === true, missing.text);
  check('未找到未改文件', read() === origin, JSON.stringify(read()));

  reset('dup\ndup\n');
  const many = await edit({ path: file, old_text: 'dup', new_text: 'zzz' });
  check('多处匹配被拒', many.isError === true && /2 次/.test(many.text), many.text);
  check('多处匹配未改文件', read() === 'dup\ndup\n', JSON.stringify(read()));

  const manyPatch = await patch({ path: file, edits: [{ old_text: 'dup', new_text: 'zzz' }] });
  check('apply_patch 多处匹配被拒', manyPatch.isError === true, manyPatch.text);
  check('apply_patch 未改文件', read() === 'dup\ndup\n', JSON.stringify(read()));
}

// ---------------------------------------------------------------- 8) 空 new_text 删除片段
{
  reset('keep\nDROP\ngone\n');
  const r = await edit({ path: file, old_text: 'DROP\ngone\n', new_text: '' });
  check('空 new_text 等价删除', !r.isError && read() === 'keep\n', JSON.stringify(read()) + ' | ' + r.text);
}

// ---------------------------------------------------------------- 9) 多字节 / emoji 往返
{
  const newText = '中文😀 混合 text';
  reset('BEFORE\nK\nAFTER\n');
  const r = await edit({ path: file, old_text: 'K', new_text: newText });
  check('中文与 emoji 逐字写入', !r.isError && read() === 'BEFORE\n' + newText + '\nAFTER\n', JSON.stringify(read()) + ' | ' + r.text);
}

// ---------------------------------------------------------------- 10) 返回值里的字符数应自洽
{
  reset('12345TOKEN99\n');
  const r = await edit({ path: file, old_text: 'TOKEN', new_text: 'AB' });
  const m = r.text.match(/(\d+) → (\d+) 字符/);
  check('返回字符数可解析', !!m, r.text);
  if (m) {
    const [, from, to] = m;
    check('返回的字符数与实际一致', Number(to) === read().length && Number(from) === 13, from + ' → ' + to + ' / 实际 ' + read().length);
  }
}

// ---------------------------------------------------------------- 11) 真实源码防回归：产物里不得再有危险写法
{
  const src = fs.readFileSync(new URL('../src/server/tools.ts', import.meta.url), 'utf8');
  check('源码无 replace(oldText, newText)', src.split('.replace(oldText, newText)').length - 1 === 0, '');
  check('源码含 replaceLiteralOnce', src.includes('function replaceLiteralOnce'), '');
  check('源码含 replaceLiteralAll', src.includes('function replaceLiteralAll'), '');

  const dist = fs.readFileSync(new URL('../dist/server/tools.js', import.meta.url), 'utf8');
  check('产物无 replace(oldText, newText)', dist.split('.replace(oldText, newText)').length - 1 === 0, '');
  check('产物含长度防御', dist.includes('expectedLen'), '');
}

fs.rmSync(ws, { recursive: true, force: true });
console.log('\n' + (failed === 0 ? 'OK' : 'FAIL') + ': ' + (results.length - failed) + '/' + results.length + ' 项通过');
process.exit(failed === 0 ? 0 : 1);
