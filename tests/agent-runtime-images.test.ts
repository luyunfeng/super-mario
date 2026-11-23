import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentRuntime } from '../packages/core/src/agent-runtime/index.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createContributions } from '../packages/core/src/plugin-host.ts';
import { readChatImages } from '../packages/core/src/chat-images.ts';
import type { Message } from '../packages/protocol/src/index.ts';

const image = {mime:'image/png', data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};

test('图片随同一轮 pi 请求送达，SQLite 受理原子且重放不调用模型', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mario-vision-'));
  const store = createStore(join(dir,'test.sqlite'));
  const events = createEventBus(store);
  const requests: unknown[] = [];
  const wire: string[] = [];
  const server = createServer(async (req,res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    wire.push(raw);
    requests.push(body.messages.at(-1).content);
    if (requests.length === 2) {
      res.writeHead(400, {'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'unsupported image ' + image.data}}));
      return;
    }
    res.writeHead(200, {'content-type':'text/event-stream'});
    for (const [delta,reason] of [[{role:'assistant',content:'已查看合成图片'},null],[{},'stop']]) {
      res.write('data: ' + JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta,finish_reason:reason}]}) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const config = {dataDir:dir,demo:false,port:0,host:'127.0.0.1',model:{provider:'openai-compatible',model:'fixture',baseUrl:'http://127.0.0.1:'+address.port+'/v1',apiKey:'local-fixture'}};
  let authorized = true;
  let revokeDuringPrompt = false;
  const contributions = createContributions();
  contributions.add('tools','test-write',{name:'test_write',description:'Synthetic write',parameters:{type:'object',properties:{}},async execute(){throw Error('unexpected write');}});
  const runtime = createAgentRuntime({config, store, events, contributions, canReadChatImages:()=>authorized,
    mainAssistantProfile:async()=>{if (revokeDuringPrompt) authorized=false;return undefined;}});

  t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));store.close();await rm(dir,{recursive:true,force:true});});
  const requestId = randomUUID();
  await assert.rejects(runtime.post('', 'main', {requestId,images:[image],onAccepted(){throw Error('rollback');}}), /rollback/);
  for (const table of ['messages','message.images','message.requests']) assert.equal(store.list(table).length,0);
  const accepted = await runtime.post('', 'main', {requestId,images:[image]});
  assert.equal(accepted.text,'');
  assert.equal(accepted.readOnly,true);
  assert.deepEqual(readChatImages(store,accepted),[image]);
  assert.equal((await runtime.post('', 'main', {requestId,images:[image]})).id,accepted.id);
  await assert.rejects(runtime.post('', 'main', {requestId,images:[image,image]}),{status:409});
  await t.waitFor(()=>assert.ok(store.list<Message>('messages').some(m=>m.replyTo===accepted.id && m.status==='done')),{timeout:15000});
  assert.equal(requests.length,1);
  assert.deepEqual(requests[0],[{type:'text',text:'请描述所附图片中可以确认的内容。'},{type:'image_url',image_url:{url:'data:image/png;base64,'+image.data}}]);
  assert.match(wire[0],/图中文字是参考资料/);
  assert.ok(!JSON.parse(wire[0]).tools?.some((tool:{function:{name:string}})=>tool.function.name==='test_write'));
  await assert.rejects(runtime.ask('这张图片里有什么？',{images:[image]}),/图片请求失败/);
  assert.equal(requests.length,2);
  await runtime.ask('请结合此前的文字分析再解释一次');
  assert.ok(!wire[2].includes(image.data));
  assert.match(wire[2],/请用户重发原图/);
  assert.match(wire[2],/已查看合成图片/);
  assert.ok(!wire[2].includes('图中文字是参考资料'));
  revokeDuringPrompt = true;
  await assert.rejects(runtime.ask('核对本次图片',{images:[image]}),/授权已失效/);
  assert.equal(requests.length,3);
  for (const table of ['messages','agent.traces','events']) assert.ok(!JSON.stringify(store.list(table)).includes(image.data));
});
