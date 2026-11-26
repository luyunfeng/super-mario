import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { activateRelease, installRelease, listReleases, releaseRoot, rollbackRelease } from '../packages/core/src/release.ts';

const run = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));

/** A free port, so two servers in this test never compete for one. */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

/** Runs the server from the release the current link points at, against the given data. */
async function start(install: string, dataDir: string) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(install, 'current', 'bin', 'super-mario.js'), '--host', '127.0.0.1', '--port', String(port),
    '--data-dir', dataDir, '--demo', '--token', 'offline-upgrade-token'], { cwd: join(install, 'current'), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exit = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit;
  };
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { started: false as const, output, stop, exit: await exit };
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/api/v1/health', { signal: AbortSignal.timeout(500) });
      if (response.ok) return { started: true as const, url: 'http://127.0.0.1:' + port, stop,
        health: await response.json() as { build: { commit: string } } };
    } catch { /* Not listening yet. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await stop();
  return { started: false as const, output, stop, exit };
}

const headers = { authorization: 'Bearer offline-upgrade-token', 'content-type': 'application/json' };

test('升级后新版本起不来：回滚到上一个版本，旧版本照常启动，升级前写入的数据都还在', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mario-upgrade-failure-'));
  const older = await mkdtemp(join(tmpdir(), 'mario-upgrade-older-'));
  const newer = await mkdtemp(join(tmpdir(), 'mario-upgrade-newer-'));
  // Servers are stopped before their directories are removed. A server that is asked to stop
  // after its files are gone cannot finish closing, and the cleanup would wait for it forever.
  const running: Array<{ stop(): Promise<void> }> = [];
  t.after(async () => {
    for (const server of running) await server.stop();
    for (const directory of [root, older, newer]) await rm(directory, { recursive: true, force: true });
  });
  // The built tree already in the checkout is copied twice. Each copy gets a record written
  // here, so the test is about releasing and rolling back, and does not depend on whether the
  // checkout has uncommitted changes.
  const oldCommit = 'a'.repeat(40), newCommit = 'b'.repeat(40);
  const at = new Date().toISOString();
  const record = (commit: string) => JSON.stringify({ commit, builtAt: at, dirty: false }) + '\n';
  for (const [tree, commit] of [[older, oldCommit], [newer, newCommit]] as const) {
    for (const part of ['bin', 'dist', 'package.json']) await cp(join(repository, part), join(tree, part), { recursive: true });
    await writeFile(join(tree, 'dist', 'build-info.json'), record(commit));
  }
  const install = releaseRoot(join(root, 'install'));
  const dataDir = join(root, 'data');
  // The releases run against the checkout's installed modules, the way a live install does.
  const dependencies = join(repository, 'node_modules');
  await installRelease(install, older, dependencies);
  await activateRelease(install, oldCommit);

  // The owner works in the release before the upgrade.
  const before = await start(install.directory, dataDir);
  assert.equal(before.started, true, 'the release before the upgrade starts: ' + (before.started ? '' : before.output));
  running.push(before);
  assert.equal(before.health.build.commit, oldCommit, 'the server reports the release it runs from');
  const created = await fetch(before.url + '/api/v1/projects', { method: 'POST', headers, body: JSON.stringify({ name: '升级前建立的项目' }) });
  assert.equal(created.status, 201);
  const projectId = ((await created.json()) as { id: string }).id;
  await before.stop();

  // A new release that cannot start: its server module is missing.
  await rm(join(newer, 'dist', 'apps', 'server', 'src', 'index.js'));
  await installRelease(install, newer, dependencies);
  await activateRelease(install, newCommit);
  const failed = await start(install.directory, dataDir);
  assert.equal(failed.started, false, 'the new release cannot start');
  assert.match(failed.output, /Cannot find module|MODULE_NOT_FOUND|ENOENT/);
  await failed.stop();

  // Roll back. The earlier release starts again from the same data directory.
  assert.deepEqual(await rollbackRelease(install), { from: newCommit, to: oldCommit });
  const after = await start(install.directory, dataDir);
  assert.equal(after.started, true, 'the earlier release starts after the rollback: ' + (after.started ? '' : after.output));
  running.push(after);
  assert.equal(after.health.build.commit, oldCommit);
  const projects = await (await fetch(after.url + '/api/v1/projects', { headers })).json() as { id: string; name: string }[];
  assert.deepEqual(projects.map(project => [project.id, project.name]), [[projectId, '升级前建立的项目']], 'the work done before the upgrade is still there');
  const state = await listReleases(install);
  assert.equal(state.current, oldCommit);
  // Rolling back is itself a switch, so the release just left is now the previous one.
  assert.equal(state.previous, newCommit);
});
