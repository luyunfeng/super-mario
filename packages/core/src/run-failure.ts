// What went wrong with a run, in the few kinds a person can act on.
//
// The kind is worked out when the run fails, from the error that was thrown, because that is
// the only moment the error is in hand. The stage is worked out when the run is read, from how
// far it got. Neither is read out of the error's words: words change, and a kind guessed from
// them would be wrong in the one case it matters.
import type { Run } from '../../protocol/src/index.ts';

/** Where it went wrong. */
export type FailureStage = 'dispatch' | 'start' | 'run' | 'recover';

/** What kind of thing went wrong. */
export type FailureKind =
  | 'network'      // the server could not reach the machine, or lost it
  | 'machine'      // the machine's agent refused or could not do it
  | 'executor'     // the thing that runs the task said it failed
  | 'server'       // the workbench itself
  | 'refused'      // it was not allowed: a policy said no, an input was not valid
  | 'unknown';

/** A machine channel error, as the workbench's MachineError is shaped. */
interface ChannelError extends Error { status?: number; delivery?: 'no' | 'unknown'; lost?: boolean }

/**
 * The kind of a failure, from the error that ended the run.
 *
 * A MachineError is told by its status: not being able to talk to the machine at all is the
 * network, the machine answering with a refusal is the machine, and anything else it answered
 * is the machine too. An InputError is something the workbench would not do. What the executor
 * itself reported has already been written as the run's failure and does not come through here.
 */
export function failureKind(error: unknown): FailureKind {
  if (!(error instanceof Error)) return 'unknown';
  // An effect that ended in an error wraps it. What kind it was is read through the wrapping.
  if (error.name === 'EffectError') return error.cause === undefined ? 'server' : failureKind(error.cause);
  // The machine channel names its own errors. Told apart by status and delivery, which it sets.
  if (error.name === 'MachineError') {
    const { status, delivery, lost } = error as ChannelError;
    // The connection went away after the request was sent. What the machine did with it is
    // not known, but what failed is the connection.
    if (lost) return 'network';
    if (status === 503 && delivery === 'no') return 'network';
    if (status === 504) return 'network';
    if (typeof status === 'number' && status < 500) return 'refused';
    return 'machine';
  }
  // The workbench refuses an action it will not do, and a hook that stops a dispatch is one too.
  if (error.name === 'InputError' || error.name === 'MailInputError' || error.name === 'PluginCallError') return 'refused';
  // Anything else that ended a run came from the workbench itself.
  return 'server';
}

/**
 * Where a run was when it stopped, read from how far it got.
 *
 * A run that was being recovered across a restart is a recovery. A run that never got a session
 * did not start, and one that was stopped before it left the queue was still being dispatched.
 * A run with a session was running.
 */
export function failureStage(run: Pick<Run, 'sessionId' | 'status' | 'error' | 'createdAt'> & { startedAt?: string }): FailureStage {
  if (/服务重启/.test(run.error ?? '')) return 'recover';
  if (run.sessionId) return 'run';
  return run.status === 'cancelled' ? 'dispatch' : 'start';
}

/** What a person reading a failure is told, in words. */
export function failureText(run: Pick<Run, 'status' | 'failure'>): string | undefined {
  if (run.status !== 'failed' && run.status !== 'unknown') return undefined;
  const kind = run.failure?.kind ?? 'unknown';
  const stage = failureStage(run as Run);
  const kinds: Record<FailureKind, string> = {
    network: '服务端连不上执行机，或者连接中断',
    machine: '执行机拒绝了这次操作，或者没能完成',
    executor: '执行者报告任务失败',
    server: '服务端自身出错',
    refused: '这次操作没有被允许：策略拒绝，或者输入无效',
    unknown: '没有足够的信息判断是哪一类问题',
  };
  const stages: Record<FailureStage, string> = { dispatch: '派发', start: '启动', run: '运行', recover: '重启后恢复' };
  return `${kinds[kind]}。失败阶段：${stages[stage]}。`;
}

/** A report someone can read or pass on without the prompt, the output or the error's words.
 *  It has only what the run already keeps as structure: what ran, when, on what build, and how
 *  it stopped. The working directory and the branch are kept, because finding a failure needs
 *  them; the prompt and the output are not, because they are the person's own content. */
export interface RunDiagnostics {
  format: 'super-mario.run-diagnostics';
  version: 1;
  exportedAt: string;
  run: {
    id: string; executorId: string; status: Run['status']; executionMode?: string; model?: string;
    projectId?: string; todoId?: string; machineId?: string;
    createdAt: string; updatedAt: string;
    build?: Run['build'];
    failure?: { kind: FailureKind; at: string; stage: FailureStage; summary: string };
    /** How long the run took, or had been going when the report was made. Only for the reader. */
    durationMs: number;
    cwd?: string; worktree?: { source: string; branch?: string; base?: string; removedAt?: string; branchDeletedAt?: string };
  };
}

export function runDiagnostics(run: Run, now = new Date()): RunDiagnostics {
  const { cwd, worktree } = run;
  const failure = run.status === 'failed' || run.status === 'unknown'
    ? { kind: run.failure?.kind ?? 'unknown', at: run.failure?.at ?? run.updatedAt, stage: failureStage(run), summary: failureText(run) ?? '' } : undefined;
  return {
    format: 'super-mario.run-diagnostics', version: 1, exportedAt: now.toISOString(),
    run: {
      id: run.id, executorId: run.executorId, status: run.status, ...(run.executionMode && { executionMode: run.executionMode }),
      ...(run.model && { model: run.model }), ...(run.projectId && { projectId: run.projectId }), ...(run.todoId && { todoId: run.todoId }),
      ...(run.machineId && { machineId: run.machineId }), createdAt: run.createdAt, updatedAt: run.updatedAt,
      ...(run.build && { build: run.build }), ...(failure ? { failure } : undefined),
      durationMs: Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)),
      ...(cwd && { cwd }), ...(worktree && { worktree: { source: worktree.source, ...(worktree.branch && { branch: worktree.branch }), ...(worktree.base && { base: worktree.base }), ...(worktree.removedAt && { removedAt: worktree.removedAt }), ...(worktree.branchDeletedAt && { branchDeletedAt: worktree.branchDeletedAt }) } }),
    },
  };
}
