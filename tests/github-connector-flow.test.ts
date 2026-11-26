import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createGithubNode } from '../plugins/github-node.ts';

const waitFor = async (condition: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for ' + what);
};

test('GitHub 连接：启用后经执行机读取未读通知并进入收件箱，换账号后旧条目归档', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-github-flow-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-github-flow' });
  let login = 'octocat';
  // The node is real. Its gh is a stand-in that answers from a fixed set, so no GitHub is reached.
  const gh = async (args: string[]) => {
    if (args.at(-1) === 'user') return JSON.stringify({ login, name: 'The Octocat' });
    const path = args.at(-1)!;
    if (path.startsWith('notifications?')) return JSON.stringify([
      { id: '501', reason: 'review_requested', updated_at: '2026-11-20T08:00:00Z',
        subject: { title: '加快首页', type: 'PullRequest', number: 42 }, repository: { full_name: 'octo/widgets' } },
    ]);
    throw new Error('unexpected ' + path);
  };
  const node = startAgentNode({ url: server.url, token: 'offline-github-flow', machineId: 'github-machine', name: '开发机',
    dataDir: join(dir, 'node'), handlers: createGithubNode({ run: gh }) as never });
  t.after(async () => {
    await node.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await waitFor(() => server.machines.list().some(machine => machine.capabilities.includes('github.account')), 'the machine to offer the GitHub handlers');

  // The owner enables the connector for this machine.
  server.app.store.put('github.connector', 'state', { machineId: 'github-machine', enabled: true });
  // Polling runs on a timer of a minute. Drive one read now through the same entry.
  await server.app.githubPoll();
  await waitFor(() => server.app.inbox.list().some(item => item.source === 'github:octocat'), 'the notification to reach the inbox');
  const item = server.app.inbox.list().find(entry => entry.source === 'github:octocat')!;
  assert.equal(item.title, 'octo/widgets #42 加快首页');
  assert.equal(item.origin?.github?.kind, 'pull');
  assert.equal(server.app.store.get<{ login: string; epoch: number }>('github.connector', 'state')?.login, 'octocat');
  // Nothing in the stored state or the item carries a token: none was ever on the server.
  assert.equal(/ghp_|token/i.test(JSON.stringify(server.app.store.get('github.connector', 'state'))), false);

  // The account changes on GitHub. The earlier account's open item is closed.
  login = 'someone-else';
  await server.app.githubPoll();
  await waitFor(() => server.app.inbox.list().filter(entry => entry.source === 'github:octocat').every(entry => entry.archivedAt), 'the earlier account\'s item to be archived');
  assert.equal(server.app.store.get<{ login: string; epoch: number }>('github.connector', 'state')?.epoch, 1);
  await waitFor(() => server.app.inbox.list().some(entry => entry.source === 'github:someone-else'), 'the new account\'s item');
});

test('GitHub 正文读取：只接受 GitHub 条目，未选电脑或换账号后拒绝，只返回页面要用的字段', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-github-read-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-github-read' });
  let login = 'octocat';
  const node = startAgentNode({ url: server.url, token: 'offline-github-read', machineId: 'reader', name: '开发机', dataDir: join(dir, 'node'),
    handlers: createGithubNode({ run: async args => {
      const path = args.at(-1)!;
      if (path === 'user') return JSON.stringify({ login, name: '' });
      if (path.startsWith('notifications?')) return JSON.stringify([{ id: '7', reason: 'mention', updated_at: '2026-11-20T08:00:00Z',
        subject: { title: '一个议题', type: 'Issue', number: 9 }, repository: { full_name: 'octo/widgets' } }]);
      if (path === 'repos/octo/widgets/issues/9') return JSON.stringify({ title: '一个议题', body: '正文', state: 'open', user: { login: 'alice' }, comments: 1, internal_note: 'must not leave the machine' });
      if (path.startsWith('repos/octo/widgets/issues/9/comments?')) return JSON.stringify([{ id: 3, body: '评论', created_at: '2026-11-19T00:00:00Z', user: { login: 'bob' }, private_path: '/home/me' }]);
      throw new Error('unexpected ' + path);
    } }) as never });
  t.after(async () => { await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await waitFor(() => server.machines.list().some(machine => machine.capabilities.includes('github.issue')), 'the machine to offer the GitHub handlers');

  server.app.store.put('inbox', 'plain', { id: 'plain', source: 'other', thread: 't', last: '1', title: '其他', text: '', version: 1, tier: 'fyi', reason: '', updatedAt: 'now' });
  await assert.rejects(server.app.githubRead('plain'), /不是 GitHub/);
  await assert.rejects(server.app.githubRead('missing'), /不是 GitHub/);
  // The item arrives once a machine is chosen.
  server.app.store.put('github.connector', 'state', { machineId: 'reader', enabled: true });
  await server.app.githubPoll();
  const item = server.app.inbox.list().find(entry => entry.source === 'github:octocat')!;
  assert.ok(item, 'the notification reached the inbox');
  // Without a machine the body is not read, even though the item is there.
  const connector = () => server.app.store.get<{ login?: string; epoch?: number }>('github.connector', 'state') ?? {};
  server.app.store.put('github.connector', 'state', { ...connector(), machineId: undefined });
  await assert.rejects(server.app.githubRead(item.id), /尚未选择电脑/);

  // With the machine chosen, only the fields the page uses come back.
  server.app.store.put('github.connector', 'state', { ...connector(), machineId: 'reader' });
  const read = await server.app.githubRead(item.id) as Record<string, unknown>;
  assert.equal(read.body, '正文');
  assert.equal(read.author, 'alice');
  assert.equal(read.commentsHasNext, false);
  const comment = (read.commentsPage as Record<string, unknown>[])[0]!;
  assert.deepEqual(Object.keys(comment).sort(), ['author', 'body', 'createdAt', 'url']);
  assert.equal(/must not leave|private_path|home\/me/.test(JSON.stringify(read)), false);
  assert.equal(Object.keys(read).includes('internal_note'), false);
  for (const page of [0, -1, 1.5, '2', 1001]) await assert.rejects(server.app.githubRead(item.id, page as number), /页码无效/);

  // After a change of account, the earlier account's item is no longer read.
  login = 'someone-else';
  await server.app.githubPoll();
  await assert.rejects(server.app.githubRead(item.id), /此前的 GitHub 账号/);
});

test('GitHub CI 跟进：失败通知进入收件箱，分支恢复后归档并写明原因', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-github-ci-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-github-ci' });
  let recovered = false;
  const node = startAgentNode({ url: server.url, token: 'offline-github-ci', machineId: 'ci-machine', name: '开发机', dataDir: join(dir, 'node'),
    handlers: createGithubNode({ run: async args => {
      const path = args.at(-1)!;
      if (path === 'user') return JSON.stringify({ login: 'octocat', name: '' });
      if (path.startsWith('notifications?')) return JSON.stringify(recovered ? [] : [{ id: '900', reason: 'ci_activity', updated_at: '2026-11-20T08:00:00Z',
        subject: { title: 'Build and test failed for main branch', type: 'CheckSuite' }, repository: { full_name: 'octo/widgets' } }]);
      if (path.startsWith('repos/octo/widgets/actions/runs?')) return JSON.stringify({ workflow_runs: recovered
        ? [{ name: 'Build and test', status: 'completed', conclusion: 'success', updated_at: '2026-11-21T00:00:00Z' }]
        : [{ name: 'Build and test', status: 'completed', conclusion: 'failure', updated_at: '2026-11-20T08:00:00Z' }] });
      if (path === 'repos/octo/widgets/branches/main') return JSON.stringify({ name: 'main' });
      throw new Error('unexpected ' + path);
    } }) as never });
  t.after(async () => { await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await waitFor(() => server.machines.list().some(machine => machine.capabilities.includes('github.ci-state')), 'the machine to offer the CI read');
  server.app.store.put('github.connector', 'state', { machineId: 'ci-machine', enabled: true });
  await server.app.githubPoll();
  const item = server.app.inbox.list().find(entry => entry.thread === 'ci:octo/widgets@main')!;
  assert.ok(item, 'the failed run reached the inbox');
  assert.equal(item.title, 'widgets · main 的 CI 失败');
  assert.deepEqual(item.origin?.githubCi, { repository: 'octo/widgets', branch: 'main', workflow: 'Build and test' });
  assert.ok(server.app.store.get<{ ci: Record<string, unknown> }>('github.connector', 'state')!.ci['ci:octo/widgets@main'], 'the branch is followed');

  // The branch recovers. The next read closes the item and says why.
  recovered = true;
  server.app.store.put('github.connector', 'state', { ...server.app.store.get('github.connector', 'state') as object, ci: { 'ci:octo/widgets@main': {
    repository: 'octo/widgets', branch: 'main', workflow: 'Build and test', failedAt: '2026-11-20T08:00:00Z' } } } as never);
  await server.app.githubPoll();
  const closed = server.app.inbox.list().find(entry => entry.id === item.id)!;
  assert.ok(closed.archivedAt, 'the item is closed');
  assert.equal(closed.reason, 'GitHub：后来成功了');
  assert.equal(server.app.store.get<{ ci: Record<string, unknown> }>('github.connector', 'state')!.ci['ci:octo/widgets@main'], undefined, 'the branch is no longer followed');
});
