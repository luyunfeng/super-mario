import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Extension, ExtensionContext, Routine } from '../packages/plugin-sdk/src/index.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';

const routine: Routine = { name: 'Example', async run() { return 'ok'; } };
function extension(id: string, activate: Extension['activate'] = () => {}, dependencies?: string[]): Extension {
  return { id, name: id, capabilities: ['test'], dependencies, activate };
}
function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'super-mario-core-'));
  const store = createStore(join(dataDir, 'db', 'state.sqlite'));
  const events = createEventBus(store);
  const contributions = createContributions();
  const host = new PluginHost({ store, events, contributions, dataDir });
  t.after(async () => {
    try { await host.close(); } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
  return { dataDir, store, events, contributions, host };
}

test('SQLite creates directories, persists JSON and supports CRUD after reopen', t => {
  const { dataDir, store } = fixture(t);
  const value = { title: '持久化', nested: [null, true, 42] };
  store.put('todos', 'one', value);
  store.put('knowledge', 'one', { isolated: true });
  store.put('todos', 'two', { title: 'second' });
  assert.equal(store.get('todos', 'missing'), undefined);
  store.close();
  const reopened = createStore(join(dataDir, 'db', 'state.sqlite'));
  try {
    assert.deepEqual(reopened.get('todos', 'one'), value);
    assert.equal(reopened.list('todos').length, 2);
    reopened.put('todos', 'one', { title: 'updated' });
    assert.deepEqual(reopened.get('todos', 'one'), { title: 'updated' });
    assert.equal(reopened.remove('todos', 'one'), true);
    assert.equal(reopened.remove('todos', 'one'), false);
    assert.deepEqual(reopened.get('knowledge', 'one'), { isolated: true });
  } finally { reopened.close(); }
});

test('transactions commit return values and roll back writes, deletes and nested work', t => {
  const { store } = fixture(t);
  store.put('values', 'original', 1);
  assert.equal(store.transaction(() => { store.put('values', 'committed', 2); return 42; }), 42);
  assert.throws(() => store.transaction(() => {
    store.remove('values', 'original');
    store.transaction(() => store.put('values', 'inner', 3));
    throw new Error('abort');
  }), /abort/);
  assert.equal(store.get('values', 'original'), 1);
  assert.equal(store.get('values', 'inner'), undefined);
  store.transaction(() => {
    assert.throws(() => store.transaction(() => { store.put('values', 'inner', 3); throw new Error('inner'); }), /inner/);
    store.put('values', 'outer', 4);
  });
  assert.equal(store.get('values', 'outer'), 4);
  assert.equal(store.get('values', 'inner'), undefined);
});

test('transactions reject async callbacks and roll back Promise-returning callbacks', t => {
  const { store } = fixture(t);
  let invoked = false;
  assert.throws(() => store.transaction(async () => { invoked = true; }), /synchronous/);
  assert.equal(invoked, false);
  assert.throws(() => store.transaction(() => { store.put('values', 'bad', 1); return Promise.resolve(); }), /Promise/);
  assert.equal(store.get('values', 'bad'), undefined);
});

test('events isolate broken listeners and preserve numeric IDs across store reopen', t => {
  const { dataDir, store, events } = fixture(t);
  const delivered: number[] = [];
  events.subscribe(() => { throw new Error('broken observer'); });
  events.subscribe(async () => { throw new Error('broken async observer'); });
  const unsubscribe = events.subscribe(event => { delivered.push(event.id); event.data = 'mutated'; });
  for (let index = 0; index < 12; index++) events.publish('changed', { index });
  void unsubscribe();
  assert.equal(events.publish('changed', null).id, 13);
  assert.deepEqual(delivered, Array.from({ length: 12 }, (_, index) => index + 1));
  assert.deepEqual(events.since(10).map(event => event.id), [11, 12, 13]);
  assert.deepEqual(events.since(0)[0].data, { index: 0 });
  store.close();
  const reopened = createStore(join(dataDir, 'db', 'state.sqlite'));
  try {
    const bus = createEventBus(reopened);
    assert.equal(bus.publish('after-restart', true).id, 14);
    assert.deepEqual(bus.since(12).map(event => event.type), ['changed', 'after-restart']);
  } finally { reopened.close(); }
});

test('contributions reject collisions and old disposers cannot remove replacements', async () => {
  const contributions = createContributions();
  const dispose = contributions.add('routines', 'shared', routine);
  assert.throws(() => contributions.add('routines', 'shared', routine), /already registered/);
  await dispose();
  contributions.add('routines', 'shared', routine);
  await dispose();
  assert.equal(contributions.list('routines').length, 1);
});

test('enable/disable is idempotent and cleans both context APIs, listeners and deferred resources', async t => {
  const { host, events, contributions } = fixture(t);
  let activationCount = 0;
  let delivered = 0;
  let disposed = 0;
  let captured!: ExtensionContext;
  host.register(extension('one', context => {
    captured = context;
    activationCount++;
    context.contribute('routines', 'direct', routine);
    context.contributions.add('routines', 'scoped', routine);
    context.onEvent(() => { delivered++; });
    context.events.subscribe(() => { delivered++; });
    context.defer(() => { disposed++; });
  }));
  await host.start();
  await host.setEnabled('one', true);
  assert.equal(activationCount, 1);
  events.publish('test', null);
  assert.equal(delivered, 2);
  await Promise.all([host.setEnabled('one', false), host.setEnabled('one', false)]);
  assert.equal(disposed, 1);
  assert.deepEqual(contributions.list('routines'), []);
  events.publish('test', null);
  assert.equal(delivered, 2);
  assert.throws(() => captured.contributions.add('routines', 'late', routine), /closed/);
  await host.setEnabled('one', true);
  assert.equal(activationCount, 2);
  assert.equal(contributions.list('routines').length, 2);
  const info = host.list();
  info[0].capabilities.push('mutated');
  assert.deepEqual(host.list()[0].capabilities, ['test']);
  await host.close();
  await host.close();
  assert.equal(disposed, 2);
  assert.equal(contributions.list('routines').length, 0);
  await assert.rejects(host.start(), /closed/);
});

test('failed activation rolls back owned resources and cannot overwrite another plugin', async t => {
  const { host, events, contributions } = fixture(t);
  let delivered = 0;
  let disposed = 0;
  host.register(extension('owner', context => context.contribute('routines', 'shared', routine)));
  host.register(extension('broken', async context => {
    context.contribute('routines', 'temporary', routine);
    context.onEvent(() => { delivered++; });
    context.defer(() => { disposed++; });
    await Promise.resolve();
    context.contribute('routines', 'shared', routine);
  }));
  await host.start();
  assert.equal(host.list()[0].status, 'active');
  assert.equal(host.list()[1].status, 'failed');
  assert.match(host.list()[1].error!, /already registered/);
  assert.deepEqual(contributions.list('routines').map(entry => entry.id), ['shared']);
  events.publish('test', null);
  assert.equal(delivered, 0);
  assert.equal(disposed, 1);
  await host.setEnabled('broken', true);
  assert.equal(disposed, 2);
  assert.equal(host.list()[1].status, 'failed');
});

test('dependencies start in order, stop dependents first and restore only enabled dependents', async t => {
  const { host } = fixture(t);
  const log: string[] = [];
  for (const [id, dependencies] of [['leaf', ['middle']], ['middle', ['base']], ['base', []]] as const) {
    host.register(extension(id, context => {
      log.push(`start:${id}`);
      context.defer(() => { log.push(`stop:${id}`); });
    }, [...dependencies]));
  }
  await host.start();
  assert.deepEqual(log, ['start:base', 'start:middle', 'start:leaf']);
  await host.setEnabled('base', false);
  assert.deepEqual(log.slice(3), ['stop:leaf', 'stop:middle', 'stop:base']);
  assert.deepEqual(host.list().map(info => [info.enabled, info.status]), [[true, 'waiting'], [true, 'waiting'], [false, 'disabled']]);
  await host.setEnabled('leaf', false);
  await host.setEnabled('base', true);
  assert.deepEqual(log.slice(6), ['start:base', 'start:middle']);
  assert.equal(host.list()[0].status, 'disabled');
});

test('missing/failed dependencies wait, registration rejects cycles, and persisted settings survive host recreation', async t => {
  const { host, store, events, contributions, dataDir } = fixture(t);
  host.register(extension('dependent', () => {}, ['missing']));
  await host.start();
  assert.equal(host.list()[0].status, 'waiting');
  assert.match(host.list()[0].error!, /missing/);
  assert.throws(() => host.register(extension('missing', () => {}, ['dependent'])), /cycle/);
  host.register(extension('missing', () => { throw new Error('unavailable'); }));
  await host.start();
  assert.equal(host.list()[0].status, 'waiting');
  assert.equal(host.list()[1].status, 'failed');
  assert.throws(() => host.register(extension('self', () => {}, ['self'])), /cycle/);
  assert.throws(() => host.register(extension('dependent')), /already registered/);
  await assert.rejects(host.setEnabled('unknown', false), /Unknown plugin/);
  await host.setEnabled('dependent', false);
  await host.close();
  const replacement = new PluginHost({ store, events, contributions, dataDir });
  replacement.register(extension('dependent'));
  await replacement.start();
  assert.equal(replacement.list()[0].status, 'disabled');
  await replacement.close();
});

test('a late dependency lets waiting plugins start on the next reconciliation', async t => {
  const { host } = fixture(t);
  host.register(extension('dependent', () => {}, ['late']));
  await host.start();
  host.register(extension('late'));
  await host.setEnabled('late', true);
  assert.deepEqual(host.list().map(info => info.status), ['active', 'active']);
});

test('cleanup continues after disposer errors and reports failure', async t => {
  const { host, contributions, events } = fixture(t);
  let delivered = 0;
  host.register(extension('cleanup', context => {
    context.contribute('routines', 'temporary', routine);
    context.onEvent(() => { delivered++; });
    context.defer(() => { throw new Error('cleanup broke'); });
  }));
  await host.start();
  await assert.rejects(host.setEnabled('cleanup', false), /cleanup failed/);
  assert.equal(host.list()[0].status, 'failed');
  assert.equal(contributions.list('routines').length, 0);
  events.publish('test', null);
  assert.equal(delivered, 0);
});

test('an explicit retry recovers failed activation and its waiting dependents', async t => {
  const { host, contributions, events } = fixture(t);
  let shouldFail = true;
  let delivered = 0;
  let disposed = 0;
  host.register(extension('dependent', context => {
    context.contribute('routines', 'dependent', routine);
  }, ['base']));
  host.register(extension('base', async context => {
    context.contribute('routines', 'base', routine);
    context.onEvent(() => { delivered++; });
    context.defer(async () => { await Promise.resolve(); disposed++; });
    await Promise.resolve();
    if (shouldFail) throw new Error('not ready');
  }));
  await host.start();
  assert.deepEqual(host.list().map(info => info.status), ['waiting', 'failed']);
  assert.deepEqual(contributions.list('routines'), []);
  events.publish('before-retry', null);
  assert.equal(delivered, 0);
  assert.equal(disposed, 1);
  shouldFail = false;
  await host.setEnabled('base', true);
  assert.deepEqual(host.list().map(info => info.status), ['active', 'active']);
  events.publish('after-retry', null);
  assert.equal(delivered, 1);
  await host.close();
  assert.equal(disposed, 2);
  assert.deepEqual(contributions.list('routines'), []);
});
