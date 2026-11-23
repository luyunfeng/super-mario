import assert from 'node:assert/strict';
import { createTopicTurns } from '../apps/server/src/feishu-topic-turns.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTopicAnchors } from '../apps/server/src/feishu-topic-anchors.ts';
import { createStore } from '../packages/core/src/store.ts';

const a = { binding:'owner-binding', grant:'enrollment', chatId:'group', threadId:'thread' };
test('锚点按配对、登记、群和话题隔离；旧发言或旧撤回重放不会改写后来发言', async t => {
  const dir = await mkdtemp(join(tmpdir(),'topic-anchor-')), db = join(dir,'test.sqlite');
  let store = createStore(db), service = createTopicAnchors(store);
  t.after(async () => { store.close(); await rm(dir,{recursive:true,force:true}); });
  assert.equal(service.lookup(a),undefined);
  service.remember(a,'m1',false); service.remember(a,'m2',true);
  store.close(); store = createStore(db); service = createTopicAnchors(store);
  service.remember(a,'m1',true); service.remember(a,'m2',false);
  service.forget(a,'m1');
  assert.deepEqual(service.lookup(a),{messageId:'m2',mentionedSelf:true});
  for (const field of ['grant','threadId','chatId','binding']) {
    const other = { ...a,[field]:'other' };
    assert.equal(service.lookup(other),undefined);
    service.remember(other,'other-' + field,false);
    assert.equal(service.lookup(other)?.messageId,'other-' + field);
  }
  service.forget(a,'m2'); service.remember(a,'m2',false);
  assert.equal(service.lookup(a),null);
  store.close(); store = createStore(db); service = createTopicAnchors(store);
  assert.equal(service.lookup(a),null);
  service.remember(a,'m3',false); assert.deepEqual(service.lookup(a),{messageId:'m3',mentionedSelf:false});
});

test('显式失效覆盖旧开题回退，撤回先于入站时不复活，事务回滚不消费消息', t => {
  const store = createStore(':memory:'); t.after(() => store.close()); const service = createTopicAnchors(store);
  service.forget(a,'legacy');
  assert.equal(service.lookup(a),null); service.remember(a,'legacy',true); assert.equal(service.lookup(a),null);
  assert.throws(() => store.transaction(() => { service.remember(a,'new',true); throw Error('rollback'); }));
  assert.equal(service.lookup(a),null); service.remember(a,'new',false);
  service.forget(a,'late'); service.remember(a,'late',true);
  assert.deepEqual(service.lookup(a),{messageId:'new',mentionedSelf:false});
  assert.equal(service.lookup({...a,threadId:''}),null);
});

test('每份配对只保留最近200个话题，满30天后的重放不能延长寿命或触发旧开题回退', t => {
  t.mock.timers.enable({ apis:['Date'], now:1000 });
  const store = createStore(':memory:'); t.after(() => store.close()); const service = createTopicAnchors(store);
  const audience = (i:number) => ({...a,threadId:'t-' + i});
  const other = {...a,binding:'other-binding'};
  service.remember(other,'separate',false);
  for (let i=0;i<200;i++) service.remember(audience(i),'om-' + i,true);
  service.remember(audience(0),'replacement',false);
  service.remember(audience(200),'om-200',true);
  assert.equal(service.lookup(audience(1)),null); assert.equal(service.lookup(audience(0))?.messageId,'replacement');
  service.remember(audience(1),'om-1',true); assert.equal(service.lookup(audience(1)),null);
  assert.equal(service.lookup(other)?.messageId,'separate');
  const limit = 30 * 86_400_000; t.mock.timers.tick(limit);
  assert.equal(service.lookup(audience(200))?.messageId,'om-200');
  service.remember(audience(200),'om-200',false); t.mock.timers.tick(1);
  assert.equal(service.lookup(audience(200)),null); assert.equal(service.lookup(other),null);
  service.remember(audience(200),'next',false); assert.equal(service.lookup(audience(200))?.messageId,'next');
});

test('上线前话题已消费消息重放，不覆盖上线后发言和点名状态', t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  const turns = createTopicTurns(store, () => ({id:'todo'})), anchors = createTopicAnchors(store);
  turns.accept({...a, root:true, command:false, words:'合成开题',messageId:'legacy-open'});
  anchors.remember(a,'legacy-open',true);
  assert.equal(anchors.lookup(a),undefined);
  anchors.remember(a,'fresh',false); anchors.remember(a,'legacy-open',true);
  assert.deepEqual(anchors.lookup(a),{ messageId:'fresh',mentionedSelf:false });
  const enrolledAgain = {...a,grant:'new-grant'};
  anchors.remember(enrolledAgain,'legacy-open',true); assert.equal(anchors.lookup(enrolledAgain),undefined);
});
