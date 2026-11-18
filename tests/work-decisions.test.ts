import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createWorkDecisions } from '../packages/core/src/work-decisions.ts';
import type { WorkDecisionsOptions } from '../packages/core/src/work-decisions.ts';
import type { BotScope, Message, Project, Todo } from '../packages/protocol/src/index.ts';

const global: BotScope = { kind: 'global' };
const project: BotScope = { kind: 'project', projectId: 'a' };
const task: BotScope = { kind: 'task', todoId: 'ta', projectId: 'a' };
const now = '2026-11-17T00:00:00.000Z';
const status = (code: number) => (error: unknown) => (error as { status?: number }).status === code;

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'super-mario-work-decisions-'));
  const path = join(dir, 'test.sqlite');
  const store = createStore(path);
  const stores = [store];
  t.after(() => { for (const connection of stores) connection.close(); rmSync(dir, { recursive: true, force: true }); });
  const events = createEventBus(store);
  for (const id of ['a', 'b']) store.put<Project>('projects', id, { id, name: id, description: '', createdAt: now, updatedAt: now });
  for (const [id, projectId] of [['ta', 'a'], ['ta2', 'a'], ['tb', 'b'], ['loose', undefined]]) {
    store.put<Todo>('todos', id!, { id: id!, title: id!, notes: '', projectId, createdAt: now, updatedAt: now });
  }
  function message(id = 'web', patch: Partial<Message> = {}) {
    const value: Message = { id, conversationId: 'main', role: 'user', text: 'PRIVATE 原始正文，不应复制到共享事实',
      origin: 'user', createdAt: now, status: 'pending', ...patch };
    store.put('messages', id, value);
    return value;
  }
  message();
  const decisions = createWorkDecisions({ store, events });
  return { store, events, decisions, message, record: (scope: BotScope = global, key = 'release') =>
    decisions.record({ key, text: '先完成本地验收', sourceMessageId: 'web', scope }),
  connect() { const connection = createStore(path); stores.push(connection); return connection; },
  authorized(authorize: NonNullable<WorkDecisionsOptions['authorize']>) { return createWorkDecisions({ store, events, authorize }); } };
}

test('Web user source becomes one fact referenceable from a separately authorized entry', t => {
  const f = fixture(t);
  const fact = f.record(project);
  let checks = 0;
  const otherEntry = f.authorized((scope, source) => {
    checks++;
    assert.deepEqual(scope, project);
    assert.equal(source.id, 'web');
  });
  assert.deepEqual(otherEntry.reference({ id: fact.id, version: 1 }), fact);
  assert.equal(checks, 1);
  assert.deepEqual(otherEntry.list(project).items, [fact]);
  assert.equal(f.store.list('work.decision-revisions').length, 1);
});

test('correction preserves identity and scope, records revisions, and invalidates old references', t => {
  const f = fixture(t);
  const original = f.record(project);
  f.message('correction', { projectId: 'a', text: 'PRIVATE 修正来源' });
  const corrected = f.decisions.correct({ id: original.id, version: 1, text: '先验收再发布', sourceMessageId: 'correction' });
  assert.equal(corrected.id, original.id);
  assert.equal(corrected.version, 2);
  assert.deepEqual(corrected.scope, project);
  assert.deepEqual(corrected.recordSource, original.source);
  assert.equal(corrected.source.messageId, 'correction');
  assert.equal(f.store.list('work.decision-revisions').length, 2);
  assert.throws(() => f.decisions.reference({ id: original.id, version: 1 }), status(409));
  assert.deepEqual(f.decisions.reference({ id: corrected.id, version: 2 }), corrected);
  assert.throws(() => f.decisions.correct({ id: original.id, version: 1, text: 'stale', sourceMessageId: 'web' }), status(409));
});

test('public records, references, events and stored proofs do not copy private source text or conversation identity', t => {
  const f = fixture(t);
  f.message('private', { conversationId: 'private-channel-identity', text: 'TOP_SECRET_RAW_HISTORY' });
  const ledger = f.authorized(() => {});
  const fact = ledger.record({ key: 'safe', text: '用户明确提供的工作摘要', sourceMessageId: 'private', scope: project });
  const output = JSON.stringify({ fact, get: ledger.get(fact.id), list: ledger.list(), ref: ledger.reference(fact),
    events: f.events.since(0), revisions: f.store.list('work.decision-revisions') });
  assert.ok(!output.includes('TOP_SECRET_RAW_HISTORY'));
  assert.ok(!output.includes('private-channel-identity'));
  assert.equal(fact.source.messageId, 'private');
  assert.equal(fact.source.createdAt, now);
  assert.ok(!JSON.stringify(fact).includes('Hash'));
});

test('source content and ownership tampering invalidate reads, references and further mutations', t => {
  const f = fixture(t);
  const source = f.message();
  const fact = f.record();
  f.message('correction');
  for (const patch of [{ text: '改写' }, { conversationId: 'other' }, { projectId: 'a' }, { todoId: 'ta' },
    { createdAt: '2026-11-18T00:00:00Z' }, { replyTo: 'new-owner' }, { role: 'assistant' as const },
    { origin: 'result' as const }, { readOnly: true }]) {
    f.store.put('messages', 'web', { ...source, ...patch });
    assert.throws(() => f.decisions.get(fact.id));
    assert.throws(() => f.decisions.reference(fact));
    assert.throws(() => f.decisions.list());
    assert.throws(() => f.decisions.correct({ id: fact.id, version: 1, text: '不能洗白', sourceMessageId: 'correction' }));
  }
  f.store.put('messages', 'web', { ...source, status: 'done' });
  assert.deepEqual(f.decisions.reference(fact), fact);
  f.store.remove('messages', 'web');
  assert.throws(() => f.decisions.reference(fact), status(409));
});

test('all correction sources remain evidence after later revisions', t => {
  const f = fixture(t);
  const original = f.record();
  const correction = f.message('c1');
  f.decisions.correct({ id: original.id, version: 1, text: '第二版', sourceMessageId: 'c1' });
  f.message('c2');
  const current = f.decisions.correct({ id: original.id, version: 2, text: '第三版', sourceMessageId: 'c2' });
  f.store.put('messages', 'c1', { ...correction, text: '篡改已被替代的修正来源' });
  assert.throws(() => f.decisions.reference(current), status(409));
});

test('scope filtering precedes counts and truncation; global sees all, project/task only exact scope', t => {
  const f = fixture(t);
  for (let n = 0; n < 101; n++) f.record({ kind: 'project', projectId: 'b' }, `other-${n}`);
  const a = f.record(project);
  const ta = f.record(task);
  f.record({ kind: 'task', todoId: 'ta2' });
  f.record(global);
  assert.deepEqual(f.decisions.list(project).items, [a]);
  assert.deepEqual(f.decisions.list(project).counts, { total: 1, active: 1, withdrawn: 0 });
  assert.equal(f.decisions.list(project).truncated, false);
  assert.deepEqual(f.decisions.list(task).items, [ta]);
  assert.deepEqual(f.decisions.list({ kind: 'unmarked' }).counts, { total: 0, active: 0, withdrawn: 0 });
  const all = f.decisions.list();
  assert.equal(all.counts.total, 105);
  assert.equal(all.items.length, 100);
  assert.equal(all.truncated, true);
});

test('source ownership prevents project/global escalation and task crossing even with host authorization', t => {
  const f = fixture(t);
  const ledger = f.authorized(() => {});
  f.message('project', { projectId: 'a', conversationId: 'arbitrary' });
  f.message('task', { todoId: 'ta', conversationId: 'arbitrary' });
  for (const scope of [global, { kind: 'project', projectId: 'b' }, { kind: 'task', todoId: 'tb' }]) {
    assert.throws(() => ledger.record({ key: 'bad', text: '不得扩大', sourceMessageId: 'project', scope: scope as BotScope }), status(403));
  }
  for (const scope of [global, project, { kind: 'task', todoId: 'ta2' }]) {
    assert.throws(() => ledger.record({ key: 'bad', text: '不得扩大', sourceMessageId: 'task', scope: scope as BotScope }), status(403));
  }
  assert.throws(() => f.record({ kind: 'unmarked' }), status(403));
  assert.throws(() => f.record({ kind: 'task', todoId: 'ta', projectId: 'b' }));
  assert.throws(() => f.record({ kind: 'project', projectId: 'missing' }));
  const fact = ledger.record({ key: 'ok', text: '事项事实', sourceMessageId: 'task', scope: { kind: 'task', todoId: 'ta' } });
  assert.deepEqual(fact.scope, task);
  const todo = f.store.get<Todo>('todos', 'ta')!;
  f.store.put('todos', 'ta', { ...todo, projectId: 'b' });
  assert.throws(() => ledger.reference(fact));
});

test('non-main identities require host authority, and authority is rechecked on all operations', t => {
  const f = fixture(t);
  for (const conversationId of ['bot:looks-valid', 'project:a:work', 'anything']) {
    f.message('entry', { conversationId });
    assert.throws(() => f.decisions.record({ key: 'entry', text: '事实', sourceMessageId: 'entry', scope: project }), status(403));
  }
  let allowed = true;
  let checks = 0;
  const ledger = f.authorized(() => { checks++; if (!allowed) throw Object.assign(new Error('host denied'), { status: 403 }); });
  const fact = ledger.record({ key: 'entry', text: '事实', sourceMessageId: 'entry', scope: project });
  ledger.get(fact.id);
  ledger.list(project);
  ledger.reference(fact);
  assert.equal(checks, 4);
  allowed = false;
  assert.throws(() => ledger.get(fact.id), status(403));
  assert.throws(() => ledger.list(project), status(403));
  assert.throws(() => ledger.reference(fact), status(403));
  assert.throws(() => ledger.correct({ ...fact, text: '改', sourceMessageId: 'web' }), status(403));
  assert.throws(() => ledger.withdraw({ ...fact, sourceMessageId: 'web' }), status(403));
  assert.throws(() => ledger.record({ key: 'main', text: '也须复核', sourceMessageId: 'web', scope: global }), status(403));
});

test('read-only, assistant and robot result messages never become authorization evidence', t => {
  const f = fixture(t);
  const ledger = f.authorized(() => {});
  const fact = f.record(project);
  for (const patch of [{ readOnly: true }, { role: 'assistant' as const }, { origin: 'result' as const }, { origin: 'notification' as const }]) {
    f.message('bad', patch);
    assert.throws(() => ledger.record({ key: 'bad', text: '拒绝', sourceMessageId: 'bad', scope: global }), status(403));
    assert.throws(() => ledger.correct({ ...fact, text: '拒绝', sourceMessageId: 'bad' }), status(403));
    assert.throws(() => ledger.withdraw({ ...fact, sourceMessageId: 'bad' }), status(403));
  }
  f.message('legacy', { origin: undefined });
  assert.equal(ledger.record({ key: 'legacy', text: '旧用户消息', sourceMessageId: 'legacy', scope: global }).version, 1);
});

test('concurrent entry requests through independent SQLite connections and restart are idempotent', async t => {
  const f = fixture(t);
  const second = f.connect();
  const other = createWorkDecisions({ store: second, events: createEventBus(second) });
  const input = { key: 'same', text: '相同明确摘要', sourceMessageId: 'web', scope: global };
  // Host methods are synchronous: concurrent requests execute atomic transactions in turn.
  const results = await Promise.all(Array.from({ length: 20 }, (_, n) => Promise.resolve().then(() => (n % 2 ? other : f.decisions).record(input))));
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  assert.equal(f.store.list('work.decisions').length, 1);
  assert.equal(f.store.list('work.decision-revisions').length, 1);
  assert.equal(f.events.since(0).length, 1);
  second.close();
  f.store.close();
  const restarted = f.connect();
  const ledger = createWorkDecisions({ store: restarted, events: createEventBus(restarted) });
  assert.deepEqual(ledger.record(input), results[0]);
  assert.throws(() => ledger.record({ ...input, text: '不同内容' }), status(409));
});

test('withdrawal persists as audit information and cannot be referenced or silently resurrected', t => {
  const f = fixture(t);
  const fact = f.record();
  f.message('withdraw');
  const withdrawn = f.decisions.withdraw({ ...fact, sourceMessageId: 'withdraw' });
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(withdrawn.version, 2);
  assert.throws(() => f.decisions.reference(fact), status(409));
  assert.throws(() => f.decisions.reference(withdrawn), status(409));
  assert.throws(() => f.record(), status(409));
  assert.throws(() => f.decisions.correct({ ...withdrawn, text: '复活', sourceMessageId: 'web' }), status(409));
  assert.deepEqual(f.decisions.list().counts, { total: 1, active: 0, withdrawn: 1 });
  assert.deepEqual(f.decisions.get(fact.id), withdrawn);
  assert.equal(f.store.list('work.decision-revisions').length, 2);
});

test('invalid input fails without writes and failed event persistence rolls back both ledgers', t => {
  const f = fixture(t);
  const input = { key: 'valid', text: '摘要', sourceMessageId: 'web', scope: global };
  for (const patch of [{ key: '' }, { key: 'x'.repeat(201) }, { text: '  ' }, { text: 'x'.repeat(4001) },
    { sourceMessageId: 'missing' }, { scope: undefined }]) {
    assert.throws(() => f.decisions.record({ ...input, ...patch } as typeof input));
  }
  const ledger = createWorkDecisions({ store: f.store, events: { ...f.events, publish() { throw new Error('event failure'); } } });
  assert.throws(() => ledger.record(input), /event failure/);
  assert.equal(f.store.list('work.decisions').length, 0);
  assert.equal(f.store.list('work.decision-revisions').length, 0);
  assert.equal(f.decisions.get('absent'), undefined);
});

test('correction cannot move project scope, and unrelated invalid evidence cannot affect filtered counts', t => {
  const f = fixture(t);
  f.message('project-a', { projectId: 'a' });
  const fact = f.decisions.record({ key: 'a', text: 'A 决定', scope: project, sourceMessageId: 'project-a' });
  f.message('project-b', { projectId: 'b' });
  f.decisions.record({ key: 'b', text: 'B 决定', scope: { kind: 'project', projectId: 'b' }, sourceMessageId: 'project-b' });
  assert.throws(() => f.decisions.correct({ ...fact, text: '跨项目修正', sourceMessageId: 'project-b' }), status(403));
  assert.throws(() => f.decisions.withdraw({ ...fact, sourceMessageId: 'project-b' }), status(403));
  f.store.remove('messages', 'project-b');
  assert.deepEqual(f.decisions.list(project).counts, { total: 1, active: 1, withdrawn: 0 });
  // Even a runtime caller supplying an extra scope field cannot move the original scope.
  const corrected = f.decisions.correct({ ...fact, scope: global, text: '仍是 A 决定', sourceMessageId: 'web' } as Parameters<typeof f.decisions.correct>[0]);
  assert.deepEqual(corrected.scope, project);
  const original = f.store.get<Message>('messages', 'project-a')!;
  f.store.put('messages', 'project-a', { ...original, text: '篡改最初来源' });
  assert.throws(() => f.decisions.reference(corrected), status(409));
});

test('async authorization is never silently accepted and callback arguments cannot alter evidence', t => {
  const f = fixture(t);
  const asyncLedger = f.authorized(async () => { throw new Error('late denial'); });
  assert.throws(() => asyncLedger.record({ key: 'async', text: '不得提前接受', sourceMessageId: 'web', scope: global }), status(403));
  assert.equal(f.store.list('work.decisions').length, 0);
  const ledger = f.authorized((scope, source) => {
    Object.assign(scope, { kind: 'global' });
    source.text = '被回调改写';
    source.conversationId = 'fake';
  });
  const fact = ledger.record({ key: 'safe', text: '安全摘要', sourceMessageId: 'web', scope: project });
  assert.deepEqual(fact.scope, project);
  assert.deepEqual(ledger.reference(fact), fact);
});
