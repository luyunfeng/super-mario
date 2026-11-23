import assert from 'node:assert/strict';
import test from 'node:test';
import {createStore} from '../packages/core/src/store.ts';
import {createEventBus} from '../packages/core/src/events.ts';
import {createPlans} from '../packages/core/src/plans.ts';
import {createRunReview} from '../packages/core/src/run-review.ts';
import type {PlanEstimateDispatch, Run} from '../packages/protocol/src/index.ts';

test('计划估时由宿主冻结，旧计划无来源，手填值跳过校准',t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const calls:{payload:Record<string,unknown>;origin?:PlanEstimateDispatch}[]=[];
  const plans=createPlans({store,events:createEventBus(store),dispatch(payload,_key,origin){
    calls.push({payload,origin});return {id:String(calls.length)};
  }});
  const task={prompt:'验收示例',doneWhen:'检查通过',estimateSource:'learned',estimateEvidence:{sampleCount:100}};
  const plan=plans.propose({title:'合成计划',tasks:[task,{...task,expectMinutes:60}]});
  assert.deepEqual(plan.tasks.map(t=>[t.expectMinutes,t.estimateSource,t.estimateEvidence]),[[60,'default',undefined],[60,'override',undefined]]);
  plans.start(plan.id,1);
  assert.deepEqual(calls.map(r=>r.origin),[{planId:plan.id,taskIndex:0,source:'default'},{planId:plan.id,taskIndex:1,source:'override'}]);
  assert.ok(calls.every(c=>!('estimateSource' in c.payload) && !('estimateEvidence' in c.payload)));
  const legacy={...plan,id:'old',tasks:[{prompt:'旧任务',doneWhen:'旧标准',expectMinutes:60}]};
  store.put('plans',legacy.id,legacy);
  plans.start(legacy.id,1);assert.equal(calls[2]?.origin,undefined);
});

test('限定近90天同范围已验收的计划执行，仅用原生完成耗时取中位数',t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const now=Date.now(), iso=(ms:number)=>new Date(ms).toISOString();
  const executorId='m/fixture', projectId='project-a', cwd='/synthetic/fixture';
  const task={prompt:'检查',doneWhen:'检查通过',projectId,executorId,cwd};
  const review=createRunReview({store,events:createEventBus(store),dispatch:()=>{throw new Error('unexpected rework');},
    completeTodo(id){const row=store.get<Record<string,unknown>>('todos',id)!;store.put('todos',id,{...row,completedAt:iso(Date.now())});}
  });
  let active:{id:string;todoId:string;duration:number;ageDays:number;accepted:boolean}|undefined;
  const plans=createPlans({store,events:createEventBus(store),dispatch(payload,key,origin){
    const sample=active!;
    const finish=now-(1+sample.ageDays)*86400000;
    const run={id:sample.id,todoId:sample.todoId,projectId,executorId,cwd,conversationId:'main',createdAt:iso(finish-sample.duration*60000),updatedAt:iso(now),
      status:'completed',output:'合成证据',executionMode:'task',doneWhen:task.doneWhen,machineId:'m',sessionId:'s-'+sample.id,
      ...(sample.id==='r1' ? {resultSource:'real'} : {nativeResultSources:['synthetic-native'],resultSource:'synthetic-native'}),planEstimate:origin};
    store.put('runs',run.id,run);store.put('dispatch-keys',key!,run.id);
    store.put('todos',sample.todoId,{id:sample.todoId,projectId});
    const id='run-result:'+run.id;
    store.put('messages',id,{id,todoId:sample.todoId,projectId,conversationId:'main',role:'assistant',origin:'result',status:'done',createdAt:iso(finish)});
    const attached=review.attach({todoId:sample.todoId,runId:run.id});
    if(sample.accepted){
      const accepted=review.decide({action:'accept',version:attached.version,todoId:sample.todoId,runId:run.id,evidenceVersion:attached.evidenceVersion});
      // Backdate the synthetic acceptance to the original fixture round.
      store.put('run-reviews',sample.todoId,{...accepted,updatedAt:iso(finish+1000)});
      store.put('todos',sample.todoId,{id:sample.todoId,projectId,completedAt:iso(finish+1000)});
    }
    return {id:run.id};
  }});
  let seq=0;
  function admit(duration:number,accepted=true,ageDays=0) {
    active={id:'r'+(++seq),todoId:'t'+seq,duration,accepted,ageDays};
    const plan=plans.propose({title:'样本',tasks:[{...task,todoId:active.todoId,expectMinutes:15}]});
    plans.start(plan.id,1);return active;
  }
  const propose=(fields:Partial<typeof task>={})=>plans.propose({title:'估时',tasks:[{...task,...fields}]}).tasks[0]!;
  for(const duration of [4,9,80,13]) admit(duration);
  admit(1,false);admit(2,true,100);
  const invalidated=admit(2);
  const reviewed=store.get<Run>('runs',invalidated.id)!;
  store.put('runs',invalidated.id,{...reviewed,output:'验收后的输出已改变'});
  const missingReceipt=admit(3);store.remove('messages','run-result:'+missingReceipt.id);
  const manual=admit(100);const manualRun=store.get<Record<string,unknown>>('runs',manual.id)!;delete manualRun.planEstimate;store.put('runs',manual.id,manualRun);
  assert.equal(propose().estimateSource,'default');
  const fifth=admit(10.1);
  const selected=propose();
  assert.equal(selected.estimateSource,'learned');assert.equal(selected.expectMinutes,11);
  assert.deepEqual(selected.estimateEvidence,{cohort:'project_machine',sampleCount:5,minutes:11});
  assert.equal(propose({projectId:'foreign'}).estimateSource,'default');
  assert.equal(propose({prompt:'实现新功能'}).estimateSource,'default');
  assert.equal(propose({prompt:'仅核实修复是否有效'}).estimateSource,'learned');
  assert.equal(propose({prompt:'不要实现新功能，列出现状'}).estimateSource,'learned');
  assert.equal(propose({prompt:'若需要，则修复后再实现'}).estimateSource,'learned');
  assert.equal(propose({executorId:'other/fixture'}).estimateEvidence?.cohort,'comparable');
  assert.equal(propose({executorId:undefined}).estimateEvidence?.cohort,'comparable');
  store.put('todos',fifth.todoId,{id:fifth.todoId,projectId});
  assert.equal(propose().estimateSource,'default');
});
