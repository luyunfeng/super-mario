import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Todo, Run } from '../packages/protocol/src/index.ts';

test('工作者只读当前负责待办的有效决定，替换负责会话后立刻移交读取权', async t => {
  const dir = await mkdtemp(join(tmpdir(),'sm-worker-decisions-'));
  const token = 'fixture-web-token', machineId = 'fake-machine', instanceId = 'fake-instance';
  const host = await startServer({dataDir:dir,host:'127.0.0.1',port:0,token,demo:true});
  const sessions: {key:string;id:string}[] = [];
  const node = startAgentNode({url:host.url,dataDir:join(dir,'node'),token,machineId,agentInstanceId:instanceId,name:'本地执行机替身',
    executors:[{id:'codex',name:'协议替身',kind:'cli',mode:'real',available:true,description:'只返回合成启动回执',machineId,defaultCwd:dir}],
    handlers:{'executor.start':async()=>{
      const key=randomBytes(32).toString('base64url'), id='offline-worker-'+sessions.length;
      sessions.push({key,id});
      return {sessionId:id,agentInstanceId:instanceId,workerToolKeyHash:createHash('sha256').update(key).digest('hex')};
    }}});
  t.after(async()=>{try {await node.close();await host.close();} finally {await rm(dir,{recursive:true,force:true});}});
  const request=(path:string,key:string,method='GET',body?:object)=>fetch(host.url+'/api/v1/'+path,{method,
    headers:{authorization:'Bearer '+key,'content-type':'application/json'},...(body && {body:JSON.stringify(body)})});
  async function web<T>(path:string,method='GET',body?:object) {
    const res=await request(path,token,method,body); assert.ok(res.ok,path+' '+res.status); return res.json() as Promise<T>;
  }
  const todo=await web<Todo>('todos','POST',{title:'合成待办甲'});
  const other=await web<Todo>('todos','POST',{title:'合成待办乙'});
  const add=(id:string,text:string)=>web<{id:string}>('todos/'+id+'/decisions','POST',{text,expectedProjectId:null});
  await add(other.id,'乙的限定决定');
  const api='worker-tools/todo-decisions';
  const call=(session:{id:string;key:string},args:object={})=>request(api,session.key,'POST',{sessionId:session.id,arguments:args});
  async function check(session:{id:string;key:string},expected:string[]) {
    const res=await call(session); assert.equal(res.status,200);
    const result=await res.json() as {message:string;decisions:{text:string;by:string}[]};
    assert.ok(result.message.trim());
    assert.deepEqual(result.decisions.map(item=>item.text).sort(),[...expected].sort());
    for(const item of result.decisions) assert.equal(item.by,'user');
    assert.ok(!JSON.stringify(result).includes('乙的限定决定'));
    return result;
  }
  async function launch(target:Todo=todo) {
    const i=sessions.length;
    const run=await web<Run>('runs','POST',{todoId:target.id,projectId:target.projectId,executorId:machineId+'/codex',executionMode:'interactive',cwd:dir,prompt:'核对当前有效的合成决定'});
    await t.waitFor(async()=>{const state=await web<{runs:Run[]}>('state');const row=state.runs.find(r=>r.id===run.id);
      assert.ok(sessions[i] && row?.sessionId===sessions[i].id && row.status==='running');});
    return {run,session:sessions[i]!};
  }
  const assign=(run:Run)=>web('todos/'+todo.id,'PATCH',{responsibleRunId:run.id});
  await t.waitFor(()=>assert.ok(host.machines.list().some(row=>row.id===machineId && row.online)));
  const a=await launch();
  assert.equal((await call(a.session)).status,403);
  await assign(a.run);
  await check(a.session,[]);
  await add(todo.id,'采用合成样表');
  const replaced=await add(todo.id,'准备撤回的合成决定');
  await check(a.session,['采用合成样表','准备撤回的合成决定']);
  await web('todos/'+todo.id+'/decisions/'+replaced.id+'/withdraw','POST',{expectedProjectId:null});
  const now=await check(a.session,['采用合成样表']);
  assert.ok(!JSON.stringify(now).includes('准备撤回的合成决定'));
  for(const args of [{todoId:other.id},{includeWithdrawn:true},{text:'伪造写入'}]) {
    const denied=await call(a.session,args);assert.equal(denied.status,400);
    assert.ok(!(await denied.text()).includes('乙的限定决定'));
  }
  assert.equal((await call({...a.session,key:token})).status,401);
  const b=await launch();await assign(b.run);
  assert.equal((await call(a.session)).status,403);
  assert.equal((await call({...a.session,id:b.session.id})).status,401);
  await check(b.session,['采用合成样表']);
  const ledger=await web<{decisions:{text:string;active:boolean}[]}>('todos/'+todo.id+'/decisions');
  assert.deepEqual(ledger.decisions.map(d=>[d.text,d.active]).sort(),[['准备撤回的合成决定',false],['采用合成样表',true]].sort());
  await web('todos/'+todo.id,'PATCH',{completed:true});
  assert.equal((await call(b.session)).status,403);
  const project=await web<{id:string}>('projects','POST',{name:'独立项目'});
  const scoped=await web<Todo>('todos','POST',{projectId:project.id,title:'项目内负责待办'});
  await web('todos/'+scoped.id+'/decisions','POST',{text:'项目合成决定',expectedProjectId:project.id});
  const c=await launch(scoped);
  await web('todos/'+scoped.id,'PATCH',{responsibleRunId:c.run.id});
  await check(c.session,['项目合成决定']);
});
