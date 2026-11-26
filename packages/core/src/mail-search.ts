import type { MailAddress, MailSummary } from '../../protocol/src/mail.ts';
import { hasAttachments, mailDate, searchable, type ImapClient } from './mail-imap.ts';

/** How many matches one page holds unless fewer are asked for, and the most it may hold. */
export const SEARCH_PAGE = 20;
export const SEARCH_MAX = 200;
/** Of a search done here because the server found nothing: how many envelopes are taken at
 *  a time, how many one page may look at, and how long one page may take. A server that does
 *  no search of its own can take seconds for one batch of old mail. */
export const LOCAL_BATCH = 100;
export const LOCAL_BUDGET = 2000;
export const LOCAL_TIME_MS = 6000;

/** One page of what a search found. */
export interface SearchPage {
  /** Newest first. */
  messages: MailSummary[];
  hasMore: boolean;
  /** Where a search of one account continues. A UID means something only in its own account,
   *  so a search of every account has none. */
  nextBeforeUid?: number;
  /** The server found nothing for the word, so the headers were matched here. The bodies of
   *  the messages were not looked into. */
  headersOnly: boolean;
}

/** What one search was asked for. */
export interface SearchRequest {
  /** Empty means every account's inbox. */
  account?: string;
  /** The folder to search. The inbox when empty. */
  mailbox?: string;
  query?: string;
  limit?: number;
  /** Continue from below this UID. */
  beforeUid?: number;
}

const SLASH = String.fromCharCode(92);

/** The summary of one message as a list shows it, without its body. */
export function summaryOf(account: string, mailbox: string, row: Record<string, unknown>): MailSummary | undefined {
  const envelope = row.envelope as Record<string, unknown> | undefined;
  if (!envelope) return undefined;
  const addresses = (value: unknown): MailAddress[] => Array.isArray(value) ? value.flatMap(item => {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const email = typeof entry.address === 'string' ? entry.address.slice(0, 320) : '';
    return email ? [{ name: typeof entry.name === 'string' ? entry.name.slice(0, 200) : '', email }] : [];
  }) : [];
  const flags = row.flags instanceof Set ? [...row.flags].map(String) : Array.isArray(row.flags) ? row.flags.map(String) : [];
  const has = (flag: string) => flags.some(item => item.toLowerCase() === (SLASH + flag).toLowerCase());
  const subject = (typeof envelope.subject === 'string' ? envelope.subject : '').split(/[\r\n\t]+/).join(' ').replace(/ +/g, ' ').trim().slice(0, 500);
  return {
    account, mailbox, uid: Number(row.uid),
    messageId: typeof envelope.messageId === 'string' ? envelope.messageId.slice(0, 998) : '',
    subject, from: addresses(envelope.from)[0] ?? addresses(envelope.sender)[0] ?? { name: '', email: '' },
    to: addresses(envelope.to), date: mailDate(row.internalDate ?? envelope.date) ?? '',
    hasAttachments: hasAttachments(row.bodyStructure), seen: has('Seen'), answered: has('Answered'), flagged: has('Flagged'),
  };
}

/** The summaries of the messages with these UIDs. They come back sorted by UID, lowest first. */
async function summaries(client: ImapClient, account: string, mailbox: string, uids: number[]): Promise<MailSummary[]> {
  const messages: MailSummary[] = [];
  if (!uids.length) return messages;
  for await (const row of client.fetch(uids.join(','), { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true })) {
    const summary = summaryOf(account, mailbox, row);
    if (summary) messages.push(summary);
  }
  return messages.sort((a, b) => a.uid - b.uid);
}

/** Whether every word of the query is in the subject, or in the name or the address of a
 *  sender or a recipient. Case does not matter. The body is not looked into. */
export function headerMatches(row: Record<string, unknown>, terms: string[]): boolean {
  if (!terms.length) return false;
  const envelope = row.envelope as Record<string, unknown> | undefined;
  if (!envelope) return false;
  const words: string[] = [String(envelope.subject ?? '')];
  for (const list of [envelope.from, envelope.sender, envelope.replyTo, envelope.to, envelope.cc]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      words.push(String(entry.name ?? ''), String(entry.address ?? ''));
    }
  }
  const haystack = words.join('\n').toLowerCase();
  return terms.every(term => haystack.includes(term));
}

/** The UIDs of the folder, lowest first, leaving out those at or above `below`.
 *
 *  A search for everything is the short way. A server that refuses every search, even that
 *  one, is asked for the UIDs of all its messages instead, which needs no search at all. */
async function everyUid(client: ImapClient, mailbox: string, below?: number): Promise<number[]> {
  let uids: number[] = [];
  try {
    const found = await searchable(client).search({}, { uid: true });
    if (Array.isArray(found)) uids = found;
  } catch {
    // The server would not search. Everything is taken by count instead.
    const box = await client.mailboxOpen(mailbox, { readOnly: true });
    for await (const row of client.fetch(`1:${Math.max(1, box.totalCount ?? 0)}`, { uid: true })) uids.push(Number(row.uid));
  }
  return [...new Set(uids)].filter(uid => Number.isSafeInteger(uid) && uid > 0).sort((a, b) => a - b).filter(uid => !below || uid < below);
}

/** The newest messages of the folder, for a search with no word. */
async function newest(client: ImapClient, account: string, mailbox: string, limit: number, below?: number): Promise<SearchPage> {
  const box = await client.mailboxOpen(mailbox, { readOnly: true });
  const total = box.totalCount ?? 0;
  const all = await everyUid(client, mailbox, below);
  // A page is the newest of them, and the server's count says whether there are older ones.
  const page = all.slice(-limit);
  const messages = await summaries(client, account, mailbox, page);
  const hasMore = all.length > limit;
  return { messages: messages.reverse(), hasMore, headersOnly: false, ...(hasMore && page.length ? { nextBeforeUid: page[0] } : {}) };
}

/** Searches one account's folder.
 *
 *  The server is asked first. Some servers find nothing for any word at all, and some refuse
 *  a search. When that happens the headers of the newest messages are matched here, a bounded
 *  number at a time, and the answer says that is what was done.
 */
export async function searchFolder(client: ImapClient, account: { id: string; email: string }, request: SearchRequest, signal: AbortSignal): Promise<SearchPage> {
  const mailbox = request.mailbox || 'INBOX';
  const limit = Math.max(1, Math.min(SEARCH_MAX, request.limit ?? SEARCH_PAGE));
  const query = (request.query ?? '').trim();
  const below = request.beforeUid && request.beforeUid > 1 ? request.beforeUid : undefined;
  const started = Date.now();
  await client.mailboxOpen(mailbox, { readOnly: true });
  signal.throwIfAborted();
  if (!query) return newest(client, account.id, mailbox, limit, below);

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Gmail takes its own search syntax, which says more than a word does. Every other server
  // is asked for the word in the headers and the body.
  const gmail = /@(gmail|googlemail)\.com$/i.test(account.email);
  let found: number[] = [];
  let byServer = false;
  try {
    const answer = await searchable(client).search(gmail ? { gmraw: query } : { text: query }, { uid: true });
    if (Array.isArray(answer)) { found = answer.filter(uid => !below || uid < below); byServer = found.length > 0; }
  } catch {
    // The server would not search. The headers are matched below.
    byServer = false;
  }
  signal.throwIfAborted();
  if (byServer) {
    const page = found.sort((a, b) => a - b).slice(-limit);
    const messages = await summaries(client, account.id, mailbox, page);
    const hasMore = found.length > limit;
    return { messages: messages.reverse(), hasMore, headersOnly: false, ...(hasMore && page.length ? { nextBeforeUid: page[0] } : {}) };
  }

  // The server found nothing, or would not search. Look through the headers from the newest
  // message down, a batch at a time, and stop at the page's budget.
  const all = await everyUid(client, mailbox, below);
  const matched: number[] = [];
  let looked = 0;
  let end = all.length;
  while (end > 0 && matched.length <= limit) {
    const count = Math.min(LOCAL_BATCH, LOCAL_BUDGET - looked, end);
    if (count <= 0) break;
    for await (const row of client.fetch(all.slice(end - count, end).join(','), { uid: true, envelope: true })) {
      if (headerMatches(row, terms)) matched.push(Number(row.uid));
    }
    looked += count;
    end -= count;
    if (looked >= LOCAL_BUDGET || Date.now() - started > LOCAL_TIME_MS) break;
  }
  signal.throwIfAborted();
  matched.sort((a, b) => a - b);
  // One match more than the page holds says there are more, without another round trip.
  const page = matched.slice(0, limit);
  const olderLeft = end > 0 || matched.length > limit;
  const messages = await summaries(client, account.id, mailbox, page);
  // The next page continues above the oldest match, or above the oldest message looked at
  // when the budget ran out before enough were found.
  const nextBeforeUid = page.length ? page[0] : end > 0 ? all[end] : undefined;
  return { messages: messages.reverse(), hasMore: olderLeft, headersOnly: true, ...(olderLeft && nextBeforeUid ? { nextBeforeUid } : {}) };
}
