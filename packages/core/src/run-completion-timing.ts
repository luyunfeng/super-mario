import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Message, Run, Todo } from '../../protocol/src/index.ts';
import type { Plan } from './plans.ts';
import { completionEvidence } from './run-review.ts';

/** Only a host dispatch receipt and its original result message establish a plan round's elapsed time. */
export function planCompletionFacts(store: Store, run: Run) {
  if (!run.planEstimate || !run.resultSource) return;
  // A synchronous interactive startup receipt does not establish completion of its session.
  if (run.executionMode === 'interactive' && !run.nativeResultSources?.includes(run.resultSource)) return;
  const {planId, taskIndex, source} = run.planEstimate;
  if (!Number.isSafeInteger(taskIndex) || taskIndex < 0 || !['default','learned','override'].includes(source)) return;
  const plan = store.get<Plan>('plans', planId);
  const task = plan?.tasks[taskIndex];
  if (!plan || plan.id !== planId || !task || task.runId !== run.id || task.estimateSource !== source ||
      (task.todoId !== undefined && task.todoId !== run.todoId) || (task.projectId !== undefined && task.projectId !== run.projectId) ||
      !Number.isFinite(task.expectMinutes) || task.expectMinutes <= 0 ||
      store.get('dispatch-keys', `plan:${planId}:${plan.version}:${taskIndex}`) !== run.id) return;
  if (run.todoId) {
    const todo = store.get<Todo>('todos',run.todoId);
    if (!todo || todo.id !== run.todoId || todo.projectId !== run.projectId) return;
  }
  try { completionEvidence(run); } catch { return; }
  const receiptId = 'run-result:' + run.id;
  const receipt = store.get<Message>('messages', receiptId);
  if (!receipt || receipt.id !== receiptId || receipt.role !== 'assistant' || receipt.origin !== 'result' || receipt.status !== 'done' ||
      receipt.conversationId !== run.conversationId || receipt.todoId !== run.todoId || receipt.projectId !== run.projectId ||
      receipt.replyTo !== run.sourceMessageId) return;
  // New receipts pin the terminal outcome. Older installations recorded it on the Run in the same transaction.
  if (receipt.runResult && (receipt.runResult.runId !== run.id || receipt.runResult.status !== 'completed' ||
    receipt.runResult.source !== run.resultSource)) return;
  const start = Date.parse(run.createdAt), finish = Date.parse(receipt.createdAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start || finish > Date.now()) return;
  const actualMinutes = Math.max(1, Math.ceil((finish - start) / 60000));
  return {task, timing:{
    startedAt:run.createdAt, reportedAt:receipt.createdAt, actualMinutes, receiptId, source:run.resultSource,
    initialEstimateMinutes:task.expectMinutes, deltaMinutes:actualMinutes-task.expectMinutes,
  }};
}

export function runCompletionTiming(store: Store, run: Run) {
  return planCompletionFacts(store, run)?.timing;
}
