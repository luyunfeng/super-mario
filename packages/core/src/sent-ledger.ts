// What went out in the owner's name, from every connector, as one list. The owner can see
// what was written for them, where it went, and open the approval that let it through.
//
// Only what is known to have gone out is in it. A request that was refused, declined or
// failed, and one whose outcome is unknown, is not: nothing is known to have reached anyone.
// Nothing is written a second time. Each row is read from the record that already holds it.
import type { Approval } from '../../protocol/src/index.ts';
import type { OutboxItem, Store } from '../../plugin-sdk/src/index.ts';

/** How much of what was written is shown in a row. The whole of it is on the record. */
export const SENT_TEXT_MOST = 4000;
/** A page of the ledger, and the most one page may hold. */
export const SENT_PAGE = 30;
export const SENT_MAX = 100;

/** The connectors whose writes go out in the owner's name. */
export const SENT_CONNECTORS = ['飞书', '邮箱', 'GitHub'] as const;
export type SentConnector = typeof SENT_CONNECTORS[number];

/** How a write was let through. */
export type SentThrough = 'approval' | 'rule';

/** One thing that went out in the owner's name. */
export interface SentItem {
  /** The record it was read from, by kind and id. */
  id: string;
  /** When it went out. */
  at: string;
  connector: SentConnector;
  /** What was done, in words. */
  action: string;
  /** Where it went, in words. */
  target: string;
  /** What was written. For a mail, the subject and then the text. */
  text: string;
  /** The written message's id on the other side, when the connector gave one. */
  messageRef?: string;
  through: SentThrough;
  /** The approval that let it through, so that the page can open it. */
  approvalId?: string;
  /** The outbox entry it was sent from, for the connectors that go through the outbox. */
  outboxId?: string;
}

/** One page of the ledger. */
export interface SentPage {
  /** Newest first. */
  items: SentItem[];
  hasMore: boolean;
  /** Where the next page starts: the last row of this one. */
  next?: { at: string; id: string };
}

const MAIL_SEND = 'plugin:mail-connector.send';
const GITHUB_COMMENT = 'plugin:github-connector.comment';

/** What was written, cut to what a row shows. The cut is on characters, not bytes. */
function cut(value: string, most: number): string {
  const chars = Array.from(value);
  return chars.length > most ? chars.slice(0, most).join('') : value;
}

/** The recipients of an email as the owner reads them. Those sent a blind copy are counted
 *  and not named, the way the message itself keeps them from the other recipients. */
function recipients(params: Record<string, unknown>): string {
  const list = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(item => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const email = typeof row.email === 'string' ? row.email : '';
    if (!email) return [];
    return [typeof row.name === 'string' && row.name ? row.name + ' <' + email + '>' : email];
  }) : [];
  const to = list(params.to), cc = list(params.cc), bcc = list(params.bcc);
  return [to.join('、'), cc.length ? '抄送 ' + cc.join('、') : '', bcc.length ? '密送 ' + bcc.length + ' 人' : ''].filter(Boolean).join('；');
}

/** Where a row sorts. Rows that share a time are told apart by id, so that a page that ends
 *  between them continues with the next one and not with the same one again. */
function position(row: { at: string; id: string }): string {
  return row.at + '|' + row.id;
}

/**
 * The ledger. It reads the outbox and the approvals, and writes nothing of its own.
 */
export function createSentLedger({ store }: { store: Store }) {
  function all(): SentItem[] {
    const rows: SentItem[] = [];
    // Replies and notices go out through the outbox. Only what was sent is taken: one that
    // is still queued, held, failed, cancelled or left unknown did not go out.
    for (const item of store.list<OutboxItem>('outbox.items')) {
      if (item.status !== 'sent') continue;
      rows.push({
        id: 'outbox:' + item.id, at: item.updatedAt, connector: '飞书', action: '发送消息',
        target: item.target ? '飞书 ' + item.target : '飞书', text: cut(item.content.text, SENT_TEXT_MOST),
        through: item.approvalId ? 'approval' : 'rule',
        ...(item.approvalId ? { approvalId: item.approvalId } : {}), outboxId: item.id,
      });
    }
    // A mail and a GitHub comment go out when the approval that asks for it is carried out.
    // What went out is what the approval holds, because that is what the owner agreed to.
    for (const approval of store.list<Approval>('approvals')) {
      if (approval.status !== 'completed') continue;
      const result = approval.result && typeof approval.result === 'object' && !Array.isArray(approval.result) ? approval.result as Record<string, unknown> : {};
      const params = approval.params as Record<string, unknown>;
      if (approval.kind === MAIL_SEND) {
        // The approval is completed when the send is over. It is a send only when the server
        // took the message; one left unknown is not shown as though it had gone.
        if (result.outcome !== 'sent') continue;
        // What went out is what the approval holds in its parameters, because the owner may
        // have rewritten the text while reviewing it. The subject is named with the text.
        const subject = typeof params.subject === 'string' ? params.subject.trim() : '';
        const body = typeof params.text === 'string' ? params.text : '';
        rows.push({
          id: 'approval:' + approval.id, at: approval.updatedAt, connector: '邮箱', action: '发送邮件',
          target: recipients(params), text: cut(subject ? '主题：' + subject + '\n\n' + body : body, SENT_TEXT_MOST), through: 'approval', approvalId: approval.id,
          ...(typeof result.messageId === 'string' && result.messageId ? { messageRef: result.messageId } : {}),
        });
      } else if (approval.kind === GITHUB_COMMENT) {
        // "already-sent" is a carry-out that found the comment had gone out before, under the
        // same key. It is not a second send, so it is not a second row.
        if (result.state !== 'sent') continue;
        rows.push({
          id: 'approval:' + approval.id, at: approval.updatedAt, connector: 'GitHub', action: '发表评论',
          target: String(params.repository ?? '') + ' #' + String(params.number ?? ''), text: cut(approval.details, SENT_TEXT_MOST),
          through: 'approval', approvalId: approval.id,
          ...(typeof result.url === 'string' && result.url ? { messageRef: result.url } : {}),
        });
      }
    }
    // Newest first. Rows that share a time keep a fixed order by id.
    return rows.sort((a, b) => position(b).localeCompare(position(a)));
  }

  /** One page, newest first. A connector narrows it; a position continues after that row. */
  function read(options: { connector?: SentConnector; limit?: number; after?: { at: string; id: string } } = {}): SentPage {
    const limit = Math.max(1, Math.min(SENT_MAX, options.limit ?? SENT_PAGE));
    const rows = all().filter(row => !options.connector || row.connector === options.connector);
    // A page that continues another one starts after its last row, that row included.
    const rest = options.after ? rows.filter(row => position(row) < position(options.after!)) : rows;
    const page = rest.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page, hasMore: rest.length > page.length, ...(last && rest.length > page.length ? { next: { at: last.at, id: last.id } } : {}) };
  }

  return { read };
}

export type SentLedger = ReturnType<typeof createSentLedger>;
