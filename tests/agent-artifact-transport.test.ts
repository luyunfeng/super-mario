import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createAgentArtifactLoader } from '../apps/agent-node/src/agent-artifacts.ts';

test('HTTP review → SHA confirmation → real node WebSocket load → version-pinned gateway call', {timeout:15000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-artifact-wire-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:join(dir,'server'),token:'artifact-wire-test',demo:true});
  const loader=createAgentArtifactLoader({dataDir:join(dir,'node')});
  const node=startAgentNode({url:server.url,token:'artifact-wire-test',machineId:'node',name:'Artifact node',dataDir:join(dir,'node'),handlers:loader.handlers,reconnectMs:10});
  t.after(async()=>{await node.close();await loader.close();await server.close();await rm(dir,{recursive:true,force:true});});
  async function api(path:string,method='GET',body?:unknown,expected=200){const r=await fetch(server.url+'/api/v1'+path,{method,headers:{Authorization:'Bearer artifact-wire-test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,expected,await r.clone().text());return r.json();}
  for(let i=0;i<200&&!server.machines.list().some(m=>m.online);i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(server.machines.list()[0]?.capabilities.includes('extension.call'));
  const source=`export default {id:'wire-probe',version:'1.0.0',activate(ctx){ctx.register('x.wire-probe.echo',async p=>({echo:p.text}));}};`;
  const staged=await api('/agent-artifacts','POST',{machineId:'node',manifest:{id:'wire-probe',version:'1.0.0',apiVersion:1},source},201);
  await api(`/agent-artifacts/${staged.id}/deploy`,'POST',{},400);
  assert.equal((await loader.handlers['extension.status']({},()=>{}) as any).artifacts.length,0);
  await api(`/agent-artifacts/${staged.id}/approve`,'POST',{sha256:'0'.repeat(64)},400);
  await api(`/agent-artifacts/${staged.id}/approve`,'POST',{sha256:staged.manifest.sha256});
  assert.equal((await api(`/agent-artifacts/${staged.id}/deploy`,'POST',{})).status,'loaded');
  assert.deepEqual(await api(`/agent-artifacts/${staged.id}/call`,'POST',{method:'x.wire-probe.echo',params:{text:'actual wire'}}),{echo:'actual wire'});
  assert.equal((await api(`/agent-artifacts/${staged.id}/status`)).status,'loaded');
  await assert.rejects(loader.handlers['extension.call']({id:'wire-probe',version:'2.0.0',sha256:staged.manifest.sha256,method:'x.wire-probe.echo',params:{}},()=>{}),/未加载|未注册/);
  const changed=await api('/agent-artifacts','POST',{machineId:'node',manifest:{id:'wire-probe',version:'1.0.1',apiVersion:1},source:source.replace('1.0.0','1.0.1')},201);
  await api(`/agent-artifacts/${changed.id}/deploy`,'POST',{},400);
});
