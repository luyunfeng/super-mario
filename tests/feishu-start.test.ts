import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Json, JsonObject, MachineInfo, Run } from '../packages/protocol/src/index.ts';
import type { FeishuOptions, FeishuSendContext } from '../plugins/feishu.ts';

const source = { chatId: 'private', senderId: 'owner', senderType: 'user', chatType: 'p2p' } as const;
const headers = { authorization: 'Bearer test-only', 'content-type': 'application/json' };

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sm-bot-start-'));
  const receivers = new Map<string, FeishuOptions>();
  const sent: { appId: string; target: string; text: string; context?: FeishuSendContext }[] = [];
  const open = () => startServer({ host: '127.0.0.1', port: 0, dataDir, demo: true, token: 'test-only' }, {
    botFactory(options) {
      receivers.set(options.appId, options);
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
        async send(target, text, context) { sent.push({ appId: options.appId, target, text, context }); } };
    },
  });
  let server = await open();
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const machine: MachineInfo = { id: 'fixture-host', name: '合成主机', online: true, platform: 'linux', connectedAt: '',
    capabilities: ['executor.start', 'executor.input', 'executor.read', 'executor.result'],
    executors: [{ id: 'codex', name: '合成交互执行者', kind: 'cli', available: true, mode: 'real', machineId: 'fixture-host',
      supportsModel: true, defaultCwd: '/fixture', description: '', nativeResultSources: ['fixture-native'] }] };
  const starts: JsonObject[] = [], inputs: JsonObject[] = [];
  let delivery: 'accepted' | 'unknown' = 'accepted';
  let taskCompleted = false;
  let startGate: Promise<void> | undefined;
  const { app, bots } = server;
  const attach = () => {
    server.app.store.put('machines', machine.id, machine);
    server.app.setMachineClient({ list: () => [machine], async call(machineId, method, params): Promise<Json> {
      assert.equal(machineId, machine.id);
      if (method === 'executor.result') return { state: taskCompleted ? 'completed' : 'running', source: 'fixture-native',
        text: taskCompleted ? '合成核验结果' : '', nativeSessionId: 'fixture-native-thread' };
      if (method === 'executor.input') { inputs.push(params); return { accepted: true }; }
      assert.equal(method, 'executor.start');
      const sessionId = 'fixture-session-' + starts.push(params);
      await startGate;
      if (delivery === 'unknown') throw Object.assign(new Error('合成回执中断'), { delivery: 'unknown' });
      return { sessionId };
    } });
  };
  attach();
  const project = app.projects.create({ name: '流星', workspace: { machineId: machine.id, cwd: '/fixture' } });
  const bot = await bots.create({ appId: 'cli_5555555555555555', appSecret: 'fixture', name: '合成机器人', scope: { kind: 'global' } });
  let receiver = receivers.get(bot.appId)!;
  const send = (text: string, messageId: string) => receiver.onMessage(text, { ...source, messageId });
  const pair = () => send(bot.pairingCode!, 'pair');
  const click = (value: Record<string, unknown>, formValue: Record<string, unknown>, operatorId: string = source.senderId) =>
    receiver.onCardAction!({ value, formValue, operatorId, chatId: source.chatId, messageId: 'form-card' });
  const form = async (command: string, id: string) => {
    const before = sent.length;
    await send(command, id);
    assert.equal(sent.length, before + 1);
    const card = sent.at(-1)?.context?.card as { body: { elements: Array<{ tag: string; elements?: Array<{
      tag: string; name?: string; default_value?: string; form_action_type?: string; behaviors?: Array<{value: Record<string, unknown>}> }> }> } };
    assert.ok(card?.body, '命令应发送飞书表单');
    const elements = card.body.elements.find(row => row.tag === 'form')?.elements;
    assert.ok(elements);
    const submit = elements.find(row => row.form_action_type === 'submit')?.behaviors?.[0].value;
    assert.equal(submit?.kind, 'workbench.startSubmit');
    return { elements, submit: submit! };
  };
  const values = { executorId: machine.id + '/codex', projectId: project.id, cwd: '/fixture',
    prompt: '执行合成核对', minutes: '5', doneWhen: '合成两份记录一致', executionMode: 'interactive' };
  async function webRuns(): Promise<Run[]> {
    const res = await fetch(server.url + '/api/v1/state', { headers });
    assert.equal(res.status, 200);
    return (await res.json()).runs;
  }
  return { app, bots, bot, receiver, receivers, machine, project, send, pair, form, click, values, starts, inputs, sent, webRuns, server,
    holdStart() {
      let release!: () => void;
      startGate = new Promise<void>(resolve => { release = resolve; });
      return release;
    },
    async restart() {
      await server.close();
      receivers.delete(bot.appId);
      server = await open();
      attach();
      await t.waitFor(() => assert.ok(receivers.has(bot.appId)));
      receiver = receivers.get(bot.appId)!;
    },
    finishTask() { taskCompleted = true; }, unknown() { delivery = 'unknown'; }, offline() { machine.online = false; app.store.put('machines', machine.id, machine); } };
}

test('飞书 /开工 预填目标，主人提交后只派发一次，同一执行可在 Web 查看', async t => {
  const f = await fixture(t);
  await f.pair();
  const form = await f.form('/开工 检查合成记录', 'open');
  assert.equal(form.elements.find(item => item.name === 'prompt')?.default_value, '检查合成记录');
  assert.equal(f.app.approvals.list().length, 0);
  assert.equal(f.starts.length, 0);
  f.click(form.submit, f.values, 'stranger');
  assert.equal((await f.webRuns()).length, 0);
  assert.ok(form.elements.some(item => item.name === 'model'));
  const selected = { ...f.values, model: 'fixture-model' };
  f.click(form.submit, selected);
  f.click(form.submit, selected);
  await t.waitFor(async () => assert.ok((await f.webRuns()).some(run => run.sessionId === 'fixture-session-1')));
  const matches = (await f.webRuns()).filter(run => run.prompt === f.values.prompt);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].model, 'fixture-model');
  assert.equal(f.starts[0].model, 'fixture-model');
  assert.equal(matches[0].status, 'running');
  assert.equal(matches[0].executionMode, 'interactive');
  assert.equal(matches[0].machineId, f.machine.id);
  assert.equal(matches[0].projectId, f.project.id);
  assert.equal(matches[0].doneWhen, f.values.doneWhen);
  assert.equal(matches[0].expectMinutes, 5);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].mode, 'interactive');
  f.click(form.submit, { ...f.values, prompt: '旧卡不能改派其他工作' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.app.approvals.list().length, 0);
  assert.equal(f.starts.length, 1);
  await f.send('请继续核对第二份记录', 'continue');
  const follow = f.app.approvals.list().filter(row => row.kind === 'input');
  assert.equal(follow.length, 1);
  assert.equal(follow[0].params.id, matches[0].id);
  assert.equal(follow[0].params.sessionId, 'fixture-session-1');
  assert.equal(f.inputs.length, 0);
  const res = await fetch(f.server.url + '/api/v1/approvals/' + follow[0].id + '/approve', {
    method: 'POST', headers, body: JSON.stringify({ version: follow[0].version }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(f.inputs, [{ sessionId: 'fixture-session-1', text: '请继续核对第二份记录' }]);
});

test('/start 拒绝跨身份、伪造执行者和离线选项，旧表单收到提交前解绑可阻止启动', async t => {
  const f = await fixture(t);
  await f.send('/start', 'before-pair');
  assert.equal(f.sent.length, 0);
  await f.pair();
  const before = f.sent.length;
  for (const [index, patch] of [{ chatType: 'group' }, { senderId: 'intruder' }, { chatId: 'other' }, { senderType: 'bot' as const }].entries())
    await f.receiver.onMessage('/start', { ...source, ...patch, messageId: 'denied-' + index });
  assert.equal(f.sent.length, before);
  const scoped = await f.bots.create({ appId: 'cli_6666666666666666', name: '项目机器人', appSecret: 'fixture',
    scope: { kind: 'project', projectId: f.project.id } });
  const projectReceiver = f.receivers.get(scoped.appId)!;
  await projectReceiver.onMessage(scoped.pairingCode!, { ...source, messageId: 'pair-project' });
  const paired = f.sent.length;
  await projectReceiver.onMessage('/start', { ...source, messageId: 'scoped' });
  assert.equal(f.sent.length, paired);
  await f.send('/agents', 'directory');
  const directory = f.sent.at(-1)?.context?.card as { elements: Array<{ actions?: Array<{value?: Record<string, unknown>}> }> };
  const open = directory.elements.flatMap(row => row.actions ?? []).find(action => action.value?.kind === 'workbench.startForm')?.value;
  assert.ok(open);
  f.click(open, {});
  await t.waitFor(() => assert.ok(f.sent.at(-1)?.context?.card?.body));
  assert.equal(f.starts.length, 0);
  const first = await f.form('/start', 'first');
  f.click(first.submit, { ...f.values, executionMode: 'task', doneWhen: '', minutes: '' });
  f.click(first.submit, { ...f.values, cwd: '/different-project' });
  f.click(first.submit, { ...f.values, executorId: 'other-host/codex' });
  assert.equal((await f.webRuns()).length, 0);
  f.offline();
  f.click(first.submit, f.values);
  assert.equal((await f.webRuns()).length, 0);
  f.machine.online = true; f.app.store.put('machines', f.machine.id, f.machine);
  const second = await f.form('/start', 'second');
  f.app.store.put('settings', 'feishu.bot.owner:' + f.bot.id + ':' + f.bot.appId, { senderId: 'another-owner', chatId: 'replacement' });
  f.click(second.submit, f.values);
  assert.equal(f.starts.length, 0);
  assert.equal((await f.webRuns()).some(run => run.prompt === f.values.prompt), false);
});

test('飞书来源的启动回执未知时，保留同一条 Web 执行并阻止重复启动', async t => {
  const f = await fixture(t);
  await f.pair();
  f.unknown();
  const form = await f.form('/start', 'uncertain');
  f.click(form.submit, f.values);
  await t.waitFor(async () => assert.ok((await f.webRuns()).some(run => run.prompt === f.values.prompt && run.status === 'unknown')));
  await f.send('/start', 'uncertain');
  f.click(form.submit, f.values);
  await new Promise<void>(resolve => setImmediate(resolve));
  const runs = (await f.webRuns()).filter(run => run.prompt === f.values.prompt);
  assert.equal(runs.length, 1);
  assert.equal(f.app.approvals.list().length, 0);
  assert.equal(f.starts.length, 1);
});

test('飞书表单已创建执行但代理尚未接到启动请求时，撤销配对会阻止外部动作', async t => {
  const f = await fixture(t);
  await f.pair();
  let reached = false;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.app.plugins.register({ id: 'start-test-policy', name: '合成执行策略', capabilities: [], activate(context) {
    context.hook('work.dispatch', 'before', async () => { reached = true; await wait; });
  } });
  await f.app.plugins.start();
  const form = await f.form('/start', 'submit-race');
  f.click(form.submit, f.values);
  try {
    await t.waitFor(() => assert.ok(reached));
    f.app.store.put('settings', 'feishu.bot.owner:' + f.bot.id + ':' + f.bot.appId,
      { senderId: 'other-owner', chatId: 'other-private' });
  } finally { release(); }
  await t.waitFor(async () => assert.ok((await f.webRuns()).some(run => run.prompt === f.values.prompt && run.status === 'failed')));
  assert.equal(f.starts.length, 0);
  assert.ok(f.sent.every(row => row.target === source.chatId));
});

test('飞书发起项目任务时透传项目指令和验收条件，原生结果回到原私聊', async t => {
  const f = await fixture(t);
  await f.pair();
  await f.app.plugins.invocations.use('project-instructions.manage', { action: 'save', projectId: f.project.id,
    revision: 0, notes: '输出中标明合成数据版本。' });
  const form = await f.form('/start', 'task-start');
  f.click(form.submit, { ...f.values, executionMode: 'task' });
  await t.waitFor(() => assert.equal(f.starts.length, 1));
  assert.equal(f.starts[0].mode, 'task');
  assert.match(String(f.starts[0].prompt), /输出中标明合成数据版本/);
  assert.match(String(f.starts[0].prompt), /合成两份记录一致/);
  await t.waitFor(async () => assert.ok((await f.webRuns()).some(run => run.sessionId === 'fixture-session-1')));
  f.finishTask();
  await f.app.monitor.poll();
  await t.waitFor(async () => assert.ok((await f.webRuns()).some(run => run.status === 'completed' && run.resultSource === 'fixture-native')));
  await t.waitFor(() => assert.ok(f.sent.some(row => row.target === source.chatId && row.text.includes('合成核验结果'))));
  assert.equal(f.sent.filter(row => row.text.includes('合成核验结果')).length, 1);
});

test('全局机器人从未归项目表单启动，切回主对话后迟到的状态卡回执只绑定原卡', async t => {
  const f = await fixture(t);
  await f.pair();
  const form = await f.form('/start', 'global-start');
  f.click(form.submit, { ...f.values, projectId: '__global__' });
  await t.waitFor(async () => assert.ok((await f.webRuns()).some(run => run.sessionId === 'fixture-session-1')));
  const run = (await f.webRuns()).find(row => row.sessionId === 'fixture-session-1')!;
  assert.equal(run.projectId, undefined);
  assert.match(run.conversationId, /^bot:/);
  await f.send('/status', 'old-run-status');
  const fromRun = f.sent.at(-1)!;
  assert.ok(fromRun.text.includes(run.id));
  const late = fromRun.context?.onSent;
  assert.ok(late);
  await f.send('/main', 'back-to-main');
  late('received-after-switch');
  await f.send('/status', 'current-main-status');
  assert.ok(!f.sent.at(-1)!.text.includes(run.id));
  await f.receiver.onMessage('请补充一项核对', { ...source, messageId: 'quote-original', parentId: 'received-after-switch' });
  const approval = f.app.approvals.list().find(row => row.params.text === '请补充一项核对');
  assert.equal(approval?.params.id, run.id);
  assert.equal(approval.params.sessionId, run.sessionId);
  assert.equal(f.starts.length, 1);
});

test('执行机启动回执晚于 /main 时保留主对话，引用登记卡仍向原执行提交输入', async t => {
  const f = await fixture(t);
  await f.pair();
  const release = f.holdStart();
  const form = await f.form('/start', 'waiting-for-host');
  const receipt = f.click(form.submit, f.values);
  try {
    await t.waitFor(() => assert.equal(f.starts.length, 1));
    const pending = (await f.webRuns()).find(row => row.prompt === f.values.prompt);
    assert.ok(pending && !pending.sessionId);
    assert.ok(JSON.stringify(receipt.card).includes(pending.id));
    await f.send('/main', 'changed-before-host');
  } finally { release(); }
  await t.waitFor(async () => assert.ok((await f.webRuns()).some(row => row.sessionId === 'fixture-session-1')));
  const run = (await f.webRuns()).find(row => row.prompt === f.values.prompt)!;
  await f.send('/status', 'default-after-host');
  assert.ok(!f.sent.at(-1)!.text.includes(run.id));
  await f.receiver.onMessage('给原执行的后续要求', { ...source, messageId: 'quote-registration', parentId: 'form-card' });
  const input = f.app.approvals.list().filter(row => row.kind === 'input');
  assert.equal(input.length, 1);
  assert.equal(input[0].params.id, run.id);
  assert.equal(input[0].params.sessionId, run.sessionId);
  assert.equal(f.inputs.length, 0);
  assert.equal(f.starts.length, 1);
});

test('同一飞书启动表单跨服务重启后重放，只返回已有执行', async t => {
  const f = await fixture(t);
  await f.pair();
  const form = await f.form('/start', 'before-restart');
  f.click(form.submit, f.values);
  await t.waitFor(async () => assert.ok((await f.webRuns()).some(row => row.sessionId === 'fixture-session-1')));
  const original = (await f.webRuns()).find(row => row.prompt === f.values.prompt)!;
  await f.restart();
  const replay = f.click(form.submit, f.values);
  assert.ok(JSON.stringify(replay.toast).includes(original.id), JSON.stringify(replay.toast));
  const changed = f.click(form.submit, { ...f.values, prompt: '另一个目标' });
  assert.equal((changed.toast as { type: string }).type, 'error');
  assert.deepEqual((await f.webRuns()).map(row => row.id), [original.id]);
  assert.equal(f.starts.length, 1);
});

test('两份表单等待回执时，仅最近提交的交互执行可成为默认目标', async t => {
  const f = await fixture(t);
  await f.pair();
  const releaseFirst = f.holdStart();
  const first = await f.form('/start', 'first-form');
  f.click(first.submit, f.values);
  await t.waitFor(() => assert.equal(f.starts.length, 1));
  const releaseSecond = f.holdStart();
  try {
    const second = await f.form('/start', 'second-form');
    f.click(second.submit, { ...f.values, prompt: '第二份交互目标' });
    await t.waitFor(() => assert.equal(f.starts.length, 2));
    releaseFirst();
    await t.waitFor(async () => assert.ok((await f.webRuns()).some(row => row.sessionId === 'fixture-session-1')));
  } finally { releaseFirst(); releaseSecond(); }
  await t.waitFor(async () => assert.ok((await f.webRuns()).some(row => row.sessionId === 'fixture-session-2')));
  const latest = (await f.webRuns()).find(row => row.prompt === '第二份交互目标')!;
  await f.send('/status', 'current-execution');
  assert.ok(f.sent.at(-1)!.text.includes(latest.id));
});
