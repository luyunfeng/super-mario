import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

test('项目只创建工作树时返回独立目录，不生成或派发执行', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mario-project-worktree-'));
  const cwd = join(root, 'repo');
  await mkdir(cwd);
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git(cwd, 'init', '-q');
  git(cwd, 'commit', '--allow-empty', '-qm', 'baseline');
  const token = 'synthetic-worktree-token';
  const server = await startServer({ dataDir: join(root, 'server'), host: '127.0.0.1', port: 0, demo: true, token });
  const discovery = createProjectDiscovery({ home: root, cwd, roots: [], temporaryRoots: [] });
  const starts: unknown[] = [];
  const agent = startAgentNode({ url: server.url, token, machineId: 'fixture', name: 'fixture', dataDir: join(root, 'node'),
    executors: [{ id: 'codex', machineId: 'fixture', name: '协议替身', kind: 'cli', available: true, mode: 'real', description: '合成测试' }],
    handlers: { ...discovery.handlers, 'executor.start': async args => {
      starts.push(args.cwd);
      return { sessionId: 'synthetic-session' };
    } } });
  t.after(async () => {
    try { await agent.close(); await server.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await t.waitFor(() => assert.ok(server.machines.list().some(machine => machine.id === 'fixture' && machine.online)));
  const project = await server.app.createProject({ name: '示例项目', workspace: { machineId: 'fixture', cwd } });
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const worktreesUrl = server.url + '/api/v1/projects/' + project.id + '/worktrees';
  const response = await fetch(worktreesUrl, { method: 'POST', headers, body: JSON.stringify({ name: '独立准备' }) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  assert.equal(result.name, '独立准备');
  assert.notEqual(result.cwd, cwd);
  assert.equal(git(result.cwd, 'rev-parse', '--show-toplevel'), result.cwd);
  assert.equal(git(result.cwd, 'rev-parse', 'HEAD'), git(cwd, 'rev-parse', 'HEAD'));
  assert.ok(git(cwd, 'worktree', 'list', '--porcelain').split('\n').includes('worktree ' + result.cwd));
  const replay = await fetch(worktreesUrl, { method: 'POST', headers, body: JSON.stringify({ name: '独立准备' }) });
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), result);
  const listed = await fetch(worktreesUrl, { headers });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).map(({ name, cwd }: { name: string; cwd: string }) => ({ name, cwd })),
    [{ name: result.name, cwd: result.cwd }]);
  assert.deepEqual(starts, []);
  assert.equal(server.app.store.list('runs').length, 0);

  const launch = await fetch(server.url + '/api/v1/runs', { method: 'POST', headers, body: JSON.stringify({
    projectId: project.id, cwd: result.cwd, executorId: 'fixture/codex', prompt: '检查独立目录', doneWhen: '返回结果', expectMinutes: 1,
  }) });
  assert.equal(launch.status, 202, await launch.text());
  await t.waitFor(() => assert.deepEqual(starts, [result.cwd]));
  assert.equal(server.app.store.list('runs').length, 1);
});
