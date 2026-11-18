import assert from 'node:assert/strict';
import { mkdtemp, chmod, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import type { NodeOptions } from '../packages/plugin-sdk/src/index.ts';
import type { NodeMessage } from '../packages/protocol/src/index.ts';

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(5);
  }
  throw new Error('Timed out waiting for agent message');
}

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'super-mario-node-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const peers: Array<{ socket: WebSocket; url: string; messages: NodeMessage[] }> = [];
  server.on('connection', (socket, request) => {
    const peer = { socket, url: request.url!, messages: [] as NodeMessage[] };
    peers.push(peer);
    socket.on('message', (data) => peer.messages.push(JSON.parse(data.toString())));
  });
  const options: NodeOptions = {
    url: `http://127.0.0.1:${address.port}/ignored`, token: 'known +&?token',
    machineId: 'test-machine', name: 'Local test node', dataDir, reconnectMs: 30,
  };
  let agent: ReturnType<typeof startAgentNode> | undefined;
  t.after(async () => {
    await agent?.close();
    for (const peer of peers) peer.socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { options, peers, start() { agent = startAgentNode(options); return agent; } };
}

test('requires a token and validates connection options before connecting', () => {
  const options: NodeOptions = { url: 'http://localhost', token: '', machineId: 'm', name: 'n', dataDir: '' };
  assert.throws(() => startAgentNode(options), /token is required/);
  assert.throws(() => startAgentNode({ ...options, token: '   ' }), /token is required/);
  assert.throws(() => startAgentNode({ ...options, token: 'secret', url: 'bad secret URL' }),
    { message: 'Agent node server URL is invalid' });
  assert.throws(() => startAgentNode({ ...options, token: 'secret', reconnectMs: 0 }), /reconnectMs/);
});

test('hello, welcome, heartbeat and read-only status use the shared wire protocol', async (t) => {
  const f = await fixture(t);
  // Fake executables prove PATH discovery works without running their contents.
  const marker = join(f.options.dataDir, 'must-not-exist');
  await writeFile(join(f.options.dataDir, 'codex'), `#!/bin/sh\ntouch '${marker}'\n`);
  await chmod(join(f.options.dataDir, 'codex'), 0o700);
  await writeFile(join(f.options.dataDir, 'claude'), 'not executable');
  const originalPath = process.env.PATH;
  process.env.PATH = f.options.dataDir;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  f.start();
  const peer = await waitFor(() => f.peers[0]);
  const hello = await waitFor(() => peer.messages[0]);
  assert.deepEqual(hello, {
    type: 'hello', agentInstanceId: (hello as Extract<NodeMessage,{type:'hello'}>).agentInstanceId, machineId: f.options.machineId, name: f.options.name,
    platform: process.platform, capabilities: ['node.status'],
  });
  assert.match((hello as Extract<NodeMessage,{type:'hello'}>).agentInstanceId!, /^[a-f0-9-]{36}$/);
  const url = new URL(peer.url, f.options.url);
  assert.equal(url.pathname, '/api/v1/node');
  assert.equal(url.searchParams.get('token'), f.options.token);
  await delay(1050);
  assert.equal(peer.messages.length, 1, 'heartbeats wait for welcome');
  peer.socket.send(JSON.stringify({ type: 'welcome', machineId: f.options.machineId }));
  await waitFor(() => peer.messages.find((message) => message.type === 'heartbeat'));
  peer.socket.send(JSON.stringify({ type: 'call', id: 'status-1', method: 'node.status', params: {} }));
  const response = await waitFor(() => peer.messages.find((message) => message.type === 'result'));
  assert.equal(response.type, 'result');
  if (response.type !== 'result') return;
  assert.equal(response.id, 'status-1');
  assert.equal(response.error, undefined);
  const result = response.result as Record<string, unknown>;
  assert.equal(result.platform, process.platform);
  assert.equal(result.pid, process.pid);
  assert.equal(result.agentInstanceId, (hello as Extract<NodeMessage,{type:'hello'}>).agentInstanceId);
  assert.equal(result.nodeVersion, process.version);
  assert.equal(result.arch, process.arch);
  assert.ok(typeof result.uptime === 'number' && result.uptime >= 0);
  assert.deepEqual(result.cli, { codex: true, claude: false });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  peer.socket.send(JSON.stringify({ type: 'call', id: 'unsupported-1', method: 'shell.execute', params: { command: 'anything' } }));
  const unsupported = await waitFor(() => peer.messages.find((m) => m.type === 'result' && m.id === 'unsupported-1'));
  assert.deepEqual(unsupported, { type: 'result', id: 'unsupported-1', error: 'unsupported method' });
});

test('disconnect reconnects with hello; close cancels scheduled reconnects', async (t) => {
  const f = await fixture(t);
  const agent = f.start();
  const first = await waitFor(() => f.peers[0]);
  await waitFor(() => first.messages[0]);
  first.socket.terminate();
  const second = await waitFor(() => f.peers[1]);
  const hello = await waitFor(() => second.messages[0]);
  assert.equal(hello.type, 'hello');
  second.socket.terminate();
  await agent.close();
  await agent.close();
  await delay(120);
  assert.equal(f.peers.length, 2);
});

test('close shuts down an active heartbeat connection without reconnecting', async (t) => {
  const f = await fixture(t);
  const agent = f.start();
  const peer = await waitFor(() => f.peers[0]);
  await waitFor(() => peer.messages[0]);
  peer.socket.send(JSON.stringify({ type: 'welcome', machineId: f.options.machineId }));
  await waitFor(() => peer.messages.find((m) => m.type === 'heartbeat'));
  await agent.close();
  const count = peer.messages.length;
  await delay(1100);
  assert.equal(peer.messages.length, count);
  assert.equal(f.peers.length, 1);
});

test('close during handshake also prevents reconnect', async (t) => {
  const f = await fixture(t);
  const agent = f.start();
  await agent.close();
  await delay(120);
  assert.ok(f.peers.length <= 1);
});

// All handlers below are explicit test doubles; the transport is a local WebSocket server.
test('advertises handlers and executors; RPC emits events and runs concurrently with heartbeat', async (t) => {
  const f = await fixture(t);
  let finish!: (value: import('../packages/protocol/src/index.ts').Json) => void;
  let slowStarted = false;
  let overriddenStatus = false;
  f.options.handlers = {
    'test.slow': async (params, emit) => {
      slowStarted = true;
      emit('test.progress', params);
      return new Promise((resolve) => { finish = resolve; });
    },
    'test.echo': async (params) => params,
    'node.status': async () => { overriddenStatus = true; return null; },
  };
  f.options.executors = [{
    id: 'fake', name: 'Test double', kind: 'test', machineId: f.options.machineId,
    available: true, mode: 'real', description: 'Metadata fixture only; never executes',
  }];
  f.start();
  const peer = await waitFor(() => f.peers[0]);
  const hello = await waitFor(() => peer.messages[0]);
  assert.equal(hello.type, 'hello');
  if (hello.type !== 'hello') return;
  assert.deepEqual(hello.capabilities, ['node.status', 'test.slow', 'test.echo']);
  assert.deepEqual(hello.executors, f.options.executors);
  peer.socket.send(JSON.stringify({ type: 'call', id: 'early', method: 'test.echo', params: {} }));
  peer.socket.send(JSON.stringify({ type: 'welcome', machineId: f.options.machineId }));
  peer.socket.send(JSON.stringify({ type: 'call', id: 'slow', method: 'test.slow', params: { text: 'input' } }));
  await waitFor(() => slowStarted || undefined);
  peer.socket.send(JSON.stringify({ type: 'call', id: 'fast', method: 'test.echo', params: { ok: true } }));
  assert.deepEqual(await waitFor(() => peer.messages.find((m) => m.type === 'result' && m.id === 'fast')),
    { type: 'result', id: 'fast', result: { ok: true } });
  assert.deepEqual(await waitFor(() => peer.messages.find((m) => m.type === 'event')),
    { type: 'event', event: 'test.progress', data: { text: 'input' } });
  await waitFor(() => peer.messages.find((m) => m.type === 'heartbeat'));
  assert.ok(!peer.messages.some((m) => m.type === 'result' && (m.id === 'slow' || m.id === 'early')));
  finish('finished');
  assert.deepEqual(await waitFor(() => peer.messages.find((m) => m.type === 'result' && m.id === 'slow')),
    { type: 'result', id: 'slow', result: 'finished' });
  peer.socket.send(JSON.stringify({ type: 'call', id: 'status', method: 'node.status', params: {} }));
  await waitFor(() => peer.messages.find((m) => m.type === 'result' && m.id === 'status'));
  assert.equal(overriddenStatus, false);
});

test('rejects unregistered and inherited methods and invalid params; failures do not leak credentials', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.options.handlers = {
    'test.fail': async () => { calls++; throw new Error(`secret ${f.options.token}`); },
    'test.throw': () => { throw { token: f.options.token }; },
  };
  f.start();
  const peer = await waitFor(() => f.peers[0]);
  await waitFor(() => peer.messages[0]);
  peer.socket.send(JSON.stringify({ type: 'welcome', machineId: f.options.machineId }));
  for (const [id, method, params, error] of [
    ['unknown', 'shell.execute', {}, 'unsupported method'],
    ['inherited', 'toString', {}, 'unsupported method'],
    ['array', 'test.fail', [], 'invalid params'],
    ['null', 'test.fail', null, 'invalid params'],
    ['failed', 'test.fail', {}, 'secret [REDACTED]'],
    ['thrown', 'test.throw', {}, 'handler failed'],
  ] as const) {
    peer.socket.send(JSON.stringify({ type: 'call', id, method, params }));
    assert.deepEqual(await waitFor(() => peer.messages.find((m) => m.type === 'result' && m.id === id)),
      { type: 'result', id, error });
  }
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(peer.messages).includes(f.options.token));
});

test('handler errors expose useful validation and host messages with bounded, redacted diagnostics', async (t) => {
  const f = await fixture(t);
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  f.options.handlers = {
    'test.fail': (params) => {
      if (params.kind === 'validation') throw new Error('cwd must be an absolute path');
      if (params.kind === 'host') throw new Error('spawn codex ENOENT');
      if (params.kind === 'long') throw new Error('x'.repeat(490) + f.options.token + 'z'.repeat(100));
      if (params.kind === 'multiline') throw new Error('Host unavailable\nprivate CLI output\n at secret stack');
      if (params.kind === 'empty') throw new Error('');
      if (params.kind === 'getter') throw Object.defineProperty(new Error(), 'message', {
        get() { throw new Error(f.options.token); },
      });
      throw new Error(`Host refused: ${f.options.token}; ${encodeURIComponent(f.options.token)}; ` +
        `${new URLSearchParams({ token: f.options.token }).toString()}; ` +
        'Bearer bearer-secret; bEaReR second-secret; ' +
        'https://user-secret:password-secret@example.com/path?access_token=query-secret&other=opaque-secret ' +
        'wss://another-user:another-password@example.com/ws?%74oken=encoded-secret ' +
        '//protocol-user:protocol-password@example.com/path ' +
        '/relative?refresh_token=relative-secret&api_key=key-secret&%74oken=relative-encoded-secret');
    },
  };
  f.start();
  const peer = await waitFor(() => f.peers[0]);
  await waitFor(() => peer.messages[0]);
  peer.socket.send(JSON.stringify({ type: 'welcome', machineId: f.options.machineId }));
  for (const [kind, expected] of [
    ['validation', 'cwd must be an absolute path'], ['host', 'spawn codex ENOENT'],
    ['long', 'x'.repeat(490) + '[REDACTED]'], ['multiline', 'Host unavailable'],
    ['empty', 'handler failed'], ['getter', 'handler failed'], ['secrets', undefined],
  ] as const) {
    peer.socket.send(JSON.stringify({ type: 'call', id: kind, method: 'test.fail', params: { kind } }));
    const response = await waitFor(() => peer.messages.find((m) => m.type === 'result' && m.id === kind));
    assert.equal(response.type, 'result');
    if (response.type !== 'result') continue;
    assert.ok(response.error && response.error.length <= 500);
    if (expected !== undefined) assert.equal(response.error, expected);
    else {
      assert.match(response.error, /^Host refused:/);
      for (const secret of [f.options.token, encodeURIComponent(f.options.token), 'bearer-secret', 'second-secret',
        'user-secret', 'password-secret', 'query-secret', 'opaque-secret', 'another-user', 'another-password',
        'encoded-secret', 'relative-secret', 'key-secret', 'relative-encoded-secret',
        'protocol-user', 'protocol-password']) assert.ok(!response.error.includes(secret), secret);
    }
  }
  assert.deepEqual(logs, [], 'handler failures must not log raw errors');
});

test('duplicate RPC ids ignore in-flight deliveries and resend the exact cached result without mutation', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  let finish!: () => void;
  const result = { applied: 1 };
  f.options.handlers = {
    'test.mutate': async () => {
      calls++;
      await new Promise<void>((resolve) => { finish = resolve; });
      return result;
    },
    'test.fail': () => { calls++; throw new Error('host unavailable'); },
    'test.echo': async (params) => params,
  };
  f.start();
  const peer = await waitFor(() => f.peers[0]);
  await waitFor(() => peer.messages[0]);
  peer.socket.send(JSON.stringify({ type: 'welcome', machineId: f.options.machineId }));
  const call = { type: 'call', id: 'mutation', method: 'test.mutate', params: {} };
  peer.socket.send(JSON.stringify(call));
  await waitFor(() => finish);
  peer.socket.send(JSON.stringify(call));
  // A separate result and heartbeat prove the duplicate does not block the connection.
  peer.socket.send(JSON.stringify({ ...call, id: 'echo', method: 'test.echo' }));
  await waitFor(() => peer.messages.find((m) => m.type === 'result' && m.id === 'echo'));
  await waitFor(() => peer.messages.find((m) => m.type === 'heartbeat'));
  assert.equal(calls, 1);
  assert.ok(!peer.messages.some((m) => m.type === 'result' && m.id === 'mutation'));
  finish();
  const original = await waitFor(() => peer.messages.find((m) => m.type === 'result' && m.id === 'mutation'));
  result.applied = 99;
  peer.socket.send(JSON.stringify({ ...call, method: 'test.fail' }));
  const duplicates = await waitFor(() => {
    const results = peer.messages.filter((m) => m.type === 'result' && m.id === 'mutation');
    return results.length === 2 ? results : undefined;
  });
  assert.deepEqual(duplicates, [original, original]);
  assert.equal(calls, 1);
  peer.socket.send(JSON.stringify({ ...call, id: 'failed', method: 'test.fail' }));
  await waitFor(() => peer.messages.find((m) => m.type === 'result' && m.id === 'failed'));
  peer.socket.send(JSON.stringify({ ...call, id: 'failed' }));
  await waitFor(() => peer.messages.filter((m) => m.type === 'result' && m.id === 'failed').length === 2 || undefined);
  assert.equal(calls, 2, 'failed calls are cached as well');
});

test('result cache is bounded and never carries completed or pending ids into a new connection', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  let finishOld!: () => void;
  f.options.handlers = {
    'test.mutate': async () => ++calls,
    'test.pending': async () => {
      await new Promise<void>((resolve) => { finishOld = resolve; });
      return 'stale';
    },
  };
  f.start();
  const first = await waitFor(() => f.peers[0]);
  await waitFor(() => first.messages[0]);
  first.socket.send(JSON.stringify({ type: 'welcome', machineId: f.options.machineId }));
  for (let i = 0; i < 257; i++) {
    first.socket.send(JSON.stringify({ type: 'call', id: String(i), method: 'test.mutate', params: {} }));
  }
  await waitFor(() => first.messages.filter((m) => m.type === 'result').length === 257 || undefined);
  first.socket.send(JSON.stringify({ type: 'call', id: '0', method: 'test.mutate', params: {} }));
  await waitFor(() => first.messages.filter((m) => m.type === 'result' && m.id === '0').length === 2 || undefined);
  assert.equal(calls, 258, 'oldest completed response is evicted');
  first.socket.send(JSON.stringify({ type: 'call', id: 'pending', method: 'test.pending', params: {} }));
  await waitFor(() => finishOld);
  first.socket.terminate();
  const second = await waitFor(() => f.peers[1]);
  await waitFor(() => second.messages[0]);
  second.socket.send(JSON.stringify({ type: 'welcome', machineId: f.options.machineId }));
  await waitFor(() => second.messages.find((m) => m.type === 'heartbeat'));
  assert.ok(!second.messages.some((m) => m.type === 'result'), 'no automatic cross-connection replay');
  finishOld();
  for (const id of ['0', 'pending']) {
    second.socket.send(JSON.stringify({ type: 'call', id, method: 'test.mutate', params: {} }));
  }
  await waitFor(() => second.messages.filter((m) => m.type === 'result').length === 2 || undefined);
  assert.equal(calls, 260, 'new deliveries are independent of the old connection');
  assert.deepEqual(second.messages.filter((m) => m.type === 'result'), [
    { type: 'result', id: '0', result: 259 }, { type: 'result', id: 'pending', result: 260 },
  ]);
});

test('disconnect waits for stream cleanup, drops old callbacks and never replays mutations', async (t) => {
  const f = await fixture(t);
  let releaseCleanup!: () => void;
  let finish!: (value: import('../packages/protocol/src/index.ts').Json) => void;
  let emitOld!: (event: string, data: import('../packages/protocol/src/index.ts').Json) => void;
  let calls = 0;
  let cleanups = 0;
  f.options.onDisconnect = () => {
    cleanups++;
    if (cleanups === 1) return new Promise<void>((resolve) => { releaseCleanup = resolve; });
  };
  f.options.handlers = {
    'test.mutate': async (_, emit) => {
      calls++;
      emitOld = emit;
      return new Promise((resolve) => { finish = resolve; });
    },
    'test.echo': async (params) => params,
  };
  const agent = f.start();
  const first = await waitFor(() => f.peers[0]);
  await waitFor(() => first.messages[0]);
  first.socket.send(JSON.stringify({ type: 'welcome', machineId: f.options.machineId }));
  first.socket.send(JSON.stringify({ type: 'call', id: 'mutation', method: 'test.mutate', params: {} }));
  await waitFor(() => calls || undefined);
  first.socket.terminate();
  await waitFor(() => cleanups || undefined);
  await delay(80);
  assert.equal(f.peers.length, 1, 'reconnect waits for old observation cleanup');
  releaseCleanup();
  const second = await waitFor(() => f.peers[1]);
  await waitFor(() => second.messages[0]);
  second.socket.send(JSON.stringify({ type: 'welcome', machineId: f.options.machineId }));
  emitOld('test.old', { secret: 'old stream' });
  finish('old result');
  second.socket.send(JSON.stringify({ type: 'call', id: 'new', method: 'test.echo', params: { fresh: true } }));
  await waitFor(() => second.messages.find((m) => m.type === 'result' && m.id === 'new'));
  await waitFor(() => second.messages.find((m) => m.type === 'heartbeat'));
  assert.equal(calls, 1);
  assert.ok(!second.messages.some((m) => m.type === 'event' || (m.type === 'result' && m.id === 'mutation')));
  await agent.close();
  assert.equal(cleanups, 2);
});

test('close is idempotent and awaits asynchronous disconnect cleanup', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let calls = 0;
  f.options.onDisconnect = () => {
    calls++;
    return new Promise<void>((resolve) => { release = resolve; });
  };
  const agent = f.start();
  await waitFor(() => f.peers[0]?.messages[0]);
  const firstClose = agent.close();
  assert.equal(agent.close(), firstClose);
  let closed = false;
  void firstClose.then(() => { closed = true; });
  await waitFor(() => calls || undefined);
  await delay(80);
  assert.equal(closed, false);
  release();
  await firstClose;
  await delay(80);
  assert.equal(calls, 1);
  assert.equal(f.peers.length, 1);
});

test('cleanup failures are observable without leaking credentials or preventing shutdown', async (t) => {
  const f = await fixture(t);
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  f.options.onDisconnect = () => { throw new Error(f.options.token); };
  const agent = f.start();
  await waitFor(() => f.peers[0]?.messages[0]);
  await agent.close();
  assert.deepEqual(errors, [['Agent node disconnect cleanup failed']]);
});

test('close during disconnected cleanup waits and cancels reconnect', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  f.options.onDisconnect = () => new Promise<void>((resolve) => { release = resolve; });
  const agent = f.start();
  const peer = await waitFor(() => f.peers[0]);
  await waitFor(() => peer.messages[0]);
  peer.socket.terminate();
  await waitFor(() => release);
  const closing = agent.close();
  release();
  await closing;
  await delay(100);
  assert.equal(f.peers.length, 1);
});

test('invalid JSON disconnects with policy error and cleans observation streams', async (t) => {
  const f = await fixture(t);
  let cleanups = 0;
  f.options.onDisconnect = () => { cleanups++; };
  const agent = f.start();
  const peer = await waitFor(() => f.peers[0]);
  await waitFor(() => peer.messages[0]);
  const closed = new Promise<number>((resolve) => peer.socket.once('close', resolve));
  peer.socket.send('{broken json');
  assert.equal(await closed, 1008);
  await waitFor(() => cleanups || undefined);
  await agent.close();
});

test('agent instance identity survives reconnect but changes on fresh start without changing machineId',async t=>{
 const f=await fixture(t);const first=f.start();const a=await waitFor(()=>f.peers[0]);
 const helloA=await waitFor(()=>a.messages.find(m=>m.type==='hello')) as Extract<NodeMessage,{type:'hello'}>;
 a.socket.send(JSON.stringify({type:'welcome',machineId:f.options.machineId}));a.socket.terminate();
 const b=await waitFor(()=>f.peers[1]);const helloB=await waitFor(()=>b.messages.find(m=>m.type==='hello')) as Extract<NodeMessage,{type:'hello'}>;
 assert.equal(helloB.agentInstanceId,helloA.agentInstanceId);await first.close();f.start();
 const c=await waitFor(()=>f.peers[2]);const helloC=await waitFor(()=>c.messages.find(m=>m.type==='hello')) as Extract<NodeMessage,{type:'hello'}>;
 assert.equal(helloC.machineId,helloA.machineId);assert.notEqual(helloC.agentInstanceId,helloA.agentInstanceId);
});
