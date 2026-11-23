import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import { createFeishuIntegration } from '../plugins/feishu.ts';
import type { Todo } from '../packages/protocol/src/index.ts';

test('主人登记话题群后在原话题开待办、记决定并收到答复；严格点名与更换配对即时隔离', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-topic-flow-'));
  const model: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const realFetch = fetch;
  let pauseReply: Promise<void> | undefined;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    assert.equal(url.hostname, '127.0.0.1');
    if (url.port !== '1') return realFetch(request);
    assert.equal(url.pathname, '/offline/chat/completions');
    model.push(await request.json());
    await pauseReply;
    const frames = [{ role: 'assistant', content: '原话题合成答复-' + model.length }, {}].map((delta, i) =>
      'data: ' + JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: i ? 'stop' : null }] }));
    return new Response([...frames, 'data: [DONE]', ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  });
  let dispatcher!: EventDispatcher;
  const sent: Array<{ path: string; body: string; inThread?: boolean; target?: string }> = [];
  const botFactory: FeishuBotFactory = options => createFeishuIntegration({ ...options,
    fetch: async (input, init) => {
      const { pathname } = new URL(String(input));
      if (pathname.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
      if (pathname.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: 'ou_bot' } });
      if (pathname.endsWith('/reactions')) return Response.json({ code: 0, data: { reaction_id: 'fixture' } });
      const body = JSON.parse(String(init?.body ?? '{}'));
      sent.push({ path: pathname, body: body.content ?? '', target: body.receive_id, inThread: body.reply_in_thread });
      return Response.json({ code: 0, data: { message_id: 'om_out_' + sent.length } });
    },
    wsFactory: options => ({ async start(input) { dispatcher = input.eventDispatcher; options.onReady?.(); }, close() {},
      getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }) }),
  });
  const host = await startServer({ dataDir: dir, host: '127.0.0.1', port: 0, token: 'fixture', demo: false,
    model: { provider: 'openai-compatible', model: 'fixture', apiKey: 'offline', baseUrl: 'http://127.0.0.1:1/offline' } }, { botFactory });
  t.after(async () => { try { await host.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  const bot = await host.bots.create({ name: '合成话题助手', appId: 'cli_8888888888888888', appSecret: 'fixture',
    scope: { kind: 'global' }, requireConfirmation: false });
  let seq = 0;
  async function event(id: string, words: string, opts: { private?: boolean; mention?: boolean; sender?: string; thread?: string; root?: string } = {}) {
    await dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: 'event-' + ++seq }, event: {
      sender: { sender_type: 'user', sender_id: { open_id: opts.sender ?? 'ou_owner' } },
      message: { message_id: id, chat_id: opts.private ? 'oc_owner' : 'oc_group', chat_type: opts.private ? 'p2p' : 'group',
        message_type: 'text', root_id: opts.root, parent_id: opts.root, thread_id: opts.thread,
        content: JSON.stringify({ text: (opts.mention ? '@_user_1 ' : '') + words }),
        mentions: opts.mention ? [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '合成话题助手' }] : [] },
    } }, { needCheck: false });
  }
  async function api<T>(path: string, body?: unknown, method = body ? 'PUT' : 'GET') {
    const reply = await fetch(host.url + '/api/v1/' + path, { method,
      headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(reply.status, 200);
    return reply.json() as Promise<T>;
  }
  const registryPath = 'feishu/bots/' + bot.id + '/topic-chats';
  type Registry = { binding: string; version: number; items: Array<{ chatId: string; home: boolean; requireOwnerMention: boolean }> };
  const registry = () => api<Registry>(registryPath);
  const allTodos = () => api<Todo[]>('todos');
  const firstIds = new Set((await allTodos()).map(row => row.id));
  const todos = async () => (await allTodos()).filter(todo => !firstIds.has(todo.id));
  const decisions = async (id: string) => (await api<{ decisions: Array<{text:string; active:boolean}> }>('todos/' + id + '/decisions')).decisions;
  const pair = async (id: string, code: string) => {
    await event(id, code, { private: true });
    await t.waitFor(() => assert.ok(host.bots.list().find(row => row.id === bot.id)?.paired));
  };
  async function answer(id: string, index: number) {
    await t.waitFor(() => assert.ok(sent.some(send => send.path.endsWith('/' + id + '/reply')
      && send.inThread && send.body.includes('原话题合成答复-' + index))), { timeout: 8000 });
  }
  await pair('om_pair', bot.pairingCode!);
  await event('om_enroll', '/topics', { mention: true });
  const old = await t.waitFor(async () => { const result = await registry(); assert.equal(result.items.length, 1); return result; });
  assert.equal(old.items[0].chatId, 'oc_group');
  const thread = 'omt_conversation', root = 'om_root', threadReply = { thread, root };
  await event('om_other', '其他群成员的合成材料', { thread, sender: 'ou_OTHER' });
  await event(root, '整理本周合成需求', { thread });
  await answer(root, 1);
  const [todo] = await todos();
  assert.equal((await todos()).length, 1);
  assert.equal(todo.notes, '整理本周合成需求');
  const brief = async (id: string) => (await api<{origin:{kind:string;requestText?:string;sourceMessageId?:string}}>('todos/' + id + '/brief')).origin;
  const audienceOf = (id: string) => host.app.store.get<{conversationId:string}>('todo.brief-origins',id)!.conversationId;
  assert.match(audienceOf(todo.id),/^feishu-group:[a-f0-9]{64}$/);
  const opening = await brief(todo.id);
  assert.deepEqual([opening.kind,opening.sourceMessageId,opening.requestText],['feishu',root,'整理本周合成需求']);
  const decision = '优先处理合成方案乙';
  await event('om_follow', decision, threadReply);
  await answer('om_follow', 2);
  await event('om_follow', '被修改的重放', threadReply);
  const initial = await registry();
  await api(registryPath, { binding: initial.binding, version: initial.version,
    items: initial.items.map(row => ({ ...row, requireOwnerMention: true })) });
  await event('om_unaddressed', '没有点名的合成跟进', threadReply);
  await event('om_strict_other', '冒充主人的合成跟进', { ...threadReply, sender: 'ou_OTHER', mention: true });
  await event('om_strict_owner', '确认严格模式可跟进', { ...threadReply, mention: true });
  await answer('om_strict_owner', 3);
  assert.equal((await todos()).length, 1);
  assert.equal(model.length, 3);
  const history = JSON.stringify(model);
  const systemTexts = model.map(req => JSON.stringify(req.messages.filter(m => ['system', 'developer'].includes(m.role))));
  assert.ok(systemTexts.every(text => text.includes(todo.id) && text.includes('对群内成员可见') && text.includes('只引用本话题的材料')));
  assert.ok(systemTexts[1].includes('已记为该待办的决定'));
  assert.ok(history.includes(decision));
  assert.doesNotMatch(history, /被修改的重放|没有点名的合成跟进|冒充主人的合成跟进|其他群成员的合成材料/);
  assert.ok(!sent.some(row => row.target && row.body.includes('原话题合成答复')));
  const visible = await decisions(todo.id);
  assert.equal(visible.filter(row => row.active && row.text === decision).length, 1);
  assert.ok(visible.some(row => row.text.includes('确认严格模式可跟进')));
  const project = host.app.projects.create({ name: '仅项目可见的合成名称' });
  const move = (id: string) => api<Todo>('todos/' + todo.id, { projectId: id }, 'PATCH');
  await move(project.id);
  const rejected = 'om_project_scope';
  await event(rejected, '迁入项目后不可沿用话题决定', { ...threadReply, mention: true });
  await t.waitFor(() => assert.ok(sent.some(s => s.path.endsWith('/' + rejected + '/reply') && s.body.includes('在 Web 项目中继续'))));
  const publicReply = sent.find(s => s.path.endsWith('/' + rejected + '/reply'))!;
  assert.ok(publicReply.inThread);
  assert.ok(!publicReply.body.includes(project.name));
  assert.equal(model.length, 3);
  await move('');
  await event(rejected, '同一旧消息不可重新解释', { ...threadReply, mention: true });
  assert.equal((await decisions(todo.id)).filter(d => /迁入项目|重新解释/.test(d.text)).length, 0);
  assert.equal(sent.filter(s => s.path.endsWith('/' + rejected + '/reply')).length, 1);
  const updated = await host.bots.update(bot.id, { appId: 'cli_7777777777777777', appSecret: 'other-fixture' });
  await pair('om_new_pair', updated.pairingCode!);
  assert.deepEqual((await registry()).items, []);
  assert.notEqual((await registry()).binding, old.binding);
  await event('om_new_enroll', '/topics', { mention: true });
  await t.waitFor(async () => assert.equal((await registry()).items.length, 1));
  await event('om_old_thread_follow', '重新配对后不继承旧任务', threadReply);
  await event('om_new_task', '/ai 全新配对后另立任务', { ...threadReply, mention: true });
  await answer('om_new_task', 4);
  assert.equal((await todos()).length, 2);
  const fresh = (await todos()).find(row => row.id !== todo.id)!;
  assert.ok(fresh.notes.includes('全新配对后另立任务'));
  assert.notEqual(audienceOf(fresh.id),audienceOf(todo.id));
  const newOpening = await brief(fresh.id);
  assert.deepEqual([newOpening.kind,newOpening.sourceMessageId,newOpening.requestText],['feishu','om_new_task','全新配对后另立任务']);
  assert.ok(!JSON.stringify(model.at(-1)).includes(decision));
  assert.ok(!(await decisions(todo.id)).some(row => row.text.includes('重新配对后')));
  await event('om_second_root', '其他话题独有的合成任务', { thread: 'omt_second' });
  await answer('om_second_root', 5);
  assert.ok(!JSON.stringify(model.at(-1)).includes('全新配对后另立任务'));
  await event('om_resume_first', '回到首个话题继续核对', threadReply);
  await answer('om_resume_first', 6);
  const resumed = JSON.stringify(model.at(-1));
  assert.ok(resumed.includes('全新配对后另立任务'));
  assert.ok(!resumed.includes('其他话题独有的合成任务'));

  let release!: () => void;
  pauseReply = new Promise<void>(resolve => { release = resolve; });
  const late = event('om_late', '在途合成答复', threadReply);
  try {
    await t.waitFor(() => assert.equal(model.length, 7));
    await api('todos/' + fresh.id, { projectId: project.id }, 'PATCH');
  } finally { pauseReply = undefined; release(); }
  await late;
  await event('om_second_follow', '等待另一个话题回复', { thread: 'omt_second', root: 'om_second_root' });
  await answer('om_second_follow', 8);
  assert.ok(!sent.some(s => s.path.endsWith('/om_late/reply') && s.body.includes('原话题合成答复-7')));

});
