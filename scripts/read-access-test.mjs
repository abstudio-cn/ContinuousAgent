// 读取申请（严格模式）回归测试：设置项、读权限判定、五个读取工具拦截、
// request_read_access 各分支、授权后放行、运行时上下文、工具清单、产物接线。
//   npm run build && node scripts/read-access-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolExecutor, buildToolCatalog } from '../dist/server/tools.js';
import { NativeBridge } from '../dist/server/native.js';
import { defaultSettings, mergeSettings } from '../dist/server/settings.js';
import { GlobalTipsStore } from '../dist/server/tips.js';

const results = [];
let failed = 0;
function check(name, cond, extra) {
  results.push(!!cond);
  if (cond) return;
  failed++;
  console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + String(extra).slice(0, 500) : ''));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-read-'));
const ws = path.join(tmp, 'ws');
const outsideDir = path.join(tmp, 'outside');
const outsideSub = path.join(outsideDir, 'sub');
const extraDir = path.join(tmp, 'extra');
for (const d of [ws, outsideDir, outsideSub, extraDir]) fs.mkdirSync(d, { recursive: true });

const wsFile = path.join(ws, 'inside.txt');
fs.writeFileSync(wsFile, '工作空间内的内容\n', 'utf8');
const outsideFile = path.join(outsideDir, 'data.txt');
fs.writeFileSync(outsideFile, '外部敏感内容\n', 'utf8');
const outsideNested = path.join(outsideSub, 'nested.txt');
fs.writeFileSync(outsideNested, '嵌套文件\n', 'utf8');
const extraFile = path.join(extraDir, 'ok.txt');
fs.writeFileSync(extraFile, '白名单内容\n', 'utf8');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
fs.writeFileSync(path.join(outsideDir, 'pic.png'), Buffer.from(PNG, 'base64'));
fs.writeFileSync(path.join(ws, 'pic.png'), Buffer.from(PNG, 'base64'));

const settings = { ...defaultSettings(), workspacePath: ws };
const tips = new GlobalTipsStore(path.join(tmp, 'global_tips.json'), () => []);
const tools = new ToolExecutor(settings, new NativeBridge(), tips);
const signal = new AbortController().signal;
const run = (name, args) => tools.execute(name, JSON.stringify(args), signal);

// ---------------------------------------------------------------- 1) 默认值与合并
const def = defaultSettings();
check('严格模式默认关闭', def.strictReadMode === false, String(def.strictReadMode));
check('默认允许申请读取', def.allowReadRequests === true, String(def.allowReadRequests));
check('默认可读白名单为空', def.extraReadPaths === '', JSON.stringify(def.extraReadPaths));

const m1 = mergeSettings(def, { strictReadMode: true });
check('merge 支持 strictReadMode=true', m1.strictReadMode === true, String(m1.strictReadMode));
const m2 = mergeSettings(def, { strictReadMode: 'yes' });
check('非布尔值不开启严格模式', m2.strictReadMode === false, String(m2.strictReadMode));
const m3 = mergeSettings(def, { allowReadRequests: false });
check('merge 支持关闭读取申请', m3.allowReadRequests === false, String(m3.allowReadRequests));
const rawList = 'D:\\some\\dir\n# 注释行\n\nE:\\other';
const m4 = mergeSettings(def, { extraReadPaths: rawList });
check('可读白名单原样保存（含注释与空行）', m4.extraReadPaths === rawList, JSON.stringify(m4.extraReadPaths));
const m5 = mergeSettings(def, { extraReadPaths: 'x'.repeat(5000) });
check('可读白名单截断到 4000 字符', m5.extraReadPaths.length === 4000, String(m5.extraReadPaths.length));

// ---------------------------------------------------------------- 2) 关闭严格模式：行为不变
check('关闭时外部路径可读', tools.isReadable(outsideFile) === true, String(tools.isReadable(outsideFile)));
const rDefault = await run('read_file', { path: outsideFile });
check('关闭时可直接读外部文件', rDefault.isError === false && rDefault.text.includes('外部敏感内容'), rDefault.text);
tools.setReadGrants([]);

// ---------------------------------------------------------------- 3) 开启严格模式：判定
tools.updateSettings({ ...settings, strictReadMode: true });
check('开启后工作空间内可读', tools.isReadable(wsFile) === true, String(tools.isReadable(wsFile)));
check('开启后工作空间根目录可读', tools.isReadable(ws) === true, String(tools.isReadable(ws)));
check('开启后外部路径不可读', tools.isReadable(outsideFile) === false, String(tools.isReadable(outsideFile)));
check('空路径不可读', tools.isReadable('') === false, String(tools.isReadable('')));

tools.updateSettings({ ...settings, strictReadMode: true, extraReadPaths: extraDir });
check('永久白名单目录可读', tools.isReadable(extraFile) === true, String(tools.isReadable(extraFile)));
check('白名单不影响其他外部路径', tools.isReadable(outsideFile) === false, String(tools.isReadable(outsideFile)));
tools.updateSettings({ ...settings, strictReadMode: true });

tools.addReadGrant(outsideDir);
check('会话授权后目录可读', tools.isReadable(outsideFile) === true, String(tools.isReadable(outsideFile)));
check('会话授权覆盖子目录', tools.isReadable(outsideNested) === true, String(tools.isReadable(outsideNested)));
check('readGrants 反映授权', tools.readGrants.length === 1 && tools.readGrants[0] === outsideDir, JSON.stringify(tools.readGrants));
tools.addReadGrant(outsideDir);
check('重复授权去重', tools.readGrants.length === 1, JSON.stringify(tools.readGrants));
tools.setReadGrants([extraDir]);
check('setReadGrants 覆盖旧授权', tools.isReadable(outsideFile) === false && tools.isReadable(extraFile) === true,
  JSON.stringify(tools.readGrants));
tools.setReadGrants([]);
check('清空授权后外部不可读', tools.isReadable(outsideFile) === false, JSON.stringify(tools.readGrants));

// ---------------------------------------------------------------- 4) 五个读取工具被拦截
const rRead = await run('read_file', { path: outsideFile });
check('read_file 被拦截', rRead.isError === true && rRead.text.includes('严格读取模式'), rRead.text);
check('read_file 拦截文案指向 request_read_access', rRead.text.includes('request_read_access'), rRead.text);
const rList = await run('list_directory', { path: outsideDir });
check('list_directory 被拦截', rList.isError === true && rList.text.includes('严格读取模式'), rList.text);
const rFind = await run('find_files', { root: outsideDir, pattern: '*.*' });
check('find_files 被拦截', rFind.isError === true && rFind.text.includes('严格读取模式'), rFind.text);
const rSearch = await run('search_files', { root: outsideDir, pattern: '敏感' });
check('search_files 被拦截', rSearch.isError === true && rSearch.text.includes('严格读取模式'), rSearch.text);
const rImg = await run('view_image', { path: path.join(outsideDir, 'pic.png') });
check('view_image 被拦截', rImg.isError === true && rImg.text.includes('严格读取模式'), rImg.text);

// 工作空间内读取不受影响
const rWs = await run('read_file', { path: wsFile });
check('工作空间内 read_file 正常', rWs.isError === false && rWs.text.includes('工作空间内的内容'), rWs.text);
const rWsList = await run('list_directory', { path: ws });
check('工作空间内 list_directory 正常', rWsList.isError === false && rWsList.text.includes('inside.txt'), rWsList.text);
const rWsImg = await run('view_image', { path: path.join(ws, 'pic.png') });
check('工作空间内 view_image 正常', rWsImg.isError === false && Array.isArray(rWsImg.images) && rWsImg.images.length === 1, rWsImg.text);

// 默认 root 是工作空间：不传 root 也能用
const rFindWs = await run('find_files', { pattern: '*.txt' });
check('find_files 默认 root 可用', rFindWs.isError === false && rFindWs.text.includes('inside.txt'), rFindWs.text);

// ---------------------------------------------------------------- 5) request_read_access 各分支
tools.updateSettings({ ...settings, strictReadMode: false });
const rOff = await run('request_read_access', { path: outsideDir });
check('未开启严格模式时提示无需申请', rOff.isError === false && rOff.text.includes('无需申请'), rOff.text);

tools.updateSettings({ ...settings, strictReadMode: true, allowReadRequests: false });
const rDisabled = await run('request_read_access', { path: outsideDir });
check('关闭申请开关后拒绝申请', rDisabled.isError === true && rDisabled.text.includes('已禁用'), rDisabled.text);

tools.updateSettings({ ...settings, strictReadMode: true, allowReadRequests: true });
const rNoBroker = await run('request_read_access', { path: outsideDir });
check('无授权交互时报错', rNoBroker.isError === true && rNoBroker.text.includes('没有可用的授权交互'), rNoBroker.text);

const asked = [];
tools.setAccessBroker({ ask: async (target, reason, kind) => { asked.push({ target, reason, kind }); return false; } });
const rDenied = await run('request_read_access', { path: outsideDir, reason: '需要读日志' });
check('用户拒绝时返回错误', rDenied.isError === true && rDenied.text.includes('拒绝'), rDenied.text);
check('拒绝不写入授权', tools.readGrants.length === 0, JSON.stringify(tools.readGrants));
check('broker 收到 kind=read', asked.length === 1 && asked[0].kind === 'read', JSON.stringify(asked));
check('broker 收到 reason', asked[0] && asked[0].reason === '需要读日志', JSON.stringify(asked));

tools.setAccessBroker({ ask: async (target, reason, kind) => { asked.push({ target, reason, kind }); return true; } });
const rGranted = await run('request_read_access', { path: outsideDir, reason: '需要读日志' });
check('用户允许后获得读权限', rGranted.isError === false && rGranted.text.includes('已获得读权限'), rGranted.text);
check('授权写入会话名单', tools.readGrants.length === 1 && tools.readGrants[0] === outsideDir, JSON.stringify(tools.readGrants));
check('broker 第二次仍带 kind=read', asked.length === 2 && asked[1].kind === 'read', JSON.stringify(asked));

const rAfter = await run('read_file', { path: outsideNested });
check('授权后可读外部文件（含子目录）', rAfter.isError === false && rAfter.text.includes('嵌套文件'), rAfter.text);

const rAgain = await run('request_read_access', { path: outsideFile });
check('已可读路径直接通过', rAgain.isError === false && rAgain.text.includes('已可读'), rAgain.text);

const rMissing = await run('request_read_access', { path: path.join(tmp, 'nope', 'missing') });
check('不存在的路径拒绝授权', rMissing.isError === true && rMissing.text.includes('不存在'), rMissing.text);

const rEmpty = await run('request_read_access', {});
check('缺少 path 报错', rEmpty.isError === true && rEmpty.text.includes('path'), rEmpty.text);

// ---------------------------------------------------------------- 6) 运行时上下文
const ctxOn = tools.runtimeContext(0);
check('严格模式写入运行时上下文', ctxOn.includes('读取申请（严格模式）已开启'), '');
check('运行时上下文列出已授权可读目录', ctxOn.includes(outsideDir), '');
check('运行时上下文声明 shell 不受拦截', ctxOn.includes('exec_command'), '');
tools.updateSettings({ ...settings, strictReadMode: false });
const ctxOff = tools.runtimeContext(0);
check('关闭后不再提示严格模式', !ctxOff.includes('读取申请（严格模式）已开启'), '');
check('关闭后仍提示可写目录规则', ctxOff.includes('额外可写目录'), '');

// ---------------------------------------------------------------- 7) 工具清单
const catalog = buildToolCatalog();
const spec = catalog.find((t) => t.function.name === 'request_read_access');
check('工具清单含 request_read_access', !!spec, '');
check('request_read_access 描述提到严格模式', !!spec && spec.function.description.includes('严格模式'), spec && spec.function.description);
check('path 必填', !!spec && JSON.stringify(spec.function.parameters.required) === '["path"]',
  spec && JSON.stringify(spec.function.parameters.required));
check('提供 reason 参数', !!spec && !!spec.function.parameters.properties.reason, '');
check('工具总数不变或增加 1', catalog.length >= 40, String(catalog.length));

// ---------------------------------------------------------------- 8) 源码/产物接线
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const serverJs = readSrc('dist/server/index.js');
const toolsJs = readSrc('dist/server/tools.js');
const clientJs = readSrc('dist/public/client/main.js');
const typesSrc = readSrc('src/shared/types.ts');
const count = (s, sub) => s.split(sub).length - 1;

check('types 声明 strictReadMode', typesSrc.includes('strictReadMode: boolean'), '');
check('types 声明 readGrants', typesSrc.includes('readGrants: string[]'), '');
check('types 声明 accessKind', typesSrc.includes("accessKind?: 'read' | 'write'"), '');
check('types 声明 readGrants 事件', typesSrc.includes("type: 'readGrants'"), '');
check('index 使用独立授权文件', serverJs.includes('read_grants.json'), '');
check('index 含 readGrantsFor / saveReadGrants',
  count(serverJs, 'readGrantsFor') >= 2 && count(serverJs, 'saveReadGrants') >= 1, String(count(serverJs, 'readGrantsFor')));
check('index 下发 readGrants', serverJs.includes('readGrants: readGrantsFor('), '');
check('index 运行前同步可读授权', serverJs.includes('setReadGrants('), '');
check('tools 读取入口都做了判定', count(toolsJs, 'this.isReadable(') === 6, String(count(toolsJs, 'this.isReadable(')));
check('tools 注册 request_read_access', toolsJs.includes("'request_read_access'"), '');
check('客户端含严格模式设置项', clientJs.includes('strictReadMode') && clientJs.includes('读取申请（严格模式）'), '');
check('客户端含读取申请开关与白名单', clientJs.includes('allowReadRequests') && clientJs.includes('extraReadPaths'), '');
check('客户端按 accessKind 区分文案', clientJs.includes('accessKind') && clientJs.includes('权限申请'), '');
check('客户端处理 readGrants 事件', clientJs.includes("type === 'readGrants'"), '');

// ---------------------------------------------------------------- 汇总
const total = results.length;
fs.rmSync(tmp, { recursive: true, force: true });
if (failed > 0) {
  console.log('FAILED: ' + failed + '/' + total + ' 项未通过');
  process.exit(1);
}
console.log('OK: ' + total + '/' + total + ' 项通过');
