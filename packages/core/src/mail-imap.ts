import type { MailAccount, Mailbox, MailSummary } from '../../protocol/src/mail.ts';
import type { ImapFlowOptions } from 'imapflow';

/** How a connection is opened. Kept separate from the library so the read can be tested
 *  without a server, and so the options are built in one place. */
export type OpenImap = (options: ImapFlowOptions) => Promise<ImapClient>;
/** The connection the mail library makes, with everything a stand-in may leave out. */
export type OpenFullImap = (options: ImapFlowOptions) => Promise<FullImapClient>;

/** Opens a connection with the mail library. The password is used here and not kept. */
export function libraryOpen(): OpenFullImap {
  return async options => {
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({ ...options, logger: false });
    // The library logs every command and response by default, which would put addresses and
    // server greetings in the workbench's output. That is turned off above.
    await client.connect();
    // The library's client has every method above. The cast is here because its own types
    // are written with more options than this uses.
    return client as unknown as FullImapClient;
  };
}

/** The options for one account's connection. The password is passed in and not stored. */
export function connectionOptions(account: MailAccount, password: string): ImapFlowOptions {
  return {
    ...transport(account),
    auth: { user: account.username, pass: password },
    // The workbench reads when the owner asks, so it does not hold an idle connection open.
    disableAutoIdle: true,
  };
}

/** Why a sign-in or a read did not work, in terms the owner can act on. */
export type MailFailure = 'authentication' | 'connection' | 'tls' | 'not-found' | 'refused' | 'timeout' | 'too-many' | 'unknown';

export class ImapError extends Error {
  readonly failure: MailFailure;
  constructor(failure: MailFailure, message: string) { super(message); this.name = 'ImapError'; this.failure = failure; }
}

// The codes Node gives for a socket, DNS or TLS failure. The mail library passes these through.
const missingHost = ['enotfound', 'eai_again'];
const refused = ['econnrefused'];
const timedOut = ['etimedout', 'connect_timeout', 'greeting_timeout', 'etimeout'];
const dropped = ['econnreset', 'epipe', 'econnectionclosed', 'noconnection'];
const tlsCodes = ['closedafterconnecttls', 'upgrade_timeout', 'starttls_injection'];
const busyCodes = ['ethrottle'];
const missingFolderCodes = ['notfound'];

// Words of a tagged response the server sends, matched on the lower-cased text. They are
// looked at only when the error carries no code, which is the case for some servers.
const authenticationWords = ['authenticationfailed', 'invalid credentials', 'login failed', 'password'];
const tlsWords = ['certificate', 'self signed', 'self-signed', 'tls', 'ssl', 'handshake', 'err_tls', 'err_ssl'];
const timeoutWords = ['timeout', 'timed out', 'socket hang up'];
const missingFolderWords = ['nonexistent', 'trycreate', 'mailbox does not exist'];
const busyWords = ['too many', 'overquota', 'unavailable', 'busy', 'throttl'];

/**
 * Puts a failure of the mail library into one of the kinds the owner can act on.
 *
 * The library sets plain fields on its errors for this: authenticationFailed, tlsFailed, the
 * server's response code, and a code of its own or of Node's. Those are read first. Its
 * message is looked at last, and only for the words above. The message itself is never
 * shown: it can hold the server's greeting, an address or a username, and it is written for
 * a developer.
 */
export function classifyImapError(error: unknown): ImapError {
  const row = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const code = typeof row.code === 'string' ? row.code.toLowerCase() : '';
  const serverCode = typeof row.serverResponseCode === 'string' ? row.serverResponseCode.toLowerCase() : '';
  const responseText = typeof row.responseText === 'string' ? row.responseText.toLowerCase() : '';
  // A code is read from the fields the library sets. Some errors that come straight from Node
  // carry theirs only in the message, as a word of its own, so that is looked at too.
  const inText = (name: string) => new RegExp('(^|[^a-z0-9_])' + name + '([^a-z0-9_]|$)').test(text);
  const is = (codes: string[]) => codes.includes(code) || codes.includes(serverCode) || codes.some(inText);
  const says = (words: string[]) => words.some(word => text.includes(word) || responseText.includes(word));
  // A refused sign-in is the most common failure and the one the owner acts on, so it is first.
  if (row.authenticationFailed === true || is(['eauth', 'authenticationfailed']) || says(authenticationWords))
    return new ImapError('authentication', '邮箱拒绝了用户名或密码，请核对登录名和授权码。');
  if (row.tlsFailed === true || is(tlsCodes) || says(tlsWords)) return new ImapError('tls', '无法建立加密连接，请核对服务器地址、端口和加密方式。');
  if (is(missingHost)) return new ImapError('connection', '找不到收件服务器，请核对服务器地址和网络。');
  if (is(refused)) return new ImapError('refused', '收件服务器拒绝了连接，请核对端口。');
  if (is(timedOut) || says(timeoutWords)) return new ImapError('timeout', '连接收件服务器超时，请稍后再试。');
  if (is(missingFolderCodes) || says(missingFolderWords)) return new ImapError('not-found', '找不到这个文件夹。');
  if (is(busyCodes) || says(busyWords)) return new ImapError('too-many', '邮箱服务器暂时忙碌，请稍后再试。');
  if (is(dropped)) return new ImapError('connection', '连接收件服务器失败，请检查网络。');
  return new ImapError('unknown', '读取邮箱失败。');
}

/** The security setting of an account as the mail library takes it. */
export function transport(account: Pick<MailAccount, 'imapHost' | 'imapPort' | 'imapSecurity'>) {
  const base = { host: account.imapHost, port: account.imapPort };
  if (account.imapSecurity === 'tls') return { ...base, secure: true, doSTARTTLS: false };
  // STARTTLS must succeed. A server that does not offer it is a failure, not a reason to go on
  // in cleartext with the password.
  if (account.imapSecurity === 'starttls') return { ...base, secure: false, doSTARTTLS: true };
  return { ...base, secure: false, doSTARTTLS: false };
}

const SLASH = String.fromCharCode(92);

/** An address as the library gives it, with any encoded words already read. */
function address(value: unknown): { name: string; email: string } {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { name: typeof row.name === 'string' ? row.name.slice(0, 200) : '', email: typeof row.address === 'string' ? row.address.slice(0, 320) : '' };
}
const addresses = (value: unknown) => Array.isArray(value) ? value.map(address).filter(item => item.email) : [];
/** The date as an ISO instant, or undefined when the header is unreadable. It is never guessed. */
export function mailDate(value: unknown): string | undefined {
  if (typeof value !== 'string' && !(value instanceof Date)) return undefined;
  const time = new Date(value as string).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
/** The flags the owner thinks in. */
function flagsOf(value: unknown) {
  const flags = value instanceof Set ? [...value].map(String) : Array.isArray(value) ? value.map(String) : [];
  const has = (flag: string) => flags.some(item => item.toLowerCase() === (SLASH + flag).toLowerCase());
  return { seen: has('Seen'), answered: has('Answered'), flagged: has('Flagged') };
}
/** The subject of an envelope, as one line. A folded subject arrives with line breaks in it. */
export function subjectOf(value: unknown): string {
  return (typeof value === 'string' ? value : '').split(/[\r\n\t]+/).join(' ').replace(/ +/g, ' ').trim().slice(0, 500);
}

/** A folder's flag without the leading backslash, in lower case: "\\Sent" becomes "sent". */
function flagName(flag: string): string | undefined {
  return flag.startsWith(SLASH) ? flag.slice(1).toLowerCase() : undefined;
}
const roles: readonly Mailbox['role'][] = ['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive'];
const byName: Record<string, Mailbox['role']> = {
  inbox: 'inbox', sent: 'sent', 'sent items': 'sent', 'sent messages': 'sent', drafts: 'drafts',
  trash: 'trash', 'deleted messages': 'trash', junk: 'junk', spam: 'junk', 'junk email': 'junk', 'junk e-mail': 'junk',
  archive: 'archive', 'all mail': 'archive',
};

/** Which of the usual roles a folder has: by the flag the server gives, then by its name.
 *  A folder that is none of them is "other", and is never read as the inbox. */
export function roleOf(path: string, flags: Set<string> = new Set(), specialUse?: string): Mailbox['role'] {
  const special = specialUse ? flagName(specialUse) ?? specialUse.toLowerCase() : undefined;
  if (special && roles.includes(special as Mailbox['role'])) return special as Mailbox['role'];
  for (const flag of flags) {
    const name = flagName(flag);
    if (name && roles.includes(name as Mailbox['role'])) return name as Mailbox['role'];
  }
  return byName[path.split(/[./]/).pop()!.toLowerCase()] ?? 'other';
}

/** Whether the message carries an attachment, from its structure. A part marked as an
 *  attachment counts, and so does a part marked inline that carries a file name, because
 *  many clients mark attachments that way. A text part, or an inlined image in a signature,
 *  does not. */
export function hasAttachments(structure: unknown): boolean {
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(walk);
    const row = node as Record<string, unknown>;
    const disposition = typeof row.disposition === 'string' ? row.disposition.toLowerCase() : '';
    const parameters = row.dispositionParameters as Record<string, unknown> | undefined;
    const named = !!parameters && typeof parameters.filename === 'string';
    if (disposition === 'attachment') return true;
    if (disposition === 'inline' && named) return true;
    if (row.childNodes) return walk(row.childNodes);
    return false;
  };
  return walk(structure);
}

/** How much of one message a read takes. A message above it is reported as too large rather
 *  than cut short, because half a message reads as a whole one. Attachments are fetched on
 *  their own, so a large message can still be read part by part. */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/** The part of the mail library this uses. A stand-in can be given in its place. */
export interface ImapClient {
  list(): Promise<Array<{ path: string; name: string; flags: Set<string>; specialUse?: string }>>;
  /** Opens a folder. Read-only, because nothing here changes a message: the workbench does
   *  not mark mail as read, and a read-only open keeps the server from letting it. */
  mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<{ path?: string; totalCount?: number; unseenCount?: number }>;
  fetch(range: string, query: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
  /** Searches the open folder. Answers the UIDs of the messages that match, in no order.
   *  A stand-in that is not asked to search need not have it. */
  search?(query: Record<string, unknown>, options: { uid: boolean }): Promise<number[] | false | undefined>;
  /** Streams one part of one message, decoded. Resolves without content when there is none. */
  download?(uid: number, part: string, options: { uid: boolean; maxBytes: number }): Promise<{ content?: AsyncIterable<Uint8Array>; meta?: Record<string, unknown> }>;
  /** Puts a message into a folder, as a mail program keeps a copy of what it sent. */
  append?(path: string, content: Uint8Array, options: { flags: string[]; date: Date }): Promise<unknown>;
  /** Adds or takes off flags of messages, leaving every other flag as it is. */
  messageFlagsAdd?(range: string, flags: string[], options: { uid: boolean }): Promise<boolean>;
  messageFlagsRemove?(range: string, flags: string[], options: { uid: boolean }): Promise<boolean>;
  logout(): Promise<void>;
}

/** A connection made with the mail library, which can do everything above. A stand-in need
 *  only do what the test asks of it. */
export interface FullImapClient extends ImapClient {
  search(query: Record<string, unknown>, options: { uid: boolean }): Promise<number[] | false | undefined>;
  download(uid: number, part: string, options: { uid: boolean; maxBytes: number }): Promise<{ content?: AsyncIterable<Uint8Array>; meta?: Record<string, unknown> }>;
  append(path: string, content: Uint8Array, options: { flags: string[]; date: Date }): Promise<unknown>;
  messageFlagsAdd(range: string, flags: string[], options: { uid: boolean }): Promise<boolean>;
  messageFlagsRemove(range: string, flags: string[], options: { uid: boolean }): Promise<boolean>;
}

/** The flags of one message that the owner can change. Nothing else is touched, so a flag
 *  a mail program set for its own use stays. */
export type MessageFlagChange = { seen?: boolean; flagged?: boolean };
export const MESSAGE_FLAGS: Record<keyof MessageFlagChange, string> = { seen: '\\Seen', flagged: '\\Flagged' };

/** Sets the flags of one message that the owner asked to change.
 *
 *  Each flag is added or taken off on its own. The flags of a message are never replaced as a
 *  whole, because a mail program keeps its own marks among them. The folder is opened for
 *  writing here: everywhere else a folder is opened read-only, so that reading a message can
 *  never change it. The connection is the caller's to close. */
export async function setMessageFlags(client: ImapClient, where: { mailbox: string; uid: number }, change: MessageFlagChange, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await client.mailboxOpen(where.mailbox);
  signal.throwIfAborted();
  for (const name of Object.keys(MESSAGE_FLAGS) as Array<keyof MessageFlagChange>) {
    const wanted = change[name];
    if (wanted === undefined) continue;
    const set = (client as FullImapClient)[wanted ? 'messageFlagsAdd' : 'messageFlagsRemove'];
    if (!set) throw new ImapError('unknown', '这个连接不能改动邮件的标记。');
    // False means no message was changed: the message is gone from the folder.
    const changed = await set.call(client, String(where.uid), [MESSAGE_FLAGS[name]], { uid: true });
    if (!changed) throw new ImapError('not-found', '这封邮件不在了，可能已被移动或删除。');
  }
}

/** The part of a connection that a search needs. A real connection always has it. */
export function searchable(client: ImapClient): Required<Pick<ImapClient, 'search'>> {
  if (!client.search) throw new Error('这个连接不能搜索。');
  return { search: client.search.bind(client) };
}
/** The part of a connection that keeps a copy needs. */
export function appends(client: ImapClient): Required<Pick<ImapClient, 'append'>> {
  if (!client.append) throw new Error('这个连接不能保存邮件。');
  return { append: client.append.bind(client) };
}

/** The most messages one read takes, from the end of the inbox. */
export const MESSAGES_PER_READ = 50;
/** The most folders one read opens. */
export const FOLDERS_PER_READ = 12;

/** Reads the folders of one account and the newest messages of its inbox. */
export async function readMailboxes(account: MailAccount, signal: AbortSignal, open: () => Promise<ImapClient>) {
  // Connecting and signing in are inside the try too, so a refused sign-in is classified
  // like any other failure instead of surfacing as the library's own error.
  let client: ImapClient | undefined;
  try {
    client = await open();
    signal.throwIfAborted();
    const listed = await client.list();
    const inbox = listed.find(box => box.path.toUpperCase() === 'INBOX');
    if (!inbox) throw new ImapError('not-found', '这个邮箱没有收件箱。');
    const mailboxes: Mailbox[] = [];
    const messages: MailSummary[] = [];
    // Every folder is listed, so the owner sees the ones they made as well as the usual ones.
    // The usual ones are opened to read their counters, at most twelve of them. The others are
    // listed without counters: opening every folder would be slow for little gain.
    const usual = listed.filter(box => roleOf(box.path, box.flags, box.specialUse) !== 'other');
    const openedFolders = usual.slice(0, FOLDERS_PER_READ);
    // The usual folders come first, then every other folder in the order the server gave.
    const order = [...openedFolders, ...listed.filter(box => !openedFolders.includes(box))];
    for (const box of order) {
      signal.throwIfAborted();
      const role = roleOf(box.path, box.flags, box.specialUse);
      if (!openedFolders.includes(box)) { mailboxes.push({ name: box.path, role, unseen: 0, total: 0 }); continue; }
      let opened: Awaited<ReturnType<ImapClient['mailboxOpen']>>;
      try { opened = await client.mailboxOpen(box.path, { readOnly: true }); }
      catch (error) {
        // A folder that cannot be opened is not an account failure. It is listed without
        // counters, so the owner still sees it.
        if (signal.aborted) throw error;
        mailboxes.push({ name: box.path, role, unseen: 0, total: 0 });
        continue;
      }
      mailboxes.push({ name: opened.path ?? box.path, role, unseen: opened.unseenCount ?? 0, total: opened.totalCount ?? 0 });
      // Only the inbox's messages are read here. Reading every folder would be slow for no
      // gain. A folder the owner names for the inbox is read on its own.
      if (role === 'inbox') messages.push(...await newestMessages(client, account.id, opened.path ?? box.path, opened.totalCount ?? 0));
    }
    return { mailboxes, messages };
  } catch (error) {
    // The library's error is replaced by one of the kinds the owner can act on. Its text is
    // not passed on. A cancellation is left as it is, so the caller can tell it apart.
    if (signal.aborted) throw error;
    throw error instanceof ImapError ? error : classifyImapError(error);
  } finally {
    // The connection is closed whether the read worked or not, so a failure leaves none open.
    await client?.logout().catch(() => {});
  }
}

/** The newest messages of one folder that is already open, at most one read takes. */
export async function newestMessages(client: ImapClient, account: string, mailbox: string, total: number): Promise<MailSummary[]> {
  const messages: MailSummary[] = [];
  if (total <= 0) return messages;
  const newest = Math.max(1, total - (MESSAGES_PER_READ - 1));
  for await (const message of client.fetch(newest + ':*', { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true })) {
    const envelope = message.envelope as Record<string, unknown> | undefined;
    if (!envelope) continue;
    const first = (value: unknown) => Array.isArray(value) ? value[0] : undefined;
    messages.push({
      account, mailbox, uid: Number(message.uid),
      messageId: typeof envelope.messageId === 'string' ? envelope.messageId.slice(0, 998) : '',
      subject: subjectOf(envelope.subject),
      from: address(first(envelope.from) ?? first(envelope.sender)),
      to: addresses(envelope.to), date: mailDate(message.internalDate ?? envelope.date) ?? '',
      hasAttachments: hasAttachments(message.bodyStructure),
      ...flagsOf(message.flags),
    });
  }
  return messages;
}
