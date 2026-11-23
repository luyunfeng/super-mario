import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { FeishuOptions, FeishuSendContext } from '../plugins/feishu.ts';
import type { Todo } from '../packages/protocol/src/index.ts';

test('Web 完成群任务后按预览时限发送原群回报，主人取消与重启不会重复投递', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-group-task-reports-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, demo: true, token: 'synthetic-token' };
  const wallClock = Date.now;
  let elapsed = 0;
  t.mock.method(Date, 'now', () => wallClock() + elapsed);
  let receiver!: FeishuOptions;
  const sent: Array<{ id: string; chat: string; text: string; context?: FeishuSendContext }> = [];
  const factory: FeishuBotFactory = opts => {
    receiver = opts;
    return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
      async send(chat, text, context) {
        const id = 'om_ack_' + sent.length;
        sent.push({ id, chat, text, context });
        context?.onSent?.(id, 'text');
      } };
  };
  let host = await startServer(config, { botFactory: factory });
  t.after(async () => { try { await host.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const bot = await host.bots.create({ name: '合成群任务机器人', appId: 'cli_8888888888888888', appSecret: 'fixture',
    scope: { kind: 'global' }, requireConfirmation: false });
  const owner = { senderType: 'user', senderId: 'ou_owner', chatType: 'p2p', chatId: 'oc_dm' } as const;
  await receiver.onMessage(bot.pairingCode!, { ...owner, messageId: 'om_pair' });
  const api = async (path: string, body?: object, status = 200, method = body ? 'PATCH' : 'GET') => {
    const res = await fetch(host.url + '/api/v1/' + path, { method,
      headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    assert.equal(res.status, status);
    return res.json();
  };
  const secretNote = '仅主人可见的合成验收细节';
  async function make(source: string, title: string) {
    await receiver.onMessage('/ai ' + title, { ...owner, chatType: 'group', chatId: 'oc_original', messageId: source, mentionedSelf: true });
    const rows: Todo[] = await api('todos');
    const todo = rows.find(row => row.title === title);
    assert.ok(todo);
    assert.ok(sent.some(message => message.chat === owner.chatId && message.text.includes(todo.id)));
    await api('todos/' + todo.id, { notes: secretNote + '-' + source });
    return todo;
  }
  const finish = (todo: Todo) => api('todos/' + todo.id, { completed: true });
  const previews = () => sent.filter(message => message.chat === owner.chatId && message.text.includes('/noreply') && /分钟/.test(message.text));
  const published = () => sent.filter(message => message.chat === 'oc_original');
  async function restart() {
    const old = receiver;
    await host.close(); host = await startServer(config, { botFactory: factory });
    await t.waitFor(() => assert.notEqual(old, receiver));
  }
  const cancelled = await make('om_cancel', '核对甲项');
  await finish(cancelled);
  await t.waitFor(() => assert.equal(previews().length, 1));
  const preview = previews()[0];
  assert.match(preview.text, /10\s*分钟/);
  assert.deepEqual(published(), []);
  await receiver.onMessage('/noreply', { ...owner, messageId: 'om_veto', parentId: preview.id });

  const project = host.app.projects.create({ name: '仅项目可见的合成项目名称' });
  const moved = await make('om_moved', '转移到项目的任务');
  await api('todos/' + moved.id, { projectId: project.id });
  await api('todos/' + moved.id, { groupTaskOutcome: '项目范围的合成结论', expectedGroupTaskOutcome: '', completed: true });
  const control = await make('om_control', '核对乙项');
  const approved = '乙项的三个合成样本一致，验收通过。';
  const updateOutcome = (id: string, outcome: string, expected = '', status = 200) => api('todos/' + id,
    { groupTaskOutcome: outcome, expectedGroupTaskOutcome: expected }, status);
  const ordinary: Todo = await api('todos', { title: '普通待办', notes: secretNote, groupTask: true }, 201, 'POST');
  await updateOutcome(ordinary.id, '普通待办不可公开', '', 403);
  for (const invalid of ['第一行\n第二行', '甲'.repeat(601)]) await updateOutcome(control.id, invalid, '', 400);
  await updateOutcome(control.id, '早期草稿');
  await updateOutcome(control.id, approved, '早期草稿');
  await updateOutcome(control.id, '过期请求不能覆盖', '早期草稿', 409);
  const stored: Todo[] = await api('todos');
  assert.equal(stored.find(row => row.id === control.id)?.groupTaskOutcome, approved);
  assert.equal(stored.find(row => row.id === ordinary.id)?.groupTaskOutcome, undefined);
  await finish(control);
  await t.waitFor(() => assert.equal(previews().length, 2));
  assert.ok(previews()[1].text.endsWith(approved));
  assert.doesNotMatch(previews()[1].text, /早期草稿|过期请求|仅主人可见/);
  assert.deepEqual(published(), []);
  // A pending control report proves that the cancellation remains effective after its actual deadline.
  elapsed = 11 * 60000;
  await restart();
  await t.waitFor(() => assert.ok(published().some(message => message.context?.replyTo === 'om_control')));
  assert.deepEqual(published().map(message => message.context?.replyTo), ['om_control']);
  assert.equal(published()[0].text, approved);

  assert.ok(!sent.some(message => message.text.includes('项目范围的合成结论')));
  await api('feishu/bots/' + bot.id, { groupTaskReportDelayMinutes: 0 });
  const instant = await make('om_immediate', '核对丙项');
  await receiver.onMessage('私聊限定标记X7F', { ...owner, messageId: 'om_private_followup' });
  await t.waitFor(() => assert.ok(sent.some(message => message.chat === owner.chatId && message.text.includes('私聊限定标记X7F'))));
  const previewCount = previews().length;
  await finish(instant);
  await t.waitFor(() => assert.ok(published().some(message => message.context?.replyTo === 'om_immediate')));
  assert.equal(previews().length, previewCount);
  for (const message of published()) {
    assert.doesNotMatch(message.text, /仅主人可见|本地演示|todoId|Bearer|私聊|om_ack_|\/noreply/);
    assert.equal(message.context?.card, undefined);
  }
  assert.equal(published().find(message => message.context?.replyTo === 'om_immediate')?.text, '这项待办已完成。');
  await restart();
  await receiver.onMessage('/ai 核对丙项', { ...owner, chatType: 'group', chatId: 'oc_original', messageId: 'om_immediate', mentionedSelf: true });
  assert.deepEqual(published().map(message => message.context?.replyTo), ['om_control', 'om_immediate']);
  assert.equal(previews().length, previewCount);
  const reverted = await api('todos/' + moved.id, { projectId: '' });
  assert.equal(reverted.groupTaskOutcome, undefined);
});
