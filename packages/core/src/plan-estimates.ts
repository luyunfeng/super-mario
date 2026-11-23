import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Message, PlanEstimateDispatch, Run, Todo } from '../../protocol/src/index.ts';
import type { Plan, PlanTaskInput } from './plans.ts';
import { completionEvidence, evidenceVersion, type RunReview } from './run-review.ts';

export type { PlanEstimateDispatch };
export type PlanEstimateSource = PlanEstimateDispatch['source'];
export type PlanEstimateEvidence = {minutes:number; sampleCount:number; cohort:'project_machine'|'machine'|'comparable'};
const candidates = 'plan.estimate-candidates';

// Only an unconditional request to change code puts work in the implementation cohort.
function workKind(task: Pick<PlanTaskInput,'prompt'|'doneWhen'>) {
  const action = /实现|修复|重构|修改代码|提交代码|合并到主干|写单测|\b(?:implement(?:ation)?|refactor|fix|modify code|commit|merge into main)\b/gi;
  const check = /验证|核实|确认|检查|调查|分析|说明|审查|调研|报告|\b(?:verify|validate|confirm|check|review|research|investigate|describe|report)\b/i;
  for (const sentence of (task.prompt+'\n'+task.doneWhen).split(/[。；;！？!?\n]|\.(?:\s|$)/)) {
    if (/如果|若|否则|视情况|\b(?:if|unless|otherwise)\b/i.test(sentence)) continue;
    for (const clause of sentence.split(/[，,、：:]|然后|之后|再|(?<!合)并|\b(?:then|and)\b/i)) {
      for (const match of clause.matchAll(action)) {
        const prefix=clause.slice(0,match.index);
        if (!check.test(prefix) && !/(?:不|勿|禁止|无需|不要|不得)[^，。]{0,4}$|\b(?:not|never|without|avoid)\b(?:\s+\w+){0,3}\s*$/i.test(prefix)) return 'code';
      }
    }
  }
  return 'general';
}

/** Keep bounded pointers to host dispatch receipts. An admission alone is never a timing sample. */
export function rememberEstimateRun(store:Store, runId:string, origin:PlanEstimateDispatch) {
  const run=store.get<Run>('runs',runId);
  if (!run || run.id!==runId || !run.todoId || run.executionMode!=='task' ||
      run.planEstimate?.planId!==origin.planId || run.planEstimate.taskIndex!==origin.taskIndex ||
      run.planEstimate.source!==origin.source) return;
  const key=JSON.stringify(run.projectId ?? null);
  const previous=store.get<string[]>(candidates,key) ?? [];
  store.put(candidates,key,[runId,...previous.filter(id=>id!==runId)].slice(0,256));
}

function completionSample(store:Store, runId:string, projectId:string|undefined, kind:ReturnType<typeof workKind>, now:number) {
  const run=store.get<Run>('runs',runId);
  if (!run || run.id!==runId || run.projectId!==projectId || !run.todoId ||
      run.executionMode!=='task' || run.status!=='completed' || !run.planEstimate) return;
  const {planId,taskIndex,source}=run.planEstimate;
  const plan=store.get<Plan>('plans',planId);
  const task=plan?.tasks[taskIndex];
  if (!plan || plan.id!==planId || !task || workKind(task)!==kind || task.runId!==runId || task.estimateSource!==source ||
      store.get('dispatch-keys',`plan:${planId}:${plan.version}:${taskIndex}`)!==runId) return;
  const todo=store.get<Todo>('todos',run.todoId);
  const review=store.get<RunReview>('run-reviews',run.todoId);
  if (!todo?.completedAt || todo.id!==run.todoId || todo.projectId!==projectId || review?.status!=='accepted' ||
      review.todoId!==todo.id || review.runId!==runId || !review.runIds?.includes(runId) || review.doneWhen!==run.doneWhen ||
      review.evidenceVersion!==evidenceVersion(run)) return;
  try { completionEvidence(run); } catch { return; }
  const resultId='run-result:'+runId;
  const receipt=store.get<Message>('messages',resultId);
  if (!receipt || receipt.id!==resultId || receipt.todoId!==todo.id || receipt.projectId!==projectId ||
      receipt.conversationId!==run.conversationId || receipt.role!=='assistant' || receipt.origin!=='result' || receipt.status!=='done') return;
  const finished=Date.parse(receipt.createdAt), started=Date.parse(run.createdAt), accepted=Date.parse(review.updatedAt);
  if (![finished,started,accepted].every(Number.isFinite) || started>finished || finished>accepted || accepted>now ||
      accepted<now-90*86400000) return;
  return {executorId:run.executorId,accepted,minutes:Math.max(1,Math.ceil((finished-started)/60000)),cwd:run.cwd};
}

/** Freeze estimates at proposal time and disclose only aggregated evidence from the same scope. */
export function estimatePlanTask(store:Store, task:PlanTaskInput):{expectMinutes:number; estimateSource:PlanEstimateSource; estimateEvidence?:PlanEstimateEvidence} {
  if (task.expectMinutes!==undefined) return {expectMinutes:task.expectMinutes,estimateSource:'override'};
  const fallback={expectMinutes:60,estimateSource:'default' as const};
  if (task.executionMode==='interactive') return fallback;
  const projectId=task.projectId ?? (task.todoId ? store.get<Todo>('todos',task.todoId)?.projectId : undefined);
  const now=Date.now();
  const ids=store.get<string[]>(candidates,JSON.stringify(projectId ?? null)) ?? [];
  const kind=workKind(task);
  const samples=ids.slice(0,256).map(id=>completionSample(store,id,projectId,kind,now))
    .filter(sample=>sample!==undefined).sort((a,b)=>b.accepted-a.accepted);
  const machine=samples.filter(s=>s.executorId===task.executorId);
  const workspace=task.cwd ? machine.filter(s=>s.cwd===task.cwd) : [];
  const cohort=workspace.length>=5 ? 'project_machine' : machine.length>=5 ? 'machine' : 'comparable';
  const chosen=(cohort==='project_machine' ? workspace : cohort==='machine' ? machine : samples).slice(0,32);
  if (chosen.length<5) return fallback;
  const values=chosen.map(s=>s.minutes).sort((a,b)=>a-b);
  const middle=(values[Math.floor((values.length-1)/2)]!+values[Math.floor(values.length/2)]!)/2;
  const minutes=Math.min(1440,Math.ceil(middle));
  return {expectMinutes:minutes,estimateSource:'learned',estimateEvidence:{
    minutes,sampleCount:values.length,cohort,
  }};
}
