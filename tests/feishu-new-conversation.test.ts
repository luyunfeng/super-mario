import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { Message, ModelConfig } from '../packages/protocol/src/index.ts';
import type { FeishuMessageSource, FeishuOptions, FeishuSendContext } from '../plugins/feishu.ts';

async function fixture(t: test.TestContext, model?: ModelConfig, demo = !model) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-feishu-new-'));
  const receivers = new Map<string, FeishuOptions>();
  const sent: Array<{ appId: string; text: string; context?: FeishuSendContext; id: string }> = [];
  const factory: FeishuBotFactory = options => {
    receivers.set(options.appId, options);
    return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
      async send(_chat, text, context) {
        const id = 'platform-' + sent.length;
        sent.push({ appId: options.appId, id, text, context });
        context?.onSent?.(id, context.card ? 'interactive' : 'text');
      } };
  };
  const config = { dataDir, port: 0, host: '127.0.0.1', demo, model, token: 'synthetic-thread-test' };
  let server = await startServer(config, { botFactory: factory });
  t.after(async () => { try { await server.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  async function bot(appId: string, owner: string) {
    const row = await server.bots.create({ appId, appSecret: 'fixture-only', name: '合成机器人-' + owner,
      scope: { kind: 'global' }, requireConfirmation: false });
    const source = { chatType: 'p2p', senderType: 'user', senderId: owner, chatId: 'private-' + owner } as const;
    const receive = (text: string, messageId: string, extra?: Partial<FeishuMessageSource>) =>
      receivers.get(appId)!.onMessage(text, { ...source, messageId, ...extra });
    return { row, receive, pair: () => receive(row.pairingCode!, 'pair'),
      click: (messageId: string, value: Record<string, unknown>) => receivers.get(appId)!.onCardAction!({
        operatorId: owner, chatId: source.chatId, messageId, value,
      }) };
  }
  function users() { return server.app.store.list<Message>('messages').filter(row => row.role === 'user'); }
  async function input(text: string) {
    return t.waitFor(() => {
      const rows = users().filter(row => row.text === text);
      assert.equal(rows.length, 1);
      const reply = server.app.store.list<Message>('messages').find(m => m.replyTo === rows[0].id && m.role === 'assistant');
      assert.equal(rows[0].status, 'done', reply?.text);
      return rows[0];
    }, { timeout: 10000 });
  }
  function threads(botId: string, threadId?: string) {
    return fetch(server.url + '/api/v1/feishu/bots/' + botId + '/threads' + (threadId ? '/' + threadId : ''),
      { headers: { authorization: 'Bearer synthetic-thread-test' } });
  }
  async function currentModel(botId: string, threadId?: string) {
    const path = '/api/v1/feishu/bots/' + botId + (threadId ? '/threads/' + threadId : '') + '/model/catalog';
    const response = await fetch(server.url + path, { headers: { authorization: 'Bearer synthetic-thread-test' } });
    assert.equal(response.status, 200);
    return (await response.json()).current as string;
  }
  return { bot, sent, users, input, threads, currentModel, get url() { return server.url; }, get store() { return server.app.store; }, async restart() { await server.close(); server = await startServer(config, { botFactory: factory }); } };
}

test('主人裸 /new 延迟开会话，带正文的命令原样保留段落，重放与旧引用不会改错会话', async t => {
  const f = await fixture(t), a = await f.bot('cli_1111111111111111', 'alpha');
  await a.receive('/new 尚未配对', 'unpaired');
  await a.pair();
  await a.receive('/new 冒充', 'wrong-owner', { senderId: 'other' });
  await a.receive('/new 群消息', 'group', { chatType: 'group' });
  assert.equal(f.users().length, 0);

  await a.receive('固定主会话起点', 'main-origin');
  const main = await f.input('固定主会话起点');
  const before = f.sent.length;
  await Promise.all([a.receive('/new', 'bare'), a.receive('/new', 'bare')]);
  assert.equal(f.users().length, 1);
  assert.equal(f.sent.slice(before).filter(item => /下一条消息/.test(item.text)).length, 1);
  await a.receive('新会话甲的首条', 'first');
  const first = await f.input('新会话甲的首条');
  assert.notEqual(first.conversationId, main.conversationId);
  await a.receive('继续会话甲', 'follow');
  assert.equal((await f.input('继续会话甲')).conversationId, first.conversationId);

  const text = '乙的首条要求\n\n  第二段保留缩进';
  const newWithQuote = () => a.receive('／NEW　' + text, 'new-with-quote', { parentId: 'main-origin' });
  await Promise.all([newWithQuote(), newWithQuote()]);
  const second = await f.input(text);
  assert.notEqual(second.conversationId, first.conversationId);
  assert.notEqual(second.conversationId, main.conversationId);
  await a.receive('转回主会话前的乙', 'following-new');
  assert.equal((await f.input('转回主会话前的乙')).conversationId, second.conversationId);
  await a.receive('/main', 'back-main');
  await a.receive('回到固定主会话', 'main-again');
  assert.equal((await f.input('回到固定主会话')).conversationId, main.conversationId);

  await f.restart();
  await newWithQuote();
  await a.receive('重启后主会话仍选中', 'default-after-restart');
  assert.equal((await f.input('重启后主会话仍选中')).conversationId, main.conversationId);
  await a.receive('引用甲的旧输入', 'quote-first', { parentId: 'first' });
  assert.equal((await f.input('引用甲的旧输入')).conversationId, first.conversationId);
  await a.receive('引用乙的起点', 'quote-second', { rootId: 'new-with-quote' });
  assert.equal((await f.input('引用乙的起点')).conversationId, second.conversationId);
  await a.receive('//new', 'literal');
  assert.equal((await f.input('/new')).conversationId, main.conversationId);
});

test('连续输入跟随新会话，状态与清单只展示本主人的会话，清单按钮可重新选中', async t => {
  const f = await fixture(t), a = await f.bot('cli_2222222222222222', 'alpha'), b = await f.bot('cli_3333333333333333', 'beta');
  await a.pair(); await b.pair();
  await Promise.all([a.receive('/新对话 会话甲的目标', 'new-a'), a.receive('紧接命令的输入', 'during-new')]);
  const alpha = await f.input('会话甲的目标');
  assert.equal((await f.input('紧接命令的输入')).conversationId, alpha.conversationId);
  await b.receive('/new 乙机器人的私聊目标', 'new-a');
  const beta = await f.input('乙机器人的私聊目标');
  assert.notEqual(beta.conversationId, alpha.conversationId);
  await a.receive('/status', 'status-a');
  const collection = await f.threads(a.row.id);
  assert.equal(collection.status, 200);
  const rows = await collection.json() as Array<{threadId: string; title: string}>;
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /会话甲的目标/);
  const detail = await f.threads(a.row.id, rows[0].threadId);
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json()).messages.filter((message: Message) => message.role === 'user')
    .map((message: Message) => message.text), ['会话甲的目标', '紧接命令的输入']);
  assert.equal((await f.threads(b.row.id, rows[0].threadId)).status, 404);
  const status = f.sent.findLast(item => item.appId === a.row.appId && item.context?.card && item.text.includes('最近消息'));
  assert.ok(status && status.text.includes('紧接命令的输入'));
  assert.doesNotMatch(status.text, /乙机器人的私聊目标/);

  const oldReply = f.sent.find(item => item.appId === a.row.appId && item.text.includes('紧接命令的输入') && item.text.includes('本地演示'));
  assert.ok(oldReply);
  await a.receive('/main', 'main');
  await a.receive('引用旧助手回复仍发到甲', 'quote-assistant', { parentId: oldReply.id });
  assert.equal((await f.input('引用旧助手回复仍发到甲')).conversationId, alpha.conversationId);
  await a.receive('/list', 'list');
  const list = f.sent.findLast(item => item.appId === a.row.appId && item.text.includes('最近对话'));
  assert.ok(list && !list.text.includes('乙机器人的私聊目标'));
  const elements = list.context?.card?.elements as Array<{ actions?: Array<{ value: Record<string, unknown> }> }>;
  const buttons = elements.flatMap(el => el.actions ?? []).filter(button =>
    button.value.kind === 'workbench.chat' && button.value.conversationThreadId);
  assert.equal(buttons.length, 1);
  await a.click(list.id, buttons[0].value);
  await a.receive('从清单恢复甲', 'from-list');
  assert.equal((await f.input('从清单恢复甲')).conversationId, alpha.conversationId);
  await f.restart();
  await a.receive('重启后继续选中的甲', 'after-restart');
  assert.equal((await f.input('重启后继续选中的甲')).conversationId, alpha.conversationId);
});


test('配对主人按标题或正文搜索活动独立对话，点击结果后在原会话续聊',async t=>{
  const f=await fixture(t);
  const a=await f.bot('cli_1122334455667788','search-a'),b=await f.bot('cli_2233445566778899','search-b');
  await a.pair();await b.pair();
  const query='合成检验词';
  async function create(person:typeof a,title:string,id:string){
    await person.receive('/new '+title,id);
    return f.input(title);
  }
  await create(a,query+' 标题甲','title');
  const body=await create(a,'第二个工作记录','body');
  await a.receive('本轮正文包含'+query,'follow-body');await f.input('本轮正文包含'+query);
  await create(a,query+' 已归档','archived');
  const noMatch=await create(a,'无关会话','unmatched');
  await create(b,query+' 他人私聊','foreign');
  const active=await (await f.threads(a.row.id)).json() as {threadId:string;title:string;version:number}[];
  const find=(title:string)=>active.find(r=>r.title===title)!;
  const archived=find(query+' 已归档');
  const headers={authorization:'Bearer synthetic-thread-test','content-type':'application/json'};
  const hide=await fetch(f.url+'/api/v1/feishu/bots/'+a.row.id+'/threads/'+archived.threadId,{
    method:'PATCH',headers,body:JSON.stringify({version:archived.version,archived:true})});
  assert.equal(hide.status,200);
  // Copied text without its own authenticated private route must never make a thread searchable.
  f.store.put('messages','unverified-row',{...noMatch,id:'unverified-row',text:query+' 无来源样例'});
  type Action={value:Record<string,unknown>};
  const buttons=(card:FeishuSendContext['card'])=>((card?.elements??[]) as Array<{actions?:Action[]}>)
    .flatMap(el=>el.actions??[]).filter(button=>button.value.kind==='workbench.chat' && button.value.conversationThreadId);
  const invoke=async(command:string,id:string)=>{
    const before=f.sent.length;
    await a.receive(command,id);
    return t.waitFor(()=>{
      const reply=f.sent.slice(before).find(row=>row.appId===a.row.appId && row.context?.replyTo===id);
      assert.ok(reply);return reply;
    },{timeout:5000});
  };
  const wanted=[find(query+' 标题甲').threadId,find('第二个工作记录').threadId].sort();
  const beforeUnauthorized=f.sent.length;
  await a.receive('/list '+query,'wrong-sender',{senderId:'stranger'});
  await a.receive('/对话 '+query,'wrong-chat',{chatType:'group',chatId:'group-test'});
  assert.ok(!f.sent.slice(beforeUnauthorized).some(row=>['wrong-sender','wrong-chat'].includes(row.context?.replyTo??'')));
  f.store.put('messages','matched-reply',{...body,id:'matched-reply',role:'assistant',replyTo:body.id,
    createdAt:'2099-01-01T00:00:00.000Z',status:'done',text:'助手摘录'+query});
  const matches=await invoke('/list '+query,'listed-english');
  assert.match(matches.text,/助手 · 2099-01-01T00:00:00.000Z\n助手摘录/);
  assert.deepEqual(buttons(matches.context?.card).map(b=>String(b.value.conversationThreadId)).sort(),wanted);
  assert.doesNotMatch(matches.text,/他人私聊|已归档|无关会话|无来源样例/);
  const chinese=await invoke('/对话 '+query,'listed-chinese');
  const choices=buttons(chinese.context?.card);
  assert.deepEqual(choices.map(b=>String(b.value.conversationThreadId)).sort(),wanted);
  const selected=choices.find(b=>b.value.conversationThreadId===find('第二个工作记录').threadId)!;
  await a.click(chinese.id,selected.value);
  await a.receive('点击搜索卡后继续记录','continue-from-search');
  assert.equal((await f.input('点击搜索卡后继续记录')).conversationId,body.conversationId);
  const forged=await a.click(chinese.id,{...selected.value,conversationThreadId:find('无关会话').threadId});
  assert.ok(forged);
  await a.receive('检验越界按钮未切换','after-forged');
  assert.equal((await f.input('检验越界按钮未切换')).conversationId,body.conversationId);
  const plugin=await fetch(f.url+'/api/v1/plugins/conversation-search',{method:'POST',headers,body:JSON.stringify({enabled:false})});
  assert.equal(plugin.status,200);
  const staleChoice=choices.find(b=>b.value.conversationThreadId===find(query+' 标题甲').threadId)!;
  const stale=await a.click(chinese.id,staleChoice.value);
  assert.match(JSON.stringify(stale),/停用/);
  await a.receive('停用后旧搜索卡保持原会话','after-disabled-click');
  assert.equal((await f.input('停用后旧搜索卡保持原会话')).conversationId,body.conversationId);
  const disabled=await invoke('/list '+query,'disabled-search');
  assert.deepEqual(buttons(disabled.context?.card),[]);
  assert.match(disabled.text,/停用|未启用|关闭/);
  const ordinary=await invoke('/list','unfiltered');
  assert.equal(buttons(ordinary.context?.card).length,3);
  assert.ok(!f.users().some(row=>/^\/(list|对话)/.test(row.text)));
});

test('新会话实际使用独立 SDK 历史，切回原会话后可继续原来的上下文', { timeout: 60000 }, async t => {
  const inputs: string[][] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    assert.equal(req.url, 'http://127.0.0.1:1/fixture/chat/completions');
    const { messages, model } = await req.json();
    inputs.push(messages.filter((m: {role: string}) => m.role === 'user').map((m: {content: unknown}) => JSON.stringify(m.content)));
    const chunks = [{ role: 'assistant', content: '合成引用回执-' + inputs.length }, {}].map((delta, index) =>
      'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model,
        choices: [{ index: 0, delta, finish_reason: index ? 'stop' : null }] }));
    return new Response([...chunks, 'data: [DONE]', ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  });
  const f = await fixture(t, { provider: 'openai-compatible', model: 'fixture-model', apiKey: 'fixture-key',
    baseUrl: 'http://127.0.0.1:1/fixture' });
  const a = await f.bot('cli_4444444444444444', 'alpha');
  await a.pair();
  await a.receive('主会话的蓝色纸张', 'main-first');
  await f.input('主会话的蓝色纸张');
  await a.receive('/new 新会话的红色纸张', 'new-first');
  await f.input('新会话的红色纸张');
  await f.restart();
  await a.receive('继续核对红色纸张', 'new-second');
  await f.input('继续核对红色纸张');
  await a.receive('/main', 'select-main');
  await a.receive('继续核对蓝色纸张', 'main-second');
  await f.input('继续核对蓝色纸张');
  assert.equal(inputs.length, 4);
  assert.match(inputs[1].join('\n'), /新会话的红色纸张/);
  assert.doesNotMatch(inputs[1].join('\n'), /蓝色纸张/);
  assert.match(inputs[2].join('\n'), /新会话的红色纸张/);
  assert.doesNotMatch(inputs[2].join('\n'), /蓝色纸张/);
  assert.match(inputs[3].join('\n'), /主会话的蓝色纸张/);
  assert.doesNotMatch(inputs[3].join('\n'), /红色纸张/);
  const oldReply = await t.waitFor(() => {
    const message = f.sent.find(row => row.appId === a.row.appId && row.text.includes('合成引用回执-4'));
    assert.ok(message); return message;
  });
  await a.receive('/new 仅核对引用的回执', 'new-quoted', { parentId: oldReply.id });
  const quoted = await f.input('仅核对引用的回执');
  assert.notEqual(quoted.conversationId, (await f.input('继续核对蓝色纸张')).conversationId);
  assert.equal(inputs[4].length, 1);
  assert.match(inputs[4][0], /> 合成引用回执-4/);
  assert.match(inputs[4][0], /仅核对引用的回执/);
  assert.doesNotMatch(inputs[4][0], /蓝色纸张|红色纸张|合成引用回执-[123]/);
});


test('飞书为独立会话改选模型，固定主会话和其他独立会话保留各自的选型', async t => {
  const initial = 'llama-3.1-8b-instant', selected = 'llama-3.3-70b-versatile';
  const f = await fixture(t, { provider: 'groq', model: initial }, true);
  const a = await f.bot('cli_5555555555555555', 'alpha');
  await a.pair();
  await a.receive('/new 选型甲', 'one');
  await f.input('选型甲');
  await a.receive('/new 选型乙', 'two');
  await f.input('选型乙');
  const rows = await (await f.threads(a.row.id)).json() as Array<{threadId: string; title: string}>;
  const one = rows.find(row => row.title === '选型甲'), two = rows.find(row => row.title === '选型乙');
  assert.ok(one && two);
  await a.receive('/modelchange ' + selected, 'change', { parentId: 'one' });
  assert.equal(await f.currentModel(a.row.id, one.threadId), selected);
  assert.equal(await f.currentModel(a.row.id, two.threadId), initial);
  assert.equal(await f.currentModel(a.row.id), initial);
  await a.receive('/modellist', 'inspect', { parentId: 'one' });
  assert.ok(f.sent.at(-1)?.text.includes('当前模型 · ' + selected));
  await a.receive('/modellist', 'inspect-active');
  assert.ok(f.sent.at(-1)?.text.includes('当前模型 · ' + initial));
  const secondChoice = 'openai/gpt-oss-20b';
  await a.receive('/modelchange ' + secondChoice, 'change-active');
  assert.equal(await f.currentModel(a.row.id, two.threadId), secondChoice);
  assert.equal(await f.currentModel(a.row.id, one.threadId), selected);
  assert.equal(await f.currentModel(a.row.id), initial);
});


test('升级前的主会话输入和助手回执没有对话锚点时，引用仍回到原主会话', async t => {
  const f = await fixture(t), a = await f.bot('cli_6666666666666666', 'alpha');
  await a.pair();
  const originalId = 'legacy-main-input';
  await a.receive('升级前的合成记录', originalId);
  const original = await f.input('升级前的合成记录');
  const reply = await t.waitFor(() => {
    const delivered = f.sent.find(row => row.appId === a.row.appId && row.text.includes('升级前的合成记录'));
    assert.ok(delivered); return delivered;
  });
  for (const platformId of [originalId, reply.id]) {
    const key = createHash('sha256').update(JSON.stringify([a.row.id, 'private-alpha', platformId])).digest('hex');
    assert.equal(f.store.remove('feishu.chat-target', key), true);
  }
  await f.restart();
  await a.receive('/new 升级后的独立会话', 'new');
  const current = await f.input('升级后的独立会话');
  assert.notEqual(current.conversationId, original.conversationId);
  await a.receive('引用旧输入', 'quote-input', { parentId: originalId });
  assert.equal((await f.input('引用旧输入')).conversationId, original.conversationId);
  await a.receive('引用旧回执', 'quote-output', { parentId: reply.id });
  assert.equal((await f.input('引用旧回执')).conversationId, original.conversationId);
  await a.receive('继续独立会话', 'continue');
  assert.equal((await f.input('继续独立会话')).conversationId, current.conversationId);
});
