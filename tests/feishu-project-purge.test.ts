import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { createFeishuGateway } from '../apps/server/src/feishu-gateway.ts';

test('gateway blocks only current project bindings and live registration operations', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-purge-bot-'));
  const config = { dataDir, host: '127.0.0.1', port: 0, demo: true };
  const app = await createWorkbench(config);
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const gateway = createFeishuGateway(app, config, { registrationProvider: { async register() {
    await gate;
    throw new Error('test cancellation');
  } } });
  t.after(async () => {
    resume();
    await gateway.registrations.close();
    await gateway.personal.close();
    await gateway.feishu.close();
    await gateway.bots.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const project = app.projects.create({ name: 'A' });
  app.store.put('todos', 'todo-a', { id: 'todo-a', projectId: project.id });
  const bot = await gateway.bots.create({ name: 'bot', enabled: false, appId: 'cli_0123456789abcdef',
    appSecret: 'test-secret', scope: { kind: 'project', projectId: project.id } });
  const check = () => gateway.assertProjectPurgeAllowed(project.id, ['todo-a']);
  const sessionDir = join(dataDir, 'pi', 'agents', createHash('sha256').update(`project:${project.id}:work`).digest('hex'));
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'history'), 'test conversation');
  const purge = () => app.purgeProject(project.id, { confirmName: project.name }, gateway.assertProjectPurgeAllowed);
  const before = await readFile(join(dataDir, 'bots.json'));
  assert.throws(check, { status: 409 });
  await assert.rejects(purge(), { status: 409 });
  assert.equal(await readFile(join(sessionDir, 'history'), 'utf8'), 'test conversation');
  gateway.assertProjectPurgeAllowed('other', []);
  assert.deepEqual(await readFile(join(dataDir, 'bots.json')), before);
  await gateway.bots.update(bot.id, { scope: { kind: 'global' } });
  check();
  const job = gateway.registrations.start({ name: 'registration', scope: { kind: 'task', todoId: 'todo-a' } });
  await Promise.resolve();
  assert.throws(check, { status: 409 });
  gateway.assertProjectPurgeAllowed('other', ['todo-b']);
  gateway.registrations.cancel(job.id);
  assert.throws(check, { status: 409 });
  resume();
  await new Promise<void>(resolve => setImmediate(resolve));
  check();
  // Interrupt after the journal is durable, before the SQLite commit. A
  // retryable project must reject new bindings throughout this interval.
  await assert.rejects(app.purgeProject(project.id, { confirmName: project.name }, id => {
    if (app.isProjectPurging(id)) throw new Error('injected final check failure');
  }), /injected final check failure/);
  const taskScope = { kind: 'task' as const, todoId: 'todo-a' };
  await assert.rejects(gateway.bots.create({ name: 'late', enabled: false, appId: 'cli_1234567890abcdef',
    appSecret: 'test-secret', scope: taskScope }), { status: 409 });
  await assert.rejects(gateway.bots.update(bot.id, { scope: taskScope }), { status: 409 });
  assert.throws(() => gateway.registrations.start({ name: 'late', scope: taskScope }), { status: 409 });
  assert.equal(gateway.bots.list().length, 1);
  assert.deepEqual(gateway.bots.list()[0]?.scope, { kind: 'global' });
  assert.equal(gateway.registrations.list().length, 1);
  assert.equal(await readFile(join(sessionDir, 'history'), 'utf8'), 'test conversation');
  await purge();
  await assert.rejects(access(sessionDir), { code: 'ENOENT' });
});
