import { createHash } from 'node:crypto';
import { botConversationId } from '../../../packages/core/src/bot-agent-routing.ts';
import type { FeishuAgentInputTarget, MailboxEntry } from '../../../packages/protocol/src/bots.ts';
import type { Message, MachineInfo, Project, Run, Todo } from '../../../packages/protocol/src/index.ts';
import type { FeishuBotSettings } from '../../../plugins/feishu-bot-config.ts';
import type { FeishuMessageSource } from '../../../plugins/feishu.ts';
import type { FeishuBotsApp } from './feishu-bots.ts';

type Topic = { todoId: string; grant: string; binding: string; opening: boolean };
type Anchor = NonNullable<FeishuAgentInputTarget['topic']>;
type Target = FeishuAgentInputTarget & { topic: Anchor };
type Selected = { worker?: Run; reason?: string };
type Notice = { text: string; approvalId?: string };
type Receipt = { notice: Notice; textHash: string };
type Stamp = { revision: number; topic?: Omit<Topic, 'binding'>; group?: FeishuMessageSource; platformReplyTo?: string; threadId?: string };
type Route = Stamp & { channel: string; botId: string; accountId: string; inputId: string; sourceMessageId?: string;
  scope: {kind: string}; target: string; envelopeId: string };
const receipts = 'feishu.topic-executor-inputs';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const nativeId = (run: Run) => run.nativeSessionId ?? run.nativeResume?.nativeSessionId;

export function createTopicExecutor(app: Pick<FeishuBotsApp, 'store' | 'approvals' | 'mailboxes' | 'listExecutors'>) {
  const { store } = app;
  function select(todoId: string): Selected | undefined {
    const todo = store.get<Todo>('todos', todoId), assigned = todo?.responsibleSession;
    if (!assigned) return;
    const worker = store.get<Run>('runs', assigned.runId);
    if (todo.completedAt || !worker || worker.id !== assigned.runId || worker.todoId !== todoId || worker.projectId !== todo.projectId ||
        !worker.machineId || !worker.sessionId || worker.machineId !== assigned.machineId || worker.sessionId !== assigned.sessionId)
      return { reason: '登记的负责会话与当前待办不再匹配。' };
    if (worker.status !== 'running' || worker.executionMode !== 'interactive')
      return { reason: '负责会话当前无法接收交互输入。' };
    if (todo.projectId) {
      const project = store.get<Project>('projects', todo.projectId);
      if (!project || project.archivedAt) return { reason: '待办所属项目已失效。' };
    }
    const machine = store.get<MachineInfo>('machines', worker.machineId);
    const ready = app.listExecutors?.().some(e => e.id === worker.executorId && e.machineId === worker.machineId &&
      e.mode === 'real' && !e.taskOnly && e.available);
    if (!machine?.online || !machine.capabilities?.some(method => method === 'executor.input' || method === 'executor.input.once') || !ready)
      return { reason: '负责会话所在电脑或执行者当前不可用。' };
    if (store.list<Run>('runs').some(other => other.id !== worker.id && other.machineId === worker.machineId &&
      other.executorId === worker.executorId && other.createdAt >= worker.createdAt &&
      (other.sessionId === worker.sessionId || (!!nativeId(worker) && nativeId(other) === nativeId(worker)))))
      return { reason: '负责会话已有更新的执行记录。' };
    return { worker };
  }
  function words(target: Target) {
    const a = target.topic;
    const msg = store.get<Message>('messages', a.inputId), route = store.get<Route>('message.routes', a.inputId);
    if (!msg || msg.id !== a.inputId || msg.role !== 'user' || msg.readOnly || (msg.origin && msg.origin !== 'user') ||
      msg.conversationId !== botConversationId({ id: target.botId, scope: { kind: 'global' } }) ||
      msg.todoId !== target.todoId || (msg.projectId ?? '') !== target.projectId || !msg.text.trim() ||
      route?.channel !== 'feishu' || route.scope?.kind !== 'global' || route.botId !== target.botId ||
      route.accountId !== target.appId || route.inputId !== a.inputId || route.sourceMessageId !== a.messageId || route.target !== a.chatId) return;
    const stamp = store.get<Stamp>('feishu.bot.envelopes', route.envelopeId);
    const matches = (s?: Stamp) => s?.topic?.opening === false && s.topic.todoId === target.todoId && s.topic.grant === a.grant &&
      s.revision === target.revision && s.threadId === a.threadId && s.platformReplyTo === a.messageId &&
      s.group?.chatType === 'group' && s.group.senderType === 'user' && s.group.senderId === target.owner.senderId &&
      s.group.chatId === a.chatId && s.group.threadId === a.threadId && s.group.messageId === a.messageId;
    if (!matches(route) || !matches(stamp)) return;
    const entry: MailboxEntry | undefined = app.mailboxes.list().find(row => row.id === route.envelopeId);
    if (entry?.botId !== target.botId || entry.direction !== 'inbox' || entry.scope.kind !== 'global' ||
      !['processing', 'completed'].includes(entry.status) || entry.eventKey !== 'feishu-in:' + JSON.stringify([target.botId, target.appId, a.messageId]) ||
      entry.sourceMessageId !== a.messageId || entry.target !== a.chatId || entry.text !== msg.text) return;
    const dispatch = store.get<{status: string; id?: string}>('feishu.bot.dispatch', [target.botId, target.appId, entry.id].join(':'));
    if (dispatch?.status === 'completed' && dispatch.id === msg.id) return msg.text;
  }
  function valid(target: FeishuAgentInputTarget): boolean {
    if (!target.topic) return false;
    const worker = select(target.todoId)?.worker;
    if (!worker || worker.id !== target.runId || worker.machineId !== target.machineId || worker.sessionId !== target.sessionId ||
      worker.executorId !== target.executorId || (worker.projectId ?? '') !== target.projectId || worker.cwd !== target.cwd ||
      (target.nativeSessionId && nativeId(worker) !== target.nativeSessionId)) return false;
    const text = words({ ...target, topic: target.topic });
    const stored = store.get<Receipt>(receipts, target.topic.inputId);
    return !!text && stored?.textHash === digest(text);
  }
  function propose(bot: FeishuBotSettings, paired: {chatId: string; senderId?: string}, source: FeishuMessageSource,
    topic: Topic, acceptedId: string, selected: Selected): Notice {
    return store.transaction(() => {
      const existing = store.get<Receipt>(receipts, acceptedId);
      if (existing) return existing.notice;
      const unavailable = (reason: string) => ({ text: '决定已记录，未向负责会话发出输入。' + reason });
      const current = select(topic.todoId);
      const worker = current?.worker;
      let notice: Notice = unavailable(selected.reason ?? current?.reason ?? '负责会话或输入审批当前不可用。');
      let text = '';
      if (bot.enabled && !bot.archivedAt && bot.scope.kind === 'global' && paired.senderId && !topic.opening && topic.binding &&
        source.threadId && source.chatId && source.messageId && source.senderId === paired.senderId && source.senderType === 'user' &&
        source.chatType === 'group' && worker?.machineId && worker.sessionId && worker.id === selected.worker?.id &&
        worker.machineId === selected.worker.machineId && worker.sessionId === selected.worker.sessionId &&
        worker.executorId === selected.worker.executorId && (!bot.executorId || bot.executorId === worker.executorId) && app.approvals) {
        const target: Target = { botId: bot.id, appId: bot.appId, revision: bot.revision, owner: { chatId: paired.chatId, senderId: paired.senderId },
          runId: worker.id, sessionId: worker.sessionId, machineId: worker.machineId, executorId: worker.executorId, nativeSessionId: nativeId(worker),
          cwd: worker.cwd, todoId: topic.todoId, projectId: worker.projectId ?? '',
          topic: { binding: topic.binding, grant: topic.grant, chatId: source.chatId, threadId: source.threadId, messageId: source.messageId, inputId: acceptedId } };
        text = words(target) ?? '';
        if (text) {
          const approval = app.approvals.propose({ kind: 'input', title: '将话题决定发送给负责会话', details: `负责会话：${worker.sessionId}\n执行者：${worker.executorId}\n如需改动，请拒绝后在原话题重新发送。`,
            todoId: topic.todoId, params: { fixedInput: true, id: worker.id, sessionId: worker.sessionId, machineId: worker.machineId,
              executorId: worker.executorId, ...(target.nativeSessionId && { nativeSessionId: target.nativeSessionId }),
              todoId: topic.todoId, ...(worker.projectId && { projectId: worker.projectId }), text } });
          store.put('feishu.agent-input-targets', approval.id, target);
          notice = { approvalId: approval.id, text: '决定已记录，输入正在等待主人到 Web 审批。' };
        }
      }
      store.put(receipts, acceptedId, { notice, textHash: digest(text) } satisfies Receipt);
      return notice;
    });
  }
  return { select, propose, valid };
}
