import { randomUUID } from 'node:crypto';
import { createTransport, type SMTPTransportOptions, type Transporter } from 'nodemailer';
import type { MailAccount, MailAddress } from '../../protocol/src/mail.ts';
import { classifyImapError, ImapError, type ImapClient, type MailFailure } from './mail-imap.ts';
import { validMailAddress } from './mail-presets.ts';

/** What one send is asked to do. The addresses are the owner's own words for them. */
export interface SendRequest {
  account: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  /** HTML as the owner's assistant wrote it. Sent beside the text when it is given. */
  html?: string;
  /** The message this one answers, and the chain it belongs to, without brackets. */
  inReplyTo?: string;
  references?: string[];
}

/** The most a message may hold. Above it a server refuses the mail, so it is refused here
 *  first, with a reason the owner can act on. */
export const MAX_SEND_BYTES = 25 * 1024 * 1024;
/** The most recipients one message may name, over to, cc and bcc together. */
export const MAX_RECIPIENTS = 100;
/** How long one send may take before it is given up on. */
export const SEND_TIMEOUT_MS = 60_000;

/** How a send ended. "unknown" means the server took the message and then did not say whether
 *  it passed it on. It is never treated as not sent, because sending it again would send it
 *  twice. */
export type SendOutcome =
  | { outcome: 'sent'; messageId: string; accepted: string[]; rejected: string[] }
  | { outcome: 'not-sent'; failure: SendFailure; message: string }
  | { outcome: 'unknown'; message: string };

/** Whether an account can sign in to its outgoing server. Nothing is sent by the check. */
export type SignInCheck = { ok: true } | { ok: false; failure: SendFailure; message: string };

/** Why a send did not happen. Each is something the owner can act on, and none leaves it
 *  in doubt about whether the message went. */
export type SendFailure = Exclude<MailFailure, 'unknown' | 'not-found'> | 'refused-by-server' | 'too-large';

/** A send that was refused before anything left this machine. */
export class SendRefused extends Error {
  readonly failure: 'invalid' | 'too-large' | 'too-many';
  constructor(failure: 'invalid' | 'too-large' | 'too-many', message: string) { super(message); this.name = 'SendRefused'; this.failure = failure; }
}

/** The addresses of one message as its envelope has them, without names. */
function envelopeOf(request: SendRequest) {
  const all = [...request.to, ...request.cc, ...request.bcc];
  if (all.length === 0) throw new SendRefused('invalid', '这封邮件没有收件人。');
  if (all.length > MAX_RECIPIENTS) throw new SendRefused('too-many', `一封邮件最多有 ${MAX_RECIPIENTS} 个收件人。`);
  // An address that is not one is not repeated in the reason: it can be long, and the owner
  // sees it in the message they wrote.
  if (all.some(item => !validMailAddress(item.email))) throw new SendRefused('invalid', '有收件人的地址不是有效的邮箱地址，请核对后重试。');
  // The same address twice gets the mail once. A name is not part of an address.
  return { to: [...new Set(request.to.map(item => item.email))], cc: [...new Set(request.cc.map(item => item.email))], bcc: [...new Set(request.bcc.map(item => item.email))] };
}

/** The message as it is written, for the mail library. */
function compose(account: MailAccount, request: SendRequest, messageId: string) {
  if (!request.subject.trim() && !request.text.trim()) throw new SendRefused('invalid', '这封邮件没有主题也没有正文。');
  const named = (list: MailAddress[]) => list.map(item => ({ name: item.name, address: item.email }));
  return {
    // The account's own address is the sender. A name that is the address itself is left out,
    // because it says nothing.
    from: { name: account.name === account.email ? '' : account.name, address: account.email },
    to: named(request.to), cc: named(request.cc), bcc: named(request.bcc),
    subject: request.subject, text: request.text,
    ...(request.html ? { html: request.html } : {}),
    ...(request.inReplyTo ? { inReplyTo: `<${request.inReplyTo}>` } : {}),
    ...(request.references?.length ? { references: request.references.map(id => `<${id}>`).join(' ') } : {}),
    // The id is made here so that the sent copy and the message that goes out carry the same one.
    messageId,
    // A date is the moment the message was written, not the moment a server took it.
    date: new Date(),
    // Mixed parts as one message, so a mail program that reads no HTML still shows the text.
    multipart: request.html ? { alternative: true } as const : undefined,
  };
}

/** The domain a message id is made under: the sender's own, so the id does not name the
 *  machine the workbench runs on. */
function idDomain(email: string): string {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return domain || 'localhost';
}

/** The logger the mail library takes. It is named from the option it is given to, because the
 *  library exports the type only there. */
type Logger = NonNullable<SMTPTransportOptions['logger']>;

/**
 * Watches the server's replies during one send.
 *
 * The one reply that matters is the one to DATA. A server answers 354 when it has taken the
 * recipients and is ready for the message itself, and a few answer 250 instead. From that
 * answer on, the message is leaving this machine, so a failure after it may have arrived: the
 * send is "unknown" and not "not sent". Before it, nothing was handed over.
 *
 * The library logs every line each side sends. The logger given to it keeps nothing, prints
 * nothing and follows only which command was sent last, so no address, name or server greeting
 * reaches the workbench's output.
 *
 * The last command sent has to be followed, because 250 is also the answer to MAIL FROM and
 * RCPT TO. Taking every 250 as the answer to DATA would say the message had started to leave
 * when only its recipients had been taken.
 */
function watchData() {
  let accepted = false;
  let lastCommand = '';
  const logger: Logger = {
    // The first argument is a record when there is one, and the text is the next.
    debug(...args: unknown[]) {
      const data = args[0];
      if (!data || typeof data !== 'object') return;
      const kind = (data as { tnx?: unknown }).tnx;
      const line = String(args[1] ?? '');
      if (kind === 'client') { lastCommand = line.split(/\s/, 1)[0]!.toUpperCase(); return; }
      if (kind !== 'server') return;
      // The answer to DATA is 354, or 250 from a server that does it the other way.
      if (lastCommand === 'DATA' && /^(354|250)\b/.test(line)) accepted = true;
    },
  };
  return { logger, wasAccepted: () => accepted };
}

/** The failure of a send that did not finish, by what the library says of it. */
function classifySendError(error: unknown, dataAccepted: boolean): SendOutcome {
  const row = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = typeof row.code === 'string' ? row.code : '';
  // The server took the message and then said it would not take it. That is a refusal, and
  // the message did not go on.
  if (code === 'EMESSAGE') {
    if (/larger than allowed/i.test(String(row.message))) return { outcome: 'not-sent', failure: 'too-large', message: `这封邮件超过服务器允许的大小（最多 ${MAX_SEND_BYTES / 1024 / 1024} MB）。` };
    return { outcome: 'not-sent', failure: 'refused-by-server', message: '邮件服务器没有接受这封邮件的内容，这封邮件没有发出。' };
  }
  // The server took the message and then the connection ended, or the answer never came.
  if (dataAccepted) return { outcome: 'unknown', message: '邮件服务器已经收下这封邮件，但没有确认是否发出。请先到已发送里核对，不要直接重发。' };
  // The kinds below are named by where in the talk they usually happen. A connection that
  // ends can do so at any point, which is why the question above comes first: once the
  // message has started to leave, none of these says it did not go.
  const known: Record<string, SendFailure> = { EAUTH: 'authentication', EDNS: 'connection', ETIMEDOUT: 'timeout', ESOCKET: 'connection', ECONNECTION: 'connection', ETLS: 'tls' };
  // Every recipient was refused. A send where only some were refused succeeds, and the ones
  // refused are named in the result.
  if (code === 'EENVELOPE') {
    return { outcome: 'not-sent', failure: 'refused-by-server', message: '邮件服务器拒绝了这封邮件的所有收件人，这封邮件没有发出。请核对地址。' };
  }
  // The message's own stream broke while it was being written out. The server had taken the
  // recipients but not the message, and refused nothing.
  if (code === 'ESTREAM') return { outcome: 'not-sent', failure: 'connection', message: '发送过程中连接中断，这封邮件没有发出。请检查网络后再试。' };
  const failure = known[code];
  if (failure) return { outcome: 'not-sent', failure, message: describe(failure) };
  // A failure the rules above do not name may have happened at any point. The answer is the
  // careful one.
  return { outcome: 'unknown', message: '发送没有完成，结果无法确认。请先到已发送里核对，不要直接重发。' };
}

/** What to do about a failure, in the owner's terms. The library's own words are not shown. */
function describe(failure: SendFailure): string {
  const words: Record<SendFailure, string> = {
    authentication: '邮箱拒绝了用户名或密码，这封邮件没有发出。请核对登录名和授权码。',
    connection: '连接发件服务器失败，这封邮件没有发出。请检查网络和服务器地址。',
    tls: '无法建立加密连接，这封邮件没有发出。请核对发件服务器的地址、端口和加密方式。',
    timeout: '连接发件服务器超时，这封邮件没有发出。请稍后再试。',
    refused: '发件服务器拒绝了连接，这封邮件没有发出。请核对发件端口。',
    'too-many': '发件服务器暂时忙碌，这封邮件没有发出。请稍后再试。',
    'refused-by-server': '邮件服务器拒绝了这封邮件，这封邮件没有发出。',
    'too-large': `这封邮件太大，这封邮件没有发出。最多 ${MAX_SEND_BYTES / 1024 / 1024} MB。`,
  };
  return words[failure];
}

/** A certificate the server may show. Only a certificate to trust can be named: whether the
 *  server's certificate is checked at all cannot be turned off, because an unchecked server
 *  would be given the password. */
export type TrustedCertificates = { ca: string | Buffer | Array<string | Buffer> };

/** How the account's security setting becomes the mail library's. */
function smtpOptions(account: Pick<MailAccount, 'username' | 'smtpHost' | 'smtpPort' | 'smtpSecurity'>, password: string, logger: Logger, trusted?: TrustedCertificates) {
  const security = account.smtpSecurity || (account.smtpPort === 465 ? 'tls' : 'starttls');
  const base = { host: account.smtpHost, port: account.smtpPort, logger, connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: SEND_TIMEOUT_MS, debug: true,
    auth: { user: account.username, pass: password }, ...(trusted ? { tls: trusted } : {}) };
  // The connection is encrypted from the start.
  if (security === 'tls') return { ...base, secure: true };
  // The connection starts in cleartext and must be upgraded. The library refuses to go on
  // when the server cannot upgrade, which is what is wanted: the password never goes in cleartext.
  if (security === 'starttls') return { ...base, secure: false, requireTLS: true };
  // The owner said the server has no encryption. The upgrade is still taken when the server
  // offers one, but it is not required. This is for a server of the owner's own.
  return { ...base, secure: false };
}

/** One send over SMTP. The password is used for this connection and is not kept.
 *  `messageId` is made by the caller when the caller also keeps a copy, so that the copy
 *  and the message that goes out carry the same one. */
export async function sendMail(account: MailAccount, password: string, request: SendRequest, signal: AbortSignal, trusted?: TrustedCertificates, messageId = `<${randomUUID()}@${idDomain(account.email)}>`): Promise<SendOutcome> {
  // Everything that can be refused is refused before a connection is made, so a bad message
  // never reaches a server.
  const envelope = envelopeOf(request);
  const message = compose(account, request, messageId);
  const watch = watchData();
  const transport: Transporter = createTransport(smtpOptions(account, password, watch.logger, trusted));
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<never>((_, reject) => {
    // The library has its own timeouts. This one is for the whole send, so a server that
    // keeps the connection open without answering cannot hold the workbench forever.
    timer = setTimeout(() => { transport.close(); reject(new SendTimedOut()); }, SEND_TIMEOUT_MS + 5000);
  });
  try {
    const sent = await Promise.race([
      // The signal goes to the library, which closes the connection the moment the owner
      // stops waiting. The talk with the server is not carried on in the background.
      transport.sendMail({ ...message, envelope: { from: account.email, ...envelope }, signal }),
      gaveUp,
    ]);
    // The envelope is who the server took the message for. A name is not part of that.
    const rejected = [...(sent.rejected ?? [])].map(String);
    return { outcome: 'sent', messageId: messageId.slice(1, -1), accepted: [...(sent.accepted ?? [])].map(String), rejected };
  } catch (error) {
    // Running out of time and being stopped are not failures of the server. What they mean
    // depends on the one question that matters: had the message started to leave?
    if (error instanceof SendTimedOut) return timedOut(watch.wasAccepted());
    const aborted = (error && typeof error === 'object' && 'code' in error && error.code === 'EABORT') || signal.aborted;
    if (aborted) return watch.wasAccepted()
      ? { outcome: 'unknown', message: '发送被中断，结果无法确认。请先到已发送里核对，不要直接重发。' }
      : { outcome: 'not-sent', failure: 'timeout', message: '发送被中断，这封邮件没有发出。' };
    return classifySendError(error, watch.wasAccepted());
  } finally {
    if (timer) clearTimeout(timer);
    transport.close();
  }
}

/** The whole send took too long. */
class SendTimedOut extends Error { constructor() { super('send timed out'); this.name = 'SendTimedOut'; } }

/** How a send that ran out of time ended. It depends on whether the message had started to
 *  leave, which is the same question as for any other failure. */
function timedOut(dataAccepted: boolean): SendOutcome {
  return dataAccepted
    ? { outcome: 'unknown', message: '邮件服务器已经收下这封邮件，但没有在限定时间内确认，结果无法确认。请先到已发送里核对，不要直接重发。' }
    : { outcome: 'not-sent', failure: 'timeout', message: '发件服务器长时间没有回应，这封邮件没有发出。请稍后再试。' };
}

/** The id a message gets when the caller does not name one. */
export function newMessageId(email: string): string { return `<${randomUUID()}@${idDomain(email)}>`; }

/** The message as it is kept in the owner's own Sent folder. It is the same message that went
 *  out, with the blind copies named, because this copy is for the owner and not for the
 *  recipients. Nothing is sent and no connection is made. */
export async function renderSentCopy(account: MailAccount, request: SendRequest, messageId: string, date = new Date()): Promise<Uint8Array> {
  const message = compose(account, request, messageId);
  const transport: Transporter = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const info = await transport.sendMail({ ...message, date });
  // With the buffer option set, the message comes back whole under "message".
  return new Uint8Array(info.message as Buffer);
}

/** Whether the account can sign in to its outgoing server. Nothing is sent. */
export async function verifySmtp(account: MailAccount, password: string, signal: AbortSignal, trusted?: TrustedCertificates): Promise<SignInCheck> {
  const watch = watchData();
  const transport: Transporter = createTransport(smtpOptions(account, password, watch.logger, trusted));
  try {
    await transport.verify();
    signal.throwIfAborted();
    return { ok: true };
  } catch (error) {
    // A check that did not finish says nothing about the account. It is not a failure of the
    // account, and it is not a success.
    if (signal.aborted || error instanceof SendTimedOut) return { ok: false, failure: 'timeout', message: '检查发件服务器超时，请稍后再试。' };
    const outcome = classifySendError(error, false);
    // Nothing is sent by a check, so a failure is always one the owner can act on without
    // wondering whether a message went. The words about a message are taken out.
    const message = outcome.outcome === 'sent' ? '' : outcome.message.replace(/，?这封邮件没有发出。?/, '').replace(/请先到已发送里核对，不要直接重发。?/, '').trim();
    return { ok: false, failure: outcome.outcome === 'not-sent' ? outcome.failure : 'refused-by-server', message: message || '发件服务器没有接受登录。' };
  } finally { transport.close(); }
}
