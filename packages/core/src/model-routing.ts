// What model each kind of work uses, how much of it a day allows, and what to fall back to.
//
// There is one provider, with one key and one endpoint (model.json). What a purpose may change
// is the model within it: a cheaper one for background work, a stronger one for review. A purpose
// with no model of its own follows the main model, as everything did before this existed.
import type { Store } from '../../plugin-sdk/src/index.ts';

/** The kinds of work the workbench does with a model. */
export const PURPOSES = ['main', 'supervisor', 'lessons', 'translation', 'inbox'] as const;
export type Purpose = typeof PURPOSES[number];

/** What a purpose is called, and what it does, for the settings page. */
export const PURPOSE_INFO: Record<Purpose, { name: string; about: string }> = {
  main: { name: '主对话', about: 'Web 和飞书里的问答。其他用途没有单独设置时都跟随它。' },
  supervisor: { name: '后台督办', about: '自动跟进、核对执行结果和简报。可以用便宜些的型号。' },
  lessons: { name: '项目经验提炼', about: '验收后从完成的任务里提炼经验。可以用便宜些的型号。' },
  translation: { name: '回复翻译', about: '把回复翻成另一种语言。可以用便宜些的型号。' },
  inbox: { name: '收件箱整理', about: '收件箱的归并、分类和起草回复。' },
};

/** How one purpose is set. Every field is optional: empty means "as before". */
export interface PurposeRule {
  /** The model within the configured provider. Empty follows the main model. */
  model?: string;
  /** The model to try when the first one fails in a way that says it is unavailable. */
  fallback?: string;
  /** The most requests a day. Absent or 0 is no limit. */
  dailyLimit?: number;
}

/** The whole routing: what each purpose does. */
export type Routing = Partial<Record<Purpose, PurposeRule>>;

const KEY = 'model-routing';
/** One document per purpose and day: how many requests were made. */
const USAGE_OF = (purpose: Purpose, day: string) => 'model-routing.usage:' + purpose + ':' + day;

/** The day a moment is in, in the owner's time zone, as the usage windows are kept by. */
function dayOf(now: Date, timeZone: string): string {
  // A day is named by its parts and not by shifting a timestamp, so that it is right across DST.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Whether a model id is one a provider could be asked for. */
export function validModelId(model: string): boolean {
  return model.length > 0 && model.length <= 256 && /^[a-zA-Z0-9~][a-zA-Z0-9._/:@\[\]-]*$/.test(model);
}

/** Reads the routing that is saved, dropping what is not well-formed. */
export function readRouting(store: Pick<Store, 'get'>): Routing {
  const saved = store.get<Record<string, unknown>>('settings', KEY);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  const routing: Routing = {};
  for (const purpose of PURPOSES) {
    const rule = saved[purpose];
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
    const { model, fallback, dailyLimit } = rule as Record<string, unknown>;
    const next: PurposeRule = {};
    if (typeof model === 'string' && validModelId(model.trim())) next.model = model.trim();
    if (typeof fallback === 'string' && validModelId(fallback.trim())) next.fallback = fallback.trim();
    if (typeof dailyLimit === 'number' && Number.isSafeInteger(dailyLimit) && dailyLimit > 0) next.dailyLimit = dailyLimit;
    if (Object.keys(next).length) routing[purpose] = next;
  }
  return routing;
}

export class RoutingError extends Error { status = 400; }

/** Checks a rule before it is saved. `main` cannot follow itself, so it needs a model of its own. */
export function validateRule(purpose: Purpose, input: unknown): PurposeRule {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RoutingError('用途设置必须为对象');
  const rule = input as Record<string, unknown>;
  for (const key of Object.keys(rule)) if (!['model', 'fallback', 'dailyLimit'].includes(key)) throw new RoutingError('用途设置只接受 model、fallback 和 dailyLimit');
  const next: PurposeRule = {};
  const model = text(rule.model), fallback = text(rule.fallback);
  if (model && !validModelId(model)) throw new RoutingError('型号格式无效');
  if (fallback && !validModelId(fallback)) throw new RoutingError('备用型号格式无效');
  if (model) next.model = model;
  if (fallback) next.fallback = fallback;
  if (fallback && fallback === model) throw new RoutingError('备用型号不能和首选型号相同');
  if (rule.dailyLimit !== undefined && rule.dailyLimit !== null && rule.dailyLimit !== 0 && rule.dailyLimit !== '0') {
    const limit = Number(rule.dailyLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) throw new RoutingError('每日上限须为 1 到 1000000 的整数，留空或 0 表示不限');
    next.dailyLimit = limit;
  }
  return next;
}

/** What a purpose resolves to for one request. */
export interface Resolved {
  /** The model asked for first. */
  model: string;
  /** Whether this purpose has a model of its own, or follows the main model. */
  own: boolean;
  /** The model to try if the first is unavailable. */
  fallback: string | undefined;
  /** Why nothing may be asked for, when the day's limit is reached. */
  blocked: string | undefined;
  /** How many requests this purpose made today, and the limit if there is one. */
  usage: { used: number; limit: number | undefined };
}

/** The main model's id, as the purposes without one of their own follow. */
export function resolvePurpose(store: Pick<Store, 'get'>, routing: Routing, purpose: Purpose, mainModel: string | undefined, now: Date, timeZone: string): Resolved {
  const rule = routing[purpose] ?? {};
  const own = purpose !== 'main' && Boolean(rule.model);
  const day = dayOf(now, timeZone);
  const used = store.get<{ count: number }>('settings', USAGE_OF(purpose, day))?.count ?? 0;
  const limit = rule.dailyLimit && rule.dailyLimit > 0 ? rule.dailyLimit : undefined;
  const exhausted = limit !== undefined && used >= limit;
  return {
    model: own ? rule.model! : mainModel ?? '',
    own,
    fallback: rule.fallback && rule.fallback !== (own ? rule.model : mainModel) ? rule.fallback : undefined,
    // The main model has no limit of its own: with nothing left to fall back to, the day's work
    // would stop. A limit on the main purpose is kept as a setting and is not enforced.
    blocked: purpose !== 'main' && exhausted ? `今日 ${PURPOSE_INFO[purpose].name}已用 ${used} 次，达到上限 ${limit}` : undefined,
    usage: { used, limit },
  };
}

/** Counts one request a purpose made today. */
export function countUse(store: Pick<Store, 'get' | 'put' | 'remove'>, purpose: Purpose, now: Date, timeZone: string): void {
  const key = USAGE_OF(purpose, dayOf(now, timeZone));
  const count = (store.get<{ count: number }>('settings', key)?.count ?? 0) + 1;
  store.put('settings', key, { count, purpose, at: now.toISOString() });
  // Yesterday's count is of no use once the day has passed, and is dropped. The same day under
  // the owner's clock is kept, so that a clock set back does not reset the count.
  const yesterday = USAGE_OF(purpose, dayOf(new Date(now.getTime() - 24 * 60 * 60 * 1000), timeZone));
  if (yesterday !== key) store.remove('settings', yesterday);
}

/** A fallback that was taken, as the owner is told of it. */
export interface FallbackRecord { purpose: Purpose; from: string; to: string; at: string; reason: string }

const FALLBACKS = 'model-routing.fallbacks';
/** How many fallbacks are kept for the settings page. */
const FALLBACKS_MOST = 20;
/** The id a fallback is kept under: when, which purpose, and what was fallen back to. */
const fallbackId = (row: FallbackRecord) => row.at + ':' + row.purpose + ':' + row.to;

/** Keeps the last few fallbacks, so that the settings page can say they happened. */
export function recordFallback(store: Pick<Store, 'list' | 'put' | 'remove'>, record: FallbackRecord): void {
  const all = store.list<FallbackRecord>(FALLBACKS).sort((a, b) => a.at.localeCompare(b.at));
  // The oldest go first, so that what is kept is the most recent.
  for (const row of all.slice(0, Math.max(0, all.length - FALLBACKS_MOST + 1))) store.remove(FALLBACKS, fallbackId(row));
  store.put(FALLBACKS, fallbackId(record), record);
}

/** The fallbacks that happened, newest first. */
export function readFallbacks(store: Pick<Store, 'list'>): FallbackRecord[] {
  return store.list<FallbackRecord>(FALLBACKS).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
}
