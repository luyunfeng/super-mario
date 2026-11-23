import type { Json, Store } from '../packages/plugin-sdk/src/index.ts';
import type { InboxItem, Run, Todo } from '../packages/protocol/src/index.ts';
import { excludesPersonalGroupFromBrief } from '../packages/protocol/src/index.ts';

export type TodayItem = { id: string; title: string; kind: string; at: string; reason?: string; projectId?: string; endAt?: string };
export type TodaySection = { total: number; items: TodayItem[]; truncated: boolean; totalIsLowerBound?: boolean };
type CalendarSection = TodaySection & { available: boolean; reason?: string };
export type TodayBrief = { date: string; timezone: string; generatedAt: string; decisions: TodaySection; inbox: TodaySection;
  mentions: TodaySection; completed: TodaySection; failed: TodaySection; running: TodaySection; calendar: CalendarSection };
export type TodayBriefSources = { timezone: string; calendarIdentity?: string; calendarUnavailableReason?: string; decisions: TodayItem[]; inbox: InboxItem[] };
type Actions = { todayBriefSources?(): TodayBriefSources;
  calendarAgenda?(input: { start?: string; end?: string }, signal: AbortSignal): Promise<Json> };

const pageSize = 12;
const dayMs = 86_400_000;
const bounded = (value: string, size = 180) => value.slice(0, size);
function section(rows: TodayItem[], chronological = false): TodaySection {
  const sortOrder = chronological ? 1 : -1;
  rows.sort((a, b) => sortOrder * (Date.parse(a.at) - Date.parse(b.at)) || a.id.localeCompare(b.id));
  return { items: rows.slice(0, pageSize), total: rows.length, truncated: rows.length > pageSize };
}

// Find the two actual civil-day boundaries; midnight need not exist and a day
// with a DST transition can span 23 or 25 hours.
function dayWindow(now: number, timezone: string) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const date = format.format(now);
  function boundary(lo: number, hi: number, after: boolean) {
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const localDate = format.format(mid);
      if (after ? localDate > date : localDate >= date) hi = mid;
      else lo = mid;
    }
    return hi;
  }
  return { date, start: boundary(now - 2 * dayMs, now, false), end: boundary(now, now + 2 * dayMs, true) };
}

function unavailable(reason: string): CalendarSection {
  return { available: false, total: 0, items: [], truncated: false, reason };
}

async function calendarSection(actions: Actions, sources: TodayBriefSources, window: ReturnType<typeof dayWindow>, signal: AbortSignal) {
  if (!sources.calendarIdentity) return unavailable(sources.calendarUnavailableReason || '飞书个人账号尚未授权');
  if (!actions.calendarAgenda) return unavailable('日程读取未接入');
  try {
    const result = await actions.calendarAgenda({ start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() }, signal);
    signal.throwIfAborted();
    if (!result || typeof result !== 'object' || Array.isArray(result)) return unavailable('日程响应无效');
    if (result.available !== true) return unavailable(typeof result.reason === 'string' ? bounded(result.reason) : '日程尚未核实');
    if (!Array.isArray(result.events)) return unavailable('日程响应无效');
    const items: TodayItem[] = [];
    let unreadable = false;
    for (const event of result.events) {
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.summary !== 'string'
        || typeof event.startTime !== 'string' || typeof event.endTime !== 'string' || !(Date.parse(event.endTime) > Date.parse(event.startTime))) {
        unreadable = true;
        continue;
      }
      if (typeof event.status === 'string' && ['decline', 'declined', 'cancelled', 'canceled'].includes(event.status.toLowerCase())) continue;
      // All-day dates are local civil dates. Timed events use their explicit offset.
      const allDay = /^\d{4}-\d\d-\d\d$/.test(event.startTime) && /^\d{4}-\d\d-\d\d$/.test(event.endTime);
      if (allDay ? event.startTime > window.date || event.endTime <= window.date
        : Date.parse(event.endTime) <= window.start || Date.parse(event.startTime) >= window.end) continue;
      items.push({ id: typeof event.eventId === 'string' ? event.eventId : '', title: bounded(event.summary), kind: 'calendar',
        at: event.startTime, endAt: event.endTime, ...(typeof event.status === 'string' && { reason: bounded(event.status) }) });
    }
    const page = section(items, true);
    const incomplete = result.partial === true || unreadable;
    return { ...page, available: true, truncated: page.truncated || incomplete, ...(incomplete && {totalIsLowerBound:true}) };
  } catch {
    signal.throwIfAborted();
    return unavailable('读取飞书日历失败，日程尚未核实');
  }
}

export async function readTodayBrief(store: Pick<Store, 'list'>, actions: Actions, input: Json, signal: AbortSignal, now = Date.now()): Promise<TodayBrief> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
    throw Object.assign(new Error('今日简报不接受查询参数'), { status: 400 });
  signal.throwIfAborted();
  if (!actions.todayBriefSources) throw Object.assign(new Error('今日简报数据源尚未接入'), { status: 503 });
  const initial = actions.todayBriefSources();
  const window = dayWindow(now, initial.timezone);
  let calendar = await calendarSection(actions, initial, window, signal);
  signal.throwIfAborted();
  // Channel grants and the account can change while the calendar request is in flight.
  const current = actions.todayBriefSources();
  if (current.timezone !== initial.timezone) throw Object.assign(new Error('简报时区已变更，请刷新'), { status: 409 });
  if (current.calendarIdentity !== initial.calendarIdentity) calendar = unavailable('飞书日历授权已变更，请刷新');
  const today = (at: string) => Date.parse(at) >= window.start && Date.parse(at) <= now;
  const runs = store.list<Run>('runs');
  const runItem = (r: Run): TodayItem => ({ id: r.id, kind: r.status, title: bounded(r.prompt), at: r.updatedAt,
    ...(r.projectId && { projectId: r.projectId }), ...(r.status === 'failed' && { reason: bounded(r.error?.trim() || '未记录失败原因', 300) }) });
  const inbox = current.inbox.filter(row => !row.archivedAt && !excludesPersonalGroupFromBrief(row));
  const inboxItem = (row: InboxItem): TodayItem => ({ id: row.id, title: bounded(row.title), kind: 'inbox', at: row.receivedAt || row.updatedAt,
    ...(row.projectId && { projectId: row.projectId }) });
  const completed = store.list<Todo>('todos').flatMap((todo): TodayItem[] => todo.completedAt && today(todo.completedAt)
    ? [{ id: todo.id, kind: 'todo', title: bounded(todo.title), at: todo.completedAt, ...(todo.projectId && { projectId: todo.projectId }) }] : []);
  return { date: window.date, timezone: current.timezone, generatedAt: new Date(now).toISOString(),
    decisions: section(current.decisions.map(row => ({ id: row.id, kind: row.kind, at: row.at, title: bounded(row.title), ...(row.projectId && { projectId: row.projectId }) }))),
    inbox: section(inbox.filter(row => row.tier === 'action').map(inboxItem)),
    mentions: section(inbox.filter(row => row.origin?.kind === 'group' && row.origin.mentionedMe === true && row.receivedAt && today(row.receivedAt)).map(inboxItem)),
    completed: section([...completed, ...runs.filter(r => r.status === 'completed' && today(r.updatedAt)).map(runItem)]),
    failed: section(runs.filter(r => r.status === 'failed' && today(r.updatedAt)).map(runItem)),
    running: section(runs.filter(r => r.status === 'running' || r.status === 'queued').map(runItem)), calendar };
}
