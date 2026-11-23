import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createInboxService} from '../packages/core/src/inbox.ts';
import {createStore} from '../packages/core/src/store.ts';
import {createEventBus} from '../packages/core/src/events.ts';

const notice={subscriptionId:'local-source',name:'合成订阅',since:'2026-01-01T00:00:00.000Z',reason:'读取订阅来源失败，请检查来源连接与权限。',state:'open'} as const;
function fixture(path:string) {
  const store=createStore(path),events=createEventBus(store);
  const inbox=createInboxService({store,events,createTodo:()=>assert.fail('禁止自动创建待办'),triage:async()=>assert.fail('禁止调用分拣器')});
  return {store,inbox,events,close:async()=>{await inbox.close();store.close();}};
}

test('连续失败满24小时出现一张知会卡，重启及手工归档后不复活，仅真实恢复结束对应故障',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'super-mario-sub-health-'));
  const path=join(dir,'synthetic.db');
  let app=fixture(path);
  t.after(async()=>{await app.close();rmSync(dir,{force:true,recursive:true});});
  t.mock.timers.enable({apis:['Date'],now:Date.parse(notice.since)+86400000-1});
  app.inbox.syncSubscriptionFailure(notice);
  assert.deepEqual(app.inbox.list(),[]);
  t.mock.timers.tick(1);
  app.inbox.syncSubscriptionFailure(notice);
  const initial=app.inbox.list()[0]!;
  assert.deepEqual(app.inbox.subscriptionFailureCard(notice.subscriptionId),initial);
  assert.equal(app.inbox.subscriptionFailureCard('unrelated'),undefined);
  assert.deepEqual([initial.source,initial.thread,initial.last,initial.receivedAt,initial.tier,initial.text,initial.version],
    ['subscription:local-source','failing','failing:'+notice.since,'2026-01-02T00:00:00.000Z','fyi',notice.reason,1]);
  app.inbox.syncSubscriptionFailure(notice);
  assert.equal(app.events.since(0).length,1);
  app.inbox.archive(initial.id,initial.version);
  const archived=app.inbox.list()[0]!;
  await app.close();
  app=fixture(path);
  app.inbox.syncSubscriptionFailure(notice);
  app.inbox.syncSubscriptionFailure({...notice,since:'2025-12-30T00:00:00.000Z',state:'recovered'});
  assert.deepEqual(app.inbox.list(),[archived]);
  t.mock.timers.tick(5000);
  app.inbox.syncSubscriptionFailure({...notice,state:'recovered'});
  app.inbox.syncSubscriptionFailure({...notice,state:'recovered'});
  app.inbox.syncSubscriptionFailure(notice);
  const recovered=app.inbox.list()[0]!;
  assert.equal(recovered.archivedAt,archived.archivedAt);
  assert.equal(recovered.receivedAt,initial.receivedAt);
  assert.equal(recovered.subscriptionFailure?.state,'recovered');
  assert.match(recovered.text,/来源读取已恢复/);
  assert.match(recovered.reason,/用户已归档/);
  assert.equal(app.events.since(0).length,3);
  const next={...notice,since:'2026-01-02T00:00:00.000Z'};
  t.mock.timers.tick(86400000);
  app.inbox.syncSubscriptionFailure(next);
  app.inbox.syncSubscriptionFailure({...notice,state:'deleted'});
  const active=app.inbox.list()[0]!;
  assert.equal(active.id,initial.id);
  assert.equal(active.version,4);
  assert.equal(active.archivedAt,undefined);
  assert.equal(active.subscriptionFailure?.since,next.since);
});

test('暂停、删除只关闭已有的对应故障；普通来源数据不能占用保留线程',async t=>{
  const app=fixture(':memory:');
  t.after(app.close);
  t.mock.timers.enable({apis:['Date'],now:Date.parse(notice.since)+86400001});
  for(const state of ['paused','deleted'] as const) {
    const source={...notice,subscriptionId:state};
    app.inbox.syncSubscriptionFailure({...source,state});
    assert.ok(!app.inbox.list().some(row=>row.source==='subscription:'+state));
    app.inbox.syncSubscriptionFailure(source);
    app.inbox.syncSubscriptionFailure({...source,state});
    const closed=app.inbox.list().find(row=>row.source==='subscription:'+state)!;
    assert.ok(closed.archivedAt);
    assert.equal(closed.subscriptionFailure?.state,state);
    assert.doesNotMatch(closed.text,/恢复/);
    app.inbox.syncSubscriptionFailure(source);
    assert.equal(app.inbox.list().find(row=>row.id===closed.id)?.version,2);
  }
  await assert.rejects(app.inbox.ingest('subscription:test',[{thread:'failing',last:'fake',title:'合成消息',text:''}]),/保留/);
  assert.equal(app.events.since(0).length,4);
});

test('后一轮故障复用提醒卡时保留上一轮的待办，重新显示知会',async t=>{
  const store=createStore(':memory:');
  const events=createEventBus(store);
  const inbox=createInboxService({store,events,createTodo(input){
    const now=new Date().toISOString();
    const todo={id:'previous-incident',title:String(input.title),notes:String(input.notes),createdAt:now,updatedAt:now};
    store.put('todos',todo.id,todo);
    return todo;
  }});
  t.after(async()=>{await inbox.close();store.close();});
  t.mock.timers.enable({apis:['Date'],now:Date.parse(notice.since)+86400000});
  inbox.syncSubscriptionFailure(notice);
  const first=inbox.subscriptionFailureCard(notice.subscriptionId)!;
  const previous=inbox.confirm(first.id,first.version);
  inbox.syncSubscriptionFailure({...notice,state:'recovered'});
  const next={...notice,since:new Date().toISOString()};
  t.mock.timers.tick(86400000);
  inbox.syncSubscriptionFailure(next);
  const card=inbox.subscriptionFailureCard(notice.subscriptionId)!;
  assert.equal(card.id,first.id);
  assert.equal(card.tier,'fyi');
  assert.equal(card.archivedAt,undefined);
  assert.equal(card.todoId,undefined);
  assert.ok(store.get('todos',previous.todoId));
});
