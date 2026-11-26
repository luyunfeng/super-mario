import { createHash } from 'node:crypto';
import PostalMime, { type Attachment, type Email } from 'postal-mime';
import type { MailAddress, MailAttachment, MailMessage, MailSummary } from '../../protocol/src/mail.ts';
import { classifyImapError, ImapError, mailDate, MAX_MESSAGE_BYTES, type ImapClient } from './mail-imap.ts';

/** The most text one message gives. A longer message is cut here and says so, because a
 *  message is read to answer a question about it. */
export const MAX_TEXT_CHARS = 200_000;
/** The most attachments one message lists. The rest are counted and named in a note. */
export const MAX_ATTACHMENTS = 100;

/** Why one message could not be read, in terms the owner can act on. */
export type MessageFailure = 'not-found' | 'too-large' | 'unreadable';
export class MessageError extends Error {
  readonly failure: MessageFailure;
  constructor(failure: MessageFailure, message: string) { super(message); this.name = 'MessageError'; this.failure = failure; }
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const cut = (value: string, most: number) => value.length > most ? value.slice(0, most) : value;

/** Addresses as the owner reads them. One address or a list is taken, and a group is opened
 *  into its members. */
export function mailAddresses(value: unknown): MailAddress[] {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  return list.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (Array.isArray(row.group)) return mailAddresses(row.group);
    const email = cut(text(row.address), 320);
    return email ? [{ name: cut(text(row.name), 200), email }] : [];
  });
}

/** The Message-Ids of the headers that tie a reply to what it answers, without the brackets. */
export function messageIds(value: string): string[] {
  const found = value.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(found.map(item => cut(item.slice(1, -1), 998)))].slice(0, 100);
}

/** The bytes of an attachment as the parser gave them. */
function bytesOf(content: Attachment['content']): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return Buffer.from(String(content), 'utf8');
}

/**
 * The id of one attachment of one message.
 *
 * It is worked out from where the attachment is and from its bytes, so it stays the same
 * while the message is unchanged, and two attachments of one message that share a name and
 * a size still differ. It says nothing about the account on its own, and cannot be turned
 * back into one.
 */
function attachmentId(where: { account: string; mailbox: string; uid: number }, index: number, attachment: Pick<Attachment, 'filename' | 'mimeType'>, bytes: Uint8Array): string {
  return createHash('sha256')
    .update(JSON.stringify([where.account, where.mailbox, where.uid, index, attachment.filename, attachment.mimeType, bytes.byteLength]))
    .update(bytes)
    .digest('base64url').slice(0, 22);
}

/** One character reference as its character. A reference that is not a character, because it
 *  is out of range or falls in the gap used by surrogate pairs, becomes nothing: a message
 *  from anyone can hold one, and it must not stop the message from being read. */
function reference(code: number): string {
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
}

/** HTML as plain words. Used only when a message has no text part. Tags, scripts and styles
 *  are dropped. This is a reading of the message and not a rendering of it, so nothing in
 *  it is trusted or kept as markup. */
export function htmlToText(html: string): string {
  const withoutHidden = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const withBreaks = withoutHidden
    .replace(/<\/(?:p|div|tr|li|h[1-6]|blockquote|pre|table|section|article|header|footer|address)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const noTags = withBreaks.replace(/<[^>]+>/g, '');
  // The entities that nearly every message carries. Others are left as written rather than
  // guessed at, and a named entity that is not one of these stays visible as itself.
  const decoded = noTags
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => reference(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => reference(Number(code)))
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
  return decoded.split('\n').map(line => line.replace(/[\t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** What one read of a message found. The attachments' content is not part of it. */
export type MessageRead = {
  message: MailMessage;
  /** The attachments with their content, kept for the moment of the read so that one can be
   *  saved. It is given back by the reader and not kept after that. */
  contents: Map<string, Uint8Array>;
};

/**
 * Reads one message in full, without marking it as read.
 *
 * The whole message is taken and parsed once, so that the text and the attachments come from
 * the same reading of it. A message is asked for with a limit on its size: one above it is
 * reported as too large and not cut short, because half a message reads as a whole one.
 */
export async function readMessage(client: ImapClient, where: { account: string; mailbox: string; uid: number }, signal: AbortSignal): Promise<MessageRead> {
  try {
    const folder = await client.mailboxOpen(where.mailbox, { readOnly: true });
    const mailbox = folder.path ?? where.mailbox;
    signal.throwIfAborted();
    let found: Record<string, unknown> | undefined;
    for await (const row of client.fetch(String(where.uid), { uid: true, envelope: true, flags: true, internalDate: true, size: true, source: { maxLength: MAX_MESSAGE_BYTES } })) {
      // A UID FETCH answers only the message asked for. One with another UID would mean the
      // server answered out of turn, and is not read.
      if (Number(row.uid) === where.uid) found = row;
    }
    if (!found) throw new MessageError('not-found', '这封邮件不在了，可能已被移动或删除。');
    if (Number(found.size) > MAX_MESSAGE_BYTES) {
      throw new MessageError('too-large', `这封邮件有 ${Math.ceil(Number(found.size) / 1024 / 1024)} MB，超过了一次读取的上限（${MAX_MESSAGE_BYTES / 1024 / 1024} MB）。`);
    }
    const source = found.source;
    if (!(source instanceof Uint8Array) || source.byteLength === 0) throw new MessageError('unreadable', '这封邮件的内容读不出来。');
    // The size the server named is checked against what arrived, because the limit on the
    // fetch is a request and a server may send less than the whole message.
    if (source.byteLength >= MAX_MESSAGE_BYTES) throw new MessageError('too-large', `这封邮件超过了一次读取的上限（${MAX_MESSAGE_BYTES / 1024 / 1024} MB）。`);
    let parsed: Email;
    try { parsed = await new PostalMime().parse(source); }
    catch { throw new MessageError('unreadable', '这封邮件的格式无法解析。'); }

    const envelope = found.envelope as Record<string, unknown> | undefined;
    // The envelope is what the server read from the message and the parser reads the same
    // headers, so either names the sender. The envelope is used when it has one.
    const from = mailAddresses(envelope?.from)[0] ?? mailAddresses(parsed.from)[0] ?? { name: '', email: '' };
    const flags = found.flags instanceof Set ? [...found.flags].map(String) : Array.isArray(found.flags) ? found.flags.map(String) : [];
    const has = (flag: string) => flags.some(item => item.toLowerCase() === (String.fromCharCode(92) + flag).toLowerCase());
    // When the message arrived is what the owner means by its date. The header's own date is
    // used only when the server gave none, because a sender can write anything there.
    const date = mailDate(found.internalDate) ?? mailDate(parsed.date) ?? '';

    // A picture that the HTML shows from inside the message, such as one in a signature, is
    // part of how the message looks and not a file the owner would save. The parser marks one
    // that sits in a related part. One that sits elsewhere is found by its id in the HTML,
    // because mail programs put it in both places.
    const html = parsed.html ?? '';
    const shownInHtml = (item: Pick<Attachment, 'contentId' | 'mimeType'>) => {
      const id = text(item.contentId).replace(/^<|>$/g, '');
      return !!id && /^image\//.test(item.mimeType) && html.includes('cid:' + id);
    };
    const files = parsed.attachments.filter(item => !item.related && !shownInHtml(item));
    const contents = new Map<string, Uint8Array>();
    const attachments: MailAttachment[] = files.slice(0, MAX_ATTACHMENTS).map((item, index) => {
      const bytes = bytesOf(item.content);
      const id = attachmentId({ ...where, mailbox }, index, item, bytes);
      contents.set(id, bytes);
      return { id, filename: cut(item.filename ?? '', 255), mimeType: cut(item.mimeType || 'application/octet-stream', 255).toLowerCase(), size: bytes.byteLength };
    });
    const body = parsed.text ?? '';
    const full = body.trim() ? body : html ? htmlToText(html) : '';
    return {
      contents,
      message: {
        account: where.account, mailbox, uid: where.uid,
        messageId: cut(text(parsed.messageId).replace(/^<|>$/g, ''), 998),
        subject: cut(text(parsed.subject), 500).split(/[\r\n\t]+/).join(' ').trim(),
        from, to: mailAddresses(parsed.to), cc: mailAddresses(parsed.cc),
        date, hasAttachments: attachments.length > 0, seen: has('Seen'), answered: has('Answered'), flagged: has('Flagged'),
        inReplyTo: cut(text(parsed.inReplyTo).replace(/^<|>$/g, ''), 998), references: messageIds(text(parsed.references)),
        text: cut(full, MAX_TEXT_CHARS), html: cut(html, MAX_TEXT_CHARS),
        textTruncated: full.length > MAX_TEXT_CHARS,
        attachments, attachmentCount: files.length,
      },
    };
  } catch (error) {
    if (signal.aborted) throw error;
    // A failure of the mail server is put into one of the kinds the owner can act on, and the
    // library's own words, which can hold an address, are not passed on.
    throw error instanceof MessageError || error instanceof ImapError ? error : classifyImapError(error);
  }
}
