// 插件系统回归测试：
//   A. 设置默认值与合并
//   B. 清单解析容错（坏 JSON / 缺 purpose / 非法 id / 占位符未声明 …）
//   C. 命名空间、工具清单、启用开关
//   D. buildInvocation（参数校验与占位符展开）
//   E. 真实执行（成功 / 非零退出 / 超时 / 输出截断）
//   F. ToolExecutor 集成：核心不受影响 + 审计强制（无审计人→拒绝、拒绝→不执行、允许→执行）
//   G. 产物接线（服务端路由 / 客户端卡片 / 样式）
//   npm run build && node scripts/plugin-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginRegistry, buildInvocation, PLUGIN_LIMITS } from '../dist/server/plugins.js';
import { ToolExecutor, buildToolCatalog } from '../dist/server/tools.js';
import { NativeBridge } from '../dist/server/native.js';
import { defaultSettings, mergeSettings } from '../dist/server/settings.js';
import { GlobalTipsStore } from '../dist/server/tips.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
let failed = 0;
function check(name, cond, extra) {
  results.push(!!cond);
  if (cond) return;
  failed++;
  console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + String(extra).slice(0, 400) : ''));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-plugin-'));
const pluginRoot = path.join(tmp, 'plugins');
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });

/** 造一个插件目录：manifest 传对象=JSON 序列化，传字符串=原样写入，传 undefined=不写 plugin.json */
function makePlugin(name, manifest, files = {}) {
  const dir = path.join(pluginRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
      'utf8',
    );
  }
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content, 'utf8');
  return dir;
}

const NODE = process.execPath;
const marker = path.join(tmp, 'marker.txt');
const echoTool = {
  name: 'echo',
  description: '回显一段文本',
  purpose: '测试用：只回显，不写任何文件',
  parameters: { text: '要回显的文本' },
  required: ['text'],
  argv: [NODE, '-e', 'console.log("ECHO:" + process.argv[1])', '{{text}}'],
  timeoutMs: 20000,
};
const writeTool = {
  name: 'touch_marker',
  description: '创建标记文件（用于判定是否真的被执行）',
  purpose: '测试用：写一个标记文件',
  parameters: { file: '目标文件绝对路径' },
  required: ['file'],
  argv: [NODE, '-e', 'require("fs").writeFileSync(process.argv[1], "ran")', '{{file}}'],
  timeoutMs: 20000,
};

// ---------------------------------------------------------------- A) 设置
const def = defaultSettings();
check('A1 插件默认关闭', def.pluginsEnabled === false, String(def.pluginsEnabled));
check('A2 默认超时 60000', def.pluginTimeoutMs === 60000, String(def.pluginTimeoutMs));
const mOn = mergeSettings(def, { pluginsEnabled: true });
check('A3 merge 可开启', mOn.pluginsEnabled === true, String(mOn.pluginsEnabled));
const mBad = mergeSettings(def, { pluginsEnabled: 'yes' });
check('A4 非布尔值不会开启', mBad.pluginsEnabled === false, String(mBad.pluginsEnabled));
const mLow = mergeSettings(def, { pluginTimeoutMs: 1 });
check('A5 超时下限夹到 1000', mLow.pluginTimeoutMs === 1000, String(mLow.pluginTimeoutMs));
const mHigh = mergeSettings(def, { pluginTimeoutMs: 99_999_999 });
check('A6 超时上限夹到 600000', mHigh.pluginTimeoutMs === 600000, String(mHigh.pluginTimeoutMs));
const mStr = mergeSettings(def, { pluginTimeoutMs: '15000' });
check('A7 字符串数值可解析', mStr.pluginTimeoutMs === 15000, String(mStr.pluginTimeoutMs));

// ---------------------------------------------------------------- B) 清单容错
const coreCatalog = buildToolCatalog();
const coreNames = coreCatalog.map((t) => t.function.name);

// B 组单独用一个干净目录，避免互相干扰
const isoRoot = path.join(tmp, 'iso');
const isoReg = new PluginRegistry(isoRoot, () => 30000, coreNames);
isoReg.reload();
check('B1 目录不存在时自动创建且不抛', fs.existsSync(isoRoot) === true);
check('B2 空目录得到空清单', isoReg.list().length === 0, JSON.stringify(isoReg.list()));

const isoBad = [
  ['no-manifest', undefined, '缺少 plugin.json'],
  ['bad-json', '{ not json', '解析失败'],
  ['no-purpose', { id: 'x1', name: '没有用途', tools: [echoTool] }, 'purpose'],
  ['bad-id', { id: '带中文的id', purpose: '用途', tools: [echoTool] }, 'id 不合法'],
  ['no-tools', { id: 'x2', purpose: '用途', tools: [] }, '没有声明任何 tools'],
  ['bad-tool-name', { id: 'x3', purpose: '用途', tools: [{ name: '坏 名字', argv: [NODE] }] }, '工具 name 不合法'],
  ['no-argv', { id: 'x4', purpose: '用途', tools: [{ name: 'ok', description: '无命令' }] }, 'argv'],
  [
    'undeclared-placeholder',
    { id: 'x5', purpose: '用途', tools: [{ name: 'ok', argv: [NODE, '-e', '1', '{{notdeclared}}'] }] },
    '未声明的占位符',
  ],
  [
    'not-object',
    '[]',
    'JSON 对象',
  ],
];
for (const [name, manifest, expect] of isoBad) {
  const dir = path.join(isoRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(dir, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8');
  }
}
isoReg.reload();
const isoList = isoReg.list();
check('B3 坏插件数量 = 9', isoList.length === 9, String(isoList.length));
for (const [name, , expect] of isoBad) {
  const one = isoList.find((p) => p.dir.endsWith(name));
  check('B4 ' + name + ' 被拒绝且错误信息含「' + expect + '」', one && one.error.includes(expect), one && one.error);
  check('B5 ' + name + ' 不提供任何工具', one && one.tools.length === 0, one && JSON.stringify(one.tools));
}
check('B6 全部错误插件都不产生可用工具', isoReg.availableToolCount === 0, String(isoReg.availableToolCount));
check('B7 错误清单仍然对外可见（供界面展示）', isoReg.list().every((p) => typeof p.error === 'string' && p.error.length > 0));
check('B8 reload 不抛异常（连续两次）', (() => {
  try {
    isoReg.reload();
    isoReg.reload();
    return true;
  } catch {
    return false;
  }
})());

// ---------------------------------------------------------------- C) 命名空间与工具清单
makePlugin('good', {
  id: 'good',
  name: '好插件',
  version: '2.1.0',
  purpose: '测试用：回显与写标记文件',
  tools: [echoTool, writeTool],
});
makePlugin('disabled', {
  id: 'disabled',
  name: '被禁用的插件',
  purpose: '测试用：默认禁用，不应出现工具',
  enabled: false,
  tools: [{ ...echoTool, name: 'echo2' }],
});
makePlugin('same-id-a', { id: 'dup', name: 'A', purpose: '重复 id 测试 A', tools: [{ ...echoTool, name: 'a_echo' }] });
makePlugin('same-id-b', { id: 'dup', name: 'B', purpose: '重复 id 测试 B', tools: [{ ...echoTool, name: 'b_echo' }] });

const reg = new PluginRegistry(pluginRoot, () => 30000, coreNames);
reg.reload();
const list = reg.list();
check('C1 目录扫描出 4 个插件', list.length === 4, list.map((p) => p.id).join(','));
const good = list.find((p) => p.id === 'good');
check('C2 好插件加载成功', !!good && good.error === '', good && good.error);
check('C3 用途被保留', !!good && good.purpose.includes('回显'), good && good.purpose);
check('C4 版本被保留', !!good && good.version === '2.1.0', good && good.version);
check(
  'C5 工具名带命名空间',
  !!good && good.tools.every((t) => t.globalName === 'plugin__good__' + t.name),
  good && JSON.stringify(good.tools.map((t) => t.globalName)),
);
const dupA = list.find((p) => p.dir.endsWith('same-id-a'));
const dupB = list.find((p) => p.dir.endsWith('same-id-b'));
check('C6 重复 id 之一被拒绝', !!dupB && dupB.error.includes('id 重复'), dupB && dupB.error);
check('C7 重复 id 的插件不提供工具', !!dupB && dupB.tools.length === 0);
check('C8 先扫描到的仍然可用', !!dupA && dupA.error === '', dupA && dupA.error);

const specs = reg.toolSpecs();
const specNames = specs.map((s) => s.function.name);
check('C9 禁用插件不出工具', !specNames.includes('plugin__disabled__echo2'), specNames.join(','));
check('C10 可用工具共 3 个（good 2 + 重复 id 的 a_echo 1）', specs.length === 3, specNames.join(','));
check('C11 工具名全部带 plugin__ 前缀', specNames.every((n) => n.startsWith('plugin__')), specNames.join(','));
check('C12 工具名与核心工具零交集', specNames.every((n) => !coreNames.includes(n)));
const echoSpec = specs.find((s) => s.function.name === 'plugin__good__echo');
check('C13 工具描述里写明用途', !!echoSpec && echoSpec.function.description.includes('用途'), echoSpec && echoSpec.function.description);
check('C14 工具描述里提到需要审计确认', !!echoSpec && echoSpec.function.description.includes('审计'), echoSpec && echoSpec.function.description);
check('C15 参数字段透传', !!echoSpec && !!echoSpec.function.parameters.properties.text);
check('C16 required 透传', !!echoSpec && echoSpec.function.parameters.required.includes('text'));
check('C17 find 能定位工具', !!reg.find('plugin__good__echo'));
check('C18 find 对未知工具返回 null', reg.find('plugin__nope__x') === null);
check('C19 find 对核心工具名返回 null', reg.find('read_file') === null);

// ---------------------------------------------------------------- D) buildInvocation
const echoToolDef = reg.find('plugin__good__echo').tool;
const inv1 = buildInvocation(echoToolDef, { text: 'hello' }, '/tmp/x');
check('D1 正常参数展开', inv1.error === '' && inv1.argv.join('|').includes('hello'), JSON.stringify(inv1));
check('D2 命令预览非空', inv1.display.length > 0, inv1.display);
const inv2 = buildInvocation(echoToolDef, {}, '/tmp/x');
check('D3 缺必填参数报错', inv2.error.includes('缺少必填参数'), inv2.error);
const inv3 = buildInvocation(echoToolDef, { text: 'a', evil: 'x' }, '/tmp/x');
check('D4 未知参数报错', inv3.error.includes('未知参数'), inv3.error);
const inv4 = buildInvocation(echoToolDef, { text: 'x'.repeat(PLUGIN_LIMITS.maxArgValueChars + 10) }, '/tmp/x');
check('D5 超长参数被拒绝', inv4.error.includes('过长'), inv4.error);
const dirTool = {
  name: 'd',
  parameters: {},
  required: [],
  argv: [NODE, '-e', 'console.log(process.argv[1])', '{{pluginDir}}'],
  command: null,
  localName: 'd',
};
const inv5 = buildInvocation(dirTool, {}, 'C:\\plug dir\\x');
check('D6 {{pluginDir}} 展开为插件目录', inv5.error === '' && inv5.argv[inv5.argv.length - 1] === 'C:\\plug dir\\x', JSON.stringify(inv5));
const optTool = {
  name: 'o',
  parameters: { a: '必填', b: '可选' },
  required: ['a'],
  argv: [NODE, '-e', '1', '{{a}}', '{{b?}}'],
  command: null,
  localName: 'o',
};
const inv6 = buildInvocation(optTool, { a: 'A' }, '/p');
check('D7 可选占位符缺省展开为空串', inv6.error === '' && inv6.argv[4] === '', JSON.stringify(inv6));
const cmdTool = {
  name: 'c',
  parameters: { p: '参数' },
  required: ['p'],
  argv: null,
  command: 'echo {{p}}',
  localName: 'c',
};
const inv7 = buildInvocation(cmdTool, { p: 'a b; rm -rf /' }, '/p');
check('D8 command 模式对特殊字符加引号', inv7.error === '' && /'a b; rm -rf \/'|"a b; rm -rf \/"/.test(inv7.command), inv7.command);
const inv8 = buildInvocation(
  { ...cmdTool, parameters: { v: { type: 'number', description: '数值' } }, required: ['v'], command: 'echo {{v}}' },
  { v: 42 },
  '/p',
);
check('D9 数值参数转字符串', inv8.error === '' && inv8.command.includes('42'), JSON.stringify(inv8));

// ---------------------------------------------------------------- E) 真实执行
const goodPlugin = reg.find('plugin__good__echo').plugin;
const goodEcho = reg.find('plugin__good__echo').tool;
const runEcho = await reg.run(goodPlugin, goodEcho, { text: '插件世界' });
check('E1 成功执行退出码 0', runEcho.code === 0 && runEcho.error === '', JSON.stringify(runEcho).slice(0, 300));
check('E2 stdout 收到回显', runEcho.stdout.includes('ECHO:插件世界'), runEcho.stdout);
check('E3 ok 标记为真', runEcho.ok === true);
check('E4 耗时字段合理', runEcho.ms >= 0 && runEcho.ms < 30000, String(runEcho.ms));

const goodTouch = reg.find('plugin__good__touch_marker').tool;
const touchRun = await reg.run(goodPlugin, goodTouch, { file: marker });
check('E5 能写标记文件', touchRun.code === 0 && fs.existsSync(marker), JSON.stringify(touchRun).slice(0, 300));

const failTool = {
  name: 'f',
  parameters: {},
  required: [],
  argv: [NODE, '-e', 'console.error("boom"); process.exit(3)'],
  command: null,
  localName: 'f',
  timeoutMs: 20000,
};
const runFail = await reg.run(goodPlugin, { ...failTool, globalName: 'plugin__good__f', description: '', purpose: '测试失败退出' }, {});
check('E6 非零退出如实上报', runFail.code === 3 && runFail.ok === false, JSON.stringify(runFail).slice(0, 200));
check('E7 stderr 被收集', runFail.stderr.includes('boom'), runFail.stderr);

const slowTool = {
  name: 'slow',
  parameters: {},
  required: [],
  argv: [NODE, '-e', 'setTimeout(() => {}, 5000)'],
  command: null,
  localName: 'slow',
  timeoutMs: 1000,
};
const t0 = Date.now();
const runSlow = await reg.run(goodPlugin, { ...slowTool, globalName: 'plugin__good__slow', description: '', purpose: '超时测试' }, {});
check('E8 超时被终止', runSlow.timedOut === true, JSON.stringify(runSlow).slice(0, 200));
check('E9 超时不判成功', runSlow.ok === false);
check('E10 超时耗时接近设定的 1s', Date.now() - t0 < 15000, String(Date.now() - t0));

const bigTool = {
  name: 'big',
  parameters: {},
  required: [],
  argv: [NODE, '-e', 'process.stdout.write("y".repeat(260000))'],
  command: null,
  localName: 'big',
  timeoutMs: 30000,
};
const runBig = await reg.run(goodPlugin, { ...bigTool, globalName: 'plugin__good__big', description: '', purpose: '大输出测试' }, {});
check('E11 超长输出被标记截断', runBig.truncated === true, String(runBig.stdout.length));
check('E12 截断后长度受控', runBig.stdout.length <= PLUGIN_LIMITS.maxOutputChars + 1024, String(runBig.stdout.length));

const missingExe = {
  name: 'nope',
  parameters: {},
  required: [],
  argv: ['definitely-not-a-real-binary-xyz-123'],
  command: null,
  localName: 'nope',
  timeoutMs: 5000,
};
const runMissing = await reg.run(goodPlugin, { ...missingExe, globalName: 'plugin__good__nope', description: '', purpose: '缺失程序测试' }, {});
check('E13 可执行文件不存在时不抛异常', runMissing.ok === false && runMissing.code !== 0, JSON.stringify(runMissing).slice(0, 200));

// ---------------------------------------------------------------- F) ToolExecutor 集成
const tips = new GlobalTipsStore(path.join(tmp, 'global_tips.json'), () => []);
const settingsOff = { ...defaultSettings(), workspacePath: ws };
const tools = new ToolExecutor(settingsOff, new NativeBridge(), tips);
const signal = new AbortController().signal;
const exec = (name, args) => tools.execute(name, JSON.stringify(args), signal);

// F1 关闭时：清单与「没有插件功能」完全一致
const offCatalog = tools.catalog();
check('F1 关闭时清单等于核心清单', JSON.stringify(offCatalog) === JSON.stringify(coreCatalog), String(offCatalog.length) + ' vs ' + coreCatalog.length);
check('F2 关闭时没有任何 plugin__ 工具', offCatalog.every((t) => !t.function.name.startsWith('plugin__')));
check('F3 关闭时核心工具数量不变', offCatalog.length === coreCatalog.length, String(offCatalog.length));

// 开启插件 + 注册表
const settingsOn = { ...defaultSettings(), workspacePath: ws, pluginsEnabled: true };
tools.updateSettings(settingsOn);
tools.setPluginRegistry(reg);
const onCatalog = tools.catalog();
check('F4 开启后多出 3 个插件工具', onCatalog.length === coreCatalog.length + 3, String(onCatalog.length));
check('F5 开启后核心工具一个不少', coreNames.every((n) => onCatalog.some((t) => t.function.name === n)));

// F6 没有审计人：一律拒绝
tools.setPluginAuditor(null);
const noAuditor = await exec('plugin__good__touch_marker', { file: path.join(tmp, 'never1.txt') });
check('F6 无审计界面时拒绝执行', noAuditor.isError === true && noAuditor.text.includes('没有可用的确认界面'), noAuditor.text);
check('F7 无审计界面时确实没执行', !fs.existsSync(path.join(tmp, 'never1.txt')));

// F8 用户拒绝：不执行
const auditCalls = [];
tools.setPluginAuditor(async (req) => {
  auditCalls.push(req);
  return false;
});
const denyTarget = path.join(tmp, 'never2.txt');
const denied = await exec('plugin__good__touch_marker', { file: denyTarget });
check('F8 用户拒绝后返回错误', denied.isError === true && denied.text.includes('用户未批准'), denied.text);
check('F9 用户拒绝后确实没执行', !fs.existsSync(denyTarget));
check('F10 审计请求带插件名', auditCalls.length === 1 && auditCalls[0].pluginName === '好插件', JSON.stringify(auditCalls[0] || {}));
check('F11 审计请求带用途', auditCalls.length === 1 && String(auditCalls[0].purpose).includes('标记文件'), String(auditCalls[0]?.purpose));
check('F12 审计请求带将执行的命令', auditCalls.length === 1 && String(auditCalls[0].command).includes('writeFileSync'), String(auditCalls[0]?.command).slice(0, 120));
check('F13 审计请求带参数', auditCalls.length === 1 && String(auditCalls[0].argsJson).includes('never2'), String(auditCalls[0]?.argsJson));
check('F14 审计请求带插件目录', auditCalls.length === 1 && String(auditCalls[0].dir).includes('good'), String(auditCalls[0]?.dir));

// F15 允许：执行
const okTarget = path.join(tmp, 'ran.txt');
const allowCalls = [];
tools.setPluginAuditor(async (req) => {
  allowCalls.push(req);
  return true;
});
const allowed = await exec('plugin__good__touch_marker', { file: okTarget });
check('F16 允许后执行成功', allowed.isError === false, allowed.text.slice(0, 300));
check('F17 允许后文件确实生成', fs.existsSync(okTarget));
check('F18 结果里写明退出码', allowed.text.includes('退出码'), allowed.text.slice(0, 200));
check('F19 结果里写明用途', allowed.text.includes('用途'), allowed.text.slice(0, 200));
check('F20 每次调用都问审计', allowCalls.length === 1, String(allowCalls.length));

// F21 审计人抛异常：拒绝且不冒泡
tools.setPluginAuditor(async () => {
  throw new Error('审计界面炸了');
});
const auditBoom = await exec('plugin__good__touch_marker', { file: path.join(tmp, 'never3.txt') });
check('F22 审计人异常时拒绝且不抛', auditBoom.isError === true && auditBoom.text.includes('审计流程出错'), auditBoom.text);
check('F23 审计人异常时没执行', !fs.existsSync(path.join(tmp, 'never3.txt')));

// F24 参数不合法：连审计都不问
let askedForBad = 0;
tools.setPluginAuditor(async () => {
  askedForBad++;
  return true;
});
const badArgs = await exec('plugin__good__touch_marker', { file: 1, extra: 'x' });
check('F25 未知参数直接拒绝', badArgs.isError === true && badArgs.text.includes('参数不合法'), badArgs.text);
check('F26 参数不合法时不打扰用户', askedForBad === 0, String(askedForBad));

// F27 关闭插件后即使注册表还在也不执行
tools.setPluginAuditor(async () => true);
tools.updateSettings({ ...settingsOn, pluginsEnabled: false });
const offExec = await exec('plugin__good__touch_marker', { file: path.join(tmp, 'never4.txt') });
check('F28 关闭后插件工具不可用', offExec.isError === true && offExec.text.includes('未知工具'), offExec.text);
check('F29 关闭后确实没执行', !fs.existsSync(path.join(tmp, 'never4.txt')));
check('F30 关闭后清单回到核心清单', JSON.stringify(tools.catalog()) === JSON.stringify(coreCatalog));

// F31 注册表内部抛异常时，catalog 仍返回核心清单
tools.updateSettings(settingsOn);
const broken = {
  availableToolCount: 1,
  find: () => null,
  preview: () => ({ command: '', error: '' }),
  toolSpecs: () => {
    throw new Error('清单生成炸了');
  },
};
tools.setPluginRegistry(broken);
const survived = tools.catalog();
check('F32 插件清单异常时回退核心清单', JSON.stringify(survived) === JSON.stringify(coreCatalog), String(survived.length));
check('F33 回退后核心工具齐全', coreNames.every((n) => survived.some((t) => t.function.name === n)));
tools.setPluginRegistry(reg);

// F34 核心工具回归：插件接进来后核心工具照常工作
const env = await exec('get_environment', {});
check('F35 核心工具 get_environment 正常', env.isError === false && env.text.includes(ws), env.text.slice(0, 200));
const unknown = await exec('totally_unknown_tool', {});
check('F36 未知工具仍给未知工具错误', unknown.isError === true && unknown.text.includes('未知工具'), unknown.text);

// F37 运行时上下文只在开启时追加插件段
const ctxOn = tools.runtimeContext();
check('F38 开启插件时上下文提到 plugin__', ctxOn.includes('plugin__'), ctxOn.split('\n').filter((l) => l.includes('插件')).join(' / '));
check('F39 上下文说明每次调用都要审计', ctxOn.includes('审计'), '');
tools.updateSettings({ ...settingsOn, pluginsEnabled: false });
const ctxOff = tools.runtimeContext();
check('F40 关闭插件时上下文不含插件段', !ctxOff.includes('plugin__'), ctxOff.split('\n').filter((l) => l.includes('插件')).join(' / '));

// ---------------------------------------------------------------- G) 产物接线
const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8');
const count = (hay, needle) => hay.split(needle).length - 1;

const serverPlugins = read('dist/server/plugins.js');
check('G1 产物含 plugins.js', serverPlugins.includes('PluginRegistry'));
check('G2 产物含命名空间前缀', serverPlugins.includes('plugin__'));
check('G3 产物含 limits', serverPlugins.includes('maxOutputChars'));
const serverTools = read('dist/server/tools.js');
check('G4 tools.js 含 setPluginAuditor', count(serverTools, 'setPluginAuditor') >= 1);
check('G5 tools.js 含 catalog()', count(serverTools, 'catalog()') >= 1);
check('G6 tools.js 含插件执行入口', serverTools.includes('executePluginTool'));
check('G7 tools.js 不含重复 default 分支', count(serverTools, "default: return err(") === 0);
const serverIndex = read('dist/server/index.js');
check('G8 index.js 含插件路由', serverIndex.includes("'/api/plugins'"));
check('G9 index.js 含重载路由', serverIndex.includes('/api/plugins/reload'));
check('G10 index.js 含审计响应路由', serverIndex.includes('/api/plugin/respond'));
check('G11 index.js 含审计日志文件名', serverIndex.includes('plugin_audit.jsonl'));
check('G12 index.js 注册了审计代理', serverIndex.includes('setPluginAuditor'));
const clientJs = read('dist/public/client/main.js');
check('G13 客户端含插件审计卡片函数', clientJs.includes('pluginAuditCard'));
check('G14 客户端含审计标题文案', clientJs.includes('插件调用审计'));
check('G15 客户端含「允许本次」按钮', clientJs.includes('允许本次'));
check('G16 客户端含「本会话允许」按钮', clientJs.includes('本会话允许'));
check('G17 客户端调用审计响应接口', clientJs.includes('/api/plugin/respond'));
check('G18 客户端设置含插件开关', clientJs.includes('pluginsEnabled'));
check('G19 客户端设置含重载按钮', clientJs.includes('重新扫描插件目录'));
const css = read('public/styles.css');
check('G20 样式含命令预览样式', css.includes('.plugin-cmd'));
check('G21 样式含插件列表样式', css.includes('.plugin-row'));

const example = read('examples/plugins/sys-info/plugin.json');
check('G22 示例插件是合法 JSON 且带 purpose', (() => {
  try {
    const m = JSON.parse(example);
    return typeof m.purpose === 'string' && m.purpose.length > 0 && Array.isArray(m.tools) && m.tools.length > 0;
  } catch {
    return false;
  }
})());

// ---------------------------------------------------------------- 汇总
const passed = results.filter(Boolean).length;
console.log('');
if (failed > 0) {
  console.log('FAIL: ' + failed + ' / ' + results.length + ' 项未通过');
  process.exit(1);
}
console.log('OK: ' + passed + '/' + results.length + ' 项通过');
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}
