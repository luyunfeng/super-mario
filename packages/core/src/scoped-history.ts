import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, parse, resolve, sep } from 'node:path';

export function scopedHistoryName(conversation: string) {
  return createHash('sha256').update(conversation).digest('hex');
}

function unsafe(): never {
  throw Object.assign(new Error('托管 Agent 历史目录含不安全路径，无法清理'), { status: 409 });
}
const fdPath = (fd: number) => process.platform === 'linux' ? '/proc/self/fd/' + fd : '/dev/fd/' + fd;
function openDir(path: string): number {
  try { return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) {
    if (['ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) unsafe();
    throw error;
  }
}
// Linux bind mounts can expose another directory on the very same device.
function mountId(fd: number): string {
  if (process.platform !== 'linux') return String(fstatSync(fd).dev);
  const id = /^mnt_id:\s*(\d+)$/m.exec(readFileSync('/proc/self/fdinfo/' + fd, 'utf8'))?.[1];
  if (!id) unsafe();
  return id;
}
// Open each component relative to its pinned parent so a replaced ancestor can
// never redirect traversal into a workspace during an awaited host operation.
function openHistoryRoot(dataDir: string) {
  const path = resolve(dataDir, 'pi', 'agents'), root = parse(path).root;
  let fd = openDir(root);
  try {
    const components = path.slice(root.length).split(sep);
    for (const [index, name] of components.entries()) {
      const next = openDir(join(fdPath(fd), name));
      const previous = fd;
      fd = next;
      try {
        if (index >= components.length - 2 && mountId(previous) !== mountId(next)) unsafe();
      } finally { closeSync(previous); }
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
function visit(path: string, mount: string, remove: boolean) {
  const fd = openDir(path);
  try {
    if (mountId(fd) !== mount) unsafe();
    for (const name of readdirSync(fdPath(fd))) {
      const child = join(fdPath(fd), name), info = lstatSync(child);
      if (info.isDirectory()) visit(child, mount, remove);
      else if (info.isFile()) { if (remove) unlinkSync(child); }
      else unsafe();
    }
    if (remove) rmdirSync(path);
  } finally { closeSync(fd); }
}

/** The host invokes removal after the durable purge fence and final dependency
 * checks, while the project and message ownership evidence are still available. */
export function checkScopedHistory(dataDir: string, conversations: Set<string>, remove: boolean) {
  const fd = openHistoryRoot(dataDir);
  if (fd === undefined) return;
  try {
    const mount = mountId(fd);
    const paths = [...conversations].map(id => join(fdPath(fd), scopedHistoryName(id)))
      .filter(path => lstatSync(path, { throwIfNoEntry: false }));
    // Check every owned tree before touching any of them.
    for (const path of paths) visit(path, mount, false);
    if (remove) for (const path of paths) visit(path, mount, true);
  } finally { closeSync(fd); }
}
