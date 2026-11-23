import { randomUUID } from 'node:crypto';
import type { DurableEvent, EventBus, EventResult, ScheduleInput, Store } from '../../plugin-sdk/src/index.ts';
import type { Json, Message } from '../../protocol/src/index.ts';
import type { createOutbox } from './outbox.ts';
import type { createSchedules } from './schedules.ts';
import { digest } from './eventbox.ts';

const collection = 'agent.followups';
const pendingBriefCollection = 'briefing.pending-notices';
const owner = 'daily-brief';

export type FollowupSchedule =
  | { kind: 'once'; at: string; tz?: string }
  | { kind: 'interval'; everySec: number; anchorAt?: string; tz?: string }
  | { kind: 'cron'; cron: string; tz: string };

export interface FollowupLink {
  label: string;
  url: string;
}

export interface FollowupRecord {
  sourceConversationId?: string;
  id: string;
  title: string;
  prompt: string;
  schedule: FollowupSchedule;
  push: 'always' | 'asked';
  projectId?: string;
  todoId?: string;
  scheduleId: string;
  scheduleVersion: number;
  status: 'active' | 'done' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastOutcome?: 'silent' | 'notified' | 'completed' | 'failed';
  lastSummary?: string;
  lastNotifiedAt?: string;
}

export interface PendingBriefNotice {
  id: string;
  title: string;
  text: string;
  projectId?: string;
  todoId?: string;
  createdAt: string;
}

function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${name}不能为空`);
  return value.trim();
}

function sanitizeLinks(raw: unknown): FollowupLink[] {
  if (!Array.isArray(raw)) return [];
  const links: FollowupLink[] = [];
  for (const item of raw.slice(0, 4)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const label = typeof (item as Record<string, unknown>).label === 'string' ? (item as Record<string, unknown>).label as string : '';
    const url = typeof (item as Record<string, unknown>).url === 'string' ? (item as Record<string, unknown>).url as string : '';
    if (!label.trim() || !URL.canParse(url)) continue;
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    links.push({ label: label.trim().slice(0, 40), url: parsed.href });
  }
  return links;
}

/**
 * Model-programmable read-only follow-ups and quiet patrols (schedule_followup +
 * push:"asked" + notify_user). Runs always execute read-only; external side
 * effects still require explicit approval workflows.
 */
export function createAgentFollowups(options: {
  store: Store;
  events: EventBus;
  schedules: Pick<ReturnType<typeof createSchedules>, 'forOwner'>;
  outbox: Pick<ReturnType<typeof createOutbox>, 'enqueueNotice'>;
  agent: {
    status: () => { available: boolean; reason?: string };
    ask: (text: string, context?: { projectId?: string; readOnly?: boolean; readOnlyAction?: 'notify_user' }) => Promise<Message>;
  };
  resolveChannel: (projectId?: string, todoId?: string) => string;
  enabled: () => boolean;
  demo?: boolean;
}) {
  const { store, events, outbox, agent, resolveChannel, enabled } = options;
  const api = options.schedules.forOwner(owner);
  let closed = false;
  let notifiedInCurrentTurn = false;

  function create(input: Record<string, unknown>, sourceConversationId?: string): FollowupRecord {
    if (closed || !enabled()) fail('主动跟进调度当前未启用', 409);
    const title = requiredText(input.title, '标题').slice(0, 120);
    const prompt = requiredText(input.prompt, '跟进指令').slice(0, 4000);
    const push = input.push === 'always' ? 'always' : 'asked';
    const projectId = typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : undefined;
    const todoId = typeof input.todoId === 'string' && input.todoId.trim() ? input.todoId.trim() : undefined;
    const rawSchedule = input.schedule as Record<string, unknown> | undefined;
    if (!rawSchedule || typeof rawSchedule !== 'object' || Array.isArray(rawSchedule)) fail('schedule 必须为对象');
    const kind = rawSchedule.kind;
    if (kind !== 'once' && kind !== 'interval' && kind !== 'cron') fail('schedule.kind 必须为 once、interval 或 cron');
    const scheduleSpec: FollowupSchedule = kind === 'once'
      ? { kind: 'once', at: requiredText(rawSchedule.at, 'at'), ...(typeof rawSchedule.tz === 'string' && rawSchedule.tz.trim() ? { tz: rawSchedule.tz.trim() } : {}) }
      : kind === 'interval'
        ? { kind: 'interval', everySec: Number(rawSchedule.everySec), ...(typeof rawSchedule.anchorAt === 'string' && rawSchedule.anchorAt.trim() ? { anchorAt: rawSchedule.anchorAt.trim() } : {}), ...(typeof rawSchedule.tz === 'string' && rawSchedule.tz.trim() ? { tz: rawSchedule.tz.trim() } : {}) }
        : { kind: 'cron', cron: requiredText(rawSchedule.cron, 'cron'), tz: requiredText(rawSchedule.tz, 'tz') };

    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim().slice(0, 80) : randomUUID();
    const now = new Date().toISOString();
    return store.transaction(() => {
      const existing = store.get<FollowupRecord>(collection, id);
      if (existing && existing.status === 'active') {
        const oldSchedule = api.list().find(s => s.id === existing.scheduleId);
        if (oldSchedule && oldSchedule.status !== 'cancelled') api.cancel(oldSchedule.id, oldSchedule.version);
      }
      const created = api.create({
        ...(scheduleSpec as ScheduleInput),
        name: `followup:${id}`,
        missed: 'coalesce',
        payload: { agentFollowup: true, followupId: id },
      });
      const record: FollowupRecord = {
        id, title, prompt,
        ...(sourceConversationId && { sourceConversationId }),
        schedule: scheduleSpec.kind === 'interval' ? { ...scheduleSpec, anchorAt: created.anchorAt } : scheduleSpec,
        push,
        ...(projectId ? { projectId } : {}),
        ...(todoId ? { todoId } : {}),
        scheduleId: created.id,
        scheduleVersion: created.version,
        status: 'active',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      store.put(collection, id, record);
      events.publish('followups.changed', { id, status: record.status });
      return record;
    });
  }

  function list(filter: Record<string, unknown> = {}): FollowupRecord[] {
    const projectId = typeof filter.projectId === 'string' && filter.projectId.trim() ? filter.projectId.trim() : undefined;
    const todoId = typeof filter.todoId === 'string' && filter.todoId.trim() ? filter.todoId.trim() : undefined;
    const status = typeof filter.status === 'string' && filter.status.trim() ? filter.status.trim() : undefined;
    return store.list<FollowupRecord>(collection)
      .filter(r => (!projectId || r.projectId === projectId) && (!todoId || r.todoId === todoId) && (!status || r.status === status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100);
  }

  function cancel(id: string): FollowupRecord {
    const cleanId = requiredText(id, 'id');
    return store.transaction(() => {
      const record = store.get<FollowupRecord>(collection, cleanId);
      if (!record) fail('跟进任务不存在', 404);
      const schedule = api.list().find(s => s.id === record.scheduleId);
      if (schedule && schedule.status !== 'cancelled') api.cancel(schedule.id, schedule.version);
      const next: FollowupRecord = { ...record, status: 'cancelled', updatedAt: new Date().toISOString() };
      store.put(collection, cleanId, next);
      events.publish('followups.changed', { id: cleanId, status: 'cancelled' });
      return next;
    });
  }

  function notifyUser(input: Record<string, unknown>): Json {
    const title = requiredText(input.title, '通知标题').slice(0, 120);
    const body = requiredText(input.text, '通知内容').slice(0, 6000);
    const urgency = input.urgency === 'brief' ? 'brief' : 'now';
    const projectId = typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : undefined;
    const todoId = typeof input.todoId === 'string' && input.todoId.trim() ? input.todoId.trim() : undefined;
    const links = sanitizeLinks(input.links);
    const now = new Date().toISOString();
    const linkLines = links.length ? `\n\n${links.map(l => `${l.label}：${l.url}`).join('\n')}` : '';
    const fullText = `${title}\n${body}${linkLines}`;

    if (urgency === 'brief') {
      const id = `brief-notice:${digest([title, body, projectId ?? '', todoId ?? ''])}`;
      store.put(pendingBriefCollection, id, { id, title, text: body + linkLines, ...(projectId ? { projectId } : {}), ...(todoId ? { todoId } : {}), createdAt: now });
      notifiedInCurrentTurn = true;
      return { delivered: 'held_for_brief', id, urgency };
    }

    const dedupKey = typeof input.dedupKey === 'string' && input.dedupKey.trim()
      ? input.dedupKey.trim()
      : `notify:${digest([title, body, projectId ?? '', todoId ?? '', now.slice(0, 16)])}`;
    const conversationId = projectId ? `project:${projectId}:work` : 'main';
    const messageId = `notice:${digest([dedupKey, conversationId])}`;
    const channel = resolveChannel(projectId, todoId);
    const outboxItem = store.transaction(() => {
      if (!store.get('messages', messageId)) {
        const message: Message = {
          id: messageId, conversationId, role: 'assistant', origin: 'notification',
          text: fullText, status: 'done', createdAt: now,
          ...(projectId ? { projectId } : {}), ...(todoId ? { todoId } : {}),
        };
        store.put('messages', messageId, message);
      }
      return outbox.enqueueNotice(owner, {
        dedupKey,
        channel,
        target: 'owner',
        content: { text: fullText },
        ...(todoId ? { relatedTo: { kind: 'todo', id: todoId } } : projectId ? { relatedTo: { kind: 'project', id: projectId } } : {}),
      });
    });
    events.publish('messages.changed', { messageId, conversationId });
    notifiedInCurrentTurn = true;
    return { delivered: 'queued', messageId, outboxId: outboxItem.id, urgency };
  }

  function consumePendingBriefNotices(): PendingBriefNotice[] {
    const items = store.list<PendingBriefNotice>(pendingBriefCollection)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (items.length) {
      store.transaction(() => {
        for (const item of items) store.remove(pendingBriefCollection, item.id);
      });
    }
    return items;
  }

  async function handle(event: DurableEvent): Promise<EventResult> {
    if (closed || event.type !== 'schedule.due' || event.typeVersion !== 1 || event.source !== 'core') {
      return { status: 'skip', reason: 'not_agent_followup' };
    }
    const data = event.data as Record<string, unknown> | null;
    const payload = data?.payload as Record<string, unknown> | undefined;
    if (!payload || payload.agentFollowup !== true || data?.owner !== owner) {
      return { status: 'skip', reason: 'not_agent_followup' };
    }
    if (!enabled()) return { status: 'retry', reason: '主动跟进已停用', afterSec: 60, deferred: true };
    const followupId = typeof payload.followupId === 'string' ? payload.followupId : '';
    const record = followupId ? store.get<FollowupRecord>(collection, followupId) : undefined;
    if (!record || record.status !== 'active' || record.scheduleId !== data.scheduleId || record.scheduleVersion !== data.scheduleVersion) {
      return { status: 'skip', reason: 'followup_inactive_or_stale' };
    }
    const scheduledFor = typeof data.scheduledFor === 'string' ? data.scheduledFor : event.createdAt;
    const now = new Date().toISOString();

    if (options.demo) {
      const nextStatus = record.schedule.kind === 'once' ? 'done' : 'active';
      store.put(collection, record.id, { ...record, status: nextStatus, lastRunAt: now, lastOutcome: 'completed', lastSummary: '演示模式已触发', updatedAt: now });
      if (record.push === 'always') {
        notifyUser({ title: record.title, text: `【演示】主动跟进已触发：${record.prompt.slice(0, 200)}`, urgency: 'now', projectId: record.projectId, todoId: record.todoId, dedupKey: `followup:${record.id}:${scheduledFor}` });
      }
      return { status: 'done' };
    }

    if (!agent.status().available) {
      return { status: 'retry', reason: '主模型未就绪', afterSec: 30, deferred: true };
    }

    notifiedInCurrentTurn = false;
    const prompt = [
      `【主动跟进触发】标题：${record.title}`,
      `计划触发时间：${scheduledFor}，当前时间：${now}`,
      `推送策略：${record.push === 'asked' ? 'asked（默认静默；无值得打扰的变化请直接以 SILENT: 开头回复；真有重要结论/会前简报请调用 notify_user 通知主人）' : 'always（请整理高密度中文结论，完成后系统或你经 notify_user 推给主人；若确认无需打扰也可回复 SILENT: 跳过）'}`,
      '本轮为只读调研轮次：请先调用已注册的只读工具（日历、收件箱、待办、执行、知识、工作区代码等）查清最新进展，禁止编造；如需对外发送或派发写任务，请向主人汇报建议由主人确认。',
      '',
      '跟进指令：',
      record.prompt,
    ].join('\n');

    try {
      const reply = await Promise.race([
        agent.ask(prompt, { ...(record.projectId ? { projectId: record.projectId } : {}), readOnly: true, readOnlyAction: 'notify_user' }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('主动跟进执行超时')), 60000);
          timer.unref();
        }),
      ]);
      const text = reply.status === 'done' ? reply.text.trim() : '';
      const isSilent = !text || /^SILENT\s*[:：]?/i.test(text);
      let outcome: FollowupRecord['lastOutcome'] = isSilent ? 'silent' : 'completed';
      let lastNotifiedAt = record.lastNotifiedAt;

      if (notifiedInCurrentTurn) {
        outcome = 'notified';
        lastNotifiedAt = now;
      } else if (record.push === 'always' && !isSilent) {
        notifyUser({
          title: record.title,
          text,
          urgency: 'now',
          projectId: record.projectId,
          todoId: record.todoId,
          dedupKey: `followup:${record.id}:${scheduledFor}`,
        });
        outcome = 'notified';
        lastNotifiedAt = now;
      }

      const nextStatus = record.schedule.kind === 'once' ? 'done' : 'active';
      const updated: FollowupRecord = {
        ...record,
        status: nextStatus,
        lastRunAt: now,
        lastOutcome: outcome,
        lastSummary: text.slice(0, 400),
        ...(lastNotifiedAt ? { lastNotifiedAt } : {}),
        updatedAt: now,
      };
      store.put(collection, record.id, updated);
      events.publish('followups.changed', { id: record.id, status: updated.status, outcome });
      return { status: 'done', outcome: { followupId: record.id, outcome } };
    } catch (error) {
      store.put(collection, record.id, {
        ...record,
        lastRunAt: now,
        lastOutcome: 'failed',
        lastSummary: (error instanceof Error ? error.message : String(error)).slice(0, 400),
        updatedAt: now,
      });
      return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    create,
    list,
    cancel,
    notifyUser,
    consumePendingBriefNotices,
    handle,
    close() { closed = true; },
  };
}
