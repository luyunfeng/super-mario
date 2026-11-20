import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('项目设置查看真实存储的整理历史并跟踪状态变化', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-project-memory-'));
  const server = await startServer({ dataDir, token: 'test-memory', demo: true, port: 0, host: '127.0.0.1' });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      try { await server.close(); }
      finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  });
  const { app } = server;
  const { id } = app.projects.create({ name: '测试项目', memoryEnabled: false });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(`${server.url}/#projects/${id}/settings?token=test-memory`);
  await expect(page.getByRole('button', { name: '查看整理会话' })).toBeVisible();
  await page.getByRole('heading', { name: '记忆整理', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '记忆整理会话' });
  await expect(drawer.getByText('暂无整理会话消息。')).toBeVisible();
  const request = { id: 'input', projectId: id, role: 'user', text: '测试整理输入', conversationId: `project:${id}:memory`, status: 'pending', createdAt: new Date().toISOString() };
  app.store.put('messages', 'input', request);
  app.store.put('messages', 'other', { ...request, id: 'other', conversationId: 'project:other:memory', text: '其他项目材料' });
  app.store.put('project.memory', id, { projectId: id, enabled: false, status: 'running' });
  await expect(drawer.getByText('整理中', { exact: true })).toBeVisible();
  await drawer.getByText('查看请求原文').click();
  await expect(drawer.getByText('测试整理输入')).toBeVisible();
  app.store.put('messages', 'reply', { ...request, id: 'reply', role: 'assistant', status: 'done', text: '测试整理回复' });
  app.store.put('project.memory', id, { projectId: id, enabled: false, status: 'completed' });
  await expect(drawer.getByText('测试整理回复')).toBeVisible();
  await expect(drawer.getByText('已整理', { exact: true })).toBeVisible();
  await expect(drawer.getByText('其他项目材料')).toHaveCount(0);
});
