/** Display provenance supplied by a connector, never an execution grant. */
export interface InboxOrigin {
  kind: 'direct' | 'group' | 'agent' | 'unknown';
  connector?: string;
  chatId?: string;
  chatName?: string;
  /** Connector reported an ordinary file message; its body requires a separate authorized read. */
  feishuFile?: true;
  /** Position from this message's connector-provided deep link. */
  feishuLocation?: { host: 'applink.feishu.cn' | 'applink.larksuite.com'; position: string; threadId?: string };
  senderName?: string;
  /** Recognized Feishu meeting minutes bot, for read-only analysis priority. */
  meetingMinutes?: true;
  senderId?: string;
  senderIdType?: string;
  /** Exact personal-account mention evidence; a bot mention does not imply this. */
  mentionedMe?: boolean;
  /** Feishu personal collection only. Verified chat user_count, excluding bots. */
  personalGroupUserCount?: number;
  /** Collected via a group-ID restricted search after checking personal mute state. */
  personalGroupObserved?: true;
  /** A GitHub notification of one pull request or issue. The link is built from this, never
   *  taken from the API, so it always points at github.com/<repository>/<kind>/<number>. */
  github?: { repository: string; number: number; kind: 'issues' | 'pull' };
}

export function excludesPersonalGroupFromAutomation(origin?: InboxOrigin): boolean {
  return origin?.kind === 'group' && origin.connector === '飞书' && origin.personalGroupUserCount !== undefined && origin.personalGroupUserCount > 50;
}

/** Personal group rows written before mute-aware collection stay available in history. */
export function excludesPersonalGroupFromBrief(item: { source: string; origin?: InboxOrigin }): boolean {
  return excludesPersonalGroupFromAutomation(item.origin) || (item.source.startsWith('feishu:') &&
    item.origin?.kind === 'group' && item.origin.connector === '飞书' && item.origin.personalGroupObserved !== true);
}
