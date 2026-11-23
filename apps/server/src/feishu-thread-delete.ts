import { createHash } from 'node:crypto';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { MailboxEntry, Message } from '../../../packages/protocol/src/index.ts';
import type { PrivateThread } from './feishu-thread-history.ts';

type Binding = { conversationThreadId?: string };
type Stamp = Binding & { chatBinding?: Binding; statusGrant?: { binding?: Binding }; listThreadIds?: string[]; inboxReplySource?: { id: string }; relay?: { sourceMessageId?: string; parentEntryId?: string } };
type Route = Stamp & { botId: string; accountId: string; revision: number; target: string; envelopeId: string; parentMessageId?: string; replyReference?: unknown };
type ThreadStore = Pick<Store, 'put' | 'get' | 'list'> & Partial<Pick<Store, 'entries' | 'remove'>>;
const digest = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const deletedThreads = 'feishu.deleted-threads';
export type DeletedThread = { botId: string; binding: string; version: number; deletedAt: string; cleanupPending: boolean };

/** The tombstone is the cleanup journal. Startup can finish the exact deleted identity after a crash or rebind. */
export function createThreadDeletionCleanup(store: ThreadStore, forget: (botId: string, threadId: string) => Promise<void>) {
  const jobs = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  function retryLater() {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = undefined; void recover().catch(retryLater); }, 300_000);
    timer.unref();
  }
  function clean(threadId: string, botId: string, binding: string): Promise<void> {
    const row = store.get<DeletedThread>(deletedThreads, threadId);
    if (!row || row.botId !== botId || row.binding !== binding || store.get('feishu.private-threads', threadId))
      return Promise.reject(Object.assign(new Error('独立对话删除记录不匹配'), { status: 409 }));
    if (!row.cleanupPending) return Promise.resolve();
    const previous = jobs.get(threadId);
    if (previous) return previous;
    const job = Promise.resolve().then(() => forget(botId, threadId)).then(() => {
      store.put(deletedThreads, threadId, { ...row, cleanupPending: false });
    }).catch(error => { retryLater(); throw error; }).finally(() => jobs.delete(threadId));
    jobs.set(threadId, job);
    return job;
  }
  async function recover() {
    for (const { id, value } of store.entries?.<DeletedThread>(deletedThreads) ?? []) {
      if (closed) break;
      if (value.cleanupPending && /^[0-9a-f]{64}$/.test(id))
        await clean(id, value.botId, value.binding).catch(retryLater);
    }
  }
  return { clean, recover, async close() {
    closed = true;
    clearTimeout(timer);
    await Promise.allSettled([...jobs.values()]);
  } };
}


/** Keep only opaque routing anchors so replayed platform messages cannot become new main-chat inputs. */
export function eraseThreadChannel(store: ThreadStore, thread: PrivateThread, conversationId: string, mails: MailboxEntry[]) {
  if (!store.entries || !store.remove) throw Object.assign(new Error('当前存储不支持删除对话'), { status: 503 });
  const { threadId, botId, appId, revision, chatId } = thread;
  const messageIds = new Set(store.list<Message>('messages').filter(m => m.conversationId === conversationId).map(m => m.id));
  const routes = store.entries<Route>('message.routes');
  const mailIds = new Set<string>();
  for (const { id, value } of routes) {
    if (messageIds.has(id) || (value.botId === botId && value.conversationThreadId === threadId)) {
      messageIds.add(id);
      mailIds.add(value.envelopeId);
    }
  }
  const platformIds = new Set<string>();
  const capabilities = new Set<string>();
  const stamped = mails.map(mail => ({ mail, stamp: store.get<Stamp>('feishu.bot.envelopes', mail.id) }));
  for (const { mail, stamp } of stamped) {
    if (mail.botId !== botId) continue;
    if (stamp?.conversationThreadId === threadId || stamp?.chatBinding?.conversationThreadId === threadId
      || stamp?.statusGrant?.binding?.conversationThreadId === threadId || stamp?.listThreadIds?.includes(threadId)
      || (mail.replyTo && messageIds.has(mail.replyTo))) mailIds.add(mail.id);
  }
  for (const { mail, stamp } of stamped) {
    if (mail.botId === botId && stamp?.inboxReplySource && mailIds.has(stamp.inboxReplySource.id)) mailIds.add(mail.id);
    const dependentRelay = stamp?.relay && (messageIds.has(stamp.relay.sourceMessageId ?? '') || mailIds.has(stamp.relay.parentEntryId ?? ''));
    if ((mailIds.has(mail.id) || dependentRelay) && ['pending', 'ready', 'processing'].includes(mail.status))
      throw Object.assign(new Error('对话仍有等待处理或正在投递的信件'), { status: 409 });
    if (!mailIds.has(mail.id)) continue;
    for (const key of [mail.id, mail.eventKey]) capabilities.add(createHash('sha256').update(key).digest('hex'));
    if (mail.direction === 'inbox' && mail.sourceMessageId) platformIds.add(mail.sourceMessageId);
  }
  const referenceKeys = new Set<string>();
  for (const id of platformIds) store.put('feishu.deleted-reply-anchors', digest([botId, appId, revision, chatId, id]), threadId);
  for (const { id, value } of store.entries<{entryId: string}>('feishu.bot.reply-references')) {
    if (!mailIds.has(value.entryId)) continue;
    referenceKeys.add(id);
    store.remove('feishu.bot.reply-references', id);
    store.put('feishu.deleted-reply-anchors', id, threadId);
  }
  for (const { id, value } of routes) {
    if (messageIds.has(id)) store.remove('message.routes', id);
    else if (value.botId === botId && value.accountId === appId && value.revision === revision && value.target === chatId
      && value.replyReference && value.parentMessageId && (platformIds.has(value.parentMessageId)
        || referenceKeys.has(digest([botId, appId, revision, chatId, value.parentMessageId]))))
      store.put('message.routes', id, { ...value, replyReference: { unavailable: true } });
  }
  for (const id of mailIds) {
    store.remove('event.mailboxes', id);
    store.remove('feishu.bot.envelopes', id);
    store.remove('feishu.bot.dispatch', botId + ':' + appId + ':' + id);
  }
  for (const id of messageIds) store.remove('feishu.bot.progress', id);
  for (const { id, value } of store.entries<string>('feishu.stop-references'))
    if (messageIds.has(value)) store.remove('feishu.stop-references', id);
  for (const { id, value } of store.entries<{ entryId: string }>('feishu.bot.relays'))
    if (mailIds.has(value.entryId)) store.remove('feishu.bot.relays', id);
  for (const { id, value } of store.entries<{ threadIds?: string[]; start?: Binding }>('feishu.card.navigation'))
    if (capabilities.has(id) || value.start?.conversationThreadId === threadId || value.threadIds?.includes(threadId)) store.remove('feishu.card.navigation', id);
  const key = digest([botId, chatId, '']);
  if (store.get<Binding>('feishu.chat-target', key)?.conversationThreadId === threadId) store.remove('feishu.chat-target', key);
}
