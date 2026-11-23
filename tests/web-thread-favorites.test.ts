import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('独立 Web 对话收藏保留可携带快照，定位须重新验证原线', async t => {
  const dataDir = await mkdtemp(join(tmpdir(),'web-thread-favorites-'));
  const config = {dataDir,demo:true,host:'127.0.0.1',port:0,token:'synthetic-access'};
  const server = await startServer(config);
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const api=(path:string,input:object,method='POST')=>fetch(server.url+'/api/v1/'+path,{
    method,headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify(input),
  });
  const project=await api('projects',{name:'合成收藏项目'});
  assert.ok(project.ok);
  const projectId=(await project.json()).id;
  const store=server.app.store;
  async function turn(text:string){
    const threadId=randomUUID();
    assert.equal((await api('web-conversations',{id:threadId,title:'合成工作对话',projectId})).status,201);
    const sent=await api('web-conversations/'+threadId+'/messages',{text});
    assert.equal(sent.status,202);
    const input:Message=await sent.json();
    const response=()=>store.list<Message>('messages').find(m=>m.replyTo===input.id && m.role==='assistant' && m.status==='done');
    await t.waitFor(()=>assert.ok(response()));
    return {threadId,input,reply:response()!};
  }
  const first=await turn('甲线合成原话');
  const other=await turn('乙线隔离原话');
  const path='web-conversations/'+first.threadId;
  const target={webThreadId:first.threadId,projectId};
  const favorite=(action:string,input:object={})=>api('message-favorites',{action,...input});
  const add=(id:string)=>favorite('add',{...target,messageId:id});
  for(const message of [other.input,other.reply]) assert.equal((await add(message.id)).status,404);
  assert.equal((await favorite('add',{messageId:first.input.id,webThreadId:first.threadId})).status,404);
  const routed=randomUUID(),routedReply=randomUUID();
  store.put('messages',routed,{...first.input,id:routed,status:'done',text:'被路由的合成私聊'});
  store.put('message.routes',routed,{channel:'feishu',inputId:routed,privateSenderId:'synthetic-owner'});
  store.put('messages',routedReply,{...first.reply,id:routedReply,replyTo:routed,text:'渠道答复'});
  for(const id of [routed,routedReply])assert.equal((await add(id)).status,404);
  const accepted=await add(first.input.id);assert.equal(accepted.status,200,await accepted.clone().text());
  assert.equal((await add(first.input.id)).status,200);
  const archived=await api(path,{version:1,archived:true},'PATCH');assert.equal(archived.status,200);
  assert.equal((await add(first.reply.id)).status,200);
  const book=await(await favorite('list')).json();
  assert.equal(book.items.length,2);
  for(const message of [first.input,first.reply]){
    const item=book.items.find((row:{messageId:string})=>row.messageId===message.id);
    assert.equal(item.text,message.text);assert.equal(item.role,message.role);
    assert.equal(item.title,'合成工作对话');
    const locate=await favorite('locate',{id:item.id});
    assert.equal(locate.status,200);
    assert.deepEqual(await locate.json(),{...target,messageId:message.id});
    assert.equal((await(await favorite('source',{id:item.id})).json()).text,message.text);
  }
  const backup=await(await favorite('backup')).json();
  assert.equal(backup.messages.length,2);
  for(const row of backup.messages)
    assert.deepEqual(Object.keys(row).sort(),['createdAt','key','omitted','role','starredAt','text','title']);
  for(const id of [first.threadId,first.reply.id,first.input.id,projectId])assert.ok(!JSON.stringify(backup).includes(id));
  const item=book.items[0];
  await server.app.plugins.setEnabled('web-conversations',false);
  assert.equal((await favorite('locate',{id:item.id})).status,503);
  assert.equal((await favorite('source',{id:item.id})).status,503);
  assert.equal((await add(first.reply.id)).status,503);
  assert.deepEqual(await(await favorite('list')).json(),book);
  await server.app.plugins.setEnabled('web-conversations',true);
  await server.app.plugins.setEnabled('message-favorites',false);
  assert.equal((await favorite('list')).status,503);
  await server.app.plugins.setEnabled('message-favorites',true);
  assert.equal((await api(path,{version:(await archived.json()).version},'DELETE')).status,200);
  assert.deepEqual(await(await favorite('list')).json(),book);
  for(const action of ['source','locate'])assert.equal((await favorite(action,{id:item.id})).status,410);
});
