import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExecutionServices } from '../plugins/executors.ts';
import type { Dispose, TerminalHost } from '../packages/plugin-sdk/src/index.ts';
import type { Json, JsonObject, PaneInfo, SessionBinding, TerminalFrame } from '../packages/protocol/src/index.ts';

// Explicit test double: never launches a real CLI or accesses a user terminal.
class FakeHost implements TerminalHost {
  available = true;
  panes: PaneInfo[] = [];
  creates: Array<{ cwd: string; argv: string[]; name: string }> = [];
  writes: Array<{ paneId: string; text?: string; keys?: string[] }> = [];
  closes: string[] = [];
  disposed = 0;
  disposeFailures = 0;
  watchError?: Error;
  watchers: Array<{ frame: (frame: TerminalFrame) => void; error: (error: Error) => void }> = [];
  inputGate?: Promise<void>;
  inputError?: Error;
  keysError?: Error;
  watchGate?: Promise<void>;
  async status() { return { available: this.available, reason: this.available ? undefined : 'fake host unavailable' }; }
  async list() { return this.panes; }
  async create(spec: { cwd: string; argv: string[]; name: string }) {
    this.creates.push(spec);
    const pane = { id: `fake-${this.creates.length}`, title: spec.name, cwd: spec.cwd };
    this.panes.push(pane);
    return pane;
  }
  async read(paneId: string) { if (!this.panes.some(p => p.id === paneId)) throw new Error('missing pane'); return { text: 'fake CLI screen: done', ansi: '\x1b[32mfake CLI screen\x1b[0m' }; }
  async input(paneId: string, text: string) { this.writes.push({ paneId, text }); await this.inputGate; if (this.inputError) throw this.inputError; }
  async keys(paneId: string, keys: string[]) { this.writes.push({ paneId, keys }); if (this.keysError) throw this.keysError; }
  async close(paneId: string) { this.closes.push(paneId); this.panes = this.panes.filter(p => p.id !== paneId); }
  async watch(_paneId: string, frame: (frame: TerminalFrame) => void, error: (error: Error) => void): Promise<Dispose> {
    this.watchers.push({ frame, error });
    await this.watchGate;
    if (this.watchError) throw this.watchError;
    return () => { if (this.disposeFailures > 0) { this.disposeFailures--; throw new Error('fake dispose failure'); } this.disposed++; };
  }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'super-mario-executors-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = new FakeHost();
  const options = { host, dataDir: join(dir, 'data'), hasCommand: () => true };
  const service = createExecutionServices(options);
  t.after(() => service.disconnect());
  const call = (method: string, params: JsonObject = {}, emit = (_event: string, _data: Json) => {}) => service.handlers[method]!(params, emit);
  const start = (executorId = 'codex', prompt = 'test prompt') => call('executor.start', { executorId, prompt, cwd: dir }) as unknown as Promise<SessionBinding>;
  return { dir, host, options, service, call, start };
}

test('node handlers do not expose project purge operations', async t => {
  const { service } = await fixture(t);
  assert.equal(service.handlers['workspace.executor.purge'], undefined);
  assert.equal(service.handlers['workspace.knowledge.purge'], undefined);
});

test('interactive argv preserves prompts as one positional argument; bindings persist and recover', async t => {
  const { dir, host, options, call, start } = await fixture(t);
  const prompt = '--help $(touch nope); "quoted"\nnext line';
  const codex = await start('codex', prompt);
  const claude = await start('claude-code', prompt);
  assert.deepEqual(host.creates[0]!.argv, ['codex', '--', prompt]);
  assert.deepEqual(host.creates[1]!.argv, ['claude', '--session-id', claude.sessionId, '--', prompt]);
  assert.equal(host.creates[0]!.cwd, dir);
  assert.deepEqual(JSON.parse(await readFile(join(options.dataDir, 'executor-sessions.json'), 'utf8')), [codex, claude]);
  const restored = createExecutionServices(options);
  await assert.rejects(restored.handlers['executor.read']!({ sessionId: codex.sessionId }, () => {}), /Historical session ownership/);
  await assert.rejects(restored.handlers['executor.input']!({ sessionId: codex.sessionId, text: 'follow up' }, () => {}), /Historical session ownership/);
  const result = await call('executor.read', { sessionId: codex.sessionId });
  assert.deepEqual(result, { text: 'fake CLI screen: done', ansi: '\x1b[32mfake CLI screen\x1b[0m', state: 'unknown', source: 'screen' });
  await call('executor.input', { sessionId: codex.sessionId, text: 'follow up' });
  assert.equal(host.writes[0]!.text, 'follow up');
  assert.deepEqual(await call('executor.interrupt', { sessionId: claude.sessionId }), { requested: true });
  assert.deepEqual(host.writes[1]!.keys, ['Enter']);
  assert.deepEqual(host.writes[2]!.keys, ['C-c']);
});

test('availability checks host and PATH without asserting login or native hook support', async t => {
  const { host, options, service } = await fixture(t);
  let info = await service.describe('fake-machine');
  assert.ok(info.every(e => e.available && e.mode === 'real' && e.machineId === 'fake-machine'));
  assert.match(info[0]!.description, /不证明已认证/);
  assert.match(info[0]!.description, /未接入原生 hook 或审批/);
  info = await createExecutionServices({ ...options, hasCommand: name => name === 'codex' }).describe('fake-machine');
  assert.equal(info[1]!.available, false);
  assert.match(info[1]!.reason!, /claude/);
  host.available = false;
  info = await service.describe('fake-machine');
  assert.ok(info.every(e => !e.available && e.reason === 'fake host unavailable'));
});

test('invalid launch inputs and unavailable dependencies never create a PTY', async t => {
  const { dir, host, options, call, start } = await fixture(t);
  await assert.rejects(start('other'), /Unsupported/);
  await assert.rejects(start('codex', ' '), /prompt/);
  await assert.rejects(call('executor.start', { executorId: 'codex', prompt: 'x', cwd: join(dir, 'absent') }));
  const regularFile = join(dir, 'file');
  await writeFile(regularFile, 'test');
  await assert.rejects(call('executor.start', { executorId: 'codex', prompt: 'x', cwd: regularFile }), /directory/);
  const unavailable = createExecutionServices({ ...options, hasCommand: () => false });
  await assert.rejects(unavailable.handlers['executor.start']!({ executorId: 'codex', prompt: 'x', cwd: dir }, () => {}), /PATH/);
  host.available = false;
  await assert.rejects(start(), /fake host unavailable/);
  assert.equal(host.creates.length, 0);
});

test('unbound sessions and external panes cannot be written, interrupted, or closed', async t => {
  const { dir, host, call } = await fixture(t);
  host.panes.push({ id: 'external', title: 'user terminal', cwd: dir });
  for (const method of ['executor.input', 'executor.interrupt', 'executor.read']) {
    await assert.rejects(call(method, { sessionId: 'external', text: 'unsafe' }), /not bound/);
  }
  for (const method of ['terminal.input', 'terminal.keys', 'terminal.close']) {
    await assert.rejects(call(method, { paneId: 'external', text: 'unsafe', keys: ['C-c'] }), /not bound/);
  }
  assert.equal(host.writes.length, 0);
  assert.equal(host.closes.length, 0);
  assert.ok(await call('terminal.read', { paneId: 'external' }));
});

test('writes reject overlap across executor and terminal aliases and never retry failed input', async t => {
  const { host, call, start } = await fixture(t);
  const b = await start();
  let release!: () => void;
  host.inputGate = new Promise<void>(r => { release = r; });
  const pending = call('executor.input', { sessionId: b.sessionId, text: 'one' });
  await assert.rejects(call('terminal.input', { paneId: b.paneId, text: 'two' }), /already has a writer/);
  await assert.rejects(call('executor.interrupt', { sessionId: b.sessionId }), /already has a writer/);
  release();
  await pending;
  host.inputError = new Error('fake transport outcome unknown');
  await assert.rejects(call('executor.input', { sessionId: b.sessionId, text: 'three' }), /unknown/);
  assert.deepEqual(host.writes, [
    { paneId: b.paneId, text: 'one' }, { paneId: b.paneId, keys: ['Enter'] },
    { paneId: b.paneId, text: 'three' },
  ]);
  host.inputError = undefined;
  await call('executor.interrupt', { sessionId: b.sessionId });
});

test('recovered writes refuse missing panes and changed cwd', async t => {
  const { dir, host, call, start } = await fixture(t);
  const b = await start();
  host.panes[0]!.cwd = join(dir, 'different');
  await assert.rejects(call('executor.input', { sessionId: b.sessionId, text: 'x' }), /cwd changed/);
  host.panes.length = 0;
  await assert.rejects(call('executor.interrupt', { sessionId: b.sessionId }), /missing/);
  assert.equal(host.writes.length, 0);
});

test('watch/unwatch and disconnect dispose observers without closing PTYs; late frames are ignored', async t => {
  const { host, service, call, start } = await fixture(t);
  const b = await start();
  const events: Array<{ event: string; data: Json }> = [];
  const emit = (event: string, data: Json) => { events.push({ event, data }); };
  const first = await call('terminal.watch', { paneId: b.paneId }, emit) as { watchId: string };
  const frame: TerminalFrame = { epoch: 'fake', seq: 1, full: true, width: 80, height: 24, data: 'fake screen' };
  host.watchers[0]!.frame(frame);
  assert.deepEqual(events[0], { event: 'terminal.frame', data: { watchId: first.watchId, paneId: b.paneId, ...frame } });
  host.watchers[0]!.error(new Error('fake observer failure'));
  assert.equal(events[1]!.event, 'terminal.error');
  await call('terminal.unwatch', first);
  await call('terminal.unwatch', first);
  await call('terminal.watch', { paneId: b.paneId }, emit);
  await service.disconnect();
  await service.disconnect();
  host.watchers.forEach(w => w.frame(frame));
  assert.equal(events.length, 2);
  assert.equal(host.disposed, 2);
  assert.equal(host.closes.length, 0);
  await call('executor.input', { sessionId: b.sessionId, text: 'still running' });
});

test('disconnect waits for pending watch registration and releases it', async t => {
  const { host, service, call, start } = await fixture(t);
  const b = await start();
  let release!: () => void;
  host.watchGate = new Promise<void>(r => { release = r; });
  const pending = call('terminal.watch', { paneId: b.paneId });
  const cleanup = service.disconnect();
  release();
  await Promise.all([pending, cleanup]);
  assert.equal(host.disposed, 1);
  assert.equal(host.closes.length, 0);
});

test('explicit terminal creation grants writes; close revokes them', async t => {
  const { dir, host, call } = await fixture(t);
  const pane = await call('terminal.create', { cwd: dir, argv: ['fake-shell', '-l'], name: 'test terminal' }) as { id: string };
  await call('terminal.input', { paneId: pane.id, text: 'test' });
  await call('terminal.keys', { paneId: pane.id, keys: ['Enter'] });
  await call('terminal.close', { paneId: pane.id });
  await assert.rejects(call('terminal.input', { paneId: pane.id, text: 'late' }), /not bound/);
  assert.deepEqual(host.closes, [pane.id]);
});

test('corrupt binding data fails visibly instead of silently adopting panes', async t => {
  const { dir, options } = await fixture(t);
  await writeFile(join(dir, 'executor-sessions.json'), JSON.stringify([{ executorId: 'constructor' }]));
  assert.throws(() => createExecutionServices({ ...options, dataDir: dir }), /Invalid executor session binding/);
});


test('executor prompts submit Enter while terminal input remains raw', async t => {
  const { host, call, start } = await fixture(t);
  const b = await start();
  await call('executor.input', { sessionId: b.sessionId, text: '\n' });
  await call('terminal.input', { paneId: b.paneId, text: ' ' });
  assert.deepEqual(host.writes, [
    { paneId: b.paneId, text: '\n' }, { paneId: b.paneId, keys: ['Enter'] },
    { paneId: b.paneId, text: ' ' },
  ]);
});

test('failed observer disposal remains reachable and disconnect attempts every observer', async t => {
  const { host, service, call, start } = await fixture(t);
  const b = await start();
  await call('terminal.watch', { paneId: b.paneId });
  await call('terminal.watch', { paneId: b.paneId });
  host.disposeFailures = 1;
  await assert.rejects(service.disconnect(), /fake dispose failure/);
  assert.equal(host.disposed, 1);
  await service.disconnect();
  assert.equal(host.disposed, 2);
  assert.equal(host.closes.length, 0);
});

test('failed observer registration is reported without a dangling subscription', async t => {
  const { host, service, call, start } = await fixture(t);
  const b = await start();
  host.watchError = new Error('fake watch failure');
  await assert.rejects(call('terminal.watch', { paneId: b.paneId }), /fake watch failure/);
  await service.disconnect();
  assert.equal(host.disposed, 0);
  assert.equal(host.closes.length, 0);
});

test('binding persistence failure reports uncertain launch and does not adopt or kill PTY', async t => {
  const { dir, host } = await fixture(t);
  const service = createExecutionServices({ host, dataDir: dir, hasCommand: () => true });
  // Fail binding persistence after initialization, without failing the independent knowledge worker.
  await mkdir(join(dir, 'executor-sessions.json'));
  await assert.rejects(service.handlers['executor.start']!({ executorId: 'codex', prompt: 'test', cwd: dir }, () => {}), /binding persistence failed; outcome unknown/);
  assert.equal(host.creates.length, 1);
  await assert.rejects(service.handlers['terminal.input']!({ paneId: host.panes[0]!.id, text: 'unsafe retry' }, () => {}), /not bound/);
  assert.equal(host.closes.length, 0);
});


test('executor.sessions returns independent bindings, including restored sessions', async t => {
  const { options, call, start } = await fixture(t);
  assert.deepEqual(await call('executor.sessions'), []);
  const a = await start();
  const b = await start('claude-code');
  const sessions = await call('executor.sessions') as unknown as SessionBinding[];
  assert.deepEqual(sessions, [a, b]);
  sessions[0]!.paneId = 'external mutation';
  assert.deepEqual(await call('executor.sessions'), [a, b]);
  const restored = createExecutionServices(options);
  assert.deepEqual(await restored.handlers['executor.sessions']!({}, () => {}), [a, b]);
});

test('failed Enter has unknown outcome and is never resent; writer lock is released', async t => {
  const { host, call, start } = await fixture(t);
  const b = await start();
  host.keysError = new Error('fake key transport failure');
  await assert.rejects(call('executor.input', { sessionId: b.sessionId, text: 'follow up' }), /outcome unknown/);
  assert.deepEqual(host.writes, [
    { paneId: b.paneId, text: 'follow up' }, { paneId: b.paneId, keys: ['Enter'] },
  ]);
  host.keysError = undefined;
  await call('terminal.input', { paneId: b.paneId, text: 'raw' });
  assert.deepEqual(host.writes[2], { paneId: b.paneId, text: 'raw' });
});

test('task mode launches only its Node runner with private config and recovers persisted results', async t => {
  const { dir, host, options, call, service } = await fixture(t);
  const b = await call('executor.start', { executorId: 'codex', prompt: 'task prompt', cwd: dir, mode: 'task' }) as unknown as SessionBinding;
  const args = host.creates[0]!.argv;
  assert.equal(args[0], process.execPath);
  assert.match(args[1]!, /task-runner\.ts$/);
  const config = JSON.parse(await readFile(args[2]!, 'utf8'));
  assert.equal(config.prompt, 'task prompt');
  assert.equal(config.cwd, dir);
  assert.equal(config.executorId, 'codex');
  const { stat } = await import('node:fs/promises');
  assert.equal((await stat(args[2]!)).mode & 0o777, 0o600);
  assert.equal((await call('executor.result', { sessionId: b.sessionId }) as { state: string }).state, 'unknown');
  const result = { state: 'completed', text: 'native task result', source: 'codex-json', exitCode: 0, nativeSessionId: 'original-thread' };
  await writeFile(config.resultsPath, JSON.stringify(result));
  await service.disconnect();
  host.panes.length = 0;
  const restored = createExecutionServices(options);
  assert.deepEqual(await restored.handlers['executor.result']!({ sessionId: b.sessionId }, () => {}), result);
  assert.equal(host.closes.length, 0);
  assert.equal(host.writes.length, 0);
  assert.ok((await service.describe('machine')).every(e => e.defaultCwd === process.cwd()));
});

test('interactive result stays unknown and invalid task modes never create panes', async t => {
  const { dir, host, call, start } = await fixture(t);
  const b = await start();
  assert.deepEqual(await call('executor.result', { sessionId: b.sessionId }), { state: 'unknown', text: 'fake CLI screen: done', source: 'screen' });
  await assert.rejects(call('executor.result', { sessionId: 'external' }), /not bound/);
  await assert.rejects(call('executor.start', { executorId: 'codex', cwd: dir, prompt: 'x', mode: 'invalid' }), /Invalid mode/);
  assert.equal(host.creates.length, 1);
});

test('pi advertises native task results and accepts only a new task', async t => {
  const { host, options, dir } = await fixture(t);
  const launcher = { command: '/local/pi-test', profile: { configDir: join(dir, 'pi-profile') } };
  const service = createExecutionServices({ ...options, launchers: { pi: launcher },
    hasCommand: cmd => cmd === launcher.command, validateResume: async () => {} });
  const info = (await service.describe('machine')).find(entry => entry.id === 'pi');
  assert.equal(info?.available, true);
  assert.deepEqual(info?.nativeResultSources, ['pi-json']);
  const params = { executorId: 'pi', cwd: dir, prompt: 'work' };
  await assert.rejects(service.handlers['executor.start']!(params, () => {}), /new tasks only/);
  await assert.rejects(service.handlers['executor.resume']!({ ...params, mode: 'task', nativeSessionId: 'old' }, () => {}), /new tasks only/);
  assert.equal(host.creates.length, 0);
  await service.handlers['executor.start']!({ ...params, mode: 'task' }, () => {});
  const config = JSON.parse(await readFile(host.creates[0]!.argv[2]!, 'utf8'));
  assert.equal(config.executorId, 'pi');
  assert.deepEqual(config.launcher, launcher);
});
