import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../apps/server/src/index.ts';
import { runWithAgentInput } from '../packages/core/src/agent-input.ts';
import { buildWorkContext } from '../packages/core/src/work-context.ts';
import type { PersonalProvider } from '../plugins/feishu-personal.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';
import type { Approval, JsonObject, Message } from '../packages/protocol/src/index.ts';
import type { InboxHandlingAction, InboxHandlingView, InboxSuggestion } from '../packages/protocol/src/inbox-handling.ts';

async function until(check:()=>boolean){for(let i=0;i<500;i++){if(check())return;await delay(10);}assert.ok(check(),'local handling pipeline did not settle');}
async function fixture(t:test.TestContext){
  const dataDir=await mkdtemp(join(tmpdir(),'mario-handling-http-')),bin=join(dataDir,'fake-bin'),log=join(dataDir,'sends.jsonl'),control=join(dataDir,'mode');
  await mkdir(bin);await writeFile(control,'success');
  await writeFile(join(bin,'lark-cli'),`#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');if(fs.readFileSync(${JSON.stringify(control)},'utf8')==='unknown')console.log('incomplete response');else console.log(JSON.stringify({ok:true,identity:'user',data:{message_id:'om_sent_fixture'}}));\n`,{mode:0o700});
  const account={profile:'fixture-personal',appId:'cli_fixture',openId:'ou_owner',name:'Synthetic owner'};
  await mkdir(join(dataDir,'private','feishu-personal'),{recursive:true});
  await writeFile(join(dataDir,'private','feishu-personal','account.json'),JSON.stringify({account,enabled:false}),{mode:0o600});
  const provider:PersonalProvider={application:async()=>{throw Error('must not authorize');},begin:async()=>{throw Error('must not authorize');},complete:async()=>{throw Error('must not authorize');},verify:async a=>a,collect:async()=>{throw Error('must not collect');}};
  const adapters=new Map<string,{options:FeishuOptions;sent:{chat:string;text:string;context:unknown}[]}>();
  const factory:FeishuBotFactory=options=>{const record={options,sent:[] as {chat:string;text:string;context:unknown}[]};adapters.set(options.appId,record);return{async start(){},async close(){},async collect(){return[];},status:()=>({connected:true}),async send(chat,text,context){record.sent.push({chat,text,context});}};};
  const previousPath=process.env.PATH;process.env.PATH=bin+':'+previousPath;
  let server=await startServer({dataDir,host:'127.0.0.1',port:0,demo:true,token:'fixture'},{personalProvider:provider,botFactory:factory});
  t.after(async()=>{await server.close();if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;await rm(dataDir,{recursive:true,force:true});});
  await until(()=>server.personal.status().status==='connected');
  const source=`feishu:${account.appId}:${account.openId}`;
  await server.app.inbox.ingest(source,[{thread:'feishu:message:'+JSON.stringify(['oc_fixture','om_original']),last:'om_original',title:'合成私聊',text:'请核对合成任务',origin:{kind:'direct',chatId:'oc_fixture'}}]);
  server.app.waitingReplies.observeSource(source,[{source,chatId:'oc_fixture',messageId:'om_original',senderId:'ou_other',senderIdType:'open_id',createdAt:new Date(Date.now()-1000).toISOString()}]);
  const item=server.app.inbox.list()[0]!;
  async function api(path:string,method='GET',body?:unknown){const response=await fetch(server.url+'/api/v1'+path,{method,headers:{authorization:'Bearer fixture','content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json() as any};}
  const route='/inbox-handling/personal/'+item.id;
  return{get server(){return server;},item,route,api,adapters,async reads(){try{return(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as string[]);}catch{return[];}},unknown:()=>writeFile(control,'unknown'),
    async save(action:InboxHandlingAction){const view=(await api(route)).data as InboxHandlingView;const response=await api(route+'/suggestions','POST',{sourceVersion:view.source.version,action});assert.equal(response.status,201,JSON.stringify(response.data));return response.data as InboxSuggestion;},
    async confirm(s:InboxSuggestion,base=route){const response=await api(base+'/suggestions/'+s.id+'/confirm','POST',{sourceVersion:s.sourceVersion,version:s.version});assert.equal(response.status,201,JSON.stringify(response.data));return response.data as Approval;},
    approve:(a:Approval)=>api('/approvals/'+a.id+'/approve','POST',{version:a.version}),
    async restart(){await server.close();server=await startServer({dataDir,host:'127.0.0.1',port:0,demo:true,token:'fixture'},{personalProvider:provider,botFactory:factory});await until(()=>server.personal.status().status==='connected');},
  };
}

test('edited Todo crosses real HTTP approval once, keeps project and audit history after archive/restart',async t=>{
  const f=await fixture(t),project=await f.server.app.createProject({name:'Project A'});f.server.app.inbox.assignProject(f.item.id,f.item.version,project.id);
  const suggestion=await f.save({kind:'todo',title:'已编辑标题',notes:'明确验收说明'}),approval=await f.confirm(suggestion);
  assert.equal(f.server.app.todos().length,0);assert.equal((await f.reads()).length,0);assert.equal((await f.approve(approval)).data.status,'completed');
  const todo=f.server.app.todos()[0]!;assert.equal(todo.title,'已编辑标题');assert.equal(todo.projectId,project.id);assert.match(todo.notes,/明确验收说明/);assert.equal(todo.completedAt,undefined);
  assert.equal((await f.approve(approval)).status,409);assert.equal(f.server.app.todos().length,1);
  let view=(await f.api(f.route)).data as InboxHandlingView;assert.equal(view.source.active,false);assert.equal(view.suggestions[0]?.status,'applied');
  assert.equal(view.linkedTodo?.status, 'open');
  await f.restart();view=(await f.api(f.route)).data;assert.equal((view.suggestions[0]?.result as any)?.todoId,todo.id);assert.equal(f.server.app.todos().length,1);
  const completedAt = new Date().toISOString();
  f.server.app.store.put('todos', todo.id, { ...todo, completedAt });
  const linked = (await f.api(f.route)).data.linkedTodo;
  assert.equal(linked.status, 'completed'); assert.equal(linked.completedAt, completedAt);
  assert.equal(linked.webPath, '#projects/' + project.id + '/todos/detail/' + todo.id);
  const actor: Message = { id: 'fixture-query', role: 'user', conversationId: 'project:' + project.id + ':work', projectId: project.id,
    text: '这条收件转出的待办完成了吗？', status: 'done', createdAt: completedAt };
  const tool = f.server.app.contributions.list('tools').find(item => item.value.name === 'inbox_handling_read')!.value;
  const output = await runWithAgentInput(actor, () => tool.execute({ kind: 'personal', id: f.item.id }, new AbortController().signal));
  assert.deepEqual((output as JsonObject).linkedTodo, linked);
  f.server.app.store.put('todos', todo.id, { ...todo, projectId: 'other', title: '另一个项目的私有标题' });
  assert.deepEqual((await f.api(f.route)).data.linkedTodo, { status: 'unavailable' });
});
test('editing or tampering with a bound approval never reaches generic plugin acknowledgement',async t=>{
  const f=await fixture(t),first=await f.save({kind:'conclusion',text:'第一版'}),old=await f.confirm(first);
  const edited=await f.api(f.route+'/suggestions','POST',{sourceVersion:first.sourceVersion,id:first.id,version:first.version,action:{kind:'conclusion',text:'第二版'}});
  assert.equal(edited.data.version,2);assert.equal((await f.approve(old)).status,409);assert.equal(f.server.app.inbox.list()[0]?.archivedAt,undefined);
  const current=await f.confirm(edited.data);f.server.app.store.put('approvals',current.id,{...current,kind:'plugin:unrelated.accepted'});
  assert.equal((await f.approve(current)).data.status,'failed');assert.equal(f.server.app.inbox.list()[0]?.archivedAt,undefined);assert.equal((await f.reads()).length,0);
});
test('model request is acknowledged once, has one user row and isolated editable output',async t=>{
  const f=await fixture(t);let calls=0;f.server.app.inboxHandlingRuntime.status=()=>({available:true});
  f.server.app.inboxHandlingRuntime.ask=async(source,cid,text,progress)=>{assert.deepEqual(progress,{total:0,recent:[]});calls++;const user:Message={id:randomUUID(),conversationId:cid,role:'user',text,status:'done',createdAt:new Date().toISOString(),readOnly:true};f.server.app.store.put('messages',user.id,user);return{id:randomUUID(),conversationId:cid,role:'assistant',replyTo:user.id,status:'done',createdAt:new Date().toISOString(),text:JSON.stringify({answer:'仅分析',suggestions:[{kind:'todo',title:source.title,notes:'来源核对'}]})};};
  const version=(await f.api(f.route)).data.source.version,body={sourceVersion:version,text:'给出建议',key:'one-click'};
  const accepted=await f.api(f.route+'/messages','POST',body);assert.equal(accepted.status,202);assert.equal(accepted.data.status,'pending');assert.equal((await f.api(f.route+'/messages','POST',body)).data.id,accepted.data.id);
  await until(()=>f.server.app.inboxHandling.read({kind:'personal',id:f.item.id}).requests[0]?.status==='completed');
  const view=(await f.api(f.route)).data as InboxHandlingView;assert.equal(calls,1);assert.equal(view.messages.filter(m=>m.role==='user').length,1);assert.equal(view.suggestions.length,1);assert.equal(f.server.app.todos().length,0);assert.equal((await f.reads()).length,0);
});
test('personal reply sends exact approved text through Outbox; repeats/restart never send twice',async t=>{
  const f=await fixture(t),suggestion=await f.save({kind:'reply',text:'确认的精确正文\n第二行'}),approval=await f.confirm(suggestion);
  assert.equal((await f.reads()).length,0);const result=await f.approve(approval);assert.equal(result.data.status,'completed',JSON.stringify(result.data));
  const sends=await f.reads();assert.equal(sends.length,1);const argv=sends[0]!;assert.equal(argv[argv.indexOf('--profile')+1],'fixture-personal');assert.equal(argv[argv.indexOf('--as')+1],'user');assert.equal(argv[argv.indexOf('--message-id')+1],'om_original');assert.equal(argv[argv.indexOf('--text')+1],suggestion.action.kind==='reply'?suggestion.action.text:'');
  const outbox=f.server.app.background.outbox.list()[0]!;assert.equal(outbox.status,'sent');assert.match(outbox.channel,/^feishu\.personal:/);
  assert.deepEqual((await f.api(f.route)).data.suggestions[0].delivery, { id: outbox.id, status: 'sent', updatedAt: outbox.updatedAt });
  assert.ok(f.server.app.inbox.list()[0]?.archivedAt,'Only confirmed delivery marks the source handled');
  assert.equal((await f.approve(approval)).status,409);await f.restart();await f.server.app.background.tick();assert.equal((await f.reads()).length,1);assert.equal(f.server.app.background.outbox.list()[0]?.status,'sent');
});
test('uncertain personal CLI response stays unknown in suggestion and Outbox without retry',async t=>{
  const f=await fixture(t);await f.unknown();const suggestion=await f.save({kind:'reply',text:'合成未知回复'}),approval=await f.confirm(suggestion);
  assert.equal((await f.approve(approval)).data.status,'unknown');assert.equal(f.server.app.background.outbox.list()[0]?.status,'unknown');assert.equal(f.server.app.store.get<InboxSuggestion>('inbox-handling.suggestions',suggestion.id)?.status,'unknown');
  assert.equal((await f.api(f.route)).data.suggestions[0].delivery.status, 'unknown');
  await f.server.app.background.tick();assert.equal((await f.reads()).length,1);await f.restart();await f.server.app.background.tick();assert.equal((await f.reads()).length,1);
  const item = f.server.app.background.outbox.list()[0]!;
  f.server.app.background.outbox.verify(item.id, true, item.version);
  const checked = (await f.api(f.route)).data.suggestions[0];
  assert.equal(checked.status, 'unknown');
  assert.equal(checked.delivery.status, 'sent');
  f.server.app.store.put('outbox.items', item.id, { ...item, relatedTo: { kind: 'inbox', id: 'other' } });
  assert.equal((await f.api(f.route)).data.suggestions[0].delivery, undefined);
  assert.equal((await f.reads()).length, 1);
});
test('archive/reopen invalidates old confirmation within the same source thread',async t=>{
  const f=await fixture(t),suggestion=await f.save({kind:'reply',text:'旧回复'}),approval=await f.confirm(suggestion);
  f.server.app.inbox.archive(f.item.id,f.item.version);f.server.app.inbox.reopen(f.item.id);assert.equal((await f.approve(approval)).data.status,'failed');assert.equal((await f.reads()).length,0);assert.equal((await f.api(f.route)).data.source.active,true);
});
test('plugin off/on never revives an old approval and a newly confirmed suggestion works after restart',async t=>{
  const f=await fixture(t),draft=await f.save({kind:'conclusion',text:'停用前的结论'}),approval=await f.confirm(draft);
  assert.equal((await f.api('/plugins/inbox-triage','POST',{enabled:false})).status,200);
  assert.equal((await f.api(f.route)).data.source.active,false);
  assert.equal((await f.api('/plugins/inbox-triage','POST',{enabled:true})).status,200);
  assert.equal((await f.approve(approval)).status,409);await f.restart();
  const next=await f.save({kind:'conclusion',text:'重新核对后的结论'}),current=await f.confirm(next);
  assert.equal((await f.approve(current)).data.status,'completed');assert.ok(f.server.app.inbox.list()[0]?.archivedAt);
});
test('approved inbox dispatch keeps exact scope/prompt and blocks a late hook rewrite before executor IO',async t=>{
  const f=await fixture(t),project=await f.server.app.createProject({name:'Execution scope'});f.server.app.inbox.assignProject(f.item.id,f.item.version,project.id);
  let calls=0;f.server.app.contributions.add('executors','fixture',{id:'fixture',name:'Synthetic worker',kind:'fixture',machineId:'local',available:true,mode:'demo',description:'offline fixture',async execute(){calls++;return{text:'synthetic result'};}});
  const action:InboxHandlingAction={kind:'dispatch',executorId:'fixture',prompt:'已确认的工作',doneWhen:'合成结果',expectMinutes:1};
  const suggestion=await f.save(action),approval=await f.confirm(suggestion),receipt=(await f.approve(approval)).data;
  assert.equal(receipt.status,'completed');await until(()=>calls===1);const run=f.server.app.store.get<any>('runs',receipt.result.runId);assert.equal(run.projectId,project.id);assert.equal(run.prompt,action.prompt);
  f.server.app.plugins.register({id:'alter-work',name:'Synthetic work policy',capabilities:[],activate(c){c.hook('work.dispatch','before',value=>({action:'continue',value:{...(value as JsonObject),prompt:'未确认的工作'}}));}});await f.server.app.plugins.start();
  const next=await f.save(action),nextApproval=await f.confirm(next),nextReceipt=(await f.approve(nextApproval)).data;
  await until(()=>f.server.app.store.get<any>('runs',nextReceipt.result.runId)?.status==='failed');assert.equal(calls,1);
});
test('main work facts expose scoped handling receipts without raw chats; reassigned history stays out of project model tools',async t=>{
  const f=await fixture(t),a=await f.server.app.createProject({name:'A'}),b=await f.server.app.createProject({name:'B'});
  let item=f.server.app.inbox.assignProject(f.item.id,f.item.version,a.id);const suggestion=await f.save({kind:'conclusion',text:'PRIVATE_A_CONCLUSION'});await f.confirm(suggestion);
  const contextA=buildWorkContext(f.server.app.store,{kind:'project',projectId:a.id});assert.equal(contextA.inboxHandling?.suggestions.total,1);assert.ok(!JSON.stringify(contextA).includes('PRIVATE_A_CONCLUSION'));assert.ok(contextA.needsYou?.items.some(x=>x.collection==='approvals'));
  assert.equal(buildWorkContext(f.server.app.store,{kind:'project',projectId:b.id}).inboxHandling?.suggestions.total,0);
  const old=f.server.app.inboxHandling.read({kind:'personal',id:f.item.id});f.server.app.store.put('messages','historic-a',{id:'historic-a',conversationId:old.conversationId,role:'assistant',text:'PRIVATE_PROJECT_A',createdAt:new Date().toISOString(),status:'done'});
  item=f.server.app.inbox.assignProject(f.item.id,item.version,b.id);
  const tool=f.server.app.contributions.list('tools').find(x=>x.value.name==='inbox_handling_read')!.value;
  const actor=(projectId:string):Message=>({id:'synthetic-input',role:'user',conversationId:`project:${projectId}:work`,projectId,text:'Read current handling facts',status:'done',createdAt:new Date().toISOString()});
  await assert.rejects(runWithAgentInput(actor(a.id),()=>tool.execute({kind:'personal',id:item.id},new AbortController().signal)),{status:403});
  const read=await runWithAgentInput(actor(b.id),()=>tool.execute({kind:'personal',id:item.id},new AbortController().signal));assert.ok(!JSON.stringify(read).includes('PRIVATE_PROJECT_A'));
  assert.ok(JSON.stringify((await f.api(f.route)).data).includes('PRIVATE_PROJECT_A'),'Authenticated Web owner retains the source audit history');
});
test('bot reply preserves original message; channel hook cannot replace the approved text',async t=>{
  const f=await fixture(t),bot=(await f.api('/feishu/bots','POST',{name:'Synthetic bot',appId:'cli_1111111111111111',appSecret:'synthetic-secret',scope:{kind:'global'},requireConfirmation:true})).data;
  const adapter=f.adapters.get(bot.appId)!,origin=(messageId:string)=>({messageId,chatId:'chat-owner',chatType:'p2p',senderId:'owner-user'});
  await adapter.options.onMessage(bot.pairingCode,origin('pair'));await adapter.options.onMessage('请处理机器人来源',origin('original-bot-input'));
  const incoming=f.server.app.mailboxes.list({direction:'inbox',botId:bot.id})[0]!,route='/inbox-handling/mailbox/'+incoming.id,view=(await f.api(route)).data as InboxHandlingView;
  assert.equal(view.source.active,true);assert.equal(view.source.replyAvailable,true);
  const save=await f.api(route+'/suggestions','POST',{sourceVersion:incoming.version,action:{kind:'reply',text:'已确认机器人回复'}}),approval=await f.confirm(save.data,route),initial=adapter.sent.length;
  const sent=await f.approve(approval);assert.equal(sent.data.status,'completed',JSON.stringify(sent.data));assert.equal(adapter.sent.length,initial+1);assert.equal(adapter.sent.at(-1)?.text,'已确认机器人回复');assert.deepEqual(adapter.sent.at(-1)?.context,{replyTo:'original-bot-input'});
  assert.equal((await f.api(route)).data.suggestions[0].delivery.id, sent.data.result.outboxId);
  assert.equal((await f.api(route)).data.suggestions[0].delivery.status, 'sent');
  await adapter.options.onMessage('请登记机器人待办', origin('bot-todo-input'));
  const todoEntry = f.server.app.mailboxes.list({ direction: 'inbox', botId: bot.id }).find(entry => entry.sourceMessageId === 'bot-todo-input')!;
  const todoRoute = '/inbox-handling/mailbox/' + todoEntry.id;
  const draft = (await f.api(todoRoute + '/suggestions', 'POST', { sourceVersion: todoEntry.version, action: { kind: 'todo', title: '核对机器人待办', notes: '核对范围' } })).data;
  const applied = await f.approve(await f.confirm(draft, todoRoute));
  assert.equal(applied.data.status, 'completed');
  assert.equal((await f.api(todoRoute)).data.linkedTodo.id, applied.data.result.todoId);
  assert.equal((await f.api(route)).data.linkedTodo, undefined);
  f.server.app.plugins.register({id:'alter-reply',name:'Synthetic policy',capabilities:[],activate(c){c.hook('channel.send','before',value=>({action:'continue',value:{...(value as JsonObject),text:'未确认的替换正文'}}));}});await f.server.app.plugins.start();
  await adapter.options.onMessage('第二条机器人来源',origin('next-bot-input'));
  const second=f.server.app.mailboxes.list({direction:'inbox',botId:bot.id}).find(item=>item.sourceMessageId==='next-bot-input')!,secondRoute='/inbox-handling/mailbox/'+second.id;
  const next=(await f.api(secondRoute+'/suggestions','POST',{sourceVersion:second.version,action:{kind:'reply',text:'第二份确认正文'}})).data,nextApproval=await f.confirm(next,secondRoute);
  const beforeDenied=adapter.sent.length; // The new incoming message has its own acknowledgement.
  assert.notEqual((await f.approve(nextApproval)).data.status,'completed');assert.equal(adapter.sent.length,beforeDenied);
});
