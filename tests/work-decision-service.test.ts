import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../packages/core/src/store.ts';
import {createEventBus} from '../packages/core/src/events.ts';
import {createWorkDecisionService} from '../packages/core/src/work-decision-service.ts';
import {startServer} from '../apps/server/src/index.ts';
import {runWithAgentInput} from '../packages/core/src/agent-input.ts';
import type {Message,JsonObject} from '../packages/protocol/src/index.ts';
const now='2026-11-17T00:00:00Z';
async function fixture(t:test.TestContext){
 const dir=await mkdtemp(join(tmpdir(),'mario-decision-service-')),store=createStore(join(dir,'db')),events=createEventBus(store);
 for(const id of ['a','b'])store.put('projects',id,{id,name:id,createdAt:now,updatedAt:now});
 store.put('todos','task',{id:'task',projectId:'a',title:'task',createdAt:now,updatedAt:now});
 let current:Message|undefined,checks=0;
 const service=createWorkDecisionService({store,events,currentInput:()=>current,assertCurrentInput:()=>{checks++;}});
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 return{store,events,service,get checks(){return checks;},input(message?:Partial<Message>){current=message?{id:'input',conversationId:'main',role:'user',text:'用户明确要求记录',createdAt:now,...message}:undefined;if(current)store.put('messages',current.id,current);return current;}};
}
test('Web explicit edits have stable user provenance, idempotent keys, revisions and no queued model turn',async t=>{
 const f=await fixture(t);const first=f.service.recordFromWeb({key:'key',text:'先验收再发布',projectId:'a'});
 assert.equal(first.version,1);assert.equal(f.store.get<Message>('messages',first.source.messageId)!.status,'done');
 assert.equal(f.store.get<Message>('messages',first.source.messageId)!.conversationId,'project:a:work');
 assert.deepEqual(f.service.recordFromWeb({key:'key',text:'先验收再发布',projectId:'a'}),first);assert.equal(f.store.list('messages').length,1);
 assert.throws(()=>f.service.recordFromWeb({key:'key',text:'改变请求',projectId:'a'}),{status:409});assert.equal(f.store.list('messages').length,1);
 const changed=f.service.changeFromWeb({id:first.id,version:1,text:'先检查真实结果再验收'});assert.equal(changed.version,2);
 assert.throws(()=>f.service.ledger.reference(first),{status:409});assert.equal(f.service.ledger.reference(changed).text,changed.text);
 assert.throws(()=>f.service.changeFromWeb({id:first.id,version:1,text:'旧版本'}),{status:409});assert.equal(f.store.list('messages').length,2);
 const gone=f.service.changeFromWeb({id:first.id,version:2},true);assert.equal(gone.status,'withdrawn');assert.equal(gone.version,3);assert.throws(()=>f.service.ledger.reference(gone),{status:409});
 assert.equal(f.service.list({projectId:'b'}).counts.total,0);assert.equal(f.checks,0);
});
test('Agent mutations pin actual user source and reject result/reflection or widened project ownership',async t=>{
 const f=await fixture(t);assert.throws(()=>f.service.recordFromAgent({key:'a',text:'x'}),{status:403});
 for(const patch of [{readOnly:true},{origin:'result' as const},{role:'assistant' as const}]){f.input(patch);assert.throws(()=>f.service.recordFromAgent({key:'a',text:'x'}),{status:403});}
 f.input({conversationId:'project:a:work',projectId:'a'});const fact=f.service.recordFromAgent({key:'a',text:'项目决定'});assert.deepEqual(fact.scope,{kind:'project',projectId:'a'});assert.equal(fact.source.messageId,'input');
 assert.throws(()=>f.service.recordFromAgent({key:'b',text:'跨项目',projectId:'b'}),{status:403});
 f.input({conversationId:'project:b:work',projectId:'b',id:'other'});assert.throws(()=>f.service.changeFromAgent({id:fact.id,version:1,text:'篡改'}),{status:403});
 assert.throws(()=>f.service.referenceFromAgent({id:fact.id,version:1}),{status:403});
 f.input({conversationId:'project:a:work',projectId:'a',readOnly:true,origin:'result',id:'result'});assert.equal(f.service.referenceFromAgent({id:fact.id,version:1}).id,fact.id);
});
test('fresh context uses current versions, reports invalid provenance and never includes raw source text',async t=>{
 const f=await fixture(t);f.input({text:'PRIVATE_ORIGINAL_USER_CHAT'});const fact=f.service.recordFromAgent({key:'context',text:'公开摘要',projectId:'a'});
 let value=f.service.context({kind:'project',projectId:'a'});assert.match(JSON.stringify(value),/公开摘要/);assert.doesNotMatch(JSON.stringify(value),/PRIVATE_ORIGINAL_USER_CHAT/);
 f.input({id:'correct',text:'另一段原文'});const corrected=f.service.changeFromAgent({id:fact.id,version:1,text:'最新决定'});
 value=f.service.context({kind:'project',projectId:'a'});assert.match(JSON.stringify(value),/最新决定/);assert.doesNotMatch(JSON.stringify(value),/公开摘要/);
 assert.doesNotMatch(JSON.stringify(f.service.context({kind:'project',projectId:'b'})),/最新决定/);
 f.store.put('message.routes',fact.source.messageId,{channel:'feishu',accountId:'new-app',target:'new-target'});
 assert.throws(()=>f.service.ledger.reference(corrected),{status:409});assert.match(JSON.stringify(f.service.context()),/unavailable/);
});
test('real HTTP records, corrects and withdraws decisions; builtin tools reuse cross-entry source and stale checks',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mario-decision-http-'));const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'offline-test'});
 t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
 const headers={authorization:'Bearer offline-test','content-type':'application/json'};
 const request=(path:string,method='GET',body?:unknown)=>fetch(server.url+'/api/v1'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await fetch(server.url+'/api/v1/work-decisions')).status,401);
 let response=await request('/work-decisions','POST',{key:'http',text:'每次交付要附依据'});assert.equal(response.status,201);const first=await response.json() as any;
 assert.equal((await request('/work-decisions','POST',{key:'forged',text:'x',sourceMessageId:'other'})).status,400);
 response=await request('/work-decisions/'+first.id,'PATCH',{version:1,text:'每次交付附当前版本依据'});assert.equal(response.status,200);const next=await response.json() as any;
 assert.equal((await request('/work-decisions/'+first.id,'PATCH',{version:1,text:'过期'})).status,409);
 const source:Message={id:'independent-channel',conversationId:'main',role:'user',text:'引用刚才的决定',createdAt:now,status:'done'};server.app.store.put('messages',source.id,source);
 const tool=(name:string)=>server.app.contributions.list('tools').find(x=>x.value.name===name)!.value;
 await assert.rejects(runWithAgentInput(source,()=>tool('work_decision_reference').execute({id:first.id,version:1},new AbortController().signal)),{status:409});
 const reference=await runWithAgentInput(source,()=>tool('work_decision_reference').execute({id:first.id,version:2},new AbortController().signal));assert.equal((reference as JsonObject).text,next.text);
 response=await request('/work-decisions/'+first.id+'/withdraw','POST',{version:2});assert.equal(response.status,200);assert.equal((await response.json() as any).status,'withdrawn');
 const final=await(await request('/work-decisions')).json() as any;assert.equal(final.items[0].version,3);assert.equal(final.counts.withdrawn,1);
});
test('archived projects preserve historical facts without allowing new mutations or poisoning other scopes',async t=>{
 const f=await fixture(t);const project=f.service.recordFromWeb({key:'old',text:'该项目的既有决定',projectId:'a'});const global=f.service.recordFromWeb({key:'global',text:'持续有效的全局决定'});
 f.store.put('projects','a',{...f.store.get<object>('projects','a'),archivedAt:now});
 assert.equal(f.service.list().counts.total,2);assert.equal(f.service.ledger.reference(project).text,project.text);
 assert.equal(f.service.ledger.reference(global).text,global.text);assert.doesNotMatch(JSON.stringify(f.service.context()),/unavailable/);
 assert.throws(()=>f.service.recordFromWeb({key:'new',text:'不应新增',projectId:'a'}),{status:409});assert.throws(()=>f.service.changeFromWeb({id:project.id,version:1,text:'不应改动'}),{status:409});
});

test('project parent may reference its task decision while unrelated task inputs remain bounded',async t=>{
 const f=await fixture(t);const fact=f.service.recordFromWeb({key:'task',text:'任务内决定',todoId:'task'});f.input({conversationId:'project:a:work',projectId:'a'});assert.equal(f.service.referenceFromAgent({id:fact.id,version:fact.version}).id,fact.id);f.input({conversationId:'main',todoId:'other',projectId:'a',id:'other-task'});assert.throws(()=>f.service.referenceFromAgent({id:fact.id,version:fact.version}),{status:403});
});
