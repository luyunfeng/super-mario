import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../packages/core/src/store.ts';
import {createSourceSubscriptions} from '../packages/core/src/source-subscriptions.ts';

const start=Date.parse('2026-04-05T10:00:00Z'),minute=60000;
const source=(id:string)=>({id,name:id,resourceLabel:'资源'});
const input=(sourceId:string,resource:string,intervalMinutes=5)=>({sourceId,resource,name:resource,intervalMinutes,destinations:['knowledge']});
const item={id:'a',title:'合成标题',text:'合成正文'};

test('单订阅从每个出站开始时刻加倍重试，重启后自动运行标明重试，成功读后投递失败也清零',async t=>{
  t.mock.timers.enable({apis:['Date'],now:start});
  const dir=await mkdtemp(join(tmpdir(),'retry-policy-')),path=join(dir,'data.db');
  let db=createStore(path),ok=false,failDelivery=true,calls=0;
  function open(){return createSourceSubscriptions({store:db,sources:()=>[source('local.a')],
    async read(){calls++;if(!ok){t.mock.timers.setTime(Date.now()+minute);throw {sourceReadCode:'not_found'};}return [item];},
    deliver(){if(failDelivery)throw Error('合成投递失败');}});}
  let svc=open();t.after(async()=>{await svc.close();db.close();await rm(dir,{force:true,recursive:true});});
  const row=svc.create(input('local.a','test')),get=()=>svc.list()[0]!;
  await assert.rejects(svc.pull(row.id,1),{status:404});
  assert.equal(get().failureCount,1);assert.equal(Date.parse(get().nextRunAt),start+10*minute);
  assert.equal(svc.runHistory(row.id).items[0]?.trigger,'manual');
  await svc.close();db.close();db=createStore(path);svc=open();
  t.mock.timers.setTime(start+9*minute);await svc.tick();assert.equal(calls,1);
  t.mock.timers.setTime(start+10*minute);await svc.tick();
  assert.equal(calls,2);assert.equal(get().failureCount,2);assert.equal(Date.parse(get().nextRunAt),start+30*minute);
  assert.equal(svc.runHistory(row.id).items[0]?.trigger,'retry');
  ok=true;await assert.rejects(svc.pull(row.id,1),{status:502});assert.equal(get().failureCount,undefined);
  assert.equal(svc.runHistory(row.id).items[0]?.trigger,'manual');
  await assert.rejects(svc.pull(row.id,1),{status:502});assert.equal(calls,3);
  failDelivery=false;await svc.pull(row.id,1);assert.equal(get().failureCount,undefined);
});

test('三个真实调用故障锁住同连接器排队读取；预览、资源、权限、结构和未连接不影响共享退避',async t=>{
  t.mock.timers.enable({apis:['Date'],now:start});const store=createStore(':memory:');
  let code='unavailable',reads=0;
  const ids=['test.a','test.b','other.a'];
  const svc=createSourceSubscriptions({store,sources:()=>ids.map(source),
    async read(){reads++;if(code)throw {sourceReadCode:code};return [];},deliver(){}});
  t.after(async()=>{await svc.close();store.close();});
  const setup=ids.map(id=>svc.create(input(id,id,600))),[a,b,c]=setup as [typeof setup[number],typeof setup[number],typeof setup[number]];
  const get=(id:string)=>svc.list().find(row=>row.id===id)!;
  for(let i=0;i<4;i++)await assert.rejects(svc.preview(input('test.a','preview')));
  for(code of ['not_connected','invalid_resource','forbidden','not_found','shape_changed']){
    await assert.rejects(svc.pull(a.id,1));
    if(code==='not_connected')assert.equal(get(a.id).failureCount,undefined);
    assert.equal(get(b.id).retryKind,undefined);
  }
  assert.equal(get(a.id).failureCount,4);assert.equal(Date.parse(get(a.id).nextRunAt),start+360*minute);
  code='unavailable';await assert.rejects(svc.pull(a.id,1));await assert.rejects(svc.pull(b.id,1));
  const before=reads;
  await Promise.all([assert.rejects(svc.pull(a.id,1),{status:503}),assert.rejects(svc.pull(b.id,1),{status:429,retryKind:'failures'})]);
  assert.equal(reads,before+1);assert.equal(get(b.id).failureCount,1);
  assert.equal(get(b.id).retryKind,'failures');assert.equal(Date.parse(get(b.id).retryAt!),start+minute);
  code='';await svc.pull(c.id,1);assert.equal(get(c.id).failureCount,undefined);
  await assert.rejects(svc.preview(input('test.a','preview')),{retryKind:'failures'});
  t.mock.timers.setTime(start+minute);await svc.pull(b.id,1);
  code='rate_limited';await assert.rejects(svc.pull(b.id,1),{status:429,retryKind:'rate_limit'});
  assert.equal(get(b.id).failureCount,undefined);assert.equal(get(a.id).retryKind,'rate_limit');
  const paused=svc.update(a.id,{version:1,enabled:false});assert.equal(paused.failureCount,undefined);
});

test('每日快照读取失败先重试，恢复后回归每日计划',async t=>{
  t.mock.timers.enable({apis:['Date'],now:start});const store=createStore(':memory:');
  let ok=false;
  const svc=createSourceSubscriptions({store,timezone:()=>'UTC',sources:()=>[{...source('local.snapshot'),mode:'snapshot'}],
    async read(){if(!ok)throw {sourceReadCode:'unavailable'};return {snapshot:{title:'合成快照',text:'本地'}};},deliver(){}});
  t.after(async()=>{await svc.close();store.close();});
  const row=svc.create({...input('local.snapshot','snapshot',60),dailyAt:'08:00'});
  await svc.tick();const next=Date.parse(svc.list()[0]!.nextRunAt);
  assert.equal(next,start+120*minute);
  ok=true;t.mock.timers.setTime(next);await svc.tick();
  assert.equal(svc.runHistory(row.id).items[0]?.trigger,'retry');
  assert.equal(svc.list()[0]!.nextRunAt,'2026-04-06T08:00:00.000Z');
});
