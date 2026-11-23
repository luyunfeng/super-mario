import { validChatId } from '../../../plugins/feishu-personal-scope.ts';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIntegrationConfig } from '../../../packages/core/src/integration-config.ts';
import { createFeishuBotConfig } from '../../../plugins/feishu-bot-config.ts';
import { createPersonalProvider, PersonalAuthError, personalProblem } from '../../../plugins/feishu-personal.ts';
import { PERSONAL_COLLECTION_BOUNDARY, preparePersonalCheckpoint } from '../../../plugins/feishu.ts';
import type { FeishuEditObservation } from '../../../plugins/feishu-edit-history.ts';
import type { PersonalCheckpoint } from '../../../plugins/feishu-personal.ts';
import type { PersonalAccount, PersonalProvider } from '../../../plugins/feishu-personal.ts';
import type { AppConfig, InboxThing } from '../../../packages/protocol/src/index.ts';
import type { PersonalAiMessage } from '../../../packages/protocol/src/personal-ai.ts';
import type { CollectedReplyEvidence } from '../../../packages/protocol/src/waiting-replies.ts';

export interface PersonalStatus {
  status: 'disconnected' | 'preparing' | 'waiting_for_scan' | 'verifying' | 'connected' | 'failed' | 'expired' | 'cancelled';
  enabled: boolean; account?: { name: string }; url?: string; expiresAt?: string;
  error?: string; recovery?: 'connect_application' | 'permissions' | 'retry'; permissionUrl?: string;
  lastCompletedThrough?: string; hasMore?: boolean; collectionPages?: number; collectionBoundary?: string;
  collecting?: boolean; privateCompletedThrough?: string;
  lastCollectedAt?: string; collected?: number; demo?: boolean;
}
/** Owns personal consent and collection separately from all bot connections. */
export function createPersonalMessages(options: {
  config: AppConfig; provider?: PersonalProvider; pollMs?: number; aiEnabled?(): boolean;
  stopPreviousCollection?(): Promise<void>;
  collectMeetingMemory?(source: string, things: InboxThing[]): void;
  canCollect(): boolean; ingest(source: string, things: InboxThing[]): Promise<unknown>;
  /** Detached observer work must recheck this collection generation immediately before writing. */
  observeAi?(source: string, messages: PersonalAiMessage[], assertCurrent: () => void): void | Promise<void>;
  // Freeze the edit-history consent generation before the provider starts reading a page.
  accountChanged?():void;
  captureEdits?(account:PersonalAccount):((rows:FeishuEditObservation[])=>void)|undefined;
  collectRelations?(source:string,ownerId:string,things:InboxThing[],evidence:CollectedReplyEvidence[],assertCurrent:()=>void):void;
  observeReplies?(source: string, evidence: CollectedReplyEvidence[]): Promise<unknown> | unknown;
}) {
  const { config } = options;
  const directory = join(config.dataDir, 'private', 'feishu-personal');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const file = join(directory, 'account.json');
  let saved: { account?: PersonalAccount; enabled: boolean; checkpoint?: PersonalCheckpoint } = { enabled: false };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof data.enabled !== 'boolean' || data.account && !['profile', 'appId', 'openId', 'name'].every(key => typeof data.account[key] === 'string')) throw new Error('个人飞书账号记录无效');
    if (data.checkpoint) {
      const c = data.checkpoint;
      const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
      if (c.version !== 1 || !c.binding || !['appId', 'openId', 'profile'].every(key => typeof c.binding[key] === 'string')
        || !Number.isSafeInteger(c.pages) || c.pages < 0 || c.notBefore !== undefined && !date(c.notBefore)
        || c.lastCompletedThrough !== undefined && !date(c.lastCompletedThrough)
        || (c.directThrough !== undefined && !date(c.directThrough)) || (c.groupRetryFrom !== undefined && !date(c.groupRetryFrom))
        || (c.directThrough === undefined) !== (c.groupRetryFrom === undefined)
        || c.window && (!date(c.window.start) || !date(c.window.end) || Date.parse(c.window.start) > Date.parse(c.window.end)
          || !Array.isArray(c.window.lanes) || c.window.lanes.length < 1 || !c.window.lanes.every((lane: any, index: number) => lane && typeof lane.done === 'boolean'
            && (lane.chatIds === undefined
              ? lane.mentions === undefined && (index === 0 || c.window.lanes.length === 3 && c.window.lanes.every((entry: any) => !entry?.chatIds))
              : index > 0 && typeof lane.mentions === 'boolean' && Array.isArray(lane.chatIds) && lane.chatIds.length > 0
                && lane.chatIds.length <= 10 && lane.chatIds.every(validChatId))
            && (lane.token === undefined || typeof lane.token === 'string' && lane.token.length > 0)
            && (lane.restarted === undefined || typeof lane.restarted === 'boolean')
            && Array.isArray(lane.seen) && lane.seen.length <= 4096 && lane.seen.every((token: unknown) => typeof token === 'string'))
          || c.window.directory !== undefined && (!c.window.directory || typeof c.window.directory.done !== 'boolean'
            || c.window.directory.retryAt !== undefined && (!Number.isFinite(c.window.directory.retryAt) || c.window.directory.retryAt < 0))
          || c.window.privateRange !== undefined && (!c.window.privateRange || !date(c.window.privateRange.start) || !date(c.window.privateRange.end) || Date.parse(c.window.privateRange.start) > Date.parse(c.window.privateRange.end)))) throw new Error('个人飞书分页记录无效');
      if (!data.account || !['appId', 'openId', 'profile'].every(key => c.binding[key] === data.account[key])) delete data.checkpoint;
    }
    saved = data;
    chmodSync(file, 0o600);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const provider = options.provider ?? createPersonalProvider({
    collectionPageLimit: 3,
    application: () => {
      const current = createIntegrationConfig(config.dataDir, config.feishu).read();
      return current.profile ? { profile: current.profile, appId: current.appId } : undefined;
    },
    fallbackApplication: () => {
      const legacy = createIntegrationConfig(config.dataDir, config.feishu).read();
      if (legacy.appId && legacy.appSecret) return { profile: `super-mario-${legacy.appId}`, appId: legacy.appId, appSecret: legacy.appSecret };
      const bot = createFeishuBotConfig(config.dataDir).list().find(bot => !bot.archivedAt && bot.appSecret);
      return bot ? { profile: `super-mario-${bot.appId}`, appId: bot.appId, appSecret: bot.appSecret } : undefined;
    },
  });
  const demo = config.demo === true && !options.provider;
  // Saved consent must be verified again before a restart resumes background reading.
  let view: PersonalStatus = { status: saved.account ? 'verifying' : 'disconnected', enabled: false, ...(demo ? { demo: true } : {}) };
  let generation = 0, closed = false;
  let abort = new AbortController();
  let pending: Promise<unknown> = Promise.resolve();
  let collecting: Promise<{ collected: number }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiration: ReturnType<typeof setTimeout> | undefined;
  function progress() {
    const boundary = saved.checkpoint?.notBefore
      ? `从 ${new Date(saved.checkpoint.notBefore).toLocaleString('zh-CN')} 重新开始采集，不回填此前历史。` + PERSONAL_COLLECTION_BOUNDARY.replace('首次读取最近24小时；', '')
      : PERSONAL_COLLECTION_BOUNDARY;
    return { collecting: Boolean(collecting), privateCompletedThrough: saved.checkpoint?.directThrough ?? saved.checkpoint?.lastCompletedThrough,
      collectionBoundary: saved.checkpoint?.window?.directory?.retryAt ? boundary + ' 群读取暂不可用，已延后重试；私聊继续采集。'
        : saved.checkpoint?.groupRetryFrom ? boundary + ' 私聊进度已独立保存，群消息仍在低优先级补读。' : boundary, lastCompletedThrough: saved.checkpoint?.lastCompletedThrough,
      hasMore: !!saved.checkpoint?.window, collectionPages: saved.checkpoint?.pages ?? 0 };
  }
  const status = () => structuredClone({ ...view, ...progress() });
  function persist() {
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(saved), { mode: 0o600, flag: 'wx' }); renameSync(temp, file);
  }
  function reset() { generation++; abort.abort(); abort = new AbortController(); clearTimeout(timer); clearTimeout(expiration); }
  function fail(error: unknown) {
    const problem = error instanceof PersonalAuthError ? error : new PersonalAuthError('failed');
    saved.enabled = false; persist();
    view = { status: problem.kind === 'expired' ? 'expired' : 'failed', enabled: false, error: problem.message,
      recovery: problem.kind === 'needs_application' ? 'connect_application' : problem.kind === 'permissions' ? 'permissions' : 'retry',
      ...(view.permissionUrl ? { permissionUrl: view.permissionUrl } : {}) };
    options.accountChanged?.();
  }
  function schedule() {
    clearTimeout(timer);
    if (closed || !view.enabled) return;
    const window = saved.checkpoint?.window;
    const pending = window && (!window.lanes[0]?.done || !window.directory?.retryAt || window.directory.retryAt <= Date.now());
    timer = setTimeout(() => { void collect().catch(() => {}); }, pending ? 250 : options.pollMs ?? (options.aiEnabled?.() ? 30_000 : 120_000)); timer.unref();
  }
  async function collect(): Promise<{ collected: number }> {
    if (closed || view.status !== 'connected' || !view.enabled || !saved.account) throw new Error('请先授权飞书账号并开启采集');
    if (collecting) return collecting;
    if (!options.canCollect()) {
      view.enabled = false; saved.enabled = false; view.error = '请先启用飞书和收件箱整理插件'; persist(); clearTimeout(timer);
      throw new Error(view.error);
    }
    const epoch = generation, account = { ...saved.account }, signal = abort.signal;
    const assertCurrent = () => {
      if (closed || epoch !== generation || !view.enabled || !options.canCollect()) throw new Error('采集已停止');
      if (!saved.account || !(['appId', 'openId', 'profile'] as const).every(key => saved.account![key] === account[key])) throw new Error('采集账号已变化');
    };
    let task!: Promise<{ collected: number }>;
    task = Promise.resolve().then(async () => {
      try {
        assertCurrent();
        // Persisting an initial window does not advance progress. It prevents a restart
        // during a failed first batch from shifting the 24-hour lower boundary forward.
        if (provider.collectBatch && !saved.checkpoint?.window) {
          saved.checkpoint = preparePersonalCheckpoint({ appId: account.appId, openId: account.openId, profile: account.profile }, saved.checkpoint); persist();
        }
        // Own the result before yielding to callbacks, including the checkpoint.
        const captureEdits=provider.collectBatch && options.captureEdits?.(account);
        const batch = provider.collectBatch ? structuredClone(await provider.collectBatch(account, signal, structuredClone(saved.checkpoint))) : undefined;
        const things = batch ? batch.items : await provider.collect(account, signal);
        assertCurrent();
        if (batch && !(['appId', 'openId', 'profile'] as const).every(key => batch.checkpoint.binding[key] === account[key])) throw new Error('采集账号已变化');
        const source = `feishu:${account.appId}:${account.openId}`;
        if (options.observeReplies && batch?.evidence?.length) {
          const evidence = structuredClone(batch.evidence).map(item => ({ ...item, source,
            ...(item.label !== undefined ? { label: item.label.slice(0, 160) } : {}),
            ...(item.preview !== undefined ? { preview: item.preview.slice(0, 160) } : {}),
          }));
          // Recheck immediately before observing; no AI inbox work may delay this.
          assertCurrent();
          await options.observeReplies(source, evidence);
        }
        assertCurrent();
        await options.ingest(source, things);
        // Ingest may yield while stop, cancel or new authorization changes the owner.
        assertCurrent();
        if(batch?.editObservations?.length) captureEdits?.(batch.editObservations);
        if(batch) options.collectRelations?.(source,account.openId,things,batch.evidence ?? [],assertCurrent);
        assertCurrent();
        options.collectMeetingMemory?.(source, things);
        if (batch?.aiMessages?.length && options.observeAi) {
          const observationError = '个人 AI 消息处理失败，普通消息采集继续。';
          let observed = true;
          try { await options.observeAi(source, batch.aiMessages, assertCurrent); } catch { observed = false; }
          assertCurrent();
          if (!observed) view.error = observationError;
          else if (view.error === observationError) delete view.error;
        }
        if (batch) {
          if (!['appId', 'openId', 'profile'].every(key => batch.checkpoint.binding[key as keyof PersonalCheckpoint['binding']] === account[key as keyof PersonalAccount])) throw new Error('采集账号已变化');
          const previous = saved.checkpoint;
          saved.checkpoint = structuredClone(batch.checkpoint);
          try { persist(); } catch (error) { saved.checkpoint = previous; throw error; }
        }
        view.lastCollectedAt = new Date().toISOString(); view.collected = things.length;
        return { collected: things.length };
      } catch (error) {
        const problem = personalProblem(error) ?? new PersonalAuthError('collection');
        if (!closed && epoch === generation) {
          view.enabled = false; saved.enabled = false; persist();
          view.error = problem.message;
          view.recovery = problem.kind === 'permissions' ? 'permissions' : 'retry';
          if (problem.kind === 'permissions') view.permissionUrl = `https://open.feishu.cn/app/${account.appId}/auth`;
        }
        throw problem;
      } finally { if (collecting === task) collecting = undefined; if (epoch === generation) schedule(); }
    });
    collecting = task; return task;
  }
  return {
    status, reschedule: schedule,
    // Internal only: the browser never receives the CLI profile or account IDs.
    sourceAccount() { return view.status === 'connected' && saved.account ? { profile: saved.account.profile, appId: saved.account.appId, openId: saved.account.openId } : undefined; },
    start() {
      if (!saved.account || demo) return;
      const epoch = generation, account = { ...saved.account }, signal = abort.signal;
      pending = provider.verify(account, signal).then(verified => {
        if (closed || epoch !== generation) return;
        if (verified.openId !== account.openId || verified.appId !== account.appId || verified.profile !== account.profile) throw new PersonalAuthError('failed');
        view = { status: 'connected', enabled: saved.enabled, account: { name: verified.name } };options.accountChanged?.();
        if (view.enabled) { void collect().catch(() => {}); }
      }).catch(error => { if (!closed && epoch === generation) fail(error); });
    },
    authorize() {
      if (closed) throw new Error('飞书授权服务已关闭');
      if (demo) throw new Error('演示模式不会授权或读取真实飞书账号。请在正式运行的工作台使用此功能。');
      if (['preparing', 'waiting_for_scan', 'verifying'].includes(view.status)) return status();
      reset(); saved.enabled = false; delete saved.checkpoint; persist(); view = { status: 'preparing', enabled: false };options.accountChanged?.();
      const epoch = generation, signal = abort.signal;
      pending = (async () => {
        try {
          // An explicit new authorization takes over the old personal polling path.
          await options.stopPreviousCollection?.();
          if (closed || epoch !== generation) return;
          const application = await provider.application(signal);
          if (closed || epoch !== generation) return;
          view.permissionUrl = `https://open.feishu.cn/app/${application.appId}/auth`;
          const authorization = await provider.begin(application, signal);
          if (closed || epoch !== generation) return;
          view = { status: 'waiting_for_scan', enabled: false, url: authorization.url, expiresAt: new Date(Date.now() + authorization.expiresIn * 1000).toISOString(), permissionUrl: view.permissionUrl };
          expiration = setTimeout(() => { if (epoch === generation) { reset(); fail(new PersonalAuthError('expired')); } }, authorization.expiresIn * 1000); expiration.unref();
          const account = await provider.complete(application, authorization, signal);
          if (closed || epoch !== generation) return;
          clearTimeout(expiration);
          saved = { account, enabled: false }; persist();
          view = { status: 'connected', enabled: false, account: { name: account.name } };options.accountChanged?.();
        } catch (error) { if (!closed && epoch === generation) { clearTimeout(expiration); fail(error); } }
      })();
      return status();
    },
    cancel() {
      reset(); saved.enabled = false; persist(); view = { status: 'cancelled', enabled: false };options.accountChanged?.(); return status();
    },
    async enable(value: unknown) {
      if (typeof value !== 'boolean') throw new Error('enabled 必须为布尔值');
      if (value && (view.status !== 'connected' || !saved.account)) throw new Error('请先完成飞书账号授权');
      if (value && !options.canCollect()) throw new Error('请先启用飞书和收件箱整理插件');
      reset(); const epoch = generation; await collecting?.catch(() => {});
      if (closed || epoch !== generation) return status();
      if (!value && ['preparing', 'waiting_for_scan', 'verifying'].includes(view.status)) view = { status: 'cancelled', enabled: false };
      view.enabled = value; saved.enabled = value; delete view.error; persist();
      if (value) { pending = collect().catch(() => {}); }
      return status();
    },
    collect,
    async close() { closed = true; reset(); await Promise.allSettled([pending, collecting]); },
  };
}
