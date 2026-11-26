import type { MailAccount, Mailbox, MailSummary } from '../../protocol/src/mail.ts';
import type { MailAccounts } from './mail-accounts.ts';
import { classifyImapError, connectionOptions, ImapError, libraryOpen, readMailboxes, type ImapClient, type MailFailure, type OpenImap } from './mail-imap.ts';

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
      const account = accounts.get(accountId);
      // The password is read here and goes no further than this call's own variables.
      const password = await accounts.password(accountId);
      if (password === undefined) throw new ImapError('authentication', '这个账号还没有密码，请重新填写。');
      try {
        const result = await readMailboxes(account, signal, () => open(connectionOptions(account, password)));
        const state: MailboxState = { account, ...result, readAt: now().toISOString() };
        last.set(accountId, state);
        failures.delete(accountId);
        accounts.checked(accountId, { ok: true });
        return { ...state, account: accounts.get(accountId) };
      } catch (error) {
        const classified = error instanceof ImapError ? error : classifyImapError(error);
        // A cancelled read is not a failure of the account, so nothing is recorded for it.
        if (signal.aborted) throw error;
        // The account may have been removed while it was being read. Nothing is kept for it then.
        last.delete(accountId);
        if (!exists(accountId)) throw classified;
        failures.set(accountId, { failure: classified.failure, message: classified.message, at: now().toISOString() });
        accounts.checked(accountId, { ok: false, error: classified.message });
        throw classified;
      } finally {
        reads.delete(accountId);
      }
    })();
    reads.set(accountId, task);
    return task;
  }
  return {
    read,
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
