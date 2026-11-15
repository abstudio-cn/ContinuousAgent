// 离线验证标准工具链：不启动 HTTP 服务，直接驱动 ToolExecutor。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolExecutor, buildToolCatalog } from '../dist/server/tools.js';
import { NativeBridge } from '../dist/server/native.js';
import { GlobalTipsStore } from '../dist/server/tips.js';
import { STATIC_SYSTEM_PROMPT, RECORD_TEMPLATE, NOTES_TEMPLATE, DONE_TOKEN } from '../dist/shared/prompt.js';
import { extractDoneToken } from '../dist/server/agent.js';
import { defaultSettings } from '../dist/server/settings.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-verify-'));
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
tools.bindSession({ id: 'verify', title: 'verify', recordPath: path.join(workspace, 'work_state.md'), notesPath: path.join(workspace, 'work_notes.md') });
const ac = new AbortController();
const results = [];
const run = async (name, args) => {
  const r = await tools.execute(name, JSON.stringify(args), ac.signal);
  results.push({ name, isError: r.isError, head: r.text.split('\n').slice(0, 3).join(' | ').slice(0, 200) });
  return r;
};

await run('exec_command', { command: 'Write-Output ("hello " + 1)' });
await run('write_file', { path: path.join(workspace, 'demo.ts'), content: 'const a = 1;\nconst b = 2;\n' });
await run('edit_file', { path: path.join(workspace, 'demo.ts'), old_text: 'const b = 2;', new_text: 'const b = 3;' });
await run('apply_patch', { path: path.join(workspace, 'demo.ts'), edits: [{ old_text: 'const a = 1;', new_text: 'const a = 10;' }] });
await run('search_files', { pattern: 'const b', root: workspace });
await run('view_image', { path: path.join(workspace, 'demo.ts') });
await run('clipboard_read', {});
await run('process_list', { filter: 'node' });
await run('get_environment', {});
await run('exec_command', { command: 'throw "boom"' });

// ---- 目录白名单 / 申请流程 ----
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-outside-'));
const outsideFile = path.join(outsideDir, 'note.txt');
let askCount = 0;
let brokerAnswer = false;
tools.setAccessBroker({ ask: async () => { askCount++; return brokerAnswer; } });

const deniedWrite = await tools.execute('write_file', JSON.stringify({ path: outsideFile, content: 'x' }), ac.signal);
const deniedAsk = await tools.execute('request_write_access', JSON.stringify({ path: outsideDir, reason: '需要写入外部目录' }), ac.signal);
brokerAnswer = true;
const allowedAsk = await tools.execute('request_write_access', JSON.stringify({ path: outsideDir, reason: '需要写入外部目录' }), ac.signal);
const allowedWrite = await tools.execute('write_file', JSON.stringify({ path: outsideFile, content: 'hello-outside' }), ac.signal);
const insideAfter = fs.existsSync(outsideFile) ? fs.readFileSync(outsideFile, 'utf8') : '(missing)';
const grantedList = tools.grants.slice();

// ---- 完成标记 ----
const doneCases = {
  plain: extractDoneToken('完成。\n' + DONE_TOKEN),
  trailingWhitespace: extractDoneToken('完成。\n  ' + DONE_TOKEN + '\n\n'),
  inline: extractDoneToken('完成。 ' + DONE_TOKEN + ' 还有后续'),
  codeFence: extractDoneToken('示例：\n' + '```' + '\n' + DONE_TOKEN + '\n' + '```'),
  none: extractDoneToken('还在跑，下一步做 X。'),
};
console.log(JSON.stringify(results, null, 2));

// ---- 提示词与工具目录自检 ----
const catalog = buildToolCatalog();
const names = catalog.map((t) => t.function.name);
const checks = {
  toolCount: names.length,
  hasWorkRecordTools: ['update_work_record', 'read_work_record', 'update_work_notes', 'append_work_notes', 'read_work_notes']
    .every((n) => names.includes(n)),
  noGameRecordTools: !names.some((n) => n.includes('game_record') || n.includes('game_notes')),
  selectWindow: names.includes('select_window'),
  promptIsWorkOriented: STATIC_SYSTEM_PROMPT.includes('工作记录') && STATIC_SYSTEM_PROMPT.includes('工作笔记')
    && !STATIC_SYSTEM_PROMPT.includes('游戏记录'),
  promptHasToolGuide: STATIC_SYSTEM_PROMPT.includes('核心循环') && STATIC_SYSTEM_PROMPT.includes('exec_command'),
  recordTemplateHeadings: (RECORD_TEMPLATE.match(/^## /gm) || []).length,
  notesTemplateHeadings: (NOTES_TEMPLATE.match(/^## /gm) || []).length,
  defaultFileNames: defaultSettings().gameRecordFileName + '/' + defaultSettings().gameNotesFileName,
  // 目录授权
  writeOutsideDeniedBeforeGrant: deniedWrite.isError,
  writeOutsideDeniedMessage: deniedWrite.text.includes('request_write_access'),
  requestDeniedByUser: deniedAsk.isError,
  requestGranted: !allowedAsk.isError,
  writeOutsideAllowedAfterGrant: !allowedWrite.isError && insideAfter === 'hello-outside',
  brokerAskedTwice: askCount === 2,
  grantedListCount: grantedList.length,
  grantToolInCatalog: names.includes('request_write_access'),
  defaultAllowPathRequests: defaultSettings().allowPathRequests === true,
  // 完成标记
  doneToken: DONE_TOKEN,
  promptExplainsDoneToken: STATIC_SYSTEM_PROMPT.includes(DONE_TOKEN) && STATIC_SYSTEM_PROMPT.includes('完成标记'),
  donePlain: doneCases.plain.done && doneCases.plain.text === '完成。',
  doneTrailingWhitespace: doneCases.trailingWhitespace.done,
  doneInlineRejected: doneCases.inline.done === false,
  doneInCodeFenceRejected: doneCases.codeFence.done === false,
  doneTextWithoutToken: doneCases.none.done === false,
};
console.log('SELFCHECK=' + JSON.stringify(checks, null, 2));
const text = fs.readFileSync(path.join(workspace, 'demo.ts'), 'utf8');
console.log('PATCHED_CONTENT=' + JSON.stringify(text));
fs.rmSync(workspace, { recursive: true, force: true });
