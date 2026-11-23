import assert from 'node:assert/strict';
import test from 'node:test';
import { createTopicCompletions } from '../apps/server/src/feishu-topic-completions.ts';
import { createStore } from '../packages/core/src/store.ts';

const first = '2026-01-01T12:00:00.000Z', second = '2026-01-02T12:00:00.000Z';
test('直接话题只收到固定完成通知，旧数据、项目、转入群任务和无路由待办不补发', async t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  const todo = { id: 'registered', notes: '合成私聊内容', groupTaskOutcome: '合成内部结论' };
  store.put('todos', 'old', { id: 'old', completedAt: first });
  const sends: string[][] = [];
  const options = { resolve(id: string) { return id === 'unbound' ? undefined : { inputId: 'source-' + id }; },
    async send(id: string, input: string, text: string, key: string, guard: () => void) {
      guard(); sends.push([id, input, text, key]); return 'om_' + sends.length;
    } };
  const service = createTopicCompletions(store, options);
  for (const [id, extra] of [['old', {}], ['project', {projectId:'p'}], ['forwarded', {groupTask:true}], ['unbound', {}]] as const) {
    store.put('todos', id, { ...todo, id, completedAt: first, ...extra });
    await service.changed(id);
  }
  assert.equal(sends.length, 0);
  store.put('todos', todo.id, { ...todo, completedAt: first });
  await Promise.all([service.changed(todo.id), service.changed(todo.id)]);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0]!.slice(0, 3), [todo.id, 'source-registered', '这项待办已完成。']);
  await service.close();
  const reloaded = createTopicCompletions(store, options);
  await reloaded.changed(todo.id);
  store.put('todos', todo.id, todo); await reloaded.changed(todo.id);
  store.put('todos', todo.id, { ...todo, completedAt: first }); await reloaded.changed(todo.id);
  assert.equal(sends.length, 1);
  store.put('todos', todo.id, { ...todo, completedAt: second });
  await reloaded.changed(todo.id); await reloaded.close();
  assert.equal(sends.length, 2); assert.notEqual(sends[0]![3], sends[1]![3]);
});

test('外发前复核原锚点与完成代次，未知结果保留，关闭等待已启动的发送', async t => {
  for (const scenario of ['anchor', 'reopen', 'cycle', 'project', 'network', 'empty-id', 'closed']) {
    await t.test(scenario, async t => {
      const store = createStore(':memory:'); t.after(() => store.close());
      let anchor = 'original', attempts = 0, started!: () => void, resume!: () => void;
      const ready = new Promise<void>(r => { started = r; }), paused = new Promise<void>(r => { resume = r; });
      const service = createTopicCompletions(store, { resolve: () => ({ inputId: anchor }),
        async send(_id, _input, _text, _key, guard) {
          started(); await paused; guard();
          attempts++;
          if (scenario === 'network') throw new Error('网络中断');
          return '';
        } });
      const id = 't'; store.put('todos', id, { id, completedAt: first });
      const job = service.changed(id); await ready;
      if (scenario === 'anchor') anchor = 'new';
      if (scenario === 'reopen') store.put('todos', id, { id });
      if (scenario === 'cycle') store.put('todos', id, { id, completedAt: second });
      if (scenario === 'project') store.put('todos', id, { id, completedAt: first, projectId: 'p' });
      let drained = false;
      const closing = scenario === 'closed' ? service.close().then(() => { drained = true; }) : undefined;
      await Promise.resolve(); assert.equal(drained, false);
      resume(); await job; await closing;
      const uncertain = scenario === 'network' || scenario === 'empty-id';
      assert.equal(attempts, uncertain ? 1 : 0);
      assert.equal(store.list<{delivery:string}>('feishu.topic-completions')[0]?.delivery, uncertain ? 'unknown' : 'failed');
      if (uncertain) { await service.changed(id); assert.equal(attempts, 1); }
      await service.close();
    });
  }
});
