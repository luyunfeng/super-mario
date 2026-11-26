import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const cli = new URL('../bin/super-mario.js', import.meta.url).pathname;

/** Runs the real command line against a throwaway install directory. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mario-release-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const install = join(root, 'install');
  const env = { PATH: process.env.PATH, HOME: root, SUPER_MARIO_DEV: '1' };
  const call = async (args: string[], success = true) => {
    let output = '', ok = true;
    try {
      const result = await run(process.execPath, [cli, 'release', ...args, '--root', install], { cwd: root, env, timeout: 20000 });
      output = result.stdout;
    } catch (error) {
      ok = false;
      output = ((error as { stdout?: string }).stdout ?? '') + ((error as { stderr?: string }).stderr ?? '');
    }
    assert.equal(ok, success, args.join(' ') + '\n' + output);
    // A failure is one plain line that names the kind of work that failed and the reason.
    if (!success) {
      assert.match(output, /^发布操作失败：[^\n]+\n?$/, args.join(' ') + '\n' + output);
      return [{ message: output.trim().slice('发布操作失败：'.length) }];
    }
    // Each action answers with one JSON line that a person and a script can both read.
    return output.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  };
  const build = async (name: string, commit: string, record: unknown = { commit, builtAt: '2026-11-26T12:00:00.000Z', dirty: false }) => {
    const tree = join(root, 'builds', name);
    await mkdir(join(tree, 'dist'), { recursive: true });
    await mkdir(join(tree, 'bin'), { recursive: true });
    // The release links to this directory for its modules.
    await mkdir(join(tree, 'node_modules'), { recursive: true });
    await writeFile(join(tree, 'bin', 'super-mario.js'), '#!/usr/bin/env node\n');
    await writeFile(join(tree, 'package.json'), '{"name":"super-mario","type":"module"}\n');
    await writeFile(join(tree, 'dist', 'build-info.json'), JSON.stringify(record) + '\n');
    await writeFile(join(tree, 'dist', 'marker.js'), 'export const commit = ' + JSON.stringify(commit) + ';\n');
    return tree;
  };
  return { root, install, call, build, current: () => readlink(join(install, 'current')) };
}

test('发布命令行：安装、列出、切换、回滚，每一步都说明结果和下一步', async t => {
  const f = await fixture(t);
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  // --help is the one answer that is text, so it is read on its own.
  const help = (await run(process.execPath, [cli, 'release', '--help'], { cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root, SUPER_MARIO_DEV: '1' } })).stdout;
  assert.match(help, /super-mario release install/);
  assert.match(help, /systemctl --user restart super-mario\.service super-mario-agent\.service/);

  const [installed] = await f.call(['install', '--from', await f.build('a', a)]);
  assert.equal(installed!.action, 'install');
  assert.equal(installed!.commit, a);
  assert.match(String(installed!.message), /已安装 a{10}。用 super-mario release activate/);

  const [listed] = await f.call(['list']);
  assert.deepEqual(listed!.releases, [{ commit: a, builtAt: '2026-11-26T12:00:00.000Z', dirty: false }]);
  assert.equal(listed!.message, '当前 无，上一个 无，已安装 aaaaaaaaaa');

  const [activated] = await f.call(['activate', a]);
  assert.equal(activated!.from, undefined);
  assert.equal(activated!.to, a);
  assert.equal(await f.current(), 'releases/' + a);
  assert.match(String(activated!.message), /当前已是 a{10}。现在重启服务。/);

  await f.call(['install', '--from', await f.build('b', b)]);
  const [switched] = await f.call(['activate', b]);
  assert.equal(switched!.from, a);
  assert.equal(switched!.to, b);
  assert.equal(await f.current(), 'releases/' + b);
  assert.match(String(switched!.message), /已从 a{10} 切换到 b{10}。现在重启服务。/);
  const [afterSwitch] = await f.call(['list']);
  assert.equal(afterSwitch!.message, '当前 bbbbbbbbbb，上一个 aaaaaaaaaa，已安装 aaaaaaaaaa、bbbbbbbbbb');

  const [rolled] = await f.call(['rollback']);
  assert.equal(rolled!.from, b);
  assert.equal(rolled!.to, a);
  assert.equal(await f.current(), 'releases/' + a);
  assert.match(String(rolled!.message), /已从 b{10} 回退到 a{10}。现在重启服务。/);
});

test('发布命令行：被拒绝的操作说明原因，并以非零状态退出，当前版本不变', async t => {
  const f = await fixture(t);
  const a = 'a'.repeat(40), c = 'c'.repeat(40);
  const at = '2026-11-26T12:00:00.000Z';
  // Nothing is installed, so there is nothing to switch to or roll back to.
  const [notInstalled] = await f.call(['activate', a], false);
  assert.match(String(notInstalled!.message), /尚未安装/);
  const [nothing] = await f.call(['rollback'], false);
  assert.match(String(nothing!.message), /没有可回退的版本/);
  // A build with uncommitted changes is refused.
  const [dirty] = await f.call(['install', '--from', await f.build('dirty', a, { commit: a, builtAt: at, dirty: true })], false);
  assert.match(String(dirty!.message), /含未提交的改动/);
  // A commit that is not a commit, and a bad subcommand.
  const [badName] = await f.call(['activate', 'abc'], false);
  assert.match(String(badName!.message), /完整的提交号/);
  const [badCommand] = await f.call(['publish'], false);
  assert.match(String(badCommand!.message), /子命令或参数无效/);
  await assert.rejects(readlink(join(f.install, 'current')));
  assert.equal((await f.call(['list']))[0]!.message, '当前 无，上一个 无，已安装 无');
});
