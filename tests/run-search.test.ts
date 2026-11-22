import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Native browser module with no TypeScript declaration.
import { searchRuns } from '../apps/web/js/features/run-search.js';

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
  const ids = (query: string) => searchRuns(query, snapshot, now).map((run: {id: string}) => run.id);
  assert.deepEqual(ids('project:月报 host:工作 agent:SAMPLE status:working since:7d 分析 表格'), ['active']);
  assert.deepEqual(ids('state:failed state:running project:p'), ['active', 'old']);
  assert.deepEqual(ids('http:503'), ['old']);
  snapshot.runs[0]!.status = 'completed';
  assert.deepEqual(ids('state:running machine:m'), []);
});
