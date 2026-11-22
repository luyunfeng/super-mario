import { execFileSync } from 'node:child_process';
import { commitChanges } from '../packages/protocol/src/index.ts';

// Only inspect local commit objects. Ignore inherited repository overrides and avoid
// optional network fetches, external diff programs, hooks and working-tree filters.
function git(cwd: string, args: string[]) {
  try {
    return execFileSync('git', ['--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd, env: { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500, maxBuffer: 256 * 1024,
    });
  } catch { return undefined; }
}

export function taskHead(cwd: string) {
  return git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])?.trim();
}

export function taskCommitChanges(cwd: string, base: string) {
  const head = taskHead(cwd);
  if (!head) return;
  let files = 0, added = 0, deleted = 0;
  if (base !== head) {
    const stats = git(cwd, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--ignore-submodules=none', base, head, '--', '.']);
    if (stats === undefined) return;
    for (const entry of stats.split('\0')) {
      if (!entry) continue;
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(entry);
      if (!match) return;
      files++;
      if (match[1] !== '-') added += Number(match[1]);
      if (match[2] !== '-') deleted += Number(match[2]);
    }
  }
  return commitChanges({ base, head, files, added, deleted });
}
