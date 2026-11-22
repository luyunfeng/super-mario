import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createAutoTakeover } from '../packages/core/src/auto-takeover.ts';
import { detectScreenPrompt } from '../plugins/live-terminals.ts';
import type { Card } from '../packages/core/src/interactions.ts';

test('detectScreenPrompt parses trust_dir, permission and choice prompts with stable rev', () => {
  const trust = detectScreenPrompt('Do you trust the files in this folder?\n> 1. Yes, proceed\n  2. No, exit');
  assert.equal(trust?.kind, 'trust_dir');
  assert.equal(trust?.options[0]?.keys, '\r');

  const perm = detectScreenPrompt('Do you want to run bash command?\n❯ 1. Yes, allow once\n  2. Always allow\n  3. No');
  assert.equal(perm?.kind, 'permission');
  assert.equal(perm?.options.length, 3);
  assert.equal(perm?.options[0]?.keys, '1\r');

  const plain = detectScreenPrompt('All tests passed.\n$ ');
  assert.equal(plain, undefined);
});

test('autoTakeover auto-approves trust_dir inside bound project, opens card for permission and withdraws when resolved locally', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-takeover-'));
  const store = createStore(join(dir, 'test.sqlite'));
  const events = createEventBus(store);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  store.put('projects', 'p1', {
    id: 'p1', name: 'Demo', workspace: { machineId: 'm1', cwd: '/work/demo' },
    createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z',
  });

  const answered: Array<{ paneId: string; keys: string }> = [];
  const openedCards: Card[] = [];
  const withdrawnCards: string[] = [];
  let activePrompts = [
    {
      paneId: 'w1:p1', terminalId: 't1', cwd: '/work/demo/sub', title: 'Codex', agent: 'codex',
      prompt: { kind: 'trust_dir', rev: 'rev-trust', title: '信任目录', excerpt: 'Do you trust?', options: [{ label: '信任', keys: '\r' }] },
    },
    {
      paneId: 'w1:p2', terminalId: 't2', cwd: '/work/demo', title: 'Claude', agent: 'claude',
      prompt: { kind: 'permission', rev: 'rev-perm', title: '权限确认', excerpt: 'Allow bash?', options: [{ label: '1. Yes', keys: '1\r' }] },
    },
  ];

  const takeover = createAutoTakeover({
    store, events,
    machines: () => ({
      list: () => [{ id: 'm1', name: 'Host', online: true, capabilities: ['terminal.live.scan_prompts', 'terminal.live.answer_prompt'] }] as never,
      async call(_id, method, params) {
        if (method === 'terminal.live.scan_prompts') return { prompts: activePrompts } as never;
        if (method === 'terminal.live.answer_prompt') {
          answered.push({ paneId: String(params.paneId), keys: String(params.keys) });
          return { applied: true, rev: params.rev } as never;
        }
        return {} as never;
      },
    }),
    openCard(input) {
      const card = { id: `card-${openedCards.length + 1}`, ...input } as unknown as Card;
      openedCards.push(card);
      return card;
    },
    withdrawCard(id) { withdrawnCards.push(id); },
  });

  await takeover.scanOnce();
  assert.equal(answered.length, 1);
  assert.equal(answered[0]!.paneId, 'w1:p1');
  assert.equal(openedCards.length, 1);
  assert.match(openedCards[0]!.title, /权限确认/);

  // Simulate user answering t2 locally on their computer: prompt disappears on next scan.
  activePrompts = [];
  await takeover.scanOnce();
  assert.deepEqual(withdrawnCards, ['card-1']);
  assert.equal(takeover.list().find(r => r.terminalId === 't2')?.status, 'withdrawn');
});
