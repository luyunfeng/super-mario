import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbench} from '../packages/core/src/workbench.ts';
import type {MachineInfo,Message,Run} from '../packages/protocol/src/index.ts';
import type {ObservedAgentSession} from '../packages/protocol/src/agent-sessions.ts';
async function fixture(t:test.TestContext){
 const dir=await mkdtemp(join(tmpdir(),'mario-native-core-')),app=await createWorkbench({host:'127.0.0.1',port:0,dataDir:dir,demo:true});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const a=app.projects.create({name:'A',workspace:{machineId:'m',cwd:'/work/A'}}),b=app.projects.create({name:'B',workspace:{machineId:'m',cwd:'/work/B'}});
 const todo=app.createTodo({title:'A-task',projectId:a.id});
 const m:MachineInfo={id:'m',name:'Linux',platform:'linux',online:true,connectedAt:'',capabilities:['agents.sessions','agents.session','executor.resume','executor.start','executor.result'],executors:[{id:'codex',name:'Codex',kind:'cli',machineId:'m',mode:'real',available:true,description:'fixture',nativeResultSources:['codex-json']}]};
 const metadata:ObservedAgentSession[]=[['thread-a','/work/A'],['thread-b','/work/B']].map(([id,cwd])=>({id:'codex:'+id,nativeSessionId:id,executorId:'codex',cwd,source:'session-metadata',state:'historical',writable:false,observedAt:new Date().toISOString()}));
 const calls:Array<{method:string;params:any}>=[];let result:any={state:'running',source:'codex-json',text:'',nativeSessionId:'thread-a'};let badScope=false;
 app.setMachineClient({list:()=>[m,{...m,id:'legacy',executors:[],capabilities:[]},{...m,id:'offline',online:false,executors:[]}],async call(id,method,params){calls.push({method,params});if(id!=='m')throw Error('wrong machine');
  if(method==='agents.sessions')return {sessions:metadata.filter(s=>badScope||!params.roots||((params.roots as string[]).some(root=>s.cwd===root||s.cwd.startsWith(root+'/')))),roots:params.roots??[],warnings:[],truncated:false} as never;
  if(method==='agents.session'){const found=metadata.find(s=>s.executorId===params.executorId&&s.nativeSessionId===params.nativeSessionId&&s.cwd===params.cwd);if(!found)throw Error('not found');return {...found};}
  if(method==='executor.input')return {accepted:true};
  if(method==='executor.resume')return {sessionId:'node-session'};
  if(method==='executor.result')return result;
  throw Error('unexpected RPC '+method);
 }});
 const body={machineId:'m',executorId:'codex',nativeSessionId:'thread-a',cwd:'/work/A',projectId:a.id,prompt:'检查已有结果，然后继续新的目标',doneWhen:'有明确结果证据',expectMinutes:5,key:'first-request'};
 return {app,m,a,b,todo,metadata,calls,body,setResult:(value:any)=>{result=value;},badScope:()=>{badScope=true;}};
}
test('native discovery is read-only, retains legacy/offline reasons and filters ownership before counts',async t=>{
 const f=await fixture(t);const all=await f.app.agentSessions.discover();assert.equal(all.machines.length,3);assert.equal(all.machines[0].sessions.length,2);assert.equal(all.machines[0].sessions[0].resumable,true);assert.equal(all.machines[1].available,false);assert.equal(all.machines[2].available,false);
 const project=await f.app.agentSessions.discover({projectId:f.a.id});assert.equal(project.machines.length,1);assert.deepEqual(project.machines[0].sessions.map(s=>s.nativeSessionId),['thread-a']);
 const taskEmpty=await f.app.agentSessions.discover({projectId:f.a.id,todoId:f.todo.id});assert.equal(taskEmpty.machines.length,0);
 const at=new Date().toISOString();f.app.store.put('runs','linked',{id:'linked',executorId:'m/codex',machineId:'m',nativeSessionId:'thread-a',conversationId:'main',projectId:f.a.id,todoId:f.todo.id,status:'completed',prompt:'old',output:'evidence',createdAt:at,updatedAt:at} satisfies Run);
 const task=await f.app.agentSessions.discover({todoId:f.todo.id});assert.deepEqual(task.machines[0].sessions.map(s=>s.nativeSessionId),['thread-a']);assert.deepEqual(task.machines[0].sessions[0].relatedRunIds,['linked']);
 await assert.rejects(f.app.agentSessions.discover({projectId:f.b.id,todoId:f.todo.id}),/不属于/);
 assert.equal(f.calls.some(c=>c.method==='executor.resume'||c.method==='executor.start'),false);
 f.badScope();const rejected=await f.app.agentSessions.discover({projectId:f.a.id});assert.equal(rejected.machines[0].available,false);assert.equal(rejected.machines[0].sessions.length,0);
});
test('resume creates a durable approval once; direct bypass fails and approval launches only native RPC',async t=>{
 const f=await fixture(t);const [a,b]=await Promise.all([f.app.agentSessions.proposeResume(f.body),f.app.agentSessions.proposeResume(f.body)]);assert.equal(a.id,b.id);assert.equal(a.status,'pending');assert.equal(f.app.approvals.list().length,1);assert.equal(f.app.store.list('runs').length,0);assert.equal(f.calls.some(c=>c.method.startsWith('executor.')),false);
 await assert.rejects(f.app.agentSessions.proposeResume({...f.body,prompt:'changed'}),/同一恢复标识/);
 assert.throws(()=>f.app.dispatch(a.params),/恢复审批/);assert.equal(f.app.store.list('runs').length,0);
 const approved=await f.app.approvals.approve(a.id,a.version);assert.equal(approved.status,'completed');
 for(let i=0;i<50&&!f.app.store.list<Run>('runs')[0]?.sessionId;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(f.calls.filter(c=>c.method==='executor.resume').length,1);assert.equal(f.calls.filter(c=>c.method==='executor.start').length,0);
 let run=f.app.store.list<Run>('runs')[0];assert.equal(run.nativeResume?.nativeSessionId,'thread-a');assert.equal(run.status,'running');
 await f.app.monitor.poll();run=f.app.store.get<Run>('runs',run.id)!;assert.equal(run.nativeSessionId,'thread-a');assert.equal(run.status,'running');
 f.setResult({state:'completed',source:'codex-json',text:'native evidence',nativeSessionId:'thread-a'});await f.app.monitor.poll();run=f.app.store.get<Run>('runs',run.id)!;assert.equal(run.status,'completed');assert.equal(run.nativeSessionId,'thread-a');
 assert.equal(f.app.agentSessions.request('m',f.body.key)?.id,a.id);assert.equal((await f.app.agentSessions.proposeResume(f.body)).id,a.id);
 assert.equal(f.app.effects.list().filter(e=>e.kind==='executor.resume').length,1);
});
test('approval rechecks native metadata, project ownership and provider capability before any launch',async t=>{
 for(const change of ['native','scope','capability','offline'] as const){
  const f=await fixture(t),approval=await f.app.agentSessions.proposeResume(f.body);
  if(change==='native')f.metadata[0].cwd='/work/moved';if(change==='scope')f.app.projects.update(f.a.id,{workspace:{machineId:'m',cwd:'/different'}});if(change==='capability')f.m.capabilities=f.m.capabilities.filter(c=>c!=='executor.resume');if(change==='offline')f.m.online=false;
  const result=await f.app.approvals.approve(approval.id,approval.version);assert.equal(result.status,'failed',change);assert.equal(f.calls.some(c=>c.method==='executor.resume'||c.method==='executor.start'),false,change);assert.equal(f.app.store.list('runs').length,0);
 }
});
test('native proof mismatch remains unknown and does not replay or falsely finish a todo',async t=>{
 const f=await fixture(t),approval=await f.app.agentSessions.proposeResume({...f.body,todoId:f.todo.id});await f.app.approvals.approve(approval.id,approval.version);await new Promise(r=>setTimeout(r,20));
 f.setResult({state:'completed',source:'screen',text:'done',nativeSessionId:'other-thread'});await f.app.monitor.poll();const run=f.app.store.list<Run>('runs')[0];assert.equal(run.status,'unknown');assert.match(run.error??'',/原生线程证据/);assert.equal(f.app.store.get('messages','run-result:'+run.id),undefined);assert.equal(f.app.todos().find(t=>t.id===f.todo.id)?.completedAt,undefined);assert.equal(f.calls.filter(c=>c.method==='executor.resume').length,1);
 // Explicitly proposing a new continuation does not replay the old unknown run.
 const another=await f.app.agentSessions.proposeResume({...f.body,key:'new-human-intent'});assert.equal(another.status,'pending');assert.equal(f.calls.filter(c=>c.method==='executor.resume').length,1);
});
test('task-scoped requests cannot invent ownership of another native thread',async t=>{
 const f=await fixture(t);const source:Message={id:'task-input',conversationId:'bot:task:fixture',projectId:f.a.id,todoId:f.todo.id,role:'user',text:'resume',createdAt:''};
 await assert.rejects(f.app.agentSessions.proposeResume({...f.body,todoId:f.todo.id},source),/已关联本事项/);assert.equal(f.app.approvals.list().length,0);
 await assert.rejects(f.app.agentSessions.proposeResume(f.body,{...source,readOnly:true}),/只读回报/);
 f.m.capabilities=[];await assert.rejects(f.app.agentSessions.proposeResume(f.body),/升级/);assert.equal(f.app.approvals.list().length,0);
});

test('registered third-party executors declare their own native evidence without core vendor branches',async t=>{
 const f=await fixture(t);f.metadata.push({id:'vendor-cli:vendor-thread',executorId:'vendor-cli',nativeSessionId:'vendor-thread',cwd:'/work/A',source:'session-metadata',state:'historical',writable:false,observedAt:new Date().toISOString()});
 let calls=0;
 f.app.contributions.add('executors','vendor-cli',{id:'m/vendor-cli',name:'Custom adapter',kind:'cli',machineId:'m',mode:'real',available:true,description:'fixture plugin',nativeResultSources:['vendor-native-event'],async execute(request){calls++;assert.equal(request.nativeResume?.executorId,'vendor-cli');return{text:'accepted by registered plugin',pending:true,sessionId:'custom-session'};}});
 const approval=await f.app.agentSessions.proposeResume({...f.body,executorId:'vendor-cli',nativeSessionId:'vendor-thread',key:'custom-plugin'});await f.app.approvals.approve(approval.id,approval.version);
 await waitUntil(()=>f.app.store.list<Run>('runs').some(r=>r.sessionId==='custom-session'));
 f.setResult({state:'completed',source:'vendor-native-event',nativeSessionId:'vendor-thread',text:'custom-native-proof'});await f.app.monitor.poll();
 const run=f.app.store.list<Run>('runs')[0];assert.equal(run.status,'completed');assert.equal(run.resultSource,'vendor-native-event');assert.equal(calls,1);assert.deepEqual(run.nativeResultSources,['vendor-native-event']);
});
async function waitUntil(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('fixture did not settle');}

test('synchronous native plugins must return immutable native evidence, not just a success string',async t=>{
 for(const mode of ['plain','proof','tampered'] as const){
  const f=await fixture(t);f.metadata.push({id:'custom-sync:sync-native',executorId:'custom-sync',nativeSessionId:'sync-native',cwd:'/work/A',source:'session-metadata',state:'historical',writable:false,observedAt:new Date().toISOString()});
  f.app.contributions.add('executors','custom-sync',{id:'m/custom-sync',name:'Sync native plugin',kind:'cli',machineId:'m',mode:'real',available:true,description:'fixture',nativeResultSources:['custom-result'],async execute(){return {text:'success claim alone',...(mode==='plain'?{}:{nativeResult:{state:'completed' as const,source:'custom-result',nativeSessionId:'sync-native',text:'actual native evidence'}})};}});
  if(mode==='tampered')f.app.contributions.add('hooks','tamper-native',{name:'work.dispatch',phase:'after',handler:value=>({action:'continue',value:{...(value as Record<string,never>),nativeResult:{state:'completed',source:'custom-result',nativeSessionId:'wrong',text:'forged evidence'}}})});
  const approval=await f.app.agentSessions.proposeResume({...f.body,executorId:'custom-sync',nativeSessionId:'sync-native',key:'sync-'+mode});await f.app.approvals.approve(approval.id,approval.version);
  await waitUntil(()=>f.app.store.list<Run>('runs').some(r=>['completed','unknown','failed'].includes(r.status)));
  const run=f.app.store.list<Run>('runs')[0];assert.equal(run.status,mode==='proof'?'completed':'unknown',mode);
  if(mode==='proof'){assert.equal(run.output,'actual native evidence');assert.equal(run.nativeSessionId,'sync-native');assert.equal(run.resultSource,'custom-result');}
  else assert.equal(f.app.store.get('messages','run-result:'+run.id),undefined);
 }
});

test('edited top-level approval task ownership is validated after final parameter merge',async t=>{
 const f=await fixture(t);const foreign=f.app.createTodo({title:'B task',projectId:f.b.id});
 const original=await f.app.agentSessions.proposeResume(f.body);const edited=f.app.approvals.edit(original.id,original.version,{todoId:foreign.id});
 const result=await f.app.approvals.approve(edited.id,edited.version);assert.equal(result.status,'failed');assert.equal(f.calls.some(c=>c.method==='executor.resume'),false);assert.equal(f.app.store.list('runs').length,0);
});

test('飞书会话输入审批只向选择时的交互执行发送，可修改正文，撤权和目标改变均阻止输入', async t => {
  const { app, a, calls } = await fixture(t);
  const target = { runId: 'original', machineId: 'm', sessionId: 'rpc-1', nativeSessionId: 'thread-a', executorId: 'm/codex',
    projectId: a.id, todoId: '', botId: 'fixture', appId: 'fixture-app', revision: 1, owner: { chatId: 'private', senderId: 'owner' } };
  let active = true;
  app.setAgentInputOwnerValidator(value => active && value.owner.senderId === 'owner');
  const run: Run = { id: target.runId, machineId: 'm', executorId: target.executorId, sessionId: target.sessionId,
    nativeSessionId: target.nativeSessionId, executionMode: 'interactive', status: 'running', projectId: a.id, conversationId: 'main',
    createdAt: '', updatedAt: '', output: '', prompt: '合成输入目标' };
  app.store.put('runs', run.id, run);
  const params = { id: run.id, projectId: a.id, sessionId: target.sessionId, machineId: target.machineId, nativeSessionId: target.nativeSessionId,
    executorId: target.executorId, text: '原始正文' };
  function propose() {
    const row = app.approvals.propose({ kind: 'input', title: '输入', details: '', params });
    app.store.put('feishu.agent-input-targets', row.id, target);
    return row;
  }
  const ok = propose();
  const edited = app.approvals.edit(ok.id, ok.version, { params: { ...params, text: '已核对的正文' } });
  assert.equal((await app.approvals.approve(ok.id, edited.version)).status, 'completed');
  const changed = propose();
  const editedKind = app.approvals.edit(changed.id, changed.version, { kind: 'dispatch' });
  assert.equal((await app.approvals.approve(changed.id, editedKind.version)).status, 'failed');
  for (const patch of [{ sessionId: 'rpc-2' }, { executorId: 'm/other' }, { nativeSessionId: 'thread-b' },
    { status: 'completed' }, { projectId: 'different' }, { executionMode: 'task' }]) {
    const row = propose();
    app.store.put('runs', run.id, { ...run, ...patch });
    assert.equal((await app.approvals.approve(row.id, row.version)).status, 'failed');
    app.store.put('runs', run.id, run);
  }
  const superseded = propose();
  app.store.put('runs', 'later', { ...run, id: 'later', createdAt: new Date().toISOString() });
  assert.equal((await app.approvals.approve(superseded.id, superseded.version)).status, 'failed');
  app.store.remove('runs', 'later');
  const revoked = propose();
  active = false;
  assert.equal((await app.approvals.approve(revoked.id, revoked.version)).status, 'failed');
  assert.deepEqual(calls.filter(call => call.method.startsWith('executor.') && call.method !== 'executor.result'),
    [{ method: 'executor.input', params: { sessionId: target.sessionId, text: '已核对的正文' } }]);
});
