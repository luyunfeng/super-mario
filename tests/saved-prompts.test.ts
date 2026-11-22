import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEventBus } from '../packages/core/src/events.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import { createStore } from '../packages/core/src/store.ts';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { savedPrompts } from '../plugins/saved-prompts.ts';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'saved-prompts-'));
  const store = createStore(join(dir, 'test.sqlite')), events = createEventBus(store);
  const host = new PluginHost({ store, dataDir: dir, events, contributions: createContributions() });
  t.after(async () => { await host.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  host.register(savedPrompts);
  await host.start();
  const call = async (input: JsonObject) => await host.invocations.use('saved-prompts.manage', input) as {
    revision: number; items: Array<{ id: string; name: string; text: string; createdAt: string; updatedAt: string }>;
  };
  return { call, host, changes: () => events.since(0).filter(event => event.type === 'saved-prompts.changed').map(event => event.data) };
}

test('saved prompts normalize text, persist order and publish only actual revisions', async t => {
  const { call, host, changes } = await fixture(t);
  assert.deepEqual(await call({ action: 'list' }), { revision: 0, items: [] });
  const first = { action: 'create', revision: 0, name: ' /Σ.总结 ', text: '\r\n甲\t乙\r丙\r\n丁 ' };
  const race = await Promise.allSettled([call(first), call(first)]);
  assert.deepEqual(race.map(result => result.status).sort(), ['fulfilled','rejected']);
  const rejected = race.find(result => result.status === 'rejected');
  assert.equal(rejected?.reason.status, 409);
  const { items: [a] } = await call({ action: 'list' });
  assert.equal(a.name, 'Σ.总结');
  assert.equal(a.text, '甲\t乙\n丙\n丁');
  assert.equal(a.createdAt, a.updatedAt);
  await assert.rejects(call({ ...first, revision: 1, name: 'ς.总结' }), { status: 409 });
  const { items: [, b] } = await call({ ...first, revision: 1, name: '另一个' });
  const update = { action: 'update', revision: 2, id: b.id, name: '新名称', text: '新提示词' };
  await assert.rejects(call({ ...update, name: a.name }), { status: 409 });
  const edited = await call(update);
  assert.equal(edited.items[1].createdAt, b.createdAt);
  assert.deepEqual(await call({ ...update, revision: 3 }), edited);
  for (const ids of [[a.id], [b.id,b.id], [a.id,'missing']]) {
    await assert.rejects(call({ action: 'reorder', revision: 3, ids }), { status: 409 });
  }
  const order = { action: 'reorder', revision: 3, ids: [b.id,a.id] };
  const sorted = await call(order);
  assert.deepEqual(sorted.items.map(item => item.id), order.ids);
  assert.deepEqual(await call({ ...order, revision: 4 }), sorted);
  await host.setEnabled('saved-prompts', false);
  await assert.rejects(call({ action: 'list' }), /unavailable/);
  await host.setEnabled('saved-prompts', true);
  assert.deepEqual(await call({ action: 'list' }), sorted);
  await assert.rejects(call({ ...update, id: 'missing', revision: 4 }), { status: 404 });
  const removed = await call({ action: 'remove', revision: 4, id: a.id });
  assert.deepEqual(await call({ action: 'remove', revision: 5, id: a.id }), removed);
  assert.deepEqual(changes(), [1,2,3,4,5].map(revision => ({ revision })));
});

test('saved prompts bound Unicode code points, control characters and collection size', async t => {
  const { call } = await fixture(t);
  const create = { action: 'create', name: '𠮷'.repeat(32), text: '🐢'.repeat(8000), revision: 0 };
  const invalidFields: JsonObject[] = [{ name: 'a b' }, { name: '//two' }, { name: '𠮷'.repeat(33) }, { text: 'a\u0080b' },
    { text: '\uD800' }, { text: '🐢'.repeat(8001) }, { text: '\r\n\t' }, { revision: null }, { id: 'unexpected' }];
  for (const invalid of invalidFields) {
    await assert.rejects(call({ ...create, ...invalid }), { status: 400 });
  }
  assert.equal((await call(create)).revision, 1);
  for (let i = 1; i < 100; i++) await call({ ...create, revision: i, name: 'prompt_' + i, text: '短句' });
  await assert.rejects(call({ ...create, revision: 100, name: 'extra' }), { status: 400 });
  assert.equal((await call({ action: 'list' })).items.length, 100);
});
