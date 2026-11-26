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

/** What one search of the mail is asked for. */
export interface SearchRequest {
  /** The account to search. Every account's inbox is searched when it is left out. */
  account?: string;
  /** The folder to search. The inbox when left out. */
  mailbox?: string;
  query?: string;
  /** How many matches one page holds at most. */
  limit?: number;
  /** Continue from below this UID. */
  beforeUid?: number;
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
  /** The first words of the body, for a list. Empty when the body was not read for it. */
  snippet?: string;
}

/** An attachment of a message, as far as it is known without reading the message. */
export interface MailAttachment {
  /** What names the attachment when it is saved. It is worked out from the attachment's
   *  place in the message and from its bytes, and is only meaningful for that message. */
  id: string;
  filename: string;
  mimeType: string;
  /** How many bytes it takes up once decoded. */
  size: number;
}

/** One message in full. Reading it does not mark it as read. */
export interface MailMessage extends MailSummary {
  cc: MailAddress[];
  /** The Message-IDs this one answers, and the chain it belongs to, for replying in turn. */
  inReplyTo: string;
  references: string[];
  /** Plain text, or the HTML as plain words when the message has no text part. */
  text: string;
  html: string;
  /** True when the text was longer than one read gives and only its beginning is here. */
  textTruncated: boolean;
  attachments: MailAttachment[];
  /** How many attachments the message has. More than are listed when there are very many. */
  attachmentCount: number;
}

/** Whether the mail of the owner's mailboxes goes into the inbox, and which folders. */
export interface MailConnectorState {
  enabled: boolean;
  /** The folders whose mail goes into the inbox. The inbox of every account when empty. */
  folders?: string[];
  lastRunAt?: string;
  lastError?: string;
  /** Mailboxes that could not be read on the last run, so the owner knows the inbox is
   *  behind for them. Their mail is not taken for gone. */
  failed?: Array<{ id: string; name: string }>;
  /** The folders of a usual kind that the last read found in each mailbox, so that the
   *  owner can choose which of them mail comes from. */
  mailboxes?: Array<{ account: string; name: string }>;
}

/** The service the mail connector offers that reads the mailboxes now. Named as a plugin's
 *  service must be: the plugin's id, a dot, and the service's own name. */
export const MAIL_POLL_SERVICE = 'mail-connector.poll';

/** What one read of a mailbox found. */
/** What one read of a mailbox found, for the inbox. */
export interface MailInboxRead {
  account: { id: string; name: string; email: string };
  mailboxes: Mailbox[];
  messages: MailSummary[];
}

