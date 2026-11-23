import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('独立 Web 对话只可停止原线正在处理的直接输入，排队及相邻线程继续', { timeout:30000 }, async t => {
  const streams = new Map<string,ServerResponse>();
  const frame = (delta:object, finish_reason:string|null) => 'data: '+JSON.stringify({
    id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason}],
  })+'\n\n';
  const model=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const latest=JSON.parse(raw).messages.findLast((m:{role:string})=>m.role==='user');
    const tag=JSON.stringify(latest).match(/SAMPLE_[A-Z]+/)?.[0] ?? 'unknown';
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(frame({role:'assistant',content:tag},null));
    streams.set(tag,res);
  });
  await new Promise<void>(ok=>model.listen(0,'127.0.0.1',ok));
  const addr=model.address();assert.ok(addr && typeof addr==='object');
  const dir=await mkdtemp(join(tmpdir(),'web-thread-stop-api-'));
  const host=await startServer({host:'127.0.0.1',port:0,token:'synthetic',dataDir:dir,demo:false,model:{
    provider:'openai-compatible',apiKey:'synthetic',model:'fixture',baseUrl:'http://127.0.0.1:'+addr.port+'/v1',
  }});
  t.after(async()=>{
    for(const res of streams.values())res.end();
    model.closeAllConnections();await new Promise<void>(ok=>model.close(()=>ok()));
    try {await host.close();}finally{await rm(dir,{recursive:true,force:true});}
  });
  const headers={authorization:'Bearer synthetic','content-type':'application/json'};
  const call=(path:string,body:object,method='POST')=>fetch(host.url+'/api/v1'+path,{headers,method,body:JSON.stringify(body)});
  const data=async(r:Response,status:number)=>{assert.equal(r.status,status,await r.clone().text());return r.json();};
  const project=host.app.projects.create({name:'合成项目'});
  const [a,b]=await Promise.all(['合成甲','合成乙'].map(async title=>{
    const {id}=await data(await call('/web-conversations',{id:randomUUID(),title,projectId:project.id}),201);
    return '/web-conversations/'+id;
  }));
  const ask=async(path:string,text:string):Promise<Message>=>data(await call(path+'/messages',{text}),202);
  const stop=(path:string,id:string)=>call(path+'/messages/'+id+'/stop',{});
  const first=await ask(a,'SAMPLE_FIRST'), sibling=await ask(b,'SAMPLE_SIBLING');
  await t.waitFor(()=>assert.ok(streams.has('SAMPLE_FIRST') && streams.has('SAMPLE_SIBLING')));
  const earlier=await ask(a,'SAMPLE_LATER');
  const taken=await ask(a,'SAMPLE_WITHDRAW');
  const reorder=(expected:string[],ordered:string[])=>call(a+'/messages/queue',{expected,ordered});
  const queueResult=await data(await reorder([earlier.id,taken.id],[taken.id,earlier.id]),200);
  assert.deepEqual(queueResult.items.map((m:Message)=>m.id),[taken.id,earlier.id]);
  assert.equal((await reorder([earlier.id,taken.id],[taken.id,earlier.id])).status,409);
  const take=(path:string)=>call(path+'/messages/'+taken.id+'/edit-queued',{projectId:project.id});
  assert.equal((await take(b)).status,404);
  const receipt=await data(await take(a),200);
  assert.equal(receipt.input.queueState,'withdrawn');
  assert.equal(receipt.input.text,'SAMPLE_WITHDRAW');
  assert.deepEqual(await data(await take(a),200),receipt);
  const cancel=(path:string,id:string)=>call(path+'/messages/'+id+'/cancel-queued',{});
  const discarded=await ask(a,'SAMPLE_CANCEL');
  assert.equal((await cancel(b,discarded.id)).status,404);
  assert.deepEqual(await data(await cancel(a,first.id),200),{outcome:'started'});
  for(let i=0;i<2;i++)assert.deepEqual(await data(await cancel(a,discarded.id),200),{outcome:'cancelled'});
  const queued=await ask(a,'SAMPLE_NEXT');
  await data(await reorder([earlier.id,queued.id],[queued.id,earlier.id]),200);
  assert.deepEqual(await data(await stop(a,queued.id),200),{outcome:'idle'});
  assert.equal((await stop(b,first.id)).status,404);
  for(const [id,changes] of [['indirect',{directWebInput:false}],['wrong-project',{projectId:'other'}],['routed',{}]] as const){
    host.app.store.put('messages',id,{...first,...changes,id});
    if(id==='routed')host.app.store.put('message.routes',id,{channel:'feishu'});
    assert.equal((await stop(a,id)).status,404);
  }
  assert.equal((await call(a+'/messages/'+first.id+'/stop',{inputId:sibling.id})).status,400);
  assert.deepEqual(await data(await stop(a,first.id),200),{outcome:'requested'});
  await t.waitFor(()=>assert.ok(streams.has('SAMPLE_NEXT')));
  assert.deepEqual(await data(await stop(a,first.id),200),{outcome:'idle'});
  const stopped=host.app.store.list<Message>('messages').find(m=>m.replyTo===first.id);
  assert.equal(stopped?.status,'failed');assert.equal(stopped?.stoppedByUser,true);
  assert.equal(host.app.store.get<Message>('messages',sibling.id)?.status,'pending');
  for(const tag of ['SAMPLE_NEXT','SAMPLE_SIBLING'])streams.get(tag)!.end(frame({},'stop')+'data: [DONE]\n\n');
  await t.waitFor(()=>assert.ok(streams.has('SAMPLE_LATER')));
  streams.get('SAMPLE_LATER')!.end(frame({},'stop')+'data: [DONE]\n\n');
  await t.waitFor(()=>assert.ok([sibling,queued].every(input=>host.app.store.get<Message>('messages',input.id)?.status==='done')));
  assert.ok(!streams.has('SAMPLE_WITHDRAW') && !streams.has('SAMPLE_CANCEL'));
  assert.deepEqual(await data(await stop(b,sibling.id),200),{outcome:'idle'});
  await data(await call('/plugins/web-conversations',{enabled:false}),200);
  assert.equal((await stop(b,sibling.id)).status,503);
  await data(await call('/plugins/web-conversations',{enabled:true}),200);
  await data(await call(b,{version:1,archived:true},'PATCH'),200);
  assert.equal((await stop(b,sibling.id)).status,409);
  await data(await call(b,{version:2},'DELETE'),200);
  assert.equal((await stop(b,sibling.id)).status,410);
});
