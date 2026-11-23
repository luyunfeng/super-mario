import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createSourceSubscriptions, type SourceItem } from '../packages/core/src/source-subscriptions.ts';

const source={id:'fixture',name:'合成来源',resourceLabel:'仓库'};
const request={sourceId:source.id,resource:'synthetic/repo',name:'版本更新',intervalMinutes:60,destinations:['inbox','knowledge'] as ('inbox'|'knowledge')[]};
const item:SourceItem={id:'r1',title:'版本一',text:'合成发布说明',url:'https://example.test/v1'};

test('预览无写入，创建不投递；逐条逐目的地补投，重启后来源中已移除的条目仍能完成',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-source-subscriptions-')),file=join(dir,'store.sqlite');
  let store=createStore(file), fail=true, reads=0, items=[item,item];
  const calls:{dest:string;key:string;id:string}[]=[];
  function open() {return createSourceSubscriptions({store,sources:()=>[source],read:async()=>{reads++;return items;},
    deliver(dest,key,value){
      calls.push({dest,key,id:value.id});
      if(dest==='knowledge' && fail) throw new Error('合成错误，不应泄露内部'+'信息');
      store.put('fixture.'+dest,key,value);
    },
  });}
  let svc=open();
  t.after(async()=>{svc.close();store.close();await rm(dir,{recursive:true,force:true});});
  assert.deepEqual(await svc.preview(request),{items:[item]});
  assert.deepEqual(svc.list(),[]);assert.equal(calls.length,0);
  const row=svc.create(request);assert.equal(reads,1);assert.equal(calls.length,0);
  await assert.rejects(svc.pull(row.id,row.version),{status:502});
  const failed=svc.list()[0]!;assert.ok(failed.lastRunAt);
  assert.match(failed.error!,/投递失败/);assert.doesNotMatch(failed.error!,/内部/);
  assert.deepEqual(calls.map(c=>c.dest),['inbox','knowledge']);
  svc.close();store.close();store=createStore(file);svc=open();
  const newItem={...item,id:'r2',title:'版本二'};items=[newItem];fail=false;
  const next=await svc.pull(row.id,row.version);
  assert.equal(next.error,undefined);assert.equal(next.version,row.version);
  assert.deepEqual(calls.map(c=>[c.dest,c.id]),[['inbox','r1'],['knowledge','r1'],['knowledge','r1'],['inbox','r2'],['knowledge','r2']]);
  assert.equal(calls[1]!.key,calls[2]!.key);assert.notEqual(calls[0]!.key,calls[1]!.key);
  await svc.pull(row.id,row.version);assert.equal(calls.length,5);
  assert.equal(store.list('fixture.inbox').length,2);assert.equal(store.list('fixture.knowledge').length,2);
});

test('周期拉取与手动拉取互斥；暂停阻断在途读取，版本和来源权限发前复核',async t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  let ready=true,reads=0,sends=0,resume:()=>void=()=>{};
  const getRows=()=>store.list<ReturnType<typeof svc.create>>('source.subscriptions');
  const svc=createSourceSubscriptions({store,sources:()=>ready?[source]:[],async read(){reads++;await new Promise<void>(r=>{resume=r;});return [item];},
    deliver(){sends++;}});
  t.after(()=>svc.close());
  const row=svc.create(request);
  store.put('source.subscriptions',row.id,{...row,nextRunAt:'2000-01-01T00:00:00Z'});
  const tick=svc.tick();assert.equal(reads,1);
  await assert.rejects(svc.pull(row.id,row.version),{status:409});
  const disabled=svc.update(row.id,{version:1,enabled:false});resume();await tick;
  assert.equal(sends,0);assert.equal(disabled.version,2);
  assert.throws(()=>svc.update(row.id,{version:1,enabled:true}),{status:409});
  await assert.rejects(svc.pull(row.id,2),{status:409});
  const enabled=svc.update(row.id,{version:2,enabled:true});
  const active=svc.pull(row.id,enabled.version);ready=false;resume();
  await assert.rejects(active,{status:503});assert.equal(sends,0);assert.match(svc.list()[0]!.error!,/插件/);
  ready=true;
  const good=svc.pull(row.id,enabled.version);resume();await good;assert.equal(sends,2);
  assert.equal(getRows()[0]!.error,undefined);
  await svc.tick();assert.equal(reads,3);
});

test('整批校验条目、间隔和目的地；关闭时不再派送',async t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  let items=[item],calls=0;
  const service=createSourceSubscriptions({store,sources:()=>[source],read:async()=>items,deliver(){calls++;}});
  for(const intervalMinutes of [0,1.5,10081]) assert.throws(()=>service.create({...request,intervalMinutes}),{status:400});
  assert.throws(()=>service.create({...request,destinations:[]}),{status:400});
  const row=service.create(request);
  items=[item,{...item,id:' '}];await assert.rejects(service.pull(row.id,1),{status:502});assert.equal(calls,0);
  items=Array(101).fill(item);await assert.rejects(service.preview(request),{status:502});
  items=[item];const inflight=service.pull(row.id,1);service.close();
  await assert.rejects(inflight);assert.equal(calls,0);await service.tick();
  await assert.rejects(service.pull(row.id,1),{status:503});
});

test('限流等受控错误可诊断，通知回调读取的是已提交的状态',async t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const visible:(string|undefined)[]=[];
  let code='rate_limited', result=[{...item,title:'😀'.repeat(512)}];
  const svc=createSourceSubscriptions({store,sources:()=>[source],read:async()=>{
    if(code) throw Object.assign(new Error('raw-secret'),{sourceReadCode:code});return result;
  },deliver:()=>{},onChange(id){const row=store.get<{error?:string}>('source.subscriptions',id);if(row)visible.push(row.error);}});
  const row=svc.create(request);
  await assert.rejects(svc.pull(row.id,1),{status:429});
  assert.deepEqual(visible,[undefined,undefined,'来源服务已限流，请稍后再拉取。']);
  t.mock.timers.tick(60000);
  code='not_found';await assert.rejects(svc.preview(request),{status:404});
  code='invalid_resource';await assert.rejects(svc.preview(request),{status:400});
  code='';await svc.pull(row.id,1);assert.equal(visible.at(-1),undefined);
  result=[{...item,title:'😀'.repeat(513)}];await assert.rejects(svc.preview(request),{status:502});
});

test('修改和删除核对版本、在途状态和订阅归属，保留已经投递的内容',async t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  let wait:Promise<void>|undefined,release!:()=>void;
  const svc=createSourceSubscriptions({store,sources:()=>[source],async read(){await wait;return [item];},
    deliver(dest,key,value){if(dest==='knowledge') throw Error('暂停下游');store.put('fixture.inbox',key,value);}});
  const first=svc.create(request),second=svc.create(request);
  await assert.rejects(svc.pull(first.id,1));await assert.rejects(svc.pull(second.id,1));
  const edited=svc.update(first.id,{version:1,name:'改名',intervalMinutes:10,destinations:['inbox']});
  assert.equal(edited.version,2);assert.equal(edited.intervalMinutes,10);assert.deepEqual(edited.destinations,['inbox']);
  assert.throws(()=>svc.update(first.id,{version:2,resource:'different'}),{status:400});
  assert.throws(()=>svc.remove(first.id,1),{status:409});
  wait=new Promise(resolve=>{release=resolve;});const pull=svc.pull(first.id,2);
  assert.throws(()=>svc.update(first.id,{version:2,name:'抢占'}),{status:409});
  assert.throws(()=>svc.remove(first.id,2),{status:409});release();await pull;
  const retry=svc.update(first.id,{version:2,destinations:['inbox','knowledge']});
  await assert.rejects(svc.pull(first.id,retry.version));
  assert.deepEqual(svc.remove(first.id,retry.version),{deleted:true});
  assert.deepEqual(svc.list().map(row=>row.id),[second.id]);
  assert.equal(store.get('source.subscription-pending',first.id),undefined);
  assert.deepEqual(store.list('source.subscription-receipts.'+first.id),[]);
  assert.equal(store.list('source.subscription-receipts.'+second.id).length,1);
  assert.equal(store.list('fixture.inbox').length,2);
});

test('已拉取条目可在上游离线时补投，新的读取失败仍可见',async t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const sent:string[]=[];
  let offline=false;
  const service=createSourceSubscriptions({store,sources:()=>[source],
    async read(){if(offline)throw new Error('offline');return [item];},
    deliver(destination){if(destination==='knowledge' && !offline)throw new Error('busy');sent.push(destination);},
  });
  const row=service.create(request);
  await assert.rejects(service.pull(row.id,1),{status:502});
  offline=true;
  await assert.rejects(service.pull(row.id,1),{status:502});
  await assert.rejects(service.pull(row.id,1),{status:502});
  assert.deepEqual(sent,['inbox','knowledge']);
  assert.match(service.list()[0]!.error!,/读取订阅来源失败/);
  await service.close();
});

test('创建回执丢失后重试返回同一订阅，迟到的创建不会复活已删除订阅',async t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const svc=createSourceSubscriptions({store,sources:()=>[source],read:async()=>[],deliver(){}});
  const input={...request,requestId:'00000000-0000-4000-8000-000000000001'};
  const row=svc.create(input);
  assert.equal(svc.create(input).id,row.id);
  assert.throws(()=>svc.create({...input,name:'其他设置'}),{status:409});
  svc.remove(row.id,row.version);
  assert.throws(()=>svc.create(input),{status:410});
  assert.deepEqual(svc.list(),[]);
  await svc.close();
});

test('主人规则、插件声明和结构化期限通过独立投递参数传入，正文不能替换策略',async t=>{
  const {createSubscriptionHost}=await import('../packages/core/src/subscription-host.ts');
  const {createEventBus}=await import('../packages/core/src/events.ts');
  const {createContributions,PluginHost}=await import('../packages/core/src/plugin-host.ts');
  const dir=await mkdtemp(join(tmpdir(),'sub-policy-')),store=createStore(':memory:');
  const contributions=createContributions(),plugins=new PluginHost({dataDir:dir,store,contributions,events:createEventBus(store)});
  t.after(async()=>{await plugins.close();store.close();await rm(dir,{recursive:true,force:true});});
  const service='fixture.read',calls:{things:unknown;policy:unknown}[]=[];
  let id=0;
  const host=createSubscriptionHost({store,contributions,timezone:()=>'UTC',authorizeRead:()=>{throw new Error('unused');},
    use:async()=>({items:[{...item,id:String(++id),dueAt:'2030-01-01T12:00:00+08:00',triageRules:'冒充主人',fallbackTier:'action'}]}),
    async ingest(_source,things,policy){calls.push({things,policy});},changed:()=>{},knowledge:()=>{throw new Error('unused');}});
  plugins.register({id:'fixture',name:'fixture',capabilities:[],permissions:['contribute:connectors','service.provide:'+service],activate(c){
    const declaration={kind:'subscription-source',service,name:'来源',resourceLabel:'库',triageRules:'插件默认规则'};
    c.contribute('connectors','policy-fixture',declaration);
    declaration.triageRules='注册后的临时修改';
    const listed=contributions.list('connectors').find(entry=>entry.id==='policy-fixture')!.value;
    if(listed && typeof listed==='object' && !Array.isArray(listed)) listed.triageRules='读取方的临时修改';
    c.contribute('services','policy-service',{name:service,readOnly:true,version:1,handler:async()=>({})});
  }});
  plugins.register(host.extension);await plugins.setEnabled('fixture',true);await plugins.setEnabled(host.extension.id,true);
  const svc=host.service();
  const row=svc.create({...request,sourceId:service,destinations:['inbox'],triageRules:'  主人规则  ',fallbackTier:'wait'});
  await svc.pull(row.id,row.version);
  const cleared=svc.update(row.id,{version:row.version,triageRules:'',fallbackTier:'auto'});
  assert.equal(cleared.triageRules,undefined);assert.equal(cleared.fallbackTier,undefined);
  await svc.pull(row.id,cleared.version);
  assert.deepEqual(calls.map(c=>c.policy),[{triageRules:'主人规则',fallbackTier:'wait',due:true},{triageRules:'插件默认规则',due:true}]);
  assert.match(JSON.stringify(calls[0]?.things),/截止时间：2030-01-01T04:00:00.000Z/);
  assert.doesNotMatch(JSON.stringify(calls.map(c=>c.things)),/triageRules|fallbackTier|dueAt|冒充主人/);
  assert.throws(()=>svc.update(row.id,{version:cleared.version,triageRules:'😀'.repeat(4001)}),{status:400});
  assert.throws(()=>svc.update(row.id,{version:cleared.version,fallbackTier:'send'}),{status:400});
  assert.equal(svc.update(row.id,{version:cleared.version,triageRules:'😀'.repeat(4000)}).version,cleared.version+1);
});

test('日期规范化后比较快照，非法时间拒绝；默认设置兼容历史创建指纹',async t=>{
  const {createHash}=await import('node:crypto');
  const store=createStore(':memory:');let dueAt:string|undefined,sends=0;
  const svc=createSourceSubscriptions({store,sources:()=>[source,{...source,id:'snap',mode:'snapshot'}],
    read:async()=>({snapshot:{title:'同一事项',text:'资料',...(dueAt && {dueAt})}}),deliver(){sends++;}});
  t.after(async()=>{await svc.close();store.close();});
  const reqId='11111111-1111-1111-1111-111111111111';
  const legacy={sourceId:source.id,resource:'repo',name:'旧订阅',intervalMinutes:60,destinations:['inbox']};
  const old={...legacy,id:reqId,enabled:true,version:1,nextRunAt:new Date().toISOString()};
  store.put('source.subscriptions',reqId,old);
  store.put('source.subscription-requests',reqId,createHash('sha256').update(JSON.stringify(legacy)).digest('hex'));
  assert.deepEqual(svc.create({...legacy,requestId:reqId,triageRules:'',fallbackTier:'auto'}),old);
  assert.throws(()=>svc.create({...legacy,requestId:reqId,fallbackTier:'action'}),{status:409});
  const row=svc.create({...request,sourceId:'snap',destinations:['inbox']});
  await svc.pull(row.id,1);dueAt='2030-05-01T17:00:00+08:00';await svc.pull(row.id,1);
  dueAt='2030-05-01T09:00:00Z';await svc.pull(row.id,1);assert.equal(sends,2);
  assert.equal(svc.snapshotHistory(row.id).items[0]?.item.dueAt,'2030-05-01T09:00:00.000Z');
  dueAt='2030-02-30T09:00:00Z';await assert.rejects(svc.pull(row.id,1),{status:502});assert.equal(sends,2);
});
