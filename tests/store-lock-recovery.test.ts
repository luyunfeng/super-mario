import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createEventbox } from '../packages/core/src/eventbox.ts';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'super-mario-store-lock-'));
  const path = join(dir, 'synthetic.sqlite');
  const store = createStore(path);
  store.put('synthetic', 'seed', 'seed');
  const reader = new DatabaseSync(path);
  t.after(() => {
    reader.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function holdReader() {
    // DELETE journal + a real SHARED lock forces the writer's commit to fail.
    assert.equal(reader.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM documents').all();
    assert.equal(reader.isTransaction, true);
  }
  return { path, store, reader, holdReader };
}

test('reader-blocked root commit rolls back and subsequent standalone put survives reopen', t => {
  // Before the fix: SQLITE_BUSY was thrown, put(after) succeeded in memory,
  // but reopen reported seed=seed, failed=undefined, after=undefined (1/1 failed).
  const { path, store, reader, holdReader } = fixture(t);
  holdReader();
  let callbacks = 0;
  assert.throws(() => store.transaction(() => {
    callbacks++;
    store.put('synthetic', 'failed', 'must-not-persist');
  }), (error: unknown) => {
    assert.equal((error as { errcode?: number }).errcode, 5); // SQLITE_BUSY
    return true;
  });
  assert.equal(callbacks, 1);
  reader.exec('ROLLBACK');
  store.put('synthetic', 'after', 'must-persist');
  assert.equal(store.get('synthetic', 'after'), 'must-persist');
  store.close();
  const reopened = createStore(path);
  try {
    const after = reopened.get('synthetic', 'after');
    t.diagnostic(`synthetic recovery: seed=${reopened.get('synthetic', 'seed')}, failed=${reopened.get('synthetic', 'failed')}, after=${after}`);
    assert.equal(after, 'must-persist');
    assert.equal(reopened.get('synthetic', 'failed'), undefined);
    assert.equal(reopened.get('synthetic', 'seed'), 'seed');
    assert.equal(reopened.transaction(() => {
      reopened.put('synthetic', 'next-transaction', 'committed');
      return 42;
    }), 42);
  } finally { reopened.close(); }
});

test('nested rollback preserves outer writes and root rollback discards successful nested writes', t => {
  const { path, store } = fixture(t);
  assert.equal(store.transaction(() => {
    store.put('synthetic', 'outer-before', 1);
    assert.throws(() => store.transaction(() => {
      store.remove('synthetic', 'seed');
      store.put('synthetic', 'nested-failed', 2);
      throw new Error('synthetic nested failure');
    }), /synthetic nested failure/);
    store.transaction(() => store.put('synthetic', 'nested-ok', 3));
    store.put('synthetic', 'outer-after', 4);
    return 42;
  }), 42);
  assert.throws(() => store.transaction(() => {
    store.transaction(() => store.put('synthetic', 'root-failed', 5));
    throw new Error('synthetic root failure');
  }), /synthetic root failure/);
  store.close();
  const reopened = createStore(path);
  try {
    assert.deepEqual(reopened.list('synthetic'), ['seed', 1, 3, 4]);
  } finally { reopened.close(); }
});

test('failed locked root also discards nested success and recovers transactions and deletes', t => {
  const { path, store, reader, holdReader } = fixture(t);
  holdReader();
  assert.throws(() => store.transaction(() => {
    store.remove('synthetic', 'seed');
    store.transaction(() => store.put('synthetic', 'nested-failed', 1));
  }), { errcode: 5 });
  reader.exec('ROLLBACK');
  assert.equal(store.get('synthetic', 'seed'), 'seed');
  assert.equal(store.get('synthetic', 'nested-failed'), undefined);
  store.transaction(() => store.transaction(() => store.put('synthetic', 'recovered', 2)));
  assert.equal(store.remove('synthetic', 'seed'), true);
  store.close();
  const reopened = createStore(path);
  try { assert.deepEqual(reopened.list('synthetic'), [2]); }
  finally { reopened.close(); }
});

test('async and Promise callbacks stay rejected without committing root or nested writes', t => {
  const { store } = fixture(t);
  let invoked = false;
  assert.throws(() => store.transaction(async () => { invoked = true; }), /synchronous/);
  assert.equal(invoked, false);
  assert.throws(() => store.transaction(() => {
    store.put('synthetic', 'promise-root', 1);
    return Promise.reject(new Error('synthetic rejection'));
  }), /Promise/);
  store.transaction(() => {
    store.put('synthetic', 'outer', 2);
    assert.throws(() => store.transaction(() => {
      store.put('synthetic', 'promise-nested', 3);
      return Promise.resolve();
    }), /Promise/);
  });
  assert.deepEqual(store.list('synthetic'), ['seed', 2]);
});

test('reader-blocked event append rolls back event and cursor without notifying observers', t => {
  const { path, store, reader, holdReader } = fixture(t);
  const events = createEventBus(store, { now: () => 0 });
  const delivered: number[] = [];
  events.subscribe(event => { delivered.push(event.id); });
  holdReader();
  assert.throws(() => events.publish('synthetic.failed', null), { errcode: 5 });
  reader.exec('ROLLBACK');
  assert.deepEqual(events.since(0), []);
  assert.equal(store.get('core.event-metadata', 'lastId'), undefined);
  assert.deepEqual(delivered, []);
  assert.equal(events.publish('synthetic.recovered', null).id, 1);
  assert.deepEqual(delivered, [1]);
  store.close();
  const reopened = createStore(path);
  try {
    assert.deepEqual(createEventBus(reopened).since(0).map(event => event.type), ['synthetic.recovered']);
    assert.equal(reopened.get('core.event-metadata', 'lastId'), 1);
  } finally { reopened.close(); }
});

test('reader-blocked eventbox append atomically rolls back event, sequence and deliveries', async t => {
  const { path, store, reader, holdReader } = fixture(t);
  const box = createEventbox({ store, events: createEventBus(store), now: () => 0 });
  try {
    box.subscribe('synthetic', {
      name: 'subscriber', types: [{ type: 'synthetic.changed', version: 1 }],
      effects: 'none', handler: () => ({ status: 'done' }),
    });
    const input = { type: 'synthetic.changed', typeVersion: 1, sourceId: 'synthetic-id', data: null };
    holdReader();
    assert.throws(() => box.publish('synthetic', input), { errcode: 5 });
    reader.exec('ROLLBACK');
    assert.deepEqual(box.events(), []);
    assert.deepEqual(box.deliveries(), []);
    assert.equal(store.get('eventbox.metadata', 'lastSeq'), undefined);
    assert.equal(box.publish('synthetic', input).duplicate, false);
    assert.equal(box.events()[0].seq, 1);
    assert.equal(box.deliveries().length, 1);
  } finally { await box.close(); }
  store.close();
  const reopened = createStore(path);
  try {
    assert.equal(reopened.list('eventbox.events').length, 1);
    assert.equal(reopened.list('eventbox.deliveries').length, 1);
    assert.equal(reopened.get('eventbox.metadata', 'lastSeq'), 1);
  } finally { reopened.close(); }
});

for (const nested of [false, true]) {
  test(`${nested ? 'nested' : 'root'} rollback cleanup failure rejects all further writes even if caught`, t => {
    const { path, store } = fixture(t);
    const originalExec = DatabaseSync.prototype.exec;
    const rollbackFailure = new Error('synthetic rollback failure');
    const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      if (sql === (nested ? 'ROLLBACK TO SAVEPOINT transaction_2' : 'ROLLBACK')) throw rollbackFailure;
      return originalExec.call(this, sql);
    });
    let callbackCalls = 0;
    const fail = () => {
      store.put('synthetic', 'uncommitted', 1);
      throw new Error('synthetic callback failure');
    };
    const checkCleanup = (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /cleanup failed/);
      assert.equal(error.errors[1], rollbackFailure);
      return true;
    };
    try {
      assert.throws(() => store.transaction(() => {
        if (nested) {
          assert.throws(() => store.transaction(fail), checkCleanup);
          assert.throws(() => store.put('synthetic', 'swallowed', 2), /cleanup failed/);
          // Returning normally must not let the outer transaction commit.
          return;
        }
        fail();
      }), checkCleanup);
      assert.throws(() => store.put('synthetic', 'after', 3), /cleanup failed/);
      assert.throws(() => store.remove('synthetic', 'seed'), /cleanup failed/);
      assert.throws(() => store.transaction(() => { callbackCalls++; }), /cleanup failed/);
      assert.equal(callbackCalls, 0);
    } finally { mock.mock.restore(); }
    store.close();
    const reopened = createStore(path);
    try {
      assert.deepEqual(reopened.list('synthetic'), ['seed']);
      reopened.put('synthetic', 'healthy', 4);
    } finally { reopened.close(); }
  });
}
