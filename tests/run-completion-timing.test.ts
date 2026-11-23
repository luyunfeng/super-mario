import assert from 'node:assert/strict';
import test from 'node:test';
import {createStore} from '../packages/core/src/store.ts';
import {runCompletionTiming} from '../packages/core/src/run-completion-timing.ts';
import type {Message,Run} from '../packages/protocol/src/index.ts';

test('计划实际用时取首次完成回执，修订预计或稍后验收都不改变首派差额',t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const start='2026-01-01T00:00:00Z', finish='2026-01-01T00:02:01Z';
  const run:Run={id:'r',todoId:'t',projectId:'p',createdAt:start,updatedAt:'2026-01-03',executionMode:'task',
    executorId:'m/sample',planEstimate:{planId:'plan',source:'default',taskIndex:0},
    prompt:'执行',sourceMessageId:'input',conversationId:'main',status:'completed',expectMinutes:12,resultSource:'real',output:'完成证据'};
  const receipt:Message={id:'run-result:r',role:'assistant',origin:'result',status:'done',conversationId:'main',projectId:'p',todoId:'t',
    replyTo:'input',createdAt:finish,text:'完成证据'};
  const task={runId:'r',projectId:'p',todoId:'t',expectMinutes:60,estimateSource:'default'};
  store.put('plans','plan',{id:'plan',version:1,tasks:[task]});
  store.put('runs','r',run);store.put('todos','t',{id:'t',projectId:'p'});store.put('messages',receipt.id,receipt);
  store.put('dispatch-keys','plan:plan:1:0',run.id);
  const expected={startedAt:start,reportedAt:finish,source:'real',receiptId:receipt.id,actualMinutes:3,initialEstimateMinutes:60,deltaMinutes:-57};
  assert.deepEqual(runCompletionTiming(store,run),expected);
  const interactive:Run = {...run,executionMode:'interactive'};
  assert.equal(runCompletionTiming(store,interactive),undefined);
  assert.equal(runCompletionTiming(store,{...interactive,resultSource:'fixture-native',nativeResultSources:['fixture-native']})?.actualMinutes,3);
  store.put('run-reviews','t',{status:'accepted',updatedAt:'2026-01-03'});
  assert.deepEqual(runCompletionTiming(store,run),expected);
  store.put('messages',receipt.id,{...receipt,createdAt:start});
  assert.equal(runCompletionTiming(store,run)?.actualMinutes,1);
  for(const bad of [{runResult:{runId:'r',status:'failed',source:'real'}},{runResult:{runId:'other',status:'completed',source:'real'}},{runResult:{runId:'r',status:'completed',source:'other'}},{replyTo:'foreign'},{todoId:'other'},{origin:'notification'},{createdAt:'2025-12-31'}]){
    store.put('messages',receipt.id,{...receipt,...bad});assert.equal(runCompletionTiming(store,run),undefined);
  }
  store.put('messages',receipt.id,receipt);
  for(const patch of [{planEstimate:undefined},{status:'failed'},{resultSource:'screen'}] as const){
    assert.equal(runCompletionTiming(store,{...run,...patch}),undefined);
  }
  store.put('dispatch-keys','plan:plan:1:0','other');assert.equal(runCompletionTiming(store,run),undefined);
  store.put('dispatch-keys','plan:plan:1:0',run.id);
  store.put('todos','t',{id:'t',projectId:'moved'});assert.equal(runCompletionTiming(store,run),undefined);
});
