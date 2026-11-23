import type { PersonalCLI } from './feishu-personal.ts';

export type GroupReadRange = { limit: number; start?: string; end?: string; sender?: string; expanded: boolean };
export type GroupReadRow = { id: string; at: string; sender: string; text: string };

function messageTime(value: unknown) {
  const timestamp = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))
    ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

/** The platform event supplies both destinations. The model may narrow time/count but never choose a chat. */
export async function readGroupHistory(input: {
  profile: string; chatId: string; threadId?: string; range: GroupReadRange; signal: AbortSignal;
  cli: PersonalCLI; check: () => Promise<void>;
}) {
  const { range, threadId, chatId } = input;
  const rows = new Map<string, GroupReadRow>();
  const notes: string[] = [];
  let scanned = 0;
  function stream(topic: boolean) {
    let cursor = '';
    const seen = new Set<string>();
    const lane = topic ? '话题' : '群';
    return async (size: number): Promise<boolean> => {
      await input.check();
      const selector = topic ? ['+threads-messages-list', '--thread', threadId!]
        : ['+chat-messages-list', '--chat-id', chatId, ...(range.start ? ['--start', range.start] : []), ...(range.end ? ['--end', range.end] : [])];
      let page;
      try {
        page = await input.cli(['--profile', input.profile, '--as', 'user', 'im', ...selector,
          '--order', 'desc', '--page-size', String(size), '--no-reactions', ...(cursor ? ['--page-token', cursor] : [])], { signal: input.signal });
      } catch { notes.push(lane + '消息读取失败'); return false; }
      await input.check();
      if (page.ok !== true || page.identity !== 'user' || !Array.isArray(page.data?.messages)) {
        notes.push(lane + '消息读取结果无法核实'); return false;
      }
      const messages = page.data.messages;
      if (messages.length > size) { notes.push(lane + '消息分页响应超过请求范围'); return false; }
      scanned += messages.length;
      let beforeWindow = false;
      for (const m of messages) {
        if (!m || m.deleted || (m.chat_id && m.chat_id !== chatId) || (topic && m.thread_id && m.thread_id !== threadId)
          || typeof m.message_id !== 'string' || typeof m.content !== 'string') continue;
        const at = messageTime(m.create_time);
        if (!at) { notes.push('有消息缺少可核实的时间'); continue; }
        if (range.start && at < range.start) { beforeWindow = true; continue; }
        if (range.end && at > range.end) continue;
        if (range.sender && ![m.sender?.name, m.sender?.id].includes(range.sender)) continue;
        rows.set(m.message_id, { id: m.message_id, at, sender: String(m.sender?.name || m.sender?.id || '未知成员'), text: m.content });
      }
      if (beforeWindow || page.data.has_more === false || page.meta?.pagination?.complete === true) return false;
      if (page.data.has_more !== true && page.meta?.pagination?.complete !== false) { notes.push(lane + '分页结束状态未知'); return false; }
      cursor = page.data.page_token;
      if (!messages.length || typeof cursor !== 'string' || !cursor || seen.has(cursor)) { notes.push(lane + '消息缺少可继续的分页位置'); return false; }
      seen.add(cursor);
      return true;
    };
  }
  const group = stream(false), topic = threadId ? stream(true) : undefined;
  if (!range.expanded) {
    await group(40);
    if (topic) await topic(50);
  } else {
    let groupMore = true, topicMore = !!topic;
    // Alternate pages so either lane can use unspent capacity from the other.
    while (scanned < range.limit && (groupMore || topicMore)) {
      if (groupMore) {
        const available = range.limit - scanned;
        groupMore = await group(Math.min(50, topicMore ? Math.ceil(available / 2) : available));
      }
      if (topic && topicMore && scanned < range.limit) topicMore = await topic(Math.min(50, range.limit - scanned));
    }
    if (groupMore || topicMore) notes.push('已达到本次读取条数，可能还有更早消息');
  }
  await input.check();
  return { rows: [...rows.values()].sort((a, b) => a.at.localeCompare(b.at)), notes: [...new Set(notes)], scanned };
}
