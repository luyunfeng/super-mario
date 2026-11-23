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
  assert.deepEqual(await read(result.token),{messages:preview.messages,expiresAt:result.expiresAt,revision:1});
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

test('同一链接编辑保留既有快照，以版本和预览签名原子替换',async t=>{
  const store=createStore(':memory:'), host=new PluginHost({store,events:createEventBus(store),contributions:createContributions(),dataDir:':memory:'});
  t.after(async()=>{await host.close();store.close();});
  host.register(createConversationSharing());await host.start();
  const manage=(action:string,input:JsonObject={})=>host.invocations.use('conversation-sharing.manage',{action,conversationId:'main',...input}) as Promise<JsonObject>;
  const message=(id:string,text:string)=>store.put('messages',id,{id,text,role:'user',directWebInput:true,conversationId:'main',status:'done'});
  message('one','原有摘录');message('two','新消息');message('three','移除的消息');
  const initial={expireHours:2,messageIds:['one','three']};
  const created=await manage('create',{...initial,previewHash:(await manage('preview',initial)).previewHash!});
  const id=String(created.id);
  const prior=store.get<JsonObject>('conversation-sharing.shares',id)!;
  delete prior.revision;store.put('conversation-sharing.shares',id,prior);
  const read=(knownRevision?:number)=>host.invocations.use('conversation-sharing.read',{token:created.token!,...(knownRevision && {knownRevision})});
  message('one','改写的原消息');
  const edit={id,revision:1,messageIds:['two','one']};
  assert.deepEqual((await manage('detail',{id})),{id,revision:1,showTools:false,includeFuture:false,messageIds:initial.messageIds,expiresAt:created.expiresAt,messages:[{role:'user',text:'原有摘录'},{role:'user',text:'移除的消息'}]});
  const preview=await manage('preview',edit);
  const update=()=>manage('update',{...edit,previewHash:preview.previewHash!});
  await assert.rejects(manage('update',{...edit,expireHours:48,previewHash:preview.previewHash!}),{status:409});
  store.put('message.routes','two',{channel:'feishu'});
  await assert.rejects(update(),{status:404});
  store.remove('message.routes','two');
  message('two','新增正文已变化');
  await assert.rejects(update(),{status:409});
  assert.deepEqual(await read(1),{unchanged:true,expiresAt:created.expiresAt,revision:1});
  message('two','新消息');message('one','再改写，原摘录仍有效');
  assert.deepEqual(await update(),{id,revision:2,expiresAt:created.expiresAt});
  assert.deepEqual(await read(1),{revision:2,expiresAt:created.expiresAt,messages:[{role:'user',text:'新消息'},{role:'user',text:'原有摘录'}]});
  assert.deepEqual(await read(2),{unchanged:true,expiresAt:created.expiresAt,revision:2});
  await assert.rejects(update(),{status:409});
  await assert.rejects(manage('revoke',{id,revision:1}),{status:409});
  const renew={...edit,revision:2,expireHours:100};
  const updated=await manage('update',{...renew,previewHash:(await manage('preview',renew)).previewHash!});
  assert.ok(String(updated.expiresAt)>String(created.expiresAt));
  store.put('message.routes','one',{channel:'feishu'});
  await assert.rejects(read(3),{status:404});
  await assert.rejects(manage('detail',{id}),{status:404});
  store.remove('message.routes','one');
  const row=store.get<JsonObject>('conversation-sharing.shares',id)!;
  store.put('conversation-sharing.shares',id,{...row,expiresAt:new Date(0).toISOString()});
  await assert.rejects(manage('preview',{...renew,revision:3}),{status:404});
  store.put('conversation-sharing.shares',id,row);
  await manage('revoke',{id,revision:3});
  await assert.rejects(manage('detail',{id}),{status:404});
  await assert.rejects(read(3),{status:404});
});

test('分享工具按原回合投影并冻结，修改开关即更新同一链接',async t=>{
  const store=createStore(':memory:'),host=new PluginHost({store,events:createEventBus(store),contributions:createContributions(),dataDir:':memory:'});
  t.after(async()=>{await host.close();store.close();});
  host.register(createConversationSharing());await host.start();
  const base={conversationId:'main',status:'done'};
  store.put('messages','u',{...base,id:'u',role:'user',directWebInput:true,text:'请找公开词'});
  store.put('messages','a',{...base,id:'a',role:'assistant',replyTo:'u',text:'助手正文'});
  const wrap=(details:object)=>JSON.stringify({details,content:[{type:'text',text:JSON.stringify(details)}]});
  const trace={...base,id:'a',userMessageId:'u',thinkingBlocks:['隐藏推理'],toolCalls:[
    {name:'current_web_message_search',args:JSON.stringify({query:'公开词',category:'text',before:'隐藏游标'}),result:wrap({hits:[{text:'隐藏的其他消息'}]}),isError:false},
    {name:'conversation_status',args:'隐藏入参',result:wrap({phase:'working',info:'隐藏字段'}),isError:false},
    {name:'office_create',args:'隐藏文件',result:'隐藏原始错误',isError:true},
    {name:'current_web_message_search',args:JSON.stringify({query:'隐藏检索词',category:'text'})},
    ...Array.from({length:17},()=>({name:'extra',args:'隐藏信息'})),
  ]};
  const save=(value:unknown)=>store.put('agent.traces','a',value);
  save(trace);
  const manage=(action:string,input:JsonObject={})=>host.invocations.use('conversation-sharing.manage',{action,conversationId:'main',...input}) as Promise<JsonObject>;
  const baseInput={messageIds:['u','a']};
  const preview=(input:JsonObject={})=>manage('preview',{...baseInput,...input});
  const plain=await preview(),input={...baseInput,showTools:true};
  assert.ok(!JSON.stringify(plain).includes('tools'));
  await assert.rejects(manage('create',{...input,previewHash:plain.previewHash!}),{status:409});
  for(const change of [{id:'wrong'},{conversationId:'bot:private'},{projectId:'p'},{userMessageId:'wrong'}]){
    save({...trace,...change});assert.ok(!JSON.stringify(await preview(input)).includes('tools'));
  }
  save(trace);
  const projected=await preview(input);
  assert.ok(!JSON.stringify(projected).includes('隐藏'));
  type Tool={name:string;args?:string;result?:string;status:string};
  const tools=(projected.messages as {tools?:Tool[]}[])[1]!.tools!;
  assert.equal(tools.length,21);
  assert.deepEqual(tools.slice(0,4),[
    {name:'current_web_message_search',status:'succeeded',args:JSON.stringify({query:'公开词',category:'text'})},
    {name:'conversation_status',status:'succeeded',result:JSON.stringify({phase:'working'})},
    {name:'office_create',status:'failed'},
    {name:'current_web_message_search',status:'unknown',args:JSON.stringify({category:'text'})},
  ]);
  save({...trace,toolCalls:Array.from({length:7000},()=>({name:'synthetic_long_tool_record'}))});
  await assert.rejects(preview(input),{status:400});
  assert.deepEqual(await preview(),plain);
  save({...trace,toolCalls:[]});await assert.rejects(manage('create',{...input,previewHash:projected.previewHash!}),{status:409});
  save(trace);
  const created=await manage('create',{...input,previewHash:projected.previewHash!}),id=created.id!;
  const read=()=>host.invocations.use('conversation-sharing.read',{token:created.token!});
  const edit=async(props:JsonObject)=>manage('update',{...baseInput,...props,id,previewHash:(await preview({...props,id})).previewHash!});
  assert.equal((await manage('detail',{id})).showTools,true);
  await host.setEnabled('conversation-sharing',false);await assert.rejects(read());await host.setEnabled('conversation-sharing',true);
  save({...trace,toolCalls:[{name:'new_tool'}]});
  await edit({revision:1,messageIds:['a']});
  assert.ok(JSON.stringify(await read()).includes('office_create'));
  assert.ok(!JSON.stringify(await read()).includes('公开词'));
  await edit({revision:2,showTools:false});
  assert.ok(!JSON.stringify(await read()).includes('tools'));
  await edit({revision:3,showTools:true});
  assert.ok(JSON.stringify(await read()).includes('new_tool'));
  assert.ok(!JSON.stringify(await read()).includes('office_create'));
});

test('后续分享核对插入顺序和范围，重启处理未完输入，恢复发布跳过停用空档',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'share-follow-')),db=join(dir,'store.sqlite');
  const open=()=>{
    const store=createStore(db),events=createEventBus(store);
    const host=new PluginHost({store,events,contributions:createContributions(),dataDir:dir});
    host.register(createConversationSharing());return {store,events,host};
  };
  let {store,events,host}=open();
  t.after(async()=>{await host.close();store.close();await rm(dir,{recursive:true,force:true});});
  await host.start();
  function put(id:string,props:JsonObject={}) {
    store.put('messages',id,{id,conversationId:'main',status:'done',role:'user',text:id,directWebInput:true,
      createdAt:'2001-01-01T00:00:00Z',...props});
    events.publish('messages.changed',{conversationId:'main',messageId:id});
  }
  const answer=(id:string,replyTo:string)=>put(id,{role:'assistant',replyTo});
  put('opening');put('old-pending',{status:'pending'});
  const manage=(action:string,input:JsonObject)=>host.invocations.use('conversation-sharing.manage',{action,conversationId:'main',...input}) as Promise<JsonObject>;
  const publish=async(props:JsonObject,create=false)=>manage(create?'create':'update',{...props,previewHash:(await manage('preview',props)).previewHash!});
  const created=await publish({messageIds:['opening'],includeFuture:true,futureScope:{}},true),id=String(created.id);
  const read=(revision?:number)=>host.invocations.use('conversation-sharing.read',{token:created.token!,...(revision && {knownRevision:revision})}) as Promise<JsonObject>;
  const detail=()=>manage('detail',{id});
  store.put('projects','private-project',{id:'private-project'});
  store.put('todos','todo-private',{id:'todo-private'});put('todo-only',{todoId:'todo-private'});
  store.put('message.routes','routed',{channel:'feishu'});put('routed');answer('routed-answer','routed');
  store.remove('message.routes','routed');
  put('project-only',{projectId:'private-project'});put('bot-only',{conversationId:'bot:test'});
  put('old-pending');answer('old-answer','old-pending');
  put('untrusted',{directWebInput:false});answer('internal-answer','untrusted');
  assert.deepEqual(await read(1),{unchanged:true,expiresAt:created.expiresAt,revision:1,publicationStatus:'live'});
  store.put('message.routes','opening',{channel:'feishu'});put('during-source-loss');
  await assert.rejects(read(),{status:404});store.remove('message.routes','opening');
  assert.deepEqual((await detail()).messageIds,['opening']);
  put('new-pending',{status:'pending',queueState:'queued'});
  put('new-pending',{status:'pending',queueState:'running'});
  assert.equal((await read(1)).unchanged,true);
  await host.close();store.close();({store,events,host}=open());await host.start();
  put('new-pending');answer('first-answer','new-pending');
  assert.deepEqual((await detail()).messageIds,['opening','new-pending','first-answer']);
  put('new-pending',{text:'此后改写的文字'});
  assert.deepEqual((await read(1)).messages,[{role:'user',text:'opening'},{role:'user',text:'new-pending'},{role:'assistant',text:'first-answer'}]);
  const first=await detail();
  await assert.rejects(manage('preview',{id,revision:first.revision!,messageIds:first.messageIds!,futureScope:{projectId:'private-project'}}),{status:409});
  await publish({id,revision:first.revision!,messageIds:first.messageIds!,includeFuture:false});
  put('paused');assert.equal((await read()).publicationStatus,'frozen');
  const frozen=await detail();
  await publish({id,revision:frozen.revision!,messageIds:frozen.messageIds!,includeFuture:true});
  answer('paused-answer','paused');put('before-plugin-off',{status:'pending'});
  await host.setEnabled('conversation-sharing',false);
  put('plugin-off');await host.setEnabled('conversation-sharing',true);
  answer('plugin-off-answer','plugin-off');put('before-plugin-off');
  put('after-plugin-on');answer('new-answer','after-plugin-on');
  const final=await detail();
  assert.deepEqual(final.messageIds,['opening','new-pending','first-answer','after-plugin-on','new-answer']);
  const scoped=await publish({messageIds:['todo-only'],includeFuture:true,futureScope:{todoId:'todo-private'}},true);
  put('todo-append',{todoId:'todo-private'});
  assert.deepEqual((await manage('detail',{id:scoped.id!})).messageIds,['todo-only','todo-append']);
  assert.deepEqual((await detail()).messageIds,final.messageIds);
  put('too-large',{text:'大'.repeat(90000)});
  assert.equal((await read()).publicationStatus,'paused');
  const paused=await detail();
  assert.equal(paused.includeFuture,false);assert.match(String(paused.pauseReason),/256 KiB/);
  assert.deepEqual(paused.messageIds,final.messageIds);
  const ids=['opening'];
  for(let i=1;i<99;i++){const key='s'+i;put(key);ids.push(key);}
  const large=await publish({messageIds:ids,includeFuture:true,futureScope:{}},true);
  put('hundred');put('over-one-hundred');
  const capped=await manage('detail',{id:large.id!});
  assert.equal((capped.messageIds as string[]).length,100);
  assert.equal((capped.messageIds as string[]).at(-1),'hundred');
  assert.match(String(capped.pauseReason),/100/);
});

test('原生分享独立核对选中指纹，离线仍可读、缩减、撤销，执行机原文不会写成 Web 发言',async t=>{
  const store=createStore(':memory:'),host=new PluginHost({store,events:createEventBus(store),contributions:createContributions(),dataDir:':memory:'});
  t.after(async()=>{await host.close();store.close();});
  const native={machineId:'machine-demo',executorId:'codex',nativeSessionId:'session-demo',cwd:'/synthetic/source'};
  const messages=Array.from({length:26},(_,index)=>({id:(index+1).toString(16).padStart(64,'0'),index,role:index%2?'assistant' as const:'user' as const,text:'正文'+index}));
  messages[0]!.text='用户原话 local-fixture-secret';
  let online=true,calls=0,waitForRead:(()=>Promise<void>)|undefined;
  host.register(createConversationSharing('local-fixture-secret',async(source,selection)=>{
    calls++;assert.deepEqual(source,native);
    if (waitForRead) await waitForRead();
    if (!online) throw Object.assign(Error('执行机离线'),{status:503});
    return {items:'offset' in selection ? messages.slice(selection.offset,selection.offset+25) :
      messages.filter(m=>selection.ids.includes(m.id)),total:messages.length};
  }));
  await host.start();
  const use=(name:string,body:JsonObject)=>host.invocations.use('conversation-sharing.'+name,body) as Promise<JsonObject>;
  const manage=(action:string,input:JsonObject={})=>use('manage',{action,native,...input});
  const list=()=>use('manage',{action:'native_sources'});
  assert.deepEqual(await list(),{sources:[]});
  assert.equal(((await manage('catalog')).items as unknown[]).length,25);
  assert.deepEqual((await manage('catalog',{offset:25})).items,[messages[25]]);
  const ids=messages.slice(0,2).map(row=>row.id),selection={messageIds:ids};
  const before=calls,preview=await manage('preview',selection);
  assert.deepEqual(preview.messages,[{role:'user',text:'用户原话 [凭证已隐藏]'},{role:'assistant',text:'正文1'}]);
  messages[1]!.text='读取期间有变动';
  await assert.rejects(manage('create',{...selection,previewHash:preview.previewHash!}),{status:409});
  messages[1]!.text='正文1';
  const created=await manage('create',{...selection,previewHash:preview.previewHash!}),id=created.id!;
  assert.equal(calls,before+3);
  let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;});
  waitForRead=()=>{entered();return new Promise<void>(resolve=>{release=resolve;});};
  const stale=manage('create',{...selection,previewHash:preview.previewHash!});
  await waiting;await host.setEnabled('conversation-sharing',false);await host.setEnabled('conversation-sharing',true);
  release();await assert.rejects(stale,{status:503});waitForRead=undefined;
  assert.equal(((await manage('list')).shares as unknown[]).length,1);
  assert.deepEqual(await list(),{sources:[native]});
  assert.deepEqual(await manage('list',{native:{...native,cwd:'/other'}}),{shares:[]});
  await assert.rejects(manage('detail',{id,native:{...native,machineId:'other'}}),{status:404});
  for (const invalid of [{showTools:true},{includeFuture:true},{futureScope:{}},{conversationId:'main'}] as JsonObject[])
    await assert.rejects(manage('preview',{...selection,...invalid}),{status:400});
  await assert.rejects(manage('preview',{messageIds:['f'.repeat(64)]}),{status:409});
  online=false;
  const disconnected=calls;
  assert.deepEqual((await use('read',{token:created.token!})).messages,preview.messages);
  assert.ok(!JSON.stringify(await use('read',{token:created.token!})).includes('machine-demo'));
  const subset={id,revision:1,messageIds:[ids[0]!]};
  const reduced=await manage('preview',subset);
  await manage('update',{...subset,previewHash:reduced.previewHash!});
  assert.equal(calls,disconnected);
  assert.deepEqual((await use('read',{token:created.token!})).messages,[{role:'user',text:'用户原话 [凭证已隐藏]'}]);
  await assert.rejects(manage('preview',{id,revision:2,messageIds:ids}),{status:503});
  assert.deepEqual(store.list('messages'),[]);
  await manage('revoke',{id,revision:2});assert.deepEqual(await list(),{sources:[]});
  await assert.rejects(use('read',{token:created.token!}),{status:404});
});
