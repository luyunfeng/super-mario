// The curator serializes this maintenance with its ordinary Git writer. Workbench project
// paths and source URLs never enter these functions. All subprocesses use a fresh Git environment.
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Store } from '../../plugin-sdk/src/index.ts';

const conflict = (reason: string): never => { throw Object.assign(new Error('无法安全净化知识历史：' + reason), { status: 409 }); };
const metadata = 'knowledge.history-swap';
type Swap = { temp: string; before: string; after: string };
async function identity(path: string) {
  try {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory()) return conflict('元数据目录类型异常');
    return stat.dev + ':' + stat.ino;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

// Each rename is atomic. A durable, inode-bound receipt covers the gap and interrupted
// cleanup. Only the generated old metadata directory can be removed, never a user's backup.
export async function finishKnowledgeSwap(root: string, store: Store) {
  const receipt = store.get<Swap>(metadata, 'pending');
  if (!receipt) return;
  if (!/^\.purify-[A-Za-z0-9]{6}$/.test(receipt.temp)) conflict('交接记录异常');
  const temp = join(root, receipt.temp), live = join(root, '.git'), previous = join(temp, 'previous');
  let current = await identity(live);
  if (current !== receipt.after) {
    if (!await identity(temp) || await identity(join(temp, '.git')) !== receipt.after) conflict('待替换仓库身份已变化');
    if (current === receipt.before && !await identity(previous)) {
      await rename(live, previous); current = undefined;
    }
    if (current !== undefined || await identity(previous) !== receipt.before) conflict('原仓库身份已变化');
    await rename(join(temp, '.git'), live);
  }
  if (await identity(temp)) {
    const old = await identity(previous);
    if (old !== undefined) {
      if (old !== receipt.before) conflict('旧元数据身份已变化');
      await rm(previous, { recursive: true });
    }
    await rmdir(temp);
  }
  store.remove(metadata, 'pending');
}

function run(root: string, args: string[], input?: Buffer | string, dates: Record<string,string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], {
      env: { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CEILING_DIRECTORIES: dirname(root), GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
        GIT_AUTHOR_NAME: 'Super Mario', GIT_AUTHOR_EMAIL: 'knowledge@localhost',
        GIT_COMMITTER_NAME: 'Super Mario', GIT_COMMITTER_EMAIL: 'knowledge@localhost', ...dates },
      encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 30000,
    }, (error, out) => error ? reject(Object.assign(new Error('知识历史命令失败：git ' + args[0]), { status: 409 })) : resolve(out));
    child.stdin?.on('error', () => {}); // execFile reports subprocess failure.
    child.stdin?.end(input);
  });
}
async function command(root: string, args: string[], input?: string, dates?: Record<string,string>) {
  return (await run(root, args, input, dates)).toString().trim();
}

const managedId = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
const pagePath = new RegExp('^(knowledge|raw)/(' + managedId + ')\\.md$');
async function verifyMetadata(root: string, clean: string, branch: string) {
  // Unknown files can be backups; never discard them along with the old object database.
  async function visit(subdir: string) {
    for (const entry of await readdir(join(root, '.git', subdir), { withFileTypes: true })) {
      const name = join(subdir, entry.name);
      if (entry.isDirectory()) {
        if (!/^(branches|hooks|info|objects(?:\/(?:info|pack|[0-9a-f]{2}))?|refs(?:\/(heads|tags))?|logs(?:\/refs(?:\/heads)?)?)$/.test(name)) conflict('包含自定义 Git 目录');
        await visit(name);
        continue;
      }
      if (!entry.isFile() || (await lstat(join(root, '.git', name))).nlink !== 1) conflict('Git 元数据包含链接或特殊文件');
      if (/^(HEAD|config|index|COMMIT_EDITMSG|packed-refs|logs\/HEAD)$/.test(name)
        || name === 'refs/heads/' + branch || name === 'logs/refs/heads/' + branch
        || /^objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(name)
        || /^objects\/pack\/pack-[0-9a-f]{40}\.(pack|idx|rev|bitmap)$/.test(name)
        || /^(objects\/info\/(packs|commit-graph)|info\/refs)$/.test(name)) continue;
      if (name === 'description' || name === 'info/exclude' || /^hooks\/[\w-]+\.sample$/.test(name)) {
        const expected = await readFile(join(clean, '.git', name)).catch(() => undefined);
        if (expected?.equals(await readFile(join(root, '.git', name)))) continue;
      }
      conflict('包含自定义 Git 文件');
    }
  }
  await visit('');
  const config = await command(root, ['config', '--file', join(root, '.git/config'), '--no-includes', '--list']);
  if (!config.split('\n').every(line => /^(core\.repositoryformatversion=0|core\.(logallrefupdates|filemode)=true|core\.bare=false)$/.test(line))) conflict('仓库含远端或自定义配置');
  const expected = [root, join(root, '.git'), join(root, '.git')].join('\n');
  if (await command(root, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']) !== expected) conflict('Git 顶层或公共目录不属于工作台');
  if (await command(root, ['for-each-ref', '--format=%(refname)']) !== 'refs/heads/' + branch) conflict('仅支持单分支且无额外引用的仓库');
  if (await command(root, ['diff', '--cached', '--no-ext-diff', '--name-only'])) conflict('仓库有手工暂存的变更');
  if (await command(root, ['fsck', '--no-reflogs', '--unreachable', '--no-progress'])) conflict('仓库含不可达的历史对象');
}

export async function purifyKnowledgeHistory(directory: string, store: Store, projectId: string, rawOwners: Map<string, string | undefined>) {
  const root = await realpath(directory);
  await finishKnowledgeSwap(root, store);
  const live = join(root, '.git'), before = await identity(live);
  if (!before) return;
  // Refuse gitfiles, linked worktrees and symlinked HEAD before running commands on the source.
  const head = join(live, 'HEAD');
  if (!(await lstat(head)).isFile()) conflict('HEAD 类型无效');
  const branch = /^ref: refs\/heads\/([a-zA-Z0-9_-]+)\n?$/.exec(await readFile(head, 'utf8'))?.[1];
  if (!branch) return conflict('分支不是工作台私有分支');
  const temp = await mkdtemp(join(root, '.purify-'));
  let handedOff = false;
  try {
    await command(temp, ['init', '--quiet', '--initial-branch=' + branch]);
    await verifyMetadata(root, temp, branch);
    const latest = await command(root, ['rev-parse', 'HEAD']);
    const commits = (await command(root, ['rev-list', '--reverse', '--parents', latest])).split('\n');
    let oldParent = '', parent = '', found = false;
    const kept = new Map<string, string | null>();
    for (const line of commits) {
      const [commit, ...parents] = line.split(' ');
      if (parents.join(' ') !== oldParent) conflict('不支持分叉或合并历史');
      oldParent = commit!;
      const info = (await command(root, ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%at%x00%ct%x00%B', commit!])).split('\0');
      let message = info[6] ?? '';
      if (info.slice(0, 4).join('|') !== 'Super Mario|knowledge@localhost|Super Mario|knowledge@localhost' ||
        !/^knowledge: (?:update knowledge map|initialize local knowledge history|curate source [A-Za-z0-9_-]+|update)$/.test(message)) conflict('含非工作台生成的提交');
      const jobId = message.match(/^knowledge: curate source (.+)$/)?.[1];
      if (jobId && rawOwners.get(jobId) === projectId) { found = true; message = 'knowledge: update'; }
      const groups = new Map<string,string[]>();
      const tree = (await run(root, ['ls-tree', '-rz', commit!])).toString().split('\0').filter(Boolean);
      for (const row of tree) {
        const file = /^100644 blob ([0-9a-f]{40})\t([^\n]+)$/.exec(row);
        if (!file) return conflict('历史含链接或非托管文件');
        const [, oid, path] = file;
        if (path === 'wiki/index.md') {
          // Generated maps may expose titles of pages since removed.
          if ((await run(root, ['cat-file', 'blob', oid!])).toString().split('\n').includes('## 项目：' + projectId)) found = true;
          continue;
        }
        const match = pagePath.exec(path!);
        if (!match) return conflict('历史含未知文件路径');
        const [, kind, id] = match;
        const key = path + ':' + oid;
        if (!kept.has(key)) {
          let owned = false;
          if (kind === 'raw') {
            if (!rawOwners.has(id!)) return conflict('历史来源快照缺少归属记录');
            owned = rawOwners.get(id!) === projectId;
          }
          if (!owned) {
            const blob = await run(root, ['cat-file', 'blob', oid!]);
            if (kind === 'knowledge') {
              const header = /^---\n([^\n]+)\n---\n/.exec(blob.toString());
              const page = header && JSON.parse(header[1]!);
              if (page?.id !== id || !['personal','global','project'].includes(page.layer) ||
                (page.layer === 'project' && typeof page.projectId !== 'string')) return conflict('历史知识页缺少有效归属');
              owned = page.layer === 'project' && page.projectId === projectId;
            }
            if (!owned && (await run(temp, ['hash-object', '-w', '--stdin'], blob)).toString().trim() !== oid) conflict('知识版本复制校验失败');
          }
          kept.set(key, owned ? null : oid!);
        }
        if (!kept.get(key)) { found = true; continue; }
        const group = groups.get(kind!) ?? [];
        group.push('100644 blob ' + oid + '\t' + id + '.md\n');
        groups.set(kind!, group);
      }
      const subtrees: string[] = [];
      for (const [kind, rows] of groups) subtrees.push('040000 tree ' + await command(temp, ['mktree'], rows.join('')) + '\t' + kind + '\n');
      const treeId = await command(temp, ['mktree'], subtrees.join(''));
      parent = await command(temp, ['commit-tree', treeId, ...(parent ? ['-p',parent] : [])], message + '\n',
        { GIT_AUTHOR_DATE: '@' + info[4] + ' +0000', GIT_COMMITTER_DATE: '@' + info[5] + ' +0000' });
    }
    if (!found) return latest.slice(0, 7);
    await command(temp, ['update-ref', 'refs/heads/' + branch, parent]);
    await command(temp, ['read-tree', parent]);
    if (latest !== await command(root, ['rev-parse', 'HEAD']) || before !== await identity(live)) conflict('净化期间仓库已变化');
    await verifyMetadata(root, temp, branch);
    const after = (await identity(join(temp, '.git')))!;
    store.put(metadata, 'pending', { temp: basename(temp), before, after } satisfies Swap);
    handedOff = true;
    await finishKnowledgeSwap(root, store);
    return parent.slice(0, 7);
  } finally {
    // Until the receipt is durable this is exclusively our fresh temporary repository.
    if (!handedOff) await rm(temp, { recursive: true, force: true });
  }
}
