import { validatePolicyPatch, type PolicyConfig } from './policies.ts';
import { randomUUID } from 'node:crypto';
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
  cwd?: string;
  projectId?: string;
  todoId?: string;
  doneWhen: string;
  expectMinutes: number;
  executionMode?: 'task' | 'interactive';
  policy?: Partial<PolicyConfig>;
}
export interface Plan {
  id: string;
  title: string;
  version: number;
  status: 'pending' | 'running' | 'started' | 'rejected' | 'partial' | 'unknown';
  tasks: (PlanTaskInput & { runId?: string; error?: string })[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
const collection = 'plans';
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new PlansError(`${field}必须为非空文本`);
}
function validate(input: { title: string; tasks: PlanTaskInput[] }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PlansError('计划必须为对象');
  text(input.title, 'title');
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 8) throw new PlansError('计划需要 1–8 个任务');
  // Copy only supported input fields. No writes or dispatches occur until every task passes.
  const tasks = Array.from(input.tasks, (task): PlanTaskInput => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new PlansError('任务必须为对象');
    text(task.prompt, 'prompt');
    text(task.doneWhen, 'doneWhen');
    if (typeof task.expectMinutes !== 'number' || !Number.isFinite(task.expectMinutes) || task.expectMinutes <= 0 || task.expectMinutes > 10080) {
      throw new PlansError('expectMinutes必须为1周内的有限正数');
    }
    const result: PlanTaskInput = { prompt: task.prompt, doneWhen: task.doneWhen, expectMinutes: task.expectMinutes };
    for (const key of ['executorId', 'cwd', 'projectId', 'todoId'] as const) {
      if (task[key] !== undefined) { text(task[key], key); result[key] = task[key]; }
    }
    if (task.executionMode !== undefined) {
      if (!['task', 'interactive'].includes(task.executionMode)) throw new PlansError('executionMode必须为task或interactive');
      result.executionMode = task.executionMode;
    }
    if (task.policy !== undefined) {
      try { validatePolicyPatch(task.policy); } catch (error) { throw new PlansError(error instanceof Error ? error.message : '无效任务策略'); }
      result.policy = structuredClone(task.policy);
    }
    return result;
  });
  return { title: input.title, tasks };
}

/** One service per store. started means dispatch accepted, never task completion. */
export function createPlans({ store, events, dispatch }: {
  store: Store;
  events: EventBus;
  dispatch: (input: Record<string, unknown>, key?: string) => { id: string };
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
      const fields = validate(input);
      const now = new Date().toISOString();
      const plan: Plan = { ...fields, id: randomUUID(), version: 1, status: 'pending', createdAt: now, updatedAt: now };
      store.put(collection, plan.id, plan);
      changed(plan.id);
      return structuredClone(plan);
    },
    start(id: string, version: number): Plan {
      const plan = store.transaction(() => {
        const plan = current(id, version);
        // Claim commits before invoking any external code, including event observers.
        plan.status = 'running';
        plan.updatedAt = new Date().toISOString();
        store.put(collection, id, plan);
        return plan;
      });
      changed(id);
      for (const [index, task] of plan.tasks.entries()) {
        try {
          const run = dispatch({ ...task }, `plan:${id}:${version}:${index}`);
          // A malformed receipt may still have caused an external action. Never replay it.
          if (!run || typeof run.id !== 'string' || !run.id.trim()) throw new Error('派发未返回有效 runId，结果未知');
          task.runId = run.id;
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
