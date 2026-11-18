import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startServer} from '../apps/server/src/index.ts';
import {startAgentNode} from '../apps/agent-node/src/index.ts';
import {createAgentDiagnostics} from '../plugins/agent-diagnostics.ts';
import {createExecutionServices} from '../plugins/executors.ts';
import type {TerminalHost} from '../packages/plugin-sdk/src/index.ts';

async function until(read:()=>boolean){for(let n=0;n<200;n++){if(read())return;await delay(10);}throw Error('local node not ready');}
test('real HTTP/WS diagnostics and recovery expose actual agent identity and retain old-peer compatibility',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mario-execution-metadata-'));const server=await startServer({host:'127.0.0.1',port:0,dataDir:join(dir,'server'),demo:true,token:'local-test'});
 const launcher=join(dir,'offline-codex');await writeFile(launcher,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 1.2.3"; else echo "Logged in using ChatGPT" >&2; fi\n');await chmod(launcher,0o700);
 const diagnostics=createAgentDiagnostics({launchers:{codex:{command:launcher}},env:{PATH:process.env.PATH,HOME:dir}});
 const host:TerminalHost={async status(){return{available:true};},async list(){return[];},async create(){throw Error('no launch');},async read(){throw Error('no screen');},async input(){throw Error('no write');},async keys(){throw Error('no write');},async close(){throw Error('no close');},async watch(){throw Error('no watch');}};
 const services=createExecutionServices({host,dataDir:join(dir,'node'),machineId:'node',agentInstanceId:'node-process'});
 const node=startAgentNode({url:server.url,token:'local-test',machineId:'node',agentInstanceId:'node-process',name:'fixture',dataDir:dir,handlers:{...services.handlers,...diagnostics.handlers}});
 const old=startAgentNode({url:server.url,token:'local-test',machineId:'old',name:'legacy fixture',dataDir:dir,handlers:{}});
 try{
  await until(()=>server.machines.list().filter(m=>m.online).length===2);const headers={authorization:'Bearer local-test','content-type':'application/json'};
  assert.equal((await fetch(server.url+'/api/v1/machines/node/diagnostics',{method:'POST',body:JSON.stringify({executorId:'codex'})})).status,401);
  const request=(id:string,body:unknown)=>fetch(server.url+'/api/v1/machines/'+id+'/diagnostics',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await request('node',{executorId:'codex',command:'untrusted'})).status,400);
  const response=await request('node',{executorId:'codex'});assert.equal(response.status,200);const data=await response.json() as any;
  assert.equal(data.authentication.state,'authenticated');assert.equal(data.version.value,'1.2.3');assert.ok(!JSON.stringify(data).includes(launcher));
  assert.equal((await request('old',{executorId:'codex'})).status,400);
  const result=await fetch(server.url+'/api/v1/machines/node/recovery',{headers});assert.equal(result.status,200);const recovery=await result.json() as any;
  assert.equal(recovery.agentInstanceId,'node-process');assert.equal(recovery.host.identity.state,'unknown');assert.equal(recovery.host.atomicControl.state,'unsupported');assert.deepEqual(recovery.sessions,[]);
  assert.equal(server.machines.list().find(m=>m.id==='node')!.agentInstanceId,'node-process');
 }finally{await node.close();await old.close();await services.close();await server.close();await rm(dir,{recursive:true,force:true});}
});
