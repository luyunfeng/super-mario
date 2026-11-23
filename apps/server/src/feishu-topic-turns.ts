import { feishuTodoSource, type FeishuTodoSource } from './feishu-todo-source.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { Todo } from '../../../packages/protocol/src/index.ts';

export type TopicAudience = { binding: string; grant: string; chatId: string; threadId: string };
type Input = TopicAudience & { messageId: string; root: boolean; command: boolean; words: string };
type Turn = { authorityVersion?: string; sourceOpening?: true; todoId: string; opening: boolean; words: string };
type Receipt = { bindingVersion?: string; topic: string; turn?: Turn; hinted?: boolean };
type Binding = { audience: TopicAudience; version: string; ownerManaged?: true; title?: string };
const openings = 'feishu.topic-owner-openings';
const reverse = 'feishu.todo-topic-bindings', removed = 'feishu.topic-unbindings';
const threads = 'feishu.topic-todos', receipts = 'feishu.topic-turns';

function key(parts: string[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
function topic(a: TopicAudience) {
  const parts = [a.binding, a.grant, a.chatId, a.threadId];
  if (parts.every(s => typeof s === 'string' && s.trim())) return key(parts);
}

export function createTopicTurns(store: Pick<Store, 'get' | 'put' | 'list' | 'transaction'>,
  createTodo: (input: { title: string; notes: string }, source: FeishuTodoSource) => Pick<Todo, 'id'>) {
  function writeReverse(todoId: string, input: TopicAudience, ownerManaged = false, title?: string): Binding {
    const { binding, grant, chatId, threadId } = input;
    const row: Binding = { audience: { binding, grant, chatId, threadId }, version: randomUUID(), ...(ownerManaged && { ownerManaged: true }), ...(title && { title }) };
    store.put(reverse, todoId, row);
    return row;
  }

  function insertBinding(todoId: string, id: string, input: TopicAudience): boolean {
    if (store.get<Binding>(reverse, todoId) || store.list<string | null>(threads).includes(todoId) || store.get(removed, key([todoId, id]))) return false;
    store.put(threads, id, todoId);
    writeReverse(todoId, input);
    return true;
  }

  function bindingFor(todoId: string): Binding | undefined {
    const row = store.get<Binding>(reverse, todoId);
    const id = row?.audience && topic(row.audience);
    if (row?.version && id && store.get(threads, id) === todoId) return row;
  }

  // Older forward records contain only the hash of the audience. Reconstruct the reverse
  // identity only from a matching audience and a unique forward owner.
  function restoreBinding(todoId: string, audience: TopicAudience): Binding | undefined {
    return store.transaction(() => {
      const id = topic(audience);
      if (!id || !todoId || store.get(threads, id) !== todoId
        || store.get<Todo>('todos', todoId)?.id !== todoId) return;
      const old = store.get<Binding>(reverse, todoId);
      if (old) return old.version && old.audience && topic(old.audience) === id ? old : undefined;
      if (store.get(removed, key([todoId, id])) || store.list<string | null>(threads).filter(owner => owner === todoId).length !== 1) return;
      return writeReverse(todoId, audience);
    });
  }

  function hasUnresolvedBinding(todoId: string): boolean {
    return !!store.get(reverse, todoId) || store.list<string | null>(threads).includes(todoId);
  }

  function todoFor(a: TopicAudience) {
    const id = topic(a);
    const todoId = id && store.get<string>(threads, id);
    if (!id || !todoId) return;
    const row = store.get<Binding>(reverse, todoId);
    if (row?.audience && topic(row.audience) === id && row.version) return todoId;
    if (!row && restoreBinding(todoId, a)) return todoId;
  }

  /** The caller supplies the current enrollment grant, including after asynchronous platform calls. */
  function bindHome(input: TopicAudience & { todoId: string }): boolean {
    return store.transaction(() => {
      const id = topic(input), todoId = input.todoId;
      if (!id || !todoId || store.get<Todo>('todos', todoId)?.id !== todoId || store.get(removed, key([todoId, id]))) return false;
      const before = store.get<string>(threads, id);
      if (before) {
        const row = before === todoId && restoreBinding(todoId, input);
        return !!row && !row.ownerManaged;
      }
      return insertBinding(todoId, id, input);
    });
  }

  function unbind(todoId: string, expectedVersion: string): void {
    store.transaction(() => {
      const row = bindingFor(todoId);
      if (!row && !hasUnresolvedBinding(todoId)) return;
      if (!row || row.version !== expectedVersion) throw Object.assign(new Error('待办话题绑定已变化，请刷新后核对。'), {status:409});
      const id = topic(row.audience)!;
      store.put(removed, key([todoId, id]), true);
      store.put(threads, id, null);
      store.put(reverse, todoId, null);
    });
  }

  function bindOwner(todoId: string, audience: TopicAudience, expectedVersion: string | null, title?: string): Binding {
    return store.transaction(() => {
      if (title !== undefined && typeof title !== 'string')
        throw Object.assign(new Error('话题标题必须为文本。'), {status:400});
      const label = title === undefined ? undefined : Array.from(title.trim()).slice(0, 200).join('');
      const id = topic(audience);
      if (!id || (expectedVersion !== null && (typeof expectedVersion !== 'string' || !expectedVersion.trim())))
        throw Object.assign(new Error('需要有效的话题和绑定版本。'), {status:400});
      if (store.get<Todo>('todos', todoId)?.id !== todoId) throw Object.assign(new Error('待办不存在。'), {status:404});
      const occupant = store.get<string>(threads, id);
      if (occupant && occupant !== todoId) throw Object.assign(new Error('这个话题已绑定其他待办。'), {status:409});
      const old = bindingFor(todoId) ?? (occupant === todoId ? restoreBinding(todoId, audience) : undefined);
      const same = old && topic(old.audience) === id;
      if (expectedVersion !== (old?.version ?? null) && !(expectedVersion === null && same))
        throw Object.assign(new Error('待办话题绑定已变化，请刷新后核对。'), {status:409});
      if (same) {
        if (label === undefined || label === (old.title ?? '')) return old;
        const updated = { ...old };
        if (label) updated.title = label;
        else delete updated.title;
        store.put(reverse, todoId, updated);
        return updated;
      }
      if (old) unbind(todoId, old.version);
      if (hasUnresolvedBinding(todoId))
        throw Object.assign(new Error('待办原有话题归属待核对。'), {status:409});
      store.put(threads, id, todoId);
      return writeReverse(todoId, audience, true, label);
    });
  }

  function accept(input: Input): Turn | undefined {
    return store.transaction(() => {
      const id = topic(input);
      if (!id || !input.messageId?.trim()) return;
      // Message IDs stay consumed when the same owner removes and re-enrolls the group.
      // The enrollment grant and thread still have to match before a stored turn can be resumed.
      const event = key([input.binding, input.chatId, input.messageId]);
      const old = store.get<Receipt>(receipts, event);
      let todoId = todoFor(input);
      if (!todoId && store.get(threads, id)) return; // Ambiguous legacy ownership must not create a replacement task.
      let binding = todoId ? bindingFor(todoId) : undefined;
      if (old && (old.topic !== id || !old.turn || old.turn.todoId !== todoId || !binding
        || (old.bindingVersion ? old.bindingVersion !== binding.version : binding.ownerManaged || store.get(removed, key([todoId!, id]))))) return;
      if (todoId) {
        const todo = store.get<Todo>('todos', todoId);
        if (!todo || todo.completedAt) {
          store.put(receipts, event, { topic: id, ...(old && { hinted: true }) } satisfies Receipt);
          return;
        }
      }
      if (old) return old.turn;
      const words = input.words.trim(), opening = !todoId;
      if (!words.replace(/\[(?:图片|视频)\]/gu, '').trim() || (opening && !input.root && !input.command)) {
        store.put(receipts, event, { topic: id } satisfies Receipt);
        return;
      }
      if (!todoId) {
        const chars = Array.from(words);
        const todo = createTodo({ title: Array.from(words.replace(/\s+/gu, ' ')).slice(0, 80).join(''),
          notes: chars.slice(0, 4000).join('') }, feishuTodoSource(input.binding, input.chatId, input.messageId, words));
        if (!todo.id) throw new Error('创建话题待办时未取得待办 ID');
        todoId = todo.id;
        if (!insertBinding(todoId, id, input)) throw new Error('话题或待办已绑定，无法开题');
      }
      binding ??= bindingFor(todoId);
      if (!binding) throw new Error('缺少话题绑定版本');
      const turn: Turn = { todoId, opening, words };
      if (binding.ownerManaged) {
        turn.authorityVersion = binding.version;
        if (!store.get(openings, binding.version)) {
          turn.sourceOpening = true;
          store.put(openings, binding.version, true);
        }
      }
      store.put(receipts, event, { topic: id, turn, bindingVersion: binding.version } satisfies Receipt);
      return turn;
    });
  }
  function hint(a: TopicAudience, messageId: string, explicit: boolean, empty: boolean) {
    const id = topic(a), event = key([a.binding, a.chatId, messageId]);
    return store.transaction(() => {
      const receipt = store.get<Receipt>(receipts, event);
      if (!id || !receipt || receipt.topic !== id || receipt.turn || receipt.hinted) return;
      store.put(receipts, event, { ...receipt, hinted: true });
      const todo = todoFor(a), done = todo && store.get<Todo>('todos', todo)?.completedAt;
      if (todo && !done) return;
      const now = Date.now(), previous = store.get<number>('feishu.topic-hints', id);
      if (!explicit && previous !== undefined && now - previous < 600_000) return;
      store.put('feishu.topic-hints', id, now);
      if (done) return '这个话题的待办已完成。要继续办理，可在 Web 重新打开待办。';
      return explicit && empty ? '请在 /ai 后写下要办理的任务。' : '这个话题还没有待办。请发送 /ai 加任务说明。';
    });
  }
  return { accept, bindHome, bindOwner, todoFor, hint, bindingFor, restoreBinding, hasUnresolvedBinding, unbind };
}
