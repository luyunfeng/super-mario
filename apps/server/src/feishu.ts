import { randomInt } from 'node:crypto';
import { createFeishuIntegration } from '../../../plugins/feishu.ts';
import { createIntegrationConfig } from '../../../packages/core/src/integration-config.ts';
import type { AppConfig, Message, MessageRoute } from '../../../packages/protocol/src/index.ts';
import type { createWorkbench } from '../../../packages/core/src/workbench.ts';

// The legacy bot controller consumes only the original adapter surface.
// Personal collection owns the optional paged provider independently.
type Integration = Omit<ReturnType<typeof createFeishuIntegration>, 'collectBatch'>;
type Factory = (options: Parameters<typeof createFeishuIntegration>[0]) => Integration;
/** Composition only: platform I/O lives in the adapter, conversations and inbox in core. */
export function createFeishuController(app: Awaited<ReturnType<typeof createWorkbench>>, config: AppConfig, factory: Factory = createFeishuIntegration) {
  const settings = createIntegrationConfig(config.dataDir, config.feishu);
  let integration: Integration | undefined;
  let bindingCode = String(randomInt(100000, 1000000));
  let codeExpires = Date.now() + 10 * 60_000;
  let closed = false;
  let generation = 0;
  let operations = Promise.resolve();
  let lastError: string | undefined;
  const replies = new Map<string, { chatId: string; generation: number }>();
  const admitting = new Set<string>();
  const sending = new Set<Promise<void>>();
  const ownerKey = () => `feishu.owner.${settings.read().appId}`;
  const enabled = () => settings.read().enabled && app.plugins.list().some(plugin => plugin.id === 'feishu' && plugin.enabled && plugin.status === 'active');
  function pairingCode() {
    if (Date.now() > codeExpires) { bindingCode = String(randomInt(100000, 1000000)); codeExpires = Date.now() + 10 * 60_000; }
    return bindingCode;
  }
  function report(error: unknown) {
    const secret = settings.read().appSecret;
    const message = error instanceof Error ? error.message : String(error);
    lastError = secret ? message.split(secret).join('[redacted]') : message;
    if (!closed) app.events.publish('feishu.changed', { reason: lastError });
  }
  async function send(chatId: string, text: string, key: string, tracked = true) {
    const active = integration, epoch = generation;
    if (!active || closed || !enabled()) throw Object.assign(new Error('飞书尚未启用'),{delivery:'no'});
    const deliver = async () => {
      if (closed || !enabled() || epoch !== generation || active !== integration) throw Object.assign(new Error('飞书发送已取消'), { delivery: 'no' });
      await active.send(chatId, text);
    };
    // Test adapters may omit Effects; the product composition always supplies it.
    if (app.effects && tracked) await app.effects.perform({ key, kind: 'feishu.send', target: chatId, summary: '机器人回复', content: { text }, run: deliver });
    else await deliver();
  }
  function track(task: Promise<void>) { sending.add(task); void task.finally(() => sending.delete(task)); }
  const offDurable = app.background?.eventbox.subscribe('core',{
    name:'feishu-results',types:[{type:'run.finished',version:1}],effects:'none',replay:1000,
    handler(event){
      const data=event.data as unknown as {messageId:string};
      const message=app.store.get<Message>('messages',data.messageId);
      if(!message?.replyTo)return {status:'skip',reason:'no_reply_origin'};
      if(!enabled())return{status:'retry',reason:'飞书已停用，等待恢复',afterSec:60,deferred:true};
      const current=settings.read();
      const receipt=app.store.list<{inputId:string;appId?:string;chatId?:string}>('feishu.receipts').find(item=>item.inputId===message.replyTo&&item.appId===current.appId);
      const route=app.store.get<MessageRoute>('message.routes',message.replyTo);
      const target=receipt?.chatId??(route?.channel==='feishu'&&route.accountId===current.appId?route.target:undefined);
      if(!target)return {status:'skip',reason:'not_feishu'};
      const owner=app.store.get<{chatId:string}>('settings',ownerKey());
      if(target!==owner?.chatId)return {status:'failed',reason:'配对用户已改变，需核实接收人'};
      const oldEffect=app.effects?.list().find(effect=>effect.key===`feishu-result:${current.appId}:${message.id}`);
      if(oldEffect?.status==='confirmed')return{status:'skip',reason:'legacy_already_sent'};
      const result=app.background.outbox.enqueueReply({dedupKey:`result:${current.appId}:${message.id}`,channel:'feishu.bot',target,content:{text:message.text},causedBy:event.id},current.appId);
      if(oldEffect&&['sent','unknown'].includes(oldEffect.status)){
        const item=app.background.outbox.list().find(i=>i.id===result.id)!;
        app.store.put('outbox.items',item.id,{...item,status:'unknown',error:'旧发送路径结果未知，请核实后处理'});
      }
      return {status:'done'};
    },
  });
  if(app.background) for(const run of app.store.list<import('../../../packages/protocol/src/index.ts').Run>('runs')) {
    const messageId=`run-result:${run.id}`;
    if(app.store.get('messages',messageId)&&['completed','failed'].includes(run.status)) app.background.publish({type:'run.finished',typeVersion:1,sourceId:`run:${run.id}:finished`,data:{runId:run.id,messageId,status:run.status},subject:{kind:'run',id:run.id}});
  }
  const off = app.events.subscribe(event => {
    if (closed) return;
    if (event.type === 'plugins.changed' && event.data && typeof event.data === 'object' && !Array.isArray(event.data) && event.data.id === 'feishu') { void restart().catch(report); return; }
    if (['runs.result','notifications.message'].includes(event.type) && app.background) return;
    if (['runs.result', 'notifications.message'].includes(event.type) && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
      const messageId = event.data.messageId;
      const message = typeof messageId === 'string' ? app.store.get<Message>('messages', messageId) : undefined;
      if (!message?.replyTo || !enabled()) return;
      const current = settings.read();
      const receipt = app.store.list<{ inputId: string; appId?: string; chatId?: string }>('feishu.receipts').find(item => item.inputId === message.replyTo && item.appId === current.appId);
      const route = app.store.get<MessageRoute>('message.routes', message.replyTo);
      const target = receipt?.chatId ?? (route?.channel === 'feishu' && route.accountId === current.appId ? route.target : undefined);
      const owner = app.store.get<{chatId:string}>('settings', ownerKey());
      if (target && target === owner?.chatId) track(send(target, message.text, `feishu-result:${current.appId}:${String(messageId)}`).catch(report));
      return;
    }
    if (event.type !== 'messages.changed' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
    const id = event.data.messageId;
    if (typeof id !== 'string') return;
    const message = app.store.get<Message>('messages', id);
    if (message?.origin === 'result' || message?.origin === 'notification') return;
    if (message?.role !== 'assistant' || !message.replyTo || !['done', 'failed'].includes(message.status ?? '')) return;
    const route = app.store.get<MessageRoute>('message.routes', message.replyTo);
    const owner = app.store.get<{chatId:string}>('settings', ownerKey());
    const resumed = route?.resumed && route.channel === 'feishu' && route.accountId === settings.read().appId && route.target === owner?.chatId ? { chatId: route.target, generation } : undefined;
    const target = replies.get(message.replyTo) ?? resumed;
    if (!target || target.generation !== generation || !integration) return;
    replies.delete(message.replyTo);
    // Claim before sending. A failed/unknown send is visible and is never silently repeated.
    track(send(target.chatId, message.text, `feishu-reply:${settings.read().appId}:${message.id}`).catch(report));
  });
  async function apply() {
    generation++; replies.clear();
    await integration?.close(); integration = undefined; lastError = undefined;
    if (closed || !enabled()) return;
    const current = settings.read(), epoch = generation;
    integration = factory({
      appId: current.appId, appSecret: current.appSecret, profile: current.profile, collectEnabled: current.collectEnabled === true,
      async onMessage(text, source) {
        if (closed || epoch !== generation || !enabled() || source.chatType !== 'p2p') return;
        const owner = app.store.get<{ chatId: string }>('settings', ownerKey());
        if (!owner) {
          // A fresh installation accepts only its short-lived code, not arbitrary senders.
          if (text.trim() !== pairingCode()) return;
          app.store.put('settings', ownerKey(), { chatId: source.chatId });
          app.events.publish('feishu.changed', { paired: true });
          return '工作台已绑定。现在可以给主 Agent 发送消息。';
        }
        if (owner.chatId !== source.chatId) return;
        const receipt = `${current.appId}:${source.messageId}`;
        if (admitting.has(receipt) || app.store.get('feishu.receipts', receipt)) return;
        const state = app.agent.status();
        if (!state.available) return `主 Agent 当前不可用：${state.reason ?? '请先配置模型'}。Web 工作台仍可正常使用。`;
        admitting.add(receipt);
        try {
          const accepted = await app.agent.post(text, 'main');
          app.store.put('message.routes', accepted.id, { channel: 'feishu', accountId: current.appId, target: source.chatId } satisfies MessageRoute);
          app.store.put('feishu.receipts', receipt, { inputId: accepted.id, appId: current.appId, chatId: source.chatId, at: new Date().toISOString() });
          if (!closed && epoch === generation && enabled()) replies.set(accepted.id, { chatId: source.chatId, generation: epoch });
        } finally { admitting.delete(receipt); }
      },
      async onInbox(things) { if (!closed && epoch === generation && enabled() && app.plugins.list().some(plugin => plugin.id === 'inbox-triage' && plugin.status === 'active')) await app.inbox.ingest(`feishu:${current.appId}:${current.profile}`, things); },
    });
    await integration.start();
    app.events.publish('feishu.changed', { configured: true });
  }
  function restart() {
    generation++; replies.clear(); // Invalidate callbacks now, before asynchronous cleanup starts.
    const job = operations.then(apply);
    operations = job.catch(report);
    return job;
  }
  return {
    start: restart,
    send,
    sendFromOutbox:(chatId:string,text:string,key:string)=>send(chatId,text,key,false),
    status() {
      const paired = Boolean(app.store.get('settings', ownerKey()));
      return { ...settings.public(), enabled: enabled(), ...integration?.status(), connected: integration?.status().connected ?? false, paired, pairingCode: !paired && enabled() ? pairingCode() : undefined, reason: lastError ?? integration?.status().reason ?? (enabled() ? '正在准备连接' : '尚未启用飞书连接') };
    },
    async update(input: Record<string, unknown>) { settings.write(input); await restart(); return this.status(); },
    async pausePersonalCollection() {
      const current = settings.read();
      if (!current.collectEnabled) return;
      settings.write({ enabled: current.enabled, collectEnabled: false });
      await restart();
    },
    async collect() {
      if (!app.plugins.list().some(plugin => plugin.id === 'inbox-triage' && plugin.status === 'active')) throw new Error('请启用收件箱整理插件');
      if (!integration || !enabled()) throw new Error('飞书尚未连接');
      const current = settings.read(), epoch = generation, active = integration;
      const things = await active.collect();
      if (closed || epoch !== generation || !enabled() || active !== integration) throw new Error('飞书采集已取消');
      if (!app.plugins.list().some(plugin => plugin.id === 'inbox-triage' && plugin.status === 'active')) throw new Error('请启用收件箱整理插件');
      await app.inbox.ingest(`feishu:${current.appId}:${current.profile}`, things);
      return { collected: things.length };
    },
    async close() {
      closed = true; generation++; replies.clear(); await off(); await offDurable?.();
      await operations; await integration?.close(); await Promise.allSettled([...sending]);
    },
  };
}
