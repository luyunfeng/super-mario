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
import { createMessageFavorites, messageFavorites } from '../plugins/message-favorites.ts';

async function fixture(t: test.TestContext, extension = messageFavorites) {
  const dir = await mkdtemp(join(tmpdir(), 'message-favorites-'));
  const store = createStore(join(dir, 'test.sqlite'));
  const events = createEventBus(store);
  const host = new PluginHost({ store, dataDir: dir, events, contributions: createContributions() });
  t.after(async () => { await host.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  host.register(extension);
  await host.start();
  const call = async (request: JsonObject) => await host.invocations.use('message-favorites.manage', request) as JsonObject;
  const changes = () => events.since(0).filter(event => event.type === 'message-favorites.changed').map(event => event.data);
  return { store, host, call, changes };
}

const source = { id: 'local-msg', conversationId: 'main', role: 'assistant', text: '🐢'.repeat(4005), createdAt: '2026-01-01T00:00:00Z' };
test('favorites snapshot actual work messages, cap by Unicode character and recheck the original conversation', async t => {
  const { store, call, host, changes } = await fixture(t);
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
  const locate = { action: 'locate', id: projectItem.id };
  assert.deepEqual(await call(locate), { messageId: source.id, projectId: 'proj' });
  store.put('projects', 'proj', { id: 'proj', name: '项目一', archivedAt: source.createdAt });
  await assert.rejects(call(locate), { status: 404 });
  store.remove('messages', source.id);
  await assert.rejects(call(locate), { status: 404 });
  await assert.rejects(call({ action: 'source', id: projectItem.id }), { status: 404 });
  await assert.rejects(call({ action: 'remove', id: item.id, revision: 1 }), { status: 409 });
  assert.equal((await call({ action: 'remove', id: item.id, revision: 2 })).revision, 3);
  assert.equal((await call({ action: 'remove', id: item.id, revision: 3 })).revision, 3);
  assert.deepEqual(changes(), [{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
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
  assert.deepEqual(target.changes(), [{ revision: 1 }, { revision: 2 }]);
  target.store.put('messages', source.id, source);
  await assert.rejects(target.call({ action: 'add', messageId: source.id }), { status: 400 });
});

const native = { machineId: 'machine', executorId: 'codex', nativeSessionId: 'session', cwd: '/synthetic' };
const fingerprint = '1'.repeat(64);
const nativeMessage = { index: 26, fingerprint, role: 'user' as const, text: '字'.repeat(4100), createdAt: null };
test('native favorites verify positional fingerprints, project public fields and back up without source locators', async t => {
  let current = [{ ...nativeMessage, privateMetadata: 'private' }];
  const { call, changes } = await fixture(t, createMessageFavorites(async (source, offset) => {
    assert.deepEqual(source, native);
    return { items: current.filter(row => row.index >= offset && row.index < offset + 25), total: 27 };
  }));
  const page = { action: 'nativePage', native, offset: 25 };
  assert.deepEqual(await call(page), { items: [nativeMessage], total: 27 });
  await assert.rejects(call({ ...page, native: { ...native, executorId: 'external' } }), { status: 400 });
  await assert.rejects(call({ ...page, offset: -1 }), { status: 400 });
  const add = { action: 'addNative', native, index: 26, fingerprint };
  await assert.rejects(call({ ...add, fingerprint: '2'.repeat(64) }), { status: 409 });
  const [a, b] = await Promise.all([call(add), call(add)]);
  assert.deepEqual(a, b);
  assert.deepEqual(changes(), [{ revision: 1 }]);
  const [item] = a.items as JsonObject[];
  assert.equal(a.revision, 1);
  assert.deepEqual(item.native, native);
  assert.equal(item.createdAt, null);
  assert.equal(item.omitted, 100);
  assert.deepEqual(await call({ action: 'marks' }), { revision: 1, items: [{ id: item.id, native, index: 26, fingerprint }] });
  const readSource = { action: 'source', id: item.id };
  assert.deepEqual(await call(readSource), { native, ...nativeMessage });
  current[0].fingerprint = '3'.repeat(64);
  await assert.rejects(call(readSource), { status: 409 });
  current = [];
  await assert.rejects(call(readSource), { status: 409 });
  const backup = await call({ action: 'backup' });
  const [record] = backup.messages as JsonObject[];
  assert.deepEqual(Object.keys(record).sort(), ['createdAt','key','omitted','role','starredAt','text','title']);
  assert.equal(record.createdAt, null);
  const restored = await fixture(t);
  await restored.call({ action: 'restore', backup, revision: 0 });
  const [archive] = (await restored.call({ action: 'list' })).items as JsonObject[];
  assert.equal(archive.native, undefined);
  assert.equal(archive.createdAt, null);
  await assert.rejects(restored.call({ action: 'source', id: archive.id }), { status: 404 });
  await assert.rejects(restored.call(page), { status: 503 });
});

test('a delayed native read cannot write after the plugin has been disabled and re-enabled', async t => {
  let notifyStart!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { notifyStart = resolve; });
  const finish = new Promise<void>(resolve => { resume = resolve; });
  const { host, call } = await fixture(t, createMessageFavorites(async (_source, _offset, signal) => {
    notifyStart();
    await finish;
    assert.ok(signal.aborted);
    return { items: [nativeMessage], total: 27 };
  }));
  const pending = call({ action: 'addNative', native, index: 26, fingerprint });
  await started;
  await host.setEnabled('message-favorites', false);
  await host.setEnabled('message-favorites', true);
  resume();
  await assert.rejects(pending, { status: 503 });
  assert.deepEqual(await call({ action: 'list' }), { revision: 0, items: [] });
});
