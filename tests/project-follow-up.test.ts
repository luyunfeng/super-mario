import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createEventbox } from '../packages/core/src/eventbox.ts';
import { createSchedules } from '../packages/core/src/schedules.ts';
import { createProjectFollowUp } from '../packages/core/src/project-follow-up.ts';
import type { ProjectBriefInput, ProjectFollowUpGrant } from '../packages/core/src/project-follow-up.ts';
import type { BriefingSettings, Project, Todo } from '../packages/protocol/src/index.ts';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'project-follow-up-'));
  const path = join(dir, 'test.sqlite');
  let store = createStore(path);
  let time = Date.parse('2026-01-01T00:00:00Z');
  const global: BriefingSettings = { timezone: 'UTC', morning: '09:00', evening: '18:00', intervalHours: 4, intervalEnabled: false, activeStart: '09:00', activeEnd: '21:00', awayNotifications: true };
  const sent: ProjectBriefInput[] = [];
  let fail = false;
  function open() {
    const events = createEventBus(store);
    const eventbox = createEventbox({ store, events, now: () => time });
    const schedules = createSchedules({ store, eventbox, now: () => time });
    const follow = createProjectFollowUp({ store, events, schedules, settings: () => global, enqueue: input => {
      sent.push(input);
      if (fail) throw new Error('uncertain');
    } });
    return { events, eventbox, schedules, follow };
  }
  let services = open();
  const f = {
    get store() { return store; },
    get events() { return services.events; },
    get schedules() { return services.schedules; },
    get follow() { return services.follow; },
    global, sent,
    fail() { fail = true; },
    project(id = 'p', automation: NonNullable<Project['followUp']>['automation'] = 'balanced', withFollow = true) {
      const project: Project = { id, name: `Project ${id}`, description: '', createdAt: '2025-12-01T00:00:00Z', updatedAt: '2026-01-01T08:00:00Z', ...(withFollow ? { followUp: { briefingTime: '09:00', overdueReminders: true, automation } } : {}) };
      store.put('projects', id, project);
      services.events.publish('projects.changed', { id });
      return project;
    },
    patch(patch: Partial<Project>, id = 'p') {
      store.put('projects', id, { ...store.get<Project>('projects', id)!, ...patch });
      services.events.publish('projects.changed', { id });
    },
    todo(id: string, projectId?: string, extra: Partial<Todo> = {}) {
      store.put<Todo>('todos', id, { id, title: `Todo ${id}`, notes: '', projectId, createdAt: '2025-12-01T00:00:00Z', updatedAt: '2026-01-01T08:00:00Z', ...extra });
    },
    due(at = '2026-01-01T09:00:00Z', projectId = 'p') {
      time = Date.parse(at);
      services.schedules.tick();
      return services.eventbox.events().find(e => e.type === 'schedule.due' && (e.data as {payload?: {projectId?:string}}).payload?.projectId === projectId)!;
    },
    async restart() {
      await services.follow.close();
      services.schedules.close();
      await services.eventbox.close();
      store.close();
      store = createStore(path);
      services = open();
    },
  };
  t.after(async () => { await services.follow.close(); services.schedules.close(); await services.eventbox.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}

test('legacy projects create no schedule; explicit settings reconcile idempotently in daily-brief', t => {
  const f = fixture(t);
  f.schedules.forOwner('daily-brief').create({ name: 'morning', kind: 'cron', cron: '0 9 * * *', tz: 'UTC' });
  f.project('legacy', 'inherit', false);
  assert.equal(f.schedules.list().length, 1);
  f.project();
  const before = f.schedules.list();
  f.follow.sync(); f.follow.sync();
  assert.deepEqual(f.schedules.list(), before);
  assert.equal(before[1].name, 'project:p:brief');
  assert.equal(before[1].owner, 'daily-brief');
});

test('project brief has isolated facts, cursor and daily dedup across reconfiguration', async t => {
  const f = fixture(t); f.project(); f.project('other');
  f.todo('own', 'p'); f.todo('foreign', 'other'); f.todo('unassigned');
  f.store.put('briefing.cursors', 'last', { to: '2099-01-01T00:00:00Z' });
  const e = f.due();
  assert.equal((await f.follow.handle(e)).status, 'done');
  assert.match(f.sent[0].text, /Todo own/);
  assert.doesNotMatch(f.sent[0].text, /Todo foreign|Todo unassigned|Project other|未归项目/);
  assert.equal(f.follow.isCurrent('p', f.sent[0].key), true);
  assert.equal(f.follow.isCurrent('other', f.sent[0].key), false);
  f.patch({ followUp: { briefingTime: '10:00', overdueReminders: true, automation: 'balanced' } });
  assert.equal((await f.follow.handle(f.due('2026-01-01T10:00:00Z'))).status, 'skip');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.store.get('briefing.cursors', 'last'), { to: '2099-01-01T00:00:00Z' });
});

test('time and global timezone edits invalidate queued events and outbound grants', async t => {
  const f = fixture(t); f.project();
  const old = f.due(); await f.follow.handle(old);
  const key = f.sent[0].key;
  f.patch({ followUp: { briefingTime: '10:30', automation: 'balanced', overdueReminders: true } });
  assert.equal(f.follow.isCurrent('p', key), false);
  assert.equal((await f.follow.handle(old)).status, 'skip');
  f.global.timezone = 'Asia/Shanghai'; f.follow.sync();
  const schedule = f.schedules.list()[0];
  assert.equal(schedule.cron, '30 10 * * *'); assert.equal(schedule.tz, 'Asia/Shanghai');
  assert.equal(schedule.nextAt, '2026-01-02T02:30:00.000Z');
});

test('briefingEnabled false pauses only project brief and preserves manually scheduled reminder', async t => {
  const f = fixture(t); f.project(); f.todo('manual', 'p', { reminderAt: '2026-01-02T12:00:00Z' });
  const manual = f.schedules.forOwner('reminders').create({ name: 'manual', kind: 'once', at: '2026-01-02T12:00:00Z' });
  const old = f.due(); await f.follow.handle(old);
  f.patch({ followUp: { briefingTime: '09:00', automation: 'balanced', overdueReminders: true, briefingEnabled: false } });
  assert.equal(f.schedules.list().find(s => s.name === 'project:p:brief')?.status, 'paused');
  assert.equal((await f.follow.handle(old)).status, 'skip');
  assert.equal(f.follow.isCurrent('p', f.sent[0].key), false);
  assert.deepEqual(f.schedules.list().find(s => s.id === manual.id), manual);
  assert.equal(f.store.get<Todo>('todos', 'manual')?.reminderAt, '2026-01-02T12:00:00Z');
});

test('archive revokes pending outbound grants even without a domain event', async t => {
  const f = fixture(t); const p = f.project(); const old = f.due(); await f.follow.handle(old);
  f.store.put('projects', 'p', { ...p, archivedAt: '2026-01-01T10:00:00Z' });
  assert.equal(f.follow.isCurrent('p', f.sent[0].key), false);
  assert.equal((await f.follow.handle(old)).status, 'skip');
  assert.equal(f.schedules.list()[0].status, 'paused');
});

test('monotonic grants prevent A to B to A from reviving an old schedule event', async t => {
  const f = fixture(t); const p = f.project(); const old = f.due();
  await f.follow.handle(old);
  const key = f.sent[0].key;
  const first = f.store.get<ProjectFollowUpGrant>('project-follow-up.grants', 'p')!.version;
  f.patch({ followUp: { ...p.followUp!, briefingEnabled: false } });
  f.patch({ followUp: p.followUp });
  assert.ok(f.store.get<ProjectFollowUpGrant>('project-follow-up.grants', 'p')!.version > first);
  assert.equal((await f.follow.handle(old)).status, 'skip');
  assert.equal(f.follow.isCurrent('p', key), false);
  assert.equal(f.sent.length, 1);
});

test('SQLite restart preserves dedup, grants and cursor; next day has its own window', async t => {
  const f = fixture(t); f.project(); const old = f.due(); await f.follow.handle(old);
  const key = f.sent[0].key;
  await f.restart();
  assert.equal(f.follow.isCurrent('p', key), true);
  assert.equal((await f.follow.handle(old)).status, 'skip');
  assert.equal((await f.follow.handle(f.due('2026-01-02T09:00:00Z'))).status, 'done');
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].text, /2026-01-01T09:00:00.000Z → 2026-01-02T09:00:00.000Z/);
});

test('overdueReminders adds scoped incomplete facts independently of approval presets', async t => {
  const f = fixture(t); f.project();
  f.todo('overdue', 'p', { dueAt: '2025-12-30T00:00:00Z' });
  f.todo('done', 'p', { dueAt: '2025-12-30T00:00:00Z', completedAt: '2025-12-31T00:00:00Z' });
  f.todo('elsewhere', 'else', { dueAt: '2025-12-30T00:00:00Z' });
  await f.follow.handle(f.due());
  assert.match(f.sent[0].text, /逾期提醒 1：Todo overdue/);
  for (const [automation, overdueReminders, day] of [['balanced', false, '02'], ['conservative', true, '03'], ['inherit', true, '04'], ['quiet', true, '05']] as const) {
    f.patch({ followUp: { briefingTime: '09:00', automation, overdueReminders } });
    await f.follow.handle(f.due(`2026-01-${day}T09:00:00Z`));
    if (overdueReminders) assert.match(f.sent.at(-1)!.text, /逾期提醒 1：Todo overdue/);
    else assert.doesNotMatch(f.sent.at(-1)!.text, /逾期提醒/);
  }
  assert.equal(f.store.get<Todo>('todos', 'overdue')?.remindedAt, undefined);
});

test('away notification switch does not invalidate briefs; timezone remains inherited', async t => {
  const f = fixture(t); f.project('p', 'inherit'); const old = f.due();
  f.global.awayNotifications = false;
  const before = f.schedules.list()[0];
  assert.equal((await f.follow.handle(old)).status, 'done');
  assert.deepEqual(f.schedules.list()[0], before);
  assert.equal(f.follow.isCurrent('p', f.sent[0].key), true);
  f.global.awayNotifications = true; f.follow.sync();
  assert.deepEqual(f.schedules.list()[0], before);
  assert.equal(f.follow.isCurrent('p', f.sent[0].key), true); f.global.timezone = 'Asia/Shanghai'; f.follow.sync();
  assert.equal(f.schedules.list()[0].tz, 'Asia/Shanghai');
  assert.equal(f.schedules.list()[0].cron, '0 9 * * *');
  assert.equal(f.store.list('background.model-grants').length, 0);
  assert.equal(f.store.list('outbox.grants').length, 0);
});

test('uncertain enqueue is claimed durably and never automatically repeated', async t => {
  const f = fixture(t); f.project(); f.fail(); const e = f.due();
  assert.deepEqual(await f.follow.handle(e), { status: 'failed', reason: 'project_enqueue_unknown' });
  assert.equal((await f.follow.handle(e)).status, 'skip');
  await f.restart();
  assert.equal((await f.follow.handle(e)).status, 'skip');
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.get<{status: string}>('project-follow-up.windows', f.sent[0].key)?.status, 'unknown');
});

test('host owner disable cannot be overridden; closed module stops reacting', async t => {
  const f = fixture(t); f.project(); const old = f.due();
  f.schedules.ownerEnabled('daily-brief', false); f.follow.sync();
  assert.equal(f.schedules.list()[0].status, 'owner_disabled');
  assert.equal((await f.follow.handle(old)).status, 'skip');
  await f.follow.close();
  const before = f.schedules.list(); f.patch({ archivedAt: '2026-01-01T10:00:00Z' }); f.follow.sync();
  assert.deepEqual(f.schedules.list(), before);
  assert.equal((await f.follow.handle(old)).status, 'skip');
});


test('all approval presets preserve daily briefs and pending grants without policy writes', async t => {
  const f = fixture(t); const p = f.project('p', 'inherit');
  const old = f.due();
  const before = f.schedules.list()[0];
  for (const automation of ['conservative', 'balanced', 'quiet', 'inherit'] as const) {
    f.patch({ followUp: { ...p.followUp!, automation } });
    assert.deepEqual(f.schedules.list()[0], before);
  }
  assert.equal((await f.follow.handle(old)).status, 'done');
  for (const automation of ['quiet', 'conservative', 'balanced', 'inherit'] as const) {
    f.patch({ followUp: { ...p.followUp!, automation } });
    assert.equal(f.follow.isCurrent('p', f.sent[0].key), true);
  }
  assert.equal(f.store.list('policies').length, 0);
});
