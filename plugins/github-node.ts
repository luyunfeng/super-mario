// GitHub read through the `gh` login of this machine. The token never leaves the machine:
// every call runs `gh api`, and only validated, typed data crosses back to the server.
// Nothing here starts an AI coding agent.
import { execFile } from 'node:child_process';

export type GhRun = (args: string[], options: { signal: AbortSignal; timeout?: number }) => Promise<string>;
type Row = Record<string, unknown>;

/** Why a read could not be done. Only these fixed reasons reach the server, never CLI output. */
export class GhError extends Error {
  readonly kind: 'not_installed' | 'not_signed_in' | 'forbidden' | 'rate_limited' | 'failed' | 'timeout' | 'bad_response';
  readonly retryAfterSeconds?: number;
  constructor(kind: GhError['kind'], retryAfterSeconds?: number) {
    super({ not_installed: '这台电脑没有安装 gh。', not_signed_in: '这台电脑的 gh 尚未登录 GitHub。',
      forbidden: '当前 GitHub 登录没有读取该内容的权限。', rate_limited: 'GitHub 请求过多，请稍后再试。',
      failed: '读取 GitHub 失败。', timeout: '读取 GitHub 超时。', bad_response: 'GitHub 返回的数据格式不符合预期。' }[kind]);
    this.name = 'GhError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const maxOutputBytes = 8 * 1024 * 1024;
/** The environment gh runs in. A token set in the environment would silently pick another
 *  account than the one the owner signed in as, so it is removed. gh uses its own login. */
function ghEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' };
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
  return environment;
}

export const runGh: GhRun = (args, options) => new Promise((resolve, reject) => {
  const child = execFile('gh', args, {
    signal: options.signal, timeout: options.timeout ?? 20_000, maxBuffer: maxOutputBytes,
    encoding: 'utf8', env: ghEnvironment(),
  }, (error, stdout, stderr) => {
    if (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GhError('not_installed'));
      if (options.signal.aborted) return reject(options.signal.reason instanceof Error ? options.signal.reason : new GhError('timeout'));
      if (error.killed) return reject(new GhError('timeout'));
      const text = String(stderr ?? '');
      // Classify by gh's own words. The text itself is not returned. Order matters: a 403
      // for a rate limit is not a permission problem. gh names the sign-in fix in its message,
      // and extra detail on the line, such as a token or a URL, must not hide the reason.
      if (/rate limit|secondary rate|abuse detection/i.test(text)) return reject(new GhError('rate_limited'));
      if (/\b403\b|forbidden|resource not accessible/i.test(text)) return reject(new GhError('forbidden'));
      if (/log(?:ged)? in|auth login|authentication token|no account|not authenticated/i.test(text)) return reject(new GhError('not_signed_in'));
      return reject(new GhError('failed'));
    }
    resolve(String(stdout ?? ''));
  });
  child.stdin?.on('error', () => { /* execFile reports the failure through its callback. */ });
  child.stdin?.end('');
});

function object(value: unknown): Row | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const chars = Array.from(value.replace(/\r\n?/g, '\n'));
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : value;
}
function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
async function json(run: GhRun, path: string, signal: AbortSignal): Promise<Row | Row[]> {
  signal.throwIfAborted();
  let raw: string;
  try { raw = await run(['api', '--method', 'GET', path], { signal }); }
  catch (error) {
    if (error instanceof GhError) throw error;
    // A token in a URL, a header or a message must not become an error shown to the owner.
    throw new GhError('failed');
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new GhError('bad_response'); }
  if (!value || typeof value !== 'object') throw new GhError('bad_response');
  return value as Row | Row[];
}

export interface GhAccount { login: string; name: string }
/** GitHub names the account. The token itself never says whose it is. */
export async function ghAccount(run: GhRun, signal: AbortSignal): Promise<GhAccount> {
  const row = (await json(run, 'user', signal)) as Row;
  if (typeof row.login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(row.login)) throw new GhError('bad_response');
  return { login: row.login, name: text(row.name, 120) };
}

export interface GhNotification {
  id: string;
  reason: string;
  subject: { title: string; type: string; number?: number };
  repository: string;
  updatedAt: string;
  url?: string;
  lastReadAt?: string;
}

/** Unread notifications, newest first. GitHub returns at most 50 per page by default. */
export async function ghNotifications(run: GhRun, signal: AbortSignal, options: { all?: boolean; page?: number; since?: string } = {}): Promise<{ items: GhNotification[]; hasNext: boolean }> {
  const query = new URLSearchParams({ per_page: '50' });
  if (options.all) query.set('all', 'true');
  if (options.page && options.page > 1) query.set('page', String(options.page));
  if (options.since) query.set('since', options.since);
  const list = await json(run, 'notifications?' + query.toString(), signal);
  if (!Array.isArray(list)) throw new GhError('bad_response');
  const items: GhNotification[] = [];
  for (const entry of list) {
    const row = object(entry), subject = object(row?.subject), repo = object(row?.repository), owner = object(repo?.owner);
    if (!row || !subject || !repo) continue;
    const id = typeof row.id === 'string' ? row.id : '';
    if (!/^\d+$/.test(id)) continue;
    items.push({
      id, reason: text(row.reason, 40), subject: { title: text(subject.title, 512), type: text(subject.type, 40),
        ...(integer(subject.number) !== undefined ? { number: integer(subject.number) } : {}) },
      repository: text(repo.full_name, 200) || [text(owner?.login, 80), text(repo.name, 120)].filter(Boolean).join('/'),
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
      ...(typeof subject.latest_comment_url === 'string' && /^https:\/\/api\.github\.com\//.test(subject.latest_comment_url) ? { url: subject.latest_comment_url } : {}),
      ...(typeof row.last_read_at === 'string' ? { lastReadAt: row.last_read_at } : {}),
    });
  }
  return { items, hasNext: list.length >= 50 };
}

/** One issue or pull request with its body, for the detail view of an inbox item. */
export async function ghIssue(run: GhRun, signal: AbortSignal, repository: string, number: number): Promise<{ title: string; body: string; state: string; url: string; author: string; comments: number }> {
  const repo = repositoryOf(repository);
  if (!Number.isSafeInteger(number) || number < 1 || number > 10_000_000) throw new GhError('bad_response');
  const row = (await json(run, 'repos/' + repo + '/issues/' + number, signal)) as Row;
  if (typeof row.title !== 'string') throw new GhError('bad_response');
  const user = object(row.user);
  return { title: text(row.title, 512), body: text(row.body, 16000), state: text(row.state, 20),
    url: 'https://github.com/' + repo + '/issues/' + number, author: text(user?.login, 80), comments: integer(row.comments) ?? 0 };
}

/** Comments of an issue or pull request, oldest first. */
export async function ghComments(run: GhRun, signal: AbortSignal, repository: string, number: number, page = 1): Promise<{ items: { author: string; body: string; createdAt: string; url: string }[]; hasNext: boolean }> {
  const repo = repositoryOf(repository);
  if (!Number.isSafeInteger(number) || number < 1 || number > 10_000_000 || !Number.isSafeInteger(page) || page < 1 || page > 1000) throw new GhError('bad_response');
  const list = await json(run, 'repos/' + repo + '/issues/' + number + '/comments?per_page=50&page=' + page, signal);
  if (!Array.isArray(list)) throw new GhError('bad_response');
  const items = list.flatMap(entry => {
    const row = object(entry), user = object(row?.user);
    if (!row || typeof row.body !== 'string') return [];
    return [{ author: text(user?.login, 80), body: text(row.body, 16000), createdAt: typeof row.created_at === 'string' ? row.created_at : '',
      url: 'https://github.com/' + repo + '/issues/' + number + (integer(row.id) !== undefined ? '#issuecomment-' + row.id : '') }];
  });
  return { items, hasNext: list.length >= 50 };
}

const ownerPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** An owner/repo name, or a fixed error. The name becomes part of an API path, so it is strict. */
export function repositoryOf(value: string): string {
  if (!ownerPattern.test(value) || value.endsWith('/.') || value.endsWith('/..')) throw new GhError('bad_response');
  return value;
}

/** The handlers a machine offers for the GitHub connector. Every one is a read. */
export function createGithubNode(options: { run?: GhRun } = {}) {
  const run = options.run ?? runGh;
  return {
    'github.account': async (_params: unknown, signal: AbortSignal) => ghAccount(run, signal),
    'github.notifications': async (params: unknown, signal: AbortSignal) => {
      const input = object(params) ?? {};
      if (Object.keys(input).some(key => !['all', 'page', 'since'].includes(key))) throw new GhError('bad_response');
      const page = input.page === undefined ? 1 : input.page;
      if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 1000) throw new GhError('bad_response');
      if (input.all !== undefined && typeof input.all !== 'boolean') throw new GhError('bad_response');
      if (input.since !== undefined && (typeof input.since !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(input.since))) throw new GhError('bad_response');
      return ghNotifications(run, signal, { ...(input.all === true ? { all: true } : {}), page, ...(typeof input.since === 'string' ? { since: input.since } : {}) });
    },
    'github.issue': async (params: unknown, signal: AbortSignal) => {
      const input = object(params) ?? {};
      if (Object.keys(input).some(key => !['repository', 'number'].includes(key))) throw new GhError('bad_response');
      if (typeof input.repository !== 'string' || typeof input.number !== 'number') throw new GhError('bad_response');
      return ghIssue(run, signal, input.repository, input.number);
    },
    'github.comments': async (params: unknown, signal: AbortSignal) => {
      const input = object(params) ?? {};
      if (Object.keys(input).some(key => !['repository', 'number', 'page'].includes(key))) throw new GhError('bad_response');
      if (typeof input.repository !== 'string' || typeof input.number !== 'number') throw new GhError('bad_response');
      return ghComments(run, signal, input.repository, input.number, typeof input.page === 'number' ? input.page : 1);
    },
  };
}
