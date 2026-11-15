// 回归测试：会话自动命名（rename_session 工具 + 标题清洗 + 兜底命名）
//   npm run build && node scripts/session-title-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolExecutor, buildToolCatalog } from '../dist/server/tools.js';
import { NativeBridge } from '../dist/server/native.js';
import { GlobalTipsStore } from '../dist/server/tips.js';
import { SessionStore, isDefaultTitle, deriveTitleFromPrompt } from '../dist/server/sessions.js';
import { STATIC_SYSTEM_PROMPT } from '../dist/shared/prompt.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-title-'));
const settings = {
  apiBaseUrl: '', apiKey: '', model: '', reasoningEffort: 'auto', temperature: 0, maxOutputTokens: 1024,
  workspacePath: workspace,
  gameRecordFileName: 'work_state.md', gameNotesFileName: 'work_notes.md', gameSavePath: '',
  allowShell: false, shellTimeoutMs: 20000, allowLaunch: false,
  allowPathRequests: true, extraWritePaths: '',
  continuousMode: false, continueDelayMs: 500, continuePrompt: '', maxTurns: 1, historyMaxMessages: 24, clickDelayMs: 0,
  sendScreenshots: false, screenshotBurnAfterRead: true, maxScreenshotWidth: 800, ocrLanguage: 'zh-Hans',
  ttsEnabled: false, ttsEngine: 'Browser', ttsVoice: '', ttsRate: 0, ttsVolume: 0.5,
  cloudTtsBaseUrl: '', cloudTtsApiKey: '', cloudTtsModel: 'tts-1', cloudTtsVoice: 'alloy',
  ttsQueueMode: 'latest', ttsQueueLimit: 2,
};

const results = [];
let failed = 0;
function check(name, cond, extra) {
  results.push(!!cond);
  if (cond) return;
  failed++;
  console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + String(extra).replace(/\n/g, '\n     ') : ''));
}

// ---------------------------------------------------------------- 1) 纯函数：默认标题判定
check('默认标题：会话 M-D HH:MM', isDefaultTitle('会话 11-14 11:27'));
check('默认标题：默认会话', isDefaultTitle('默认会话'));
check('非默认标题：自定义', !isDefaultTitle('修复命令行后台执行'));
check('非默认标题：带前缀相似', !isDefaultTitle('会话 11-14 11:27 的后续'));
check('非默认标题：空串', !isDefaultTitle(''));

// ---------------------------------------------------------------- 2) 纯函数：兜底标题推断
check('兜底：取首行并去标点', deriveTitleFromPrompt('请帮我优化会话命名。\n第二行不该用') === '优化会话命名', deriveTitleFromPrompt('请帮我优化会话命名。\n第二行不该用'));
check('兜底：去 markdown 标记', deriveTitleFromPrompt('## 修复 `exec_command` 后台执行') === '修复 exec_command 后台执行', deriveTitleFromPrompt('## 修复 `exec_command` 后台执行'));
check('兜底：跳过空行', deriveTitleFromPrompt('\n\n  给会话起名  \n') === '给会话起名', deriveTitleFromPrompt('\n\n  给会话起名  \n'));
check('兜底：截断到 20 字', Array.from(deriveTitleFromPrompt('一'.repeat(50))).length === 20, deriveTitleFromPrompt('一'.repeat(50)));
check('兜底：空输入返回空串', deriveTitleFromPrompt('   \n\t ') === '');

// ---------------------------------------------------------------- 3) 工具清单
const names = buildToolCatalog().map((s) => s.function.name);
const spec = buildToolCatalog().find((s) => s.function.name === 'rename_session');
check('清单含 rename_session', names.includes('rename_session'), names.length);
check('rename_session 必填 title', JSON.stringify(spec?.function.parameters?.required) === '["title"]', JSON.stringify(spec?.function.parameters));
check('提示词要求收尾命名', STATIC_SYSTEM_PROMPT.includes('rename_session') && STATIC_SYSTEM_PROMPT.includes('[[DONE]]'), '');

// ---------------------------------------------------------------- 4) 工具接上真实 SessionStore
const store = new SessionStore(path.join(workspace, '_sessions'), () => settings);
const meta = store.create(); // 默认标题
check('新建会话用默认标题', isDefaultTitle(meta.title), meta.title);

const tools = new ToolExecutor(settings, new NativeBridge(), new GlobalTipsStore(path.join(workspace, 'global_tips.json')));
tools.bindSession({
  id: meta.id, title: meta.title,
  recordPath: store.recordPath(meta.id), notesPath: store.notesPath(meta.id),
});
const ac = new AbortController();
const call = (name, args) => tools.execute(name, JSON.stringify(args), ac.signal);

// 未注入 renamer 时应给出明确错误
const noHook = await call('rename_session', { title: '测试命名' });
check('未注入回调时报错', noHook.isError === true && noHook.text.includes('不支持'), noHook.text);

// 注入 renamer（与 index.ts 相同逻辑）
let broadcastCount = 0;
tools.setSessionRenamer((sessionId, title) => {
  const m = store.rename(sessionId, title);
  if (!m) return null;
  broadcastCount++;
  return m.title;
});

const renamed = await call('rename_session', { title: '  修复命令行后台执行。  ' });
check('命名成功', renamed.isError === false, renamed.text);
check('标题已写入存储', store.get(meta.id)?.title === '修复命令行后台执行', store.get(meta.id)?.title);
check('回写工具内的会话标题', renamed.text.includes('修复命令行后台执行'), renamed.text);
check('触发一次广播', broadcastCount === 1, broadcastCount);

// 已命名后不再被判定为默认值（兜底不会覆盖）
check('命名后不再是默认标题', !isDefaultTitle(store.get(meta.id)?.title || ''), store.get(meta.id)?.title);

// 清洗：markdown / 引号 / 换行 / 超长
const messy = await call('rename_session', { title: '## "测试\n标题" **超长** ' + 'x'.repeat(40) });
check('清洗后成功', messy.isError === false, messy.text);
const cleaned = store.get(meta.id)?.title || '';
check('清洗掉井号引号星号与换行', !/["#*\n]/.test(cleaned), cleaned);
check('清洗后长度 ≤ 24', Array.from(cleaned).length <= 24, cleaned);

// 空标题 / 纯标点
const empty = await call('rename_session', { title: '   ' });
check('空标题报错', empty.isError === true, empty.text);
const punct = await call('rename_session', { title: '。。。' });
check('纯标点也报错', punct.isError === true, punct.text);

// 会话被删除后 → renamer 返回 null
store.remove(meta.id);
const gone = await call('rename_session', { title: '删掉之后' });
check('会话不存在时报错', gone.isError === true && gone.text.includes('失败'), gone.text);

// ---------------------------------------------------------------- 5) 兜底命名不覆盖已有标题
const keep = store.create('用户自己起的名');
const store2 = store;
function autoName(sessionId, prompt) {
  const m = store2.get(sessionId);
  if (!m || !isDefaultTitle(m.title)) return false;
  const title = deriveTitleFromPrompt(prompt);
  if (!title) return false;
  store2.rename(sessionId, title);
  return true;
}
check('兜底不覆盖自定义标题', autoName(keep.id, '随便什么任务') === false && store.get(keep.id)?.title === '用户自己起的名', store.get(keep.id)?.title);

const fresh = store.create();
check('兜底会给默认标题命名', autoName(fresh.id, '请帮我修复命令行后台执行') === true);
check('兜底用的是任务描述', store.get(fresh.id)?.title === '修复命令行后台执行', store.get(fresh.id)?.title);

const blank = store.create();
check('任务描述为空时不命名', autoName(blank.id, '   ') === false && isDefaultTitle(store.get(blank.id)?.title || ''), store.get(blank.id)?.title);

// ---------------------------------------------------------------- 6) 客户端不再弹窗要标题
const clientSrc = fs.readFileSync(new URL('../src/client/main.ts', import.meta.url), 'utf8');
const newSessionBlock = clientSrc.slice(clientSrc.indexOf('async function newSession'), clientSrc.indexOf('async function renameSession'));
check('newSession 不再调用 window.prompt', !newSessionBlock.includes('window.prompt'), newSessionBlock);
check('newSession 仍会创建会话', newSessionBlock.includes("'/api/sessions'"), newSessionBlock);
check('手动重命名入口保留', clientSrc.includes("'/rename'"), '');

console.log('\n' + (failed === 0 ? 'OK' : 'FAIL') + ': ' + (results.length - failed) + '/' + results.length + ' 项通过');
console.log('临时目录: ' + workspace);
process.exit(failed === 0 ? 0 : 1);
