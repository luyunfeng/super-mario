import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/core/src/store.ts';
import { createAdminOverview } from '../apps/server/src/admin-overview.ts';

test('explicit public origin persists independently of the current listener and validates raw URL parts', t => {
  const store = createStore(':memory:');
  t.after(()=>store.close());
  let port = 8123;
  let listenerReads = 0;
  const make = () => createAdminOverview({
    store, startedAt:'2026-11-24T00:00:00Z',version:'test',demo:true,
    address:()=>{listenerReads++;return {family:'IPv4',address:'127.0.0.1',port};},machines:()=>[],plugins:()=>[],devices:()=>[],
  });
  const admin = make();
  assert.equal(admin.network().publicOrigin,'');
  for(const origin of ['http://localhost:8123','http://127.0.0.1','http://[::1]:8124'])
    assert.equal(admin.setPublicOrigin(origin).publicOrigin,origin);
  const boundary = 'https://' + 'a.'.repeat(251) + 'ab';
  assert.equal(boundary.length,512);
  assert.equal(admin.setPublicOrigin(boundary).publicOrigin,boundary);
  const international = 'https://' + '界.'.repeat(100) + 'invalid';
  assert.ok(international.length < 512 && new URL(international).origin.length > 512);
  for(const large of [boundary+'/',international]) assert.throws(()=>admin.setPublicOrigin(large),{status:400});
  const reads = listenerReads;
  assert.equal(admin.publicOrigin(),boundary);
  assert.equal(listenerReads,reads);
  assert.equal(admin.setPublicOrigin('HTTPS://EXAMPLE.INVALID:443/').publicOrigin,'https://example.invalid');
  for(const value of [null,' ','http://remote.invalid','ftp://localhost','https://user:password@example.invalid',
    'https://@example.invalid','https://example.invalid/path','https://example.invalid/?','https://example.invalid/#',
    'https://example.invalid/a/..','https://example.invalid\\path','\nhttps://example.invalid','http://127.1',
    'http://localhost.example.invalid','https://example.invalid\u0000'])
    assert.throws(()=>admin.setPublicOrigin(value),{status:400});
  port++;
  const reopened = make();
  assert.equal(reopened.network().publicOrigin,'https://example.invalid');
  assert.equal(reopened.network().listen,'127.0.0.1:8124');
  assert.deepEqual(reopened.network().endpoints,reopened.read().endpoints);
  assert.equal(reopened.setPublicOrigin('').publicOrigin,'');
  assert.equal(admin.network().publicOrigin,'');
});
