import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import { readRunQuestionHold, releaseRunQuestionHold, runQuestionInputHeld } from '../packages/core/src/run-question-deadline.ts';
import type { Run, Json, JsonObject } from '../packages/protocol/src/index.ts';

test('主人报告偏题只撤回该卡，阻止同一执行的默认和自动按键；手答及其他执行可继续',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'run-question-mismatch-'));
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,token:'local-mismatch',demo:true});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const {app}=server;
  const machineId='node',now=new Date().toISOString();
  const inputs:JsonObject[]=[],keys:JsonObject[]=[];
  let revision='trust-1', sessionsReads=0;
  app.setMachineClient({
    list:()=>[{id:machineId,name:'进程内替身',online:true,platform:'linux',connectedAt:now,
      capabilities:['executor.input','executor.sessions','terminal.live.scan_prompts','terminal.live.answer_prompt'],
      executors:[{id:'codex',name:'合成执行器',description:'',kind:'cli',machineId,mode:'real',available:true}]}],
    async call(_,method,params):Promise<Json>{
      if(method==='executor.input'){inputs.push(params);return {requested:true};}
      if(method==='executor.sessions'){sessionsReads++;return [{sessionId:'s1',paneId:'p1'},{sessionId:'s2',paneId:'p2'}];}
      if(method==='terminal.live.scan_prompts') return {prompts:['p1','p2'].map(paneId=>({
        paneId,terminalId:paneId,cwd:dataDir,title:'合成终端',agent:'fixture',prompt:{kind:'trust_dir',rev:revision,title:'确认目录',excerpt:'',options:[{keys:'enter',label:'确认'}]}}))};
      assert.equal(method,'terminal.live.answer_prompt');keys.push(params);return {applied:true};
    },
  });
  const project=app.projects.create({name:'合成项目',workspace:{machineId,cwd:dataDir}});
  const run:Run={id:'r1',executorId:'node/codex',machineId,sessionId:'s1',projectId:project.id,conversationId:'main',prompt:'核对',cwd:dataDir,
    executionMode:'interactive',status:'running',output:'',createdAt:now,updatedAt:now};
  app.store.put('runs',run.id,run);app.store.put('runs','r2',{...run,id:'r2',sessionId:'s2'});
  const ask=(runId=run.id)=>app.interactions.openFromWeb({kind:'question',title:'需要选择',body:'',runId,deadline:'5m',reversible:true,
    questions:[{question:'排序？',options:[{label:'甲'},{label:'乙'}],recommend:'甲'}]});
  const report=async(card:Card,version=card.version)=>fetch(server.url+'/api/v1/interactions/'+card.id+'/mismatch',{method:'POST',
    headers:{authorization:'Bearer local-mismatch','content-type':'application/json'},body:JSON.stringify({version})});
  const mismatch=ask(),sibling=ask(),newer=ask(),foreign=ask('r2');
  assert.equal((await report(mismatch,5)).status,409);
  assert.equal(readRunQuestionHold(app.store,run),undefined);
  const response=await report(mismatch);assert.equal(response.status,200);
  const closed=await response.json() as Card;
  assert.equal(closed.status,'withdrawn');assert.equal(closed.withdrawnReason,'owner_mismatch');assert.equal(closed.answer,undefined);
  assert.equal(closed.version,mismatch.version+1);assert.deepEqual(await (await report(mismatch)).json(),closed);
  assert.equal(readRunQuestionHold(app.store,run)?.cardId,mismatch.id);
  assert.equal(app.runObservations(run.id).followupsHeld,true);
  assert.equal(inputs.length,0);
  const workInput=app.contributions.list('tools').find(row=>row.value.name==='work_input')!.value;
  await assert.rejects(async()=>workInput.execute({id:run.id,text:'自行跟进'},new AbortController().signal),/偏题/);
  const newest=await (await report(newer)).json() as Card;
  assert.equal(releaseRunQuestionHold(app.store,run,closed.id,closed.version),false);
  await report(mismatch);
  assert.equal(readRunQuestionHold(app.store,run)?.cardId,newest.id);
  app.interactions.expireTick(Date.parse(foreign.expiresAt)+1);
  await t.waitFor(()=>assert.equal(app.store.get<Card>('interactions',foreign.id)?.delivery,'confirmed'));
  assert.equal(app.store.get<Card>('interactions',sibling.id)?.status,'open');assert.deepEqual(inputs.map(i=>i.sessionId),['s2']);
  await app.autoTakeover.scanOnce();
  assert.ok(sessionsReads>0);assert.deepEqual(keys.map(key=>key.paneId),['p2']);
  const handled=await app.interactions.answer(sibling.id,sibling.version,[{selected:['乙']}]);
  assert.equal(handled.delivery,'confirmed');assert.deepEqual(inputs.map(i=>i.sessionId),['s2','s1']);
  // Restart makes a live run uncertain. That must not authorize automatic writes or releases.
  app.store.put('runs',run.id,{...run,status:'unknown'});
  assert.equal(runQuestionInputHeld(app.store,{...run,status:'unknown'}),true);
  assert.equal(app.runObservations(run.id).followupsHeld,true);
  assert.equal(releaseRunQuestionHold(app.store,run,newest.id,newest.version),false);
  app.store.put('runs',run.id,run);
  assert.equal(releaseRunQuestionHold(app.store,run,newest.id,newest.version),true);
  assert.equal(readRunQuestionHold(app.store,run),undefined);
  const before=sessionsReads;revision='trust-2';await app.autoTakeover.scanOnce();
  assert.equal(sessionsReads,before);assert.deepEqual(keys.slice(-2).map(key=>key.paneId),['p1','p2']);
});
