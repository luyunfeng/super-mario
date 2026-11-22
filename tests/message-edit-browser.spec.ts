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

test('编辑自己的历史消息可撤销替换，手动发送才新增消息，主对话与项目的编辑草稿相互隔离', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-message-edit-'));
  const token = 'message-edit-browser-fixture';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let node: ReturnType<typeof startAgentNode> | undefined;
  t.after(async () => { await browser?.close(); await node?.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const cwd = join(dir, 'project'), machineId = 'edit-fixture-node';
  await mkdir(cwd);
  const discovery = createProjectDiscovery({ home: dir, cwd, roots: [], temporaryRoots: [], ignoreEnvironmentRoots: true });
  node = startAgentNode({ url: server.url, token, machineId, name: '合成编辑测试电脑', dataDir: join(dir, 'node'),
    handlers: { 'workspace.directory': discovery.handlers['workspace.directory'] }, executors: [] });
  await expect.poll(() => server.machines.list().some(m => m.id === machineId && m.online)).toBe(true);
  const alpha = await server.app.createProject({ name: '工作项目甲', workspace: { machineId, cwd } });
  const beta = server.app.projects.create({ name: '工作项目乙' });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  const contexts = [
    { panel: '#chat', input: '给 Agent 的消息', send: '发送', route: 'chat', id: 'main', name: '主对话', quotePrefix: '> 历史引文第一行。\n> 历史引文第二行。\n\n' },
    { panel: '#panel-workspace', input: '项目目标', send: '发送目标', route: 'projects/' + alpha.id + '/workspace',
      id: 'project:' + alpha.id + ':work', name: '项目甲', projectId: alpha.id, quotePrefix: '' },
  ];
  const own = (id: string) => server.app.store.list<Message>('messages').filter(m => m.conversationId === id && m.role === 'user');
  for (const ctx of contexts) {
    for (const [role, text] of [['user', ctx.quotePrefix + ctx.name + '历史正文\n第二行。'], ['assistant', ctx.name + '引用来源。']] as const) {
      const id = ctx.id + '-' + role;
      server.app.store.put('messages', id, { id, conversationId: ctx.id, role, text, projectId: ctx.projectId,
        status: 'done', createdAt: new Date().toISOString() } satisfies Message);
    }
  }
  const readOnly: Message = { id: 'readonly-source', conversationId: 'project:' + beta.id + ':work', projectId: beta.id,
    role: 'user', readOnly: true, text: '其他来源的只读输入。', createdAt: new Date().toISOString(), status: 'done' };
  server.app.store.put('messages', readOnly.id, readOnly);
  await page.goto(server.url + '/#chat?token=' + token);
  for (const ctx of contexts) {
    await page.goto(server.url + '/#' + ctx.route);
    const panel = page.locator(ctx.panel), input = panel.getByLabel(ctx.input);
    const historyText = ctx.name + '历史正文\n第二行。';
    const original = own(ctx.id)[0];
    const mine = panel.locator('.msg--user').filter({ hasText: ctx.name + '历史正文' });
    const theirs = panel.locator('.msg--assistant').filter({ hasText: ctx.name + '引用来源。' });
    const action = mine.getByRole('button', { name: '编辑消息', exact: true });
    const undo = panel.getByRole('button', { name: '撤销替换', exact: true });
    const preview = panel.locator('[data-message-quote]');
    await expect(action).toBeVisible();
    await expect(theirs).toBeVisible();
    await expect(theirs.getByRole('button', { name: '编辑消息' })).toHaveCount(0);
    const draft = ctx.name + '原来输入的文字\n未发送。';
    await input.fill(draft);
    await theirs.getByRole('button', { name: '引用消息', exact: true }).click();
    await expect(preview).toContainText(ctx.name + '引用来源。');
    await action.click();
    await expect(input).toHaveValue(historyText);
    if (ctx.quotePrefix) await expect(preview).toContainText('历史引文第二行。');
    else await expect(preview).toBeHidden();
    await undo.click();
    await expect(input).toHaveValue(draft);
    await expect(preview).toContainText(ctx.name + '引用来源。');
    assert.deepEqual(own(ctx.id), [original]);
    await action.click();
    await expect(input).toHaveValue(historyText);
    const edited = ctx.name + '修订后正文\n保留这一行。';
    await input.fill(edited);
    await page.reload();
    await expect(input).toHaveValue(edited);
    if (ctx.quotePrefix) await expect(preview).toContainText('历史引文第二行。');
    else await expect(preview).toBeHidden();
    await expect(undo).toBeHidden();
    await page.goto(server.url + '/#projects/' + beta.id + '/workspace');
    await expect(page.getByLabel('项目目标')).toHaveValue('');
    const readOnlyRow = page.locator('#panel-workspace .msg--user').filter({ hasText: readOnly.text });
    await expect(readOnlyRow).toBeVisible();
    await expect(readOnlyRow.getByRole('button', { name: '编辑消息' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '撤销替换' })).toBeHidden();
    await page.goto(server.url + '/#' + ctx.route);
    if (ctx.id === 'main') await panel.getByLabel('项目范围').selectOption('');
    await expect(input).toHaveValue(edited);
    assert.deepEqual(own(ctx.id), [original]);
    await panel.getByRole('button', { name: ctx.send, exact: true }).click();
    await expect.poll(() => own(ctx.id).map(m => m.text)).toEqual([ctx.quotePrefix + historyText, ctx.quotePrefix + edited]);
    const [before, after] = own(ctx.id);
    assert.deepEqual(before, original);
    assert.notEqual(after.id, before.id);
    await expect(input).toHaveValue('');
    await expect(preview).toBeHidden();
  }

  const workspace = page.locator('#panel-workspace');
  const projectAction = workspace.locator('.msg--user').filter({ hasText: '项目甲历史正文' }).getByRole('button', { name: '编辑消息' });
  await projectAction.click();
  const projectInput = workspace.getByLabel('项目目标');
  await expect(projectInput).toHaveValue('项目甲历史正文\n第二行。');
  const toggle = async (plugin: string, enabled: boolean) => {
    const res = await page.request.post(server.url + '/api/v1/plugins/' + plugin, {
      headers: { Authorization: 'Bearer ' + token }, data: { enabled },
    });
    assert.ok(res.ok());
  };
  await toggle('conversation-edit', false);
  await expect(workspace.getByRole('button', { name: '编辑消息' })).toHaveCount(0);
  await expect(workspace.getByRole('button', { name: '撤销替换' })).toBeHidden();
  await expect(projectInput).toHaveValue('项目甲历史正文\n第二行。');
  await page.goto(server.url + '/#chat');
  const chat = page.locator('#chat');
  await chat.getByLabel('项目范围').selectOption('');
  await expect(chat.locator('.msg--user')).toHaveCount(2);
  await expect(chat.getByRole('button', { name: '编辑消息' })).toHaveCount(0);
  await toggle('conversation-edit', true);
  await expect(chat.getByRole('button', { name: '编辑消息' })).toHaveCount(2);
  await chat.locator('.msg--assistant').filter({ hasText: '主对话引用来源。' }).getByRole('button', { name: '引用消息' }).click();
  await expect(chat.locator('[data-message-quote]')).toContainText('主对话引用来源。');
  await toggle('conversation-quotes', false);
  await expect(chat.getByRole('button', { name: '引用消息' })).toHaveCount(0);
  const quoted = own('main')[0];
  await chat.locator('.msg--user').filter({ hasText: '主对话历史正文' }).getByRole('button', { name: '编辑消息' }).click();
  await expect(chat.getByLabel('给 Agent 的消息')).toHaveValue(quoted.text);
  await expect(chat.locator('[data-message-quote]')).toBeHidden();
  assert.equal(own('main').length, 2);
  assert.deepEqual(own(readOnly.conversationId), [readOnly]);

  // 服务端先受理 A，仅延迟浏览器回执。在这期间编辑 B 会创建新的撤销记录。
  const input = chat.getByLabel('给 Agent 的消息');
  const undo = chat.getByRole('button', { name: '撤销替换' });
  const send = chat.getByRole('button', { name: '发送', exact: true });
  const second = own('main')[1];
  const editB = chat.locator('.msg--user').filter({ hasText: '主对话修订后正文' }).getByRole('button', { name: '编辑消息' });
  const sentA = '在途中的 A 修订稿。';
  await input.fill(sentA);
  let acknowledge!: () => void;
  const gate = new Promise<void>(resolve => { acknowledge = resolve; });
  const endpoint = '**/api/v1/messages';
  await page.route(endpoint, async route => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  const receipt = page.waitForResponse(r => r.url().endsWith('/api/v1/messages') && r.request().method() === 'POST');
  await send.click();
  try {
    await expect.poll(() => own('main').map(m => m.text)).toEqual([quoted.text, second.text, sentA]);
    await editB.click();
    await expect(input).toHaveValue(second.text);
    await expect(undo).toBeVisible();
  } finally { acknowledge(); }
  assert.ok((await receipt).ok());
  await expect(send).toBeEnabled();
  await expect(input).toHaveValue(second.text);
  await undo.click();
  await expect(input).toHaveValue(sentA);
  await page.unroute(endpoint);

  // 单次编辑在成功发送后结束，其旧撤销入口不能复活发送前的草稿。
  await editB.click();
  await expect(undo).toBeVisible();
  const sentB = '单独发送的 B 修订稿。';
  await input.fill(sentB);
  await send.click();
  await expect(input).toHaveValue('');
  await expect(undo).toBeHidden();
  assert.deepEqual(own('main').map(m => m.text), [quoted.text, second.text, sentA, sentB]);
  await toggle('conversation-quotes', true);
  await expect(chat.getByRole('button', { name: '引用消息' }).first()).toBeVisible();
  await expect(chat.locator('[data-message-quote]')).toBeHidden();
});
