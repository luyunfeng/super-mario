import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost, createContributions } from '../packages/core/src/plugin-host.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createConversationExport } from '../plugins/conversation-export.ts';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';

test('export is an authenticated plugin read of one owner-selected work conversation', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-export-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, demo: true, token: 'synthetic-export-token' };
  const server = await startServer(config);
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const post = (path: string, body: object, authorized = true) => fetch(server.url + '/api/v1' + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized && { authorization: 'Bearer ' + config.token }) },
    body: JSON.stringify(body),
  });
  const project = server.app.projects.create({ name: '本地验收', workspace: { machineId: 'fixture-node', cwd: '/workspace/[alpha]' } });
  const scope = `project:${project.id}:work`;
  const store = server.app.store;
  for (const [id, conversationId, text] of [
    ['main', 'main', '主对话记录'],
    ['memory', `project:${project.id}:memory`, '独立记忆记录'],
    ['bot', 'bot:synthetic', '机器人独立记录'],
    ['work', scope, '浏览器工作会话'],
  ]) {
    store.put('messages', id!, { id, projectId: project.id, conversationId, role: 'user', text, createdAt: '2026-11-17T02:04:00Z' });
  }
  store.put('messages', 'mismatched', { id: 'mismatched', projectId: 'other', conversationId: scope,
    role: 'user', text: '归属不一致的输入', createdAt: '2026-11-17T02:04:00Z' });
  const request = { projectId: project.id, includeWork: true };
  const path = '/conversation-export';
  assert.equal((await post(path, request, false)).status, 401);
  assert.equal((await post(path, { ...request, conversationId: 'bot:synthetic' })).status, 400);
  assert.equal((await post(path, { ...request, includeWork: 'false' })).status, 400);
  assert.equal((await post(path, { ...request, projectId: 'absent' })).status, 404);
  const response = await post(path, request);
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.count, 1);
  assert.ok(document.markdown.includes('导出时绑定的电脑：fixture-node'));
  assert.ok(document.markdown.includes(String.raw`导出时绑定的目录：/workspace/\[alpha\]`));
  assert.match(document.markdown, /浏览器工作会话/);
  assert.doesNotMatch(document.markdown, /独立记忆记录|机器人独立记录|主对话记录|归属不一致的输入/);
  for (const id of ['reply', 'wrong-scope']) {
    store.put('messages', id, { id, conversationId: scope, role: 'assistant', replyTo: 'work', text: '执行结束', createdAt: '2026-11-17T02:05:00Z' });
    store.put('agent.traces', id, { id, conversationId: id === 'reply' ? scope : 'main', userMessageId: 'work',
      toolCalls: [{ name: id === 'reply' ? 'project.read' : 'foreign.tool', input: 'private-input', output: 'private-output',
        isError: false, finishedAt: '2026-11-17T02:04:59Z' }] });
  }
  const detailed = await (await post(path, request)).json();
  assert.match(detailed.markdown, /## 项目助手 ·/);
  assert.match(detailed.markdown, /project\.read` · 成功/);
  assert.doesNotMatch(detailed.markdown, /private-input|private-output|foreign\.tool/);
  const plain = await (await post(path, { ...request, includeWork: false })).json();
  assert.doesNotMatch(plain.markdown, /project\.read|foreign\.tool/);
  store.put('messages', 'main-reply', { ...store.get<object>('messages', 'main')!, id: 'main-reply', role: 'assistant' });
  await post('/assistant-profile', { action: 'save', revision: 0, name: '[合成](地址)' });
  const named = await (await post(path, { includeWork: false })).json();
  assert.doesNotMatch(named.markdown, /fixture-node|导出时绑定的目录/);
  assert.ok(named.markdown.includes(String.raw`## \[合成\](地址) ·`));
  await post('/plugins/assistant-profile', { enabled: false });
  const unnamed = await (await post(path, { includeWork: false })).json();
  assert.match(unnamed.markdown, /## 主 Agent ·/);
  assert.equal((await post('/plugins/conversation-export', { enabled: false })).status, 200);
  assert.equal((await post(path, request)).status, 503);
});

test('independent Web thread export reads the whole registered history and validates source exclusivity', async t=>{
  const store=createStore(':memory:'), id='b9c8631f-3c50-4507-82d2-67e16a057351';
  const host=new PluginHost({store,events:createEventBus(store),dataDir:'',contributions:createContributions()});
  t.after(async()=>{await host.close();store.close();});
  let reads=0;
  host.register(createConversationExport(undefined,async()=>{throw Error('must not read main speaker');},undefined,(thread,project)=>{
    assert.equal(thread,id);assert.equal(project,'scope');reads++;
    return {title:'合成 [独立] 对话',messages:Array.from({length:125},(_,i)=>({
      id:String(i),conversationId:'web:'+id,projectId:'scope',role:i%2?'assistant':'user',
      text:'正文编号 '+i,createdAt:'2026-11-17T02:04:00Z',
    }))};
  }));
  await host.start();
  const input={webThreadId:id,projectId:'scope',includeWork:false};
  for(const mixed of [{native:{}},{botId:'bot'},{threadId:'00'},{webThreadId:'web:'+id},{projectId:123}] as JsonObject[])
    await assert.rejects(host.invocations.use('conversation-export.markdown',{...input,...mixed}),{status:400});
  assert.equal(reads,0);
  const doc=await host.invocations.use('conversation-export.markdown',input) as {markdown:string;count:number;filename:string};
  assert.equal(reads,1);assert.equal(doc.count,125);
  assert.match(doc.markdown,/正文编号 124/);assert.match(doc.markdown,/## 助手 ·/);
  assert.ok(doc.markdown.startsWith(String.raw`# 合成 \[独立\] 对话`));
  assert.doesNotMatch(doc.markdown,/## 主 Agent|## 项目助手|导出时绑定/);
});
