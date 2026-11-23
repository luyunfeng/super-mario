import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('主对话、项目与独立 Web 对话可重试工具前失败的回复，并发复用原附件仅启动一轮', {timeout:45000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-retry-reply-')),headers={authorization:'Bearer fixture','content-type':'application/json'};
  const requests=new Map<string,string[]>(),retryPrompt=new Set<string>(),held=new Map<string,ServerResponse>();
  const model=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    const packet=JSON.parse(body),last=packet.messages.at(-1);
    const user=JSON.stringify(packet.messages.findLast((m:{role:string})=>m.role==='user')?.content);
    const tag=user.match(/CASE_[A-Z]+/u)?.[0]??'other';
    if(packet.messages.some((m:{role:string;content:unknown})=>['system','developer'].includes(m.role) && JSON.stringify(m.content).includes('先前的失败文字不能作为交付或额外授权'))) retryPrompt.add(tag);
    const attempts=requests.get(tag)??[];attempts.push(user);requests.set(tag,attempts);
    const event=(delta:object,finish_reason:string|null)=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',
      model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n';
    if(['CASE_TOOL','CASE_THREADTOOL'].includes(tag) && last.role==='user'){
      res.writeHead(200,{'content-type':'text/event-stream'});
      const tool={index:0,id:'synthetic',type:'function',function:{name:'todos_list',arguments:'{}'}};
      return res.end(event({role:'assistant',tool_calls:[tool]},null)+event({},'tool_calls')+'data: [DONE]\n\n');
    }
    if(tag==='CASE_STOP' || (attempts.length===2 && ['CASE_MAIN','CASE_PROJECT','CASE_THREAD'].includes(tag))){
      res.writeHead(200,{'content-type':'text/event-stream'});res.write(event({role:'assistant',content:'合成回复'},null));
      held.set(tag,res);return;
    }
    res.writeHead(400,{'content-type':'application/json'});
    res.end(JSON.stringify({error:{message:'合成模型错误',type:'invalid_request_error'}}));
  });
  await new Promise<void>(done=>model.listen(0,'127.0.0.1',done));const addr=model.address();assert.ok(addr && typeof addr==='object');
  const host=await startServer({host:'127.0.0.1',port:0,token:'fixture',dataDir:dir,demo:false,model:{
    provider:'openai-compatible',apiKey:'fixture',model:'fixture',baseUrl:'http://127.0.0.1:'+addr.port+'/v1'}});
  t.after(async()=>{for(const stream of held.values())stream.end();try{await host.close();}finally{
    model.closeAllConnections();await new Promise<void>(done=>model.close(()=>done()));await rm(dir,{recursive:true,force:true});}});
  const post=(path:string,data:unknown)=>fetch(host.url+'/api/v1'+path,{method:'POST',headers,body:JSON.stringify(data)});
  const response=async(r:Response,status:number)=>{assert.equal(r.status,status,await r.clone().text());return r.json();};
  const answer=(input:Message,status:string)=>t.waitFor(()=>{
    const m=host.app.store.list<Message>('messages').find(row=>row.replyTo===input.id && row.status===status);assert.ok(m);return m;
  },{timeout:10000});
  const retry=(a:Message,conversationId=a.conversationId)=>post('/messages/'+a.id+'/retry',{conversationId});
  const project=host.app.projects.create({name:'重试项目'}),projectPath='/projects/'+project.id+'/messages';
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCc8AAAAASUVORK5CYII=';
  const threadId=randomUUID(),sibling=randomUUID(),threadPath='/web-conversations/'+threadId;
  for(const id of [threadId,sibling])await response(await post('/web-conversations',{id,title:'合成重试线程',projectId:project.id}),201);
  const threadState=(version:number,archived:boolean)=>fetch(host.url+'/api/v1'+threadPath,{method:'PATCH',headers,body:JSON.stringify({version,archived})});
  for (const tag of ['CASE_MAIN','CASE_PROJECT','CASE_THREAD']) {
    const main=tag==='CASE_MAIN',thread=tag==='CASE_THREAD';
    const conv=main?'main':thread?'web:'+threadId:'project:'+project.id+':work',path=main?'/messages':thread?threadPath+'/messages':projectPath;
    const bytes='附件合成标记 '+tag,original=tag+' 请核对以下两项。\n保留第二行。';
    const upload=await response(await fetch(host.url+'/api/v1/chat-files/uploads?'+new URLSearchParams({
      conversationId:conv,name:'合成.txt',...(!main && {projectId:project.id})}),{
      method:'PUT',headers:{...headers,'content-type':'text/plain'},body:bytes}),201);
    const input:Message=await response(await post(path,{text:original,files:[{uploadId:upload.uploadId}],images:[{mime:'image/png',data:png}]}),202);
    const failed=await answer(input,'failed');assert.equal(failed.retryable,true);
    assert.equal((await retry(failed,main?'project:'+project.id+':work':'main')).status,404);
    const failedAttempt=requests.get(tag)![0];assert.ok(failedAttempt.includes(bytes) && failedAttempt.includes(png));
    if(main) {
      assert.equal((await fetch(host.url+'/api/v1/messages/'+failed.id+'/retry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversationId:conv})})).status,401);
      assert.equal((await post('/messages/'+failed.id+'/retry',{conversationId:conv,text:'替换原输入'})).status,400);
      await response(await post('/plugins/conversation-retry',{enabled:false}),200);
      assert.equal((await retry(failed)).status,503);assert.equal(requests.get(tag)?.length,1);
      await response(await post('/plugins/conversation-retry',{enabled:true}),200);
      await response(await post('/plugins/conversation-files',{enabled:false}),200);
      const denied=await retry(failed);assert.ok([403,409,503].includes(denied.status));
      assert.equal(requests.get(tag)?.length,1);
      await response(await post('/plugins/conversation-files',{enabled:true}),200);
    }
    if(thread){
      assert.equal((await retry(failed,'web:'+sibling)).status,404);
      assert.equal((await retry(failed,'project:'+project.id+':work')).status,404);
      assert.equal((await threadState(1,true)).status,200);
      assert.equal((await retry(failed)).status,409);
      assert.equal((await threadState(2,false)).status,200);
      for(const plugin of ['conversation-images','conversation-files','conversation-retry','web-conversations']){
        await host.app.plugins.setEnabled(plugin,false);
        assert.ok([403,503].includes((await retry(failed)).status));
        await host.app.plugins.setEnabled(plugin,true);
      }
      host.app.store.put('message.routes',failed.id,{channel:'feishu'});
      assert.equal((await retry(failed)).status,404);
      host.app.store.remove('message.routes',failed.id);
      assert.equal(requests.get(tag)?.length,1);
    }
    const [a,b]=await Promise.all([retry(failed),retry(failed)]);
    const one:Message=await response(a,202),two:Message=await response(b,202);
    assert.equal(one.id,two.id);assert.notEqual(one.id,input.id);assert.equal(one.retryOf,failed.id);
    assert.equal(one.text,original);assert.equal(one.conversationId,conv);assert.equal(one.projectId,input.projectId);
    assert.deepEqual(one.images,input.images);assert.deepEqual(one.files,input.files);
    await t.waitFor(()=>assert.ok(held.has(tag)),{timeout:10000});
    const stream=held.get(tag)!;stream.end('data: '+JSON.stringify({id:'fixture',model:'fixture',object:'chat.completion.chunk',
      choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    await answer(one,'done');assert.equal(requests.get(tag)?.length,2);
    assert.equal(requests.get(tag)![1],failedAttempt);assert.ok(retryPrompt.has(tag),'真实重试轮须收到授权边界提示');
    if(thread){
      const del=await fetch(host.url+'/api/v1'+threadPath,{method:'DELETE',headers,body:JSON.stringify({version:3})});
      assert.equal(del.status,200);
      assert.equal((await retry(failed)).status,404);
      assert.equal(requests.get(tag)?.length,2);
    }
    if(!thread)assert.equal(host.app.store.get<Message>('messages',failed.id)?.status,'failed');
  }
  const unsafeInput:Message=await response(await post('/web-conversations/'+sibling+'/messages',{text:'CASE_THREADTOOL 请查看待办'}),202);
  const unsafeReply=await answer(unsafeInput,'failed');
  assert.ok(!unsafeReply.retryable);
  assert.equal((await retry(unsafeReply)).status,409);
  assert.equal(requests.get('CASE_THREADTOOL')?.length,2);
  const old:Message=await response(await post(projectPath,{text:'CASE_RETIRED 稍后归档项目'}),202);
  const retired=await answer(old,'failed');assert.equal(retired.retryable,true);
  const archive=await fetch(host.url+'/api/v1/projects/'+project.id,{method:'DELETE',headers});assert.equal(archive.status,200);
  const inactive=await retry(retired);assert.ok([403,404,409].includes(inactive.status));assert.equal(requests.get('CASE_RETIRED')?.length,1);
  const toolInput:Message=await response(await post('/messages',{text:'CASE_TOOL 请查待办'}),202),tool=await answer(toolInput,'failed');
  assert.equal(requests.get('CASE_TOOL')?.length,2);assert.ok(!tool.retryable);
  assert.ok([403,409].includes((await retry(tool)).status));assert.equal(requests.get('CASE_TOOL')?.length,2);
  const stoppedInput:Message=await response(await post('/messages',{text:'CASE_STOP 主人将结束本轮'}),202);
  await t.waitFor(()=>assert.ok(held.has('CASE_STOP')));
  const stop=await response(await post('/messages/'+stoppedInput.id+'/stop',{}),200);assert.equal(stop.outcome,'requested');
  const stopped=await answer(stoppedInput,'failed');assert.equal(stopped.stoppedByUser,true);assert.ok(!stopped.retryable);
  assert.ok([403,409].includes((await retry(stopped)).status));assert.equal(requests.get('CASE_STOP')?.length,1);
});
