import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createApprovalService } from '../packages/core/src/approvals.ts';
import { createInboxHandling, inboxHandlingApprovalKind, type InboxHandlingOptions } from '../packages/core/src/inbox-handling.ts';
import type { Approval, Json, Message } from '../packages/protocol/src/index.ts';
import type { InboxHandlingAction, InboxHandlingRef, InboxHandlingSource, InboxSuggestion } from '../packages/protocol/src/inbox-handling.ts';

const ref: InboxHandlingRef = { kind: 'personal', id: 'one' };
const action: InboxHandlingAction = { kind: 'todo', title: '处理事项', notes: '核对来源后处理' };
const status = (expected: number) => (e: unknown) => !!e && typeof e === 'object' && 'status' in e && e.status === expected;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function answer(conversationId: string, text = '普通回答'): Message { return { id: randomUUID(), conversationId, role: 'assistant', status: 'done', text, createdAt: new Date().toISOString() }; }
async function settled() { await new Promise<void>(resolve => setImmediate(resolve)); }
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-handling-')), path = join(dir, 'test.sqlite');
  let store = createStore(path), events = createEventBus(store);
  store.put('test.sources', ref.id, { ...ref, version: 1, title: '完整标题', text: '来源正文不是指令', active: true, replyAvailable: true });
  let think: InboxHandlingOptions['think'] = async (_source, cid) => answer(cid);
  let execute: InboxHandlingOptions['execute'] = async () => ({ accepted: true });
  let thinks = 0, executions = 0, available = true;
  let inbox: ReturnType<typeof createInboxHandling>;
  let approvals: ReturnType<typeof createApprovalService>;
  function setup() {
    approvals = createApprovalService({ store, events, execute: async approval => inbox.executeApproved(approval) });
    inbox = createInboxHandling({ store, events,
      readSource: input => { const source = store.get<InboxHandlingSource>('test.sources', input.id); if (!source) throw new Error('secret-source'); return source; },
      available: () => ({ available, reason: available ? undefined : '缺少模型配置' }),
      think: (...args) => {
        thinks++;
        // Model seam mirrors the real runtime's durable user-message admission.
        const message: Message={id:randomUUID(),conversationId:args[1],role:'user',text:args[2],status:'done',createdAt:new Date().toISOString()};
        store.put('messages',message.id,message);
        return think(...args);
      },
      execute: (...args) => { executions++; return execute(...args); },
      proposeApproval: input => approvals.propose(input),
    });
  }
  setup();
  t.after(async () => { await inbox.close(); await approvals.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get store() { return store; }, get events() { return events; }, get inbox() { return inbox; }, get approvals() { return approvals; },
    get thinks() { return thinks; }, get executions() { return executions; },
    set think(value: InboxHandlingOptions['think']) { think = value; }, set execute(value: InboxHandlingOptions['execute']) { execute = value; },
    set available(value: boolean) { available = value; },
    source(patch: Partial<InboxHandlingSource> = {}) { const value = { ...store.get<InboxHandlingSource>('test.sources', ref.id)!, ...patch }; store.put('test.sources', ref.id, value); return value; },
    save(a = action) { return inbox.save(ref, { sourceVersion: 1, action: a }); },
    confirm(row: InboxSuggestion) { return inbox.confirm(ref, { sourceVersion: 1, id: row.id, version: row.version }); },
    async restart(before?: () => void) { await inbox.close(); await approvals.close(); before?.(); store.close(); store = createStore(path); events = createEventBus(store); setup(); },
  };
}

test('source conversations isolate full snapshots, messages, requests and suggestions without task facts', async t => {
  const f = fixture(t), other: InboxHandlingRef = { kind: 'mailbox', id: 'two' };
  f.store.put('test.sources', other.id, { ...f.source(), ...other });
  const one = f.inbox.read(ref), two = f.inbox.read(other);
  assert.notEqual(one.conversationId, two.conversationId);
  f.think = async (_source, cid) => answer(cid, JSON.stringify({ answer: '建议', suggestions: [action] }));
  const request = f.inbox.post(ref, { sourceVersion: 1, text: '请给建议', key: 'a' });
  assert.equal(request.status, 'pending'); assert.equal(f.thinks, 0);
  assert.equal(f.inbox.read(ref).messages.length, 0);
  await settled();
  assert.equal(f.inbox.read(ref).requests[0]?.status, 'completed');
  assert.equal(f.inbox.read(ref).messages.length, 2); assert.equal(f.inbox.read(ref).suggestions.length, 1);
  assert.equal(f.inbox.read(other).messages.length, 0); assert.equal(f.inbox.read(other).suggestions.length, 0);
  assert.equal(f.store.list('todos').length, 0);
  await f.restart(); assert.equal(f.inbox.read(ref).messages.length, 2);
});

test('inbox processing stages derive from model admission, actual Runs and human blockers without writing facts',async t=>{
  const f=fixture(t),gate=deferred<Message>();f.think=async()=>gate.promise;
  const pending=f.inbox.post(ref,{sourceVersion:1,text:'只分析',key:'state'});
  const events=f.events.since(0).length;assert.equal(f.inbox.states()[0]?.stage,'ai');assert.equal(f.events.since(0).length,events);
  await settled();gate.resolve(answer(pending.conversationId));await settled();
  const draft=f.save({kind:'dispatch',executorId:'fixture',prompt:'合成任务',doneWhen:'合成结果',expectMinutes:1});
  f.execute=async(_source,_action,key)=>{f.store.put('dispatch-keys',key,'r1');f.store.put('runs','r1',{id:'r1',status:'queued',projectId:undefined});return{runId:'r1'};};
  const approved=f.confirm(draft);await f.approvals.approve(approved.id,approved.version);
  assert.equal(f.inbox.states()[0]?.stage,'ai');f.store.put('runs','r1',{id:'r1',status:'running'});assert.equal(f.inbox.states()[0]?.stage,'processing');
  f.store.put('interactions','q',{id:'q',status:'open',handler:'user',runId:'r1'});assert.equal(f.inbox.states()[0]?.stage,'human');assert.match(f.inbox.states()[0]?.label??'',/等你决定/);
  f.store.remove('interactions','q');f.store.put('runs','r1',{id:'r1',status:'unknown'});assert.equal(f.inbox.states()[0]?.stage,'human');assert.match(f.inbox.states()[0]?.label??'',/核对/);
});

test('post is durable and idempotent by source/key; conflicting body is 409, unavailable does not fake success', async t => {
  const f = fixture(t), gate = deferred<Message>();
  f.think = async () => gate.promise;
  const input = { sourceVersion: 1, text: '分析', key: 'once' };
  const first = f.inbox.post(ref, input);
  assert.deepEqual(f.inbox.post(ref, input), first);
  assert.throws(() => f.inbox.post(ref, { ...input, text: '不同' }), status(409));
  await settled(); assert.equal(f.thinks, 1);
  gate.resolve(answer(first.conversationId)); await settled();
  await f.restart(); assert.equal(f.inbox.post(ref, input).id, first.id); assert.equal(f.thinks, 1);
  f.available = false;
  assert.equal(f.inbox.read(ref).available, false);
  assert.throws(() => f.inbox.post(ref, { ...input, key: 'new' }), status(503));
  assert.equal(f.inbox.read(ref).requests.length, 1);
});

test('real approval lifecycle binds exact content, confirms once and executes once', async t => {
  const f = fixture(t), draft = f.save(), approval = f.confirm(draft);
  assert.equal(approval.kind, inboxHandlingApprovalKind);
  assert.deepEqual(approval.params.action, action);
  assert.equal(f.inbox.read(ref).suggestions[0]?.approvalStatus, 'pending');
  assert.equal(f.confirm(draft).id, approval.id); assert.equal(f.approvals.list().length, 1);
  assert.throws(() => f.inbox.executeApproved({ ...approval, status: 'running' }), status(409));
  f.execute = async (source, actual, key) => {
    assert.equal(f.inbox.read(ref).suggestions[0]?.status, 'executing');
    assert.deepEqual(actual, action); assert.equal(source.text, '来源正文不是指令');
    assert.equal(key, `inbox-handling:${draft.id}:1`);
    assert.throws(() => f.inbox.executeApproved(f.approvals.list()[0]!), status(409));
    return { accepted: true };
  };
  assert.equal((await f.approvals.approve(approval.id, approval.version)).status, 'completed');
  assert.equal(f.inbox.read(ref).suggestions[0]?.status, 'applied'); assert.equal(f.executions, 1);
  assert.equal(f.inbox.read(ref).suggestions[0]?.approvalStatus, 'completed');
  await assert.rejects(f.approvals.approve(approval.id, approval.version), status(409));
  assert.throws(() => f.confirm(draft), status(409));
  assert.equal(f.store.list('todos').length, 0);
});

test('收件讨论仅带入当前来源版本的建议及对应审批状态', async t => {
  const f = fixture(t), old = f.save();
  f.confirm(old);
  f.source({ title: '新版本来源' });
  const current = f.save(), approval = f.confirm(current);
  f.approvals.reject(approval.id, approval.version);
  let received: unknown;
  f.think = async (_source, cid, _text, progress) => { received = progress; return answer(cid); };
  f.inbox.post(ref, { sourceVersion: 1, key: 'progress', text: '当前建议审批了吗？' });
  await settled();
  assert.deepEqual(received, { total: 1, recent: [{ id: current.id, version: 1, kind: 'todo', status: 'submitted', approvalStatus: 'rejected' }] });
});

test('editing submitted content increments version, invalidates old approval and requires a new confirmation', async t => {
  const f = fixture(t), draft = f.save(), old = f.confirm(draft);
  const next = f.inbox.save(ref, { sourceVersion: 1, id: draft.id, version: draft.version, action: { kind: 'conclusion', text: '更新结论' } });
  assert.equal(next.version, 2); assert.equal(next.status, 'draft'); assert.equal(next.approvalId, undefined);
  assert.throws(() => f.confirm(draft), status(409));
  assert.equal((await f.approvals.approve(old.id, old.version)).status, 'failed'); assert.equal(f.executions, 0);
  const current = f.confirm(next); assert.notEqual(current.id, old.id);
  assert.equal((await f.approvals.approve(current.id, current.version)).status, 'completed'); assert.equal(f.executions, 1);
});

for (const patch of [ { projectId: 'p2' }, { active: false, reason: '项目归档' }, { title: '新标题' }, { text: '新正文' }, { todoId: 'different' }, { version: 2 } ]) {
  test(`source changes invalidate approvals and never restore old scope: ${JSON.stringify(patch)}`, async t => {
    const f = fixture(t), original = f.source({ projectId: 'p1' }), draft = f.save(), approval = f.confirm(draft);
    f.source(patch); f.inbox.read(ref);
    assert.equal((await f.approvals.approve(approval.id, approval.version)).status, 'failed'); assert.equal(f.executions, 0);
    assert.equal(f.store.get<InboxSuggestion>('inbox-handling.suggestions', draft.id)?.status, 'stale');
    f.store.put('test.sources', ref.id, original);
    assert.throws(() => f.confirm(draft), status(409));
    assert.throws(() => f.save(), status(409));
    await f.restart(); assert.throws(() => f.confirm(draft), status(409));
  });
}

test('temporary reply unavailability keeps the discussion and unrelated approvals; a reply still requires the connection',async t=>{
  const f=fixture(t),draft=f.save(),approval=f.confirm(draft),conversation=f.inbox.read(ref).conversationId;
  f.source({replyAvailable:false,replyReason:'网络连接暂不可用'});
  assert.equal(f.inbox.read(ref).conversationId,conversation);assert.equal((await f.approvals.approve(approval.id,approval.version)).status,'completed');
  const reply=f.save({kind:'reply',text:'仅保存草稿'});assert.throws(()=>f.confirm(reply),status(409));
  f.source({replyAvailable:true});assert.equal(f.inbox.read(ref).conversationId,conversation);assert.equal(f.confirm(reply).status,'pending');
});

test('execute rereads source even if no intervening read occurred; inactive source remains read-only', async t => {
  const f = fixture(t), draft = f.save(), approval = f.confirm(draft);
  f.source({ active: false });
  assert.equal((await f.approvals.approve(approval.id, approval.version)).status, 'failed'); assert.equal(f.executions, 0);
  assert.equal(f.inbox.read(ref).available, false);
  assert.throws(() => f.inbox.post(ref, { sourceVersion: 1, text: 'test', key: 'x' }), status(409));
  assert.throws(() => f.save(), status(409)); assert.throws(() => f.confirm(draft), status(409));
});

test('reply-disabled sources allow draft saving but refuse confirmation without discarding it', t => {
  const f = fixture(t); f.source({ replyAvailable: false });
  const draft = f.save({ kind: 'reply', text: '待发送回复' });
  assert.throws(() => f.confirm(draft), /不能发送回复/);
  assert.equal(f.inbox.read(ref).suggestions[0]?.status, 'draft'); assert.equal(f.approvals.list().length, 0);
});

for (const mutate of [
  (a: Approval) => ({ ...a, version: 2 }),
  (a: Approval) => ({ ...a, title: 'tampered' }),
  (a: Approval) => ({ ...a, kind: 'plugin:other.action' as const }),
  (a: Approval) => ({ ...a, params: { ...a.params, contentHash: 'forged' } }),
  (a: Approval) => ({ ...a, params: { ...a.params, action: { kind: 'conclusion', text: '替换' } } }),
]) test(`stored approval mutations cannot execute (${mutate.toString()})`, async t => {
  const f = fixture(t), draft = f.save(), approval = f.confirm(draft);
  const changed = mutate(approval); f.store.put('approvals', changed.id, changed);
  assert.equal((await f.approvals.approve(changed.id, changed.version)).status, 'failed'); assert.equal(f.executions, 0);
});

test('even a real running approval cannot be substituted by a forged id, params or kind', async t => {
  const f = fixture(t), draft = f.save(), approval = f.confirm(draft);
  const execution = f.approvals.approve(approval.id, approval.version), running = f.approvals.list()[0]!;
  for (const patch of [{ id: 'fake' }, { params: {} }, { kind: 'plugin:other.action' as const }]) {
    assert.throws(() => f.inbox.executeApproved({ ...running, ...patch }), status(409));
  }
  assert.equal((await execution).status, 'completed'); assert.equal(f.executions, 1);
});

for (const bad of [
  { kind: 'todo', title: '', notes: 'x' }, { kind: 'todo', title: 'x', notes: '' },
  { kind: 'reply', text: 'x', id: 'model-id' }, { kind: 'conclusion', text: 'x', status: 'applied' },
  { kind: 'reply', text: 'x', approvalId: 'a' }, { kind: 'reply', text: 'x', source: ref },
  { kind: 'dispatch', executorId: 'a', prompt: 'p', doneWhen: 'd', expectMinutes: 0 },
  { kind: 'dispatch', executorId: 'a', prompt: 'p', doneWhen: 'd', expectMinutes: 1.5 },
  { kind: 'dispatch', executorId: '', prompt: 'p', doneWhen: 'd', expectMinutes: 1 },
  { kind: 'dispatch', executorId: 'a', prompt: 'p', doneWhen: '', expectMinutes: 1 },
  { kind: 'dispatch', executorId: 'a', prompt: 'p', doneWhen: 'd', expectMinutes: 1, cwd: '' },
  { kind: 'unknown', text: 'x' },
]) test(`strict validation rejects save and complete model envelope: ${JSON.stringify(bad)}`, async t => {
  const f = fixture(t);
  assert.throws(() => f.save(bad as InboxHandlingAction), status(400));
  f.think = async (_source, cid) => answer(cid, JSON.stringify({ suggestions: [action, bad] }));
  f.inbox.post(ref, { sourceVersion: 1, key: 'x', text: '分析' }); await settled();
  assert.equal(f.inbox.read(ref).suggestions.length, 0); assert.equal(f.inbox.read(ref).messages.length, 2);
});

for (const output of ['普通文本', '```json\n{"suggestions":[]}\n```', '{"suggestions":[],"status":"applied"}', JSON.stringify({ suggestions: [action, action, action, action, action] })]) {
  test(`non-action output stays in history without invented suggestions: ${output.slice(0, 30)}`, async t => {
    const f = fixture(t); f.think = async (_source, cid) => answer(cid, output);
    f.inbox.post(ref, { sourceVersion: 1, key: 'x', text: '分析' }); await settled();
    assert.equal(f.inbox.read(ref).suggestions.length, 0); assert.equal(f.inbox.read(ref).messages[1]?.text, output);
  });
}

test('valid model envelope accepts at most four actions and does not execute any of them', async t => {
  const f = fixture(t), actions: InboxHandlingAction[] = [action, { kind: 'reply', text: '回复' }, { kind: 'conclusion', text: '结论' }, { kind: 'dispatch', executorId: 'worker', prompt: '处理', doneWhen: '验证完成', expectMinutes: 3, cwd: '/tmp' }];
  f.think = async (_source, cid) => answer(cid, JSON.stringify({ answer: '好的', suggestions: actions }));
  f.inbox.post(ref, { sourceVersion: 1, key: 'x', text: '分析' }); await settled();
  assert.deepEqual(f.inbox.read(ref).suggestions.map(row => row.action), actions);
  assert.equal(f.executions, 0); assert.equal(f.approvals.list().length, 0);
});

for (const patch of [{ conversationId: 'main' }, { role: 'user' as const }, { status: 'pending' as const }]) {
  test(`foreign or incomplete think result is not stored: ${JSON.stringify(patch)}`, async t => {
    const f = fixture(t); f.think = async (_source, cid) => ({ ...answer(cid, 'SECRET'), ...patch });
    f.inbox.post(ref, { sourceVersion: 1, key: 'x', text: '分析' }); await settled();
    assert.equal(f.store.list<Message>('messages').length, 1);
    assert.equal(f.inbox.read(ref).requests[0]?.status, 'failed');
    assert.ok(!JSON.stringify(f.inbox.read(ref)).includes('SECRET'));
  });
}

test('late model completion after source changes cannot create usable suggestions, including scope restoration', async t => {
  const f = fixture(t), gate = deferred<Message>(); f.think = async () => gate.promise;
  const pending = f.inbox.post(ref, { sourceVersion: 1, key: 'x', text: '分析' }); await settled();
  f.source({ projectId: 'p2' }); assert.equal(f.inbox.read(ref).requests.length, 0);
  f.source({ projectId: undefined });
  gate.resolve(answer(pending.conversationId, JSON.stringify({ suggestions: [action] }))); await settled();
  assert.equal(f.inbox.read(ref).suggestions.length, 0); assert.equal(f.inbox.read(ref).messages.length, 2);
});

test('restart recovers pending and executing as unknown, preserves messages and never replays', async t => {
  const f = fixture(t), request = f.inbox.post(ref, { sourceVersion: 1, key: 'x', text: '分析' }); await settled();
  const draft = f.save(), approval = f.confirm(draft);
  await f.restart(() => {
    const req = f.store.get<Record<string, unknown>>('inbox-handling.requests', request.id)!;
    f.store.put('inbox-handling.requests', request.id, { ...req, status: 'pending' });
    const row = f.store.get<InboxSuggestion>('inbox-handling.suggestions', draft.id)!;
    f.store.put('inbox-handling.suggestions', draft.id, { ...row, status: 'executing' });
    f.store.put('approvals', approval.id, { ...approval, status: 'running' });
  });
  assert.equal(f.inbox.read(ref).requests[0]?.status, 'unknown');
  assert.equal(f.inbox.read(ref).suggestions[0]?.status, 'unknown');
  assert.equal(f.approvals.list()[0]?.status, 'unknown'); assert.equal(f.thinks, 1); assert.equal(f.executions, 0);
  assert.equal(f.inbox.post(ref, { sourceVersion: 1, key: 'x', text: '分析' }).status, 'unknown');
  assert.throws(() => f.inbox.save(ref, { sourceVersion: 1, id: draft.id, version: 1, action }), status(409));
  assert.equal(f.save().status, 'draft');
});

for (const delivery of ['unknown', 'no']) test(`execution failure ${delivery} is sanitized, never automatically retried`, async t => {
  const f = fixture(t); f.execute = async () => { throw Object.assign(new Error('SECRET credential'), { delivery }); };
  const draft = f.save(), approval = f.confirm(draft);
  const result = await f.approvals.approve(approval.id, approval.version);
  assert.equal(result.status, delivery === 'unknown' ? 'unknown' : 'failed');
  assert.equal(f.inbox.read(ref).suggestions[0]?.status, delivery === 'unknown' ? 'unknown' : 'draft');
  assert.ok(!JSON.stringify(f.inbox.read(ref)).includes('SECRET')); assert.ok(!JSON.stringify(result).includes('SECRET'));
  await assert.rejects(f.approvals.approve(approval.id, approval.version), status(409)); assert.equal(f.executions, 1);
  const serialized = JSON.stringify(f.events.since(0));
  assert.ok(!serialized.includes('credential')); assert.ok(!serialized.includes('核对来源')); assert.ok(!serialized.includes('来源正文'));
});

test('think failures do not disclose exception contents; close waits for jobs and rejects new calls', async t => {
  const f = fixture(t), gate = deferred<Message>(); f.think = async () => gate.promise;
  f.inbox.post(ref, { sourceVersion: 1, key: 'x', text: '分析' }); await settled();
  let done = false; const closing = f.inbox.close().then(() => { done = true; });
  await settled(); assert.equal(done, false);
  for (const call of [() => f.inbox.read(ref), () => f.inbox.post(ref, { sourceVersion: 1, key: 'y', text: 'x' }), () => f.save(), () => f.inbox.confirm(ref, { sourceVersion: 1, id: 'x', version: 1 }), () => f.inbox.executeApproved({} as Approval)]) assert.throws(call, status(503));
  gate.reject(new Error('SECRET bearer token')); await closing; assert.equal(done, true);
  const rows = f.store.list<{ status: string; error?: string }>('inbox-handling.requests');
  assert.equal(rows[0]?.status, 'failed'); assert.ok(!JSON.stringify(rows).includes('SECRET'));
});

test('close also waits for already claimed external execution', async t => {
  const f = fixture(t), gate = deferred<Json>(); f.execute = async () => gate.promise;
  const draft = f.save(), approval = f.confirm(draft), executing = f.approvals.approve(approval.id, approval.version);
  await settled(); assert.equal(f.executions, 1);
  let done = false; const closing = f.inbox.close().then(() => { done = true; }); await settled(); assert.equal(done, false);
  gate.resolve({ delivered: true }); await closing; assert.equal((await executing).status, 'completed'); assert.equal(done, true);
});

test('async readSource/proposal callbacks are rejected before invoking them; thenable wrappers roll back', t => {
  const f = fixture(t);
  let called = false;
  const base: InboxHandlingOptions = { store: f.store, events: f.events, available: () => ({ available: true }), readSource: () => f.source(), think: async (_s, cid) => answer(cid), proposeApproval: input => f.approvals.propose(input), execute: async () => ({}) };
  assert.throws(() => createInboxHandling({ ...base, readSource: (async () => { called = true; return f.source(); }) as unknown as InboxHandlingOptions['readSource'] }), /同步/);
  assert.throws(() => createInboxHandling({ ...base, proposeApproval: (async (input: Pick<Approval, 'kind' | 'title' | 'details' | 'params'>) => { called = true; return f.approvals.propose(input); }) as unknown as InboxHandlingOptions['proposeApproval'] }), /同步/);
  assert.equal(called, false);
  const wrapping = createInboxHandling({ ...base, proposeApproval: ((input: Pick<Approval, 'kind' | 'title' | 'details' | 'params'>) => Promise.resolve(f.approvals.propose(input))) as unknown as InboxHandlingOptions['proposeApproval'] });
  const row = wrapping.save(ref, { sourceVersion: 1, action });
  assert.throws(() => wrapping.confirm(ref, { sourceVersion: 1, id: row.id, version: row.version }), /同步/);
  assert.equal(f.approvals.list().length, 0);
  assert.equal(wrapping.read(ref).suggestions[0]?.status, 'draft');
});

test('pending confirmation survives restart; stale source/suggestion versions and other sources cannot edit it', async t => {
  const f = fixture(t), draft = f.save(), approval = f.confirm(draft);
  await f.restart(); assert.equal(f.confirm(draft).id, approval.id); assert.equal(f.approvals.list().length, 1);
  assert.throws(() => f.inbox.confirm(ref, { sourceVersion: 2, id: draft.id, version: 1 }), status(409));
  assert.throws(() => f.inbox.save(ref, { sourceVersion: 1, id: draft.id, version: 2, action }), status(409));
  const other: InboxHandlingRef = { kind: 'personal', id: 'two' };
  f.store.put('test.sources', other.id, { ...f.source(), ...other });
  assert.throws(() => f.inbox.confirm(other, { sourceVersion: 1, id: draft.id, version: 1 }), status(409));
  assert.throws(() => f.inbox.save(other, { sourceVersion: 1, id: draft.id, version: 1, action }), status(409));
  assert.equal(f.inbox.read(ref).suggestions[0]?.status, 'submitted');
});

test('same-version suggestion content tampering is checked against approval before any external I/O', async t => {
  const f = fixture(t), draft = f.save(), approval = f.confirm(draft);
  const row = f.store.get<InboxSuggestion>('inbox-handling.suggestions', draft.id)!;
  f.store.put('inbox-handling.suggestions', draft.id, { ...row, action: { kind: 'reply', text: '不同内容' } });
  assert.equal((await f.approvals.approve(approval.id, approval.version)).status, 'failed');
  assert.equal(f.executions, 0);
});

test('source changing during think is rechecked on completion without requiring a read', async t => {
  const f = fixture(t), gate = deferred<Message>(); f.think = async () => gate.promise;
  const pending = f.inbox.post(ref, { sourceVersion: 1, key: 'x', text: '分析' }); await settled();
  f.source({ active: false });
  gate.resolve(answer(pending.conversationId, JSON.stringify({ suggestions: [action] }))); await settled();
  assert.equal(f.store.list('inbox-handling.suggestions').length, 0);
  assert.equal(f.store.list<Message>('messages').length, 2);
});

test('suggestion claim does not hold a transaction across external awaits, and executing/applied cannot be reused', async t => {
  const f = fixture(t), gate = deferred<Json>(); f.execute = async () => gate.promise;
  const draft = f.save(), approval = f.confirm(draft), job = f.approvals.approve(approval.id, approval.version);
  await settled();
  assert.throws(() => f.inbox.save(ref, { sourceVersion: 1, id: draft.id, version: 1, action }), status(409));
  const independent = f.save(); assert.notEqual(independent.id, draft.id);
  assert.equal(f.confirm(independent).status, 'pending');
  gate.resolve({ accepted: true }); await job;
  assert.throws(() => f.inbox.save(ref, { sourceVersion: 1, id: draft.id, version: 1, action }), status(409));
});

test('proposal and its events roll back together when synchronous persistence fails', t => {
  const f = fixture(t);
  const inbox = createInboxHandling({ store: f.store, events: {
    ...f.events,
    publish(type, data) {
      f.events.publish(type, data);
      if (type === 'inbox-handling.changed' && data && typeof data === 'object' && 'status' in data && data.status === 'submitted') throw new Error('persistence failed');
      return f.events.since(0).at(-1)!;
    },
  }, available: () => ({ available: true }), readSource: () => f.source(), think: async (_s, cid) => answer(cid), execute: async () => ({}), proposeApproval: input => f.approvals.propose(input) });
  const draft = inbox.save(ref, { sourceVersion: 1, action }), before = f.events.since(0).length;
  assert.throws(() => inbox.confirm(ref, { sourceVersion: 1, id: draft.id, version: 1 }), /persistence failed/);
  assert.equal(f.approvals.list().length, 0); assert.equal(f.events.since(0).length, before);
  assert.equal(inbox.read(ref).suggestions[0]?.status, 'draft'); assert.equal(f.store.list('inbox-handling.approvals').length, 0);
});

for (const mode of ['throw', 'invalid-receipt']) test(`uncertain external outcome is unknown: ${mode}`, async t => {
  const f = fixture(t);
  f.execute = async () => { if (mode === 'throw') throw new Error('SECRET external failure'); return { count: Number.NaN }; };
  const draft = f.save(), approval = f.confirm(draft);
  const result = await f.approvals.approve(approval.id, approval.version);
  assert.equal(result.status, 'unknown'); assert.equal(f.inbox.read(ref).suggestions[0]?.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('SECRET')); assert.equal(f.executions, 1);
});
