import { digest } from '../../../packages/core/src/eventbox.ts';
import type { EffectRecord } from '../../../packages/core/src/effects.ts';
import type { DurableEvent, Store } from '../../../packages/plugin-sdk/src/index.ts';
import { responsibleSessionTodos } from '../../../packages/core/src/responsible-session.ts';
import type { Json, Message, Run } from '../../../packages/protocol/src/index.ts';

const object = (value?: Json) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const observation = new Set(['screen', 'text', 'runner', 'real', 'demo', 'unknown', 'idle', 'terminal-idle']);

/** Resolve the live responsible session using committed native evidence only. The caller authorizes the final group route. */
export function topicFinishedNotice(store: Pick<Store, 'get' | 'list'>, runId: string, messageId: string): {todoId: string; eventId: string} | undefined {
  if (!runId || messageId !== 'run-result:' + runId) return;
  const run = store.get<Run>('runs', runId);
  if (run?.id !== runId || run.status !== 'completed' || run.executionMode !== 'task' || run.projectId !== undefined
    || !run.machineId || !run.sessionId || !run.executorId || !run.resultSource || observation.has(run.resultSource.trim().toLowerCase())
    || !run.nativeResultSources?.includes(run.resultSource)) return;
  if (run.nativeResume && (!run.nativeSessionId || run.nativeResume.nativeSessionId !== run.nativeSessionId ||
    ![run.nativeResume.executorId, run.machineId + '/' + run.nativeResume.executorId].includes(run.executorId))) return;

  const key = 'run:' + runId + ':start';
  const effect = store.get<EffectRecord>('effects', key);
  const result = object(effect?.result);
  if (effect?.key !== key || effect.kind !== (run.nativeResume ? 'executor.resume' : 'executor.start')
    || effect.status !== 'confirmed' || effect.target !== run.machineId || result?.sessionId !== run.sessionId) return;
  // A synchronous plugin return alone is also marked completed. Only a pinned native-resume result is evidence on that path.
  if (result.pending !== true) {
    const proof = object(result.nativeResult);
    if (!run.nativeResume || proof?.state !== 'completed' || proof.source !== run.resultSource
      || proof.nativeSessionId !== run.nativeSessionId || proof.text !== run.output) return;
  }

  const sourceId = 'run:' + runId + ':finished', eventKey = digest(['core', sourceId]);
  const event = store.get<DurableEvent>('eventbox.events', eventKey);
  const data = object(event?.data);
  if (event?.id !== eventKey || event.source !== 'core' || event.sourceId !== sourceId || event.type !== 'run.finished' || event.typeVersion !== 1
    || event.subject?.kind !== 'run' || event.subject.id !== runId || data?.runId !== runId || data.messageId !== messageId || data.status !== 'completed') return;
  const message = store.get<Message>('messages', messageId);
  if (message?.id !== messageId || message.origin !== 'result' || message.role !== 'assistant' || message.status !== 'done'
    || message.conversationId !== run.conversationId || message.replyTo !== run.sourceMessageId || message.todoId !== run.todoId
    || message.projectId !== run.projectId) return;

  const todo = responsibleSessionTodos(store)(run);
  if (!todo) return;
  return { todoId: todo.id, eventId: messageId };
}
