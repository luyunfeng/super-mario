import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPersonalProvider, PERSONAL_MESSAGE_SCOPES } from '../plugins/feishu-personal.ts';
import type { PersonalCLI } from '../plugins/feishu-personal.ts';
import { preparePersonalCheckpoint } from '../plugins/feishu.ts';
import { createPersonalMessages } from '../apps/server/src/feishu-personal.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createInboxService } from '../packages/core/src/inbox.ts';

const account = { profile: 'review-local', appId: 'cli_0123456789abcdef', openId: 'ou_review', name: '本地替身' };
const envelope = (messages: unknown[] = [], data = {}) => ({ ok: true, identity: 'user', data: { messages, has_more: false, ...data } });
function providerWith(read: (args: string[]) => Record<string, any>) {
  const runCLI: PersonalCLI = async args => args.includes('status')
    ? { appId: account.appId, identity: 'user', verified: true, identities: { user: {
      available: true, openId: account.openId, scope: PERSONAL_MESSAGE_SCOPES.join(' '),
    } } } : read(args);
  return createPersonalProvider({ application: () => account, runCLI });
}

test('review: 同会话后续页的新命中必须进入真实收件箱，不能仅凭上下文末条去重', async t => {
  const store = createStore(':memory:');
  const inbox = createInboxService({ store, events: createEventBus(store), createTodo: () => { throw new Error('unused'); } });
  t.after(async () => { await inbox.close(); store.close(); });
  const message = (n: number) => ({ message_id: `om_${n}`, chat_id: 'oc_busy', chat_type: 'p2p',
    create_time: `2026-11-17T00:${String(n).padStart(2, '0')}:00Z`, content: n === 0 ? '请处理分页深处的请求' : `消息${n}`,
    sender: { id: 'ou_other' } });
  // 51 messages in one chat: the context endpoint supplies only the newest 50.
  const history = Array.from({ length: 50 }, (_, n) => message(n + 1));
  const provider = providerWith(args => {
    if (args.includes('+chat-messages-list')) return envelope(history);
    if (args.includes('--is-at-me')) return envelope();
    // Both p2p and unfiltered searches see the same private conversation.
    return args.includes('--page-token') ? envelope([message(0)])
      : envelope(history, { has_more: true, page_token: 'older' });
  });
  const first = await provider.collectBatch!(account, new AbortController().signal);
  await inbox.ingest('review', first.items);
  assert.doesNotMatch(inbox.list()[0]!.text, /om_0\]/);
  const second = await provider.collectBatch!(account, new AbortController().signal, first.checkpoint);
  assert.equal(second.hasMore, false);
  assert.ok(second.checkpoint.lastCompletedThrough);
  assert.match(second.items.find(item => item.last === 'om_0')!.text, /om_0\]/); // Search really delivered the missed message.
  await inbox.ingest('review', second.items);
  assert.match(inbox.list().find(item => item.last === 'om_0')!.text, /om_0\]/, '已推进完成水位，但后续页命中被真实 inbox 的 last 去重丢弃');
  assert.equal(inbox.list().length, 51);
  for (let n = 0; n <= 50; n++) assert.ok(inbox.list().some(item => item.last === `om_${n}`));
});

test('review: 达到seen上限的路线耗尽后，服务提交的断页记录仍须可重启', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mario-pagination-review-'));
  const directory = join(dataDir, 'private', 'feishu-personal');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'account.json');
  const checkpoint = preparePersonalCheckpoint(account);
  checkpoint.pages = 4098;
  checkpoint.window!.lanes[0] = { done: false, token: 'final-page', seen: Array.from({ length: 4096 }, (_, n) => `seen-${n}`) };
  checkpoint.window!.lanes[1] = { done: true, seen: [] };
  checkpoint.window!.lanes[2] = { done: false, token: 'general-current', seen: Array.from({ length: 4095 }, (_, n) => `general-${n}`) };
  writeFileSync(file, JSON.stringify({ account, enabled: true, checkpoint }));
  const provider = providerWith(args => args.includes('p2p') || args.includes('general-next') ? envelope()
    : envelope([], { has_more: true, page_token: 'general-next' }));
  const options = { config: { host: '127.0.0.1', port: 0, dataDir, demo: false }, provider,
    canCollect: () => true, ingest: async () => {} };
  const service = createPersonalMessages(options); // The input checkpoint passes the production validator.
  t.after(async () => { await service.close(); rmSync(dataDir, { recursive: true, force: true }); });
  service.start();
  for (let n = 0; n < 200 && service.status().collectionPages === 4098; n++) await delay(1);
  assert.equal(service.status().collectionPages, 4100);
  await service.close();
  const committed = JSON.parse(readFileSync(file, 'utf8')).checkpoint;
  assert.equal(committed.window.lanes[0].done, true);
  assert.equal(committed.window.lanes[0].seen.length, 0);
  assert.equal(committed.window.lanes[2].token, 'general-next');
  assert.equal(committed.window.lanes[2].seen.length, 4096);
  assert.equal(committed.window.start, checkpoint.window!.start);
  assert.equal(committed.window.end, checkpoint.window!.end);
  let resumed!: ReturnType<typeof createPersonalMessages>;
  assert.doesNotThrow(() => {
    resumed = createPersonalMessages(options);
    t.after(() => resumed.close());
  }, '生产采集提交了自身加载器拒绝的checkpoint，导致服务重启失败');
  resumed.start();
  for (let n = 0; n < 200 && !resumed.status().lastCompletedThrough; n++) await delay(1);
  assert.equal(resumed.status().lastCompletedThrough, checkpoint.window!.end);
  assert.equal(resumed.status().collectionPages, 4101);
});

test('review: 同会话三页125条请求经SQLite落盘、重扫后全部保留，旧聚合条目不变', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mario-pagination-inbox-'));
  const path = join(directory, 'inbox.sqlite');
  let store = createStore(path);
  const openInbox = () => createInboxService({ store, events: createEventBus(store), createTodo: () => { throw new Error('unused'); } });
  let inbox = openInbox();
  t.after(async () => { await inbox.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const messages = Array.from({ length: 126 }, (_, n) => ({
    message_id: `om_request_${n}`, chat_id: 'oc_same', chat_type: 'group', chat_name: '同一群',
    create_time: new Date(Date.parse('2026-11-17T00:00:00Z') + n * 1000).toISOString(),
    content: `请处理独立请求${n}`, sender: { id: n === 125 ? account.openId : 'ou_other', name: '对方' },
    mentions: n % 2 === 0 ? [{ id: { open_id: account.openId } }] : [],
  }));
  const provider = providerWith(args => {
    // Context deliberately contains an unrelated direct message and a mention.
    if (args.includes('+chat-messages-list')) return envelope([{ ...messages[124], message_id: 'unrelated', chat_type: 'p2p' }]);
    const page = args.includes('--page-token') ? Number(args[args.indexOf('--page-token') + 1]) : 0;
    return envelope(messages.slice(page * 50, (page + 1) * 50), page < 2 ? { has_more: true, page_token: String(page + 1) } : {});
  });
  const source = `feishu:${account.appId}:${account.openId}`;
  // The legacy entry and its identity remain readable when the paged provider is enabled.
  const legacy = await provider.collect(account, new AbortController().signal);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0]!.thread, 'feishu:oc_same:main');
  await inbox.ingest(source, legacy);
  const old = inbox.list()[0]!;
  for (let scan = 0; scan < 2; scan++) {
    let checkpoint = preparePersonalCheckpoint(account);
    for (let page = 0; page < 3; page++) {
      const batch = await provider.collectBatch!(account, new AbortController().signal, checkpoint);
      assert.equal(batch.hasMore, page < 2);
      assert.equal(batch.items.length, page < 2 ? 50 : 25, '三路重复命中与自己的消息均过滤');
      await inbox.ingest(source, batch.items);
      checkpoint = batch.checkpoint;
      assert.equal(inbox.list().length, (scan === 0 ? Math.min((page + 1) * 50, 125) : 125) + 1);
    }
    assert.ok(checkpoint.lastCompletedThrough);
    // Reopen actual SQLite storage before checking the durable requests or rescanning.
    await inbox.close(); store.close(); store = createStore(path); inbox = openInbox();
    assert.deepEqual(inbox.list().find(item => item.id === old.id), old);
    for (let n = 0; n < 125; n++) {
      const item = inbox.list().find(item => item.last === `om_request_${n}` && item.id !== old.id)!;
      assert.ok(item, `第${n}条请求被后续页抹掉`);
      assert.equal(item.text, `[om_request_${n}] 对方: 请处理独立请求${n}`);
      assert.equal(item.origin!.kind, 'group');
      assert.equal(item.origin!.mentionedMe, n % 2 === 0);
      assert.equal(item.receivedAt, messages[n]!.create_time);
      assert.equal(item.version, 1, '重扫不得重分拣或覆盖已入箱条目');
      assert.equal(item.tier, 'action');
    }
  }
});
