import { createHash } from 'node:crypto';
import { publicText } from '../../../plugins/agent-progress-card.ts';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { Todo } from '../../../packages/protocol/src/index.ts';

export type GroupTaskReportSource = {
  homeChatId?: string; homeGrant?: string; homeThreadId?: string;
  botId: string; appId: string; binding: string; chatId: string; messageId: string;
  todoId: string; privateMessageId: string; senderId: string;
};
type Source = Partial<GroupTaskReportSource> & { handedOff?: boolean; recalled?: boolean };
type Route = {
  delayMinutes?: number;
  preview(text: string, guard: () => void): Promise<string>;
  send(text: string, guard: () => void): Promise<string>;
};
type Report = {
  status: 'planned' | 'previewUnknown' | 'sendUnknown' | 'sent' | 'cancelled' | 'failed';
  completedAt?: string; text?: string; due?: number; previewId?: string; sentId?: string;
  previewAttempts?: number; sendAttempts?: number; stopRequested?: boolean;
};
const collection = 'feishu.group-task-reports';
const sources = 'feishu.group-tasks';
const minute = 60_000;
const week = 7 * 24 * 60 * minute;

function sourceOf(raw?: Source): GroupTaskReportSource | undefined {
  if (!raw || raw.recalled) return;
  const { botId, appId, binding, chatId, messageId, todoId, privateMessageId, senderId } = raw;
  if (botId && appId && binding && chatId && messageId && todoId && privateMessageId && senderId)
    return { botId, appId, binding, chatId, messageId, todoId, privateMessageId, senderId,
      ...(raw.homeChatId && { homeChatId: raw.homeChatId, homeGrant: raw.homeGrant, homeThreadId: raw.homeThreadId }) };
}
function keyFor(s: GroupTaskReportSource) {
  return createHash('sha256').update(JSON.stringify([s.botId, s.appId, s.chatId, s.messageId])).digest('hex');
}

// Only the first line of the host's public outcome is eligible. Never substitute a private answer or notes.
function publicLine(outcome: string) {
  const first = outcome.trim().split(/[\r\n\u2028\u2029]/u)[0];
  const line = publicText(first, Number.MAX_SAFE_INTEGER).replace(/```.*?(?:```|$)|<at\b[^>]*>.*?<\/at>/giu, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)|`[^`]*(?:`|$)|\b(?:[a-z][a-z\d+.\-]*:\/\/|www\.)\S+|<[^<>]*>/giu, ' ')
    .replace(/(?:[a-z]:\\[^\s]*)|(?:[\w.~@%+=:,-]*(?:\/[\w.~@%+=:,-]+)+\/?)/giu, ' ')
    .replace(/@[^\s，。,;；:：、!！?？)）]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return /[\p{L}\p{N}]/u.test(line) ? Array.from(line).slice(0, 600).join('') : '这项待办已完成。';
}

export function createGroupTaskReports(store: Pick<Store, 'get' | 'list' | 'put' | 'transaction'>, options: {
  lookup(source: GroupTaskReportSource): Route | undefined;
  getOutcome(todoId: string): string | undefined;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let closed = false, sweeping: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, timerDue: number | undefined;
  const read = (key: string) => store.get<Report>(collection, key);
  function wake(due: number) {
    if (closed || (timerDue !== undefined && timerDue <= due)) return;
    if (timer) clearTimeout(timer);
    timerDue = due;
    timer = setTimeout(() => {
      timer = undefined; timerDue = undefined;
      // A deadline can expire while another source is awaiting its receipt. Sweep again after that pass.
      void Promise.resolve(sweeping).then(sweep).catch(() => {});
    }, Math.max(1, due - now()));
    timer.unref();
  }
  function outcome(s: GroupTaskReportSource) {
    const completedAt = store.get<Todo>('todos', s.todoId)?.completedAt;
    if (!completedAt) return;
    const age = now() - Date.parse(completedAt);
    if (!(age >= 0 && age <= week)) return;
    const text = options.getOutcome(s.todoId)?.trim();
    if (text) return { completedAt, text: publicLine(text) };
  }

  async function step(source: GroupTaskReportSource) {
    const key = keyFor(source);
    let report = read(key);
    if (report && report.status !== 'planned') return;
    const result = outcome(source);
    if (report?.completedAt && (!result || report.completedAt !== result.completedAt || report.text !== result.text)) {
      // A reopened task or corrected outcome needs a fresh private preview and a full cancellation window.
      const reset = store.transaction(() => {
        if (JSON.stringify(read(key)) !== JSON.stringify(report)) return false;
        store.put(collection, key, { status: 'planned' } satisfies Report);
        return true;
      });
      if (!reset) return;
      report = { status: 'planned' };
    }
    if (!result || closed) return;
    const route = options.lookup(source);
    if (!route) return;
    const configured = route.delayMinutes;
    const delay = Number.isInteger(configured) && configured! >= 0 && configured! <= 60 ? configured! : 10;
    if (report?.due !== undefined && report.due > now()) { wake(report.due); return; }
    const preview = report?.due === undefined && delay > 0;
    const status = preview ? 'previewUnknown' : 'sendUnknown';
    const currentSource = () => {
      const row = store.get<Source>(sources, key);
      const latest = row?.handedOff && sourceOf(row);
      return latest && Object.entries(source).every(([k, v]) => latest[k as keyof GroupTaskReportSource] === v);
    };
    const claim = store.transaction(() => {
      const current = read(key);
      if (closed || !currentSource() || JSON.stringify(current) !== JSON.stringify(report)) return;
      const next: Report = { ...current, ...result, status };
      if (preview) next.previewAttempts = (next.previewAttempts ?? 0) + 1;
      else next.sendAttempts = (next.sendAttempts ?? 0) + 1;
      store.put(collection, key, next);
      return next;
    });
    if (!claim) return;
    const guard = () => {
      const actual = outcome(source);
      const state = read(key);
      if (closed || !currentSource() || state?.status !== status || state.stopRequested || !options.lookup(source)
        || actual?.completedAt !== result.completedAt || actual?.text !== result.text)
        throw new Error('原群回报的授权、任务结论或发送状态已变化');
    };
    try {
      guard();
      const id = preview
        ? await route.preview('将在 ' + delay + ' 分钟后回复原群消息。引用本消息或任务承接消息发送 /noreply 可取消。\n\n' + result.text, guard)
        : await route.send(result.text, guard);
      if (!id?.trim() || closed) return;
      store.transaction(() => {
        if (read(key)?.status !== status) return;
        if (preview) {
          const due = now() + delay * minute;
          store.put(collection, key, { ...claim, status: 'planned', due, previewId: id });
          wake(due);
        } else store.put(collection, key, { ...claim, status: 'sent', sentId: id });
      });
    } catch (error) {
      // A crash, timeout or missing ID keeps the claim. Only proof that nothing was sent permits one retry.
      if (!closed && error && typeof error === 'object' && 'delivery' in error && error.delivery === 'no') {
        store.transaction(() => {
          const state = read(key);
          if (state?.status !== status) return;
          if (state.stopRequested) { store.put(collection, key, { ...state, status: 'cancelled' }); return; }
          const attempts = (preview ? claim.previewAttempts : claim.sendAttempts) ?? 1;
          store.put(collection, key, { ...claim, status: attempts < 2 ? 'planned' : 'failed' });
        });
      }
    }
  }
  function sweep() {
    if (closed) return Promise.resolve();
    if (!sweeping) sweeping = Promise.resolve().then(async () => {
      for (const raw of store.list<Source>(sources)) {
        if (closed) break;
        const s = sourceOf(raw);
        if (s && raw.handedOff) await step(s);
      }
    }).finally(() => { sweeping = undefined; });
    return sweeping;
  }

  function cancel(botId: string, binding: string, quotedIds: readonly string[], topic?: { chatId: string; threadId: string; grant: string }) {
    return store.transaction(() => {
      if (closed || !botId || !binding || (!quotedIds.length && !topic)) return 'missing' as const;
      const matches = store.list<Source>(sources).map(sourceOf).filter(s => {
        if (!s || s.botId !== botId || s.binding !== binding) return false;
        if (topic) return s.homeChatId === topic.chatId && s.homeThreadId === topic.threadId && s.homeGrant === topic.grant;
        if (s.homeChatId) return false;
        const p = read(keyFor(s))?.previewId;
        return quotedIds.includes(s.privateMessageId) || (!!p && quotedIds.includes(p));
      });
      const s = matches.length === 1 ? matches[0] : undefined;
      if (!s) return 'missing' as const;
      const key = keyFor(s), prior = read(key);
      if (prior?.status === 'sent') return 'sent' as const;
      if (prior?.status === 'sendUnknown') {
        store.put(collection, key, { ...prior, stopRequested: true });
        return 'unknown' as const;
      }
      if (prior?.status === 'cancelled') return 'already' as const;
      store.put(collection, key, { status: 'cancelled', previewId: prior?.previewId } satisfies Report);
      return 'cancelled' as const;
    });
  }
  return { sweep, cancel, close() { closed = true; if (timer) clearTimeout(timer); return sweeping ?? Promise.resolve(); } };
}
