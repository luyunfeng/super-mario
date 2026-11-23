import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/core/src/store.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createPluginMetrics } from '../packages/core/src/plugin-metrics.ts';

test('real callbacks attribute service, wrapper and hook outcomes to their registering owners', async t => {
  const store = createStore(':memory:');
  const host = new PluginHost({ store, dataDir: '', events: createEventBus(store), contributions: createContributions() });
  t.after(async () => { await host.close(); store.close(); });
  host.register({ id: 'origin', name: 'Origin', capabilities: [], activate(c) {
    c.provide('origin.read', async value => {
      if (value === 'slow') return new Promise(() => {});
      if (value === 'private-argument') throw Error('private-exception');
      return { privateResult: true };
    });
  } });
  host.register({ id: 'observer', name: 'Observer', capabilities: [], dependencies: ['origin'], activate(c) {
    c.wrap('origin.read', (input, next) => next(input));
    // IDs supplied by a contributor need not include its name.
    c.contributions.add('hooks', 'someone-else:hook', { name: 'knowledge.put', phase: 'before',
      handler: () => ({action:'deny',reason:'private-reason'}) });
  } });
  await host.start();
  await host.invocations.use('origin.read', {});
  await assert.rejects(host.invocations.use('origin.read', 'private-argument'));
  await assert.rejects(host.invocations.use('origin.read', 'slow', {timeoutMs:5}));
  await assert.rejects(host.invocations.use('origin.read', {}, {signal:AbortSignal.abort()}));
  await assert.rejects(host.invocations.invoke('knowledge.put', {}, async () => null));
  const provider = host.metrics('origin', '1h');
  assert.deepEqual([provider.calls, provider.errors,provider.operations[0]?.name], [3, 2,'service:origin.read']);
  assert.ok(provider.p95Ms !== null && provider.p95Ms > 0);
  const observer = host.metrics('observer','24h');
  assert.deepEqual(observer.operations.map(row => [row.name,row.calls,row.errors]), [
    ['wrapper:origin.read',3,2], ['hook:knowledge.put:before',1,1],
  ]);
  await host.setEnabled('observer',false);
  await host.invocations.use('origin.read', {});
  assert.deepEqual(host.metrics('observer','24h'), observer);
  assert.throws(() => host.metrics('missing','7d'), {status:404});
  assert.throws(() => host.metrics('origin','invalid' as '1h'), {status:400});
  await host.close();
  const persisted = JSON.stringify(store.list('core.plugin-metrics.plugin.origin'));
  assert.match(persisted, /service:origin.read/);
  assert.doesNotMatch(persisted, /private/);
});

test('SQLite buckets survive restart, expire in each window and bound operation cardinality', () => {
  const store = createStore(':memory:');
  const hour = 3_600_000;
  let now = 0;
  let metrics = createPluginMetrics(store, () => now);
  for (let i=0;i<100;i++) metrics.record('sample','service:sample.op'+i, i<95?5:100, false);
  metrics.record('sample','service:sample./private/path',1,true);
  const initial = metrics.read('sample','1h');
  assert.equal(initial.operations.length,65);
  assert.equal(initial.calls,101);
  assert.equal(initial.p95Ms,5);
  assert.ok(!JSON.stringify(initial).includes('private'));
  metrics.close();
  now = hour;
  metrics = createPluginMetrics(store, () => now);
  assert.equal(metrics.read('sample','1h').calls,0);
  assert.equal(metrics.read('sample','24h').calls,101);
  now = 24*hour;
  assert.equal(metrics.read('sample','24h').calls,0);
  assert.equal(metrics.read('sample','7d').calls,101);
  now = 7*24*hour;
  assert.deepEqual(metrics.read('sample','7d'), {window:'7d',calls:0,errors:0,p95Ms:null,operations:[]});
  metrics.close();
  assert.deepEqual(store.list('core.plugin-metrics.plugin.sample'),[]);
  store.close();
});
