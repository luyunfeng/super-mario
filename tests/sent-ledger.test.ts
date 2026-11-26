import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import type { Approval } from '../packages/protocol/src/index.ts';
import type { OutboxItem } from '../packages/plugin-sdk/src/index.ts';

/** An outbox entry as it is stored. */
function outgoing(id: string, status: OutboxItem['status'], at: string, extra: Partial<OutboxItem> = {}): OutboxItem {
  return { id, owner: 'owner', version: 1, contentHash: 'h', status, attempt: 1, dedupKey: 'k-' + id, channel: 'feishu.bot', target: 'oc_chat',
    content: { text: '已安排周四评审。' }, createdAt: at, updatedAt: at, ...extra };
}
/** An approval as it is stored. */
function done(id: string, kind: Approval['kind'], at: string, result: Approval['result'], extra: Partial<Approval> = {}): Approval {
  return { id, version: 1, kind, title: '标题', details: '正文', params: {}, status: 'completed', result, createdAt: at, updatedAt: at, ...extra };
}

async function start(t: { after(fn: () => void): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-sent-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-sent' });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const { store } = server.app;
  // What went out.
  store.put('outbox.items', 'sent-1', outgoing('sent-1', 'sent', '2026-11-27T10:00:00.000Z', { approvalId: 'appr-9' }));
  store.put('outbox.items', 'sent-0', outgoing('sent-0', 'sent', '2026-11-27T10:00:00.000Z'));
  store.put('approvals', 'mail-1', done('mail-1', 'plugin:mail-connector.send', '2026-11-27T09:00:00.000Z', { outcome: 'sent', copyKept: true, messageId: 'm-1@example.invalid' },
    // The card's own summary says other words. What went out is in the parameters, where
    // the owner's edits while reviewing are kept.
    { title: '发送邮件', details: '这是审批卡片上的摘要，不是发出去的正文。',
      params: { account: 'a', sender: 'me@example.invalid', subject: '周四的评审', text: '请确认周四的评审时间。\n谢谢。', to: [{ name: '李四', email: 'lisi@example.invalid' }, { email: 'wang@example.invalid' }], cc: [{ email: 'cc@example.invalid' }], bcc: [{ email: 'b1@example.invalid' }, { email: 'b2@example.invalid' }] } }));
  store.put('approvals', 'gh-1', done('gh-1', 'plugin:github-connector.comment', '2026-11-27T08:00:00.000Z', { state: 'sent', url: 'https://github.com/o/r/issues/1#issuecomment-1' },
    { title: '在 o/r #1 发表评论', details: '看过了。', params: { repository: 'o/r', number: 1 } }));
  store.put('approvals', 'gh-again', done('gh-again', 'plugin:github-connector.comment', '2026-11-27T08:30:00.000Z', { state: 'already-sent', url: 'https://github.com/o/r/issues/1#issuecomment-1' },
    { title: '在 o/r #1 发表评论', details: '看过了。', params: { repository: 'o/r', number: 1 } }));
  // What did not go out. None of these is in the ledger.
  store.put('outbox.items', 'queued', outgoing('queued', 'queued', '2026-11-27T11:00:00.000Z'));
  store.put('outbox.items', 'failed', outgoing('failed', 'failed', '2026-11-27T11:01:00.000Z'));
  store.put('outbox.items', 'unknown', outgoing('unknown', 'unknown', '2026-11-27T11:02:00.000Z'));
  store.put('outbox.items', 'held', outgoing('held', 'held', '2026-11-27T11:03:00.000Z'));
  store.put('outbox.items', 'cancelled', outgoing('cancelled', 'cancelled', '2026-11-27T11:04:00.000Z'));
  store.put('approvals', 'mail-unknown', done('mail-unknown', 'plugin:mail-connector.send', '2026-11-27T11:05:00.000Z', { outcome: 'unknown' }));
  store.put('approvals', 'mail-failed', done('mail-failed', 'plugin:mail-connector.send', '2026-11-27T11:06:00.000Z', { outcome: 'not-sent' }));
  store.put('approvals', 'mail-pending', { ...done('mail-pending', 'plugin:mail-connector.send', '2026-11-27T11:07:00.000Z', undefined), status: 'pending' });
  store.put('approvals', 'gh-unknown', done('gh-unknown', 'plugin:github-connector.comment', '2026-11-27T11:08:00.000Z', { state: 'unknown' }));
  // A dispatch that completed is not something written in the owner's name.
  store.put('approvals', 'dispatch', done('dispatch', 'dispatch', '2026-11-27T11:09:00.000Z', { ok: true }));
  const read = async (query = '') => {
    const answer = await fetch(server.url + '/api/v1/sent' + query, { headers: { authorization: 'Bearer offline-sent' } });
    return { status: answer.status, body: await answer.json() as Record<string, unknown> };
  };
  return { server, read };
}

test('台账只列真正发出去的，三种来源都在，最新的在前；重复执行不算第二条', async t => {
  const f = await start(t);
  const { status, body } = await f.read();
  assert.equal(status, 200);
  const items = body.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(item => item.id), ['outbox:sent-1', 'outbox:sent-0', 'approval:mail-1', 'approval:gh-1']);
  // The two that share a time keep a fixed order, by id.
  assert.equal(items.some(item => /queued|failed|unknown|held|cancelled|pending|dispatch/.test(String(item.id))), false);
  const [reply, , mail, comment] = items;
  assert.equal(reply!.connector, '飞书');
  assert.equal(reply!.through, 'approval');
  assert.equal(reply!.approvalId, 'appr-9');
  assert.equal(reply!.outboxId, 'sent-1');
  assert.equal(mail!.connector, '邮箱');
  assert.equal(mail!.target, '李四 <lisi@example.invalid>、wang@example.invalid；抄送 cc@example.invalid；密送 2 人');
  assert.equal(mail!.text, '主题：周四的评审\n\n请确认周四的评审时间。\n谢谢。');
  assert.equal(String(mail!.text).includes('审批卡片'), false);
  assert.equal(mail!.messageRef, 'm-1@example.invalid');
  assert.equal(comment!.connector, 'GitHub');
  assert.equal(comment!.target, 'o/r #1');
  assert.ok(String(comment!.messageRef).endsWith('#issuecomment-1'));
  assert.equal(body.hasMore, false);
});

test('台账可按连接器筛选并翻页，翻页不重复也不漏', async t => {
  const f = await start(t);
  const first = (await f.read('?limit=2')).body;
  assert.equal((first.items as unknown[]).length, 2);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.next, { at: '2026-11-27T10:00:00.000Z', id: 'outbox:sent-0' });
  // The second page starts after the row the first one ended on, that row included.
  const next = first.next as { at: string; id: string };
  const second = (await f.read('?limit=2&after_at=' + encodeURIComponent(next.at) + '&after_id=' + encodeURIComponent(next.id))).body;
  assert.deepEqual((second.items as Array<{ id: string }>).map(item => item.id), ['approval:mail-1', 'approval:gh-1']);
  // Walking every page sees each row once.
  const seen: string[] = [];
  let after: { at: string; id: string } | undefined;
  for (let page = 0; page < 10; page++) {
    const query = '?limit=2' + (after ? '&after_at=' + encodeURIComponent(after.at) + '&after_id=' + encodeURIComponent(after.id) : '');
    const body = (await f.read(query)).body;
    seen.push(...(body.items as Array<{ id: string }>).map(item => item.id));
    if (!body.next) break;
    after = body.next as { at: string; id: string };
  }
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen).size, 4);
  // Only the mail.
  const mail = (await f.read('?connector=' + encodeURIComponent('邮箱'))).body;
  assert.deepEqual((mail.items as Array<{ connector: string }>).map(item => item.connector), ['邮箱']);
});

test('台账的参数不对时拒绝，读取不改动任何记录', async t => {
  const f = await start(t);
  const before = JSON.stringify(f.server.app.approvals.list());
  assert.equal((await f.read('?connector=' + encodeURIComponent('别的'))).status, 400);
  assert.equal((await f.read('?limit=0')).status, 400);
  assert.equal((await f.read('?limit=101')).status, 400);
  assert.equal((await f.read('?after_at=x')).status, 400);
  assert.equal((await f.read('?extra=1')).status, 400);
  assert.equal((await f.read('?limit=1&limit=2')).status, 400);
  // It is a read: it needs the owner's token and changes nothing.
  assert.equal((await fetch(f.server.url + '/api/v1/sent')).status, 401);
  // There is no way to write to it: a request that is not a read is not answered as one.
  assert.equal((await fetch(f.server.url + '/api/v1/sent', { method: 'POST', headers: { authorization: 'Bearer offline-sent' } })).status, 404);
  assert.equal(JSON.stringify(f.server.app.approvals.list()), before);
});
