import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

test('主对话和项目工作会话独立恢复引用，发送时逐行引用原文，停用后仅发送正文', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-message-quotes-'));
  const token = 'quote-browser-fixture';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let node: ReturnType<typeof startAgentNode> | undefined;
  t.after(async () => { await browser?.close(); await node?.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const cwd = join(dir, 'project'), machineId = 'quote-fixture-node';
  await mkdir(cwd);
  const discovery = createProjectDiscovery({ home: dir, cwd, roots: [], temporaryRoots: [], ignoreEnvironmentRoots: true });
  node = startAgentNode({ url: server.url, token, machineId, name: '合成引用测试电脑', dataDir: join(dir, 'node'),
    handlers: { 'workspace.directory': discovery.handlers['workspace.directory'] }, executors: [] });
  await expect.poll(() => server.machines.list().some(m => m.id === machineId && m.online)).toBe(true);
  const project = await server.app.createProject({ name: '合成引用项目', workspace: { machineId, cwd } });
  const projectConversation = 'project:' + project.id + ':work';
  const mainOriginal = '本周结论\n**原始格式**仍保留。', projectOriginal = '工作记录\n第二项已核对。';
  const seed = (message: Omit<Message, 'createdAt' | 'status'>) => server.app.store.put('messages', message.id, {
    ...message, createdAt: new Date().toISOString(), status: 'done',
  });
  seed({ id: 'quote-main-original', conversationId: 'main', role: 'assistant', text: mainOriginal });
  seed({ id: 'quote-work-original', conversationId: projectConversation, projectId: project.id, role: 'user', text: projectOriginal });
  const sent = (conversationId: string) => server.app.store.list<Message>('messages')
    .filter(m => m.conversationId === conversationId && m.role === 'user' && m.id !== 'quote-work-original').map(m => m.text);

  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#chat?token=' + token);
  const chat = page.locator('#chat'), workspace = page.locator('#panel-workspace');
  const mainPreview = chat.locator('[data-message-quote]'), workPreview = workspace.locator('[data-message-quote]');
  const mainQuote = chat.locator('#messages [data-id="quote-main-original"]').getByRole('button', { name: '引用消息', exact: true });
  const projectQuote = workspace.locator('.msg--user').filter({ hasText: '工作记录' }).getByRole('button', { name: '引用消息', exact: true });
  const mainInput = chat.getByLabel('给 Agent 的消息'), projectInput = workspace.getByLabel('项目目标');
  const scope = chat.getByLabel('项目范围'), projectUrl = server.url + '/#projects/' + project.id + '/workspace';
  await mainInput.fill('请补充依据。');
  await mainQuote.click();
  await expect(mainPreview).toContainText('本周结论');
  await chat.getByRole('button', { name: '移除引用' }).click();
  await expect(mainPreview).toBeHidden();
  await expect(mainInput).toHaveValue('请补充依据。');
  await page.reload();
  await expect(mainQuote).toBeVisible();
  await expect(mainPreview).toBeHidden();
  await mainQuote.click();
  await page.reload();
  await expect(mainPreview).toContainText('本周结论');
  await expect(mainInput).toHaveValue('请补充依据。');
  await scope.selectOption(project.id);
  await expect(mainPreview).toBeHidden();
  await scope.selectOption('');
  await expect(mainPreview).toContainText('本周结论');

  await page.goto(projectUrl);
  await expect(projectQuote).toBeVisible();
  await expect(workPreview).toBeHidden();
  await projectQuote.click();
  await expect(workPreview).toContainText('工作记录');
  await workspace.getByRole('button', { name: '移除引用' }).click();
  await expect(workPreview).toBeHidden();
  await projectQuote.click();
  await projectInput.fill('请记录下一步。');
  await page.reload();
  await expect(workPreview).toContainText('工作记录');
  await expect(projectInput).toHaveValue('请记录下一步。');
  await page.goto(server.url + '/#chat');
  await scope.selectOption('');
  await expect(mainPreview).toContainText('本周结论');
  assert.deepEqual(sent('main'), []);
  assert.deepEqual(sent(projectConversation), []);
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => sent('main')).toEqual(['> 本周结论\n> **原始格式**仍保留。\n\n请补充依据。']);
  await expect(mainPreview).toBeHidden();
  const mainDetails = chat.locator('.msg--user details.message-quote');
  await expect(mainDetails.locator('p')).toBeHidden();
  await mainDetails.locator('summary').click();
  await expect(mainDetails.locator('p')).toBeVisible();
  assert.equal(await mainDetails.locator('p').textContent(), mainOriginal);
  await page.goto(projectUrl);
  await expect(workPreview).toContainText('工作记录');
  await workspace.getByRole('button', { name: '发送目标', exact: true }).click();
  await expect.poll(() => sent(projectConversation)).toEqual(['> 工作记录\n> 第二项已核对。\n\n请记录下一步。']);
  await expect(workPreview).toBeHidden();
  const workDetails = workspace.locator('.msg--user details.message-quote');
  await workDetails.locator('summary').click();
  await expect(workDetails.locator('p')).toBeVisible();
  assert.equal(await workDetails.locator('p').textContent(), projectOriginal);
  await page.reload();
  await expect(projectInput).toHaveValue('');
  await expect(workPreview).toBeHidden();

  await page.goto(server.url + '/#chat');
  await scope.selectOption('');
  await mainQuote.click();
  await expect(mainPreview).toContainText('本周结论');
  await mainInput.fill('普通正文。');
  const disabled = await page.request.post(server.url + '/api/v1/plugins/conversation-quotes', {
    headers: { Authorization: 'Bearer ' + token }, data: { enabled: false },
  });
  assert.ok(disabled.ok());
  await expect(mainQuote).toHaveCount(0);
  await expect(mainPreview).toBeHidden();
  await expect(mainInput).toHaveValue('普通正文。');
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => sent('main').at(-1)).toBe('普通正文。');
  await page.goto(projectUrl);
  await expect(projectInput).toBeVisible();
  await expect(workspace.getByRole('button', { name: '引用消息' })).toHaveCount(0);
});
