import { chatDirectory } from './feishu-scope-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuIntegration } from '../plugins/feishu.ts';

// Official CLI v1.0.74 shortcuts/im/convert_lib/content_convert.go:
// sender is preserved; parent_id becomes reply_to only without thread_id.
// sender.id_type is the native IM message contract, NOT sender_type or name.
const rawRow = (message_id: string, extra = {}) => ({
  message_id, chat_id: 'oc_chat', msg_type: 'text', chat_type: 'group',
  create_time: '2026-11-17T00:00:00Z', content: '请回复', chat_name: '测试群',
  sender: { id: 'ou_other', id_type: 'open_id', sender_type: 'user', name: '我' },
  updated: false, deleted: false, ...extra,
});
async function collect(messages: unknown[]) {
  const adapter = createFeishuIntegration({ appId: 'cli_0123456789abcdef', appSecret: '', profile: 'offline', personalOpenId: 'ou_me',
    onMessage: async () => {}, onInbox: async () => {},
    runCLI: async args => chatDirectory(args, ['oc_chat']) ?? ({ ok: true, identity: 'user', data: { messages, has_more: false } }),
  });
  try { return await adapter.collectBatch(); } finally { await adapter.close(); }
}

test('raw CLI hits: own outgoing metadata is independent of inbox, bounded and stably deduplicated across lanes', async () => {
  const own = rawRow('om_own', { sender: { id: 'ou_me', id_type: 'open_id', sender_type: 'user', name: '对方' },
    content: '私'.repeat(400), chat_name: '群'.repeat(300) });
  const reply = rawRow('om_reply', { reply_to: 'om_own' });
  const first = await collect([own, reply, own]);
  const second = await collect([own, reply, own]);
  assert.deepEqual(first.evidence, second.evidence);
  assert.deepEqual(first.evidence?.map(row => row.messageId), ['om_own', 'om_reply']);
  assert.equal(first.items.length, 1);
  assert.ok(!JSON.stringify(first.items).includes('私'));
  assert.equal(first.evidence![0]!.preview, '私'.repeat(160));
  assert.equal(first.evidence![0]!.label?.length, 160);
  assert.deepEqual(first.evidence![1], {
    source: 'feishu:cli_0123456789abcdef:ou_me', chatId: 'oc_chat', messageId: 'om_reply',
    senderId: 'ou_other', senderIdType: 'open_id', createdAt: '2026-11-17T00:00:00.000Z',
    parentId: 'om_own', edited: false, deleted: false, label: '测试群', preview: '请回复',
  });
});

test('only explicit reply fields map; thread/root/text/update_time cannot fabricate direct parent or edit', async () => {
  const batch = await collect([
    rawRow('om_thread', { thread_id: 'omt_thread', content: '回复 om_own', update_time: '2026-11-17T01:00:00Z' }),
    rawRow('om_native', { parent_id: 'om_direct', root_id: 'om_root', thread_id: 'omt_thread', updated: true, deleted: true }),
    rawRow('om_plain', { updated: undefined, last: 'om_fake', origin: { senderId: 'ou_fake' } }),
  ]);
  const [thread, native, plain] = batch.evidence!;
  assert.equal(thread!.threadId, 'omt_thread'); assert.equal(thread!.parentId, undefined);
  assert.equal(thread!.rootId, undefined); assert.equal(thread!.edited, false);
  assert.equal(native!.parentId, 'om_direct'); assert.equal(native!.rootId, 'om_root');
  assert.equal(native!.edited, true); assert.equal(native!.deleted, true);
  assert.equal(plain!.parentId, undefined); assert.equal(plain!.edited, undefined);
  assert.equal(plain!.senderId, 'ou_other');
});

test('missing identity type, sender, ids or creation time skips incomplete evidence without guessing', async () => {
  const batch = await collect([
    rawRow('om_no_type', { sender: { id: 'ou_me', sender_type: 'user', name: 'open_id' } }),
    rawRow('om_no_sender', { sender: { id_type: 'open_id' } }),
    rawRow('', {}), rawRow('om_no_chat', { chat_id: '' }),
    rawRow('om_no_time', { create_time: undefined }),
    rawRow('om_valid'),
  ]);
  assert.deepEqual(batch.evidence?.map(row => row.messageId), ['om_valid']);
  // Existing inbox behavior for incoming messages remains available without evidence.
  assert.ok(batch.items.some(row => row.thread.includes('om_no_sender')));
});
