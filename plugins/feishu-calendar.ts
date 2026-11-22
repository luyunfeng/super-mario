import type { Json } from '../packages/protocol/src/index.ts';
import { personalProblem, runPersonalCLI, type PersonalCLI } from './feishu-personal.ts';

export interface CalendarEventItem {
  eventId?: string;
  summary: string;
  startTime: string;
  endTime: string;
  status?: string;
  meetingUrl?: string;
  organizer?: string;
}

export interface CalendarConflict {
  first: string;
  second: string;
  overlapMinutes: number;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function parseTime(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim()) {
    if (/^\d{10}$/.test(raw.trim())) return new Date(Number(raw.trim()) * 1000).toISOString();
    if (/^\d{13}$/.test(raw.trim())) return new Date(Number(raw.trim())).toISOString();
    return raw.trim();
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const date = new Date(raw > 1e12 ? raw : raw * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Row;
    return parseTime(obj.timestamp ?? obj.date ?? obj.iso ?? obj.time);
  }
  return '';
}

function extractItems(raw: Row) {
  const data = (raw.data && typeof raw.data === 'object' ? raw.data : raw) as Row;
  const list = Array.isArray(data.items) ? data.items
    : Array.isArray(data.events) ? data.events
      : Array.isArray(raw.items) ? raw.items
        : undefined;
  if (!list) throw new Error('invalid agenda response');
  const events: CalendarEventItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Row;
    const summary = str(item.summary ?? item.title) || '（无标题日程）';
    const startTime = parseTime(item.start_time ?? item.startTime ?? item.start);
    const endTime = parseTime(item.end_time ?? item.endTime ?? item.end);
    if (!(Date.parse(endTime) > Date.parse(startTime))) continue;
    const vchat = (item.vchat && typeof item.vchat === 'object' ? item.vchat : undefined) as Row | undefined;
    const meetingUrl = str(item.meeting_url ?? item.meetingUrl ?? vchat?.meeting_url ?? vchat?.url);
    const eventStatus = str(item.status).toLowerCase();
    const status = ['cancelled', 'canceled'].includes(eventStatus) ? eventStatus : str(item.self_status ?? item.rsvp_status ?? item.status);
    const organizer = str(item.organizer_name ?? (item.organizer && typeof item.organizer === 'object' ? (item.organizer as Row).display_name : ''));
    const eventId = str(item.event_id ?? item.eventId ?? item.id);
    events.push({
      ...(eventId ? { eventId } : {}),
      summary: summary.slice(0, 160),
      startTime,
      endTime,
      ...(status ? { status } : {}),
      ...(meetingUrl ? { meetingUrl } : {}),
      ...(organizer ? { organizer } : {}),
    });
  }
  events.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  return { events, unreadable: list.length - events.length, hasMore: data.has_more === true || raw.has_more === true };
}

export function detectCalendarConflicts(events: readonly CalendarEventItem[]): CalendarConflict[] {
  const active = events
    .filter(e => !['decline', 'declined', 'cancelled', 'canceled'].includes((e.status ?? '').toLowerCase()))
    .map(e => ({ summary: e.summary, start: Date.parse(e.startTime), end: Date.parse(e.endTime) }))
    .filter(e => Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start)
    .sort((a, b) => a.start - b.start);
  const conflicts: CalendarConflict[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (active[j]!.start >= active[i]!.end) break;
      const overlapMs = Math.min(active[i]!.end, active[j]!.end) - active[j]!.start;
      const overlapMinutes = Math.round(overlapMs / 60000);
      if (overlapMinutes > 0) {
        conflicts.push({ first: active[i]!.summary, second: active[j]!.summary, overlapMinutes });
      }
    }
  }
  return conflicts;
}

/**
 * Read-only Feishu calendar agenda fetcher via lark-cli.
 * Computes overlapping time conflicts deterministically in code.
 */
export async function fetchCalendarAgenda(options: {
  profile?: string;
  start?: string;
  end?: string;
  signal: AbortSignal;
  runCLI?: PersonalCLI;
}): Promise<Json> {
  if (!options.profile) {
    return { available: false, reason: '尚未授权个人飞书账号，无法读取日历。请先在“渠道”页授权飞书个人账号。', events: [], conflicts: [] };
  }
  const cli = options.runCLI ?? runPersonalCLI;
  const args = ['--profile', options.profile, '--as', 'user', 'calendar', '+agenda'];
  if (options.start) args.push('--start', options.start);
  if (options.end) args.push('--end', options.end);
  args.push('--format', 'json');
  try {
    const raw = await cli(args, { signal: options.signal, timeout: 20_000 });
    const { events, unreadable, hasMore } = extractItems(raw as Row);
    if (!events.length && unreadable) {
      return { available: false, reason: '日程记录的起止时间无法核实，请稍后重查。', events: [], conflicts: [] };
    }
    const conflicts = detectCalendarConflicts(events);
    return {
      available: true,
      count: events.length,
      partial: hasMore || unreadable > 0 || events.length > 50,
      unreadable, hasMore,
      events: events.slice(0, 50) as unknown as Json,
      conflicts: conflicts as unknown as Json,
    };
  } catch (error) {
    const problem = personalProblem(error);
    return {
      available: false,
      reason: problem?.kind === 'permissions' ? '个人飞书账号缺少日历读取权限，请核对应用权限及用户授权。'
        : problem && ['unavailable', 'expired', 'needs_application'].includes(problem.kind) ? problem.message
          : '读取飞书日历失败，日程尚未核实。',
      events: [],
      conflicts: [],
    };
  }
}
