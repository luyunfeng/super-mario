import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Json, Run } from '../packages/protocol/src/index.ts';

test('主人逐题回答后按执行机实际回执记录送达、未发送或未知，复读待办历史不重送', async t => {
  const dataDir = await mkdtemp(join(tmpdir(),'run-question-receipt-'));
  const machineId = 'fixture', token = 'fixture-local';
  const server = await startServer({dataDir,host:'127.0.0.1',port:0,demo:true,token});
  const inputs: string[] = [];
  let receipt: Json = {};
  const machine = startAgentNode({url:server.url,token,dataDir:join(dataDir,'node'),name:'协议替身',machineId,
    executors:[{id:'codex',name:'测试执行者',kind:'cli',machineId,mode:'real',available:true,description:'',defaultCwd:dataDir}],
    handlers:{'executor.start':async()=>({sessionId:'local'}),'executor.input':async args=>{
      inputs.push(String(args.text)); return receipt;
    }}});
  t.after(async()=>{await machine.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  await t.waitFor(()=>assert.ok(server.machines.list().some(m=>m.id===machineId && m.online)));
  const todo = server.app.createTodo({title:'核对展示顺序'});
  const run = await server.app.dispatch({executorId:machineId+'/codex',executionMode:'interactive',cwd:dataDir,prompt:'核对列顺序',todoId:todo.id});
  await t.waitFor(()=>assert.equal(server.app.store.get<Run>('runs',run.id)?.sessionId,'local'));
  server.app.policies.write({},{ladder:['user']});
  for (const [ack,expected] of [[{requested:true},'confirmed'],[{requested:false},'failed'],[{},'unknown'],
      [{requested:true,accepted:false},'unknown']] as const) {
    receipt=ack;
    const card=server.app.interactions.open({kind:'question',title:'如何排序？',body:'请核对列顺序',runId:run.id,
      questions:[{question:'列顺序',options:[{label:'日期'},{label:'名称'}],recommend:'日期'}]});
    const path=server.url+'/api/v1/interactions/'+card.id+'/answer';
    const answer=()=>fetch(path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({version:card.version,answers:[{selected:['名称']}]})});
    assert.equal((await answer()).status,200);
    const history=server.app.taskClosure.history(todo.id);
    assert.equal(history.rounds[0].answerReceipts.find(row=>row.cardId===card.id)?.delivery,expected);
    assert.equal((await answer()).status,409);
  }
  assert.equal(inputs.length,4);
  assert.ok(inputs.every(text=>text.includes('选择：名称') && !text.includes('选择：日期')));
});
