import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';
import type { Job } from '../packages/core/src/knowledge-curator.ts';

test('explicit knowledge retry is idempotent across HTTP retries and restart; malformed requests do not enqueue work', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-knowledge-retry-'));
  let server = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, token: 'fixture' });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const original: Job = { id: 'original', title: '离线资料', text: '合成内容', layer: 'personal', status: 'unknown', knowledgeIds: [], createdAt: now, updatedAt: now, requestOrigin: 'agent', sourceMessageId: 'old-user' };
  server.app.store.put('knowledge.sources', original.id, original);
  async function retry(body: unknown) {
    const response = await fetch(server.url + '/api/v1/knowledge/sources/original/retry', { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as Job };
  }
  const [first, repeated] = await Promise.all([retry({ key: 'explicit-click' }), retry({ key: 'explicit-click' })]);
  assert.equal(first.status, 201);
  assert.equal(repeated.data.id, first.data.id);
  assert.equal(first.data.retryOf, original.id);
  assert.equal(first.data.requestOrigin, 'web'); // The authenticated user explicitly requested this retry.
  assert.equal(first.data.sourceMessageId, undefined);
  assert.equal(server.app.store.list('knowledge.sources').length, 2);
  await server.close();
  server = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, token: 'fixture' });
  assert.equal((await retry({ key: 'explicit-click' })).data.id, first.data.id);
  assert.equal((await retry({ key: 123 })).status, 400);
  assert.equal((await retry({ key: 'bad/key' })).status, 400);
  assert.equal((await retry({ key: 'new-key', requestOrigin: 'web' })).status, 400);
  assert.equal(server.app.store.list('knowledge.sources').length, 2);
  assert.equal(server.app.store.get<Job>('knowledge.sources', original.id)?.status, 'unknown');
});
