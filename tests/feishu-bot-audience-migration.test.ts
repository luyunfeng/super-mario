import assert from 'node:assert/strict';
import test from 'node:test';
import { mailboxEntryId } from '../packages/core/src/event-mailboxes.ts';
import { createStore } from '../packages/core/src/store.ts';
import { feishuAudienceHistory } from '../packages/core/src/agent-runtime/feishu-audience.ts';
import type { MailboxEntry, Message } from '../packages/protocol/src/index.ts';

test('旧 SQLite 路由只恢复切换时同一受众核实的收件和已实际送达的回答', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const botId = 'fixture-bot', accountId = 'fixture-app', revision = 7, generation = 'same-binding';
  const chatId = 'oc_dm', senderId = 'ou_owner', conversationId = 'fixture-conversation';
  const cutover = { generation, revision, appId: accountId, chatId, senderId };
  store.put('settings', 'feishu.bot.owner:' + botId + ':' + accountId, { chatId, senderId });
  store.put('feishu.group-read.generation', botId, generation);
  store.put('feishu.audience.cutover', botId, cutover);
  const history = feishuAudienceHistory(store, botId, conversationId);
  const scope = { kind: 'global' } as const;
  function seed(id: string, options: { rev?: number; routeTarget?: string; inboxTarget?: string; generation?: string; receivedId?: string;
    inboxStatus?: MailboxEntry['status']; pending?: boolean } = {}) {
    const target = options.routeTarget ?? chatId;
    const input: Message = { id, conversationId, role: 'user', text: '发言-' + id,
      status: options.pending ? 'pending' : 'done', createdAt: '2026-01-01T00:00:00Z' };
    const mail: MailboxEntry = { id: 'box-' + id, version: 2, botId, scope, eventKey: 'feishu-in:om_' + id,
      sourceMessageId: 'om_' + id, title: '合成来源', text: input.text, target: options.inboxTarget ?? target,
      direction: 'inbox', requiresConfirmation: false, status: options.inboxStatus ?? 'completed',
      resultId: id, createdAt: input.createdAt, updatedAt: input.createdAt };
    const route = { channel: 'feishu', botId, accountId, revision: options.rev ?? revision, target, scope, inputId: id,
      envelopeId: mail.id, sourceMessageId: mail.sourceMessageId,
      ...(target === chatId ? { privateSenderId: senderId } : { group: { chatId: target, chatType: 'group', senderId, senderType: 'user' } }),
      ...(options.generation !== undefined ? { audienceGeneration: options.generation } : {}) };
    store.put('messages', id, input);
    store.put('message.routes', id, route);
    store.put('event.mailboxes', mail.id, mail);
    store.put('feishu.bot.dispatch', botId + ':' + accountId + ':' + mail.id, { status: 'completed', id: options.receivedId ?? id });
    return { input, mail, route };
  }
  const valid = seed('same-version');
  seed('old-version', { rev: revision - 1 });
  seed('another-chat', { routeTarget: 'oc_other' });
  seed('wrong-envelope-target', { inboxTarget: 'oc_other' });
  seed('wrong-receipt-id', { receivedId: 'unrelated-input' });
  const wrongText = seed('wrong-envelope-content');
  store.put('event.mailboxes', wrongText.mail.id, { ...wrongText.mail, text: '已被替换的用户正文' });
  seed('unconfirmed-envelope', { inboxStatus: 'processing' });
  function reply(id: string, changes: Partial<MailboxEntry> = {}) {
    const assistant: Message = { ...valid.input, id, text: '回答-' + id, role: 'assistant', replyTo: valid.input.id };
    const eventKey = 'feishu-reply:' + JSON.stringify([botId, accountId, valid.input.id, assistant.id]);
    const outbox: MailboxEntry = { ...valid.mail, id: mailboxEntryId(botId, 'outbox', eventKey), direction: 'outbox', text: assistant.text, replyTo: valid.input.id,
      eventKey, ...changes };
    store.put('messages', id, assistant); store.put('event.mailboxes', outbox.id, outbox);
  }
  reply('delivered'); reply('awaiting', { status: 'unknown' }); reply('wrong-target', { target: 'oc_other' });
  reply('wrong-delivered-body', { text: '平台实际送达文本' });
  reply('wrong-reply', { replyTo: 'other-input' });
  const current = seed('current', { generation, pending: true });
  const currentAudience = () => history.forInput(current.input);
  const restored = () => history.legacyUtterances(currentAudience()).map(row => row.text);
  assert.deepEqual(restored(), [valid.input.text, '回答-delivered']);
  for (const alternate of [{ ...cutover, generation: 'last-binding' }, { ...cutover, revision: revision + 1 },
    { ...cutover, appId: 'other-app' }, { ...cutover, senderId: 'other-owner' }, { ...cutover, chatId: 'other-private-chat' }]) {
    store.put('feishu.audience.cutover', botId, alternate);
    assert.deepEqual(restored(), []);
  }
});
