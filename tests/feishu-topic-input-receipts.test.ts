import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTopicInputReceipts, TopicInputReceiptNotReady } from '../apps/server/src/feishu-topic-input-receipts.ts';
import { createApprovalService } from '../packages/core/src/approvals.ts';
import { createEffects } from '../packages/core/src/effects.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createStore } from '../packages/core/src/store.ts';
import type { Store } from '../packages/plugin-sdk/src/index.ts';
import type { Approval, Json } from '../packages/protocol/src/index.ts';
import type { FeishuAgentInputTarget } from '../packages/protocol/src/bots.ts';

const topic = { binding: 'binding', chatId: 'group', threadId: 'thread', messageId: 'source', inputId: 'input', grant: 'grant' };
const pinned = { runId: 'run', sessionId: 'session', machineId: 'machine', executorId: 'executor', projectId: '', todoId: '',
  botId: 'bot', appId: 'app', revision: 1, owner: { chatId: 'private', senderId: 'owner' }, topic };
function seed(store: Store, id: string, status: Approval['status'], effect?: string, result?: Json) {
  const key = 'approval:' + id + ':2', params = { id: 'run', text: '私聊合成输入' };
  store.put('approvals', id, { id, status, version: 2, kind: 'input', params, result, error: '私有测试日志' });
  store.put('feishu.agent-input-targets', id, pinned);
  if (effect) store.put('effects', key, { key, status: effect, kind: 'executor.input', target: 'run', result,
    fingerprint: createHash('sha256').update(JSON.stringify(['executor.input', 'run', { text: params.text }])).digest('hex') });
}

test('执行机输入回执以确定写入为准，只发送固定的公开状态', async t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  const rows = new Map<string, string>();
  const reports = createTopicInputReceipts(store, { async send(target: FeishuAgentInputTarget, text, key) {
    assert.deepEqual(target, pinned); assert.equal(rows.has(key), false); rows.set(key, text);
    return 'platform-confirmed';
  } });
  const cases = [
    ['positive', 'completed', 'confirmed', { requested: true }, '执行机会话已收到这条输入。'],
    ['negative', 'completed', 'confirmed', { accepted: false }, '这条输入未发送到执行机会话。'],
    ['ack', 'completed', 'confirmed', { accepted: true }, '这条输入的送达结果未知。'],
    ['conflict', 'completed', 'confirmed', { accepted: false, requested: true }, '这条输入的送达结果未知。'],
    ['crash-before-approval', 'unknown', 'confirmed', { requested: true }, '执行机会话已收到这条输入。'],
    ['no-effect', 'completed', undefined, { requested: true }, '这条输入的送达结果未知。'],
    ['failed', 'failed', 'failed', undefined, '这条输入未发送到执行机会话。'],
    ['invalidated', 'failed', undefined, undefined, '这条输入未发送到执行机会话。'],
    ['rejected', 'rejected', undefined, undefined, '输入审批已拒绝，这条输入未发送。'],
    ['uncertain', 'unknown', 'unknown', undefined, '这条输入的送达结果未知。'],
  ] as const;
  for (const [id, status, effect, ack] of cases) seed(store, id, status, effect, ack);
  seed(store, 'pending', 'pending'); seed(store, 'running', 'running'); seed(store, 'private', 'rejected');
  store.put('feishu.agent-input-targets', 'private', { ...pinned, topic: undefined });
  await Promise.all([reports.sweep(), reports.changed('positive'), reports.sweep()]);
  assert.equal(rows.size, cases.length);
  for (const [id, , , , message] of cases) assert.equal(rows.get('feishu-topic-input-receipt:' + id), message);
  await reports.close();
});

test('中断、缺少平台 ID 或网络错误均不会再次向话题投递', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-topic-input-receipts-'));
  const db = join(dir, 'test.db');
  let store = createStore(db);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  for (const id of ['crash', 'empty', 'throw', 'refused', 'new']) seed(store, id, 'rejected');
  store.put('feishu.topic-input-receipts', 'crash', { status: 'rejected', delivery: 'unknown' });
  const reports = createTopicInputReceipts(store, { async send(_target, _text, key) {
    if (key.endsWith(':throw')) throw new Error('私有错误内容');
    if (key.endsWith(':refused')) throw Object.assign(new Error('失去原话题授权'), { delivery: 'no' });
    return '';
  } });
  for (const id of ['empty', 'throw', 'refused']) await reports.changed(id);
  await reports.close(); store.close(); store = createStore(db);
  const sent: string[] = [];
  const recovered = createTopicInputReceipts(store, { async send(_target, _text, key) { sent.push(key); return 'platform-id'; } });
  await recovered.sweep(); await recovered.sweep(); await recovered.close();
  assert.deepEqual(sent, ['feishu-topic-input-receipt:new']);
  assert.equal(store.get<{ delivery: string }>('feishu.topic-input-receipts', 'refused')?.delivery, 'failed');
});

test('真实审批与 effect 提交后订阅读取终态，审批通过本身不发送成功回报', async () => {
  const store = createStore(':memory:'), events = createEventBus(store);
  const effects = createEffects({ store, events }), sends: string[] = [];
  const reports = createTopicInputReceipts(store, { async send(_target, text) { sends.push(text); return 'message-id'; } });
  let release!: () => void;
  const writer = new Promise<void>(resolve => { release = resolve; });
  const approvals = createApprovalService({ store, events, execute(a) {
    return effects.perform({ key: 'approval:' + a.id + ':' + a.version, kind: 'executor.input', target: pinned.runId,
      summary: '输入', content: { text: a.params.text! }, async run() { await writer; return { requested: true }; } });
  } });
  const tasks: Promise<void>[] = [];
  const unsubscribe = events.subscribe(e => {
    if (e.type === 'approvals.changed' && e.data && typeof e.data === 'object' && 'id' in e.data && typeof e.data.id === 'string') tasks.push(reports.changed(e.data.id));
  });
  try {
    const a = approvals.propose({ kind: 'input', title: '合成输入', details: '', params: { id: pinned.runId, text: '合成文本' } });
    store.put('feishu.agent-input-targets', a.id, pinned);
    const done = approvals.approve(a.id, a.version);
    await Promise.all(tasks); assert.deepEqual(sends, []);
    release(); await done; await Promise.all(tasks);
    assert.deepEqual(sends, ['执行机会话已收到这条输入。']);
  } finally {
    release(); await unsubscribe(); await approvals.close(); await effects.close(); await reports.close(); store.close();
  }
});

test('启动扫描与审批终态交错，机器人或发送前连接未就绪时保留待发，恢复后只投递一次', async t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  const sent: string[] = [];
  let online = false, delayedHook = true;
  const receipts = createTopicInputReceipts(store, { ready: () => online, async send(_target, _text, key) {
    if (delayedHook) { delayedHook = false; online = false; throw new TopicInputReceiptNotReady(); }
    sent.push(key); return 'platform';
  } });
  seed(store, 'terminal', 'pending');
  seed(store, 'recovered', 'rejected');
  await receipts.sweep();
  seed(store, 'terminal', 'completed', 'confirmed', { requested: true });
  await receipts.changed('terminal');
  assert.deepEqual(store.list('feishu.topic-input-receipts'), []);
  online = true; await receipts.retryReady();
  assert.deepEqual(store.list<{ delivery: string }>('feishu.topic-input-receipts').map(row => row.delivery), ['waiting']);
  online = true;
  await Promise.all([receipts.retryReady(), receipts.changed('terminal'), receipts.sweep()]);
  assert.deepEqual(sent.sort(), ['feishu-topic-input-receipt:recovered', 'feishu-topic-input-receipt:terminal']);
  await receipts.close();
});
