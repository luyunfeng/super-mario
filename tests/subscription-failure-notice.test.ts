import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSourceSubscriptions} from '../packages/core/src/source-subscriptions.ts';
import {createStore} from '../packages/core/src/store.ts';
import type {SubscriptionFailureNotice} from '../packages/protocol/src/index.ts';

const input={sourceId:'fixture.feed',resource:'a',name:'合成订阅',intervalMinutes:10080,destinations:['knowledge']};
const source={id:input.sourceId,name:'来源',resourceLabel:'资源'};
const start=Date.parse('2026-01-05T10:00:00Z'),day=86400000;

test('真实来源失败满24小时独立于调度与限流开启，成功读取即恢复，即使投递失败',async t=>{
  t.mock.timers.enable({apis:['Date'],now:start});
  const dir=await mkdtemp(join(tmpdir(),'sm-notices-')),file=join(dir,'test.db');
  let store=createStore(file),problem='private',registered=true,deliveryFails=false,reads=0;
  function open(){return createSourceSubscriptions({store,sources:()=>registered?[source]:[],
    async read(){reads++;
      if(problem==='private')throw Object.assign(new Error('合成绝密凭证不得出现在收件'),{status:503});
      if(problem==='throttle')throw {sourceReadCode:'rate_limited',retryAfterSeconds:172800};
      return [{id:'fixture-a',title:'更新',text:'合成内容'}];},
    deliver(){if(deliveryFails)throw Error('synthetic');},
    onFailureNotice(notice){store.put('fixture.notice',notice.subscriptionId,notice);}
  });}
  let svc=open();t.after(async()=>{await svc.close();store.close();await rm(dir,{recursive:true,force:true});});
  const a=svc.create(input),b=svc.create({...input,resource:'b'});
  function row(id:string){return svc.list().find(s=>s.id===id)!;}
  function notice(){return store.get<SubscriptionFailureNotice>('fixture.notice',a.id);}
  registered=false;await assert.rejects(svc.pull(a.id,1),{status:503});assert.equal(row(a.id).failingSince,undefined);
  registered=true;await assert.rejects(svc.preview({...input,subscriptionId:a.id}));
  assert.equal(row(a.id).failingSince,undefined);
  await assert.rejects(svc.pull(a.id,1),{status:502});const since=new Date(start).toISOString();
  assert.equal(row(a.id).failingSince,since);assert.doesNotMatch(row(a.id).failureReason!,/绝密/);
  t.mock.timers.setTime(start+1000);problem='throttle';
  const reason=row(a.id).failureReason;
  await assert.rejects(svc.pull(b.id,1),{status:429});assert.equal(row(b.id).failingSince,undefined);
  await assert.rejects(svc.pull(a.id,1),{status:429});assert.equal(row(a.id).failingSince,since);assert.equal(row(a.id).failureReason,reason);
  await assert.rejects(svc.pull(b.id,1),{status:429});assert.equal(row(b.id).failingSince,undefined);
  t.mock.timers.setTime(start+day-1);await svc.tick();assert.equal(notice(),undefined);
  await svc.close();store.close();store=createStore(file);svc=open();
  const count=reads;t.mock.timers.setTime(start+day);await svc.tick();await svc.tick();
  assert.equal(reads,count);assert.deepEqual(notice(),{state:'open',subscriptionId:a.id,name:a.name,since,reason:row(a.id).failureReason});
  t.mock.timers.setTime(start+day*2+2000);problem='';deliveryFails=true;
  await svc.preview({...input,subscriptionId:a.id});assert.equal(row(a.id).failingSince,since);
  await assert.rejects(svc.pull(a.id,1),{status:502});
  assert.equal(notice()?.state,'recovered');assert.equal(notice()?.since,since);
  assert.equal(row(a.id).failingSince,undefined);assert.equal(row(a.id).failureReason,undefined);assert.match(row(a.id).error!,/投递失败/);
  const priorReads=reads;await assert.rejects(svc.pull(a.id,1),{status:502});
  assert.equal(reads,priorReads);assert.equal(row(a.id).failingSince,undefined);
});

test('取消读取不会启动失败计时，暂停与删除事务关闭当前失败周期',async t=>{
  const store=createStore(':memory:');
  t.mock.timers.enable({apis:['Date'],now:start});
  let started!:()=>void,arrived=new Promise<void>(resolve=>{started=resolve;}),wait=true,failNotice=false;
  const svc=createSourceSubscriptions({store,sources:()=>[source],deliver(){},
    async read(_src,_resource,signal){
      if(wait){started();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));}
      throw {sourceReadCode:'unavailable'};
    },onFailureNotice(notice){store.put('fixture.notice',notice.subscriptionId,notice);if(failNotice)throw Error('合成保存失败');}
  });
  t.after(async()=>{await svc.close();store.close();});
  const a=svc.create(input);
  const pending=assert.rejects(svc.pull(a.id,1),{status:409});await arrived;
  let row=svc.update(a.id,{version:1,enabled:false});await pending;
  assert.equal(row.failingSince,undefined);
  wait=false;row=svc.update(a.id,{version:row.version,enabled:true});await assert.rejects(svc.pull(a.id,row.version),{status:503});
  assert.match(svc.list()[0]!.failureReason!,/暂不可用/);
  failNotice=true;assert.throws(()=>svc.update(a.id,{version:row.version,enabled:false}),/合成保存失败/);
  assert.equal(svc.list()[0]!.enabled,true);assert.equal(store.get('fixture.notice',a.id),undefined);
  failNotice=false;row=svc.update(a.id,{version:row.version,enabled:false});
  assert.equal(row.failingSince,undefined);
  assert.equal(store.get<SubscriptionFailureNotice>('fixture.notice',a.id)?.state,'paused');
  t.mock.timers.setTime(start+day*2);row=svc.update(a.id,{version:row.version,enabled:true});
  await assert.rejects(svc.pull(a.id,row.version),{status:503});const nextSince=new Date().toISOString();
  svc.remove(a.id,row.version);assert.equal(svc.list().length,0);
  assert.equal(store.get<SubscriptionFailureNotice>('fixture.notice',a.id)?.state,'deleted');
  assert.equal(store.get<SubscriptionFailureNotice>('fixture.notice',a.id)?.since,nextSince);
});

test('慢读取的失败计时从出站开始；分页循环暂停已有故障且不虚报恢复',async t=>{
  t.mock.timers.enable({apis:['Date'],now:start});
  const store=createStore(':memory:'),states:SubscriptionFailureNotice['state'][]=[];
  let mode='first';
  const svc=createSourceSubscriptions({store,sources:()=>[source],deliver(){},onFailureNotice:n=>states.push(n.state),
    async read(){
      if(mode==='slow') {t.mock.timers.setTime(start+day);throw Error('合成超时');}
      return {items:[],nextCursor:'repeat'};
    }});
  t.after(async()=>{await svc.close();store.close();});
  const row=svc.create(input);
  await svc.pull(row.id,1);
  mode='slow';await assert.rejects(svc.pull(row.id,1),{status:502});
  assert.equal(svc.list()[0]!.failingSince,new Date(start).toISOString());
  mode='first';await svc.tick();
  assert.equal(svc.runHistory(row.id).items[0]?.trigger,'retry');
  assert.deepEqual(states,['open','paused']);assert.equal(svc.list()[0]!.enabled,false);
});
