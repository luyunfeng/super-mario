import test from 'node:test';
import assert from 'node:assert/strict';
import type { InboxThing, Json } from '../packages/plugin-sdk/src/index.ts';
import { branchMatches, createGithubConnector, githubAdmitted, githubThing, type GithubConnectorActions, type GithubConnectorState, type GithubMachine, type GithubNotification } from '../plugins/github-connector.ts';

const notification = (overrides: Partial<GithubNotification> = {}): GithubNotification => ({
  id: '100', reason: 'review_requested', repository: 'octo/widgets', updatedAt: '2026-11-20T08:00:00Z',
  subject: { title: '加快首页', type: 'PullRequest', number: 42 }, ...overrides,
});

function fixture(initial: GithubConnectorState) {
  let state = initial;
  const ingested: InboxThing[][] = [];
  const retired: string[] = [];
  const closed: { thread: string; reason: string }[] = [];
  const calls: { machineId: string; method: string }[] = [];
  let login = 'octocat';
  let failAccount: string | undefined;
  let failNotifications: string | undefined;
  let items: GithubNotification[] = [notification()];
  let ciState: unknown = { over: '', failed: null };
  let ciReason: string | undefined;
  let ciContext: unknown = { defaultBranch: 'master', ownPullRequest: 7 };
  const machines: GithubMachine[] = [{ id: 'm1', name: '开发机', online: true, capabilities: ['github.account', 'github.notifications'] }];
  const actions: GithubConnectorActions = {
    async githubCall(machineId, method) {
      calls.push({ machineId, method });
      if (method === 'github.account') return (failAccount ? { ok: false, reason: 'not_signed_in', message: failAccount } : { ok: true, data: { login } }) as Json;
      if (method === 'github.notifications') return (failNotifications ? { ok: false, reason: 'rate_limited', message: failNotifications } : { ok: true, data: { items, hasNext: false } }) as Json;
      if (method === 'github.ci-state') return (ciReason ? { ok: false, reason: ciReason, message: 'x' } : { ok: true, data: ciState }) as Json;
      if (method === 'github.ci-context') return { ok: true, data: ciContext } as Json;
      throw new Error('unexpected method ' + method);
    },
    githubMachines: () => machines,
    async githubIngest(things) { ingested.push(things); },
    githubState: () => state,
    githubSave(next) { state = next; },
    githubRetire(name) { retired.push(name); return 2; },
    githubClose(thread, reason) { closed.push({ thread, reason }); return true; },
  };
  return { actions, ingested, retired, calls, setLogin: (value: string) => { login = value; }, setItems: (value: GithubNotification[]) => { items = value; },
    closed, setCiState: (value: unknown) => { ciState = value; }, failCi: (reason?: string) => { ciReason = reason; },
    setCiContext: (value: unknown) => { ciContext = value; },
    failAccount: (message?: string) => { failAccount = message; }, failNotifications: (message?: string) => { failNotifications = message; }, state: () => state };
}

async function poll(actions: GithubConnectorActions) {
  // The extension polls on activation and on a timer. Drive one read through the same path.
  const extension = createGithubConnector(actions, { pollMs: 3_600_000 });
  const disposers: Array<() => void> = [];
  extension.activate({ defer: (dispose: () => void) => { disposers.push(dispose); } } as never);
  await new Promise(resolve => setTimeout(resolve, 5));
  for (const dispose of disposers) dispose();
}

test('一条通知转成一个收件条目，线程是议题或合并请求，链接由已校验的身份拼出', () => {
  assert.deepEqual(githubThing(notification()), {
    thread: 'octo/widgets/pull/42', last: '100', title: 'octo/widgets #42 加快首页', text: '有人请你评审。',
    receivedAt: '2026-11-20T08:00:00Z',
    origin: { kind: 'direct', connector: 'GitHub', senderName: 'review_requested', github: { repository: 'octo/widgets', number: 42, kind: 'pull' } },
  });
  assert.equal(githubThing(notification({ subject: { title: '没有编号', type: 'RepositoryInvitation' } })), undefined);
});

test('首次读取记下 GitHub 命名的账号，未读通知进入收件箱', async () => {
  const f = fixture({ machineId: 'm1', enabled: true });
  await poll(f.actions);
  assert.equal(f.state().login, 'octocat');
  assert.equal(f.state().epoch, 0);
  assert.equal(f.ingested.length, 1);
  assert.equal(f.ingested[0]![0]!.thread, 'octo/widgets/pull/42');
  assert.equal(f.state().lastError, undefined);
  assert.equal(f.retired.length, 0);
});

test('未启用或未选执行机时不读取；执行机报未登录时记下原因，不写入任何条目', async () => {
  const off = fixture({ machineId: 'm1', enabled: false });
  await poll(off.actions);
  assert.equal(off.calls.length, 0);
  const none = fixture({ enabled: true });
  await poll(none.actions);
  assert.equal(none.calls.length, 0);
  const signedOut = fixture({ machineId: 'm1', enabled: true });
  signedOut.failAccount('这台电脑的 gh 尚未登录 GitHub。');
  await poll(signedOut.actions);
  assert.equal(signedOut.state().lastError, '这台电脑的 gh 尚未登录 GitHub。');
  assert.equal(signedOut.state().login, undefined);
  assert.equal(signedOut.ingested.length, 0);
});

test('换了账号：旧账号的收件条目归档，纪元加一，通知记在新账号下', async () => {
  const f = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0 });
  f.setLogin('someone-else');
  await poll(f.actions);
  assert.deepEqual(f.retired, ['octocat']);
  assert.equal(f.state().login, 'someone-else');
  assert.equal(f.state().epoch, 1);
  assert.equal(f.ingested.length, 1);
});

test('读通知期间又换了账号：这一批不写入', async () => {
  const f = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0 });
  const original = f.actions.githubCall;
  f.actions.githubCall = async (machineId, method, params) => {
    const reply = await original(machineId, method, params);
    // The account changes on GitHub while the notifications are in flight.
    if (method === 'github.notifications') f.actions.githubSave({ ...f.state(), login: 'another', epoch: 1 });
    return reply;
  };
  await poll(f.actions);
  assert.equal(f.ingested.length, 0);
  assert.equal(f.state().login, 'another');
});

test('通知读取失败只记原因，下次轮询继续；执行机关闭或停用后不再读取', async () => {
  const f = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0 });
  f.failNotifications('GitHub 请求过多，请稍后再试。');
  await poll(f.actions);
  assert.equal(f.state().lastError, 'GitHub 请求过多，请稍后再试。');
  assert.equal(f.ingested.length, 0);
  f.failNotifications(undefined);
  await poll(f.actions);
  assert.equal(f.state().lastError, undefined);
  assert.equal(f.ingested.length, 1);
  f.actions.githubSave({ ...f.state(), enabled: false });
  const before = f.calls.length;
  await poll(f.actions);
  assert.equal(f.calls.length, before);
});

const ciNotification = (id: string, at: string, title = 'Build and test failed for main branch'): GithubNotification => ({
  id, reason: 'ci_activity', repository: 'octo/widgets', updatedAt: at, subject: { title, type: 'CheckSuite' },
});

test('CI 失败：一条通知成为按分支归并的条目，并登记为要跟进', async () => {
  const thing = githubThing(ciNotification('600', '2026-11-20T08:00:00Z'))!;
  assert.equal(thing.thread, 'ci:octo/widgets@main');
  assert.equal(thing.title, 'widgets · main 的 CI 失败');
  assert.deepEqual(thing.origin?.githubCi, { repository: 'octo/widgets', branch: 'main', workflow: 'Build and test' });
  // A title that does not name a workflow and a branch is not a CI failure to follow.
  assert.equal(githubThing(ciNotification('601', '2026-11-20T08:00:00Z', 'something else')), undefined);
  const f = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0 });
  f.setItems([ciNotification('600', '2026-11-20T08:00:00Z')]);
  await poll(f.actions);
  const followed = f.state().ci!['ci:octo/widgets@main']!;
  assert.equal(followed.repository, 'octo/widgets');
  assert.equal(followed.branch, 'main');
  assert.equal(followed.failedAt, '2026-11-20T08:00:00Z');
});

test('CI 跟进：分支恢复、合并、关闭或删除后归档条目并停止跟进', async () => {
  for (const [state, reason] of [
    [{ over: 'passed', failed: null }, 'GitHub：后来成功了'],
    [{ over: 'merged' }, 'GitHub：合并请求已合并'],
    [{ over: 'closed' }, 'GitHub：合并请求已关闭'],
    [{ over: 'deleted' }, 'GitHub：分支已删除'],
  ] as const) {
    const f = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0,
      ci: { 'ci:octo/widgets@main': { repository: 'octo/widgets', branch: 'main', workflow: 'Build and test', failedAt: '2026-11-20T08:00:00Z' } } });
    f.setCiState(state);
    await poll(f.actions);
    assert.deepEqual(f.closed, [{ thread: 'ci:octo/widgets@main', reason }], JSON.stringify(state));
    assert.equal(f.state().ci!['ci:octo/widgets@main'], undefined, 'the branch is no longer followed');
  }
  // The machine reporting the branch as not found ends the follow-up in the same way.
  const missing = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0,
    ci: { 'ci:octo/widgets@main': { repository: 'octo/widgets', branch: 'main', workflow: 'Build and test', failedAt: '2026-11-20T08:00:00Z' } } });
  missing.failCi('not_found');
  await poll(missing.actions);
  assert.deepEqual(missing.closed, [{ thread: 'ci:octo/widgets@main', reason: 'GitHub：分支已删除' }]);
});

test('CI 跟进：有更新的失败时更新同一条目；同一失败不重复；仍在失败且没有新失败时不动；读取失败留到下次', async () => {
  const followed = { repository: 'octo/widgets', branch: 'main', workflow: 'Build and test', failedAt: '2026-11-20T08:00:00Z' };
  // A newer failure is ingested under the same thread, so it updates the item the owner has.
  const newer = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0, ci: { 'ci:octo/widgets@main': followed } });
  newer.setItems([]);
  newer.setCiState({ over: '', failed: { workflow: 'Build and test', at: '2026-11-21T09:00:00Z' } });
  await poll(newer.actions);
  assert.equal(newer.ingested.length, 1);
  assert.equal(newer.ingested[0]![0]!.thread, 'ci:octo/widgets@main');
  assert.equal(newer.ingested[0]![0]!.last, 'ci:2026-11-21T09:00:00Z');
  assert.match(newer.ingested[0]![0]!.text, /Build and test 在分支 main 上失败/);
  assert.equal(newer.state().ci!['ci:octo/widgets@main']!.failedAt, '2026-11-21T09:00:00Z');
  assert.deepEqual(newer.closed, []);
  // The failure already shown is not news, so the item is left alone.
  const same = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0, ci: { 'ci:octo/widgets@main': followed } });
  same.setItems([]);
  same.setCiState({ over: '', failed: { workflow: 'Build and test', at: '2026-11-20T08:00:00Z' } });
  await poll(same.actions);
  assert.equal(same.ingested.length, 0);
  assert.deepEqual(same.closed, []);
  // Still failing with no settled workflow, or a read that failed: nothing changes yet.
  const pending = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0, ci: { 'ci:octo/widgets@main': followed } });
  pending.setItems([]);
  pending.setCiState({ over: '', failed: null });
  await poll(pending.actions);
  assert.equal(pending.ingested.length, 0);
  assert.deepEqual(pending.closed, []);
  const failedRead = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0, ci: { 'ci:octo/widgets@main': followed } });
  failedRead.setItems([]);
  failedRead.failCi('rate_limited');
  await poll(failedRead.actions);
  assert.deepEqual(failedRead.closed, [], 'a failed read is not a deleted branch');
  assert.ok(failedRead.state().ci!['ci:octo/widgets@main'], 'the branch is still followed');
});

test('CI 跟进：刚检查过的分支在间隔内不再检查，一次最多检查五个', async () => {
  const entry = (branch: string) => ({ repository: 'octo/widgets', branch, workflow: 'Build and test', failedAt: '2026-11-20T08:00:00Z' });
  const justChecked = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0,
    ci: { 'ci:octo/widgets@main': { ...entry('main'), checkedAt: new Date().toISOString() } } });
  await poll(justChecked.actions);
  assert.equal(justChecked.calls.filter(call => call.method === 'github.ci-state').length, 0);
  const many = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0,
    ci: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(branch => ['ci:octo/widgets@' + branch, entry(branch)])) });
  many.setItems([]);
  many.setCiState({ over: '', failed: null });
  await poll(many.actions);
  assert.equal(many.calls.filter(call => call.method === 'github.ci-state').length, 5);
});

test('收件选项：静音的仓库、忽略的分支和四种 CI 模式决定什么进收件箱', () => {
  const run = ciNotification('700', '2026-11-20T08:00:00Z', 'Build failed for main branch');
  const train = ciNotification('701', '2026-11-20T08:00:00Z', 'Build failed for train/1732000000 branch');
  const isDefault = { defaultBranch: 'main' };
  const notDefault = { defaultBranch: 'master' };
  const mine = { defaultBranch: 'master', ownPullRequest: 9 };
  // A muted repository is left out entirely, whatever the notification is.
  assert.equal(githubAdmitted(notification({ repository: 'octo/widgets' }), { mutedRepositories: ['OCTO/widgets'] }), false);
  assert.equal(githubAdmitted(notification({ repository: 'octo/widgets' }), { mutedRepositories: ['octo/other'] }), true);
  // Branches automation pushes are left out by default, and the owner can name others.
  assert.equal(githubAdmitted(train, {}, isDefault), false);
  const own = { defaultBranch: 'main', ownPullRequest: 3 };
  assert.equal(githubAdmitted(train, { ignoredBranches: [] }, own), true, 'with no ignored branches, the owner own pull request comes in');
  assert.equal(githubAdmitted(train, { ciMode: 'all' }, isDefault), false, 'an ignored branch stays out even in the all mode');
  assert.equal(githubAdmitted(run, { ignoredBranches: ['ma?n'] }, isDefault), false);
  assert.equal(githubAdmitted(run, { ignoredBranches: ['release/*'] }, isDefault), true);
  // The default mode "mine": the default branch, or the owner's own open pull request.
  assert.equal(githubAdmitted(run, {}, isDefault), true);
  assert.equal(githubAdmitted(run, {}, mine), true);
  assert.equal(githubAdmitted(run, {}, notDefault), false);
  assert.equal(githubAdmitted(run, { ciMode: 'default-branch' }, isDefault), true);
  assert.equal(githubAdmitted(run, { ciMode: 'default-branch' }, mine), false, 'an own pull request does not count in this mode');
  assert.equal(githubAdmitted(run, { ciMode: 'all' }, notDefault), true);
  assert.equal(githubAdmitted(run, { ciMode: 'off' }, isDefault), false);
  // Other notifications are not subject to the CI modes.
  assert.equal(githubAdmitted(notification(), { ciMode: 'off' }), true);
  // * does not cross a slash, and other characters are matched as written.
  assert.equal(branchMatches('train/*', 'train/1732000000'), true);
  assert.equal(branchMatches('train/*', 'train/a/b'), false);
  assert.equal(branchMatches('release-?', 'release-1'), true);
  assert.equal(branchMatches('a.b', 'axb'), false);
  assert.equal(branchMatches('a.b', 'a.b'), true);
  assert.equal(branchMatches('(', 'x'), false);
});

test('收件选项在投递前生效：不进收件箱的失败也不登记跟进；仓库的默认分支一天只问一次', async () => {
  const muted = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0, mutedRepositories: ['octo/widgets'] });
  muted.setItems([ciNotification('710', '2026-11-20T08:00:00Z')]);
  await poll(muted.actions);
  assert.equal(muted.ingested.length, 0);
  assert.deepEqual(muted.state().ci, {}, 'a muted repository failure is not followed');
  const asked = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0 });
  asked.setItems([ciNotification('711', '2026-11-20T08:00:00Z')]);
  await poll(asked.actions);
  await poll(asked.actions);
  assert.equal(asked.calls.filter(call => call.method === 'github.ci-context').length, 1, 'the default branch is remembered for a day');
  assert.equal(asked.ingested.length, 2);
  // A failed read of the context is tried again next time instead of deciding blindly.
  const broken = fixture({ machineId: 'm1', enabled: true, login: 'octocat', epoch: 0 });
  broken.setItems([ciNotification('712', '2026-11-20T08:00:00Z')]);
  const original = broken.actions.githubCall;
  broken.actions.githubCall = async (machineId, method, params) => method === 'github.ci-context'
 ? { ok: false, reason: 'rate_limited', message: '限流' } as Json : original(machineId, method, params);
  await poll(broken.actions);
  assert.equal(broken.ingested.length, 0);
  assert.deepEqual(broken.state().repositories, {}, 'nothing is remembered from a failed read');
});
