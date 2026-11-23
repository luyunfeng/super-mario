import {readBriefingSettings} from './briefing.ts';
import type { Store, EventBus } from '../../plugin-sdk/src/index.ts';
import type { FeishuBot, Project, Run, Message, Approval, Todo, AwayNotification as PendingNotice } from '../../protocol/src/index.ts';
import type { createBackground } from './background.ts';
import type { createWebPresence } from './web-presence.ts';

export function createAwayNotifications({ store, background, presence, bots, channel, events }: {
  store: Store; background: ReturnType<typeof createBackground>; presence: ReturnType<typeof createWebPresence>;
  bots: () => FeishuBot[]; channel: (bot: FeishuBot) => string; events?: EventBus;
}) {
  const list = () => store.list<PendingNotice>('notifications.away');
  function flush() {
    // Re-register unchanged routes after restart so already queued outbox items can resume.
    for (const bot of bots().filter(b => b.scope.kind !== 'unmarked' && b.enabled && b.configured && b.connected && b.paired && b.replyTarget)) channel(bot);
    const settings = store.get<{enabled?:boolean; alwaysNotifyRuns?:boolean}>('notifications.settings','away');
    const disabled = settings?.enabled === false;
    const alwaysNotifyRuns = settings?.alwaysNotifyRuns === true;
    if (disabled || presence.status().present) {
      for (const item of list().filter(i => ['pending','queued'].includes(i.status))) {
        if (!disabled && alwaysNotifyRuns) {
          // Older notices have no runId, but retain their durable event identity.
          const isRun = item.runId || store.get<{type:string}>('eventbox.events',item.id.slice('away:'.length))?.type === 'run.finished';
          if (isRun) continue;
        }
        const outgoing = item.outboxId ? background.outbox.list().find(o=>o.id===item.outboxId) : undefined;
        // A return to Web may suppress unsent notifications, never rewrite uncertain delivery.
        if (outgoing && ['sending','sent','unknown'].includes(outgoing.status)) continue;
        if (outgoing && outgoing.status !== 'cancelled') background.outbox.cancel(outgoing.id,outgoing.version);
        store.put('notifications.away',item.id,{...item,status:'skipped',reason:disabled?'离场通知已关闭':'用户已返回页面，取消未发送通知'});
      }
      if (disabled || !alwaysNotifyRuns) return;
    }
    for (const item of list().filter(i => i.status === 'pending')) {
      if (item.decision && store.get<{status:string}>(item.decision.kind === 'approval' ? 'approvals':'plans',item.decision.id)?.status !== 'pending') {
        store.put('notifications.away',item.id,{...item,status:'skipped',reason:'决定已处理'});continue;
      }
      if (item.cardId && store.get<{status:string}>('interactions', item.cardId)?.status !== 'open') {
        store.put('notifications.away', item.id, { ...item, status: 'skipped', reason: '问题已处理' }); continue;
      }
      if (item.projectId && store.get<Project>('projects', item.projectId)?.archivedAt) {
        store.put('notifications.away', item.id, { ...item, status: 'skipped', reason: '项目已归档' }); continue;
      }
      const candidates = bots().filter(b => b.enabled && b.configured && b.connected && b.paired && b.replyTarget);
      const match = candidates.sort((a,b) => a.id.localeCompare(b.id));
      const bot = match.find(b => b.scope.kind === 'task' && b.scope.todoId === item.todoId)
        ?? match.find(b => b.scope.kind === 'project' && b.scope.projectId === item.projectId)
        ?? match.find(b => b.scope.kind === 'global');
      if (!bot) { store.put('notifications.away', item.id, { ...item, reason: '积压：没有已连接并配对的事项、项目或全局机器人' }); continue; }
      store.transaction(() => {
        const card = item.cardId ? store.get<{version:number}>('interactions',item.cardId) : undefined;
        const outgoing = background.outbox.enqueue('away-notifications', { dedupKey: item.id, channel: channel(bot), target: 'owner', content: { text: item.text }, ...(item.todoId ? {relatedTo:{kind:'todo',id:item.todoId}} : {}),...(card?.version ? {staleIf:{ref:`interaction:${item.cardId}`,version:card.version}} : item.decision ? {staleIf:{ref:`${item.decision.kind}:${item.decision.id}`,version:item.decision.version}} : {}) });
        store.put('notifications.away', item.id, { ...item, status: 'queued', outboxId: outgoing.id, reason: '已进入发件箱，沿用发送授权和审批' });
      });
    }
  }
  const off = background.eventbox.subscribe('core', { name: 'away-notifications', effects: 'none', types: [{type:'run.finished',version:1},{type:'interaction.user_required',version:1},{type:'web.notice',version:1}], handler(event) {
    const id = `away:${event.id}`;
    if (store.get('notifications.away', id)) return {status:'done'};
    const data = event.data as { runId?: string; id?: string; messageId?: string; webPresent?: boolean; decisionKind?: 'approval'|'plan'; decisionId?: string; version?: number };
    const approval = data.decisionKind === 'approval' ? store.get<Approval>('approvals',data.decisionId!) : undefined;
    const planOrigin = data.decisionKind === 'plan' ? store.get<{projectId?:string;todoId?:string}>('plan-origins',data.decisionId!) : undefined;
    const run = data.runId ? store.get<Run>('runs',data.runId) : undefined;
    const card = data.id ? store.get<{projectId?:string;runId?:string;status:string}>('interactions',data.id) : undefined;
    const originRun = run ?? (card?.runId ? store.get<Run>('runs',card.runId) : undefined);
    const message = data.messageId ? store.get<Message>('messages',data.messageId) : undefined;
    const todoId = originRun?.todoId ?? approval?.todoId ?? planOrigin?.todoId ?? message?.todoId;
    const todo = todoId ? store.get<Todo>('todos',todoId) : undefined;
    const projectId = originRun?.projectId ?? card?.projectId ?? todo?.projectId ?? planOrigin?.projectId ?? message?.projectId ?? (typeof approval?.params.projectId === 'string' ? approval.params.projectId : undefined);
    const plan = data.decisionKind === 'plan' ? store.get<{title:string}>('plans',data.decisionId!) : undefined;
    const originalRoute = message?.replyTo ? store.get<{channel:string}>('message.routes',message.replyTo) : undefined;
    const atSource = store.get<{present:boolean}>('notifications.source-presence',data.runId ? `run:${data.runId}` : `interaction:${data.id}`)?.present;
    const awaySettings = store.get<{enabled?:boolean; alwaysNotifyRuns?:boolean}>('notifications.settings','away');
    const isRunFinish = event.type === 'run.finished';
    const present = data.webPresent ?? atSource ?? presence.status().present;
    const skip = (present && !(isRunFinish && awaySettings?.alwaysNotifyRuns === true)) || awaySettings?.enabled === false || Boolean(originalRoute?.channel);
    const held = !skip && readBriefingSettings(store).lowDistraction &&
      (isRunFinish || (message && message.conversationId !== 'main' && !data.decisionKind && !data.id));
    const project = projectId ? store.get<Project>('projects', projectId) : undefined;
    const runHeader = originRun ? `后台 Agent · ${originRun.machineId || originRun.executorId}${project ? ` · ${project.name}` : ''}` : '';
    const fallbackText = message?.text
      ?? (approval ? `等待审批：${approval.title}\n${approval.details}` : plan ? `等待确认计划：${plan.title}` : originRun ? `${runHeader}\n${originRun.error || originRun.output || '执行已结束'}` : '有工作结果或决定需要你查看');
    store.put('notifications.away',id,{ id,createdAt:event.createdAt,...(isRunFinish && run && {runId:run.id}),...(message && {messageId:message.id}),text:fallbackText,projectId,todoId,cardId:data.id,...(data.decisionKind?{decision:{kind:data.decisionKind,id:data.decisionId!,version:data.version!}}:{}),status:skip?'skipped':held?'held':'pending',...(held?{reason:'按低干扰设置保留'}:{}),...(skip?{reason:Boolean(originalRoute?.channel)?'沿用原路回复，避免重复通知':'用户在场或已关闭离场通知'}:{}) });
    flush(); return {status:'done'};
  } });
  // Normalize user-visible replies and decisions into the existing durable eventbox.
  const offDomain = events?.subscribe(event => {
    const data = event.data as {id?:string;messageId?:string};
    if (event.type === 'messages.changed' && data.messageId) {
      const m = store.get<Message>('messages',data.messageId);
      if (m?.role !== 'assistant' || !m.replyTo || !['done','failed'].includes(m.status ?? '') || m.origin === 'result' || m.origin === 'notification' || (m.conversationId !== 'main' && !/^project:.*:work$/.test(m.conversationId))) return;
      const key = `web-message:${m.id}`;
      if (store.get('notifications.decision-sources',key)) return;
      store.transaction(()=>{background.publish({type:'web.notice',typeVersion:1,sourceId:key,data:{messageId:m.id,webPresent:presence.status().present}});store.put('notifications.decision-sources',key,{createdAt:new Date().toISOString()});});
    }
    if ((event.type === 'approvals.changed' || event.type === 'plans.changed') && data.id) decision(event.type === 'approvals.changed' ? 'approval':'plan',data.id);
  });
  function decision(kind:'approval'|'plan',id:string) {
    const item = store.get<{status:string;version:number;params?:{outboxId?:string}}>(kind === 'approval'?'approvals':'plans',id);
    // Asking approval for this notification must never generate another notification.
    if (item?.status !== 'pending' || item.params?.outboxId) return;
    const key=`decision:${kind}:${id}:${item.version}`;
    if (store.get('notifications.decision-sources',key)) return;
    store.transaction(()=>{background.publish({type:'web.notice',typeVersion:1,sourceId:key,data:{decisionKind:kind,decisionId:id,version:item.version,webPresent:presence.status().present}});store.put('notifications.decision-sources',key,{createdAt:new Date().toISOString()});});
  }
  for (const a of store.list<{id:string}>('approvals')) decision('approval',a.id);
  for (const p of store.list<{id:string}>('plans')) decision('plan',p.id);
  // Retry only unrouted intents; actual delivery and unknown protection belong to the outbox.
  const timer = setInterval(() => { try { flush(); } catch (error) { console.error('离场通知路由失败', error); } }, 5000); timer.unref();
  return { list, flush, async close() { clearInterval(timer); offDomain?.(); await off(); } };
}
