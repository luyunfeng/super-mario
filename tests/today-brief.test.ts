import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/core/src/store.ts';
import { readTodayBrief, type TodayBriefSources } from '../plugins/today-brief.ts';
import type { InboxItem } from '../packages/protocol/src/index.ts';

const signal = new AbortController().signal;
const start = '2026-03-08T05:00:00.000Z';
const now = Date.parse('2026-03-08T18:00:00Z');

test('today uses the workbench civil day across DST, bounded facts and exact mention evidence', async t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const inbox: InboxItem = { id: 'pending', thread: 'thread', last: 'last', source: 'feishu:account', version: 1,
    tier: 'action', reason: 'request', receivedAt: start, updatedAt: start, title: 'please review', text: 'private raw text',
    origin: { kind: 'group', connector: '飞书', personalGroupObserved: true, mentionedMe: true } };
  const sources: TodayBriefSources = { timezone: 'America/New_York', calendarIdentity: 'identity', decisions: [], inbox: [
    inbox, { ...inbox, id: 'not-mentioned', origin: { ...inbox.origin!, mentionedMe: false } },
    { ...inbox, id: 'old-group', origin: { ...inbox.origin!, personalGroupObserved: undefined } },
    { ...inbox, id: 'large-group', origin: { ...inbox.origin!, personalGroupUserCount: 51 } },
    { ...inbox, id: 'missing-received-at', receivedAt: undefined, tier: 'fyi' },
    { ...inbox, id: 'archived', archivedAt: start }, { ...inbox, id: 'backlog', receivedAt: '2026-03-07T12:00:00Z' },
  ] };
  store.put('todos', 'before-day', { id: 'before-day', title: 'yesterday', completedAt: '2026-03-08T04:59:59Z' });
  store.put('todos', 'at-start', { id: 'at-start', title: 'done', completedAt: start });
  for (let i = 0; i < 15; i++) store.put('runs', String(i), { id: String(i), status: 'running', prompt: 'backlog run', updatedAt: '2026-03-06T09:00:00Z' });
  for (const status of ['failed', 'completed']) store.put('runs', status, { id: status, status, error: 'exit code 1', prompt: 'task', updatedAt: start });
  store.put('runs', 'earlier-failure', {id:'earlier-failure', status:'failed', prompt:'前一日失败', updatedAt:'2026-03-08T04:59:59Z'});
  const receipt = await readTodayBrief(store, { todayBriefSources: () => sources, calendarAgenda: async input => {
    assert.deepEqual(input, { start, end: '2026-03-09T04:00:00.000Z' });
    return { available: true, partial: true, events: [
      { eventId: 'meeting', summary: 'meeting', startTime: start, endTime: '2026-03-08T06:00:00Z' },
      { eventId: 'all-day', summary: 'all day', startTime: '2026-03-08', endTime: '2026-03-09' },
      ...['declined', 'cancelled'].map(status => ({ eventId: status, status, summary: status, startTime: start, endTime: '2026-03-08T06:00:00Z' })),
      { eventId: 'outside', summary: 'wrong day', startTime: '2026-03-09', endTime: '2026-03-10' },
    ] };
  } }, {}, signal, now);
  assert.equal(receipt.date, '2026-03-08');
  assert.equal(receipt.calendar.truncated, true);
  assert.equal(receipt.calendar.totalIsLowerBound,true);
  assert.equal(receipt.running.totalIsLowerBound,undefined);
  assert.deepEqual(receipt.calendar.items.map(row => row.id), ['all-day', 'meeting']);
  assert.deepEqual(receipt.inbox.items.map(row => row.id), ['not-mentioned', 'pending', 'backlog']);
  assert.deepEqual(receipt.mentions.items.map(row => row.id), ['pending']);
  assert.deepEqual(receipt.completed.items.map(row => row.kind), ['todo', 'completed']);
  assert.deepEqual(receipt.failed.items.map(row=>row.id),['failed']);
  assert.equal(receipt.failed.items[0].reason, 'exit code 1');
  assert.deepEqual([receipt.running.total, receipt.running.items.length, receipt.running.truncated], [15, 12, true]);
  assert.ok(!JSON.stringify(receipt).includes('private raw text'));
});

test('today refreshes grants after calendar I/O and distinguishes unavailable from an empty agenda', async t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  let current: TodayBriefSources = { timezone: 'UTC', calendarIdentity: 'first', decisions: [], inbox: [] };
  const sources = () => ({ ...current });
  const result = await readTodayBrief(store, { todayBriefSources: sources, calendarAgenda: async () => {
    current = { ...current, calendarIdentity: 'another' };
    return { available: true, events: [{ eventId: 'hidden', summary: 'private', startTime: start, endTime: '2026-03-08T06:00:00Z' }] };
  } }, {}, signal, now);
  assert.equal(result.calendar.available, false);
  assert.doesNotMatch(JSON.stringify(result), /hidden|private|another/);
  const failed = await readTodayBrief(store, { todayBriefSources: sources, calendarAgenda: async () => { throw Error('private detail'); } }, {}, signal, now);
  assert.equal(failed.calendar.available, false);
  assert.doesNotMatch(JSON.stringify(failed), /private detail/);
  const empty = await readTodayBrief(store, { todayBriefSources: sources, calendarAgenda: async () => ({ available: true, events: [] }) }, {}, signal, now);
  assert.equal(empty.calendar.available, true);
  current = { ...current, calendarIdentity: undefined, calendarUnavailableReason: '飞书插件已停用' };
  let called = false;
  const unlinked = await readTodayBrief(store, { todayBriefSources: sources, calendarAgenda: async () => { called = true; return {}; } }, {}, signal, now);
  assert.equal(called, false);
  assert.equal(unlinked.calendar.reason, '飞书插件已停用');
  await assert.rejects(readTodayBrief(store, {}, { projectId: 'forged' }, signal), { status: 400 });
});
