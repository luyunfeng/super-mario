import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';

test('项目经验 HTTP：读取、改正、版本冲突、删除、归档拒绝写入、项目之间隔离', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-project-lessons-http-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-project-lessons' });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { 'Authorization': 'Bearer offline-project-lessons', 'Content-Type': 'application/json' };
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(server.url + '/api/v1' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const first = await call('/projects', 'POST', { name: '结算重构' });
  const second = await call('/projects', 'POST', { name: '另一个项目' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  // The learner runs beside acceptance and needs a model. Seed one lesson directly so this
  // test is about what the owner can do with a recorded lesson.
  const store = server.app.store;
  store.put('project.lessons', 'lesson-1', { id: 'lesson-1', projectId: first.data.id, kind: 'missing_context', text: '先确认对账口径',
    seen: 1, firstSeenAt: '2026-11-01T00:00:00.000Z', lastSeenAt: '2026-11-01T00:00:00.000Z', sources: [], edited: false, stale: false, version: 1 });

  const listed = await call('/projects/' + first.data.id + '/lessons');
  assert.equal(listed.status, 200);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].text, '先确认对账口径');

  // Another project sees nothing and cannot edit this lesson.
  assert.deepEqual((await call('/projects/' + second.data.id + '/lessons')).data, []);
  const foreign = await call('/projects/' + second.data.id + '/lessons', 'PUT', { id: 'lesson-1', text: '越权', version: 1 });
  assert.equal(foreign.status, 404);
  assert.equal((await call('/projects/' + first.data.id + '/lessons')).data[0].text, '先确认对账口径');

  const edited = await call('/projects/' + first.data.id + '/lessons', 'PUT', { id: 'lesson-1', text: '  先和对账口径的负责人确认  ', version: 1 });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.text, '先和对账口径的负责人确认');
  assert.equal(edited.data.edited, true);
  assert.equal(edited.data.version, 2);

  const stale = await call('/projects/' + first.data.id + '/lessons', 'PUT', { id: 'lesson-1', text: '用旧版本改', version: 1 });
  assert.equal(stale.status, 409);
  assert.match(String(stale.data.error), /已有新版本/);
  assert.equal((await call('/projects/' + first.data.id + '/lessons')).data[0].text, '先和对账口径的负责人确认');

  for (const body of [{ id: 'lesson-1', text: '', version: 2 }, { id: 'lesson-1', text: 'x'.repeat(601), version: 2 },
    { id: 'lesson-1', text: '版本不是整数', version: '2' }, { id: 'lesson-1', text: '多余字段', version: 2, extra: 1 }]) {
    const bad = await call('/projects/' + first.data.id + '/lessons', 'PUT', body);
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
  assert.equal((await call('/projects/missing/lessons')).status, 404);

  // An archived project can be read but not changed.
  assert.equal((await call('/projects/' + first.data.id, 'DELETE')).status, 200);
  assert.equal((await call('/projects/' + first.data.id + '/lessons')).status, 200);
  assert.equal((await call('/projects/' + first.data.id + '/lessons', 'PUT', { id: 'lesson-1', text: '归档后改', version: 2 })).status, 409);

  assert.equal((await call('/projects/' + first.data.id + '/restore', 'POST')).status, 200);
  const removed = await call('/projects/' + first.data.id + '/lessons', 'DELETE', { id: 'lesson-1', version: 2 });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data, { id: 'lesson-1' });
  assert.deepEqual((await call('/projects/' + first.data.id + '/lessons')).data, []);
  assert.equal((await call('/projects/' + first.data.id + '/lessons', 'DELETE', { id: 'lesson-1', version: 2 })).status, 404);
});
