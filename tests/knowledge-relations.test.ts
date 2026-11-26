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

test('系统按共同来源建议关联，主人可排除某条，之后不再建议；恢复后又建议。助手走同一个入口', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-knowledge-suggest-'));
  const server = await startServer({host: '127.0.0.1', port: 0, dataDir, demo: true, token: 'offline-suggest'});
  t.after(async () => { await server.close(); await rm(dataDir, {recursive: true, force: true}); });
  const backend = server.app.knowledge();
  const project = await server.app.createProject({name: '建议项目'});
  const a = await backend.put({layer: 'personal', title: '发布例会', content: '定下周四发布'});
  const b = await backend.put({layer: 'personal', title: '回滚方案', content: '出问题回到上一版'});
  const c = await backend.put({layer: 'personal', title: '食堂菜单', content: '周三有面'});
  const p = await backend.put({layer: 'project', projectId: project.id, title: '项目内页', content: '只在项目内'});
  // Two sources: one made a and b, the other made a and b again, and one made p alone.
  const source = (id: string, title: string, knowledgeIds: string[], layer: 'personal' | 'project' = 'personal', projectId?: string) => server.app.store.put('knowledge.sources', id, {
    id, title, knowledgeIds, layer, ...(projectId ? {projectId} : {}), status: 'completed', createdAt: '2026-11-27T10:00:00.000Z', updatedAt: '2026-11-27T10:00:00.000Z' });
  const sourceA = '11111111-1111-4111-8111-111111111111', sourceB = '22222222-2222-4222-8222-222222222222';
  source(sourceA, '周一发布会', [a.id, b.id]);
  source(sourceB, '发布会补充', [a.id, b.id]);
  source('33333333-3333-4333-8333-333333333333', '项目记录', [p.id], 'project', project.id);
  const get = async (path: string, token = 'offline-suggest') => {
    const answer = await fetch(server.url + '/api/v1' + path, token ? {headers: {authorization: 'Bearer ' + token}} : {});
    return {status: answer.status, body: await answer.json() as Record<string, unknown>};
  };
  type Row = {id: string; sources: string[]; denied?: boolean};
  const relations = async (id: string) => (await get('/knowledge/' + id + '/relations')).body.items as Row[];

  // The system suggests b for a, naming both sources; c, which shares nothing, is not suggested.
  let rows = await relations(a.id);
  assert.deepEqual(rows.map(row => row.id), [b.id]);
  assert.deepEqual(rows[0]!.sources, ['周一发布会', '发布会补充']);
  assert.deepEqual(await relations(c.id), []);
  // A project page is suggested only within its own scope, and its source is its own.
  assert.deepEqual((await relations(p.id)).map(row => row.id), []);
  // The read needs the owner's token, takes no parameters, and refuses a page that is not there.
  assert.equal((await get('/knowledge/' + a.id + '/relations', '')).status, 401);
  assert.equal((await get('/knowledge/' + a.id + '/relations?x=1')).status, 400);
  assert.equal((await get('/knowledge/nope/relations')).status, 404);

  // The same suggestions reach the assistant through knowledge_list.
  const listTool = server.app.contributions.list('tools').find(entry => entry.value.name === 'knowledge_list')!.value;
  const listed = await runWithAgentInput({id: 'suggest-list', role: 'user', conversationId: 'main', text: '查知识', createdAt: new Date().toISOString()},
    () => listTool.execute({}, new AbortController().signal)) as Array<{id: string; suggested?: {id: string; title: string; sources: string[]}[]}>;
  assert.deepEqual(listed.find(page => page.id === a.id)!.suggested, [{id: b.id, title: '回滚方案', sources: ['周一发布会', '发布会补充']}]);
  // A page outside the result is not named.
  const narrow = await runWithAgentInput({id: 'suggest-narrow', role: 'user', conversationId: 'main', text: '查知识', createdAt: new Date().toISOString()},
    () => listTool.execute({query: '发布例会'}, new AbortController().signal)) as Array<{id: string; suggested?: unknown}>;
  assert.equal(narrow.length, 1);
  assert.equal('suggested' in narrow[0]!, false);

  // The owner says b is not related. It goes through the tool, as an assistant would.
  const tool = server.app.contributions.list('tools').find(entry => entry.value.name === 'knowledge_change_relation')!.value;
  const call = (id: string, updatedAt: string, relatedId: string, action: string) => {
    const source: Message = {id: 'suggest-' + Math.random(), role: 'user', conversationId: 'main', text: '这条不是关联', createdAt: new Date().toISOString()};
    return runWithAgentInput(source, () => tool.execute({id, updatedAt, relatedId, action}, new AbortController().signal)) as Promise<{changed: boolean; updatedAt: string; relatedIds: string[]; excludedRelatedIds: string[]}>;
  };
  const denied = await call(a.id, a.updatedAt, b.id, 'exclude');
  assert.equal(denied.changed, true);
  assert.deepEqual(denied.excludedRelatedIds, [b.id]);
  assert.deepEqual(denied.relatedIds, []);
  // The stored page keeps the denial, and b is no longer suggested.
  const stored = (await backend.list()).find(page => page.id === a.id)!;
  assert.deepEqual(stored.excludedRelatedIds, [b.id]);
  rows = await relations(a.id);
  assert.equal(rows.some(row => row.id === b.id && !row.denied), false);
  // What was denied is still shown as denied, so that it can be allowed again.
  assert.deepEqual(rows.filter(row => row.denied).map(row => row.id), [b.id]);
  const afterList = await runWithAgentInput({id: 'suggest-after', role: 'user', conversationId: 'main', text: '查知识', createdAt: new Date().toISOString()},
    () => listTool.execute({}, new AbortController().signal)) as Array<{id: string; suggested?: {denied?: boolean}[]}>;
  assert.deepEqual(afterList.find(page => page.id === a.id)!.suggested, [{id: b.id, title: '回滚方案', sources: ['周一发布会', '发布会补充'], denied: true}]);
  // Denying again changes nothing; denying a page the system did not suggest is refused.
  const again = await call(a.id, stored.updatedAt, b.id, 'exclude');
  assert.equal(again.changed, false);
  await assert.rejects(call(a.id, again.updatedAt, c.id, 'exclude'), /系统没有建议/);
  await assert.rejects(call(a.id, again.updatedAt, a.id, 'exclude'), /不能关联自己/);
  // b's own view of a is not denied: the owner spoke about a, not about b.
  assert.equal((await relations(b.id))[0]!.denied, undefined);
  // An edit of the text that does not name the denials keeps them.
  const edited = await backend.put({...stored, content: '定下周四发布，提前一天封版'});
  assert.deepEqual(edited.excludedRelatedIds, [b.id]);
  // Allowing it again is a change, and the suggestion comes back.
  const allowed = await call(a.id, edited.updatedAt, b.id, 'allow');
  assert.equal(allowed.changed, true);
  assert.deepEqual(allowed.excludedRelatedIds, []);
  rows = await relations(a.id);
  assert.equal(rows.some(row => row.id === b.id && !row.denied), true);
  assert.equal(rows.some(row => row.denied), false);
  // Allowing one that was not denied is refused.
  await assert.rejects(call(a.id, allowed.updatedAt, b.id, 'allow'), /没有被排除/);
  // The page itself may be saved with its denials, but not with itself among them.
  const page = (await backend.list()).find(page => page.id === a.id)!;
  const saved = await fetch(server.url + '/api/v1/knowledge/' + a.id, {method: 'PATCH', headers: {authorization: 'Bearer offline-suggest', 'content-type': 'application/json'},
    body: JSON.stringify({excludedRelatedIds: [b.id], expectedUpdatedAt: page.updatedAt})});
  assert.equal(saved.status, 200);
  assert.deepEqual(((await backend.list()).find(page => page.id === a.id)!).excludedRelatedIds, [b.id]);
  const self = await fetch(server.url + '/api/v1/knowledge/' + a.id, {method: 'PATCH', headers: {authorization: 'Bearer offline-suggest', 'content-type': 'application/json'},
    body: JSON.stringify({excludedRelatedIds: [a.id], expectedUpdatedAt: page.updatedAt})});
  assert.equal(self.status, 400);
});

