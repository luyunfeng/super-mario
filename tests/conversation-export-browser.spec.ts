import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect, type Locator, type Page } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

async function downloadMarkdown(page: Page, drawer: Locator) {
  const pending = page.waitForEvent('download');
  await drawer.getByRole('button', { name: '下载 .md', exact: true }).click();
  const download = await pending;
  assert.match(download.suggestedFilename(), /\.md$/);
  const path = await download.path();
  assert.ok(path);
  const markdown = await readFile(path, 'utf8');
  assert.equal(markdown, await drawer.getByLabel('Markdown 预览').textContent());
  return markdown;
}

test('从主对话和项目工作区导出完整 Markdown，并通过插件配置停用和恢复入口', {timeout: 45000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-conversation-export-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token: 'export-browser-fixture' });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => {
    await browser.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  const page = await context.newPage();
  const project = server.app.projects.create({ name: '合成项目甲' });
  const other = server.app.projects.create({ name: '合成项目乙' });
  const createdAt = '2026-01-01T12:00:00.000Z';
  const put = (message: Omit<Message, 'createdAt'>) =>
    server.app.store.put('messages', message.id, { createdAt, ...message });

  const mainText = '主对话的独立正文\n\n- 保留 Markdown 换行';
  put({ id: 'main-reply', conversationId: 'main', role: 'assistant', text: mainText, projectId: project.id,
    progress: { phase: 'responding', observedAt: createdAt, detail: '内部详情标记' } });
  const projectTexts = Array.from({ length: 64 }, (_, index) => '项目甲历史消息-' + String(index + 1).padStart(3, '0'));
  for (const [index, text] of projectTexts.entries()) {
    put({ id: 'project-' + index, conversationId: `project:${project.id}:work`, projectId: project.id, role: index % 2 ? 'assistant' : 'user', text });
  }
  put({ id: 'other', conversationId: `project:${other.id}:work`, projectId: other.id, role: 'user', text: '其他项目隔离标记' });
  put({ id: 'memory', conversationId: `project:${project.id}:memory`, projectId: project.id, role: 'assistant', text: '项目记忆隔离标记' });

  const profile = await page.request.post(server.url + '/api/v1/assistant-profile', {
    headers: { authorization: 'Bearer export-browser-fixture' }, data: { action: 'save', revision: 0, name: '合成工作助手' },
  });
  assert.ok(profile.ok());
  await page.goto(server.url + '/#chat?token=export-browser-fixture');
  await page.locator('#message-form').getByLabel('项目范围', { exact: true }).selectOption(project.id);
  const open = page.getByRole('button', { name: '导出对话', exact: true });
  const drawer = page.getByRole('dialog', { name: '导出对话', exact: true });
  const steps = drawer.getByRole('checkbox', { name: '包含公开工作步骤' });
  await open.click();
  await expect(steps).not.toBeChecked();
  const plain = await downloadMarkdown(page, drawer);
  assert.ok(plain.includes(mainText));
  assert.match(plain, /## 合成工作助手 ·/);
  assert.match(plain, /导出时间：\d{4}-.*Z/);
  assert.doesNotMatch(plain, /项目甲历史消息|隔离标记|内部详情标记|正在输出/);
  await steps.check();
  await expect(drawer.getByLabel('Markdown 预览')).toContainText('正在输出');
  const expanded = await downloadMarkdown(page, drawer);
  assert.ok(expanded.includes(mainText));
  assert.doesNotMatch(expanded, /项目甲历史消息|隔离标记|内部详情标记/);
  await drawer.getByRole('button', { name: '复制 Markdown' }).click();
  await expect(drawer.getByRole('status')).toContainText('已复制');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expanded);
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();

  await page.goto(server.url + `/#projects/${project.id}/workspace`);
  const log = page.getByRole('log', { name: '项目对话' });
  await expect(log).toContainText(projectTexts.at(-1)!);
  await expect(log).not.toContainText(projectTexts[0]);
  await open.click();
  const projectMarkdown = await downloadMarkdown(page, drawer);
  assert.deepEqual(projectMarkdown.match(/项目甲历史消息-\d+/g), projectTexts);
  assert.doesNotMatch(projectMarkdown, /主对话的独立正文|隔离标记/);
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();

  async function togglePlugin(action: '停用' | '启用') {
    await page.getByRole('button', { name: '插件配置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '插件配置' });
    await settings.getByLabel('搜索插件').fill('conversation-export');
    const plugin = settings.getByRole('region', { name: '对话导出' });
    await plugin.getByRole('button', { name: action, exact: true }).click();
    await expect(plugin.getByRole('button', { name: action === '停用' ? '启用' : '停用', exact: true })).toBeVisible();
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
  }
  await togglePlugin('停用');
  await expect(open).toHaveCount(0);
  await page.goto(server.url + '/#chat');
  await expect(page.locator('#message-text')).toBeVisible();
  await expect(open).toHaveCount(0);
  await togglePlugin('启用');
  await open.click();
  await expect(drawer.getByLabel('Markdown 预览')).toContainText('主对话的独立正文');
});
