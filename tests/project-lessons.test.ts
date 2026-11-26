import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/core/src/store.ts';
import { createProjectLessons } from '../packages/core/src/project-lessons.ts';

const day = 24 * 60 * 60 * 1000;
const start = Date.parse('2030-01-01T00:00:00Z');
const source = (todoId: string) => ({ todoId, title: '任务 ' + todoId });

function fixture(t: { after(fn: () => void): void }) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  let at = start;
  const lessons = createProjectLessons(store, () => at);
  return { store, lessons, advance: (ms: number) => { at += ms; } };
}

test('验收后记经验：重复的累加来源并保留主人改过的措辞，已删除的不复活，不跨项目', t => {
  const { lessons, advance } = fixture(t);
  const first = lessons.learn('p', source('t1'), [
    { kind: 'missing_context', text: '先确认数据口径再写查询' },
    { kind: 'wasted_step', text: '' },
    { kind: 'improvement' as const, text: 'x'.repeat(601) },
  ]);
  assert.equal(first.length, 1, 'empty and over-long drafts are not recorded');
  assert.equal(first[0]!.seen, 1);
  assert.equal(first[0]!.sources[0]!.todoId, 't1');

  // The owner rewrites it. Later rounds keep the owner's wording.
  const edited = lessons.edit('p', first[0]!.id, '  先和主人确认数据口径  ', first[0]!.version);
  assert.equal(edited.text, '先和主人确认数据口径');
  assert.equal(edited.edited, true);
  assert.throws(() => lessons.edit('p', edited.id, '旧版本', first[0]!.version), /已有新版本/);

  // A later task teaches the same thing. It adds a source and keeps the owner's words.
  advance(day);
  const [again] = lessons.learn('p', source('t2'), [{ kind: 'missing_context', text: '换个说法', sameAs: edited.id }]);
  assert.equal(again.seen, 2);
  assert.equal(again.text, '先和主人确认数据口径', 'the owner\'s wording survives');
  assert.deepEqual(again.sources.map(item => item.todoId), ['t2', 't1'], 'newest source first');

  // An id that is not a live lesson of this project is dropped, never created anew.
  const other = lessons.learn('p', source('t3'), [{ kind: 'improvement', text: '无关内容', sameAs: 'not-a-lesson' }]);
  assert.deepEqual(other, []);
  assert.equal(lessons.list('p').length, 1);

  // Another project sees nothing and cannot edit this one.
  assert.deepEqual(lessons.list('q'), []);
  assert.throws(() => lessons.edit('q', edited.id, '越权', again.version), /经验不存在/);
  assert.throws(() => lessons.remove('q', edited.id, again.version), /经验不存在/);
});

test('删除后不再交给新 Agent，同一件事换了说法也不会被重新记下', t => {
  const { lessons } = fixture(t);
  const [item] = lessons.learn('p', source('t1'), [{ kind: 'repeated_mistake', text: '不要跳过集成测试' }]);
  assert.match(lessons.instructions('p'), /不要跳过集成测试/);
  lessons.remove('p', item.id, item.version);
  assert.equal(lessons.instructions('p'), '');
  assert.deepEqual(lessons.list('p'), []);
  // Pointing at the deleted id does not bring it back.
  assert.deepEqual(lessons.learn('p', source('t2'), [{ kind: 'repeated_mistake', text: '不要跳过集成测试', sameAs: item.id }]), []);
  assert.equal(lessons.list('p').length, 0);
});

test('九十天没有再出现的经验不再交给新 Agent，但仍在列表里可见', t => {
  const { lessons, advance } = fixture(t);
  lessons.learn('p', source('t1'), [{ kind: 'improvement', text: '先写验收标准再动手' }]);
  advance(89 * day);
  assert.equal(lessons.list('p')[0]!.stale, false);
  assert.match(lessons.instructions('p'), /先写验收标准再动手/);
  advance(2 * day);
  assert.equal(lessons.list('p')[0]!.stale, true, 'still listed, so the owner can read and delete it');
  assert.equal(lessons.instructions('p'), '', 'no longer handed to new Agents');
  // Being taught again makes it current.
  const [again] = lessons.learn('p', source('t2'), [{ kind: 'improvement', text: 'x', sameAs: lessons.list('p')[0]!.id }]);
  assert.equal(again.stale, false);
  assert.match(lessons.instructions('p'), /先写验收标准再动手/);
});

test('已删除的经验在重启后仍然记得', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const first = createProjectLessons(store, () => start);
  const [item] = first.learn('p', source('t1'), [{ kind: 'wasted_step', text: '不要重复下载依赖' }]);
  first.remove('p', item.id, item.version);
  const reopened = createProjectLessons(store, () => start);
  assert.deepEqual(reopened.learn('p', source('t2'), [{ kind: 'wasted_step', text: '不要重复下载依赖', sameAs: item.id }]), []);
  assert.deepEqual(reopened.list('p'), []);
});
