import { responsibleSessionTodos } from '../../../packages/core/src/responsible-session.ts';
import { mailboxEntryId } from '../../../packages/core/src/event-mailboxes.ts';
import type { Card } from '../../../packages/core/src/interactions.ts';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { MailboxEntry, Message, Run } from '../../../packages/protocol/src/index.ts';

type Route = {
  channel: string;
  botId: string;
  accountId: string;
  revision: number;
  inputId: string;
  target: string;
  threadId?: string;
  topic?: { todoId: string; grant: string; opening?: boolean; sourceOpening?: boolean };
};

/** Read after notifications.message. The host checks current opening permissions before delivery. */
export function topicInteractionNotice(
  store: Pick<Store, 'get' | 'list'>,
  cardId: string,
  openingInputId?: string,
  now = Date.now()
) {
  const card = store.get<Card>('interactions', cardId);
  if (
    !card ||
    card.id !== cardId ||
    !card.runId ||
    card.projectId !== undefined ||
    card.status !== 'open' ||
    card.handler !== 'user' ||
    !card.userNotifiedAt ||
    !(Date.parse(card.expiresAt) > now)
  )
    return;
  const run = store.get<Run>('runs', card.runId);
  if (
    !run ||
    run.id !== card.runId ||
    !run.machineId ||
    !run.sessionId ||
    run.projectId !== undefined ||
    // Task executors reject question/permission replies. Plan and review cards are handled by the workbench itself.
    (run.executionMode !== 'interactive' && !(run.executionMode === 'task' && ['plan', 'review'].includes(card.kind))) ||
    run.status !== 'running' ||
    card.executorId !== run.executorId ||
    card.cwd !== run.cwd
  )
    return;
  const todo = responsibleSessionTodos(store)(run);
  if (!todo) return;
  const origin = store.get<{ inputId?: string }>('interaction-origins', cardId);
  const noticeId = 'interaction-notice:' + cardId;
  const message = store.get<Message>('messages', noticeId);
  if (
    !origin ||
    (run.sourceMessageId && run.sourceMessageId !== origin.inputId) ||
    !message ||
    message.id !== noticeId ||
    message.origin !== 'notification' ||
    message.role !== 'assistant' ||
    message.conversationId !== 'main' ||
    message.projectId !== undefined ||
    message.status !== 'done' ||
    message.createdAt !== card.userNotifiedAt ||
    !Number.isFinite(Date.parse(message.createdAt)) ||
    message.replyTo !== origin.inputId
  )
    return;
  const original = origin.inputId ? store.get<Message>('messages', origin.inputId) : undefined;
  if (
    origin.inputId !== undefined &&
    (!original ||
      original.id !== origin.inputId ||
      original.projectId !== undefined ||
      (original.todoId !== undefined && original.todoId !== todo.id))
  )
    return;
  if (openingInputId !== undefined) {
    const opening = store.get<Route>('message.routes', openingInputId);
    if (
      !opening ||
      opening.inputId !== openingInputId ||
      opening.channel !== 'feishu' ||
      !(opening.topic?.opening || opening.topic?.sourceOpening) ||
      opening.topic.todoId !== todo.id ||
      !opening.botId ||
      !opening.accountId ||
      !opening.target ||
      !opening.threadId ||
      !opening.topic.grant
    )
      return;
    const route = origin.inputId && store.get<Route>('message.routes', origin.inputId);
    if (
      route &&
      route.inputId &&
      route.channel === 'feishu' &&
      route.botId === opening.botId &&
      route.accountId === opening.accountId &&
      route.revision === opening.revision &&
      route.target === opening.target &&
      route.threadId === opening.threadId &&
      route.topic?.grant === opening.topic.grant &&
      route.topic.todoId === todo.id
    ) {
      // Older versions used the normal assistant outbox. An uncertain delivery must suppress a second notification too.
      const eventKey = 'feishu-reply:' + JSON.stringify([route.botId, route.accountId, route.inputId, noticeId]);
      const id = mailboxEntryId(route.botId, 'outbox', eventKey);
      const previous = store.get<MailboxEntry>('event.mailboxes', id);
      if (
        previous?.id === id &&
        previous.eventKey === eventKey &&
        previous.botId === route.botId &&
        previous.direction === 'outbox' &&
        previous.replyTo === route.inputId &&
        previous.target === route.target &&
        ['ready', 'pending', 'processing', 'completed', 'unknown'].includes(previous.status)
      )
        return;
    }
  }
  return { todoId: todo.id, runId: run.id, interactionId: cardId };
}
