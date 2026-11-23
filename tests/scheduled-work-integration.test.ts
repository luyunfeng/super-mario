import test from 'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{setTimeout as delay}from'node:timers/promises';
import{startServer}from'../apps/server/src/index.ts';import{runWithAgentInput}from'../packages/core/src/agent-input.ts';import type{Approval,Message,Run}from'../packages/protocol/src/index.ts';
async function fixture(t:test.TestContext){const dir=await mkdtemp(join(tmpdir(),'mario-scheduled-http-'));let server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'offline'});t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});return{get server(){return server;},async request(path:string,method='GET',body?:unknown){const r=await fetch(server.url+'/api/v1'+path,{method,headers:{authorization:'Bearer offline','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json() as any};},async due(){await server.app.background.tick();await server.app.background.eventbox.drain();},async restart(){await server.close();server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'offline'});}};}
const work=(key:string,action:any={kind:'brief'},extra={})=>({key,title:'真实周期协调',schedule:{kind:'once',at:new Date(Date.now()-1000).toISOString()},action,...extra});
test('real HTTP creation approval activates one schedule and program fact brief survives restart without a model',async t=>{
 const f=await fixture(t);const existing=(await f.request('/eventbox/schedules')).data.length;
 assert.equal((await fetch(f.server.url+'/api/v1/scheduled-work')).status,401);const input=work('brief');const created=await f.request('/scheduled-work','POST',input);assert.equal(created.status,201);assert.equal(created.data.status,'pending');assert.equal((await f.request('/eventbox/schedules')).data.length,existing);
 const before=await f.request('/scheduled-work');assert.equal(before.data.items[0].status,'pending');assert.equal('sourceMessage' in before.data.items[0],false);
 const approved=await f.request('/approvals/'+created.data.id+'/approve','POST',{version:created.data.version});assert.equal(approved.data.status,'completed');assert.ok(approved.data.result.scheduleId);
 await f.due();let list=(await f.request('/scheduled-work')).data;assert.equal(list.items[0].occurrences.length,1);assert.equal(list.items[0].occurrences[0].status,'completed');const messageId=list.items[0].occurrences[0].result.messageId;const message=f.server.app.store.get<Message>('messages',messageId)!;assert.match(message.text,/开放待办/);assert.equal(message.replyTo,undefined);assert.equal(message.origin,'notification');assert.equal(f.server.app.store.list<Run>('runs').length,0);
 assert.equal(list.items[0].scheduleStatus,'done');
 assert.equal(list.items[0].nextAt,undefined);
 await f.due();assert.equal(f.server.app.store.list<Message>('messages').filter(m=>m.id===messageId).length,1);await f.restart();await f.due();list=(await f.request('/scheduled-work')).data;assert.equal(list.items[0].occurrences.length,1);assert.ok(f.server.app.store.get('messages',messageId));
});
test('due dispatch creates a second explicit approval; cancel closes its pending receipt without executing',async t=>{
 const f=await fixture(t);let launches=0;f.server.app.contributions.add('executors','fixture',{id:'fixture',name:'Offline executor',machineId:'local',kind:'test',available:true,mode:'demo',description:'local fake',async execute(){launches++;return{text:'synthetic'};}});
 const action={kind:'dispatch',executorId:'fixture',prompt:'local work',doneWhen:'return synthetic',expectMinutes:1};const created=(await f.request('/scheduled-work','POST',work('dispatch',action))).data;
 await f.request('/approvals/'+created.id+'/approve','POST',{version:1});await f.due();const row=(await f.request('/scheduled-work')).data.items[0];assert.equal(launches,0);assert.equal(row.occurrences[0].approvalStatus,'pending');assert.equal(row.occurrences[0].run,undefined);assert.equal(f.server.app.store.list('runs').length,0);
 assert.equal((await f.request('/scheduled-work/'+row.id+'/cancel','POST',{version:row.version+1})).status,409);const cancelled=await f.request('/scheduled-work/'+row.id+'/cancel','POST',{version:row.version});assert.equal(cancelled.status,200);assert.equal(f.server.app.store.get<Approval>('approvals',row.occurrences[0].approvalId)!.status,'rejected');assert.equal(launches,0);
 assert.equal((await f.request('/approvals/'+row.occurrences[0].approvalId+'/approve','POST',{version:1})).status,409);
});
test('current periodic dispatch approval runs the ordinary executor exactly once and leaves the Todo uncompleted',async t=>{
 const f=await fixture(t);let launches=0;f.server.app.contributions.add('executors','fixture',{id:'fixture',name:'Offline executor',machineId:'local',kind:'test',available:true,mode:'demo',description:'fake',async execute(){launches++;return{text:'synthetic'};}});
 const todo=f.server.app.createTodo({title:'周期待办'});const creation=(await f.request('/scheduled-work','POST',work('go',{kind:'dispatch',executorId:'fixture',prompt:'local work',doneWhen:'return synthetic',expectMinutes:1},{todoId:todo.id}))).data;await f.request('/approvals/'+creation.id+'/approve','POST',{version:1});await f.due();const row=(await f.request('/scheduled-work')).data.items[0];const id=row.occurrences[0].approvalId;
 assert.equal((await f.request('/approvals/'+id+'/approve','POST',{version:1})).data.status,'completed');for(let n=0;launches===0&&n<100;n++)await delay(5);assert.equal(launches,1);await f.due();assert.equal(launches,1);assert.equal(f.server.app.todos().find(x=>x.id===todo.id)!.completedAt,undefined);
 const receipt=(await f.request('/scheduled-work/history','POST',{workId:row.id,todoId:todo.id})).data.occurrences[0];
 const run=f.server.app.store.list<Run>('runs')[0];
 assert.equal(receipt.approvalStatus,'completed');
 assert.deepEqual(receipt.run,{id:run.id,status:run.status});
 f.server.app.store.put('runs',run.id,{...run,todoId:'another-todo'});
 assert.equal((await f.request('/scheduled-work')).data.items[0].occurrences[0].run,undefined);
});
test('builtin tool pins real user provenance; readonly result turns cannot create schedules or leak raw source text',async t=>{
 const f=await fixture(t);const source:Message={id:'real-user',role:'user',conversationId:'main',text:'PRIVATE_USER_TEXT',status:'pending',createdAt:new Date().toISOString()};f.server.app.store.put('messages',source.id,source);const tool=f.server.app.contributions.list('tools').find(x=>x.value.name==='scheduled_work_propose')!.value;
 const input=work('tool');await assert.rejects(runWithAgentInput({...source,readOnly:true},()=>tool.execute(input as any,new AbortController().signal)),{status:403});const approval=await runWithAgentInput(source,()=>tool.execute(input as any,new AbortController().signal)) as unknown as Approval;
 f.server.app.store.put('messages',source.id,{...source,status:'done'});const accepted=await f.request('/approvals/'+approval.id+'/approve','POST',{version:1});assert.equal(accepted.data.status,'completed');const publicRows=(await f.request('/scheduled-work')).data;assert.ok(!JSON.stringify(publicRows).includes('PRIVATE_USER_TEXT'));
});

test('修订后的历史保留原动作，历史版本缺少证据时标为未知', async t => {
  const f = await fixture(t);
  const source: Message = { id: 'source-revision', role: 'user', text: '安排定时工作', conversationId: 'main',
    status: 'done', createdAt: new Date().toISOString() };
  f.server.app.store.put('messages', source.id, source);
  const propose = (action: object) => runWithAgentInput(source, () =>
    f.server.app.scheduledWork.propose(work('revision', action), true));
  const first = propose({ kind: 'brief' });
  await f.request('/approvals/' + first.id + '/approve', 'POST', { version: first.version });
  await f.due();
  const second = propose({ kind: 'dispatch', executorId: 'fixture', prompt: '核对', doneWhen: '交付记录', expectMinutes: 1 });
  assert.notEqual(second.id, first.id);
  const list = async () => (await f.request('/scheduled-work')).data.items[0];
  const current = await list();
  assert.equal(current.action.kind, 'dispatch');
  const original = current.occurrences[0];
  assert.equal(original.workVersion, 1);
  assert.equal(original.kind, 'brief');
  const store = f.server.app.store;
  const saved = store.get<import('../packages/protocol/src/index.ts').ScheduledWorkOccurrence>('scheduled-work.occurrences', original.key)!;
  assert.equal(saved.actionKind, 'brief');
  const { actionKind, ...legacy } = saved;
  store.put('scheduled-work.occurrences', original.key, legacy);
  assert.equal((await list()).occurrences[0].kind, 'brief');
  const { result, ...unconfirmed } = legacy;
  store.put('scheduled-work.occurrences', original.key, unconfirmed);
  await f.restart();
  const history = await f.request('/scheduled-work/history', 'POST', { workId: current.id });
  assert.equal(history.data.occurrences[0].kind, 'unknown');
});
