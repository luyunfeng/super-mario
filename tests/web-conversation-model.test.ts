import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('SDK requests preserve the correct Web thread history within a shared project and isolate main', async t => {
  const requests: { role: string; content: unknown }[][] = [];
  const model = createServer(async (req, res) => {
    if (req.method === 'GET') { res.end('fixture'); return; }
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw).messages);
    res.writeHead(200, { 'content-type':'text/event-stream' });
    for (const [delta,finish_reason] of [[{ role:'assistant', content:'fixture-answer-'+requests.length },null],[{},'stop']]) {
      res.write('data: '+JSON.stringify({ id:'fixture', object:'chat.completion.chunk',created:1,model:'fixture',
        choices:[{index:0,delta,finish_reason}] })+'\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const dir = await mkdtemp(join(tmpdir(),'sm-web-thread-sdk-'));
  const address=model.address();
  assert.ok(address && typeof address==='object');
  t.after(async()=>{
    model.closeAllConnections();
    await new Promise<void>(resolve=>model.close(()=>resolve()));
    await rm(dir,{recursive:true,force:true});
  });
  const server = await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:false, model:{
    provider:'openai-compatible', model:'fixture',apiKey:'synthetic-local',baseUrl:'http://127.0.0.1:'+address.port+'/v1',
  }});
  try {
    async function post(path:string, body:object) {
      const response = await fetch(server.url+'/api/v1'+path, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    }
    const project = await post('/projects',{name:'合成并行项目'});
    const [a,b] = await Promise.all([1,2].map(n => post('/web-conversations',{id:randomUUID(),title:'对话'+n,projectId:project.id})));
    async function ask(path:string,conversationId:string,text:string) {
      const before=requests.length;
      const input=await post(path,{text});
      assert.equal(input.conversationId,conversationId);
      assert.equal(input.projectId,conversationId==='main'?undefined:project.id);
      for(let i=0;i<500;i++) {
        const reply=server.app.store.list<Message>('messages').find(row=>row.replyTo===input.id && (row.status==='done' || row.status==='failed'));
        if(reply){
          assert.equal(reply.status,'done',reply.text);
          assert.equal(reply.conversationId,conversationId);
          assert.equal(reply.projectId,input.projectId);
          assert.equal(requests.length,before+1);
          return requests[before];
        }
        await delay(10);
      }
      assert.fail('等待本地模型回合结束超时');
    }
    const askA=(text:string)=>ask('/web-conversations/'+a.id+'/messages','web:'+a.id,text);
    const askB=(text:string)=>ask('/web-conversations/'+b.id+'/messages','web:'+b.id,text);
    const aOnly='A-only-'+randomUUID(), bOnly='B-only-'+randomUUID();
    const firstA=await askA(aOnly), firstB=await askB(bOnly);
    const nextA=await askA('请回顾本对话的首条内容');
    const main=await ask('/messages','main','只看主对话上文');
    const system=(messages:typeof firstA)=>JSON.stringify(messages.filter(m=>m.role==='system'||m.role==='developer'));
    for(const thread of [firstA,firstB,nextA]){
      assert.match(system(thread), /当前输入来自一段独立的 Web 对话/);
      assert.match(system(thread), /承接上文时只使用本会话实际提供的消息/);
      assert.match(system(thread), /不能把回复描述成已发往飞书/);
    }
    assert.ok(JSON.stringify(firstB).includes(bOnly));
    assert.ok(!JSON.stringify(firstB).includes(aOnly));
    assert.ok(JSON.stringify(nextA.filter(m=>m.role==='user')).includes(aOnly));
    assert.ok(JSON.stringify(nextA.filter(m=>m.role==='assistant')).includes('fixture-answer-1'));
    assert.ok(!JSON.stringify(nextA).includes(bOnly));
    assert.ok(!JSON.stringify(nextA).includes('fixture-answer-2'));
    assert.ok(!JSON.stringify(main).includes(aOnly) && !JSON.stringify(main).includes(bOnly));
    assert.doesNotMatch(system(main),/当前输入来自一段独立的 Web 对话/);
  } finally {
    await server.close();
  }
});
