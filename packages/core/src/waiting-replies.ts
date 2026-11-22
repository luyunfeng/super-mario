import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';
import type { Todo } from '../../protocol/src/index.ts';
import type { ArmWaitingReply, ConsumeWaitingReplyResult, NormalizedReplyEvidence, WaitingReplySnapshot } from '../../protocol/src/waiting-replies.ts';

const waits = 'todo.waiting-replies';
const evidenceCollection = 'todo.reply-evidence';
const waitId = (todoId: string, key: string) => JSON.stringify([todoId, key]);
const evidenceId = (e: NormalizedReplyEvidence) => JSON.stringify([e.source, e.chatId, e.messageId]);

function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be nonempty`);
}
function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError('Invalid timestamp');
}
function evidence(input: NormalizedReplyEvidence): NormalizedReplyEvidence {
  if (!input || typeof input !== 'object') throw new TypeError('Raw reply evidence required');
  for (const key of ['source', 'chatId', 'messageId', 'senderId', 'senderIdType'] as const) text(input[key], key);
  timestamp(input.createdAt);
  // Copy only the contract fields: display names/origin never become identity.
  const result: NormalizedReplyEvidence = {
    source: input.source, chatId: input.chatId, messageId: input.messageId,
    senderId: input.senderId, senderIdType: input.senderIdType, createdAt: input.createdAt,
  };
  for (const key of ['parentId', 'rootId', 'threadId'] as const) {
    if (input[key] !== undefined) { text(input[key], key); result[key] = input[key]; }
  }
  for (const key of ['edited', 'deleted'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new TypeError(`${key} must be boolean`);
      result[key] = input[key];
    }
  }
  return result;
}
function unchanged(todo: Todo, wait: WaitingReplySnapshot): boolean {
  return !todo.completedAt && todo.waitingOn === wait.waitingOn && todo.reminderAt === wait.reminderAt
    && todo.projectId === wait.scope.projectId;
}

/** Compose with the real workbench's Store and EventBus. No timer, collector or
 * external send is installed. Call arm only AFTER updateTodo sets waitingOn and
 * reminderAt. consume accepts trusted collector metadata, never parsed prose.
 *
 * Writes and durable events share a synchronous transaction. As with updateTodo,
 * EventBus observers should reload state; the existing bus delivers synchronously.
 * This module neither counts reminders as sends nor infers absence from a page.
 */
export function createWaitingReplies({ store, events, now = () => new Date() }: {
  store: Store; events: EventBus; now?: () => Date;
}) {
  function list(todoId: string): WaitingReplySnapshot[] {
    text(todoId, 'todoId');
    return store.list<WaitingReplySnapshot>(waits).filter(w => w.todoId === todoId).sort((a, b) => a.cycle - b.cycle);
  }
  function get(todoId: string): WaitingReplySnapshot | undefined { return list(todoId).at(-1); }
  function save(wait: WaitingReplySnapshot) { store.put(waits, waitId(wait.todoId, wait.key), wait); }

  return {
    list, get,
    invalidate(todoId: string) {
      return store.transaction(() => {
        const wait = get(todoId);
        if (wait?.status === 'waiting') save({ ...wait, status: 'invalidated', endedAt: now().toISOString() });
      });
    },
    arm(input: ArmWaitingReply): WaitingReplySnapshot {
      text(input.todoId, 'todoId'); text(input.key, 'key');
      text(input.expectedSenderId, 'expectedSenderId'); text(input.expectedSenderIdType, 'expectedSenderIdType');
      if (input.note !== undefined) text(input.note, 'note');
      const anchor = evidence(input.anchor);
      if (anchor.edited || anchor.deleted) throw new TypeError('Anchor must be an original message');
      return store.transaction(() => {
        const previous = store.get<WaitingReplySnapshot>(waits, waitId(input.todoId, input.key));
        if (previous) {
          if (JSON.stringify(previous.anchor) !== JSON.stringify(anchor)
            || previous.expectedSenderId !== input.expectedSenderId || previous.expectedSenderIdType !== input.expectedSenderIdType
            || previous.note !== input.note) throw new Error('Waiting key already used with different input');
          return previous;
        }
        const todo = store.get<Todo>('todos', input.todoId);
        if (!todo || todo.id !== input.todoId) throw new Error('Todo does not exist');
        if (todo.completedAt || !todo.waitingOn?.trim() || !todo.reminderAt) throw new Error('Todo must already be waiting with a reminder');
        timestamp(todo.reminderAt);
        const startedAt = now().toISOString();
        if (Date.parse(anchor.createdAt) > Date.parse(startedAt)) throw new Error('Anchor is in the future');
        const history = list(todo.id);
        // Reusing an old anchor cannot distinguish a delayed old-cycle reply.
        if (history.some(w => evidenceId(w.anchor) === evidenceId(anchor))) throw new Error('New waiting cycle requires a fresh anchor');
        for (const old of history) if (old.status === 'waiting') save({ ...old, status: 'superseded', endedAt: startedAt });
        const wait: WaitingReplySnapshot = {
          todoId: todo.id, key: input.key, anchor, expectedSenderId: input.expectedSenderId,
          expectedSenderIdType: input.expectedSenderIdType, ...(input.note === undefined ? {} : { note: input.note }),
          cycle: (history.at(-1)?.cycle ?? 0) + 1, reminderVersion: todo.reminderVersion ?? 1, startedAt,
          scope: todo.projectId === undefined ? {} : { projectId: todo.projectId },
          waitingOn: todo.waitingOn, reminderAt: todo.reminderAt, status: 'waiting',
        };
        save(wait);
        return wait;
      });
    },
    consume(input: NormalizedReplyEvidence): ConsumeWaitingReplyResult {
      const reply = evidence(input);
      return store.transaction(() => {
        const id = evidenceId(reply);
        if (store.get(evidenceCollection, id)) return { duplicate: true, matched: [] };
        // First observation is immutable, including rejected edits/deletions. A
        // collector must not later upgrade the same observation into a new reply.
        store.put(evidenceCollection, id, reply);
        const processedAt = now().toISOString();
        const matched: WaitingReplySnapshot[] = [];
        for (const wait of store.list<WaitingReplySnapshot>(waits)) {
          if (wait.status !== 'waiting') continue;
          const todo = store.get<Todo>('todos', wait.todoId);
          if (!todo || !unchanged(todo, wait)) {
            save({ ...wait, status: 'invalidated', endedAt: processedAt });
            continue;
          }
          if (reply.edited || reply.deleted || reply.source !== wait.anchor.source || reply.chatId !== wait.anchor.chatId
            || reply.senderId !== wait.expectedSenderId || reply.senderIdType !== wait.expectedSenderIdType
            || reply.parentId !== wait.anchor.messageId || reply.messageId === wait.anchor.messageId
            || Date.parse(reply.createdAt) <= Math.max(Date.parse(wait.startedAt), Date.parse(wait.anchor.createdAt))
            || Date.parse(reply.createdAt) > Date.parse(processedAt)) continue;
          const hit: WaitingReplySnapshot = { ...wait, status: 'matched', endedAt: processedAt,
            hit: { evidence: reply, reason: 'direct_reply', processedAt } };
          // Preserve all unrelated Todo fields. remindedAt is a local reminder
          // claim, not a delivery count, and belongs to the cleared reminder.
          const { waitingOn: _waitingOn, reminderAt: _reminderAt, remindedAt: _remindedAt, ...rest } = todo;
          store.put('todos', todo.id, { ...rest, reminderVersion: (todo.reminderVersion ?? 1) + 1, updatedAt: processedAt });
          save(hit);
          matched.push(hit);
          events.publish('todos.changed', { id: todo.id });
        }
        return { duplicate: false, matched };
      });
    },
  };
}
