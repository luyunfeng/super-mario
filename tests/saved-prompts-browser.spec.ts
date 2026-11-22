import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

test('本人消息可保存为常用提示词，主对话和项目斜杠菜单只插入草稿，发送时保存编辑后的正文', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-saved-prompts-'));
  const cwd = join(dir, 'project');
  await mkdir(cwd);
  const token = 'saved-prompt-browser-fixture', machineId = 'fixture-prompts-node';
  const server = await startServer({ dataDir: join(dir, 'data'), host: '127.0.0.1', port: 0, demo: true, token });
  const projects = createProjectDiscovery({ home: dir, cwd, roots: [], temporaryRoots: [], ignoreEnvironmentRoots: true });
  const node = startAgentNode({ url: server.url, token, machineId, name: '合成项目电脑', dataDir: join(dir, 'node'),
    handlers: { 'workspace.directory': projects.handlers['workspace.directory'] }, executors: [] });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await node.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await expect.poll(() => server.machines.list().some(item => item.id === machineId && item.online)).toBe(true);
  const project = await server.app.createProject({ name: '合成提示词项目', workspace: { machineId, cwd } });
  const sourceText = '请总结本次讨论。';
  const template = '先列出进展。\n再列出待确认问题。';
  const userTexts = (conversation: string) => server.app.store.list<Message>('messages')
    .filter(m => m.conversationId === conversation && m.role === 'user').map(m => m.text);

  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const sent: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/v1\/(projects\/[^/]+\/)?messages$/.test(request.url())) {
      sent.push(request.postDataJSON().text);
    }
  });
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#chat?token=' + token);
  const main = page.getByLabel('给 Agent 的消息');
  await main.fill(sourceText);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const mine = page.locator('#messages .msg--user').filter({ hasText: sourceText });
  await mine.getByRole('button', { name: '保存为提示词', exact: true }).click();

  const drawer = page.getByRole('dialog', { name: '常用提示词', exact: true });
  const button = (name: string) => drawer.getByRole('button', { name, exact: true });
  const name = drawer.getByLabel('名称', { exact: true });
  const body = drawer.getByLabel('提示词正文', { exact: true });
  await expect(body).toHaveValue(sourceText);
  await name.fill('review');
  await button('保存').click();
  await button('编辑 review').click();
  await body.fill(template);
  await button('保存').click();
  await button('新增提示词').click();
  await name.fill('weekly');
  await body.fill('列出本周计划。');
  await button('保存').click();

  const editButtons = drawer.getByRole('button', { name: /^编辑 / });
  await expect(editButtons).toHaveCount(2);
  await expect(editButtons.first()).toHaveAccessibleName('编辑 review');
  await button('下移 review').click();
  await expect(editButtons.first()).toHaveAccessibleName('编辑 weekly');
  await expect(editButtons.last()).toHaveAccessibleName('编辑 review');
  await button('关闭').click();
  await expect(page.locator('dialog.drawer')).toHaveCount(0);
  await expect(page.locator('#messages .msg--assistant').first()).toBeVisible();
  await expect(page.locator('#messages .msg--assistant').getByRole('button', { name: '保存为提示词' })).toHaveCount(0);

  await main.fill('/rev');
  await expect(page.getByRole('button', { name: '/review', exact: true })).toBeVisible();
  await main.press('Enter');
  await expect(main).toHaveValue(template);
  assert.deepEqual(sent, [sourceText]);
  assert.deepEqual(userTexts('main'), [sourceText]);
  const mainFinal = template + '\n补充主对话结论。';
  await main.fill(mainFinal);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => userTexts('main')).toEqual([sourceText, mainFinal]);

  await page.goto(server.url + `/#projects/${project.id}/workspace`);
  const projectInput = page.getByLabel('项目目标');
  await projectInput.fill('/rev');
  await page.getByRole('button', { name: '/review', exact: true }).click();
  await expect(projectInput).toHaveValue(template);
  const projectConversation = `project:${project.id}:work`;
  assert.deepEqual(sent, [sourceText, mainFinal]);
  assert.deepEqual(userTexts(projectConversation), []);
  const projectFinal = template + '\n只处理合成项目。';
  await projectInput.fill(projectFinal);
  await page.getByRole('button', { name: '发送目标', exact: true }).click();
  await expect.poll(() => userTexts(projectConversation)).toEqual([projectFinal]);
  assert.deepEqual(sent, [sourceText, mainFinal, projectFinal]);

  await expect(projectInput).toHaveValue('');
  await page.reload();
  await expect(projectInput).toBeEnabled();
  await projectInput.press('ArrowUp');
  await expect(projectInput).toHaveValue(projectFinal);
  await projectInput.press('ArrowDown');
  await expect(projectInput).toHaveValue('');
  await projectInput.fill('正在编辑的草稿');
  await projectInput.press('ArrowUp');
  await expect(projectInput).toHaveValue('正在编辑的草稿');
  await projectInput.press('Control+r');
  const search = page.getByRole('dialog', { name: '已发送内容' });
  await search.getByLabel('搜索已发送内容').fill('补充 进展');
  await expect(search.getByRole('button', { name: /补充主对话结论/ })).toBeVisible();
  await search.getByLabel('搜索已发送内容').press('Escape');
  await expect(projectInput).toHaveValue('正在编辑的草稿');
  await projectInput.press('Control+r');
  await search.getByLabel('搜索已发送内容').fill('补充 进展');
  await search.getByLabel('搜索已发送内容').press('Enter');
  await expect(projectInput).toHaveValue(mainFinal);
  assert.deepEqual(sent, [sourceText, mainFinal, projectFinal]);

  await page.getByRole('button', { name: '常用提示词', exact: true }).click();
  await expect(editButtons.first()).toHaveAccessibleName('编辑 weekly');
  await expect(editButtons.last()).toHaveAccessibleName('编辑 review');
  await button('删除 weekly').click();
  await button('取消 weekly').click();
  await expect(editButtons).toHaveCount(2);
  await button('删除 weekly').click();
  await button('确认删除 weekly').click();
  await expect(editButtons).toHaveCount(1);
  await expect(editButtons).toHaveAccessibleName('编辑 review');
  await button('关闭').click();
  await expect(page.locator('dialog.drawer')).toHaveCount(0);
  await projectInput.fill('/rev');
  const suggestion = page.getByRole('button', { name: '/review', exact: true });
  await expect(suggestion).toBeVisible();
  const disabled = await page.request.post(server.url + '/api/v1/plugins/saved-prompts', {
    headers: { Authorization: 'Bearer ' + token }, data: { enabled: false },
  });
  assert.ok(disabled.ok());
  await expect(suggestion).toHaveCount(0);
  await expect(page.getByRole('button', { name: '常用提示词', exact: true })).toHaveCount(0);
  await expect(projectInput).toHaveValue('/rev');
  assert.deepEqual(sent, [sourceText, mainFinal, projectFinal]);
});

test('插件设置可管理提示词；并发编辑保留草稿，已打开的斜杠菜单收到其他客户端的更新', { timeout: 30000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-saved-prompts-conflict-'));
  const token = 'prompt-conflict-fixture';
  const server = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, token });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const first = await browser.newPage(), second = await browser.newPage();
  for (const page of [first, second]) {
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    await page.goto(server.url + '/#chat?token=' + token);
  }
  await first.getByRole('button', { name: '插件配置', exact: true }).click();
  const settings = first.getByRole('dialog', { name: '插件配置' });
  await settings.getByLabel('搜索插件').fill('saved-prompts');
  await settings.getByRole('button', { name: '管理常用提示词', exact: true }).click();
  const left = first.getByRole('dialog', { name: '常用提示词', exact: true });
  const right = second.getByRole('dialog', { name: '常用提示词', exact: true });
  const leftBody = left.getByLabel('提示词正文');
  await left.getByRole('button', { name: '新增提示词' }).click();
  await left.getByLabel('名称', { exact: true }).fill('draft');
  await leftBody.fill('初稿。');
  await left.getByRole('button', { name: '保存', exact: true }).click();
  await left.getByRole('button', { name: '编辑 draft' }).click();
  await leftBody.fill('第一窗口的未保存草稿。');

  await second.getByRole('button', { name: '常用提示词', exact: true }).click();
  await right.getByRole('button', { name: '编辑 draft' }).click();
  const rightBody = right.getByLabel('提示词正文');
  await rightBody.fill('第二窗口提交的版本。');
  await right.getByRole('button', { name: '保存', exact: true }).click();
  await expect(right).toContainText('第二窗口提交的版本。');
  await expect(left.getByRole('button', { name: '刷新列表' })).toBeVisible();
  await expect(leftBody).toHaveValue('第一窗口的未保存草稿。');

  const conflict = first.waitForResponse(r => r.url().endsWith('/api/v1/saved-prompts') && r.request().postDataJSON()?.action === 'update');
  await left.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal((await conflict).status(), 409);
  await expect(left.getByRole('alert')).toContainText('已更新');
  await expect(leftBody).toHaveValue('第一窗口的未保存草稿。');
  await left.getByRole('button', { name: '刷新列表' }).click();
  await expect(leftBody).toHaveValue('第一窗口的未保存草稿。');
  await left.getByRole('button', { name: '取消', exact: true }).click();
  await expect(left).toContainText('第二窗口提交的版本。');
  await left.getByRole('button', { name: '删除 draft', exact: true }).click();
  await expect(left.getByRole('button', { name: '确认删除 draft' })).toBeVisible();
  await right.getByRole('button', { name: '编辑 draft' }).click();
  await rightBody.fill('删除确认期间由第二窗口更新。');
  await right.getByRole('button', { name: '保存', exact: true }).click();
  await expect(left).toContainText('删除确认期间由第二窗口更新。');
  await expect(left.getByRole('button', { name: '确认删除 draft' })).toHaveCount(0);
  await left.getByRole('button', { name: '关闭', exact: true }).click();
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(first.locator('dialog.drawer')).toHaveCount(0);

  const input = first.getByLabel('给 Agent 的消息');
  await input.fill('/');
  const oldItem = first.getByRole('button', { name: '/draft', exact: true });
  await expect(oldItem).toBeVisible();
  await right.getByRole('button', { name: '编辑 draft' }).click();
  await right.getByLabel('名称', { exact: true }).fill('release');
  await rightBody.fill('改名后的提示词正文。');
  await right.getByRole('button', { name: '保存', exact: true }).click();
  const updatedItem = first.getByRole('button', { name: '/release', exact: true });
  await expect(updatedItem).toBeVisible();
  await expect(oldItem).toHaveCount(0);
  await expect(input).toHaveValue('/');
  await updatedItem.click();
  await expect(input).toHaveValue('改名后的提示词正文。');

  // A later exact match must still be found beyond the bare slash menu's display limit.
  const manage = (data: Record<string, unknown>) => first.request.post(server.url + '/api/v1/saved-prompts', {
    headers: { authorization: 'Bearer ' + token }, data,
  });
  const list = await manage({ action: 'list' });
  let { revision } = await list.json();
  const names = ['xplan', 'plan-beta', 'plan-alpha', ...Array.from({ length: 24 }, (_, i) => 'item-' + i), 'plan'];
  for (const name of names) {
    const response = await manage({ action: 'create', revision, name, text: '正文 ' + name });
    assert.equal(response.status(), 200);
    revision = (await response.json()).revision;
  }
  await input.fill('/');
  const rows = first.getByRole('group', { name: '提示词候选' }).getByRole('button');
  await expect(rows).toHaveCount(25);
  await input.fill('/PLAN');
  await expect(rows).toHaveText(['/plan', '/plan-beta', '/plan-alpha', '/xplan']);
  await input.press('Enter');
  await expect(input).toHaveValue('正文 plan');
});
