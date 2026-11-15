// 回归测试：exec_command 的后台执行能力（background / wait_ms / exec_output / exec_kill）
//   npm run build && node scripts/exec-bg-test.mjs
// 全部通过退出码 0；任一失败打印明细并退出 1。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolExecutor } from '../dist/server/tools.js';
import { NativeBridge } from '../dist/server/native.js';
import { GlobalTipsStore } from '../dist/server/tips.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-execbg-'));
const settings = {
  apiBaseUrl: '', apiKey: '', model: '', reasoningEffort: 'auto', temperature: 0, maxOutputTokens: 1024,
  workspacePath: workspace,
  gameRecordFileName: 'work_state.md', gameNotesFileName: 'work_notes.md', gameSavePath: '',
  allowShell: true, shellTimeoutMs: 20000, allowLaunch: false,
  allowPathRequests: true, extraWritePaths: '',
  continuousMode: false, continueDelayMs: 500, continuePrompt: '', maxTurns: 1, historyMaxMessages: 24, clickDelayMs: 0,
  sendScreenshots: false, screenshotBurnAfterRead: true, maxScreenshotWidth: 800, ocrLanguage: 'zh-Hans',
  ttsEnabled: false, ttsEngine: 'Browser', ttsVoice: '', ttsRate: 0, ttsVolume: 0.5,
  cloudTtsBaseUrl: '', cloudTtsApiKey: '', cloudTtsModel: 'tts-1', cloudTtsVoice: 'alloy',
  ttsQueueMode: 'latest', ttsQueueLimit: 2,
};

const native = new NativeBridge();
const tools = new ToolExecutor(settings, native, new GlobalTipsStore(path.join(workspace, 'global_tips.json')));
tools.bindSession({
  id: 'exec-bg', title: 'exec-bg',
  recordPath: path.join(workspace, 'work_state.md'),
  notesPath: path.join(workspace, 'work_notes.md'),
});
const ac = new AbortController();
const call = (name, args = {}) => tools.execute(name, JSON.stringify(args), ac.signal);

let failed = 0;
const results = [];
function check(name, cond, extra) {
  results.push(!!cond);
  if (cond) return;
  failed++;
  console.log('FAIL ' + name + (extra ? '\n     ' + String(extra).replace(/\n/g, '\n     ') : ''));
}
function has(text, needle) {
  return String(text).includes(needle);
}
const jobIdOf = (text) => {
  const m = String(text).match(/任务 ID: (exec-\d+)/);
  return m ? m[1] : '';
};

// ---------------------------------------------------------------- 1) background 立即返回
let t0 = Date.now();
const bg = await call('exec_command', { command: 'Start-Sleep -Seconds 3; Write-Output bg-done', background: true });
const bgMs = Date.now() - t0;
const bgJob = jobIdOf(bg.text);
check('background 不阻塞（<2000ms）', bgMs < 2000, '实际 ' + bgMs + 'ms');
check('background 返回任务 ID', /^exec-\d+$/.test(bgJob), bg.text);
check('background 标记运行中', has(bg.text, '运行中'), bg.text);
check('background 不是错误', bg.isError === false, bg.text);

// ---------------------------------------------------------------- 2) exec_output 等待到结束
const poll1 = await call('exec_output', { job_id: bgJob, wait_ms: 15000 });
check('exec_output 等到结束', has(poll1.text, '已结束'), poll1.text);
check('exec_output 给出退出码 0', has(poll1.text, '退出码 0'), poll1.text);
check('exec_output 含 stdout 内容', has(poll1.text, 'bg-done'), poll1.text);

// ---------------------------------------------------------------- 3) 增量不重复
const poll2 = await call('exec_output', { job_id: bgJob });
check('重复读取不重复输出', !has(poll2.text, '--- 新增 stdout ---'), poll2.text);
check('重复读取说明没有新输出', has(poll2.text, '没有新增 stdout'), poll2.text);

// ---------------------------------------------------------------- 4) wait_ms 到期转后台
t0 = Date.now();
const partial = await call('exec_command', { command: 'Start-Sleep -Seconds 4; Write-Output late-done', wait_ms: 1500 });
const partialMs = Date.now() - t0;
const partialJob = jobIdOf(partial.text);
check('wait_ms 到点即返回（1.2~4s）', partialMs >= 1200 && partialMs < 4000, '实际 ' + partialMs + 'ms');
check('wait_ms 说明转入后台', has(partial.text, '转入后台'), partial.text);
check('wait_ms 也给出任务 ID', /^exec-\d+$/.test(partialJob), partial.text);
const late = await call('exec_output', { job_id: partialJob, wait_ms: 20000 });
check('转后台后仍能跑完', has(late.text, '已结束') && has(late.text, 'late-done'), late.text);

// ---------------------------------------------------------------- 5) 两个后台任务并行
const a = await call('exec_command', { command: 'Start-Sleep -Seconds 2; Write-Output tag-A', background: true });
const b = await call('exec_command', { command: 'Start-Sleep -Seconds 2; Write-Output tag-B', background: true });
const ja = jobIdOf(a.text);
const jb = jobIdOf(b.text);
check('并行任务 ID 不同', !!ja && !!jb && ja !== jb, ja + ' / ' + jb);
const both = await Promise.all([
  call('exec_output', { job_id: ja, wait_ms: 20000 }),
  call('exec_output', { job_id: jb, wait_ms: 20000 }),
]);
check('并行任务各自完成', has(both[0].text, 'tag-A') && has(both[1].text, 'tag-B'),
  both[0].text + '\n---\n' + both[1].text);

// ---------------------------------------------------------------- 6) exec_kill 终止整树
const long = await call('exec_command', {
  command: 'while ($true) { Start-Sleep -Milliseconds 200 }',
  background: true,
});
const longJob = jobIdOf(long.text);
check('长任务拿到 ID', /^exec-\d+$/.test(longJob), long.text);
const killed = await call('exec_kill', { job_id: longJob });
check('exec_kill 发送终止', has(killed.text, '已发送终止信号'), killed.text);
const afterKill = await call('exec_output', { job_id: longJob, wait_ms: 10000 });
check('被终止任务变为已结束', has(afterKill.text, '已结束'), afterKill.text);
const killAgain = await call('exec_kill', { job_id: longJob });
check('重复终止给出提示', has(killAgain.text, '无需终止'), killAgain.text);

// ---------------------------------------------------------------- 7) 列表 / 未知任务
const list = await call('exec_output');
check('列任务不含未知错误', list.isError === false, list.text);
check('列表含后台任务字样', has(list.text, '后台任务'), list.text);
const unknown = await call('exec_output', { job_id: 'exec-9999' });
check('未知任务报错', unknown.isError === true && has(unknown.text, '未找到任务'), unknown.text);

// ---------------------------------------------------------------- 8) 前台行为回归
const fg = await call('exec_command', { command: 'Write-Output ("hello " + 1)' });
check('前台同步返回退出码', has(fg.text, '退出码: 0'), fg.text);
check('前台同步返回输出', has(fg.text, 'hello 1'), fg.text);
check('前台不打印任务 ID', !has(fg.text, '任务 ID'), fg.text);
const bad = await call('exec_command', { command: 'throw "boom"' });
check('失败命令 isError', bad.isError === true, bad.text);
check('失败命令非零退出码', /退出码: [1-9]/.test(bad.text), bad.text);

// ---------------------------------------------------------------- 9) 空命令 / 禁用开关
const empty = await call('exec_command', { command: '   ' });
check('空命令报错', empty.isError === true, empty.text);
tools.updateSettings({ ...settings, allowShell: false });
const denied = await call('exec_command', { command: 'Write-Output 1', background: true });
check('禁用 shell 时拒绝', denied.isError === true && has(denied.text, '禁用'), denied.text);
tools.updateSettings(settings);

// ---------------------------------------------------------------- 10) dispose 清理
const live = await call('exec_command', { command: 'while ($true) { Start-Sleep -Milliseconds 200 }', background: true });
check('清理前有任务', /^exec-\d+$/.test(jobIdOf(live.text)), live.text);
tools.dispose();
const afterDispose = await call('exec_output');
check('dispose 后任务表清空', has(afterDispose.text, '当前没有后台任务'), afterDispose.text);

// ---------------------------------------------------------------- 输出
console.log('\n' + (failed === 0 ? 'OK' : 'FAIL') + ': ' + (results.length - failed) + '/' + results.length + ' 项通过');
console.log('临时目录: ' + workspace);
process.exit(failed === 0 ? 0 : 1);
