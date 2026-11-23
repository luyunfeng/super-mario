import { estimatePlanTask, rememberEstimateRun, type PlanEstimateDispatch, type PlanEstimateSource, type PlanEstimateEvidence } from './plan-estimates.ts';
import { validatePolicyPatch, type PolicyConfig } from './policies.ts';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';

export class PlansError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  constructor(message: string, status: 400 | 404 | 409 | 503 = 400) {
    super(message);
    this.name = 'PlansError';
    this.status = status;
  }
}

export interface PlanTaskInput {
  prompt: string;
  executorId?: string;
  model?: string;
  cwd?: string;
  projectId?: string;
  todoId?: string;
  doneWhen: string;
  expectMinutes?: number;
  executionMode?: 'task' | 'interactive';
  policy?: Partial<PolicyConfig>;
}
export interface Plan {
  id: string;
  title: string;
  version: number;
  status: 'pending' | 'running' | 'started' | 'rejected' | 'partial' | 'unknown';
  tasks: (PlanTaskInput & {expectMinutes:number; estimateSource?:PlanEstimateSource; estimateEvidence?:PlanEstimateEvidence; runId?:string; error?:string})[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
const collection = 'plans';
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new PlansError(`${field}必须为非空文本`);
}
function modelId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) throw new PlansError('模型标识无效');
  return value;
}
function minutes(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10080) {
    throw new PlansError('expectMinutes必须为1周内的有限正数');
  }
}

function applyStartEdits(plan: Plan, edits: unknown) {
  if (!Array.isArray(edits) || !edits.length || edits.length > plan.tasks.length) throw new PlansError('请选择要修改的计划任务');
  const changed = new Set<number>();
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit) || !Number.isSafeInteger(edit.index)
        || edit.index < 0 || edit.index >= plan.tasks.length || changed.has(edit.index)) throw new PlansError('任务索引无效或重复');
    changed.add(edit.index);
    const fields = Object.keys(edit).filter(k => k !== 'index');
    const task = plan.tasks[edit.index]!;
    if (!fields.length) throw new PlansError('请提供要修改的任务字段');
    for (const key of fields) {
      const value:unknown = edit[key];
      if (key === 'expectMinutes') {
        minutes(value);
        if (value !== task.expectMinutes) {
          task.expectMinutes = value;
          task.estimateSource = 'override';
          delete task.estimateEvidence;
        }
      } else if (key === 'model') {
        if (value === '') delete task.model;
        else task.model = modelId(value);
      } else if (key === 'prompt' || key === 'doneWhen' || key === 'executorId' || key === 'cwd') {
        text(value,key);
        if (key === 'cwd' && (!isAbsolute(value.trim()) || /[\x00-\x1f\x7f]/.test(value))) throw new PlansError('工作目录必须为绝对路径');
        task[key] = value.trim();
      } else throw new PlansError('计划修改包含不支持的字段');
    }
  }
}

function validate(store: Store, input: { title: string; tasks: PlanTaskInput[] }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PlansError('计划必须为对象');
  text(input.title, 'title');
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 8) throw new PlansError('计划需要 1–8 个任务');
  // Copy only supported input fields. No writes or dispatches occur until every task passes.
  const tasks = Array.from(input.tasks, (task): Plan['tasks'][number] => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new PlansError('任务必须为对象');
    text(task.prompt, 'prompt');
    text(task.doneWhen, 'doneWhen');
    if (task.expectMinutes !== undefined) minutes(task.expectMinutes);
    const result: PlanTaskInput = { prompt: task.prompt, doneWhen: task.doneWhen, expectMinutes: task.expectMinutes };
    for (const key of ['executorId', 'cwd', 'projectId', 'todoId'] as const) {
      if (task[key] !== undefined) { text(task[key], key); result[key] = task[key]; }
    }
    if (task.model !== undefined) result.model = modelId(task.model);
    if (task.executionMode !== undefined) {
      if (!['task', 'interactive'].includes(task.executionMode)) throw new PlansError('executionMode必须为task或interactive');
      result.executionMode = task.executionMode;
    }
    if (task.policy !== undefined) {
      try { validatePolicyPatch(task.policy); } catch (error) { throw new PlansError(error instanceof Error ? error.message : '无效任务策略'); }
      result.policy = structuredClone(task.policy);
    }
    return {...result,...estimatePlanTask(store,result)};
  });
  return { title: input.title, tasks };
}

/** One service per store. started means dispatch accepted, never task completion. */
export function createPlans({ store, events, dispatch, preflight }: {
  store: Store;
  events: EventBus;
  preflight?: (task:PlanTaskInput, planId:string) => void;
  dispatch: (input: Record<string, unknown>, key?: string, estimate?:PlanEstimateDispatch) => { id: string };
}) {
  let closed = false;
  function open() { if (closed) throw new PlansError('计划服务已关闭', 503); }
  function get(id: string): Plan {
    text(id, 'id');
    const plan = store.get<Plan>(collection, id);
    if (!plan) throw new PlansError('计划不存在', 404);
    return plan;
  }
  function current(id: string, version: number): Plan {
    open();
    if (!Number.isSafeInteger(version) || version < 1) throw new PlansError('version必须为正整数');
    const plan = get(id);
    if (plan.version !== version || plan.status !== 'pending') throw new PlansError('计划已更新或已提交，请刷新', 409);
    return plan;
  }
  function changed(id: string) { events.publish('plans.changed', { id }); }
  const recovered = store.transaction(() => {
    const plans = store.list<Plan>(collection).filter(plan => plan.status === 'running');
    for (const plan of plans) store.put(collection, plan.id, { ...plan, status: 'unknown',
      error: '服务重启，派发结果未知，不自动重试', updatedAt: new Date().toISOString() });
    return plans;
  });
  for (const plan of recovered) changed(plan.id);

  return {
    get,
    list(): Plan[] { return store.list<Plan>(collection).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    propose(input: { title: string; tasks: PlanTaskInput[] }): Plan {
      open();
      const fields = validate(store,input);
      const now = new Date().toISOString();
      const plan: Plan = { ...fields, id: randomUUID(), version: 1, status: 'pending', createdAt: now, updatedAt: now };
      store.put(collection, plan.id, plan);
      changed(plan.id);
      return structuredClone(plan);
    },
    start(id: string, version: number, edits?:unknown): Plan {
      const plan = store.transaction(() => {
        const plan = current(id, version);
        if (edits !== undefined) {
          applyStartEdits(plan, edits);
          for (const task of plan.tasks) preflight?.(task, id);
        }
        // Claim commits before invoking any external code, including event observers.
        plan.status = 'running';
        plan.updatedAt = new Date().toISOString();
        store.put(collection, id, plan);
        return plan;
      });
      changed(id);
      for (const [index, task] of plan.tasks.entries()) {
        try {
          const {estimateSource, estimateEvidence, ...payload} = task;
          const estimate = estimateSource && {planId:id, taskIndex:index, source:estimateSource};
          const run = dispatch(payload, `plan:${id}:${version}:${index}`, estimate);
          // A malformed receipt may still have caused an external action. Never replay it.
          if (!run || typeof run.id !== 'string' || !run.id.trim()) throw new Error('派发未返回有效 runId，结果未知');
          task.runId = run.id;
          if (estimate) rememberEstimateRun(store, run.id, estimate);
        } catch (error) {
          task.error = error instanceof Error ? error.message || error.name : String(error);
        }
        // Persist each receipt before dispatching the next task; a crash leaves running.
        plan.updatedAt = new Date().toISOString();
        store.put(collection, id, plan);
      }
      plan.status = plan.tasks.some(task => task.error !== undefined) ? 'partial' : 'started';
      plan.updatedAt = new Date().toISOString();
      store.put(collection, id, plan);
      changed(id);
      return structuredClone(plan);
    },
    reject(id: string, version: number): Plan {
      const plan = store.transaction(() => {
        const plan = current(id, version);
        plan.status = 'rejected';
        plan.updatedAt = new Date().toISOString();
        store.put(collection, id, plan);
        return plan;
      });
      changed(id);
      return plan;
    },
    close() { closed = true; },
  };
}
