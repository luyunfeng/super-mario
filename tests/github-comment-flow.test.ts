import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createGithubNode } from '../plugins/github-node.ts';

const waitFor = async (condition: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for ' + what);
};

async function start(t: test.TestContext, label: string) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-github-comment-' + label + '-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-github-comment' });
  const state = { login: 'octocat', posted: [] as { path: string; input: string }[] };
  const node = startAgentNode({ url: server.url, token: 'offline-github-comment', machineId: 'commenter', name: '开发机', dataDir: join(dir, 'node'),
    handlers: createGithubNode({ dataDir: join(dir, 'node'), run: async (args, options) => {
      // A read ends with its path. A write ends with "--input -", so its path is third from last.
      const path = args.at(-1) === '-' ? args.at(-3)! : args.at(-1)!;
      if (path === 'user') return JSON.stringify({ login: state.login, name: '' });
      if (path.endsWith('/comments')) {
        state.posted.push({ path, input: options.input ?? '' });
        return JSON.stringify({ id: 500 + state.posted.length });
      }
      if (path.includes('/comments?')) return '[]';
      if (path.startsWith('notifications?')) return '[]';
      throw new Error('unexpected ' + args.join(' '));
    } }) as never });
  t.after(async () => { await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await waitFor(() => server.machines.list().some(machine => machine.capabilities.includes('github.comment')), 'the machine to offer the comment handler');
  server.app.store.put('github.connector', 'state', { machineId: 'commenter', enabled: true });
  await server.app.githubPoll();
  const headers = { 'Authorization': 'Bearer offline-github-comment', 'Content-Type': 'application/json' };
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(server.url + '/api/v1' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  return { server, state, call };
}

test('GitHub 评论：提交只产生审批，确认后发出一次，重复确认不重发', { timeout: 60_000 }, async t => {
  const { server, state, call } = await start(t, 'approve');
  const proposed = await call('/github/comments', 'POST', { repository: 'octo/widgets', number: 42, body: '  已看过，可以这样改。  ' });
  assert.equal(proposed.status, 201);
  assert.equal(proposed.data.kind, 'plugin:github-connector.comment');
  assert.equal(proposed.data.status, 'pending');
  assert.equal(proposed.data.details, '已看过，可以这样改。');
  assert.equal('body' in proposed.data.params, false, 'the comment lives in one place, the text the owner approves');
  assert.equal(proposed.data.params.account, 'octocat');
  assert.equal(state.posted.length, 0, 'nothing is posted before the owner approves');

  const approved = await call('/approvals/' + proposed.data.id + '/approve', 'POST', { version: proposed.data.version });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  await waitFor(() => state.posted.length === 1, 'the comment to be posted once');
  assert.equal(state.posted[0]!.path, 'repos/octo/widgets/issues/42/comments');
  assert.equal(JSON.parse(state.posted[0]!.input).body, '已看过，可以这样改。');
  const stored = server.app.store.get<{ status: string; version: number; result: { posted: boolean; url: string } }>('approvals', proposed.data.id)!;
  assert.equal(stored.status, 'completed');
  assert.equal(stored.result.posted, true);
  assert.equal(stored.result.url, 'https://github.com/octo/widgets/issues/42#issuecomment-501');
  // Approving again is refused, and nothing is posted a second time.
  const again = await call('/approvals/' + proposed.data.id + '/approve', 'POST', { version: stored.version });
  assert.ok(again.status >= 400, 'a completed approval cannot be approved again');
  assert.equal(state.posted.length, 1);
});

test('GitHub 评论：拒绝的审批不发出；换账号后确认被拒；助手工具不能发评论', { timeout: 60_000 }, async t => {
  const { server, state, call } = await start(t, 'reject');
  const first = await call('/github/comments', 'POST', { repository: 'octo/widgets', number: 7, body: '一条评论' });
  const rejected = await call('/approvals/' + first.data.id + '/reject', 'POST', { version: first.data.version });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  assert.equal(state.posted.length, 0);

  // The account changes on GitHub between proposing and approving.
  const second = await call('/github/comments', 'POST', { repository: 'octo/widgets', number: 8, body: '另一条' });
  state.login = 'someone-else';
  await server.app.githubPoll();
  const approved = await call('/approvals/' + second.data.id + '/approve', 'POST', { version: second.data.version });
  assert.equal(state.posted.length, 0, 'a comment approved for another account is not posted');
  const stored = server.app.store.get<{ status: string; error?: string }>('approvals', second.data.id)!;
  assert.equal(stored.status, 'failed');
  assert.match(stored.error ?? '', /账号或电脑已变化/);
  assert.equal(approved.status >= 200, true);

  // Invalid input never becomes an approval.
  for (const body of [{ repository: '../x', number: 1, body: 'x' }, { repository: 'octo/widgets', number: 0, body: 'x' },
    { repository: 'octo/widgets', number: 1, body: '   ' }, { repository: 'octo/widgets', number: 1, body: 'x', extra: 1 }]) {
    assert.equal((await call('/github/comments', 'POST', body)).status, 400, JSON.stringify(body));
  }
  // The assistant's tools are reads. None of them posts.
  const writes = server.app.contributions.list('tools').filter(item => /comment|reply|post/i.test(item.value.name) && item.value.name.startsWith('github'));
  assert.deepEqual(writes.map(item => item.value.name), []);
});

test('GitHub 评论：主人核对审批时改了内容，发出的是改过的版本', { timeout: 60_000 }, async t => {
  const { state, call } = await start(t, 'edit');
  const proposed = await call('/github/comments', 'POST', { repository: 'octo/widgets', number: 3, body: '最初起草的评论' });
  // The owner rewrites the comment while reviewing it, which makes a new version.
  const edited = await call('/approvals/' + proposed.data.id, 'PATCH', { version: proposed.data.version, title: proposed.data.title, details: '主人改过的评论', params: proposed.data.params });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const approved = await call('/approvals/' + proposed.data.id + '/approve', 'POST', { version: edited.data.version });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(state.posted.length, 1);
  assert.equal(JSON.parse(state.posted[0]!.input).body, '主人改过的评论');
});
