import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPersonalMessages } from '../apps/server/src/feishu-personal.ts';
import { preparePersonalCheckpoint } from '../plugins/feishu.ts';
import type { PersonalBatch, PersonalProvider, PersonalAccount } from '../plugins/feishu-personal.ts';
import type { CollectedReplyEvidence } from '../packages/protocol/src/waiting-replies.ts';

const account = { appId: 'cli_0123456789abcdef', profile: 'offline', openId: 'ou_me', name: '测试' };
const source = `feishu:${account.appId}:${account.openId}`;
const evidence: CollectedReplyEvidence = { source: 'feishu:untrusted', chatId: 'oc_chat', messageId: 'om_reply',
  senderId: 'ou_other', senderIdType: 'open_id', parentId: 'om_own', createdAt: '2026-11-17T00:00:00Z',
  label: '群'.repeat(200), preview: '文'.repeat(300) };
function batch(): PersonalBatch {
  const checkpoint = preparePersonalCheckpoint({ appId: account.appId, openId: account.openId, profile: account.profile });
  checkpoint.lastCompletedThrough = checkpoint.window!.end; delete checkpoint.window; checkpoint.pages = 3;
  return { items: [], checkpoint, hasMore: false, evidence: [structuredClone(evidence)] };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
async function until(check: () => boolean) { for (let n = 0; n < 200; n++) { if (check()) return; await delay(5); } assert.fail('状态未收敛'); }
function fixture(t: test.TestContext, overrides: {
  collectBatch?: PersonalProvider['collectBatch']; observeReplies?: (source: string, rows: CollectedReplyEvidence[]) => unknown;
  ingest?: () => Promise<unknown>; canCollect?: () => boolean;
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mario-reply-observation-'));
  let current = account; let observed = 0, ingested = 0;
  const provider: PersonalProvider = {
    application: async () => current,
    begin: async () => ({ url: 'https://example.invalid/offline', code: 'fake', expiresIn: 60 }),
    complete: async () => current, verify: async () => current, collect: async () => [],
    collectBatch: overrides.collectBatch ?? (async () => batch()),
  };
  const service = createPersonalMessages({ config: { dataDir, host: '127.0.0.1', port: 0, demo: false }, provider, pollMs: 60_000,
    canCollect: overrides.canCollect ?? (() => true),
    ingest: async () => { ingested++; return overrides.ingest?.(); },
    observeReplies: async (source, rows) => { observed++; return overrides.observeReplies?.(source, rows); },
  });
  t.after(async () => { await service.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { service, provider, counts: () => ({ observed, ingested }),
    read: () => JSON.parse(readFileSync(join(dataDir, 'private/feishu-personal/account.json'), 'utf8')),
    switchAccount(next: PersonalAccount) { current = next; },
    async connect() { service.authorize(); await until(() => service.status().status === 'connected'); },
  };
}

test('observe before slow ingest; canonical source and bounded copies cannot mutate batch checkpoint', async t => {
  const original = batch(), snapshot = structuredClone(original), gate = deferred<void>(); let entered = false;
  const f = fixture(t, { collectBatch: async () => original,
    observeReplies: (seenSource, rows) => {
      assert.equal(seenSource, source); assert.equal(rows[0]!.source, source);
      assert.equal(rows[0]!.preview?.length, 160); assert.equal(rows[0]!.label?.length, 160);
      rows[0]!.source = 'corrupt'; rows[0]!.preview = 'mutated'; rows.length = 0;
      // Even a callback holding the provider's batch cannot change committed progress.
      original.checkpoint.pages = 999; original.checkpoint.binding.openId = 'ou_wrong';
    }, ingest: async () => { entered = true; await gate.promise; },
  });
  await f.connect(); await f.service.enable(true); await until(() => entered);
  assert.deepEqual(f.counts(), { observed: 1, ingested: 1 });
  assert.equal(f.read().checkpoint.pages, 0);
  assert.deepEqual(original.evidence, snapshot.evidence);
  gate.resolve(); await until(() => !!f.service.status().lastCompletedThrough);
  assert.deepEqual(f.read().checkpoint, snapshot.checkpoint);
});

for (const mode of ['stop', 'cancel', 'switch', 'disabled', 'wrong-binding'] as const) {
  test(`${mode}: late batch cannot observe, ingest or advance watermark`, async t => {
    const gate = deferred<PersonalBatch>(); let entered = false, allowed = true;
    const f = fixture(t, { collectBatch: async () => { entered = true; return gate.promise; }, canCollect: () => allowed });
    await f.connect(); await f.service.enable(true); await until(() => entered);
    let stopping: Promise<unknown> | undefined;
    if (mode === 'stop') stopping = f.service.enable(false);
    if (mode === 'cancel' || mode === 'switch') f.service.cancel();
    if (mode === 'switch') { f.switchAccount({ ...account, openId: 'ou_new' }); await f.connect(); }
    if (mode === 'disabled') allowed = false;
    const result = batch(); if (mode === 'wrong-binding') result.checkpoint.binding.openId = 'ou_wrong';
    gate.resolve(result); await stopping;
    await until(() => !f.service.status().enabled);
    // Await collection settlement through the public method where still in flight.
    await delay(10);
    assert.deepEqual(f.counts(), { observed: 0, ingested: 0 });
    assert.equal(f.read().checkpoint?.lastCompletedThrough, undefined);
    assert.ok(!f.read().checkpoint || f.read().checkpoint.pages === 0);
    if (mode === 'switch') assert.equal(f.read().account.openId, 'ou_new');
  });
}

test('observer failure prevents ingest and leaves original pinned window without watermark', async t => {
  const f = fixture(t, { observeReplies: () => { throw new Error('local store failure'); } });
  await f.connect(); await f.service.enable(true); await until(() => !!f.service.status().error);
  assert.deepEqual(f.counts(), { observed: 1, ingested: 0 });
  assert.equal(f.read().checkpoint.pages, 0); assert.ok(f.read().checkpoint.window);
  assert.equal(f.read().checkpoint.lastCompletedThrough, undefined);
});

for (const mode of ['stop', 'disabled', 'ingest-failed'] as const) {
  test(`${mode} after observation cannot commit progress`, async t => {
    const gate = deferred<void>(); let entered = false, allowed = true;
    const f = fixture(t, { canCollect: () => allowed,
      observeReplies: async () => { entered = true; await gate.promise; },
      ingest: async () => { if (mode === 'ingest-failed') throw new Error('inbox failure'); },
    });
    await f.connect(); await f.service.enable(true); await until(() => entered);
    const stopping = mode === 'stop' ? f.service.enable(false) : undefined;
    if (mode === 'disabled') allowed = false;
    gate.resolve(); await stopping; await until(() => !f.service.status().enabled);
    assert.equal(f.read().checkpoint.pages, 0); assert.equal(f.read().checkpoint.lastCompletedThrough, undefined);
    assert.equal(f.counts().ingested, mode === 'ingest-failed' ? 1 : 0);
  });
}

test('legacy providers with no evidence keep ingesting without observation', async t => {
  const f = fixture(t, { collectBatch: async () => { const result = batch(); delete result.evidence; return result; } });
  await f.connect(); await f.service.enable(true); await until(() => !!f.service.status().lastCompletedThrough);
  assert.deepEqual(f.counts(), { observed: 0, ingested: 1 });
});
