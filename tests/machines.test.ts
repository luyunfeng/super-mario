import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createMachineHub, MachineError } from '../packages/core/src/machines.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import type { MachineInfo, NodeMessage, ServerMessage } from '../packages/protocol/src/index.ts';

type Hello = Extract<NodeMessage, { type: 'hello' }>;
const hello: Hello = {
  type: 'hello', machineId: 'test-machine', name: 'Local test machine', platform: 'linux',
  capabilities: ['node.status', 'test.mutate'],
  executors: [{ id: 'test-executor', name: 'Fake executor', kind: 'test', machineId: 'test-machine',
    available: true, mode: 'real', description: 'Metadata only; never executes' }],
};

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(5);
  }
  throw new Error('Timed out waiting for local WebSocket');
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'super-mario-machines-'));
  const store = createStore(join(dir, 'state.sqlite'));
  store.put<MachineInfo>('machines', hello.machineId, {
    id: hello.machineId, name: hello.name, platform: hello.platform, capabilities: hello.capabilities,
    online: true, connectedAt: '2020-01-01T00:00:00.000Z', executors: hello.executors,
  });
  const events = createEventBus(store);
  const hub = createMachineHub({ store, events });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    hub.close();
    for (const ws of sockets) ws.terminate();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function connect(greeting: Hello | null = hello) {
    const incoming = once(server, 'connection');
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.add(client);
    const messages: ServerMessage[] = [];
    client.on('message', data => messages.push(JSON.parse(data.toString())));
    const [ws] = await incoming as [WebSocket];
    ws.on('message', data => hub.handle(ws, JSON.parse(data.toString())));
    await once(client, 'open');
    if (greeting) {
      hub.attach(ws, greeting);
      await waitFor(() => messages.find(message => message.type === 'welcome'));
    }
    return {
      client, ws, messages,
      call: (index = 0) => waitFor(() => messages.filter(message => message.type === 'call')[index]),
      send: (message: NodeMessage) => client.send(JSON.stringify(message)),
    };
  }
  return { store, events, hub, connect };
}

const machineError = (status: number, delivery: 'no' | 'unknown') => (error: unknown) => {
  assert.ok(error instanceof MachineError);
  assert.equal(error.status, status);
  assert.equal(error.delivery, delivery);
  return true;
};

test('persisted machines start offline; hello stores executor metadata and sends welcome', async t => {
  const f = await fixture(t);
  assert.equal(f.hub.list()[0].online, false);
  assert.equal(f.store.get<MachineInfo>('machines', hello.machineId)?.online, false);
  await assert.rejects(f.hub.call(hello.machineId, 'node.status', {}), machineError(503, 'no'));
  const peer = await f.connect();
  assert.deepEqual(peer.messages[0], { type: 'welcome', machineId: hello.machineId });
  const info = f.hub.list()[0];
  assert.equal(info.online, true);
  assert.equal(info.name, hello.name);
  assert.equal(info.platform, hello.platform);
  assert.ok(Number.isFinite(Date.parse(info.connectedAt)));
  assert.deepEqual(info.capabilities, hello.capabilities);
  assert.deepEqual(info.executors, hello.executors);
  assert.deepEqual(f.store.get('machines', hello.machineId), info);
  assert.equal(f.events.since(0)[0].type, 'machines.changed');
  info.executors![0].name = 'external edit';
  assert.equal(f.hub.list()[0].executors![0].name, 'Fake executor');
});

test('validates hello before replacing a connection; rejects unadvertised methods and bad timeouts', async t => {
  const f = await fixture(t);
  const peer = await f.connect(null);
  for (const invalid of [null, {}, { ...hello, name: ' ' }, { ...hello, machineId: '' },
    { ...hello, platform: 42 }, { ...hello, capabilities: 'node.status' },
    { ...hello, capabilities: [''] }, { ...hello, executors: [null] },
    { ...hello, executors: [{ ...hello.executors![0], machineId: 'other' }] }]) {
    assert.throws(() => f.hub.attach(peer.ws, invalid as Hello), machineError(400, 'no'));
  }
  f.hub.attach(peer.ws, hello);
  assert.throws(() => f.hub.attach(peer.ws, hello), machineError(400, 'no'));
  await assert.rejects(f.hub.call(hello.machineId, 'shell.execute', {}), machineError(400, 'no'));
  await assert.rejects(f.hub.call(hello.machineId, 'node.status', {}, { timeoutMs: 0 }), machineError(400, 'no'));
  assert.ok(!peer.messages.some(message => message.type === 'call'));
});

test('RPC correlates concurrent results, supports node.status and isolates other and unknown sockets', async t => {
  const f = await fixture(t);
  const peer = await f.connect();
  const other = await f.connect({ ...hello, machineId: 'other', executors: [] });
  const unknown = await f.connect(null);
  const first = f.hub.call(hello.machineId, 'node.status', { detail: true });
  const second = f.hub.call(hello.machineId, 'test.mutate', { text: 'input' });
  const a = await peer.call();
  const b = await peer.call(1);
  assert.notEqual(a.id, b.id);
  assert.equal(a.method, 'node.status');
  assert.deepEqual(b.params, { text: 'input' });
  let settled = false;
  void first.then(() => { settled = true; });
  f.hub.handle(other.ws, { type: 'result', id: a.id, result: 'wrong machine' });
  f.hub.handle(unknown.ws, { type: 'result', id: a.id, result: 'unknown socket' });
  f.hub.handle(peer.ws, { type: 'result', id: 'missing', result: 'ignored' });
  await delay(10);
  assert.equal(settled, false);
  peer.send({ type: 'result', id: b.id, result: { ok: true } });
  assert.deepEqual(await second, { ok: true });
  peer.send({ type: 'result', id: a.id, result: false });
  assert.equal(await first, false);
  const failed = f.hub.call(hello.machineId, 'test.mutate', {});
  const rejection = assert.rejects(failed, machineError(502, 'unknown'));
  peer.send({ type: 'result', id: (await peer.call(2)).id, error: 'handler failed' });
  await rejection;
});

test('disconnect rejects sent mutations as unknown and persists offline without replay', async t => {
  const f = await fixture(t);
  const peer = await f.connect();
  const result = f.hub.call(hello.machineId, 'test.mutate', {});
  const rejection = assert.rejects(result, machineError(502, 'unknown'));
  await peer.call();
  peer.client.close();
  await rejection;
  assert.equal(f.hub.list()[0].online, false);
  assert.equal(f.store.get<MachineInfo>('machines', hello.machineId)?.online, false);
  const next = await f.connect();
  assert.deepEqual(next.messages, [{ type: 'welcome', machineId: hello.machineId }]);
});

test('replacement rejects old pending calls; late close/results/events cannot affect new connection', async t => {
  const f = await fixture(t);
  const old = await f.connect();
  const oldClosed = once(old.client, 'close');
  const abandoned = f.hub.call(hello.machineId, 'test.mutate', {});
  const rejected = assert.rejects(abandoned, machineError(502, 'unknown'));
  await old.call();
  const next = await f.connect();
  await rejected;
  await oldClosed;
  const result = f.hub.call(hello.machineId, 'node.status', {});
  const call = await next.call();
  const received: unknown[] = [];
  f.hub.onEvent(event => received.push(event));
  f.hub.detach(old.ws);
  f.hub.handle(old.ws, { type: 'result', id: call.id, result: 'stale' });
  f.hub.handle(old.ws, { type: 'event', event: 'stale', data: null });
  assert.equal(f.store.get<MachineInfo>('machines', hello.machineId)?.online, true);
  assert.deepEqual(received, []);
  next.send({ type: 'result', id: call.id, result: 'fresh' });
  assert.equal(await result, 'fresh');
});

test('events broadcast without persistence, isolate throwing listeners and dispose subscriptions', async t => {
  const f = await fixture(t);
  const peer = await f.connect();
  const before = f.events.since(0);
  const received: unknown[] = [];
  f.hub.onEvent(() => { throw new Error('broken observer'); });
  f.hub.onEvent(async () => { throw new Error('async broken observer'); });
  const dispose = f.hub.onEvent(event => received.push(event));
  const frame = { type: 'event', event: 'terminal.frame', data: { seq: 1, data: 'hello' } } as const;
  peer.send(frame);
  await waitFor(() => received.length === 1 || undefined);
  assert.deepEqual(received, [{ machineId: hello.machineId, event: frame.event, data: frame.data }]);
  assert.deepEqual(f.events.since(0), before);
  await dispose();
  f.hub.handle(peer.ws, frame);
  assert.equal(received.length, 1);
});

test('timeout is unknown, late result is ignored, and timeout never replays a mutation', async t => {
  const f = await fixture(t);
  const peer = await f.connect();
  const result = f.hub.call(hello.machineId, 'test.mutate', {}, { timeoutMs: 30 });
  const rejected = assert.rejects(result, machineError(504, 'unknown'));
  const call = await peer.call();
  await rejected;
  peer.send({ type: 'result', id: call.id, result: 'late' });
  const next = f.hub.call(hello.machineId, 'node.status', {});
  const nextCall = await peer.call(1);
  peer.send({ type: 'result', id: nextCall.id });
  assert.equal(await next, null);
  assert.equal(peer.messages.filter(message => message.type === 'call').length, 2);
});

test('close clears pending timers/listeners, closes peers, stays idempotent and leaves store usable', async t => {
  const f = await fixture(t);
  const peer = await f.connect();
  const closed = once(peer.client, 'close');
  const closeListenerCount = peer.ws.listenerCount('close');
  let observed = 0;
  f.hub.onEvent(() => { observed++; });
  const result = f.hub.call(hello.machineId, 'test.mutate', {}, { timeoutMs: 60_000 });
  const rejected = assert.rejects(result, machineError(502, 'unknown'));
  await peer.call();
  f.hub.close();
  f.hub.close();
  await rejected;
  await closed;
  f.hub.handle(peer.ws, { type: 'event', event: 'late', data: null });
  f.hub.onEvent(() => { observed++; });
  assert.equal(observed, 0);
  assert.equal(peer.ws.listenerCount('close'), closeListenerCount - 1);
  assert.equal(f.hub.list()[0].online, false);
  assert.equal(f.store.get<MachineInfo>('machines', hello.machineId)?.online, false);
  f.store.put('test', 'still-open', true);
  assert.equal(f.store.get('test', 'still-open'), true);
  await assert.rejects(f.hub.call(hello.machineId, 'node.status', {}), machineError(503, 'no'));
  assert.throws(() => f.hub.attach(peer.ws, hello), machineError(503, 'no'));
});


test('default timeout is ten seconds and clears its pending request', async t => {
  const f = await fixture(t);
  const peer = await f.connect();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = f.hub.call(hello.machineId, 'test.mutate', {});
  const rejected = assert.rejects(result, machineError(504, 'unknown'));
  let settled = false;
  void result.catch(() => { settled = true; });
  t.mock.timers.tick(9999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejected;
  t.mock.timers.reset();
  const call = await peer.call();
  f.hub.handle(peer.ws, { type: 'result', id: call.id, result: 'late' });
  assert.equal(f.hub.list()[0].online, true);
});

test('optional agent instance identity is retained, replaced, validated and never invented for legacy peers',async t=>{
 const f=await fixture(t);const first=await f.connect({...hello,agentInstanceId:'process-one'});assert.equal(f.hub.list()[0].agentInstanceId,'process-one');
 await f.connect({...hello,agentInstanceId:'process-two'});assert.equal(f.hub.list()[0].agentInstanceId,'process-two');first.client.close();await delay(10);assert.equal(f.hub.list()[0].agentInstanceId,'process-two');
 await f.connect(hello);assert.equal(f.hub.list()[0].agentInstanceId,undefined);
 const invalid=await f.connect(null);assert.throws(()=>f.hub.attach(invalid.ws,{...hello,agentInstanceId:'bad\nidentity'}),/Invalid machine hello/);
});

test('the build an agent node reports is kept for the owner and validated, and an older node without it still connects',async t=>{
 const f=await fixture(t);const commit='a'.repeat(40);
 await f.connect({...hello,build:{commit,dirty:true}});
 assert.deepEqual(f.hub.list()[0].build,{commit,dirty:true});
 await f.connect({...hello,build:{commit:'unknown'}});assert.deepEqual(f.hub.list()[0].build,{commit:'unknown'},'a node outside a build says so');
 // A node from before this field was added sends none. It is not refused for that.
 await f.connect(hello);assert.equal(f.hub.list()[0].build,undefined);
 const invalid=await f.connect(null);
 for(const build of [null,7,'abc',{},{commit:''},{commit:'abc'},{commit:'A'.repeat(40)},{commit:'g'.repeat(40)},{commit,dirty:'yes'},{commit:'unknown',dirty:1}])
  // These values are invalid on purpose, so the cast stands for an untrusted node.
  assert.throws(()=>f.hub.attach(invalid.ws,{...hello,build:build as never}),/Invalid machine hello/,JSON.stringify(build));
});
