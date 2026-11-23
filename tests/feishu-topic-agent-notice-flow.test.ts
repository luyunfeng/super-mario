import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import type { Message, Run, Todo } from '../packages/protocol/src/index.ts';
import type { FeishuOptions, FeishuSendContext } from '../plugins/feishu.ts';

test('负责执行会话的主人交互只在原话题提醒，卡片私有详情、已处理及未绑定请求不公开', {timeout:40000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-topic-agent-notice-'));
  const token = 'synthetic', machineId = 'fixture-machine';
  let receiver!: FeishuOptions;
  const sent: Array<{chat:string;text:string;context?:FeishuSendContext}> = [];
  const server = await startServer({dataDir:dir,token,demo:true,host:'127.0.0.1',port:0}, {
    botFactory(options) {
      receiver = options;
      return {async start() {}, async close() {}, async collect() {return [];}, status:() => ({connected:true}),
        async send(chat,text,context) {
          context?.beforeSend?.(); context?.groupReadReply?.(); sent.push({chat,text,context});
          context?.onSent?.('om_platform_' + sent.length, 'text');
        }};
    },
  });
  let starts = 0;
  const machine = startAgentNode({url:server.url,token,dataDir:join(dir,'node'),name:'本地协议替身',machineId,
    executors:[{id:'codex',name:'合成执行器',kind:'cli',machineId,mode:'real',available:true,description:'',defaultCwd:dir}],
    handlers:{'executor.start':async()=>({sessionId:'synthetic-session-' + ++starts}),
      'executor.input':async()=>({requested:true})}});
  t.after(async()=>{try {await machine.close(); await server.close();} finally {await rm(dir,{recursive:true,force:true});}});
  async function api<T>(path:string,method='GET',body?:object) {
    const res = await fetch(server.url + '/api/v1/' + path,{method,headers:{authorization:'Bearer ' + token,'content-type':'application/json'},
      ...(body && {body:JSON.stringify(body)})});
    if (!res.ok) throw Error(path + ' HTTP ' + res.status + ' ' + await res.text());
    return res.json() as Promise<T>;
  }
  const bot = await server.bots.create({name:'合成助理',appId:'cli_5555555555555555',appSecret:'fixture',scope:{kind:'global'}});
  const owner = {senderType:'user',senderId:'ou_synthetic'} as const;
  await receiver.onMessage(bot.pairingCode!,{...owner,chatType:'p2p',chatId:'oc_private',messageId:'om_pair'});
  async function openTask(key:string) {
    const chat = 'oc_' + key, thread = 'omt_' + key, root = 'om_root_' + key, title = '合成话题-' + key;
    await receiver.onMessage('/topics',{...owner,chatType:'group',chatId:chat,messageId:'om_enable_' + key});
    await receiver.onMessage(title,{...owner,chatType:'group',chatId:chat,threadId:thread,messageId:root});
    await t.waitFor(() => assert.ok(sent.some(m => m.context?.replyTo === root && m.text.includes(title))),{timeout:8000});
    const todo = (await api<Todo[]>('todos')).find(t => t.title === title)!;
    const source = server.app.store.list<Message>('messages').find(m => m.todoId === todo.id && m.text === title && m.role === 'user');
    assert.ok(source); return {todo,source,chat,thread,root};
  }
  await t.waitFor(() => assert.ok(server.machines.list().some(m => m.id === machineId && m.online)));
  const web = await openTask('web'), channel = await openTask('channel'), suppressed = await openTask('suppressed');
  async function launch(todo?:Todo,source?:Message) {
    const run = await api<Run>('runs','POST',{executorId:machineId + '/codex',prompt:'合成执行任务',executionMode:'interactive',
      todoId:todo?.id,cwd:dir,...(source && {sourceMessageId:source.id,conversationId:source.conversationId})});
    await t.waitFor(async() => assert.ok((await api<{runs:Run[]}>('state')).runs.some(row => row.id === run.id && row.status === 'running' && row.sessionId)));
    return run;
  }
  const bind = (todo:Todo,run:Run) => api<Todo>('todos/' + todo.id,'PATCH',{responsibleRunId:run.id});
  const webRun = await launch(), channelRun = await launch(channel.todo,channel.source), clearedRun = await launch(suppressed.todo);
  const unrelated = await launch(suppressed.todo);
  await bind(web.todo,webRun); await bind(channel.todo,channelRun); await bind(suppressed.todo,clearedRun);
  const secretTitle = '私有标题验收标记', privateCommand = '合成命令标记 /private/synthetic-script.sh';
  const cardInput = (run:Run,name:string) => ({kind:'permission' as const,title:secretTitle + name,body:privateCommand + name,runId:run.id});
  const at = sent.length;
  const foreign = await api<Card>('interactions','POST',cardInput(unrelated,'未绑定'));
  assert.equal(foreign.handler,'user');
  // Withdraw in the opening turn, before any deferred "needs the owner" check can run.
  const withdrawn = server.app.interactions.open(cardInput(clearedRun,'已撤回'));
  assert.equal(server.app.interactions.withdraw(withdrawn.id,withdrawn.version).status,'withdrawn');
  const [w,c] = await Promise.all([api<Card>('interactions','POST',cardInput(webRun,'甲')),
    api<Card>('interactions','POST',cardInput(channelRun,'乙'))]);
  const groupMessages = () => sent.slice(at).filter(m => m.chat !== 'oc_private');
  await t.waitFor(() => {
    assert.ok(groupMessages().some(r => r.context?.replyTo === web.root));
    assert.ok(groupMessages().some(r => r.context?.replyTo === channel.root));
  },{timeout:9000});
  assert.deepEqual(groupMessages().map(r => [r.chat,r.context?.threadId,r.context?.replyTo]).sort(),
    [[web.chat,web.thread,web.root],[channel.chat,channel.thread,channel.root]].sort());
  const publicText = groupMessages()[0].text;
  assert.equal(publicText,'负责会话需要主人处理，请到 Web「等你处理」查看。');
  assert.ok(groupMessages().every(m => m.text === publicText));
  const payloads = JSON.stringify(groupMessages());
  for (const secret of [secretTitle,privateCommand,dir,webRun.id,channelRun.id,w.id,c.id]) assert.ok(!payloads.includes(secret));
  const rows = await api<{id:string;todoId?:string;route?:{href:string;label:string}}[]>('attention');
  for (const [card,todo] of [[w,web.todo],[c,channel.todo]] as const) {
    const row = rows.find(row => row.id === 'interaction:' + card.id);
    assert.equal(row?.todoId,todo.id);
    assert.deepEqual(row?.route,{href:'#projects/all/todos/detail/' + todo.id,label:'查看待办：' + todo.title});
  }
  const cards = await api<Card[]>('interactions');
  for (const expected of [w,c]) {
    const stored = cards.find(r => r.id === expected.id);
    assert.ok(stored && stored.handler === 'user' && stored.status === 'open');
    assert.equal(stored.title,expected.title); assert.equal(stored.body,expected.body);
  }
  // Releases before batched notices could leave a private full-text reply in the ordinary outbox.
  const legacyKey = 'feishu-reply:' + JSON.stringify([bot.id, bot.appId, channel.source.id, 'interaction-notice:' + c.id]);
  const {store, mailboxes} = server.app;
  const entry = mailboxes.put({ botId: bot.id, scope: bot.scope, direction: 'outbox', eventKey: legacyKey,
    title: '旧版提醒', text: privateCommand, target: channel.chat, replyTo: channel.source.id, requiresConfirmation: false });
  const opening = store.get<{envelopeId:string}>('message.routes', channel.source.id)!;
  store.put('feishu.bot.envelopes', entry.id, store.get('feishu.bot.envelopes', opening.envelopeId));
  await assert.rejects(server.bots.send(bot.id, channel.chat, privateCommand, legacyKey), /执行详情请在 Web 中查看/);
  assert.ok(sent.every(m => !m.text.includes(privateCommand)));
});
