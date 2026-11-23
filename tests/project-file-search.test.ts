import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { workspaceCode } from '../plugins/workspace-code.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

test('文件名按路径词序和文件名边界排名，Git 忽略项、越界链接和凭证不进入结果', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-file-finder-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  await mkdir(join(root, 'views'), { recursive: true });
  const search = async (query: string) => await workspaceCode({ cwd: root, kind: 'search', query }, () => {}) as { paths: string[]; truncated: boolean };
  for (const path of ['views/MapView.ts', 'views/mapview.ts', 'views/not-indexed.ts', 'views/tracked.ts', '.env.local']) {
    await writeFile(join(root, path), 'OnlyTheBodyMatches');
  }
  await writeFile(join(dir, 'outside.ts'), '合成外部文件');
  await symlink(join(dir, 'outside.ts'), join(root, 'views/outside.ts'));
  await symlink(dir, join(root, 'jump'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'dependency.ts'), '');
  assert.deepEqual(await search('mv'), { paths: ['views/MapView.ts', 'views/mapview.ts'], truncated: false });
  assert.deepEqual(await search('OnlyTheBodyMatches'), { paths: [], truncated: false });
  const originalPath = process.env.PATH!;
  try {
    process.env.PATH = join(dir, 'no-git-here');
    assert.deepEqual((await search('MapView.ts')).paths, ['views/MapView.ts', 'views/mapview.ts']);
  } finally { process.env.PATH = originalPath; }
  for (const query of ['outside', '.env', 'dependency']) assert.deepEqual((await search(query)).paths, []);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'views/tracked.ts'], { cwd: root });
  await writeFile(join(root, '.gitignore'), 'views/tracked.ts\nviews/not-indexed.ts\n');
  assert.deepEqual((await search('not-indexed')).paths, []);
  assert.deepEqual((await search('tracked')).paths, ['views/tracked.ts']);
  assert.deepEqual((await search('views map')).paths, (await search('map views')).paths);
  assert.deepEqual((await search('mv')).paths, ['views/MapView.ts', 'views/mapview.ts']);
  for (const query of ['outside', 'dependency', '.env']) assert.deepEqual((await search(query)).paths, []);
  await Promise.all(Array.from({ length: 51 }, (_, i) => writeFile(join(root, 'entry' + i), '')));
  const limited = await search('entry');
  assert.equal(limited.paths.length, 50);
  assert.equal(limited.truncated, true);
});

test('文件搜索 HTTP 按项目绑定发起 RPC，拒绝未授权、停用插件、越权参数及读取中重新绑定', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-file-search-api-'));
  const root = join(dir, 'work'), other = join(dir, 'other');
  await mkdir(root);
  await mkdir(other);
  await writeFile(join(root, 'project.txt'), '');
  await writeFile(join(other, 'private.txt'), '');
  const token = 'fixture-file-search-token';
  const server = await startServer({ host: '127.0.0.1', port: 0, token, demo: true, dataDir: join(dir, 'data') });
  let release!: () => void, signalStarted!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  let pause = false;
  const node = startAgentNode({ url: server.url, token, machineId: 'finder-fixture', name: '文件测试机', dataDir: join(dir, 'agent'), executors: [],
    handlers: { ...createProjectDiscovery({ home: dir, ignoreEnvironmentRoots: true, roots: [], temporaryRoots: [] }).handlers,
      'workspace.code': async (params, emit) => {
        if (pause) { signalStarted(); await hold; }
        return workspaceCode(params, emit);
      } },
  });
  t.after(async () => { release(); await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await t.waitFor(() => assert.ok(server.machines.list().some(item => item.id === 'finder-fixture' && item.online)));
  const project = await server.app.createProject({ name: '合成项目', workspace: { machineId: 'finder-fixture', cwd: root } });
  const url = server.url + '/api/v1/projects/' + project.id + '/code?kind=search&query=txt';
  const get = (extra = '') => fetch(url + extra, { headers: { authorization: 'Bearer ' + token } });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await get('&cwd=' + encodeURIComponent(other))).status, 400);
  assert.deepEqual(await (await get()).json(), { paths: ['project.txt'], truncated: false });
  await server.app.plugins.setEnabled('conversation-search', false);
  assert.equal((await get()).status, 503);
  await server.app.plugins.setEnabled('conversation-search', true);
  pause = true;
  const stale = get();
  await started;
  server.app.store.put('projects', project.id, { ...project, workspace: { machineId: 'finder-fixture', cwd: other } });
  release();
  const rejected = await stale;
  assert.equal(rejected.status, 409);
  assert.doesNotMatch(await rejected.text(), /project\.txt/);
  assert.deepEqual(await (await get()).json(), { paths: ['private.txt'], truncated: false });
});
