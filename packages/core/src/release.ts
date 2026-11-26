import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseBuildRecord } from './build-info.ts';

export class ReleaseError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'ReleaseError'; this.status = status; }
}

/** Where the releases of one installation live, and which one is current. */
export interface ReleaseRoot {
  /** Holds one directory per release, named after the commit it was built from. */
  directory: string;
  /** The link the services run from. It is replaced, never edited in place. */
  current: string;
  /** Remembers which release was current before the last switch. */
  previous: string;
}

const sha = /^[0-9a-f]{40}$/;

function fail(message: string, status = 400): never { throw new ReleaseError(message, status); }

/** The layout under one installation directory, which holds releases, current and previous. */
export function releaseRoot(directory: string): ReleaseRoot {
  const resolved = resolve(directory);
  return { directory: resolved, current: join(resolved, 'current'), previous: join(resolved, 'previous') };
}

/** The release a link points at, as its commit, or undefined when the link is absent or broken. */
async function pointed(link: string): Promise<string | undefined> {
  let target: string;
  try { target = await readlink(link); } catch { return undefined; }
  // The link is written as the relative path releases/<commit>, so it keeps working when the
  // whole share directory is moved. Anything else is not a link this module wrote.
  const match = /^releases\/([0-9a-f]{40})$/.exec(target);
  return match?.[1];
}

export interface InstalledRelease { commit: string; builtAt: string; dirty: boolean }

/** Every release that is installed, read from each one's own build record. */
export async function listReleases(root: ReleaseRoot): Promise<{ current?: string; previous?: string; releases: InstalledRelease[] }> {
  let names: string[] = [];
  try { names = await readNames(join(root.directory, 'releases')); } catch (error) {
    // Before the first install there is no releases directory, which simply means none yet.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const releases: InstalledRelease[] = [];
  for (const name of names) {
    if (!sha.test(name)) continue;
    let record: ReturnType<typeof parseBuildRecord>;
    try { record = parseBuildRecord(await readFile(join(root.directory, 'releases', name, 'dist', 'build-info.json'), 'utf8')); }
    catch { record = parseBuildRecord(''); }
    // A release directory whose record is missing or names another commit is not a release
    // that can be trusted to be what its name says.
    if (record.commit !== name) continue;
    releases.push({ commit: name, builtAt: record.builtAt, dirty: record.dirty });
  }
  return { current: await pointed(root.current), previous: await pointed(root.previous), releases };
}

async function readNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort();
}

/**
 * Copies what a release needs out of a built checkout into the releases directory, under its
 * commit. A release is bin, dist and package.json: the sources, the tests and the checkout's
 * own metadata are not shipped. The build record inside dist names the commit, so the
 * directory cannot be given a name the build does not have.
 */
export async function installRelease(root: ReleaseRoot, builtTree: string, dependencies: string): Promise<InstalledRelease> {
  const source = resolve(builtTree);
  // Each part is required. A release missing one would start and then fail on a missing file.
  for (const part of ['bin', 'dist', 'package.json']) {
    try { await lstat(join(source, part)); }
    catch { fail('构建产物缺少 ' + part + '。请在完整的签出里运行 npm run build。', 409); }
  }
  let record: ReturnType<typeof parseBuildRecord>;
  try { record = parseBuildRecord(await readFile(join(source, 'dist', 'build-info.json'), 'utf8')); }
  catch { fail('构建产物里没有构建记录。请用 npm run build 重新构建。', 409); }
  if (record.commit === 'unknown') fail('这份构建没有记录提交号，不能作为发布版本。', 409);
  if (record.dirty) fail('这份构建含未提交的改动，不对应任何提交。请先提交再构建。', 409);
  // The dependencies are linked, not copied, so they have to be there. A release whose link
  // points at nothing would install and then fail to start on the first imported module.
  const modules = resolve(dependencies);
  let modulesStat;
  try { modulesStat = await lstat(modules); }
  catch { fail('找不到依赖目录：' + modules + '。请先运行 npm install。', 409); }
  if (!modulesStat.isDirectory()) fail('依赖目录不是目录：' + modules, 409);
  const target = join(root.directory, 'releases', record.commit);
  await mkdir(join(root.directory, 'releases'), { recursive: true });
  // The release the services run from is not replaced in place: they hold its files open and
  // would find them gone while the copy runs. To reinstall it, switch away first.
  if (await pointed(root.current) === record.commit) fail('这个版本正在运行，不能原地覆盖。要重装请先切换到别的版本。', 409);
  try {
    const existing = await lstat(target);
    // Installing again replaces what is there. An interrupted install leaves a partial
    // directory, which is never trusted.
    if (existing.isDirectory()) { await rm(target, { recursive: true, force: true }); }
    else fail('发布目录被一个非目录的文件占用了。', 409);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Copy to a temporary name and rename into place, so a reader never sees a half-copied release.
  const staging = join(root.directory, 'releases', '.installing-' + record.commit + '-' + process.pid);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: false });
  for (const part of ['bin', 'dist', 'package.json']) await cp(join(source, part), join(staging, part), { recursive: true, dereference: false });
  // A release does not carry its dependencies, which are large and shared. The services
  // resolve them through one link, so every release runs against the same installed modules.
  await symlink(modules, join(staging, 'node_modules'), 'dir');
  await rename(staging, target);
  return { ...record };
}

/**
 * Points the current link at an installed release. The switch is one rename, so the link is
 * never missing or half-written while the services are being restarted. The release that was
 * current is remembered, which is what makes a rollback possible.
 */
export async function activateRelease(root: ReleaseRoot, commit: string): Promise<{ from?: string; to: string }> {
  if (!sha.test(commit)) fail('发布版本须为完整的提交号');
  const installed = await listReleases(root);
  if (!installed.releases.some(release => release.commit === commit)) fail('这个版本尚未安装。请先 super-mario release install。', 404);
  const from = installed.current;
  if (from === commit) return { from, to: commit };
  const link = join(root.directory, '.current-' + process.pid);
  await rm(link, { force: true });
  await symlink(join('releases', commit), link);
  try { await rename(link, root.current); }
  catch (error) { await rm(link, { force: true }); throw error; }
  if (from) {
    const previousLink = join(root.directory, '.previous-' + process.pid);
    await rm(previousLink, { force: true });
    await symlink(join('releases', from), previousLink);
    await rename(previousLink, root.previous);
  }
  return { from, to: commit };
}

/** Points the current link back at the release before the last switch. */
export async function rollbackRelease(root: ReleaseRoot): Promise<{ from?: string; to: string }> {
  const state = await listReleases(root);
  if (!state.previous) fail('没有可回退的版本。尚未切换过发布版本，或上一个版本已被移除。', 409);
  return activateRelease(root, state.previous);
}
