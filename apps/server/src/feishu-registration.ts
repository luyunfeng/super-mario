import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotScope, FeishuBotInput } from '../../../packages/protocol/src/bots.ts';
import { createFeishuRegistrationProvider, feishuRegistrationSteps, RegistrationError } from '../../../plugins/feishu-registration.ts';
import type { FeishuRegistrationProvider, RegistrationStage, RegistrationStep, RegistrationTrace } from '../../../plugins/feishu-registration.ts';

export interface FeishuRegistrationInput { name: string; scope: BotScope; requireConfirmation?: boolean }
export type FeishuRegistrationStatus = 'queued' | 'waiting_for_scan' | 'creating_app' | 'configuring' | 'publishing' | 'verifying' | 'completed' | 'needs_configuration' | 'failed' | 'unknown' | 'cancelled' | 'expired';
/** This is the entire public payload for APIs, events and durable job snapshots. */
export interface FeishuRegistrationJob {
  id: string; status: FeishuRegistrationStatus; progress: string; url?: string; expiresAt?: string;
  missingSteps: RegistrationStep[]; botId?: string; diagnostic?: RegistrationTrace & { at: string };
}
export interface FeishuRegistrationOptions {
  dataDir: string;
  events: { publish(type: string, data: FeishuRegistrationJob): unknown };
  bots: {
    create(input: FeishuBotInput): { id: string } | Promise<{ id: string }>;
    update(id: string, input: { enabled: boolean }): unknown | Promise<unknown>;
    bindOwner?(id: string, openId: string): unknown | Promise<unknown>;
  };
  provider?: FeishuRegistrationProvider;
  fetch?: typeof fetch;
}
const activeStatuses = new Set<FeishuRegistrationStatus>(['queued', 'waiting_for_scan', 'creating_app', 'configuring', 'publishing', 'verifying']);
const progressText: Record<RegistrationStage, string> = {
  waiting_for_scan: '请用飞书扫描二维码并在手机确认登录', creating_app: '正在创建飞书应用',
  configuring: '正在配置机器人权限、长连接和卡片回调', publishing: '正在创建并提交应用版本', verifying: '正在回读线上版本、权限和事件配置',
};
function inputOf(value: FeishuRegistrationInput): FeishuRegistrationInput {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80) throw new Error('机器人名称必须为 1–80 个字符');
  if (value.requireConfirmation !== undefined && typeof value.requireConfirmation !== 'boolean') throw new Error('requireConfirmation 必须为布尔值');
  const s = value.scope;
  let scope: BotScope;
  if (s?.kind === 'global' || s?.kind === 'unmarked') scope = { kind: s.kind };
  else if (s?.kind === 'project' && typeof s.projectId === 'string' && s.projectId.trim()) scope = { kind: 'project', projectId: s.projectId };
  else if (s?.kind === 'task' && typeof s.todoId === 'string' && s.todoId.trim() && (s.projectId === undefined || typeof s.projectId === 'string' && s.projectId.trim())) scope = { kind: 'task', todoId: s.todoId, ...(s.projectId ? { projectId: s.projectId } : {}) };
  else throw new Error('机器人 scope 无效');
  return { name: value.name.trim(), scope, requireConfirmation: value.requireConfirmation ?? true };
}
function qrURL(value: string | undefined): string | undefined {
  if (!value || value.length > 8192) return undefined;
  try {
    const qr = JSON.parse(value);
    if (typeof qr?.qrlogin?.token === 'string' && /^[A-Za-z0-9_+=/.-]+$/.test(qr.qrlogin.token)) return JSON.stringify({ qrlogin: { token: qr.qrlogin.token } });
  } catch { /* SDK device mode returns an HTTPS URL. */ }
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && ['accounts.feishu.cn', 'accounts.larksuite.com'].includes(url.hostname)) return url.href;
  } catch { /* Invalid provider output is not exposed. */ }
  return undefined;
}
/** Composition only. GET/list/restart never contact Feishu or repeat a creation/publication. */
export function createFeishuRegistration(options: FeishuRegistrationOptions) {
  const directory = join(options.dataDir, 'private', 'feishu-registration');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const metadataFile = join(directory, 'jobs.json');
  const provider = options.provider ?? createFeishuRegistrationProvider({ dataDir: options.dataDir, fetch: options.fetch });
  const jobs = new Map<string, { input: FeishuRegistrationInput; job: FeishuRegistrationJob }>();
  const running = new Map<string, { abort: AbortController; task: Promise<void> }>();
  let closed = false;
  function persist() {
    const temporary = `${metadataFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify([...jobs.values()]), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, metadataFile); chmodSync(metadataFile, 0o600);
  }
  if (existsSync(metadataFile)) {
    chmodSync(metadataFile, 0o600);
    const saved: unknown = JSON.parse(readFileSync(metadataFile, 'utf8'));
    if (!Array.isArray(saved)) throw new Error('飞书注册记录格式错误');
    for (const entry of saved) {
      const input = inputOf(entry.input), previous = entry.job as FeishuRegistrationJob;
      if (!previous || !/^[a-f0-9-]{36}$/.test(previous.id)) continue;
      const interrupted = activeStatuses.has(previous.status);
      const priorAppId = Array.isArray(previous.missingSteps) ? previous.missingSteps.map(step => typeof step?.url === 'string' ? step.url.match(/^https:\/\/open\.feishu\.cn\/app\/(cli_[a-fA-F0-9]{16})\/(?:auth|event|version)$/)?.[1] : undefined).find(Boolean) : undefined;
      const job: FeishuRegistrationJob = {
        id: previous.id, status: interrupted ? 'unknown' : previous.status,
        progress: interrupted ? '服务在注册期间退出；请先到飞书后台确认结果，系统不会自动重试' : previous.progress,
        missingSteps: previous.botId && previous.status !== 'completed' ? feishuRegistrationSteps(priorAppId, input.scope.kind === 'global') : [],
        ...(previous.diagnostic ? { diagnostic: previous.diagnostic } : {}),
        ...(previous.botId ? { botId: previous.botId } : {}),
      };
      jobs.set(job.id, { input, job });
    }
    persist();
  }
  const snapshot = (job: FeishuRegistrationJob) => structuredClone(job);
  function changed(job: FeishuRegistrationJob) {
    persist();
    // Observer failures must not reclassify an external action or repeat bot creation.
    try { options.events.publish('feishu.registration.changed', snapshot(job)); } catch { /* Metadata is already durable. */ }
  }
  function finish(job: FeishuRegistrationJob, status: FeishuRegistrationStatus, progress: string) {
    if (['failed', 'expired', 'unknown', 'needs_configuration'].includes(status)) {
      console.warn(JSON.stringify({ event: 'feishu.registration', logId: job.id, stage: job.status, status, ...job.diagnostic }));
    }
    job.status = status; job.progress = progress; delete job.url; delete job.expiresAt; changed(job);
  }
  async function execute(input: FeishuRegistrationInput, job: FeishuRegistrationJob, abort: AbortController) {
    let createdBotId: string | undefined, enabling = false;
    let latest: RegistrationTrace | undefined;
    try {
      const result = await provider.register({ name: input.name, workbench: input.scope.kind === 'global', signal: abort.signal, trace(info) { latest = info; }, progress(info) {
        if (closed || abort.signal.aborted || !Object.hasOwn(progressText, info.stage)) return;
        job.status = info.stage; job.progress = progressText[info.stage];
        if (info.stage === 'waiting_for_scan') {
          job.url = qrURL(info.url);
          if (info.expiresAt && Number.isFinite(Date.parse(info.expiresAt))) job.expiresAt = new Date(info.expiresAt).toISOString();
        } else { delete job.url; delete job.expiresAt; }
        changed(job);
      } });
      abort.signal.throwIfAborted();
      if (!/^cli_[a-fA-F0-9]{16}$/.test(result.appId) || typeof result.appSecret !== 'string' || !result.appSecret.trim()) throw new RegistrationError('failed');
      // Never inherit a scanner's open_id or an owner of a different application. The bot controller handles pairing.
      const bot = await options.bots.create({ ...input, appId: result.appId, appSecret: result.appSecret, enabled: false });
      createdBotId = bot.id; job.botId = bot.id; changed(job);
      abort.signal.throwIfAborted();
      if (result.verified === true && result.missingSteps.length === 0) {
        const recognized = typeof result.ownerOpenId === 'string' && /^ou_[A-Za-z0-9]+$/.test(result.ownerOpenId) && Boolean(options.bots.bindOwner);
        if (recognized) await options.bots.bindOwner!(bot.id, result.ownerOpenId!);
        enabling = true;
        await options.bots.update(bot.id, { enabled: true });
        if (abort.signal.aborted || closed) { await options.bots.update(bot.id, { enabled: false }); abort.signal.throwIfAborted(); }
        job.missingSteps = []; finish(job, 'completed', recognized ? '应用已发布并识别扫码用户；直接私聊机器人即可开始使用' : '应用已发布，权限及长连接已核验；未能识别扫码用户，请使用机器人配对码完成绑定');
      } else {
        if (latest) job.diagnostic = { ...latest, at: new Date().toISOString() };
        job.missingSteps = feishuRegistrationSteps(result.appId, input.scope.kind === 'global');
        finish(job, result.outcome === 'unknown' ? 'unknown' : 'needs_configuration', result.outcome === 'unknown' ? '应用已创建；版本创建或发布结果未知，请到飞书后台确认，系统不会自动重试' : '应用凭证已保存；配置尚未核验，机器人保持禁用，请按链接完成配置');
      }
    } catch (error) {
      if (enabling && createdBotId) {
        try { await options.bots.update(createdBotId, { enabled: false }); } catch { /* The controller retains its own configuration failure state. */ }
      }
      if (job.status === 'cancelled') return;
      // Never expose third-party exception text, request bodies, secrets, tokens or cookies.
      const outcome = abort.signal.aborted || closed ? 'cancelled' : error instanceof RegistrationError ? error.outcome : 'failed';
      // Permission and release instructions only apply once an application exists.
      job.missingSteps = createdBotId ? job.missingSteps : [];
      if (latest) job.diagnostic = { ...latest, at: new Date().toISOString() };
      const failure: Partial<Record<FeishuRegistrationStatus, string>> = {
        queued: '未能取得飞书登录二维码，请重新生成。',
        waiting_for_scan: latest?.step === 'console-identity' ? '扫码已完成，读取飞书开放平台身份失败。请使用下方日志 ID 排查。' : '扫码登录未完成，请重新生成二维码，并在手机上确认登录。',
        creating_app: '飞书应用创建或凭证读取失败，请先到开放平台核对同名应用。',
        configuring: '飞书机器人配置未完成，请核对应用配置。',
        publishing: '飞书应用发布未完成，请核对版本状态。',
        verifying: '飞书应用核验未通过，请核对线上版本。',
      };
      finish(job, outcome, outcome === 'unknown' ? '外部操作结果未知；请到飞书后台确认，系统不会自动重试' : outcome === 'expired' ? '二维码已过期，请重新生成' : outcome === 'cancelled' ? '注册已取消；已经发生的外部操作不会撤销，请到飞书后台核对' : failure[job.status] ?? '飞书注册未完成，请核对当前阶段。');
    }
  }
  return {
    start(value: FeishuRegistrationInput): FeishuRegistrationJob {
      if (closed) throw new Error('飞书注册服务已关闭');
      if (running.size) throw new Error('已有飞书注册正在进行，请先完成或取消');
      const input = inputOf(value);
      const job: FeishuRegistrationJob = { id: randomUUID(), status: 'queued', progress: '正在准备注册', missingSteps: [] };
      jobs.set(job.id, { input, job }); changed(job);
      const abort = new AbortController();
      // Start only from this explicit user action. Returning a snapshot never drives the state machine.
      const task = Promise.resolve().then(() => { abort.signal.throwIfAborted(); return execute(input, job, abort); }).catch(() => {}).finally(() => running.delete(job.id));
      running.set(job.id, { abort, task });
      return snapshot(job);
    },
    get(id: string) { const entry = jobs.get(id); return entry ? snapshot(entry.job) : undefined; },
    list() { return [...jobs.values()].map(entry => snapshot(entry.job)); },
    cancel(id: string) {
      const entry = jobs.get(id); if (!entry) return undefined;
      if (activeStatuses.has(entry.job.status)) {
        running.get(id)?.abort.abort();
        finish(entry.job, 'cancelled', '注册已取消；已经发生的外部操作不会撤销，请到飞书后台核对');
      }
      return snapshot(entry.job);
    },
    async close() {
      closed = true;
      for (const [id, operation] of running) {
        operation.abort.abort(); const job = jobs.get(id)!.job;
        if (activeStatuses.has(job.status)) finish(job, 'cancelled', '服务已关闭；已经发生的外部操作不会撤销，请到飞书后台核对');
      }
      await Promise.allSettled([...running.values()].map(operation => operation.task));
    },
  };
}
