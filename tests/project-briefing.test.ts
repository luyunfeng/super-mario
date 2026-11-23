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
  assert.deepEqual(brief.projects[0].decisions.map(t => t.href), ['#chat?interaction=a-card', '#chat?approval=a-approval', '#chat?plan=a-plan']);
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
  assert.match(formatWindowBrief({ ...brief, overdue: [{ id: 'x', title: 'late' }] }, 'project'), /逾期待办 1：late/);
});

test('早报按计划时刻区分逾期和当地当天剩余期限，覆盖夏令时回拨与长期未更新事项', t => {
  const store = facts(t);
  const scheduled = '2026-11-01T06:30:00Z', zone = 'America/New_York';
  const add = (id: string, dueAt: string, extra: Partial<Todo> = {}) =>
    store.put<Todo>('todos', id, { id, projectId: 'a', title: id, notes: '', dueAt, createdAt: from, updatedAt: from, ...extra });
  add('first-0130', '2026-11-01T05:30:00Z');
  add('second-0130', scheduled);
  add('late-today', '2026-11-02T04:59:59Z');
  add('tomorrow', '2026-11-02T05:00:00Z');
  add('done', scheduled, { completedAt: from });
  add('future-created', scheduled, { createdAt: '2026-11-02T05:00:00Z' });
  add('other-project', scheduled, { projectId: 'b' });
  add('invalid-date', 'invalid');
  const start = '2026-10-31T16:00:00Z';
  const brief = buildWindowBrief(store, start, scheduled, 'a', [], zone);
  assert.deepEqual(brief.projects[0].overdue?.map(item => item.id), ['first-0130']);
  assert.deepEqual(brief.projects[0].dueToday?.map(item => item.id), ['second-0130', 'late-today']);
  assert.deepEqual(brief.projects[0].todoUpdates, []);
  const text = formatWindowBrief(brief, 'morning', zone);
  assert.match(text, /今日到期 2：second-0130（11\/01 01:30）；late-today（11\/01 23:59）/);
  assert.doesNotMatch(text, /tomorrow|other-project|future-created|invalid-date/);
  assert.equal(buildWindowBrief(store, start, scheduled, 'a').projects[0].overdue, undefined);
});

test('全天待办按早报当地日期判断逾期，保留登记日期', t => {
  const store = facts(t);
  for (const [id, day, offset] of [['today', '2026-01-02', '+14:00'], ['yesterday', '2026-01-01', '-12:00']]) {
    store.put('todos', id, {id, title:id, projectId:'a', dueDay:day, dueAt:day + 'T23:59:59.999' + offset, createdAt:from, updatedAt:from});
  }
  const [project] = buildWindowBrief(store, from, '2026-01-02T11:00:00Z', 'a', [], 'UTC').projects;
  assert.deepEqual(project.overdue?.map(item => item.id), ['yesterday']);
  assert.deepEqual(project.dueToday?.map(item => item.id), ['today']);
});

test('低干扰保留通知按事件时间与项目归入简报，旧记录使用原事件', t => {
  const store=facts(t);
  for (const [id,projectId,time] of [['one','a',to],['other','b',to],['edge','a',from]]) {
    store.put('eventbox.events',id,{createdAt:time});
    store.put('notifications.away','away:'+id,{id:'away:'+id,projectId,status:'held',text:'合成通知 '+id});
  }
  const brief=buildWindowBrief(store,from,to,'a');
  assert.deepEqual(brief.projects[0].heldNotifications,[{id:'away:one',title:'合成通知 one'}]);
  assert.match(formatWindowBrief(brief,'project'),/低干扰保留通知 1：合成通知 one/);
  store.put('notifications.away','away:one',{id:'away:one',runId:'r',projectId:'a',createdAt:to,status:'held',text:'执行结果'});
  store.put('runs','r',{id:'r',projectId:'a',status:'running',updatedAt:from});
  const read=()=>buildWindowBrief(store,from,to,'a').projects[0].heldNotifications[0];
  assert.equal(read().href,'#projects/a/runs/r');
  store.put('runs','r',{id:'r',projectId:'b',status:'running',updatedAt:from});
  assert.equal(read().href,undefined);
});
