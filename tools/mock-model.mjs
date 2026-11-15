import http from 'node:http';

const record = [
  '# 游戏记录', '',
  '## 角色信息', '- 名称：自检勇者 Lv.9', '', 
  '## 角色装备', '- 铁剑', '',
  '## 当前进度', '- 第二章', '',
  '## 游戏背景', '- Mock 世界', '',
  '## 人物关系', '- 无', '',
  '## 游玩策略风格', '- 稳健探索',
].join('\n');

const PORT = Number(process.env.MOCK_PORT || 18766);

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const toolCount = (body.match(/"role":"tool"/g) || []).length;
    console.log('REQ bytes=' + body.length + ' toolMessages=' + toolCount);
    const missing = [];
    for (const marker of ['你是 GameAgent', '游戏笔记（长期知识库）', 'GAME_AGENT_NOTES_BEGIN',
      'GAME_NOTES.md BEGIN', 'GAME_RECORD.md BEGIN', 'RUNTIME CONTEXT BEGIN']) {
      if (!body.includes(marker)) missing.push(marker);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

    if (missing.length > 0) {
      send({ choices: [{ delta: { content: 'MISSING_CONTEXT: ' + missing.join(', ') }, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const native = process.env.MOCK_MODE === 'native';
    if (native && toolCount === 0) {
      send({ choices: [{ delta: { content: '先截图确认画面。' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_s1', type: 'function', function: { name: 'screenshot', arguments: JSON.stringify({ max_width: 900 }) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else if (native && toolCount === 1) {
      send({ choices: [{ delta: { content: '用 OCR 读取界面文字。' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_o1', type: 'function', function: { name: 'ocr', arguments: '{}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else if (native && toolCount === 2) {
      send({ choices: [{ delta: { content: '记录当前进度。' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_r1', type: 'function', function: { name: 'update_game_record', arguments: JSON.stringify({ content: record }) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else if (native) {
      send({ choices: [{ delta: { content: '原生链路自检完成。' }, finish_reason: 'stop' }] });
    } else if (toolCount === 0) {
      send({ choices: [{ delta: { reasoning_content: '先读取现有游戏记录，确认当前状态。' } }] });
      send({ choices: [{ delta: { content: '先看一下当前的游戏记录。' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_game_record', arguments: '{}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else if (toolCount === 1) {
      send({ choices: [{ delta: { content: '把已确认的情报写进长期笔记。' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'append_game_notes', arguments: JSON.stringify({ content: '\n- 自检：史莱姆弱点为火' }) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else if (toolCount === 2) {
      send({ choices: [{ delta: { content: '更新角色状态快照。' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_3', type: 'function', function: { name: 'update_game_record', arguments: JSON.stringify({ content: record }) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ delta: { content: '演示完成：记录与笔记都已更新。' }, finish_reason: 'stop' }] });
    }
    send({ usage: { prompt_tokens: 1200, completion_tokens: 80 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
server.listen(PORT, '127.0.0.1', () => console.log('mock model listening on ' + PORT));