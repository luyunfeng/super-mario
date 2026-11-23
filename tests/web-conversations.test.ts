import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEventBus } from '../packages/core/src/events.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import { createStore } from '../packages/core/src/store.ts';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { eraseWebConversationRegistration, webConversationMatches, webConversationsExtension } from '../plugins/web-conversations.ts';

test('independent web conversations persist exact scopes and idempotent creation through plugin lifecycle', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-web-conversations-'));
  const open = async () => {
    const store = createStore(join(dir, 'test.sqlite')), events = createEventBus(store);
    const host = new PluginHost({ store, events, dataDir: dir, contributions: createContributions() });
    host.register(webConversationsExtension);
    await host.start();
    return { store, events, host, close: async () => { await host.close(); store.close(); } };
  };
  let f = await open();
  t.after(async () => { await f.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = (input: JsonObject) => f.host.invocations.use('web-conversations.manage', input);
  for (const id of ['p','q']) f.store.put('projects', id, { id });
  const id = randomUUID(), request = { action:'create', id, title:'测试' };
  const [a,b] = await Promise.all([call(request),call(request)]);
  assert.deepEqual(a,b);
  assert.equal(f.events.since(0).filter(event => event.type === 'web-conversations.changed').length, 1);
  await assert.rejects(call({...request,title:'改名'}),{status:409});
  await assert.rejects(call({...request,projectId:'p'}),{status:409});
  const pid = randomUUID();
  const projectRow = await call({action:'create',id:pid,projectId:'p'});
  assert.deepEqual(await call({action:'list'}),{items:[a]});
  assert.deepEqual(await call({action:'list',projectId:'p'}),{items:[projectRow]});
  assert.deepEqual(await call({action:'get',id:pid}),projectRow);
  const other=randomUUID();
  await call({action:'create',id:other,title:'测试'});
  const message={id:'recent',role:'user',text:'合成  最近输入',conversationId:'web:'+id,directWebInput:true,createdAt:'2099-01-02T00:00:00.000Z'};
  f.store.put('messages',message.id,message);
  f.store.put('messages','unrelated',{...message,id:'unrelated',projectId:'p',text:'其他范围',createdAt:'2099-02-01T00:00:00.000Z'});
  const recent=await call({action:'list'}) as {items:{id:string;lastInputText?:string}[]};
  assert.deepEqual(recent.items.map(row=>[row.id,row.lastInputText]),[[id,'合成 最近输入'],[other,undefined]]);
  assert.equal(webConversationMatches(f.store,pid,'p'),true);
  assert.equal(webConversationMatches(f.store,pid),false);
  assert.equal(webConversationMatches(f.store,id),true);
  await assert.rejects(call({action:'get',id:pid,projectId:'q'}),{status:404});
  await assert.rejects(call({action:'create',id:'main'}),{status:400});
  await assert.rejects(call({action:'create',id:randomUUID(),projectId:'missing'}),{status:404});
  await f.close();
  f = await open();
  assert.deepEqual(await call(request),a);
  f.store.put('projects','p',{id:'p',archivedAt:new Date().toISOString()});
  assert.equal(webConversationMatches(f.store,pid,'p'),false);
  for (const input of [{action:'get',id:pid},{action:'list',projectId:'p'},{action:'create',id:pid,projectId:'p'}] as JsonObject[])
    await assert.rejects(call(input),{status:409});
  await f.host.setEnabled('web-conversations',false);
  await assert.rejects(call({action:'list'}),/unavailable/);
});

test('legacy conversation rename, archive and restore use exact versions and preserve original create receipts', async t => {
  const store = createStore(':memory:'), events = createEventBus(store);
  const host = new PluginHost({store, events, dataDir:'', contributions:createContributions()});
  t.after(async () => { await host.close(); store.close(); });
  host.register(webConversationsExtension);
  await host.start();
  const id=randomUUID(), legacy={id,title:'Original',createdAt:new Date().toISOString()};
  store.put('web-conversations',id,legacy);
  const use=(args:JsonObject)=>host.invocations.use('web-conversations.manage',args);
  const original={...legacy,version:1,archived:false};
  assert.deepEqual(await use({action:'get',id}),original);
  assert.deepEqual(await use({action:'update',id,version:1,title:'Original'}),original);
  const edited={...original,title:'Renamed',version:2};
  assert.deepEqual(await use({action:'update',id,version:1,title:'Renamed'}),edited);
  assert.deepEqual(await use({action:'create',id,title:'Original'}),edited);
  await assert.rejects(use({action:'create',id,title:'Renamed'}),{status:409});
  await assert.rejects(use({action:'update',id,version:1,archived:true}),{status:409});
  store.put('messages','wait',{role:'user',conversationId:'web:'+id,status:'pending'});
  await assert.rejects(use({action:'update',id,version:2,archived:true}),{status:409});
  assert.deepEqual(await use({action:'list'}),{items:[edited]});
  store.put('messages','wait',{role:'user',conversationId:'web:'+id,status:'done'});
  store.put('messages','other',{role:'user',conversationId:'web:'+randomUUID(),status:'pending'});
  const archived={...edited,archived:true,version:3};
  assert.deepEqual(await use({action:'update',id,version:2,archived:true}),archived);
  assert.deepEqual(await use({action:'list'}),{items:[]});
  assert.deepEqual(await use({action:'list',archived:true}),{items:[archived]});
  assert.deepEqual(await use({action:'get',id}),archived);
  assert.equal(webConversationMatches(store,id),false);
  assert.deepEqual(await use({action:'update',id,version:3,archived:false}),{...edited,version:4});
  assert.equal(webConversationMatches(store,id),true);
  assert.equal(events.since(0).filter(event=>event.type==='web-conversations.changed').length,3);
});


test('host deletion participates in rollback and freezes the original version without retaining text', async t => {
  const store = createStore(':memory:');
  const host = new PluginHost({store, events:createEventBus(store), dataDir:'', contributions:createContributions()});
  t.after(async () => { await host.close(); store.close(); });
  host.register(webConversationsExtension);
  await host.start();
  const use = (input:JsonObject) => host.invocations.use('web-conversations.manage',input);
  const erase = (id:string,version:number) => store.transaction(()=>eraseWebConversationRegistration(store,id,version));
  assert.throws(()=>erase('main',1),{status:400});
  assert.throws(()=>erase(randomUUID(),0),{status:400});
  assert.throws(()=>erase(randomUUID(),1),{status:404});
  for (const archived of [false,true]) {
    const id=randomUUID(),version=archived?2:1;
    const create={action:'create',id,title:'Private title'};
    await use(create);
    if(archived) await use({action:'update',id,version:1,archived});
    await assert.rejects(use({action:'delete',id,version}),{status:400});
    assert.throws(()=>erase(id,version+1),{status:409});
    assert.throws(()=>store.transaction(()=>{
      eraseWebConversationRegistration(store,id,version);
      throw Error('cleanup failed');
    }),/cleanup failed/);
    assert.ok(store.get('web-conversations',id));
    assert.equal(store.get('web-conversations.deleted',id),undefined);
    erase(id,version);
    assert.deepEqual(store.get('web-conversations.deleted',id),{id,version,cleanupPending:true});
    assert.equal(store.get('web-conversations',id),undefined);
    assert.equal(webConversationMatches(store,id),false);
    for(const input of [create,{action:'get',id},{action:'update',id,version,title:'Other title'}] as JsonObject[])
      await assert.rejects(use(input),{status:410});
    assert.deepEqual(await use({action:'list',archived}),{items:[]});
    store.put('web-conversations.deleted',id,{id,version,cleanupPending:false});
    erase(id,version);
    assert.deepEqual(store.get('web-conversations.deleted',id),{id,version,cleanupPending:false});
    assert.throws(()=>erase(id,version+1),{status:409});
  }
});
