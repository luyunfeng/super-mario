import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

/** The real SDK chain with a stand-in model that reports which model it was asked for. */
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-provenance-'));
  const asked: string[] = [];
  const model = createServer(async (req, res) => {
    if (req.method === 'GET') { res.end('fixture'); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const id = String(JSON.parse(raw).model ?? '');
    asked.push(id);
    // The answer names the model, and the usage differs by model so that each reply's is its own.
    const text = '由 ' + id + ' 回答';
    const usage = id === 'second-model' ? { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100 } : { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason, extra] of [[{ role: 'assistant', content: text }, null, {}], [{}, 'stop', { usage }]] as const) {
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: id, ...extra,
        choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(ok => model.listen(0, '127.0.0.1', ok));
  const address = model.address();
  assert.ok(address && typeof address === 'object');
  const server = await startServer({ dataDir: dir, host: '127.0.0.1', port: 0, demo: false, model: {
    provider: 'openai-compatible', model: 'first-model', apiKey: 'offline-model-fixture', baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
  } });
  // The server is closed first, while its directory is still there: closing writes to the
  // database. Then the model it talks to, then the directory.
  t.after(async () => { await server.close(); model.closeAllConnections(); await new Promise<void>(ok => model.close(() => ok())); await rm(dir, { recursive: true, force: true }); });
  const ready = async () => {
    for (let i = 0; i < 300; i++) {
      const status = await fetch(server.url + '/api/v1/model').then(answer => answer.json() as Promise<{ runtime: { main: { available: boolean } } }>);
      if (status.runtime.main.available) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('运行时未就绪');
  };
  const ask = async (text: string) => {
    const response = await fetch(server.url + '/api/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    assert.ok(response.ok, await response.clone().text());
    const input = await response.json() as Message;
    for (let i = 0; i < 500; i++) {
      const reply = server.app.store.list<Message>('messages').find(m => m.replyTo === input.id && (m.status === 'done' || m.status === 'failed'));
      if (reply) { assert.equal(reply.status, 'done', reply.text); return reply; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('模型回合未结束');
  };
  return { server, ask, asked, ready };
}

test('每条回复记下是哪个模型答的和这一轮的用量；对话中途换模型后，两条回复各记各的', { timeout: 60000 }, async t => {
  const { server, ask, asked, ready } = await fixture(t);
  await ready();
  const first = await ask('第一个问题');
  assert.match(first.text, /由 first-model 回答/);
  assert.deepEqual(first.model, { provider: 'openai-compatible', model: 'first-model' });
  // Input, output and the total as the model reported them; no cache was used.
  assert.deepEqual(first.usage, { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 1050 });
  // The owner picks another model for this conversation.
  // A model typed by hand, as one the catalogue does not list is picked.
  const picked = await fetch(server.url + '/api/v1/model/pick', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'second-model', typed: true }) });
  assert.ok(picked.ok, await picked.clone().text());
  const second = await ask('第二个问题');
  assert.match(second.text, /由 second-model 回答/);
  assert.deepEqual(second.model, { provider: 'openai-compatible', model: 'second-model' });
  assert.deepEqual(second.usage, { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 2100 });
  // The first reply still says which model gave it.
  assert.equal(server.app.store.get<Message>('messages', first.id)?.model?.model, 'first-model');
  assert.deepEqual(asked, ['first-model', 'second-model']);
});
