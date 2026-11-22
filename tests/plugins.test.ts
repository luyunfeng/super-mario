import { createContributions } from '../packages/core/src/plugin-host.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createSystemExtensions } from '../plugins/index.ts';
import type { ContributionMap, Contributions, Dispose, EventBus, ExtensionContext, Store } from '../packages/plugin-sdk/src/index.ts';
import type { AppEvent, KnowledgeEntry, Run, Todo } from '../packages/protocol/src/index.ts';

function memoryStore(): Store {
  let data = new Map<string, Map<string, unknown>>();
  return {
    get<T>(collection: string, id: string) { return structuredClone(data.get(collection)?.get(id)) as T | undefined; },
    list<T>(collection: string) { return structuredClone([...(data.get(collection)?.values() ?? [])]) as T[]; },
    put<T>(collection: string, id: string, value: T) {
      if (!data.has(collection)) data.set(collection, new Map());
      data.get(collection)!.set(id, structuredClone(value));
    },
    remove(collection, id) { return data.get(collection)?.delete(id) ?? false; },
    transaction<T>(fn: () => T) {
      const before = structuredClone(data);
      try { return fn(); } catch (error) { data = before; throw error; }
    },
    close() {},
  };
}

function eventBus(): EventBus {
  const events: AppEvent[] = [];
  const listeners = new Set<(event: AppEvent) => void>();
  return {
    publish(type, data) {
      const event = { id: events.length + 1, type, data, createdAt: new Date().toISOString() };
      events.push(event);
      for (const listener of listeners) listener(event);
      return event;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    since(id) { return events.filter(event => event.id > id); },
  };
}

async function setup(t: TestContext, demo = false, directory?: string) {
  const dataDir = directory ?? mkdtempSync(join(tmpdir(), 'super-mario-plugins-'));
  if (!directory) t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const values = new Map<keyof ContributionMap, Map<string, unknown>>();
  const contributions: Contributions = {
    ...createContributions(),
    add<K extends keyof ContributionMap>(kind: K, id: string, value: ContributionMap[K]) {
      if (!values.has(kind)) values.set(kind, new Map());
      const items = values.get(kind)!;
      assert.equal(items.has(id), false, `duplicate contribution: ${kind}/${id}`);
      items.set(id, value);
      return () => { items.delete(id); };
    },
    list<K extends keyof ContributionMap>(kind: K) {
      return [...(values.get(kind)?.entries() ?? [])].map(([id, value]) => ({ id, value: value as ContributionMap[K] }));
    },
  };
  const store = memoryStore();
  const events = eventBus();
  const disposers = new Map<string, Dispose[]>();
  const extensions = createSystemExtensions({ demo });
  for (const extension of extensions) {
    const owned: Dispose[] = [];
    disposers.set(extension.id, owned);
    const context: ExtensionContext = {
      hook: () => () => {}, provide: () => () => {}, use: async () => null, wrap: () => () => {},
      id: extension.id, dataDir, config: {}, store, events, contributions,
      contribute(kind, id, value) { owned.push(contributions.add(kind, id, value)); },
      defer(dispose) { owned.push(dispose); },
      onEvent(listener) { owned.push(events.subscribe(listener)); },
    };
    await extension.activate(context);
  }
  return {
    dataDir, store, contributions, extensions,
    knowledge: contributions.list('knowledge_backends').find(item => item.id === 'local')!.value,
    async disable(id: string) { for (const dispose of [...disposers.get(id)!].reverse()) await dispose(); },
  };
}

const signal = () => new AbortController().signal;

test('exactly nine system extensions; real executors reject without external effects', async t => {
  const host = await setup(t);
  assert.deepEqual(host.extensions.map(item => item.id), [
    'builtin-tools', 'knowledge-local', 'executor-claude-code', 'executor-codex', 'executor-pi',
    'terminal-host', 'feishu', 'inbox-triage', 'daily-brief',
  ]);
  const executors = host.contributions.list('executors');
  assert.deepEqual(executors.map(item => item.id), ['claude-code', 'codex', 'pi']);
  for (const { value } of executors) {
    assert.equal(value.available, false);
    assert.equal(value.mode, 'real');
    assert.ok(value.reason);
    let output = '';
    await assert.rejects(value.execute({ prompt: 'test', signal: signal(), onOutput: text => { output += text; } }), /执行机/);
    assert.equal(output, '');
  }
  const listTool = host.contributions.list('tools').find(item => item.id === 'executors_list')!.value;
  const result = await listTool.execute({}, signal());
  assert.equal((result as unknown[]).length, 3);
  assert.ok(!JSON.stringify(result).includes('execute'));
  for (const id of ['terminal_host_status', 'feishu_status', 'inbox_triage_status']) {
    const status = host.contributions.list('tools').find(item => item.id === id)!.value;
    const result = await status.execute({}, signal());
    assert.equal((result as { status: string }).status, 'managed_by_host');
    assert.equal((result as { available: boolean }).available, false);
  }
});

test('todo agenda uses a half-open local date window and keeps undated todos in the full list', async t => {
  const host = await setup(t);
  for (const [id, dueAt] of [
    ['next', '2026-03-09T00:00:00-04:00'], ['late', '2026-03-08T23:59:00-04:00'],
    ['undated', undefined], ['start', '2026-03-08T05:00:00Z'],
  ]) host.store.put('todos', id!, { id, dueAt });
  const list = host.contributions.list('tools').find(item => item.id === 'todos_list')!.value;
  const agenda = await list.execute({ dueFrom: '2026-03-08T00:00:00-05:00', dueBefore: '2026-03-09T00:00:00-04:00' }, signal());
  assert.deepEqual((agenda as unknown as Todo[]).map(todo => todo.id), ['start', 'late']);
  assert.equal((await list.execute({}, signal()) as unknown[]).length, 4);
  await assert.rejects(list.execute({ status: 'running' }, signal()), /待办状态/);
  await assert.rejects(list.execute({ overdue: 'true' }, signal()), /布尔值/);
  host.store.put('todos', 'closed', { id: 'closed', projectId: 'p', completedAt: '2026-03-08T00:00Z' });
  assert.deepEqual((await list.execute({ projectId: 'p', status: 'done' }, signal()) as unknown as Todo[]).map(todo => todo.id), ['closed']);
  assert.deepEqual(await list.execute({ status: 'done', overdue: true }, signal()), []);
  await assert.rejects(list.execute({ dueFrom: '2026-03-08' }, signal()), /时区/);
  await assert.rejects(list.execute({ dueFrom: '2026-03-09T00:00Z', dueBefore: '2026-03-08T00:00Z' }, signal()), /起点/);
});

test('demo executor is separate, delayed, explicitly marked, and owned by Codex extension', async t => {
  const host = await setup(t, true);
  const executor = host.contributions.list('executors').find(item => item.id === 'demo')!.value;
  assert.equal(executor.mode, 'demo');
  assert.equal(executor.machineId, 'local-demo');
  assert.equal(executor.available, true);
  const output: string[] = [];
  const start = performance.now();
  const result = await executor.execute({ prompt: '示例任务', signal: signal(), onOutput: text => output.push(text) });
  assert.ok(performance.now() - start >= 80);
  assert.match(result.text, /演示 \/ demo/);
  assert.match(result.text, /未执行模型或真实 CLI/);
  assert.match(result.text, /示例任务/);
  assert.deepEqual(output, [result.text]);
  await host.disable('executor-codex');
  assert.deepEqual(host.contributions.list('executors').map(item => item.id), ['claude-code', 'pi']);
});

test('demo cancellation rejects before start and while waiting without success output', async t => {
  const host = await setup(t, true);
  const executor = host.contributions.list('executors').find(item => item.id === 'demo')!.value;
  let outputs = 0;
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(executor.execute({ prompt: '', signal: cancelled.signal, onOutput: () => outputs++ }), { name: 'AbortError' });
  const pending = new AbortController();
  const execution = executor.execute({ prompt: '', signal: pending.signal, onOutput: () => outputs++ });
  const timer = setTimeout(() => pending.abort(), 10);
  try { await assert.rejects(execution, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  assert.equal(outputs, 0);
});

test('knowledge persists as Markdown and reconstructs its index after a new host starts', async t => {
  const host = await setup(t);
  const entry = await host.knowledge.put({ id: 'note-1', layer: 'personal', title: '工作方式', content: '# 正文\n独立文件\n---\n保留正文\n' });
  assert.match(readFileSync(join(host.dataDir, 'knowledge/note-1.md'), 'utf8'), /^---\n\{"id":"note-1"/);
  assert.deepEqual(host.store.get('knowledge', entry.id), entry);
  const restarted = await setup(t, false, host.dataDir);
  assert.deepEqual(await restarted.knowledge.list(), [entry]);
  assert.deepEqual(restarted.store.get('knowledge', entry.id), entry);
  const updated = await restarted.knowledge.put({ ...entry, title: '已更新', content: '新正文' });
  assert.equal((await host.knowledge.list())[0]!.content, '新正文');
  assert.equal(updated.id, entry.id);
  assert.equal(await restarted.knowledge.remove(entry.id), true);
  assert.equal(await restarted.knowledge.remove(entry.id), false);
  assert.deepEqual(await host.knowledge.list(), []);
  assert.equal(host.store.get('knowledge', entry.id), undefined);
  assert.equal(restarted.store.get('knowledge', entry.id), undefined);
});

test('knowledge supports all layers, project filters and case-insensitive keywords', async t => {
  const host = await setup(t);
  await host.knowledge.put({ id: 'personal', layer: 'personal', title: 'Apple', content: 'Banana' });
  await host.knowledge.put({ id: 'global', layer: 'global', title: '总规则', content: 'Apple Banana' });
  await host.knowledge.put({ id: 'project-a', layer: 'project', projectId: 'a', title: '项目 A', content: 'Banana' });
  await host.knowledge.put({ id: 'project-b', layer: 'project', projectId: 'b', title: '项目 B', content: 'Apple' });
  assert.equal((await host.knowledge.list()).length, 4);
  assert.deepEqual((await host.knowledge.list({ query: 'APPLE banana' })).map(entry => entry.id), ['global', 'personal']);
  assert.deepEqual((await host.knowledge.list({ layer: 'project', projectId: 'a', query: 'banana' })).map(entry => entry.id), ['project-a']);
  assert.deepEqual((await host.knowledge.list({ layer: 'global' })).map(entry => entry.id), ['global']);
  const tool = host.contributions.list('tools').find(item => item.id === 'knowledge_list')!.value;
  const result = await tool.execute({ layer: 'project', projectId: 'b' }, signal());
  assert.deepEqual((result as unknown as KnowledgeEntry[]).map(entry => entry.id), ['project-b']);
  await host.disable('knowledge-local');
  await assert.rejects(tool.execute({}, signal()), /backend is unavailable/);
});

test('knowledge rejects invalid scopes and traversal ids before writing files', async t => {
  const host = await setup(t);
  const base = { layer: 'personal' as const, title: 'test', content: '' };
  for (const id of ['../escape', '/tmp/escape', '.', '..', 'nested/file', '', 'a'.repeat(129)]) {
    await assert.rejects(host.knowledge.put({ ...base, id }), /Invalid knowledge id/);
    await assert.rejects(host.knowledge.remove(id), /Invalid knowledge id/);
  }
  await assert.rejects(host.knowledge.put({ ...base, layer: 'project' }), /requires projectId/);
  await assert.rejects(host.knowledge.put({ ...base, layer: 'project', projectId: ' ' }), /projectId/);
  await assert.rejects(host.knowledge.put({ ...base, layer: 'public' as never }), /layer/);
  await assert.rejects(host.knowledge.put({ ...base, title: '' }), /title/);
  await assert.rejects(host.knowledge.list({ layer: 'public' as never }), /layer/);
  await assert.rejects(host.knowledge.list({ query: 1 as never }), /query/);
  assert.deepEqual(await host.knowledge.list(), []);
});

test('files are the fact source: external edits, deletions and corrupt metadata', async t => {
  const host = await setup(t);
  const entry = await host.knowledge.put({ id: 'fact', layer: 'global', title: '规则', content: '初始' });
  const path = join(host.dataDir, 'knowledge/fact.md');
  const { content: _content, ...metadata } = entry;
  writeFileSync(path, `---\n${JSON.stringify(metadata)}\n---\n外部更新`);
  assert.equal((await host.knowledge.list())[0]!.content, '外部更新');
  assert.equal(host.store.get<KnowledgeEntry>('knowledge', entry.id)!.content, '外部更新');
  writeFileSync(path, 'corrupt');
  await assert.rejects(host.knowledge.list(), /Invalid knowledge Markdown/);
  assert.equal(host.store.get<KnowledgeEntry>('knowledge', entry.id)!.content, '外部更新');
  writeFileSync(path, `---\n${JSON.stringify({ ...metadata, id: 'other' })}\n---\n正文`);
  await assert.rejects(host.knowledge.list(), /filename and metadata/);
  rmSync(path);
  assert.deepEqual(await host.knowledge.list(), []);
  assert.equal(host.store.get('knowledge', entry.id), undefined);
});

test('knowledge refuses symlink reads and symlink directories', async t => {
  const host = await setup(t);
  const outside = join(host.dataDir, 'outside.md');
  writeFileSync(outside, 'private');
  const link = join(host.dataDir, 'knowledge/link.md');
  symlinkSync(outside, link);
  await assert.rejects(host.knowledge.list(), /regular file/);
  // Updating an existing entry must verify its prior version without following links.
  await assert.rejects(host.knowledge.put({ id: 'link', layer: 'personal', title: 'safe', content: 'new' }), { code: 'ELOOP' });
  assert.equal(readFileSync(outside, 'utf8'), 'private');
  rmSync(join(host.dataDir, 'knowledge'), { recursive: true });
  symlinkSync(tmpdir(), join(host.dataDir, 'knowledge'));
  await assert.rejects(host.knowledge.list(), /real directory/);
  await assert.rejects(host.knowledge.put({ layer: 'personal', title: 'test', content: '' }), /real directory/);
});

test('dailybrief uses only current todos and runs, including failed and unknown states', async t => {
  const host = await setup(t, true);
  const routine = host.contributions.list('routines').find(item => item.id === 'dailybrief')!.value;
  assert.deepEqual(await routine.run(), {
    todos: { total: 0, open: 0, completed: 0 },
    runs: { total: 0, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, unknown: 0 },
  });
  const timestamp = new Date().toISOString();
  const todo: Todo = { id: 'open', title: '真实待办', notes: '', createdAt: timestamp, updatedAt: timestamp };
  host.store.put('todos', todo.id, todo);
  host.store.put('todos', 'done', { ...todo, id: 'done', completedAt: timestamp });
  for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'] as const) {
    const run: Run = { id: status, executorId: 'codex', conversationId: 'test', prompt: 'test', status, output: '', createdAt: timestamp, updatedAt: timestamp };
    host.store.put('runs', status, run);
  }
  assert.deepEqual(await routine.run(), {
    todos: { total: 2, open: 1, completed: 1 },
    runs: { total: 6, queued: 1, running: 1, completed: 1, failed: 1, cancelled: 1, unknown: 1 },
  });
  host.store.remove('todos', 'open');
  assert.equal((await routine.run() as { todos: { total: number } }).todos.total, 1);
  await host.disable('daily-brief');
  assert.deepEqual(host.contributions.list('routines'), []);
});
