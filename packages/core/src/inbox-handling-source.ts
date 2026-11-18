import { createHash } from 'node:crypto';
import type { Store } from '../../plugin-sdk/src/index.ts';
import type { InboxItem, MailboxEntry, Project, Todo, NormalizedReplyEvidence } from '../../protocol/src/index.ts';
import type { InboxHandlingRef, InboxHandlingSource } from '../../protocol/src/inbox-handling.ts';

export interface PersonalReplyAccount { profile: string; appId: string; openId: string }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message: string, status = 409): never { throw Object.assign(new Error(message), { status, delivery: 'no' }); }

/** Routing comes from connector-observed metadata, never free-form model args. */
export function personalInboxReplyTarget(store: Store, id: string, account?: PersonalReplyAccount) {
  const item = store.get<InboxItem>('inbox', id);
  if (!item) fail('收件消息不存在', 404);
  if (!account || item.source !== `feishu:${account.appId}:${account.openId}`) fail('请连接采集这条消息的个人飞书账号');
  if (!item.thread.startsWith('feishu:message:')) fail('旧来源没有单条消息引用，不能自动回复；请使用新采集的消息');
  let pair: unknown;
  try { pair = JSON.parse(item.thread.slice('feishu:message:'.length)); } catch { fail('来源消息引用无效'); }
  if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string'
    || !/^oc_[A-Za-z0-9_-]+$/.test(pair[0]) || !/^om_[A-Za-z0-9_-]+$/.test(pair[1])
    || item.origin?.chatId !== pair[0] || item.last.split(':')[0] !== pair[1]) fail('来源消息引用不完整或不匹配');
  const evidence = store.list<NormalizedReplyEvidence>('todo.reply-sources').find(row => row.source === item.source && row.chatId === pair[0] && row.messageId === pair[1]);
  if (!evidence || evidence.deleted) fail('缺少连接器观察的消息依据，不能自动回复');
  return { profile: account.profile, appId: account.appId, openId: account.openId, chatId: pair[0], messageId: pair[1], sourceVersion: item.version };
}

/** Public source projection for both existing inbox collections. */
export function createInboxHandlingSources(options: {
  store: Store;
  personalAccount(): PersonalReplyAccount | undefined;
  mailboxAccess(entry: MailboxEntry): { active: boolean; reason?: string; replyAvailable: boolean; replyReason?: string; binding?: string };
}) {
  const { store } = options;
  return function read(ref: InboxHandlingRef): InboxHandlingSource {
    if (!ref || !['personal', 'mailbox'].includes(ref.kind) || typeof ref.id !== 'string' || !ref.id.trim()) fail('收件来源无效', 400);
    let result: InboxHandlingSource;
    const pluginGeneration=['inbox-triage','feishu'].map(id=>store.get<{revision?:number}>('core.plugin-settings',id)?.revision??1);
    if (ref.kind === 'personal') {
      const item = store.get<InboxItem>('inbox', ref.id);
      if (!item) fail('收件消息不存在', 404);
      let replyReason: string | undefined;
      try { personalInboxReplyTarget(store, ref.id, options.personalAccount()); }
      catch (error) { replyReason = error instanceof Error ? error.message : '个人回复连接不可用'; }
      result = { ...ref, version: item.version, title: item.title, text: item.text,
        ...(item.projectId ? { projectId: item.projectId } : {}), ...(item.todoId ? { todoId: item.todoId } : {}),
        active: !item.archivedAt, ...(item.archivedAt ? { reason: '消息已归档，请先恢复到收件箱' } : {}),
        replyAvailable: !replyReason, ...(replyReason ? { replyReason } : {}),
        binding: digest([item.source, item.thread, item.last, item.origin, item.updatedAt, item.archivedAt??null, options.personalAccount() ?? null,pluginGeneration]) };
    } else {
      const entry = store.get<MailboxEntry>('event.mailboxes', ref.id);
      if (!entry || entry.direction !== 'inbox') fail('机器人收件不存在', 404);
      const access = options.mailboxAccess(entry);
      const blocked = !['pending', 'ready'].includes(entry.status) || entry.scope.kind === 'unmarked';
      result = { ...ref, version: entry.version, title: entry.title, text: entry.text,
        ...('projectId' in entry.scope && entry.scope.projectId ? { projectId: entry.scope.projectId } : {}),
        ...(entry.scope.kind === 'task' ? { todoId: entry.scope.todoId } : {}), ...access,
        ...(blocked ? { active: false, reason: entry.scope.kind === 'unmarked' ? '请先给消息选择项目或事项范围' : '该消息已处理或结果未确认，仅供查看' } : {}) };
      result.binding=digest([access.binding??null,pluginGeneration]);
    }
    if (result.projectId) {
      const project = store.get<Project>('projects', result.projectId);
      if (!project || project.archivedAt) result = { ...result, active: false, reason: '所属项目不存在或已归档' };
      result.binding=digest([result.binding,project?.updatedAt??null,project?.archivedAt??null]);
    }
    if (result.todoId) {
      const todo = store.get<Todo>('todos', result.todoId);
      if (!todo || todo.projectId !== result.projectId || todo.completedAt) result = { ...result, active: false, reason: '关联待办已结束或项目归属已变化' };
      result.binding=digest([result.binding,todo?.updatedAt??null,todo?.completedAt??null]);
    }
    return result;
  };
}
