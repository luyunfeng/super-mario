import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PluginHost, createContributions } from '../packages/core/src/plugin-host.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createSystemExtensions } from '../plugins/index.ts';
import { sdkOnlyExtension } from '../plugins/examples/sdk-only.ts';

test('SDK-only example and system extensions share a real host; disable cleans tools and listeners', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mario-sdk-example-'));
  const store = createStore(join(dataDir, 'state.sqlite'));
  const events = createEventBus(store);
  const contributions = createContributions();
  const host = new PluginHost({ store, events, contributions, dataDir });
  t.after(async () => {
    try { await host.close(); } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
  for (const extension of createSystemExtensions({ demo: false })) host.register(extension);
  host.register(sdkOnlyExtension);
  await host.start();
  assert.ok(host.list().every(item => item.status === 'active'), JSON.stringify(host.list()));
  const tool = contributions.list('tools').find(item => item.id === 'example_echo')!.value;
  assert.ok(contributions.list('tools').some(item => item.id === 'executors_list'));
  events.publish('example.ping', {});
  const input = { message: 'real registered execution', nested: [1, true] };
  assert.deepEqual(await tool.execute(input, new AbortController().signal), { input, observed: 1 });
  await host.setEnabled(sdkOnlyExtension.id, false);
  assert.equal(host.list().find(item => item.id === sdkOnlyExtension.id)!.status, 'disabled');
  assert.equal(contributions.list('tools').some(item => item.id === 'example_echo'), false);
  events.publish('example.ping', {});
  // The old closure is retained only to prove that its event listener was removed.
  assert.deepEqual(await tool.execute({}, new AbortController().signal), { input: {}, observed: 1 });
  await host.setEnabled(sdkOnlyExtension.id, true);
  const restarted = contributions.list('tools').filter(item => item.id === 'example_echo');
  assert.equal(restarted.length, 1);
  assert.deepEqual(await restarted[0]!.value.execute({}, new AbortController().signal), { input: {}, observed: 0 });
  await host.close();
  assert.deepEqual(contributions.list('tools'), []);
});
