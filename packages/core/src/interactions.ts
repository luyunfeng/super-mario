import type { PolicyStage } from './policies.ts';
import { randomUUID } from 'node:crypto';
import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';

/** Structural contract: policies can supply this shape without depending on this module. */
export interface Decision {
  handler: 'rules' | 'main_agent' | 'supervisor' | 'user';
  mode?: 'auto' | 'suggest';
  answer?: string;
  ruleId?: string;
  layer: 'global' | 'project' | 'task' | 'default';
  deadlineAt?: string;
  userDeadlineAt?: string;
  escalationMinutes?: number;
  stages?: PolicyStage[];
}
export type PolicyDecision = Decision;
export interface Card {
  id: string;
  version: number;
  decisionVersion?: number;
  kind: 'question' | 'permission' | 'plan' | 'review';
  title: string;
  body: string;
  runId?: string;
  projectId?: string;
  executorId?: string;
  cwd?: string;
  status: 'open' | 'answered' | 'expired' | 'withdrawn';
  answer?: string;
  answeredBy?: string;
  suggestion?: string;
  handler: Decision['handler'];
  mode?: Decision['mode'];
  ruleId?: string;
  layer: Decision['layer'];
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  answeredAt?: string;
  delivery?: 'confirmed' | 'failed' | 'unknown';
  error?: string;
  stages?: PolicyStage[];
  stageIndex?: number;
  stageDueAt?: string;
  escalationMinutes?: number;
  userNotifiedAt?: string;
  routingHistory?: { handler: Decision['handler']; outcome: string; at: string }[];
}
type Input = Pick<Card, 'kind' | 'title' | 'body' | 'runId' | 'projectId' | 'executorId' | 'cwd'>;
const collection = 'interactions';
export class InteractionError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  constructor(message: string, status: 400 | 404 | 409 | 503 = 400) {
    super(message);
    this.name = 'InteractionError';
    this.status = status;
  }
}
function text(value: unknown, name: string, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim())) throw new InteractionError(`${name}必须为文本`);
}

/** Parent owns expireTick and must await close() before closing the store. No automatic replay. */
export function createInteractions({ store, events, decide, answer: deliver, askAgent, publish }: {
  store: Store;
  events: EventBus;
  publish?: (input: import('../../plugin-sdk/src/index.ts').EventInput) => unknown;
  decide: (card: Card, conversationQuestion: boolean) => Decision;
  answer: (card: Card, text: string) => Promise<void>;
  askAgent?: (handler: 'main_agent' | 'supervisor', card: Card) => Promise<string>;
}) {
  let closed = false;
  const jobs = new Set<Promise<unknown>>();
  function active() { if (closed) throw new InteractionError('交互服务已关闭', 503); }
  function changed(id: string) { events.publish('interactions.changed', { id }); }
  function track<T>(job: Promise<T>): Promise<T> {
    jobs.add(job);
    // Both branches observe failures, including fire-and-forget background jobs.
    void job.then(() => jobs.delete(job), () => jobs.delete(job));
    return job;
  }
  function save(previous: Card, patch: Partial<Card>): Card {
    const next = { ...previous, ...patch, version: previous.version + 1, updatedAt: new Date().toISOString() };
    store.put(collection, next.id, next);
    return next;
  }
  function get(id: string, version: number): Card {
    text(id, 'id');
    if (!Number.isSafeInteger(version) || version < 1) throw new InteractionError('version必须为正整数');
    const card = store.get<Card>(collection, id);
    if (!card) throw new InteractionError('交互卡片不存在', 404);
    if (card.version !== version || card.status !== 'open') throw new InteractionError('交互卡片已更新或处理', 409);
    return card;
  }
  // Expiration is committed even when the attempted answer is rejected.
  function claim(id: string, version: number, patch: Partial<Card>): Card {
    const card = store.transaction(() => {
      const previous = get(id, version);
      const next = save(previous, Date.parse(previous.expiresAt) <= Date.now() ? { status: 'expired' } : { ...patch, ...(patch.status === 'answered' ? { decisionVersion: previous.version + 1 } : {}) });
      if (next.status === 'answered') publish?.({type:'interaction.answered',typeVersion:1,sourceId:`interaction:${id}:v${next.version}`,data:{id,version:next.version,answer:next.answer||'',by:next.answeredBy||'user'},subject:{kind:'interaction',id},staleIf:{ref:`interaction:${id}`,version:next.version}});
      return next;
    });
    return card;
  }
  function answer(id: string, version: number, value: string, by = 'user'): Promise<Card> {
    active();
    text(value, 'answer');
    text(by, 'by');
    // Claim before any I/O. Unknown also covers a crash between delivery and confirmation.
    const card = claim(id, version, { status: 'answered', answer: value, answeredBy: by,
      answeredAt: new Date().toISOString(), delivery: 'unknown' });
    if (card.status === 'expired') {
      changed(id);
      throw new InteractionError('交互卡片已过期', 409);
    }
    const job = track(Promise.resolve().then(async () => {
      let patch: Partial<Card>;
      try {
        await deliver(structuredClone(card), value);
        patch = { delivery: 'confirmed' };
      } catch (error) {
        const uncertain = error !== null && typeof error === 'object' &&
          (('delivery' in error && error.delivery === 'unknown') || ('deliveryunknown' in error && error.deliveryunknown === true));
        patch = { delivery: uncertain ? 'unknown' : 'failed', error: error instanceof Error ? error.message : String(error) };
      }
      // close() waits for already claimed deliveries, so the store is still available here.
      const result = store.transaction(() => save(store.get<Card>(collection, card.id) ?? card, patch));
      changed(id);
      if (patch.delivery !== 'confirmed') events.publish('interactions.user_required', { id });
      return result;
    }));
    changed(id);
    return job;
  }
  function advance(card: Card, outcome: string, now = Date.now(), error?: string): Card | undefined {
    if (closed) return;
    const current = store.get<Card>(collection, card.id);
    if (!current || current.version !== card.version || current.status !== 'open' || !current.stages) return;
    if (now >= Date.parse(current.expiresAt)) {
      const next = save(current, { status: 'expired' }); changed(next.id); return next;
    }
    const stageIndex = Math.min((current.stageIndex ?? 0) + 1, current.stages.length - 1);
    const stage = current.stages[stageIndex]!;
    const next = save(current, { handler: stage.handler, mode: stage.mode, stageIndex,
      stageDueAt: stage.handler === 'user' ? undefined : new Date(now + (current.escalationMinutes ?? 3) * 60000).toISOString(),
      routingHistory: [...(current.routingHistory ?? []), { handler: current.handler, outcome, at: new Date(now).toISOString() }],
      ...(error ? { error } : {}) });
    changed(next.id);
    events.publish('interactions.escalated', { id: next.id, from: current.handler, to: stage.handler, outcome });
    if (stage.handler === 'user') events.publish('interactions.user_required', { id: next.id });
    else background(next);
    return next;
  }
  function apply(card: Card, value: string) {
    if (closed) return;
    const current = store.get<Card>(collection, card.id);
    if (!current || current.version !== card.version || current.status !== 'open') return;
    if (Date.parse(current.expiresAt) <= Date.now()) {
      const expired = claim(card.id, card.version, {});
      changed(expired.id);
      return;
    }
    if (current.stages && current.stageDueAt && Date.parse(current.stageDueAt) <= Date.now()) { advance(current, 'timeout'); return; }
    text(value, 'suggestion');
    if (card.mode === 'auto') return answer(card.id, card.version, value, card.handler);
    // A missing mode is conservative: an available response is only a suggestion.
    const currentCard = get(card.id, card.version);
    const userIndex = currentCard.stages?.findIndex(stage => stage.handler === 'user');
    const next = store.transaction(() => save(currentCard, { suggestion: value,
      ...(userIndex !== undefined && userIndex >= 0 ? { handler: 'user', mode: 'suggest', stageIndex: userIndex, stageDueAt: undefined,
        routingHistory: [...(currentCard.routingHistory ?? []), { handler: currentCard.handler, outcome: 'suggested', at: new Date().toISOString() }] } : {}) }));
    changed(next.id);
    if (next.stages) events.publish('interactions.user_required', { id: next.id });
  }
  function background(card: Card): void {
    const job = Promise.resolve().then(async () => {
      if (closed) return;
      const current = store.get<Card>(collection, card.id);
      if (!current || current.version !== card.version || current.status !== 'open') return;
      if (Date.parse(current.expiresAt) <= Date.now()) { apply(card, ''); return; }
      if (card.handler === 'rules') {
        const preset = card.stages?.[card.stageIndex ?? 0]?.answer ?? card.answer;
        if (preset !== undefined) await apply(card, preset);
        else advance(card, 'no_rule_answer');
      } else if (card.handler === 'main_agent' || card.handler === 'supervisor') {
        if (!askAgent) throw new Error('缺少 askAgent，等待用户处理');
        await apply(card, await askAgent(card.handler, structuredClone(current)));
      }
    }).catch(error => {
      if (closed) return;
      const current = store.get<Card>(collection, card.id);
      if (!current || current.version !== card.version || current.status !== 'open') return;
      if (current.stages) { advance(current, 'error', Date.now(), error instanceof Error ? error.message : String(error)); return; }
      const next = store.transaction(() => save(current, Date.parse(current.expiresAt) <= Date.now()
        ? { status: 'expired' } : { error: error instanceof Error ? error.message : String(error) }));
      changed(next.id);
    });
    track(job);
  }
  for (const card of store.list<Card>(collection)) {
    if (card.status !== 'open' || !card.stages) continue;
    const job = Promise.resolve().then(() => {
      if (closed) return;
      if (card.handler === 'user') events.publish('interactions.user_required', { id: card.id });
      else if (Date.parse(card.expiresAt) > Date.now() && (!card.stageDueAt || Date.parse(card.stageDueAt) > Date.now())) background(card);
    });
    track(job);
  }
  return {
    open(input: Input, conversationQuestion = false): Card {
      active();
      if (!input || !['question', 'permission', 'plan', 'review'].includes(input.kind)) throw new InteractionError('无效的交互 kind');
      text(input.title, 'title');
      text(input.body, 'body', true);
      const fields: Input = { kind: input.kind, title: input.title, body: input.body };
      for (const key of ['runId', 'projectId', 'executorId', 'cwd'] as const) {
        if (input[key] !== undefined) { text(input[key], key); fields[key] = input[key]; }
      }
      const now = new Date().toISOString();
      const card: Card = { ...fields, id: randomUUID(), version: 1, status: 'open', handler: 'user', layer: 'default',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), createdAt: now, updatedAt: now };
      const decision = decide(structuredClone(card), conversationQuestion);
      if (!decision || !['rules', 'user', 'main_agent', 'supervisor'].includes(decision.handler) ||
        !['global', 'project', 'task', 'default'].includes(decision.layer) ||
        (decision.mode !== undefined && !['auto', 'suggest'].includes(decision.mode))) throw new InteractionError('无效的策略决定');
      if (decision.answer !== undefined) text(decision.answer, 'decision.answer');
      if (decision.ruleId !== undefined) text(decision.ruleId, 'ruleId');
      if (decision.deadlineAt !== undefined) {
        text(decision.deadlineAt, 'deadlineAt');
        if (!Number.isFinite(Date.parse(decision.deadlineAt))) throw new InteractionError('无效的 deadlineAt');
        card.expiresAt = new Date(decision.deadlineAt).toISOString();
      }
      if (decision.stages) {
        if (!Array.isArray(decision.stages) || !decision.stages.length || decision.stages.at(-1)?.handler !== 'user'
          || new Set(decision.stages.map(stage => stage.handler)).size !== decision.stages.length
          || !decision.stages.every(stage => ['rules','supervisor','main_agent','user'].includes(stage.handler) && ['auto','suggest'].includes(stage.mode))) throw new InteractionError('无效的处理梯级');
        if (!Number.isFinite(decision.escalationMinutes) || decision.escalationMinutes! <= 0 || !decision.userDeadlineAt || !Number.isFinite(Date.parse(decision.userDeadlineAt))) throw new InteractionError('无效的梯级期限');
        card.stages = structuredClone(decision.stages); card.stageIndex = 0;
        card.escalationMinutes = decision.escalationMinutes;
        card.expiresAt = decision.userDeadlineAt;
        if (decision.handler !== 'user') card.stageDueAt = decision.deadlineAt;
      }
      card.handler = decision.handler;
      card.layer = decision.layer;
      if (decision.mode !== undefined) card.mode = decision.mode;
      if (decision.ruleId !== undefined) card.ruleId = decision.ruleId;
      // Rule responses are proposals until the card is claimed, never an answered card on open.
      store.put(collection, card.id, card);
      if (card.handler !== 'user') background({ ...card, ...(decision.answer !== undefined ? { answer: decision.answer } : {}) });
      changed(card.id);
      if (card.stages && card.handler === 'user') events.publish('interactions.user_required', { id: card.id });
      return structuredClone(card);
    },
    answer,
    withdraw(id: string, version: number): Card {
      active();
      const card = claim(id, version, { status: 'withdrawn' });
      changed(id);
      return card;
    },
    expireTick(now = Date.now()): Card[] {
      active();
      if (!Number.isFinite(now)) throw new InteractionError('无效的过期时间');
      const expired = store.transaction(() => store.list<Card>(collection)
        .filter(card => card.status === 'open' && Date.parse(card.expiresAt) <= now)
        .map(card => save(card, { status: 'expired' })));
      for (const card of expired) changed(card.id);
      const escalated: Card[] = [];
      for (const card of store.list<Card>(collection)) {
        if (card.status === 'open' && card.stages && card.handler !== 'user' && card.stageDueAt && Date.parse(card.stageDueAt) <= now) {
          const next = advance(card, 'timeout', now); if (next) escalated.push(next);
        }
      }
      return [...expired, ...escalated];
    },
    list(): Card[] { active(); return store.list<Card>(collection); },
    async close(): Promise<void> {
      closed = true;
      await Promise.allSettled([...jobs]);
    },
  };
}
