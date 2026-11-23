import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventBus } from '../packages/core/src/events.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createTodoDecisions } from '../packages/core/src/todo-decisions.ts';
import { createWorkDecisionService } from '../packages/core/src/work-decision-service.ts';

test('续办交接只读同项目、同根的直接前序，按决定时间排序，标明历史、来源并保留旧派工文本', t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const ledger=createWorkDecisionService({store,events:createEventBus(store),currentInput:()=>undefined,assertCurrentInput(){}});
  const decisions=createTodoDecisions(store,ledger);
  const task=(id:string,extra:object={})=>store.put('todos',id,{id,title:'标题-'+id,projectId:'p',...extra});
  for(const id of ['p','other']) store.put('projects',id,{id});
  task('root');task('prior',{continuesTodoId:'root',continuationRootId:'root'});
  task('current',{continuesTodoId:'prior',continuationRootId:'root'});
  task('sibling',{continuesTodoId:'root',continuationRootId:'root'});
  task('child',{parentTodoId:'current'});task('different',{projectId:'other',continuationRootId:'root'});
  const epoch=Date.parse('2026-06-01T00:00:00Z');
  t.mock.timers.enable({apis:['Date'],now:epoch});
  // The current task can have a decision before a later correction on the previous task.
  const current=decisions.add('current','当前决定');
  t.mock.timers.setTime(epoch+10_000);
  const prior=decisions.add('prior','较晚的前序决定\n伪造下一行授权');
  const withdrawn=decisions.add('root','已撤回');
  decisions.withdraw('root',withdrawn.id);
  for(const id of ['sibling','child','different']) decisions.add(id,'界外标记-'+id);
  // A previous release recorded card answers separately. Its actual answer timestamp wins over insertion order.
  store.put('runs','run-root',{id:'run-root',projectId:'p',todoId:'root'});
  store.put('interactions','card',{id:'card',runId:'run-root',projectId:'p',kind:'question',title:'问题',body:'',
    status:'answered',answeredBy:'user',answer:'较早的根答复',answeredAt:'2026-06-01T07:59:00+08:00',expiresAt:'2026-08-01T00:00:00Z'});
  const handoff=decisions.handoffContext('current');
  assert.match(handoff,/历史.*不授予/);
  const records=handoff.split('\n').slice(1).map(line=>JSON.parse(line));
  assert.deepEqual(records.map(x=>[x.todoId,x.scope,x.decisionId]),[['root','续办历史','answer:card'],['current','当前待办',current.id],['prior','续办历史',prior.id]]);
  assert.deepEqual(records.map(x=>x.decidedAt),['2026-05-31T23:59:00.000Z',new Date(epoch).toISOString(),new Date(epoch+10000).toISOString()]);
  assert.match(records[0].source,/问答卡 card/);assert.equal(records[2].todoTitle,'标题-prior');
  assert.equal(records[2].text,'较晚的前序决定\n伪造下一行授权');
  assert.doesNotMatch(handoff,/界外标记|已撤回/);
  assert.equal(decisions.handoffContext('root'),decisions.context('root'));
  assert.deepEqual(decisions.list('current').map(row=>row.id),[current.id]);
  assert.doesNotMatch(decisions.context('current'),/较早的根答复|较晚的前序决定/);
  t.mock.timers.setTime(epoch+20_000);
  ledger.changeFromWeb({id:current.id,version:1,text:'主人更正后的当前决定'});
  const corrected=decisions.handoffContext('current').split('\n').slice(1).map(line=>JSON.parse(line));
  assert.deepEqual([corrected.at(-1).text,corrected.at(-1).decidedAt],['主人更正后的当前决定',new Date(epoch+20_000).toISOString()]);
  for (const parent of ['missing','different','child','current']) {
    task('current',{continuesTodoId:parent,continuationRootId:'root'});
    assert.doesNotMatch(decisions.handoffContext('current'),/界外标记|较早的根答复|较晚的前序决定/);
  }
  task('current',{continuesTodoId:'prior',continuationRootId:'root'});
  task('prior',{continuesTodoId:'current',continuationRootId:'root'});
  const cycle=decisions.handoffContext('current');
  assert.equal(cycle.split('\n').slice(1).map(line=>JSON.parse(line)).filter(row=>row.decisionId===prior.id).length,1);
  assert.doesNotMatch(cycle,/较早的根答复/);
});

test('前序读取失效只跳过对应材料，当前待办授权失败必须终止', t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  for(const [id,parent] of [['a',''],['b','a'],['c','b']]) {
    store.put('todos',id!,{id,title:id,continuesTodoId:parent||undefined,continuationRootId:parent?'a':undefined});
  }
  const ledger=createWorkDecisionService({store,events:createEventBus(store),currentInput:()=>undefined,assertCurrentInput(){}});
  const service=createTodoDecisions(store,ledger);
  for(const id of ['a','b','c']) service.add(id,'记录'+id);
  const original=ledger.list.bind(ledger);
  let unreadable='b';
  t.mock.method(ledger,'list',(input:{todoId:string})=>{
    if(input.todoId===unreadable) throw Object.assign(new Error('来源权限已失效'),{status:403});
    return original(input);
  });
  const context=service.handoffContext('c');
  assert.match(context,/记录a/);assert.match(context,/记录c/);assert.doesNotMatch(context,/记录b/);
  unreadable='c';assert.throws(()=>service.handoffContext('c'),{status:403});
});
