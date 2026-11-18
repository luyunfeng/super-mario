import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { runWithAgentInput } from '../packages/core/src/agent-input.ts';
import { botConversationId } from '../packages/core/src/bot-agent-routing.ts';
import type { FeishuBot, MailboxEntry } from '../packages/protocol/src/bots.ts';
import type { Message } from '../packages/protocol/src/index.ts';
async function fixture(t: test.TestContext) {
 const dataDir=await mkdtemp(join(tmpdir(),'mario-bot-tools-'));
 const app=await createWorkbench({dataDir,host:'127.0.0.1',port:0,demo:true});
 t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
 const bots:FeishuBot[]=[{id:'main-bot',name:'main',appId:'cli_example',enabled:true,configured:true,paired:true,connected:true,scope:{kind:'global'},executorId:'demo',requireConfirmation:true,createdAt:'',updatedAt:''}];
 app.setBotsStatus(()=>bots as never);
 const input:Message={id:'input',conversationId:botConversationId(bots[0]),role:'user',text:'work',createdAt:new Date().toISOString()};app.store.put('messages',input.id,input);
 const find=(name:string)=>{const tool=app.contributions.list('tools').find(t=>t.value.name===name)?.value;assert.ok(tool,name);return tool;};
 return {app,bots,input,find};
}
test('a robot executor binding governs direct work, split plans and delayed approved dispatches',async t=>{
 const {app,bots,input,find}=await fixture(t);
 const call=(name:string,args:Record<string,unknown>)=>runWithAgentInput(input,()=>find(name).execute(args as never,new AbortController().signal));
 const run=await call('work_dispatch',{prompt:'bound work'}) as unknown as {id:string;executorId:string};assert.equal(run.executorId,'demo');
 await assert.rejects(call('work_dispatch',{prompt:'wrong engine',executorId:'another'}),/绑定其他执行者/);
 await assert.rejects(call('task_plan',{title:'wrong plan',tasks:[{prompt:'wrong engine',executorId:'another',doneWhen:'evidence',expectMinutes:1}]}),/绑定其他执行者/);
 assert.equal(app.plans.list().length,0);
 const planned=await call('task_plan',{title:'bound plan',tasks:[{prompt:'step',doneWhen:'evidence',expectMinutes:1}]}) as unknown as {tasks:Array<{executorId?:string}>};assert.equal(planned.tasks[0].executorId,'demo');
 bots[0].executorId='new-engine';
 assert.throws(()=>app.dispatch({prompt:'delayed old approval',executorId:'demo',conversationId:input.conversationId,sourceMessageId:input.id}),/绑定其他执行者/);
 // Existing run IDs/results remain readable after a rebind; no new CLI is started.
 assert.equal(app.store.get<{executorId:string}>('runs',run.id)?.executorId,'demo');
});
test('handoff pins sender and parent provenance to the real calling message',async t=>{
 const {app,bots,input,find}=await fixture(t);const requests:unknown[]=[];
 app.setBotRelay(async request=>{requests.push(request);return {id:'relay',version:1,direction:'inbox',botId:request.targetBotId,eventKey:request.key,title:'request',text:request.text,scope:{kind:'global'},requiresConfirmation:true,status:'pending',createdAt:'',updatedAt:''};});
 const handoff=(args:Record<string,unknown>,source=input)=>runWithAgentInput(source,()=>find('bot_handoff').execute(args as never,new AbortController().signal));
 const result=await handoff({targetBotId:'peer',text:'review',key:'one'}) as unknown as MailboxEntry;assert.equal(result.status,'pending');
 assert.deepEqual(requests,[{sourceBotId:'main-bot',targetBotId:'peer',text:'review',key:'input:one',sourceMessageId:'input'}]);
 await assert.rejects(handoff({sourceBotId:'someone-else',targetBotId:'peer',text:'review',key:'two'}),/冒用/);
 await assert.rejects(handoff({targetBotId:'peer',text:'review',key:'two',parentEntryId:'forged'}),/父信件/);
 const parent=app.mailboxes.put({direction:'inbox',botId:bots[0].id,eventKey:'feishu-a2a:incoming',title:'delegated',text:'do work',scope:{kind:'global'},requiresConfirmation:false});
 app.store.put('event.mailboxes',parent.id,{...parent,status:'completed',resultId:input.id});
 await handoff({targetBotId:'peer',text:'next',key:'three'});
 assert.deepEqual(requests.at(-1),{sourceBotId:'main-bot',targetBotId:'peer',text:'next',key:'input:three',sourceMessageId:'input',parentEntryId:parent.id});
});
test('main chat uses a configured global identity; project chat cannot impersonate the main agent',async t=>{
 const {app,input,find}=await fixture(t);let requests=0;app.setBotRelay(async req=>{requests++;return {id:'r',version:1,direction:'inbox',scope:{kind:'global'},botId:req.targetBotId,eventKey:req.key,title:'r',text:req.text,requiresConfirmation:true,status:'pending',createdAt:'',updatedAt:''};});
 const tool=find('bot_handoff'),args={targetBotId:'peer',text:'next',key:'intent'};
 await runWithAgentInput({...input,id:'web',conversationId:'main'},()=>tool.execute(args,new AbortController().signal));assert.equal(requests,1);
 await assert.rejects(runWithAgentInput({...input,conversationId:'project:p:work'},()=>tool.execute(args,new AbortController().signal)),/主对话/);assert.equal(requests,1);
});

test('collaboration result enters only its initiating conversation as readOnly evidence',async t=>{
 const {app,bots,input}=await fixture(t);
 const notice=await app.postScopedResult({botId:bots[0].id,scope:bots[0].scope,text:'子Agent已提交结果；验收仍待确认',sourceMessageId:input.id});
 assert.equal(notice.conversationId,input.conversationId);assert.equal(notice.readOnly,true);assert.equal(notice.origin,'result');assert.equal(notice.replyTo,input.id);
 const originalWeb={...input,id:'web-source',conversationId:'main'};app.store.put('messages',originalWeb.id,originalWeb);
 const webNotice=await app.postScopedResult({botId:bots[0].id,scope:{kind:'global'},text:'请求的结果',sourceMessageId:originalWeb.id});assert.equal(webNotice.conversationId,'main');assert.equal(webNotice.readOnly,true);
 const project=app.projects.create({name:'A'});
 await assert.rejects(app.postScopedResult({botId:bots[0].id,scope:{kind:'project',projectId:project.id},text:'不能冒用全局来源',sourceMessageId:originalWeb.id}),/项目机器人/);
 await assert.rejects(app.postScopedResult({botId:'other-bot',scope:{kind:'global'},text:'不能串机器人',sourceMessageId:input.id}),/不属于发起机器人/);
});
