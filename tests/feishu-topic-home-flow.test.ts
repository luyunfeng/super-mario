import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';
import { createFeishuIntegration, type FeishuOptions, type FeishuMessageSource } from '../plugins/feishu.ts';
import type { Todo } from '../packages/protocol/src/index.ts';

test('外群 @/ai 在已登记主群开题并续答，主群可取消原群回报，读取话题失败保留待办', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sm-topic-home-'));
  const config = { dataDir, demo: true, host: '127.0.0.1', port: 0, token: 'synthetic' };
  const wall = Date.now;
  let offset = 0;
  t.mock.method(Date, 'now', () => wall() + offset);
  let receiver!: FeishuOptions, missingThread = false;
  const sent: Array<{ id:string; chat:string; replyTo?:string; thread:boolean; text:string }> = [];
  const reads: string[] = [];
  let waitForThread: Promise<void> | undefined;
  const threads = new Map<string,string>();
  const chats = new Map<string,string>();
  const factory = (options: FeishuOptions) => {
    receiver = options;
    return createFeishuIntegration({ ...options,
      fetch: async (input, init) => {
        const url = new URL(String(input)), path = url.pathname;
        if (path.endsWith('/tenant_access_token/internal')) return Response.json({code:0,tenant_access_token:'fixture',expire:3600});
        if (path.endsWith('/bot/v3/info')) return Response.json({code:0,bot:{open_id:'ou_bot'}});
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture');
        if (init?.method === 'GET') {
          const id = path.split('/').at(-1)!;
          assert.equal(path, '/open-apis/im/v1/messages/' + id);
          assert.equal(chats.get(id), 'oc_home'); reads.push(id);
          if (waitForThread) await waitForThread;
          return Response.json({code:0,data:{items:[{message_id:id,chat_id:'oc_home',...(missingThread ? {} : {thread_id:threads.get(id)})}]}});
        }
        assert.ok(path.startsWith('/open-apis/im/v1/messages'));
        const body = JSON.parse(String(init?.body));
        const replyTo = path.match(/\/messages\/([^/]+)\/reply$/)?.[1];
        const chat = replyTo ? chats.get(replyTo) : body.receive_id;
        assert.ok(chat, '每条回复都必须发回原消息所在群');
        const id = 'om_sent_' + sent.length;
        sent.push({id, chat, replyTo, thread:!!body.reply_in_thread, text:body.content});
        chats.set(id,chat);
        if (!replyTo && chat === 'oc_home') threads.set(id, 'omt_home_' + id);
        return Response.json({code:0,data:{message_id:id}});
      },
      wsFactory: opts => ({async start() {opts.onReady?.();}, close() {},
        getConnectionStatus: () => ({state:'connected',reconnectAttempts:0})}),
    });
  };
  let host = await startServer(config, {botFactory:factory});
  t.after(async () => {try {await host.close();} finally {await rm(dataDir,{recursive:true,force:true});}});
  const bot = await host.bots.create({name:'合成群任务', appId:'cli_5555555555555555',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false});
  const emit = (id:string, chatId:string, text:string, extra:Partial<FeishuMessageSource> = {}) => {
    chats.set(id,chatId);
    return receiver.onMessage(text, {messageId:id,chatId,chatType:'group',senderType:'user',senderId:'ou_owner', ...extra});
  };
  const api = async (path:string, body?:object) => {
    const res = await fetch(host.url + '/api/v1/' + path,{method:body ? 'PATCH':'GET',
      headers:{authorization:'Bearer synthetic','content-type':'application/json'},...(body && {body:JSON.stringify(body)})});
    assert.equal(res.status, 200); return res.json();
  };
  await emit('om_pair','oc_private',bot.pairingCode!,{chatType:'p2p'});
  await emit('om_enroll','oc_home','／话题群 主群');
  const privateCount = sent.filter(row => row.chat === 'oc_private').length;
  const baseline = new Set((await api('todos') as Todo[]).map(row => row.id));
  const todos = async () => (await api('todos') as Todo[]).filter(row => !baseline.has(row.id));
  await emit('om_external','oc_source','/ai 核对合成主群任务',{mentionedSelf:true});
  const [task] = await todos();
  assert.equal(task.title,'核对合成主群任务');
  const roots = () => sent.filter(row => row.chat === 'oc_home' && !row.replyTo);
  assert.equal(roots().length,1);
  const root = roots()[0];
  assert.match(root.text,/核对合成主群任务/);
  assert.deepEqual(reads,[root.id]);
  await t.waitFor(() => assert.ok(sent.some(row => row.replyTo === root.id && row.thread)));
  await emit('om_follow','oc_home','合成讨论结论乙',{threadId:threads.get(root.id),rootId:root.id,parentId:root.id});
  await t.waitFor(() => assert.ok(sent.some(row => row.replyTo === 'om_follow' && row.thread)));
  assert.deepEqual((await todos()).map(row => row.id),[task.id]);
  const decision = await fetch(host.url + '/api/v1/todos/' + task.id + '/decisions', {
    method: 'POST', headers: {authorization: 'Bearer synthetic', 'content-type': 'application/json'},
    body: JSON.stringify({text: '合成的私有决定正文', expectedProjectId: null}),
  });
  assert.ok(decision.ok);
  await t.waitFor(() => assert.ok(sent.some(row => row.chat === 'oc_home' && row.replyTo === root.id && row.thread
    && row.text.includes('待办新增 1 项决定'))), { timeout: 8000 });
  assert.ok(sent.every(row => !row.text.includes('合成的私有决定正文')));
  await api('todos/' + task.id,{completed:true});
  const preview = await t.waitFor(() => {
    const row = sent.find(row => row.replyTo === root.id && row.text.includes('/noreply'));
    assert.ok(row && row.thread && row.chat === 'oc_home'); return row;
  });
  await emit('om_veto','oc_home','/noreply',{threadId:threads.get(root.id),rootId:root.id,parentId:preview.id});
  assert.ok(sent.some(row => row.replyTo === 'om_veto' && row.thread && row.text.includes('取消')));
  offset = 11 * 60000;
  await host.close();
  host = await startServer(config,{botFactory:factory});
  await t.waitFor(() => assert.ok(receiver.topicPolicy?.('oc_home')));
  async function newHandoff(sourceId:string, title:string) {
    const count = roots().length;
    await emit(sourceId, 'oc_source', '/ai ' + title, {mentionedSelf:true});
    const todo = (await todos()).find(row => row.title === title);
    assert.ok(todo);
    const opening = roots()[count];
    assert.ok(opening && opening.text.includes(title));
    assert.equal(reads.at(-1), opening.id);
    await t.waitFor(() => assert.ok(sent.some(row => row.replyTo === opening.id && row.thread)));
    return {todo,opening};
  }
  const plain = (raw:string) => JSON.parse(raw).text as string | undefined;
  const completions = (openingId:string) => sent.filter(row => row.chat === 'oc_home' && row.thread
    && row.replyTo === openingId && plain(row.text) === '这项待办已完成。');
  const previewCount = (openingId:string) => sent.filter(row => row.replyTo === openingId && plain(row.text)?.includes('分钟后回复原群消息')).length;
  const published = (sourceId:string) => sent.filter(row => row.chat === 'oc_source' && row.replyTo === sourceId);
  const early = await newHandoff('om_early', '提前取消回报');
  await emit('om_early_veto','oc_home','/noreply',{threadId:threads.get(early.opening.id),rootId:early.opening.id,parentId:early.opening.id});
  assert.ok(sent.some(row => row.replyTo === 'om_early_veto' && row.thread && plain(row.text)?.includes('已取消')));
  await api('todos/' + early.todo.id,{completed:true});
  await t.waitFor(() => assert.equal(completions(early.opening.id).length,1));
  await api('feishu/bots/' + bot.id, {groupTaskReportDelayMinutes:0});
  const instant = await newHandoff('om_instant', '即时回报有公开结论');
  await api('todos/' + instant.todo.id,{expectedGroupTaskOutcome:'',groupTaskOutcome:'合成公开验收结论。',completed:true});
  await t.waitFor(() => {
    assert.equal(completions(instant.opening.id).length,1);
    assert.deepEqual(published('om_instant').map(row => plain(row.text)),['合成公开验收结论。']);
  });
  // The Web can mark a task complete while the platform is still resolving the home topic ID.
  let release!: () => void;
  waitForThread = new Promise<void>(resolve => { release = resolve; });
  const racingTitle = '核实话题时提前完成';
  const handoff = emit('om_race','oc_source','/ai ' + racingTitle,{mentionedSelf:true});
  let raceRoot: string;
  try {
    const opening = await t.waitFor(() => {
      const row = roots().find(row => row.text.includes(racingTitle));
      assert.ok(row && reads.includes(row.id));
      return row;
    });
    raceRoot = opening.id;
    const todo = (await todos()).find(todo => todo.title === racingTitle);
    assert.ok(todo);
    const completed: Todo = await api('todos/' + todo.id,{completed:true});
    assert.ok(completed.completedAt);
    assert.equal(completions(raceRoot).length,0);
    assert.equal(published('om_race').length,0);
  } finally {
    release();
    waitForThread = undefined;
    await handoff;
  }
  await t.waitFor(() => {
    assert.equal(completions(raceRoot).length,1);
    assert.deepEqual(published('om_race').map(row => plain(row.text)),['这项待办已完成。']);
  });
  offset += 11 * 60000;
  await host.close();
  host = await startServer(config,{botFactory:factory});
  await t.waitFor(() => assert.ok(receiver.topicPolicy?.('oc_home')));
  assert.equal(completions(early.opening.id).length,1);
  assert.equal(completions(instant.opening.id).length,1);
  assert.equal(completions(root.id).length,0);
  assert.equal(previewCount(root.id),1);
  assert.equal(previewCount(early.opening.id),0);
  assert.equal(previewCount(instant.opening.id),0);
  assert.equal(published('om_early').length,0);
  assert.equal(published('om_instant').length,1);
  assert.equal(completions(raceRoot).length,1);
  assert.equal(published('om_race').length,1);
  missingThread = true;
  await assert.rejects(emit('om_missing','oc_source','/ai 无话题编号的任务',{mentionedSelf:true}),/话题/);
  assert.equal(roots().length,5);
  assert.equal(reads.at(-1),roots()[4].id);
  assert.equal((await todos()).length,5);
  assert.ok(sent.some(row => row.replyTo === 'om_missing' && row.text.includes('无法确认主群话题')));
  assert.equal(sent.filter(row => row.chat === 'oc_private').length,privateCount);
  assert.equal(sent.some(row => row.replyTo === 'om_external'),false);
});
