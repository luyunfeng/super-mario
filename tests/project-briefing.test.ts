import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/core/src/store.ts';
import { buildWindowBrief, formatWindowBrief } from '../packages/core/src/briefing.ts';
import type { Project, Todo } from '../packages/protocol/src/index.ts';

const from = '2026-01-01T00:00:00Z', to = '2026-01-02T00:00:00Z';
function facts(t: test.TestContext) {
  const store = createStore(':memory:'); t.after(() => store.close());
  for (const id of ['a', 'b']) store.put<Project>('projects', id, { id, name: id, description: '', createdAt: from, updatedAt: to });
  for (const [id, projectId] of [['a-todo', 'a'], ['b-todo', 'b'], ['unassigned', undefined]]) store.put<Todo>('todos', id!, { id: id!, title: id!, projectId, notes: '', createdAt: from, updatedAt: to });
  for (const [id, projectId] of [['a-card', 'a'], ['b-card', 'b'], ['global-card', undefined]]) store.put('interactions', id!, { id, projectId, title: id, status: 'open', createdAt: from });
  store.put('approvals', 'a-approval', { id: 'a-approval', title: 'a-approval', status: 'pending', todoId: 'a-todo', params: {}, createdAt: from });
  store.put('approvals', 'global-approval', { id: 'global-approval', title: 'global-approval', status: 'pending', params: {}, createdAt: from });
  store.put('plans', 'a-plan', { id: 'a-plan', title: 'a-plan', status: 'pending', tasks: [{ projectId: 'a' }], createdAt: from });
  store.put('plans', 'global-plan', { id: 'global-plan', title: 'global-plan', status: 'pending', tasks: [{}], createdAt: from });
  return store;
}

test('optional project filter isolates todos and all decision sources', t => {
  const store = facts(t); const brief = buildWindowBrief(store, from, to, 'a');
  assert.deepEqual(brief.projects.map(p => p.projectId), ['a']);
  assert.deepEqual(brief.projects[0].todoUpdates.map(t => t.id), ['a-todo']);
  assert.deepEqual(brief.projects[0].decisions.map(t => t.id), ['a-card', 'a-approval', 'a-plan']);
  assert.doesNotMatch(JSON.stringify(brief), /b-todo|b-card|global-card|unassigned|global-plan|global-approval/);
});

test('existing global summary keeps unassigned facts; missing or archived project has none', t => {
  const store = facts(t);
  assert.deepEqual(buildWindowBrief(store, from, to).projects.map(p => p.projectId), ['a', 'b', '']);
  assert.equal(buildWindowBrief(store, from, to).projects[2].todoUpdates[0].id, 'unassigned');
  assert.deepEqual(buildWindowBrief(store, from, to, 'missing').projects, []);
  store.put('projects', 'a', { ...store.get<Project>('projects', 'a')!, archivedAt: to });
  assert.deepEqual(buildWindowBrief(store, from, to, 'a').projects, []);
});

test('window bounds and optional overdue formatting preserve existing behavior', t => {
  const store = facts(t);
  assert.throws(() => buildWindowBrief(store, to, from, 'a'), /时间窗/);
  const brief = buildWindowBrief(store, from, to, 'a');
  assert.doesNotMatch(formatWindowBrief(brief, 'morning'), /逾期提醒/);
  assert.match(formatWindowBrief(brief, 'morning'), /^工作台早间简报/);
  assert.match(formatWindowBrief({ ...brief, overdue: [{ id: 'x', title: 'late' }] }, 'project'), /逾期提醒 1：late \[x\]/);
});
