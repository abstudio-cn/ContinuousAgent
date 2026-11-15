#!/usr/bin/env node
/**
 * 历史消息序列自检：确保发给模型的 messages 永远不会出现
 *   "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
 * 的非法结构（DeepSeek/OpenAI 兼容接口会直接回 HTTP 400）。
 *
 * 用法：node scripts/history-sequence-test.mjs [--history <history.json>]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sanitizeHistory, trimHistoryMessages } from '../dist/server/history.js';
import { buildMessages } from '../dist/server/llm.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const failures = [];
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) failures.push(name);
};

/** 校验 API payload：每个 tool 消息都要能对应到紧邻的 assistant.tool_calls，且调用都有结果。 */
function validatePayload(messages) {
  const errors = [];
  let pending = null;
  const flush = () => {
    if (!pending) return;
    for (const [id, answered] of pending) if (!answered) errors.push('工具调用没有结果: ' + id);
    pending = null;
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      flush();
      pending = new Map(m.tool_calls.map((c) => [c.id, false]));
      const ids = new Set(m.tool_calls.map((c) => c.id));
      if (ids.size !== m.tool_calls.length) errors.push('assistant.tool_calls 存在重复 id @' + i);
      for (const id of ids) if (!id) errors.push('assistant.tool_calls 存在空 id @' + i);
      continue;
    }
    if (m.role === 'tool') {
      if (!pending) {
        errors.push('tool 消息没有前置 tool_calls @' + i + ' (tool_call_id=' + m.tool_call_id + ')');
        continue;
      }
      if (!pending.has(m.tool_call_id)) {
        errors.push('tool_call_id 不在前置 tool_calls 中 @' + i + ' (' + m.tool_call_id + ')');
        continue;
      }
      pending.set(m.tool_call_id, true);
      continue;
    }
    flush();
  }
  flush();
  return errors;
}

const call = (id, name = 'noop') => ({ id, name, arguments: '{}' });

/** 旧版 buildMessages 的等价实现（不做任何配对修复），用于展示“修复前会怎么发”。 */
function legacyPayload(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content ?? '' };
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content ? m.content : null,
        tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
      };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

// 1) 文件开头就是 tool 消息（本次线上故障的形态：按条数硬截断把 assistant 截掉了）
{
  const history = [
    { role: 'tool', toolCallId: 'call_1', content: '旧工具结果' },
    { role: 'assistant', content: '好', toolCalls: [call('call_2')] },
    { role: 'tool', toolCallId: 'call_2', content: '结果' },
  ];
  const fixed = sanitizeHistory(history);
  check('孤儿 tool 被丢弃', fixed.droppedToolMessages === 1, 'dropped=' + fixed.droppedToolMessages);
  check('修复后不以 tool 开头', fixed.messages[0].role !== 'tool', fixed.messages[0].role);
  const payload = buildMessages(fixed.messages);
  check('孤儿 tool 不再进入请求体', validatePayload(payload).length === 0, validatePayload(payload).join('; '));
}

// 2) assistant 有两个调用但只有一个结果（中断/异常退出）
{
  const history = [
    { role: 'user', content: '做点事' },
    { role: 'assistant', content: '', toolCalls: [call('call_a'), call('call_b')] },
    { role: 'tool', toolCallId: 'call_a', content: 'A 完成' },
    { role: 'user', content: '继续' },
  ];
  const fixed = sanitizeHistory(history);
  check('缺失结果被补齐', fixed.synthesizedToolResults === 1, 'synth=' + fixed.synthesizedToolResults);
  const payload = buildMessages(fixed.messages);
  const errs = validatePayload(payload);
  check('补齐后请求体合法', errs.length === 0, errs.join('; '));
}

// 3) 空 id / 重复 id（部分网关不回 id）
{
  const history = [
    { role: 'user', content: '开始' },
    { role: 'assistant', content: '', toolCalls: [call(''), call('dup')] },
    { role: 'assistant', content: '', toolCalls: [call('dup'), call('')] },
    { role: 'tool', toolCallId: '', content: '无 id 结果' },
    { role: 'tool', toolCallId: 'dup', content: 'dup 结果' },
    { role: 'tool', toolCallId: 'dup', content: '重复 id 结果' },
    { role: 'tool', toolCallId: '', content: '第二组唯一结果' },
  ];
  const fixed = sanitizeHistory(history);
  check('空/重复 id 被重置', fixed.remappedToolCallIds >= 2, 'remapped=' + fixed.remappedToolCallIds);
  const payload = buildMessages(fixed.messages);
  const errs = validatePayload(payload);
  check('重置后请求体合法', errs.length === 0, errs.join('; '));
}

// 4) 裁剪窗口内没有 user：必须回退到完整工具组的起点
{
  const history = [{ role: 'user', content: '目标' }];
  for (let i = 0; i < 60; i++) {
    history.push({ role: 'assistant', content: '', toolCalls: [call('c' + i + '_0'), call('c' + i + '_1')] });
    history.push({ role: 'tool', toolCallId: 'c' + i + '_0', content: 'x' });
    history.push({ role: 'tool', toolCallId: 'c' + i + '_1', content: 'y' });
  }
  const trimmed = trimHistoryMessages(history, 10);
  check('裁剪后不以 tool 开头', trimmed.messages[1] && trimmed.messages[1].role !== 'tool',
    trimmed.messages[1] ? trimmed.messages[1].role : 'none');
  const payload = buildMessages(trimmed.messages, false);
  const errs = validatePayload(payload);
  check('裁剪后请求体合法', errs.length === 0, errs.join('; '));
  check('裁剪确实生效', trimmed.removed > 0, 'removed=' + trimmed.removed);
}

// 5) 真实故障文件（如果存在）：%APPDATA%/ContinuousAgent/sessions/<id>/history.json
{
  const direct = arg('history', '');
  let file = direct;
  if (!file) {
    const root = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'ContinuousAgent', 'sessions');
    if (fs.existsSync(root)) {
      const found = fs.readdirSync(root)
        .map((d) => path.join(root, d, 'history.json'))
        .filter((f) => fs.existsSync(f))
        .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
      if (found) file = found;
    }
  }
  if (file && fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const beforeErrs = validatePayload(legacyPayload(raw));
    const afterErrs = validatePayload(buildMessages(raw, false));
    console.log('真实历史: ' + file + '（首条 role=' + (raw[0]?.role || 'empty') + '）');
    console.log('  旧逻辑会发出的非法点: ' + beforeErrs.length + '，修复后: ' + afterErrs.length);
    if (beforeErrs.length) console.log('  首个非法点: ' + beforeErrs[0]);
    check('真实历史修复后请求体合法', afterErrs.length === 0, afterErrs.slice(0, 3).join('; '));
  } else {
    console.log('（未找到 history.json，跳过真实文件用例）');
  }
}

console.log('');
console.log(failures.length === 0 ? '历史序列自检通过 [OK]' : '历史序列自检失败 [FAIL] ' + failures.join(', '));
process.exit(failures.length === 0 ? 0 : 1);
