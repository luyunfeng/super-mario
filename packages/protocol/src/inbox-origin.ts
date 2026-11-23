/** Display provenance supplied by a connector, never an execution grant. */
export interface InboxOrigin {
  kind: 'direct' | 'group' | 'agent' | 'unknown';
  connector?: string;
  chatId?: string;
  chatName?: string;
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
}

export function excludesPersonalGroupFromAutomation(origin?: InboxOrigin): boolean {
  return origin?.kind === 'group' && origin.connector === '飞书' && origin.personalGroupUserCount !== undefined && origin.personalGroupUserCount > 50;
}

/** Personal group rows written before mute-aware collection stay available in history. */
export function excludesPersonalGroupFromBrief(item: { source: string; origin?: InboxOrigin }): boolean {
  return excludesPersonalGroupFromAutomation(item.origin) || (item.source.startsWith('feishu:') &&
    item.origin?.kind === 'group' && item.origin.connector === '飞书' && item.origin.personalGroupObserved !== true);
}
