// The GitHub connector: the unread notifications of the account a machine's gh is signed
// in as, brought into the inbox. The token never reaches the server. Every read goes through
// the machine, and GitHub names the account.
import type { Extension, ExtensionContext, InboxThing, Json, JsonObject } from '../packages/plugin-sdk/src/index.ts';

export interface GithubMachine { id: string; name: string; online: boolean; capabilities: string[] }

/** What the connector remembers between runs. The server never stores a token. */
export interface GithubConnectorState {
  machineId?: string;
  enabled?: boolean;
  /** The account GitHub last named for the machine's login. */
  login?: string;
  /** Counts the changes of login. A read that began under an earlier epoch is discarded. */
  epoch?: number;
  /** Failed continuous integration to follow up, keyed by thread. */
  ci?: Record<string, { repository: string; branch: string; workflow: string; pull?: number; failedAt?: string; checkedAt?: string }>;
  lastRunAt?: string;
  lastError?: string;
}

export interface GithubConnectorActions {
  githubCall(machineId: string, method: string, params: JsonObject): Promise<Json>;
  githubMachines(): GithubMachine[];
  githubIngest(things: InboxThing[]): Promise<void>;
  githubState(): GithubConnectorState;
  githubSave(state: GithubConnectorState): void;
  /** Closes the open inbox items of an account that is no longer the one being read. */
  githubRetire(login: string): number;
  /** Closes one inbox item of the account being read, with the reason. */
  githubClose(thread: string, reason: string): boolean;
}

export type GithubNotification = {
  id: string; reason: string; subject: { title: string; type: string; number?: number };
  repository: string; updatedAt: string; url?: string;
};
type Reply<T> = { ok: true; data: T } | { ok: false; reason: string; message: string };

const reasons: Record<string, string> = {
  mention: '有人在 GitHub 上提到了你。',
  review_requested: '有人请你评审。',
  assign: '有人把这项指派给你。',
  author: '你发起的议题或合并请求有了新的回复。',
  comment: '你评论过的议题或合并请求有了新的回复。',
  ci_activity: '这项的持续集成有了新结果。',
  security_alert: '仓库有安全提醒。',
  invitation: '有人邀请你加入仓库或团队。',
};

/** GitHub titles a failed run "<workflow> failed for <branch> branch", sometimes with a count. */
const ciTitle = /^(.+?)\s+(?:failed|timed out|failure)\s+for\s+(\S+)\s+branch(?:\s*·\s*\d+)?$/i;
/** How long to wait before asking GitHub again about the same branch. */
const CI_RECHECK_MS = 10 * 60 * 1000;

/**
 * A notification as one inbox thing. The thread is the pull request or issue, so a later
 * notification about the same one updates the item instead of opening another. A notification
 * without a number names no pull request or issue, and is left out.
 */
export function githubThing(notification: GithubNotification): InboxThing | undefined {
  if (notification.reason === 'ci_activity') {
    const match = ciTitle.exec(notification.subject.title.trim());
    if (!match) return undefined;
    const repository = notification.repository;
    const number = notification.subject.number;
    return {
      // One item for a repository's branch. A rerun and a later failure join it.
      thread: 'ci:' + repository.toLowerCase() + '@' + match[2]!,
      last: notification.id,
      title: repository.split('/')[1] + ' · ' + match[2] + ' 的 CI 失败',
      text: match[1] + ' 在分支 ' + match[2] + ' 上失败。',
      receivedAt: notification.updatedAt,
      origin: { kind: 'direct', connector: 'GitHub', senderName: notification.reason,
        githubCi: { repository, branch: match[2]!, workflow: match[1]!, ...(number ? { pull: number } : {}) } },
    };
  }
  const number = notification.subject.number;
  if (!number) return undefined;
  const pull = notification.subject.type === 'PullRequest';
  const kind = pull ? 'pull' : 'issues';
  return {
    thread: notification.repository.toLowerCase() + '/' + kind + '/' + number,
    last: notification.id,
    title: notification.repository + ' #' + number + ' ' + notification.subject.title,
    text: reasons[notification.reason] ?? 'GitHub 上有了新的动态。',
    receivedAt: notification.updatedAt,
    origin: {
      kind: 'direct', connector: 'GitHub', senderName: notification.reason,
      github: { repository: notification.repository, number, kind },
    },
  };
}

function sameLogin(a: string | undefined, b: string | undefined) {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** One read of the account and its unread notifications, under the epoch it began with. */
async function run(actions: GithubConnectorActions): Promise<void> {
  const before = actions.githubState();
  if (!before.enabled || !before.machineId) return;
  const machineId = before.machineId;
  const fail = (error: unknown) => actions.githubSave({ ...actions.githubState(), lastRunAt: new Date().toISOString(),
    lastError: error instanceof Error ? error.message : '读取 GitHub 失败。' });
  try {
    const accountReply = await actions.githubCall(machineId, 'github.account', {}) as unknown as Reply<{ login: string }>;
    if (!accountReply.ok) throw new Error(accountReply.message);
    const login = accountReply.data.login;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)) throw new Error('GitHub 返回的账号名无效。');
    const current = actions.githubState();
    if (current.machineId !== machineId || !current.enabled) return;
    // A different account retires the earlier one's items. The epoch changes with it.
    const changed = current.login !== undefined && !sameLogin(current.login, login);
    const epoch = (current.epoch ?? 0) + (changed ? 1 : 0);
    actions.githubSave({ ...current, login, epoch, lastRunAt: new Date().toISOString(), lastError: undefined });
    // The new epoch is saved first. Retiring is idempotent, so a failure between the two
    // leaves the state consistent and the next run retires what is still open.
    if (changed) actions.githubRetire(current.login!);

    const reply = await actions.githubCall(machineId, 'github.notifications', {}) as unknown as Reply<{ items: GithubNotification[]; hasNext: boolean }>;
    if (!reply.ok) throw new Error(reply.message);
    // The account may have changed while the notifications were being read. Then they belong
    // to an account that is no longer being read, and are not written.
    const after = actions.githubState();
    if (!after.enabled || after.machineId !== machineId || after.epoch !== epoch || !sameLogin(after.login, login)) return;
    const things = reply.data.items.flatMap(item => { const thing = githubThing(item); return thing ? [thing] : []; });
    if (things.length) await actions.githubIngest(things);
    // A failed run is followed from now on. Its thread is the branch, so a rerun joins it.
    const ci = { ...(actions.githubState().ci ?? {}) };
    for (const thing of things) {
      const target = thing.origin?.githubCi;
      if (target) ci[thing.thread] = { repository: target.repository, branch: target.branch, workflow: target.workflow,
        ...(target.pull ? { pull: target.pull } : {}), failedAt: thing.receivedAt ?? '', checkedAt: new Date().toISOString() };
    }
    actions.githubSave({ ...actions.githubState(), ci });
    await followUpCi(actions, machineId, login, epoch);
  } catch (error) { fail(error); }
}

/**
 * GitHub notifies only the account that started a run, so a later failure on the same branch
 * arrives as no notification at all. The open CI items are asked about again from time to time.
 * The branch recovering, being deleted, or its pull request closing ends the item.
 */
async function followUpCi(actions: GithubConnectorActions, machineId: string, login: string, epoch: number) {
  const state = actions.githubState();
  const now = Date.now();
  const due = Object.entries(state.ci ?? {}).filter(([, item]) => !item.checkedAt || now - Date.parse(item.checkedAt) >= CI_RECHECK_MS)
    .sort(([a], [b]) => a.localeCompare(b)).slice(0, 5);
  for (const [thread, item] of due) {
    const current = actions.githubState();
    // The account or the machine may have changed while earlier items were being checked.
    if (!current.enabled || current.machineId !== machineId || current.epoch !== epoch || current.login?.toLowerCase() !== login.toLowerCase()) return;
    const reply = await actions.githubCall(machineId, 'github.ci-state', { repository: item.repository, branch: item.branch, ...(item.pull ? { pull: item.pull } : {}) }) as unknown as Reply<GhCiState>;
    if (!reply.ok) {
      // A missing branch is the one failure that ends the follow-up. The machine reports it as not found.
      if (reply.reason !== 'not_found') continue;
    }
    const after = actions.githubState();
    if (!after.enabled || after.machineId !== machineId || after.epoch !== epoch || after.login?.toLowerCase() !== login.toLowerCase()) return;
    const latest = after.ci?.[thread];
    if (!latest) continue;
    const checkedAt = new Date().toISOString();
    const ci = { ...after.ci, [thread]: { ...latest, checkedAt } };
    const result = reply.ok ? reply.data : { over: 'deleted' as const };
    if (result.over) {
      const why = { merged: 'GitHub：合并请求已合并', closed: 'GitHub：合并请求已关闭', deleted: 'GitHub：分支已删除', passed: 'GitHub：后来成功了' }[result.over];
      actions.githubClose(thread, why);
      delete ci[thread];
    } else if (result.failed && (!latest.failedAt || Date.parse(result.failed.at) > Date.parse(latest.failedAt))) {
      // A newer failure is news GitHub sent no notification for. The item is ingested again
      // under the same thread, which updates it and keeps what the owner already decided.
      await actions.githubIngest([{
        thread, last: 'ci:' + result.failed.at, title: item.repository.split('/')[1] + ' · ' + item.branch + ' 的 CI 失败',
        text: result.failed.workflow + ' 在分支 ' + item.branch + ' 上失败，最近一次 ' + new Date(result.failed.at).toISOString() + '。',
        origin: { kind: 'direct', connector: 'GitHub', senderName: 'ci_activity',
          githubCi: { repository: item.repository, branch: item.branch, workflow: result.failed.workflow, ...(item.pull ? { pull: item.pull } : {}) } },
      }]);
      ci[thread] = { ...latest, failedAt: result.failed.at, workflow: result.failed.workflow, checkedAt };
    }
    actions.githubSave({ ...actions.githubState(), ci });
  }
}

type GhCiState = { over: 'merged' | 'closed' | 'deleted' | 'passed' } | { over: ''; failed: { workflow: string; at: string } | null };

/** The connector as a plugin, with one read made available to its host. */
export type GithubConnectorExtension = Extension & { poll(): Promise<void> };

export function createGithubConnector(actions: GithubConnectorActions, options: { pollMs?: number } = {}): GithubConnectorExtension {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  async function poll() {
    // One read at a time. A slow machine must not stack reads on top of each other.
    if (running) return running;
    running = (async () => {
      try { if (!stopped) await run(actions); }
      finally { running = undefined; }
    })();
    return running;
  }
  return Object.assign({
    id: 'github-connector', name: 'GitHub', capabilities: ['inbox.source'], permissions: [],
    activate(context: ExtensionContext) {
      stopped = false;
      timer = setInterval(() => { if (!stopped) void poll(); }, options.pollMs ?? 60_000);
      void poll();
      context.defer(() => { stopped = true; clearInterval(timer); });
    },
  }, { poll });
}
