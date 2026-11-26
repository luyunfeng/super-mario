import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateRelease, installRelease, listReleases, ReleaseError, releaseRoot, rollbackRelease } from '../packages/core/src/release.ts';

/** A built checkout as a release is made from it: bin, dist and package.json. */
async function builtTree(root: string, name: string, commit: string, record: unknown = { commit, builtAt: '2026-11-26T12:00:00.000Z', dirty: false }) {
  const tree = join(root, 'builds', name);
  await mkdir(join(tree, 'dist'), { recursive: true });
  await mkdir(join(tree, 'bin'), { recursive: true });
  await writeFile(join(tree, 'bin', 'super-mario.js'), '#!/usr/bin/env node\n');
  await writeFile(join(tree, 'package.json'), JSON.stringify({ name: 'super-mario', type: 'module' }) + '\n');
  await writeFile(join(tree, 'dist', 'build-info.json'), JSON.stringify(record) + '\n');
  await writeFile(join(tree, 'dist', 'marker.js'), 'export const commit = ' + JSON.stringify(commit) + ';\n');
  return tree;
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mario-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releases = releaseRoot(join(root, 'install'));
  // A release links to the installed modules instead of carrying them.
  const dependencies = join(root, 'node_modules');
  await mkdir(dependencies);
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
  return {
    root, releases, a, b, c, dependencies,
    install: (tree: string, modules: string = dependencies) => installRelease(releases, tree, modules),
    tree: (name: string, commit: string, record?: unknown) => builtTree(root, name, commit, record),
    current: async () => readlink(releases.current),
    marker: async (commit: string) => (await readFile(join(releases.directory, 'releases', commit, 'dist', 'marker.js'), 'utf8')).includes(commit),
  };
}

test('安装把构建产物放到以提交号命名的目录，重复安装得到完整的目录', async t => {
  const f = await fixture(t);
  assert.deepEqual(await listReleases(f.releases), { current: undefined, previous: undefined, releases: [] });
  assert.deepEqual(await f.install(await f.tree('a', f.a)), { commit: f.a, builtAt: '2026-11-26T12:00:00.000Z', dirty: false });
  assert.equal(await f.marker(f.a), true);
  // The dependencies are one link to the installed modules, not a copy of them.
  assert.equal(await readlink(join(f.releases.directory, 'releases', f.a, 'node_modules')), f.dependencies);
  assert.deepEqual((await listReleases(f.releases)).releases, [{ commit: f.a, builtAt: '2026-11-26T12:00:00.000Z', dirty: false }]);
  // Installing again replaces the directory, so a damaged one is made whole.
  await rm(join(f.releases.directory, 'releases', f.a, 'dist', 'marker.js'));
  await f.install(await f.tree('a', f.a));
  assert.equal(await f.marker(f.a), true);
  // A leftover partial directory from an interrupted install is replaced, not trusted.
  await rm(join(f.releases.directory, 'releases', f.a), { recursive: true });
  await mkdir(join(f.releases.directory, 'releases', f.a, 'dist'), { recursive: true });
  await f.install(await f.tree('a', f.a));
  assert.equal(await f.marker(f.a), true);
});

test('没有构建记录、提交号未知或含未提交改动的构建不能安装', async t => {
  const f = await fixture(t);
  const at = '2026-11-26T12:00:00.000Z';
  for (const [name, commit, record, message] of [
    ['no-record', f.a, undefined, /没有构建记录/],
    ['unknown', f.a, { commit: 'unknown', builtAt: at, dirty: false }, /没有记录提交号/],
    ['dirty', f.a, { commit: f.a, builtAt: at, dirty: true }, /含未提交的改动/],
    ['short', f.a, { commit: 'abc', builtAt: at, dirty: false }, /没有记录提交号|构建记录|提交号/],
    // A record that cannot be read as a record reads as no commit, which is what is reported.
    ['bad-time', f.a, { commit: f.a, builtAt: 'yesterday', dirty: false }, /没有记录提交号/],
  ] as const) {
    // A complete checkout whose record is the case in question, so only that rule can refuse it.
    const tree = await f.tree(name, commit, record ?? { commit, builtAt: at, dirty: false });
    if (!record) await rm(join(tree, 'dist', 'build-info.json'));
    await assert.rejects(f.install(tree), (error: unknown) => {
      return error instanceof ReleaseError && message.test(error.message);
    }, name);
  }
  // A checkout without one of the three parts a release needs is refused, and says which.
  for (const part of ['bin', 'dist', 'package.json']) {
    const tree = await f.tree('missing-' + part, f.a);
    await rm(join(tree, part), { recursive: true, force: true });
    await assert.rejects(f.install(tree), (error: unknown) => {
      return error instanceof ReleaseError && error.message.includes('缺少 ' + part);
    }, part);
  }
  // The dependencies are linked rather than copied, so a missing one is refused at install
  // time, which is before the release would fail to start.
  await assert.rejects(f.install(await f.tree('a', f.a), join(f.root, 'no-modules')), /找不到依赖目录/);
  const notDirectory = join(f.root, 'a-file');
  await writeFile(notDirectory, 'not a directory');
  await assert.rejects(f.install(await f.tree('a', f.a), notDirectory), /依赖目录不是目录/);
  assert.deepEqual(await listReleases(f.releases), { current: undefined, previous: undefined, releases: [] }, 'nothing was installed');
  // A checkout that is not there has none of the parts, and the first missing one is named.
  await assert.rejects(f.install(join(f.root, 'missing')), /缺少 bin/);
});

test('切换是一个原子动作：当前链接始终指向一个完整的版本，并记住上一个版本', async t => {
  const f = await fixture(t);
  await f.install(await f.tree('a', f.a));
  await f.install(await f.tree('b', f.b));
  assert.deepEqual(await activateRelease(f.releases, f.a), { from: undefined, to: f.a });
  assert.equal(await f.current(), 'releases/' + f.a);
  // No earlier release yet, so there is nothing to roll back to.
  assert.equal((await listReleases(f.releases)).previous, undefined);
  await assert.rejects(rollbackRelease(f.releases), /没有可回退的版本/);
  assert.deepEqual(await activateRelease(f.releases, f.b), { from: f.a, to: f.b });
  assert.equal(await f.current(), 'releases/' + f.b);
  assert.equal(await readlink(f.releases.previous), 'releases/' + f.a);
  // Switching to the release that is already current changes nothing.
  assert.deepEqual(await activateRelease(f.releases, f.b), { from: f.b, to: f.b });
  assert.equal(await readlink(f.releases.previous), 'releases/' + f.a, 'the previous release is still the one before the switch');
  // No temporary link is left behind.
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(f.releases.directory)).sort(), ['current', 'previous', 'releases']);
});

test('回滚切回上一个版本；未安装或格式不对的版本不能切换', async t => {
  const f = await fixture(t);
  await f.install(await f.tree('a', f.a));
  await f.install(await f.tree('b', f.b));
  await activateRelease(f.releases, f.a);
  await activateRelease(f.releases, f.b);
  assert.deepEqual(await rollbackRelease(f.releases), { from: f.b, to: f.a });
  assert.equal(await f.current(), 'releases/' + f.a);
  assert.equal(await readlink(f.releases.previous), 'releases/' + f.b);
  // A rollback is itself a switch, so rolling back again returns to the release just left.
  assert.deepEqual(await rollbackRelease(f.releases), { from: f.a, to: f.b });
  assert.equal(await f.current(), 'releases/' + f.b);
  // A release that is not installed, or a name that is not a commit, is refused.
  await assert.rejects(activateRelease(f.releases, f.c), /尚未安装/);
  for (const bad of ['abc', f.a.toUpperCase(), f.a + '0', '', 'releases/x', '../' + f.a]) {
    await assert.rejects(activateRelease(f.releases, bad), /完整的提交号/, JSON.stringify(bad));
  }
  assert.equal(await f.current(), 'releases/' + f.b, 'a refused switch leaves the current release as it was');
});

test('正在运行的版本不能被原地覆盖；目录被文件占用或记录与目录名不符时如实报告', async t => {
  const f = await fixture(t);
  await f.install(await f.tree('a', f.a));
  await activateRelease(f.releases, f.a);
  await assert.rejects(f.install(await f.tree('a-again', f.a)), /正在运行，不能原地覆盖/);
  assert.equal(await f.marker(f.a), true, 'the running release is untouched');
  // Switching away makes reinstalling it possible.
  await f.install(await f.tree('b', f.b));
  await activateRelease(f.releases, f.b);
  await f.install(await f.tree('a-again', f.a));
  // A directory whose record names another commit is not listed as a release.
  await mkdir(join(f.releases.directory, 'releases', f.c, 'dist'), { recursive: true });
  await writeFile(join(f.releases.directory, 'releases', f.c, 'dist', 'build-info.json'), JSON.stringify({ commit: f.a, builtAt: '2026-11-26T12:00:00.000Z', dirty: false }));
  assert.deepEqual((await listReleases(f.releases)).releases.map(release => release.commit).sort(), [f.a, f.b].sort());
  await assert.rejects(activateRelease(f.releases, f.c), /尚未安装/);
});
