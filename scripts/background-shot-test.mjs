#!/usr/bin/env node
/**
 * 后台截图回归测试：验证 screenshot_background 既不抢前台，也不会在窗口被遮挡时
 * 抓到上层窗口的画面。
 *
 *   1) 源码/产物接线：原生宿主的 CaptureBackground 只用 PrintWindow，绝不激活/抓屏
 *   2) 原生通道实测：对「非前台且被遮挡」的窗口抓图，前台窗口与目标状态全程不变
 *   3) 工具层：参数解析、不激活、不改目标窗口、blank/无窗口/title 分支
 *
 * 需 Windows + PowerShell 5.1（无可用窗口时第 2 节自动跳过，不算失败）。
 * 用法：node scripts/background-shot-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) failures.push(name);
};
const count = (hay, needle) => hay.split(needle).length - 1;

const { ToolExecutor, buildToolCatalog } = await import('../dist/server/tools.js');
const { NativeBridge } = await import('../dist/server/native.js');
const { GlobalTipsStore } = await import('../dist/server/tips.js');

// ---------------------------------------------------------------- 1) 源码接线
console.log('\n=== 1) 源码与产物接线 ===');
const ps1 = fs.readFileSync(path.join(ROOT, 'scripts/native-host.ps1'), 'utf8');
const nativeTs = fs.readFileSync(path.join(ROOT, 'src/server/native.ts'), 'utf8');
const toolsTs = fs.readFileSync(path.join(ROOT, 'src/server/tools.ts'), 'utf8');
const promptTs = fs.readFileSync(path.join(ROOT, 'src/shared/prompt.ts'), 'utf8');

check('1.1 原生宿主有 capture-bg 命令', count(ps1, "'capture-bg'") === 1);
check('1.2 原生宿主有 CaptureBackground', count(ps1, 'public static Hashtable CaptureBackground') === 1);
check('1.3 原生宿主有 window-state / foreground 命令', count(ps1, "'window-state'") === 1 && count(ps1, "'foreground'") === 1);
check('1.4 native-host.ps1 仍是纯 ASCII（PS 5.1 无 BOM 解析要求）',
  [...ps1].every((c) => c.charCodeAt(0) < 128), '非 ASCII=' + [...ps1].filter((c) => c.charCodeAt(0) > 127).length);

// 抠出 CaptureBackground 函数体：从声明到下一个 static 方法（CaptureClient）
const bgStart = ps1.indexOf('public static Hashtable CaptureBackground');
const bgEnd = ps1.indexOf('static Bitmap CaptureClient', bgStart);
const bgBody = bgStart >= 0 && bgEnd > bgStart ? ps1.slice(bgStart, bgEnd) : '';
check('1.5 能抠出 CaptureBackground 函数体', bgBody.length > 500, bgBody.length + ' 字符');
check('1.6 函数体调用 PrintWindow', count(bgBody, 'PrintWindow(hwnd') === 2, '两次尝试');
check('1.7 函数体绝不 SetForegroundWindow', count(bgBody, 'SetForegroundWindow') === 0);
check('1.8 函数体绝不 ShowWindow（不还原最小化窗口）', count(bgBody, 'ShowWindow') === 0);
check('1.9 函数体绝不 BitBlt（不抓屏幕像素）', count(bgBody, 'BitBlt') === 0);

check('1.10 native.ts 有 captureBackground', count(nativeTs, 'async captureBackground') === 1);
check('1.11 native.ts 调 capture-bg', count(nativeTs, "'capture-bg'") === 1);
check('1.12 native.ts 有 windowState/foreground', count(nativeTs, 'async windowState(') === 1 && count(nativeTs, 'async foreground(') === 1);

check('1.13 tools.ts 有 screenshotBackground 方法', count(toolsTs, 'private async screenshotBackground(') === 1);
check('1.14 switch 有 screenshot_background 分支', count(toolsTs, "case 'screenshot_background'") === 1);
check('1.15 工具清单含 screenshot_background', count(toolsTs, "tool('screenshot_background'") === 1);
check('1.16 selectWindow 支持 activate 开关', count(toolsTs, 'activate = true): Promise<TargetInfo | null>') === 1);
check('1.17 原生真实调用只走 captureBackground', count(toolsTs, 'this.native.captureBackground(') === 1);
check('1.18 prompt.ts 引导使用 screenshot_background', count(promptTs, 'screenshot_background') >= 1);

const distTools = fs.readFileSync(path.join(ROOT, 'dist/server/tools.js'), 'utf8');
const distNative = fs.readFileSync(path.join(ROOT, 'dist/server/native.js'), 'utf8');
check('1.19 产物 tools.js 含 screenshot_background', count(distTools, 'screenshot_background') === 3);
check('1.20 产物 native.js 含 capture-bg', count(distNative, "'capture-bg'") === 1);

const catalog = buildToolCatalog();
const names = catalog.map((t) => t.function.name);
check('1.21 工具清单含 screenshot_background 且唯一',
  names.filter((n) => n === 'screenshot_background').length === 1);
check('1.22 select_window 声明了 activate 参数',
  JSON.stringify(catalog.find((t) => t.function.name === 'select_window').function.parameters.properties).includes('"activate"'));
check('1.23 既有 screenshot 仍在（向后兼容）', names.includes('screenshot'));

// ---------------------------------------------------------------- 2) 原生实测
console.log('\n=== 2) 原生通道实测（不抢前台 + 遮挡下内容正确） ===');
const bridge = new NativeBridge();
let nativeOk = false;
try {
  nativeOk = await bridge.start();
} catch {
  nativeOk = false;
}
check('2.1 原生桥启动', nativeOk, bridge.detail);

if (nativeOk) {
  try {
    const before = await bridge.foreground();
    const windows = await bridge.listWindows();
    check('2.2 能列出可见窗口', windows.length > 0, windows.length + ' 个');

    // 优先挑「非前台且被遮挡」的窗口——这是旧实现会截错的场景。
    // 注意：个别窗口（输入法宿主、透明浮层）本身不可渲染，PrintWindow 只会得到纯色；
    // 这类窗口正好用来验证 blank 判定，但内容断言必须落在能渲染的窗口上。
    const ranked = windows
      .filter((w) => String(w.hwnd) !== String(before.hwnd) && w.width >= 200 && w.height >= 150)
      .sort((a, b) => Number(b.width * b.height) - Number(a.width * a.height));
    check('2.3 有非前台候选窗口', ranked.length > 0, ranked.length + ' 个');

    const stBefore = new Map();
    for (const w of ranked) stBefore.set(String(w.hwnd), await bridge.windowState(w.hwnd));

    const tried = [];
    let picked = null;
    for (const w of ranked.slice(0, 6)) {
      const t0 = Date.now();
      const s = await bridge.captureBackground(w.hwnd, 640, 'jpeg');
      tried.push({ w, s, ms: Date.now() - t0 });
      if (s.buffer.length > 1000 && !s.blank) { picked = tried[tried.length - 1]; break; }
    }
    const after = await bridge.foreground();
    const brief = (t) => t.w.processName + '#' + t.w.pid + '=' + t.s.buffer.length + 'B,blank=' + t.s.blank;

    check('2.4 存在可后台渲染的窗口', !!picked, tried.map(brief).join('; '));

    if (!picked) {
      console.log('SKIP  2.5~2.10 本轮候选窗口都不可后台渲染（环境相关），跳过内容断言');
    } else {
      const { w: target, s: shot, ms } = picked;
      const st1 = stBefore.get(String(target.hwnd));
      const st2 = await bridge.windowState(target.hwnd);
      check('2.5 拿到图像数据', shot.buffer.length > 1000, shot.buffer.length + ' 字节 / ' + ms + 'ms');
      check('2.6 走的是 PrintWindow', shot.method === 'printwindow', shot.method);
      check('2.7 不是纯色空白图', shot.blank === false, 'blank=' + shot.blank);
      check('2.8 图像尺寸与客户区一致',
        shot.clientWidth === target.width && shot.clientHeight === target.height,
        shot.clientWidth + 'x' + shot.clientHeight + ' vs ' + target.width + 'x' + target.height);
      check('2.9 前台窗口未被抢走（连续抓图之后）', String(before.hwnd) === String(after.hwnd),
        before.processName + ' → ' + after.processName);
      check('2.10 目标窗口状态全程未变（前台/最小化/遮挡）',
        JSON.stringify(st1) === JSON.stringify(st2), JSON.stringify(st1));
      console.log('      目标: ' + target.processName + '#' + target.pid +
        ' 前台=' + st1.isForeground + ' 被遮挡=' + st1.occluded + ' 尺寸=' + target.width + 'x' + target.height);
      const sample = path.join(os.tmpdir(), 'ca-bg-shot-sample-' + Date.now() + '.jpg');
      fs.writeFileSync(sample, shot.buffer);
      console.log('      样本: ' + sample + '（' + fs.statSync(sample).size + ' 字节，临时目录，可删）');
    }

    check('2.11 所有抓取都走 PrintWindow 且 blank 标记完整',
      tried.length > 0 && tried.every((t) => t.s.method === 'printwindow' && typeof t.s.blank === 'boolean'),
      tried.map(brief).join('; '));
    const blanks = tried.filter((t) => t.s.blank).map((t) => t.w.processName + '#' + t.w.pid);
    if (blanks.length > 0) {
      console.log('      说明: ' + blanks.join(', ') + ' 被 blank 正确标记（这类窗口本身不可渲染，不是抓错窗口）');
    }
  } catch (e) {
    check('2.9 原生实测未抛异常', false, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------- 3) 工具层
console.log('\n=== 3) 工具层（不激活、不改目标、各分支） ===');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-bgshot-'));
const baseSettings = {
  apiBaseUrl: '', apiKey: '', model: '', reasoningEffort: 'auto', temperature: 0, maxOutputTokens: 1024,
  workspacePath: ws,
  gameRecordFileName: 'work_state.md', gameNotesFileName: 'work_notes.md', gameSavePath: '',
  allowShell: true, shellTimeoutMs: 20000, allowLaunch: false,
  allowPathRequests: true, extraWritePaths: '',
  continuousMode: false, continueDelayMs: 500, continuePrompt: '', maxTurns: 1, historyMaxMessages: 24, clickDelayMs: 0,
  sendScreenshots: true, screenshotBurnAfterRead: true, maxScreenshotWidth: 800, ocrLanguage: 'zh-Hans',
  ttsEnabled: false, ttsEngine: 'Browser', ttsVoice: '', ttsRate: 0, ttsVolume: 0.5,
  cloudTtsBaseUrl: '', cloudTtsApiKey: '', cloudTtsModel: 'tts-1', cloudTtsVoice: 'alloy',
  ttsQueueMode: 'latest', ttsQueueLimit: 2,
};
const ac = new AbortController();

/**

 * 假原生桥：记录调用，绝不真的动窗口。
 */
function makeStub(overrides = {}) {
  const calls = { activate: [], capture: [], captureBackground: [], listWindows: 0 };
  const wins = [
    { pid: 111, hwnd: '0xAA', title: 'Alpha Window', processName: 'alpha', width: 800, height: 600, isForeground: true },
    { pid: 222, hwnd: '0xBB', title: 'Beta Window', processName: 'beta', width: 1024, height: 768, isForeground: false },
  ];
  const stub = {
    available: true,
    detail: 'stub',
    calls,
    async listWindows() { calls.listWindows++; return wins; },
    async windowInfo(hwnd) {
      const w = wins.find((x) => String(x.hwnd) === String(hwnd)) || wins[0];
      return { ...w };
    },
    async activate(hwnd) { calls.activate.push(String(hwnd)); return true; },
    async capture(hwnd) {
      calls.capture.push(String(hwnd));
      return { buffer: Buffer.from('SCREEN-GRAB'), width: 100, height: 80, clientWidth: 800, clientHeight: 600 };
    },
    async captureBackground(hwnd, maxWidth, format) {
      calls.captureBackground.push({ hwnd: String(hwnd), maxWidth, format });
      if (overrides.throwBg) throw new Error('PrintWindow failed: window is minimized or cannot render in background');
      return {
        buffer: Buffer.from('PRINTWINDOW-BYTES'),
        width: 640, height: 480, clientWidth: 800, clientHeight: 600,
        method: 'printwindow', minimized: false, isForeground: false, occluded: true,
        blank: !!overrides.blank,
      };
    },
    async windowState() { return { isForeground: false, minimized: false, visible: true, occluded: true }; },
    async foreground() { return wins[0]; },
    ...overrides.extra,
  };
  return stub;
}

function makeExecutor(stub, settingsPatch = {}) {
  const settings = { ...baseSettings, ...settingsPatch };
  const tools = new ToolExecutor(settings, stub, new GlobalTipsStore(path.join(ws, 'global_tips.json')));
  tools.bindSession({
    id: 'bgshot', title: 'bgshot',
    recordPath: path.join(ws, 'work_state.md'), notesPath: path.join(ws, 'work_notes.md'),
  });
  return tools;
}

// 3a 用当前目标窗口
{
  const stub = makeStub();
  const tools = makeExecutor(stub);
  await tools.selectWindow(111, undefined);           // 会 activate（默认行为不变）
  check('3.1 select_window 默认仍激活（向后兼容）', stub.calls.activate.length === 1, stub.calls.activate.join(','));
  await tools.execute('screenshot', JSON.stringify({ max_width: 320 }), ac.signal);
  check('3.2 screenshot 仍走旧通道 capture()', stub.calls.capture.length === 1 && stub.calls.captureBackground.length === 0);

  stub.calls.activate.length = 0;
  const r = await tools.execute('screenshot_background', JSON.stringify({ max_width: 640 }), ac.signal);
  check('3.3 screenshot_background 成功且回图像', !r.isError && Array.isArray(r.images) && r.images.length === 1,
    (r.text || '').split('\n')[0].slice(0, 60));
  check('3.4 绝不调用 activate（不抢窗口）', stub.calls.activate.length === 0, stub.calls.activate.join(','));
  check('3.5 走的是 captureBackground（不是抓屏幕）',
    stub.calls.captureBackground.length === 1 && stub.calls.capture.length === 1);
  check('3.6 传了正确的 max_width', stub.calls.captureBackground[0].maxWidth === 640,
    JSON.stringify(stub.calls.captureBackground[0]));
  check('3.7 文案标明未激活窗口', (r.text || '').includes('未激活窗口'), '');
  check('3.8 文案给出前台/遮挡状态', /前台=否/.test(r.text) && /被遮挡=是/.test(r.text), '');
}

// 3b 用 pid 指定「另一个」窗口，且不改本会话目标
{
  const stub = makeStub();
  const tools = makeExecutor(stub);
  await tools.selectWindow(111);
  stub.calls.activate.length = 0;
  const r = await tools.execute('screenshot_background', JSON.stringify({ pid: 222 }), ac.signal);
  check('3.9 可对任意 pid 后台截图', !r.isError && stub.calls.captureBackground[0].hwnd === '0xBB',
    JSON.stringify(stub.calls.captureBackground[0] || {}));
  check('3.10 指定 pid 时不激活该窗口', stub.calls.activate.length === 0);
  const ctx = tools.runtimeContext();
  check('3.11 不改变本会话目标窗口', ctx.includes('PID=111'), ctx.split('\n').find((l) => l.startsWith('- 目标窗口')) || '');
  check('3.12 文案带上了窗口标识', (r.text || '').includes('Beta Window'), '');
}

// 3c blank 分支
{
  const stub = makeStub({ blank: true });
  const tools = makeExecutor(stub);
  await tools.selectWindow(111);
  const r = await tools.execute('screenshot_background', '{}', ac.signal);
  check('3.13 纯色空白图报错并给出替代方案', r.isError && /疑似纯色空白/.test(r.text) && /screenshot/.test(r.text),
    (r.text || '').slice(0, 60));
}

// 3d PrintWindow 失败分支
{
  const stub = makeStub({ throwBg: true });
  const tools = makeExecutor(stub);
  await tools.selectWindow(111);
  let threw = false;
  let text = '';
  try {
    const r = await tools.execute('screenshot_background', '{}', ac.signal);
    text = r.text || '';
  } catch (e) {
    threw = true;
    text = e instanceof Error ? e.message : String(e);
  }
  check('3.14 PrintWindow 失败时不静默（抛错或报错）', threw || text.length > 0, text.slice(0, 60));
}

// 3e 窗口不存在 / 未选窗口
{
  const stub = makeStub();
  const tools = makeExecutor(stub);
  const r1 = await tools.execute('screenshot_background', JSON.stringify({ pid: 999 }), ac.signal);
  check('3.15 找不到窗口时明确报错', r1.isError && /未找到匹配的窗口/.test(r1.text), (r1.text || '').slice(0, 40));
  const r2 = await tools.execute('screenshot_background', '{}', ac.signal);
  check('3.16 未选窗口且无参数时明确报错', r2.isError && /尚未选择窗口/.test(r2.text), (r2.text || '').slice(0, 40));
  const r3 = await tools.execute('screenshot_background', JSON.stringify({ title_contains: 'beta' }), ac.signal);
  check('3.17 支持按标题关键字定位', !r3.isError && stub.calls.captureBackground[0].hwnd === '0xBB');
}

// 3f 不发送截图图像的会话
{
  const stub = makeStub();
  const tools = makeExecutor(stub, { sendScreenshots: false });
  await tools.selectWindow(111);
  const r = await tools.execute('screenshot_background', '{}', ac.signal);
  check('3.18 关闭截图图像时只回文字元信息', !r.isError && !r.images && /不发送截图图像/.test(r.text),
    (r.text || '').slice(0, 50));
}

// 3g select_window activate=false
{
  const stub = makeStub();
  const tools = makeExecutor(stub);
  const r = await tools.execute('select_window', JSON.stringify({ pid: 222, activate: false }), ac.signal);
  check('3.19 select_window activate=false 不激活', !r.isError && stub.calls.activate.length === 0,
    (r.text || '').slice(0, 50));
  check('3.20 文案说明未激活', /未激活窗口/.test(r.text), '');
}

// 3h 原生不可用
{
  const stub = makeStub({ extra: { available: false, detail: '原生桥接未启动（stub）' } });
  const tools = makeExecutor(stub);
  const r = await tools.execute('screenshot_background', '{}', ac.signal);
  check('3.21 原生不可用时给出清晰原因', r.isError && /原生控制不可用/.test(r.text), (r.text || '').slice(0, 40));
}

// ---------------------------------------------------------------- 汇总
if (nativeOk) bridge.stop();
const failed = results.filter((x) => !x).length;
console.log('');
if (failed === 0) {
  console.log('OK: ' + results.length + '/' + results.length + ' 项通过');
  process.exit(0);
} else {
  console.log('FAIL: ' + failed + ' / ' + results.length + ' 项未通过');
  process.exit(1);
}
