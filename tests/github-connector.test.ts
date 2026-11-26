import test from 'node:test';
import assert from 'node:assert/strict';
import type { InboxThing, Json } from '../packages/plugin-sdk/src/index.ts';
import { createGithubConnector, githubThing, type GithubConnectorActions, type GithubConnectorState, type GithubMachine, type GithubNotification } from '../plugins/github-connector.ts';

const notification = (overrides: Partial<GithubNotification> = {}): GithubNotification => ({
  id: '100', reason: 'review_requested', repository: 'octo/widgets', updatedAt: '2026-11-20T08:00:00Z',
  subject: { title: '加快首页', type: 'PullRequest', number: 42 }, ...overrides,
});

function fixture(initial: GithubConnectorState) {
  let state = initial;
  const ingested: InboxThing[][] = [];
  const retired: string[] = [];
  const calls: { machineId: string; method: string }[] = [];
  let login = 'octocat';
  let failAccount: string | undefined;
  let failNotifications: string | undefined;
  let items: GithubNotification[] = [notification()];
  const machines: GithubMachine[] = [{ id: 'm1', name: '开发机', online: true, capabilities: ['github.account', 'github.notifications'] }];
  const actions: GithubConnectorActions = {
    async githubCall(machineId, method) {
      calls.push({ machineId, method });
      if (method === 'github.account') return (failAccount ? { ok: false, reason: 'not_signed_in', message: failAccount } : { ok: true, data: { login } }) as Json;
      if (method === 'github.notifications') return (failNotifications ? { ok: false, reason: 'rate_limited', message: failNotifications } : { ok: true, data: { items, hasNext: false } }) as Json;
      throw new Error('unexpected method ' + method);
    },
    githubMachines: () => machines,
    async githubIngest(things) { ingested.push(things); },
    githubState: () => state,
    githubSave(next) { state = next; },
    githubRetire(name) { retired.push(name); return 2; },
  };
  return { actions, ingested, retired, calls, setLogin: (value: string) => { login = value; }, setItems: (value: GithubNotification[]) => { items = value; },
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
