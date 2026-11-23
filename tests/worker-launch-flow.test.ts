import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { TerminalHost } from '../packages/plugin-sdk/src/index.ts';
import type { Run, Todo } from '../packages/protocol/src/index.ts';
import { createExecutionServices } from '../plugins/executors.ts';

test('Web 派工签发的真实启动凭证经 stdio MCP 和 HTTP 读取 SQLite 中的有效决定', async t => {
  const dir=await mkdtemp(join(tmpdir(),'sm-worker-launch-'));
  const token='synthetic-web-token',machineId='fixture-machine',agentInstanceId='fixture-instance';
  const server=await startServer({dataDir:join(dir,'server'),port:0,host:'127.0.0.1',token,demo:true});
  const panes: Parameters<TerminalHost['create']>[0][]=[];
  const host:TerminalHost={
    async status(){return {available:true};},async list(){return [];},
    async create(spec){panes.push(spec);return {id:'fixture-pane',cwd:spec.cwd,title:spec.name};},
    async read(){return {text:'',ansi:''};},async input(){assert.fail('验收不需要向终端发送输入');},
    async keys(){assert.fail('验收不需要发送按键');},async close(){},async watch(){return ()=>{};},
  };
  const agentDir=join(dir,'agent');
  const services=createExecutionServices({host,machineId,agentInstanceId,dataDir:agentDir,hasCommand:cmd=>cmd==='codex',
    workerToolUrl:server.url+'/api/v1/worker-tools/todo-bind-thread'});
  const agent=startAgentNode({url:server.url,token,machineId,agentInstanceId,name:'内存执行机',dataDir:agentDir,
    executors:await services.describe(machineId),handlers:services.handlers});
  t.after(async()=>{try {await agent.close();await services.close();await server.close();} finally {await rm(dir,{recursive:true,force:true});}});
  async function web<T>(path:string,method='GET',body?:object) {
    const res=await fetch(server.url+'/api/v1/'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      ...(body && {body:JSON.stringify(body)})});
    assert.ok(res.ok,path+' '+res.status);return res.json() as Promise<T>;
  }
  await t.waitFor(()=>assert.ok(server.machines.list().some(row=>row.id===machineId && row.online)));
  const todo=await web<Todo>('todos','POST',{title:'合成执行任务'});
  const run=await web<Run>('runs','POST',{executorId:machineId+'/codex',executionMode:'interactive',todoId:todo.id,prompt:'检查已确认的决定',cwd:dir});
  const sessionId=await t.waitFor(async()=>{
    const row=(await web<{runs:Run[]}>('state')).runs.find(row=>row.id===run.id);
    assert.ok(row?.status==='running' && row.sessionId);return row.sessionId;
  });
  await web('todos/'+todo.id,'PATCH',{responsibleRunId:run.id});
  const text='启动后追加的合成决定\n逐字保留第二行';
  const decision=await web<{id:string}>('todos/'+todo.id+'/decisions','POST',{text,expectedProjectId:null});
  assert.equal(panes.length,1);
  const pane=panes[0]!;
  assert.equal(pane.argv[0],'codex');assert.equal(pane.env?.SUPER_MARIO_WORKER_SESSION,sessionId);
  const key=pane.env?.SUPER_MARIO_WORKER_KEY;
  assert.ok(key && key!==token && /^[A-Za-z0-9_-]{43}$/.test(key));
  assert.ok(!(await readFile(join(agentDir,'executor-sessions.json'),'utf8')).includes(key));
  // Launch only the exact local MCP bridge described by the captured CLI configuration.
  const value=(name:string)=>{
    const prefix='mcp_servers.super_mario.'+name+'=';
    const arg=pane.argv.find(entry=>entry.startsWith(prefix));assert.ok(arg);
    return JSON.parse(arg.slice(prefix.length));
  };
  const command=value('command'), args=value('args'), envNames=value('env_vars') as string[];
  assert.equal(command,process.execPath);
  assert.deepEqual(args,[fileURLToPath(new URL('../plugins/worker-topic-mcp.ts',import.meta.url))]);
  assert.deepEqual([...envNames].sort(),['SUPER_MARIO_WORKER_KEY','SUPER_MARIO_WORKER_SESSION','SUPER_MARIO_WORKER_URL']);
  const child=spawn(command,args,{cwd:dir,env:Object.fromEntries(envNames.map(name=>[name,pane.env![name]])),stdio:['pipe','pipe','pipe'],timeout:8000});
  const closed=once(child,'close');
  let out='',err='';
  child.stdout.setEncoding('utf8').on('data',chunk=>{out+=chunk;});
  child.stderr.setEncoding('utf8').on('data',chunk=>{err+=chunk;});
  const frames=[
    {id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},
    {method:'notifications/initialized'},{id:2,method:'tools/list'},
    {id:3,method:'tools/call',params:{name:'todo_decisions',arguments:{}}},
  ];
  child.stdin.end(frames.map(frame=>JSON.stringify({jsonrpc:'2.0',...frame})).join('\n')+'\n');
  const [code]=await closed;assert.equal(code,0);assert.ok(!out.includes(key) && !err.includes(key));assert.equal(err,'');
  const results=out.trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(results.find(row=>row.id===2)?.result.tools.some((tool:{name:string})=>tool.name==='todo_decisions'));
  const result=results.find(row=>row.id===3)?.result;
  assert.ok(result && !result.isError);
  const actual=JSON.parse(result.content[0].text);
  assert.deepEqual(actual.decisions.map((row:{id:string;text:string;by:string})=>[row.id,row.text,row.by]),[[decision.id,text,'user']]);
});
