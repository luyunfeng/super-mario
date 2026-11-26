import type { MailPreset } from '../../protocol/src/mail.ts';

// The servers of the mail domains people actually have. A domain that is not here is still
// usable: the owner gives the servers. Each entry says where the sign-in code is made, for the
// providers that do not accept the account's own password in a mail client.
const gmail: MailPreset = { provider: 'gmail', imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecurity: 'tls', codeSite: 'myaccount.google.com/apppasswords' };
const qq: MailPreset = { provider: 'imap', imapHost: 'imap.qq.com', imapPort: 993, smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecurity: 'tls', codeSite: 'mail.qq.com' };
const netease = (host: string, site: string): MailPreset => ({ provider: 'imap', imapHost: 'imap.' + host, imapPort: 993, smtpHost: 'smtp.' + host, smtpPort: 465, smtpSecurity: 'tls', codeSite: site });

const presets = new Map<string, MailPreset>([
  ['gmail.com', gmail], ['googlemail.com', gmail],
  ['qq.com', qq], ['foxmail.com', qq], ['vip.qq.com', qq],
  ['163.com', netease('163.com', 'mail.163.com')], ['vip.163.com', netease('vip.163.com', 'mail.163.com')],
  ['126.com', netease('126.com', 'mail.126.com')], ['vip.126.com', netease('vip.126.com', 'mail.126.com')],
  ['yeah.net', netease('yeah.net', 'mail.yeah.net')], ['188.com', netease('188.com', 'www.188.com')],
  ['outlook.com', { provider: 'imap', imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, smtpSecurity: 'starttls' }],
  ['hotmail.com', { provider: 'imap', imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, smtpSecurity: 'starttls' }],
  ['live.com', { provider: 'imap', imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, smtpSecurity: 'starttls' }],
  ['icloud.com', { provider: 'imap', imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecurity: 'starttls', codeSite: 'account.apple.com' }],
  ['me.com', { provider: 'imap', imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecurity: 'starttls', codeSite: 'account.apple.com' }],
  ['yahoo.com', { provider: 'imap', imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecurity: 'tls' }],
]);

/** The servers of one address's domain, or undefined when the domain is not known. */
export function mailPreset(email: string): MailPreset | undefined {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? presets.get(domain) : undefined;
}

/** A mail address as it is allowed to be. One @, a domain of labels, no spaces or controls. */
const address = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** A host as it is given to a server: a name, or an IPv4 address, or an IPv6 address in brackets. */
const host = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\])$/;

export function validMailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && address.test(value);
}

export function validMailHost(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && host.test(value) && !value.includes('..');
}

export function validMailPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

/** The security a port means, when the owner did not say. */
export function securityOfPort(port: number, kind: 'imap' | 'smtp'): string {
  if (kind === 'imap') return port === 993 ? 'tls' : port === 143 ? 'starttls' : 'none';
  return port === 465 ? 'tls' : port === 587 ? 'starttls' : 'none';
}
