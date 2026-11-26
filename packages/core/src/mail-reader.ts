import type { MailAccount, Mailbox, MailSummary } from '../../protocol/src/mail.ts';
import type { MailAccounts } from './mail-accounts.ts';
import { classifyImapError, connectionOptions, ImapError, libraryOpen, newestMessages, readMailboxes, roleOf, type ImapClient, type MailFailure, type OpenImap } from './mail-imap.ts';

export type { MailFailure };

/** What one account's last read found. */
export interface MailboxState {
  account: MailAccount;
  mailboxes: Mailbox[];
  messages: MailSummary[];
  readAt: string;
}

/**
 * Reads the mail of the accounts the owner added.
 *
 * A password is taken out of the sealed store for the moment of the connection and is passed
 * on the stack to the library. It is not kept on this object, in the state, or in a result.
 */
export function createMailReader({ accounts, open = libraryOpen(), now = () => new Date() }: {
  accounts: MailAccounts; open?: OpenImap; now?: () => Date;
}) {
  const reads = new Map<string, Promise<MailboxState>>();
  const last = new Map<string, MailboxState>();
  const failures = new Map<string, { failure: MailFailure; message: string; at: string }>();
  /** Whether the account is still on record. It can be removed while a read of it is running. */
  const exists = (accountId: string) => {
    try { accounts.get(accountId); return true; } catch { return false; }
  };
  /** The part of a read that is shown for an account, without the account itself. */
  const found = ({ mailboxes, messages, readAt }: MailboxState) => ({ mailboxes, messages, readAt });
  /** The account and its password for one connection. The password is used by the caller for
   *  the connection and is not kept here. */
  async function credentials(accountId: string) {
    const account = accounts.get(accountId);
    const password = await accounts.password(accountId);
    if (password === undefined) throw new ImapError('authentication', '这个账号还没有密码，请重新填写。');
    return { account, password };
  }
  /** A failure as one of the kinds the owner can act on. */
  const classify = (error: unknown) => error instanceof ImapError ? error : classifyImapError(error);
  /** Reads one account.
   *
   *  Two asks for the same account while one is running share that read and its result, so the
   *  account is signed in to once. The read belongs to the first ask: if that one is cancelled,
   *  the other is cancelled with it and can simply ask again.
   *
   *  A password that cannot be read is not a failure of the account and is passed on as it is,
   *  so the caller can tell it from a mail server's refusal. */
  function read(accountId: string, signal: AbortSignal): Promise<MailboxState> {
    const running = reads.get(accountId);
    if (running) return running;
    const task = (async () => {
      // The password is read here and goes no further than this call's own variables.
      const { account, password } = await credentials(accountId);
      try {
        const result = await readMailboxes(account, signal, () => open(connectionOptions(account, password)));
        const state: MailboxState = { account, ...result, readAt: now().toISOString() };
        last.set(accountId, state);
        failures.delete(accountId);
        accounts.checked(accountId, { ok: true });
        return { ...state, account: accounts.get(accountId) };
      } catch (error) {
        const failure = classify(error);
        // A cancelled read is not a failure of the account, so nothing is recorded for it.
        if (signal.aborted) throw error;
        // The account may have been removed while it was being read. Nothing is kept for it then.
        last.delete(accountId);
        if (!exists(accountId)) throw failure;
        failures.set(accountId, { failure: failure.failure, message: failure.message, at: now().toISOString() });
        accounts.checked(accountId, { ok: false, error: failure.message });
        throw failure;
      } finally {
        reads.delete(accountId);
      }
    })();
    reads.set(accountId, task);
    return task;
  }
  return {
    read,
    /** The newest messages of one folder of one account, for the inbox.
     *
     *  This does not say whether the account is connected. That is what a check of the
     *  connection is for, and a read in the background must not change what the page shows
     *  about it. A failure is passed on as the owner could act on it. */
    async readFolders(accountId: string, wanted: string[], signal: AbortSignal): Promise<{ account: MailAccount; mailboxes: Mailbox[]; messages: MailSummary[] }> {
      const { account, password } = await credentials(accountId);
      let client: ImapClient | undefined;
      try {
        client = await open(connectionOptions(account, password));
        signal.throwIfAborted();
        const mailboxes: Mailbox[] = [];
        const messages: MailSummary[] = [];
        // Every folder is listed, so the owner sees the ones they made as well as the usual
        // ones. The wanted ones are opened read-only, so that nothing here can change a
        // message. A folder that is not wanted is listed without its counters.
        for (const box of await client.list()) {
          const role = roleOf(box.path, box.flags, box.specialUse);
          if (!wanted.includes(box.path)) { mailboxes.push({ name: box.path, role, unseen: 0, total: 0 }); continue; }
          const opened = await client.mailboxOpen(box.path, { readOnly: true });
          const name = opened.path ?? box.path;
          mailboxes.push({ name, role, unseen: opened.unseenCount ?? 0, total: opened.totalCount ?? 0 });
          messages.push(...await newestMessages(client, account.id, name, opened.totalCount ?? 0));
        }
        return { account, mailboxes, messages };
      } catch (error) {
        if (signal.aborted) throw error;
        throw classify(error);
      } finally { await client?.logout().catch(() => {}); }
    },
    /** The last read of every account, and what went wrong for the ones that did not read. */
    state() {
      return accounts.list().map(account => ({
        account,
        ...(last.has(account.id) ? found(last.get(account.id)!) : {}),
        ...(failures.has(account.id) ? { failure: failures.get(account.id) } : {}),
      }));
    },
    forget(accountId: string) { reads.delete(accountId); last.delete(accountId); failures.delete(accountId); },
  };
}
export type MailReader = ReturnType<typeof createMailReader>;
