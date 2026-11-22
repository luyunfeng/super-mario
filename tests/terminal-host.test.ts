import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { terminalCommand, terminalSocketPath } from '../plugins/terminal-endpoint.ts';
import { createTerminalHost } from '../plugins/terminal-host.ts';
import type { TerminalFrame } from '../packages/protocol/src/index.ts';

// Explicit fake executable: no installed CLI, real daemon or user panes are used.
const fakeSource = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
const mode = process.env.FAKE_MODE;
const pane = { pane_id: 'workspace:1.1', cwd: '/tmp/example', label: 'Example' };
const output = result => console.log(JSON.stringify({ id: 'fake', result }));
if (args[0] === '--version') console.log('herdr fake-version');
else if (args.join(' ') === 'terminal session observe --help') {
  if (mode === 'unsupported') process.exit(2);
  console.log('Observe a terminal stream: observe TARGET');
} else if (args.join(' ') === 'status server --json') console.log(JSON.stringify({ running: mode !== 'offline', compatible: mode !== 'incompatible', endpoint_compatible: true }));
else if (args[0] === 'tab' && args[1] === 'create') output({ root_pane: pane, tab: { label: 'Example' } });
else if (args[0] === 'pane') {
  if (mode === 'failure') { console.error('fake daemon unavailable'); process.exit(1); }
  if (mode === 'json-error') output({});
  else if (mode === 'rpc-error') console.log(JSON.stringify({ error: { code: 'pane_not_found' } }));
  else if (args[1] === 'list') output({ panes: [pane, { pane_id: 'workspace:1.2', title: 'Title', foreground_cwd: '/foreground' }, { pane_id: 'workspace:1.3' }] });
  else if (args[1] === 'read') process.stdout.write(args.at(-1) === 'ansi' ? '\\x1b[31m你好\\x1b[0m\\n' : '你好\\n');
  else if (mode === 'launch-failure' && args[1] === 'run') process.exit(1);
} else if (args.slice(0, 3).join(' ') === 'terminal session observe') {
  const frame = (seq, full = false) => ({ type: 'terminal.frame', seq, full, encoding: 'ansi', width: 80, height: 24, bytes: 'G1szMW3kvaDlpb0=' });
  console.error('old diagnostic: not a frame');
  if (mode === 'exit') { console.error('fake observer failed'); process.exit(7); }
  if (mode === 'closed') { console.log(JSON.stringify({ type: 'terminal.closed', reason: 'fake shutdown' })); process.exit(0); }
  if (mode === 'bad-json') console.log('{bad');
  else if (mode === 'bad-base64') console.log(JSON.stringify({ ...frame(1, true), bytes: '!!!' }));
  else if (mode === 'no-full') console.log(JSON.stringify(frame(1)));
  else {
    const first = JSON.stringify(frame(40, true)) + '\\n';
    process.stdout.write(first.slice(0, 20));
    setTimeout(() => { process.stdout.write(first.slice(20)); console.log(JSON.stringify(frame(mode === 'gap' ? 42 : 41))); }, 15);
  }
  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  else process.on('SIGTERM', () => { fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['observer-disposed']) + '\\n'); process.exit(0); });
  setInterval(() => {}, 1000);
} else { console.error('unexpected fake argv'); process.exit(2); }
`;

async function fixture(t: { after(fn: () => Promise<void>): void }, mode = '') {
  const dir = await mkdtemp(join(tmpdir(), 'super-mario-terminal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, 'fake-terminal.cjs');
  const log = join(dir, 'argv.ndjson');
  await writeFile(command, fakeSource);
  await chmod(command, 0o700);
  const host = createTerminalHost({ command, env: { FAKE_LOG: log, FAKE_MODE: mode } });
  const calls = async (): Promise<string[][]> => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { host, calls, dir };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('fake executable timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('status probes version, observation capability and running protocol without starting a daemon', async t => {
  const { host, calls } = await fixture(t);
  assert.deepEqual(await host.status(), { available: true });
  assert.deepEqual(await calls(), [['--version'], ['terminal', 'session', 'observe', '--help'], ['status', 'server', '--json']]);
  for (const mode of ['offline', 'unsupported', 'incompatible']) {
    const { host } = await fixture(t, mode);
    const status = await host.status();
    assert.equal(status.available, false);
    assert.ok(status.reason);
  }
  const missing = createTerminalHost({ command: join(tmpdir(), 'super-mario-missing-' + Date.now()) });
  assert.equal((await missing.status()).available, false);
  await assert.rejects(missing.list(), /ENOENT/);
});

test('service environment discovers named sockets and an installation outside its PATH', async t => {
  const { dir } = await fixture(t);
  const env = { HOME: dir, PATH: '/missing', XDG_CONFIG_HOME: join(dir, 'config'), HERDR_SESSION: 'review-1' };
  const userBin = join(dir, '.local', 'bin');
  await mkdir(userBin, { recursive: true });
  const installed = join(userBin, 'herdr');
  await writeFile(installed, '#!/bin/sh\n', { mode: 0o700 });
  assert.equal(terminalCommand(undefined, env), installed);
  assert.equal(terminalCommand('/missing/custom-herdr', env), '/missing/custom-herdr');
  assert.equal(terminalSocketPath(env), join(env.XDG_CONFIG_HOME, 'herdr/sessions/review-1/herdr.sock'));
  assert.equal(terminalSocketPath({ ...env, HERDR_SOCKET_PATH: '/tmp/custom.sock' }), '/tmp/custom.sock');
  assert.equal(terminalSocketPath({ HOME: dir }), join(dir, '.config/herdr/herdr.sock'));
  assert.throws(() => terminalSocketPath({ ...env, HERDR_SESSION: '../escape' }));
  assert.throws(() => terminalSocketPath({ ...env, HERDR_SESSION: 'x'.repeat(65) }));
});

test('explicit start is idempotent, coalesces concurrent callers and keeps agent credentials out of the host', async t => {
  const { dir } = await fixture(t);
  const command = join(dir, 'test-start.cjs');
  const state = join(dir, 'state');
  await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
const state = process.env.HERDR_SOCKET_PATH;
if (args === 'status server --json') {
  console.log(JSON.stringify({ running: fs.existsSync(state), compatible: true }));
} else if (args === 'server') {
  fs.appendFileSync(state, JSON.stringify({ leaked: !!process.env.SUPER_MARIO_TOKEN || !!process.env.ANTHROPIC_API_KEY, session: process.env.HERDR_SESSION }) + '\\n');
} else process.exit(1);
`, { mode: 0o700 });
  const host = createTerminalHost({ command, env: { HOME: dir, INVOCATION_ID: '', HERDR_ENV: '', HERDR_SOCKET_PATH: state,
    HERDR_SESSION: 'synthetic', SUPER_MARIO_TOKEN: 'fixture', ANTHROPIC_API_KEY: 'fixture' } });
  assert.deepEqual(await Promise.all([host.startServer(), host.startServer()]), [{ running: true }, { running: true }]);
  assert.deepEqual(await host.startServer(), { running: true });
  assert.deepEqual((await readFile(state, 'utf8')).trim().split('\n').map(s => JSON.parse(s)), [{ leaked: false, session: 'synthetic' }]);
  // Simulate a user manager and run its actual command vector locally; never contact systemd.
  const runtime = join(dir, 'runtime');
  await mkdir(join(runtime, 'systemd'), { recursive: true });
  await writeFile(join(runtime, 'systemd/private'), '');
  const managerLog = join(dir, 'unit-arguments');
  await writeFile(join(dir, 'systemd-run'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2);
const start = args.indexOf('/usr/bin/env');
fs.writeFileSync(process.env.FAKE_MANAGER_LOG, JSON.stringify(args.slice(0, start)));
process.exit(cp.spawnSync(args[start], args.slice(start + 1)).status);
`, { mode: 0o700 });
  const managedState = join(dir, 'managed');
  const managed = createTerminalHost({ command, env: { HOME: dir, PATH: dir + ':/usr/bin:/bin',
    INVOCATION_ID: 'fixture', HERDR_ENV: '', XDG_RUNTIME_DIR: runtime, HERDR_SOCKET_PATH: managedState,
    HERDR_SESSION: 'managed', FAKE_MANAGER_LOG: managerLog, SUPER_MARIO_TOKEN: 'fixture' } });
  assert.deepEqual(await managed.startServer(), { running: true });
  const flags = JSON.parse(await readFile(managerLog, 'utf8'));
  assert.deepEqual(flags.slice(0, -1), ['--user', '--quiet', '--collect', '--unit']);
  assert.match(flags.at(-1), /^super-mario-herdr-[a-f0-9]{16}$/);
  assert.deepEqual(JSON.parse(await readFile(managedState, 'utf8')), { leaked: false, session: 'managed' });
  const incompatible = await fixture(t, 'incompatible');
  await assert.rejects(incompatible.host.startServer(), /协议不兼容/);
  assert.deepEqual(await incompatible.calls(), [['status', 'server', '--json']]);
});

test('real argv contract and response wrappers for list/read/input/keys/close', async t => {
  const { host, calls } = await fixture(t);
  assert.deepEqual(await host.list(), [
    { id: 'workspace:1.1', title: 'Example', cwd: '/tmp/example' },
    { id: 'workspace:1.2', title: 'Title', cwd: '/foreground' },
    { id: 'workspace:1.3', title: '', cwd: '' },
  ]);
  assert.deepEqual(await host.read('workspace:1.1'), { text: '你好\n', ansi: '\x1b[31m你好\x1b[0m\n' });
  const text = '--help $(touch /should-not-run)\n中文';
  await host.input('workspace:1.1', text);
  await host.keys('workspace:1.1', ['Enter', 'ctrl-c']);
  await host.keys('workspace:1.1', []);
  await host.close('workspace:1.1');
  assert.deepEqual(await calls(), [
    ['pane', 'list'], ['pane', 'read', 'workspace:1.1', '--format', 'text'], ['pane', 'read', 'workspace:1.1', '--format', 'ansi'],
    ['pane', 'send-text', 'workspace:1.1', text], ['pane', 'send-keys', 'workspace:1.1', 'Enter', 'ctrl-c'], ['pane', 'close', 'workspace:1.1'],
  ]);
});

test('create passes cwd/name and launches exact argv without executing prompt as shell code', async t => {
  const { host, calls, dir } = await fixture(t);
  const marker = join(dir, 'must-not-exist');
  const argv = ['/usr/bin/printf', '%s\n', `'; touch ${marker}; #`, `$(touch ${marker})`, '`whoami`', '', 'a\nb', '中文', '--help'];
  const created = await host.create({ cwd: dir, name: '--name with quotes\'', argv });
  assert.equal(created.id, 'workspace:1.1');
  assert.equal(created.title, "--name with quotes'");
  const [create, rename, run] = await calls();
  assert.deepEqual(rename, ['pane', 'rename', 'workspace:1.1', "--name with quotes'"]);
  assert.deepEqual(create.slice(0, 7), ['tab', 'create', '--cwd', dir, '--label', "--name with quotes'", '--no-focus']);
  const launchEnv: NodeJS.ProcessEnv = {};
  for (let i = 7; i < create.length; i += 2) {
    if (create[i] === '--workspace') continue;
    assert.equal(create[i], '--env');
    const split = create[i + 1].indexOf('=');
    launchEnv[create[i + 1].slice(0, split)] = create[i + 1].slice(split + 1);
  }
  assert.deepEqual(run.slice(0, 3), ['pane', 'run', 'workspace:1.1']);
  // Only /bin/sh and printf execute here, in an isolated temporary directory.
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', run[3]], { env: { ...process.env, ...launchEnv } });
  assert.equal(stdout, argv.slice(2).join('\n') + '\n');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('invalid input fails before external actions; daemon failures remain visible', async t => {
  const { host } = await fixture(t);
  await assert.rejects(host.create({ cwd: 'relative', name: 'a', argv: ['echo'] }), /absolute/);
  await assert.rejects(host.create({ cwd: '/tmp', name: 'a', argv: [] }), /executable/);
  await assert.rejects(host.create({ cwd: '/tmp', name: 'a', argv: ['echo', '\0'] }), /argv/);
  await assert.rejects(host.close('--help'), /paneId/);
  await assert.rejects(host.input('id', '\0'), /text/);
  for (const mode of ['failure', 'json-error', 'rpc-error']) {
    const { host } = await fixture(t, mode);
    await assert.rejects(host.list());
  }
  const failed = await fixture(t, 'launch-failure');
  await assert.rejects(failed.host.create({ cwd: '/tmp', name: 'x', argv: ['echo'] }), /outcome unknown.*workspace:1.1/);
  assert.equal((await failed.calls()).length, 3);
});

test('observe preserves base64/full/seq, allocates epochs, and disposal only stops observers', async t => {
  const { host, calls } = await fixture(t);
  const frames: TerminalFrame[] = [];
  const errors: Error[] = [];
  const dispose = await host.watch('workspace:1.1', frame => frames.push(frame), error => errors.push(error));
  t.after(async () => { await dispose(); });
  await until(() => frames.length === 2 || errors.length > 0);
  assert.equal(errors.length, 0);
  assert.deepEqual(frames.map(({ epoch, ...frame }) => frame), [
    { seq: 40, full: true, width: 80, height: 24, data: 'G1szMW3kvaDlpb0=' },
    { seq: 41, full: false, width: 80, height: 24, data: 'G1szMW3kvaDlpb0=' },
  ]);
  await dispose();
  await dispose();
  const again: TerminalFrame[] = [];
  const disposeAgain = await host.watch('workspace:1.1', frame => again.push(frame), error => errors.push(error));
  t.after(async () => { await disposeAgain(); });
  await until(() => again.length > 0);
  assert.notEqual(again[0].epoch, frames[0].epoch);
  await disposeAgain();
  assert.equal(errors.length, 0);
  assert.deepEqual((await calls()).filter(call => call[0] !== 'observer-disposed'), [
    ['terminal', 'session', 'observe', 'workspace:1.1'], ['terminal', 'session', 'observe', 'workspace:1.1'],
  ]);
});

test('observer protocol/exit/spawn failures call onError exactly once', async t => {
  for (const mode of ['exit', 'closed', 'bad-json', 'bad-base64', 'no-full', 'gap']) {
    const { host } = await fixture(t, mode);
    const errors: Error[] = [];
    const dispose = await host.watch('workspace:1.1', () => {}, error => errors.push(error));
    t.after(async () => { await dispose(); });
    await until(() => errors.length > 0);
    await dispose();
    assert.equal(errors.length, 1, mode);
    if (mode === 'exit') { assert.match(errors[0].message, /exited \(7\)/); assert.doesNotMatch(errors[0].message, /fake observer failed/); }
    if (mode === 'closed') { assert.match(errors[0].message, /observation/i); assert.doesNotMatch(errors[0].message, /fake shutdown/); }
  }
  const errors: Error[] = [];
  const dispose = await createTerminalHost({ command: '/nonexistent/super-mario-fake' }).watch('id', () => {}, error => errors.push(error));
  await until(() => errors.length > 0);
  await dispose();
  assert.equal(errors.length, 1);
});

test('dispose reaps an observer which ignores SIGTERM without closing the pane', async t => {
  const { host, calls } = await fixture(t, 'ignore-term');
  let ready = false;
  const dispose = await host.watch('workspace:1.1', () => { ready = true; }, () => assert.fail('disposal must not report a stream error'));
  t.after(async () => { await dispose(); });
  await until(() => ready);
  await dispose();
  assert.deepEqual(await calls(), [['terminal', 'session', 'observe', 'workspace:1.1']]);
});
