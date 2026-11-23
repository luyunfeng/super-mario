import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import type {Run} from '../packages/protocol/src/index.ts';
import {startServer} from '../apps/server/src/index.ts';

test('管理员签发单机凭据，执行机身份受限且撤销立即断开现有连接',{timeout:20000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'machine-credential-http-')),root='synthetic-credential-root';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,token:root,demo:true});
  const peers=new Set<WebSocket>();
  t.after(async()=>{for(const ws of peers)ws.terminate();await server.close();await rm(dataDir,{recursive:true,force:true});});
  const api=server.url+'/api/v1',wsBase=api.replace('http:','ws:');
  const bearer=(token:string)=>({authorization:'Bearer '+token});
  const post=(action:string,input:object,headers:Record<string,string>)=>fetch(api+'/admin/'+action,{
    method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(input),
  });
  const code=await (await post('setup-code',{},bearer(root))).json();
  const setup=await post('setup',{code:code.code,password:'synthetic-machine-management'},{});
  assert.equal(setup.status,200);
  const cookie=setup.headers.get('set-cookie')!.split(';')[0]!;
  const admin={cookie,'x-csrf-token':(await setup.json()).csrf};
  const endpoint=api+'/admin/machine-credentials',id='fixture-node-a';
  function socket(path:string,token:string){
    const ws=new WebSocket(wsBase+path,{headers:bearer(token)});peers.add(ws);
    ws.on('error',()=>{});ws.on('close',()=>peers.delete(ws));return ws;
  }
  function hello(ws:WebSocket,machineId:string){
    ws.send(JSON.stringify({type:'hello',machineId,name:'合成节点',platform:'linux',capabilities:[]}));
  }
  const first=socket('/node',root);await once(first,'open');hello(first,id);
  await once(first,'message');first.close();await once(first,'close');
  assert.equal((await fetch(endpoint,{headers:bearer(root)})).status,401);
  assert.equal((await post('machine-credentials/issue',{id},bearer(root))).status,401);
  assert.equal((await post('machine-credentials/issue',{id},{cookie})).status,403);
  assert.equal((await post('machine-credentials/issue',{id},{...admin,origin:'https://unrelated.invalid'})).status,403);
  const issued=await post('machine-credentials/issue',{id},admin);assert.equal(issued.status,201);
  assert.equal(issued.headers.get('cache-control'),'no-store');
  const credential=await issued.json();assert.equal(credential.id,id);assert.ok(credential.token);
  const listed=await fetch(endpoint,{headers:{cookie}});assert.equal(listed.status,200);
  assert.deepEqual(await listed.json(),{machines:[{id}]});
  const token:string=credential.token;
  assert.equal((await fetch(api+'/state',{headers:bearer(token)})).status,401);
  await assert.rejects(once(socket('/events',token),'open'),/401|403/);
  const wrong=socket('/node',token);await once(wrong,'open');hello(wrong,'fixture-node-b');
  assert.equal((await once(wrong,'close'))[0],1008);
  const current=socket('/node',token);await once(current,'open');hello(current,id);
  await once(current,'message');
  assert.equal((await post('machines/remove',{id},bearer(root))).status,401);
  assert.equal((await post('machines/remove',{id},{cookie})).status,403);
  assert.equal((await post('machines/remove',{id},{...admin,origin:'https://unrelated.invalid'})).status,403);
  assert.equal((await post('machines/remove',{id},admin)).status,409);
  assert.deepEqual(await(await fetch(endpoint,{headers:{cookie}})).json(),{machines:[{id}]});
  assert.equal((await post('machine-credentials/revoke',{id},{cookie})).status,403);
  const closed=once(current,'close');
  const revoked=await post('machine-credentials/revoke',{id},admin);
  assert.equal(revoked.status,200);assert.deepEqual(await revoked.json(),{revoked:true});await closed;
  await assert.rejects(once(socket('/node',token),'open'),/401|403/);
  assert.deepEqual(await(await fetch(endpoint,{headers:{cookie}})).json(),{machines:[]});
  assert.equal((await post('machine-credentials/revoke',{id},admin)).status,404);
  const replacement=await post('machine-credentials/issue',{id},admin);assert.equal(replacement.status,201);
  const replacementToken=(await replacement.json()).token;
  for(let attempt=0;attempt<2;attempt++){
    const peer=socket('/node',replacementToken);await once(peer,'open');hello(peer,id);
    await once(peer,'message');peer.close();await once(peer,'close');
    await t.waitFor(async()=>{
      const list=await(await fetch(api+'/admin/machines',{headers:{cookie}})).json();
      assert.equal(list.machines.find((m:{id:string})=>m.id===id).online,false);
    });
  }
  const at=new Date().toISOString();
  const history:Run={id:'fixture-history',executorId:'fixture-executor',machineId:id,conversationId:'main',
    prompt:'合成任务',status:'completed',output:'已有结果',createdAt:at,updatedAt:at};
  server.app.store.put('runs',history.id,history);
  const removed=await post('machines/remove',{id},admin);assert.equal(removed.status,200);
  assert.deepEqual(await removed.json(),{machines:[]});
  assert.deepEqual(await(await fetch(endpoint,{headers:{cookie}})).json(),{machines:[]});
  await assert.rejects(once(socket('/node',replacementToken),'open'),/401|403/);
  const snapshot=await(await fetch(api+'/state',{headers:bearer(root)})).json();
  assert.deepEqual(snapshot.runs.find((r:Run)=>r.id===history.id),history);
  assert.equal((await post('machines/remove',{id},admin)).status,404);
});
