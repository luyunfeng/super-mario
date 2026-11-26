import { cp, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
const destination = new URL('../dist/apps/web/', import.meta.url);

// Which commit this build was made from. The server and the agent node report it, so an
// owner can tell whether a running machine is on the build they think it is. The commit is
// taken from the environment when given, so a build without a Git checkout can still be
// traced. It is never guessed: an unknown commit is written as unknown.
const repositoryRoot = new URL('..', import.meta.url);
const run = promisify(execFile);
const git = async (args) => (await run('git', args, { cwd: repositoryRoot })).stdout.trim();
let commit = process.env.SUPER_MARIO_BUILD_COMMIT?.trim().toLowerCase() || '';
if (!/^[0-9a-f]{40}$/.test(commit)) {
  try { commit = await git(['rev-parse', 'HEAD']); } catch { commit = ''; }
}
let dirty = false;
if (process.env.SUPER_MARIO_BUILD_DIRTY === '1') dirty = true;
else if (commit) {
  try { dirty = (await git(['status', '--porcelain'])).length > 0; } catch { dirty = true; }
}
await writeFile(new URL('../dist/build-info.json', import.meta.url), JSON.stringify({
  commit: commit || 'unknown', builtAt: new Date().toISOString(), dirty,
}) + '\n');
// 先清空再复制，避免改名或删除的前端文件残留在构建产物里。
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(new URL('../apps/web/', import.meta.url), destination, { recursive: true });

for (const name of ['change-watch','approval-followup']) {
  await cp(new URL(`../plugins/examples/${name}/super-mario.extension.json`, import.meta.url), new URL(`../dist/plugins/examples/${name}/super-mario.extension.json`, import.meta.url));
}
await cp(new URL('../plugins/command-inbox/super-mario.extension.json', import.meta.url), new URL('../dist/plugins/command-inbox/super-mario.extension.json', import.meta.url));
