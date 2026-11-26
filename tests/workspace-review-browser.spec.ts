import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { promisify } from 'node:util';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { createWorkspaceGitWrite } from '../plugins/workspace-git-write.ts';
import { workspaceCode } from '../plugins/workspace-code.ts';

test('差异里的每一行都能写评论，评论带着文件和行号进入对话；删掉的行不能评论', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-review-page-'));
  const token = 'review-page-fixture';
  const root = join(dir, 'repo');
  const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).then(result => result.stdout);
  await git(dir, 'init', '-q', '-b', 'main', 'repo');
  // Three lines committed, then the second changed and a fourth added.
  await writeFile(join(root, 'notes.md'), 'one\ntwo old\nthree\n');
  await git(root, 'add', 'notes.md');
  await git(root, 'commit', '-qm', 'first');
  await writeFile(join(root, 'notes.md'), 'one\ntwo new\nthree\nfour\n');
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token, demo: true });
  const node = startAgentNode({ url: server.url, token, machineId: 'review-machine', name: '工作电脑', dataDir: join(dir, 'node'), executors: [],
    handlers: { 'workspace.code': workspaceCode, ...createWorkspaceGitWrite().handlers } });
  t.after(async () => { await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  for (let tries = 0; tries < 100 && !server.machines.list().some(item => item.id === 'review-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const project = await server.app.projects.create({ name: '评审项目', workspace: { machineId: 'review-machine', cwd: root } });
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
  await sidebar.getByRole('button', { name: 'Git diff', exact: true }).click();
  // Lines of the file as it is now can be commented on, by their number in the file: the changed
  // ones and the unchanged ones the diff shows around them. A removed line and the diff's own
  // headers cannot.
  await expect(sidebar.getByRole('button', { name: '评论第 1 行' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: '评论第 2 行' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: '评论第 4 行' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: '评论第 3 行', exact: true })).toBeVisible();
  await expect(sidebar.locator('.diff-line--del')).toHaveCount(1);
  await expect(sidebar.locator('.diff-line--del').first()).not.toHaveAttribute('role', 'button');
  // A comment on the changed line goes to the conversation as a quotation of that line.
  await sidebar.getByRole('button', { name: '评论第 2 行', exact: true }).click();
  const comment = sidebar.getByRole('group', { name: '对这一行评论' });
  await expect(comment).toBeVisible();
  await comment.getByRole('textbox', { name: '评论' }).fill('这里改成「贰」');
  await comment.getByRole('button', { name: '加入对话' }).click();
  await expect(comment).toBeHidden();
  const composer = page.getByRole('textbox', { name: '项目目标' });
  await expect(composer).toHaveValue(/> notes\.md:2 two new\n\n这里改成「贰」\n\n/);
  // An empty comment is not added: the box is kept for the owner to write in.
  await sidebar.getByRole('button', { name: '评论第 4 行', exact: true }).click();
  await comment.getByRole('button', { name: '加入对话' }).click();
  await expect(comment).toBeVisible();
  await expect(composer).toHaveValue(/> notes\.md:2 two new\n\n这里改成「贰」\n\n/);
  // Cancelling puts the line back as it was.
  await comment.getByRole('button', { name: '取消', exact: true }).click();
  await expect(comment).toBeHidden();
  await expect(sidebar.locator('.diff-line--active')).toHaveCount(0);
  assert.deepEqual(pageErrors, []);
});
