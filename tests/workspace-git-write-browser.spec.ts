import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { workspaceCode } from '../plugins/workspace-code.ts';
import { createWorkspaceGitWrite } from '../plugins/workspace-git-write.ts';
import { createWorkspaceWrite } from '../plugins/workspace-write.ts';
import { promisify } from 'node:util';

test('项目工作区里能暂存、取消暂存和提交；提交用的是主人自己的身份', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-git-page-'));
  const token = 'workspace-git-page-fixture';
  const root = join(dir, 'repo');
  const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).then(result => result.stdout);
  // The leading space of a status line says the index is unchanged: it is not trimmed away.
  const gitLine = async (cwd: string, ...args: string[]) => (await git(cwd, ...args)).replace(/\n$/, '');
  await gitLine(dir, 'init', '-q', '-b', 'main', 'repo');
  await gitLine(root, 'config', 'user.name', 'Fixture');
  await gitLine(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'README.md'), 'first\n');
  await gitLine(root, 'add', 'README.md');
  await gitLine(root, 'commit', '-qm', 'first');
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token, demo: true });
  const node = startAgentNode({ url: server.url, token, machineId: 'git-machine', name: '工作电脑', dataDir: join(dir, 'node'), executors: [],
    handlers: { 'workspace.code': workspaceCode, ...createWorkspaceWrite({ dataDir: join(dir, 'agent') }).handlers, ...createWorkspaceGitWrite().handlers } });
  t.after(async () => { await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  for (let tries = 0; tries < 100 && !server.machines.list().some(item => item.id === 'git-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const project = await server.app.projects.create({ name: 'Git 项目', workspace: { machineId: 'git-machine', cwd: root } });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#projects/' + project.id + '/workspace?token=' + token);
  const sidebar = page.locator('#panel-workspace .code-sidebar');
  await page.locator('#panel-workspace').getByRole('button', { name: '查看代码' }).click();
  const gitPanel = sidebar.getByRole('region', { name: 'Git', exact: true });
  await expect(gitPanel).toContainText('分支 main · 已暂存 0 个，未暂存 0 个');
  assert.equal(await gitPanel.getByRole('button', { name: '提交已暂存的改动' }).isDisabled(), true);
  // A change is made on the computer.
  await writeFile(join(root, 'README.md'), 'second\n');
  await gitPanel.getByRole('button', { name: '刷新 Git 状态' }).click();
  await expect(gitPanel).toContainText('未暂存 1 个');
  await expect(gitPanel.getByRole('list', { name: '改动' }).getByRole('listitem')).toHaveCount(1);
  // Stage it, and the list and the count say so.
  await gitPanel.getByRole('button', { name: '暂存', exact: true }).click();
  await expect(gitPanel).toContainText('已暂存 1 个，未暂存 0 个');
  assert.equal(await gitLine(root, 'status', '--porcelain'), 'M  README.md');
  // Unstage it: the change is kept, only the staging is undone.
  await gitPanel.getByRole('button', { name: '取消暂存', exact: true }).click();
  await expect(gitPanel).toContainText('已暂存 0 个，未暂存 1 个');
  assert.equal(await gitLine(root, 'status', '--porcelain'), ' M README.md');
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'second\n');
  // Stage again and commit, with a message.
  await gitPanel.getByRole('button', { name: '暂存', exact: true }).click();
  await expect(gitPanel).toContainText('已暂存 1 个');
  await gitPanel.getByRole('textbox', { name: '提交说明' }).fill('say what changed');
  await gitPanel.getByRole('button', { name: '提交已暂存的改动' }).click();
  await expect(gitPanel).toContainText('已提交：');
  assert.match(await gitLine(root, 'log', '-1', '--format=%s'), /^say what changed$/);
  assert.equal(await gitLine(root, 'log', '-1', '--format=%an <%ae>'), 'Fixture <fixture@example.invalid>');
  assert.equal(await gitLine(root, 'status', '--porcelain'), '');
  assert.deepEqual(pageErrors, []);
});
