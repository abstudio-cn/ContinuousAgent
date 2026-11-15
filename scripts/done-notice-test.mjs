// 回归测试：完成提示不再显示「收到完成标记 [[DONE]]」，只保留「任务结束，已停止自动续跑。」
//   npm run build && node scripts/done-notice-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
let failed = 0;
function check(name, cond, extra) {
  results.push(!!cond);
  if (cond) return;
  failed++;
  console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + String(extra).slice(0, 600) : ''));
}

const KEEP = '任务结束，已停止自动续跑。';
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------------------------------------------------------------- 1) 服务端：源码与产物都不再推带前缀的文案
const agentSrc = read('src/server/agent.ts');
const agentDist = read('dist/server/agent.js');
check('源码推送干净文案', agentSrc.includes("this.pushItem('system', '" + KEEP + "');"), '');
check('源码不再拼接 DONE 前缀', !/pushItem\('system'[^)]*收到完成标记/.test(agentSrc), '');
check('产物推送干净文案', agentDist.includes(KEEP), '');
check('产物不含「收到完成标记」', !agentDist.includes('收到完成标记'), '(若仍有则是构建未跑)');

// 说明：DONE_TOKEN 仍被 extractDoneToken 使用，import 不能删
check('源码仍保留 DONE_TOKEN 的解析使用', agentSrc.includes('if (!trailing.endsWith(DONE_TOKEN))'), '');

// ---------------------------------------------------------------- 2) 客户端：从编译产物提取 systemItemText 并求值
const clientDist = read('dist/public/client/main.js');
const start = clientDist.indexOf('function systemItemText(');
check('产物含 systemItemText', start >= 0, '');

let systemItemText = null;
if (start >= 0) {
  // 先配平参数列表的圆括号，再取之后的第一个 '{'（避免误命中默认值 {}）
  let i = clientDist.indexOf('(', start);
  let depth = 0;
  for (; i < clientDist.length; i++) {
    if (clientDist[i] === '(') depth++;
    else if (clientDist[i] === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  let j = clientDist.indexOf('{', i);
  let braces = 0;
  let k = j;
  for (; k < clientDist.length; k++) {
    const c = clientDist[k];
    if (c === '{') braces++;
    else if (c === '}') {
      braces--;
      if (braces === 0) break;
    }
  }
  const body = clientDist.slice(start, k + 1);
  systemItemText = new Function(body + '; return systemItemText;')();
  check('成功提取并求值 systemItemText', typeof systemItemText === 'function', body.slice(0, 200));
}

if (typeof systemItemText === 'function') {
  const legacy = '收到完成标记 [[DONE]]：' + KEEP;
  check('旧文案只留后半句', systemItemText(legacy) === KEEP, JSON.stringify(systemItemText(legacy)));
  check('新文案原样显示', systemItemText(KEEP) === KEEP, JSON.stringify(systemItemText(KEEP)));
  check('半角冒号也能剥离', systemItemText('收到完成标记 [[DONE]]: ' + KEEP) === KEEP, JSON.stringify(systemItemText('收到完成标记 [[DONE]]: ' + KEEP)));
  check('无空格变体也能剥离', systemItemText('收到完成标记[[DONE]]：' + KEEP) === KEEP, JSON.stringify(systemItemText('收到完成标记[[DONE]]：' + KEEP)));
  check('只有前缀时补回后半句', systemItemText('收到完成标记 [[DONE]]') === KEEP, JSON.stringify(systemItemText('收到完成标记 [[DONE]]')));
  check('其它系统消息不受影响', systemItemText('已中断当前运行。') === '已中断当前运行。', '');
  check('中途出现 DONE 的文本不误伤', systemItemText('本任务已输出 [[DONE]] 并结束') === '本任务已输出 [[DONE]] 并结束', '');
  check('空文本安全', systemItemText('') === '', JSON.stringify(systemItemText('')));
  check('null/undefined 安全', systemItemText(null) === '' && systemItemText(undefined) === '', '');
}

// ---------------------------------------------------------------- 3) 渲染确实用了它
const clientSrc = read('src/client/main.ts');
check('renderItem 的 system 分支改用兼容函数', /const tag = el\('span', 'tag', systemItemText\(item\.text\)\);/.test(clientSrc), '');
check('客户端不再直接渲染 item.text 到 tag', !/el\('span', 'tag', item\.text\)/.test(clientSrc), '');

// ---------------------------------------------------------------- 4) 现有真实时间线：渲染后不再含「收到完成标记」
const dataDir = path.join(process.env.APPDATA || '', 'ContinuousAgent', 'sessions');
if (fs.existsSync(dataDir) && typeof systemItemText === 'function') {
  let total = 0;
  let leftover = 0;
  for (const id of fs.readdirSync(dataDir)) {
    const f = path.join(dataDir, id, 'timeline.json');
    if (!fs.existsSync(f)) continue;
    let items = [];
    try {
      items = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it || it.kind !== 'system' || typeof it.text !== 'string') continue;
      if (!it.text.includes('收到完成标记')) continue;
      total++;
      if (systemItemText(it.text).includes('收到完成标记')) leftover++;
    }
  }
  check('历史 system 条目渲染后不含「收到完成标记」（共 ' + total + ' 条）', leftover === 0, '仍有 ' + leftover + ' 条');
}

console.log('\n' + (failed === 0 ? 'OK' : 'FAIL') + ': ' + (results.length - failed) + '/' + results.length + ' 项通过');
process.exit(failed === 0 ? 0 : 1);
