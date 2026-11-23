import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjects } from '../packages/core/src/projects.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { todoSections, todoDecisionIds } from '../packages/core/src/todo-sections.ts';
import type { Todo } from '../packages/protocol/src/index.ts';

test('server todo sections are exclusive, preserve todos, and do not invent needs-you facts', () => {
  const now = new Date(2026, 10, 16, 12);
  const day = (delta: number) => new Date(2026, 10, 16 + delta, 9).toISOString();
  const make = (id: string, extra: Partial<Todo> = {}): Todo => ({ id, title: id, notes: '', createdAt: day(-3), updatedAt: day(0), ...extra });
  const todos = [make('late', { dueAt: day(-1), waitingOn: '同事' }), make('today', { dueAt: day(0) }), make('waiting', { waitingOn: '同事' }), make('later', { dueAt: day(2) }), make('someday'), make('recent', { completedAt: day(0), dueAt: day(-2) }), make('done', { completedAt: day(-2) })];
  const before = structuredClone(todos); const sections = todoSections(todos, now);
  assert.deepEqual(Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.map(t => t.id)])), { '需要你': [], '逾期': ['late'], '今天': ['today'], '等待中': ['waiting'], '之后': ['later'], '某天': ['someday'], '刚完成': ['recent'], '已完成': ['done'] });
  assert.equal(Object.values(sections).flat().length, todos.length);
  assert.deepEqual(todos, before);
  const allDay = todoSections([
    make('today-abroad', { dueDay: '2026-11-16', dueAt: day(1) }),
    make('yesterday-abroad', { dueDay: '2026-11-15', dueAt: day(0) }),
  ], now);
  assert.equal(allDay['今天'][0]?.id, 'today-abroad');
  assert.equal(allDay['逾期'][0]?.id, 'yesterday-abroad');
  assert.throws(() => todoSections([], new Date('invalid')), /时间无效/);
});

test('project follow-up settings validate and persist without allowing memoryEnabled PATCH', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-project-settings-')); const db = join(dataDir, 'db.sqlite');
  let store = createStore(db);
  try {
    const projects = createProjects({ store, events: createEventBus(store) });
    const preference = { briefingTime: '09:30', overdueReminders: true, automation: 'inherit' as const };
    const project = projects.create({ name: ' 项目 ', description: ' 目标 ', memoryEnabled: false, followUp: preference });
    preference.briefingTime = '10:00';
    assert.equal(projects.list()[0].followUp?.briefingTime, '09:30');
    projects.update(project.id, { followUp: { briefingTime: '23:59', overdueReminders: false, automation: 'quiet' } });
    for (const followUp of [null, {}, { ...preference, briefingTime: '24:00' }, { ...preference, briefingTime: '9:00' }, { ...preference, overdueReminders: 'yes' }, { ...preference, automation: 'auto' }, { ...preference, unexpected: true }]) {
      assert.throws(() => projects.update(project.id, { followUp } as never), error => (error as { status: number }).status === 400);
    }
    assert.throws(() => projects.update(project.id, { memoryEnabled: true }), /未知项目字段/);
    assert.equal(projects.list()[0].memoryEnabled, false);
    store.close(); store = createStore(db);
    const persisted = createProjects({ store, events: createEventBus(store) }).list()[0];
    assert.deepEqual(persisted.followUp, { briefingTime: '23:59', overdueReminders: false, automation: 'quiet' });
  } finally { store.close(); await rm(dataDir, { recursive: true, force: true }); }
});


test('needs-you section uses explicit human decisions and never marks business completion', () => {
  const store=createStore(':memory:');
  try {
    const now=new Date().toISOString();
    store.put('approvals','a',{id:'a',status:'pending',todoId:'t',params:{}});
    store.put('runs','r',{id:'r',status:'failed',todoId:'other'});
    assert.deepEqual(todoDecisionIds(store),['t']);
    const todos:Todo[]=[{id:'t',title:'等待批准',notes:'',createdAt:now,updatedAt:now}];
    assert.equal(todoSections(todos,new Date(),todoDecisionIds(store))['需要你'].length,1);
    store.put('approvals','a',{id:'a',status:'completed',todoId:'t',params:{}});
    assert.deepEqual(todoDecisionIds(store),[]);
    assert.equal(todoSections(todos,new Date(),todoDecisionIds(store))['某天'].length,1);
    assert.equal(todos[0]?.completedAt,undefined);
  }finally{store.close();}
});
