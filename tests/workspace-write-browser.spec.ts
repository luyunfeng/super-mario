import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { workspaceCode } from '../plugins/workspace-code.ts';
import { createWorkspaceWrite } from '../plugins/workspace-write.ts';

test('项目工作区里可以编辑并保存一个文件到电脑，再撤销；文件在电脑上变过就拒绝保存', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-write-page-'));
  const token = 'workspace-write-page-fixture';
  const root = join(dir, 'project');
  await mkdir(root);
  await writeFile(join(root, 'notes.md'), 'first line\n');
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token, demo: true });
  const write = createWorkspaceWrite({ dataDir: join(dir, 'agent') });
  const node = startAgentNode({ url: server.url, token, machineId: 'write-machine', name: '工作电脑', dataDir: join(dir, 'node'), executors: [],
    handlers: { 'workspace.code': workspaceCode, ...write.handlers } });
  t.after(async () => { await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  for (let tries = 0; tries < 100 && !server.machines.list().some(item => item.id === 'write-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const project = await server.app.projects.create({ name: '编辑文件项目', workspace: { machineId: 'write-machine', cwd: root } });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#projects/' + project.id + '/workspace?token=' + token);
  const sidebar = page.locator('#panel-workspace .code-sidebar');
  await page.locator('#panel-workspace').getByRole('button', { name: '查看代码' }).click();
  await sidebar.getByRole('button', { name: 'notes.md', exact: true }).click();
  await expect(sidebar.locator('pre')).toHaveText('first line');
  // Edit, and save what was read.
  const edit = sidebar.getByRole('button', { name: '编辑', exact: true });
  await expect(edit).toBeEnabled();
  await edit.click();
  const box = sidebar.getByRole('textbox', { name: '文件内容' });
  await box.fill('second line\n');
  const save = sidebar.getByRole('button', { name: '保存到电脑' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(sidebar.getByRole('status').filter({ hasText: '已保存到电脑' })).toBeVisible();
  assert.equal(await readFile(join(root, 'notes.md'), 'utf8'), 'second line\n');
  // What the page shows is what is on the computer.
  await expect(sidebar.locator('pre')).toHaveText('second line');
  // Someone changes the file on the computer. Saving again is refused, and nothing is written.
  await writeFile(join(root, 'notes.md'), 'someone else\n');
  await box.fill('third line\n');
  await save.click();
  await expect(sidebar.getByRole('status').filter({ hasText: '没有保存' })).toContainText('已经变化');
  assert.equal(await readFile(join(root, 'notes.md'), 'utf8'), 'someone else\n');
  await expect(save).toBeDisabled();
  // Undo is refused too: the file is not as it was saved.
  await sidebar.getByRole('button', { name: '撤销上次保存' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '撤销', exact: true }).click();
  await expect(sidebar.getByRole('status').filter({ hasText: '没有撤销' })).toBeVisible();
  assert.equal(await readFile(join(root, 'notes.md'), 'utf8'), 'someone else\n');
  // Read the file again: the editor shows what is on the computer now, and saving that works.
  await sidebar.getByRole('button', { name: '文本', exact: true }).click();
  await expect(sidebar.locator('pre')).toHaveText('someone else');
  await sidebar.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(box).toHaveValue('someone else\n');
  await box.fill('mine now\n');
  await save.click();
  await expect(sidebar.getByRole('status').filter({ hasText: '已保存到电脑' })).toBeVisible();
  assert.equal(await readFile(join(root, 'notes.md'), 'utf8'), 'mine now\n');
  // Undo puts back what was there before that save.
  await sidebar.getByRole('button', { name: '撤销上次保存' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '撤销', exact: true }).click();
  await expect(sidebar.getByRole('status').filter({ hasText: '已撤销' })).toBeVisible();
  assert.equal(await readFile(join(root, 'notes.md'), 'utf8'), 'someone else\n');
  assert.deepEqual(pageErrors, []);
});
