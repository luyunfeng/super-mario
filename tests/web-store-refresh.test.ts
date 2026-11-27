import test from 'node:test';
import assert from 'node:assert/strict';

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onclose: Listener | null = null;
  closed = false;
  url: string;
  constructor(url: URL | string) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }
  close() { this.closed = true; }
  emitOpen() { this.onopen?.(); }
  emitMessage(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

test('web store coalesces concurrent refreshes without starvation and ignores non-snapshot high-frequency events', async (t) => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevLocation = (globalThis as Record<string, unknown>).location;
  const prevWebSocket = (globalThis as Record<string, unknown>).WebSocket;
  FakeWebSocket.instances = [];
  (globalThis as Record<string, unknown>).window = { addEventListener() {} };
  (globalThis as Record<string, unknown>).location = { href: 'http://127.0.0.1:48080/', protocol: 'http:' };
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
  t.after(() => {
    (globalThis as Record<string, unknown>).window = prevWindow;
    (globalThis as Record<string, unknown>).location = prevLocation;
    (globalThis as Record<string, unknown>).WebSocket = prevWebSocket;
  });

  // @ts-expect-error plain ESM browser module without .d.ts
  const { createStore } = await import('../apps/web/js/lib/store.js');

  let stateCalls = 0;
  let owner = 'token-a';
  const resolvers: Array<(value: unknown) => void> = [];
  const api = {
    token: () => owner,
    draftOwner: () => owner,
    get(path: string) {
      if (path === '/state') {
        stateCalls += 1;
        return new Promise((resolve) => { resolvers.push(resolve); });
      }
      return Promise.resolve([]);
    },
  };

  const store = createStore(api);
  store.connect();
  assert.equal(stateCalls, 1, 'connect triggers initial refresh');

  const ws = FakeWebSocket.instances[0];
  assert.ok(ws);
  ws.emitOpen();
  assert.equal(stateCalls, 1, 'ws.onopen does not duplicate in-flight initial refresh');

  // High-frequency trace / connected / takeover events should not queue extra refreshes.
  ws.emitMessage({ type: 'connected' });
  for (let i = 0; i < 10; i++) ws.emitMessage({ type: 'agent.trace.changed', data: { turnId: 't1' } });
  ws.emitMessage({ type: 'takeover.changed', data: { key: 'k1' } });

  // Resolve the first in-flight /state request; snapshot must be applied immediately (no starvation).
  resolvers.shift()!({ version: '1', todos: [] });
  await new Promise((r) => setTimeout(r, 220));
  assert.equal((store.view.snapshot as { version: string } | null)?.version, '1');
  assert.equal(stateCalls, 1, 'ignored high-frequency events did not trigger follow-up refresh');

  // Now trigger multiple snapshot-relevant events while a refresh is in flight.
  ws.emitMessage({ type: 'todos.changed' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(stateCalls, 2);
  // While #2 is in flight, fire another burst of events.
  ws.emitMessage({ type: 'todos.changed' });
  ws.emitMessage({ type: 'runs.changed' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(stateCalls, 2, 'concurrent events coalesce while refresh is in flight');

  // Resolve #2 -> snapshot updates to v2, and exactly one follow-up refresh (#3) is scheduled.
  resolvers.shift()!({ version: '2', todos: [] });
  await new Promise((r) => setTimeout(r, 220));
  assert.equal((store.view.snapshot as { version: string } | null)?.version, '2');
  assert.equal(stateCalls, 3, 'exactly one coalesced follow-up refresh runs after in-flight finishes');

  // Resetting owner discards in-flight #3 response.
  owner = 'token-b';
  store.reset();
  assert.equal(store.view.snapshot, null);
  assert.equal(stateCalls, 4);
  resolvers.shift()!({ version: '3-stale', todos: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.view.snapshot, null, 'stale response from previous epoch is discarded');
  resolvers.shift()!({ version: '4-fresh', todos: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((store.view.snapshot as { version: string } | null)?.version, '4-fresh');
});
