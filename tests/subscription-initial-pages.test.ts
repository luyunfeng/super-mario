import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../packages/core/src/store.ts';
import {createSourceSubscriptions,type SourceItem} from '../packages/core/src/source-subscriptions.ts';
import type {SubscriptionInboxGroup} from '../packages/core/src/subscription-inbox-groups.ts';

const input={sourceId:'fixture.feed',resource:'a',name:'合成来源',intervalMinutes:10,destinations:['inbox','knowledge']};
const rows=(...ids:string[]):SourceItem[]=>ids.map(id=>({id,title:id,text:'合成正文',thread:id}));
const start=Date.parse('2026-04-05T10:00:00Z');

async function fixture(t:test.TestContext){
  t.mock.timers.enable({apis:['Date'],now:start});
  const dir=await mkdtemp(join(tmpdir(),'sm-initial-page-')),file=join(dir,'fixture.db');
  let db=createStore(file);
  const groups:SubscriptionInboxGroup[]=[],knowledge:string[]=[],calls:{cursor?:string;checkpoint?:string}[]=[];
  const state={page:{items:[] as SourceItem[],nextCursor:undefined as string|undefined,checkpoint:undefined as string|undefined},
    problem:'',failKnowledge:false,failGroup:''};
  function open(){return createSourceSubscriptions({store:db,sources:()=>[{id:input.sourceId,name:'来源',resourceLabel:'资源'}],
    async read(_id,_resource,_signal,cursor,checkpoint){calls.push({cursor,checkpoint});
      if(state.problem)throw {sourceReadCode:state.problem,retryAfterSeconds:60};
      return state.page;},
    deliver(_dest,_key,item){if(state.failKnowledge)throw Error('模拟知识库离线');knowledge.push(item.id);},
    deliverInbox(_row,group){groups.push(group);if(group.kind===state.failGroup)throw Error('模拟收件回执失败');}
  });}
  let svc=open();t.after(async()=>{await svc.close();db.close();await rm(dir,{recursive:true,force:true});});
  return {get svc(){return svc;},state,knowledge,groups,calls,
    page(items:SourceItem[],nextCursor?:string,checkpoint?:string){state.page={items,nextCursor,checkpoint};},
    async restart(){await svc.close();db.close();db=createStore(file);svc=open();}
  };
}

test('开启收件后等全部页读完，逐页写知识，重启与限流不提前入箱；终页去重保留预存和未来截止项',async t=>{
  const f=await fixture(t),row=f.svc.create({...input,destinations:['knowledge']});
  f.page(rows('before'));await f.svc.pull(row.id,1);
  const active=f.svc.update(row.id,{version:1,destinations:input.destinations});
  const pull=()=>f.svc.pull(row.id,active.version);
  f.page(rows('a','b'),'next','watermark');assert.equal((await pull()).inboxCatchupPending,3);
  assert.deepEqual(f.knowledge,['before','a','b']);assert.equal(f.groups.length,0);
  assert.equal(f.svc.list()[0]!.inboxCatchupPending,3);assert.equal(f.svc.runHistory(row.id).currentPending.inbox,3);
  assert.deepEqual(f.svc.runHistory(row.id).items[0]!.delivered,{knowledge:2,inbox:0});
  await f.restart();f.state.problem='rate_limited';await assert.rejects(pull(),{status:429});
  const calls=f.calls.length;await assert.rejects(pull(),{status:429});assert.equal(f.calls.length,calls);
  assert.equal(f.groups.length,0);assert.equal(f.svc.list()[0]!.inboxCatchupPending,3);
  t.mock.timers.setTime(start+61000);f.state.problem='unavailable';await assert.rejects(pull(),{status:503});assert.equal(f.groups.length,0);
  f.state.problem='';const future={...rows('due')[0]!,dueAt:'2026-05-06T12:00:00Z'};
  f.page([...rows('a','c','d'),future]);await pull();
  assert.equal(f.calls.at(-1)?.cursor,'next');assert.equal(f.svc.list()[0]!.inboxCatchupPending,undefined);
  assert.deepEqual(f.groups.find(g=>g.kind==='digest')!.itemIds.toSorted(),['a','b','before','c','d']);
  assert.deepEqual(f.groups.find(g=>g.kind==='thread')!.itemIds,['due']);
  assert.deepEqual(f.knowledge,['before','a','b','c','d','due']);
  assert.equal(f.svc.runHistory(row.id).currentPending.inbox,0);
  assert.deepEqual(f.svc.runHistory(row.id).items[0]!.delivered,{knowledge:3,inbox:6});
  f.page(rows('live'),'later','watermark-2');await pull();
  assert.deepEqual(f.calls.at(-1),{cursor:undefined,checkpoint:'watermark'});
  assert.deepEqual(f.groups.at(-1)!.itemIds,['live']);
});

test('非终页知识中断后先补原页，终页收件中断后不重读来源或重写已确认条目',async t=>{
  const f=await fixture(t),row=f.svc.create(input),pull=()=>f.svc.pull(row.id,1);
  f.page(rows('a','b'),'second');f.state.failKnowledge=true;await assert.rejects(pull(),{status:502});
  assert.equal(f.svc.list()[0]!.inboxCatchupPending,2);assert.equal(f.groups.length,0);
  await f.restart();f.state.failKnowledge=false;await pull();assert.equal(f.calls.length,1);
  assert.deepEqual(f.knowledge,['a','b']);assert.equal(f.groups.length,0);
  f.page(rows('c','d'));f.state.failGroup='digest';await assert.rejects(pull(),{status:502});
  assert.equal(f.svc.runHistory(row.id).currentPending.inbox,4);
  assert.equal(f.svc.runHistory(row.id).items[0]!.delivered.inbox,0);assert.deepEqual(f.knowledge,['a','b','c','d']);
  await f.restart();f.state.failGroup='';await pull();
  assert.equal(f.calls.length,2);assert.equal(f.groups.length,2);assert.deepEqual(f.groups[0],f.groups[1]);
  assert.equal(f.svc.runHistory(row.id).currentPending.inbox,0);
});

test('分页期间暂停可跨重启从首页续收；移除收件目的地和删除订阅清理积压',async t=>{
  const f=await fixture(t),row=f.svc.create(input);
  f.page(rows('a','b'),'p2');await f.svc.pull(row.id,1);
  let active=f.svc.update(row.id,{version:1,enabled:false});assert.equal(active.inboxCatchupPending,2);
  await f.restart();await f.svc.tick();assert.equal(f.groups.length,0);
  active=f.svc.update(row.id,{version:active.version,enabled:true});
  f.page(rows('b','c'),'p2');await f.svc.pull(row.id,active.version);
  assert.equal(f.calls.at(-1)!.cursor,undefined);assert.equal(f.svc.list()[0]!.inboxCatchupPending,3);
  active=f.svc.update(row.id,{version:active.version,destinations:['knowledge']});
  assert.equal(f.svc.list()[0]!.inboxCatchupPending,undefined);assert.equal(f.svc.runHistory(row.id).currentPending.inbox,0);
  f.page(rows('d'));await f.svc.pull(row.id,active.version);assert.equal(f.groups.length,0);
  active=f.svc.update(row.id,{version:active.version,destinations:input.destinations});
  f.page(rows('e'),'p3');await f.svc.pull(row.id,active.version);assert.equal(f.svc.list()[0]!.inboxCatchupPending,5);
  f.svc.remove(row.id,active.version);await f.restart();assert.equal(f.svc.list().length,0);assert.equal(f.groups.length,0);
});

test('仅收件时空首页也等待终页，跨页重现同一编号不会重复算作新条目',async t=>{
  const f=await fixture(t),row=f.svc.create({...input,destinations:['inbox']});
  const pull=()=>f.svc.pull(row.id,1);
  f.page([],'p2');assert.equal((await pull()).inboxCatchupPending,0);
  await f.restart();assert.equal(f.svc.list()[0]!.inboxCatchupPending,0);
  f.page(rows('a','b'),'p3');assert.equal((await pull()).inboxCatchupPending,2);
  f.page(rows('b','c'),'p4');assert.equal((await pull()).inboxCatchupPending,3);
  assert.equal(f.svc.runHistory(row.id).items[0]?.newCount,1);assert.equal(f.groups.length,0);
  f.page(rows('b','d'));await pull();
  assert.deepEqual(f.groups[0]?.itemIds.toSorted(),['a','b','c','d']);
  assert.equal(f.svc.runHistory(row.id).items[0]?.newCount,1);
});
