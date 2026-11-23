import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { MachineClient } from '../packages/plugin-sdk/src/index.ts';
import type { Json, JsonObject, Run } from '../packages/protocol/src/index.ts';

test('主人修改后开始计划：整批检查先于派发，执行者接收修改后的工作，旧确认不能再启动', async t => {
  const dataDir=await mkdtemp(join(tmpdir(),'mario-plan-edit-'));
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,token:'offline-plan',demo:true});
  t.after(async()=>{try{await server.close();}finally{await rm(dataDir,{recursive:true,force:true});}});
  const starts:JsonObject[]=[];
  const machine:MachineClient={
    list:()=>['first','second'].map(id=>({id,name:'合成执行机',online:true,platform:'linux',connectedAt:new Date().toISOString(),
      capabilities:['executor.start','executor.result'],executors:[{
        id:'codex',name:'合成执行者',kind:'cli',machineId:id,available:true,mode:'real',description:'进程内替身',
      }]})),
    async call(id,method,args):Promise<Json>{
      assert.ok(id==='first'||id==='second');
      if(method==='executor.result')return {state:'running'};
      assert.equal(method,'executor.start');
      starts.push(args);
      return {sessionId:'synthetic-'+starts.length};
    },
  };
  server.app.setMachineClient(machine);
  const post=(path:string,body:object)=>fetch(server.url+'/api/v1/'+path,{method:'POST',
    headers:{authorization:'Bearer offline-plan','content-type':'application/json'},body:JSON.stringify(body)});
  const first={prompt:'保留第一项',doneWhen:'原标准',executorId:'first/codex',cwd:dataDir};
  const incompatible=await post('plans',{title:'第二步模型不可用',tasks:[first,{...first,model:'fixture-model'}]});
  assert.equal(incompatible.status,201);
  const pending=await incompatible.json();
  const rejected=await post('plans/'+pending.id+'/start',{version:pending.version});
  assert.equal(rejected.status,400);
  assert.match(await rejected.text(),/模型/);
  assert.deepEqual(server.app.plans.get(pending.id),pending);
  assert.equal(server.app.store.list('runs').length,0);
  assert.equal(starts.length,0);
  const proposal=await post('plans',{title:'分项检查',tasks:[first,{...first,prompt:'第二项旧原文'}]});
  assert.equal(proposal.status,201);
  const plan=await proposal.json();
  const path='plans/'+plan.id+'/start';
  const patch={index:1,prompt:'只核对新材料',doneWhen:'需列出两个新差异',cwd:join(dataDir,'target'),
    executorId:'second/codex',expectMinutes:25};
  for(const [edits,status] of [
    [[{...patch,projectId:'foreign'}],400],[[{...patch,todoId:'new'}],400],[[{...patch,policy:{}}],400],
    [[{...patch,executionMode:'interactive'}],400],[[patch,patch],400],[[{...patch,cwd:'relative'}],400],
    [[{...patch,index:5}],400],[[{...patch,expectMinutes:0}],400],[[{...patch,executorId:'missing'}],503],
  ] as const) {
    assert.equal((await post(path,{version:plan.version,edits})).status,status);
    assert.deepEqual(server.app.plans.get(plan.id),plan);
    assert.equal(server.app.store.list('runs').length,0);
    assert.equal(starts.length,0);
  }
  const noDirectory=await post('plans',{title:'缺少工作目录',tasks:[first,{prompt:'第二项',doneWhen:'检查完成'}]});
  const secondPlan=await noDirectory.json();
  assert.equal((await post('plans/'+secondPlan.id+'/start',{version:1,edits:[{index:1,executorId:'second/codex'}]})).status,400);
  const plain=await fetch(server.url+'/api/v1/'+path,{method:'POST',headers:{authorization:'Bearer offline-plan','content-type':'text/plain'},
    body:JSON.stringify({version:plan.version,edits:[patch]})});
  assert.equal(plain.status,415);
  assert.equal(server.app.store.list('runs').length,0);
  assert.equal(starts.length,0);
  const submissions=await Promise.all([1,2].map(()=>post(path,{version:plan.version,edits:[patch]})));
  assert.deepEqual(submissions.map(r=>r.status).sort(),[200,409]);
  const saved=await submissions.find(r=>r.ok)!.json();
  assert.equal(saved.status,'started');
  assert.equal(saved.tasks[0].estimateSource,'default');
  assert.equal(saved.tasks[1].estimateSource,'override');
  assert.equal(saved.tasks[1].expectMinutes,25);
  assert.equal(saved.tasks[0].prompt,first.prompt);
  assert.equal(saved.tasks[1].doneWhen,patch.doneWhen);
  await t.waitFor(()=>assert.equal(starts.length,2));
  const runs=server.app.store.list<Run>('runs');
  assert.deepEqual(runs.map(r=>r.executorId),['first/codex','second/codex']);
  assert.equal(runs[1].doneWhen,patch.doneWhen);
  const actual=starts.find(call=>call.cwd===patch.cwd);
  assert.ok(actual);
  assert.match(JSON.stringify(actual),/只核对新材料/);
  assert.match(JSON.stringify(actual),/需列出两个新差异/);
  assert.doesNotMatch(JSON.stringify(actual),/第二项旧原文/);
});
