import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createEffects, EffectError } from '../packages/core/src/effects.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createStore } from '../packages/core/src/store.ts';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-effects-acceptance-'));
  const path = join(dir, 'effects.sqlite');
  let store = createStore(path);
  let effects = createEffects({ store, events: createEventBus(store) });
  t.after(async () => { await effects.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    get store() { return store; }, get effects() { return effects; },
    async restart() {
      await effects.close(); store.close();
      store = createStore(path);
      effects = createEffects({ store, events: createEventBus(store) });
    },
  };
}
function delivery(expected: 'no' | 'unknown') {
  return (error: unknown) => error instanceof EffectError && error.status === 409 && error.delivery === expected;
}
const action = { key: 'reply:one', kind: 'send', target: 'local-fake', summary: 'send reply', content: { text: 'one' } };

test('SQLite Effects shares concurrent identical work, rejects conflicting content and restores confirmed result', async t => {
  const f = await fixture(t);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = async () => { calls++; await gate; return { receipt: 'local-only' }; };
  const jobs = Array.from({ length: 12 }, () => f.effects.perform({ ...action, run }));
  try {
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(f.store.get<{ status: string }>('effects', action.key)?.status, 'sent');
    await assert.rejects(f.effects.perform({ ...action, content: { text: 'different' }, run }), delivery('no'));
  } finally { release(); }
  assert.deepEqual(await Promise.all(jobs), Array.from({ length: 12 }, () => ({ receipt: 'local-only' })));
  await f.restart();
  assert.deepEqual(await f.effects.perform({ ...action, run }), { receipt: 'local-only' });
  assert.equal(calls, 1);
  assert.equal(f.effects.list().length, 1);
});

test('SQLite Effects turns an interrupted persisted claim unknown on restart and never replays it', async t => {
  const f = await fixture(t);
  await f.effects.perform({ ...action, run: async () => ({ receipt: 'fixture' }) });
  const record = f.effects.list()[0];
  // Crash boundary: durable claim exists, but there is no durable external receipt.
  f.store.put('effects', action.key, { ...record, status: 'sent', result: undefined });
  await f.restart();
  let calls = 0;
  const run = async () => { calls++; return null; };
  assert.equal(f.effects.list()[0].status, 'unknown');
  await assert.rejects(f.effects.perform({ ...action, run }), delivery('unknown'));
  await f.restart();
  await assert.rejects(f.effects.perform({ ...action, run }), delivery('unknown'));
  assert.equal(calls, 0);
});

test('SQLite Effects distinguishes definite failure from uncertain delivery and retries neither after restart', async t => {
  const f = await fixture(t);
  let calls = 0;
  for (const definite of [true, false]) {
    const input = { ...action, key: `failure:${definite}`, run: async () => {
      calls++;
      throw definite ? Object.assign(new Error('rejected before send'), { delivery: 'no' }) : new Error('lost receipt');
    } };
    await assert.rejects(f.effects.perform(input), delivery(definite ? 'no' : 'unknown'));
  }
  assert.deepEqual(f.effects.list().map(item => item.status), ['failed', 'unknown']);
  await f.restart();
  for (const definite of [true, false]) {
    await assert.rejects(f.effects.perform({ ...action, key: `failure:${definite}`, run: async () => { calls++; return null; } }), delivery(definite ? 'no' : 'unknown'));
  }
  assert.equal(calls, 2);
});

test('Effects close drains accepted work and prevents new external actions immediately', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const run = async () => { calls++; await gate; return 'receipt'; };
  const job = f.effects.perform({ ...action, run });
  let drained = false;
  const closing = f.effects.close().then(() => { drained = true; });
  try {
    await Promise.resolve();
    assert.equal(drained, false);
    await assert.rejects(f.effects.perform({ ...action, key: 'new-after-close', run }), delivery('no'));
    assert.equal(f.effects.list().length, 1);
  } finally { release(); }
  assert.equal(await job, 'receipt');
  await closing;
  await f.effects.close();
  assert.equal(drained, true);
  assert.equal(calls, 1);
  assert.equal(f.effects.list()[0].status, 'confirmed');
});
