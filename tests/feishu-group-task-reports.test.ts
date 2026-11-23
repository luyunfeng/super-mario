import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGroupTaskReports, type GroupTaskReportSource } from '../apps/server/src/feishu-group-task-reports.ts';
import { createStore } from '../packages/core/src/store.ts';

function fixture(t: TestContext, home = false) {
  const dir = mkdtempSync(join(tmpdir(), 'group-reports-')), path = join(dir, 'test.sqlite');
  const source: GroupTaskReportSource = { botId: 'bot', appId: 'app', binding: 'pair-a', chatId: 'group',
    messageId: 'question', todoId: 'todo', privateMessageId: 'anchor', senderId: 'owner',
    ...(home && { homeChatId:'home', homeGrant:'grant', homeThreadId:'thread' }) };
  const key = createHash('sha256').update(JSON.stringify(['bot', 'app', 'group', 'question'])).digest('hex');
  const preview: string[] = [], sent: string[] = [];
  const state = { time: Date.parse('2026-01-01T00:00:00Z'), delay: undefined as number | undefined,
    authorized: true, outcome: '合成结果' as string | undefined,
    preview: async (text: string, guard: () => void) => { guard(); preview.push(text); return 'notice'; },
    send: async (text: string, guard: () => void) => { guard(); sent.push(text); return 'receipt'; } };
  let store = createStore(path);
  store.put('feishu.group-tasks', key, { ...source, delivery: 'confirmed', handedOff: true, task: { request: '仅私聊的合成任务' } });
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
    needed: (s = source) => reports.homeCompletionNeeded(s),
    setSource: (patch: object) => store.put('feishu.group-tasks', key, { ...source, delivery: 'confirmed', handedOff:true, ...patch }),
    setReport: (row: object) => store.put('feishu.group-task-reports', key, row),
    cancelHome: () => reports.cancel(source.botId,source.binding,[],{chatId:'home',grant:'grant',threadId:'thread'}),
    cancel: (id = 'notice', binding = source.binding) => reports.cancel(source.botId, binding, [id]),
    recall: () => store.put('feishu.group-tasks', key, { ...source, delivery: 'confirmed', handedOff: true, recalled: true }),
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

test('只读判定核验主群承接登记、当前授权和原消息，零延迟不占用预览', async t => {
  const f = fixture(t,true); f.state.delay = 0;
  assert.equal(f.needed(),true); assert.equal(f.needed(),true); assert.equal(f.receipt(),undefined);
  const fields: (keyof GroupTaskReportSource)[] = ['homeChatId','homeGrant','homeThreadId','botId','appId','binding','chatId','messageId','todoId','privateMessageId','senderId'];
  for (const field of fields) assert.equal(f.needed({...f.source,[field]:'mismatch'}),false,field);
  f.setSource({delivery:'unknown'}); assert.equal(f.needed(),false);
  f.setSource({handedOff:false}); assert.equal(f.needed(),false); f.setSource({});
  f.state.authorized = false; assert.equal(f.needed(),false); f.state.authorized = true;
  f.completed(false); assert.equal(f.needed(),false); f.completed();
  await f.sweep(); assert.equal(f.needed(),true);
  assert.deepEqual(f.preview,[]); assert.deepEqual(f.sent,['合成结果']);
  f.recall(); assert.equal(f.needed(),false);
  const privateOnly = fixture(t); privateOnly.state.delay = 0; assert.equal(privateOnly.needed(),false);
});

test('提前取消允许本代主群完成行，已预览、预览未知及其取消不得重复通知', async t => {
  for (const mode of ['early','preview','unknown'] as const) await t.test(mode,async t => {
    const f = fixture(t,true);
    assert.equal(f.needed(),false);
    if (mode === 'early') {
      f.completed(false);
      assert.equal(f.cancelHome(),'cancelled'); assert.equal(f.needed(),false);
      f.completed();
    } else {
      if (mode === 'unknown') f.state.preview = async () => '';
      await f.sweep(); f.state.delay = 0;
      assert.equal(f.needed(),false); assert.equal(f.cancelHome(),'cancelled');
    }
    f.restart(); assert.equal(f.needed(),mode === 'early');
    if (mode !== 'early') { f.state.time += 1000; f.completed(); assert.equal(f.needed(),true); }
  });
});

test('同一代已预览并回报仍抑制；已回报的上一代重开后可单独通知主群', async t => {
  const f = fixture(t,true);
  await f.sweep(); f.state.time += 600_001;
  await f.sweep(); assert.equal(f.receipt()?.status,'sent'); assert.equal(f.needed(),false);
  f.completed(false); assert.equal(f.needed(),false);
  f.completed(); f.restart(); assert.equal(f.needed(),true);
  await f.sweep(); assert.deepEqual(f.sent,['合成结果']); assert.equal(f.needed(),true);
  f.setReport({status:'cancelled', previewId:'legacy-preview'}); assert.equal(f.needed(),false);
  f.setReport({status:'cancelled'}); assert.equal(f.needed(),false);
});

test('同一完成代次修改公开结论并切换零延迟后，保留已有主群预览证据', async t => {
  const f = fixture(t,true); await f.sweep(); assert.equal(f.needed(),false);
  f.state.outcome = '修订后结论'; f.state.delay = 0; await f.sweep(); f.restart();
  assert.deepEqual(f.sent,['修订后结论']); assert.equal(f.needed(),false);
});
