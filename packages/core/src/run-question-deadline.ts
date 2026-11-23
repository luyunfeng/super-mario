import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Project, Run, Todo } from '../../protocol/src/index.ts';
import { readQuestionResponses, questionEvidence } from './question-responses.ts';
import type { Card } from './interactions.ts';

export interface RunDeadlineTarget {
  runId:string; machineId:string; executorId:string; sessionId:string; conversationId:string;
  nativeSessionId?:string; cwd?:string; projectId?:string; todoId?:string; runSourceId?:string;
  sourceId?:string; audience?:string; agentInstanceId?:string;
}

/** Only freeze a current interactive session. A later run can reuse the same machine-side identifier. */
export function runDeadlineTarget(store:Pick<Store,'get'|'list'>,run:Run):RunDeadlineTarget|undefined {
  if (run.status!=='running' || run.executionMode!=='interactive' || !run.machineId || !run.sessionId ||
      !run.executorId || !Number.isFinite(Date.parse(run.createdAt))) return;
  const project=run.projectId && store.get<Project>('projects',run.projectId);
  if (run.projectId && (!project || project.id!==run.projectId || project.archivedAt)) return;
  const todo=run.todoId && store.get<Todo>('todos',run.todoId);
  if (run.todoId && (!todo || todo.id!==run.todoId || todo.projectId!==run.projectId || todo.completedAt)) return;
  const native=run.nativeSessionId??run.nativeResume?.nativeSessionId;
  if (store.list<Run>('runs').some(other=>other.id!==run.id && other.machineId===run.machineId &&
      !(Date.parse(other.createdAt)<Date.parse(run.createdAt)) && (other.sessionId===run.sessionId ||
        (native && other.executorId===run.executorId && (other.nativeSessionId??other.nativeResume?.nativeSessionId)===native)))) return;
  return {runId:run.id,machineId:run.machineId,executorId:run.executorId,sessionId:run.sessionId,conversationId:run.conversationId,
    nativeSessionId:native,cwd:run.cwd,projectId:run.projectId,todoId:run.todoId,runSourceId:run.sourceMessageId};
}

export function readRunDeadlineTarget(store:Pick<Store,'get'|'list'>,card:Card) {
  if (!card.runId || !card.decisionDeadlineAt || card.kind!=='question') return;
  const origin=store.get<{inputId?:string;runDeadline?:RunDeadlineTarget}>('interaction-origins',card.id);
  const frozen=origin?.runDeadline;
  if (!frozen || frozen.runId!==card.runId || frozen.sourceId!==origin?.inputId ||
      frozen.projectId!==card.projectId || frozen.executorId!==card.executorId || frozen.cwd!==card.cwd) return;
  const run=store.get<Run>('runs',card.runId);
  const current=run && runDeadlineTarget(store,run);
  if (!current || Object.entries(current).some(([key,value])=>frozen[key as keyof RunDeadlineTarget]!==value)) return;
  return frozen;
}

export function runQuestionReply(card:Card,text:string) {
  if (card.answeredBy==='supervisor_delegated') {
    if (!card.delegationRequestedAt || !card.reversible || card.externallyVisible!==false || !card.questions?.length || !card.answers ||
        !card.decisionAssumption?.trim() || card.answers.some(a=>a.text || !a.selected?.length))
      throw Object.assign(new Error('无法核实原执行的督办委托选择'),{delivery:'no'});
    const {answers}=readQuestionResponses(card.questions,card.answers);
    return '督办受委托就本轮内部可逆问题作出选择。以下选项和假设来自督办，不扩大外部操作授权。\n'+
      JSON.stringify({逐题选择:questionEvidence(card.questions,answers),采用的假设:card.decisionAssumption});
  }
  if (!card.byDefault) return text;
  if (!card.reversible || !card.questions?.length || card.answers?.length!==card.questions.length ||
      !card.questions.every((q,i)=>q.recommend && q.options.some(o=>o.label===q.recommend) &&
        card.answers?.[i]?.selected.length===1 && card.answers[i]?.selected[0]===q.recommend && !card.answers[i]?.text))
    throw Object.assign(new Error('无法核实截止卡的原始推荐选项'),{delivery:'no'});
  return '系统截止默认选择（未收到主人答复）。仅供原执行处理本轮提问，不代表主人授权其他操作。\n'+
    JSON.stringify(card.questions.map((q,i)=>({问题:q.question,已选:card.answers![i]!.selected})));
}

interface RunQuestionHold {
  cardId:string;
  cardVersion:number;
  heldAt:string;
}
const holds='run.question-holds';

/** Keep the owner's objection tied to the original run, scope, and executor session. */
export function readRunQuestionHold(store:Pick<Store,'get'|'list'>,run:Run):RunQuestionHold|undefined {
  const hold=store.get<RunQuestionHold>(holds,run.id);
  if (!hold) return;
  const card=store.get<Card>('interactions',hold.cardId);
  if (!card || card.id!==hold.cardId || run.status!=='running' || card.runId!==run.id || card.status!=='withdrawn' || card.withdrawnReason!=='owner_mismatch' ||
      card.version!==hold.cardVersion) return;
  const target=readRunDeadlineTarget(store,card);
  if (!target || target.machineId!==run.machineId || target.sessionId!==run.sessionId || target.executorId!==run.executorId ||
      target.projectId!==run.projectId || target.todoId!==run.todoId) return;
  return hold;
}

/** A restart marks previously running sessions unknown. That loss of positive
 * evidence never authorizes an automatic write to the still-pinned session. */
export function runQuestionInputHeld(store:Pick<Store,'get'>,run:Run):boolean {
  const hold=store.get<RunQuestionHold>(holds,run.id);
  if (!hold) return false;
  const frozen=store.get<{runDeadline?:RunDeadlineTarget}>('interaction-origins',hold.cardId)?.runDeadline;
  return !!frozen && frozen.runId===run.id && frozen.machineId===run.machineId && frozen.sessionId===run.sessionId &&
    frozen.executorId===run.executorId && (run.status==='running' || run.status==='unknown');
}

/** Called in the same transaction that withdrew the exact card. */
export function holdRunQuestion(store:Store,card:Card) {
  const target=readRunDeadlineTarget(store,card);
  if (!target || card.status!=='withdrawn' || card.withdrawnReason!=='owner_mismatch')
    throw Object.assign(new Error('无法核实需暂停的原执行'),{status:409});
  store.put(holds,target.runId,{cardId:card.id,cardVersion:card.version,heldAt:card.updatedAt} satisfies RunQuestionHold);
}

export function releaseRunQuestionHold(store:Store,run:Run,cardId:string,cardVersion:number):boolean {
  return store.transaction(()=>{
    const hold=readRunQuestionHold(store,run);
    return hold?.cardId===cardId && hold.cardVersion===cardVersion && store.remove(holds,run.id);
  });
}
