type Row = Record<string, unknown>;
type Read = (args: string[]) => Promise<Row>;
export type SearchLane = { done: boolean; token?: string; seen: string[]; restarted?: boolean; chatIds?: string[]; mentions?: boolean };
export const validChatId = (value: unknown): value is string => typeof value === 'string' && /^oc_[a-zA-Z0-9_]+$/.test(value);
const batchSize = 10;

function chunks(ids: string[]) {
  const groups: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) groups.push(ids.slice(i, i + batchSize));
  return groups;
}

// +chat-list --exclude-muted retains unknown statuses. Only the current user's
// explicit boolean in batch_query is affirmative evidence, scoped to this read.
export async function unmutedIds(ids: string[], read: Read): Promise<string[]> {
  const allowed: string[] = [];
  for (const chat_ids of chunks(ids)) {
    const data = await read(['chat.user_setting', 'batch_query', '--data', JSON.stringify({ chat_ids })]);
    if (!Array.isArray(data.items) || (data.invalid_ids !== undefined && !Array.isArray(data.invalid_ids))) throw new Error('群通知设置响应无效');
    const seen = new Set<string>(), denied = new Set<string>();
    for (const row of data.items) {
      if (!row || !chat_ids.includes(row.chat_id)) continue;
      if (seen.has(row.chat_id) || row.is_muted !== false) denied.add(row.chat_id);
      seen.add(row.chat_id);
    }
    for (const row of data.invalid_ids ?? []) denied.add(row?.id);
    allowed.push(...chat_ids.filter(id => seen.has(id) && !denied.has(id)));
  }
  return allowed;
}

export async function allowedPersonalChats(read: Read): Promise<string[]> {
  const ids = new Set<string>(), tokens = new Set<string>();
  let token: string | undefined;
  do {
    const page = await read(['+chat-list', '--types', 'group', '--exclude-muted', '--page-size', '100', ...(token ? ['--page-token', token] : [])]);
    if (!Array.isArray(page.chats) || typeof page.has_more !== 'boolean') throw new Error('个人群名单分页无效');
    for (const chat of page.chats) if (validChatId(chat?.chat_id) && chat.chat_mode !== 'p2p') ids.add(chat.chat_id);
    if (!page.has_more) break;
    if (typeof page.page_token !== 'string' || !page.page_token || tokens.has(page.page_token)) throw new Error('个人群名单缺少下一游标或游标循环');
    token = page.page_token;
    tokens.add(token);
  } while (token);
  return unmutedIds([...ids].sort(), read);
}

// A token belongs to its exact search (including ordered IDs and mention flag).
// Pre-filter checkpoints only have a compatible private lane at position zero.
export function scopedLanes(ids: string[], previous: SearchLane[] = []): SearchLane[] {
  const lanes: SearchLane[] = [previous[0] ?? { done: false, seen: [] }];
  const saved = new Map(previous.slice(1).filter(lane => lane.chatIds).map(lane => [JSON.stringify([lane.chatIds, lane.mentions]), lane]));
  for (const chatIds of chunks(ids)) {
    for (const mentions of [true, false]) {
      lanes.push(saved.get(JSON.stringify([chatIds, mentions])) ?? { done: false, seen: [], chatIds, mentions });
    }
  }
  return lanes;
}

export function searchFilter(lane: SearchLane): string[] {
  return lane.chatIds ? ['--chat-type', 'group', '--chat-id', lane.chatIds.join(','), ...(lane.mentions ? ['--is-at-me'] : [])] : ['--chat-type', 'p2p'];
}
