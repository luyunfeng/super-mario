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
  for (const invalid of [{showTools:'true'},{includeFuture:'true'},{futureScope:{}},{conversationId:'main'}] as JsonObject[])
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

test('原生分享启用工具时在线复核，冻结公开名称与状态；离线关闭可移除所有细节',async t=>{
  const store=createStore(':memory:'),host=new PluginHost({store,events:createEventBus(store),contributions:createContributions(),dataDir:':memory:'});
  t.after(async()=>{await host.close();store.close();});
  const native={machineId:'m',executorId:'codex',nativeSessionId:'n',cwd:'/fixture/root'};
  const ids=['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)],messageIds=ids.slice(0,2);
  let online=true,reads=0,text='已确认回答';
  const firstTool={name:'read_file',status:'returned' as const,args:'原始参数',result:'内部回执',headers:'凭据'};
  let tools=[firstTool];
  host.register(createConversationSharing('',async(_s,selection)=>{
    reads++;if (!online) throw Object.assign(Error('执行机离线'),{status:503});
    const rows=[{id:ids[0]!,index:0,role:'user' as const,text:'问题',tools:[{...firstTool,name:'用户不应出现工具'}]},
      {id:ids[1]!,index:1,role:'assistant' as const,text,tools},
      {id:ids[2]!,index:2,role:'assistant' as const,text:'另一个回答',tools:[{...firstTool,name:'another_tool'}]}];
    return {items:'offset' in selection ? rows : rows.filter(r=>selection.ids.includes(r.id)),total:3};
  }));
  await host.start();
  const manage=(action:string,body:JsonObject={})=>host.invocations.use('conversation-sharing.manage',{action,native,...body}) as Promise<JsonObject>;
  const preview=(opts:JsonObject)=>manage('preview',opts);
  const publish=async(opts:JsonObject)=>manage(opts.id?'update':'create',{...opts,previewHash:(await preview(opts)).previewHash!});
  const catalog=await manage('catalog');
  assert.ok((catalog.items as JsonObject[]).every(item=>!Object.hasOwn(item,'tools')));
  const plain={messageIds};
  const created=await publish(plain),id=created.id!;
  const read=()=>host.invocations.use('conversation-sharing.read',{token:created.token!}) as Promise<JsonObject>;
  const enabled={...plain,id,revision:1,showTools:true};
  online=false;await assert.rejects(preview(enabled),{status:503});online=true;
  const candidates=await preview(enabled);
  const expected=[{role:'user',text:'问题'},{role:'assistant',text,tools:[{name:'read_file',status:'returned'}]}];
  assert.deepEqual(candidates.messages,expected);
  tools=[{...firstTool,name:'changed_tool'}];
  await assert.rejects(manage('update',{...enabled,previewHash:candidates.previewHash!}),{status:409});
  tools=[firstTool];text='正文发生变化，指纹由宿主复核';
  await manage('update',{...enabled,previewHash:candidates.previewHash!});
  online=false;
  const oldReads=reads;
  await publish({...plain,id,revision:2,expireHours:1});
  assert.deepEqual((await read()).messages,expected);
  assert.equal(reads,oldReads);
  await assert.rejects(preview({id,revision:3,messageIds:ids}),{status:503});
  await publish({id,revision:3,messageIds:[ids[0]!]});
  assert.deepEqual((await read()).messages,[expected[0]]);
  online=true;
  await publish({id,revision:4,messageIds:[ids[0]!,ids[2]!]});
  assert.ok(JSON.stringify((await read()).messages).includes('another_tool'));
  online=false;
  await publish({id,revision:5,messageIds:[ids[0]!,ids[2]!],showTools:false});
  assert.ok(!JSON.stringify(await read()).includes('tools'));
  online=true;
  tools=Array.from({length:8000},()=>firstTool);
  await assert.rejects(preview({messageIds,showTools:true}),{status:400});
  tools=[{...firstTool,name:'bad key private details'}];
  await assert.rejects(preview({messageIds,showTools:true}),{status:409});
  tools=[firstTool];
  const direct=await publish({messageIds,showTools:true});
  const live=await host.invocations.use('conversation-sharing.read',{token:direct.token!});
  for (const forbidden of ['原始参数','内部回执','凭据','headers','/fixture/root']) assert.ok(!JSON.stringify(live).includes(forbidden));
});

test('原生追加以确认时尾部为界，读者共享刷新，可离线看旧摘录，撤销、停启和改写均阻断旧任务',async t=>{
  let time=Date.now();t.mock.method(Date,'now',()=>time);
  const store=createStore(':memory:'),host=new PluginHost({store,events:createEventBus(store),contributions:createContributions(),dataDir:':memory:'});
  t.after(async()=>{await host.close();store.close();});
  const native={machineId:'test-machine',executorId:'codex',nativeSessionId:'test-session',cwd:'/synthetic'};
  const rows:{id:string;index:number;role:'user'|'assistant';text:string}[]=[];
  function append(text:string) {const index=rows.length,id=(index+1).toString(16).padStart(64,'0');rows.push({id,index,role:index%2?'assistant':'user',text});return id;}
  const first=append('原摘录');
  let offline=false,reads=0,delay:(()=>Promise<void>)|undefined;
  host.register(createConversationSharing('',async(_source,selection)=>{
    reads++;if (delay) await delay();if (offline) throw Object.assign(Error('离线'),{status:503});
    const items='ids' in selection ? rows.filter(r=>selection.ids.includes(r.id)).map(r=>({...r,...(selection.showTools && r.role==='assistant' && {tools:[{name:'reader',status:'returned' as const}]})})) :
      rows.slice(selection.offset,selection.offset+25);
    return {items,total:rows.length};
  }));
  await host.start();
  const manage=(action:string,input:JsonObject)=>host.invocations.use('conversation-sharing.manage',{action,native,...input}) as Promise<JsonObject>;
  const options={messageIds:[first],includeFuture:true,showTools:true},preview=await manage('preview',options);
  append('确认前输入');
  const share=await manage('create',{...options,previewHash:preview.previewHash!}),id=share.id!;
  const read=()=>host.invocations.use('conversation-sharing.read',{token:share.token!}) as Promise<JsonObject>;
  append('追加用户');append('追加助手');
  const beforeRefresh=reads;
  const got=await Promise.all([read(),read(),read()]);
  assert.equal(reads-beforeRefresh,3); // One offset/IDs/anchor verification across all three viewers.
  assert.ok(got.every(v=>v.revision===2 && v.publicationStatus==='live'));
  const messages=got[0]!.messages as JsonObject[];
  assert.deepEqual(messages.map(m=>m.text),['原摘录','追加用户','追加助手']);assert.deepEqual(messages[2]!.tools,[{name:'reader',status:'returned'}]);
  append('节流后追加');const priorReads=reads;
  assert.equal((await read()).revision,2);assert.equal(priorReads,reads);
  time+=16000;offline=true;assert.equal((await read()).revision,2);offline=false;
  let release!:()=>void,entered!:()=>void;
  const startSlow=()=>{
    const started=new Promise<void>(r=>{entered=r;});
    const wait=new Promise<void>(r=>{release=r;});
    delay=async()=>{entered();await wait;};
    time+=16000;
    return started;
  };
  const started=startSlow();const pending=read();await started;
  assert.equal((await pending).revision,2); // The refresh is still blocked, but the viewer sees its snapshot.
  delay=undefined;release();await new Promise(resolve=>setImmediate(resolve));
  const latest=await read();assert.equal(latest.revision,3);
  await host.setEnabled('conversation-sharing',false);append('停用期间');
  await host.setEnabled('conversation-sharing',true);
  const paused=await read();assert.equal(paused.publicationStatus,'paused');assert.deepEqual(paused.messages,latest.messages);
  const detail=await manage('detail',{id});
  const edit={...options,id,revision:detail.revision!,messageIds:detail.messageIds!};
  await manage('update',{...edit,previewHash:(await manage('preview',edit)).previewHash!});
  append('恢复后追加');const resumed=await read();assert.ok(!JSON.stringify(resumed).includes('停用期间'));
  assert.ok(JSON.stringify(resumed).includes('恢复后追加'));
  rows.at(-1)!.id='f'.repeat(64);append('改写后不公开');time+=16000;
  const mismatch=await read();assert.equal(mismatch.publicationStatus,'paused');assert.deepEqual(mismatch.messages,resumed.messages);
  const renew={...edit,revision:mismatch.revision!};
  await manage('update',{...renew,previewHash:(await manage('preview',renew)).previewHash!});
  append('撤销后不能发布');
  const startedAgain=startSlow();const stale=read();await startedAgain;
  await manage('revoke',{id});delay=undefined;release();
  await assert.rejects(stale,{status:404});
  assert.equal(store.get('conversation-sharing.snapshots',String(id)),undefined);

  const create=async(opts:JsonObject)=>manage('create',{...opts,previewHash:(await manage('preview',opts)).previewHash!});
  while(rows.length<99) append('历史消息'+rows.length);
  const full=await create({messageIds:rows.slice(0,99).map(r=>r.id),includeFuture:true});
  append('第一百条');append('第一百零一条');
  const byToken=(token:JsonObject['token'])=>host.invocations.use('conversation-sharing.read',{token:token!}) as Promise<JsonObject>;
  const capped=await byToken(full.token);assert.equal(capped.publicationStatus,'paused');
  assert.equal((capped.messages as JsonObject[]).length,100);
  assert.equal((capped.messages as JsonObject[]).at(-1)!.text,'第一百条');
  const large=await create({messageIds:[first],includeFuture:true});append('巨'.repeat(90000));
  const oversize=await byToken(large.token);assert.equal(oversize.publicationStatus,'paused');
  assert.equal((oversize.messages as JsonObject[]).length,1);
});
