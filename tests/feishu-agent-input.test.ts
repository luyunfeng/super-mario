import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions, FeishuSendContext } from '../plugins/feishu.ts';
import type { Json, JsonObject, MachineInfo, Run } from '../packages/protocol/src/index.ts';

test('从飞书选择原生会话，在 Web 审批后只向原交互执行发送一次输入', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sm-agent-input-'));
  let receiver!: FeishuOptions;
  const outbox: FeishuSendContext[] = [];
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, demo: true, token: 'offline-fixture' }, {
    botFactory(options) {
      receiver = options;
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
        async send(_target, _text, context) { if (context) outbox.push(context); } };
    },
  });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { app, bots } = server;
  const m: MachineInfo = { id: 'build-a', name: '合成执行机', online: true, platform: 'linux', connectedAt: '', capabilities: ['agents.sessions', 'executor.input'],
    executors: [{ id: 'codex', kind: 'cli', name: '合成执行者', available: true, mode: 'real', machineId: 'build-a', description: '' }] };
  const writes: JsonObject[] = [];
  const at = new Date().toISOString();
  const meta = { id: 'codex:thread', executorId: 'codex', nativeSessionId: 'thread', cwd: '/fixture', observedAt: at,
    state: 'historical', source: 'session-metadata', writable: false };
  app.store.put('machines', m.id, m);
  app.setMachineClient({ list: () => [m], async call(id, method, params): Promise<Json> {
    assert.equal(id, m.id);
    if (method === 'agents.sessions') return { sessions: [meta], roots: ['/fixture'], truncated: false, warnings: [] };
    assert.equal(method, 'executor.input');
    writes.push(params);
    return { accepted: true };
  } });
  const project = app.projects.create({ name: '样例', workspace: { machineId: m.id, cwd: meta.cwd } });
  const run: Run = { id: 'run-a', projectId: project.id, conversationId: 'main', executorId: 'build-a/codex', sessionId: 'session-one',
    nativeSessionId: meta.nativeSessionId, machineId: m.id, cwd: meta.cwd, executionMode: 'interactive', status: 'running',
    prompt: '查样例', output: '', createdAt: at, updatedAt: at };
  app.store.put('runs', run.id, run);
  const bot = await bots.create({ name: '合成主机器人', appId: 'cli_3333333333333333', appSecret: 'fixture', scope: { kind: 'global' } });
  const source = { chatId: 'private', senderId: 'owner', chatType: 'p2p', senderType: 'user' } as const;
  const send = (text: string, messageId: string) => receiver.onMessage(text, { ...source, messageId });
  await send(bot.pairingCode!, 'pair');
  await send('/agents 样例', 'directory');
  const card = outbox.at(-1)?.card as { elements: { actions?: { value?: Record<string, unknown> }[] }[] };
  const value = card.elements.flatMap(element => element.actions ?? []).find(action => action.value?.kind === 'workbench.agentSelect')?.value;
  assert.ok(value);
  receiver.onCardAction!({ value, chatId: source.chatId, operatorId: source.senderId, messageId: 'selected' });
  await send('第一条输入', 'one');
  await send('第一条输入', 'one');
  assert.deepEqual(writes, []);
  await send('/agents 样例', 'pending');
  assert.match(JSON.stringify(outbox.at(-1)?.card), /等你决定/);
  const approve = async (text: string) => {
    const records = app.approvals.list().filter(item => item.params.text === text);
    assert.equal(records.length, 1);
    const proposal = records[0];
    const res = await fetch(server.url + '/api/v1/approvals/' + proposal.id + '/approve', { method: 'POST',
      headers: { authorization: 'Bearer offline-fixture', 'content-type': 'application/json' }, body: JSON.stringify({ version: proposal.version }) });
    assert.equal(res.status, 200);
    return app.approvals.list().find(item => item.id === proposal.id)!.status;
  };
  assert.equal(await approve('第一条输入'), 'completed');
  await send('不能送到其他会话', 'two');
  app.store.put('runs', run.id, { ...run, sessionId: 'replacement' });
  assert.equal(await approve('不能送到其他会话'), 'failed');
  assert.deepEqual(writes, [{ sessionId: 'session-one', text: '第一条输入' }]);
});
