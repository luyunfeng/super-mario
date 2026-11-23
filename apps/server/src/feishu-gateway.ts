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
import {inboxItemId} from '../../../packages/core/src/inbox.ts';
import {createInboxPins} from './feishu-inbox-pins.ts';
import {createPersonalPins} from '../../../plugins/feishu-personal-pins.ts';
import {createFeishuEditHistory} from '../../../plugins/feishu-edit-history.ts';
import {collectInboxRelations} from './feishu-inbox-relations.ts';
import { createPersonalMessages } from './feishu-personal.ts';
import type { GroupReadService } from './feishu-group-read-delivery.ts';
import { createGroupReader } from './feishu-read-group.ts';
import { privateThreadExport } from './feishu-thread-history.ts';
import { dashboardWebBase, createFeishuBotsController, type FeishuBotFactory } from './feishu-bots.ts';
import { createFeishuRegistration, type FeishuRegistrationJob } from './feishu-registration.ts';

export type FeishuGatewayDependencies = {
  botFactory?: FeishuBotFactory;
  readGroup?: GroupReadService;
  commandGroupPlatform?: CommandGroupPlatform;
  registrationProvider?: FeishuRegistrationProvider;
  personalProvider?: PersonalProvider;
  personalPins?:ReturnType<typeof createPersonalPins>;
};

/** Owns all Feishu connectors, QR views, mailbox routing, and outbox reply hosts for the server. */
export function createFeishuGateway(
  app: Awaited<ReturnType<typeof createWorkbench>>,
  config: AppConfig,
  dependencies: FeishuGatewayDependencies = {},
) {
  const feishu = createFeishuController(app, config);
  const history=createFeishuEditHistory(app.store);
  const historyPlugins=['feishu','feishu-edit-history'];
  const historyActive=()=>historyPlugins.every(id=>app.plugins.list().some(plugin=>plugin.id===id && plugin.status==='active'));
  const generation=()=>historyPlugins.map(id=>app.store.get<{revision:number}>('core.plugin-settings',id)?.revision??1).join(':');
  const accountKey=(account:{profile:string;appId:string;openId:string})=>createHash('sha256').update(JSON.stringify([account.profile,account.appId,account.openId])).digest('hex');
  let personalGeneration=0;
  const personal: ReturnType<typeof createPersonalMessages> = createPersonalMessages({
    aiEnabled: () => personalAi.status().enabled,
    observeAi: (source, messages, assertCurrent) => personalAi.observe(source, messages, assertCurrent),
    config,
    provider: dependencies.personalProvider,
    stopPreviousCollection: () => feishu.pausePersonalCollection(),
    canCollect: () => ['feishu', 'inbox-triage'].every(id => app.plugins.list().some(plugin => plugin.id === id && plugin.status === 'active')),
    ingest: (source, things) => app.inbox.ingest(source, things),
    collectMeetingMemory: app.collectMeetingMemory,
    accountChanged:()=>{personalGeneration++;app.events.publish('feishu.edit-history.changed',{accountChanged:true});},
    captureEdits(account) {
      if(!historyActive()) return;
      const key=accountKey(account),settings=history.settings(key),epoch=generation();
      if(!settings.enabled) return;
      return observations=>{
        if(historyActive() && generation()===epoch) history.observe(key,settings.revision,observations);
      };
    },
    collectRelations:(...args)=>collectInboxRelations(app.store,app.inbox.offerConnectorParent,app.waitingReplies.observedSource,...args),
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
    return { ...personalAi.status(), accountKey:account?accountKey(account):'' };
  }
  function currentHistory() {
    if(!historyActive()) throw new InputError('飞书或消息编辑历史插件未启用',503);
    const account=personal.sourceAccount();
    if(!account) throw new InputError('请先连接并核验个人飞书账号',409);
    const key=accountKey(account);
    return {...history.settings(key),accountKey:key,source:'feishu:'+account.appId+':'+account.openId};
  }
  function configureHistory(input:Record<string,unknown>) {
    const current=currentHistory();
    if(Object.keys(input).some(key=>!['accountKey','revision','enabled'].includes(key)) ||
      typeof input.enabled!=='boolean' || typeof input.revision!=='number' || !Number.isSafeInteger(input.revision) || input.revision<0)
      throw new InputError('编辑历史设置或版本无效',400);
    if(input.accountKey!==current.accountKey) throw new InputError('个人飞书账号已变化，请重新读取设置',409);
    const updated=history.configure(current.accountKey,input.enabled,input.revision);
    if(updated.revision!==current.revision) app.events.publish('feishu.edit-history.changed',{accountKey:current.accountKey,revision:updated.revision});
    return {...current,...updated};
  }
  function readEditHistory(id:string) {
    const state=currentHistory(),item=app.store.get<import('../../../packages/protocol/src/index.ts').InboxItem>('inbox',id);
    if(!item || item.id!==id || item.source!==state.source || !item.thread.startsWith('feishu:message:'))
      throw new InputError('当前账号没有这条原始飞书收件',404);
    if(!state.enabled) throw new InputError('个人消息编辑历史已关闭',403);
    const chatId=item.origin?.chatId,messageId=item.last.split(':')[0];
    if(!chatId || !/^oc_[a-zA-Z0-9_-]+$/.test(chatId) || !messageId || !/^om_[a-zA-Z0-9_-]+$/.test(messageId) ||
      item.thread!=='feishu:message:'+JSON.stringify([chatId,messageId]) || inboxItemId(item.source,item.thread)!==id ||
      app.waitingReplies.observedSource(item.source,chatId,messageId)?.deleted)
      throw new InputError('无法核对原始飞书消息',404);
    return history.read(state.accountKey,chatId,messageId);
  }
  app.setFeishuEditHistoryReader(readEditHistory);
  const pins=createInboxPins(app,dependencies.personalPins??createPersonalPins(),()=>{
    const account=personal.sourceAccount();
    return account?{account:{...account,name:personal.status().account?.name??''},key:accountKey(account),generation:personalGeneration}:undefined;
  });
  app.setFeishuPinReader(pins.list);
  app.setFeishuPinOriginalReader(pins.readListedOriginal);
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
    const account=personal.sourceAccount();
    const value = {...personal.status(),...(account && {accountKey:accountKey(account),source:'feishu:'+account.appId+':'+account.openId})};
    return value.url ? { ...value, qrDataUrl: await QRCode.toDataURL(value.url, { width: 280, margin: 2, errorCorrectionLevel: 'M' }) } : value;
  }
  app.subscriptions.setPublicBase(dashboardWebBase(config,process.env.SUPER_MARIO_WEB_URL));
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
  app.setPrivateOfficeValidator(bots.canReadOfficeSource);
  app.setPrivateFileValidator(bots.canReadPrivateFile);
  app.setPrivateImageValidator(bots.canReadPrivateImage);
  app.setScopeRequestValidator(bots.ownerScopeRequest);
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

  return { feishu, personal, pins, currentHistory, configureHistory, readEditHistory, personalAi, personalAiView, configurePersonalAi, personalView, bots, registrations, registrationView, proposeMail, commandGroup };
}
