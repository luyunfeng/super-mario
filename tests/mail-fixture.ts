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

export function fakeMailServer(options: FakeServerOptions): FakeServer {
  const opened: FakeServer['opened'] = [];
  const fetched: FakeServer['fetched'] = [];
  const searches: FakeServer['searches'] = [];
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

