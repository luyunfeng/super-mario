import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../packages/core/src/store.ts';
import {createEventBus} from '../packages/core/src/events.ts';
import {PluginHost,createContributions} from '../packages/core/src/plugin-host.ts';
import {createConversationSharing} from '../plugins/conversation-sharing.ts';
import type {JsonObject} from '../packages/plugin-sdk/src/index.ts';

test('分享锁定选择、有效期和预览正文，只公开净化的静态摘录，归档后可撤销',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'share-test-')), db=join(dir,'workbench.sqlite');
  function open(){
    const store=createStore(db),host=new PluginHost({store,events:createEventBus(store),contributions:createContributions(),dataDir:dir});
    host.register(createConversationSharing('fix.*[t]$&ure'));
    return {store,host};
  }
  let {store,host}=open();
  t.after(async()=>{await host.close();store.close();await rm(dir,{recursive:true,force:true});});
  await host.start();
  const conversationId='project:p:work', base={conversationId,projectId:'p',status:'done',createdAt:new Date().toISOString()};
  store.put('projects','p',{id:'p'});
  const privateLink='/share#'+'J'.repeat(43);
  const user={...base,id:'u',role:'user',directWebInput:true,text:'第一段 fix.*[t]$&ure '+privateLink};
  const answer={...base,id:'a',role:'assistant',replyTo:'u',text:'第二段',files:[{name:'extra-private-file'}]};
  store.put('messages','u',user);store.put('messages','a',answer);
  const manage=(action:string,input:JsonObject={})=>host.invocations.use('conversation-sharing.manage',{conversationId,...input,action});
  const read=(token:string)=>host.invocations.use('conversation-sharing.read',{token});
  const selection={messageIds:['u','a'],expireHours:1};
  const preview=await manage('preview',selection) as {messages:{role:string;text:string}[];previewHash:string};
  assert.deepEqual(preview.messages,[{role:'user',text:'第一段 [凭证已隐藏] /share#[凭证已隐藏]'},{role:'assistant',text:'第二段'}]);
  const create=()=>manage('create',{...selection,previewHash:preview.previewHash});
  await assert.rejects(manage('create',{...selection,expireHours:2,previewHash:preview.previewHash}),{status:409});
  store.put('messages','a',{...answer,text:'另一段'});
  await assert.rejects(create(),{status:409});
  store.put('messages','a',answer);
  const result=await create() as {id:string;expiresAt:string;token:string};
  assert.doesNotMatch(JSON.stringify(await manage('list')),new RegExp(result.token));
  for (const name of ['shares','snapshots','tokens']) {
    assert.ok(!JSON.stringify(store.entries!('conversation-sharing.'+name)).includes(result.token));
  }
  await host.close();store.close();({store,host}=open());await host.start();
  const expiring=await create() as {id:string;token:string};
  const receipt=store.get<JsonObject>('conversation-sharing.shares',expiring.id)!;
  store.put('conversation-sharing.shares',expiring.id,{...receipt,expiresAt:new Date(Date.now()-1).toISOString()});
  await assert.rejects(read(expiring.token),{status:404});
  store.put('messages','a',{...answer,text:'修改后的文本'});
  assert.deepEqual(await read(result.token),{messages:preview.messages,expiresAt:result.expiresAt});
  await host.setEnabled('conversation-sharing',false);
  await assert.rejects(read(result.token));
  await host.setEnabled('conversation-sharing',true);
  store.put('message.routes','u',{channel:'feishu'});
  await assert.rejects(read(result.token),{status:404});store.remove('message.routes','u');
  store.put('projects','p',{id:'p',archivedAt:base.createdAt});
  await assert.rejects(read(result.token),{status:404});
  await manage('revoke',{id:result.id});
  store.put('projects','p',{id:'p'});
  await assert.rejects(read(result.token),{status:404});
  for (const [id,props] of Object.entries({internal:{directWebInput:undefined},failed:{status:'failed'},withdrawn:{queueState:'withdrawn'},cancelled:{queueState:'cancelled'},notice:{origin:'notification'},other:{conversationId:'main'},forged:{role:'assistant',replyTo:'internal'}})){
    store.put('messages',id,{...user,...props,id});
    await assert.rejects(manage('preview',{messageIds:[id]}),{status:404});
  }
  await assert.rejects(manage('preview',{messageIds:['u','u']}),{status:400});
  await assert.rejects(manage('preview',{messageIds:['u'],conversationId:'bot:private'}),{status:404});
  await assert.rejects(create(),{status:409});
});
