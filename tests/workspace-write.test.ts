import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createWorkspaceWrite } from '../plugins/workspace-write.ts';

const hash = (text: string | Buffer) => createHash('sha256').update(typeof text === 'string' ? Buffer.from(text, 'utf8') : text).digest('hex');
interface Written { written: boolean; undoId: string; hash: string }

/** A project with one file, and the node that writes to it. */
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-workspace-write-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'project'), dataDir = join(dir, 'agent');
  await mkdir(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'README.md'), 'first\n');
  await writeFile(join(root, 'src', 'index.ts'), 'export const version = 1;\n');
  const node = createWorkspaceWrite({ dataDir });
  const write = async (path: string, text: string, expected: string | null | undefined, cwd = root) =>
    await node.handlers['workspace.file.write']!({ cwd, path, text, ...(expected === undefined ? {} : { expected }) }, () => {}) as unknown as Written;
  const undo = async (undoId: string, expected?: string, cwd = root) =>
    await node.handlers['workspace.file.undo']!({ cwd, undoId, ...(expected === undefined ? {} : { expected }) }, () => {}) as unknown as { undone: boolean };
  return { root, dir, node, write, undo };
}

test('a file is written whole, keeps its permissions, and can be undone to what was there', async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, 'README.md'), 'utf8');
  await chmod(join(f.root, 'README.md'), 0o640);
  const result = await f.write('README.md', 'second\n', hash(before));
  assert.equal(result.written, true);
  assert.equal(result.hash, hash('second\n'));
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'second\n');
  assert.equal((await stat(join(f.root, 'README.md'))).mode & 0o777, 0o640, 'permissions are kept');
  // Nothing is left beside the file.
  assert.deepEqual((await readdir(f.root)).sort(), ['README.md', 'src']);
  // Undo puts back what was there, and the undo is used up.
  assert.equal((await f.undo(result.undoId, result.hash)).undone, true);
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'first\n');
  await assert.rejects(f.undo(result.undoId), /ENOENT|撤销/);
});

test('a file that changed on the computer since it was read is not written: the owner is told to read it again', async t => {
  const f = await fixture(t);
  const read = await readFile(join(f.root, 'README.md'), 'utf8');
  // Someone else changes it after the page read it.
  await writeFile(join(f.root, 'README.md'), 'someone else\n');
  await assert.rejects(f.write('README.md', 'mine\n', hash(read)), /已经变化/);
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'someone else\n');
  // A write without saying what was read is refused for a file that is there.
  await assert.rejects(f.write('README.md', 'mine\n', undefined), /已经变化/);
  // Nothing was kept for undo, as nothing was written.
  await assert.rejects(readdir(join(f.dir, 'agent')), { code: 'ENOENT' });
});

test('a new file is made where there was none, and undoing it removes it', async t => {
  const f = await fixture(t);
  const result = await f.write('src/new.ts', 'export {}\n', null);
  assert.equal(await readFile(join(f.root, 'src', 'new.ts'), 'utf8'), 'export {}\n');
  assert.equal((await f.undo(result.undoId, result.hash)).undone, true);
  await assert.rejects(readFile(join(f.root, 'src', 'new.ts')), { code: 'ENOENT' });
  // A new file in a directory that is not there is refused: nothing is made on the way.
  await assert.rejects(f.write('no/such/dir/file.ts', 'x', null), /ENOENT|目录/);
});

test('undo is refused when the file changed again after the write', async t => {
  const f = await fixture(t);
  const result = await f.write('README.md', 'second\n', hash('first\n'));
  await writeFile(join(f.root, 'README.md'), 'third\n');
  await assert.rejects(f.undo(result.undoId, hash('second\n')), /又变化了/);
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'third\n');
  // An undo without saying what is there now is refused too.
  await assert.rejects(f.undo(result.undoId), /又变化了/);
});

test('what is refused: a path out of the project, a sensitive file, a link, a directory, a binary file, a file too large', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'outside.txt'), 'outside');
  await symlink(join(f.dir, 'outside.txt'), join(f.root, 'link.txt'));
  for (const [path, expected] of [
    ['../outside.txt', /越出|ENOENT/],
    ['.env', /敏感/],
    ['.git/config', /敏感/],
    ['/etc/passwd', /相对路径/],
  ] as const) await assert.rejects(f.write(path, 'x', null), expected);
  // A link is not written through.
  await assert.rejects(f.write('link.txt', 'x', hash('outside')), /越出项目根目录/, 'a link to outside the project is refused as outside');
  assert.equal(await readFile(join(f.dir, 'outside.txt'), 'utf8'), 'outside');
  // A directory, a binary file and an oversized one are refused.
  await assert.rejects(f.write('src', 'x', null), /普通文本文件/);
  await writeFile(join(f.root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(f.write('binary.bin', 'x', hash(Buffer.from([0, 1, 2, 3]))), /二进制/);
  await assert.rejects(f.write('big.txt', 'x'.repeat(256 * 1024 + 1), null), /256 KiB/);
  // A root that is not what was bound is refused.
  // The root comes from the server's saved binding, so it is trusted to be a project; only the
  // filesystem root itself is refused.
  await assert.rejects(f.write('README.md', 'x', hash('first\n'), '/'), /根目录|不可写/);
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'first\n');
});

test('an undo belongs to the project it was made in', async t => {
  const f = await fixture(t);
  const result = await f.write('README.md', 'second\n', hash('first\n'));
  const other = join(f.dir, 'other');
  await mkdir(other);
  await writeFile(join(other, 'README.md'), 'other\n');
  await assert.rejects(f.undo(result.undoId, hash('second\n'), other), /不是在这个项目/);
  await assert.rejects(f.undo('not-a-uuid', hash('second\n')), /撤销编号/);
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'second\n');
  assert.equal(await readFile(join(other, 'README.md'), 'utf8'), 'other\n');
});
