import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../packages/core/src/store.ts';
import { readTodoHistory } from '../packages/core/src/todo-history.ts';
import type { Run, Todo } from '../packages/protocol/src/index.ts';

test('todo history pages real stored attempts and review decisions without writing or crossing ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-todo-history-')), db = join(dir, 'test.sqlite');
  let store = createStore(db);
  try {
    const stamp = '2026-11-19T00:00:00Z';
    const todo: Todo = { id: 'task', projectId: 'A', title: '核对交付', notes: '', createdAt: stamp, updatedAt: stamp };
    store.put('todos', todo.id, todo);
    for (let i = 0; i < 23; i++) {
      const run: Run = { id: `r${i.toString().padStart(2,'0')}`, todoId: todo.id, projectId: 'A', executorId: 'fixture', conversationId: 'main', prompt: '第' + i + '次执行', output: 'x'.repeat(4100), status: i === 21 ? 'failed' : 'completed', createdAt: new Date(Date.parse(stamp) + i * 1000).toISOString(), updatedAt: stamp };
      store.put('runs', run.id, run);
    }
    const run = store.get<Run>('runs', 'r22')!;
    store.put('runs', 'foreign', { ...run, id: 'foreign', projectId: 'B', output: 'SECRET' });
    store.put('runs', 'other-todo', { ...run, id: 'other-todo', todoId: 'other', output: 'SECRET' });
    store.put('run-review.intents', 'rework', { request: { todoId: 'task', runId: 'r21', action: 'rework', defects: '补充失败依据' }, result: { updatedAt: stamp } });
    for (const [requestRun, status, resultRun] of [
      ['r03', 'pending', 'r22'], ['r04', 'unknown', 'r22'], ['r05', 'dispatching', 'r05'],
      ['r06', 'pending', 'foreign'], ['r07', 'pending', 'other-todo'], ['r08', 'pending', 'r08'],
    ] as const) {
      store.put('run-review.intents', requestRun, { request: { todoId: 'task', runId: requestRun, action: 'rework' },
        result: { todoId: 'task', updatedAt: stamp, status, runId: resultRun } });
    }
    const card = { runId: 'r22', projectId: 'A', title: '核对答复', status: 'answered', answeredAt: stamp, kind: 'question' };
    for (const delivery of ['confirmed', 'failed', 'unknown']) store.put('interactions', delivery, { ...card, id: delivery, delivery });
    store.put('interactions', 'local', { ...card, id: 'local', kind: 'review', delivery: 'confirmed' });
    store.put('interactions', 'legacy', { ...card, id: 'legacy' });
    store.put('interactions', 'other', { ...card, id: 'other', projectId: 'B', title: 'SECRET' });
    store.put('interactions', 'open', { ...card, id: 'open', status: 'open', title: 'SECRET' });
    const before = JSON.stringify([store.list('todos'), store.list('runs'), store.list('run-review.intents')]);
    const first = readTodoHistory(store, 'task');
    assert.equal(first.total, 23); assert.equal(first.rounds.length, 20);
    assert.deepEqual(first.rounds.map(r => r.number), Array.from({length:20}, (_,i)=>23-i));
    assert.deepEqual(first.rounds[0]!.answerReceipts.map(r => [r.cardId, r.target, r.delivery]), [
      ['confirmed','executor','confirmed'], ['failed','executor','failed'], ['legacy','executor','unknown'],
      ['local','workbench','confirmed'], ['unknown','executor','unknown']]);
    assert.equal(first.rounds[0]!.run.output.length,4000); assert.equal(first.rounds[0]!.outputTruncated,true);
    assert.equal(first.rounds[1]!.decisions[0]!.defects,'补充失败依据');
    const decision = (runId: string) => first.rounds.find(round => round.run.id === runId)!.decisions[0]!;
    assert.equal(decision('r03').reworkRunId, 'r22');
    assert.equal(decision('r04').dispatchStatus, 'unknown');
    assert.equal(decision('r05').dispatchStatus, 'dispatching');
    for (const id of ['r04', 'r05', 'r06', 'r07', 'r08', 'r21']) assert.equal(decision(id).reworkRunId, undefined);
    assert.doesNotMatch(JSON.stringify(first), /SECRET/);
    store.put('runs', 'new-run', { ...run, id:'new-run', createdAt:'2026-11-20T00:00:00Z' });
    const older = readTodoHistory(store, 'task', first.nextBefore);
    assert.deepEqual(older.rounds.map(r=>r.number),[3,2,1]); assert.equal(older.nextBefore,undefined);
    store.remove('runs','new-run');
    assert.equal(JSON.stringify([store.list('todos'),store.list('runs'),store.list('run-review.intents')]),before);
    assert.throws(()=>readTodoHistory(store,'missing'),(e: any)=>e.status===404);
    assert.throws(()=>readTodoHistory(store,'task','foreign'),(e: any)=>e.status===400);
    store.close(); store=createStore(db);
    assert.deepEqual(readTodoHistory(store,'task'), first);
    store.put('todos','task',{...todo,projectId:'B'});
    const moved=readTodoHistory(store,'task'); assert.equal(moved.total,1); assert.equal(moved.rounds[0]!.run.id,'foreign');
  } finally { store.close(); await rm(dir,{recursive:true,force:true}); }
});
