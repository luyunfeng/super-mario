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
  await button('定位到原会话').click();
  await expect(projectLog.locator('.is-search-hit')).toContainText(projectText);
  await open.click();
  await search.fill(mainText);
  const switchedOff = await fetch(server.url + '/api/v1/plugins/conversation-search', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.ok(switchedOff.ok);
  await button('定位到原会话').click();
  await expect(main).toHaveClass(/is-search-hit/);
  await page.reload();
  await expect(main).toBeFocused();
  await open.click();
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

  server.app.store.remove('messages', 'project-favorite');
  await search.fill(projectText);
  await button('定位到原会话').click();
  await expect(drawer.getByRole('status')).toContainText('没有这条消息');
  await expect(drawer.locator('pre')).toHaveText(projectText);
  await search.fill('');
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
  await page.goto(server.url + '/#projects/' + project.id + '/workspace');
  await expect(projectLog.getByRole('button', { name: /收藏/ })).toHaveCount(0);
  await page.goto(server.url + '/#chat');
  await expect(main).toContainText(mainText);
  await page.goto(server.url + '/#chat?favorite=main-favorite');
  await expect(page.getByText('「消息收藏」插件当前不可用，无法定位原消息。')).toBeVisible();
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
  await expect(button('定位到原会话')).toHaveCount(0);
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
  // The other page's write refreshes the open list without replacing the staged import.
  await expect(drawer).toContainText(liveText);
  await expect(button('确认恢复')).toBeEnabled();

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

  await button('关闭').click();
  const same = first.locator('#messages [data-id="second-client-message"]');
  await expect(same.getByRole('button', { name: '已收藏', exact: true })).toBeVisible();
  await live.getByRole('button', { name: '已收藏', exact: true }).click();
  await expect(same.getByRole('button', { name: '收藏消息', exact: true })).toBeVisible();
  await live.getByRole('button', { name: '收藏消息', exact: true }).click();
  await expect(same.getByRole('button', { name: '已收藏', exact: true })).toBeVisible();
});

test('收藏分批显示，搜索覆盖折叠及未显示的快照，复制与下载保留完整正文', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-favorites-pages-'));
  const token = 'local-favorites-pages', server = await startServer({ dataDir: dir, host: '127.0.0.1', port: 0, demo: true, token });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  // The oldest message is on the third batch. Its searchable term is on line seven.
  const sixLines = Array.from({ length: 6 }, (_, n) => '第 ' + (n + 1) + ' 行').join('\n');
  const oldest = sixLines + '\nＲＥＰＯＲＴ批注仅在最后一行';
  const unicodePreview = '甲'.repeat(419) + '𠮷';
  const messages = Array.from({ length: 50 }, (_, n) => {
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
    return { key: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), title: '收藏样例-' + n,
      role: n % 2 ? 'user' : 'assistant', text: n === 0 ? oldest : n === 49 ? unicodePreview + '末尾' : '已保存的正文-' + n,
      omitted: 0, createdAt: n === 0 ? null : stamp, starredAt: stamp };
  });
  const backup = { format: 'super-mario.message-favorites', version: 1, messages };
  const imported = await fetch(server.url + '/api/v1/message-favorites', { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'restore', backup, revision: 0 }),
  });
  assert.equal(imported.status, 200, await imported.clone().text());
  assert.equal((await imported.json()).toAdd, 50);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ permissions: ['clipboard-read', 'clipboard-write'] });
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#chat?token=' + token);
  await page.getByRole('button', { name: '消息收藏', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '消息收藏' });
  const cards = drawer.getByRole('article');
  const row = (n: number) => cards.filter({ has: page.getByText('收藏样例-' + n, { exact: true }) });
  const more = drawer.getByRole('button', { name: '显示更多消息' });
  const search = drawer.getByLabel('搜索收藏');
  await expect(cards).toHaveCount(24);
  await expect(row(0)).toHaveCount(0);
  const long = row(49);
  assert.equal(await long.locator('pre').textContent(), unicodePreview);
  const expand = long.getByRole('button', { name: '显示已保存的全文' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();
  assert.equal(await long.locator('pre').textContent(), messages[49]!.text);
  const collapse = long.getByRole('button', { name: '收起', exact: true });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();
  await more.click();
  await expect(cards).toHaveCount(48);
  await more.click();
  await expect(cards).toHaveCount(50);
  await expect(more).toHaveCount(0);
  await search.fill('收藏样例');
  await expect(cards).toHaveCount(24);
  await expect(more).toBeVisible();

  await search.fill('report 助手 收藏样例');
  await expect(cards).toHaveCount(1);
  const old = row(0);
  assert.equal(await old.locator('pre').textContent(), sixLines);
  await expect(old).toContainText(messages[0]!.starredAt);
  await expect(old.getByRole('button', { name: '显示已保存的全文' })).toHaveAttribute('aria-expanded', 'false');
  await old.getByRole('button', { name: '复制正文' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(oldest);

  const pending = page.waitForEvent('download');
  await drawer.getByRole('button', { name: '下载 Markdown' }).click();
  const path = await (await pending).path();
  assert.ok(path);
  const markdown = await readFile(path, 'utf8');
  assert.equal(markdown.split('\n').filter(line => line.startsWith('## 收藏样例-')).length, 50);
  for (const entry of messages) assert.ok(markdown.includes(entry.text));

  await old.getByRole('button', { name: '取消收藏' }).click();
  await expect(cards).toHaveCount(0);
  await expect(drawer).toContainText('没有匹配的收藏');
  await expect(search).toBeFocused();
  await search.fill('');
  await expect(cards).toHaveCount(24);
  await expect(more).toBeVisible();
});
