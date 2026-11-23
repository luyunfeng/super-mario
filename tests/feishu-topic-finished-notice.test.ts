import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { topicFinishedNotice } from '../apps/server/src/feishu-topic-finished-notice.ts';
import { digest } from '../packages/core/src/eventbox.ts';
import type { EffectRecord } from '../packages/core/src/effects.ts';
import type { DurableEvent } from '../packages/plugin-sdk/src/index.ts';
import type { Message, Run, Todo } from '../packages/protocol/src/index.ts';
import type { FeishuOptions, FeishuSendContext } from '../plugins/feishu.ts';

test('Web 指定负责会话后，独立监控确认原生结果并在飞书原话题只报轮次状态', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-topic-run-notice-'));
  const token = 'test-only', machineId = 'topic-machine';
  let options!: FeishuOptions, finished = false;
  const sent: Array<{chat: string; text: string; context?: FeishuSendContext}> = [];
  const server = await startServer({ dataDir, host:'127.0.0.1', port:0, demo:true, token }, { botFactory(cfg) {
    options = cfg;
    return { async start() {}, async collect() {return [];}, async close() {}, status: () => ({connected:true}),
      async send(chat,text,context) { context?.beforeSend?.(); sent.push({chat,text,context}); context?.onSent?.('out-' + sent.length,'text'); } };
  } });
  const src = 'fixture-native-event', sessionId = 'machine-session';
  const node = startAgentNode({ dataDir:join(dataDir,'node'), url:server.url, token, machineId, name:'合成执行机',
    executors:[{ id:'codex', kind:'cli', name:'执行替身', description:'只返回合成记录', machineId, mode:'real',
      available:true, defaultCwd:dataDir, nativeResultSources:[src] }],
    handlers:{ 'executor.start': async () => ({sessionId}), 'executor.result': async () => ({
      state:finished?'completed':'running', source:src, text:finished?'仅本地的合成输出':'',
      nativeSessionId:'synthetic-thread' }) } });
  t.after(async () => { try { await node.close(); await server.close(); } finally { await rm(dataDir,{recursive:true,force:true}); } });
  const api = async <T,>(path:string, method='GET', body?:object) => {
    const r = await fetch(server.url + '/api/v1/' + path, { method, headers:{authorization:'Bearer ' + token, 'content-type':'application/json'},
      ...(body && {body:JSON.stringify(body)}) });
    assert.ok(r.ok, await r.clone().text()); return await r.json() as T;
  };
  const bot = await server.bots.create({name:'合成助手',appId:'cli_2222222222222222',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false});
  const owner = {senderId:'ou_fixture', senderType:'user' as const};
  await options.onMessage(bot.pairingCode!, { ...owner, chatType:'p2p',chatId:'oc_private',messageId:'om_pair' });
  await options.onMessage('/topics',{...owner,chatType:'group',chatId:'oc_topic',messageId:'om_enroll'});
  await options.onMessage('需核对的事项',{...owner,chatType:'group',chatId:'oc_topic',threadId:'omt_native',messageId:'om_open'});
  const todo = (await api<Todo[]>('todos')).find(row => row.title === '需核对的事项')!;
  assert.ok(todo);
  await t.waitFor(() => assert.ok(server.machines.list().some(m=>m.id === machineId && m.online)));
  const opening = server.app.store.list<Message>('messages').find(message => message.role === 'user' && message.todoId === todo.id &&
    server.app.store.get<{sourceMessageId?:string}>('message.routes',message.id)?.sourceMessageId === 'om_open');
  assert.ok(opening);
  const run = await api<Run>('runs','POST',{ sourceMessageId: opening.id, conversationId: opening.conversationId, executorId: machineId + '/codex', prompt:'仅本地的合成任务',
    executionMode:'task', todoId:todo.id, doneWhen:'合成样本核对完毕', expectMinutes:1, cwd:dataDir });
  assert.equal(run.sourceMessageId, opening.id); assert.equal(run.conversationId, opening.conversationId);
  const {store} = server.app, mid = 'run-result:' + run.id;
  const notice = () => topicFinishedNotice(store,run.id,mid);
  await t.waitFor(() => assert.equal(store.get<Run>('runs',run.id)?.sessionId,sessionId));
  const bound = await api<Todo>('todos/' + todo.id,'PATCH',{responsibleRunId:run.id});
  assert.equal(bound.responsibleSession?.sessionId,sessionId);
  await server.app.monitor.poll(); assert.equal(notice(),undefined);
  const observed: unknown[] = [];
  const off = server.app.events.subscribe(event => { if (event.type === 'runs.result') observed.push(notice()); });
  finished = true; await server.app.monitor.poll(); await off();
  assert.deepEqual(observed,[{todoId:todo.id,eventId:mid}]);
  await t.waitFor(() => assert.ok(sent.some(row => row.text === '负责会话已结束一轮执行。')), {timeout:7000});
  const posted = sent.filter(row=>row.text === '负责会话已结束一轮执行。');
  assert.equal(posted.length,1); assert.equal(posted[0].chat,'oc_topic'); assert.equal(posted[0].context?.replyTo,'om_open');
  assert.equal(posted[0].context?.threadId,'omt_native');
  assert.equal(sent.some(row=>row.text.includes('仅本地的合成')),false);
  assert.equal(store.get<Todo>('todos',todo.id)?.completedAt,undefined);

  const terminal = store.get<Run>('runs',run.id)!, evidence = store.get<Message>('messages',mid)!;
  assert.equal(evidence.replyTo, opening.id);
  assert.ok(evidence.text.includes('仅本地的合成输出'));
  const startKey = 'run:' + run.id + ':start', start = store.get<EffectRecord>('effects',startKey)!;
  const eventKey = digest(['core','run:' + run.id + ':finished']), event = store.get<DurableEvent>('eventbox.events',eventKey)!;
  const cases: Array<[string,string,unknown]> = [
    ['runs',run.id,{...terminal,status:'unknown'}], ['runs',run.id,{...terminal,resultSource:'screen',nativeResultSources:['screen']}],
    ['runs',run.id,{...terminal,resultSource:'real',nativeResultSources:['real']}], ['runs',run.id,{...terminal,nativeResultSources:undefined}],
    ['runs',run.id,{...terminal,executionMode:'interactive'}], ['runs',run.id,{...terminal,projectId:'elsewhere'}],
    ['runs',run.id,{...terminal,nativeResume:{executorId:'codex',nativeSessionId:'other'}}],
    ['messages',mid,{...evidence,origin:'notification'}], ['messages',mid,{...evidence,todoId:'other'}],
    ['eventbox.events',eventKey,{...event, source:'plugin'}], ['effects',startKey,{...start,status:'unknown'}],
    ['effects',startKey,{...start,result:{pending:true,sessionId:'other'}}],
    ['todos',todo.id,{...bound,completedAt:new Date().toISOString()}], ['todos',todo.id,{...bound,responsibleSession:undefined}],
    ['todos','ambiguous',{...bound,id:'ambiguous'}], ['runs','new',{...terminal,id:'new'}],
  ];
  for (const [collection, key, value] of cases) {
    const original = store.get(collection,key); store.put(collection,key,value);
    assert.equal(notice(),undefined,collection + ' ' + key);
    if (original === undefined) store.remove(collection,key); else store.put(collection,key,original);
  }
  assert.equal(topicFinishedNotice(store,run.id,'unrelated'),undefined);
  store.put('todos',todo.id,{...bound,groupTask:true}); assert.ok(notice());
  store.put('runs',run.id,{...terminal,todoId:undefined}); store.put('messages',mid,{...evidence,todoId:undefined});
  assert.ok(notice(), 'Web 可把同范围、未标记待办的运行登记为唯一负责会话');
});
