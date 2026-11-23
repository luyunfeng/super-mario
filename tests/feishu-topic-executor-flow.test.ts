import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions, FeishuMessageSource, FeishuSendContext } from '../plugins/feishu.ts';
import type { Approval, JsonObject, Run, Todo } from '../packages/protocol/src/index.ts';

test('飞书话题决定经 Web 批准后仅送当前负责会话，重放、换负责人和取消登记均不会重复投递', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sm-topic-executor-'));
  const token = 'synthetic', machineId = 'fixture-machine';
  const topic = { chatType: 'group', chatId: 'oc_topic', threadId: 'omt_1', senderType: 'user', senderId: 'ou_owner' } as const;
  let botEvents!: FeishuOptions, modelCalls = 0;
  const sent: Array<{chat: string; text: string; context?: FeishuSendContext}> = [];
  const originalFetch = fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    assert.equal(url.hostname, '127.0.0.1');
    if (url.port !== '1') return originalFetch(request);
    assert.equal(url.pathname, '/offline/chat/completions'); modelCalls++;
    const frames = [{ role: 'assistant', content: '合成话题答复' }, {}].map((delta, i) =>
      'data: ' + JSON.stringify({ id: 'fixture', model: 'fixture', object: 'chat.completion.chunk',
        choices: [{index:0, delta, finish_reason:i ? 'stop' : null}] }));
    return new Response([...frames, 'data: [DONE]', ''].join('\n\n'), {headers:{'content-type':'text/event-stream'}});
  });
  const server = await startServer({ dataDir, token, host:'127.0.0.1', port:0, demo:false,
    model:{provider:'openai-compatible', model:'fixture', apiKey:'synthetic', baseUrl:'http://127.0.0.1:1/offline'} }, {
    botFactory(options) {
      botEvents = options;
      return {async start() {}, async close() {}, async collect() {return [];}, status:() => ({connected:true}),
        async send(chat, text, context) {
          context?.beforeSend?.(); sent.push({chat,text,context}); context?.onSent?.('om_out_' + sent.length,'text');
        }};
    },
  });
  const inputs: JsonObject[] = [];
  let starts = 0;
  const agent = startAgentNode({machineId,name:'合成执行机',dataDir:join(dataDir,'node'),url:server.url,token,
    executors:[{id:'codex',name:'本地协议替身',machineId,kind:'cli',mode:'real',available:true,description:'',defaultCwd:dataDir}],
    handlers:{
      'executor.start': async () => ({sessionId:'synthetic-session-' + ++starts}),
      'executor.input': async params => {inputs.push(params); return {requested:true};},
      'executor.read': async () => ({text:'',state:'unknown',source:'screen'}),
      'executor.result': async () => ({text:'',state:'running',source:'fixture'}),
    },
  });
  t.after(async () => { try { await agent.close(); await server.close(); } finally { await rm(dataDir,{recursive:true,force:true}); } });
  const api = async <T,>(path:string, method = 'GET', body?:object) => {
    const response = await fetch(server.url + '/api/v1/' + path,{method,headers:{authorization:'Bearer ' + token,'content-type':'application/json'},
      ...(body && {body:JSON.stringify(body)})});
    assert.ok(response.ok, path + ' HTTP ' + response.status);
    return response.json() as Promise<T>;
  };
  const bot = await server.bots.create({ name:'合成话题助手', appId:'cli_5555555555555555',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false });
  const emit = (messageId:string, text:string, change:Partial<FeishuMessageSource> = {}) =>
    botEvents.onMessage(text, {...topic,messageId, ...change});
  await emit('om_pair',bot.pairingCode!,{chatType:'p2p',chatId:'oc_private',threadId:undefined});
  await emit('om_enroll','/topics',{threadId:undefined});
  await emit('om_root','合成验收任务');
  await t.waitFor(() => assert.ok(sent.some(row => row.context?.replyTo === 'om_root' && row.text.includes('合成话题答复'))));
  const todo = (await api<Todo[]>('todos')).find(row => row.title === '合成验收任务')!;
  assert.ok(todo); assert.equal(modelCalls,1);
  await t.waitFor(() => assert.ok(server.machines.list().some(row => row.id === machineId && row.online)));
  async function createRun() {
    const created = await api<Run>('runs','POST',{executorId:machineId + '/codex',prompt:'本地执行机协议占位任务',
      todoId:todo.id, executionMode:'interactive',cwd:dataDir});
    return t.waitFor(async () => {
      const run = (await api<{runs:Run[]}>('state')).runs.find(r => r.id === created.id);
      assert.ok(run?.status === 'running' && run.sessionId); return run;
    });
  }
  const one = await createRun(), two = await createRun();
  const assign = async (run:Run) => {
    const saved = await api<Todo>('todos/' + todo.id,'PATCH',{responsibleRunId:run.id});
    assert.deepEqual(saved.responsibleSession,{runId:run.id,machineId,sessionId:run.sessionId});
  };
  await assign(one);
  const decisions = async () => (await api<{decisions:Array<{text:string;active:boolean}>}>('todos/' + todo.id + '/decisions')).decisions;
  const approvals = async () => (await api<Approval[]>('approvals')).filter(a => a.kind === 'input');
  const follow = (id:string, text:string) => emit(id,text,{rootId:'om_root',parentId:'om_root'});
  async function propose(id:string, text:string) {
    await follow(id,text);
    const rows = (await decisions()).filter(d => d.active && d.text === text);
    assert.equal(rows.length,1);
    const a = (await approvals()).filter(a => a.params.text === text);
    assert.equal(a.length,1, '话题决定应向当前负责会话提出一次输入审批');
    assert.equal(a[0].status,'pending');
    assert.equal(modelCalls,1);
    return a[0];
  }
  const approve = (a:Approval) => api<Approval>('approvals/' + a.id + '/approve','POST',{version:a.version});
  const first = '先核对甲样本';
  const approved = await propose('om_decision',first);
  const card = (await api<Array<{id:string;editable?:boolean;detail:string}>>('attention')).find(row => row.id === 'approval:' + approved.id);
  assert.ok(card && card.editable === false);
  assert.ok(card.detail.includes(one.sessionId!) && card.detail.includes(first));
  const mutation = await fetch(server.url + '/api/v1/approvals/' + approved.id, {method:'PATCH',
    headers:{authorization:'Bearer ' + token,'content-type':'application/json'},
    body:JSON.stringify({version:approved.version,params:{...approved.params,text:'替换原文'}})});
  assert.equal(mutation.status,409);
  assert.equal(approved.params.id,one.id);
  assert.equal(approved.params.sessionId,one.sessionId);
  const frozen = server.app.store.get<{topic:{chatId:string;threadId:string;messageId:string;grant:string;binding:string}}>('feishu.agent-input-targets',approved.id);
  assert.deepEqual([frozen?.topic.chatId,frozen?.topic.threadId,frozen?.topic.messageId], [topic.chatId,topic.threadId,'om_decision']);
  assert.ok(frozen?.topic.grant && frozen.topic.binding);
  assert.equal(inputs.length,0);
  await follow('om_decision','重放试图修改正文');
  assert.equal((await approvals()).length,1);
  const beforeApproval = sent.length;
  assert.equal((await approve(approved)).status,'completed');
  await t.waitFor(() => assert.ok(sent.slice(beforeApproval).some(row => row.chat === topic.chatId && row.context?.replyTo === 'om_decision'
    && row.context.threadId === topic.threadId && /(?:已收到|已送入|已发送|已送达|已接收|已确认|已将.{0,12}送)/.test(row.text)
    && !/已完成/.test(row.text))), {timeout:5000});
  assert.deepEqual(inputs,[{sessionId:one.sessionId,text:first}]);
  await follow('om_decision',first);
  const stale = await propose('om_change','负责人已变化的合成决定');
  await assign(two);
  assert.notEqual((await approve(stale)).status,'completed');
  const removed = await propose('om_leave','话题登记已撤销的合成决定');
  assert.equal(removed.params.id,two.id);
  await emit('om_off','/topics off',{threadId:undefined});
  assert.notEqual((await approve(removed)).status,'completed');
  assert.equal((await approvals()).length,3);
  assert.equal((await decisions()).filter(row => row.text === first).length,1);
  assert.ok(!(await decisions()).some(row => row.text.includes('重放试图修改')));
  assert.equal(modelCalls,1);
  assert.deepEqual(inputs,[{sessionId:one.sessionId,text:first}]);
});
