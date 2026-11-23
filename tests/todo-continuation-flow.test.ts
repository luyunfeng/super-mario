import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import type { Todo } from '../packages/protocol/src/index.ts';

test('Web 建立续办，执行者只接收真实前序决定，重试和项目迁移保持归属', async t => {
  const dataDir = await mkdtemp(join(tmpdir(),'sm-continuation-'));
  const cfg = {host:'127.0.0.1',port:0,dataDir,demo:true,token:'fixture'};
  let server = await startServer(cfg);
  t.after(async()=>{try {await server.close();} finally {await rm(dataDir,{recursive:true,force:true});}});
  async function request(path:string, method='GET', input?:object, status=200) {
    const res = await fetch(server.url+'/api/v1/'+path,{method,headers:{authorization:'Bearer fixture','content-type':'application/json'},
      ...(input && {body:JSON.stringify(input)})});
    assert.equal(res.status,status,path+' '+res.status);
    return res.json();
  }
  const project = await request('projects','POST',{name:'资料整理'},201);
  const other = await request('projects','POST',{name:'其他工作'},201);
  const first:Todo = await request('todos','POST',{title:'盘点',projectId:project.id},201);
  const path = (todo:Todo) => 'todos/'+todo.id;
  const phase = (todo:Todo,title:string,requestId:string,status=201) => request(path(todo)+'/continue','POST',
    {expectedProjectId:project.id,title,continuationReason:'确认上一步产物后续办',requestId},status) as Promise<Todo>;
  const note = (todo:Todo,text:string) => request(path(todo)+'/decisions','POST',{expectedProjectId:project.id,text},201);
  await note(first,'原阶段核对甲列');
  await request(path(first),'PATCH',{completed:true});
  const [second, retry] = await Promise.all([phase(first,'复核','second'),phase(first,'复核','second')]);
  assert.equal(second.id,retry.id);
  await phase(first,'替换重试内容','second',409);
  const sibling = await phase(first,'平行核对','branch');
  await note(sibling,'旁支决定不可见');
  const fact = await note(second,'中间阶段保留表头');
  const third = await phase(second,'形成报告','third');
  const fourth = await phase(third,'发布记录','fourth');
  assert.deepEqual([third.continuesTodoId,third.continuationRootId],[second.id,first.id]);
  await server.close(); server = await startServer(cfg);
  assert.equal((await phase(second,'形成报告','third')).id,third.id);
  await request(path(first)+'/continue','POST',{title:'跨项目',continuationReason:'测试',requestId:'bad',expectedProjectId:other.id},409);
  await request(path(third),'PATCH',{continuesTodoId:sibling.id},400);
  const local = await request(path(third)+'/decisions');
  assert.deepEqual(local.decisions,[]);
  const prompts:string[]=[];
  server.app.plugins.register({id:'capture-continuation',name:'测试执行器',capabilities:['executors'],activate(ctx){
    ctx.contribute('executors','continuation-fixture',{id:'continuation-fixture',name:'协议替身',kind:'custom',machineId:'fixture',mode:'real',available:true,
      description:'记录本地输入',async execute({prompt}){prompts.push(prompt);return {text:'已验收'};}});
  }});
  await server.app.plugins.setEnabled('capture-continuation',true);
  async function dispatch(todo:Todo) {
    const count=prompts.length;
    await request('runs','POST',{todoId:todo.id,projectId:project.id,executorId:'continuation-fixture',prompt:'处理本阶段',doneWhen:'有明细',expectMinutes:1},202);
    await t.waitFor(()=>assert.equal(prompts.length,count+1));
    return prompts[count]!;
  }
  const handoff=await dispatch(third);
  assert.match(handoff,/原阶段核对甲列/); assert.match(handoff,/中间阶段保留表头/); assert.doesNotMatch(handoff,/旁支决定不可见/);
  await request(path(second)+'/decisions/'+fact.id+'/withdraw','POST',{expectedProjectId:project.id});
  assert.doesNotMatch(await dispatch(third),/中间阶段保留表头/);
  await request(path(second),'PATCH',{projectId:other.id});
  await request(path(second),'PATCH',{projectId:project.id});
  const rows:Todo[]=await request('todos');
  assert.equal(rows.find(row=>row.id===third.id)?.continuesTodoId,undefined);
  assert.equal(rows.find(row=>row.id===fourth.id)?.continuationRootId,third.id);
  assert.equal(rows.find(row=>row.id===sibling.id)?.continuationRootId,first.id);
  assert.doesNotMatch(await dispatch(fourth),/原阶段核对甲列|中间阶段保留表头/);
  await phase(second,'形成报告','third',409);
});
