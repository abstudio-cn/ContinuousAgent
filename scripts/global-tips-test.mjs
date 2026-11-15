// 全局技巧库回归测试：脱敏、项目信息拦截、频次、容量淘汰、开关与提示词注入。
//   npm run build && node scripts/global-tips-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeTip, GlobalTipsStore } from '../dist/server/tips.js';
import { ToolExecutor, buildToolCatalog } from '../dist/server/tools.js';
import { NativeBridge } from '../dist/server/native.js';
import { defaultSettings, mergeSettings } from '../dist/server/settings.js';
import { STATIC_SYSTEM_PROMPT, TIPS_MAX_CHARS, TIPS_INJECT_MAX_CHARS, TIP_MAX_CHARS } from '../dist/shared/prompt.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-tips-'));
const results = [];
let failed = 0;
function check(name, cond, extra) {
  results.push(!!cond);
  if (cond) return;
  failed++;
  console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + String(extra).slice(0, 500) : ''));
}

// ---------------------------------------------------------------- 1) 脱敏
const s1 = sanitizeTip('用 exec_command 跑 "C:\\Users\\abstudio\\proj\\build.ps1"，超时看 stderr');
check('Windows 路径被脱敏', s1.ok && s1.text.includes('<路径>') && !s1.text.includes('abstudio'), s1.text);
check('记录脱敏类别', s1.redactions.includes('路径'), JSON.stringify(s1.redactions));

const s2 = sanitizeTip('抓不到就用 https://api.example.com/v1/chat?x=1 试试，或问 dev@example.com');
check('链接被脱敏', s2.ok && s2.text.includes('<链接>') && !s2.text.includes('example.com'), s2.text);
check('邮箱被脱敏', s2.text.includes('<邮箱>'), s2.text);

const s3 = sanitizeTip('key 是 sk-abcdefghijklmnop1234，服务在 10.0.0.8:7800');
check('密钥被脱敏', s3.ok && !s3.text.includes('sk-abc'), s3.text);
check('IP:端口被脱敏', s3.text.includes('<IP>') && !s3.text.includes('10.0.0.8'), s3.text);

const s4 = sanitizeTip('客户端 ID 是 550e8400-e29b-41d4-a716-446655440000');
check('GUID 被脱敏', s4.ok && s4.text.includes('<ID>') && !s4.text.includes('550e8400'), s4.text);

const s5 = sanitizeTip('APPDATA 下的配置在 %APPDATA%\\SomeApp\\config.json');
check('环境变量路径被脱敏', s5.ok && s5.text.includes('<路径>'), s5.text);

const s6 = sanitizeTip('长任务加 background=true，配 wait_ms 避免死等');
check('通用技巧不被误伤', s6.ok && s6.text === '长任务加 background=true，配 wait_ms 避免死等', s6.text);

const s7 = sanitizeTip('   ');
check('空内容被拒绝', s7.ok === false, JSON.stringify(s7));

const s8 = sanitizeTip('技巧'.repeat(2000));
check('超长内容被截断', s8.ok && Array.from(s8.text).length <= TIP_MAX_CHARS && s8.truncated, String(Array.from(s8.text).length));

// 纯字母长串会先被「长串」规则脱敏，不会进入截断分支（脱敏优先是正确的）
const s8b = sanitizeTip('x'.repeat(5000));
check('纯长串被脱敏而非截断', s8b.ok && s8b.text === '<已脱敏>', s8b.text);

const s9 = sanitizeTip('多行\n技巧\n要折叠成单行');
check('多行折叠成单行', s9.ok && !s9.text.includes('\n'), JSON.stringify(s9.text));

// ---------------------------------------------------------------- 2) 项目信息拦截
const hints = ['C:\\Users\\abstudio\\Documents\\SomeProject', 'SomeProject', 'sess123456'];
const p1 = sanitizeTip('在 SomeProject 里跑构建脚本', hints);
check('动态敏感词被拒绝', p1.ok === false && /专有信息/.test(p1.reason || ''), p1.reason);

const p2 = sanitizeTip('先改 package.json 的 scripts 再跑构建', hints);
check('package.json 被拒绝', p2.ok === false && /项目信息/.test(p2.reason || ''), p2.reason);

const p3 = sanitizeTip('把 src/server/index.ts 里的入口改掉', hints);
check('项目源码结构被拒绝', p3.ok === false, p3.reason);

const p4 = sanitizeTip('在 .git 里能看到提交历史', hints);
check('仓库信息被拒绝', p4.ok === false, p4.reason);

const p5 = sanitizeTip('用 sess123456 作为会话标识', hints);
check('会话 id 被拒绝', p5.ok === false, p5.reason);

// ---------------------------------------------------------------- 3) 增删查 + 频次
const storeFile = path.join(tmp, 'global_tips.json');
const store = new GlobalTipsStore(storeFile, () => hints);

const a1 = store.add('exec_command 用 background=true 跑长任务，再用 exec_output 取增量输出');
check('add 成功并分配 id', a1.ok === true && !!a1.id, JSON.stringify(a1));
check('add 后统计正确', store.stats().count === 1 && store.stats().chars > 0, JSON.stringify(store.stats()));
check('上限是 100000', store.stats().max === TIPS_MAX_CHARS, String(store.stats().max));

const a2 = store.add('exec_command 用 background=true 跑长任务，再用 exec_output 取增量输出。');
check('等价内容被合并', a2.ok === true && a2.reinforced === true && a2.id === a1.id, JSON.stringify(a2));
check('合并后条目数不变', store.stats().count === 1, String(store.stats().count));
check('合并即累加频次', store.list()[0].uses === 2, String(store.list()[0].uses));

const a3 = store.add('在 SomeProject 里跑 build');
check('add 拒绝项目信息', a3.ok === false && /专有信息/.test(a3.reason || ''), a3.reason);
check('被拒绝的条目没有入库', store.stats().count === 1, String(store.stats().count));

const use1 = store.markUsed(a1.id, 3);
check('use 累加频次', use1.ok === true && use1.tip.uses === 5, JSON.stringify(use1));
check('use 不存在的 id 报错', store.markUsed('t999').ok === false, '');

// 持久化：新实例能读回
const store2 = new GlobalTipsStore(storeFile, () => hints);
check('落盘后可读回', store2.stats().count === 1 && store2.list()[0].uses === 5, JSON.stringify(store2.stats()));

// 不可逆操作之前先备份（remove 只在本测试自己的临时库里做）
check('remove 生效', store2.remove(a1.id) === true, '');
check('remove 后为空', store2.stats().count === 0, '');
check('remove 不存在的 id 返回 false', store2.remove('t404') === false, '');

// ---------------------------------------------------------------- 4) 容量淘汰（低频优先清除）
const ev = new GlobalTipsStore(path.join(tmp, 'evict.json'), () => []);
const filler = '把长任务放到后台执行并读取增量输出，避免阻塞当前轮次与用户交互。';
const ids = [];
for (let i = 0; i < 70; i++) {
  const r = ev.add('第 ' + i + ' 条：' + filler.repeat(50));
  if (!r.ok) {
    check('容量测试写入第 ' + i + ' 条', false, r.reason);
    break;
  }
  ids.push(r.id);
  // 前 3 条一入库就抬高频次：等频次时按「最久未用」淘汰，不抬就会被先淘汰
  if (i < 3) ev.markUsed(r.id, 500);
}
const evStats = ev.stats();
check('超上限后总字符回落到上限内', evStats.chars <= TIPS_MAX_CHARS, JSON.stringify(evStats));
check('确实发生了淘汰', evStats.count < ids.length, '写入 ' + ids.length + ' 条，现存 ' + evStats.count);

// 继续写入，确认高频条目不被淘汰
let evictedTotal = 0;
for (let i = 0; i < 40; i++) {
  const r = ev.add('追加 ' + i + '：' + filler.repeat(50));
  if (r.ok && r.evicted) evictedTotal += r.evicted.length;
}
check('此轮又发生淘汰', evictedTotal > 0, String(evictedTotal));
check('高频条目全部保留', ids.slice(0, 3).every((id) => ev.list().some((t) => t.id === id)), '');
check('淘汰后仍在容量内', ev.stats().chars <= TIPS_MAX_CHARS, JSON.stringify(ev.stats()));
const survivorIds = new Set(ev.list().map((t) => t.id));
const removedHigh = ids.slice(0, 3).filter((id) => !survivorIds.has(id));
check('没有误删高频条目', removedHigh.length === 0, JSON.stringify(removedHigh));

// ---------------------------------------------------------------- 5) 提示词注入与开关
const inj = new GlobalTipsStore(path.join(tmp, 'inject.json'), () => []);
inj.add('优先用 edit_file 做精确替换，避免整文件重写');
inj.add('截图为缩放图，只用于观察，坐标用客户区像素');
inj.markUsed(inj.list()[1].id, 9);

const blockOn = inj.buildPromptBlock(true);
check('开启时注入提示块', blockOn.includes('CONTINUOUS_AGENT_TIPS_BEGIN'), blockOn.slice(0, 120));
check('注入内容含条目 id 与频次', /\[t\d+\] 用 \d+ 次｜/.test(blockOn), blockOn.slice(0, 400));
check('按频次降序注入', blockOn.indexOf('用 9 次') < blockOn.indexOf('用 1 次'), blockOn);
check('注入块声明只含通用技巧', blockOn.includes('不含任何项目'), '');
check('关闭时完全不注入', inj.buildPromptBlock(false) === '', JSON.stringify(inj.buildPromptBlock(false)));

const emptyStore = new GlobalTipsStore(path.join(tmp, 'empty.json'), () => []);
check('空库不注入', emptyStore.buildPromptBlock(true) === '', '');

const bigBlock = ev.buildPromptBlock(true);
check('注入受字符预算限制', bigBlock.length <= TIPS_INJECT_MAX_CHARS + 1200, String(bigBlock.length));
check('超出预算的条目标注省略', /另有 \d+ 条因注入预算未附带/.test(bigBlock), bigBlock.slice(0, 400));

// ---------------------------------------------------------------- 6) 设置项
const def = defaultSettings();
check('默认开启', def.globalTipsEnabled === true, String(def.globalTipsEnabled));
const merged = mergeSettings(def, { globalTipsEnabled: false });
check('可关闭', merged.globalTipsEnabled === false, String(merged.globalTipsEnabled));
const merged2 = mergeSettings(merged, {});
check('非法值保持原值', merged2.globalTipsEnabled === false, String(merged2.globalTipsEnabled));
check('STATIC_SYSTEM_PROMPT 含技巧库规则', STATIC_SYSTEM_PROMPT.includes('全局技巧库') && STATIC_SYSTEM_PROMPT.includes('不写项目名'), '');

// ---------------------------------------------------------------- 7) 工具层
const catalog = buildToolCatalog();
const spec = catalog.find((t) => t.function.name === 'global_tips');
check('工具清单含 global_tips', !!spec, '');
check('action 枚举齐全', !!spec && JSON.stringify(spec.function.parameters.properties.action.enum) === '["add","use","list","remove"]', '');
check('action 必填', !!spec && JSON.stringify(spec.function.parameters.required) === '["action"]', '');

const settings = { ...defaultSettings(), workspacePath: path.join(tmp, 'ws'), allowShell: true };
fs.mkdirSync(settings.workspacePath, { recursive: true });
const toolsStore = new GlobalTipsStore(path.join(tmp, 'tool_tips.json'), () => ['SomeProject']);
const tools = new ToolExecutor(settings, new NativeBridge(), toolsStore);
const signal = new AbortController().signal;

const rAdd = await tools.execute('global_tips', JSON.stringify({
  action: 'add',
  text: 'PowerShell 里输出中文先设 [Console]::OutputEncoding，否则 stdout 乱码',
}), signal);
check('工具 add 成功', rAdd.isError === false && /已加入全局技巧库/.test(rAdd.text), rAdd.text);

const rAdd2 = await tools.execute('global_tips', JSON.stringify({
  action: 'add',
  text: '在 SomeProject 里跑构建脚本，先看 npm script 名字',
}), signal);
check('工具拒绝项目信息', rAdd2.isError === true && /专有信息/.test(rAdd2.text), rAdd2.text);

// 路径会被脱敏成占位符，不应因路径而拒绝（脱敏后已无项目信息）
const rAdd3 = await tools.execute('global_tips', JSON.stringify({
  action: 'add',
  text: '用 exec_command 在 C:\\Users\\abstudio\\Documents\\SomeProject\\ 下跑构建',
}), signal);
check('路径先脱敏不报错', rAdd3.isError === false && /已脱敏/.test(rAdd3.text) && !rAdd3.text.includes('abstudio'), rAdd3.text);

const rList = await tools.execute('global_tips', JSON.stringify({ action: 'list' }), signal);
check('工具 list 可用', rList.isError === false && /全局技巧库：2 条/.test(rList.text), rList.text);

const idInStore = toolsStore.list()[0].id;
const rUse = await tools.execute('global_tips', JSON.stringify({ action: 'use', id: idInStore, times: 2 }), signal);
check('工具 use 记录频次', rUse.isError === false && /累计 3 次/.test(rUse.text), rUse.text);

const rUseAll = await tools.execute('global_tips', JSON.stringify({ action: 'use', ids: [idInStore, 't999'] }), signal);
check('批量 use 报告未找到条目', rUseAll.isError === false && /未找到条目/.test(rUseAll.text), rUseAll.text);

const rBad = await tools.execute('global_tips', JSON.stringify({ action: 'nope' }), signal);
check('未知 action 报错', rBad.isError === true, rBad.text);

const rRemove = await tools.execute('global_tips', JSON.stringify({ action: 'remove', id: idInStore }), signal);
check('工具 remove 生效', rRemove.isError === false && toolsStore.stats().count === 1, rRemove.text);

// runtimeContext 反映开关状态
const ctxOn = tools.runtimeContext(0);
check('运行时上下文提示已启用', ctxOn.includes('全局技巧库: 已启用'), '');
tools.updateSettings({ ...settings, globalTipsEnabled: false });
const ctxOff = tools.runtimeContext(0);
check('运行时上下文提示已关闭', ctxOff.includes('用户已在设置中关闭'), '');

// ---------------------------------------------------------------- 8) 默认数据目录位置（全局而非按会话）
check('技巧库落在数据目录而非会话目录', !storeFile.includes(path.sep + 'sessions' + path.sep), storeFile);

// ---------------------------------------------------------------- 9) 设置面板条目名单接线
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0)), '..');
const clientJs = fs.readFileSync(path.join(repo, 'dist', 'public', 'client', 'main.js'), 'utf8');
const cssText = fs.readFileSync(path.join(repo, 'public', 'styles.css'), 'utf8');

check('客户端定义 list 渲染函数', clientJs.includes('function loadTipsList'), '');
check('客户端只请求一次 /api/tips', clientJs.split('/api/tips').length - 1 === 1, String(clientJs.split('/api/tips').length - 1));
check('技巧库分区挂载名单', clientJs.includes("el('div', 'tips-list')") && clientJs.includes('void loadTipsList('), '');
check('名单渲染 id / 频次 / 原文', clientJs.includes('tip-id') && clientJs.includes('tip-uses') && clientJs.includes('tip-text'), '');
check('未使用条目有文案', clientJs.includes('未使用'), '');
check('读取失败有提示', clientJs.includes('读取条目失败'), '');
check('空库有提示', clientJs.includes('库里还没有条目'), '');
check('提供刷新按钮', clientJs.includes("el('button', 'tips-refresh', '刷新')"), '');
check('样式包含名单类', ['.tips-head', '.tip-row', '.tip-meta', '.tip-text'].every((c) => cssText.includes(c)), '');

console.log('\n' + (failed === 0 ? 'OK' : 'FAIL') + ': ' + (results.length - failed) + '/' + results.length + ' 项通过');
console.log('临时目录: ' + tmp);
process.exit(failed === 0 ? 0 : 1);
