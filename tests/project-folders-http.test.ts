import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';
const poll = async (fn:()=>boolean) => { for(let i=0;i<100;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Node state did not settle'); };
test('real node discovers folders read-only; HTTP binds canonical remote paths, deduplicates and restores removed projects', {timeout:20000},async t=>{
 const dir = await mkdtemp(join(tmpdir(), 'mario-folders-http-'));
 const repo = join(dir, 'projects', 'example');
 const gitOnly = join(dir, 'projects', 'no-session');
 const codex = join(dir, '.codex', 'sessions', '2026', '11', '19');
 const claude = join(dir, '.claude', 'projects', '-fixture');
 for (const folder of [repo, join(gitOnly, '.git'), codex, claude]) await mkdir(folder, {recursive:true});
 const sessionId = '932fa250-715a-4227-a2e1-567c2dc4eaf8';
 const timestamp = '2026-11-19T10:00:00.000Z';
 await writeFile(join(codex, `rollout-2026-11-19T10-00-00-${sessionId}.jsonl`), [
   {type:'session_meta', timestamp, payload:{id:sessionId, timestamp, cwd:repo, source:'cli', originator:'codex_cli_rs'}},
   {type:'event_msg', timestamp, payload:{type:'user_message', message:'查看项目状态'}},
 ].map(row=>JSON.stringify(row)).join('\n')+'\n');
 await writeFile(join(claude, sessionId+'.jsonl'), JSON.stringify({
   type:'user', sessionId, cwd:repo, timestamp, isSidechain:false,
   userType:'external', message:{role:'user', content:'查看项目状态'},
 })+'\n');
 // Both paths exist. Only the directory with user session evidence should be offered.
 const automated = join(dir, 'projects', 'agent-child');
 await mkdir(automated);
 await writeFile(join(dir, '.claude.json'), JSON.stringify({projects:{[gitOnly]:{}}}));
 const childId = 'f3f66f84-bfcb-4faa-9a66-a826a5098576';
 await writeFile(join(codex, `rollout-2026-11-19T10-00-01-${childId}.jsonl`), JSON.stringify({
   type:'session_meta', timestamp, payload:{id:childId, cwd:automated, timestamp,
     source:{subagent:{thread_spawn:{parent_thread_id:sessionId, depth:1}}}},
 })+'\n');
 await writeFile(join(repo, 'keep.txt'), 'project files stay on the node');
 const alias=join(dir,'alias');await symlink(repo,alias);
 const server=await startServer({host:'127.0.0.1',port:0,dataDir:join(dir,'data'),demo:true,token:'offline-project-folders'});
 const discovery=createProjectDiscovery({home:dir,cwd:repo,temporaryRoots:[],ignoreEnvironmentRoots:true});
 const node=startAgentNode({url:server.url,token:'offline-project-folders',machineId:'workspace-computer',name:'项目电脑',dataDir:join(dir,'node'),handlers:discovery.handlers});
 const headers={'Authorization':'Bearer offline-project-folders','Content-Type':'application/json'};
 const call=async(path:string,method='GET',body?:unknown)=>{const response=await fetch(server.url+'/api/v1'+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
 try {
  await poll(()=>server.machines.list().some(machine=>machine.online));
  const legacy=await call('/projects','POST',{name:'原有项目'});assert.equal(legacy.status,201);
  const scanned=await call('/machines/workspace-computer/projects');assert.equal(scanned.status,200);
  await t.test('discovery returns the node home and only user-session candidates', () => {
    assert.equal(scanned.data.homeDir, dir);
    assert.deepEqual(scanned.data.projects.map((p:{cwd:string})=>p.cwd), [repo]);
    assert.deepEqual([...scanned.data.projects[0].sources].sort(), ['claude','codex']);
  });
  assert.equal(server.app.projects.list().length,1,'Scanning must not import projects');
  const discoverTool=server.app.contributions.list('tools').find(item=>item.value.name==='projects_discover')!.value;
  const observed=await discoverTool.execute({machineId:'workspace-computer'},new AbortController().signal);assert.ok(Array.isArray(observed));assert.equal((observed[0] as {available?:boolean}).available,true);assert.equal(server.app.projects.list().length,1);
  const createTool=server.app.contributions.list('tools').find(item=>item.value.name==='project_create')!.value;await assert.rejects(createTool.execute({name:'不存在目录工具调用',workspace:{machineId:'workspace-computer',cwd:join(dir,'tool-missing')}},new AbortController().signal),/未能确认/);
  const first=await call('/projects','POST',{name:'已绑定目录',workspace:{machineId:'workspace-computer',cwd:alias}});assert.equal(first.status,201);assert.equal(first.data.workspace.cwd,repo);
  const duplicate=await call('/projects','POST',{name:'不覆盖原名称',workspace:{machineId:'workspace-computer',cwd:repo}});assert.equal(duplicate.data.id,first.data.id);assert.equal(duplicate.data.name,'已绑定目录');
  const todo = await call('/todos','POST',{title:'保留历史',projectId:first.data.id});
  assert.equal(todo.status,201);
  assert.equal('purgeProject' in server.app, false);
  const purgePath = '/projects/'+first.data.id+'/purge';
  const confirmation = {confirmName:first.data.name};
  assert.equal((await call(purgePath,'POST',confirmation)).status,404);
  const removed = await call('/projects/'+first.data.id, 'DELETE');
  assert.equal(removed.status, 200);
  assert.ok(removed.data.archivedAt);
  assert.equal((await call(purgePath,'POST',confirmation)).status,404);
  assert.equal(await readFile(join(repo, 'keep.txt'), 'utf8'), 'project files stay on the node');
  const rediscovered = await call('/machines/workspace-computer/projects');
  assert.equal(rediscovered.status, 200);
  assert.ok(rediscovered.data.projects.some((p:{cwd:string})=>p.cwd===repo));
  const restored = await call('/projects/'+first.data.id+'/restore', 'POST', {});
  assert.equal(restored.status, 200);
  assert.equal(restored.data.id, first.data.id);
  assert.equal(restored.data.name, first.data.name);
  assert.deepEqual(restored.data.workspace, first.data.workspace);
  assert.equal(restored.data.archivedAt, undefined);
  const todos = await call('/todos');
  assert.equal(todos.status,200);
  assert.deepEqual(todos.data.find((item:{id:string})=>item.id===todo.data.id),todo.data);
  const missing=await call('/projects','POST',{name:'不存在目录',workspace:{machineId:'workspace-computer',cwd:join(dir,'missing')}});assert.equal(missing.status,400);assert.equal(server.app.projects.list().length,2);
  const boundLegacy=await call('/projects/'+legacy.data.id,'PATCH',{workspace:{machineId:'workspace-computer',cwd:join(dir,'projects')}});assert.equal(boundLegacy.status,200);assert.equal(boundLegacy.data.name,'原有项目');
  const noAuth=await fetch(server.url+'/api/v1/machines/workspace-computer/projects');assert.equal(noAuth.status,401);
  await node.close();await poll(()=>!server.machines.list().some(machine=>machine.online));
  assert.equal((await call('/machines/workspace-computer/projects')).status,503);
  const edit=await call('/projects/'+first.data.id,'PATCH',{description:'电脑离线仍可维护背景'});assert.equal(edit.status,200);assert.equal(edit.data.workspace.cwd,repo);
  assert.equal((await call('/projects','POST',{name:'不能冒充在线',workspace:{machineId:'workspace-computer',cwd:dir}})).status,503);
  assert.equal(server.app.projects.list().length,2);
 } finally{await node.close();await server.close();await rm(dir,{recursive:true,force:true});}
});
