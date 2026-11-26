// A stand-in mail server for the tests. It holds folders and messages in memory and answers
// the part of the mail library the workbench uses. Nothing here talks to a network.
import type { ImapClient } from '../packages/core/src/mail-imap.ts';

export type FakeMessage = {
  uid: number;
  /** The fields a list shows, already as the library gives them. */
  envelope?: Record<string, unknown>;
  flags?: Set<string>;
  internalDate?: string | Date;
  bodyStructure?: unknown;
  /** The whole message as it went over the wire. Given when a test reads one in full. */
  raw?: Uint8Array;
  /** The decoded content of one part, keyed by part number. Given when a test downloads. */
  parts?: Record<string, Uint8Array>;
  /** The size the server reports for the message, when it differs from the raw bytes. */
  size?: number;
};

export type FakeFolder = { path: string; messages: FakeMessage[]; specialUse?: string; flags?: string[] };

export type FakeServerOptions = {
  folders: FakeFolder[];
  /** What list() answers, in place of the folders. */
  listAnswer?: Array<{ path: string; name: string; flags: Set<string>; specialUse?: string }>;
  fail?: { connect?: Error; list?: Error; open?: Error; fetch?: Error; download?: Error };
  /** How the server answers a search for a word. "none" is a server that finds nothing
   *  for any word, "refused" one that will not search, and "finds" one that searches. */
  search?: 'finds' | 'none' | 'refused';
};

export type FakeServer = {
  client: ImapClient;
  /** Every folder that was opened, with whether it was opened read-only. */
  opened: Array<{ path: string; readOnly: boolean }>;
  /** Every fetch, as the range and the query it was asked for. */
  fetched: Array<{ range: string; query: Record<string, unknown> }>;
  /** Every search the server was asked for. */
  searches: Array<{ query: Record<string, unknown>; uid: boolean }>;
  /** Every attachment download. */
  downloaded: Array<{ uid: number; part: string; maxBytes: number }>;
  /** Every message put into a folder, as the copy of one that was sent. */
  appended: Array<{ path: string; content: Uint8Array; flags: string[]; date: Date }>;
  logouts: () => number;
};

/** One header of a message as text, with a folded line joined and an encoded word read.
 *  Only what a list shows is read here. The message itself is parsed in full elsewhere. */
function headerOf(raw: Uint8Array, name: string): string {
  const text = new TextDecoder().decode(raw);
  const head = text.split(/\r\n\r\n/)[0] ?? text;
  const lines = head.split(/\r\n/);
  const value: string[] = [];
  for (const line of lines) {
    if (value.length) {
      // A header that is too long for one line continues on the next, which starts with space.
      if (/^[ \t]/.test(line)) { value.push(line.trim()); continue; }
      break;
    }
    if (new RegExp('^' + name + ':', 'i').test(line)) value.push(line.replace(new RegExp('^' + name + ':\\s*', 'i'), ''));
  }
  if (!value.length) return '';
  return value.join(' ').replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, code: string) => Buffer.from(code, 'base64').toString('utf8')).trim();
}

/** The envelope of a message given only as raw, as a real server reads it from the headers.
 *  A message that has one of its own keeps it. */
function envelopeOf(message: FakeMessage): Record<string, unknown> | undefined {
  if (message.envelope) return message.envelope;
  if (!message.raw) return undefined;
  const address = (value: string) => {
    const match = /^(.*?)<?([^<>\s]+@[^<>\s]+)>?$/.exec(value.trim());
    return match ? { name: match[1]!.replace(/^"|"$/g, '').trim(), address: match[2]! } : { name: '', address: value.trim() };
  };
  const list = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean).map(address);
  return {
    subject: headerOf(message.raw, 'Subject'),
    messageId: headerOf(message.raw, 'Message-ID').replace(/^<|>$/g, ''),
    from: list(headerOf(message.raw, 'From')), to: list(headerOf(message.raw, 'To')), date: headerOf(message.raw, 'Date'),
  };
}

export function fakeMailServer(options: FakeServerOptions): FakeServer {
  const opened: FakeServer['opened'] = [];
  const fetched: FakeServer['fetched'] = [];
  const searches: FakeServer['searches'] = [];
  // Envelopes are read before any answer is given, so that answering stays synchronous.
  for (const folder of options.folders) for (const message of folder.messages) message.envelope = envelopeOf(message);
  const downloaded: FakeServer['downloaded'] = [];
  const appended: FakeServer['appended'] = [];
  let logouts = 0;
  // The folder that is selected now. fetch() and download() read from it, as on a real server.
  let selected: FakeFolder | undefined;
  const client: ImapClient = {
    async list() {
      if (options.fail?.list) throw options.fail.list;
      if (options.listAnswer) return options.listAnswer;
      return options.folders.map(folder => ({
        path: folder.path, name: folder.path.split('/').pop()!, flags: new Set(folder.flags ?? []),
        ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
      }));
    },
    async mailboxOpen(path, openOptions = {}) {
      opened.push({ path, readOnly: openOptions.readOnly === true });
      if (options.fail?.open) throw options.fail.open;
      const folder = options.folders.find(item => item.path === path);
      if (!folder) throw new Error('Nonexistent');
      selected = folder;
      return { path, totalCount: folder.messages.length, unseenCount: folder.messages.filter(message => !message.flags?.has(String.fromCharCode(92) + 'Seen')).length };
    },
    fetch: async function * (range, query) {
      if (options.fail?.fetch) throw options.fail.fetch;
      fetched.push({ range, query });
      // "*" in a set is the largest UID the folder has.
      const largest = selected ? Math.max(0, ...selected.messages.map(item => item.uid)) : 0;
      for (const message of selected?.messages ?? []) {
        if (!inSet(message.uid, range, largest)) continue;
        const answer: Record<string, unknown> = { uid: message.uid };
        if (query.envelope && message.envelope) answer.envelope = message.envelope;
        if (query.flags) answer.flags = message.flags ?? new Set<string>();
        if (query.internalDate && message.internalDate !== undefined) answer.internalDate = message.internalDate;
        if (query.bodyStructure && message.bodyStructure !== undefined) answer.bodyStructure = message.bodyStructure;
        if (query.size) answer.size = message.size ?? message.raw?.byteLength ?? 0;
        // The source is what a full read asks for. A server that reports a size above the limit
        // sends only that many bytes, as the real one does.
        if (query.source) {
          const asked = query.source as { maxLength?: number } | true;
          const limit = asked !== true && asked.maxLength ? asked.maxLength : Infinity;
          const raw = message.raw ?? new Uint8Array();
          answer.source = Buffer.from(raw.slice(0, limit));
        }
        yield answer;
      }
    },
    async search(query, searchOptions) {
      searches.push({ query, uid: searchOptions.uid });
      if (options.search === 'refused') throw new Error('SEARCH failed');
      // A server that finds nothing answers nothing for any word.
      if (Object.keys(query).length && options.search !== 'finds') return [];
      if (Object.keys(query).length === 0) return (selected?.messages ?? []).map(message => message.uid);
      // A server that searches looks at the subject and the sender.
      const word = String(query.text ?? '').toLowerCase();
      return (selected?.messages ?? []).filter(message => JSON.stringify(message.envelope ?? {}).toLowerCase().includes(word)).map(message => message.uid);
    },
    async download(uid, part, downloadOptions) {
      downloaded.push({ uid, part, maxBytes: downloadOptions.maxBytes });
      if (options.fail?.download) throw options.fail.download;
      const message = selected?.messages.find(item => item.uid === uid);
      const content = message?.parts?.[part];
      if (!content) return {};
      const bytes = content.slice(0, downloadOptions.maxBytes);
      // The content is given in two pieces, so a reader that assumes one chunk fails here.
      const middle = Math.ceil(bytes.byteLength / 2);
      async function * pieces() { yield bytes.slice(0, middle); yield bytes.slice(middle); }
      return { content: pieces(), meta: { size: bytes.byteLength } };
    },
    async logout() { logouts++; },
    /** Keeps what was put in a folder. A test that sends reads it back from here. */
    async append(path, content, appendOptions) {
      appended.push({ path, content: new Uint8Array(content), flags: [...appendOptions.flags], date: new Date(appendOptions.date) });
      return { path };
    },
  };
  return { client, opened, fetched, searches, downloaded, appended, logouts: () => logouts };
}

/** Whether a UID is in a set as a mail server writes it: one number, a range "n:m", an open
 *  end "n:*", or several of those with commas between. `largest` is what "*" stands for. */
function inSet(uid: number, range: string, largest: number): boolean {
  return range.split(',').some(part => {
    const [from, to] = part.split(':');
    const start = Number(from);
    if (!Number.isSafeInteger(start)) return false;
    if (to === undefined) return uid === start;
    // "*" is the largest number there is.
    const end = to === '*' ? largest : Number(to);
    return uid >= Math.min(start, end) && uid <= Math.max(start, end);
  });
}

