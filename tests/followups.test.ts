import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createEventbox } from '../packages/core/src/eventbox.ts';
import { createSchedules } from '../packages/core/src/schedules.ts';
import { createAgentFollowups } from '../packages/core/src/followups.ts';
import type { DurableEvent, Json } from '../packages/plugin-sdk/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

async function setup(t: test.TestContext, ask: (prompt: string, ctx?: { projectId?: string; readOnly?: boolean }) => Promise<Message>) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-followups-'));
  const store = createStore(join(dir, 'test.sqlite'));
  const events = createEventBus(store);
  const eventbox = createEventbox({ store, events });
  const schedules = createSchedules({ store, eventbox });
  const notices: Array<{ owner: string; input: Record<string, unknown> }> = [];
  const outbox = {
    enqueueNotice(owner: string, input: Record<string, unknown>) {
      notices.push({ owner, input });
      return { id: `outbox-${notices.length}` };
    },
  };
  const followups = createAgentFollowups({
    store, events, schedules, outbox: outbox as never,
    agent: { status: () => ({ available: true }), ask },
    resolveChannel: () => 'feishu.bot:global',
    enabled: () => true,
  });
  t.after(async () => {
    followups.close();
    await eventbox.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, followups, notices };
}

function makeDueEvent(followupId: string, scheduleId: string, scheduleVersion: number, scheduledFor: string): DurableEvent {
  return {
    id: `evt-${followupId}-${scheduledFor}`,
    rootId: `evt-${followupId}-${scheduledFor}`,
    seq: 1,
    source: 'core',
    sourceId: `schedule:${scheduleId}:v${scheduleVersion}:${scheduledFor}`,
    type: 'schedule.due',
    typeVersion: 1,
    createdAt: scheduledFor,
    data: {
      owner: 'daily-brief',
      scheduleId,
      scheduleVersion,
      scheduledFor,
      payload: { agentFollowup: true, followupId },
    } as unknown as Json,
  };
}

test('once followup with push=always wakes agent read-only, pushes notice, and marks done', async t => {
  const calls: Array<{ prompt: string; readOnly?: boolean }> = [];
  const { followups, notices } = await setup(t, async (prompt, ctx) => {
    calls.push({ prompt, readOnly: ctx?.readOnly });
    return { id: 'm1', conversationId: 'main', role: 'assistant', text: '17:30 隔日会要点：1. !267 已上 PPE。', status: 'done', createdAt: new Date().toISOString() };
  });
  const created = followups.create({
    id: 'pre-meeting-1',
    title: '17:30 项目同步例会',
    prompt: '核对今日发布与迁移进展，整理 3 条会议要点',
    push: 'always',
    schedule: { kind: 'once', at: '2026-11-21T17:20:00+08:00' },
  });
  assert.equal(created.status, 'active');

  const res = await followups.handle(makeDueEvent(created.id, created.scheduleId, created.scheduleVersion, '2026-11-21T17:20:00+08:00'));
  assert.equal(res.status, 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.readOnly, true);
  assert.equal(notices.length, 1);
  assert.match(String((notices[0]!.input.content as { text: string }).text), /!267 已上 PPE/);

  const after = followups.list({ status: 'done' });
  assert.equal(after.length, 1);
  assert.equal(after[0]!.lastOutcome, 'notified');
});

test('quiet patrol (push=asked) stays silent on SILENT reply and only notifies when notify_user is called', async t => {
  let turn = 0;
  let followupsRef: ReturnType<typeof createAgentFollowups> | undefined;
  const { followups, notices } = await setup(t, async () => {
    turn++;
    if (turn === 1) {
      return { id: 'm1', conversationId: 'main', role: 'assistant', text: 'SILENT: CI 仍在运行，无异常', status: 'done', createdAt: new Date().toISOString() };
    }
    followupsRef!.notifyUser({
      title: '构建失败提醒',
      text: 'PPE 部署流水线失败，请核对环境变量。',
      urgency: 'now',
      links: [{ label: '查看文档', url: 'https://example.com/doc/1' }],
    });
    return { id: 'm2', conversationId: 'main', role: 'assistant', text: '已通知主人', status: 'done', createdAt: new Date().toISOString() };
  });
  followupsRef = followups;

  const patrol = followups.create({
    title: 'CI 状态巡检',
    prompt: '检查最近构建是否有失败',
    push: 'asked',
    schedule: { kind: 'interval', everySec: 1800 },
  });

  await followups.handle(makeDueEvent(patrol.id, patrol.scheduleId, patrol.scheduleVersion, '2026-11-21T18:00:00+08:00'));
  assert.equal(notices.length, 0);
  assert.equal(followups.list()[0]!.lastOutcome, 'silent');
  assert.equal(followups.list()[0]!.status, 'active');

  await followups.handle(makeDueEvent(patrol.id, patrol.scheduleId, patrol.scheduleVersion, '2026-11-21T18:30:00+08:00'));
  assert.equal(notices.length, 1);
  assert.match(String((notices[0]!.input.content as { text: string }).text), /https:\/\/example\.com\/doc\/1/);
  assert.equal(followups.list()[0]!.lastOutcome, 'notified');
});

test('notifyUser with urgency=brief defers to pending brief notices and cancel stops followup', async t => {
  const { followups, notices } = await setup(t, async () => ({
    id: 'm', conversationId: 'main', role: 'assistant', text: 'ok', status: 'done', createdAt: new Date().toISOString(),
  }));
  const r = followups.notifyUser({ title: '低优先级进展', text: '文档已归档', urgency: 'brief' }) as { delivered: string };
  assert.equal(r.delivered, 'held_for_brief');
  assert.equal(notices.length, 0);
  const consumed = followups.consumePendingBriefNotices();
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0]!.title, '低优先级进展');
  assert.equal(followups.consumePendingBriefNotices().length, 0);

  const item = followups.create({
    title: '临时提醒',
    prompt: '检查状态',
    schedule: { kind: 'once', at: '2026-11-21T20:00:00+08:00' },
  });
  followups.cancel(item.id);
  const skipped = await followups.handle(makeDueEvent(item.id, item.scheduleId, item.scheduleVersion, '2026-11-21T20:00:00+08:00'));
  assert.equal(skipped.status, 'skip');
});
