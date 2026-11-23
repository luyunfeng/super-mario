import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createEventbox } from '../packages/core/src/eventbox.ts';
import { createSchedules } from '../packages/core/src/schedules.ts';
import { createApprovalService } from '../packages/core/src/approvals.ts';
import { createScheduledWork, scheduledWorkApprovalKind } from '../packages/core/src/scheduled-work.ts';
import type { Approval, Json, Message, Project, Run, Todo } from '../packages/protocol/src/index.ts';
import type { ScheduledWorkInput, ScheduledWorkOccurrence } from '../packages/protocol/src/scheduled-work.ts';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'scheduled-work-'));
  const path = join(dir, 'db.sqlite');
  let store = createStore(path);
  let time = Date.parse('2026-01-01T00:00:00Z');
  let enabled = true, authorized = true, briefFail = false;
  let briefCount = 0, dispatchCount = 0;
  let hold: (() => Promise<Json>) | undefined;
  function open() {
    const events = createEventBus(store);
    const eventbox = createEventbox({ store, events, now: () => time });
    const schedules = createSchedules({ store, eventbox, now: () => time });
    const approvals = createApprovalService({ store, events, execute: async a => {
      if (a.kind === scheduledWorkApprovalKind) return work.approveCreation(a);
      work.assertDispatchCurrent(a);
      dispatchCount++;
      const id = `run-${a.id}`;
      store.put<Run>('runs', id, { id, executorId: String(a.params.executorId), conversationId: 'main', sourceMessageId: 'u', prompt: String(a.params.prompt), status: 'running', output: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
      store.put('dispatch-keys', `approval:${a.id}:${a.version}`, id);
      return { runId: id };
    } });
    const work = createScheduledWork({ store, events, schedules, now: () => time, proposeApproval: a => approvals.propose(a), enabled: () => enabled,
      authorize: () => authorized,
      brief: async () => { briefCount++; if (briefFail) throw new Error('uncertain'); if (hold) return hold(); return { text: '只读程序事实', messageId: 'brief-ref' }; },
    });
    return { events, eventbox, schedules, approvals, work };
  }
  let s = open();
  const source: Message = { id: 'u', role: 'user', origin: 'user', conversationId: 'main', text: '每天检查项目', createdAt: '2026-01-01T00:00:00Z' };
  store.put('messages', 'u', source);
  const f = {
    get store() { return store; }, get work() { return s.work; }, get approvals() { return s.approvals; }, get schedules() { return s.schedules; }, get events() { return s.events; }, get eventbox() { return s.eventbox; },
    get briefCount() { return briefCount; }, get dispatchCount() { return dispatchCount; },
    setEnabled(value: boolean) { enabled = value; }, setAuthorized(value: boolean) { authorized = value; },
    failBrief() { briefFail = true; }, holdBrief(fn: () => Promise<Json>) { hold = fn; },
    propose(patch: Partial<ScheduledWorkInput> = {}) { return s.work.propose({ key: 'k', title: '检查', schedule: { kind: 'interval', everySec: 60 }, action: { kind: 'brief' }, ...patch }, 'u'); },
    async activate(patch: Partial<ScheduledWorkInput> = {}) { const a = f.propose(patch); const approved = await s.approvals.approve(a.id, a.version); assert.equal(approved.status, 'completed', approved.error); return approved; },
    due(at: string) { time = Date.parse(at); s.schedules.tick(); return s.eventbox.events().find(e => e.type === 'schedule.due')!; },
    async restart() { s.work.close(); await s.approvals.close(); s.schedules.close(); await s.eventbox.close(); store.close(); store = createStore(path); s = open(); },
  };
  t.after(async () => { s.work.close(); await s.approvals.close(); s.schedules.close(); await s.eventbox.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}
const dispatch: ScheduledWorkInput['action'] = { kind: 'dispatch', executorId: 'local/codex', prompt: '检查测试', doneWhen: '报告测试结果', expectMinutes: 10, cwd: '/tmp' };

test('preview does not activate schedules; approval creates persistent owner schedule idempotently', async t => {
  const f = fixture(t);
  const legacy = f.schedules.forOwner('daily-brief').create({ name: 'morning', kind: 'cron', cron: '0 9 * * *', tz: 'Asia/Shanghai' });
  const a = f.propose();
  assert.equal(a.kind, scheduledWorkApprovalKind);
  assert.equal(f.schedules.list().length, 1);
  assert.equal(f.dispatchCount + f.briefCount, 0);
  assert.throws(() => f.work.approveCreation(a), /审批执行入口/);
  assert.equal(f.propose().id, a.id);
  const done = await f.approvals.approve(a.id, a.version);
  assert.equal(done.status, 'completed', done.error);
  const before = f.schedules.list();
  assert.equal(before[1].owner, 'daily-brief');
  assert.deepEqual(f.work.approveCreation(done), done.result);
  await f.restart();
  assert.deepEqual(f.work.approveCreation(done), done.result);
  assert.deepEqual(f.schedules.list(), before);
  assert.deepEqual(f.schedules.list()[0], legacy);
});

test('updated preview rejects old approval and edited approval params/version', async t => {
  const f = fixture(t);
  const old = f.propose(); const next = f.propose({ title: '新预览' });
  assert.equal((await f.approvals.approve(old.id, old.version)).status, 'failed');
  const edited = f.approvals.edit(next.id, next.version, { params: { ...next.params, sourceMessageId: 'forged' } });
  assert.equal((await f.approvals.approve(edited.id, edited.version)).status, 'failed');
  assert.equal(f.schedules.list().length, 0);
});

test('reject read-only/result/forged tool sources; host source and authorize are mandatory', t => {
  const f = fixture(t);
  for (const patch of [{ readOnly: true }, { origin: 'result' }, { role: 'assistant' }, { origin: 'model-result' }]) {
    const source = f.store.get<Message>('messages', 'u')!;
    f.store.put('messages', 'u', { ...source, ...patch });
    assert.throws(() => f.propose(), /原用户来源/);
    f.store.put('messages', 'u', source);
  }
  for (const patch of [{ __owner: 'daily-brief' }, { sourceMessageId: 'u' }, { action: { ...dispatch, __owner: 'core' } }]) {
    assert.throws(() => f.propose(patch as Partial<ScheduledWorkInput>), /字段/);
  }
  f.setAuthorized(false);
  assert.throws(() => f.propose(), /授权/);
  assert.equal(f.approvals.list().length, 0); assert.equal(f.schedules.list().length, 0);
});

test('ScheduleApi validates interval, cron and timezone during preview with rollback', t => {
  const f = fixture(t);
  for (const schedule of [{ kind: 'interval', everySec: 1 }, { kind: 'once', at: '2026-01-01T01:00:00' }, { kind: 'cron', cron: 'bad', tz: 'UTC' }, { kind: 'cron', cron: '0 9 * * *', tz: 'Mars/Olympus' }, { kind: 'interval', everySec: 60, tz: 'bad' }]) {
    assert.throws(() => f.propose({ schedule: schedule as ScheduledWorkInput['schedule'] }));
  }
  assert.equal(f.schedules.list().length, 0); assert.equal(f.approvals.list().length, 0);
});

test('once fires only once; event replay and SQLite restart retain result/message reference', async t => {
  const f = fixture(t);
  await f.activate({ schedule: { kind: 'once', at: '2026-01-01T01:00:00Z' } });
  const e = f.due('2026-01-01T02:00:00Z');
  assert.equal(f.schedules.list()[0].status, 'done');
  assert.equal((await f.work.handle(e)).status, 'done');
  assert.equal((await f.work.handle(e)).status, 'skip');
  await f.restart();
  assert.equal((await f.work.handle(e)).status, 'skip');
  f.due('2026-01-02T00:00:00Z');
  assert.equal(f.briefCount, 1);
  assert.deepEqual(f.store.list<ScheduledWorkOccurrence>('scheduled-work.occurrences')[0].result, { text: '只读程序事实', messageId: 'brief-ref' });
});

test('cron timezone uses real coalesce: only latest missed occurrence is consumed', async t => {
  const f = fixture(t);
  await f.activate({ schedule: { kind: 'cron', cron: '0 9 * * *', tz: 'Asia/Shanghai' } });
  assert.equal(f.schedules.list()[0].nextAt, '2026-01-01T01:00:00.000Z');
  const e = f.due('2026-01-04T02:00:00Z');
  assert.equal((e.data as { scheduledFor: string }).scheduledFor, '2026-01-04T01:00:00.000Z');
  assert.equal((e.data as { missedCount: number }).missedCount, 3);
  assert.equal((await f.work.handle(e)).status, 'done'); assert.equal(f.briefCount, 1);
});

test('暂停阻断未来触发，恢复核对版本，暂停前的派发审批仍可单独处理', async t => {
  const f = fixture(t);
  const creation = await f.activate({ action: dispatch });
  const due = f.due('2026-01-01T00:01:00Z');
  await f.work.handle(due);
  const row = f.work.list()[0];
  const paused = f.work.setPaused(row.id, row.version, row.scheduleVersion!, true);
  assert.deepEqual(f.work.approveCreation(creation), creation.result);
  await f.restart();
  f.due('2026-01-01T00:05:00Z');
  assert.equal(f.eventbox.events().filter(e => e.type === 'schedule.due').length, 1);
  assert.throws(() => f.work.setPaused(row.id, row.version, row.scheduleVersion!, false), /版本/);
  const original = f.approvals.list().find(a => a.kind === 'dispatch')!;
  assert.equal((await f.approvals.approve(original.id, original.version)).status, 'completed');
  assert.equal(f.dispatchCount, 1);
  const resumed = f.work.setPaused(row.id, row.version, paused.scheduleVersion, false);
  assert.equal(resumed.scheduleStatus, 'active');
  assert.equal((await f.work.handle(due)).status, 'skip');
  f.due('2026-01-01T00:06:00Z');
  assert.equal(f.eventbox.events().filter(e => e.type === 'schedule.due').length, 2);
  assert.equal(f.dispatchCount, 1);
});

test('pending and unknown dispatch approvals do not accumulate, including after restart', async t => {
  const f = fixture(t); await f.activate({ action: dispatch });
  const e = f.due('2026-01-01T00:01:00Z');
  assert.equal((await f.work.handle(e)).status, 'done');
  assert.equal(f.dispatchCount, 0);
  const a = f.approvals.list().find(a => a.kind === 'dispatch')!;
  assert.deepEqual(a.params.prompt, dispatch.kind === 'dispatch' ? dispatch.prompt : '');
  assert.equal((await f.work.handle(f.due('2026-01-01T00:02:00Z'))).status, 'skip');
  f.store.put('approvals', a.id, { ...a, status: 'running' });
  await f.restart();
  assert.equal(f.approvals.list().find(x => x.id === a.id)?.status, 'unknown');
  assert.equal((await f.work.handle(f.due('2026-01-01T00:03:00Z'))).status, 'skip');
  assert.equal(f.approvals.list().filter(a => a.kind === 'dispatch').length, 1);
});

test('active/unknown Runs block next dispatch; terminal Run permits a new approval', async t => {
  const f = fixture(t); await f.activate({ action: dispatch });
  await f.work.handle(f.due('2026-01-01T00:01:00Z'));
  const a = f.approvals.list().find(a => a.kind === 'dispatch')!;
  assert.equal((await f.approvals.approve(a.id, a.version)).status, 'completed');
  assert.equal(f.dispatchCount, 1);
  const run = f.store.list<Run>('runs')[0];
  assert.equal((await f.work.handle(f.due('2026-01-01T00:02:00Z'))).status, 'skip');
  f.store.put('runs', run.id, { ...run, status: 'unknown' });
  assert.equal((await f.work.handle(f.due('2026-01-01T00:03:00Z'))).status, 'skip');
  f.store.put('runs', run.id, { ...run, status: 'completed' });
  assert.equal((await f.work.handle(f.due('2026-01-01T00:04:00Z'))).status, 'done');
  assert.equal(f.approvals.list().filter(a => a.kind === 'dispatch').length, 2);
  assert.equal(f.dispatchCount, 1);
});

test('cancel/update/disable invalidate backlog and old dispatch approval', async t => {
  for (const mode of ['cancel', 'update', 'disable', 'schedule-edit', 'owner-disable', 'rebind'] as const) {
    const f = fixture(t); await f.activate({ action: dispatch });
    const e = f.due('2026-01-01T00:01:00Z'); await f.work.handle(e);
    const a = f.approvals.list().find(a => a.kind === 'dispatch')!;
    if (mode === 'cancel') f.work.cancel(f.work.list()[0].id);
    if (mode === 'update') f.propose({ title: '新计划', action: dispatch });
    if (mode === 'disable') f.setEnabled(false);
    if (mode === 'owner-disable') f.schedules.ownerEnabled('daily-brief', false);
    if (mode === 'rebind') f.setAuthorized(false);
    if (mode === 'schedule-edit') { const s = f.schedules.list()[0]; f.schedules.forOwner('daily-brief').update(s.id, { everySec: 120 }, s.version); }
    assert.throws(() => f.work.assertDispatchCurrent(a));
    assert.equal((await f.work.handle(e)).status, 'skip');
    assert.equal((await f.approvals.approve(a.id, a.version)).status, 'failed');
    assert.equal(f.dispatchCount, 0);
  }
});

test('project archival and todo completion immediately stop schedules via domain events', async t => {
  for (const mode of ['project', 'todo'] as const) {
    const f = fixture(t);
    const project: Project = { id: 'p', name: 'p', description: '', createdAt: '', updatedAt: '' };
    const todo: Todo = { id: 't', projectId: 'p', title: 't', notes: '', createdAt: '', updatedAt: '' };
    f.store.put('projects', 'p', project); f.store.put('todos', 't', todo);
    await f.activate({ action: dispatch, projectId: 'p', todoId: 't' });
    const e = f.due('2026-01-01T00:01:00Z'); await f.work.handle(e);
    const a = f.approvals.list().find(a => a.kind === 'dispatch')!;
    if (mode === 'project') { f.store.put('projects', 'p', { ...project, archivedAt: 'now' }); f.events.publish('projects.changed', { id: 'p' }); }
    else { f.store.put('todos', 't', { ...todo, completedAt: 'now' }); f.events.publish('todos.changed', { id: 't' }); }
    assert.equal(f.schedules.list()[0].status, 'cancelled');
    assert.throws(() => f.work.assertDispatchCurrent(a));
    assert.equal((await f.work.handle(e)).status, 'skip');
  }
});

test('concurrent event delivery claims once before await and unknown brief never replays', async t => {
  const f = fixture(t); await f.activate();
  let release!: (result: Json) => void;
  f.holdBrief(() => new Promise(resolve => { release = resolve; }));
  const e = f.due('2026-01-01T00:01:00Z');
  const first = f.work.handle(e);
  assert.equal((await f.work.handle(e)).status, 'skip');
  release({ text: 'facts' }); assert.equal((await first).status, 'done');
  f.failBrief(); const bad = f.due('2026-01-01T00:02:00Z');
  assert.equal((await f.work.handle(bad)).status, 'failed');
  await f.restart(); assert.equal((await f.work.handle(bad)).status, 'skip');
  assert.equal(f.briefCount, 2);
});

test('concurrent creation approvals and concurrent dispatch events are idempotent', async t => {
  const f = fixture(t); const a = f.propose({ action: dispatch });
  const approved = await Promise.allSettled([f.approvals.approve(a.id, a.version), f.approvals.approve(a.id, a.version)]);
  assert.equal(approved.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.schedules.list().length, 1);
  const e = f.due('2026-01-01T00:01:00Z');
  const results = await Promise.all([f.work.handle(e), f.work.handle(e)]);
  assert.equal(results.filter(r => r.status === 'done').length, 1);
  await f.restart(); assert.equal((await f.work.handle(e)).status, 'skip');
  assert.equal(f.approvals.list().filter(a => a.kind === 'dispatch').length, 1);
});

test('ordinary dispatch passes; edited scheduled dispatch and forged occurrence are rejected', async t => {
  const f = fixture(t); await f.activate({ action: dispatch });
  const plain = f.approvals.propose({ kind: 'dispatch', title: '普通派发', details: '', params: {} });
  assert.equal(f.work.assertDispatchCurrent(plain), undefined);
  const forged = f.approvals.propose({ kind: 'dispatch', title: '伪造', details: '', params: { scheduledWorkOccurrence: 'fake' } });
  assert.throws(() => f.work.assertDispatchCurrent(forged));
  await f.work.handle(f.due('2026-01-01T00:01:00Z'));
  const a = f.approvals.list().find(a => a.params.scheduledWorkOccurrence && a.id !== forged.id)!;
  const edited = f.approvals.edit(a.id, a.version, { params: { prompt: '扩大权限' } });
  assert.throws(() => f.work.assertDispatchCurrent(edited));
  assert.throws(() => f.work.assertDispatchCurrent(a.id));
});

test('scope changes without events still stop due handling and approval execution', async t => {
  const f = fixture(t); await f.activate({ action: dispatch });
  const e = f.due('2026-01-01T00:01:00Z'); await f.work.handle(e);
  f.store.put('messages', 'u', { ...f.store.get<Message>('messages', 'u')!, readOnly: true });
  assert.equal((await f.work.handle(f.due('2026-01-01T00:02:00Z'))).status, 'skip');
  const a = f.approvals.list().find(a => a.kind === 'dispatch')!;
  assert.throws(() => f.work.assertDispatchCurrent(a));
  assert.equal(f.schedules.list()[0].status, 'cancelled');
});


test('new confirmed revision replaces invalid pending dispatch without reviving its approval', async t => {
  const f = fixture(t); await f.activate({ action: dispatch });
  await f.work.handle(f.due('2026-01-01T00:01:00Z'));
  const old = f.approvals.list().find(a => a.kind === 'dispatch')!;
  const preview = f.propose({ title: '新确认版本', action: dispatch });
  assert.throws(() => f.work.assertDispatchCurrent(old));
  assert.equal((await f.approvals.approve(preview.id, preview.version)).status, 'completed');
  assert.equal((await f.work.handle(f.due('2026-01-01T00:02:00Z'))).status, 'done');
  assert.equal(f.approvals.list().filter(a => a.kind === 'dispatch').length, 2);
  assert.throws(() => f.work.assertDispatchCurrent(old));
});

test('Eventbox subscription consumes genuine due event and ignores global daily briefs', async t => {
  const f = fixture(t); await f.activate();
  f.schedules.forOwner('daily-brief').create({ name: 'morning', kind: 'cron', cron: '* * * * *', tz: 'UTC' });
  const off = f.eventbox.subscribe('core', { name: 'scheduled-work-test', types: [{ type: 'schedule.due', version: 1 }], effects: 'none', handler: e => f.work.handle(e) });
  f.due('2026-01-01T00:01:00Z');
  await f.eventbox.drain();
  assert.equal(f.briefCount, 1);
  assert.equal(f.eventbox.deliveries().filter(d => d.status === 'done').length, 1);
  assert.equal(f.eventbox.deliveries().filter(d => d.status === 'skipped').length, 1);
  assert.deepEqual(f.work.list()[0].occurrences[0].result, { text: '只读程序事实', messageId: 'brief-ref' });
  off();
});

test('creation evidence edits and foreign/stale payloads cannot authorize a due event', async t => {
  const f = fixture(t); const creation = await f.activate();
  const e = f.due('2026-01-01T00:01:00Z');
  for (const changed of [{ ...e, source: 'plugin:fake' }, { ...e, typeVersion: 2 }, { ...e, staleIf: { ref: 'schedule:other', version: 1 } }, { ...e, data: { ...(e.data as object), payload: { scheduledWork: true, workId: 'fake', workVersion: 1 } } }]) {
    assert.equal((await f.work.handle(changed)).status, 'skip');
  }
  f.store.put('approvals', creation.id, { ...creation, params: { ...creation.params, sourceMessageId: 'other' } });
  assert.equal((await f.work.handle(e)).status, 'skip');
  assert.equal(f.briefCount, 0);
});

test('owner disable and scope revocation survive re-enable and reopening', async t => {
  const f = fixture(t); await f.activate({ action: dispatch });
  await f.work.handle(f.due('2026-01-01T00:01:00Z'));
  const a = f.approvals.list().find(a => a.kind === 'dispatch')!;
  f.setEnabled(false); f.work.sync(); f.setEnabled(true);
  await f.restart();
  assert.equal(f.work.list()[0].status, 'cancelled');
  assert.throws(() => f.work.assertDispatchCurrent(a));
  assert.equal((await f.approvals.approve(a.id, a.version)).status, 'failed');
  assert.equal(f.dispatchCount, 0);
});


test('runtime turn status changes preserve original user authorization; text edits revoke it', async t => {
  const f = fixture(t);
  const source = f.store.get<Message>('messages', 'u')!;
  f.store.put('messages', 'u', { ...source, status: 'pending' });
  const a = f.propose();
  f.store.put('messages', 'u', { ...source, status: 'done' });
  assert.equal((await f.approvals.approve(a.id, a.version)).status, 'completed');
  assert.equal((await f.work.handle(f.due('2026-01-01T00:01:00Z'))).status, 'done');
  f.store.put('messages', 'u', { ...source, status: 'done', text: '新的范围' });
  assert.equal((await f.work.handle(f.due('2026-01-01T00:02:00Z'))).status, 'skip');
  assert.equal(f.work.list()[0].status, 'cancelled');
});


test('只跳过指定周期，撤销校验原标记，重启和错过多期仍保留原排期', async t => {
  const f = fixture(t);
  const at = '2026-01-01T00:01:00.000Z';
  await f.activate({ schedule: { kind: 'interval', everySec: 60, anchorAt: at } });
  const [row] = f.work.list();
  const skip = (time: string, token?: string) => f.work.skipNext(row.id, row.version, row.scheduleVersion!, time, token);
  const marker = () => f.work.list()[0].occurrences.find(o => o.scheduledFor === at)?.ownerSkipToken;
  skip(at);
  const first = marker()!;
  skip(at);
  assert.equal(marker(), first);
  skip(at, first);
  assert.equal(marker(), undefined);
  skip(at);
  assert.throws(() => skip(at, first), /标记已改变/);
  await f.restart();
  const due = f.due(at);
  assert.equal((await f.work.handle(due)).status, 'skip');
  assert.equal(f.briefCount, 0);
  assert.throws(() => skip(at), /时间已改变/);
  const second = '2026-01-01T00:02:00.000Z';
  skip(second);
  f.due('2026-01-01T00:04:00Z');
  const latest = f.eventbox.events().find(e => e.sourceId.endsWith(':2026-01-01T00:04:00.000Z'))!;
  assert.equal((await f.work.handle(latest)).status, 'done');
  assert.equal(f.briefCount, 1);
  assert.equal(f.work.list()[0].occurrences.filter(o => o.ownerSkipToken).length, 2);
  const next = '2026-01-01T00:05:00.000Z';
  assert.equal(f.schedules.list()[0].nextAt, next);
  skip(next);
  f.work.setPaused(row.id, row.version, row.scheduleVersion!, true);
  assert.equal(f.work.list()[0].occurrences.some(o => o.scheduledFor === next), false);
});
