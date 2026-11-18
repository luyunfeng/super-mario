import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';
const poll = async (fn:()=>boolean) => { for(let i=0;i<100;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Node state did not settle'); };
test('real node discovers folders read-only; HTTP binds canonical remote paths, deduplicates and retains old projects', {timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mario-folders-http-'));const repo=join(dir,'projects','example');await mkdir(join(repo,'.git'),{recursive:true});const alias=join(dir,'alias');await symlink(repo,alias);
 const server=await startServer({host:'127.0.0.1',port:0,dataDir:join(dir,'data'),demo:true,token:'offline-project-folders'});
 const discovery=createProjectDiscovery({home:dir,cwd:repo,temporaryRoots:[],roots:[join(dir,'projects')]});
 const node=startAgentNode({url:server.url,token:'offline-project-folders',machineId:'workspace-computer',name:'项目电脑',dataDir:join(dir,'node'),handlers:discovery.handlers});
 const headers={'Authorization':'Bearer offline-project-folders','Content-Type':'application/json'};
 const call=async(path:string,method='GET',body?:unknown)=>{const response=await fetch(server.url+'/api/v1'+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
 try {
  await poll(()=>server.machines.list().some(machine=>machine.online));
  const legacy=await call('/projects','POST',{name:'原有项目'});assert.equal(legacy.status,201);
  const scanned=await call('/machines/workspace-computer/projects');assert.equal(scanned.status,200);assert.ok(scanned.data.projects.some((p:{cwd:string})=>p.cwd===repo));assert.equal(server.app.projects.list().length,1,'Scanning must not import projects');
  const discoverTool=server.app.contributions.list('tools').find(item=>item.value.name==='projects_discover')!.value;
  const observed=await discoverTool.execute({machineId:'workspace-computer'},new AbortController().signal);assert.ok(Array.isArray(observed));assert.equal((observed[0] as {available?:boolean}).available,true);assert.equal(server.app.projects.list().length,1);
  const createTool=server.app.contributions.list('tools').find(item=>item.value.name==='project_create')!.value;await assert.rejects(createTool.execute({name:'不存在目录工具调用',workspace:{machineId:'workspace-computer',cwd:join(dir,'tool-missing')}},new AbortController().signal),/未能确认/);
  const first=await call('/projects','POST',{name:'已绑定目录',workspace:{machineId:'workspace-computer',cwd:alias}});assert.equal(first.status,201);assert.equal(first.data.workspace.cwd,repo);
  const duplicate=await call('/projects','POST',{name:'不覆盖原名称',workspace:{machineId:'workspace-computer',cwd:repo}});assert.equal(duplicate.data.id,first.data.id);assert.equal(duplicate.data.name,'已绑定目录');
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
