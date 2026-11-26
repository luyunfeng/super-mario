// Puts the mail of the owner's mailboxes into the inbox, the way the GitHub connector puts
// notifications there. Reading the mail is the workbench's; this decides what becomes an
// item and what keeps replies together.
import { createHash } from 'node:crypto';
import type { Extension, ExtensionContext } from '../packages/plugin-sdk/src/index.ts';
import { MAIL_POLL_SERVICE, type InboxThing, type MailConnectorState, type MailInboxRead, type MailSummary } from '../packages/protocol/src/index.ts';

/** What the connector may do. The workbench gives it these. */
export interface MailConnectorActions {
  /** Reads the mailboxes the owner added that are to go into the inbox. A mailbox that could
   *  not be read is left out and named, so its mail is not taken for gone. */
  /** Reads the mailboxes. The signal is triggered when the connector stops, so that a read
   *  that is under way ends and does not keep the process alive. */
  read(signal: AbortSignal): Promise<{ reads: MailInboxRead[]; failed: Array<{ id: string; name: string }> }>;
  /** Puts things into the inbox. It updates an item whose thread is the same. */
  ingest(things: InboxThing[]): Promise<void>;
  /** Retires the open items of an account, as when the owner removes it. */
  retire(account: string): void;
  /** The state, and a way to save it. */
  state(): MailConnectorState;
  save(state: MailConnectorState): void;
}

/** How often mail is read. Each read signs in to every mailbox, so it is not done often. */
export const MAIL_POLL_MS = 3 * 60_000;

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
export async function runMailConnector(actions: MailConnectorActions, signal: AbortSignal = new AbortController().signal): Promise<void> {
  const before = actions.state();
  if (!before.enabled) return;
  const fail = (error: unknown) => actions.save({ ...actions.state(), lastRunAt: new Date().toISOString(),
    lastError: error instanceof Error ? error.message : '读取邮箱失败。' });
  try {
    const { reads, failed } = await actions.read(signal);
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
    // The folders are kept so that the page can offer them to be chosen. They are the ones
    // of a usual kind, because those are the ones mail is kept in by role.
    const mailboxes = reads.flatMap(read => read.mailboxes.filter(box => box.role !== 'other').map(box => ({ account: read.account.name, name: box.name })));
    actions.save({ ...actions.state(), lastRunAt: new Date().toISOString(), lastError: undefined, failed, mailboxes });
  } catch (error) {
    // A read that was stopped is not a failure of a mailbox, and says nothing about the mail.
    if (signal.aborted) return;
    fail(error);
  }
}

/** The connector as a plugin. It reads on a timer and once when it starts, and offers one
 *  service that reads now. The plugin host keeps the extension to itself, so a read asked
 *  for from the page goes through that service and not through the extension. */
export function createMailConnector(actions: MailConnectorActions, options: { pollMs?: number } = {}): Extension {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let lifetime = new AbortController();
  function poll(): Promise<void> {
    // One read at a time. A slow mailbox must not have reads stack up on it.
    if (running) return running;
    running = (async () => {
      try { if (!stopped) await runMailConnector(actions, lifetime.signal); }
      finally { running = undefined; }
    })();
    return running;
  }
  return Object.assign({
    // A plugin may offer a service only when it says so here, by name.
    id: 'mail-connector', name: '邮箱', capabilities: ['inbox.source'], permissions: ['service.provide:' + MAIL_POLL_SERVICE],
    activate(context: ExtensionContext) {
      stopped = false;
      timer = setInterval(() => { if (!stopped) void poll(); }, options.pollMs ?? MAIL_POLL_MS);
      void poll();
      // Reading mail changes nothing that is the owner's, so the service is read-only.
      context.contribute('services', MAIL_POLL_SERVICE, { name: MAIL_POLL_SERVICE, version: 1, readOnly: true, handler: async () => { await poll(); return { read: true }; } });
      // Stopping ends a read that is under way and waits for it, so no connection is left
      // open and nothing keeps the process alive after the plugin is stopped.
      context.defer(() => {
        stopped = true;
        clearInterval(timer);
        lifetime.abort();
        // A read that was under way is waited for. It ends by the signal above, and that end
        // is the stop itself and not a failure of the plugin, so it is not passed on.
        return running?.catch(() => {});
      });
    },
  });
}
