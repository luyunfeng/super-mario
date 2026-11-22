import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';

test('命名会话经 WebSocket 打开，写入失败只报告一次并释放该连接', { timeout: 15_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-terminal-wire-'));
  const token = 'terminal-test-only';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token, demo: true });
  let writes = 0, releases = 0;
  const agent = startAgentNode({
    url: server.url, token, machineId: 'test', name: '测试执行机', dataDir: join(dir, 'node'),
    handlers: {
      'terminal.live.full.open': async params => ({ connectionId: 'attached', session: params.session }),
      'terminal.live.frames': async () => ({ frames: [] }),
      'terminal.live.input': async () => { writes++; throw new Error('输入结果未知'); },
      'terminal.live.release': async () => { releases++; return {}; },
    },
  });
  t.after(async () => { await agent.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  while (!server.machines.list().some(m => m.online)) await delay(10);
  const ws = new WebSocket(server.url.replace('http:', 'ws:') + '/api/v1/live-terminal?machineId=test&mode=full&session=blue', { headers: { Authorization: 'Bearer ' + token } });
  const messages: Record<string, string>[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', () => resolve());
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      if (msg.type === 'ready') {
        ws.send(JSON.stringify({ type: 'input', data: 'YQ==' }));
        ws.send(JSON.stringify({ type: 'input', data: 'Yg==' }));
      }
    });
  });
  assert.deepEqual(messages.map(m => m.type), ['ready', 'error']);
  assert.equal(messages[0]?.session, 'blue');
  assert.match(messages[1]!.message!, /输入结果未知/);
  for (let i = 0; i < 100 && !releases; i++) await delay(10);
  assert.equal(writes, 1);
  assert.equal(releases, 1);
});
