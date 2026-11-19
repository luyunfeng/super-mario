import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Scope = { layer: 'personal' } | { layer: 'project'; projectId: string };
const digest = (scope: Scope) => createHash('sha256').update(JSON.stringify(scope)).digest('hex');
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fdPath = (fd: number) => (process.platform === 'linux' ? '/proc/self/fd/' : '/dev/fd/') + fd;
const unsafe = (): never => { throw new Error('知识执行机文件归属或路径未确认'); };

function mount(fd: number) {
  if (process.platform !== 'linux') return String(fstatSync(fd).dev);
  return /^mnt_id:\s*(\d+)$/m.exec(readFileSync('/proc/self/fdinfo/' + fd, 'utf8'))?.[1] ?? unsafe();
}
function directory<T>(path: string, parent: number | undefined, action: (fd: number) => T) {
  const fd = openSync(path, flags);
  try {
    if (parent !== undefined && mount(fd) !== mount(parent)) unsafe();
    return action(fd);
  } finally { closeSync(fd); }
}
export function readKnowledgeRecord(path: string, parent?: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (parent !== undefined && mount(fd) !== mount(parent))) unsafe();
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
const stat = (path: string) => lstatSync(path, { throwIfNoEntry: false });
function scopeDirectory(scope: Scope) {
  return 'knowledge-workspace' + (scope.layer === 'project' ? '-' + digest(scope) : '');
}
// The marker lives outside the workspace. Its inode proof survives a crash between
// removing the last workspace entry and removing the directory itself.
const ownerFile = (scope: Scope) => '.workspace-' + digest(scope) + '.json';
function identity(fd: number) {
  const st = fstatSync(fd, { bigint: true });
  return [st.dev.toString(), st.ino.toString()];
}
function checkOwner(marker: string, jobs: number, fd: number, projectId: string) {
  const owner = readKnowledgeRecord(marker, jobs);
  if (owner.projectId !== projectId || JSON.stringify(owner.directory) !== JSON.stringify(identity(fd))) unsafe();
}
export function prepareKnowledgeWorkspace(dataDir: string, scope: Scope) {
  directory(dataDir, undefined, root => {
    const path = join(fdPath(root), scopeDirectory(scope)), fresh = !stat(path);
    if (fresh) mkdirSync(path, { mode: 0o700 });
    directory(path, root, fd => {
      if (scope.layer === 'project') directory(join(fdPath(root), 'knowledge-jobs'), root, jobs => {
        const marker = join(fdPath(jobs), ownerFile(scope));
        if (fresh) writeFileSync(marker, JSON.stringify({ projectId: scope.projectId, directory: identity(fd) }), { flag: 'wx', mode: 0o600 });
        else if (stat(marker)) checkOwner(marker, jobs, fd, scope.projectId);
      });
    });
  });
  return join(resolve(dataDir), scopeDirectory(scope));
}

// Resolve children relative to pinned directory descriptors. Reject symlinks, mounts,
// native repositories and multiply-linked files rather than crossing ownership boundaries.
function visit(fd: number, remove: boolean) {
  for (const name of readdirSync(fdPath(fd))) {
    if (name === '.git') unsafe();
    const path = join(fdPath(fd), name), info = lstatSync(path);
    if (info.isDirectory()) {
      directory(path, fd, child => visit(child, remove));
      if (remove) rmdirSync(path);
    } else {
      if (!info.isFile() || info.nlink !== 1) unsafe();
      const file = openSync(path, constants.O_NOFOLLOW | constants.O_RDONLY | constants.O_NONBLOCK);
      try { if (mount(file) !== mount(fd)) unsafe(); } finally { closeSync(file); }
      if (remove) unlinkSync(path);
    }
  }
}

export function cleanKnowledgeWorkerStorage(dataDir: string, projectId: string, known: Map<string, { scope: Scope }>, live: boolean, remove: boolean) {
  const scope = { layer: 'project', projectId } as const;
  directory(dataDir, undefined, root => directory(join(fdPath(root), 'knowledge-jobs'), root, jobs => {
    const files: string[] = [];
    for (const name of readdirSync(fdPath(jobs))) {
      const match = /^([A-Za-z0-9_-]{1,128})\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.exec(name);
      if (!match) continue;
      const path = join(fdPath(jobs), name), record = readKnowledgeRecord(path, jobs);
      const saved = known.get(match[1]!);
      if (record.id !== match[1] || (saved && (saved.scope.layer !== (record.scope?.layer ?? 'personal') ||
        (saved.scope.layer === 'project' && saved.scope.projectId !== record.scope?.projectId)))) unsafe();
      if (record.scope?.layer === 'project' && record.scope.projectId === projectId) files.push(path);
    }
    const path = join(fdPath(root), scopeDirectory(scope));
    const marker = join(fdPath(jobs), ownerFile(scope));
    if (stat(marker) && readKnowledgeRecord(marker, jobs).projectId !== projectId) unsafe();
    if (stat(path)) {
      directory(path, root, fd => {
        if (stat(marker)) {
          checkOwner(marker, jobs, fd, projectId);
          visit(fd, remove);
        } else {
          // Legacy empty scoped workspaces are provable with a matching worker/job. A
          // non-empty unmarked directory could have been replaced by the user.
          if ((!live && !files.length) || readdirSync(fdPath(fd)).length) unsafe();
        }
        if (remove) rmdirSync(path);
      });
    }
    if (remove) {
      for (const file of files) unlinkSync(file);
      if (stat(marker)) unlinkSync(marker);
    }
  }));
}
