import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { todoBrief } from '../packages/core/src/todo-brief.ts';
import { createRunScopes, initialRunCriteria, runScopeClock, runScopeEvidence } from '../packages/core/src/run-scope.ts';
import { createStore } from '../packages/core/src/store.ts';
import type { Run } from '../packages/protocol/src/index.ts';

const run: Run = {id:'r', todoId:'t', projectId:'p', executorId:'fixture', prompt:'任务', conversationId:'main',
  doneWhen:'甲', expectMinutes:20, status:'running', output:'', createdAt:'2026-01-01', updatedAt:'2026-01-01'};
const change = {expectedVersion:0, expectedDoneWhen:'甲', doneWhen:'乙', reason:'补充测试', expectMinutes:30};
const owner = {kind:'web' as const};
function seed(store: ReturnType<typeof createStore>) {
  store.put('projects','p',{id:'p'});
  store.put('todos','t',{id:'t',projectId:'p'});
  store.put('runs','r',run);
}

test('修改首派标准与预计时长后，历史可跨重启读取；重试及 ABA 不覆盖',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-run-scope-'));
  const file=join(dir,'store.sqlite');
  let store=createStore(file);
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  seed(store);
  let scopes=createRunScopes(store);
  assert.equal(scopes.read('r').version,0);
  const revised=scopes.revise('r',change,owner);
  assert.equal(revised.history[0]?.before,'甲');
  assert.equal(revised.history[0]?.after,'乙');
  assert.equal(revised.history[0]?.reason,change.reason);
  assert.deepEqual(revised.history[0]?.added,['乙']);
  assert.deepEqual(revised.history[0]?.dropped,['甲']);
  assert.ok(Date.parse(revised.history[0]!.createdAt));
  assert.equal(revised.initialExpectMinutes,20);
  assert.equal(store.get<Run>('runs','r')?.expectMinutes,30);
  store.close();store=createStore(file);scopes=createRunScopes(store);
  assert.deepEqual(scopes.revise('r',change,owner),revised);
  assert.throws(()=>scopes.revise('r',{...change,reason:'不是重试'},owner),{status:409});
  const back=scopes.revise('r',{expectedVersion:1,expectedDoneWhen:'乙',doneWhen:'甲',reason:'恢复原标准'},
    {kind:'assistant',messageId:'m1'});
  assert.equal(back.version,2);assert.equal(back.initialDoneWhen,'甲');assert.equal(back.expectMinutes,30);
  assert.deepEqual(back.history[1]?.source,{kind:'assistant',messageId:'m1'});
  assert.throws(()=>scopes.revise('r',change,owner),{status:409});
  store.put('runs','r',{...store.get<Run>('runs','r')!,status:'completed'});
  assert.equal(scopes.read('r').history.length,2);
  assert.throws(()=>scopes.revise('r',{...change,expectedVersion:2},owner),{status:409});
});

test('范围、运行状态、输入以及记录身份均在写前校验',t=>{
  const store=createStore(':memory:');t.after(()=>store.close());seed(store);
  const {read,revise}=createRunScopes(store);
  assert.throws(()=>read('missing'),{status:404});
  for(const bad of [{doneWhen:' '},{reason:''},{expectMinutes:Infinity},{expectedVersion:-1},{expectedVersion:undefined}]) {
    assert.throws(()=>revise('r',{...change,...bad} as typeof change,owner),{status:400});
  }
  for(const status of ['queued','cancelled','completed','failed','unknown'] as const) {
    store.put('runs','r',{...run,status});assert.throws(()=>revise('r',change,owner),{status:409});
  }
  store.put('runs','r',{...run,id:'wrong'});assert.throws(()=>read('r'),{status:404});
  store.put('runs','r',run);
  store.put('todos','t',{id:'t',projectId:'other'});assert.throws(()=>revise('r',change,owner),{status:404});
  store.put('todos','t',{id:'t',projectId:'p',completedAt:'today'});assert.throws(()=>revise('r',change,owner),{status:409});
  seed(store);store.put('projects','p',{id:'p',archivedAt:'today'});assert.throws(()=>revise('r',change,owner),{status:409});
  assert.equal(read('r').version,0);
});

test('历史写入失败不留下已改的运行记录',t=>{
  const store=createStore(':memory:');t.after(()=>store.close());seed(store);
  const scopes=createRunScopes({...store,put(collection,id,value) {
    if(collection!=='runs') throw new Error('模拟历史写入失败');
    store.put(collection,id,value);
  }});
  assert.throws(()=>scopes.revise('r',change,owner),/模拟历史写入失败/);
  assert.equal(scopes.read('r').doneWhen,'甲');assert.equal(scopes.read('r').version,0);
});

test('交办依据保留首派内容；没有预设标准的执行首次修订后仍有自己的条目',t=>{
  const store=createStore(':memory:');t.after(()=>store.close());seed(store);
  const scopes=createRunScopes(store);
  scopes.revise('r',change,owner);
  const unscoped={...run,id:'unscoped',doneWhen:undefined,expectMinutes:undefined};
  store.put('runs',unscoped.id,unscoped);
  assert.ok(todoBrief(store,'t').criteria.some(row => row.runId === unscoped.id && row.doneWhen === ''));
  scopes.revise(unscoped.id,{...change,expectedDoneWhen:''},owner);
  const rows=todoBrief(store,'t').criteria;
  assert.deepEqual(rows.map(row=>[row.runId,row.doneWhen,row.expectMinutes]),[['r','甲',20],['unscoped','',undefined]]);
  assert.equal(scopes.read(unscoped.id).doneWhen,'乙');

  store.put('todos','t',{id:'t',projectId:'moved'});
  assert.deepEqual(initialRunCriteria(store,store.get<Run>('runs','r')!),{doneWhen:'甲',expectMinutes:20});
  assert.deepEqual(initialRunCriteria(store,store.get<Run>('runs',unscoped.id)!),{doneWhen:undefined,expectMinutes:undefined});
  assert.deepEqual(todoBrief(store,'t').criteria,[]);
  const standalone={...run,id:'standalone',todoId:undefined};
  store.put('runs',standalone.id,standalone);
  assert.deepEqual(initialRunCriteria(store,standalone),{doneWhen:'甲',expectMinutes:20});
});

test('有效移除证据按首次移除去重，恢复后不再列出；脱离待办或执行归属后隐藏',t=>{
  const store=createStore(':memory:');t.after(()=>store.close());seed(store);
  const original={...run,doneWhen:'甲\n乙\n丙'};
  store.put('runs','r',original);
  const service=createRunScopes(store);
  const current=()=>store.get<Run>('runs','r')!;
  assert.equal(runScopeEvidence(store,current()),undefined);
  assert.deepEqual(service.read('r').droppedCriteria,[]);
  function revise(doneWhen:string,reason:string){
    const {version,doneWhen:expectedDoneWhen}=service.read('r');
    return service.revise('r',{expectedVersion:version,expectedDoneWhen,doneWhen,reason},owner);
  }
  const first=revise('乙','先移除甲和丙');
  revise('甲\n乙\n丙','恢复两项');
  assert.deepEqual(runScopeEvidence(store,current())?.dropped,[]);
  assert.deepEqual(service.read('r').droppedCriteria,[]);
  revise('乙\n丙\n丁','再次移除甲，增加丁');
  const last=revise('丙','去掉乙和丁');
  assert.deepEqual(runScopeClock(store,current()),{version:4,createdAt:last.history[3]!.createdAt});
  const evidence=runScopeEvidence(store,current());
  assert.deepEqual(evidence,{version:4,initialDoneWhen:original.doneWhen,currentDoneWhen:'丙',dropped:[
    {criterion:'甲',reason:'先移除甲和丙',version:1,createdAt:first.history[0]!.createdAt},
    ...['乙','丁'].map(criterion=>({criterion,reason:'去掉乙和丁',version:4,createdAt:last.history[3]!.createdAt})),
  ]});
  assert.deepEqual(last.droppedCriteria,evidence?.dropped);
  assert.deepEqual(service.read('r').droppedCriteria,last.droppedCriteria);
  store.put('todos','t',{id:'t',projectId:'moved'});
  assert.equal(runScopeEvidence(store,current()),undefined);
  store.put('todos','t',{id:'t',projectId:'p'});const stale=current();
  store.put('runs','r',{...stale,todoId:'different'});
  assert.equal(runScopeEvidence(store,stale),undefined);
  assert.equal(runScopeClock(store,stale),undefined);
});
