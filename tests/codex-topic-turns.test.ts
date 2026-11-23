import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createExecutionServices } from '../plugins/executors.ts';
import { codexTurnEndpoint } from '../plugins/codex-topic-turns.ts';
import type { JsonObject, SessionBinding } from '../packages/protocol/src/index.ts';
import type { TerminalHost } from '../packages/plugin-sdk/src/index.ts';

test('私有 Unix socket 的交互恢复只把明确 start 回执关联到单轮公开答复', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-turn-')),
    path = join(cwd, 'control.sock');
  const old = process.env.SUPER_MARIO_CODEX_SOCKET;
  process.env.SUPER_MARIO_CODEX_SOCKET = path;
  const http = createServer(),
    wss = new WebSocketServer({ server: http });
  t.after(async () => {
    if (old === undefined) delete process.env.SUPER_MARIO_CODEX_SOCKET;
    else process.env.SUPER_MARIO_CODEX_SOCKET = old;
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise<void>((ok) => http.close(() => ok()));
    await rm(cwd, { recursive: true, force: true });
  });
  await new Promise<void>((ok) => http.listen(path, ok));
  await chmod(path, 0o600);
  const nativeSessionId = 'fixture-thread',
    turnId = 'fixture-turn',
    words = '只执行合成工作';
  let loaded = true,
    status = 'idle',
    threadCwd = cwd,
    thread = nativeSessionId,
    loseStart = false;
  let startId = turnId;
  let turnsApi: 'old' | 'new' | 'error' = 'old';
  let turns: JsonObject[] = [];
  const calls: Array<{ method: string; params: JsonObject }> = [];
  wss.on('connection', (ws) =>
    ws.on('message', (bytes) => {
      const frame = JSON.parse(String(bytes));
      calls.push(frame);
      if (frame.method === 'initialized') return;
      const meta = { id: thread, cwd: threadCwd, status: { type: status }, turns };
      const results: Record<string, unknown> = {
        initialize: {},
        'thread/loaded/list': { data: loaded ? [nativeSessionId] : [], nextCursor: null },
        'thread/resume': { thread: meta },
        'thread/read': { thread: meta },
        'turn/start': { turn: { id: startId } },
      };
      if (frame.method === 'thread/turns/list') {
        assert.deepEqual(frame.params, {
          threadId: nativeSessionId,
          sortDirection: 'desc',
          itemsView: 'full',
          limit: 100,
          ...(frame.params.cursor && { cursor: 'older' }),
        });
        if (turnsApi !== 'new') {
          ws.send(JSON.stringify({ id: frame.id, error: { code: turnsApi === 'old' ? -32601 : -1234 } }));
          return;
        }
        const result = frame.params.cursor
          ? { data: turns, nextCursor: null }
          : { data: [{ id: 'unrelated' }], nextCursor: 'older' };
        ws.send(JSON.stringify({ id: frame.id, result }));
        return;
      }
      if (frame.method === 'turn/start' && loseStart) {
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: results[frame.method] }));
    })
  );
  let created: string[] = [],
    writes = 0;
  const host: TerminalHost = {
    status: async () => ({ available: true }),
    list: async () => [{ id: 'pane', title: 'fixture', cwd }],
    create: async (spec) => {
      assert.equal(spec.env?.SUPER_MARIO_WORKER_KEY, undefined);
      created = spec.argv;
      return { id: 'pane', title: 'fixture', cwd };
    },
    read: async () => ({ text: '其他对话正文', ansi: '' }),
    input: async () => {
      writes++;
    },
    keys: async () => {
      writes++;
    },
    close: async () => {},
    watch: async () => () => {},
  };
  const options = { host, dataDir: cwd, workerToolUrl: 'https://workbench.example.test/api/v1/worker-tools/todo-bind-thread', machineId: 'node', hasCommand: () => true, validateResume: async () => ({}) };
  delete process.env.SUPER_MARIO_CODEX_SOCKET;
  const localPty = createExecutionServices(options);
  assert.equal(localPty.handlers['executor.turnResult'], undefined);
  await localPty.close();
  process.env.SUPER_MARIO_CODEX_SOCKET = path;
  const node = createExecutionServices(options);
  delete process.env.SUPER_MARIO_CODEX_SOCKET;
  const call = (name: string, params: JsonObject) => node.handlers[name](params, () => {});
  const launch = (await call('executor.resume', {
    executorId: 'codex',
    mode: 'interactive',
    nativeSessionId,
    prompt: '合成启动',
    cwd,
  })) as unknown as SessionBinding;
  const { sessionId } = launch;
  assert.equal(Object.hasOwn(launch, 'workerToolKeyHash'), false);
  assert.deepEqual(created, ['codex', '--remote', 'unix://' + path, 'resume', '--', nativeSessionId, '合成启动']);
  const input = { sessionId, text: words, clientMessageId: 'source' },
    query = { sessionId, clientMessageId: 'source', nativeSessionId, turnId };
  const started = { requested: true, clientMessageId: 'source', nativeSessionId, turnId };
  assert.deepEqual(await call('executor.input.once', input), started);
  assert.deepEqual(await call('executor.input.once', input), started);
  assert.deepEqual(
    calls.map((x) => x.method),
    ['initialize', 'initialized', 'thread/loaded/list', 'thread/read', 'thread/resume', 'turn/start']
  );
  assert.deepEqual(calls.at(-1)?.params, {
    threadId: nativeSessionId,
    input: [{ type: 'text', text: words, text_elements: [] }],
  });
  const result = () => call('executor.turnResult', query) as Promise<JsonObject>;
  const prefix = { ...query, source: 'codex-app-server' };
  turns = [{ id: turnId, status: 'inProgress', items: [] }];
  assert.deepEqual(await result(), { ...prefix, state: 'running' });
  const user = { type: 'userMessage', content: [{ type: 'text', text: words }] };
  const final = { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '本轮的合成结论' };
  const done = { id: turnId, status: 'completed', items: [user, { type: 'reasoning', text: '私人推理' }, final] };
  turns = [{ id: 'other', status: 'completed', items: [{ ...final, text: '别人的结论' }] }, done];
  assert.deepEqual(await result(), { ...prefix, state: 'completed', text: final.text });
  turnsApi = 'new';
  assert.deepEqual(await result(), { ...prefix, state: 'completed', text: final.text });
  turnsApi = 'error';
  const fullReads = () => calls.filter((c) => c.method === 'thread/read' && c.params.includeTurns).length;
  const beforeReads = fullReads();
  assert.equal((await result()).state, 'unknown');
  assert.equal(fullReads(), beforeReads);
  turnsApi = 'new';
  for (const row of [
    { ...done, items: [user, final, user] },
    { ...done, items: [user, final, final] },
    { ...done, items: [user, { ...final, phase: 'commentary' }] },
    { ...done, items: [{ ...user, content: [{ type: 'text', text: '其他输入' }] }, final] },
    { ...done, status: 'interrupted' },
  ]) {
    turns = [row];
    assert.deepEqual(await result(), { ...prefix, state: 'failed' });
  }
  turns = [done, done];
  assert.equal((await result()).state, 'unknown');
  const oldCalls = calls.length;
  const wrong = { ...query, turnId: 'wrong' };
  assert.deepEqual(await call('executor.turnResult', wrong), { ...wrong, state: 'unknown' });
  assert.equal(calls.length, oldCalls);
  const rejected: string[] = [];
  for (const change of [
    () => {
      status = 'active';
    },
    () => {
      status = 'idle';
      threadCwd = '/other';
    },
    () => {
      threadCwd = cwd;
      thread = 'elsewhere';
    },
    () => {
      thread = nativeSessionId;
      loaded = false;
    },
  ]) {
    change();
    const before = calls.filter((c) => c.method === 'turn/start').length;
    const id = 'blocked-' + calls.length;
    rejected.push(id);
    assert.deepEqual(await call('executor.input.once', { ...input, clientMessageId: id }), {requested:false, state:'not-sent', clientMessageId:id});
    assert.equal(calls.filter((c) => c.method === 'turn/start').length, before);
  }
  loaded = true;
  loseStart = true;
  const lost = { ...input, clientMessageId: 'lost' };
  assert.deepEqual(await call('executor.input.once', lost), { state: 'unknown', clientMessageId: 'lost' });
  const attempts = calls.filter((c) => c.method === 'turn/start').length;
  assert.deepEqual(await call('executor.input.once', lost), { state: 'unknown', clientMessageId: 'lost' });
  assert.equal(calls.filter((c) => c.method === 'turn/start').length, attempts);
  assert.equal(writes, 0);
  turns = [done];
  loseStart = false;
  assert.deepEqual(await call('executor.input.once', { ...input, clientMessageId: 'conflict' }), {
    state: 'unknown',
    clientMessageId: 'conflict',
  });
  assert.deepEqual(await result(), { ...query, state: 'unknown' });
  assert.deepEqual(await call('executor.input.once', input), { requested: true, clientMessageId: 'source' });
  startId = 'other-bound-turn';
  const otherInput = { ...input, clientMessageId: 'second-source' },
    otherQuery = { ...query, turnId: startId, clientMessageId: otherInput.clientMessageId };
  await call('executor.input.once', otherInput);
  turns = [{ ...done, id: startId }];
  assert.equal(((await call('executor.turnResult', otherQuery)) as JsonObject).text, final.text);
  await chmod(path, 0o660);
  assert.throws(() => codexTurnEndpoint(path, cwd, nativeSessionId), /private/);
  await chmod(path, 0o600);
  await chmod(cwd, 0o755);
  assert.throws(() => codexTurnEndpoint(path, cwd, nativeSessionId), /private/);
  await chmod(cwd, 0o700);
  await symlink(path, join(cwd, 'alias'));
  assert.throws(() => codexTurnEndpoint(join(cwd, 'alias'), cwd, nativeSessionId), /alias/);
  await rename(path, path + '.old');
  const replacement = createServer();
  let connections = 0;
  replacement.on('connection', () => {
    connections++;
  });
  await new Promise<void>((ok) => replacement.listen(path, ok));
  await chmod(path, 0o600);
  t.after(() => replacement.close());
  assert.equal(((await call('executor.turnResult', otherQuery)) as JsonObject).state, 'unknown');
  assert.equal(connections, 0);
  process.env.SUPER_MARIO_CODEX_SOCKET = path;
  const reopened = createExecutionServices(options);
  assert.deepEqual(await reopened.handlers['executor.input.once'](input, () => {}), {
    requested: true,
    clientMessageId: 'source',
  });
  assert.deepEqual(await reopened.handlers['executor.turnResult'](query, () => {}), { ...query, state: 'unknown' });
  for (const clientMessageId of rejected) {
    assert.deepEqual(await reopened.handlers['executor.input.once']({...input, clientMessageId}, () => {}), {requested:false, state:'not-sent', clientMessageId});
  }
  await reopened.close();
  await node.close();
});
