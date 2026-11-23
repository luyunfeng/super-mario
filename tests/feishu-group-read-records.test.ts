import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

type Entry = { id: string; task: string; answer: string; status: string; createdAt: string;
  confirmedParts: number; totalParts: number | null };

test('读群记录分页仅展示当前绑定原群的已确认回执，撤回清除文本，重启仍保留', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-read-records-'));
  const config = { dataDir, host: '127.0.0.1', port: 0, demo: true, token: 'fixture' };
  const accounts = new Map<string, FeishuOptions>();
  const replies: Array<{ source: string; text: string; confirmed: boolean }> = [];
  const factory: FeishuBotFactory = opts => {
    accounts.set(opts.appId, opts);
    return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
      async send(target, text, context) {
        const source = context?.replyTo;
        if (!source || target !== 'oc_group') return;
        const confirmed = source !== 'partial' || !replies.some(r => r.source === source);
        replies.push({ source, text, confirmed });
        if (confirmed) context?.onSent?.('om_sent_' + replies.length, 'text');
      } };
  };
  let release = () => {}, started = () => {};
  const wait = new Promise<void>(ok => { release = ok; });
  const computing = new Promise<void>(ok => { started = ok; });
  const dependencies = { botFactory: factory, readGroup: { account: () => 'owner-binding', async run(input: { messageId: string }) {
    if (input.messageId === 'partial') return '首段确认'.repeat(1000) + '未确认的后续原文';
    if (input.messageId === 'failed') throw new Error('private-backend-marker');
    if (input.messageId === 'working') { started(); await wait; }
    return '核对回执-' + input.messageId;
  } } };
  let host = await startServer(config, dependencies);
  t.after(async () => { release(); try { await host.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  async function bind(appId: string) {
    const bot = await host.bots.create({ name: '合成读群', appId, appSecret: 'synthetic-app-secret', scope: { kind: 'global' }, readGroup: true });
    await accounts.get(appId)!.onMessage(bot.pairingCode!, { senderType: 'user', senderId: 'ou_owner', chatType: 'p2p', chatId: 'oc_owner', messageId: 'pair' });
    return bot;
  }
  const a = await bind('cli_1111111111111111'), b = await bind('cli_2222222222222222');
  const issue = (id: string, task = '核对请求-' + id) => accounts.get(a.appId)!.onMessage('/read ' + task, {
    chatType: 'group', chatId: 'oc_group', senderType: 'user', senderId: 'ou_owner', messageId: id, mentionedSelf: true,
  });
  const url = (id: string, before?: string) => host.url + '/api/v1/feishu/bots/' + id + '/group-reads' +
    (before ? '?before=' + encodeURIComponent(before) : '');
  async function page(id: string, before?: string) {
    const response = await fetch(url(id, before), { headers: { authorization: 'Bearer ' + config.token } });
    assert.equal(response.status, 200);
    return response.json() as Promise<{items: Entry[]; nextBefore: string | null}>;
  }
  assert.equal((await fetch(url(a.id))).status, 401);
  // Old receipts carry platform IDs but have no source binding or confirmed text snapshot.
  host.app.store.put('feishu.group-read', '0'.repeat(64), { status: 'completed', replies: ['om_private_old'] });
  assert.deepEqual(await page(a.id), { items: [], nextBefore: null });
  for (let i = 0; i < 21; i++) await issue('complete-' + i);
  await issue('partial').catch(() => {});
  await issue('failed');
  const pending = issue('working');
  await computing;
  const active = (await page(a.id)).items.find(row => row.status === 'working');
  assert.ok(active);
  assert.equal(active.answer, '');
  assert.equal(active.confirmedParts, 0);
  release(); await pending;
  const first = await page(a.id);
  assert.equal(first.items.length, 20);
  assert.ok(first.nextBefore);
  const second = await page(a.id, first.nextBefore);
  assert.equal(second.nextBefore, null);
  const all = [...first.items, ...second.items];
  assert.equal(new Set(all.map(row => row.id)).size, 24);
  assert.deepEqual(new Set(all.map(row => row.task)), new Set(['working', 'failed', 'partial', ...Array.from({length: 21}, (_, i) => 'complete-' + i)]
    .map(id => '核对请求-' + id)));
  assert.deepEqual(all.map(row => row.createdAt), all.map(row => row.createdAt).sort().reverse());
  for (const entry of all) {
    assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
    const source = entry.task.slice('核对请求-'.length);
    const confirmed = replies.filter(row => row.source === source && row.confirmed);
    assert.equal(entry.answer, confirmed.map(row => row.text).join(''));
    assert.equal(entry.confirmedParts, confirmed.length);
    assert.equal(entry.totalParts, source === 'partial' ? 2 : 1);
    assert.equal(entry.status, source === 'partial' ? 'unknown' : source === 'failed' ? 'failed' : 'completed');
  }
  assert.doesNotMatch(JSON.stringify(all), /om_private_old|未确认的后续原文|private-backend-marker|ou_owner|oc_group|synthetic-app-secret/);
  assert.deepEqual(await page(b.id), { items: [], nextBefore: null });
  const partial = all.find(row => row.task === '核对请求-partial')!;
  await host.close(); host = await startServer(config, dependencies);
  assert.deepEqual((await page(a.id)).items.find(row => row.id === partial.id), partial);
  accounts.get(a.appId)!.onRecall!('oc_group', 'partial');
  const recalled = (await page(a.id)).items.find(row => row.id === partial.id);
  assert.equal(recalled?.status, 'recalled');
  assert.equal(recalled.task, '');
  assert.equal(recalled.answer, '');
  await host.close(); host = await startServer(config, dependencies);
  const restored = (await page(a.id)).items;
  assert.deepEqual(restored.find(row => row.id === partial.id), recalled);
  assert.ok(restored.some(row => row.task === '核对请求-working' && row.status === 'completed'));
  const newApp = 'cli_3333333333333333';
  const rebound = await host.bots.update(a.id, { appId: newApp, appSecret: 'fixture-rebound-secret' });
  await accounts.get(newApp)!.onMessage(rebound.pairingCode!, { senderType: 'user', chatType: 'p2p', chatId: 'oc_new_owner',
    senderId: 'ou_new_owner', messageId: 'pair-new' });
  assert.deepEqual(await page(a.id), { items: [], nextBefore: null });
});
