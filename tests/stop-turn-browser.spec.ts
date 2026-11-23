import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('Web 主会话和项目消息旁的停止按钮只请求对应的输入', { timeout: 45000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-stop-ui-'));
  let started = 0, disconnected = 0;
  const model = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    for await (const _ of req) { /* Drain the test request before holding the stream. */ }
    started++;
    res.on('close', () => disconnected++);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address();
  assert.ok(address && typeof address !== 'string');
  const token = 'stop-browser-fixture';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, token, demo: false,
    model: { provider: 'openai-compatible', model: 'fixture', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1` } });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => {
    await browser.close(); model.closeAllConnections(); await server.close();
    await new Promise<void>(resolve => model.close(() => resolve())); await rm(dataDir, { recursive: true, force: true });
  });
  const project = server.app.projects.create({ name: '合成中断项目' });
  const main = await server.app.agent.post('核对主会话输入');
  const work = await server.app.projectWorkspace.post(project.id, '核对项目输入');
  await expect.poll(() => started).toBe(2);
  const page = await browser.newPage();
  const posts: string[] = [];
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/stop')) posts.push(new URL(req.url()).pathname); });
  await page.goto(server.url + '/#chat?token=' + token);
  for (const [index, message] of [main, work].entries()) {
    if (index) await page.goto(server.url + '/#projects/' + project.id + '/workspace');
    const input = page.locator('.msg--user').filter({ hasText: message.text });
    const stop = input.getByRole('button', { name: '停止本轮', exact: true });
    if (!index) {
      await page.route('**/messages/*/stop', route => route.abort(), { times: 1 });
      await stop.click();
      await expect(input).toContainText('停止结果未知');
      assert.equal(started, 2);
      assert.equal(disconnected, 0);
    }
    await stop.click();
    await expect.poll(() => disconnected).toBe(index + 1);
    await expect.poll(() => server.app.store.get<Message>('messages', message.id)?.status).toBe('failed');
    await expect(stop).toHaveCount(0);
    await expect(input).toContainText('已停止本轮');
    if (!index) assert.equal(server.app.store.get<Message>('messages', work.id)?.status, 'pending');
  }
  assert.deepEqual(posts, ['/api/v1/messages/' + main.id + '/stop', '/api/v1/messages/' + main.id + '/stop', '/api/v1/projects/' + project.id + '/messages/' + work.id + '/stop']);
});
