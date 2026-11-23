import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../packages/core/src/store.ts';
import {createSourceSubscriptions,type SourceItem} from '../packages/core/src/source-subscriptions.ts';
import type {SubscriptionInboxGroup} from '../packages/core/src/subscription-inbox-groups.ts';

const input={sourceId:'fixture.feed',resource:'repo',name:'合成来源',destinations:['inbox'],intervalMinutes:1};
const items=(...ids:string[]):SourceItem[]=>ids.map(id=>({id,title:'标题-'+id,text:'正文-'+id,thread:'update'}));
async function setup(t:test.TestContext){
  const dir=await mkdtemp(join(tmpdir(),'sm-group-delivery-')),path=join(dir,'test.db');
  let store=createStore(path),result:SourceItem[]=[],fail=false,badRead=false;
  const sends:SubscriptionInboxGroup[]=[],knowledge:string[]=[];
  function open(){return createSourceSubscriptions({store,sources:()=>[{id:input.sourceId,name:'来源',resourceLabel:'资源',triageRules:'连接器规则'}],
    read:async()=>{if(badRead)throw Object.assign(new Error('offline'),{sourceReadCode:'unavailable'});return result;},
    deliverInbox:async(row,g)=>{assert.equal(row.triageRules,'连接器规则');sends.push(g);if(fail)throw new Error('合成丢失的回执');},
    deliver(dest,_key,item){assert.equal(dest,'knowledge');knowledge.push(item.id);},timezone:()=>'UTC'});}
  let svc=open();
  t.after(async()=>{await svc.close();store.close();await rm(dir,{recursive:true,force:true});});
  return {get svc(){return svc;},sends,knowledge,read:(data:SourceItem[])=>{result=data;},fails:(v:boolean)=>{fail=v;},offline:(v:boolean)=>{badRead=v;},
    restart:async()=>{await svc.close();store.close();store=createStore(path);svc=open();}};
}

test('首次读取可摘要；实时消息保留此前个人话题上下文，切换分组后未交付旧条目仍按原身份重投',async t=>{
  const f=await setup(t),row=f.svc.create(input);
  f.read(items('one','two'));await f.svc.pull(row.id,1);
  assert.equal(f.sends.length,1);assert.deepEqual(f.sends[0]?.itemIds,['one','two']);
  f.read(items('three'));await f.svc.pull(row.id,1);
  const recent=f.sends.at(-1)!;assert.equal(recent.thread,f.sends[0]!.thread);
  assert.match(recent.text,/标题-one/);assert.match(recent.text,/标题-two/);assert.deepEqual(recent.itemIds,['three']);
  f.read(items('four'));f.fails(true);await assert.rejects(f.svc.pull(row.id,1),{status:502});
  const frozen=f.sends.at(-1)!;f.fails(false);
  const changed=f.svc.update(row.id,{version:1,inboxGroup:'source'});
  await f.restart();f.read(items('five'));await f.svc.pull(row.id,changed.version);
  assert.deepEqual(f.sends.at(-2),frozen);
  assert.deepEqual(f.sends.at(-1)!.itemIds,['five']);assert.equal(f.sends.at(-1)!.thread,'source');
  assert.doesNotMatch(f.sends.at(-1)!.text,/标题-four/);
  assert.deepEqual(f.svc.runHistory(row.id).items[0]?.delivered,{inbox:2,knowledge:0});
});

test('启用收件时此前24小时未送条目与首轮合并，一次原子确认；重新开启与普通暂停不重复摘要',async t=>{
  const now=Date.parse('2026-04-01T12:00:00Z');t.mock.timers.enable({apis:['Date'],now});
  const f=await setup(t),row=f.svc.create({...input,destinations:['knowledge']});
  f.read(items('expired'));await f.svc.pull(row.id,1);
  t.mock.timers.setTime(now+86401000);
  f.read(items('a','b'));await f.svc.pull(row.id,1);
  const enabled=f.svc.update(row.id,{version:1,destinations:['knowledge','inbox']});
  await f.restart();f.read(items('c','d','expired'));await f.svc.pull(row.id,enabled.version);
  assert.equal(f.sends.length,1);assert.match(f.sends[0]!.thread,/^digest:/);
  assert.deepEqual(f.sends[0]!.itemIds.sort(),['a','b','c','d']);assert.doesNotMatch(f.sends[0]!.text,/expired/);
  let current=f.svc.update(row.id,{version:enabled.version,destinations:['knowledge']});
  f.read(items('e','f'));await f.svc.pull(row.id,current.version);
  current=f.svc.update(row.id,{version:current.version,enabled:false});
  current=f.svc.update(row.id,{version:current.version,destinations:['inbox','knowledge']});
  current=f.svc.update(row.id,{version:current.version,enabled:true});
  f.read(items('g','h'));await f.svc.pull(row.id,current.version);
  assert.deepEqual(f.sends[1]!.itemIds.sort(),['e','f','g','h']);assert.doesNotMatch(f.sends[1]!.text,/标题-[abcd]/);
  current=f.svc.update(row.id,{version:current.version,enabled:false});
  current=f.svc.update(row.id,{version:current.version,enabled:true});
  f.read(items('i','j','k','l'));await f.svc.pull(row.id,current.version);
  assert.equal(f.sends[2]!.thread,'thread:update');assert.doesNotMatch(f.sends[2]!.text,/标题-expired/);
});

test('初开收件遇上游断线可补投缓存，同一轮创建即启用的多项也摘要',async t=>{
  const f=await setup(t),one=f.svc.create(input);
  f.read(items('a','b','c','d'));await f.svc.pull(one.id,1);
  assert.match(f.sends[0]!.thread,/^digest:/);
  const two=f.svc.create({...input,destinations:['knowledge']});
  await f.svc.pull(two.id,1);
  const b=f.svc.update(two.id,{version:1,destinations:['knowledge','inbox']});
  f.offline(true);await assert.rejects(f.svc.pull(two.id,b.version),{status:503});
  assert.deepEqual(f.sends.at(-1)!.itemIds.sort(),['a','b','c','d']);
  f.offline(false);f.read([]);await f.svc.pull(two.id,b.version);
  assert.equal(f.sends.length,2);
});

test('实时线程第2天保留上下文，第9天淘汰旧观察，收件首轮窗口仍为24小时',async t=>{
  const time=Date.parse('2026-01-01T12:00:00Z');t.mock.timers.enable({apis:['Date'],now:time});
  const f=await setup(t),row=f.svc.create(input);
  f.read(items('day-one'));await f.svc.pull(row.id,1);
  t.mock.timers.setTime(time+25*3600000);
  f.read(items('day-two'));await f.svc.pull(row.id,1);
  assert.match(f.sends.at(-1)!.text,/标题-day-one/);
  t.mock.timers.setTime(time+8*86400000+100);
  await f.restart();f.read(items('day-nine'));await f.svc.pull(row.id,1);
  assert.doesNotMatch(f.sends.at(-1)!.text,/标题-day-one/);assert.match(f.sends.at(-1)!.text,/标题-day-two/);
});

test('冻结500项积压再收到100项时保留原观察，摘要最多500项，其余正常分组并确认',async t=>{
  const now=Date.parse('2026-06-01T00:00:00Z');t.mock.timers.enable({apis:['Date'],now});
  const f=await setup(t),row=f.svc.create({...input,destinations:['knowledge']});
  const batch=(page:number)=>items(...Array.from({length:100},(_,n)=>'item-'+(page*100+n)));
  for(let page=0;page<5;page++){
    t.mock.timers.setTime(now+page*1000);
    f.read(batch(page));await f.svc.pull(row.id,1);
  }
  const active=f.svc.update(row.id,{version:1,destinations:['knowledge','inbox']});
  await f.restart();t.mock.timers.setTime(now+60000);
  f.read(batch(5));await f.svc.pull(row.id,active.version);
  const digest=f.sends.find(g=>g.kind==='digest')!;
  assert.equal(digest.itemIds.length,500);assert.equal(f.sends.filter(g=>g.kind==='digest').length,1);
  assert.equal(f.sends.find(g=>g.kind==='thread')?.itemIds.length,100);
  assert.equal(new Set(f.sends.flatMap(g=>g.itemIds)).size,600);
  assert.deepEqual(f.svc.runHistory(row.id).items[0]?.delivered,{inbox:600,knowledge:100});
});
