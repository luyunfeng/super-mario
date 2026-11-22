import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { assistantProfile } from '../plugins/assistant-profile.ts';

async function openProfile(dir: string) {
  const store = createStore(join(dir, 'test.sqlite'));
  const events = createEventBus(store);
  const host = new PluginHost({ dataDir: dir, store, events, contributions: createContributions() });
  host.register(assistantProfile);
  await host.start();
  return {
    call: (input: JsonObject) => host.invocations.use('assistant-profile.manage', input),
    changes: () => events.since(0).filter(event => event.type === 'assistant-profile.changed').map(event => event.data),
    close: async () => { await host.close(); store.close(); },
    host,
  };
}

test('assistant profile defaults, handles conflicting writes and survives a database reopen', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-profile-'));
  let runtime = await openProfile(dir);
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const read = { action: 'read' }, save = { action: 'save', name: '  欧阳·安娜  ', revision: 0 };
  assert.deepEqual(await runtime.call(read), { name: '主 Agent', revision: 0 });
  const race = await Promise.allSettled([runtime.call(save), runtime.call(save)]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(race.find(result => result.status === 'rejected')?.reason.status, 409);
  const updated = { name: '欧阳·安娜', revision: 1 };
  assert.deepEqual(await runtime.call({ ...save, revision: 1 }), updated);
  assert.deepEqual(runtime.changes(), [{ revision: 1 }]);
  await runtime.close();
  runtime = await openProfile(dir);
  assert.deepEqual(await runtime.call(read), updated);
  await runtime.host.setEnabled('assistant-profile', false);
  await assert.rejects(runtime.call(read), /unavailable/);
  await runtime.host.setEnabled('assistant-profile', true);
  assert.deepEqual(await runtime.call({ ...save, name: '主 Agent', revision: 1 }), { name: '主 Agent', revision: 2 });
  assert.deepEqual(runtime.changes(), [{ revision: 1 }, { revision: 2 }]);
});

test('assistant profile rejects controls, forged fields and invalid revisions, and counts Unicode characters', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-profile-')), runtime = await openProfile(dir);
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const save = { action: 'save', revision: 0, name: '𠮷'.repeat(40) };
  for (const name of ['  ', '\nName', 'Name\t', 'a\u0085b', 'a\u2028b', '\u200E姓名', '\u202E名', '名\u2069', '\uDFFF', save.name + '一']) {
    await assert.rejects(runtime.call({ ...save, name }), { status: 400 });
  }
  const invalid: JsonObject[] = [{ action: 'save', name: '名' }, { ...save, revision: -1 },
    { ...save, revision: '0' }, { ...save, projectId: 'foreign' }, { action: 'read', name: 'name' }];
  for (const input of invalid) await assert.rejects(runtime.call(input), { status: 400 });
  assert.deepEqual(runtime.changes(), []);
  assert.deepEqual(await runtime.call(save), { revision: 1, name: save.name });
});
