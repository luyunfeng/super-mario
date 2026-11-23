import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { recordTodoOrigin, todoBrief } from '../packages/core/src/todo-brief.ts';
import type { Todo } from '../packages/protocol/src/index.ts';

const start='2026-01-01T00:00:00Z';
const todo=(id:string,fields:Partial<Todo>={}):Todo=>({id,title:'初始标题-'+id,notes:'初始备注-'+id,projectId:'p',createdAt:start,updatedAt:start,...fields});

test('创建说明不可变，续办读取真实根，逐轮列出同范围标准；重启及私密消息不改变原说明', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-todo-brief-'));
  const file=join(dir,'fixture.sqlite');
  let store=createStore(file);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const root=todo('root');
  const first=todo('first',{continuesTodoId:root.id,continuationRootId:root.id,continuationReason:'最初的交接说明'});
  const last=todo('latest',{continuesTodoId:first.id,continuationRootId:root.id,continuationReason:'第二次接手'});
  const sibling=todo('sibling',{continuesTodoId:root.id,continuationRootId:root.id});
  const child=todo('child',{parentTodoId:first.id});
  for(const item of [root,first,last,sibling,child]) store.put('todos',item.id,item);
  store.put('messages','om_private',{id:'om_private',conversationId:'private-thread',text:'私聊原文保密标记'});
  recordTodoOrigin(store,root,'assistant',{id:'om_private',conversationId:'private-thread'});
  recordTodoOrigin(store,first,'continuation');
  recordTodoOrigin(store,last,'continuation');
  const edit={...root,title:'后来标题',notes:'后来备注'};
  store.put('todos',root.id,edit);
  recordTodoOrigin(store,edit,'web',{id:'another-message',conversationId:'main',text:'不能覆盖原记录'});
  const newer={...first,continuationReason:'随后修改的说明'};
  store.put('todos',first.id,newer);recordTodoOrigin(store,newer,'continuation');
  const addRun=(id:string,todoId:string,createdAt:string,extra:object={})=>store.put('runs',id,{
    id,todoId,projectId:'p',createdAt,doneWhen:'标准-'+id,executorId:'fixture',prompt:'不公开派工原文',...extra,
  });
  addRun('second',first.id,'2026-01-01T08:20:00+08:00',{expectMinutes:12});
  addRun('first',root.id,'2026-01-01T00:10:00Z');
  addRun('third',last.id,'2026-01-01T00:30:00Z');
  addRun('fourth',last.id,'2026-01-01T00:35:00Z');
  addRun('branch',sibling.id,start);addRun('hierarchy',child.id,start);addRun('scope',last.id,start,{projectId:'other'});
  addRun('empty',last.id,start,{doneWhen:' '});addRun('impostor',last.id,start,{id:'fake'});
  store.close();store=createStore(file);
  const brief=todoBrief(store,last.id);
  assert.deepEqual(brief.origin,{todoId:'root',kind:'assistant',title:root.title,notes:root.notes,createdAt:start,sourceMessageId:'om_private'});
  assert.equal(brief.reconstructed,false);
  assert.deepEqual(brief.criteria.map(r=>[r.todoId,r.runId,r.doneWhen,r.expectMinutes]),
    [['root','first','标准-first',undefined],['first','second','标准-second',12],['latest','third','标准-third',undefined],['latest','fourth','标准-fourth',undefined]]);
  assert.doesNotMatch(JSON.stringify(brief),/私聊原文|不公开派工原文|后来备注|private-thread/);
  assert.equal(todoBrief(store,last.id,true,'other-thread').origin.sourceMessageId,undefined);
  assert.equal(todoBrief(store,last.id,true,'private-thread').origin.sourceMessageId,'om_private');
  const scoped=todoBrief(store,first.id,false);
  assert.equal(scoped.origin.title,first.title);assert.equal(scoped.origin.continuationReason,'最初的交接说明');
  assert.deepEqual(scoped.criteria.map(r=>r.runId),['second']);
});

test('旧库明确重建；源快照和派工不能随迁移、伪造根或循环跨出当前范围', t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const root=todo('root'), next=todo('next',{continuesTodoId:'root',continuationRootId:'root'});
  store.put('todos','root',root);store.put('todos','next',next);
  const legacy=todoBrief(store,next.id);
  assert.equal(legacy.reconstructed,true);assert.equal(legacy.origin.kind,'reconstructed');assert.equal(legacy.origin.title,root.title);
  recordTodoOrigin(store,root,'web',{id:'msg',conversationId:'main',text:'😀'.repeat(2001)});
  const verified=todoBrief(store,next.id);assert.equal(verified.origin.requestText,'😀'.repeat(2000));
  assert.deepEqual(todoBrief(store,next.id,true,'main'),verified);
  const foreign=todoBrief(store,next.id,true,'feishu:private:other').origin;
  assert.equal(foreign.kind,'web');
  assert.ok(!Object.hasOwn(foreign,'requestText') && !Object.hasOwn(foreign,'sourceMessageId'));
  assert.ok(!Object.hasOwn(verified.origin,'conversationId') && !Object.hasOwn(foreign,'conversationId'));
  assert.deepEqual(todoBrief(store,next.id),verified);
  store.put('todos','root',{...root,projectId:'different',notes:'迁移后的现行备注'});
  const moved=todoBrief(store,'root');assert.equal(moved.reconstructed,true);assert.equal(moved.origin.sourceMessageId,undefined);
  assert.equal(moved.origin.notes,'迁移后的现行备注');assert.equal(moved.origin.requestText,undefined);
  assert.equal(todoBrief(store,next.id).origin.todoId,next.id);
  for(const change of [{id:'wrong'},{continuesTodoId:'next'},{continuationRootId:'unrelated'}]) {
    store.put('todos','root',{...root,...change});assert.equal(todoBrief(store,next.id).origin.todoId,next.id);
  }
  assert.throws(()=>todoBrief(store,'missing'),{status:404});
  store.put('todos','next',{...next,id:'wrong'});assert.throws(()=>todoBrief(store,'next'),{status:404});
});

test('回滚创建事务同时回滚原始说明，旧记录读取不冒充创建事实', t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const task=todo('draft');
  assert.throws(()=>store.transaction(()=>{store.put('todos',task.id,task);recordTodoOrigin(store,task,'web');throw new Error('rollback');}));
  store.put('todos',task.id,{...task,title:'后来才实际创建'});
  assert.equal(todoBrief(store,task.id).reconstructed,true);
  assert.equal(store.entries?.('todo.brief-origins').length,0);
});
