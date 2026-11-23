import assert from 'node:assert/strict';
import test from 'node:test';
import { botConversationId } from '../packages/core/src/bot-agent-routing.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import { privateThreadPage, readPrivateThreadHistory } from '../apps/server/src/feishu-thread-history.ts';

test('独立对话记录按可见发言分页，排除其他配对、群组、协作回流和未知游标', () => {
  const row = { threadId: 'a'.repeat(64), botId: 'a', appId: 'app', revision: 3, chatId: 'chat', senderId: 'owner', createdAt: '2026-01-01' };
  const conversationId = botConversationId({ id: row.botId, scope: { kind: 'global' } }, row.threadId);
  const messages: Message[] = [], routes = new Map<string, unknown>();
  for (let i = 0; i < 48; i++) {
    const id = String(i);
    messages.push({ id, role: 'user', conversationId, createdAt: new Date(i).toISOString(), text: '发言 ' + i });
    routes.set(id, { channel: 'feishu', accountId: 'app', botId: 'a', target: 'chat', privateSenderId: 'owner',
      conversationThreadId: row.threadId, revision: 3, ...[{ privateSenderId: 'other' }, { group: {} }, { relay: {} }, { revision: 2 }][i] });
  }
  const store = { list<T>() { return messages as T[]; }, get<T>(_type: string, id: string) { return routes.get(id) as T | undefined; } };
  const rows = readPrivateThreadHistory(store, [row, { ...row, threadId: 'b'.repeat(64) }]);
  assert.deepEqual(rows, [{ threadId: row.threadId, title: '发言 4', latestAt: messages.at(-1)!.createdAt, count: 44 }]);
  const recent = privateThreadPage(store, row, null);
  assert.equal(recent.messages.length, 40);
  assert.equal(recent.nextBefore, '8');
  const earlier = privateThreadPage(store, row, recent.nextBefore);
  assert.deepEqual(earlier.messages.map(item => item.text), ['发言 4', '发言 5', '发言 6', '发言 7']);
  assert.equal(earlier.nextBefore, null);
  assert.throws(() => privateThreadPage(store, row, '3'), { status: 409 });
});
