// Puts the mail of the owner's mailboxes into the inbox, the way the GitHub connector puts
// notifications there. Reading the mail is the workbench's; this decides what becomes an
// item and what keeps replies together.
import { createHash } from 'node:crypto';
import type { InboxThing, Mailbox, MailSummary } from '../packages/protocol/src/index.ts';

/** What one read of a mailbox found. */
export interface MailInboxRead {
  account: { id: string; name: string; email: string };
  mailboxes: Mailbox[];
  messages: MailSummary[];
}

/** What the connector may do. The workbench gives it these. */
export interface MailConnectorActions {
  /** Reads the mailboxes the owner added that are to go into the inbox. */
  read(): Promise<MailInboxRead[]>;
  /** Puts things into the inbox. It updates an item whose thread is the same. */
  ingest(things: InboxThing[]): Promise<void>;
  /** Retires the open items of an account, as when the owner removes it. */
  retire(account: string): void;
  /** The state, and a way to save it. */
  state(): MailConnectorState;
  save(state: MailConnectorState): void;
}

export interface MailConnectorState {
  /** Whether mail goes into the inbox at all. */
  enabled: boolean;
  /** The mailboxes whose mail goes into the inbox. The inbox of every account when empty. */
  folders?: string[];
  lastRunAt?: string;
  lastError?: string;
}

/** What keeps replies in one item: the subject without the prefixes a reply or a forward
 *  adds, and without the name of a mailing list. */
const prefixes = /^\s*((re|fw|fwd|aw|回复|答复|转发)\s*[:：]\s*|\[[^\]]{1,30}\]\s*)+/i;

/** The thread of a message.
 *
 *  Replies and forwards of one subject go together. A subject that says nothing once the
 *  prefixes are gone is grouped by who sent it as well, so a message with no subject from one
 *  person is not folded under another person's.
 *
 *  All space is taken out of the key. The key is only for keeping messages together and is
 *  never shown, and a space that came from a line fold or from the sender would otherwise
 *  keep two messages of one Chinese subject apart. Two English subjects that differ only by
 *  a space would be brought together, which is the rarer and the smaller mistake. */
export function mailThread(subject: string, from?: string): string {
  let key = subject.replace(prefixes, '').toLowerCase().replace(/\s+/g, '');
  if (!key) key = '\u0000from:' + (from ?? '').trim().toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/** The folders of an account whose mail goes into the inbox. */
function admitted(read: MailInboxRead, wanted: string[] | undefined): Set<string> {
  if (!wanted?.length) return new Set(['INBOX']);
  const names = new Set(read.mailboxes.map(box => box.name));
  return new Set(wanted.filter(name => names.has(name)));
}

/** One message as an inbox thing, or nothing when it is not to become one.
 *
 *  Only mail the owner has not read becomes an item, and it stays one item for the whole
 *  thread: a reply updates it and moves it back to the top. Mail that was read before the
 *  inbox first saw it is left alone, because the owner has already seen it. */
export function mailThing(read: MailInboxRead, message: MailSummary, folders: Set<string>): InboxThing | undefined {
  if (!folders.has(message.mailbox) || message.seen) return undefined;
  const sender = message.from.name || message.from.email;
  return {
    // One item for one account and one thread. Two accounts with the same subject are two.
    thread: read.account.id + ':' + mailThread(message.subject, message.from.email),
    // The newest message of the thread decides whether the item is new.
    last: message.mailbox + ':' + message.uid,
    title: (message.subject || '（无主题）') + ' · ' + sender,
    text: message.from.email + ' 发来一封邮件。' + (message.hasAttachments ? '带附件。' : ''),
    sender,
    receivedAt: message.date || undefined,
    origin: { kind: 'direct', connector: '邮箱', senderName: sender,
      mail: { account: read.account.id, mailbox: message.mailbox, uid: message.uid } },
  };
}

/** Reads the mailboxes once and puts what is new into the inbox. */
export async function runMailConnector(actions: MailConnectorActions): Promise<void> {
  const before = actions.state();
  if (!before.enabled) return;
  const fail = (error: unknown) => actions.save({ ...actions.state(), lastRunAt: new Date().toISOString(),
    lastError: error instanceof Error ? error.message : '读取邮箱失败。' });
  try {
    const reads = await actions.read();
    // The state may have been switched off or narrowed while the mail was being read. What
    // was read is still put in under the folders that are wanted now.
    const after = actions.state();
    if (!after.enabled) return;
    const things: InboxThing[] = [];
    for (const read of reads) {
      const folders = admitted(read, after.folders);
      // The newest message of a thread is the one that says the item is new, so the messages
      // are taken from the newest and only the first of each thread is kept.
      const newest = new Set<string>();
      for (const message of [...read.messages].sort((a, b) => b.uid - a.uid)) {
        const thread = read.account.id + ':' + mailThread(message.subject, message.from.email);
        // The newest message of a thread speaks for the thread, whether or not it becomes an
        // item. When the owner has read it, an older unread message of the same thread must
        // not surface as if the thread were new.
        if (newest.has(thread)) continue;
        newest.add(thread);
        const thing = mailThing(read, message, folders);
        if (thing) things.push(thing);
      }
    }
    if (things.length) await actions.ingest(things);
    actions.save({ ...actions.state(), lastRunAt: new Date().toISOString(), lastError: undefined });
  } catch (error) { fail(error); }
}

/** What the owner changes on the page. */
export function configureMailConnector(current: MailConnectorState, input: Record<string, unknown>): MailConnectorState {
  const extra = Object.keys(input).find(key => !['enabled', 'folders'].includes(key));
  if (extra) throw new Error('邮箱连接参数无效：' + extra);
  if (typeof input.enabled !== 'boolean') throw new Error('请说明是否把邮件放进收件箱');
  let folders: string[] | undefined;
  if (input.folders !== undefined) {
    if (!Array.isArray(input.folders) || input.folders.length > 30 || input.folders.some(name => typeof name !== 'string' || !name || name.length > 512 || /[\u0000-\u001f\u007f]/.test(name)))
      throw new Error('文件夹名称无效');
    folders = [...new Set(input.folders as string[])];
  }
  return { ...current, enabled: input.enabled, ...(folders ? { folders } : {}) };
}
