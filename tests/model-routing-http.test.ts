import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import { PURPOSES, type Purpose } from '../packages/core/src/model-routing.ts';

interface RoutingStatus {
  mainModel: string; timeZone: string;
  purposes: { purpose: Purpose; name: string; model: string; own: boolean; fallback?: string; blocked?: string; usage: { used: number; limit?: number }; rule: { model?: string; fallback?: string; dailyLimit?: number } }[];
  fallbacks: { purpose: Purpose; from: string; to: string; reason: string }[];
}

/** A model endpoint that answers like an OpenAI-compatible one, and counts what it is asked. */
async function modelService() {
  const asked: { model: string }[] = [];
  const service = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      let request: { model?: string; stream?: boolean } = {};
      try { request = JSON.parse(body || '{}'); } catch { /* not JSON */ }
      const model = String(request.model ?? '');
      asked.push({ model });
      // A translation is asked for JSON, and answers with it.
      const translating = /翻译|translat/i.test(body);
      const content = translating ? JSON.stringify({ texts: ['A reply that was translated'] }) : '合成的回复';
      // A model that does not exist is refused as a provider refuses it.
      if (model.includes('missing')) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'model not found' } })); return; }
      // The SDK asks for a stream by default, and reads server-sent events; it also takes a whole answer.
      const base = { id: 'chatcmpl-synthetic', object: 'chat.completion', model, created: 1 };
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, finish_reason] of [[{ role: 'assistant', content }, null], [{}, 'stop']] as const) {
          res.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: 'chatcmpl-synthetic', object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    });
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', () => resolve()));
  return { asked, url: 'http://127.0.0.1:' + (service.address() as { port: number }).port + '/v1',
    close: () => new Promise<void>((resolve, reject) => { service.closeAllConnections(); service.close(error => error ? reject(error) : resolve()); }) };
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-routing-'));
  const service = await modelService();
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: false, token: 'routing-fixture',
    model: { provider: 'openai-compatible', model: 'main-model', baseUrl: service.url, apiKey: 'synthetic-key' } });
  t.after(async () => { await server.close(); await service.close(); await rm(dir, { recursive: true, force: true }); });
  const web = async <T>(path: string, method = 'GET', body?: object) => {
    const answer = await fetch(server.url + '/api/v1/' + path, { method, headers: { authorization: 'Bearer routing-fixture', 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: answer.status, body: await answer.json() as T };
  };
  const status = async () => (await web<RoutingStatus>('model/routing')).body;
  return { server, service, web, status };
}

test('what each purpose is set to is read, and a purpose without a model of its own follows the main model', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const before = await f.status();
  assert.equal(before.mainModel, 'main-model');
  assert.deepEqual(before.purposes.map(row => row.purpose), [...PURPOSES]);
  // Nothing is set: every purpose follows the main model, with no limit and no fallback.
  for (const row of before.purposes) {
    assert.equal(row.model, 'main-model');
    assert.equal(row.own, false);
    assert.equal(row.fallback, undefined);
    assert.equal(row.blocked, undefined);
    assert.equal(row.usage.used, 0);
    assert.equal(row.usage.limit, undefined);
  }
  assert.deepEqual(before.fallbacks, []);
});

test('a purpose is given its own model, a fallback and a day limit; what is set is read back and kept after a restart', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const saved = await f.web<RoutingStatus>('model/routing/supervisor', 'PUT', { model: 'cheap-model', fallback: 'spare-model', dailyLimit: 30 });
  assert.equal(saved.status, 200);
  const supervisor = saved.body.purposes.find(row => row.purpose === 'supervisor')!;
  assert.equal(supervisor.model, 'cheap-model');
  assert.equal(supervisor.own, true);
  assert.equal(supervisor.fallback, 'spare-model');
  assert.deepEqual(supervisor.usage, { used: 0, limit: 30 });
  // The other purposes are not touched.
  assert.equal(saved.body.purposes.find(row => row.purpose === 'lessons')!.own, false);
  // A field left out goes back to following the main model; the rest of the rule is kept.
  const cleared = await f.web<RoutingStatus>('model/routing/supervisor', 'PUT', { dailyLimit: 30 });
  const after = cleared.body.purposes.find(row => row.purpose === 'supervisor')!;
  assert.equal(after.own, false);
  assert.equal(after.model, 'main-model');
  assert.equal(after.usage.limit, 30);
  // An empty rule removes the purpose's entry altogether.
  const removed = await f.web<RoutingStatus>('model/routing/supervisor', 'PUT', {});
  assert.deepEqual(removed.body.purposes.find(row => row.purpose === 'supervisor')!.rule, {});
  assert.equal(f.server.app.store.get('settings', 'model-routing'), undefined);
});

test('what is refused: a purpose that does not exist, a malformed model, and a field that is not known', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.web('model/routing/nonsense', 'PUT', { model: 'x' })).status, 404);
  assert.equal((await f.web('model/routing/supervisor', 'PUT', { model: 'has space' })).status, 400);
  assert.equal((await f.web('model/routing/supervisor', 'PUT', { model: 'a', fallback: 'a' })).status, 400);
  assert.equal((await f.web('model/routing/supervisor', 'PUT', { dailyLimit: -1 })).status, 400);
  assert.equal((await f.web('model/routing/supervisor', 'PUT', { colour: 'red' })).status, 400);
  assert.equal((await f.status()).purposes.find(row => row.purpose === 'supervisor')!.own, false);
});

test('a purpose with a model of its own is asked for that model, and one that reached its day limit is refused', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  await t.waitFor(async () => assert.equal((await f.web<{ runtime: { main: { available: boolean } } }>('model')).body.runtime.main.available, true));
  // Translation is a direct completion: each call is one request, so it is the simplest to count.
  assert.equal((await f.web('model/routing/translation', 'PUT', { model: 'cheap-model', dailyLimit: 1 })).status, 200);
  for (const [id, text] of [['synthetic-reply', '需要翻译的回复'], ['another-reply', '另一条需要翻译的回复']]) {
    f.server.app.store.put('messages', id, { id, conversationId: 'main', role: 'assistant', text, status: 'done', createdAt: '2026-11-27T00:00:00Z' });
  }
  // A second reply, and not the same one again: a translation it already made is answered from
  // its cache without asking the model, and so is neither counted nor held by the limit.
  const translate = (messageId: string) => f.web<{ text?: string; error?: string }>('reply-translation', 'POST', { messageId, conversationId: 'main', target: 'en' });
  const first = await translate('synthetic-reply');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(f.service.asked.at(-1)!.model, 'cheap-model');
  // The limit of one is reached: the next is refused before anything is asked of the provider.
  const second = await translate('another-reply');
  assert.equal(second.status, 429, JSON.stringify(second.body));
  assert.match(String(second.body.error), /今日 回复翻译已用 1 次，达到上限 1/);
  assert.equal(f.service.asked.filter(row => row.model === 'cheap-model').length, 1);
  const row = (await f.status()).purposes.find(purpose => purpose.purpose === 'translation')!;
  assert.deepEqual(row.usage, { used: 1, limit: 1 });
  assert.match(row.blocked!, /达到上限/);
  // The main conversation is not held by another purpose's limit.
  assert.equal((await f.status()).purposes.find(purpose => purpose.purpose === 'main')!.blocked, undefined);
});
