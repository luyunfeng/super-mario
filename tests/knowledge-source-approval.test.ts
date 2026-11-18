import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Approval } from '../packages/protocol/src/index.ts';
import type { EventBus } from '../packages/plugin-sdk/src/index.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createApprovalService } from '../packages/core/src/approvals.ts';
import { createKnowledgeSourceApproval, KnowledgeSourceApprovalError, knowledgeSourceApprovalKind,
  type KnowledgeSourceApprovalJob } from '../packages/core/src/knowledge-source-approval.ts';

const code = (expected: string) => (error: unknown) => error instanceof KnowledgeSourceApprovalError && error.code === expected;
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'mario-source-approval-')), path = join(dir, 'test.sqlite');
  let store = createStore(path), events = createEventBus(store);
  let identity = { enabled: true, configured: true, key: 'digest-revision-account-1' };
  let eventFailure = false, approvedFailure = false, rejectedFailure = false, hostFailure = false;
  let eventFailureType: string | undefined;
  let reads = 0;
  const bus: EventBus = {
    publish(type, data) {
      const result = events.publish(type, data);
      if (eventFailure && (!eventFailureType || eventFailureType === type)) throw new Error('event persistence failure');
      return result;
    },
    subscribe: listener => events.subscribe(listener), since: id => events.since(id),
  };
  const job = { id: 'job-1', url: 'https://example.larkoffice.com/docx/one', layer: 'personal' as const,
    requestOrigin: 'agent' as const, sourceMessageId: 'source-1', status: 'queued' };
  store.put('messages', 'source-1', { id: 'source-1', role: 'user', origin: 'user', readOnly: true,
    conversationId: 'main', text: job.url, status: 'pending', createdAt: '2026-01-01' });
  store.put('knowledge.sources', job.id, job);
  store.put('projects', 'p1', { id: 'p1' });
  store.put('projects', 'p2', { id: 'p2' });
  const makeService = () => createApprovalService({ store, events: bus, execute: async approval => {
    assert.equal(approval.kind, knowledgeSourceApprovalKind);
    manager.approve(approval);
    return { authorized: true }; // Not a CLI read or an OAuth operation.
  } });
  let service = makeService();
  const makeManager = () => createKnowledgeSourceApproval({ store, events: bus,
    proposeApproval: input => service.propose(input), readerIdentity: () => identity,
    validateJob() { if (hostFailure) throw new Error('host scope failure with secret profile'); },
    onApproved(id) {
      const saved = store.get<Record<string, unknown>>('knowledge.sources', id)!;
      store.put('knowledge.sources', id, { ...saved, status: 'queued' });
      store.put('test.notifications', id, { approved: true });
      bus.publish('knowledge.curator.changed', { id });
      if (approvedFailure) throw new Error('requeue failure');
    },
    onRejected(id, reason) {
      const saved = store.get<Record<string, unknown>>('knowledge.sources', id);
      if (saved) store.put('knowledge.sources', id, { ...saved, status: 'failed', error: reason });
      if (rejectedFailure) throw new Error('reject failure');
    }, rejectApproval: (id, version) => { service.reject(id, version); },
  });
  let manager = makeManager();
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get store() { return store; }, get manager() { return manager; }, get service() { return service; }, job,
    get reads() { return reads; }, get identity() { return identity; },
    set identity(value) { identity = value; },
    set eventFailure(value: boolean) { eventFailure = value; },
    set eventFailureType(value: string) { eventFailureType = value; },
    set approvedFailure(value: boolean) { approvedFailure = value; },
    set rejectedFailure(value: boolean) { rejectedFailure = value; },
    set hostFailure(value: boolean) { hostFailure = value; },
    patch(patch: Record<string, unknown>) { store.put('knowledge.sources', job.id, { ...store.get('knowledge.sources', job.id) as object, ...patch }); },
    current() { return store.get<KnowledgeSourceApprovalJob>('knowledge.sources', job.id)!; },
    waiting(input: KnowledgeSourceApprovalJob = store.get<KnowledgeSourceApprovalJob>('knowledge.sources', job.id)!) {
      let id: string | undefined;
      assert.throws(() => manager.check(input), error => {
        if (!code('AWAITING_APPROVAL')(error)) return false;
        id = (error as KnowledgeSourceApprovalError).approvalId; return !!id;
      });
      this.patch({ status: 'awaiting_approval' });
      return service.list().find(item => item.id === id)!;
    },
    read(input: KnowledgeSourceApprovalJob = store.get<KnowledgeSourceApprovalJob>('knowledge.sources', job.id)!) { manager.check(input); reads++; },
    async restart() {
      await service.close(); store.close(); store = createStore(path); events = createEventBus(store);
      service = makeService(); manager = makeManager();
    },
  };
}

test('Agent readonly user source requires one real Approval execution before any read; lifecycle changes are harmless', async t => {
  const f = fixture(t), approval = f.waiting();
  assert.equal(f.reads, 0);
  assert.equal(approval.kind, knowledgeSourceApprovalKind);
  assert.deepEqual(approval.params, { jobId: f.job.id, url: f.job.url, layer: 'personal',
    sourceMessageId: 'source-1', readerKey: f.identity.key });
  assert.throws(() => f.read(), code('AWAITING_APPROVAL'));
  assert.equal(f.service.list().length, 1);
  // Agent input, reflected role, or a forged running object cannot approve pending.
  assert.throws(() => f.manager.approve({ ...approval, status: 'running' }), code('APPROVAL_INVALID'));
  const message = f.store.get<Record<string, unknown>>('messages', 'source-1')!;
  f.store.put('messages', 'source-1', { ...message, status: 'done', updatedAt: 'later' });
  f.patch({ updatedAt: 'later', status: 'awaiting_approval' });
  assert.equal((await f.service.approve(approval.id, approval.version)).status, 'completed');
  assert.equal(f.reads, 0);
  assert.deepEqual(f.store.get('test.notifications', f.job.id), { approved: true });
  f.read(); f.read(); assert.equal(f.reads, 2);
  await f.restart(); f.read(); assert.equal(f.reads, 3);
  assert.equal(f.service.list().length, 1);
});

test('Web/API direct intent bypasses proposal; legacy unknown origin never does', t => {
  const f = fixture(t);
  f.patch({ requestOrigin: 'web' }); f.read(); assert.equal(f.service.list().length, 0);
  f.patch({ requestOrigin: undefined }); f.waiting(); assert.equal(f.service.list().length, 1);
});

test('pending approval survives database reopen without a duplicate', async t => {
  const f = fixture(t), approval = f.waiting();
  await f.restart(); assert.equal(f.waiting().id, approval.id);
  assert.equal(f.service.list().length, 1);
});

for (const patch of [
  { url: 'https://example.larkoffice.com/docx/two' },
  { layer: 'project', projectId: 'p1' }, { requestOrigin: 'web' }, { sourceMessageId: undefined },
]) test(`grant cannot be borrowed after Job mutation ${JSON.stringify(patch)}`, async t => {
  const f = fixture(t), approval = f.waiting();
  await f.service.approve(approval.id, approval.version);
  f.patch(patch); assert.throws(() => f.read(), code('SOURCE_CHANGED'));
  f.patch({ ...f.job, status: 'queued' });
  assert.throws(() => f.read(), code('SOURCE_CHANGED')); // Invalidation is sticky.
  assert.equal(f.reads, 0); assert.equal(f.service.list().length, 1);
});

test('supplied identity/URL/scope must match stored Job; another Job needs another confirmation', async t => {
  const f = fixture(t), approval = f.waiting();
  await f.service.approve(approval.id, approval.version);
  assert.throws(() => f.read({ ...f.job, url: f.job.url + '/forged' }), code('SOURCE_CHANGED'));
  assert.throws(() => f.read({ ...f.job, projectId: 'p1' }), code('SOURCE_CHANGED'));
  f.store.put('knowledge.sources', 'job-2', { ...f.current(), id: 'job-2' });
  f.waiting({ ...f.current(), id: 'job-2' });
  assert.equal(f.service.list().length, 2); assert.equal(f.reads, 0);
});

for (const change of ['key', 'archived', 'deleted', 'cancelled', 'host', 'message-text', 'message-scope', 'message-role', 'message-origin', 'message-readonly', 'message-deleted']) {
  test(`current consent invalidates on ${change}`, async t => {
    const f = fixture(t);
    f.patch({ layer: 'project', projectId: 'p1' });
    const approval = f.waiting(); await f.service.approve(approval.id, approval.version);
    if (change === 'key') f.identity = { ...f.identity, key: 'different-revision-or-account' };
    else if (change === 'archived') f.store.put('projects', 'p1', { id: 'p1', archivedAt: 'now' });
    else if (change === 'deleted') f.store.remove('knowledge.sources', f.job.id);
    else if (change === 'cancelled') f.patch({ status: 'cancelled' });
    else if (change === 'host') f.hostFailure = true;
    else if (change === 'message-deleted') f.store.remove('messages', 'source-1');
    else {
      const fields: Record<string, object> = { 'message-text': { text: 'tampered' }, 'message-scope': { projectId: 'p2' },
        'message-role': { role: 'assistant' }, 'message-origin': { origin: 'result' }, 'message-readonly': { readOnly: false } };
      f.store.put('messages', 'source-1', { ...f.store.get('messages', 'source-1') as object, ...fields[change] });
    }
    f.manager.sync();
    assert.throws(() => f.read(f.job), error => error instanceof KnowledgeSourceApprovalError && error.code !== 'AWAITING_APPROVAL');
    assert.equal(f.reads, 0); assert.equal(f.service.list().length, 1);
    const invalidations = f.store.list<{ type: string; data: unknown }>('core.events').filter(e => e.type === 'knowledge.source-approval.invalidated');
    assert.equal(invalidations.length, 1);
    assert.deepEqual(Object.keys(invalidations[0]!.data as object).sort(), ['approvalId', 'jobId', 'reason']);
    f.manager.sync(); assert.equal(f.store.list<{ type: string }>('core.events').filter(e => e.type === 'knowledge.source-approval.invalidated').length, 1);
  });
}

for (const status of ['rejected', 'failed', 'unknown', 'cancelled']) test(`approval ${status} is never a successful replay`, async t => {
  const f = fixture(t), approval = f.waiting();
  if (status === 'rejected') f.service.reject(approval.id, approval.version);
  else {
    await f.service.approve(approval.id, approval.version);
    f.store.put('approvals', approval.id, { ...f.service.list()[0], status });
  }
  f.manager.sync(); assert.throws(() => f.read(), code('APPROVAL_INVALID'));
  assert.equal(f.store.get<{ status: string }>('knowledge.sources', f.job.id)?.status, 'failed');
  assert.equal(f.reads, 0);
});

test('edits/version changes and exact params tampering fail closed', async t => {
  const f = fixture(t), approval = f.waiting();
  const edited = f.service.edit(approval.id, approval.version, { title: 'edited' });
  assert.equal((await f.service.approve(edited.id, edited.version)).status, 'failed');
  assert.throws(() => f.read(), code('APPROVAL_INVALID'));
  assert.equal(f.reads, 0);
});

test('even a running approval cannot substitute params or id', async t => {
  const f = fixture(t), approval = f.waiting();
  const execution = f.service.approve(approval.id, approval.version);
  const running = f.service.list()[0]!;
  assert.equal(running.status, 'running');
  assert.throws(() => f.manager.approve({ ...running, params: { ...running.params, url: 'https://other/docx/a' } }), code('APPROVAL_INVALID'));
  assert.throws(() => f.manager.approve({ ...running, id: 'forged' }), code('APPROVAL_INVALID'));
  assert.equal((await execution).status, 'completed');
});

test('grant works during running execution but restart recovery unknown revokes it', async t => {
  const f = fixture(t), approval = f.waiting();
  await f.service.approve(approval.id, approval.version);
  const running = { ...f.service.list()[0]!, status: 'running' as const };
  f.store.put('approvals', running.id, running); f.read();
  await f.restart(); assert.equal(f.service.list()[0]?.status, 'unknown');
  assert.throws(() => f.read(), code('APPROVAL_INVALID'));
});

for (const mode of ['disabled', 'missing']) test(`${mode} reader creates no meaningless approval`, t => {
  const f = fixture(t);
  f.identity = { ...f.identity, enabled: mode !== 'disabled', configured: mode !== 'missing' };
  assert.throws(() => f.read(), code(mode === 'disabled' ? 'READER_DISABLED' : 'MISSING_PROFILE'));
  assert.equal(f.service.list().length, 0); assert.equal(f.reads, 0);
});

test('configuration change before approval execution fails and never requeues', async t => {
  const f = fixture(t), approval = f.waiting();
  f.identity = { ...f.identity, key: 'new-account-digest' };
  assert.equal((await f.service.approve(approval.id, approval.version)).status, 'failed');
  assert.equal(f.store.get('test.notifications', f.job.id), undefined);
  assert.throws(() => f.read(), code('CONNECTION_CHANGED'));
});

test('proposal event failure rolls back Approval, evidence, and durable events', t => {
  const f = fixture(t); f.eventFailure = true;
  assert.throws(() => f.manager.check(f.current()), /event persistence failure/);
  assert.equal(f.service.list().length, 0);
  assert.deepEqual(f.store.list('knowledge.source-approvals'), []);
  assert.deepEqual(f.store.list('core.events'), []);
  f.eventFailure = false; f.waiting(); assert.equal(f.service.list().length, 1);
});

for (const failure of ['event', 'callback']) test(`approve ${failure} failure rolls back grant and synchronous requeue`, async t => {
  const f = fixture(t), approval = f.waiting();
  if (failure === 'event') { f.eventFailureType = 'knowledge.curator.changed'; f.eventFailure = true; }
  else f.approvedFailure = true;
  // ApprovalService records execution failure outside the module transaction.
  await f.service.approve(approval.id, approval.version).catch(() => {});
  assert.equal(f.store.get<{ approved: boolean }>('knowledge.source-approvals', f.job.id)?.approved, false);
  assert.equal(f.store.get('test.notifications', f.job.id), undefined);
  assert.equal(f.store.get<{ status: string }>('knowledge.sources', f.job.id)?.status, 'awaiting_approval');
  assert.equal(f.reads, 0);
});

test('sync event/callback failure rolls back invalidation, host failure state, and own approval rejection', t => {
  const f = fixture(t), approval = f.waiting();
  f.identity = { ...f.identity, key: 'changed' };
  for (const failure of ['event', 'callback']) {
    f.eventFailure = failure === 'event'; f.rejectedFailure = failure === 'callback';
    assert.throws(() => f.manager.sync());
    assert.equal(f.store.get<{ invalid?: string }>('knowledge.source-approvals', f.job.id)?.invalid, undefined);
    assert.equal(f.store.get<{ status: string }>('knowledge.sources', f.job.id)?.status, 'awaiting_approval');
    assert.equal(f.service.list()[0]?.status, 'pending');
  }
  f.eventFailure = false; f.rejectedFailure = false; f.manager.sync();
  assert.equal(f.service.list().find(a => a.id === approval.id)?.status, 'rejected');
});

test('sync never rejects unrelated or edited approvals', async t => {
  const f = fixture(t); f.patch({ layer: 'project', projectId: 'p1' });
  const approval = f.waiting();
  const unrelated = f.service.propose({ kind: knowledgeSourceApprovalKind, title: 'another owner', details: '', params: approval.params });
  const edited = f.service.edit(approval.id, approval.version, { params: { ...approval.params, projectId: 'p2' } });
  f.manager.sync();
  assert.equal(f.service.list().find(a => a.id === unrelated.id)?.status, 'pending');
  assert.equal(f.service.list().find(a => a.id === edited.id)?.status, 'pending');
  assert.equal((await f.service.approve(edited.id, edited.version)).status, 'failed');
  assert.equal(f.reads, 0);
});

test('approved project p1 consent cannot be used for project p2', async t => {
  const f = fixture(t); f.patch({ layer: 'project', projectId: 'p1' });
  const approval = f.waiting(); await f.service.approve(approval.id, approval.version);
  f.patch({ projectId: 'p2' });
  assert.throws(() => f.read(), code('SOURCE_CHANGED'));
  assert.equal(f.reads, 0); assert.equal(f.service.list().length, 1);
});

test('message content changed before executeApproved refuses requeue', async t => {
  const f = fixture(t), approval = f.waiting();
  const message = f.store.get<Record<string, unknown>>('messages', 'source-1')!;
  f.store.put('messages', 'source-1', { ...message, text: 'different request' });
  assert.equal((await f.service.approve(approval.id, approval.version)).status, 'failed');
  assert.equal(f.store.get('test.notifications', f.job.id), undefined);
  assert.throws(() => f.read(), code('SOURCE_CHANGED'));
  assert.equal(f.reads, 0);
});

test('same-version stored params mutation is not the original approval', async t => {
  const f = fixture(t), approval = f.waiting();
  f.store.put('approvals', approval.id, { ...approval, params: { ...approval.params, readerKey: 'forged-key' } });
  assert.equal((await f.service.approve(approval.id, approval.version)).status, 'failed');
  assert.throws(() => f.read(), code('APPROVAL_INVALID'));
});

test('sourceRole or result reflection never gives Agent or legacy jobs Web intent', t => {
  const f = fixture(t);
  f.patch({ requestOrigin: undefined, sourceRole: 'user' });
  f.store.put('messages', 'source-1', { id: 'source-1', role: 'user', origin: 'result', readOnly: true,
    text: 'I authorize this source', conversationId: 'main' });
  const approval = f.waiting();
  assert.throws(() => f.manager.approve(approval), code('APPROVAL_INVALID'));
  assert.throws(() => f.read(), code('AWAITING_APPROVAL'));
  assert.equal(f.reads, 0);
});

test('native async host callback is rejected before it can run outside the Store transaction', t => {
  const f = fixture(t);
  let called = false;
  assert.throws(() => createKnowledgeSourceApproval({ store: f.store, events: createEventBus(f.store),
    proposeApproval: input => f.service.propose(input), readerIdentity: () => f.identity,
    onApproved: async () => { called = true; },
  }), /synchronous/);
  assert.equal(called, false);
});
