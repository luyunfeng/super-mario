import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/core/src/store.ts';
import { createProjectLessonLearner } from '../packages/core/src/project-lesson-learner.ts';

type Listener = (event: { type: string; data?: unknown }) => void;

function fixture(t: { after(fn: () => void): void }, options: { demo?: boolean } = {}) {
  const store = createStore(':memory:');
  const listeners = new Set<Listener>();
  const calls: { text: string; aborted: boolean }[] = [];
  let reply: string | Error = '{"lessons":[]}';
  const publish = (type: string, data: unknown) => { for (const listener of listeners) listener({ type, data }); };
  const learner = createProjectLessonLearner({
    store, demo: options.demo ?? false,
    events: { subscribe(listener: Listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    async ask(text, signal) {
      calls.push({ text, aborted: signal.aborted });
      if (reply instanceof Error) throw reply;
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); setTimeout(resolve, 5); });
      signal.throwIfAborted();
      return reply;
    },
  });
  const accepted = (todoId: string, status = 'accepted') => {
    store.put('todos', todoId, { id: todoId, title: '任务 ' + todoId, projectId: 'p', completed: true });
    store.put('runs', 'run-' + todoId, { id: 'run-' + todoId, prompt: '修好登录', output: '已修复', progress: { recentSteps: ['读代码', '改测试'] } });
    store.put('run-reviews', todoId, { status, runId: 'run-' + todoId, evidenceVersion: 'ev1', doneWhen: '能登录', round: 1 });
  };
  t.after(async () => { await learner.close(); store.close(); });
  return { store, learner, publish, calls, accepted, reply: (value: string | Error) => { reply = value; } };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('验收通过才提炼，并把模型的条目记入待办所属项目', async t => {
  const { learner, publish, calls, accepted, reply } = fixture(t);
  accepted('t1');
  reply('{"lessons":[{"kind":"missing_context","text":"先确认数据口径"}]}');
  publish('run-review.changed', { todoId: 't1' });
  await settle();
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /修好登录/);
  assert.match(calls[0]!.text, /能登录/);
  const [lesson] = learner.list('p');
  assert.equal(lesson.text, '先确认数据口径');
  assert.equal(lesson.sources[0]!.todoId, 't1');
});

test('返工和重开不提炼，未通过验收的待办不调用模型', async t => {
  const { learner, publish, calls, accepted } = fixture(t);
  accepted('t1', 'rework');
  publish('run-review.changed', { todoId: 't1' });
  await settle();
  assert.equal(calls.length, 0);
  assert.deepEqual(learner.list('p'), []);
});

test('模型回复不合法时不入库，也不抛出', async t => {
  const { learner, publish, calls, accepted, reply } = fixture(t);
  accepted('t1');
  reply('这不是 JSON');
  publish('run-review.changed', { todoId: 't1' });
  await settle();
  assert.equal(calls.length, 1);
  assert.deepEqual(learner.list('p'), []);
});

test('模型失败不影响验收记录，也不重试', async t => {
  const { store, learner, publish, calls, accepted, reply } = fixture(t);
  accepted('t1');
  reply(new Error('模型不可用'));
  publish('run-review.changed', { todoId: 't1' });
  await settle();
  assert.equal(calls.length, 1);
  assert.deepEqual(learner.list('p'), []);
  assert.equal(store.get<{ status: string }>('run-reviews', 't1')!.status, 'accepted');
});

test('同一待办在提炼中收到第二次事件，不重复提炼也不重复入库', async t => {
  const { learner, publish, calls, accepted, reply } = fixture(t);
  accepted('t1');
  reply('{"lessons":[{"kind":"improvement","text":"先写验收标准"}]}');
  publish('run-review.changed', { todoId: 't1' });
  publish('run-review.changed', { todoId: 't1' });
  await settle();
  // Both events report the same acceptance, so the model is asked once.
  assert.equal(calls.length, 1);
  assert.equal(learner.list('p').length, 1);
});

test('模型的 sameAs 指向已有经验时累加来源', async t => {
  const { learner, publish, accepted, reply } = fixture(t);
  accepted('t1');
  reply('{"lessons":[{"kind":"improvement","text":"先写验收标准"}]}');
  publish('run-review.changed', { todoId: 't1' });
  await settle();
  const [lesson] = learner.list('p');
  accepted('t2');
  reply(JSON.stringify({ lessons: [{ kind: 'improvement', text: '换个说法', sameAs: lesson.id }] }));
  publish('run-review.changed', { todoId: 't2' });
  await settle();
  const [again] = learner.list('p');
  assert.equal(again.id, lesson.id);
  assert.equal(again.seen, 2);
  assert.equal(again.text, '先写验收标准', 'the first wording is kept');
});

test('演示模式不调用模型', async t => {
  const { learner, publish, calls, accepted } = fixture(t, { demo: true });
  accepted('t1');
  publish('run-review.changed', { todoId: 't1' });
  await settle();
  assert.equal(calls.length, 0);
  assert.deepEqual(learner.list('p'), []);
});

test('关闭时中止进行中的模型调用并等待它结束', async t => {
  const { learner, publish, calls, accepted, reply } = fixture(t);
  accepted('t1');
  reply('{"lessons":[{"kind":"improvement","text":"不应入库"}]}');
  publish('run-review.changed', { todoId: 't1' });
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(calls.length, 1);
  await learner.close();
  assert.deepEqual(learner.list('p'), [], 'an aborted call records nothing');
});
