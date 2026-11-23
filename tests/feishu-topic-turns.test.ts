import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTopicTurns, type TopicAudience } from '../apps/server/src/feishu-topic-turns.ts';
import { createStore } from '../packages/core/src/store.ts';

const a: TopicAudience = { binding: 'paired', grant: 'enrollment-one', chatId: 'chat-one', threadId: 'topic-one' };
const message = { ...a, messageId: 'message-one', root: false, command: false, words: '合成发言' };
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'topic-turns-')), path = join(dir, 'offline.db');
  const store = createStore(path);
  const host = (db: typeof store) => createTopicTurns(db, input => {
    const todo = { id: 'todo-' + db.list('todos').length, ...input };
    db.put('todos', todo.id, todo);
    return todo;
  });
  const reopened = createStore(path);
  t.after(() => { store.close(); reopened.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, turns: host(store), other: host(reopened) };
}

test('未绑定的话题仅在根消息或 /ai 建办；重复输入恢复首次文字，普通跟进沿用原任务', t => {
  const { store, turns, other } = fixture(t);
  assert.equal(turns.accept(message), undefined);
  assert.equal(turns.accept({ ...message, root: true }), undefined);
  assert.equal(turns.accept({ ...message, messageId: 'image', root: true, words: '[图片]\n[视频]' }), undefined);
  const root = { ...message, messageId: 'root', root: true, words: '  任务第一行\n任务第二行  ' };
  const turn = turns.accept(root);
  assert.deepEqual(turn, { todoId: 'todo-0', opening: true, words: '任务第一行\n任务第二行' });
  assert.deepEqual(other.accept({ ...root, words: '篡改后的重放' }), turn);
  const follow = { ...message, messageId: 'follow' };
  assert.deepEqual(other.accept(follow), { todoId: 'todo-0', opening: false, words: '合成发言' });
  assert.deepEqual(turns.accept({ ...follow, command: true, words: '另一条命令' }), other.accept(follow));
  assert.equal(turns.accept({ ...follow, threadId: 'other', root: true }), undefined);
  assert.equal(store.list('todos').length, 1);
  assert.deepEqual(store.get('todos', 'todo-0'), { id: 'todo-0', title: '任务第一行 任务第二行', notes: '任务第一行\n任务第二行' });
  assert.equal(turns.accept({ ...message, threadId: 'other', command: true, messageId: 'command' })?.opening, true);
});

test('重新登记旧话题不会继承旧待办，相同事件不在新登记下重建', t => {
  const { store, turns } = fixture(t);
  const old = turns.accept({ ...message, root: true })!;
  const again = { ...message, grant: 'enrollment-two' };
  assert.equal(turns.todoFor(again), undefined);
  assert.equal(turns.accept({ ...again, root: true }), undefined);
  assert.equal(turns.accept({ ...again, messageId: 'new-follow' }), undefined);
  const next = turns.accept({ ...again, messageId: 'new-root', command: true })!;
  assert.notEqual(next.todoId, old.todoId);
  store.put('todos', next.todoId, { id: next.todoId, completedAt: '2026-01-01T00:00:00Z' });
  assert.equal(turns.accept({ ...again, messageId: 'closed', command: true }), undefined);
  assert.equal(store.list('todos').length, 2);
});

test('主群新话题可幂等绑定已存在待办，冲突或丢失的待办不会被重新创建', t => {
  const { store, turns, other } = fixture(t);
  assert.equal(turns.bindHome({ ...a, todoId: 'missing' }), false);
  store.put('todos', 'from-group', { id: 'from-group' });
  store.put('todos', 'another', { id: 'another' });
  assert.equal(turns.bindHome({ ...a, todoId: 'from-group' }), true);
  assert.equal(other.bindHome({ ...a, todoId: 'from-group' }), true);
  assert.equal(other.bindHome({ ...a, todoId: 'another' }), false);
  assert.deepEqual(turns.accept(message), { opening: false, todoId: 'from-group', words: message.words });
  store.remove('todos', 'from-group');
  assert.equal(turns.accept({ ...message, root: true, messageId: 'deleted' }), undefined);
  assert.equal(store.list('todos').length, 1);
});

test('未绑定和已结待办回复用法；相同消息不重复提示，普通跟进共用冷却期', t => {
  const { store, turns, other } = fixture(t);
  const notice = (id: string, command: boolean) => {
    other.accept({ ...message, messageId: id, command, words: command ? '' : '继续' });
    return turns.hint(a, id, command, command);
  };
  assert.match(notice('first', false)!, /还没有待办/);
  assert.equal(notice('second', false), undefined);
  assert.match(notice('empty', true)!, /写下/);
  assert.equal(notice('empty', true), undefined);
  const opened = turns.accept({ ...message, messageId: 'opened', root: true })!;
  store.put('todos', opened.todoId, { id: opened.todoId, completedAt: '2026-01-01T00:00:00Z' });
  assert.equal(notice('opened', false), undefined);
  assert.match(notice('finished', true)!, /已完成/);
  assert.equal(store.list('todos').length, 1);
});
