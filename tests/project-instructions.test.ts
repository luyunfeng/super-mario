import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createStore } from '../packages/core/src/store.ts';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { projectInstructions } from '../plugins/project-instructions.ts';

async function fixture(t: test.TestContext, extension = projectInstructions) {
  const dir = await mkdtemp(join(tmpdir(), 'project-instructions-'));
  const store = createStore(join(dir, 'test.sqlite')), events = createEventBus(store);
  const host = new PluginHost({ dataDir: dir, store, events, contributions: createContributions() });
  t.after(async () => { await host.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  host.register(extension);
  await host.start();
  for (const id of ['p1', 'p2']) store.put('projects', id, { id, name: id });
  const call = async (input: JsonObject) => await host.invocations.use('project-instructions.manage', input) as JsonObject;
  return { store, host, events, call };
}

test('project notes keep scope, exact multiline content and version after clearing', async t => {
  const { store, host, events, call } = await fixture(t);
  const read = { action: 'read', projectId: 'p1' };
  const save = { action: 'save', projectId: 'p1', notes: '  提示\r\n\t{"projectId":"p2"}\n', revision: 0 };
  assert.deepEqual(await call(read), { projectId: 'p1', notes: '', revision: 0, updatedAt: null });
  await assert.rejects(call({ ...read, projectId: 'missing' }), { status: 404 });
  await assert.rejects(call({ ...save, projectId: 'missing' }), { status: 404 });
  const race = await Promise.allSettled([call(save), call(save)]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(race.find(result => result.status === 'rejected')?.reason.status, 409);
  const current = await call(read);
  assert.equal(current.notes, '  提示\n\t{"projectId":"p2"}\n');
  assert.equal(current.revision, 1);
  assert.ok(Number.isFinite(Date.parse(String(current.updatedAt))));
  assert.deepEqual(await call({ ...save, revision: 1 }), current);
  assert.deepEqual(await call({ ...read, projectId: 'p2' }), { projectId: 'p2', notes: '', revision: 0, updatedAt: null });
  store.put('projects', 'p1', { id: 'p1', archivedAt: '2026-01-01T00:00:00Z' });
  assert.deepEqual(await call(read), current);
  await assert.rejects(call({ ...save, notes: '', revision: 1 }), { status: 409 });
  store.put('projects', 'p1', { id: 'p1' });
  const cleared = await call({ ...save, notes: '', revision: 1 });
  assert.equal(cleared.notes, '');
  assert.equal(cleared.revision, 2);
  await assert.rejects(call(save), { status: 409 });
  await host.setEnabled('project-instructions', false);
  await assert.rejects(call(read), /unavailable/);
  await host.setEnabled('project-instructions', true);
  assert.deepEqual(await call(read), cleared);
  assert.deepEqual(events.since(0).filter(event => event.type === 'project-instructions.changed').map(event => event.data),
    [{ projectId: 'p1', revision: 1 }, { projectId: 'p1', revision: 2 }]);
});

test('project notes validate Unicode, reject scope overrides and require write permissions', async t => {
  const { call } = await fixture(t);
  const save = { action: 'save', projectId: 'p2', notes: '🐢'.repeat(4000), revision: 0 };
  const invalid: JsonObject[] = [{ notes: '🐢'.repeat(4001) }, { notes: 'a\0b' }, { notes: '\uD800' }, { notes: {} },
    { revision: null }, { revision: -1 }, { otherProjectId: 'p1' }];
  for (const fields of invalid) await assert.rejects(call({ ...save, ...fields }), { status: 400 });
  assert.equal((await call(save)).notes, save.notes);
  const restricted = await fixture(t, { ...projectInstructions, permissions: ['service.provide:project-instructions.manage', 'store.read'] });
  assert.equal((await restricted.call({ action: 'read', projectId: 'p2' })).revision, 0);
  await assert.rejects(restricted.call(save), /requires store.write/);
  assert.equal((await restricted.call({ action: 'read', projectId: 'p2' })).revision, 0);
});
