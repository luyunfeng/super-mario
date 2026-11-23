import { createHash, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { createPersonalAi } from '../../../packages/core/src/personal-ai.ts';
import { createPersonalAiHandler } from './personal-ai-handler.ts';
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { createFeishuBotConfig } from '../../../plugins/feishu-bot-config.ts';
import { createCommandGroup, createCommandGroupPlatform, type CommandGroupPlatform } from './feishu-command-group.ts';
import { InputError, requiredText, type createWorkbench } from '../../../packages/core/src/workbench.ts';
import { personalInboxReplyTarget } from '../../../packages/core/src/inbox-handling-source.ts';
import { replyAsPersonalUser } from '../../../plugins/feishu-personal-reply.ts';
import type { PersonalProvider } from '../../../plugins/feishu-personal.ts';
import type { FeishuRegistrationProvider } from '../../../plugins/feishu-registration.ts';
import type { AppConfig, Json } from '../../../packages/protocol/src/index.ts';
import { createFeishuController } from './feishu.ts';
import { createPersonalMessages } from './feishu-personal.ts';
import type { GroupReadService } from './feishu-group-read-delivery.ts';
import { createGroupReader } from './feishu-read-group.ts';
import { privateThreadExport } from './feishu-thread-history.ts';
import { createFeishuBotsController, type FeishuBotFactory } from './feishu-bots.ts';
import { createFeishuRegistration, type FeishuRegistrationJob } from './feishu-registration.ts';

export type FeishuGatewayDependencies = {
  botFactory?: FeishuBotFactory;
  readGroup?: GroupReadService;
  commandGroupPlatform?: CommandGroupPlatform;
  registrationProvider?: FeishuRegistrationProvider;
  personalProvider?: PersonalProvider;
};

/** Owns all Feishu connectors, QR views, mailbox routing, and outbox reply hosts for the server. */
export function createFeishuGateway(
  app: Awaited<ReturnType<typeof createWorkbench>>,
  config: AppConfig,
  dependencies: FeishuGatewayDependencies = {},
) {
  const feishu = createFeishuController(app, config);
  const personal: ReturnType<typeof createPersonalMessages> = createPersonalMessages({
    aiEnabled: () => personalAi.status().enabled,
    observeAi: (source, messages, assertCurrent) => personalAi.observe(source, messages, assertCurrent),
    config,
    provider: dependencies.personalProvider,
    stopPreviousCollection: () => feishu.pausePersonalCollection(),
    canCollect: () => ['feishu', 'inbox-triage'].every(id => app.plugins.list().some(plugin => plugin.id === id && plugin.status === 'active')),
    ingest: (source, things) => app.inbox.ingest(source, things),
    collectMeetingMemory: app.collectMeetingMemory,
    observeReplies: (source, evidence) => app.waitingReplies.observeSource(source, evidence),
  });
  const handlePersonalAi = createPersonalAiHandler(app);
  const personalAi = createPersonalAi({
    store: app.store,
    account: () => {
      const account = personal.sourceAccount();
      return account ? `feishu:${account.appId}:${account.openId}` : undefined;
    },
    handle: (source, trigger, question, context, assertCurrent) =>
      handlePersonalAi(source, trigger, question, context, () => {
        assertCurrent();
        if (!personal.status().enabled || !['feishu', 'inbox-triage'].every(id =>
          app.plugins.list().some(plugin => plugin.id === id && plugin.status === 'active'))) {
          throw new InputError('个人消息采集已停止', 409);
        }
      }),
  });
  function personalAiView() {
    const account = personal.sourceAccount();
    const accountKey = account ? createHash('sha256').update(JSON.stringify([account.profile, account.appId, account.openId])).digest('hex') : '';
    return { ...personalAi.status(), accountKey };
  }
  function configurePersonalAi(input: Record<string, unknown>) {
    const { expectedAccountKey, ...settings } = input;
    if (expectedAccountKey !== undefined && personalAiView().accountKey !== expectedAccountKey) throw new InputError('个人账号已变更，请重新打开设置', 409);
    if (!personal.sourceAccount()) throw new InputError('请先连接个人飞书账号', 409);
    try { personalAi.configure(settings); }
    catch (error) { throw new InputError(error instanceof Error ? error.message : '个人 AI 设置无效'); }
    personal.reschedule();
    return personalAiView();
  }
  app.setKnowledgeSourceAccount(() => personal.sourceAccount(), () => personal.status().status !== 'verifying');
  async function personalView() {
    const value = personal.status();
    return value.url ? { ...value, qrDataUrl: await QRCode.toDataURL(value.url, { width: 280, margin: 2, errorCorrectionLevel: 'M' }) } : value;
  }
  const bots = createFeishuBotsController(app, config, { factory: dependencies.botFactory,
    readGroup: dependencies.readGroup ?? createGroupReader(config, () => personal.sourceAccount()), webBase: process.env.SUPER_MARIO_WEB_URL });
  const commandGroup = createCommandGroup({
    store:app.store, bots:bots.list, projects:app.projects.list,
    enabled:()=>app.plugins.list().some(p=>p.id==='feishu' && p.status==='active'),
    platform:dependencies.commandGroupPlatform ?? createCommandGroupPlatform(appId=>{
      const bot=createFeishuBotConfig(config.dataDir,config.feishu?.appId).list().find(row=>row.appId===appId && !row.archivedAt && row.enabled && (row.scope.kind==='global' || row.scope.kind==='project'));
      if (!bot?.appSecret) throw new Error('机器人凭证不可用');
      return new Client({appId,appSecret:bot.appSecret,loggerLevel:LoggerLevel.fatal});
    },app.store),
    refresh:()=>bots.refreshCommandGroup(),
  });
  app.setInboxReplyHost(entry => bots.inboxHandlingStatus(entry.id), async (source, text, key) => {
    if (!app.plugins.list().some(p => p.id === 'feishu' && p.status === 'active')) throw Object.assign(new InputError('飞书插件已停用', 409), { delivery: 'no' });
    if (source.kind === 'mailbox') return bots.replyToInbox(source.id, source.version, text, key);
    const target = personalInboxReplyTarget(app.store, source.id, personal.sourceAccount());
    const sameTarget = () => {
      const next = personalInboxReplyTarget(app.store, source.id, personal.sourceAccount());
      if (JSON.stringify(next) !== JSON.stringify(target) || next.sourceVersion !== source.version) throw Object.assign(new InputError('个人账号或收件引用已变化', 409), { delivery: 'no' });
      const current = app.readInboxHandlingSource({ kind: source.kind, id: source.id });
      if (!current.active || current.binding !== source.binding) throw Object.assign(new InputError('原收件已变化或归档', 409), { delivery: 'no' });
      if (!app.plugins.list().some(p => p.id === 'feishu' && p.status === 'active')) throw Object.assign(new InputError('飞书插件已停用', 409), { delivery: 'no' });
    };
    let sentMessageId: string | undefined;
    const currentTarget = () => { try { sameTarget(); return target.messageId; } catch { return undefined; } };
    const accountId = target.appId + ':' + target.openId;
    const channel = 'feishu.personal:' + createHash('sha256').update(key).digest('hex').slice(0, 16);
    const unregister = app.background.outbox.registerChannel(channel, async (destination, body, sendKey) => {
      if (destination !== target.messageId || body !== text) throw Object.assign(new InputError('回复目标或内容已变化', 409), { delivery: 'no' });
      const result = await app.plugins.invocations.invoke('channel.send', { sourceId: source.id, messageId: target.messageId, chatId: target.chatId, text, key }, async input => {
        const expected = { sourceId: source.id, messageId: target.messageId, chatId: target.chatId, text, key };
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 5 || Object.entries(expected).some(([field, value]) => (input as Record<string, unknown>)[field] !== value)) throw Object.assign(new InputError('回复目标或内容被修改', 409), { delivery: 'no' });
        sameTarget();
        return replyAsPersonalUser({ profile: target.profile, messageId: target.messageId, text, key: 'inbox-' + createHash('sha256').update(sendKey).digest('hex').slice(0, 40) });
      });
      sentMessageId = (result as { messageId: string }).messageId;
    }, currentTarget, () => currentTarget() ? accountId : undefined);
    try {
      const intent = app.background.outbox.enqueueReply({ dedupKey: key, channel, target: target.messageId, content: { text }, relatedTo: { kind: 'inbox', id: source.id } }, accountId);
      const result = await app.background.outbox.send(intent.id);
      if (result.status !== 'sent') throw Object.assign(new InputError('个人回复未确认送达，请核对发件箱', 409), { delivery: ['failed', 'cancelled', 'expired'].includes(result.status) ? 'no' : 'unknown' });
      return { outboxId: result.id, status: 'sent', ...(sentMessageId ? { messageId: sentMessageId } : {}) };
    } finally { unregister(); }
  });
  const registrations = createFeishuRegistration({
    dataDir: config.dataDir,
    events: { publish: (type, data) => app.events.publish(type, data as unknown as Json) },
    bots,
    provider: dependencies.registrationProvider,
  });
  async function registrationView(job: FeishuRegistrationJob) {
    if (!job.url) return job;
    // QR login is a mobile scanner payload, not necessarily a browser URL.
    return {
      ...job,
      qrUrl: job.url.startsWith('https://') ? job.url : undefined,
      qrDataUrl: await QRCode.toDataURL(job.url, { width: 280, margin: 2, errorCorrectionLevel: 'M' }),
    };
  }
  app.mailboxes.setHandlers({
    inbox: entry => bots.dispatchInbox(entry),
    outbox: async entry => { await bots.send(entry.botId, requiredText(entry.target, '发送目标'), entry.text, entry.eventKey); },
  });
  app.setAgentInputOwnerValidator(bots.validateAgentInputOwner);
  app.setBotsStatus(() => bots.list() as unknown as Json);
  app.setBotRelay(input => bots.relay(input));
  // Private owner targets are used for routing only, never restored to the public bot list.
  const notificationBots = () => bots.list().map(bot => ({ ...bot, replyTarget: app.store.get<{ chatId: string }>('settings', `feishu.bot.owner:${bot.id}:${bot.appId}`)?.chatId }));
  app.setNotificationBots(notificationBots);
  app.setNotificationChannel(bot => {
    const identity = (b: typeof bot) => JSON.stringify([b.appId, b.scope, b.replyTarget, b.updatedAt]);
    const snapshot = identity(bot);
    const channel = `feishu.bot:${bot.id}:${createHash('sha256').update(snapshot).digest('hex').slice(0, 16)}`;
    app.background.outbox.registerChannel(channel, async (target, text, key) => {
      const current = notificationBots().find(b => b.id === bot.id);
      if (!current?.enabled || !current.connected || !current.paired || identity(current) !== snapshot || current.replyTarget !== target) throw Object.assign(new Error('机器人绑定或配对已变化，请核对积压通知'), { delivery: 'no' });
      // The outbox already checked the existing grant or an explicit content-bound approval.
      const entry = app.mailboxes.put({ direction: 'outbox', botId: bot.id, scope: bot.scope, eventKey: key, title: '工作台通知', text, target, requiresConfirmation: false });
      const result = await app.mailboxes.process(entry.id);
      if (result.status !== 'completed') throw Object.assign(new Error(result.error ?? '通知未送达'), { delivery: result.status === 'unknown' ? 'unknown' : 'no' });
    }, () => notificationBots().find(b => b.id === bot.id && identity(b) === snapshot && b.enabled && b.paired)?.replyTarget, () => notificationBots().some(b=>b.id===bot.id&&identity(b)===snapshot&&b.enabled&&b.paired)?snapshot:undefined);
    return channel;
  });
  app.setBotScopeAccess((scope, botId, input, threadId) => bots.canUseScope(scope, botId, input, threadId));
  app.setPrivateExport((id, threadId) => {
    if (!app.plugins.list().some(p => p.id === 'feishu' && p.status === 'active')) throw new InputError('飞书插件已停用', 503);
    return privateThreadExport(app.store, bots.requireThread(id, threadId));
  });
  app.setGroupReadRecords(bots.listGroupReads);
  app.setPrivateSearch(bots.searchPrivateHistory);
  app.setPrivateConversation((id, threadId, action, input) => action === 'read'
    ? bots.privateThreadMetadata(id, threadId) : bots.updatePrivateThread(id, threadId, input, 'assistant'));
  function proposeMail(input: Record<string, unknown>) {
    const bot = bots.list().find(bot => bot.id === input.botId);
    if (!bot) throw new InputError('请选择机器人', 404);
    return app.mailboxes.put({
      direction: 'outbox',
      botId: bot.id,
      scope: bot.scope,
      eventKey: `draft:${randomUUID()}`,
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '待确认的飞书消息',
      text: requiredText(input.text, '消息内容'),
      target: requiredText(input.target ?? bot.replyTarget, '目标会话'),
      requiresConfirmation: true,
    });
  }
  app.setMailboxProposer(input => proposeMail(input) as unknown as Json);
  app.setFeishuSender(
    (chatId, text, key) => feishu.send(chatId, text, key),
    () => feishu.status().enabled ? app.store.get<{ chatId: string }>('settings', `feishu.owner.${feishu.status().appId}`)?.chatId : undefined,
    () => feishu.status().appId,
    (chatId, text, key) => feishu.sendFromOutbox(chatId, text, key),
  );
  app.setFeishuStatus(() => ({ ...feishu.status(), reason: feishu.status().reason ?? '' }));

  return { feishu, personal, personalAi, personalAiView, configurePersonalAi, personalView, bots, registrations, registrationView, proposeMail, commandGroup };
}
