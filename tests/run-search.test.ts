import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Native browser module with no TypeScript declaration.
import { searchRunHits } from '../apps/web/js/features/run-search.js';

test('search applies run dimensions to current snapshot facts, including repeated alternatives and time windows', () => {
  const now = Date.UTC(2026, 3, 8);
  const snapshot = {
    projects: [{ id: 'p', name: '月报' }], machines: [{ id: 'm', name: '工作站' }],
    executors: [{ id: 'e', name: 'Sample CLI' }],
    runs: [
      { id: 'active', projectId: 'p', machineId: 'm', executorId: 'e', status: 'running', prompt: '分析', output: '表格', updatedAt: '2026-04-01T00:00:00Z' },
      { id: 'old', projectId: 'p', machineId: 'm', executorId: 'e', status: 'failed', error: 'HTTP:503', updatedAt: '2026-03-31T23:59:59Z' },
      { id: 'other', projectId: 'q', status: 'running', prompt: '分析' },
    ],
  };
  const ids = (query: string) => searchRunHits(query, snapshot, now).map((hit: {run: {id: string}}) => hit.run.id);
  assert.deepEqual(ids('project:月报 host:工作 agent:SAMPLE status:working since:7d 分析 表格'), ['active']);
  assert.deepEqual(ids('state:failed state:running project:p'), ['active', 'old']);
  assert.deepEqual(ids('http:503'), ['old']);
  snapshot.runs[0]!.status = 'completed';
  assert.deepEqual(ids('state:running machine:m'), []);
});

test('title, project and evidence hits rank in order and keep literal branch and error excerpts', () => {
  const runs = [
    { id: 'branch', prompt: '甲', worktree: { branch: 'topic/ABC[1]' }, error: '需要复核' },
    { id: 'place', prompt: '乙', projectId: 'project' },
    { id: 'contains', prompt: '查 abc[1]' },
    { id: 'starts', prompt: 'ABC[1] 清单' },
  ];
  const snapshot = { runs, projects: [{ id: 'project', name: 'abc[1]' }] };
  const hits = searchRunHits('abc[1]', snapshot);
  assert.deepEqual(hits.map((hit: {run: {id: string}}) => hit.run.id), ['starts', 'contains', 'place', 'branch']);
  assert.equal(hits[3].excerpt, '分支 · topic/ABC[1]');
  const combined = searchRunHits('复核 abc[1]', snapshot);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].excerpt, '错误 · 需要复核');
});
