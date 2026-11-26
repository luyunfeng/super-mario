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

/**
 * A notification as one inbox thing. The thread is the pull request or issue, so a later
 * notification about the same one updates the item instead of opening another. A notification
 * without a number names no pull request or issue, and is left out.
 */
export function githubThing(notification: GithubNotification): InboxThing | undefined {
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
  } catch (error) { fail(error); }
}

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
