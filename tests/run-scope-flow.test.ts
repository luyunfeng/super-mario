import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Run, Todo } from '../packages/protocol/src/index.ts';
import type { RunReview } from '../packages/core/src/run-review.ts';
import type { createRunScopes } from '../packages/core/src/run-scope.ts';

type Scope = ReturnType<ReturnType<typeof createRunScopes>['read']>;

test('Web 调整范围时原执行回执已在途，重试沿用一次派工；验收及重启读取新标准', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-run-scope-flow-'));
  const config={dataDir:dir,host:'127.0.0.1',port:0,token:'scope-local-test',demo:true};
  let server=await startServer(config);
  let release!: ()=>void;
  const waitForRelease=new Promise<void>(resolve=>{release=resolve;});
  let launches=0, resultReads=0;
  const node=startAgentNode({url:server.url,dataDir:join(dir,'worker'),token:config.token,machineId:'local-worker',name:'本地协议替身',
    executors:[{id:'codex',machineId:'local-worker',name:'受控执行器',kind:'fixture',mode:'real',available:true,
      description:'只返回合成回执',defaultCwd:dir,nativeResultSources:['fixture-native']}],
    handlers:{
      'executor.start':async()=>{launches++;return {sessionId:'local-session'};},
      'executor.result':async()=>{resultReads++;await waitForRelease;return {state:'completed',source:'fixture-native',
        nativeSessionId:'local-native',text:'完成回执中的合成证据',doneWhen:'原验收标准'};},
    }});
  let nodeClosed=false;
  t.after(async()=>{release();try{if(!nodeClosed) await node.close();await server.close();}finally{await rm(dir,{recursive:true,force:true});}});
  async function api<T>(path:string,method='GET',input?:object,status=200,key?:string) {
    const response=await fetch(server.url+'/api/v1/'+path,{method,headers:{authorization:'Bearer '+config.token,
      'content-type':'application/json',...(key && {'idempotency-key':key})},...(input && {body:JSON.stringify(input)})});
    const data=await response.json();assert.equal(response.status,status,method+' '+path+' '+JSON.stringify(data));return data as T;
  }
  const project=await api<{id:string}>('projects','POST',{name:'范围验收项目'},201);
  const todo=await api<Todo>('todos','POST',{title:'验证运行中范围调整',projectId:project.id},201);
  await t.waitFor(async()=>assert.ok((await server.app.snapshot()).executors.some(e=>e.id==='local-worker/codex'&&e.available)));
  const input={executorId:'local-worker/codex',todoId:todo.id,projectId:project.id,prompt:'合成派工内容',
    executionMode:'task',cwd:dir,doneWhen:'原验收标准',expectMinutes:10};
  const key='fixture-key';
  const run=await api<Run>('runs','POST',input,202,key);
  const path='runs/'+run.id+'/scope';
  const get=()=>api<Scope>(path+'?expectedProjectId='+project.id);
  await t.waitFor(()=>assert.equal(server.app.store.get<Run>('runs',run.id)?.sessionId,'local-session'));
  const pending=server.app.monitor.poll();
  await t.waitFor(()=>assert.ok(resultReads>0));
  const initial=await get();assert.equal(initial.version,0);assert.equal(initial.doneWhen,input.doneWhen);
  const change={expectedVersion:0,expectedDoneWhen:input.doneWhen,expectedProjectId:project.id,
    doneWhen:'调整后须通过回归测试',reason:'主人补充交付要求',expectMinutes:25};
  await api(path,'POST',{...change,expectedProjectId:null},409);
  const revised=await api<Scope>(path,'POST',change);
  assert.deepEqual(revised.history.map(e=>[e.before,e.after,e.reason,e.source.kind]),[[input.doneWhen,change.doneWhen,change.reason,'web']]);
  assert.deepEqual(await api<Scope>(path,'POST',change),revised);
  await api(path,'POST',{...change,doneWhen:'另一条过期写入'},409);
  const replay=await api<Run>('runs','POST',input,202,key);
  assert.equal(replay.id,run.id);assert.equal(replay.doneWhen,change.doneWhen);
  await api('runs','POST',{...input,doneWhen:change.doneWhen},409,key);
  release();await pending;
  const completed=await get();assert.equal(completed.status,'completed');assert.equal(completed.doneWhen,change.doneWhen);
  assert.equal(completed.expectMinutes,25);
  const review=await api<RunReview>('todos/'+todo.id+'/review','POST',{version:0,runId:run.id});
  assert.equal(review.doneWhen,change.doneWhen);assert.equal(review.status,'pending');
  const brief=await api<{criteria:{runId:string;doneWhen:string;expectMinutes:number}[]}>('todos/'+todo.id+'/brief');
  assert.deepEqual(brief.criteria.map(r=>[r.runId,r.doneWhen,r.expectMinutes]),[[run.id,input.doneWhen,10]]);
  assert.equal(launches,1);
  await node.close();nodeClosed=true;await server.close();server=await startServer(config);
  assert.deepEqual(await get(),completed);
  const afterRestart=await api<Run>('runs','POST',input,202,key);
  assert.deepEqual([afterRestart.id,afterRestart.status,afterRestart.doneWhen],[run.id,'completed',change.doneWhen]);
  await api(path,'POST',{...change,expectedVersion:1,expectedDoneWhen:change.doneWhen,doneWhen:'迟到的变更'},409);
});
