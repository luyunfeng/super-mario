import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../packages/core/src/store.ts';
import {createEventBus} from '../packages/core/src/events.ts';
import {createRunMonitor} from '../packages/core/src/run-monitor.ts';
import {executionProgress} from '../packages/core/src/execution-progress.ts';
import {startServer} from '../apps/server/src/index.ts';
import {buildWorkContext} from '../packages/core/src/work-context.ts';
import type {Run,ExecutionResult} from '../packages/protocol/src/index.ts';
const progress={phase:'tool' as const,toolName:'file_reader',detail:'读取文件',observedAt:'2026-11-17T00:00:00Z'};
const run:Run={id:'run',executorId:'node/vendor',machineId:'node',sessionId:'workbench-session',nativeResultSources:['vendor-event'],nativeResume:{executorId:'vendor',nativeSessionId:'native-thread'},conversationId:'main',status:'running',executionMode:'task',prompt:'fixture',output:'',createdAt:progress.observedAt,updatedAt:progress.observedAt};
async function fixture(t:test.TestContext){
 const dir=await mkdtemp(join(tmpdir(),'mario-progress-')),store=createStore(join(dir,'test.sqlite')),events=createEventBus(store),results:ExecutionResult[]=[];store.put('runs',run.id,run);
 let value:unknown={state:'running',text:'',source:'vendor-event',nativeSessionId:'native-thread',progress};
 const monitor=createRunMonitor({store,events,machines:()=>({list:()=>[{id:'node',name:'fixture',online:true,platform:'linux',connectedAt:'',capabilities:['executor.result']}],call:async()=>value as any}),onResult:(_run,result)=>{results.push(result);}});
 t.after(async()=>{await monitor.close();store.close();await rm(dir,{recursive:true,force:true});});return{store,events,monitor,results,result:(v:unknown)=>{value=v;}};
}
test('adapter progress has a bounded copied shape and never carries tool input or command arguments',()=>{
 assert.deepEqual(executionProgress({...progress,input:'secret command',extra:{token:'secret'}}),progress);
 for(const bad of [{...progress,phase:'completed'},{...progress,toolName:'x'.repeat(101)},{...progress,detail:'line\nprivate'},{...progress,observedAt:'not-a-time'}])assert.equal(executionProgress(bad),undefined);
});
test('registered native progress is persisted once, remains running and cannot complete a task',async t=>{
 const f=await fixture(t);await f.monitor.poll();const first=f.store.get<Run>('runs',run.id)!;assert.deepEqual(first.progress,progress);assert.equal(first.status,'running');assert.equal(first.resultSource,'vendor-event');assert.equal(f.results.length,0);
 const count=f.events.since(0).length;await f.monitor.poll();assert.equal(f.events.since(0).length,count);assert.deepEqual(f.store.get('runs',run.id),first);
});
test('undeclared sources and mismatching resumed threads cannot supply a progress observation',async t=>{
 for(const values of [{source:'screen',nativeSessionId:'native-thread'},{source:'vendor-event',nativeSessionId:'other-thread'}]){
  const f=await fixture(t);f.result({state:'running',text:'',progress,...values});await f.monitor.poll();assert.equal(f.store.get<Run>('runs',run.id)!.progress,undefined);assert.equal(f.results.length,0);
 }
});
test('late RPC observations cannot revive or overwrite a cancelled execution',async t=>{
 const f=await fixture(t);let done!:(value:unknown)=>void;f.result(new Promise(resolve=>{done=resolve;}));const polling=f.monitor.poll();await new Promise(resolve=>setImmediate(resolve));f.store.put('runs',run.id,{...run,status:'cancelled'});done({state:'running',text:'',source:'vendor-event',nativeSessionId:'native-thread',progress});await polling;assert.equal(f.store.get<Run>('runs',run.id)!.status,'cancelled');assert.equal(f.store.get<Run>('runs',run.id)!.progress,undefined);
});
test('work snapshots expose progress and only real user-owned blockers in the visible project',async t=>{
 const f=await fixture(t);f.store.put('runs',run.id,{...run,projectId:'a',progress});
 for(const [id,projectId,handler]of[['own','a','user'],['automatic','a','supervisor'],['foreign','b','user']])f.store.put('interactions',id,{id,projectId,runId:projectId==='a'?run.id:'foreign-run',handler,status:'open',kind:'permission',title:id,body:'',version:1,createdAt:progress.observedAt});
 const context=buildWorkContext(f.store,{kind:'project',projectId:'a'});assert.deepEqual(context.runs!.items[0].progress,progress);assert.deepEqual(context.runs!.items[0].blockedBy.map(item=>item.id),['own']);assert.ok(!JSON.stringify(context).includes('foreign'));
});
test('real observation HTTP is read-only and separates user blockers from native waiting phases',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mario-progress-http-')),server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,demo:true,token:'fixture'});t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});server.app.store.put('runs',run.id,{...run,progress});
 const first=server.app.interactions.open({kind:'permission',title:'Need directory approval',body:'fixture',runId:run.id});
 const second=server.app.interactions.open({kind:'permission',title:'Automatic stage',body:'fixture',runId:run.id});server.app.store.put('interactions',second.id,{...second,handler:'supervisor'});
 const approval=server.app.approvals.propose({kind:'input',title:'Confirm input',details:'fixture',params:{id:run.id,text:'continue'}});
 assert.equal((await fetch(server.url+'/api/v1/runs/run/observations')).status,401);
 const response=await fetch(server.url+'/api/v1/runs/run/observations',{headers:{authorization:'Bearer fixture'}});assert.equal(response.status,200);const state=await response.json();assert.deepEqual(state.progress,progress);assert.deepEqual(state.blockedBy.map((item:any)=>item.id).sort(),[first.id,approval.id].sort());assert.equal(server.app.store.list('runs').length,1);assert.equal(server.app.todos().length,0);assert.equal(server.app.effects.list().length,0);
 server.app.interactions.withdraw(first.id,first.version);server.app.approvals.reject(approval.id,approval.version);
 const updated=await(await fetch(server.url+'/api/v1/runs/run/observations',{headers:{authorization:'Bearer fixture'}})).json();assert.equal(updated.blockedBy.length,0);assert.equal(server.app.store.get<Run>('runs',run.id)!.status,'running');
});
