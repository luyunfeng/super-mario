import { runScopeClock } from './run-scope.ts';
import { todoSections, todoDecisionIds } from './todo-sections.ts';
import { buildWindowBrief } from './briefing.ts';
import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';
import type { Approval, AutomationSettings as ProtocolAutomationSettings, JsonObject, MachineInfo, Run, SupervisionSignal, Todo } from '../../protocol/src/index.ts';

// Keep compatibility until the shared protocol also exposes the estimate factor.
type AutomationSettings = ProtocolAutomationSettings & { stalledFactorOfEstimate?: number };
type ResolvedAutomationSettings = AutomationSettings & { stalledFactorOfEstimate: number };

const defaults: ResolvedAutomationSettings = { tickSeconds: 30, stalledMinutes: 20, stalledFactorOfEstimate: 1.5, needsYouMinutes: 3, remindersEnabled: true };
const settingsCollection = 'supervision.settings';
const signalsCollection = 'supervision.signals';

function validate(patch: Partial<AutomationSettings>): void {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('督办配置必须为对象');
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'remindersEnabled') {
      if (typeof value !== 'boolean') throw new TypeError('remindersEnabled必须为布尔值');
    } else if (key === 'stalledFactorOfEstimate') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 10) {
        throw new TypeError('stalledFactorOfEstimate必须为1到10之间的有限数字');
      }
    } else {
      const max = key === 'tickSeconds' ? 3600 : 43200;
      if (!['tickSeconds', 'stalledMinutes', 'needsYouMinutes'].includes(key)
        || !Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
        throw new TypeError(`${key}必须为1到${max}之间的整数`);
      }
    }
  }
}

/** One scheduler per store. Notifications are local events, never external actions.
 * Reminder claims deliberately precede publishing: an uncertain publish is not retried.
 */
export function createSupervision({ store, events, enabled = () => true, now = () => new Date(), publish, conversations }: {
  conversations?:()=>import('../../protocol/src/inbox-conversations.ts').InboxConversation[];
  store: Store; events: EventBus; enabled?: () => boolean; now?: () => Date; publish?: (event: import('../../plugin-sdk/src/index.ts').EventInput) => unknown;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let closed = false;
  const settings = (): ResolvedAutomationSettings => {
    const value = { ...defaults, ...store.get<AutomationSettings>(settingsCollection, 'automation') };
    validate(value);
    return value;
  };
  settings(); // Fail explicitly on invalid persisted settings, before scheduling work.
  // Upgrade timestamp-based terminal identities without re-reviewing an already processed fact.
  store.transaction(()=>{
    for(const old of store.list<SupervisionSignal>(signalsCollection)) {
      if(old.kind!=='review'||!old.runId)continue;
      const run=store.get<Run>('runs',old.runId);if(!run||!['completed','failed'].includes(run.status))continue;
      const id=JSON.stringify(['review',run.id,`${run.status}:terminal`]);if(id===old.id)continue;
      const processed=store.get('supervisor.processed',old.id);
      if(processed&&!store.get('supervisor.processed',id))store.put('supervisor.processed',id,processed);
      if(!store.get(signalsCollection,id))store.put(signalsCollection,id,{...old,id});
      store.remove(signalsCollection,old.id);
    }
  });

  const signals = () => store.list<SupervisionSignal>(signalsCollection);
  const usable = () => !closed && enabled();

  function tick(): void {
    if (!usable()) return;
    const config = settings();
    const date = now();
    const timestamp = date.toISOString();
    const aged = (value: string, minutes: number) => date.getTime() - Date.parse(value) >= minutes * 60000;
    const desired = new Map<string, SupervisionSignal>();
    function add(kind: SupervisionSignal['kind'], target: string, version: string | number,
      text: string, reference: { runId?: string; todoId?: string } = {}) {
      // JSON tuple encoding avoids collisions between ids containing separators.
      const id = JSON.stringify([kind, target, version]);
      desired.set(id, { id, kind, text, ...reference, createdAt: timestamp });
    }
    for (const run of store.list<Run>('runs')) {
      if (run.status === 'completed' || run.status === 'failed') {
        add('review', run.id, `${run.status}:terminal`, `执行${run.status === 'completed' ? '完成' : '失败'}，请复核：${run.id}`, { runId: run.id });
      }
      // Only an accepted scope revision restarts the clock. Output and heartbeat updates do not.
      const estimate = typeof run.expectMinutes === 'number' && Number.isFinite(run.expectMinutes) && run.expectMinutes > 0
        ? run.expectMinutes : 0;
      const stalledMinutes = Math.max(config.stalledMinutes, estimate * config.stalledFactorOfEstimate);
      const revision = run.status === 'running' && run.todoId ? runScopeClock(store,run) : undefined;
      if (run.status === 'running' && aged(revision?.createdAt ?? run.createdAt, stalledMinutes)) {
        add('stalled', run.id, revision?.version ?? 'running', `执行已超过督办时限：${run.id}`, { runId: run.id });
      }
      if (['queued', 'running', 'unknown'].includes(run.status) && run.machineId
        && store.get<MachineInfo>('machines', run.machineId)?.online === false) {
        add('orphaned', run.id, run.machineId, `执行机离线，执行结果待确认：${run.id}`, { runId: run.id });
      }
    }
    // The protocol calls pendingApproval records Approval with status=pending.
    for (const approval of store.list<Approval>('approvals')) {
      if (approval.status === 'pending' && aged(approval.updatedAt, config.needsYouMinutes)) {
        add('needs_you', approval.id, approval.version, `等待你的审批：${approval.title}`,
          approval.todoId ? { todoId: approval.todoId } : {});
      }
    }
    const notifications: SupervisionSignal[] = [];
    store.transaction(() => {
      for (const todo of store.list<Todo>('todos')) {
        if (!config.remindersEnabled || todo.completedAt || !todo.reminderAt || Date.parse(todo.reminderAt) > date.getTime()
          || !Number.isFinite(Date.parse(todo.reminderAt))) continue;
        const id = JSON.stringify(['reminder', todo.id, todo.reminderAt]);
        // Re-read the claim inside the transaction. Multiple service instances and
        // reentrant event observers must not send the same reminder twice.
        const current = store.get<Todo>('todos', todo.id);
        if (!current || current.completedAt || current.reminderAt !== todo.reminderAt) continue;
        if (!current.remindedAt) {
          store.put('todos', todo.id, { ...current, remindedAt: timestamp });
          add('reminder', todo.id, todo.reminderAt, `待办提醒：${todo.title}`, { todoId: todo.id });
          publish?.({ type: 'todo.reminder_due', typeVersion: 1, sourceId: `reminder:${todo.id}:${todo.reminderAt}`, data: { todoId: todo.id, title: todo.title, reminderAt: todo.reminderAt }, subject: { kind: 'todo', id: todo.id } });
        } else {
          const previous = store.get<SupervisionSignal>(signalsCollection, id);
          if (previous) desired.set(id, previous);
        }
      }
      for (const [id, candidate] of desired) {
        const previous = store.get<SupervisionSignal>(signalsCollection, id);
        if (!previous || previous.resolvedAt) {
          const { resolvedAt: _, ...open } = candidate;
          store.put(signalsCollection, id, open);
          notifications.push(open);
          publish?.({ type: 'supervision.signal', typeVersion: 1, sourceId: `signal:${open.id}`, data: { id: open.id, kind: open.kind, text: open.text, ...(open.runId ? { runId: open.runId } : {}), ...(open.todoId ? { todoId: open.todoId } : {}) }, subject: { kind: open.runId ? 'run' : 'todo', id: open.runId || open.todoId || open.id } });
        }
      }
      for (const previous of signals()) {
        if (!previous.resolvedAt && !desired.has(previous.id)) {
          store.put(signalsCollection, previous.id, { ...previous, resolvedAt: timestamp });
        }
      }
    });
    // No observer runs until the claims and signal transitions have committed.
    for (const signal of notifications) events.publish('notifications.created', { ...signal });
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (!started || closed) return;
    timer = setInterval(() => {
      try { tick(); }
      catch (error) {
        // Timer errors remain visible without crashing the server or claiming success.
        console.error('Supervision tick failed', error);
      }
    }, settings().tickSeconds * 1000);
    timer.unref();
  }

  return {
    settings,
    configure(patch: Partial<AutomationSettings>): ResolvedAutomationSettings {
      validate(patch);
      const next = store.transaction(() => {
        const value = { ...settings(), ...patch };
        store.put(settingsCollection, 'automation', value);
        return value;
      });
      schedule();
      return next;
    },
    signals,
    resolvePreviousStall(runId: string, version: number, resolvedAt: string) {
      const id = JSON.stringify(['stalled',runId,version || 'running']);
      const previous = store.get<SupervisionSignal>(signalsCollection,id);
      if (previous && !previous.resolvedAt) store.put(signalsCollection,id,{...previous,resolvedAt});
    },
    tick,
    start() { if (started || closed) return; started = true; schedule(); },
    close() { closed = true; started = false; if (timer) clearInterval(timer); timer = undefined; },
    brief(): JsonObject | null {
      if (!usable()) return null;
      const timestamp = now().getTime();
      const todos = store.list<Todo>('todos');
      const partitions: Record<string, Todo[]> = { overdue: [], waiting: [], upcoming: [], completed: [] };
      for (const todo of todos) {
        const group = todo.completedAt ? 'completed' : todo.waitingOn ? 'waiting'
          : todo.dueAt && Date.parse(todo.dueAt) <= timestamp ? 'overdue' : 'upcoming';
        partitions[group].push(todo);
      }
      const runs: Record<Run['status'], number> = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, unknown: 0 };
      for (const run of store.list<Run>('runs')) runs[run.status]++;
      // Serialization removes optional undefined fields from protocol records.
      return JSON.parse(JSON.stringify({ window: buildWindowBrief(store,new Date(timestamp-86400000).toISOString(),new Date(timestamp).toISOString(),undefined,conversations?.()), sections: todoSections(todos, new Date(timestamp), todoDecisionIds(store)), todos: partitions, runs, signals: signals().filter(signal => !signal.resolvedAt) })) as JsonObject;
    },
  };
}
