import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createMachineCredentials } from '../apps/server/src/machine-credentials.ts';

test('machine credentials bind an exact ID across restart and revoke only the selected machine', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-node-credentials-'));
  const file = join(dir, 'test.sqlite');
  let store = createStore(file);
  t.after(() => { store.close(); rmSync(dir, { recursive:true, force:true }); });
  let auth = createMachineCredentials(store);
  assert.throws(() => auth.issue('   '), { status:400 });
  const first = auth.issue('node-a');
  const second = auth.issue('node-b');
  assert.match(first.token, /^smmc_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(auth.resolve(first.token), 'node-a');
  assert.equal(auth.resolve('unrecognized'), undefined);
  assert.deepEqual(auth.list(), [{ id:'node-a' }, { id:'node-b' }]);

  const peer = createStore(file);
  try {
    const other = createMachineCredentials(peer);
    assert.throws(() => other.issue('node-a'), { status:409 });
    assert.equal(other.resolve(first.token), 'node-a');
  } finally { peer.close(); }

  store.close();
  assert.equal(readFileSync(file).includes(Buffer.from(first.token)), false);
  store = createStore(file);
  auth = createMachineCredentials(store);
  assert.equal(auth.resolve(first.token), 'node-a');
  assert.equal(auth.revoke('node-a'), true);
  assert.equal(auth.resolve(first.token), undefined);
  assert.equal(auth.revoke('node-a'), false);
  assert.equal(auth.resolve(second.token), 'node-b');
  assert.deepEqual(auth.list(), [{ id:'node-b' }]);
  const renewed = auth.issue('node-a');
  assert.notEqual(renewed.token, first.token);
  assert.equal(auth.resolve(first.token), undefined);
  assert.equal(auth.resolve(renewed.token), 'node-a');
});
