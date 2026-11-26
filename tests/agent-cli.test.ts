import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { JsonObject, NodeMessage, SessionBinding } from '../packages/protocol/src/index.ts';

const entry = fileURLToPath(new URL('../bin/super-mario-agent.js', import.meta.url));
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error('Timed out waiting for CLI test double');
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(force); }
}
async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'super-mario-agent-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Every terminal subprocess below runs this test double. No user daemon or CLI is accessed.
const fakeTerminal = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_TERMINAL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') console.log('fake terminal 1.0');
else if (args.join(' ') === 'terminal session observe --help') console.log('observe TARGET');
else if (args[0] === 'status') console.log(JSON.stringify({ running: true, compatible: true }));
else if (args.join(' ') === 'pane list') console.log(JSON.stringify({ result: { panes: [{ pane_id: 'test-pane', cwd: process.env.TEST_AGENT_DIR }] } }));
else if (args[0] === 'terminal') {
  process.on('SIGTERM', () => { fs.appendFileSync(process.env.TEST_TERMINAL_LOG, JSON.stringify(['observer.stopped']) + '\\n'); process.exit(0); });
  console.log(JSON.stringify({ type: 'terminal.frame', seq: 0, full: true, encoding: 'ansi', width: 80, height: 24, bytes: Buffer.from('fake screen').toString('base64') }));
  setInterval(() => {}, 1000);
} else if (args[1] === 'send-text' || args[1] === 'send-keys') {}
else { console.error('Unexpected test command'); process.exitCode = 1; }
`;

for (const override of [false, true]) {
  test(`agent CLI wires real execution services using ${override ? 'configured' : 'default'} terminal command`, async t => {
    const dir = await directory(t);
    const command = join(dir, override ? 'test-terminal' : 'herdr');
    const log = join(dir, 'terminal.jsonl');
    await writeFile(command, fakeTerminal, { mode: 0o700 });
    await chmod(command, 0o700);
    // Discovery only: these files must never run.
    for (const cli of ['codex', 'claude']) {
      await writeFile(join(dir, cli), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    }
    await writeFile(log, '');
    const binding: SessionBinding = { sessionId: 'test-session', paneId: 'test-pane', executorId: 'codex', cwd: dir, createdAt: new Date().toISOString() };
    await writeFile(join(dir, 'machine.json'), JSON.stringify({ id: 'test-machine' }));
    await writeFile(join(dir, 'executor-sessions.json'), JSON.stringify([binding]));
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    t.after(async () => {
      for (const ws of server.clients) ws.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const messages: NodeMessage[] = [];
    server.on('connection', socket => {
      socket.on('message', data => messages.push(JSON.parse(data.toString())));
    });
    const env = { ...process.env, SUPER_MARIO_DEV: '1', SUPER_MARIO_TOKEN: 'test-token',
      PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`, TEST_TERMINAL_LOG: log, TEST_AGENT_DIR: dir };
    // Explicitly erase an inherited override so the default-command case is deterministic.
    delete (env as NodeJS.ProcessEnv).SUPER_MARIO_TERMINAL_COMMAND;
    if (override) (env as NodeJS.ProcessEnv).SUPER_MARIO_TERMINAL_COMMAND = command;
    const piCommand = join(dir, 'custom-pi');
    await writeFile(piCommand, '#!/bin/sh\n[ "$1" = "--version" ] || exit 99\necho 0.64.0\n', { mode: 0o700 });
    Object.assign(env, { SUPER_MARIO_PI_COMMAND: override ? join(dir, 'missing') : piCommand, PI_CODING_AGENT_DIR: dir });
    const child = spawn(process.execPath, [entry, ...(override ? ['--pi-command', piCommand] : []), '--url', `http://127.0.0.1:${address.port}`, '--data-dir', dir, '--name', 'CLI test'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => stop(child));
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const peer = await waitFor(() => {
      if (child.exitCode !== null) throw new Error(output);
      return server.clients.values().next().value;
    });
    const hello = await waitFor(() => messages.find(m => m.type === 'hello'));
    assert.equal(hello.type, 'hello');
    if (hello.type !== 'hello') return;
    assert.equal(hello.machineId, 'test-machine');
    assert.equal(hello.name, 'CLI test');
    for (const method of ['node.status', 'agents.sessions', 'agents.session', 'executor.resume', 'executor.recovery', 'executor.diagnostics', 'executor.start', 'executor.sessions', 'executor.input', 'terminal.input', 'terminal.watch']) {
      assert.ok(hello.capabilities.includes(method), method);
    }
    assert.deepEqual(hello.executors?.map(e => [e.id, e.available, e.machineId, e.mode]), [
      ['codex', true, 'test-machine', 'real'], ['claude-code', true, 'test-machine', 'real'], ['pi', true, 'test-machine', 'real'],
    ]);
    // The signal handler is registered after the startup log.
    await waitFor(() => output.includes('执行机代理已启动') || undefined);
    peer.send(JSON.stringify({ type: 'welcome', machineId: hello.machineId }));
    let sequence = 0;
    async function call(method: string, params: JsonObject = {}, expectedError?: RegExp) {
      const id = `call-${++sequence}`;
      peer.send(JSON.stringify({ type: 'call', id, method, params }));
      const result = await waitFor(() => messages.find(m => m.type === 'result' && m.id === id));
      assert.equal(result.type, 'result');
      if (result.type !== 'result') throw new Error('Expected result');
      if (expectedError) { assert.match(result.error!, expectedError); return; }
      assert.equal(result.error, undefined);
      return result.result;
    }
    const status = await call('node.status') as { cli: { pi: boolean } };
    assert.equal(status.cli.pi, true);
    const diagnostic = await call('executor.diagnostics', { executorId: 'pi' }) as JsonObject;
    assert.deepEqual(diagnostic.version, { state: 'known', value: '0.64.0' });
    assert.deepEqual(await call('executor.sessions'), [binding]);
    await call('executor.input', { sessionId: binding.sessionId, text: 'follow up' }, /Historical session ownership/);
    await call('terminal.input', { paneId: binding.paneId, text: 'raw' }, /Historical session ownership/);
    await call('terminal.watch', { paneId: binding.paneId }, /Historical session ownership/);
    await call('terminal.watch', { paneId: 'current-unbound-pane' });
    await waitFor(() => messages.find(m => m.type === 'event' && m.event === 'terminal.frame'));
    await stop(child);
    assert.equal(child.exitCode, 0, output);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.deepEqual(calls.filter(args => args[1] === 'send-text' || args[1] === 'send-keys'), [], 'restored binding must never receive CLI input');
    assert.ok(calls.some(args => args[0] === 'observer.stopped'), 'onDisconnect disposes observation subprocess');
    assert.ok(!calls.some(args => args[0] === 'tab' || args[1] === 'close'), 'never starts or closes a CLI pane');
    assert.ok(!output.includes('test-token'));
  });
}

test('agent CLI loads compiled modules, including guarded artifacts, and passes lifecycle options', async t => {
  const dir = await directory(t);
  await mkdir(join(dir, 'bin'));
  await mkdir(join(dir, 'dist/apps/agent-node/src'), { recursive: true });
  await mkdir(join(dir, 'dist/plugins'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await copyFile(entry, join(dir, 'bin/super-mario-agent.js'));
  // Compiled-module doubles verify selection and wiring without requiring a project build.
  await writeFile(join(dir, 'dist/plugins/agent-diagnostics.js'), `export function createAgentDiagnostics() { return { handlers: { 'executor.diagnostics': async () => ({}) }, probe() { throw new Error('must not diagnose during startup'); } }; }`);
  await writeFile(join(dir, 'dist/plugins/live-terminals.js'), `
    import { writeFile } from 'node:fs/promises';
    export function createLiveTerminalServices() { return { handlers: { 'terminal.live.list': async () => ({panes:[]}) }, disconnect: async () => {}, close: async () => writeFile(${JSON.stringify(join(dir, 'live-closed'))}, 'done') }; }
  `);
  await writeFile(join(dir, 'dist/plugins/terminal-host.js'), `
    export function createTerminalHost(options) {
      if (Object.keys(options).some(key => key !== 'command')) throw new Error('Unexpected host options');
      return { command: options.command };
    }
  `);
  await writeFile(join(dir, 'dist/plugins/cli-session-discovery.js'), `export function createCliSessionDiscovery() { return { handlers: { 'agents.sessions': async () => ({ sessions: [], roots: [], warnings: [], truncated: false }), 'agents.session': async () => ({}) }, validateResume: async () => ({}) }; }`);
  await writeFile(join(dir, 'dist/plugins/project-discovery.js'), `export function createProjectDiscovery() { return { handlers: { 'workspace.projects': async () => ({projects:[]}), 'workspace.directory': async () => ({}) } }; }`);
  await writeFile(join(dir, 'dist/plugins/github-node.js'), `export function createGithubNode() { return { 'github.account': async () => ({ok:true}), 'github.notifications': async () => ({ok:true}), 'github.issue': async () => ({ok:true}), 'github.comments': async () => ({ok:true}) }; }`);
  // node-plugins.ts also reads the office worker guide and machine skills. They carry no
  // behaviour of their own here, but the compiled modules must exist to be loaded.
  await mkdir(join(dir, 'dist/plugins/office'), { recursive: true });
  await writeFile(join(dir, 'dist/plugins/office/guide.js'), `export const officeWorkerGuide = [];`);
  await writeFile(join(dir, 'dist/plugins/machine-skills.js'), `export function createMachineSkills() { return { handlers: {}, close: async () => {} }; }`);
  await writeFile(join(dir, 'dist/plugins/executors.js'), `
    import { writeFile } from 'node:fs/promises';
    export function createExecutionServices({host, dataDir}) {
      if (host.command !== 'compiled-test-terminal') throw new Error('Missing command override');
      return {
        handlers: { 'executor.sessions': async () => [] },
        describe: async machineId => [{ id: 'compiled-test', machineId }],
        disconnect: async () => writeFile(dataDir + '/disconnected', 'done'),
        close: async () => writeFile(dataDir + '/closed', 'done'),
      };
    }
  `);
  await writeFile(join(dir, 'dist/apps/agent-node/src/agent-artifacts.js'), `
    import { writeFile } from 'node:fs/promises';
    export function createAgentArtifactLoader({dataDir}) {
      return { handlers: { 'extension.load': async () => ({}), 'extension.status': async () => ({}), 'extension.call': async () => ({}) }, close: async () => writeFile(dataDir + '/artifacts-closed', 'done') };
    }
  `);
  const nodePluginsSource = await readFile(fileURLToPath(new URL('../apps/agent-node/src/node-plugins.ts', import.meta.url)), 'utf8');
  await writeFile(
    join(dir, 'dist/apps/agent-node/src/node-plugins.js'),
    stripTypeScriptTypes(nodePluginsSource, { mode: 'strip' }).replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2'),
  );
  await writeFile(join(dir, 'dist/apps/agent-node/src/index.js'), `
    import { writeFile } from 'node:fs/promises';
    export async function startAgentNode(options) {
      await writeFile(options.dataDir + '/options.json', JSON.stringify({
        ...options, token: undefined, handlers: Object.keys(options.handlers), onDisconnect: typeof options.onDisconnect,
      }));
      const keepAlive = setInterval(() => {}, 1000);
      return { async close() { await options.onDisconnect(); clearInterval(keepAlive); } };
    }
  `);
  const child = spawn(process.execPath, [join(dir, 'bin/super-mario-agent.js'), '--url', 'http://127.0.0.1:1', '--data-dir', dir], {
    env: { ...process.env, SUPER_MARIO_DEV: '0', SUPER_MARIO_TOKEN: 'test-token', SUPER_MARIO_TERMINAL_COMMAND: 'compiled-test-terminal' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stop(child));
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(output);
    return output.includes('执行机代理已启动') || undefined;
  });
  const options = JSON.parse(await readFile(join(dir, 'options.json'), 'utf8'));
  assert.deepEqual(options.handlers, ['office.guide', 'terminal.live.list', 'terminal.host.start', 'executor.sessions', 'executor.diagnostics', 'extension.load', 'extension.status', 'extension.call', 'workspace.projects', 'workspace.directory', 'agents.sessions', 'agents.session', 'github.account', 'github.notifications', 'github.issue', 'github.comments']);
  assert.deepEqual(options.executors, [{ id: 'compiled-test', machineId: options.machineId }]);
  assert.equal(options.onDisconnect, 'function');
  assert.equal(options.dataDir, dir);
  await stop(child);
  assert.equal(child.exitCode, 0, output);
  assert.equal(await readFile(join(dir, 'disconnected'), 'utf8'), 'done');
  assert.equal(await readFile(join(dir, 'closed'), 'utf8'), 'done');
  assert.equal(await readFile(join(dir, 'artifacts-closed'), 'utf8'), 'done');
  assert.equal(await readFile(join(dir, 'live-closed'), 'utf8'), 'done');
});
