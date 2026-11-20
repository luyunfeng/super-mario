import { chatDirectory } from './feishu-scope-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbench} from '../packages/core/src/workbench.ts';
import {createPersonalProvider,PERSONAL_MESSAGE_SCOPES} from '../plugins/feishu-personal.ts';
import {collectAttention} from '../packages/core/src/attention.ts';
import type {Json,JsonObject} from '../packages/protocol/src/index.ts';

test('personal CLI metadata distinguishes direct, group mentions and own messages without guessing',async()=>{
 const own='ou_personal',calls:string[][]=[];
 const item=(chat:string,extra={})=>({message_id:'om_'+chat,chat_id:'oc_'+chat,chat_name:chat,chat_type:'group',create_time:'2026-11-17T00:00:00Z',sender:{id:'ou_other',name:'Another user'},content:'A real-shaped fixture',...extra});
 const hits=[item('direct',{chat_type:'p2p'}),item('mention',{mentions:[{id:own,name:'same name'}]}),item('other',{mentions:[{id:'ou_other_bot',name:'same name'}]}),item('unknown',{chat_type:undefined}),item('own',{sender:{id:own,name:'Me'}})];
 const provider=createPersonalProvider({application:()=>undefined,runCLI:async args=>{calls.push(args);
  const directory=chatDirectory(args,['oc_mention','oc_other','oc_unknown']);if(directory)return directory;
  if(args.includes('status'))return{appId:'cli_fixture',identity:'user',verified:true,identities:{user:{available:true,openId:own,userName:'Me',scope:PERSONAL_MESSAGE_SCOPES.join(' ')}}};
  if(args.includes('+messages-search')){
   const messages=args.includes('p2p')?[hits[0],hits[4]]:args.includes('--is-at-me')?[hits[1]]:[hits[2],hits[3],hits[1]];
   return{ok:true,identity:'user',data:{messages}};
  }
  return{ok:true,identity:'user',data:{messages:[]}};
 }});
 const result=await provider.collect({profile:'fixture',appId:'cli_fixture',openId:own,name:'Me'},new AbortController().signal);
 assert.equal(result.length,4);
 assert.equal(result.find(x=>x.title==='direct')?.origin?.kind,'direct');
 assert.equal(result.find(x=>x.title==='mention')?.origin?.mentionedMe,true);
 assert.equal(result.find(x=>x.title==='other')?.origin?.mentionedMe,false);
 assert.equal(result.find(x=>x.title==='unknown')?.origin?.kind,'group');
 assert.ok(calls.every(args=>args[0]==='--profile'&&args[1]==='fixture'));
 assert.equal(calls.filter(args=>args.includes('+messages-search')).length,3);
 assert.ok(calls.some(args=>args.includes('--chat-type')&&args.includes('p2p')));
 assert.ok(calls.some(args=>args.includes('--chat-type')&&args.includes('group')&&args.includes('--is-at-me')));
});

test('SDK intake forces connector namespace, keeps provenance and never accepts lifecycle authority',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mario-plugin-intake-'));
 const app=await createWorkbench({dataDir:dir,host:'127.0.0.1',port:0,demo:true});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 let use!:(value:JsonObject)=>Promise<Json>;
 app.plugins.register({id:'local-source',name:'Configured internal source fixture',capabilities:['inbox.collect'],permissions:['service.use:core.inbox.ingest'],activate(context){use=value=>context.use('core.inbox.ingest',value);}});
 await app.plugins.start();
 const thing={thread:'internal-chat',last:'one',title:'Internal source',text:'Please review',origin:{kind:'group',connector:'Internal source',mentionedMe:true},archivedAt:'fake',projectId:'forged',todoId:'forged',version:500};
 const result=await use({sourceId:'messages',__owner:'feishu',items:[thing]});assert.deepEqual(result,{accepted:true,count:1,source:'plugin:local-source:messages'});
 const saved=app.inbox.list()[0];assert.equal(saved.origin?.mentionedMe,true);assert.equal(saved.projectId,undefined);assert.equal(saved.archivedAt,undefined);assert.equal(saved.todoId,undefined);assert.equal(saved.version,1);
 assert.equal(app.todos().length,0);assert.equal(app.store.list('runs').length,0);assert.equal(app.approvals.list().length,0);
 await use({sourceId:'messages',items:[thing]});assert.equal(app.inbox.list().length,1);
 await assert.rejects(use({sourceId:'feishu:owner',items:[thing]}),/来源|批次/);
 await app.plugins.setEnabled('local-source',false);await assert.rejects(use({sourceId:'messages',items:[]}),/inactive|停用|active|disposed|closed/i);
});

test('FYI private chats and exact mentions stay in background instead of becoming human decisions',()=>{
 const base={id:'direct',source:'plugin:internal:messages',thread:'t',last:'one',title:'FYI fixture',text:'A user should see this',reason:'fyi',tier:'fyi' as const,version:1,updatedAt:'2026-11-17T00:00:00Z'};
 const result=collectAttention({inbox:[{...base,origin:{kind:'direct',connector:'Internal source'}},{...base,id:'mention',origin:{kind:'group',mentionedMe:true}},{...base,id:'other',origin:{kind:'group',mentionedMe:false}},{...base,id:'archived',origin:{kind:'direct'},archivedAt:base.updatedAt}]});
 assert.deepEqual(result,[]);
 const actionable=collectAttention({inbox:[{...base,tier:'action',origin:{kind:'direct',connector:'Internal source'}}]});
 assert.equal(actionable[0]?.source,'Internal source');
});

test('main Agent can classify a source message into a project with its current version; readOnly and scoped inputs cannot',async t=>{
 const {runWithAgentInput}=await import('../packages/core/src/agent-input.ts');
 const dir=await mkdtemp(join(tmpdir(),'mario-inbox-agent-'));
 const app=await createWorkbench({dataDir:dir,host:'127.0.0.1',port:0,demo:true});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const project=app.projects.create({name:'User-selected project'});
 await app.inbox.ingest('plugin:fixture:messages',[{thread:'source',last:'one',title:'Review',text:'Please review',origin:{kind:'direct'}}]);
 const row=app.inbox.list()[0];
 const tools=app.contributions.list('tools'),list=tools.find(t=>t.value.name==='inbox_list')!.value,assign=tools.find(t=>t.value.name==='inbox_assign_project')!.value;
 const found=await list.execute({kind:'direct'},new AbortController().signal) as any;assert.equal(found.total,1);assert.equal(found.items[0].id,row.id);
 const source={id:'main-classification',role:'user' as const,conversationId:'main',text:'把这条消息归入项目',createdAt:new Date().toISOString()};app.store.put('messages',source.id,source);
 const result=await runWithAgentInput(source,()=>assign.execute({id:row.id,version:row.version,projectId:project.id},new AbortController().signal)) as any;
 assert.equal(result.projectId,project.id);assert.equal(result.archivedAt,undefined);assert.equal(app.todos().length,0);assert.equal(app.store.list('runs').length,0);
 await assert.rejects(runWithAgentInput({...source,readOnly:true},()=>assign.execute({id:row.id,version:result.version,projectId:project.id},new AbortController().signal)),/当前用户输入/);
 await assert.rejects(runWithAgentInput({...source,conversationId:'project:'+project.id+':work',projectId:project.id},()=>assign.execute({id:row.id,version:result.version,projectId:project.id},new AbortController().signal)),/只有主对话/);
});
