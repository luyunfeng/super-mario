import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEventBus } from '../packages/core/src/events.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createTodoDecisions } from '../packages/core/src/todo-decisions.ts';
import { createWorkDecisionService } from '../packages/core/src/work-decision-service.ts';
import type { Run } from '../packages/protocol/src/index.ts';

function setup(file:string) {
  const store=createStore(file);
  const ledger=createWorkDecisionService({store,events:createEventBus(store),currentInput:()=>undefined,assertCurrentInput(){}});
  const decisions=createTodoDecisions(store,ledger);
  function assign(id:string,sessionId:string,machineId='fixture') {
    const run:Run={id:machineId+'/'+sessionId,sessionId,machineId,todoId:id,projectId:'project',status:'running',
      executorId:machineId+'/codex',createdAt:'2026-01-01',updatedAt:'2026-01-01',conversationId:'main',prompt:'合成',output:''};
    store.put('projects','project',{id:'project'});
    store.put('runs',run.id,run);
    store.put('todos',id,{id,projectId:'project',responsibleSession:{runId:run.id,machineId,sessionId}});
    return run;
  }
  return {store,decisions,assign};
}

test('工作者决定保留内容与执行来源，接任者可替代有效工作者决定，撤回不复活旧决定', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'todo-agent-ledger-'));
  const file=join(dir,'fixture.sqlite');
  let f=setup(file);
  t.after(async()=>{f.store.close();await rm(dir,{recursive:true,force:true});});
  const run=f.assign('one','first'), other=f.assign('two','other');
  const manual=f.decisions.add('one','主人选择');
  const args={question:' 选择哪种方法 ',choice:' 使用甲 ',reason:' 已验证 '};
  assert.throws(()=>f.decisions.addAgent('two',run,args),{status:403});
  assert.throws(()=>f.decisions.addAgent('one',run,{...args,machineId:'自报'}),{status:400});
  const first=f.decisions.addAgent('one',run,args);
  assert.equal(first.source,'agent');assert.equal(first.sourceId,run.id);
  assert.deepEqual([first.question,first.choice,first.reason],['选择哪种方法','使用甲','已验证']);
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));
  const record=f.store.get<{machineId:string;sessionId:string;runId:string;projectId:string}>('todo.agent-decisions',first.id);
  assert.deepEqual([record?.machineId,record?.sessionId,record?.runId,record?.projectId],[run.machineId,run.sessionId,run.id,'project']);
  const context=f.decisions.context('one');
  assert.match(context,/工作者决定 .*来源执行/);
  const quoted=context.split('\n').slice(1).map(line=>JSON.parse(line));
  assert.equal(quoted.length,2);
  assert.equal(quoted.find(item=>item.sources[0].includes(first.id)).text,first.text);
  assert.throws(()=>f.decisions.addAgent('one',run,{...args,supersedesId:manual.id}),{status:409});
  assert.throws(()=>f.decisions.addAgent('two',other,{...args,supersedesId:first.id}),{status:409});
  const next=f.assign('one','second');
  assert.throws(()=>f.decisions.addAgent('one',run,args),{status:403});
  const second=f.decisions.addAgent('one',next,{...args,choice:'改用乙',supersedesId:first.id});
  assert.equal(second.supersedesId,first.id);
  assert.throws(()=>f.decisions.addAgent('one',next,{...args,supersedesId:first.id}),{status:409});
  assert.throws(()=>f.decisions.withdraw('two',second.id),{status:404});
  f.store.close();f=setup(file);
  assert.equal(f.decisions.list('one').find(d=>d.id===first.id)?.active,false);
  assert.ok(!f.decisions.context('one').includes('使用甲'));
  assert.match(f.decisions.context('one'),/改用乙/);
  f.decisions.withdraw('one',second.id);
  assert.equal(f.decisions.list('one').filter(d=>d.active).length,1);
  assert.match(f.decisions.context('one'),/主人选择/);
  assert.doesNotMatch(f.decisions.context('one'),/使用甲|改用乙/);
  f.store.put('projects','project',{id:'project',archivedAt:new Date().toISOString()});
  assert.throws(()=>f.decisions.addAgent('one',next,args),{status:409});
  assert.throws(()=>f.decisions.withdraw('one',second.id),{status:409});
  const assigned=f.store.get<Record<string,unknown>>('todos','one')!;
  f.store.put('projects','different-project',{id:'different-project'});
  f.store.put('todos','one',{...assigned,projectId:'different-project'});
  assert.ok(!f.decisions.list('one').some(d=>d.source==='agent'));
  assert.throws(()=>f.decisions.withdraw('one',second.id),{status:404});
});

test('三段按码点截断；限额按机器与会话滚动计数，替代和撤回都计入', t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const {store,decisions,assign}=setup(':memory:');t.after(()=>store.close());
  const run=assign('one','shared');
  for(const bad of [{question:'',choice:'a'},{question:'q',choice:' '},{question:'q',choice:'c',reason:2}])
    assert.throws(()=>decisions.addAgent('one',run,bad),{status:400});
  const long='😀'.repeat(4001), cut='😀'.repeat(4000)+'…';
  const row=decisions.addAgent('one',run,{question:long,choice:long,reason:long});
  assert.deepEqual([row.question,row.choice,row.reason],[cut,cut,cut]);
  const args={question:'问题',choice:'选择'};
  const correction=decisions.addAgent('one',run,{...args,supersedesId:row.id});
  decisions.withdraw('one',correction.id);
  for(let i=0;i<8;i++) decisions.addAgent('one',run,args);
  now+=599_999;
  assert.throws(()=>decisions.addAgent('one',run,args),{status:429});
  const other=assign('two','shared','different-machine');
  assert.ok(decisions.addAgent('two',other,args).id);
  now++;
  assert.ok(decisions.addAgent('one',run,args).id);
});
