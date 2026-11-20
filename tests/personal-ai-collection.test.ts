import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuIntegration } from '../plugins/feishu.ts';
import { createPersonalMessages } from '../apps/server/src/feishu-personal.ts';
import type { PersonalAccount, PersonalProvider } from '../plugins/feishu-personal.ts';

const account: PersonalAccount = { profile: 'offline', appId: 'cli_offline', openId: 'ou_self', name: '测试' };
const long = '/ai ' + '完整原文'.repeat(150);
const at = '2026-11-17T12:00:00.000Z';
function row(id: string, chat: string, extra = {}) {
  return { chat_id: chat, message_id: id, msg_type: 'text', content: long, create_time: at,
    sender: { id: 'ou_self', id_type: 'open_id', sender_type: 'user' }, ...extra };
}
const groupIds = ['oc_small', 'oc_large', 'oc_unknown', 'oc_muted'];

for (const limit of [undefined, 3]) {
  test('AI projection keeps original text, owner and verified chat scope, page limit ' + limit, async t => {
    const adapter = createFeishuIntegration({ ...account, personalOpenId: account.openId, appSecret: '', personalCollectionPageLimit: limit,
      async onMessage() {}, async onInbox() {},
      async personalChatDetail(chatId) {
        if (chatId === 'oc_verified') return { mode: 'p2p' };
        return { mode: 'group', userCount: ({ oc_small: 50, oc_large: 51 } as Record<string, number>)[chatId] };
      },
      async runCLI(args) {
        let data;
        if (args.includes('+chat-list')) data = { chats: groupIds.map(chat_id => ({ chat_id })), has_more: false };
        else if (args.includes('batch_query')) data = { items: groupIds.map(chat_id => ({ chat_id, is_muted: chat_id === 'oc_muted' })) };
        else {
          assert.ok(args.includes('+messages-search'));
          const messages = args.includes('p2p') ? [
            row('om_dm', 'oc_direct', { chat_type: 'p2p', root_id: 'om_root', thread_id: 'omt_thread', reply_to: 'om_parent' }),
            row('om_peer', 'oc_verified', { sender: { id: 'ou_peer', id_type: 'open_id' } }),
            row('om_no_mode', 'oc_unknown'), row('om_edit', 'oc_direct', { chat_type: 'p2p', updated: true }),
            row('om_deleted', 'oc_direct', { chat_type: 'p2p', deleted: true }), row('om_bot', 'oc_direct', {
              chat_type: 'p2p', sender: { id: 'ou_bot', id_type: 'open_id', sender_type: 'app' } }),
            row('om_card', 'oc_direct', { chat_type: 'p2p', msg_type: 'interactive' }),
          ] : groupIds.map(chat => row('om_' + chat, chat, { chat_type: 'group' }));
          data = { messages, has_more: false };
        }
        return { ok: true, identity: 'user', data };
      } });
    t.after(() => adapter.close());
    const batch = await adapter.collectBatch();
    assert.deepEqual(batch.aiMessages?.map(m => m.messageId), ['om_dm', 'om_peer', 'om_oc_small']);
    assert.deepEqual(batch.aiMessages[0], { chatId: 'oc_direct', messageId: 'om_dm', text: long, createdAt: at, kind: 'direct',
      senderId: account.openId, senderIdType: 'open_id', threadId: 'omt_thread', rootId: 'om_root' });
    assert.equal(batch.aiMessages[2]?.groupUserCount, 50);
    assert.equal(batch.aiMessages[2]?.groupObserved, true);
    const anchor = batch.evidence?.find(m => m.messageId === 'om_dm');
    assert.equal(anchor?.parentId, 'om_parent');
    assert.equal(anchor?.preview?.length, 160);
    assert.ok(batch.items.some(m => m.last === 'om_peer'));
    assert.ok(!batch.items.some(m => m.last === 'om_dm'));
  });
}

for (const scenario of ['success', 'ingest fails', 'cancel during ingest', 'wrong account', 'observer fails', 'restart before write']) {
  test('personal observer admission and checkpoint: ' + scenario, async t => {
    const calls: string[] = [];
    const observations: string[][] = [];
    const deferredWrites: (() => void)[] = [];
    const writes: number[] = [];
    const dataDir = await mkdtemp(join(tmpdir(), 'personal-ai-'));
    const provider: PersonalProvider = { async application() { return account; }, async begin() { return { url: 'https://example.invalid', code: 'test', expiresIn: 60 }; },
      async complete() { return account; }, async verify() { return account; }, async collect() { return []; },
      async collectBatch() { return { items: [], evidence: [], hasMore: false, aiMessages: [{
        text: long, senderId: account.openId, senderIdType: 'open_id', messageId: 'om_dm', chatId: 'oc_dm', kind: 'direct', createdAt: at }],
        checkpoint: { version: 1, binding: { ...account, openId: scenario === 'wrong account' ? 'ou_wrong' : account.openId }, pages: 1, lastCompletedThrough: at } }; } };
    const service = createPersonalMessages({ config: { host: '127.0.0.1', port: 0, dataDir, demo: true }, provider, canCollect: () => true,
      async ingest() { calls.push('ingest'); if (scenario === 'cancel during ingest') service.cancel(); if (scenario === 'ingest fails') throw Error('offline'); },
      async observeAi(source, messages, assertCurrent) { calls.push('ai'); observations.push([source, messages[0]!.text]);
        if (scenario === 'restart before write') {
          const round = observations.length;
          deferredWrites.push(() => { assertCurrent(); writes.push(round); });
        }
        if (scenario === 'observer fails') throw Error('offline'); } });
    t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
    service.authorize();
    await t.waitFor(() => assert.equal(service.status().status, 'connected'));
    await service.enable(true);
    await t.waitFor(() => assert.equal(service.status().collecting, false));
    if (scenario === 'restart before write') {
      await service.enable(false);
      await service.enable(true);
      await t.waitFor(() => assert.equal(deferredWrites.length, 2));
      assert.throws(deferredWrites[0]!, /采集已停止/);
      deferredWrites[1]!();
      assert.deepEqual(writes, [2]);
    } else if (scenario === 'success' || scenario === 'observer fails') {
      assert.deepEqual(observations, [['feishu:cli_offline:ou_self', long]]);
      assert.deepEqual(calls, ['ingest', 'ai']); assert.equal(service.status().lastCompletedThrough, at); assert.equal(service.status().enabled, true);
      if (scenario === 'observer fails') assert.match(service.status().error!, /AI/);
    } else {
      assert.deepEqual(calls, scenario === 'wrong account' ? [] : ['ingest']); assert.equal(service.status().lastCompletedThrough, undefined);
    }
  });
}

for (const pollMs of [undefined, 750]) {
  test('rescheduling keeps one poll timer and preserves pending pages, pollMs=' + pollMs, async t => {
    const dataDir = await mkdtemp(join(tmpdir(), 'personal-ai-poll-'));
    let reads = 0, aiEnabled = false;
    const service = createPersonalMessages({
      config: { host: '127.0.0.1', port: 0, dataDir, demo: true }, pollMs, aiEnabled: () => aiEnabled,
      canCollect: () => true, async ingest() {},
      provider: { async application() { return account; }, async begin() { return { url: 'https://example.invalid', code: 'test', expiresIn: 60 }; },
        async complete() { return account; }, async verify() { return account; }, async collect() { return []; },
        async collectBatch(_account, _signal, checkpoint) {
          const next = structuredClone(checkpoint!);
          next.pages = ++reads;
          if (reads > 1) delete next.window;
          return { items: [], checkpoint: next, hasMore: !!next.window };
        } },
    });
    t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
    service.authorize();
    await t.waitFor(() => assert.equal(service.status().status, 'connected'));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const advance = async (ms: number, expected: number) => {
      t.mock.timers.tick(ms);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(reads, expected);
    };
    await service.enable(true);
    await advance(0, 1);
    aiEnabled = true;
    service.reschedule();
    await advance(249, 1);
    await advance(1, 2);
    await advance((pollMs ?? 30_000) - 1, 2);
    await advance(1, 3);
    aiEnabled = false;
    service.reschedule();
    await advance((pollMs ?? 120_000) - 1, 3);
    await advance(1, 4);
    aiEnabled = true;
    service.reschedule();
    await advance((pollMs ?? 30_000) - 1, 4);
    await advance(1, 5);
    await service.enable(false);
    service.reschedule();
    await advance(120_000, 5);
  });
}
