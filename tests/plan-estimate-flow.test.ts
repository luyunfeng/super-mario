import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { MachineClient } from '../packages/plugin-sdk/src/index.ts';
import type { Json, Run, SupervisionSignal } from '../packages/protocol/src/index.ts';

test('计划启动到预计复核使用宿主派发来源，改时长重设到点，重启及结束不会重复提醒', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mario-plan-clock-'));
  const options = {dataDir:dir,host:'127.0.0.1',port:0,token:'offline-clock',demo:true};
  let server = await startServer(options);
  t.after(async () => { try { await server.close(); } finally { await rm(dir,{recursive:true,force:true}); } });
  const sessions = new Map<string,'running'|'completed'>();
  const machine: MachineClient = {
    list:() => [{id:'fixture',name:'离线替身',online:true,platform:'linux',connectedAt:new Date().toISOString(),
      capabilities:['executor.start','executor.result'], executors:[{id:'codex',name:'协议替身',kind:'cli',machineId:'fixture',
        available:true,mode:'real',description:'仅内存回执',nativeResultSources:['fixture-native']}]}],
    async call(id,method,args): Promise<Json> {
      assert.equal(id,'fixture');
      if (method === 'executor.start') {
        const sessionId = 'session-' + (sessions.size+1);
        sessions.set(sessionId,'running'); return {sessionId};
      }
      assert.equal(method,'executor.result');
      const state = sessions.get(String(args.sessionId));
      assert.ok(state);
      return {state,source:'fixture-native',text:state === 'completed' ? '测试输出已生成' : ''};
    },
  };
  server.app.setMachineClient(machine);
  const base = Date.now();
  t.mock.timers.enable({apis:['Date'],now:base});
  const atMinute = (minutes:number) => t.mock.timers.setTime(base+minutes*60_000);
  const run = (id:string) => server.app.store.get<Run>('runs',id)!;
  async function post(path:string,body:object,expected:number) {
    const response = await fetch(server.url+'/api/v1'+path,{method:'POST',
      headers:{Authorization:'Bearer '+options.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data = await response.json();
    assert.equal(response.status,expected,JSON.stringify(data)); return data;
  }
  async function waitSession(id:string) {
    for (let i=0;i<100 && !run(id).sessionId;i++) await delay(10);
    assert.ok(run(id).sessionId); assert.equal(run(id).status,'running');
  }
  const all = (id:string,kind:SupervisionSignal['kind']) => server.app.supervision.signals().filter(s => s.runId === id && s.kind === kind);
  const active = (id:string,kind:SupervisionSignal['kind']) => all(id,kind).filter(s => !s.resolvedAt);
  const tick = () => server.app.supervision.tick();
  server.app.supervision.configure({tickSeconds:3600,stalledMinutes:5,stalledFactorOfEstimate:2});
  const todo = server.app.createTodo({title:'合成验收事项'});
  const task = {todoId:todo.id,executorId:'fixture/codex',prompt:'核对表格',doneWhen:'首版列名匹配',expectMinutes:2,cwd:dir};
  const plan = await post('/plans',{title:'离线核对计划',tasks:[task]},201);
  const started = await post('/plans/'+plan.id+'/start',{version:plan.version},200);
  assert.equal(started.status,'started');
  const id = started.tasks[0].runId as string;
  await waitSession(id);
  const source = {planId:plan.id,taskIndex:0,source:'override'};
  assert.deepEqual(run(id).planEstimate,source);
  const direct = await post('/runs',{...task,planEstimate:source},202);
  await waitSession(direct.id);
  assert.equal(run(direct.id).planEstimate,undefined);
  assert.equal(sessions.size,2);
  atMinute(1); tick();
  assert.equal(all(id,'estimate_due').length,0);
  atMinute(2); tick(); tick();
  const [due] = active(id,'estimate_due');
  assert.ok(due); assert.equal(all(id,'estimate_due').length,1);
  assert.equal(all(direct.id,'estimate_due').length,0);
  assert.equal(all(id,'stalled').length,0);
  await post('/supervisor/flush',{},200);
  assert.ok(server.app.supervisorAgent.reviews().some(review => review.signalIds.includes(due.id)));
  assert.equal(run(id).status,'running');
  assert.equal(server.app.store.get<{completedAt?:string}>('todos',todo.id)?.completedAt,undefined);
  tick();
  assert.equal(active(id,'estimate_due').length,0);
  atMinute(5); tick();
  assert.equal(active(id,'stalled').length,1);
  const revise = (v:number,before:string,after:string,minutes?:number) => post('/runs/'+id+'/scope',{
    expectedProjectId:null,expectedVersion:v,expectedDoneWhen:before,doneWhen:after,reason:'合成范围修订',
    ...(minutes !== undefined && {expectMinutes:minutes})},200);
  await revise(0,task.doneWhen,'补充空值核对');
  tick();
  assert.equal(all(id,'estimate_due').length,1);
  assert.equal(active(id,'stalled').length,0);
  await revise(1,'补充空值核对','补充空值核对',4);
  atMinute(8); tick();
  assert.equal(all(id,'estimate_due').length,1);
  atMinute(9); tick(); tick();
  const [next] = active(id,'estimate_due');
  assert.ok(next); assert.notEqual(next.id,due.id);
  assert.equal(all(id,'estimate_due').length,2);
  assert.equal(active(id,'stalled').length,0);
  await revise(2,'补充空值核对','重新核对空值');
  tick();
  assert.deepEqual(active(id,'estimate_due').map(s => s.id),[next.id]);
  await server.close();
  server = await startServer(options);
  server.app.setMachineClient(machine);
  assert.equal(run(id).status,'unknown');
  tick();
  assert.equal(active(id,'estimate_due').length,0);
  sessions.set(run(id).sessionId!,'completed');
  await server.app.monitor.poll();
  assert.equal(run(id).status,'completed');
  atMinute(100); tick(); tick();
  assert.equal(all(id,'estimate_due').length,2);
  assert.equal(active(id,'estimate_due').length,0);
  assert.equal(active(id,'stalled').length,0);
  assert.equal(active(id,'review').length,1);
  assert.equal(all(direct.id,'estimate_due').length,0);
  assert.equal(sessions.size,2);
});
