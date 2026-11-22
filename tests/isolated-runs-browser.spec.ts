import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';
import type { Run } from '../packages/protocol/src/index.ts';

test('Web and HTTP launch overlapping tasks in separate Git branches from a dirty project', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mario-isolate-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git(cwd, 'init', '-q');
  await writeFile(join(cwd, 'shared.txt'), 'baseline');
  await writeFile(join(cwd, '.gitattributes'), 'shared.txt filter=fixture\n');
  git(cwd, 'add', '.gitattributes', 'shared.txt'); git(cwd, 'commit', '-qm', 'baseline');
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'config', 'filter.fixture.smudge', 'false');
  git(cwd, 'config', 'filter.fixture.required', 'true');
  await writeFile(join(cwd, 'shared.txt'), 'original pending change');
  const server = await startServer({ dataDir: join(root, 'server'), host: '127.0.0.1', port: 0, demo: true, token: 'worktree-fixture' });
  const discovery = createProjectDiscovery({ home: root, cwd, roots: [], temporaryRoots: [] });
  const continuedIn: string[] = [];
  const starts = new Map<string, string>();
  let incompleteBranchStatus = false;
  let baseReads = 0, groupedCheckouts = 0;

  const node = startAgentNode({ url: server.url, token: 'worktree-fixture', machineId: 'fixture', name: 'fixture', dataDir: join(root, 'node'),
    executors: [{ id: 'codex', machineId: 'fixture', name: '协议替身', kind: 'cli', available: true, mode: 'real', description: 'fixture' }],
    handlers: { ...discovery.handlers,
      'workspace.retainedBranchStatus': async args => incompleteBranchStatus ? {} : discovery.handlers['workspace.retainedBranchStatus'](args),
      'workspace.worktreeBase': async args => {
        const pinned = await discovery.handlers['workspace.worktreeBase'](args);
        baseReads++;
        // Another developer advances HEAD after the group's checkpoint.
        const next = git(cwd, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'concurrent change');
        git(cwd, 'update-ref', 'HEAD', next);
        return pinned;
      },
      'workspace.prepareRunWorktree': async args => {
        if (args.base && ++groupedCheckouts === 2) throw new Error('合成的工作树创建失败');
        return discovery.handlers['workspace.prepareRunWorktree'](args);
      },
      'executor.start': async args => {
      const path = String(args.cwd);
      if (String(args.prompt).includes('本次在原执行工作树中开始新任务')) {
        assert.equal(await readFile(join(path, 'shared.txt'), 'utf8'), starts.get(path));
        continuedIn.push(path);
        return { sessionId: 'followup-' + continuedIn.length };
      }
      assert.equal(await readFile(join(path, 'shared.txt'), 'utf8'), 'baseline');
      assert.match(String(args.prompt), /本次使用独立 Git 工作树/);
      starts.set(path, String(args.prompt));
      await writeFile(join(path, 'shared.txt'), String(args.prompt));
      return { sessionId: path.split('/').at(-1)! };
    } },
  });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await node.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  await expect.poll(() => server.machines.list().some(m => m.online)).toBe(true);
  const project = await server.app.createProject({ name: '测试项目', workspace: { machineId: 'fixture', cwd } });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#projects/' + project.id + '/runs?token=worktree-fixture');
  await page.getByRole('button', { name: '发起执行', exact: true }).first().click();
  const drawer = page.getByRole('dialog', { name: '发起执行' });
  await drawer.getByLabel('要做什么').fill('第一项任务');
  await drawer.getByLabel('怎样算完成').fill('核对文件');
  await drawer.getByLabel('预计用时').fill('2');
  await drawer.getByLabel('从当前提交创建独立 Git 工作树').check();
  await drawer.getByRole('button', { name: '开始执行' }).click();
  await expect.poll(() => starts.size).toBe(1);
  const input = { projectId: project.id, cwd, executorId: 'fixture/codex', isolatedWorktree: true,
    prompt: '第二项任务', doneWhen: '核对文件', expectMinutes: 2 };
  const post = (data: typeof input) => fetch(server.url + '/api/v1/runs', { method: 'POST', headers: {
    authorization: 'Bearer worktree-fixture', 'content-type': 'application/json', 'idempotency-key': 'second-run',
  }, body: JSON.stringify(data) });
  assert.equal((await post(input)).status, 202);
  await expect.poll(() => starts.size).toBe(2);
  assert.equal((await post(input)).status, 202);
  assert.equal((await post({ ...input, isolatedWorktree: false })).status, 409);
  const runs = server.app.store.list<Run>('runs');
  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.equal(run.worktree?.base, base);
    assert.equal(git(run.cwd!, 'branch', '--show-current'), 'super-mario/' + run.id);
    assert.equal(await readFile(join(run.cwd!, 'shared.txt'), 'utf8'), starts.get(run.cwd!));
  }
  assert.equal(await readFile(join(cwd, 'shared.txt'), 'utf8'), 'original pending change');
  const first = runs.find(run => run.prompt === '第一项任务')!;
  const path = first.cwd!;
  const extra = git(path, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'worktree only');
  git(path, 'update-ref', 'HEAD', extra);
  await writeFile(join(path, 'stage.txt'), 'staged file');
  git(path, 'add', 'stage.txt');
  await writeFile(join(path, 'stage.txt'), 'staged file with later edit');
  await writeFile(join(path, 'new.txt'), 'untracked file');
  await writeFile(join(path, '.env'), 'synthetic');
  await page.goto(server.url + '/#projects/' + project.id + '/runs/' + first.id);
  const rename = (name: string, previousName: string) => fetch(server.url + '/api/v1/runs/' + first.id + '/worktree-name', {
    method: 'PATCH', headers: { authorization: 'Bearer worktree-fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ name, previousName }),
  });
  await page.getByRole('button', { name: '重命名工作树' }).click();
  const editor = page.getByRole('dialog', { name: '重命名工作树' });
  await editor.getByLabel('工作树名称').fill('接口修订');
  await editor.getByLabel('工作树名称').press('Enter');
  await expect(editor).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('工作树：接口修订', { exact: true }).last()).toBeVisible();
  await page.goto(server.url + '/#projects/' + project.id + '/runs');
  const renamedRow = page.locator('a.run').filter({ hasText: '工作树：接口修订' });
  await expect(renamedRow).toContainText('第一项任务');
  await renamedRow.click();
  const peer = runs.find(run => run.id !== first.id)!;
  await page.getByLabel('选择对比执行').selectOption(peer.id);
  await expect(page.getByRole('region', { name: '执行对比' }).getByText('工作树：接口修订')).toBeVisible();
  await page.getByRole('link', { name: '关闭对比' }).click();
  assert.equal((await rename('陈旧请求', '')).status, 409);
  assert.equal((await rename('   ', '接口修订')).status, 400);
  assert.equal((await rename('接口修订', '')).status, 200);
  assert.equal(git(path, 'branch', '--show-current'), first.worktree!.branch);
  const runsList = server.app.contributions.list('tools').find(entry => entry.value.name === 'runs_list')!.value;
  const listed = await runsList.execute({}, new AbortController().signal) as unknown as Run[];
  assert.equal(listed.find(run => run.id === first.id)?.worktree?.name, '接口修订');
  const historyTool = server.app.contributions.list('tools').find(entry => entry.value.name === 'run_worktree_history')!.value;
  const getHistory = async (mode: string, offset = 0, version?: string) => JSON.parse(JSON.stringify(await historyTool.execute(
    { id: first.id, mode, offset, ...(version && { version }) }, new AbortController().signal)));
  let tip = extra;
  for (let i = 1; i <= 21; i++) tip = git(path, 'commit-tree', 'HEAD^{tree}', '-p', tip, '-m', '历史提交 ' + i);
  git(path, 'update-ref', 'HEAD', tip, extra);
  await page.getByRole('button', { name: '查看提交历史' }).click();
  const history = page.getByRole('dialog', { name: '工作树提交历史' });
  await expect(history.getByRole('listitem')).toHaveCount(20);
  const firstPage = await getHistory('unmerged');
  assert.equal(firstPage.commits[0].hash, tip);
  await history.getByRole('button', { name: '加载更早提交' }).click();
  await expect(history.getByRole('listitem')).toHaveCount(22);
  await expect(history.getByRole('listitem').last()).toContainText('worktree only');
  await history.getByLabel('提交范围').selectOption('all');
  await history.getByRole('button', { name: '加载更早提交' }).click();
  await expect(history.getByRole('listitem')).toHaveCount(23);
  await history.getByRole('listitem').last().getByRole('button').click();
  const detail = page.getByRole('dialog', { name: '提交详情' });
  await expect(detail).toContainText(base);
  await detail.getByLabel('已提交文件').selectOption('shared.txt');
  await expect(detail.locator('pre.code-sidebar__text')).toContainText('+baseline');
  await detail.getByRole('button', { name: '关闭' }).click();
  const detailTool = async (commit: string, mode: string, file?: string) => JSON.parse(JSON.stringify(await historyTool.execute(
    { id: first.id, mode, commit, ...(file && { path: file }) }, new AbortController().signal)));
  await assert.rejects(detailTool(base, 'unmerged'), /不在当前工作树/);
  assert.equal((await detailTool(base, 'all')).parent, null);
  const stagedTree = git(path, 'write-tree');
  const side = git(path, 'commit-tree', stagedTree, '-p', base, '-m', 'side commit');
  const merge = git(path, 'commit-tree', stagedTree, '-p', tip, '-p', side, '-m', 'merge fixture');
  git(path, 'update-ref', 'HEAD', merge, tip);
  const merged = await detailTool(merge, 'all');
  assert.equal(merged.merge, true);
  assert.equal(merged.parent, tip);
  assert.deepEqual(merged.files, ['stage.txt']);
  git(path, 'update-ref', 'HEAD', extra, merge);
  await assert.rejects(detailTool(tip, 'all'), /不在当前工作树/);
  await assert.rejects(getHistory('unmerged', firstPage.nextOffset, firstPage.version), /历史已变化/);
  await history.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '查看工作树状态' }).click();
  const status = page.getByRole('dialog', { name: '工作树状态' });
  await expect(status).toContainText(first.worktree!.branch!);
  await expect(status).toContainText('1 个提交尚未进入');
  await expect(status).toContainText('未提交文件（含未跟踪）：4');
  await expect(status).toContainText('暂存区：新增');
  await expect(status).toContainText('工作区：修改');
  await expect(status).toContainText('new.txt');
  await expect(status).toContainText('已隐藏 1 个受限文件');
  await expect(status).not.toContainText('.env');
  const stagedFile = status.locator('div.stack').filter({ has: page.locator(':scope > code').filter({ hasText: /^stage\.txt$/ }) }).last();
  await stagedFile.getByRole('button', { name: '查看暂存差异' }).click();
  await expect(stagedFile.locator('pre')).toContainText('+staged file');
  await expect(stagedFile.locator('pre')).not.toContainText('later edit');
  await stagedFile.getByRole('button', { name: '查看未暂存差异' }).click();
  await expect(stagedFile.locator('pre')).toContainText('+staged file with later edit');
  await status.getByRole('button', { name: '查看未跟踪文件' }).click();
  await expect(status.locator('pre').filter({ hasText: /^untracked file$/ })).toBeVisible();
  await assert.rejects(server.app.readRunWorktreeChange(first.id, '.env', 'working'), /可见/);
  await rm(join(path, 'new.txt'));
  await status.getByRole('button', { name: '刷新状态' }).click();
  await expect(status).toContainText('未提交文件（含未跟踪）：3');
  await expect(status).not.toContainText('new.txt');
  const statusTool = server.app.contributions.list('tools').find(entry => entry.value.name === 'run_worktree_status')!.value;
  const liveChange = await statusTool.execute({ id: first.id, area: 'working', path: 'stage.txt' }, new AbortController().signal);
  assert.match(JSON.stringify(liveChange), /staged file with later edit/);
  const largeArgs = { id: first.id, area: 'working', path: 'stage.txt' };
  await writeFile(join(path, 'stage.txt'), 'a'.repeat(18000));
  const part = JSON.parse(JSON.stringify(await statusTool.execute(largeArgs, new AbortController().signal)));
  assert.equal(part.nextOffset, 16000);
  const nextArgs = { ...largeArgs, offset: part.nextOffset, version: part.version };
  const rest = JSON.parse(JSON.stringify(await statusTool.execute(nextArgs, new AbortController().signal)));
  assert.equal(rest.nextOffset, null);
  assert.equal(rest.version, part.version);
  await writeFile(join(path, 'stage.txt'), 'staged file with later edit');
  await assert.rejects(Promise.resolve(statusTool.execute(nextArgs, new AbortController().signal)), /已变化/);
  const evidence = await statusTool.execute({ id: first.id }, new AbortController().signal);
  assert.match(JSON.stringify(evidence), /stage\.txt/);
  assert.doesNotMatch(JSON.stringify(evidence), /\.env/);
  await status.getByRole('button', { name: '关闭' }).click();
  const cleanup = (head: string, confirmed = true) => fetch(server.url + '/api/v1/runs/' + first.id + '/worktree-cleanup',
    { method: 'POST', headers: { authorization: 'Bearer worktree-fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ head, confirmed, requestId: crypto.randomUUID() }) });
  assert.equal((await cleanup(extra)).status, 409, 'active execution keeps its directory');
  assert.equal((await cleanup(extra, false)).status, 400);
  server.app.store.put('runs', first.id, { ...server.app.store.get<Run>('runs', first.id)!, status: 'completed' });
  assert.equal((await cleanup(extra)).status, 409, 'uncommitted files must survive');
  assert.equal(await readFile(join(path, '.env'), 'utf8'), 'synthetic');
  await rm(join(path, '.env'));
  await writeFile(join(path, '.gitignore'), 'local-cache\n');
  git(path, '-c', 'filter.fixture.required=false', 'add', '.');
  git(path, '-c', 'filter.fixture.required=false', 'commit', '-qm', 'keep this branch');
  const kept = git(path, 'rev-parse', 'HEAD');
  assert.equal((await cleanup(extra)).status, 409, 'confirmation is bound to the viewed HEAD');
  await writeFile(join(path, 'local-cache'), 'ignored work');
  assert.equal((await cleanup(kept)).status, 409, 'ignored files survive cleanup');
  const inspect = () => statusTool.execute({ id: first.id }, new AbortController().signal);
  const ignoredStatus = await inspect();
  assert.match(JSON.stringify(ignoredStatus), /"ignored":1/);
  assert.doesNotMatch(JSON.stringify(ignoredStatus), /local-cache/);
  git(cwd, 'worktree', 'lock', '--reason', 'synthetic private reason', path);
  const lockedStatus = JSON.stringify(await inspect());
  assert.match(lockedStatus, /"locked":true/);
  assert.doesNotMatch(lockedStatus, /synthetic private reason/);
  await page.reload();
  await page.getByRole('button', { name: '查看工作树状态' }).click();
  await expect(status).toContainText('Git 工作树已锁定');
  await expect(status).toContainText('1 个 Git 忽略项');
  await expect(status.getByRole('button', { name: '清理工作树目录' })).toBeDisabled();
  assert.equal((await cleanup(kept)).status, 409);
  git(cwd, 'worktree', 'unlock', path);
  assert.equal(await readFile(join(path, 'local-cache'), 'utf8'), 'ignored work');
  await rm(join(path, 'local-cache'));
  server.app.store.put('runs', first.id, { ...server.app.store.get<Run>('runs', first.id)!,
    commitChanges: { base, head: kept, files: 3, added: 4, deleted: 1 } });
  await page.reload();
  await page.getByRole('button', { name: '查看工作树状态' }).click();
  const occupiedRun = { ...peer, worktree: undefined, id: crypto.randomUUID(), cwd: join(path, 'nested'), status: 'unknown' as const, prompt: '核对子目录中的执行' };
  server.app.store.put('runs', occupiedRun.id, occupiedRun);
  await page.reload();
  await page.getByRole('button', { name: '查看工作树状态' }).click();
  const blockers = status.getByRole('region', { name: '阻止清理的执行' });
  await expect(blockers.getByRole('link')).toHaveAttribute('href', new RegExp(occupiedRun.id + '$'));
  await expect(status.getByRole('button', { name: '清理工作树目录' })).toBeDisabled();
  assert.equal((await cleanup(kept)).status, 409);
  server.app.store.put('runs', occupiedRun.id, { ...occupiedRun, status: 'completed' });
  await status.getByRole('button', { name: '刷新状态' }).click();
  await expect(blockers).toHaveCount(0);
  await status.getByRole('button', { name: '清理工作树目录' }).click();
  const confirm = page.getByRole('dialog', { name: '清理工作树目录？' });
  await confirm.getByRole('button', { name: '取消' }).click();
  assert.equal(git(path, 'rev-parse', 'HEAD'), kept);
  await status.getByRole('button', { name: '清理工作树目录' }).click();
  await confirm.getByRole('button', { name: '确认清理目录' }).click();
  await expect(status).toContainText('工作树目录已清理，分支已保留');
  assert.equal(git(cwd, 'rev-parse', first.worktree!.branch!), kept);
  await assert.rejects(readFile(join(path, '.git')), { code: 'ENOENT' });
  assert.equal((await cleanup(kept)).status, 200);
  assert.equal((await rename('清理后修改', '接口修订')).status, 410);
  assert.match(JSON.stringify(await server.app.readRunCommitDiff(first.id, 'stage.txt')), /staged file/);
  await page.reload();
  await expect(page.getByText('工作树目录已清理 · 保留分支', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '查看保留分支' }).click();
  const retained = page.getByRole('dialog', { name: '保留分支', exact: true });
  await expect(retained).toContainText(kept);
  const readStatus = async () => JSON.parse(JSON.stringify(await statusTool.execute({ id: first.id }, new AbortController().signal)));
  const afterCleanup = await readStatus();
  assert.ok(afterCleanup.removedAt);
  assert.equal((await getHistory('unmerged')).commits[0].hash, kept);
  assert.match((await detailTool(kept, 'unmerged', 'stage.txt')).text, /staged file/);
  await assert.rejects(detailTool(kept, 'unmerged', '.env'), /不可浏览/);
  assert.equal(afterCleanup.retainedBranch.head, kept);
  assert.equal(afterCleanup.retainedBranch.unmerged, Number(git(cwd, 'rev-list', '--count', 'HEAD..' + kept)));
  incompleteBranchStatus = true;
  const incomplete = await readStatus();
  assert.equal(incomplete.removedAt, afterCleanup.removedAt);
  assert.equal(incomplete.retainedBranch, undefined);
  assert.match(incomplete.branchStatusUnavailable, /回执不完整/);
  incompleteBranchStatus = false;
  const retainedRef = 'refs/heads/' + first.worktree!.branch!;
  git(cwd, 'update-ref', retainedRef, base, kept);
  await retained.getByRole('button', { name: '刷新状态' }).click();
  await expect(retained.getByRole('button', { name: '删除执行分支' })).toBeDisabled();
  await expect(retained).toContainText('分支已偏离目录清理时的提交');
  assert.equal((await readStatus()).retainedBranch.moved, true);
  git(cwd, 'update-ref', retainedRef, kept, base);
  const occupied = join(root, 'occupied');
  git(cwd, 'worktree', 'add', '--no-checkout', occupied, first.worktree!.branch!);
  await retained.getByRole('button', { name: '刷新状态' }).click();
  await expect(retained).toContainText('分支仍在工作树中使用');
  assert.equal((await readStatus()).retainedBranch.checkedOut, true);
  await expect(retained.getByRole('button', { name: '删除执行分支' })).toBeDisabled();
  git(cwd, 'worktree', 'remove', '--force', occupied);
  await retained.getByRole('button', { name: '刷新状态' }).click();
  await retained.getByRole('button', { name: '删除执行分支' }).click();
  const deletion = page.getByRole('dialog', { name: '删除执行分支？' });
  await deletion.getByRole('button', { name: '取消' }).click();
  assert.equal(git(cwd, 'rev-parse', first.worktree!.branch!), kept);
  await retained.getByRole('button', { name: '删除执行分支' }).click();
  await deletion.getByRole('button', { name: '确认删除分支' }).click();
  await expect(retained).toContainText('执行分支已删除');
  const afterDeletion = await readStatus();
  assert.ok(afterDeletion.branchDeletedAt);
  assert.equal(afterDeletion.retainedBranch, undefined);
  assert.equal(git(cwd, 'branch', '--list', first.worktree!.branch!), '');
  assert.equal(git(cwd, 'rev-parse', 'refs/super-mario/runs/' + first.id + '/head'), kept);
  assert.match(JSON.stringify(await server.app.readRunCommitDiff(first.id, 'stage.txt')), /staged file/);
  await page.reload();
  await expect(page.getByText('工作树目录已清理 · 执行分支已删除')).toBeVisible();
  // A failed checkout must never fall back to running in the bound directory.
  const plain = join(root, 'ordinary');
  await mkdir(plain);
  const nonGit = await server.app.createProject({ name: '普通目录', workspace: { machineId: 'fixture', cwd: plain } });
  const rejected = server.app.dispatch({ ...input, cwd: plain, projectId: nonGit.id });
  await expect.poll(() => server.app.store.get<Run>('runs', rejected.id)?.status).toBe('unknown');
  assert.equal(starts.size, 2);

  await page.goto(server.url + '/#projects/' + project.id + '/runs');
  await page.getByRole('button', { name: '发起执行', exact: true }).first().click();
  await drawer.getByLabel('要做什么').fill('同一任务跑三份');
  await drawer.getByLabel('怎样算完成').fill('核对输出');
  await drawer.getByLabel('预计用时').fill('2');
  await drawer.getByLabel('从当前提交创建独立 Git 工作树').check();
  await drawer.getByLabel('从同一提交并行执行').selectOption('3');
  const sent = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/v1/runs'));
  await drawer.getByRole('button', { name: '开始执行' }).click();
  const request = await sent;
  await expect(page).toHaveURL(/compare=group$/);
  const cards = page.getByRole('region', { name: '执行对比' }).getByRole('article');
  await expect(cards).toHaveCount(3);
  await expect.poll(() => starts.size).toBe(4);
  const groupRuns = server.app.store.list<Run>('runs').filter(run => run.comparisonRunIds);
  const ids = groupRuns[0]!.comparisonRunIds!;
  assert.deepEqual(new Set(ids), new Set(groupRuns.map(run => run.id)));
  assert.ok(groupRuns.every(run => run.worktree?.base === base));
  assert.equal(baseReads, 1);
  assert.equal(groupedCheckouts, 3);
  assert.notEqual(git(cwd, 'rev-parse', 'HEAD'), base);
  for (const run of groupRuns.filter(run => starts.has(run.cwd!))) {
    assert.equal(run.worktree?.base, base);
    assert.equal(git(run.cwd!, 'rev-parse', 'HEAD'), base);
  }
  await expect(cards.filter({ hasText: '合成的工作树创建失败' })).toHaveCount(1);
  const replay = (copies: number) => fetch(request.url(), { method: 'POST', headers: {
    authorization: 'Bearer worktree-fixture', 'content-type': 'application/json',
    'idempotency-key': request.headers()['idempotency-key']!,
  }, body: JSON.stringify({ ...request.postDataJSON(), copies }) });
  assert.deepEqual((await (await replay(3)).json()).comparisonRunIds, ids);
  assert.equal((await replay(2)).status, 409);
  assert.equal(groupedCheckouts, 3);
  await page.reload();
  await expect(cards).toHaveCount(3);
  await page.goto(server.url + '/#projects/' + project.id + '/runs/' + peer.id);
  await page.getByRole('button', { name: '在此工作树发起执行' }).click();
  await expect(drawer).toContainText(peer.cwd!);
  await drawer.getByLabel('要做什么').fill('检查前一项任务留下的文件');
  await drawer.getByLabel('怎样算完成').fill('逐项核对修改');
  await drawer.getByLabel('预计用时').fill('2');
  const followupSent = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/v1/runs'));
  await drawer.getByRole('button', { name: '开始执行' }).click();
  const followupRequest = await followupSent;
  await expect.poll(() => continuedIn).toEqual([peer.cwd]);
  const child = server.app.store.list<Run>('runs').find(run => run.worktreeRunId === peer.id)!;
  assert.equal(child.cwd, peer.cwd);
  assert.equal(child.worktree, undefined);
  await page.getByRole('link', { name: '查看原工作树' }).click();
  await expect(page).toHaveURL(new RegExp(peer.id + '$'));
  const startAgain = (body: Record<string, unknown>, key: string) => fetch(followupRequest.url(), { method: 'POST', headers: {
    authorization: 'Bearer worktree-fixture', 'content-type': 'application/json', 'idempotency-key': key,
  }, body: JSON.stringify(body) });
  const params = followupRequest.postDataJSON();
  const sameKey = followupRequest.headers()['idempotency-key']!;
  assert.equal((await (await startAgain(params, sameKey)).json()).id, child.id);
  assert.equal((await startAgain({ ...params, worktreeRunId: first.id }, sameKey)).status, 409);
  assert.equal((await startAgain({ ...params, worktreeRunId: first.id }, 'removed')).status, 409);
  assert.equal((await startAgain({ ...params, projectId: nonGit.id }, 'cross-project')).status, 409);
  git(peer.cwd!, 'switch', '-c', 'changed-branch');
  const stale = await (await startAgain(params, 'stale-branch')).json();
  await expect.poll(() => server.app.store.get<Run>('runs', stale.id)?.status).toBe('failed');
  assert.deepEqual(continuedIn, [peer.cwd]);
  await page.reload();
  const related = page.getByRole('region', { name: '工作树关联执行' });
  await expect(related.getByRole('link')).toHaveCount(2);
  const followups = await runsList.execute({ worktreeRunId: peer.id }, new AbortController().signal) as unknown as Run[];
  assert.deepEqual(followups.map(run => run.id), [stale.id, child.id]);
  assert.deepEqual(await runsList.execute({ worktreeRunId: first.id }, new AbortController().signal), []);
  await expect(related.getByRole('link').first()).toHaveAttribute('href', new RegExp(stale.id + '$'));
  await related.getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(stale.id + '$'));
  await expect(page.getByText('工作树目录或分支已变化，执行未启动', { exact: false }).first()).toBeVisible();

});
