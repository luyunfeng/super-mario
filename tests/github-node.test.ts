import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhError, createGithubNode, ghAccount, ghComments, ghIssue, ghNotifications, repositoryOf, runGh, type GhRun } from '../plugins/github-node.ts';

const account = { login: 'octocat', name: 'The Octocat', id: 1, type: 'User' };
const page = (items: unknown[]) => JSON.stringify(items);
const isGhError = (kind: GhError['kind']) => (error: unknown) => error instanceof GhError && error.kind === kind;

test('账号由 GitHub 回答，令牌内容不进入结果', async () => {
  const calls: string[][] = [];
  const run: GhRun = async args => { calls.push(args); return JSON.stringify(account); };
  assert.deepEqual(await ghAccount(run, new AbortController().signal), { login: 'octocat', name: 'The Octocat' });
  assert.deepEqual(calls, [['api', '--method', 'GET', 'user']]);
  // A malformed login is refused: it would otherwise become a label or part of a path.
  await assert.rejects(ghAccount(async () => JSON.stringify({ login: '../evil', name: 'x' }), new AbortController().signal), isGhError('bad_response'));
});

test('通知读取：解析字段、截断长标题、丢弃不合法的条目，all 与分页参数写入请求', async () => {
  const seen: string[][] = [];
  const run: GhRun = async args => {
    seen.push(args);
    return page([
      { id: '1', reason: 'mention', updated_at: '2026-11-01T00:00:00Z', last_read_at: '2026-10-01T00:00:00Z',
        subject: { title: 'x'.repeat(600), type: 'PullRequest', number: 42, latest_comment_url: 'https://api.github.com/repos/o/r/issues/comments/9' },
        repository: { full_name: 'o/r', owner: { login: 'o' }, name: 'r' } },
      { id: 'bad', reason: 'mention', subject: { title: 'no numeric id' }, repository: { full_name: 'o/r' } },
      { id: '2', reason: 'review_requested', subject: { title: '请评审', type: 'PullRequest', latest_comment_url: 'javascript:alert(1)' },
        repository: { full_name: 'o/other' } },
    ]);
  };
  const signal = new AbortController().signal;
  const result = await ghNotifications(run, signal, { all: true, page: 2, since: '2026-11-01T00:00:00Z' });
  assert.equal(result.items.length, 2, 'the entry without a numeric id is left out');
  assert.equal(result.items[0]!.repository, 'o/r');
  assert.equal(Array.from(result.items[0]!.subject.title).length, 512);
  assert.equal(result.items[0]!.subject.number, 42);
  assert.equal(result.items[1]!.url, undefined, 'a non-API link is not kept');
  assert.equal(result.hasNext, false);
  const query = new URL('https://api.github.com/' + seen[0]!.at(-1)!).searchParams;
  assert.equal(query.get('all'), 'true');
  assert.equal(query.get('page'), '2');
  assert.equal(query.get('since'), '2026-11-01T00:00:00Z');
  assert.equal(query.get('per_page'), '50');
});

test('议题与评论：仓库名严格校验，正文截断，链接由已校验的身份拼出', async () => {
  const signal = new AbortController().signal;
  const run: GhRun = async args => {
    const path = args.at(-1)!;
    if (path === 'repos/o/r/issues/7') return JSON.stringify({ title: '标题', body: 'y'.repeat(17000), state: 'open', user: { login: 'someone' }, comments: 3, html_url: 'https://evil.example/' });
    if (path === 'repos/o/r/issues/7/comments?per_page=50&page=1') return page([
      { id: 11, body: '第一条', created_at: '2026-11-02T00:00:00Z', user: { login: 'a' } },
      { body: 42, created_at: '2026-11-03T00:00:00Z' },
    ]);
    throw new Error('unexpected ' + args.join(' '));
  };
  const issue = await ghIssue(run, signal, 'o/r', 7);
  assert.equal(issue.url, 'https://github.com/o/r/issues/7', 'the API-provided URL is not trusted');
  assert.equal(Array.from(issue.body).length, 16000);
  const comments = await ghComments(run, signal, 'o/r', 7);
  assert.deepEqual(comments.items, [{ author: 'a', body: '第一条', createdAt: '2026-11-02T00:00:00Z', url: 'https://github.com/o/r/issues/7#issuecomment-11' }]);
  for (const bad of ['o/r/../../x', 'o/r?access_token=abc', '', 'o', 'o/r#frag']) {
    assert.throws(() => repositoryOf(bad), isGhError('bad_response'));
  }
});

test('节点处理器只接受已知参数，越界参数与错误类型被拒绝', async () => {
  const signal = new AbortController().signal;
  const node = createGithubNode({ run: async () => page([]) });
  assert.deepEqual(await node['github.notifications']({}, signal), { items: [], hasNext: false });
  for (const params of [{ page: 0 }, { page: '2' }, { page: 1, extra: 1 }, { all: 'yes' }, { since: 'yesterday' }]) {
    await assert.rejects(node['github.notifications'](params, signal), isGhError('bad_response'));
  }
  await assert.rejects(node['github.issue']({ repository: 'o/r', number: '7' }, signal), isGhError('bad_response'));
  await assert.rejects(node['github.comments']({ repository: '../x', number: 1 }, signal), isGhError('bad_response'));
});

test('真实启动器按 gh 的输出归类失败原因，输出原文不回传', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-gh-fake-'));
  const saved = process.env.PATH;
  t.after(async () => { process.env.PATH = saved; await rm(dir, { recursive: true, force: true }); });
  const signal = new AbortController().signal;
  const outcome = async (stderr: string, installed = true) => {
    // A stand-in for gh, first on PATH. It prints the given text and fails. Nothing real runs.
    if (installed) await writeFile(join(dir, 'gh'), '#!/bin/sh\nprintf %s ' + JSON.stringify(stderr) + ' >&2\nexit 4\n', { mode: 0o755 });
    // With no gh on PATH nothing can start, whatever the previous case left in the directory.
    process.env.PATH = installed ? dir : '';
    try { await runGh(['api', 'user'], { signal, timeout: 5_000 }); return 'resolved'; }
    catch (error) { assert.ok(error instanceof GhError); return error; }
  };
  assert.equal(((await outcome('gh: You are not currently logged in. To log in, run: gh auth login')) as GhError).kind, 'not_signed_in');
  assert.equal(((await outcome('HTTP 403: API rate limit exceeded for 1.2.3.4. (Rate limit of 60 per hour)')) as GhError).kind, 'rate_limited');
  assert.equal(((await outcome('HTTP 403: Resource not accessible by integration (https://api.github.com/)')) as GhError).kind, 'forbidden');
  assert.equal(((await outcome('gh: something else went wrong with a secret ghp_abcdefghijklmnopqrstuvwxyz')) as GhError).kind, 'failed');
  // An empty PATH cannot find gh, so nothing is started.
  assert.equal(((await outcome('', false)) as GhError).kind, 'not_installed');
  // The reason is a fixed sentence. It never carries the stderr, the address or a token.
  const refused = await outcome('gh: You are not currently logged in. ghp_abcdefghijklmnopqrstuvwxyz') as GhError;
  assert.equal(refused.kind, 'not_signed_in');
  assert.equal(refused.message, '这台电脑的 gh 尚未登录 GitHub。');
});

test('环境里的令牌不传给 gh，gh 只用主人登录的账号', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-gh-env-'));
  const saved = { PATH: process.env.PATH, token: process.env.GH_TOKEN };
  t.after(async () => {
    process.env.PATH = saved.PATH;
    if (saved.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.token;
    await rm(dir, { recursive: true, force: true });
  });
  // The stand-in reports which token it was given. It starts with a shebang, so no shell profile applies.
  await writeFile(join(dir, 'gh'), '#!/bin/sh\nprintf %s "${GH_TOKEN:-none} ${GITHUB_TOKEN:-none}"\n', { mode: 0o755 });
  process.env.PATH = dir;
  process.env.GH_TOKEN = 'ghp_environment_token_must_not_reach_gh';
  const stdout = await runGh(['api', 'user'], { signal: new AbortController().signal, timeout: 5_000 });
  assert.equal(stdout, 'none none');
});
