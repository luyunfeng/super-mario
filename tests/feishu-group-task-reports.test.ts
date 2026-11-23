import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGroupTaskReports, type GroupTaskReportSource } from '../apps/server/src/feishu-group-task-reports.ts';
import { createStore } from '../packages/core/src/store.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'group-reports-')), path = join(dir, 'test.sqlite');
  const source: GroupTaskReportSource = { botId: 'bot', appId: 'app', binding: 'pair-a', chatId: 'group',
    messageId: 'question', todoId: 'todo', privateMessageId: 'anchor', senderId: 'owner' };
  const key = createHash('sha256').update(JSON.stringify(['bot', 'app', 'group', 'question'])).digest('hex');
  const preview: string[] = [], sent: string[] = [];
  const state = { time: Date.parse('2026-01-01T00:00:00Z'), delay: undefined as number | undefined,
    authorized: true, outcome: '合成结果' as string | undefined,
    preview: async (text: string, guard: () => void) => { guard(); preview.push(text); return 'notice'; },
    send: async (text: string, guard: () => void) => { guard(); sent.push(text); return 'receipt'; } };
  let store = createStore(path);
  store.put('feishu.group-tasks', key, { ...source, handedOff: true, task: { request: '仅私聊的合成任务' } });
  function completed(done = true) {
    store.put('todos', source.todoId, { id: source.todoId, notes: '仅私聊的合成笔记', ...(done && { completedAt: new Date(state.time).toISOString() }) });
  }
  completed();
  function open() {
    return createGroupTaskReports(store, {
      now: () => state.time, lookup: s => {
        assert.deepEqual(s, source);
        return state.authorized ? { delayMinutes: state.delay, preview: state.preview, send: state.send } : undefined;
      }, getOutcome: () => state.outcome,
    });
  }
  let reports = open();
  t.after(() => { reports.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { source, state, preview, sent, completed,
    sweep: () => reports.sweep(),
    restart() { reports.close(); store.close(); store = createStore(path); reports = open(); },
    cancel: (id = 'notice', binding = source.binding) => reports.cancel(source.botId, binding, [id]),
    recall: () => store.put('feishu.group-tasks', key, { ...source, handedOff: true, recalled: true }),
    receipt: () => store.get<{sentId?: string; status: string}>('feishu.group-task-reports', key),
  };
}

test('只预览真实短结论，确认后计时，跨重启保留原期限与公开回执', async t => {
  const f = fixture(t);
  f.state.outcome = undefined;
  await f.sweep();
  assert.equal(f.preview.length, 0);
  f.state.outcome = '变更已完成 [合成链接](https://example.invalid/private) @成员 /tmp/private `secret`\n仅私聊的第二行';
  await Promise.all([f.sweep(), f.sweep()]);
  assert.equal(f.preview.length, 1);
  assert.match(f.preview[0], /10 分钟[\s\S]*\/noreply[\s\S]*变更已完成$/u);
  assert.doesNotMatch(f.preview[0], /secret|tmp|private|成员|私聊/u);
  f.restart();
  f.state.delay = 0;
  f.state.time += 599_999;
  await f.sweep();
  assert.deepEqual(f.sent, []);
  f.state.time++;
  await f.sweep();
  f.restart();
  await f.sweep();
  assert.deepEqual(f.sent, ['变更已完成']);
  assert.equal(f.receipt()?.sentId, 'receipt');
  assert.equal(f.cancel(), 'sent');
});

test('主人按私聊锚点或已确认预览取消，跨配对和原群消息均不匹配', async t => {
  const f = fixture(t);
  await f.sweep();
  assert.equal(f.cancel('notice', 'pair-b'), 'missing');
  assert.equal(f.cancel('question'), 'missing');
  assert.equal(f.cancel(), 'cancelled');
  f.restart();
  assert.equal(f.cancel('anchor'), 'already');
  f.state.time += 600_001;
  await f.sweep();
  assert.deepEqual(f.sent, []);
});

test('重开后撤销旧计划，新结论重新预览；撤回原群消息后不投递', async t => {
  const f = fixture(t);
  await f.sweep();
  f.completed(false);
  f.state.time += 600_001;
  await f.sweep();
  f.completed();
  f.state.outcome = '已完成新的合成工作';
  await f.sweep();
  assert.equal(f.preview.length, 2);
  assert.deepEqual(f.sent, []);
  f.recall();
  f.state.time += 600_001;
  await f.sweep();
  assert.deepEqual(f.sent, []);
});

test('预览未取得回执，重启也不再次预览或公开', async t => {
  const f = fixture(t);
  f.state.preview = async text => { f.preview.push(text); return ''; };
  await f.sweep();
  f.restart();
  f.state.time += 600_001;
  await f.sweep();
  assert.equal(f.preview.length, 1);
  assert.deepEqual(f.sent, []);
});

test('零延迟直发，发送结果不明则持久保留，重启不重发', async t => {
  const f = fixture(t);
  f.state.delay = 0;
  f.state.send = async text => { f.sent.push(text); throw new Error('合成超时'); };
  await f.sweep();
  f.restart();
  await f.sweep();
  assert.deepEqual(f.preview, []);
  assert.deepEqual(f.sent, ['合成结果']);
  assert.equal(f.cancel('anchor'), 'unknown');
});

test('投递钩子等待期间撤销授权，最后检查阻止发群；过期不再上报', async t => {
  const f = fixture(t);
  f.state.delay = 0;
  f.state.time += 8 * 86_400_000;
  await f.sweep();
  assert.deepEqual(f.sent, []);
  f.completed();
  f.state.send = async (text, guard) => {
    await Promise.resolve();
    f.state.authorized = false;
    guard();
    f.sent.push(text);
    return 'unexpected';
  };
  await f.sweep();
  assert.deepEqual(f.sent, []);
});
