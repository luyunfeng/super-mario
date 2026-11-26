// Writing a file of a bound project from the page, and undoing it. The page shows a file, the
// owner changes it, and the change is written to the computer the project is on.
//
// Two things can go wrong and each is refused before anything is written: the file changed on
// the computer since the page read it (the owner would overwrite someone's work), and the path
// is not an ordinary file inside the project. An undo puts back what was there before the write.
import { constants } from 'node:fs';
import { open, realpath, lstat, mkdir, rename, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { NodeHandler } from '../packages/plugin-sdk/src/index.ts';
import type { Json } from '../packages/protocol/src/index.ts';
import { sensitiveWorkspacePath } from './workspace-code.ts';

/** The most that is read or written, as the page reads files of at most this size. */
const limit = 256 * 1024;
/** Where what was replaced is kept for undo, under the agent's own data directory. */
const UNDO_DIR = 'file-undo';
/** How many undos are kept. Older ones go, oldest first. */
const UNDO_MOST = 100;

function inside(root: string, path: string) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('路径越出项目根目录');
  if (sensitiveWorkspacePath(rel)) throw new Error('敏感文件不可写');
}

/** The root of the bound project, as the server supplies it, checked as it is on this computer. */
async function projectRoot(cwd: unknown): Promise<string> {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || /[\0\r\n]/.test(cwd)) throw new Error('项目根目录无效');
  const root = await realpath(cwd);
  if (root !== resolve(cwd)) throw new Error('项目根目录已变化，请重新绑定');
  if (root === resolve('/') || sensitiveWorkspacePath(root)) throw new Error('这个目录不可写');
  return root;
}

/** The file as it is now, or undefined when there is none yet. It is read the way the page reads
 *  it: an ordinary file, not a link, UTF-8 text, and within the size the page shows. */
async function current(root: string, requested: string): Promise<{ text: string; hash: string } | undefined> {
  let canonical: string;
  try { canonical = await realpath(requested); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  inside(root, canonical);
  const info = await lstat(canonical);
  if (info.isSymbolicLink()) throw new Error('不通过符号链接写文件');
  if (!info.isFile()) throw new Error('只允许写普通文本文件');
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (process.platform === 'linux') inside(root, await realpath('/proc/self/fd/' + handle.fd));
    const value = await handle.stat();
    if (!value.isFile() || value.size > limit) throw new Error('文件过大，上限 256 KiB');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('文件过大，上限 256 KiB');
    const data = buffer.subarray(0, bytesRead);
    if (data.some(byte => byte < 32 && ![9, 10, 13].includes(byte))) throw new Error('二进制文件不可写');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Error('只支持 UTF-8 文本文件'); }
    return { text, hash: createHash('sha256').update(data).digest('hex') };
  } finally { await handle.close(); }
}

export function createWorkspaceWrite(options: { dataDir: string }) {
  const undoDir = resolve(options.dataDir, UNDO_DIR);
  /** What was replaced is written first, whole, under a temporary name and then renamed. */
  async function keepUndo(root: string, path: string, before: string | null): Promise<string> {
    const id = randomUUID();
    await mkdir(undoDir, { recursive: true, mode: 0o700 });
    const file = resolve(undoDir, id + '.json');
    const temp = file + '.' + randomUUID() + '.tmp';
    const body = JSON.stringify({ root, path, before, at: new Date().toISOString() });
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(body, 'utf8'); } finally { await handle.close(); }
    await rename(temp, file);
    // The oldest undos go once there are too many, so that the directory does not grow without end.
    const kept = (await readdir(undoDir)).filter(name => name.endsWith('.json')).sort();
    for (const name of kept.slice(0, Math.max(0, kept.length - UNDO_MOST))) await rm(resolve(undoDir, name), { force: true });
    return id;
  }
  async function undoRecord(id: unknown) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('撤销编号无效');
    return JSON.parse(await readFile(resolve(undoDir, id + '.json'), 'utf8')) as { root: string; path: string; before: string | null; at: string };
  }
  const handlers: Record<string, NodeHandler> = {
    'workspace.file.write': async params => {
      const root = await projectRoot(params.cwd);
      const path = params.path;
      if (typeof path !== 'string' || isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error('只接受项目内相对路径');
      const requested = resolve(root, path); inside(root, requested);
      if (typeof params.text !== 'string' || Buffer.byteLength(params.text, 'utf8') > limit) throw new Error('文件内容无效或超过 256 KiB');
      // A file is not written through a directory that is a link, or one that does not exist yet
      // for a file that does: a new file may be made, but only in a directory that is already there.
      const existing = await current(root, requested);
      const expected = params.expected;
      if (existing) {
        if (typeof expected !== 'string' || expected !== existing.hash) throw new Error('文件在电脑上已经变化，请重新读取后再保存');
      } else {
        if (expected !== null && expected !== undefined) throw new Error('文件在电脑上已经变化，请重新读取后再保存');
        const parent = await realpath(dirname(requested));
        inside(root, parent);
        if (!(await lstat(dirname(requested))).isDirectory()) throw new Error('只能在没有符号链接的目录里新建文件');
      }
      const id = await keepUndo(root, path, existing?.text ?? null);
      const canonical = existing ? await realpath(requested) : requested;
      const temp = canonical + '.' + randomUUID() + '.tmp';
      const handle = await open(temp, 'wx', existing ? (await lstat(canonical)).mode & 0o777 : 0o644);
      try { await handle.writeFile(params.text, 'utf8'); } finally { await handle.close(); }
      await rename(temp, canonical);
      return { root, path, written: true, undoId: id, hash: createHash('sha256').update(Buffer.from(params.text, 'utf8')).digest('hex') } as unknown as Json;
    },
    'workspace.file.undo': async params => {
      const root = await projectRoot(params.cwd);
      const record = await undoRecord(params.undoId);
      if (record.root !== root) throw new Error('这次修改不是在这个项目里做的');
      const requested = resolve(root, record.path); inside(root, requested);
      // Undo is refused if the file changed again after the write: it would take that work away.
      const existing = await current(root, requested);
      const expected = params.expected;
      if (existing) {
        if (typeof expected !== 'string' || expected !== existing.hash) throw new Error('文件在保存后又变化了，不能撤销，请重新读取');
      } else if (record.before !== null) throw new Error('文件已经不在了，不能撤销');
      if (record.before === null) {
        // There was no file before: undo removes it.
        if (existing) await unlink(requested);
      } else {
        const temp = requested + '.' + randomUUID() + '.tmp';
        const handle = await open(temp, 'wx', 0o644);
        try { await handle.writeFile(record.before, 'utf8'); } finally { await handle.close(); }
        await rename(temp, requested);
      }
      await rm(resolve(undoDir, String(params.undoId) + '.json'), { force: true });
      return { root, path: record.path, undone: true } as unknown as Json;
    },
  };
  return { handlers };
}
