// 回归测试：文件改动前备份（changed_backup）
//   npm run build && node scripts/changed-backup-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolExecutor } from '../dist/server/tools.js';
import { NativeBridge } from '../dist/server/native.js';
import { GlobalTipsStore } from '../dist/server/tips.js';
import { ChangedBackupStore, backupStamp } from '../dist/server/backup.js';
import { defaultSettings, mergeSettings } from '../dist/server/settings.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-backup-'));
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

const backupDir = path.join(ws, 'changed_backup');
const target = path.join(ws, 'demo.ts');
const write = (p, text) => fs.writeFileSync(p, text, 'utf8');
const read = (p) => fs.readFileSync(p, 'utf8');

async function call(tool, args) {
  return tools.execute(tool, JSON.stringify(args), signal);
}

// ---------------------------------------------------------------- 1) 新建文件不备份
{
  const r = await call('write_file', { path: target, content: 'v1\n' });
  check('write_file 新建成功', !r.isError, r.text);
  check('新建文件不产生备份', !fs.existsSync(backupDir) || fs.readdirSync(backupDir).filter((f) => f.endsWith('.bak')).length === 0,
    fs.existsSync(backupDir) ? fs.readdirSync(backupDir).join(',') : '(目录不存在)');
  check('提示里不含备份字样', !r.text.includes('已备份'), r.text);
}

// ---------------------------------------------------------------- 2) 覆盖合并前备份
{
  const r = await call('write_file', { path: target, content: 'v2\n' });
  const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.bak'));
  check('覆盖产生 1 份备份', files.length === 1, files.join(','));
  check('提示里说明备份文件', /已备份为 changed_backup\//.test(r.text), r.text);
  const backupFile = path.join(backupDir, files[0]);
  check('备份内容是改前内容', read(backupFile) === 'v1\n', JSON.stringify(read(backupFile)));
  check('目标文件已是新内容', read(target) === 'v2\n', JSON.stringify(read(target)));
  // 命名：原文件名__YYYYMMDD_HHmmss_SSS.bak
  check('备份名为「文件名+时间戳」', /^demo\.ts__\d{8}_\d{6}_\d{3}\.bak$/.test(files[0]), files[0]);
}

// ---------------------------------------------------------------- 3) edit_file 备份
{
  write(target, 'line1\nline2\nline3\n');
  const r = await call('edit_file', { path: target, old_text: 'line2', new_text: 'LINE2' });
  check('edit_file 成功', !r.isError, r.text);
  check('edit_file 提示含备份', /已备份为 changed_backup\//.test(r.text), r.text);
  const store = new ChangedBackupStore(() => settings);
  const entries = store.list();
  check('edit_file 产生备份', entries.length >= 1, String(entries.length));
  const latest = entries[0];
  check('最新备份对应本文件', path.resolve(latest.originalPath) === path.resolve(target), latest.originalPath);
  check('最新备份记录了工具名', latest.tool === 'edit_file', latest.tool);
  check('最新备份内容是改前内容', read(path.join(backupDir, latest.id)) === 'line1\nline2\nline3\n',
    JSON.stringify(read(path.join(backupDir, latest.id))));
}

// ---------------------------------------------------------------- 4) apply_patch 只备份一次
{
  write(target, 'AAA\nBBB\nCCC\n');
  const before = new ChangedBackupStore(() => settings).list().length;
  const r = await call('apply_patch', {
    path: target,
    edits: [
      { old_text: 'AAA', new_text: 'a1' },
      { old_text: 'BBB', new_text: 'b1' },
      { old_text: 'CCC', new_text: 'c1' },
    ],
  });
  check('apply_patch 成功', !r.isError, r.text);
  const after = new ChangedBackupStore(() => settings).list();
  check('apply_patch 只新增 1 份备份', after.length === before + 1, before + ' → ' + after.length);
  check('apply_patch 备份是整批改前内容', read(path.join(backupDir, after[0].id)) === 'AAA\nBBB\nCCC\n',
    JSON.stringify(read(path.join(backupDir, after[0].id))));
  check('apply_patch 三处都改了', read(target) === 'a1\nb1\nc1\n', JSON.stringify(read(target)));
}

// ---------------------------------------------------------------- 5) 同内容不重复备份
{
  const store = new ChangedBackupStore(() => settings);
  const f = path.join(ws, 'dedupe.txt');
  write(f, 'same\n');
  const first = store.snapshot(f, 'identical-content', 'test');
  const second = store.snapshot(f, 'identical-content', 'test');
  check('首次 snapshot 成功', !!first, JSON.stringify(first));
  check('同内容第二次被跳过', second === null, JSON.stringify(second));
  const changed = store.snapshot(f, 'identical-content-2', 'test');
  check('内容变化后再备份', !!changed && changed.id !== first.id, JSON.stringify(changed && changed.id));
}

// ---------------------------------------------------------------- 6) list 倒序 + 序号防撞
{
  const store = new ChangedBackupStore(() => settings);
  const f = path.join(ws, 'seq.txt');
  write(f, 'x\n');
  // 同一毫秒内连续备份不同内容：文件名不能撞
  const a = store.snapshot(f, 'content-A', 'test');
  const b = store.snapshot(f, 'content-B', 'test');
  const c = store.snapshot(f, 'content-C', 'test');
  check('同毫秒三次都被备份', !!a && !!b && !!c, JSON.stringify([a && a.id, b && b.id, c && c.id]));
  const ids = new Set([a.id, b.id, c.id]);
  check('同毫秒文件名不重复', ids.size === 3, [...ids].join(','));
  const times = store.list().map((e) => e.time);
  check('list 按时间倒序', times.every((t, i) => i === 0 || times[i - 1] >= t), times.join(','));
}

// ---------------------------------------------------------------- 7) restore 回滚
{
  const store = new ChangedBackupStore(() => settings);
  const f = path.join(ws, 'rollback.txt');
  write(f, 'original\n');
  const snap = store.snapshot(f, 'original\n', 'test');
  write(f, 'broken\n');
  const r = store.restore(snap.id, () => true);
  check('restore 成功', r.ok, r.text);
  check('回滚后内容恢复', read(f) === 'original\n', JSON.stringify(read(f)));
  // 回滚本身也要先备份当前（坏）内容
  const entries = store.list();
  check('回滚前备份了坏内容', entries.some((e) => e.tool === 'restore' && e.hash !== snap.hash), entries.map((e) => e.tool).join(','));
  check('回滚不存在的 id 报错', store.restore('nope.bak', () => true).ok === false, '');
  check('回滚到不可写路径被拒', (() => {
    const f2 = path.join(ws, 'ro.txt');
    write(f2, 'a\n');
    const s2 = store.snapshot(f2, 'a\n', 'test');
    return store.restore(s2.id, () => false).ok === false;
  })(), '');
}

// ---------------------------------------------------------------- 8) 备份目录自身不备份
{
  const store = new ChangedBackupStore(() => settings);
  const inside = path.join(backupDir, 'inner.txt');
  write(inside, 'zz');
  check('备份目录内的文件不产生备份', store.snapshot(inside, 'zz', 'test') === null, '');
}

// ---------------------------------------------------------------- 9) 关掉开关后不备份
{
  const f = path.join(ws, 'off.txt');
  write(f, 'keep\n');
  tools.updateSettings({ ...settings, changedBackupEnabled: false });
  // 计数用「已启用」的设置，与工具内部（已关闭）形成真实对照
  const counter = new ChangedBackupStore(() => settings);
  const before = counter.list().length;
  const r = await call('write_file', { path: f, content: 'changed\n' });
  check('关闭后写入成功', !r.isError, r.text);
  check('关闭后提示无备份', !r.text.includes('已备份'), r.text);
  check('关闭后不新增备份', counter.list().length === before, before + ' → ' + counter.list().length);
  tools.updateSettings({ ...settings, changedBackupEnabled: true });
}

// ---------------------------------------------------------------- 10) 上限裁剪
{
  const store = new ChangedBackupStore(() => ({ ...settings, changedBackupMaxFiles: 2 }));
  const f = path.join(ws, 'prune.txt');
  write(f, 'p\n');
  for (let i = 0; i < 5; i++) store.snapshot(f, 'prune-content-' + i, 'test');
  const entries = store.list();
  check('裁剪到上限 2 份', entries.length === 2, String(entries.length));
  check('保留的是最新的', entries[0].hash !== entries[1].hash && read(path.join(backupDir, entries[0].id)) === 'prune-content-4',
    entries.map((e) => e.id).join(','));
}

// ---------------------------------------------------------------- 11) changed_backup 工具
{
  const list = await call('changed_backup', { action: 'list' });
  check('list 可用', !list.isError && /改动备份：\d+ 份/.test(list.text), list.text.slice(0, 200));
  check('list 显示目录', list.text.includes(backupDir), list.text.slice(0, 300));

  const none = await call('changed_backup', { action: 'restore' });
  check('restore 缺 id 报错', none.isError === true && /需要 id/.test(none.text), none.text);

  // 现造一个可回滚的场景
  const f = path.join(ws, 'tool-restore.txt');
  write(f, 'good\n');
  const store = new ChangedBackupStore(() => settings);
  const snap = store.snapshot(f, 'good\n', 'test');
  write(f, 'bad\n');
  const restored = await call('changed_backup', { action: 'restore', id: snap.id });
  check('工具 restore 成功', !restored.isError && /已回滚/.test(restored.text), restored.text);
  check('工具 restore 内容正确', read(f) === 'good\n', JSON.stringify(read(f)));

  const bad = await call('changed_backup', { action: 'zzz' });
  check('未知 action 报错', bad.isError === true, bad.text);

  const cleared = await call('changed_backup', { action: 'clear' });
  check('工具 clear 成功', !cleared.isError && /已清空/.test(cleared.text), cleared.text);
  check('clear 后目录无 .bak',
    !fs.existsSync(backupDir) || fs.readdirSync(backupDir).filter((n) => n.endsWith('.bak')).length === 0,
    fs.existsSync(backupDir) ? fs.readdirSync(backupDir).join(',') : '');
  check('clear 后索引消失', !fs.existsSync(path.join(backupDir, 'index.json')), '');
  const list2 = await call('changed_backup', { action: 'list' });
  check('clear 后 list 为空', /暂无备份/.test(list2.text), list2.text.slice(0, 200));
}

// ---------------------------------------------------------------- 12) 设置与状态
{
  const d = defaultSettings();
  check('默认开启备份', d.changedBackupEnabled === true, String(d.changedBackupEnabled));
  check('默认上限 200', d.changedBackupMaxFiles === 200, String(d.changedBackupMaxFiles));
  check('可关闭', mergeSettings(d, { changedBackupEnabled: false }).changedBackupEnabled === false, '');
  check('上限小于 1 被夹到 1', mergeSettings(d, { changedBackupMaxFiles: 0 }).changedBackupMaxFiles === 1, '');
  check('上限过大被夹到 5000', mergeSettings(d, { changedBackupMaxFiles: 99999 }).changedBackupMaxFiles === 5000, '');
  check('非法值保持原值', mergeSettings({ ...d, changedBackupMaxFiles: 7 }, { changedBackupMaxFiles: 'x' }).changedBackupMaxFiles === 7, '');

  const stamp = backupStamp(new Date(2026, 10, 14, 9, 8, 7, 65));
  check('时间戳格式', stamp === '20261114_090807_065', stamp);
}

// ---------------------------------------------------------------- 13) 任务结束自动清空（源码 + 产物）
{
  const src = fs.readFileSync(new URL('../src/server/agent.ts', import.meta.url), 'utf8');
  check('源码在完成任务分支清空备份', /if \(completion\.done\) \{[\s\S]{0,400}backups\.clear\(/.test(src), '');
  check('完成文案未被改动（done-notice 依赖）',
    src.includes("this.pushItem('system', '任务结束，已停止自动续跑。');"), '');
  const dist = fs.readFileSync(new URL('../dist/server/agent.js', import.meta.url), 'utf8');
  check('产物含自动清空', /backups\.clear\(/.test(dist), '');

  const toolsDist = fs.readFileSync(new URL('../dist/server/tools.js', import.meta.url), 'utf8');
  check('产物含 changed_backup 工具', toolsDist.includes('changed_backup'), '');
  check('产物三处写入都带 snapshot',
    (toolsDist.match(/this\.backups\.snapshot\(/g) || []).length === 3,
    (toolsDist.match(/this\.backups\.snapshot\(/g) || []).length);
  const typesDist = fs.readFileSync(new URL('../dist/shared/types.js', import.meta.url), 'utf8');
  check('types 产物可读', typeof typesDist === 'string', '');
}


// ---------------------------------------------------------------- 14) 按会话隔离清空
{
  const store = new ChangedBackupStore(() => settings);
  const f1 = path.join(ws, 'sess-one.txt');
  const f2 = path.join(ws, 'sess-two.txt');
  write(f1, 'a\n');
  write(f2, 'b\n');
  store.snapshot(f1, 'a\n', 'test', 'sess-1');
  store.snapshot(f2, 'b\n', 'test', 'sess-2');
  const beforeCount = store.list().length;
  check('两个会话各自备份', beforeCount >= 2, String(beforeCount));

  const cleared = store.clear('sess-1');
  check('按会话清空只删自己的', cleared.removed >= 1, JSON.stringify(cleared));
  const left = store.list();
  check('另一会话备份仍在', left.some((e) => e.session === 'sess-2'), left.map((e) => e.session).join(','));
  check('本会话备份已删净', !left.some((e) => e.session === 'sess-1'), left.map((e) => e.session).join(','));
  check('clear 返回 kept 与剩余一致', cleared.kept === left.length, cleared.kept + ' vs ' + left.length);

  const all = store.clear();
  check('不传会话 = 全清', store.list().length === 0, String(store.list().length));
  check('全清返回删除份数', all.removed >= 1, JSON.stringify(all));
}

// ---------------------------------------------------------------- 15) 结束时只清本会话
{
  const src = fs.readFileSync(new URL('../src/server/agent.ts', import.meta.url), 'utf8');
  check('结束时按会话清空', /backups\.clear\(this\.deps\.sessionId\)/.test(src), '');
  check('不按会话时不会全清', !/backups\.clear\(\)/.test(src), '');
}
fs.rmSync(ws, { recursive: true, force: true });
console.log('\n' + (failed === 0 ? 'OK' : 'FAIL') + ': ' + (results.length - failed) + '/' + results.length + ' 项通过');
process.exit(failed === 0 ? 0 : 1);
