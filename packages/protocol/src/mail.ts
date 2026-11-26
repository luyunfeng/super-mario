/** A mail account as the owner sees it. The password is never part of this. */
export interface MailAccount {
  id: string;
  name: string;
  email: string;
  /** How it signs in: with a password, or with a code the provider issued for mail clients. */
  auth: 'password';
  username: string;
  imapHost: string;
  imapPort: number;
  /** tls | starttls | none. Empty means derived from the port. */
  imapSecurity: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: string;
  /** Whether the last check succeeded, and what went wrong if it did not. */
  status: 'unknown' | 'ok' | 'error';
  error?: string;
  /** The password is on record. Said so the page can tell "set" from "not set". */
  hasPassword: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** What the owner sends to add or change an account. */
export interface MailAccountInput {
  name?: string;
  email: string;
  username?: string;
  /** Left out when the account is changed and the password stays as it is. */
  password?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecurity?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: string;
}

/** The well-known servers of one mail domain, and where its sign-in code is made. */
export interface MailPreset {
  provider: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: string;
  /** Where the owner makes the code that mail clients sign in with, when the account's own password does not work. */
  codeSite?: string;
}

/** A mail address as the owner reads it. */
export interface MailAddress { name: string; email: string }

/** A folder of one account, with its role and counters. */
export interface Mailbox {
  name: string;
  /** The usual folders are named. Any other folder is "other", and is not read as the inbox. */
  role: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'other';
  unseen: number;
  total: number;
}

/** One message in a list. The body is not part of it. */
export interface MailSummary {
  account: string;
  mailbox: string;
  uid: number;
  messageId: string;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  /** An ISO instant, or empty when the date header could not be read. */
  date: string;
  hasAttachments: boolean;
  seen: boolean;
  answered: boolean;
  flagged: boolean;
}

/** An attachment of a message, as far as it is known without reading the message. */
export interface MailAttachment {
  /** What names the attachment when it is saved: its place in the message and what it is. */
  id: string;
  filename: string;
  mimeType: string;
  /** How many bytes it takes up once decoded, when the server says. */
  size: number;
  /** The part of the message it is, for fetching it on its own. */
  part: string;
}

/** One message in full. Reading it does not mark it as read. */
export interface MailMessage extends MailSummary {
  cc: MailAddress[];
  /** The Message-IDs this one answers, and the chain it belongs to, for replying in turn. */
  inReplyTo: string;
  references: string[];
  text: string;
  html: string;
  /** True when the message is larger than one read takes. The text is empty then. */
  tooLarge: boolean;
  attachments: MailAttachment[];
}
