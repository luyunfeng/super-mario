import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { GhError, createGithubNode, ghAccount, ghChecks, ghComments, ghDiff, ghIssue, ghNotifications, ghSearch, repositoryOf, runGh, type GhRun } from '../plugins/github-node.ts';

const account = { login: 'octocat', name: 'The Octocat', id: 1, type: 'User' };
const page = (items: unknown[]) => JSON.stringify(items);
const isGhError = (kind: GhError['kind']) => (error: unknown) => error instanceof GhError && error.kind === kind;
const emit = () => {};

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
  const node = createGithubNode({ run: async () => page([]) });
  assert.deepEqual(await node['github.notifications']({}, emit), { ok: true, data: { items: [], hasNext: false } });
  const refused = (error: unknown) => {
    const value = error as { ok: false; reason: string };
    assert.equal(value.ok, false);
    return value.reason === 'bad_response';
  };
  // These inputs are invalid on purpose. The cast is the caller of the machine channel
  // handing over data that was not checked first.
  for (const params of [{ page: 0 }, { page: '2' }, { page: 1, extra: 1 }, { all: 'yes' }, { since: 'yesterday' }]) {
    assert.ok(refused(await node['github.notifications'](params as unknown as JsonObject, emit)));
  }
  assert.ok(refused(await node['github.issue']({ repository: 'o/r', number: '7' }, emit)));
  assert.ok(refused(await node['github.comments']({ repository: '../x', number: 1 }, emit)));
});

test('处理器把失败原因放进结果：机器通道只传消息和状态码，抛出会丢失原因', async () => {
  const node = createGithubNode({ run: async () => { throw new GhError('not_signed_in'); } });
  // The handlers are called the way the machine calls them: the params and an emit function.
  const emit = () => {};
  assert.deepEqual(await node['github.account']({}, emit), { ok: false, reason: 'not_signed_in', message: '这台电脑的 gh 尚未登录 GitHub。' });
  // An unexpected failure from inside the handler is reported as a plain failure. Its own
  // text could hold a path, an address or a token, so none of it leaves the machine.
  const broken = createGithubNode({ run: async () => { throw new Error('secret ghp_abcdefghijklmnopqrstuvwxyz at /home/me'); } });
  assert.deepEqual(await broken['github.account']({}, emit), { ok: false, reason: 'failed', message: '读取 GitHub 失败。' });
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

test('搜索：查询去掉控制字符，链接由仓库和编号拼出，非议题结果被丢弃', async () => {
  const signal = new AbortController().signal;
  const seen: string[][] = [];
  const run: GhRun = async args => {
    seen.push(args);
    return JSON.stringify({ total_count: 2, items: [
      { number: 7, title: '慢查询', state: 'open', updated_at: '2026-11-01T00:00:00Z', repository: { full_name: 'o/r' }, pull_request: { url: 'x' }, html_url: 'https://evil.example/' },
      { title: '没有仓库和编号' },
    ] });
  };
  const result = await ghSearch(run, signal, { query: '  慢\n查询\u0000 ', limit: 99 });
  assert.deepEqual(result, { total: 2, items: [{ repository: 'o/r', number: 7, title: '慢查询', state: 'open', updatedAt: '2026-11-01T00:00:00Z',
    url: 'https://github.com/o/r/pull/7', pull: true }] });
  const query = new URL('https://api.github.com/' + seen[0]!.at(-1)!).searchParams;
  assert.equal(query.get('q'), '慢 查询');
  assert.equal(query.get('per_page'), '30', 'the limit is capped at 30');
  // A query that starts with a dash would be read by gh as an option.
  await assert.rejects(ghSearch(async () => '{}', signal, { query: '--help', limit: 5 }), isGhError('bad_response'));
  await assert.rejects(ghSearch(async () => '[]', signal, { query: 'x', limit: 5 }), isGhError('bad_response'));
});

test('差异：整份返回并截断，指定文件时只取该文件的段落，找不到报错', async () => {
  const signal = new AbortController().signal;
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '+a', 'diff --git a/b.ts b/b.ts', '--- a/b.ts', '+++ b/b.ts', '+b'].join('\n');
  const run: GhRun = async () => diff;
  assert.equal((await ghDiff(run, signal, 'o/r', 3)).text, diff);
  assert.equal((await ghDiff(run, signal, 'o/r', 3, 'b.ts')).text, 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n+b');
  await assert.rejects(ghDiff(run, signal, 'o/r', 3, 'missing.ts'), isGhError('bad_response'));
  await assert.rejects(ghDiff(run, signal, 'o/r', 3, '/etc/passwd'), isGhError('bad_response'));
  await assert.rejects(ghDiff(run, signal, 'o/r', 3, '../secret'), isGhError('bad_response'));
  const long = await ghDiff(async () => 'x'.repeat(70_000), signal, 'o/r', 3);
  assert.equal(long.truncated, true);
  assert.equal(Array.from(long.text).length, 60_000);
});

test('检查状态：按合并请求头提交读取，链接只接受 github.com，缺失时回到检查页', async () => {
  const signal = new AbortController().signal;
  const sha = 'a'.repeat(40);
  const run: GhRun = async args => {
    if (args.at(-1) === 'repos/o/r/pulls/5') return JSON.stringify({ head: { sha }, mergeable_state: 'dirty' });
    if (args.at(-1) === 'repos/o/r/commits/' + sha + '/check-runs?per_page=100') return JSON.stringify({ check_runs: [
      { name: 'build', status: 'completed', conclusion: 'failure', details_url: 'https://github.com/o/r/actions/runs/1' },
      { name: 'test', status: 'in_progress', details_url: 'https://evil.example/' },
      { status: 'completed' },
    ] });
    throw new Error('unexpected ' + args.join(' '));
  };
  assert.deepEqual(await ghChecks(run, signal, 'o/r', 5), { ref: sha, state: 'dirty', items: [
    { name: 'build', state: 'completed', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/1' },
    { name: 'test', state: 'in_progress', conclusion: '', url: 'https://github.com/o/r/pull/5/checks' },
  ] });
  await assert.rejects(ghChecks(async () => JSON.stringify({ head: { sha: 'not-a-sha' } }), signal, 'o/r', 5), isGhError('bad_response'));
});

test('搜索、差异和检查处理器拒绝未知参数与错误类型', async () => {
  const node = createGithubNode({ run: async () => '{}' });
  for (const [method, params] of [
    ['github.search', { query: 'x', extra: 1 }], ['github.search', { limit: 5 }], ['github.search', { query: 'x', limit: 'many' }],
    ['github.diff', { repository: 'o/r', number: 'five' }], ['github.diff', { repository: 'o/r', number: 5, path: 7 }],
    ['github.checks', { repository: 'o/r' }], ['github.checks', { repository: '../x', number: 5 }],
  ] as const) {
    const result = await node[method]!(params as unknown as JsonObject, emit) as { ok: boolean };
    assert.equal(result.ok, false, method + ' ' + JSON.stringify(params));
  }
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
