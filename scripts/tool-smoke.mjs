#!/usr/bin/env node
/**
 * 工具层冒烟测试：直接实例化 ToolExecutor，验证文件沙箱、截图、键鼠与 OCR 的原生链路。
 * 需要 Windows + PowerShell 5.1。用法：node scripts/tool-smoke.mjs [窗口标题关键字]
 */
import fs from 'node:fs';
import path from 'node:path';
import { NativeBridge } from '../dist/server/native.js';
import { ToolExecutor } from '../dist/server/tools.js';
import { GlobalTipsStore } from '../dist/server/tips.js';
import { getSettings, defaultSettings } from '../dist/server/settings.js';

const titleHint = process.argv[2] || 'GameAgent';
const failures = [];
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) failures.push(name);
};

const settings = typeof getSettings === 'function' ? getSettings() : defaultSettings();
settings.workspacePath = path.join(process.cwd(), '.smokews');
fs.mkdirSync(settings.workspacePath, { recursive: true });

const bridge = new NativeBridge();
const tools = new ToolExecutor(settings, bridge, new GlobalTipsStore(path.join(settings.workspacePath, 'global_tips.json')));
const signal = new AbortController().signal;

const ok = await bridge.start();
check('原生桥接启动', ok, bridge.detail);
if (ok) {
  const target = await tools.selectWindow(0, titleHint);
  check('选择窗口', !!target, target ? target.processName + ' ' + target.width + 'x' + target.height : '未找到 ' + titleHint);

  const shot = await tools.execute('screenshot', JSON.stringify({ max_width: 640 }), signal);
  check('screenshot', !shot.isError && !!shot.images?.length, (shot.text || '').slice(0, 80));

  const ocr = await tools.execute('ocr', '{}', signal);
  check('ocr', !ocr.isError, (ocr.text || '').split('\n')[0].slice(0, 60));

  const move = await tools.execute('mouse_move', JSON.stringify({ x: 120, y: 120 }), signal);
  check('mouse_move', !move.isError, move.text);

  const env = await tools.execute('get_environment', '{}', signal);
  check('get_environment', !env.isError);
}

const file = path.join(settings.workspacePath, 'smoke.txt');
const w = await tools.execute('write_file', JSON.stringify({ path: file, content: 'hello 世界' }), signal);
check('write_file', !w.isError && fs.existsSync(file), w.text);

const r = await tools.execute('read_file', JSON.stringify({ path: file }), signal);
check('read_file', !r.isError && r.text.includes('hello 世界'));

const outside = await tools.execute('write_file', JSON.stringify({ path: 'C:\\Windows\\Temp\\nope.txt', content: 'x' }), signal);
check('工作空间外写入被拒绝', outside.isError, (outside.text || '').slice(0, 50));

const d = await tools.execute('delete_path', JSON.stringify({ path: file }), signal);
check('delete_path 进回收站', !d.isError && fs.existsSync(path.join(settings.workspacePath, '.trash')), d.text);

const notes = await tools.execute('append_game_notes', JSON.stringify({ content: '- smoke note' }), signal);
check('append_game_notes', !notes.isError, notes.text);

const rec = await tools.execute('update_game_record', JSON.stringify({ content: '## 角色信息\n- 冒烟测试\n' }), signal);
check('update_game_record', !rec.isError, rec.text);

await bridge.stop();
console.log('');
console.log(failures.length === 0 ? '工具冒烟通过 ✅' : '工具冒烟失败 ❌ ' + failures.join(', '));
process.exit(failures.length === 0 ? 0 : 1);
