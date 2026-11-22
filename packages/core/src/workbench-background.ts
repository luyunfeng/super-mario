import { buildWindowBrief, createBriefingSettings, formatWindowBrief } from './briefing.ts';
import { buildBriefingPrompt } from './prompts.ts';
import type { createAgentRuntime } from './agent-runtime/index.ts';
import type { createApprovalService } from './approvals.ts';
import type { createBackground } from './background.ts';
import type { createEventBus } from './events.ts';
import type { createInboxService } from './inbox.ts';
import type { Card, createInteractions } from './interactions.ts';
import type { createContributions, PluginHost } from './plugin-host.ts';
import type { createProjectFollowUp } from './project-follow-up.ts';
import type { createReplyTracking } from './reply-tracking.ts';
import type { createStore } from './store.ts';
import type { createSupervision } from './supervision.ts';
import type { createSupervisorAgent } from './supervisor-agent.ts';
import type { createWebPresence } from './web-presence.ts';
import type { Approval, CollectedReplyEvidence, FeishuBot, InboxThing, Json, Message, Run, Todo } from '../../protocol/src/index.ts';

export function reminderReference(todo: Todo) {
  return { ref: `reminder:${JSON.stringify([todo.id, todo.reminderAt])}`, version: todo.reminderVersion ?? 1 };
}

export function reminderSourceId(todo: Todo) {
  // Preserve generation-1 deduplication when reconciling legacy events.
  return (todo.reminderVersion ?? 1) === 1
    ? `reminder:${todo.id}:${todo.reminderAt}`
    : `reminder:${JSON.stringify([todo.id, todo.reminderAt, todo.reminderVersion])}`;
}

export interface WorkbenchBackgroundDeps {
  demo?: boolean;
  consumePendingBriefNotices?: () => { title: string; text: string; createdAt: string }[];
  conversations?:()=>import('../../protocol/src/inbox-conversations.ts').InboxConversation[];
  store: ReturnType<typeof createStore>;
  events: ReturnType<typeof createEventBus>;
  background: ReturnType<typeof createBackground>;
  plugins: PluginHost;
  contributions: ReturnType<typeof createContributions>;
  briefing: ReturnType<typeof createBriefingSettings>;
  supervision: ReturnType<typeof createSupervision>;
  supervisorAgent: ReturnType<typeof createSupervisorAgent>;
  supervisorRuntime: ReturnType<typeof createAgentRuntime>;
  agent: ReturnType<typeof createAgentRuntime>;
  inbox: ReturnType<typeof createInboxService>;
  waitingReplies: ReturnType<typeof createReplyTracking>;
  approvals: ReturnType<typeof createApprovalService>;
  interactions: { open: (input: Parameters<ReturnType<typeof createInteractions>['open']>[0]) => Card };
  presence: ReturnType<typeof createWebPresence>;
  projectFollowUp: ReturnType<typeof createProjectFollowUp>;
  proposePlan: (input: Record<string, unknown>, fromAgent?: boolean) => unknown;
  notificationBots: () => FeishuBot[];
  notificationChannel: (bot: FeishuBot) => string;
  changed: (type: string, data: unknown) => void;
  isClosing: () => boolean;
  createInputError: (message: string, status?: number) => Error;
  requiredText: (value: unknown, name: string) => string;
}

/** Wires durable background subscriptions, default briefing schedules, and core JSON services. */
export function wireWorkbenchBackground(deps: WorkbenchBackgroundDeps): { close(): Promise<void> } {
  const {
    store,
    events,
    background,
    plugins,
    contributions,
    briefing,
    supervision,
    supervisorAgent,
    supervisorRuntime,
    agent,
    inbox,
    waitingReplies,
    approvals,
    interactions,
    presence,
    projectFollowUp,
    proposePlan,
    notificationBots,
    notificationChannel,
    changed,
    isClosing,
    createInputError,
    requiredText,
  } = deps;

  const offReview = background.eventbox.subscribe('core', {
    name: 'review-cards',
    types: [{ type: 'supervisor.review.created', version: 1 }],
    effects: 'none',
    handler(event) {
      const data = event.data as unknown as { id: string; runIds: string[]; text: string };
      if (store.get('background.review-cards', data.id)) return { status: 'done' };
      store.transaction(() => {
        const runId = data.runIds.length === 1 && store.get<Run>('runs', data.runIds[0]!) ? data.runIds[0] : undefined;
        const card = interactions.open({ kind: 'review', title: '后台督办复核建议', body: data.text, runId });
        store.put('background.review-cards', data.id, { cardId: card.id });
      });
      return { status: 'done' };
    },
  });

  const offSupervisor = background.eventbox.subscribe('core', {
    name: 'supervisor-review',
    types: [{ type: 'supervision.signal', version: 1 }],
    effects: 'ledger',
    serial: 'none',
    timeoutMs: 600000,
    async handler(event) {
      const data = event.data as unknown as { id: string; kind: string };
      if (!['review', 'stalled', 'orphaned', 'needs_you'].includes(data.kind) || store.get('supervisor.processed', data.id)) return { status: 'done' };
      if (!supervision.signals().some(s => s.id === data.id && !s.resolvedAt)) return { status: 'skip', reason: 'signal_resolved' };
      if (supervisorAgent.settings().canResume || !supervisorRuntime.status().available) return { status: 'retry', reason: '督办暂停或模型未就绪', afterSec: 30, deferred: true };
      await supervisorAgent.flush();
      return store.get('supervisor.processed', data.id) ? { status: 'done' } : { status: 'retry', reason: '等待批处理间隔', afterSec: 30, deferred: true };
    },
  });

  // Reconcile old claimed reminders and open signals before the worker starts.
  store.transaction(() => {
    for (const signal of supervision.signals().filter(s => !s.resolvedAt)) {
      background.publish({
        type: 'supervision.signal',
        typeVersion: 1,
        sourceId: `signal:${signal.id}`,
        data: {
          id: signal.id,
          kind: signal.kind,
          text: signal.text,
          ...(signal.runId ? { runId: signal.runId } : {}),
          ...(signal.todoId ? { todoId: signal.todoId } : {}),
        },
        subject: { kind: signal.runId ? 'run' : 'todo', id: signal.runId || signal.todoId || signal.id },
      });
      if (signal.kind === 'reminder' && signal.todoId) {
        const todo = store.get<Todo>('todos', signal.todoId);
        if (todo?.remindedAt && todo.reminderAt) {
          background.publish({
            type: 'todo.reminder_due',
            typeVersion: 1,
            sourceId: reminderSourceId(todo),
            staleIf: reminderReference(todo),
            data: { todoId: todo.id, title: todo.title, reminderAt: todo.reminderAt },
            subject: { kind: 'todo', id: todo.id },
          });
        }
      }
    }
    store.put('eventbox.migrations', 'core-v1', { completedAt: new Date().toISOString() });
  });

  const offBrief = background.eventbox.subscribe('core', {
    name: 'dailybrief',
    types: [{ type: 'schedule.due', version: 1 }],
    effects: 'none',
    async handler(event) {
      const data = event.data as unknown as { owner: string; name: string; scheduledFor: string; scheduleId: string };
      if (data.owner !== 'daily-brief' || !['morning', 'evening', 'interval'].includes(data.name)) return { status: 'skip', reason: 'not_a_brief' };
      if (!plugins.list().some(p => p.id === 'daily-brief' && p.status === 'active')) return { status: 'retry', reason: '插件已停用', afterSec: 60, deferred: true };
      if (store.get('background.briefs', event.id)) return { status: 'done' };
      const routine = contributions.list('routines').find(item => item.id === 'dailybrief');
      // Counts are calculated here from persisted facts; the routine is also callable by plugins.
      if (!routine) return { status: 'skip', reason: 'brief_unavailable' };
      await routine.value.run();
      const to = data.scheduledFor || event.createdAt;
      if (data.name === 'interval' && !briefing.inActiveWindow(to)) return { status: 'skip', reason: 'outside_active_window' };
      const windowKey = `${data.scheduleId || data.name}:${to}`;
      if (store.get('briefing.windows', windowKey)) return { status: 'done' };
      const previous = store.get<{ to: string }>('briefing.cursors', 'last')?.to;
      if (previous && Date.parse(previous) >= Date.parse(to)) return { status: 'skip', reason: 'window_already_covered' };
      const hours = data.name === 'interval' ? briefing.settings().intervalHours : data.name === 'morning' ? 15 : 9;
      const from = previous || new Date(Date.parse(to) - hours * 3600000).toISOString();
      const tz = briefing.settings().timezone;
      const facts = buildWindowBrief(store, from, to, undefined, deps.conversations?.(), data.name === 'morning' ? tz : undefined, data.name === 'evening');
      const pendingNotices = deps.consumePendingBriefNotices?.() ?? [];
      const baseText = formatWindowBrief(facts, data.name, tz);
      const fallbackText = pendingNotices.length
        ? `${baseText}\n\n待汇总通知 ${pendingNotices.length}：\n${pendingNotices.map(n => `- ${n.title}：${n.text.slice(0, 300)}`).join('\n')}`
        : baseText;
      let briefText = fallbackText;
      if (!deps.demo && agent.status().available) {
        try {
          const prompt = buildBriefingPrompt(data.name, fallbackText, tz, to);
          const reply = await Promise.race([
            agent.ask(prompt, { readOnly: true }),
            new Promise<never>((_, reject) => {
              const t = setTimeout(() => reject(new Error('简报模型总结超时')), 45000);
              t.unref();
            }),
          ]);
          const summary = reply.status === 'done' ? reply.text?.trim() : '';
          if (summary) briefText = `${fallbackText.split('\n')[0]}\n${summary}`;
        } catch {
          // Fall back to deterministic facts brief if model call fails or times out.
        }
      }
      const globalBot = notificationBots()
        .filter(b => b.scope.kind === 'global' && b.enabled && b.configured && b.connected && b.paired && b.replyTarget)
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      const briefChannel = globalBot ? notificationChannel(globalBot) : 'feishu.bot';
      store.transaction(() => {
        store.put('background.briefs', event.id, { id: event.id, createdAt: new Date().toISOString(), facts });
        store.put('briefing.windows', windowKey, { eventId: event.id });
        store.put('briefing.cursors', 'last', { to });
        background.outbox.enqueueNotice('daily-brief', {
          dedupKey: `brief:${windowKey}`,
          channel: briefChannel,
          target: 'owner',
          content: { text: briefText },
          causedBy: event.id,
          ...(event.staleIf ? { staleIf: event.staleIf } : {}),
        });
      });
      return { status: 'done' };
    },
  });

  const offNotifications = background.eventbox.subscribe('core', {
    name: 'notifications',
    types: [{ type: 'todo.reminder_due', version: 1 }, { type: 'supervisor.review.created', version: 1 }],
    effects: 'none',
    handler(event) {
      const data = event.data as unknown as { todoId?: string; title?: string; text?: string; messageId?: string; id?: string; reminderAt?: string };
      if (event.type === 'todo.reminder_due') {
        const todo = data.todoId ? store.get<Todo>('todos', data.todoId) : undefined;
        if (!todo || todo.completedAt || !data.reminderAt || todo.reminderAt !== data.reminderAt) return { status: 'skip', reason: 'reminder_changed' };
      }
      const message = data.messageId ? store.get<Message>('messages', data.messageId) : undefined;
      // A review card already has its own notification event; avoid a second summary of the same review.
      if (event.type === 'interaction.user_required' && data.id && store.get<Card>('interactions', data.id)?.kind === 'review') return { status: 'skip', reason: 'review_has_notification' };
      const text = event.type === 'todo.reminder_due'
        ? `待办提醒：${data.title}\n/#todos`
        : event.type === 'supervisor.review.created'
          ? `督办复核建议：${(data.text || '').slice(0, 1000)}\n/#supervision`
          : `${(message?.text || '有交互事项需要你处理').slice(0, 1000)}\n/#interactions`;
      background.outbox.enqueue(event.type === 'todo.reminder_due' ? 'reminders' : 'supervisor', {
        dedupKey: `notification:${event.id}`,
        channel: 'feishu.bot',
        target: 'owner',
        content: { text },
        causedBy: event.id,
        ...(data.todoId ? { relatedTo: { kind: 'todo', id: data.todoId } } : {}),
        ...(event.staleIf ? { staleIf: event.staleIf } : {}),
      });
      return { status: 'done' };
    },
  });

  if (!background.schedules.forOwner('daily-brief').list().length) {
    for (const [name, cron] of [['morning', '0 9 * * *'], ['evening', '0 18 * * *']]) {
      background.schedules.forOwner('daily-brief').create({ name: name!, kind: 'cron', cron: cron!, tz: 'Asia/Shanghai' });
    }
  }

  const offProjectBrief = background.eventbox.subscribe('core', {
    name: 'project-dailybrief',
    types: [{ type: 'schedule.due', version: 1 }],
    effects: 'none',
    handler: event => projectFollowUp.handle(event),
  });

  for (const name of ['core.plan.propose', 'core.agent.ask', 'core.approval.propose', 'core.interaction.open', 'core.inbox.ingest']) {
    contributions.add('services', name, {
      name,
      version: 1,
      async handler(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw createInputError('服务参数必须为对象');
        const owner = requiredText(value.__owner, '插件身份');
        if (name === 'core.inbox.ingest') {
          if (!plugins.list().some(plugin => plugin.id === owner && plugin.status === 'active')) throw createInputError('采集插件未启用', 409);
          const sourceId = requiredText(value.sourceId, '来源标识');
          if (!/^[A-Za-z0-9._-]{1,100}$/.test(sourceId) || !Array.isArray(value.items) || value.items.length > 500) throw createInputError('采集来源或消息批次无效');
          // ExtensionContext injects __owner. A plugin cannot impersonate Feishu or
          // another connector, nor assign lifecycle/project state through intake.
          const source = `plugin:${owner}:${sourceId}`;
          if (value.evidence !== undefined && (!Array.isArray(value.evidence) || value.evidence.length > 500)) throw createInputError('回复证据批次无效');
          await inbox.ingest(source, value.items as unknown as InboxThing[]);
          if (value.evidence !== undefined) {
            if (!plugins.list().some(plugin => plugin.id === owner && plugin.status === 'active')) throw createInputError('采集插件已停止', 409);
            waitingReplies.observeSource(source, value.evidence as unknown as CollectedReplyEvidence[]);
          }
          return { accepted: true, count: value.items.length, source };
        }
        if (name === 'core.plan.propose') return proposePlan({ ...value, start: false }) as unknown as Json;
        if (name === 'core.agent.ask') {
          background.claimModel(owner);
          return await agent.ask(requiredText(value.text, '问题'), { readOnly: true }) as unknown as Json;
        }
        if (name === 'core.approval.propose') {
          if (typeof value.kind !== 'string' || !value.kind.startsWith(`plugin:${owner}.`)) throw createInputError('审批 kind 必须属于调用插件', 403);
          const key = typeof value.dedupKey === 'string' ? `${owner}:${value.dedupKey}` : undefined;
          return store.transaction(() => {
            const old = key ? store.get<{ id: string }>('background.approval-requests', key) : undefined;
            if (old) {
              const approval = store.get<Approval>('approvals', old.id);
              if (approval) return approval as unknown as Json;
            }
            const approval = approvals.propose(value as unknown as Parameters<typeof approvals.propose>[0]);
            if (key) store.put('background.approval-requests', key, { id: approval.id });
            return approval as unknown as Json;
          });
        }
        return interactions.open(value as unknown as Parameters<typeof interactions.open>[0]) as unknown as Json;
      },
    });
  }

  for (const plugin of plugins.list()) background.host.ownerEnabled(plugin.id, plugin.status === 'active');
  background.start();

  const offInteractionNotice = events.subscribe(event => {
    if (event.type !== 'interactions.user_required' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data) || typeof event.data.id !== 'string') return;
    const id = event.data.id;
    // The origin is persisted immediately after open(). Defer observation until that write completes.
    void Promise.resolve().then(() => {
      if (isClosing()) return;
      const card = store.get<Card>('interactions', id);
      if (!card || card.userNotifiedAt) return;
      const origin = store.get<{ inputId?: string }>('interaction-origins', id);
      const now = new Date().toISOString();
      const messageId = `interaction-notice:${id}`;
      store.transaction(() => {
        store.put('interactions', id, { ...card, userNotifiedAt: now });
        const message: Message = {
          id: messageId,
          conversationId: 'main',
          role: 'assistant',
          origin: 'notification',
          replyTo: origin?.inputId,
          projectId: card.projectId,
          text: `需要你处理：${card.title}\n${card.suggestion ?? card.body}\n请在“交互卡”中核对并回答。`,
          status: 'done',
          createdAt: now,
        };
        store.put('messages', messageId, message);
        store.put('notifications.source-presence', `interaction:${id}`, { present: presence.status().present });
        background.publish({ type: 'interaction.user_required', typeVersion: 1, sourceId: `interaction-notice:${id}`, data: { id, messageId }, subject: { kind: 'interaction', id } });
      });
      changed('messages.changed', { messageId });
      changed('notifications.message', { messageId });
    }).catch(error => {
      if (!isClosing()) console.error('交互卡通知保存失败', error instanceof Error ? error.message : 'unknown');
    });
  });

  return {
    async close() {
      await offProjectBrief();
      await offReview();
      await offSupervisor();
      await offBrief();
      await offNotifications();
      await offInteractionNotice();
    },
  };
}
