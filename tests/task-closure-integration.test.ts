import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../apps/server/src/index.ts';
import type {Run} from '../packages/protocol/src/index.ts';
const wait=async(check:()=>boolean)=>{for(let i=0;i<150;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('local closure did not settle');};
async function fixture(t:test.TestContext){
 const dir=await mkdtemp(join(tmpdir(),'mario-closure-http-'));
 const server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,demo:true,token:'closure-fixture'});
 t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
 let calls=0,unknown=false;
 server.app.contributions.add('executors','closure-fixture',{id:'closure-fixture',name:'Local protocol fixture',kind:'fixture',machineId:'fixture',mode:'real',available:true,description:'A controlled executor; no actual provider',async execute(){calls++;if(unknown)throw Object.assign(new Error('fixture uncertainty'),{delivery:'unknown'});return{text:'Controlled executor delivered evidence'};}});
 const api=async(path:string,method='GET',body?:unknown,status=200)=>{const r=await fetch(server.url+'/api/v1'+path,{method,headers:{Authorization:'Bearer closure-fixture','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;};
 const project=await api('/projects','POST',{name:'Closure Project'},201),todo=await api('/todos','POST',{title:'Verify delivery',projectId:project.id},201);
 const launch=async()=>{const run=await api('/runs','POST',{executorId:'closure-fixture',prompt:'Produce verifiable result',projectId:project.id,todoId:todo.id,doneWhen:'Controlled fixture evidence returned',expectMinutes:1},202);await wait(()=>['completed','unknown'].includes(server.app.store.get<Run>('runs',run.id)!.status));return server.app.store.get<Run>('runs',run.id)!;};
 return{server,api,project,todo,launch,calls:()=>calls,uncertain:()=>{unknown=true;}};
}
test('HTTP report and acceptance share the completion guard; reopen invalidates both proofs',async t=>{
 const f=await fixture(t),base='/todos/'+f.todo.id;
 assert.equal((await fetch(f.server.url+'/api/v1'+base+'/closure')).status,401);
 await f.api(base+'/reporting','PUT',{required:true,version:0});
 await f.api(base,'PATCH',{completed:true},409);
 const run=await f.launch();assert.equal(run.status,'completed');assert.equal(f.server.app.todos()[0].completedAt,undefined);
 const review=await f.api(base+'/review','POST',{runId:run.id});
 const decision={version:review.version,runId:run.id,evidenceVersion:review.evidenceVersion,action:'accept'};
 await f.api(base+'/review/decide','POST',decision,409);
 assert.equal((await f.api(base+'/closure')).review.status,'pending','Failed completion rolls back the acceptance too');
 const report=await f.api(base+'/report','POST',{version:1,messageId:'run-result:'+run.id});assert.equal(report.report.todoId,f.todo.id);
 await f.api(base,'PATCH',{completed:true},409); // A report cannot bypass a pending explicit review.
 await f.api(base+'/review/decide','POST',decision);
 assert.ok(f.server.app.todos()[0].completedAt);
 await f.api(base+'/review/decide','POST',decision);assert.equal(f.calls(),1);
 await f.api(base,'PATCH',{completed:false});
 const reopened=await f.api(base+'/closure');assert.equal(reopened.reporting.cycle,2);assert.equal(reopened.reporting.report,undefined);assert.equal(reopened.review.status,'reopened');
 await f.api(base,'PATCH',{completed:true},409);
 await f.api(base+'/report','POST',{version:reopened.reporting.version,messageId:'run-result:'+run.id},409);
 await f.api(base+'/review','POST',{runId:run.id,version:reopened.review.version},409);
});

test('HTTP rework is a new bounded round and duplicate decisions never dispatch twice',async t=>{
 const f=await fixture(t),base='/todos/'+f.todo.id;
 await f.api('/task-closure/settings','PUT',{maxReworks:1});
 await f.api('/task-closure/settings','PUT',{maxReworks:-1},400);
 const run=await f.launch(),review=await f.api(base+'/review','POST',{runId:run.id});
 const decision={version:review.version,runId:run.id,evidenceVersion:review.evidenceVersion,action:'rework',defects:'Add missing verification evidence'};
 const next=await f.api(base+'/review/decide','POST',decision);assert.equal(next.round,1);assert.notEqual(next.runId,run.id);
 const repeat=await f.api(base+'/review/decide','POST',decision);assert.equal(repeat.runId,next.runId);
 await wait(()=>f.server.app.store.get<Run>('runs',next.runId)?.status==='completed');assert.equal(f.calls(),2);
 const fresh=(await f.api(base+'/closure')).review;
 await f.api(base+'/review/decide','POST',{...decision,version:fresh.version,runId:fresh.runId,evidenceVersion:fresh.evidenceVersion},409);
 assert.equal(f.calls(),2);assert.equal(f.server.app.todos()[0].completedAt,undefined);
});

test('ordinary todos keep manual completion while unknown executions cannot be accepted or reworked',async t=>{
 const f=await fixture(t),normal=await f.api('/todos','POST',{title:'Legacy ordinary todo'},201);
 await f.api('/todos/'+normal.id,'PATCH',{completed:true});
 f.uncertain();const run=await f.launch();assert.equal(run.status,'unknown');
 const base='/todos/'+f.todo.id,review=await f.api(base+'/review','POST',{runId:run.id});
 for(const action of ['accept','rework'])await f.api(base+'/review/decide','POST',{version:review.version,runId:run.id,evidenceVersion:review.evidenceVersion,action,defects:'Cannot infer uncertain external execution'},409);
 assert.equal(f.calls(),1);
});

test('project schedule feeds real outbox with only scoped facts and revokes queued delivery on archive',async t=>{
 const f=await fixture(t);
 await f.api('/projects/'+f.project.id,'PATCH',{followUp:{briefingTime:'09:00',automation:'balanced',overdueReminders:true}});
 const schedule=f.server.app.background.schedules.list().find(s=>s.name===`project:${f.project.id}:brief`)!;assert.ok(schedule);
 await f.api('/todos','POST',{title:'Other project private content'},201);
 const now=new Date().toISOString();
 f.server.app.background.publish({type:'schedule.due',typeVersion:1,sourceId:'controlled-project-due',data:{owner:schedule.owner,name:schedule.name,scheduleId:schedule.id,scheduleVersion:schedule.version,scheduledFor:now,payload:schedule.payload!},staleIf:{ref:'schedule:'+schedule.id,version:schedule.version}});
 await wait(()=>f.server.app.background.outbox.list().some(i=>i.dedupKey.startsWith('project-brief:')));
 const outgoing=f.server.app.background.outbox.list().find(i=>i.dedupKey.startsWith('project-brief:'))!;
 assert.match(outgoing.content.text,/Verify delivery/);assert.doesNotMatch(outgoing.content.text,/Other project private content|未归项目/);
 assert.equal(outgoing.relatedTo?.id,f.project.id);assert.notEqual(outgoing.status,'sent');
 f.server.app.projects.archive(f.project.id);
 const cancelled=await f.server.app.background.outbox.send(outgoing.id);assert.equal(cancelled.status,'cancelled');
 assert.equal(f.calls(),0);assert.equal(f.server.app.store.get('briefing.cursors','last'),undefined);
});

test('project follow-up applies actual policy presets atomically and requires explicit trusted-directory confirmation',async t=>{
 const f=await fixture(t),url='/projects/'+f.project.id+'/follow-up';
 const followUp={briefingEnabled:true,briefingTime:'10:30',overdueReminders:true,automation:'balanced'};
 await f.api(url,'PUT',{followUp,expectedUpdatedAt:f.project.updatedAt});
 const p=f.server.app.projects.list().find(p=>p.id===f.project.id)!;
 assert.ok(f.server.app.policies.read({projectId:p.id}).rules.some(rule=>rule.kind==='question'&&rule.mode==='auto'));
 await f.api(url,'PUT',{followUp:{...followUp,automation:'quiet'},expectedUpdatedAt:p.updatedAt},409);
 assert.equal(f.server.app.projects.list().find(row=>row.id===f.project.id)!.followUp?.automation,'balanced');
 f.server.app.projects.update(p.id,{workspace:{machineId:'node',cwd:'/work/project'}});
 await f.api(url,'PUT',{followUp:{...followUp,automation:'quiet'}},400);
 await f.api(url,'PUT',{followUp:{...followUp,automation:'quiet'},confirmed:true});
 const quiet=f.server.app.policies.read({projectId:p.id});assert.ok(quiet.rules.some(rule=>rule.kind==='permission'&&rule.cwdUnder==='/work/project'));
 await f.api(url,'PUT',{followUp:{...followUp,automation:'inherit'}});
 assert.deepEqual(f.server.app.policies.read({projectId:p.id}),f.server.app.policies.read());
 await f.api(url,'PUT',{followUp,expectedUpdatedAt:'stale-project-version'},409);
 assert.equal(f.calls(),0);assert.equal(f.server.app.todos().length,1);
});
