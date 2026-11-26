import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../apps/server/src/index.ts';
import {runWithAgentInput} from '../packages/core/src/agent-input.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('知识页可关联和移除同范围内的其他页，不能关联自己或范围外的页，旧文件没有关联字段仍可读', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-knowledge-relations-'));
  const server = await startServer({host: '127.0.0.1', port: 0, dataDir, demo: true});
  t.after(async () => { await server.close(); await rm(dataDir, {recursive: true, force: true}); });
  const backend = server.app.knowledge();
  const project = await server.app.createProject({name: '关联项目'});
  const other = await server.app.createProject({name: '另一个项目'});
  const a = await backend.put({layer: 'personal', title: '部署步骤', content: '先核对版本再发布'});
  const b = await backend.put({layer: 'personal', title: '回滚步骤', content: '保留上一版产物'});
  const inProject = await backend.put({layer: 'project', projectId: project.id, title: '项目约定', content: '只在项目内可见'});
  const inOther = await backend.put({layer: 'project', projectId: other.id, title: '别的项目约定', content: '不属于本项目'});
  // The change goes through the same path and the same checks as the assistant tool.
  type Receipt = {changed: boolean; relatedIds: string[]; updatedAt: string};
  const call = (id: string, updatedAt: string, relatedId: string, action: 'add' | 'remove', projectId?: string) => {
    const source: Message = {id: 'relation-' + Math.random(), role: 'user', conversationId: projectId ? 'project:' + projectId + ':work' : 'main',
      text: '关联这两个知识页', createdAt: new Date().toISOString(), ...(projectId ? {projectId} : {})};
    const tool = server.app.contributions.list('tools').find(entry => entry.value.name === 'knowledge_change_relation')!.value;
    return runWithAgentInput(source, () => tool.execute({id, updatedAt, relatedId, action}, new AbortController().signal)) as Promise<Receipt>;
  };

  // Personal pages can be linked from the main conversation.
  const linked = await call(a.id, a.updatedAt, b.id, 'add');
  assert.deepEqual(linked, {changed: true, id: a.id, relatedIds: [b.id], updatedAt: linked.updatedAt});
  assert.deepEqual((await backend.list()).find(page => page.id === a.id)!.relatedIds, [b.id]);
  // Linking again changes nothing.
  const again = await call(a.id, linked.updatedAt, b.id, 'add');
  assert.equal(again.changed, false);
  assert.deepEqual(again.relatedIds, [b.id]);
  // A page cannot link to itself.
  await assert.rejects(call(a.id, again.updatedAt, a.id, 'add'), /不能关联自己/);
  // A stale version is refused, so a concurrent edit is not overwritten.
  await assert.rejects(call(a.id, a.updatedAt, b.id, 'remove'), /已有新版本/);
  const removed = await call(a.id, again.updatedAt, b.id, 'remove');
  assert.equal(removed.changed, true);
  assert.deepEqual(removed.relatedIds, []);
  assert.equal((await backend.list()).find(page => page.id === a.id)!.relatedIds, undefined);

  // From a project conversation, a page of that project can link to another page of the
  // same project, but not to a personal page or a page of another project.
  const second = await backend.put({layer: 'project', projectId: project.id, title: '发布检查', content: '检查回滚预案'});
  await assert.rejects(call(inProject.id, inProject.updatedAt, a.id, 'add', project.id), /要关联的知识页不可用/);
  await assert.rejects(call(inProject.id, inProject.updatedAt, inOther.id, 'add', project.id), /要关联的知识页不可用/);
  const projectLink = await call(inProject.id, inProject.updatedAt, second.id, 'add', project.id);
  assert.deepEqual(projectLink.relatedIds, [second.id]);
  // The main conversation spans projects, so it may link to a page of a live project,
  // exactly as it may read one. A page of an archived project is out of reach.
  const fromMain = await call(b.id, b.updatedAt, inProject.id, 'add');
  assert.deepEqual(fromMain.relatedIds, [inProject.id]);
  await server.app.projects.archive(other.id);
  // Archiving keeps the page itself; it is only out of reach, which is what is being tested.
  assert.ok((await backend.list()).some(page => page.id === inOther.id));
  await assert.rejects(call(b.id, fromMain.updatedAt, inOther.id, 'add'), /要关联的知识页不可用/);

  // A file saved before links existed has no relatedIds and still loads.
  const {mkdirSync, writeFileSync} = await import('node:fs');
  const dir = join(dataDir, 'plugins', 'knowledge-local', 'knowledge');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'legacy.md'), '---\n{"id":"legacy","layer":"personal","title":"旧页","content":"旧内容","updatedAt":"2026-01-01T00:00:00.000Z"}\n---\n旧内容');
  let legacy: Awaited<ReturnType<typeof backend.list>>[number] | undefined;
  legacy = (await backend.list()).find(page => page.id === 'legacy');
  assert.equal(legacy?.title, '旧页');
  assert.equal(legacy?.relatedIds, undefined);

  // knowledge_list names a linked page that is in the same result, and only then.
  const listTool = server.app.contributions.list('tools').find(entry => entry.value.name === 'knowledge_list')!.value;
  await call(a.id, (await backend.list()).find(page => page.id === a.id)!.updatedAt, b.id, 'add');
  const listed = await runWithAgentInput(
    {id: 'list-input', role: 'user', conversationId: 'main', text: '查知识', createdAt: new Date().toISOString()},
    () => listTool.execute({}, new AbortController().signal)) as Array<{id: string; related?: {id: string; title: string}[]}>;
  assert.deepEqual(listed.find(page => page.id === a.id)!.related, [{id: b.id, title: '回滚步骤'}]);
  // A keyword query that leaves the linked page out carries no title for it.
  const narrowed = await runWithAgentInput(
    {id: 'list-input-2', role: 'user', conversationId: 'main', text: '查部署', createdAt: new Date().toISOString()},
    () => listTool.execute({query: '部署'}, new AbortController().signal)) as Array<{id: string; related?: {id: string; title: string}[]}>;
  assert.deepEqual(narrowed.map(page => page.id), [a.id]);
  // The link is still named by id; no title is revealed for a page outside this result.
  assert.deepEqual(narrowed[0]!.related, []);
});
