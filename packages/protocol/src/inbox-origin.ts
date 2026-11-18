/** Display provenance supplied by a connector, never an execution grant. */
export interface InboxOrigin {
  kind: 'direct' | 'group' | 'agent' | 'unknown';
  connector?: string;
  chatId?: string;
  chatName?: string;
  senderName?: string;
  /** Exact personal-account mention evidence; a bot mention does not imply this. */
  mentionedMe?: boolean;
}
