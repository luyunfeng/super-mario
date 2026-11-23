import { cardAcceptsAnswer, questionDeadline } from './question-deadline.ts';
import { questionItems, readQuestionResponses } from './question-responses.ts';
import type { QuestionItem, QuestionResponse } from '../../protocol/src/index.ts';
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
  questions?: QuestionItem[];
  wait?: boolean;
  decisionDeadlineAt?: string;
  reversible?: boolean;
  deadlineRemindedAt?: string;
  contextRequestedAt?: string;
  decisionExplanation?: string;
  byDefault?: true;
  answers?: QuestionResponse[];
  withdrawnReason?: 'user_spoke'|'owner_mismatch';
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
type Input = Pick<Card, 'kind' | 'title' | 'body' | 'runId' | 'projectId' | 'executorId' | 'cwd' | 'questions' | 'wait'> & {deadline?:string; reversible?:boolean};
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
export function createInteractions({ store, events, decide, answer: deliver, askAgent, publish, deadlineOutcome, questionContext, holdMismatch, defaultHeld }: {
  store: Store;
  events: EventBus;
  holdMismatch?: (card:Card)=>void;
  defaultHeld?: (card:Card)=>boolean;
  questionContext?: (card:Card) => {facts:string; explain?:(signal:AbortSignal)=>Promise<string>};
  deadlineOutcome?: (card:Card) => 'eligible'|'spoke'|'unverified'|'initializing';
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
  function claim(id: string, version: number, patch: Partial<Card>, now=Date.now()): Card {
    const card = store.transaction(() => {
      const previous = get(id, version);
      const next = save(previous, !cardAcceptsAnswer(previous,now) ? { status: 'expired' } : { ...patch, ...(patch.status === 'answered' ? { decisionVersion: previous.version + 1 } : {}) });
      if (next.status === 'answered') publish?.({type:'interaction.answered',typeVersion:1,sourceId:`interaction:${id}:v${next.version}`,data:{id,version:next.version,answer:next.answer||'',by:next.answeredBy||'user'},subject:{kind:'interaction',id},staleIf:{ref:`interaction:${id}`,version:next.version}});
      return next;
    });
    return card;
  }
  function settleDeadline(id:string, now:number):Card|undefined {
    const result=store.transaction(() => {
      const card=store.get<Card>(collection,id);
      if (!card || card.status!=='open' || !card.decisionDeadlineAt || !(Date.parse(card.decisionDeadlineAt)<=now) || card.deadlineRemindedAt || card.contextRequestedAt) return;
      const outcome=deadlineOutcome?.(card);
      if (outcome === 'initializing') return;
      if (card.wait===false && outcome==='spoke') return save(card,{status:'expired'});
      if (outcome==='eligible' && !defaultHeld?.(card) && card.reversible===true && card.questions?.length &&
          card.questions.every(q=>q.recommend && q.options.some(o=>o.label===q.recommend))) {
        const response=readQuestionResponses(card.questions,card.questions.map(q=>({selected:[q.recommend]})));
        const next=save(card,{status:'answered',byDefault:true,answeredBy:'deadline_default',answers:response.answers,
          answer:response.text,answeredAt:new Date(now).toISOString(),decisionVersion:card.version+1,delivery:'unknown'});
        publish?.({type:'interaction.answered',typeVersion:1,sourceId:`interaction:${id}:v${next.version}`,
          data:{id,version:next.version,answer:response.text,by:'deadline_default',byDefault:true},subject:{kind:'interaction',id},
          staleIf:{ref:`interaction:${id}`,version:next.version}});
        return next;
      }
      // Preserve the form version: its owner can still submit the originally issued card.
      const stamp=new Date(now).toISOString();
      const reminded={...card,deadlineRemindedAt:stamp,updatedAt:stamp};
      store.put(collection,id,reminded);
      events.publish('interactions.deadline_overdue',{id});
      return reminded;
    });
    if (!result) return;
    if (result.byDefault) void deliverAnswer(result,result.answer!);
    else changed(id);
    return result;
  }
  const explaining=new Map<string,Promise<Card>>();
  const contextStop=new AbortController();
  function reportMismatch(id:string,version:number):Card {
    active();
    text(id,'id');
    if (!Number.isSafeInteger(version) || version<1) throw new InteractionError('version必须为正整数');
    const result=store.transaction(()=>{
      const card=store.get<Card>(collection,id);
      if (!card) throw new InteractionError('交互卡片不存在',404);
      if (card.kind!=='question' || !card.runId || !card.decisionDeadlineAt || !card.questions?.length)
        throw new InteractionError('仅原执行的截止提问支持报告偏题');
      if (card.handler!=='user' || deadlineOutcome?.(card)!=='eligible' || !holdMismatch)
        throw new InteractionError('原执行或授权已变化',409);
      if (card.status==='withdrawn' && card.withdrawnReason==='owner_mismatch' && card.version===version+1)
        return {card,changed:false};
      if (card.version!==version || !cardAcceptsAnswer(card)) throw new InteractionError('提问版本或截止状态已变化',409);
      const next=save(card,{status:'withdrawn',withdrawnReason:'owner_mismatch'});
      holdMismatch(next);
      return {card:next,changed:true};
    });
    if (result.changed) changed(id);
    return result.card;
  }
  async function requestContext(id:string,version:number):Promise<Card> {
    active();
    text(id,'id');
    if (!Number.isSafeInteger(version) || version<1) throw new InteractionError('version必须为正整数');
    const claim=store.transaction(()=>{
      const card=store.get<Card>(collection,id);
      if (!card) throw new InteractionError('交互卡片不存在',404);
      if (card.kind!=='question' || !card.runId || !card.decisionDeadlineAt || !card.questions?.length)
        throw new InteractionError('仅原执行的截止提问支持补充背景',400);
      if (card.status!=='open' || card.handler!=='user' || deadlineOutcome?.(card)!=='eligible')
        throw new InteractionError('原提问或执行已变化',409);
      if (card.contextRequestedAt && (version===card.version || version===card.version-1)) return {card};
      if (version!==card.version || !cardAcceptsAnswer(card)) throw new InteractionError('原问题版本或截止状态已变化',409);
      const context=questionContext?.(card);
      if (!context?.facts) throw new InteractionError('无法核对原执行背景',409);
      // A crash or unavailable model still leaves a readable explanation and suspends the old default.
      const next=save(card,{contextRequestedAt:new Date().toISOString(),decisionExplanation:context.facts});
      return {card:next,context};
    });
    const {card,context}=claim;
    if (!context) return explaining.get(id) ?? card;
    if (!context.explain) { changed(id); return card; }
    const explain=context.explain;
    const job=track(Promise.resolve().then(async()=>{
      let explanation='';
      try {
        if (!contextStop.signal.aborted) explanation=(await explain(contextStop.signal)).trim();
      } catch { /* Keep the committed scoped facts. Provider errors may contain private data. */ }
      const next=store.transaction(()=>{
        const current=store.get<Card>(collection,id);
        if (!current || current.status!=='open' || current.handler!=='user' || current.version!==card.version ||
            current.contextRequestedAt!==card.contextRequestedAt || deadlineOutcome?.(current)!=='eligible')
          throw new InteractionError('背景生成期间原问题或执行已变化',409);
        if (!explanation || closed) return current;
        // Only the explanation changed. The owner's options and already-open form version still match.
        const updated={...current,decisionExplanation:explanation,updatedAt:new Date().toISOString()};
        store.put(collection,id,updated);
        return updated;
      });
      if (next.decisionExplanation!==card.decisionExplanation) changed(id);
      return next;
    }).finally(()=>explaining.delete(id)));
    explaining.set(id,job);
    changed(id);
    return job;
  }
  function answer(id: string, version: number, input: string | QuestionResponse[], by = 'user'): Promise<Card> {
    active();
    const now=Date.now();
    let current = get(id, version);
    if (current.decisionDeadlineAt && Date.parse(current.decisionDeadlineAt)<=now) {
      settleDeadline(id,now);
      current=get(id,version);
    }
    if (current.decisionDeadlineAt && !cardAcceptsAnswer(current,now))
      throw new InteractionError('正在核验截止选项，稍后再试',409);
    if (!cardAcceptsAnswer(current,now)) {
      claim(id, version, {status:'expired'});
      changed(id);
      throw new InteractionError('交互卡片已过期', 409);
    }
    if (current.runId && current.decisionDeadlineAt && deadlineOutcome?.(current)!=='eligible')
      throw new InteractionError('原执行或来源已不可核实，请核对后再回答',409);
    const response = current.questions ? readQuestionResponses(current.questions, input) : undefined;
    const value = response?.text ?? input;
    text(value, 'answer');
    if ((response || current.wait === false) && !['user','user_feishu'].includes(by)) throw new InteractionError('这张提问卡须由主人直接回答');
    text(by, 'by');
    // Claim before any I/O. Unknown also covers a crash between delivery and confirmation.
    const card = claim(id, version, { status: 'answered', answer: value, ...(response && {answers:response.answers}), answeredBy: by,
      answeredAt: new Date(now).toISOString(), delivery: 'unknown' },now);
    if (card.status === 'expired') {
      changed(id);
      throw new InteractionError('交互卡片已过期', 409);
    }
    return deliverAnswer(card,value);
  }
  const delivering=new Set<string>();
  function deliverAnswer(card:Card,value:string) {
    delivering.add(card.id);
    const id=card.id;
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
      const result = store.transaction(() => {
        const current = store.get<Card>(collection, card.id) ?? card;
        if ((current.wait === false || current.byDefault) && current.delivery === 'confirmed') return current;
        return save(current, patch);
      });
      changed(id);
      if (result.delivery !== 'confirmed') events.publish('interactions.user_required', { id });
      return result;
    }));
    void job.then(()=>delivering.delete(id),()=>delivering.delete(id));
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
    if (card.mode === 'auto' && !current.questions) return answer(card.id, card.version, value, card.handler);
    // A missing mode is conservative: an available response is only a suggestion.
    const currentCard = get(card.id, card.version);
    const userIndex = currentCard.stages?.findIndex(stage => stage.handler === 'user');
    const next = store.transaction(() => save(currentCard, { suggestion: value,
      ...(currentCard.questions && {handler:'user', mode:'suggest'}),
      ...(userIndex !== undefined && userIndex >= 0 ? { handler: 'user', mode: 'suggest', stageIndex: userIndex, stageDueAt: undefined,
        routingHistory: [...(currentCard.routingHistory ?? []), { handler: currentCard.handler, outcome: 'suggested', at: new Date().toISOString() }] } : {}) }));
    changed(next.id);
    if (next.stages || next.questions) events.publish('interactions.user_required', { id: next.id });
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
      const current = store.get<Card>(collection, card.id);
      if (current?.status !== 'open' || current.version !== card.version || Date.parse(current.expiresAt) <= Date.now()) return;
      if (card.handler === 'user') events.publish('interactions.user_required', { id: card.id });
      else if (Date.parse(card.expiresAt) > Date.now() && (!card.stageDueAt || Date.parse(card.stageDueAt) > Date.now())) background(card);
    });
    track(job);
  }
  return {
    open(input: Input, conversationQuestion = false, boundRun = false): Card {
      active();
      if (!input || !['question', 'permission', 'plan', 'review'].includes(input.kind)) throw new InteractionError('无效的交互 kind');
      text(input.title, 'title');
      text(input.body, 'body', true);
      const fields: Input = { kind: input.kind, title: input.title, body: input.body };
      if (input.wait !== undefined) {
        if (typeof input.wait !== 'boolean' || input.kind !== 'question' || (input.wait === false && input.runId))
          throw new InteractionError('wait 仅适用于对话中的普通提问');
        fields.wait = input.wait;
      }
      if (input.questions !== undefined) {
        if (input.kind !== 'question') throw new InteractionError('只有普通问题卡支持逐题选项');
        fields.questions = questionItems(input.questions);
      }
      for (const key of ['runId', 'projectId', 'executorId', 'cwd'] as const) {
        if (input[key] !== undefined) { text(input[key], key); fields[key] = input[key]; }
      }
      const now = new Date().toISOString();
      const card: Card = { ...fields, id: randomUUID(), version: 1, status: 'open', handler: 'user', layer: 'default',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), createdAt: now, updatedAt: now };
      Object.assign(card,questionDeadline({...fields,deadline:input.deadline,reversible:input.reversible},Date.parse(now),boundRun));
      const policy = decide(structuredClone(card), conversationQuestion);
      const decision: Decision = card.wait === false || card.decisionDeadlineAt ? {...policy,handler:'user',mode:'suggest',answer:undefined,ruleId:undefined,
        ...(policy.stages && {stages:[{handler:'user',mode:'suggest'}]})} : policy;
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
      if (card.decisionDeadlineAt) card.expiresAt=card.decisionDeadlineAt;
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
    answer, requestContext, reportMismatch,
    withdraw(id: string, version: number, reason?:'user_spoke'): Card {
      active();
      const now=Date.now();
      if (get(id,version).decisionDeadlineAt) {
        const settled=settleDeadline(id,now);
        // A new human message can arrive between the cutoff and the next sweep.
        // Its host must still accept it when the old question has already settled.
        if (reason==='user_spoke' && settled && settled.status!=='open') return settled;
      }
      const card = claim(id, version, { status: 'withdrawn', ...(reason && {withdrawnReason:reason}) },now);
      changed(id);
      return card;
    },
    expireTick(now = Date.now()): Card[] {
      active();
      if (!Number.isFinite(now)) throw new InteractionError('无效的过期时间');
      const expired = store.transaction(() => store.list<Card>(collection)
        .filter(card => card.status === 'open' && !card.decisionDeadlineAt && Date.parse(card.expiresAt) <= now)
        .map(card => save(card, { status: 'expired' })));
      for (const card of expired) changed(card.id);
      const escalated: Card[] = [];
      for (const card of store.list<Card>(collection)) {
        if (card.status === 'open' && card.decisionDeadlineAt && !card.deadlineRemindedAt && !card.contextRequestedAt && Date.parse(card.decisionDeadlineAt)<=now) {
          const next=settleDeadline(card.id,now); if (next) escalated.push(next);
        } else if (card.status === 'open' && card.stages && card.handler !== 'user' && card.stageDueAt && Date.parse(card.stageDueAt) <= now) {
          const next = advance(card, 'timeout', now); if (next) escalated.push(next);
        }
      }
      return [...expired, ...escalated];
    },
    recoverRunDefault(id:string, attempted:boolean) {
      const current=store.get<Card>(collection,id);
      if (closed || !current?.runId || current.status!=='answered' || !current.byDefault || !current.answer ||
          current.delivery!=='unknown' || current.error || delivering.has(id)) return;
      if (!attempted) {
        const state=deadlineOutcome?.(current);
        if (state==='initializing') return;
        if (state!=='eligible' || defaultHeld?.(current)) {
          // No executor input was ever claimed. Leave the original choice for its owner.
          store.transaction(()=>{
            const row=store.get<Card>(collection,id);
            if (!row || row.version!==current.version || store.get('effects','interaction:'+id)) return;
            save(row,{status:'open',byDefault:undefined,answers:undefined,answer:undefined,answeredAt:undefined,
              decisionVersion:undefined,answeredBy:undefined,delivery:undefined,deadlineRemindedAt:new Date().toISOString()});
            events.publish('interactions.deadline_overdue',{id});
          });
          changed(id);
          return;
        }
      }
      void deliverAnswer(current,current.answer);
    },
    list(): Card[] { active(); return store.list<Card>(collection); },
    async close(): Promise<void> {
      closed = true;
      contextStop.abort();
      await Promise.allSettled([...jobs]);
    },
  };
}
