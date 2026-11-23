import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('独立 Web 对话上传和发送绑定同一登记；模型只读附件，归档可下载，删除或插件停用失效',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'web-thread-files-'));
  const observed:string[]=[];
  const model=createServer(async(req,res)=>{
    if(req.method==='GET'){res.end('fixture');return;}
    let raw='';for await(const chunk of req)raw+=chunk.toString();observed.push(raw);
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,finish_reason] of [[{role:'assistant',content:'合成已读'},null],[{},'stop']])
      res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const address=model.address();assert.ok(address&&typeof address==='object');
  const server=await startServer({dataDir,demo:false,host:'127.0.0.1',port:0,token:'local-test',model:{provider:'openai-compatible',model:'fixture',apiKey:'fixture',baseUrl:'http://127.0.0.1:'+address.port+'/v1'}});
  t.after(async()=>{await server.close();model.closeAllConnections();await new Promise(r=>model.close(r));await rm(dataDir,{recursive:true,force:true});});
  const base=server.url+'/api/v1/',auth={authorization:'Bearer local-test'};
  const json=(path:string,value:object,method='POST',key?:string)=>fetch(base+path,{method,headers:{...auth,'content-type':'application/json',...(key && {'idempotency-key':key})},body:JSON.stringify(value)});
  const projectId=(await(await json('projects',{name:'合成附件项目'})).json()).id;
  const [a,b,global]=[randomUUID(),randomUUID(),randomUUID()];
  for(const id of [a,b,global])assert.equal((await json('web-conversations',{id,title:'合成附件对话',...(id!==global&&{projectId})})).status,201);
  const text='合成文件内容-'+randomUUID();
  const upload=(id:string,project?:string,todo?:string)=>fetch(base+'chat-files/uploads?'+new URLSearchParams({
    conversationId:'web:'+id,name:'合成材料.txt',...(project&&{projectId:project}),...(todo&&{todoId:todo}),
  }),{method:'PUT',headers:{...auth,'content-type':'text/plain'},body:text});
  const path=(id:string)=>'web-conversations/'+id;
  assert.equal((await upload(global)).status,201);
  assert.equal((await upload(a)).status,404);
  assert.equal((await upload(a,projectId,'other')).status,403);
  assert.equal((await upload(randomUUID(),projectId)).status,404);
  const receipt=await upload(a,projectId);assert.equal(receipt.status,201);
  const {uploadId}=await receipt.json(),payload={files:[{uploadId}]};
  assert.equal((await json(path(b)+'/messages',payload)).status,403);
  assert.equal((await json(path(a)+'/messages',{...payload,projectId})).status,400);
  const key=randomUUID(),accepted=await json(path(a)+'/messages',payload,'POST',key);
  assert.equal(accepted.status,202,await accepted.clone().text());
  const input:Message=await accepted.json();
  assert.equal(input.readOnly,true);assert.equal(input.text,'');assert.equal(input.files?.[0].name,'合成材料.txt');
  assert.equal((await(await json(path(a)+'/messages',payload,'POST',key)).json()).id,input.id);
  await t.waitFor(()=>assert.ok(server.app.store.list<Message>('messages').some(m=>m.replyTo===input.id&&m.status==='done')));
  assert.equal(observed.length,1);assert.ok(JSON.stringify(JSON.parse(observed[0]).messages).includes(text));
  const file=(id:string,preview=false,messageId=input.id)=>fetch(base+'messages/'+messageId+'/files/0'+(preview?'/preview':'')+'?conversationId=web:'+id,{headers:auth});
  assert.equal((await file(b)).status,404);
  const routed=randomUUID();server.app.store.put('messages',routed,{...input,id:routed,status:'done'});
  server.app.store.put('message.routes',routed,{channel:'feishu',inputId:routed});
  assert.equal((await file(a,false,routed)).status,404);
  const archive=await json(path(a),{version:1,archived:true},'PATCH');assert.equal(archive.status,200);
  assert.equal((await upload(a,projectId)).status,409);
  assert.equal((await json(path(a)+'/messages',payload)).status,409);
  assert.equal(await(await file(a)).text(),text);
  assert.equal((await(await file(a,true)).json()).text,text);
  for(const plugin of ['conversation-files','web-conversations']){
    await server.app.plugins.setEnabled(plugin,false);
    assert.equal((await upload(global)).status,503);
    assert.ok([404,503].includes((await file(a)).status));
    assert.ok([404,503].includes((await file(a,true)).status));
    await server.app.plugins.setEnabled(plugin,true);
  }
  assert.equal((await json(path(a),{version:(await archive.json()).version},'DELETE')).status,200);
  assert.equal((await upload(a,projectId)).status,410);
  assert.equal((await file(a)).status,404);
});
