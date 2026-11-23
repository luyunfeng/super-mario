import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('独立 Web 对话导出只含本线真实输入和对应回复，归档可读，删除或插件停用后拒读', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'web-thread-export-'));
  const server = await startServer({ dataDir, demo:true, host:'127.0.0.1', port:0, token:'fixture-token' });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive:true, force:true }); });
  const api = (path:string, input:object, method='POST') => fetch(server.url+'/api/v1/'+path,{
    method, headers:{ authorization:'Bearer fixture-token','content-type':'application/json' }, body:JSON.stringify(input),
  });
  const project = async(name:string) => {
    const response = await api('projects',{name});
    assert.ok(response.ok);
    return (await response.json()).id as string;
  };
  const projectId = await project('合成甲项目'), otherProject = await project('合成乙项目');
  async function conversation(title:string, projectId?:string) {
    const id = randomUUID();
    assert.equal((await api('web-conversations',{id,title,projectId})).status,201);
    return id;
  }
  const id = await conversation('合成导出对话',projectId);
  const other = await conversation('同项目另一条对话',projectId);
  const global = await conversation('无项目对话');
  const store = server.app.store;
  async function turn(threadId:string,text:string) {
    const response = await api('web-conversations/'+threadId+'/messages',{text});
    assert.equal(response.status,202);
    const input:Message = await response.json();
    const reply = () => store.list<Message>('messages').find(m => m.replyTo===input.id && m.status==='done' && m.role==='assistant');
    await t.waitFor(()=>assert.ok(reply()));
    return {input,reply:reply()!};
  }
  const local = await turn(id,'要导出的合成原话');
  const sibling = await turn(other,'隔离标记：同项目另一条线');
  await turn(global,'隔离标记：无项目原话');
  const fakeInput = (label:string, changes:Partial<Message>) => {
    const key = randomUUID();
    store.put('messages',key,{...local.input,id:key,status:'done',text:'隔离标记：'+label,...changes});
    return key;
  };
  const routed = fakeInput('飞书入站',{});
  store.put('message.routes',routed,{channel:'feishu',inputId:routed});
  fakeInput('其他项目',{projectId:otherProject});
  fakeInput('内部合成',{directWebInput:undefined});
  for(const source of [routed,sibling.input.id]){
    const key = randomUUID();
    store.put('messages',key,{...local.reply,id:key,replyTo:source,text:'隔离标记：非本线回复'});
  }
  store.put('agent.traces',local.reply.id,{id:local.reply.id,userMessageId:local.input.id,conversationId:local.input.conversationId,
    toolCalls:[{name:'fixture_lookup',isError:false,finishedAt:local.input.createdAt,args:'不可公开的合成参数'}]});
  const exportThread = (input:object,includeWork=false) => api('conversation-export',{...input,includeWork});
  const target = {webThreadId:id,projectId};
  const archived = await api('web-conversations/'+id,{version:1,archived:true},'PATCH');
  assert.equal(archived.status,200);
  for(const includeWork of [false,true]){
    const response = await exportThread(target,includeWork);
    assert.equal(response.status,200,await response.clone().text());
    const {markdown,filename,count} = await response.json();
    assert.equal(count,2); assert.match(filename,/\.md$/);
    for(const expected of ['合成导出对话',local.input.text,local.reply.text]) assert.ok(markdown.includes(expected));
    assert.equal(markdown.includes('fixture_lookup'),includeWork);
    assert.doesNotMatch(markdown,/隔离标记|不可公开的合成参数/);
  }
  assert.equal((await exportThread({webThreadId:id})).status,404);
  assert.equal((await exportThread({...target,projectId:otherProject})).status,404);
  assert.equal((await exportThread({webThreadId:global})).status,200);
  assert.equal((await exportThread({...target,native:{}})).status,400);
  assert.equal((await exportThread({...target,threadId:'wrong'})).status,400);
  for(const plugin of ['conversation-export','web-conversations']){
    await server.app.plugins.setEnabled(plugin,false);
    assert.equal((await exportThread(target)).status,503);
    await server.app.plugins.setEnabled(plugin,true);
  }
  assert.equal((await api('web-conversations/'+id,{version:(await archived.json()).version},'DELETE')).status,200);
  assert.equal((await exportThread(target)).status,410);
  assert.equal((await exportThread({webThreadId:other,projectId})).status,200);
});
