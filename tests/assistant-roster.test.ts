import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../packages/core/src/store.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createAssistantProfile, readWebThreadAssistant } from '../plugins/assistant-profile.ts';
import { eraseWebConversationRegistration,webConversationsExtension } from '../plugins/web-conversations.ts';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';

test('assistant roster binds each scope exactly once across retries and restart, preserves archives and rotates deleted threads',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-roster-'));
  let loseAck=false;
  async function fixture(){
    const store=createStore(join(dir,'test.sqlite'));
    const host=new PluginHost({store,dataDir:dir,events:createEventBus(store),contributions:createContributions()});
    host.register(webConversationsExtension);
    host.register(createAssistantProfile(async input=>{
      const result=await host.invocations.use('web-conversations.manage',input);
      if(loseAck){loseAck=false;throw Error('lost response');}
      return result;
    }));
    await host.start();
    return {store,host,call:(input:JsonObject)=>host.invocations.use('assistant-profile.roster',input),
      close:async()=>{await host.close();store.close();}};
  }
  let env=await fixture();
  t.after(async()=>{await env.close();await rm(dir,{recursive:true,force:true});});
  const a={id:randomUUID(),name:'审校',instructions:'引用合成材料。'};
  const b={id:randomUUID(),name:'审校',instructions:''};
  const open=async(id:string,projectId?:string)=>(await env.call({action:'open',id,...(projectId && {projectId})}) as {threadId:string}).threadId;
  assert.deepEqual(await env.call({action:'list'}),{items:[]});
  assert.deepEqual(await env.call({action:'create',...a}),{...a,revision:0});
  assert.deepEqual(await env.call({action:'create',...a}),{...a,revision:0});
  assert.deepEqual(await env.call({action:'create',...b}),{...b,revision:0});
  await assert.rejects(env.call({action:'create',...a,name:'另一个'}),{status:409});
  await assert.rejects(env.call({action:'create',...a,id:randomUUID(),instructions:'长'.repeat(2001)}),{status:400});
  const projectId='fixture-project';
  env.store.put('projects',projectId,{id:projectId});
  const [first,same,project,another]=await Promise.all([open(a.id),open(a.id),open(a.id,projectId),open(b.id)]);
  assert.equal(first,same);assert.equal(new Set([first,project,another]).size,3);
  assert.deepEqual(readWebThreadAssistant(env.store,project),{...a,revision:0});
  const ordinary=randomUUID();
  await env.host.invocations.use('web-conversations.manage',{action:'create',id:ordinary,title:a.name});
  assert.equal(readWebThreadAssistant(env.store,ordinary),undefined);
  loseAck=true;
  await assert.rejects(open(b.id,projectId),/lost response/);
  const registered=env.store.list<{id:string;projectId?:string}>('web-conversations').find(row=>row.projectId===projectId && row.id!==project)!;
  assert.deepEqual(readWebThreadAssistant(env.store,registered.id),{...b,revision:0});
  await env.close();env=await fixture();
  assert.equal(await open(b.id,projectId),registered.id);
  assert.deepEqual(await env.call({action:'list'}),{items:[{...a,revision:0},{...b,revision:0}]});
  await env.host.invocations.use('web-conversations.manage',{action:'update',id:first,version:1,archived:true});
  assert.equal(await open(a.id),first);
  env.store.transaction(()=>eraseWebConversationRegistration(env.store,first,2));
  assert.equal(readWebThreadAssistant(env.store,first),undefined);
  const replacement=await open(a.id);
  assert.notEqual(replacement,first);
  assert.deepEqual(readWebThreadAssistant(env.store,replacement),{...a,revision:0});
  // Simulate a persisted profile created before revisions were introduced.
  env.store.put('assistant-profile.roster',a.id,a);
  const updated={...a,name:'编辑后的助理',instructions:'新的说明',revision:1};
  assert.deepEqual(await env.call({action:'update',...updated,revision:0}),updated);
  assert.deepEqual(await env.call({action:'update',...updated}),updated);
  await assert.rejects(env.call({action:'update',...a,revision:0}),{status:409});
  await assert.rejects(env.call({action:'update',...a,revision:-1}),{status:400});
  await assert.rejects(env.call({action:'update',...a,id:randomUUID(),revision:0}),{status:404});
  await env.close();env=await fixture();
  assert.deepEqual(await env.call({action:'create',...a}),updated);
  await assert.rejects(env.call({action:'create',...a,name:updated.name,instructions:updated.instructions}),{status:409});
  assert.deepEqual(await env.call({action:'list'}),{items:[updated,{...b,revision:0}]});
  assert.equal(await open(a.id),replacement);
  assert.deepEqual(readWebThreadAssistant(env.store,replacement),updated);
  await env.host.setEnabled('web-conversations',false);
  await assert.rejects(open(a.id),{status:503});
  assert.deepEqual(await env.host.invocations.use('assistant-profile.manage',{action:'read'}),{name:'主 Agent',revision:0});
});
