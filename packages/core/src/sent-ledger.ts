// What went out in the owner's name, from every connector, as one list. The owner can see
// what was written for them, where it went, and open the approval that let it through.
//
// Only what is known to have gone out is in it. A request that was refused, declined or
// failed, and one whose outcome is unknown, is not: nothing is known to have reached anyone.
// Nothing is written a second time. Each row is read from the record that already holds it.
// The one write is the answer of a recall the owner asked for, which is kept on the outbox entry.
import type { Approval } from '../../protocol/src/index.ts';
import type { OutboxItem, OutboxRecall, Store } from '../../plugin-sdk/src/index.ts';

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
  /** The bot that sent a Feishu message, so that a recall asks the same bot. */
  botId?: string;
  /** Whether the owner can take it back: a Feishu message the bot sent, with its id kept, not already taken back. */
  canRecall: boolean;
  /** When the owner tried to take it back, and how that ended. */
  recall?: OutboxRecall;
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

/** The bot an outbox channel belongs to. A bot's notices go out on feishu.bot:<bot id>:<binding>; any other
 *  channel, and a channel whose id is not a bot's, answers with nothing. */
function botOfChannel(channel: string): string | undefined {
  if (!channel.startsWith('feishu.bot:')) return undefined;
  const id = channel.split(':')[1];
  return id && /^[0-9a-f]{64}$/.test(id) ? id : undefined;
}

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
 * The ledger. It reads the outbox and the approvals. The one thing it writes is the answer of a recall,
 * kept on the outbox entry the row was read from.
 */
/** What the channel says of a recall it was asked for. `refused` means nothing was deleted and the message is still
 *  there; `unknown` means it may have been deleted and the channel did not confirm. */
export type SentRecallAnswer = { status: 'done' | 'refused' | 'unknown'; error?: string };

export function createSentLedger({ store, recallFeishu }: { store: Store; recallFeishu?: (messageId: string, botId?: string) => Promise<SentRecallAnswer> }) {
  // One recall at a time per row. A second ask while the first is in flight waits for its answer.
  const inFlight = new Map<string, Promise<SentItem>>();
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
        ...(item.messageRef ? { messageRef: item.messageRef } : {}),
        // A bot's notices go out on the channel feishu.bot:<bot id>:<binding>. A recall asks that bot.
        ...(botOfChannel(item.channel) ? { botId: botOfChannel(item.channel)! } : {}),
        canRecall: Boolean(item.messageRef) && item.recall?.status !== 'done',
        ...(item.recall ? { recall: item.recall } : {}),
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
          // Once a server has a mail, nothing takes it back.
          canRecall: false,
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
          // A comment is deleted from the machine signed in to GitHub, which is not at hand here.
          canRecall: false,
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

  /** One row by id, from the whole ledger and not from a page. */
  function find(id: string): SentItem | undefined { return all().find(item => item.id === id); }

  /** The owner takes back one Feishu message the bot sent. The caller has checked that the row may be
   *  recalled and that the owner asked for it. The answer is kept on the outbox entry, whatever it is, so
   *  that a restart does not lose it. A row already taken back answers so again without asking the channel. */
  async function recall(id: string): Promise<SentItem> {
    const row = all().find(item => item.id === id);
    if (!row) throw new Error('这条记录已不在');
    if (row.recall?.status === 'done') return row;
    if (!row.outboxId || !row.messageRef || !recallFeishu) throw new Error('这条记录现在不能撤回');
    const running = inFlight.get(id);
    if (running) return running;
    const { outboxId, messageRef } = row;
    const job = (async () => {
      const item = store.get<OutboxItem>('outbox.items', outboxId);
      if (!item || item.status !== 'sent' || item.messageRef !== messageRef) throw new Error('这条记录已变化，请刷新后再试');
      const answer = await recallFeishu!(messageRef, row.botId);
      store.put('outbox.items', item.id, { ...item, recall: { status: answer.status, at: new Date().toISOString(), ...(answer.error ? { error: answer.error } : {}) } });
      return all().find(item => item.id === id)!;
    })().finally(() => inFlight.delete(id));
    inFlight.set(id, job);
    return job;
  }
  return { read, find, recall };
}

export type SentLedger = ReturnType<typeof createSentLedger>;
