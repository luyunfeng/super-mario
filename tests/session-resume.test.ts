import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TerminalHost } from '../packages/plugin-sdk/src/index.ts';
import type { JsonObject, NativeResumeSpec, SessionBinding } from '../packages/protocol/src/index.ts';
import { createExecutionServices } from '../plugins/executors.ts';
import { buildNativeResumeCommand } from '../plugins/session-resume.ts';

type Validation = (input: NativeResumeSpec & { cwd: string }) => Promise<unknown>;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-resume-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const creates: Array<{ argv: string[]; cwd: string; name: string }> = [];
  let available = true, present = true;
  const host: TerminalHost = {
    status: async () => ({ available, reason: 'fake host unavailable' }),
    create: async spec => { creates.push(spec); return { id: `pane-${creates.length}`, cwd: spec.cwd, title: spec.name }; },
    list: async () => [], read: async () => ({ text: 'done', ansi: 'done' }),
    input: async () => { throw new Error('unexpected write'); }, keys: async () => { throw new Error('unexpected keys'); },
    close: async () => { throw new Error('unexpected close'); }, watch: async () => () => {},
  };
  const options = { host, dataDir: join(dir, 'data'), hasCommand: () => present };
  const services: ReturnType<typeof createExecutionServices>[] = [];
  const service = (validateResume?: Validation) => {
    const s = createExecutionServices({ ...options, ...(validateResume ? { validateResume } : {}) });
    services.push(s); return s;
  };
  t.after(async () => { for (const s of services) { await s.disconnect(); await s.close(); } });
  const params: JsonObject = { executorId: 'codex', nativeSessionId: 'native-id', cwd: dir, prompt: '--option $(touch unsafe);\nnext' };
  return { dir, creates, options, service, params, unavailable: () => { available = false; }, missing: () => { present = false; } };
}
const emit = () => {};

test('builder constructs exact native argv without shell or permission bypass', () => {
  const base = { nativeSessionId: 'native-id', cwd: '/tmp/project', prompt: '--prompt ; $(echo x)' };
  assert.deepEqual(buildNativeResumeCommand({ ...base, executorId: 'codex', mode: 'interactive' }), { command: 'codex', args: ['resume', '--', base.nativeSessionId, base.prompt] });
  assert.deepEqual(buildNativeResumeCommand({ ...base, executorId: 'codex', mode: 'task', resultsPath: '/tmp/result.json' }), {
    command: 'codex', args: ['--sandbox', 'workspace-write', 'exec', 'resume', '--json', '--skip-git-repo-check', '--output-last-message', '/tmp/result.json.last-message', '--', base.nativeSessionId, base.prompt],
  });
  assert.deepEqual(buildNativeResumeCommand({ ...base, executorId: 'claude-code', mode: 'interactive' }), { command: 'claude', args: ['--resume', base.nativeSessionId, '--', base.prompt] });
  assert.deepEqual(buildNativeResumeCommand({ ...base, executorId: 'claude-code', mode: 'task' }), { command: 'claude', args: ['--resume', base.nativeSessionId, '-p', '--output-format', 'stream-json', '--verbose', '--', base.prompt] });
});

test('builder rejects unsafe or absent IDs, relative cwd, and empty prompt', () => {
  const base = { executorId: 'codex' as const, nativeSessionId: 'ok', mode: 'interactive' as const, cwd: '/tmp', prompt: 'continue' };
  for (const nativeSessionId of ['', '-last', 'a b', 'a\nb', 'a\0b', 'a\x7fb', 'x'.repeat(513)]) assert.throws(() => buildNativeResumeCommand({ ...base, nativeSessionId }));
  for (const cwd of ['relative', '/tmp\0bad']) assert.throws(() => buildNativeResumeCommand({ ...base, cwd }));
  for (const prompt of ['', '  ', 'bad\0prompt']) assert.throws(() => buildNativeResumeCommand({ ...base, prompt }));
});

test('resume capability is opt-in; start explicitly rejects resume fields', async t => {
  const f = await fixture(t), old = f.service();
  assert.equal(Object.hasOwn(old.handlers, 'executor.resume'), false);
  assert.equal(Object.hasOwn(f.service(async () => {}).handlers, 'executor.resume'), true);
  for (const key of ['resume', 'nativeResume', 'nativeSessionId']) {
    await assert.rejects(old.handlers['executor.start']!({ executorId: 'codex', cwd: f.dir, prompt: 'x', [key]: 'id' }, emit), /executor.resume/);
  }
  assert.equal(f.creates.length, 0);
});

test('resume validates ownership before launch, persists fields, and only restores bindings on restart', async t => {
  const f = await fixture(t);
  const validations: unknown[] = [];
  const s = f.service(async input => { assert.equal(f.creates.length, 0); validations.push(input); });
  const b = await s.handlers['executor.resume']!(f.params, emit) as unknown as SessionBinding;
  assert.deepEqual(validations, [{ executorId: 'codex', nativeSessionId: 'native-id', cwd: f.dir }]);
  assert.deepEqual(f.creates[0]!.argv, ['codex', 'resume', '--', 'native-id', f.params.prompt]);
  assert.equal(f.creates[0]!.cwd, f.dir);
  assert.deepEqual(b.nativeResume, { executorId: 'codex', nativeSessionId: 'native-id' });
  assert.equal(b.nativeSessionId, 'native-id');
  assert.deepEqual(await s.handlers['executor.result']!({ sessionId: b.sessionId }, emit), { state: 'unknown', text: 'done', source: 'screen' });
  const restored = f.service();
  assert.deepEqual(await restored.handlers['executor.sessions']!({}, emit), [b]);
  const rows = await s.handlers['executor.sessions']!({}, emit) as unknown as SessionBinding[];
  rows[0]!.nativeResume!.nativeSessionId = 'mutated';
  assert.deepEqual(await s.handlers['executor.sessions']!({}, emit), [b]);
  assert.equal(f.creates.length, 1);
});

test('task resume uses existing runner and private config with native session ID', async t => {
  const f = await fixture(t), s = f.service(async () => {});
  const b = await s.handlers['executor.resume']!({ ...f.params, mode: 'task' }, emit) as unknown as SessionBinding;
  assert.equal(f.creates[0]!.argv[0], process.execPath);
  assert.match(f.creates[0]!.argv[1]!, /task-runner\.ts$/);
  const config = JSON.parse(await readFile(f.creates[0]!.argv[2]!, 'utf8'));
  assert.equal(config.nativeSessionId, 'native-id');
  assert.equal(config.cwd, f.dir);
  assert.deepEqual(await f.service().handlers['executor.sessions']!({}, emit), [b]);
  assert.equal(f.creates.length, 1);
});

for (const failure of ['validator', 'host', 'PATH', 'directory', 'relative', 'id', 'mode', 'extra', 'changed-host', 'changed-PATH', 'changed-directory'] as const) {
  test(`preflight ${failure} creates no pane or task files`, async t => {
    const f = await fixture(t);
    let validations = 0;
    const s = f.service(async () => {
      validations++;
      if (failure === 'validator') throw new Error('wrong cwd ownership');
      if (failure === 'changed-host') f.unavailable();
      if (failure === 'changed-PATH') f.missing();
      if (failure === 'changed-directory') await rm(join(f.dir, 'cwd'), { recursive: true });
    });
    const cwd = join(f.dir, 'cwd'); await mkdir(cwd);
    const params: JsonObject = { ...f.params, cwd, mode: 'task' };
    if (failure === 'host') f.unavailable();
    if (failure === 'PATH') f.missing();
    if (failure === 'directory') params.cwd = join(f.dir, 'absent');
    if (failure === 'relative') params.cwd = '.';
    if (failure === 'id') params.nativeSessionId = '-last';
    if (failure === 'mode') params.mode = 'invalid';
    if (failure === 'extra') params.fork = true;
    const before = await readdir(f.options.dataDir, { recursive: true });
    await assert.rejects(s.handlers['executor.resume']!(params, emit));
    assert.deepEqual(await readdir(f.options.dataDir, { recursive: true }), before);
    assert.equal(f.creates.length, 0);
    if (['host', 'PATH', 'directory', 'relative', 'id', 'mode', 'extra'].includes(failure)) assert.equal(validations, 0);
  });
}

test('resume persistence failure and host transport uncertainty never replay launch', async t => {
  const f = await fixture(t), s = f.service(async () => {});
  await mkdir(join(f.options.dataDir, 'executor-sessions.json'));
  await assert.rejects(s.handlers['executor.resume']!(f.params, emit), /binding persistence failed; outcome unknown/);
  await s.disconnect();
  assert.deepEqual(await s.handlers['executor.sessions']!({}, emit), []);
  assert.equal(f.creates.length, 1);
});

test('persisted invalid native fields are rejected; old bindings still load', async t => {
  const f = await fixture(t); f.service();
  const path = join(f.options.dataDir, 'executor-sessions.json');
  const old = { sessionId: 'old', paneId: 'pane', executorId: 'codex', cwd: f.dir, createdAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify([old]));
  assert.deepEqual(await f.service().handlers['executor.sessions']!({}, emit), [old]);
  for (const fields of [{ nativeSessionId: '-bad' }, { nativeSessionId: null }, { nativeResume: null }, { nativeResume: { executorId: 'other', nativeSessionId: 'id' } }, { nativeResume: { executorId: 'codex', nativeSessionId: 'id', fork: true } }, { nativeResume: { executorId: 'codex', nativeSessionId: 'id' }, nativeSessionId: 'different' }]) {
    await writeFile(path, JSON.stringify([{ ...old, ...fields }]));
    assert.throws(() => f.service(), /Invalid executor session binding/);
  }
});

test('resume RPC capabilities and disconnect preserve unknown delivery without replaying launch', async t => {
  const { EventEmitter } = await import('node:events');
  const { createMachineHub, MachineError } = await import('../packages/core/src/machines.ts');
  const { createStore } = await import('../packages/core/src/store.ts');
  const { createEventBus } = await import('../packages/core/src/events.ts');
  const f = await fixture(t);
  const store = createStore(':memory:');
  const hub = createMachineHub({ store, events: createEventBus(store) });
  t.after(() => { hub.close(); store.close(); });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = f.service(async () => gate);
  let calls = 0;
  let work: Promise<unknown> | undefined;
  function connect(s: ReturnType<typeof createExecutionServices>) {
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      close() {},
      send(payload: string, callback?: (error?: Error) => void) {
        const message = JSON.parse(payload);
        if (message.type === 'call') {
          calls++;
          work = s.handlers[message.method]!(message.params, emit).then(result => {
            hub.handle(socket as unknown as import('ws').default, { type: 'result', id: message.id, result });
          });
        }
        callback?.();
      },
    });
    const ws = socket as unknown as import('ws').default;
    hub.attach(ws, { type: 'hello', machineId: 'fake-node', name: 'fake', platform: 'linux', capabilities: Object.keys(s.handlers) });
    return ws;
  }
  const old = connect(f.service());
  await assert.rejects(hub.call('fake-node', 'executor.resume', f.params), (error: unknown) => error instanceof MachineError && error.delivery === 'no');
  assert.equal(calls, 0);
  hub.detach(old);
  const current = connect(service);
  const pending = hub.call('fake-node', 'executor.resume', f.params);
  hub.detach(current);
  await assert.rejects(pending, (error: unknown) => error instanceof MachineError && error.delivery === 'unknown');
  release();
  await work;
  assert.equal(f.creates.length, 1);
  connect(f.service());
  assert.equal(calls, 1);
  const rows = await service.handlers['executor.sessions']!({}, emit) as unknown as SessionBinding[];
  assert.equal(rows[0]!.nativeSessionId, 'native-id');
  assert.equal(f.creates.length, 1);
});
