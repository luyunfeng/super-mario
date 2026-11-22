import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('主对话与项目消息可收藏，下载的备份可预览并恢复，停用插件收回入口', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-favorites-browser-'));
  const token = 'favorites-browser-fixture';
  const server = await startServer({ dataDir: dir, host: '127.0.0.1', port: 0, demo: true, token });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const project = server.app.projects.create({ name: '合成归档项目' });
  const mainText = '主对话归档验收样例';
  const projectText = '合成项目阶段结论';
  const put = (message: Omit<Message, 'createdAt' | 'status'>) => server.app.store.put('messages', message.id, {
    ...message, createdAt: '2026-03-01T10:00:00.000Z', status: 'done',
  });
  put({ id: 'main-favorite', role: 'user', conversationId: 'main', text: mainText });
  put({ id: 'project-favorite', role: 'assistant', projectId: project.id, conversationId: `project:${project.id}:work`, text: projectText });
  put({ id: 'outside-fixture', role: 'assistant', projectId: project.id, conversationId: `project:${project.id}:memory`, text: '项目记忆隔离样例' });

  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const open = page.getByRole('button', { name: '消息收藏', exact: true });
  const drawer = page.getByRole('dialog', { name: '消息收藏', exact: true });
  const button = (name: string) => drawer.getByRole('button', { name, exact: true });

  await page.goto(server.url + '/#chat?token=' + token);
  const main = page.locator('#messages [data-id="main-favorite"]');
  await main.getByRole('button', { name: '收藏消息', exact: true }).click();
  await expect(main.getByRole('button', { name: '已收藏', exact: true })).toBeVisible();
  await page.goto(server.url + `/#projects/${project.id}/workspace`);
  const projectLog = page.getByRole('log', { name: '项目对话' });
  await expect(projectLog).toContainText(projectText);
  await projectLog.getByRole('button', { name: '收藏消息', exact: true }).click();
  await expect(projectLog.getByRole('button', { name: '已收藏', exact: true })).toBeVisible();
  await open.click();
  const remove = button('取消收藏');
  await expect(remove).toHaveCount(2);
  await expect(drawer).toContainText(mainText);
  await expect(drawer).toContainText(projectText);
  await expect(drawer).not.toContainText('项目记忆隔离样例');
  const search = drawer.getByLabel('搜索收藏');
  await search.fill('合成项目');
  await expect(remove).toHaveCount(1);
  await button('查看原文').click();
  await expect(drawer.getByText('消息原文', { exact: true })).toBeVisible();
  await expect(drawer.getByText(projectText, { exact: true })).toHaveCount(2);
  await search.fill('');
  await expect(remove).toHaveCount(2);

  const pending = page.waitForEvent('download');
  await button('下载收藏备份').click();
  const download = await pending;
  assert.match(download.suggestedFilename(), /\.json$/);
  const backupPath = join(dir, 'fixture-favorites.json');
  await download.saveAs(backupPath);
  const backup = await readFile(backupPath, 'utf8');
  const payload = JSON.parse(backup);
  assert.equal(payload.format, 'super-mario.message-favorites');
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.messages.map((message: { text: string }) => message.text).sort(), [mainText, projectText].sort());
  assert.doesNotMatch(backup, /项目记忆隔离样例|outside-fixture|messageId|projectId/);

  await remove.first().click();
  await expect(remove).toHaveCount(1);
  await remove.click();
  await expect(remove).toHaveCount(0);
  await drawer.getByLabel('导入收藏备份', { exact: true }).setInputFiles(backupPath);
  await expect(button('确认恢复')).toBeEnabled();
  await expect(remove).toHaveCount(0);
  await button('确认恢复').click();
  await expect(remove).toHaveCount(2);
  await expect(drawer).toContainText(mainText);
  await expect(drawer).toContainText(projectText);

  const disabled = await fetch(server.url + '/api/v1/plugins/message-favorites', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.ok(disabled.ok);
  await expect(drawer).toBeHidden();
  await expect(open).toHaveCount(0);
  await expect(projectLog.getByRole('button', { name: /收藏/ })).toHaveCount(0);
  await page.goto(server.url + '/#chat');
  await expect(main).toContainText(mainText);
  await expect(open).toHaveCount(0);
  await expect(main.getByRole('button', { name: /收藏/ })).toHaveCount(0);
  await page.getByRole('button', { name: '插件配置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '插件配置' });
  await settings.getByLabel('搜索插件').fill('message-favorites');
  const plugin = settings.getByRole('region', { name: '消息收藏' });
  await plugin.getByRole('button', { name: '启用', exact: true }).click();
  await expect(plugin.getByRole('button', { name: '停用', exact: true })).toBeVisible();
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  await open.click();
  await expect(remove).toHaveCount(2);
  await expect(button('查看原文')).toHaveCount(0);
  await button('关闭').click();
  await main.getByRole('button', { name: '收藏消息', exact: true }).click();
  await expect(main.getByRole('button', { name: '已收藏', exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
});

test('其他客户端修改收藏后旧预览返回 409，可复用同一备份重新预览并导出 Markdown', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-favorites-race-'));
  const token = 'favorite-conflict-fixture';
  const server = await startServer({ dataDir: dir, host: '127.0.0.1', port: 0, demo: true, token });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const createdAt = '2026-03-01T10:00:00.000Z';
  const liveText = '第二客户端收藏的样例';
  const archiveText = '归档摘要\n\n- 第一项\n- 第二项';
  server.app.store.put('messages', 'second-client-message', {
    id: 'second-client-message', role: 'user', conversationId: 'main', text: liveText, createdAt, status: 'done',
  });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const first = await browser.newPage();
  const second = await browser.newPage();
  for (const page of [first, second]) {
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    await page.goto(server.url + '/#chat?token=' + token);
  }

  await first.getByRole('button', { name: '消息收藏', exact: true }).click();
  const drawer = first.getByRole('dialog', { name: '消息收藏', exact: true });
  const button = (name: string) => drawer.getByRole('button', { name, exact: true });
  const file = drawer.getByLabel('导入收藏备份', { exact: true });
  const backup = {
    format: 'super-mario.message-favorites', version: 1,
    messages: [{
      key: '040e5baa-e678-4613-90fe-16cd1f1e0c16', title: '归档项目样例', role: 'assistant',
      text: archiveText, omitted: 0, createdAt, starredAt: createdAt,
    }],
  };
  await file.setInputFiles({
    name: 'portable.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(drawer).toContainText('待恢复 1 条');
  const live = second.locator('#messages [data-id="second-client-message"]');
  await live.getByRole('button', { name: '收藏消息', exact: true }).click();
  await expect(live.getByRole('button', { name: '已收藏', exact: true })).toBeVisible();

  const result = first.waitForResponse(response => response.url().endsWith('/api/v1/message-favorites')
    && response.request().postDataJSON()?.action === 'restore');
  await button('确认恢复').click();
  assert.equal((await result).status(), 409);
  await expect(drawer).toContainText('收藏列表已更改');
  await expect(drawer).toContainText(liveText);
  await expect(drawer).not.toContainText(archiveText);
  await expect(file).toHaveValue(/portable\.json$/);
  await button('重新预览').click();
  await expect(drawer).toContainText('待恢复 1 条');
  await button('确认恢复').click();
  await expect(button('取消收藏')).toHaveCount(2);

  const pending = first.waitForEvent('download');
  await button('下载 Markdown').click();
  const download = await pending;
  assert.match(download.suggestedFilename(), /\.md$/);
  const markdownPath = join(dir, 'favorites.md');
  await download.saveAs(markdownPath);
  const markdown = await readFile(markdownPath, 'utf8');
  assert.match(markdown, /^# 消息收藏\n/);
  assert.ok(markdown.includes('## 主对话') && markdown.includes(liveText));
  assert.ok(markdown.includes('## 归档项目样例') && markdown.includes(archiveText));
  assert.match(markdown, /恢复快照/);
});
