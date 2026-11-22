import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus } from '../packages/core/src/events.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import { createStore } from '../packages/core/src/store.ts';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { messageFavorites } from '../plugins/message-favorites.ts';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'message-favorites-'));
  const store = createStore(join(dir, 'test.sqlite'));
  const host = new PluginHost({ store, dataDir: dir, events: createEventBus(store), contributions: createContributions() });
  t.after(async () => { await host.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  host.register(messageFavorites);
  await host.start();
  const call = async (request: JsonObject) => await host.invocations.use('message-favorites.manage', request) as JsonObject;
  return { store, host, call };
}

const source = { id: 'local-msg', conversationId: 'main', role: 'assistant', text: '🐢'.repeat(4005), createdAt: '2026-01-01T00:00:00Z' };
test('favorites snapshot actual work messages, cap by Unicode character and recheck the original conversation', async t => {
  const { store, call, host } = await fixture(t);
  store.put('messages', source.id, source);
  const request = { action: 'add', messageId: source.id };
  await assert.rejects(call({ ...request, text: 'forged' }), { status: 400 });
  store.put('messages', source.id, { ...source, status: 'pending' });
  await assert.rejects(call(request), { status: 409 });
  store.put('messages', source.id, source);
  const added = await call(request);
  const [item] = added.items as JsonObject[];
  assert.deepEqual(await call({ action: 'marks' }), { revision: 1, items: [{ id: item.id, messageId: source.id }] });
  assert.equal(item.messageId, source.id);
  assert.equal(item.projectId, undefined);
  assert.equal(item.omitted, 5);
  assert.equal(item.text, '🐢'.repeat(4000));
  assert.deepEqual(await call(request), added);
  assert.equal((await call({ action: 'source', id: item.id })).text, source.text);
  store.put('projects', 'proj', { id: 'proj', name: '项目一' });
  for (const conversationId of ['project:proj:memory', 'bot:b', 'project:other:work']) {
    store.put('messages', source.id, { ...source, conversationId });
    await assert.rejects(call({ action: 'source', id: item.id }), { status: 404 });
    await assert.rejects(call({ ...request, projectId: 'proj' }), { status: 404 });
  }
  store.put('messages', source.id, { ...source, conversationId: 'project:proj:work', projectId: 'proj' });
  const project = await call({ ...request, projectId: 'proj' });
  const [projectItem] = project.items as JsonObject[];
  assert.equal(projectItem.projectId, 'proj');
  assert.equal((await call({ action: 'source', id: projectItem.id })).projectId, 'proj');
  store.remove('messages', source.id);
  await assert.rejects(call({ action: 'source', id: projectItem.id }), { status: 404 });
  await assert.rejects(call({ action: 'remove', id: item.id, revision: 1 }), { status: 409 });
  assert.equal((await call({ action: 'remove', id: item.id, revision: 2 })).revision, 3);
  await host.setEnabled('message-favorites', false);
  await assert.rejects(call({ action: 'list' }), /unavailable/);
  await host.setEnabled('message-favorites', true);
  assert.deepEqual((await call({ action: 'list' })).items, [projectItem]);
});

test('portable backups merge by stable key, never convey source access, and reject stale or partial restores', async t => {
  const original = await fixture(t), target = await fixture(t);
  original.store.put('messages', source.id, source);
  const item = ((await original.call({ action: 'add', messageId: source.id })).items as JsonObject[])[0];
  const backup = await original.call({ action: 'backup' });
  const [message] = backup.messages as JsonObject[];
  assert.deepEqual(Object.keys(message).sort(), ['createdAt','key','omitted','role','starredAt','text','title']);
  const preview = { action: 'preview', backup };
  const restore = { action: 'restore', backup, revision: 0 };
  assert.deepEqual(await original.call(preview), { revision: 1, total: 1, toAdd: 0, alreadySaved: 1, available: 299 });
  assert.deepEqual(await target.call(preview), { revision: 0, total: 1, toAdd: 1, alreadySaved: 0, available: 300 });
  for (const malformed of [{ ...message, messageId: source.id }, { ...message, role: 'invalid' }, { ...message, text: 'x'.repeat(4001) }]) {
    await assert.rejects(target.call({ ...restore, backup: { ...backup, messages: [malformed] } }), { status: 400 });
  }
  await assert.rejects(target.call({ ...restore, backup: { ...backup, messages: [message, message] } }), { status: 400 });
  await assert.rejects(target.call({ action: 'restore', backup }), { status: 400 });
  assert.equal((await target.call(restore)).revision, 1);
  await assert.rejects(target.call(restore), { status: 409 });
  assert.equal((await target.call({ ...restore, revision: 1 })).revision, 1);
  const [archive] = (await target.call({ action: 'list' })).items as JsonObject[];
  assert.notEqual(archive.id, item.id);
  assert.equal(archive.messageId, undefined);
  assert.equal(archive.projectId, undefined);
  await assert.rejects(target.call({ action: 'source', id: archive.id }), { status: 404 });
  assert.deepEqual(await target.call({ action: 'backup' }), backup);

  const batch = { ...backup, messages: Array.from({ length: 300 }, () => ({ ...message, text: '存档', omitted: 0, key: randomUUID() })) };
  assert.equal((await target.call({ ...preview, backup: batch })).available, 299);
  await assert.rejects(target.call({ ...restore, revision: 1, backup: batch }), { status: 400 });
  assert.equal((await target.call({ action: 'list' })).revision, 1);
  batch.messages.pop();
  assert.equal((await target.call({ ...restore, revision: 1, backup: batch })).toAdd, 299);
  target.store.put('messages', source.id, source);
  await assert.rejects(target.call({ action: 'add', messageId: source.id }), { status: 400 });
});
