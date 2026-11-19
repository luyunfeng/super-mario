import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Browser module is also a pure projection usable without a DOM.
import { recentWork, RECENT_WORK_MS } from '../apps/web/js/lib/recent-work.js';

test('recent work keeps only confirmed todo completion and successful execution, independent of seen state', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const stamp = (ago: number) => new Date(now - ago).toISOString();
  const snapshot = { todos: [
    { id: 'completed', projectId: 'A', completedAt: stamp(1) },
    { id: 'boundary', completedAt: stamp(RECENT_WORK_MS) },
    { id: 'invalid', completedAt: 'bad' }, { id: 'future', completedAt: stamp(-1) },
    { id: 'reopened' }, { id: 'other', projectId: 'B', completedAt: stamp(2) },
  ], runs: ['completed', 'failed', 'unknown', 'cancelled', 'running'].map(status => ({ id: status, status, projectId: 'A', updatedAt: stamp(3) })) };
  const original = structuredClone(snapshot);
  assert.deepEqual(recentWork(snapshot, 'A', now).map((item: {id: string}) => item.id), ['todo:completed', 'run:completed']);
  assert.equal(recentWork(snapshot, '', now).length, 3);
  assert.deepEqual(recentWork({ ...snapshot, seenRunIds: ['completed'] }, 'A', now), recentWork(snapshot, 'A', now));
  assert.deepEqual(snapshot, original);
  assert.deepEqual(recentWork(snapshot, '', now + RECENT_WORK_MS + 2), []);
});
