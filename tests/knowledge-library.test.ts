import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../apps/server/src/index.ts';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import type { MachineClient } from '../packages/plugin-sdk/src/index.ts';
import type { Json } from '../packages/protocol/src/index.ts';

test('projects and knowledge edits are real HTTP resources with a private local Git map', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-library-http-'));
  const server = await startServer({ host:'127.0.0.1',port:0,dataDir,demo:true,token:'library-test' });
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const api=async(path:string,method='GET',body?:unknown)=>{const response=await fetch(server.url+'/api/v1'+path,{method,headers:{Authorization:'Bearer library-test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(response.ok,await response.clone().text());return response.json();};
  const project=await api('/projects','POST',{name:'知识项目',description:'项目上下文'});
  const knowledge=await api('/knowledge','POST',{layer:'project',projectId:project.id,title:'第一版',content:'原始知识'});
  const edited=await api('/knowledge/'+knowledge.id,'PATCH',{title:'第二版',content:'修改后的知识'});assert.equal(edited.title,'第二版');assert.equal(edited.projectId,project.id);
  await api('/projects/'+project.id,'DELETE');
  assert.equal((await api('/knowledge')).length,1);
  const index=await api('/knowledge/index');assert.match(index.content,/第二版/);assert.equal(index.versioning.available,true);
  const root=join(dataDir,'plugins','knowledge-local');assert.ok(execFileSync('git',['-C',root,'rev-list','--count','HEAD'],{encoding:'utf8'}).trim()!=='0');
  assert.equal(execFileSync('git',['-C',root,'remote'],{encoding:'utf8'}).trim(),'');
});

test('curation defaults to personal, recovers uncertain delivery without resubmit, preserves source and records Git', {timeout:20000}, async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-curator-'));
  const app=await createWorkbench({host:'127.0.0.1',port:0,dataDir,demo:true});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const remoteJobs=new Map<string,Json>();let submissions=0;let uncertain=true;
  const client:MachineClient={list:()=>[{id:'machine',name:'Knowledge node',online:true,platform:'linux',connectedAt:new Date().toISOString(),capabilities:['executor.knowledge.start']}],async call(_machine,method,params){
    if(method==='executor.knowledge.start')return {workerId:'resident',provider:'codex',scope:params.scope,state:'idle',pid:123};
    if(method==='executor.knowledge.stop')return {stopped:true};
    if(method==='executor.knowledge.submit'){submissions++;remoteJobs.set(String(params.jobId),{id:params.jobId,scope:params.scope,status:'completed',text:JSON.stringify({pages:[{title:'知识炼化',content:'按知识点组织，保留来源并维护索引。'}],summary:'已整理'})});if(uncertain){uncertain=false;throw new Error('connection closed after accepting job');}return {accepted:true};}
    return {workerId:'resident',provider:'codex',scope:params.scope,state:'idle',pid:123,...(params.jobId?{job:remoteJobs.get(String(params.jobId))}: {})} as any;
  }};
  app.setMachineClient(client);
  await app.knowledgeCurator.configure({enabled:true,machineId:'machine',provider:'codex'});
  const job=app.knowledgeCurator.addSource({title:'知识整理原始材料',text:'按知识点整理资料。保留原始来源，自动维护知识地图。'});
  assert.equal(job.layer,'personal');
  const deadline=Date.now()+12000;while(Date.now()<deadline&&app.knowledgeCurator.status().jobs[0]?.status!=='completed')await delay(30);
  const saved=app.knowledgeCurator.status().jobs[0];assert.equal(saved.status,'completed');assert.equal(submissions,1);
  const pages=await app.knowledge().list();assert.equal(pages.length,1);assert.equal(pages[0].layer,'personal');assert.match(pages[0].content,/本次整理来源/);
  const raw=await readFile(join(dataDir,'plugins','knowledge-local','raw',job.id+'.md'),'utf8');assert.match(raw,/知识整理原始材料/);assert.match(raw,/按知识点整理资料/);
  assert.equal(app.knowledgeCurator.status().versioning.available,true);
  assert.match((await app.knowledgeCurator.index()).content,/知识炼化/);
});

test('an old knowledge turn cannot overwrite a human edit and invalid imports are not polled forever', {timeout:15000}, async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-curator-conflict-'));
  const app=await createWorkbench({host:'127.0.0.1',port:0,dataDir,demo:true});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const page=await app.knowledge().put({layer:'personal',title:'已有知识',content:'第一版'});
  let accepted=false,complete=false,reads=0;
  app.setMachineClient({list:()=>[{id:'node',name:'Node',online:true,platform:'linux',connectedAt:'now',capabilities:['executor.knowledge.start']}],async call(_id,method,params): Promise<Json> {
    if(method==='executor.knowledge.start')return {workerId:'worker',provider:'codex',scope:params.scope,state:'idle'};
    if(method==='executor.knowledge.submit'){accepted=true;return {accepted:true};}
    if(params.jobId){reads++;return {workerId:'worker',provider:'codex',scope:params.scope,state:complete?'idle':'running',job:{id:params.jobId,scope:params.scope,status:complete?'completed':'running',text:JSON.stringify({pages:[{id:page.id,title:page.title,content:'过时整理结果'}],summary:'update'})}};}
    return {workerId:'worker',provider:'codex',scope:params.scope,state:'idle'};
  }});
  await app.knowledgeCurator.configure({enabled:true,machineId:'node',provider:'codex'});
  app.knowledgeCurator.addSource({text:'用于更新已有知识的材料'});
  while(!accepted)await delay(10);
  await app.knowledge().put({...page,content:'用户刚刚手工修订'});complete=true;
  const deadline=Date.now()+7000;while(Date.now()<deadline&&app.knowledgeCurator.status().jobs[0].status!=='failed')await delay(20);
  assert.equal(app.knowledgeCurator.status().jobs[0].status,'failed');
  assert.equal((await app.knowledge().list()).find(p=>p.id===page.id)?.content,'用户刚刚手工修订');
  const previous=reads;await delay(2100);assert.equal(reads,previous);
});
