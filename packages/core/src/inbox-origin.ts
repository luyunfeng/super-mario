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
  if (result.connector === '飞书' && input.feishuFile === true) result.feishuFile = true;
  if (result.connector === '飞书' && input.meetingMinutes === true) result.meetingMinutes = true;
  if (result.connector === '飞书' && input.feishuLocation !== undefined) {
    const location = input.feishuLocation as Record<string, unknown> | null;
    if (!location || (location.host !== 'applink.feishu.cn' && location.host !== 'applink.larksuite.com') ||
        typeof location.position !== 'string' || !/^\d{1,16}$/.test(location.position) ||
        (location.threadId !== undefined && (typeof location.threadId !== 'string' || !/^omt_[\w-]+$/.test(location.threadId)))) return fail();
    result.feishuLocation = {host:location.host, position:location.position, ...(typeof location.threadId === 'string' && {threadId:location.threadId})};
  }
  if (input.mentionedMe !== undefined) {
    if (typeof input.mentionedMe !== 'boolean') return fail();
    if (result.kind === 'group') result.mentionedMe = input.mentionedMe;
  }
  if (input.github !== undefined) {
    const github = input.github as Record<string, unknown> | null;
    if (result.connector !== 'GitHub' || !github || typeof github.repository !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(github.repository) ||
        typeof github.number !== 'number' || !Number.isSafeInteger(github.number) || github.number < 1 ||
        (github.kind !== 'issues' && github.kind !== 'pull')) return fail();
    result.github = { repository: github.repository, number: github.number, kind: github.kind };
  }
  if (input.githubCi !== undefined) {
    const ci = input.githubCi as Record<string, unknown> | null;
    if (result.connector !== 'GitHub' || !ci || typeof ci.repository !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(ci.repository) ||
        typeof ci.branch !== 'string' || !ci.branch || ci.branch.length > 250 || /[\u0000-\u001f\u007f]/.test(ci.branch) ||
        typeof ci.workflow !== 'string' || !ci.workflow || ci.workflow.length > 200 ||
        (ci.pull !== undefined && (typeof ci.pull !== 'number' || !Number.isSafeInteger(ci.pull) || ci.pull < 1))) return fail();
    result.githubCi = { repository: ci.repository, branch: ci.branch, workflow: ci.workflow, ...(typeof ci.pull === 'number' ? { pull: ci.pull } : {}) };
  }
  if (result.kind === 'group' && result.connector === '飞书' && input.personalGroupUserCount !== undefined) {
    const count = input.personalGroupUserCount;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return fail();
    result.personalGroupUserCount = count;
  }
  if (result.kind === 'group' && result.connector === '飞书' && input.personalGroupObserved === true) result.personalGroupObserved = true;
  return result;
}
