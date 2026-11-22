import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { acceptMessage, readMessageReceipt } from '../packages/core/src/message-receipts.ts';
import { createStore } from '../packages/core/src/store.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('主会话和项目独立受理请求，回放同一输入并读取最新状态', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'message-receipts-'));
  const config = { dataDir, host: '127.0.0.1', port: 0, demo: true };
  let app = await createWorkbench(config);
  const disk = createStore(join(dataDir, 'workbench.sqlite'));
  t.after(async () => { disk.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = await app.createProject({ name: '合成项目' });
  const requestId = randomUUID();
  const context = { requestId, projectId: project.id, readOnly: true };
  const read = () => readMessageReceipt(disk, 'main', requestId);
  const notifications: string[] = [];
  const stop = app.events.subscribe(event => {
    if (event.type === 'messages.changed' && read()?.status === 'pending') notifications.push(read()!.id);
  });
  assert.equal(read(), undefined);
  const [first, retry] = await Promise.all([
    app.agent.post(' 合成问题 ', 'main', context), app.agent.post('合成问题', 'main', context),
  ]);
  stop();
  assert.equal(first.status, 'pending');
  assert.equal(first.requestId, requestId);
  assert.equal(first.text, '合成问题');
  assert.deepEqual(first, retry);
  assert.deepEqual(notifications, [first.id], '首次通知到达时其他 SQLite 连接已能读到回执，重试没有广播');
  for (const altered of [{ ...context, readOnly: false }, { ...context, projectId: undefined },
    { ...context, origin: 'result' as const }, { ...context, replyTo: 'different' }, { ...context, todoId: 'elsewhere' }]) {
    await assert.rejects(app.agent.post(first.text, 'main', altered), { status: 409 });
  }
  await assert.rejects(app.agent.post('其他正文', 'main', context), { status: 409 });
  for (const invalid of ['', requestId + '\n', 'A' + requestId.slice(1), requestId.slice(0, 14) + '3' + requestId.slice(15)]) {
    await assert.rejects(app.agent.post('foo', 'main', { requestId: invalid }), { status: 400 });
    assert.throws(() => readMessageReceipt(disk, 'main', invalid), { status: 400 });
  }
  const scoped = await app.projectWorkspace.post(project.id, first.text, requestId);
  assert.notEqual(scoped.id, first.id);
  assert.equal((await app.projectWorkspace.post(project.id, first.text, requestId)).id, scoped.id);
  const legacy = await app.agent.post(first.text);
  assert.equal(legacy.requestId, undefined);
  assert.notEqual((await app.agent.post(first.text)).id, legacy.id);

  await app.close();
  assert.equal(read()?.status, 'done');
  const replies = () => disk.list<Message>('messages').filter(m => m.replyTo === first.id);
  assert.equal(replies().length, 1);
  const interrupted = { ...first, requestId: randomUUID(), id: randomUUID(), status: 'pending' as const };
  acceptMessage(disk, interrupted);
  app = await createWorkbench(config);
  assert.equal((await app.agent.post(first.text, 'main', context)).status, 'done');
  const failed = await app.agent.post(first.text, 'main', { ...context, requestId: interrupted.requestId });
  assert.equal(failed.id, interrupted.id);
  assert.equal(failed.status, 'failed');
  assert.equal(disk.list<Message>('messages').filter(m => m.replyTo === interrupted.id).length, 1);
  assert.equal(replies().length, 1);
  app.store.put('projects', project.id, { ...project, archivedAt: new Date().toISOString() });
  await assert.rejects(async () => app.projectWorkspace.post(project.id, first.text, requestId), { status: 409 });
});

test('写入回执失败会一起回滚输入，损坏的回执不能重新受理', () => {
  const store = createStore(':memory:');
  try {
    const message: Message = { id: randomUUID(), requestId: randomUUID(), conversationId: 'main', role: 'user',
      text: '合成正文', status: 'pending', createdAt: new Date().toISOString() };
    const broken = { ...store, put(collection: string, id: string, value: unknown) {
      if (collection === 'message.requests') throw new Error('模拟回执写入失败');
      store.put(collection, id, value);
    } };
    assert.throws(() => acceptMessage(broken, message), /模拟回执写入失败/);
    assert.equal(store.list('messages').length, 0);
    assert.equal(acceptMessage(store, message), undefined);
    store.remove('messages', message.id);
    assert.throws(() => acceptMessage(store, message), { status: 409 });
    assert.equal(store.list('messages').length, 0);
  } finally { store.close(); }
});
