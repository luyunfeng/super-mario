import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import type { EffectRecord } from '../packages/core/src/effects.ts';
import type { TodoHistory } from '../packages/protocol/src/todo-history.ts';
import type { JsonObject, Run } from '../packages/protocol/src/index.ts';

async function fixture(t:TestContext) {
  const dataDir=await mkdtemp(join(tmpdir(),'supervised-run-deadline-'));
  const config={host:'127.0.0.1',port:0,dataDir,demo:true,token:'supervised-fixture'};
  let server=await startServer(config);
  const machineId='protocol-test';
  const sessionId='synthetic-session';
  const inputs:JsonObject[]=[];
  let acknowledged=true;
  const connect=()=>startAgentNode({url:server.url,token:config.token,dataDir:join(dataDir,'node'),machineId,name:'本地协议替身',
    executors:[{id:'codex',machineId,name:'假执行者',kind:'cli',available:true,mode:'real',description:'进程内测试处理器',defaultCwd:dataDir}],
    handlers:{'executor.start':async()=>({sessionId}),'executor.input':async args=>{
      inputs.push(args);
      return acknowledged ? {requested:true} : {} as JsonObject;
    }}});
  let machine=connect();
  t.after(async()=>{await machine.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  const online=()=>t.waitFor(()=>assert.ok(server.machines.list().some(row=>row.id===machineId && row.online)));
  async function post(path:string,body:object) {
    return fetch(server.url+'/api/v1'+path,{method:'POST',headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify(body)});
  }
  async function create<T>(path:string,body:object,status:number) {
    const res=await post(path,body);
    const value=await res.text();
    assert.equal(res.status,status,value);
    return JSON.parse(value) as T;
  }
  await online();
  const todo=server.app.createTodo({title:'核对列顺序'});
  const run=await create<Run>('/runs',{executorId:machineId+'/codex',todoId:todo.id,cwd:dataDir,executionMode:'interactive',prompt:'准备两种排列草稿'},202);
  await t.waitFor(()=>assert.equal(server.app.store.get<Run>('runs',run.id)?.sessionId,sessionId));
  const ask=(reversible:boolean)=>create<Card>('/interactions',{kind:'question',title:'选择草稿',body:'表格按哪一列排列？',runId:run.id,
    deadline:'2m',reversible,questions:[{question:'主排序',options:[{label:'按月'},{label:'按部门'}],recommend:'按月'},
      {question:'顺序',options:[{label:'降序'},{label:'升序'}],recommend:'升序'}]},201);
  return {inputs,ask,sessionId,post,run,
    app:()=>server.app,
    async history(card:Card) {
      const res=await fetch(server.url+'/api/v1/todos/'+todo.id+'/history',{headers:{authorization:'Bearer '+config.token}});
      assert.equal(res.status,200);
      const value=await res.json() as TodoHistory;
      return value.rounds.find(round=>round.run.id===run.id)?.answerReceipts.find(row=>row.cardId===card.id);
    },
    loseReceipt(){acknowledged=false;},
    read:(card:Card)=>server.app.store.get<Card>('interactions',card.id)!,
    tick:(card:Card)=>server.app.interactions.expireTick(Date.parse(card.decisionDeadlineAt!)+1),
    restart:async()=>{await machine.close();await server.close();server=await startServer(config);machine=connect();await online();}};
}

test('可逆问题到期后，原执行会话只收到一次标明系统选择的逐题答复',async t=>{
  const f=await fixture(t);
  const card=await f.ask(true);
  f.tick(card); f.tick(card);
  await t.waitFor(()=>assert.equal(f.read(card).delivery,'confirmed'));
  assert.equal(f.read(card).byDefault,true);
  assert.equal(f.read(card).answeredBy,'deadline_default');
  const receipt=await f.history(card);
  assert.equal(receipt?.answeredBy,'deadline_default');
  assert.equal(receipt.target,'executor');
  assert.equal(receipt.delivery,'confirmed');
  assert.deepEqual(f.read(card).answers,[{selected:['按月']},{selected:['升序']}]);
  assert.equal(f.inputs.length,1);
  assert.equal(f.inputs[0]!.sessionId,f.sessionId);
  const text=String(f.inputs[0]!.text);
  assert.match(text,/系统/); assert.match(text,/默认/); assert.match(text,/按月/); assert.match(text,/升序/);
  assert.equal((await f.post('/interactions/'+card.id+'/answer',{version:card.version,answers:[{selected:['按部门']},{selected:['降序']}]})).status,409);
  assert.equal(f.inputs.length,1);
});

test('不可逆问题到期保留原卡，主人随后可经原 HTTP 表单回答',async t=>{
  const f=await fixture(t);
  const card=await f.ask(false);
  f.tick(card); f.tick(card);
  const overdue=f.read(card);
  assert.equal(overdue.status,'open');
  assert.ok(overdue.deadlineRemindedAt);
  assert.equal(overdue.version,card.version);
  assert.equal(f.inputs.length,0);
  const past=new Date(Date.now()-1000).toISOString();
  f.app().store.put('interactions',card.id,{...overdue,expiresAt:past,decisionDeadlineAt:past});
  const res=await f.post('/interactions/'+card.id+'/answer',{version:card.version,answers:[{selected:['按部门']},{selected:['降序']}]});
  assert.equal(res.status,200,await res.text());
  assert.equal(f.read(card).answeredBy,'user');
  assert.equal(f.read(card).byDefault,undefined);
  assert.equal(f.read(card).delivery,'confirmed');
  assert.equal(f.inputs.length,1);
  assert.equal(f.inputs[0]!.sessionId,f.sessionId);
  assert.match(String(f.inputs[0]!.text),/按部门/);assert.match(String(f.inputs[0]!.text),/降序/);
});

test('执行机已收到但回执不明确，服务重启和再次扫截止均不重投',async t=>{
  const f=await fixture(t);
  f.loseReceipt();
  const card=await f.ask(true);
  f.tick(card);
  await t.waitFor(()=>{assert.equal(f.inputs.length,1);assert.ok(f.read(card).error);});
  assert.equal(f.read(card).delivery,'unknown');
  await f.restart();
  f.tick(card);
  assert.equal(f.read(card).delivery,'unknown');
  assert.equal((await f.history(card))?.delivery,'unknown');
  assert.equal(f.read(card).byDefault,true);
  assert.equal(f.inputs.length,1);
});

test('执行机已接收、宿主在回执落库前中断，重启和执行机重新连接后不会重发',async t=>{
  const f=await fixture(t);
  const card=await f.ask(true);
  f.tick(card);
  await t.waitFor(()=>assert.equal(f.read(card).delivery,'confirmed'));
  // Preserve the actual request fingerprint and simulate the durable rows at the crash boundary.
  const key='interaction:'+card.id;
  const {result:_,...effect}=f.app().store.get<EffectRecord>('effects',key)!;
  f.app().store.put('effects',key,{...effect,status:'sent'});
  f.app().store.put('interactions',card.id,{...f.read(card),delivery:'unknown'});
  await f.restart();
  f.tick(card);
  assert.equal(f.app().store.get<EffectRecord>('effects',key)?.status,'unknown');
  assert.equal(f.read(card).delivery,'unknown');
  assert.equal((await f.history(card))?.delivery,'unknown');
  assert.equal(f.inputs.length,1);
});

test('原执行的会话被替换，在截止前或裁决后实际投递前均不转发到新会话',async t=>{
  for(const race of [false,true]) await t.test(race?'裁决后':'裁决前',async t=>{
    const f=await fixture(t);
    const card=await f.ask(true);
    if(race) f.tick(card);
    const current=f.app().store.get<Run>('runs',f.run.id)!;
    f.app().store.put('runs',current.id,{...current,sessionId:'replacement-session'});
    if(!race) f.tick(card);
    await t.waitFor(()=>assert.ok(f.read(card).deadlineRemindedAt || f.read(card).error));
    assert.notEqual(f.read(card).delivery,'confirmed');
    assert.equal(f.inputs.length,0);
  });
});
