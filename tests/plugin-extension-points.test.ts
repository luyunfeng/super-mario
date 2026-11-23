import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { PluginHost, createContributions } from '../packages/core/src/plugin-host.ts';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { assertJson } from '../packages/plugin-sdk/src/index.ts';
import type { Extension, ExtensionContext, JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { catalog, consumer } from '../plugins/examples/extension-points.ts';
import { loadExtensions } from '../packages/core/src/extension-loader.ts';
async function fixture(t: test.TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'mario-plugin-api-')), store=createStore(':memory:'), contributions=createContributions();
  const host=new PluginHost({store,contributions,dataDir:dir,events:createEventBus(store)});
  t.after(async()=>{await host.close();store.close();await rm(dir,{recursive:true,force:true});});
  return {dir,store,host,contributions};
}
test('plugin-owned point, JSON service and ordered wrapper work and follow dependency lifecycle',async t=>{
  const f=await fixture(t);f.host.register(consumer);f.host.register(catalog);await f.host.start();
  assert.deepEqual(f.contributions.list('example.catalog.labels')[0].value,{label:'通过插件声明的扩展点'});
  assert.deepEqual(await f.host.invocations.use('example.catalog.echo',{text:'hello'}),{text:'wrapped:hello',wrapped:true});
  await f.host.setEnabled('example.catalog',false);
  assert.equal(f.contributions.points().some(p=>p.id==='example.catalog.labels'),false);assert.equal(f.contributions.list('service_wrappers').length,0);
  await assert.rejects(f.host.invocations.use('example.catalog.echo',{}),/unavailable/);
  await f.host.setEnabled('example.catalog',true);assert.equal(f.contributions.list('example.catalog.labels').length,1);
});
test('hooks are ordered, may deny, time out closed, and removed hooks cannot run',async t=>{
  const f=await fixture(t);const order:number[]=[];
  f.host.register({id:'audit',name:'Audit',capabilities:[],activate(c){
    c.hook('work.dispatch','before',value=>{order.push(2);return{action:'continue',value:{...(value as JsonObject),prompt:'changed'}};},{order:2});
    c.hook('work.dispatch','before',()=>{order.push(1);},{order:1});
  }});await f.host.start();let calls=0;
  const value=await f.host.invocations.invoke('work.dispatch',{prompt:'initial'},async v=>{calls++;return v;});assert.deepEqual(value,{prompt:'changed'});assert.deepEqual(order,[1,2]);assert.equal(calls,1);
  f.host.register({id:'deny',name:'Deny',capabilities:[],activate(c){c.hook('work.dispatch','before',()=>({action:'deny',reason:'rejected'}),{order:-1});}});await f.host.start();
  await assert.rejects(f.host.invocations.invoke('work.dispatch',{},async()=>{calls++;return null;}),/rejected/);assert.equal(calls,1);await f.host.setEnabled('deny',false);
  f.host.register({id:'slow',name:'Slow',capabilities:[],activate(c){c.hook('work.dispatch','before',()=>new Promise(()=>{}),{order:-1,timeoutMs:10});}});await f.host.start();
  await assert.rejects(f.host.invocations.invoke('work.dispatch',{},async()=>{calls++;return null;}),/timed out/);assert.equal(calls,1);
});
test('JSON boundary rejects functions/classes/cycles; registration only allows named callbacks and permissions are enforced',async t=>{
  const f=await fixture(t);class Data { text='not transport'; }
  for(const value of [{fn:()=>{}},new Data(),{date:new Date()},NaN])assert.throws(()=>assertJson(value),/JSON/);
  const cycle:any={};cycle.self=cycle;assert.throws(()=>assertJson(cycle),/cycle/);
  assert.throws(()=>f.contributions.add('unknown.point','x',{}),/Undeclared/);
  let context!:ExtensionContext;
  f.host.register({id:'restricted',name:'Restricted',capabilities:[],permissions:[],activate(c){context=c;}});await f.host.start();
  assert.throws(()=>context.store.put('x','x',{}),/requires store.write/);
  assert.throws(()=>context.hook('work.dispatch','before',()=>{}),/requires hook/);
  f.host.register({id:'bad-json',name:'Bad',capabilities:[],extensionPoints:[{id:'bad-json.data',version:1}],activate(c){c.contribute('bad-json.data','invalid',{fn:()=>{}} as any);}});await f.host.start();
  assert.equal(f.host.list().find(p=>p.id==='bad-json')?.status,'failed');assert.equal(f.contributions.points().some(p=>p.id==='bad-json.data'),false);
  assert.throws(()=>f.contributions.add('tools','bad',{name:'bad',parameters:{x:()=>{}},execute:async()=>null}as any),/JSON/);
});
test('plugins with store permissions cannot read or change administrator credentials',async t=>{
  const f=await fixture(t);
  let context!:ExtensionContext;
  f.host.register({id:'store-client',name:'Store client',capabilities:[],permissions:['store.read','store.write'],activate(c){context=c;}});
  await f.host.start();
  for(const collection of ['core.admin-auth.sessions','browser-devices.credentials']){
    f.store.put(collection,'sample',{synthetic:true});
    for (const operation of [
      ()=>context.store.get(collection,'sample'), ()=>context.store.list(collection),
      ()=>context.store.put(collection,'sample',{}), ()=>context.store.remove(collection,'sample'),
    ]) assert.throws(operation,/Reserved host collection/);
    assert.deepEqual(f.store.get(collection,'sample'),{synthetic:true});
  }
});
test('wrappers cannot call downstream twice or after timing out; after failures report unknown',async t=>{
  const f=await fixture(t);let calls=0;let delayed: (()=>Promise<unknown>)|undefined;
  f.host.register({id:'service',name:'Service',capabilities:[],activate(c){c.provide('service.echo',()=>{calls++;return 'ok';});c.wrap('service.echo',async(i,next)=>{await next(i);return next(i);});c.hook('knowledge.put','after',()=>{throw new Error('after failed');});}});await f.host.start();
  await assert.rejects(f.host.invocations.use('service.echo',{}),/only once/);assert.equal(calls,1);
  await assert.rejects(f.host.invocations.invoke('knowledge.put',{},async()=>({})),(e:any)=>e.delivery==='unknown');
  await f.host.setEnabled('service',false);
  f.host.register({id:'late',name:'Late',capabilities:[],activate(c){c.provide('late.echo',()=>{calls++;return'ok';});c.wrap('late.echo',async(i,next)=>{delayed=()=>next(i);return new Promise(()=>{});},{timeoutMs:10});}});await f.host.start();
  await assert.rejects(f.host.invocations.use('late.echo',{}),/timed out/);await assert.rejects(delayed!(),/timeout/);assert.equal(calls,1);
});
test('real work dispatch and knowledge writes pass through plugin hooks before performing work',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-core-hooks-'));const app=await createWorkbench({host:'127.0.0.1',port:0,dataDir:dir,demo:true});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  let calls=0;
  app.plugins.register({id:'policy',name:'Policy',capabilities:[],activate(c){c.hook('work.dispatch','before',()=>({action:'deny',reason:'blocked before CLI'}));c.hook('knowledge.put','before',()=>({action:'deny',reason:'blocked before write'}));}});await app.plugins.start();
  app.plugins.register({id:'executor',name:'Executor',capabilities:[],activate(c){c.contribute('executors','custom',{id:'custom',name:'Custom',kind:'test',machineId:'local',available:true,mode:'real',description:'test',execute:async()=>{calls++;return{text:'should not run'};}});}});await app.plugins.start();
  const run=app.dispatch({executorId:'custom',prompt:'test',doneWhen:'verify',expectMinutes:1});
  for(let i=0;i<100&&app.store.get<any>('runs',run.id)?.status!=='failed';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(app.store.get<any>('runs',run.id).status,'failed');assert.equal(calls,0);
  await assert.rejects(app.knowledge().put({layer:'personal',title:'Denied',content:'no write'}),/blocked before write/);assert.equal((await app.knowledge().list()).length,0);
});
test('manifest declares plugin points before activation and consumer can contribute without editing core',async t=>{
  const f=await fixture(t);const folder=join(f.dir,'extensions','manifest');await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'super-mario.extension.json'),JSON.stringify({id:'manifest',version:'1.0.0',apiVersion:1,main:'entry.mjs',extensionPoints:[{id:'manifest.labels',version:1}]}));
  await writeFile(join(folder,'entry.mjs'),`export default {id:'manifest',name:'Manifest',capabilities:[],activate(ctx){ctx.contribute('manifest.labels','label',{title:'valid'});}};`);
  for(const item of await loadExtensions(f.dir))f.host.register(item.extension,item.config);await f.host.start();assert.deepEqual(f.contributions.list('manifest.labels')[0].value,{title:'valid'});
});

test('inspections retain local manifest evidence and report safe live dependency and lifecycle status', async t => {
  const { dir, host } = await fixture(t);
  const manifests = {
    local: { version: '3.2.1-beta.1', dependencies: ['builtin'], permissions: [] },
    broken: { version: '2.0.0', main: 'nonexistent.mjs' },
    invalid: { version: 'not-semver' },
  };
  for (const [id, fields] of Object.entries(manifests)) {
    const folder = join(dir, 'extensions', id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'super-mario.extension.json'), JSON.stringify({ id, main: 'entry.mjs', apiVersion: 1, ...fields }));
  }
  await writeFile(join(dir, 'extensions', 'local', 'entry.mjs'), "export default {id:'local',name:'Local',version:'untrusted',capabilities:['read'],activate(){}};");
  for (const item of await loadExtensions(dir)) host.register(item.extension, item.config, item.origin);
  host.register({ id: 'builtin', name: 'Builtin', capabilities: [], activate() {} });
  host.register({ id: 'missing-dep', name: 'Missing', dependencies: ['uninstalled'], capabilities: [], activate() {} });
  host.register({ id: 'exception', name: 'Exception', capabilities: [], activate() { throw Error('synthetic-private-error'); } });
  await host.start();
  const inspect = (id: string) => host.inspections('4.0.0').find(item => item.id === id)!;
  assert.deepEqual(inspect('local'), {
    id: 'local', name: 'Local', source: 'local', version: '3.2.1-beta.1', enabled: true, status: 'active',
    capabilities: ['read'], permissions: [], dependencies: [{ id: 'builtin', status: 'active' }],
  });
  assert.equal(inspect('builtin').source, 'builtin');
  assert.equal(inspect('builtin').version, '4.0.0');
  assert.equal(inspect('builtin').permissions, null);
  assert.equal(inspect('broken').version, '2.0.0');
  assert.equal(inspect('broken').reason, '本地插件入口加载或校验失败');
  assert.equal(inspect('invalid').version, null);
  assert.equal(inspect('invalid').reason, '本地插件清单读取或校验失败');
  assert.equal(inspect('exception').reason, '插件启动失败');
  assert.deepEqual(inspect('missing-dep').dependencies, [{ id: 'uninstalled', status: 'missing' }]);
  await host.setEnabled('builtin', false);
  assert.equal(inspect('local').status, 'waiting');
  assert.equal(inspect('local').reason, '等待依赖插件就绪');
  assert.deepEqual(inspect('local').dependencies, [{ id: 'builtin', status: 'disabled' }]);
  assert.doesNotMatch(JSON.stringify(host.inspections('4.0.0')), /synthetic-private-error|nonexistent\.mjs|mario-plugin-api/);
});
