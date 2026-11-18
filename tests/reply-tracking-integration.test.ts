import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {startServer} from '../apps/server/src/index.ts';
import {buildWorkContext} from '../packages/core/src/work-context.ts';
import {referenceCurrent} from '../packages/core/src/eventbox.ts';
import type {NormalizedReplyEvidence,Todo} from '../packages/protocol/src/index.ts';
const source='feishu:offline-app:offline-account';
async function fixture(t:test.TestContext){const dir=await mkdtemp(join(tmpdir(),'mario-reply-http-'));let server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'local-test'});t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});const headers={authorization:'Bearer local-test','content-type':'application/json'};return{get server(){return server;},async request(path:string,method='GET',body?:unknown){const r=await fetch(server.url+'/api/v1'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,value:await r.json() as any};},async restart(){await server.close();server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'local-test'});}};}
function messages():NormalizedReplyEvidence[]{const at=new Date(Date.now()-60000).toISOString();return[{source,chatId:'chat',messageId:'ask',senderId:'me',senderIdType:'open_id',createdAt:at},{source,chatId:'chat',messageId:'past-person',senderId:'person',senderIdType:'open_id',createdAt:at}];}
test('trusted collection → real HTTP selection → direct reply stops only current waiting reminder and survives restart',async t=>{
 const f=await fixture(t);const app=f.server.app;app.waitingReplies.observeSource(source,messages().map((x,i)=>({...x,preview:i?'之前回复':'要跟进的问题'})));
 const created=await f.request('/todos','POST',{title:'等待明确回复',waitingOn:'对方',reminderAt:new Date(Date.now()+60000).toISOString(),dueAt:new Date(Date.now()+86400000).toISOString()});assert.equal(created.status,201);const todo=created.value;
 const sources=await f.request('/todos/'+todo.id+'/waiting-reply/sources');const anchor=sources.value.items.find((x:any)=>x.messageId==='ask');
 assert.equal((await f.request('/todos/'+todo.id+'/waiting-reply','POST',{key:'wait',anchorId:'forged',expectedSenderId:'person',expectedSenderIdType:'open_id'})).status,409);
 const armed=await f.request('/todos/'+todo.id+'/waiting-reply','POST',{key:'wait',anchorId:anchor.id,expectedSenderId:'person',expectedSenderIdType:'open_id'});assert.equal(armed.status,201);assert.equal(armed.value.status,'waiting');
 const stale={ref:'reminder:'+JSON.stringify([todo.id,todo.reminderAt]),version:1};assert.equal(referenceCurrent(app.store,stale),true);await delay(5);
 const reply={...messages()[1]!,messageId:'answer',parentId:'ask',createdAt:new Date().toISOString()};assert.equal(app.waitingReplies.observeSource('other-account',[reply]).matched,0);assert.equal(app.waitingReplies.observeSource(source,[{...reply,messageId:'same-thread',parentId:undefined,threadId:'thread'}]).matched,0);
 assert.equal(app.waitingReplies.observeSource(source,[reply]).matched,1);assert.equal(app.waitingReplies.observeSource(source,[reply]).matched,0);
 const after=app.store.get<Todo>('todos',todo.id)!;assert.equal(after.completedAt,undefined);assert.equal(after.waitingOn,undefined);assert.equal(after.reminderAt,undefined);assert.equal(after.dueAt,todo.dueAt);assert.equal(referenceCurrent(app.store,stale),false);
 const context=buildWorkContext(app.store);assert.equal(context.todos!.items.find(x=>x.id===todo.id)!.replyTracking!.status,'matched');
 await f.restart();const retained=await f.request('/todos/'+todo.id+'/waiting-reply');assert.equal(retained.value.status,'matched');assert.equal(retained.value.hit.evidence.messageId,'answer');
});
test('manual wait edits invalidate immediately even if identical values are later restored; unrelated title edits preserve waiting',async t=>{
 const f=await fixture(t);const app=f.server.app;app.waitingReplies.observeSource(source,messages());const todo=(await f.request('/todos','POST',{title:'等待',waitingOn:'对方',reminderAt:new Date(Date.now()+60000).toISOString()})).value;
 const anchor=app.waitingReplies.sources(todo.id).items.find(x=>x.messageId==='ask')!;app.waitingReplies.arm(todo.id,{key:'cycle',anchorId:anchor.id,expectedSenderId:'person',expectedSenderIdType:'open_id'});
 await f.request('/todos/'+todo.id,'PATCH',{title:'只改标题'});assert.equal(app.waitingReplies.get(todo.id)!.status,'waiting');
 await f.request('/todos/'+todo.id,'PATCH',{waitingOn:'另一个人'});assert.equal(app.waitingReplies.get(todo.id)!.status,'invalidated');await f.request('/todos/'+todo.id,'PATCH',{waitingOn:'对方'});await delay(5);
 assert.equal(app.waitingReplies.observeSource(source,[{...messages()[1]!,messageId:'late',parentId:'ask',createdAt:new Date().toISOString()}]).matched,0);assert.equal(app.store.get<Todo>('todos',todo.id)!.reminderAt,todo.reminderAt);
});
test('queued reminder outbox is invalidated after an actual reply without sending or completing the Todo',async t=>{
 const f=await fixture(t);const app=f.server.app;app.waitingReplies.observeSource(source,messages());const todo=app.createTodo({title:'排队提醒',waitingOn:'对方',reminderAt:new Date(Date.now()+60000).toISOString()});const anchor=app.waitingReplies.sources(todo.id).items.find(x=>x.messageId==='ask')!;app.waitingReplies.arm(todo.id,{key:'q',anchorId:anchor.id,expectedSenderId:'person',expectedSenderIdType:'open_id'});
 const stale={ref:'reminder:'+JSON.stringify([todo.id,todo.reminderAt]),version:1};const queued=app.background.outbox.enqueue('reminders',{dedupKey:'test-reminder',channel:'feishu.bot',target:'owner',content:{text:'local fixture'},staleIf:stale});
 await delay(5);app.waitingReplies.observeSource(source,[{...messages()[1]!,messageId:'reply',parentId:'ask',createdAt:new Date().toISOString()}]);
 const result=await app.background.outbox.send(queued.id);assert.equal(result.status,'cancelled');assert.equal(app.store.get<Todo>('todos',todo.id)!.completedAt,undefined);
});
