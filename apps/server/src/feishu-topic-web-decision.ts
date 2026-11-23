import { createHash } from 'node:crypto';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { Message, Todo } from '../../../packages/protocol/src/index.ts';
import type { WorkDecision } from '../../../packages/protocol/src/work-decisions.ts';

/** Called for live ledger events only. The caller owns pairing, topic membership and delivery. */
export function webTopicDecision(
  store: Pick<Store, 'get'>,
  getDecision: (id: string) => WorkDecision | undefined,
  event: { type: string; data: unknown }
): { todoId: string; decisionId: string } | undefined {
  if (event.type !== 'work.decision.recorded' || !event.data || typeof event.data !== 'object') return;
  const data = event.data as Record<string, unknown>;
  if (typeof data.id !== 'string' || data.version !== 1 || data.status !== 'active') return;
  try {
    // ledger.get verifies every revision, source content and the sealed channel route.
    const fact = getDecision(data.id);
    if (
      !fact ||
      fact.id !== data.id ||
      fact.version !== 1 ||
      fact.status !== 'active' ||
      fact.scope.kind !== 'task' ||
      fact.scope.projectId !== undefined
    )
      return;
    const todo = store.get<Todo>('todos', fact.scope.todoId);
    if (!todo || todo.id !== fact.scope.todoId || todo.projectId !== undefined) return;
    // recordFromWeb derives its evidence key from the exact operation, resolved scope and request key.
    // Agent writes also have role=user evidence, but their source is the actual chat input.
    const key = createHash('sha256')
      .update(JSON.stringify(['record', { kind: 'task', todoId: todo.id }, fact.key]))
      .digest('hex');
    const sourceId = 'wd-input-' + key;
    if (fact.source.messageId !== sourceId || fact.recordSource.messageId !== sourceId || store.get('message.routes', sourceId))
      return;
    const source = store.get<Message>('messages', sourceId);
    if (
      !source ||
      source.id !== sourceId ||
      source.conversationId !== 'main' ||
      source.role !== 'user' ||
      source.origin !== 'user' ||
      source.status !== 'done' ||
      source.replyTo !== undefined ||
      source.readOnly ||
      source.todoId !== todo.id ||
      source.projectId !== undefined ||
      source.text.trim() !== fact.text ||
      source.createdAt !== fact.source.createdAt
    )
      return;
    return { todoId: todo.id, decisionId: fact.id };
  } catch {
    // The source or its scope can change before this listener runs.
    return;
  }
}
