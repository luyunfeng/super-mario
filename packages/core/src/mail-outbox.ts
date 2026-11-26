import type { Approval, MailAccount } from '../../protocol/src/index.ts';
import type { Json, JsonObject } from '../../plugin-sdk/src/index.ts';
import { appends, connectionOptions, libraryOpen, roleOf, type ImapClient, type OpenImap } from './mail-imap.ts';
import { newMessageId, renderSentCopy, SendRefused, sendMail, type SendOutcome, type SendRequest } from './mail-send.ts';
import { validMailAddress } from './mail-presets.ts';

/** The kind of the approval that sends one email. It follows the plugin form so that the
 *  approval service takes it without being told about it. */
export const MAIL_SEND_APPROVAL = 'plugin:mail-connector.send';

/** What the assistant sends when it asks to send mail. Checked field by field, and the
 *  checked copy is what the owner approves. */
export type SendInput = SendRequest;

/** A request that is not well formed. It never reaches an approval. */
export class MailInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'MailInputError'; this.status = status; }
}

const most = (value: unknown, name: string, limit: number): string => {
  if (typeof value !== 'string') throw new MailInputError(`${name}须为文本`);
  if (value.length > limit) throw new MailInputError(`${name}最多 ${limit} 个字符`);
  return value;
};
/** One address as the assistant gives it: an object with an email and an optional name. */
function address(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MailInputError(`${name}须为邮箱地址对象`);
  const row = value as Record<string, unknown>;
  const allowed = ['name', 'email'];
  const extra = Object.keys(row).find(key => !allowed.includes(key));
  if (extra) throw new MailInputError(`${name}参数无效：${extra}`);
  if (typeof row.email !== 'string' || !validMailAddress(row.email)) throw new MailInputError(`${name}里的邮箱地址无效`);
  return { name: typeof row.name === 'string' ? row.name.slice(0, 200) : '', email: row.email };
}
function addresses(value: unknown, name: string, limit: number) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new MailInputError(`${name}须为数组`);
  if (value.length > limit) throw new MailInputError(`${name}最多 ${limit} 个地址`);
  return value.map(item => address(item, name));
}

/** Checks what the assistant sent. Anything it did not mean to send is refused here, so the
 *  approval holds exactly one message and nothing else. */
export function checkedSendInput(input: Record<string, unknown>): SendInput {
  const allowed = ['account', 'account_id', 'to', 'cc', 'bcc', 'subject', 'text', 'html', 'in_reply_to', 'inReplyTo', 'references'];
  const extra = Object.keys(input).find(key => !allowed.includes(key));
  if (extra) throw new MailInputError(`发邮件参数无效：${extra}`);
  const account = input.account ?? input.account_id;
  if (typeof account !== 'string' || !account) throw new MailInputError('请先说明用哪个邮箱发出');
  const to = addresses(input.to, '收件人', 50);
  const cc = addresses(input.cc, '抄送', 50);
  const bcc = addresses(input.bcc, '密送', 50);
  if (to.length + cc.length + bcc.length === 0) throw new MailInputError('请说明发给谁');
  const subject = most(input.subject, '主题', 998);
  const text = most(input.text, '正文', 100_000);
  const html = input.html === undefined ? undefined : most(input.html, 'HTML 正文', 500_000);
  const reply = input.in_reply_to ?? input.inReplyTo;
  if (reply !== undefined && (typeof reply !== 'string' || !/^[^<>\s]{1,998}$/.test(reply.replace(/^<|>$/g, '')))) throw new MailInputError('in_reply_to 须为 Message-ID');
  const references = input.references === undefined ? [] : Array.isArray(input.references) ? input.references : String(input.references).split(/\s+/);
  if (references.length > 100 || references.some(item => typeof item !== 'string' || !/^[^<>\s]{1,998}$/.test(String(item).replace(/^<|>$/g, '')))) throw new MailInputError('references 须为 Message-ID 的列表');
  return {
    account, to, cc, bcc, subject, text,
    ...(reply !== undefined ? { inReplyTo: String(reply).replace(/^<|>$/g, '') } : {}),
    references: (references as string[]).map(item => item.replace(/^<|>$/g, '')),
  };
}

/** What the owner reads on the approval. It is the message as it will go out, so that what is
 *  approved is what is sent. */
function summary(request: SendInput): { title: string; details: string } {
  const named = (list: { name: string; email: string }[]) => list.map(item => item.name ? `${item.name} <${item.email}>` : item.email).join('、');
  const lines = [
    `收件人：${named(request.to)}`,
    ...(request.cc.length ? [`抄送：${named(request.cc)}`] : []),
    ...(request.bcc.length ? [`密送：${named(request.bcc)}`] : []),
    `主题：${request.subject}`,
    '',
    request.text,
    ...(request.html !== undefined ? ['', '（这封邮件另附 HTML 版本，内容与上面相同。）'] : []),
  ];
  return { title: `发送邮件给 ${named(request.to).slice(0, 120)}：${request.subject.slice(0, 80)}`, details: lines.join('\n') };
}

/** Puts back the names the tool uses from the names the approval keeps. */
export function requestOf(params: JsonObject): SendInput {
  return checkedSendInput({
    account: params.account, to: params.to, cc: params.cc, bcc: params.bcc, subject: params.subject, text: params.text,
    html: params.html, in_reply_to: params.inReplyTo, references: params.references,
  });
}

/** An email the assistant wants to send. Nothing goes out until the owner approves it. */
export function proposeMailSend(input: Record<string, unknown>, accounts: { get(id: string): MailAccount }, propose: (input: { kind: Approval['kind']; title: string; details: string; params: JsonObject }) => Approval): Approval {
  const request = checkedSendInput(input);
  // The account is checked now, so an approval is not made for a mailbox that is not there.
  const account = accounts.get(request.account);
  const { title, details } = summary(request);
  return propose({
    kind: MAIL_SEND_APPROVAL as Approval['kind'], title, details,
    // The account's address is kept with the request: if the owner changes which address the
    // account has, the approval no longer says what would be sent.
    params: { ...request, account: account.id, sender: account.email } as unknown as JsonObject,
  });
}

/** Sends the email the owner approved.
 *
 *  What is sent is read from the approval and not from a copy made when it was proposed,
 *  because the owner may have rewritten the recipients or the text while reviewing it.
 *
 *  The outcome is returned as it is. One that is unknown is not turned into a failure, and it
 *  is not sent again: the message may already have gone.
 */
export async function executeMailSend(approval: Approval, accounts: {
  get(id: string): MailAccount; password(id: string): Promise<string | undefined>;
}, signal: AbortSignal, open?: OpenImap): Promise<SendOutcome & { copyKept?: boolean }> {
  const params = approval.params as unknown as { account: string; sender: string };
  const account = accounts.get(params.account);
  // The approval names the address the message was to go from. If the account now has
  // another one, the owner approved a message that is no longer this account's to send.
  if (account.email !== params.sender) throw new MailInputError('这个邮箱的地址已经变了，这封邮件没有发出。请核对后重新提交。', 409);
  const request = requestOf(approval.params);
  const password = await accounts.password(account.id);
  if (password === undefined) throw new MailInputError('这个邮箱还没有密码，这封邮件没有发出。', 409);
  // The id is made here, so that the message and the copy kept of it can share it.
  const messageId = newMessageId(account.email);
  let outcome: SendOutcome;
  try { outcome = await sendMail(account, password, request, signal, undefined, messageId); }
  catch (error) {
    if (error instanceof SendRefused) throw new MailInputError(error.message);
    throw error;
  }
  // A copy is kept only of a message that went. One that is unknown may have gone, and
  // keeping a copy of it would say it did.
  if (outcome.outcome !== 'sent') return outcome;
  const copyKept = await keepSentCopy(account, password, request, messageId, open);
  // A copy that could not be kept does not make the send a failure: the message went. The
  // owner is told, so they know the Sent folder does not have it.
  return { ...outcome, copyKept };
}

/** Keeps a copy of a sent message in the account's Sent folder, as a mail program does.
 *  It says whether it could. A failure here is not a failure of the send. */
async function keepSentCopy(account: MailAccount, password: string, request: SendInput, messageId: string, open: OpenImap = libraryOpen()): Promise<boolean> {
  let client: ImapClient | undefined;
  try {
    const raw = await renderSentCopy(account, request, messageId);
    client = await open(connectionOptions(account, password));
    const folders = await client.list();
    // The folder that holds sent mail is found by its role, as the folder list finds it, so
    // that a server that names it differently still gets the copy.
    // The same rule finds it here as names it in the folder list, so the copy goes where the
    // owner sees their sent mail.
    const sent = folders.find(box => roleOf(box.path, box.flags, box.specialUse) === 'sent');
    if (!sent) return false;
    const kept = await appends(client).append(sent.path, raw, { flags: [String.fromCharCode(92) + 'Seen'], date: new Date() });
    return kept !== false;
  } catch {
    return false;
  } finally { await client?.logout().catch(() => {}); }
}

