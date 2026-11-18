import type { DurableEvent, EventBus, EventResult, StaleReference, Store } from '../../plugin-sdk/src/index.ts';
import type { BriefingSettings, Project, Todo } from '../../protocol/src/index.ts';
import { buildWindowBrief, formatWindowBrief } from './briefing.ts';
import type { createSchedules } from './schedules.ts';

/** The host's durable background event, rather than the domain EventBus event. */
export type BackgroundEvent = DurableEvent;
export interface ProjectBriefInput {
  projectId: string;
  text: string;
  key: string;
  staleIf?: StaleReference;
}
export interface ProjectFollowUpGrant {
  projectId: string;
  version: number;
  signature: string;
  enabled: boolean;
  scheduleId?: string;
  scheduleVersion?: number;
}
interface Window {
  projectId: string;
  grantVersion: number;
  key: string;
  to: string;
  status: 'claimed' | 'queued' | 'unknown';
}
const grants = 'project-follow-up.grants';
const windows = 'project-follow-up.windows';
const cursors = 'project-follow-up.cursors';

/** Owns read-only project summaries. The host retains all outbound authorization. */
export function createProjectFollowUp({ store, events, schedules, settings, enqueue }: {
  store: Store;
  events: EventBus;
  schedules: Pick<ReturnType<typeof createSchedules>, 'forOwner'>;
  settings: () => BriefingSettings;
  enqueue: (input: ProjectBriefInput) => unknown;
}) {
  const api = schedules.forOwner('daily-brief');
  let closed = false;
  function sync() {
    if (closed) return;
    const global = settings();
    store.transaction(() => {
      const projects = store.list<Project>('projects');
      const ids = new Set([...projects.map(p => p.id), ...store.list<ProjectFollowUpGrant>(grants).map(g => g.projectId)]);
      const existing = api.list();
      for (const id of ids) {
        const project = projects.find(p => p.id === id);
        const follow = project?.followUp;
        // Approval presets and away notifications do not govern daily project briefs.
        const enabled = !!follow && !project?.archivedAt && follow.briefingEnabled !== false;
        const signature = JSON.stringify([follow?.briefingTime, follow?.briefingEnabled !== false, follow?.overdueReminders, project?.archivedAt ?? null, !!project, global.timezone]);
        const old = store.get<ProjectFollowUpGrant>(grants, id);
        let schedule = existing.find(s => s.name === `project:${id}:brief`);
        // Keep a tombstone even after deletion; revisions must never restart at one.
        if (!follow && !old && !schedule) continue;
        const changed = old?.signature !== signature || old?.scheduleId !== schedule?.id || old?.scheduleVersion !== schedule?.version;
        const version = (old?.version ?? 0) + (changed ? 1 : 0);
        if (enabled) {
          const [hour, minute] = follow!.briefingTime.split(':');
          const spec = { name: `project:${id}:brief`, kind: 'cron' as const, cron: `${Number(minute)} ${Number(hour)} * * *`, tz: global.timezone,
            payload: { projectId: id, grantVersion: version, signature } };
          if (!schedule) schedule = api.create(spec);
          else if (schedule.status !== 'cancelled' && (changed || schedule.cron !== spec.cron || schedule.tz !== spec.tz || schedule.status === 'paused')) {
            // owner_disabled is maintained by the host, never bypassed here.
            schedule = api.update(schedule.id, { ...spec, ...(schedule.status === 'paused' ? { status: 'active' as const } : {}) }, schedule.version);
          }
        } else if (schedule && !['paused', 'cancelled'].includes(schedule.status)) {
          schedule = api.update(schedule.id, { status: 'paused' }, schedule.version);
        }
        const next: ProjectFollowUpGrant = { projectId: id, version, signature, enabled, scheduleId: schedule?.id, scheduleVersion: schedule?.version };
        if (JSON.stringify(old) !== JSON.stringify(next)) store.put(grants, id, next);
      }
    });
  }
  function isCurrent(projectId: string, key: string): boolean {
    if (closed) return false;
    sync();
    const grant = store.get<ProjectFollowUpGrant>(grants, projectId);
    const window = store.get<Window>(windows, key);
    const schedule = api.list().find(s => s.id === grant?.scheduleId);
    return !!grant?.enabled && !!window && window.projectId === projectId && window.grantVersion === grant.version
      && schedule?.status === 'active' && schedule.version === grant.scheduleVersion;
  }
  async function handle(event: BackgroundEvent): Promise<EventResult> {
    if (closed || event.type !== 'schedule.due' || event.typeVersion !== 1) return { status: 'skip', reason: 'not_a_project_brief' };
    sync();
    const data = event.data as { owner?: string; name?: string; scheduleId?: string; scheduleVersion?: number; scheduledFor?: string; payload?: {projectId?: string; grantVersion?: number; signature?: string} } | null;
    const id = data?.payload?.projectId;
    if (!id || data?.owner !== 'daily-brief' || data.name !== `project:${id}:brief`) return { status: 'skip', reason: 'not_a_project_brief' };
    const grant = store.get<ProjectFollowUpGrant>(grants, id);
    const schedule = api.list().find(s => s.id === data.scheduleId);
    if (!grant?.enabled || schedule?.status !== 'active' || grant.scheduleId !== data.scheduleId
      || grant.scheduleVersion !== data.scheduleVersion || schedule.version !== data.scheduleVersion
      || grant.version !== data.payload?.grantVersion || grant.signature !== data.payload?.signature) return { status: 'skip', reason: 'stale_project_brief' };
    const to = data.scheduledFor;
    if (!to || !Number.isFinite(Date.parse(to))) return { status: 'skip', reason: 'invalid_project_window' };
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: settings().timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(to));
    // Daily dedup survives time and timezone edits and is independent of global briefs.
    const key = JSON.stringify([id, day]);
    const previous = store.get<{to: string}>(cursors, id)?.to;
    if (store.get(windows, key) || (previous && Date.parse(previous) >= Date.parse(to))) return { status: 'skip', reason: 'project_window_already_covered' };
    const from = previous ?? new Date(Date.parse(to) - 86400000).toISOString();
    const brief = buildWindowBrief(store, from, to, id);
    const follow = store.get<Project>('projects', id)!.followUp!;
    const overdue = follow.overdueReminders
      ? store.list<Todo>('todos').filter(t => t.projectId === id && !t.completedAt && t.dueAt && Date.parse(t.dueAt) < Date.parse(to) && Date.parse(t.createdAt) <= Date.parse(to)).map(t => ({ id: t.id, title: t.title })) : undefined;
    const text = formatWindowBrief({ ...brief, ...(overdue ? { overdue } : {}) }, 'project');
    // Claim before the outbound callback. It can have acted before throwing or crashing;
    // keep unknown claims across restart instead of repeating an uncertain action.
    store.transaction(() => {
      store.put<Window>(windows, key, { projectId: id, grantVersion: grant.version, key, to, status: 'claimed' });
      store.put(cursors, id, { to });
    });
    try {
      await enqueue({ projectId: id, text, key, staleIf: { ref: `schedule:${schedule.id}`, version: schedule.version } });
      store.put<Window>(windows, key, { projectId: id, grantVersion: grant.version, key, to, status: 'queued' });
      return { status: 'done' };
    } catch {
      store.put<Window>(windows, key, { projectId: id, grantVersion: grant.version, key, to, status: 'unknown' });
      return { status: 'failed', reason: 'project_enqueue_unknown' };
    }
  }
  const off = events.subscribe(event => { if (event.type === 'projects.changed') sync(); });
  sync();
  return { sync, handle, isCurrent, close() { closed = true; return off(); } };
}
