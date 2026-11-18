import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { startServer } from '../apps/server/src/index.ts';

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'super-mario-http-boundary-'));
  const running = await startServer({ host: '127.0.0.1', port: 0, dataDir, token: 'local-test', demo: true });
  t.after(async () => {
    try { await running.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  return running;
}

test('shutdown with a registered execution node drains socket callbacks before closing storage', async t => {
  const running = await fixture(t);
  const ws = new WebSocket(`${running.url.replace('http:', 'ws:')}/api/v1/node?token=local-test`);
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const welcome = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', machineId: 'local-machine', name: 'Local fake node', platform: 'test', capabilities: [] }));
  await welcome;
  const closed = once(ws, 'close');
  await running.close();
  await closed;
  // Give the server-side close callback a turn even when the client closes first.
  // node:test reports any uncaught access to the closed database as a test failure.
  await new Promise<void>(resolve => setImmediate(resolve));
});
