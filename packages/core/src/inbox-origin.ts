import type { InboxOrigin } from '../../protocol/src/inbox-origin.ts';

/** Shared by personal intake and robot mail. Missing legacy provenance stays unknown. */
export function normalizeInboxOrigin(value: unknown): InboxOrigin | undefined {
  if (value === undefined) return;
  const fail = (): never => { throw Object.assign(new Error('消息来源格式无效'), { status: 400 }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  if (!['direct', 'group', 'agent', 'unknown'].includes(String(input.kind))) return fail();
  const result: InboxOrigin = { kind: input.kind as InboxOrigin['kind'] };
  for (const key of ['connector', 'chatId', 'chatName', 'senderName', 'senderId', 'senderIdType'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || input[key].length > 1000 || input[key].includes('\0')) return fail();
    if (input[key].trim()) result[key] = input[key].trim();
  }
  if (input.mentionedMe !== undefined) {
    if (typeof input.mentionedMe !== 'boolean') return fail();
    if (result.kind === 'group') result.mentionedMe = input.mentionedMe;
  }
  if (result.kind === 'group' && result.connector === '飞书' && input.personalGroupUserCount !== undefined) {
    const count = input.personalGroupUserCount;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return fail();
    result.personalGroupUserCount = count;
  }
  if (result.kind === 'group' && result.connector === '飞书' && input.personalGroupObserved === true) result.personalGroupObserved = true;
  return result;
}
