import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { buildWorkContext, formatWorkContextMarkdown, pendingDecisionPage } from '../packages/core/src/work-context.ts';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-work-context-'));
  const store = createStore(join(dir, 'test.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const at = '2026-11-17T00:00:00Z';
  for (const id of ['A', 'B']) {
    store.put('projects', id, { id, name: id, description: `${id}-project-fact`, createdAt: at, updatedAt: at });
    store.put('todos', id, { id, projectId: id, title: `${id}-todo`, notes: '', createdAt: at, updatedAt: at });
    store.put('runs', id, { id, projectId: id, todoId: id, status: 'running', prompt: `${id}-run`, output: `${id}-output`, createdAt: at, updatedAt: at });
    store.put('interactions', id, { id, projectId: id, runId: id, status: 'open', handler: 'user', title: `${id}-question`, version: 1, createdAt: at });
  }
  store.put('project.memory', 'B', { summary: 'B-memory', updatedAt: at });
  store.put('machines', 'm', { id: 'm', name: 'global-machine', online: false });
  store.put('settings', 'secret', { apiKey: 'DO_NOT_PROJECT_SETTINGS' });
  store.put('messages', 'secret', { text: 'DO_NOT_COPY_CHAT' });
  return store;
}

test('global facts cross histories, refresh from SQLite and keep execution separate from completion', async t => {
  const store = await fixture(t);
  const before = JSON.stringify(buildWorkContext(store, { kind: 'global' }));
  assert.match(before, /B-memory|B-project-fact/);
  assert.match(before, /B-question/);
  assert.match(before, /global-machine/);
  assert.doesNotMatch(before, /DO_NOT_PROJECT_SETTINGS|DO_NOT_COPY_CHAT/);
  store.put('runs', 'B', { ...store.get<object>('runs', 'B'), status: 'completed', output: 'new-native-result' });
  const after = buildWorkContext(store, { kind: 'global' });
  assert.match(JSON.stringify(after), /new-native-result/);
  assert.equal(after.todos!.total, 2, 'a completed execution never completes its todo');
  assert.equal(after.runs!.counts.completed, 1);
});

test('project and task counts and decisions exclude other projects, siblings and mixed plans', async t => {
  const store = await fixture(t);
  store.put('todos', 'sibling', { id: 'sibling', projectId: 'A', title: 'SIBLING', createdAt: '', updatedAt: '' });
  store.put('approvals', 'sibling', { id: 'sibling', todoId: 'sibling', title: 'SIBLING_APPROVAL', status: 'pending', params: { projectId: 'B' }, version: 1, createdAt: '' });
  store.put('plans', 'mixed', { id: 'mixed', title: 'MIXED_PLAN', status: 'pending', tasks: [{ projectId: 'A' }, { projectId: 'B' }], createdAt: '' });
  const project = buildWorkContext(store, { kind: 'project', projectId: 'A' });
  assert.equal(project.todos!.total, 2);
  assert.match(JSON.stringify(project), /SIBLING_APPROVAL/);
  assert.doesNotMatch(JSON.stringify(project), /B-project-fact|B-question|B-memory|MIXED_PLAN|global-machine/);
  const task = buildWorkContext(store, { kind: 'task', projectId: 'A', todoId: 'A' });
  assert.equal(task.todos!.total, 1);
  assert.equal(task.needsYou!.total, 1);
  assert.doesNotMatch(JSON.stringify(task), /SIBLING|B-question|MIXED_PLAN/);
  assert.doesNotMatch(JSON.stringify(buildWorkContext(store, undefined, 'A')), /B-project-fact|B-question/);
  assert.equal(buildWorkContext(store, { kind: 'global' }).needsYou!.total, 4);
});

test('bounded context reports omitted records and full counts without exposing unmarked data', async t => {
  const store = await fixture(t);
  for (let i = 0; i < 40; i++) store.put('runs', `r${i}`, { id: `r${i}`, prompt: 'x'.repeat(5000), output: 'y'.repeat(10000), status: 'unknown', createdAt: '', updatedAt: '' });
  const context = buildWorkContext(store);
  assert.equal(context.runs!.items.length, 12);
  assert.equal(context.runs!.total, 42);
  assert.equal(context.runs!.omitted, 30);
  assert.equal(context.runs!.counts.unknown, 40);
  assert.ok(JSON.stringify(context).length < 15000);
  assert.doesNotMatch(JSON.stringify(buildWorkContext(store, { kind: 'unmarked' })), /A-project-fact|B-memory|A-question|global-machine/);
});

test('executor facts are scoped before association and counts, including shared and bound machines', async t => {
  const store = await fixture(t);
  const executors = ['eA', 'eB', 'bound', 'hidden'].map(id => ({ id, name: id, kind: 'cli',
    machineId: id === 'hidden' ? 'other' : 'shared', available: true, mode: 'real' as const,
    description: 'PRIVATE_DESCRIPTION', defaultCwd: 'PRIVATE_CWD' }));
  for (const id of ['A', 'B']) store.put('runs', id, { ...store.get<object>('runs', id),
    executorId: `e${id}`, sessionId: `session-${id}`, status: id === 'A' ? 'unknown' : 'failed',
    resultSource: 'native', error: 'e'.repeat(5000), output: 'completed successfully' });
  const live = { executors };
  const project = buildWorkContext(store, { kind: 'project', projectId: 'A' }, undefined, live);
  assert.deepEqual(project.externalAgents!.items.map(e => e.id), ['eA']);
  assert.equal(project.runs!.items[0].machineId, 'shared');
  assert.equal(project.runs!.items[0].machineIdSource, 'currentExecutor');
  assert.equal(project.runs!.items[0].sessionId, 'session-A');
  assert.equal(project.runs!.items[0].error.length, 400);
  assert.equal(project.runs!.items[0].resultSource, 'native');
  assert.equal(project.externalAgents!.items[0].counts.unknown, 1);
  assert.equal(project.externalAgents!.items[0].needsYou.total, 1);
  assert.equal(project.todos!.total, 1);
  store.put('projects', 'A', { ...store.get<object>('projects', 'A'), workspace: { machineId: 'shared', cwd: '/work' } });
  const bound = buildWorkContext(store, { kind: 'project', projectId: 'A' }, undefined, live);
  assert.equal(bound.externalAgents!.total, 3);
  const b = bound.externalAgents!.items.find(e => e.id === 'eB')!;
  assert.equal(b.runs.total, 0);
  assert.equal(b.needsYou.total, 0);
  assert.equal(b.counts.failed, 0);
  assert.equal(b.executionObservation, '未上报');
  assert.doesNotMatch(JSON.stringify(bound), /B-question|session-B|PRIVATE_DESCRIPTION|PRIVATE_CWD|hidden/);
  const task = buildWorkContext(store, { kind: 'task', projectId: 'A', todoId: 'A' }, undefined, live);
  assert.deepEqual(task.externalAgents!.items.map(e => e.id), ['eA']);
  const global = buildWorkContext(store, { kind: 'global' }, undefined, live);
  assert.equal(global.externalAgents!.total, 4);
  assert.equal(global.externalAgents!.items.find(e => e.id === 'eB')!.counts.failed, 1);
  const historical = buildWorkContext(store);
  assert.equal(historical.externalAgents!.total, 2);
  assert.equal(historical.externalAgents!.items[0].available, null);
  assert.equal(historical.externalAgents!.items[0].availabilitySource, 'unknown');
  assert.match(historical.externalAgents!.items[0].reason, /实时可用性未知/);
  assert.doesNotMatch(JSON.stringify(historical.externalAgents), /idle/);
});

test('executor projection refreshes across SQLite connections, bounds groups and short circuits unmarked', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-work-context-shared-'));
  const path = join(dir, 'shared.sqlite');
  const reader = createStore(path);
  const writer = createStore(path);
  t.after(async () => { reader.close(); writer.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(buildWorkContext(reader).externalAgents!.total, 0);
  writer.put('runs', 'r', { id: 'r', executorId: 'e', status: 'unknown', createdAt: 'first', updatedAt: 'latest' });
  const facts = buildWorkContext(reader);
  assert.equal(facts.externalAgents!.items[0].updatedAt, 'latest');
  assert.equal(facts.runs!.counts.unknown, 1);
  const executors = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, name: 'n'.repeat(5000),
    machineId: 'm', mode: 'real' as const, available: false, kind: 'cli', description: '', reason: 'r'.repeat(5000) }));
  const bounded = buildWorkContext(reader, undefined, undefined, { executors });
  assert.equal(bounded.externalAgents!.items.length, 8);
  assert.equal(bounded.externalAgents!.omitted, 23);
  assert.ok(bounded.externalAgents!.items.every(e => e.name.length <= 180 && e.reason.length <= 180));
  const unmarked = buildWorkContext({ list() { throw new Error('must not read'); }, get() { throw new Error('must not read'); } },
    { kind: 'unmarked' }, undefined, { executors });
  assert.deepEqual(Object.keys(unmarked).sort(), ['scope', 'unavailable']);
});

test('formatWorkContextMarkdown renders concise overview and respects unmarked scope', async t => {
  const store = await fixture(t);
  const md = formatWorkContextMarkdown(buildWorkContext(store, { kind: 'global' }));
  assert.match(md, /待你拍板 \(2\)/);
  assert.match(md, /开放待办 \(2\)/);
  assert.match(md, /执行态势/);
  assert.match(md, /global-machine\(离线\)/);
  const unmarked = formatWorkContextMarkdown(buildWorkContext(store, { kind: 'unmarked' }));
  assert.match(unmarked, /当前范围不可用/);
});

test('待决定清单仅向正确的项目与待办展示可核实的执行关联', async t => {
  const store = await fixture(t);
  for (const [id, params] of Object.entries({
    orphan: { runId: 'missing', projectId: 'A' },
    conflict: { runId: 'B', projectId: 'A' },
    inconsistent: { id: 'A', runId: 'B' },
    own: { id: 'A' },
  })) store.put('approvals', id, { id, kind: 'input', status: 'pending', title: id, params, version: 1, createdAt: '' });
  for (const scope of [{ kind: 'project', projectId: 'A' }, { kind: 'task', projectId: 'A', todoId: 'A' }] as const) {
    assert.deepEqual(pendingDecisionPage(store, scope, 0).items.map(item => item.id), ['A', 'own']);
    assert.deepEqual(buildWorkContext(store, scope).needsYou?.items.map(item => item.id), ['A', 'own']);
  }
  assert.equal(pendingDecisionPage(store, { kind: 'unmarked' }, 0).total, 0);
});

test('合并收件追问按项目与待办范围列出，排除已答问题和原始聊天', async t => {
  const store = await fixture(t);
  const group = { id: 'a'.repeat(64), version: 2, projectId: 'A', todoIds: ['A'], title: '合成会话', question: '需要哪个环境？',
    status: 'waiting_user' as const, latestAt: '2030-01-01', preview: 'PRIVATE_PREVIEW', person: 'PRIVATE_PERSON',
    kind: 'direct' as const, messageIds: ['private-message'], pendingCount: 1 };
  const groups = [group, { ...group, id: 'mixed', todoIds: ['A', 'sibling'] }, { ...group, id: 'other', projectId: 'B' },
    { ...group, id: 'answered', status: 'watching' as const }, { ...group, id: 'missing-question', question: '' }];
  const rows = (todoId?: string) => pendingDecisionPage(store, todoId ? { kind: 'task', projectId: 'A', todoId }
    : { kind: 'project', projectId: 'A' }, 0, groups).items.filter(row => row.collection === 'conversations');
  assert.deepEqual(rows().map(row => row.id), [group.id, 'mixed']);
  const taskRows = rows('A');
  assert.deepEqual(taskRows.map(row => row.id), [group.id]);
  assert.equal(taskRows[0]?.webCitation, '[查看待决定事项](#inbox?conversation=' + group.id + ')');
  assert.doesNotMatch(JSON.stringify(taskRows), /PRIVATE_|private-message/);
});
