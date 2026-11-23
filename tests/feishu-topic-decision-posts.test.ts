import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createTopicDecisionPosts } from '../apps/server/src/feishu-topic-decision-posts.ts';
import { createStore } from '../packages/core/src/store.ts';

test('安静待办首个事件等三秒，按待办合并且一分钟内最多一次；只报有效决定数', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const store = createStore(':memory:'); t.after(() => store.close());
  const withdrawn = new Set<string>(), sends: string[][] = [];
  const service = createTopicDecisionPosts(store, { resolve: todo => ({ inputId:'anchor-' + todo }),
    isCurrent: (_todo, id) => !withdrawn.has(id),
    async send(todo, input, text, key, guard) { guard(); sends.push([todo, input, text, key]); return 'ack-' + sends.length; } });
  service.recover();
  service.changed('a', '1'); service.changed('b', 'b1');
  t.mock.timers.tick(2999);
  service.changed('a', '1'); service.changed('a', '2');
  assert.equal(sends.length,0);
  t.mock.timers.tick(1); await setImmediate();
  assert.deepEqual(sends.map(s => s.slice(0,3)), [['a','anchor-a','待办新增 2 项决定。'], ['b','anchor-b','待办新增 1 项决定。']]);
  service.changed('a','1');
  for (let n = 0; n < 61; n++) service.changed('a','new-' + n);
  withdrawn.add('new-7'); withdrawn.add('new-49');
  t.mock.timers.tick(59_999); await setImmediate(); assert.equal(sends.length,2);
  t.mock.timers.tick(1); await setImmediate(); assert.equal(sends[2]?.[2], '待办新增 48 项决定。');
  service.changed('a','new-55'); service.changed('a','3');
  withdrawn.add('3');
  t.mock.timers.tick(60_000); await setImmediate(); assert.equal(sends.length,3);
  await service.close();
});

test('外层事务回滚不会发送，切换锚点与异步发送前撤权会阻止旧批次', async t => {
  t.mock.timers.enable({ apis: ['Date','setTimeout'], now: 1000 });
  const store = createStore(':memory:'); t.after(() => store.close());
  let anchor: string | undefined = 'first', valid = true;
  const sends: string[] = [];
  let hook = () => {};
  const service = createTopicDecisionPosts(store, { settleMs: 3, intervalMs: 10,
    resolve: () => anchor ? {inputId:anchor} : undefined, isCurrent: () => valid,
    async send(_todo, input, _text, _key, guard) { hook(); guard(); sends.push(input); return 'ack'; } });
  service.recover();
  assert.throws(() => store.transaction(() => { service.changed('t','rolled'); throw Error('rollback'); }));
  t.mock.timers.tick(3); await setImmediate(); assert.equal(sends.length,0);
  service.changed('t','rolled');
  anchor = 'second'; t.mock.timers.tick(3); await setImmediate(); assert.equal(sends.length,0);
  service.changed('t','second-event'); hook = () => { valid = false; };
  t.mock.timers.tick(10); await setImmediate(); assert.equal(sends.length,0);
  valid = true; hook = () => {}; service.changed('t','third'); anchor = undefined;
  t.mock.timers.tick(10); await setImmediate(); assert.equal(sends.length,0);
  anchor = 'second'; service.changed('t','third'); t.mock.timers.tick(100); await setImmediate();
  assert.equal(sends.length,0); await service.close();
});

test('SQLite 重启恢复待发及节流水位，已尝试且未取得平台回执的批次不重发', async t => {
  t.mock.timers.enable({ apis: ['Date','setTimeout'], now: 1000 });
  const dir = await mkdtemp(join(tmpdir(),'sm-topic-decisions-')), db = join(dir,'tmp.sqlite');
  let store = createStore(db);
  t.after(async () => { store.close(); await rm(dir, {recursive:true,force:true}); });
  let attempts = 0;
  const opts = { settleMs: 30, intervalMs: 100, resolve: () => ({inputId:'origin'}),
    async send(_todo: string, _input: string, _text: string, _key: string, guard: () => void) {
      guard(); if (++attempts === 1) return ''; throw new Error('网络中断');
    } };
  let service = createTopicDecisionPosts(store, opts);
  async function restart() { await service.close(); store.close(); store = createStore(db); service = createTopicDecisionPosts(store,opts); }
  service.recover(); service.changed('t','first'); t.mock.timers.tick(10); await restart();
  t.mock.timers.tick(5000); await setImmediate(); assert.equal(attempts,0);
  // A repeat during startup cannot arm the restored queue before the bot handshake.
  service.changed('t','first'); t.mock.timers.tick(5000); await setImmediate(); assert.equal(attempts,0);
  service.recover(); service.recover(); t.mock.timers.tick(1); await setImmediate(); assert.equal(attempts,1);
  service.changed('t','second'); await restart(); service.recover(); service.changed('t','first');
  t.mock.timers.tick(99); await setImmediate(); assert.equal(attempts,1);
  t.mock.timers.tick(1); await setImmediate(); assert.equal(attempts,2);
  await restart(); service.recover(); service.changed('t','second'); t.mock.timers.tick(200); await setImmediate();
  assert.equal(attempts,2);
  assert.deepEqual(store.list<{delivery:string}>('feishu.topic-decision-posts').map(r=>r.delivery), ['unknown','unknown']);
  await service.close();
});

test('首批在途时新决定独立入队，关闭等待在途回执并保留下一批', async t => {
  t.mock.timers.enable({ apis: ['Date','setTimeout'], now: 1000 });
  const store = createStore(':memory:'); t.after(() => store.close());
  let resume!: () => void, count = 0;
  const gate = new Promise<void>(r => { resume = r; });
  const options = { resolve: () => ({inputId:'origin'}), settleMs: 5, intervalMs: 10,
    async send(_id:string, _input:string, _text:string, _key:string, guard:()=>void) {
      guard();
      if (++count === 1) { service.changed('t','two'); await gate; }
      return 'ack-' + count;
    } };
  let service = createTopicDecisionPosts(store, options);
  service.recover(); service.changed('t','one');
  t.mock.timers.tick(5); await setImmediate();
  t.mock.timers.tick(100); await setImmediate(); assert.equal(count,1);
  let drained = false;
  const closing = service.close().then(() => { drained = true; });
  await setImmediate(); assert.equal(drained,false);
  resume(); await closing;
  service = createTopicDecisionPosts(store, options); service.recover();
  t.mock.timers.tick(1); await setImmediate(); assert.equal(count,2);
  await service.close();
});
