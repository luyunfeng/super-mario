import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Run, Todo } from '../packages/protocol/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createSupervision, waitingRunQuestion } from '../packages/core/src/supervision.ts';

test('执行提问在主人等待阈值只生成一条可复核信号，审批同名、重启和换版各自独立',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'supervision-question-'));
  const path=join(dir,'main.db');
  let time=Date.parse('2026-02-10T08:00:00Z');
  const stamp=new Date(time).toISOString();
  const emitted:unknown[]=[];
  function open() {
    const store=createStore(path);
    const service=createSupervision({store,events:createEventBus(store),now:()=>new Date(time),publish:event=>emitted.push(event)});
    return {store,service,close(){service.close();store.close();}};
  }
  let f=open();t.after(()=>{f.close();rmSync(dir,{force:true,recursive:true});});
  f.service.configure({needsYouMinutes:2});
  const run:Run={id:'run',projectId:'p',todoId:'todo',status:'running',executorId:'fixture',conversationId:'main',prompt:'',
    executionMode:'interactive',output:'',createdAt:stamp,updatedAt:stamp};
  const todo:Todo={id:'todo',title:'离线验收',notes:'',projectId:'p',createdAt:stamp,updatedAt:stamp};
  f.store.put('projects','p',{id:'p'}); f.store.put('todos',todo.id,todo);f.store.put('runs',run.id,run);
  const question:Card={id:'shared',kind:'question',runId:run.id,projectId:'p',executorId:run.executorId,
    title:'内部标题',body:'私有正文',status:'open',version:1,handler:'user',layer:'default',
    createdAt:new Date(time-3600000).toISOString(),updatedAt:stamp,expiresAt:new Date(time+3600000).toISOString(),
    routingHistory:[{handler:'supervisor',outcome:'timeout',at:stamp}]};
  const put=(card:Card)=>f.store.put('interactions',card.id,card);
  put(question);
  f.store.put('approvals',question.id,{id:question.id,title:'安全审批',status:'pending',version:1,updatedAt:stamp});
  time+=119999;f.service.tick();assert.deepEqual(f.service.signals(),[]);
  ++time;f.service.tick();
  const onlyOpen=()=>f.service.signals().filter(s=>s.questionCardId && !s.resolvedAt);
  assert.equal(f.service.signals().length,2);const first=onlyOpen()[0]!;
  assert.equal(first.kind,'needs_you');assert.equal(first.questionVersion,1);assert.equal(first.questionCardId,question.id);
  assert.equal(first.todoId,todo.id);assert.equal(first.runId,run.id);
  assert.ok(!JSON.stringify(emitted).includes('私有'));assert.ok(!JSON.stringify(emitted).includes('内部标题'));
  assert.equal(f.store.list('interactions').length,1);
  f.close();f=open();f.service.tick();assert.equal(onlyOpen()[0]!.id,first.id);assert.equal(emitted.length,2);
  f.store.put('todos','another',{...todo,id:'another'});
  f.store.put('runs',run.id,{...run,todoId:'another'});f.service.tick();
  assert.deepEqual(onlyOpen(),[]);assert.ok(f.service.signals().find(s=>s.id===first.id)?.resolvedAt);
  f.store.put('runs',run.id,run);
  put({...question,version:2});f.service.tick();assert.equal(onlyOpen().length,1);assert.equal(onlyOpen()[0]!.questionVersion,2);
  assert.ok(f.service.signals().find(s=>s.id===first.id)?.resolvedAt);
  put({...question,version:3,status:'answered'});f.service.tick();assert.deepEqual(onlyOpen(),[]);
  assert.equal(waitingRunQuestion(f.store,question.id,time),undefined);
  put(question);time=Date.parse(question.expiresAt);f.service.tick();assert.deepEqual(onlyOpen(),[]);
});

test('只核对当前范围仍有效的普通执行提问',()=>{
  const store=createStore(':memory:');
  try {
    const now=Date.now(),expiresAt=new Date(now+60000).toISOString();
    const card={id:'card',kind:'question',status:'open',handler:'user',version:1,runId:'r',projectId:'p',expiresAt,executorId:'x',cwd:'/fixture'};
    const run={id:'r',projectId:'p',todoId:'t',executorId:'x',cwd:'/fixture',status:'running'};
    const valid=()=>!!waitingRunQuestion(store,card.id,now);
    store.put('projects','p',{id:'p'});store.put('todos','t',{id:'t',projectId:'p'});store.put('runs','r',run);
    for(const patch of [{kind:'permission'},{kind:'review'},{status:'withdrawn'},{status:'expired'},{wait:false},{handler:'rules'},{version:0},{runId:'absent'},
      {projectId:'q'},{executorId:'other'},{cwd:'/other'},{expiresAt:'invalid'}]) {
      store.put('interactions',card.id,{...card,...patch});assert.equal(valid(),false,JSON.stringify(patch));
    }
    store.put('interactions',card.id,card);assert.equal(valid(),true);
    for (const patch of [{status:'completed'},{status:'queued'},{status:'unknown'},{executionMode:'task'},{todoId:'missing'},{id:'foreign'}]) {
      store.put('runs','r',{...run,...patch});assert.equal(valid(),false,JSON.stringify(patch));
    }
    store.put('runs','r',run);
    for (const patch of [{id:'foreign'},{projectId:'moved'},{completedAt:expiresAt}]) {
      store.put('todos','t',{id:'t',projectId:'p',...patch});assert.equal(valid(),false,JSON.stringify(patch));
    }
    store.put('todos','t',{id:'t',projectId:'p'});store.put('projects','p',{id:'p',archivedAt:expiresAt});assert.equal(valid(),false);
    store.remove('projects','p');assert.equal(valid(),false);
    store.put('interactions','card',{...card,projectId:undefined});store.put('runs','r',{...run,projectId:undefined,todoId:undefined});
    assert.equal(valid(),true);
  } finally {store.close();}
});
