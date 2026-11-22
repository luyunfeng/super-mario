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
  const starts = new Map<string, string>();
  const node = startAgentNode({ url: server.url, token: 'worktree-fixture', machineId: 'fixture', name: 'fixture', dataDir: join(root, 'node'),
    executors: [{ id: 'codex', machineId: 'fixture', name: '协议替身', kind: 'cli', available: true, mode: 'real', description: 'fixture' }],
    handlers: { ...discovery.handlers, 'executor.start': async args => {
      const path = String(args.cwd);
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
  // A failed checkout must never fall back to running in the bound directory.
  const plain = join(root, 'ordinary');
  await mkdir(plain);
  const nonGit = await server.app.createProject({ name: '普通目录', workspace: { machineId: 'fixture', cwd: plain } });
  const rejected = server.app.dispatch({ ...input, cwd: plain, projectId: nonGit.id });
  await expect.poll(() => server.app.store.get<Run>('runs', rejected.id)?.status).toBe('unknown');
  assert.equal(starts.size, 2);

});
