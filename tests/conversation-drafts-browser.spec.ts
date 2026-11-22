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

test('主对话各个项目范围和项目工作会话独立恢复草稿，发送回执只清除已发送的原稿', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-draft-scopes-'));
  const token = 'draft-scope-fixture';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let node: ReturnType<typeof startAgentNode> | undefined;
  t.after(async () => { await browser?.close(); await node?.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const cwd = join(dir, 'project'), machineId = 'draft-fixture-node';
  await mkdir(cwd);
  const discovery = createProjectDiscovery({ home: dir, cwd, roots: [], temporaryRoots: [], ignoreEnvironmentRoots: true });
  node = startAgentNode({ url: server.url, token, machineId, name: '草稿测试电脑', dataDir: join(dir, 'node'),
    handlers: { 'workspace.directory': discovery.handlers['workspace.directory'] }, executors: [] });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  await expect.poll(() => server.machines.list().some(m => m.id === machineId && m.online)).toBe(true);
  const alpha = await server.app.createProject({ name: '草稿项目甲', workspace: { machineId, cwd } });
  const beta = server.app.projects.create({ name: '草稿项目乙' });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#chat?token=' + token);
  const main = page.getByLabel('给 Agent 的消息'), work = page.getByLabel('项目目标');
  const scope = page.locator('#message-form').getByLabel('项目范围');
  const send = page.getByRole('button', { name: '发送', exact: true });
  const projectSend = page.getByRole('button', { name: '发送目标', exact: true });
  const gotoWork = (id: string) => page.goto(server.url + '/#projects/' + id + '/workspace');
  const userMessages = (id: string) => server.app.store.list<Message>('messages')
    .filter(m => m.conversationId === id && m.role === 'user').map(m => m.text);
  await expect(send).toBeEnabled();
  await main.fill('全局草稿\n保留换行。');
  await page.reload();
  await expect(main).toHaveValue('全局草稿\n保留换行。');
  await scope.selectOption(alpha.id);
  await expect(main).toHaveValue('');
  await main.fill('项目甲的主对话草稿');
  await scope.selectOption(beta.id);
  await expect(main).toHaveValue('');
  await main.fill('项目乙的主对话草稿');
  await gotoWork(alpha.id);
  await expect(work).toHaveValue('');
  await work.fill('项目甲工作会话原稿');
  await gotoWork(beta.id);
  await expect(work).toHaveValue('');
  await work.fill('项目乙的工作会话草稿');
  await page.reload();
  await expect(work).toHaveValue('项目乙的工作会话草稿');
  await gotoWork(alpha.id);
  await expect(work).toHaveValue('项目甲工作会话原稿');

  // 服务已经写入消息，仅延迟浏览器收到的 HTTP 回执。
  const projectPost = '**/api/v1/projects/' + alpha.id + '/messages';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(projectPost, async route => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  const success = page.waitForResponse(r => r.url().endsWith('/' + alpha.id + '/messages') && r.request().method() === 'POST');
  await projectSend.click();
  try {
    await expect.poll(() => userMessages('project:' + alpha.id + ':work')).toEqual(['项目甲工作会话原稿']);
    await work.fill('迟到回执期间输入的新草稿');
  } finally { release(); }
  assert.ok((await success).ok());
  await expect(projectSend).toBeEnabled();
  await expect(work).toHaveValue('迟到回执期间输入的新草稿');
  await page.unroute(projectPost);
  await page.reload();
  await expect(work).toHaveValue('迟到回执期间输入的新草稿');
  await projectSend.click();
  await expect(work).toHaveValue('');
  await page.reload();
  await expect(projectSend).toBeEnabled();
  await expect(work).toHaveValue('');
  assert.deepEqual(userMessages('project:' + alpha.id + ':work'), ['项目甲工作会话原稿', '迟到回执期间输入的新草稿']);

  await page.goto(server.url + '/#chat');
  await scope.selectOption(alpha.id);
  await expect(main).toHaveValue('项目甲的主对话草稿');
  await scope.selectOption(beta.id);
  await expect(main).toHaveValue('项目乙的主对话草稿');
  await scope.selectOption('');
  await expect(main).toHaveValue('全局草稿\n保留换行。');
  await page.route('**/api/v1/messages', route => route.fulfill({ status: 409, json: { error: '合成拒绝' } }));
  await send.click();
  await expect(page.locator('#message-form')).toContainText('合成拒绝');
  await expect(main).toHaveValue('全局草稿\n保留换行。');
  assert.deepEqual(userMessages('main'), []);
  await page.unroute('**/api/v1/messages');
  await page.reload();
  await expect(main).toHaveValue('全局草稿\n保留换行。');
  // 只增加空格仍是一次编辑。服务会裁剪发送正文，草稿匹配必须比较原始输入。
  let acknowledge!: () => void;
  const pendingReceipt = new Promise<void>(resolve => { acknowledge = resolve; });
  await page.route('**/api/v1/messages', async route => {
    const response = await route.fetch();
    await pendingReceipt;
    await route.fulfill({ response });
  });
  const mainReceipt = page.waitForResponse(r => r.url().endsWith('/api/v1/messages') && r.request().method() === 'POST');
  await send.click();
  try {
    await expect.poll(() => userMessages('main')).toEqual(['全局草稿\n保留换行。']);
    await main.fill('全局草稿\n保留换行。 ');
  } finally { acknowledge(); }
  assert.ok((await mainReceipt).ok());
  await expect(send).toBeEnabled();
  await expect(main).toHaveValue('全局草稿\n保留换行。 ');
  await page.unroute('**/api/v1/messages');
  await page.reload();
  await expect(main).toHaveValue('全局草稿\n保留换行。 ');
  await send.click();
  await expect(main).toHaveValue('');
  assert.deepEqual(userMessages('main'), ['全局草稿\n保留换行。', '全局草稿\n保留换行。']);
  await page.reload();
  await expect(send).toBeEnabled();
  await expect(main).toHaveValue('');
});

test('同一浏览器和服务地址更换凭据后隔离草稿，关闭插件后编辑不会持久化', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-draft-identity-'));
  const first = 'draft-first-fixture', second = 'draft-second-fixture';
  const start = (token: string, port = 0) => startServer({ host: '127.0.0.1', port, dataDir: dir, token, demo: true });
  let server = await start(first);
  const url = server.url, port = Number(new URL(url).port);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => { await browser?.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  const input = page.getByLabel('给 Agent 的消息');
  const send = page.getByRole('button', { name: '发送', exact: true });
  const enter = async (token: string) => {
    await page.goto(url + '/#chat?token=' + token);
    await expect(send).toBeEnabled();
  };
  await enter(first);
  await input.fill('第一个凭据的私人草稿');
  await page.reload();
  await expect(input).toHaveValue('第一个凭据的私人草稿');
  // 在同一端口轮换实际 HTTP 凭据，沿用同一浏览器存储。
  await page.goto('about:blank');
  await server.close();
  server = await start(second, port);
  await enter(second);
  await expect(input).toHaveValue('');
  await input.fill('第二个凭据的草稿');
  await page.reload();
  await expect(input).toHaveValue('第二个凭据的草稿');
  const disabled = await page.request.post(url + '/api/v1/plugins/conversation-drafts', {
    headers: { Authorization: 'Bearer ' + second }, data: { enabled: false },
  });
  assert.ok(disabled.ok());
  await page.reload();
  await expect(send).toBeEnabled();
  await expect(input).toHaveValue('');
  await input.fill('停用期间的临时输入');
  await page.reload();
  await expect(send).toBeEnabled();
  await expect(input).toHaveValue('');
});
