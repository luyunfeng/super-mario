import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createEventMailboxes } from '../packages/core/src/event-mailboxes.ts';
import type { InboxOrigin } from '../packages/protocol/src/index.ts';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'super-mario-mail-origin-'));
  const path = join(dir, 'mail.sqlite');
  const store = createStore(path);
  const events = createEventBus(store);
  const mailboxes = createEventMailboxes({ store, events });
  t.after(async () => { await mailboxes.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, events, mailboxes, path };
}
const input = { direction: 'inbox' as const, botId: 'local-test', scope: { kind: 'global' as const }, eventKey: 'message', title: '天气', text: '晴朗', requiresConfirmation: false };

test('SQLite mail stores normalized origins across restart and duplicates are complete no-ops', async t => {
  const f = fixture(t);
  const first = f.mailboxes.put({ ...input, origin: { kind: 'group', connector: ' cli ', chatId: ' oc_test ', mentionedMe: false } });
  assert.deepEqual(first.origin, { kind: 'group', connector: 'cli', chatId: 'oc_test', mentionedMe: false });
  assert.equal(first.status, 'ready');
  assert.deepEqual(f.mailboxes.put({ ...input, origin: first.origin }), first);
  assert.equal(f.events.since(0).length, 1);
  await f.mailboxes.close();
  const store = createStore(f.path);
  const restarted = createEventMailboxes({ store, events: createEventBus(store) });
  try { assert.deepEqual(restarted.get(first.id), first); } finally { await restarted.close(); store.close(); }
});

test('display provenance never overrides the explicitly configured robot confirmation policy', async t => {
  const f = fixture(t);
  let calls = 0;
  f.mailboxes.setHandlers({ inbox: async () => { calls++; } });
  const origins: InboxOrigin[] = [{ kind: 'direct' }, { kind: 'group', mentionedMe: true }];
  for (const [index, origin] of origins.entries()) {
    const item = f.mailboxes.put({ ...input, eventKey: String(index), origin, requiresConfirmation: true });
    assert.equal(item.requiresConfirmation, true);
    assert.equal(item.status, 'pending');
    await assert.rejects(f.mailboxes.process(item.id, item.version), /确认/);
    assert.equal(calls, index);
    await f.mailboxes.confirm(item.id, item.version);
    assert.equal(calls, index + 1);
  }
  const ordinary = f.mailboxes.put({ ...input, origin: { kind: 'group', mentionedMe: false } });
  assert.equal(ordinary.status, 'ready');
  const unknown = f.mailboxes.put({ ...input, eventKey: 'oc_unknown', title: '@我 群聊 私聊' });
  assert.equal(unknown.origin, undefined);
  assert.equal(unknown.status, 'ready');
});

test('legacy pending mail gains verified origin and invalidates old actions without delivery', async t => {
  const f = fixture(t);
  let calls = 0;
  f.mailboxes.setHandlers({ inbox: async () => { calls++; } });
  const old = f.mailboxes.put(input);
  const enriched = f.mailboxes.put({ ...input, origin: { kind: 'direct' } });
  assert.equal(enriched.version, old.version + 1);
  assert.equal(enriched.status, old.status);
  assert.equal(enriched.requiresConfirmation, old.requiresConfirmation);
  await assert.rejects(f.mailboxes.confirm(old.id, old.version), error => (error as { status: number }).status === 409);
  assert.equal(calls, 0);
  assert.equal(f.events.since(0).length, 2);
  assert.deepEqual(f.mailboxes.put({ ...input, origin: { kind: 'direct' } }), enriched);
  assert.equal(f.events.since(0).length, 2);
});

test('rejected mail provenance can be enriched without revival or scope changes', async t => {
  const f = fixture(t);
  const first = f.mailboxes.put({ ...input, origin: { kind: 'unknown' } });
  const rejected = f.mailboxes.reject(first.id, first.version);
  const enriched = f.mailboxes.put({ ...input, origin: { kind: 'group', mentionedMe: true } });
  assert.deepEqual(enriched, { ...rejected, origin: { kind: 'group', mentionedMe: true }, version: rejected.version + 1, updatedAt: enriched.updatedAt });
  assert.deepEqual(f.mailboxes.put({ ...input, origin: { kind: 'agent' } }), enriched);
});

test('provenance enrichment during dispatch survives completion without another handler call', async t => {
  const f = fixture(t);
  let release!: () => void;
  let calls = 0;
  f.mailboxes.setHandlers({ inbox: async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); } });
  const first = f.mailboxes.put(input);
  const pending = f.mailboxes.process(first.id, first.version);
  await new Promise(resolve => setImmediate(resolve));
  const enriched = f.mailboxes.put({ ...input, origin: { kind: 'direct' } });
  assert.equal(enriched.status, 'processing');
  release();
  const completed = await pending;
  assert.deepEqual(completed.origin, { kind: 'direct' });
  assert.equal(completed.version, enriched.version + 1);
  assert.equal(completed.status, 'completed');
  assert.equal(calls, 1);
});

test('invalid provenance fails before persistence and known origins cannot be overwritten', async t => {
  const f = fixture(t);
  assert.throws(() => f.mailboxes.put({ ...input, origin: { kind: 'group', mentionedMe: 'true' } as unknown as InboxOrigin }), error => (error as { status: number }).status === 400);
  assert.equal(f.mailboxes.list().length, 0);
  const known = f.mailboxes.put({ ...input, origin: { kind: 'direct', mentionedMe: true } });
  assert.deepEqual(known.origin, { kind: 'direct' });
  assert.deepEqual(f.mailboxes.put({ ...input, origin: { kind: 'group', mentionedMe: true } }), known);
});
