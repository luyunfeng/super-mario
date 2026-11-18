import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createInteractions, InteractionError, type Card, type Decision } from '../packages/core/src/interactions.ts';

const input = { kind: 'question' as const, title: '继续吗？', body: '说明', runId: 'run-1', projectId: 'project-1', executorId: 'executor-1', cwd: '/tmp' };
const user: Decision = { handler: 'user', layer: 'default' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function status(code: number) { return (error: unknown) => error instanceof InteractionError && error.status === code; }
async function flush() { await new Promise<void>(resolve => setImmediate(resolve)); }
function fixture(t: { after(fn: () => Promise<void>): void }, options: Partial<Parameters<typeof createInteractions>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'super-mario-interactions-'));
  const path = join(dir, 'data.sqlite');
  const store = createStore(path);
  const events = createEventBus(store);
  const deliveries: string[] = [];
  const service = createInteractions({ store, events, decide: () => user, answer: async (_, value) => { deliveries.push(value); }, ...options });
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const read = (id: string) => store.get<Card>('interactions', id)!;
  return { store, events, service, deliveries, path, read };
}

test('open persists synchronously, snapshots inputs, preserves metadata and defaults approvals to user', async t => {
  const f = fixture(t);
  for (const kind of ['question', 'permission', 'plan', 'review'] as const) {
    const request = { ...input, kind };
    const before = Date.now();
    const card = f.service.open(request);
    assert.deepEqual(f.read(card.id), card);
    assert.equal(card.handler, 'user');
    assert.equal(card.mode, undefined);
    assert.equal(card.status, 'open');
    assert.ok(Date.parse(card.expiresAt) >= before + 15 * 60_000);
    assert.ok(Date.parse(card.expiresAt) <= Date.now() + 15 * 60_000);
    request.title = 'mutated'; card.title = 'also mutated';
    assert.equal(f.read(card.id).title, input.title);
    assert.equal(f.read(card.id).cwd, '/tmp');
  }
  await flush();
  assert.deepEqual(f.deliveries, []);
  assert.equal(f.events.since(0).length, 4);
});

test('SQLite claim wins across service instances before I/O; stale/duplicate answers never deliver', async t => {
  const gate = deferred<void>();
  let calls = 0;
  const f = fixture(t, { answer: async (card, value) => {
    calls++;
    assert.equal(f.read(card.id).status, 'answered');
    assert.equal(f.read(card.id).delivery, 'unknown');
    assert.equal(value, 'first');
    card.title = 'callback mutation';
    await gate.promise;
  } });
  const secondStore = createStore(f.path);
  const other = createInteractions({ store: secondStore, events: createEventBus(secondStore), decide: () => user,
    answer: async () => { calls++; } });
  try {
    const card = f.service.open(input);
    assert.throws(() => f.service.answer(card.id, 2, 'stale'), status(409));
    const pending = f.service.answer(card.id, card.version, 'first');
    assert.throws(() => other.answer(card.id, card.version, 'second'), status(409));
    assert.throws(() => other.withdraw(card.id, card.version), status(409));
    await Promise.resolve();
    assert.equal(calls, 1);
    gate.resolve();
    const result = await pending;
    assert.equal(result.delivery, 'confirmed');
    assert.equal(result.answeredBy, 'user');
    assert.equal(result.title, input.title);
    assert.throws(() => other.answer(card.id, result.version, 'retry'), status(409));
  } finally { gate.resolve(); await other.close(); secondStore.close(); }
});

test('rules require explicit auto, suggest never delivers, provenance is retained', async t => {
  for (const mode of [undefined, 'suggest', 'auto'] as const) {
    const f = fixture(t, { decide: () => ({ handler: 'rules', mode, layer: 'project', ruleId: 'rule-1', answer: 'yes' }) });
    const card = f.service.open(input);
    assert.equal(card.status, 'open');
    assert.equal(card.answer, undefined);
    await flush();
    const result = f.read(card.id);
    assert.equal(result.layer, 'project');
    assert.equal(result.ruleId, 'rule-1');
    assert.equal(result.status, mode === 'auto' ? 'answered' : 'open');
    if (mode === 'auto') {
      assert.equal(result.delivery, 'confirmed');
      assert.equal(result.answeredBy, 'rules');
      assert.deepEqual(f.deliveries, ['yes']);
    } else {
      assert.equal(result.suggestion, 'yes');
      assert.deepEqual(f.deliveries, []);
    }
  }
});

test('permission and plan with omitted mode cannot bypass approval even with rules or agents', async t => {
  for (const kind of ['permission', 'plan'] as const) {
    for (const handler of ['rules', 'supervisor', 'main_agent', 'user'] as const) {
      const f = fixture(t, { decide: () => ({ handler, layer: 'default', answer: 'approve' }), askAgent: async () => 'approve' });
      const card = f.service.open({ ...input, kind });
      await flush();
      assert.equal(f.read(card.id).status, 'open');
      assert.deepEqual(f.deliveries, []);
    }
  }
});

test('agents receive snapshots and explicit auto delivers once; suggestions require user acceptance', async t => {
  for (const handler of ['main_agent', 'supervisor'] as const) {
    for (const mode of ['auto', 'suggest'] as const) {
      const f = fixture(t, { decide: () => ({ handler, mode, layer: 'task' }), askAgent: async (actual, card) => {
        assert.equal(actual, handler);
        card.title = 'agent mutation';
        return 'answer from agent';
      } });
      const card = f.service.open(input);
      await flush();
      const result = f.read(card.id);
      assert.equal(result.title, input.title);
      if (mode === 'auto') {
        assert.equal(result.answeredBy, handler);
        assert.equal(result.delivery, 'confirmed');
      } else {
        assert.equal(result.suggestion, 'answer from agent');
        assert.deepEqual(f.deliveries, []);
        await f.service.answer(result.id, result.version, 'user choice');
        assert.deepEqual(f.deliveries, ['user choice']);
      }
    }
  }
});

test('deadline overrides default; expiry is terminal and answer enforces time without a tick', async t => {
  const deadlineAt = new Date(Date.now() - 1000).toISOString();
  const f = fixture(t, { decide: () => ({ ...user, deadlineAt }) });
  const first = f.service.open(input);
  assert.equal(first.expiresAt, deadlineAt);
  assert.throws(() => f.service.answer(first.id, first.version, 'late'), status(409));
  assert.equal(f.read(first.id).status, 'expired');
  const second = f.service.open(input);
  assert.deepEqual(f.service.expireTick().map(card => card.id), [second.id]);
  assert.deepEqual(f.service.expireTick(), []);
  assert.throws(() => f.service.answer(second.id, second.version, 'late'), status(409));
  assert.deepEqual(f.deliveries, []);
});

test('late agent answers and suggestions cannot overwrite user decisions, withdrawal or expiration', async t => {
  for (const mode of ['auto', 'suggest'] as const) {
    for (const action of ['answer', 'withdraw', 'expire'] as const) {
      const gate = deferred<string>();
      const f = fixture(t, { decide: () => ({ handler: 'supervisor', mode, layer: 'global' }), askAgent: () => gate.promise });
      const card = f.service.open(input);
      await Promise.resolve();
      if (action === 'answer') await f.service.answer(card.id, card.version, 'user first');
      if (action === 'withdraw') f.service.withdraw(card.id, card.version);
      if (action === 'expire') f.service.expireTick(Date.parse(card.expiresAt));
      const snapshot = f.read(card.id);
      gate.resolve('late agent');
      await flush();
      assert.deepEqual(f.read(card.id), snapshot);
      assert.deepEqual(f.deliveries, action === 'answer' ? ['user first'] : []);
    }
  }
});

test('agent result reaching deadline expires without applying its suggestion', async t => {
  const gate = deferred<string>();
  const f = fixture(t, { decide: () => ({ handler: 'supervisor', mode: 'suggest', layer: 'default' }), askAgent: () => gate.promise });
  const card = f.service.open(input);
  await Promise.resolve();
  // Real SQLite state simulates elapsed time without a timer or sleeping test.
  f.store.put('interactions', card.id, { ...card, expiresAt: new Date(0).toISOString() });
  gate.resolve('late');
  await flush();
  assert.equal(f.read(card.id).status, 'expired');
  assert.equal(f.read(card.id).suggestion, undefined);
});

test('delivery failures and uncertainty are persisted, not success, and never replay on restart', async t => {
  for (const error of [new Error('failed'), Object.assign(new Error('uncertain'), { deliveryunknown: true }),
    { delivery: 'unknown', message: 'remote timeout' }]) {
    const f = fixture(t, { answer: async () => { throw error; } });
    const card = f.service.open(input);
    const result = await f.service.answer(card.id, card.version, 'choice');
    assert.equal(result.status, 'answered');
    assert.equal(result.delivery, error instanceof Error && error.message === 'failed' ? 'failed' : 'unknown');
    assert.ok(result.error);
    await f.service.close();
    const restored = createInteractions({ store: f.store, events: f.events, decide: () => user, answer: async () => assert.fail('must not replay') });
    assert.deepEqual(restored.list()[0], result);
    assert.throws(() => restored.answer(result.id, result.version, 'retry'), status(409));
    await restored.close();
  }
});

test('agent errors, unavailable agent and invalid output stay open with an explicit error', async t => {
  for (const askAgent of [undefined, async () => { throw new Error('model unavailable'); }, async () => '']) {
    const f = fixture(t, { decide: () => ({ handler: 'main_agent', mode: 'auto', layer: 'default' }), askAgent });
    const card = f.service.open(input);
    await flush();
    const result = f.read(card.id);
    assert.equal(result.status, 'open');
    assert.ok(result.error);
    assert.equal(result.delivery, undefined);
    assert.deepEqual(f.deliveries, []);
    await f.service.answer(card.id, result.version, 'manual fallback');
  }
});

test('close blocks new actions, waits for slow agent and claimed delivery, discards agent results', async t => {
  const agent = deferred<string>();
  const delivery = deferred<void>();
  const f = fixture(t, { decide: () => ({ handler: 'supervisor', mode: 'auto', layer: 'default' }),
    askAgent: () => agent.promise, answer: () => delivery.promise });
  const slow = f.service.open(input);
  await Promise.resolve();
  const manual = f.service.open(input);
  const pending = f.service.answer(manual.id, manual.version, 'manual');
  let finished = false;
  const closing = f.service.close().then(() => { finished = true; });
  const closingAgain = f.service.close();
  await Promise.resolve();
  assert.equal(finished, false);
  assert.throws(() => f.service.open(input), status(503));
  assert.throws(() => f.service.answer(slow.id, slow.version, 'closed'), status(503));
  assert.throws(() => f.service.withdraw(slow.id, slow.version), status(503));
  assert.throws(() => f.service.expireTick(), status(503));
  delivery.resolve();
  await pending;
  assert.equal(finished, false);
  agent.resolve('late automatic');
  await Promise.all([closing, closingAgain]);
  assert.equal(f.read(slow.id).status, 'open');
  assert.equal(f.read(slow.id).suggestion, undefined);
  assert.equal(f.read(manual.id).delivery, 'confirmed');
  f.store.close();
  await flush(); // No continuation may access the now closed SQLite store.
});

test('validation rejects malformed inputs and decisions without writes or delivery', async t => {
  const f = fixture(t);
  for (const value of [null, { ...input, kind: 'other' }, { ...input, title: '' }, { ...input, body: 1 }, { ...input, cwd: '' }]) {
    assert.throws(() => f.service.open(value as never), status(400));
  }
  assert.deepEqual(f.service.list(), []);
  assert.throws(() => f.service.answer('missing', 0, 'yes'), status(400));
  assert.throws(() => f.service.answer('missing', 1, 'yes'), status(404));
  const card = f.service.open(input);
  assert.throws(() => f.service.answer(card.id, card.version, ''), status(400));
  assert.equal(f.read(card.id).status, 'open');
  for (const decision of [{ ...user, deadlineAt: 'bad' }, { ...user, mode: 'invalid' }, { ...user, handler: 'other' },
    { ...user, layer: 'other' }, { ...user, answer: '' }]) {
    const invalid = fixture(t, { decide: () => decision as Decision });
    assert.throws(() => invalid.service.open(input), status(400));
    assert.deepEqual(invalid.service.list(), []);
  }
});
