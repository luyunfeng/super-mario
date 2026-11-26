import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { createWorkspacePullRequestNode } from '../plugins/workspace-pull-request.ts';
import type { Approval, Project } from '../packages/protocol/src/index.ts';

const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).then(result => result.stdout.trim());
const TOKEN = 'pull-request-fixture';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-pull-http-'));
  const remote = join(dir, 'remote.git'), root = join(dir, 'project');
  await git(dir, 'init', '-q', '--bare', '--initial-branch', 'main', remote);
  await git(dir, 'init', '-q', '-b', 'main', 'project');
  await writeFile(join(root, 'README.md'), 'first\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-qm', 'first');
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '-q', '-u', 'origin', 'main');
  await git(root, 'checkout', '-qb', 'feature');
  await writeFile(join(root, 'README.md'), 'second\n');
  await git(root, 'commit', '-qam', 'second');
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token: TOKEN });
  const ghAsked: string[][] = [];
  const node = startAgentNode({ url: server.url, token: TOKEN, machineId: 'pull-machine', name: '工作电脑', dataDir: join(dir, 'node'), executors: [],
    handlers: {
      ...createWorkspacePullRequestNode({ run: async args => { ghAsked.push(args); return 'https://github.com/owner/repo/pull/7\n'; } }).handlers,
      // The GitHub connector's own reading, as the approval checks the account the owner signed in as.
      'github.account': async () => ({ login: 'fixture-owner', name: '' }),
      'github.notifications': async () => ({ items: [] }),
      'github.comment': async () => ({ state: 'sent' }),
    } });
  t.after(async () => { await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  for (let tries = 0; tries < 100 && !server.machines.list().some(item => item.id === 'pull-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const project = server.app.projects.create({ name: 'PR 项目', workspace: { machineId: 'pull-machine', cwd: root } }) as unknown as Project;
  // The connector is on, with this computer and its signed-in account.
  server.app.githubConfigure({ enabled: true, machineId: 'pull-machine', ciMode: 'off', mutedRepositories: [], ignoredBranches: [] });
  // The account is read from the computer, as the connector does when it is turned on.
  await server.app.githubPoll();
  const call = async (path: string, method: string, body?: object) => {
    const answer = await fetch(server.url + '/api/v1' + path, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: answer.status, body: await answer.json() as Record<string, unknown> };
  };
  const onRemote = async (branch: string) => git(remote, 'rev-parse', '--verify', '--quiet', branch).then(() => true, () => false);
  return { server, root, remote, project, call, ghAsked, onRemote };
}

test('开出 PR 先形成审批；批准前什么都不推，批准后推分支并用 gh 开 PR', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const proposed = await f.call('/github/pulls', 'POST', { projectId: f.project.id, repository: 'owner/repo', branch: 'feature', base: 'main', title: 'Add a second line', body: 'This adds a line.' });
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  const approval = proposed.body as unknown as Approval;
  assert.equal(approval.kind, 'plugin:github-connector.pull');
  assert.equal(approval.status, 'pending');
  // The owner is told exactly what will happen.
  assert.match(approval.title, /分支 feature 推到 GitHub 并开出 PR/);
  for (const expected of ['仓库：owner/repo', '分支：feature → main', '标题：Add a second line', 'This adds a line.']) assert.ok(approval.details?.includes(expected), expected);
  // Nothing has been pushed, and GitHub has not been asked.
  assert.equal(await f.onRemote('feature'), false);
  assert.deepEqual(f.ghAsked, []);
  // The owner approves. The branch is pushed, and the pull request is opened.
  const decided = await f.call('/approvals/' + approval.id + '/approve', 'POST', { version: approval.version });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(await f.onRemote('feature'), true);
  assert.equal(await git(f.remote, 'rev-parse', 'feature'), await git(f.root, 'rev-parse', 'feature'));
  assert.equal(f.ghAsked.length, 1);
  const asked = f.ghAsked[0] as string[];
  assert.deepEqual(asked.slice(0, 6), ['pr', 'create', '--repo', 'owner/repo', '--head', 'feature']);
  assert.equal(asked.at(-1), '-');
  const after = (await f.call('/approvals', 'GET')).body as unknown as Approval[];
  const done = after.find(row => row.id === approval.id)!;
  assert.equal(done.status, 'completed');
  const result = done.result as { url?: string } | undefined;
  assert.equal(result?.url, 'https://github.com/owner/repo/pull/7');
});

test('仓库、分支、标题写得不对时不形成审批；项目换了电脑或 GitHub 换了账号后，原来的审批不再执行', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const good = { projectId: f.project.id, repository: 'owner/repo', branch: 'feature', base: 'main', title: 't' };
  for (const bad of [{ ...good, repository: 'no slash' }, { ...good, branch: '../x' }, { ...good, title: ' ' }, { ...good, projectId: 'no-such' }, { ...good, force: true }]) {
    assert.ok([400, 404].includes((await f.call('/github/pulls', 'POST', bad)).status), JSON.stringify(bad));
  }
  assert.equal((await f.call('/github/pulls', 'GET')).status, 404);
  const proposed = (await f.call('/github/pulls', 'POST', good)).body as unknown as Approval;
  // The GitHub account changes after the approval was made, as it does when the owner signs in
  // as someone else on that computer: it is not carried out.
  const state = f.server.app.store.get<{ machineId: string; enabled: boolean }>('github.connector', 'state')!;
  f.server.app.store.put('github.connector', 'state', { ...state, login: 'someone-else' });
  const decided = await f.call('/approvals/' + proposed.id + '/approve', 'POST', { version: proposed.version });
  // The approval is answered with its outcome, as every approval is: it failed, and says why.
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const failed = decided.body as unknown as Approval;
  assert.equal(failed.status, 'failed');
  assert.match(String(failed.error), /账号或电脑已变化/);
  assert.equal(await f.onRemote('feature'), false);
  assert.deepEqual(f.ghAsked, []);
});
