import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import { runWithAgentInput } from '../packages/core/src/agent-input.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import type { EffectRecord } from '../packages/core/src/effects.ts';
import type { Json, JsonObject, Message, Run } from '../packages/protocol/src/index.ts';

test('Web 主人聊天逐字选择原执行的单题选项，模型改选和重放都不能再发输入',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'run-chat-choice-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true,token:'chat-choice-fixture'});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const {app}=server;
  const machineId='choice-fixture',sessionId='choice-session',inputs:JsonObject[]=[];
  app.setMachineClient({
    list:()=>[{id:machineId,name:'选项验收替身',platform:'linux',online:true,connectedAt:'2026-01-01T00:00:00Z',
      capabilities:['executor.start','executor.input'],executors:[{id:'codex',name:'进程内替身',kind:'cli',available:true,mode:'real',description:'合成执行机',machineId}]}],
    async call(machine,method,params):Promise<Json> {
      assert.equal(machine,machineId);
      if (method==='executor.start') return {sessionId};
      assert.equal(method,'executor.input');
      inputs.push(params);return {requested:true};
    },
  });
  async function post<T>(path:string,data:object,status:number) {
    const response=await fetch(server.url+'/api/v1'+path,{method:'POST',
      headers:{authorization:'Bearer chat-choice-fixture','content-type':'application/json'},body:JSON.stringify(data)});
    const body=await response.text();
    assert.equal(response.status,status,body);return JSON.parse(body) as T;
  }
  const original=await post<Message>('/messages',{text:'准备两个排序方案供我选择。'},202);
  const run=await post<Run>('/runs',{executorId:machineId+'/codex',executionMode:'interactive',cwd:dataDir,
    prompt:'准备排序草稿',sourceMessageId:original.id},202);
  await t.waitFor(()=>assert.equal(app.store.get<Run>('runs',run.id)?.sessionId,sessionId));
  const card=await post<Card>('/interactions',{kind:'question',title:'选择排序',body:'',runId:run.id,
    deadline:'10m',reversible:true,questions:[{question:'按哪列排序？',options:[{label:'按月'},{label:'按部门'}],recommend:'按月'}]},201);
  const answer=app.contributions.list('tools').find(entry=>entry.value.name==='interaction_answer')!.value;
  const choose=(source:Message,text?:string)=>runWithAgentInput(source,()=>answer.execute({id:card.id,version:card.version,...(text!==undefined && {text})},new AbortController().signal));
  const unrelated=await post<Message>('/messages',{text:'现在进展怎样？'},202);
  await assert.rejects(async()=>choose(unrelated,'按月'));
  assert.equal(app.store.get<Card>('interactions',card.id)?.status,'open');
  assert.equal(inputs.length,0);
  const owner=await post<Message>('/messages',{text:'按部门'},202);
  assert.equal(owner.directWebInput,true);
  await choose(owner);
  const answered=app.store.get<Card>('interactions',card.id)!;
  assert.equal(answered.status,'answered');assert.equal(answered.delivery,'confirmed');
  assert.equal(answered.byDefault,undefined);assert.deepEqual(answered.answers,[{selected:['按部门']}]);
  assert.equal(inputs.length,1);assert.equal(inputs[0]!.sessionId,sessionId);
  assert.match(String(inputs[0]!.text),/按部门/);assert.doesNotMatch(String(inputs[0]!.text),/按月/);
  const effect=app.store.get<EffectRecord>('effects','interaction:'+card.id)!;
  assert.equal(effect.target,run.id);assert.equal(effect.status,'confirmed');
  assert.deepEqual(effect.result,{requested:true});
  await assert.rejects(async()=>choose(owner));
  assert.equal(inputs.length,1);
});
