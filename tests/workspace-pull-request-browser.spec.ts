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
import { createWorkspacePullRequestNode } from '../plugins/workspace-pull-request.ts';
import { workspaceCode } from '../plugins/workspace-code.ts';
import type { Approval } from '../packages/protocol/src/index.ts';

test('项目工作区里可以提交开出 PR 的审批；批准前不推送，批准后推送并开出', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-pull-page-'));
  const token = 'pull-page-fixture';
  const remote = join(dir, 'remote.git'), root = join(dir, 'project');
  const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).then(result => result.stdout.trim());
  await git(dir, 'init', '-q', '--bare', '--initial-branch', 'main', remote);
  await git(dir, 'init', '-q', '-b', 'main', 'project');
  await writeFile(join(root, 'README.md'), 'first\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-qm', 'first');
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '-q', '-u', 'origin', 'main');
  await git(root, 'checkout', '-qb', 'feature');
  await writeFile(join(root, 'README.md'), 'second\n');
  await git(root, 'commit', '-qam', 'second');
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token, demo: true });
  const ghAsked: string[][] = [];
  const node = startAgentNode({ url: server.url, token, machineId: 'pull-machine', name: '工作电脑', dataDir: join(dir, 'node'), executors: [],
    handlers: {
      'workspace.code': workspaceCode, ...createWorkspaceGitWrite().handlers,
      ...createWorkspacePullRequestNode({ run: async args => { ghAsked.push(args); return 'https://github.com/owner/repo/pull/7\n'; } }).handlers,
      'github.account': async () => ({ login: 'fixture-owner', name: '' }), 'github.notifications': async () => ({ items: [] }), 'github.comment': async () => ({ state: 'sent' }),
    } });
  t.after(async () => { await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  for (let tries = 0; tries < 100 && !server.machines.list().some(item => item.id === 'pull-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const project = await server.app.projects.create({ name: 'PR 页面项目', workspace: { machineId: 'pull-machine', cwd: root } });
  server.app.githubConfigure({ enabled: true, machineId: 'pull-machine', ciMode: 'off', mutedRepositories: [], ignoredBranches: [] });
  await server.app.githubPoll();
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#projects/' + project.id + '/workspace?token=' + token);
  const sidebar = page.locator('#panel-workspace .code-sidebar');
  await page.locator('#panel-workspace').getByRole('button', { name: '查看代码' }).click();
  const pull = sidebar.getByRole('group', { name: '开出 PR', exact: true });
  await pull.locator('summary').click();
  await pull.getByRole('textbox', { name: '仓库' }).fill('owner/repo');
  await pull.getByRole('textbox', { name: '合并到哪个分支' }).fill('main');
  await pull.getByRole('textbox', { name: 'PR 标题' }).fill('Add a second line');
  await pull.getByRole('textbox', { name: 'PR 说明' }).fill('This adds a line.');
  await pull.getByRole('button', { name: '提交审批' }).click();
  await expect(pull).toContainText('已提交审批');
  // The approval is there for the owner to read, and nothing has been pushed.
  const approvals = server.app.store.list<Approval>('approvals');
  const approval = approvals.find(row => row.kind === 'plugin:github-connector.pull')!;
  assert.ok(approval);
  assert.match(approval.title, /分支 feature 推到 GitHub 并开出 PR/);
  await assert.rejects(git(remote, 'rev-parse', '--verify', '--quiet', 'feature'), /Command failed/);
  assert.deepEqual(ghAsked, []);
  // The owner approves it where approvals are approved.
  const decided = await fetch(server.url + '/api/v1/approvals/' + approval.id + '/approve', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ version: approval.version }) });
  assert.equal(decided.status, 200);
  assert.equal(await git(remote, 'rev-parse', 'feature'), await git(root, 'rev-parse', 'feature'));
  assert.equal(ghAsked.length, 1);
  assert.deepEqual(pageErrors, []);
});
