import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';
import type { Project, Todo } from '../packages/protocol/src/index.ts';

test('confirmed project purge removes only its workbench data and releases its folder binding', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mario-project-purge-'));
  const dataDir = join(root, 'server');
  const token = 'project-purge-fixture';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, token, demo: true });
  const machineId = 'purge-test-node';
  const node = startAgentNode({ url: server.url, token, machineId, name: '测试电脑', dataDir: join(root, 'node'),
    handlers: createProjectDiscovery({ home: root, ignoreEnvironmentRoots: true }).handlers });
  const db = new DatabaseSync(join(dataDir, 'workbench.sqlite'), { readOnly: true });
  t.after(async () => {
    db.close();
    await node.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !server.machines.list().some(m => m.id === machineId && m.online); i++) await delay(20);
  assert.ok(server.machines.list().some(m => m.id === machineId && m.online));

  const request = (path: string, method = 'GET', body?: unknown, signal?: AbortSignal) =>
    fetch(server.url + '/api/v1' + path, { method, signal,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
  async function create<T>(path: string, body: unknown): Promise<T> {
    const response = await request(path, 'POST', body);
    const value = await response.json();
    assert.equal(response.status, 201, JSON.stringify(value));
    return value as T;
  }
  // A separate SQLite connection observes committed rows even if HTTP hides archived projects.
  const row = db.prepare('SELECT value FROM documents WHERE collection = ? AND id = ?');
  async function fixture(name: string) {
    const workspace = { machineId, cwd: join(root, 'folders', name) };
    await mkdir(workspace.cwd, { recursive: true });
    const file = join(workspace.cwd, 'work.txt');
    await writeFile(file, name);
    const project = await create<Project>('/projects', { name, workspace });
    const todo = await create<Todo>('/todos', { title: '项目待办', projectId: project.id });
    const knowledge = await create<{ id: string }>('/knowledge', { layer: 'project', projectId: project.id,
      title: '项目资料', content: name });
    return { project, todo, knowledge, workspace, file };
  }
  const target = await fixture('官网');
  const other = await fixture('官网二期');
  const personal = await create<{ id: string }>('/knowledge', { layer: 'personal', title: '项目资料', content: '个人资料' });
  const saved = (item: typeof target) => [row.get('projects', item.project.id), row.get('todos', item.todo.id)];
  const original = saved(target);
  const control = saved(other);
  assert.ok([...original, ...control].every(Boolean));
  async function knowledgeIds() {
    const response = await request('/knowledge');
    assert.equal(response.status, 200);
    return (await response.json() as Array<{ id: string }>).map(entry => entry.id).sort();
  }
  const originalKnowledge = await knowledgeIds();
  for (const id of [target.knowledge.id, other.knowledge.id, personal.id]) assert.ok(originalKnowledge.includes(id));
  const path = '/projects/' + target.project.id;

  // Cancelling before submission sends no destructive request. In-flight cancellation is a different contract.
  await assert.rejects(request(path + '/purge', 'POST', { confirmName: target.project.name }, AbortSignal.abort()),
    { name: 'AbortError' });
  assert.deepEqual(saved(target), original);
  assert.deepEqual(await knowledgeIds(), originalKnowledge);

  for (const body of [{}, { confirmName: other.project.name }, { confirmName: target.project.name + ' ' }]) {
    const rejected = await request(path + '/purge', 'POST', body);
    assert.equal(rejected.status, 400, await rejected.text());
    assert.deepEqual(saved(target), original);
    assert.deepEqual(saved(other), control);
    assert.deepEqual(await knowledgeIds(), originalKnowledge);
  }
  const confirmed = await request(path + '/purge', 'POST', { confirmName: target.project.name });
  assert.ok(confirmed.ok, 'purge returned ' + confirmed.status + ' ' + await confirmed.text());
  assert.deepEqual(saved(target), [undefined, undefined]);
  assert.deepEqual(saved(other), control);
  assert.deepEqual(await knowledgeIds(), originalKnowledge.filter(id => id !== target.knowledge.id));
  for (const item of [target, other]) assert.equal(await readFile(item.file, 'utf8'), item.project.name);

  assert.equal((await request(path + '/restore', 'POST', {})).status, 404);
  const rebound = await create<Project>('/projects', { name: target.project.name, workspace: target.workspace });
  assert.ok(rebound.id);
  assert.notEqual(rebound.id, target.project.id);
  assert.deepEqual(rebound.workspace, target.workspace);
  assert.deepEqual(saved(target), [undefined, undefined]);
  assert.deepEqual(saved(other), control);
  assert.equal(await readFile(target.file, 'utf8'), target.project.name);
});
