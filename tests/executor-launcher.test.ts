import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createExecutionServices } from '../plugins/executors.ts';
import { createTerminalHost } from '../plugins/terminal-host.ts';
import { runTask } from '../plugins/task-runner.ts';
import { buildNativeResumeCommand } from '../plugins/session-resume.ts';
import type { TaskConfig } from '../plugins/task-results.ts';
import type { TerminalHost } from '../packages/plugin-sdk/src/index.ts';
import type { JsonObject } from '../packages/protocol/src/index.ts';

const exec = promisify(execFile);
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-launcher-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const creates: Parameters<TerminalHost['create']>[0][] = [];
  const host: TerminalHost = {
    status: async () => ({ available: true }), list: async () => [],
    create: async spec => { creates.push(spec); return { id: String(creates.length), cwd: spec.cwd, title: spec.name }; },
    read: async () => ({ text: '', ansi: '' }), input: async () => {}, keys: async () => {},
    close: async () => {}, watch: async () => () => {},
  };
  const command = join(dir, 'configured cli.cjs');
  await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync('observed.json', JSON.stringify({
  command: process.argv[1], args: process.argv.slice(2), cwd: process.cwd(),
  codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR,
  path: process.env.PATH, home: process.env.HOME,
  workerHash: process.env.SUPER_MARIO_WORKER_KEY && require('node:crypto').createHash('sha256').update(process.env.SUPER_MARIO_WORKER_KEY).digest('hex'),
  workerSession: process.env.SUPER_MARIO_WORKER_SESSION, workerUrl: process.env.SUPER_MARIO_WORKER_URL
}));
const id = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1]
  : process.argv.includes('resume') ? process.argv.at(-2) : 'test-native';
if (process.env.CLAUDE_CONFIG_DIR) console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: id, result: 'fake native result' }));
else {
 console.log(JSON.stringify({ type: 'thread.started', thread_id: id }));
 console.log(JSON.stringify({ type: 'turn.completed' }));
}
`);
  await chmod(command, 0o700);
  return { dir, host, creates, command };
}

for (const executorId of ['codex', 'claude-code'] as const) {
  test(`${executorId}: explicit launcher/profile reaches pane and real task child, including resume`, async t => {
    const { dir, host, creates, command } = await fixture(t);
    const configDir = join(dir, "profile ' $(literal)");
    await mkdir(configDir);
    const launcher = { command, profile: { configDir } };
    const service = createExecutionServices({ host, dataDir: join(dir, 'data'), launchers: { [executorId]: launcher }, validateResume: async () => {} });
    t.after(() => service.close());
    const call = (method: string, params: JsonObject) => service.handlers[method]!(params, () => {});
    assert.equal((await service.describe('machine')).find(e => e.id === executorId)!.available, true);
    for (const resume of [false, true]) {
      const prompt = '--literal $(no-command)';
      const params = { executorId, cwd: dir, prompt, ...(resume ? { nativeSessionId: 'native-test' } : { model: 'fixture-model' }) };
      const method = resume ? 'executor.resume' : 'executor.start';
      await call(method, params);
      const pane = creates.at(-1)!;
      assert.equal(pane.argv[0], command);
      if (resume) assert.deepEqual(pane.argv.slice(1), buildNativeResumeCommand({ ...params, nativeSessionId: 'native-test', mode: 'interactive' }).args);
      assert.deepEqual(pane.env, { [executorId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: configDir });
      assert.equal(pane.cwd, dir);
      await exec(pane.argv[0]!, pane.argv.slice(1), { cwd: pane.cwd, env: { ...process.env, ...pane.env } });
      const interactive = JSON.parse(await readFile(join(dir, 'observed.json'), 'utf8'));
      if (!resume) assert.deepEqual(interactive.args.slice(0, 2), ['--model', 'fixture-model']);
      assert.equal(interactive.command, command);
      assert.equal(interactive[executorId === 'codex' ? 'codex' : 'claude'], configDir);
      await call(method, { ...params, mode: 'task' });
      const task = creates.at(-1)!;
      const config = JSON.parse(await readFile(task.argv[2]!, 'utf8')) as TaskConfig;
      assert.deepEqual(config.launcher, launcher);
      await exec(task.argv[0]!, task.argv.slice(1));
      const observed = JSON.parse(await readFile(join(dir, 'observed.json'), 'utf8'));
      if (!resume) assert.deepEqual(observed.args.slice(0, 2), ['--model', 'fixture-model']);
      assert.equal(observed.command, command);
      assert.equal(observed[executorId === 'codex' ? 'codex' : 'claude'], configDir);
      assert.equal(observed.cwd, dir);
      assert.equal(observed.path, process.env.PATH);
      assert.equal(observed.home, process.env.HOME);
      if (resume) assert.deepEqual(observed.args, buildNativeResumeCommand({ ...params, nativeSessionId: 'native-test', mode: 'task', resultsPath: config.resultsPath }).args);
      assert.equal(JSON.parse(await readFile(config.resultsPath, 'utf8')).state, 'completed');
    }
  });
}

test('RPC cannot select a launcher; local configuration is validated and copied', async t => {
  const { dir, host, creates, command } = await fixture(t);
  for (const launcher of [
    { command: 'relative/path' }, { command: '-bad' }, { command, argv: ['x'] },
    { command, env: { PATH: '/bad' } }, { command, profile: { configDir: 'relative' } },
    { command, profile: { configDir: dir, extra: true } },
  ]) {
    assert.throws(() => createExecutionServices({ host, dataDir: dir, launchers: { codex: launcher } }), /launcher/);
    await assert.rejects(runTask({ executorId: 'codex', prompt: 'x', cwd: dir, resultsPath: join(dir, 'result'), launcher }), /launcher/);
  }
  const launcher = { command };
  const service = createExecutionServices({ host, dataDir: dir, launchers: { codex: launcher } });
  t.after(() => service.close());
  launcher.command = '/not-the-configured-command';
  for (const key of ['command', 'argv', 'env', 'profile', 'launcher', 'launchers']) {
    await assert.rejects(service.handlers['executor.start']!({ executorId: 'codex', prompt: 'x', cwd: dir, [key]: 'untrusted' }, () => {}), /local only/);
  }
  await service.handlers['executor.start']!({ executorId: 'codex', prompt: 'x', cwd: dir }, () => {});
  assert.equal(creates[0]!.argv[0], command);
});

test('legacy task configs retain the default codex/claude commands on PATH', async t => {
  const { dir, command } = await fixture(t);
  for (const [executorId, name] of [['codex', 'codex'], ['claude-code', 'claude']] as const) {
    const target = join(dir, name);
    await writeFile(target, await readFile(command));
    await chmod(target, 0o700);
    const configPath = join(dir, 'legacy.json');
    await writeFile(configPath, JSON.stringify({ executorId, prompt: 'legacy', cwd: dir, resultsPath: join(dir, 'legacy-result.json') }));
    await exec(process.execPath, ['plugins/task-runner.ts', configPath], { env: { ...process.env, PATH: dir } });
    assert.equal(JSON.parse(await readFile(join(dir, 'observed.json'), 'utf8')).command, target);
  }
});

test('terminal adapter forwards only profile env through literal tab arguments', async t => {
  const { dir } = await fixture(t);
  const log = join(dir, 'calls.jsonl');
  const command = join(dir, 'fake-host.cjs');
  await writeFile(command, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({result: {root_pane: {pane_id:'fake', cwd:${JSON.stringify(dir)}}}}));
`);
  await chmod(command, 0o700);
  const host = createTerminalHost({ command });
  const configDir = join(dir, "profile '$(touch nope)");
  await host.create({ cwd: dir, name: 'test', argv: ['fake-cli', '--'], env: { CODEX_HOME: configDir } });
  const calls: string[][] = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls[0]!.includes('CODEX_HOME=' + configDir));
  assert.equal(calls[0]!.filter(arg => arg === '--env').length, 3);
  for (const key of ['PATH', 'HOME', 'NODE_OPTIONS', 'SUPER_MARIO_TERMINAL_ARG_0']) {
    await assert.rejects(host.create({ cwd: dir, name: 'bad', argv: ['x'], env: { [key]: dir } }), /environment key/);
  }
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 3);
});

test('missing explicitly configured absolute launcher never falls back to a default CLI', async t => {
  const { dir, host, creates } = await fixture(t);
  const command = join(dir, 'missing-cli');
  const service = createExecutionServices({ host, dataDir: dir, launchers: { codex: { command } } });
  t.after(() => service.close());
  assert.equal((await service.describe('machine'))[0]!.available, false);
  await assert.rejects(service.handlers['executor.start']!({ executorId: 'codex', prompt: 'x', cwd: dir }, () => {}), /not on PATH/);
  assert.deepEqual(creates, []);
});

test('scoped tool credentials reach each local Codex child without entering config, argv or session listings', async t => {
  const { dir, host, creates, command } = await fixture(t);
  const dataDir = join(dir, 'data');
  const workerToolUrl = 'https://workbench.example.test/api/v1/worker-tools/todo-bind-thread';
  const service = createExecutionServices({ host, dataDir, workerToolUrl, agentInstanceId: 'fixture-node',
    launchers: { codex: { command }, pi: { command }, 'claude-code': { command } },
    validateResume: async () => {} });
  t.after(() => service.close());
  const keys = new Set<string>();
  for (const mode of ['interactive', 'task']) {
    for (const resume of [false, true]) {
      const method = resume ? 'executor.resume' : 'executor.start';
      const result = await service.handlers[method]!({ mode, executorId: 'codex', prompt: '--literal', cwd: dir,
        ...(resume ? { nativeSessionId: 'scoped-native' } : {}) }, () => {}) as JsonObject;
      const pane = creates.at(-1)!;
      const key = pane.env!.SUPER_MARIO_WORKER_KEY!;
      assert.match(key, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(!keys.has(key));
      keys.add(key);
      assert.equal(result.agentInstanceId, 'fixture-node');
      assert.equal(result.workerToolKeyHash, createHash('sha256').update(key).digest('hex'));
      assert.ok(!JSON.stringify(result).includes(key));
      assert.ok(!JSON.stringify(pane.argv).includes(key));
      if (mode === 'task') assert.ok(!(await readFile(pane.argv[2]!, 'utf8')).includes(key));
      await exec(pane.argv[0]!, pane.argv.slice(1), { cwd: dir, env: { ...process.env, ...pane.env } });
      const child = JSON.parse(await readFile(join(dir, 'observed.json'), 'utf8'));
      assert.equal(child.workerHash, result.workerToolKeyHash);
      assert.equal(child.workerSession, result.sessionId);
      assert.equal(child.workerUrl, workerToolUrl);
      assert.equal(child.args[1], 'mcp_servers.super_mario.command=' + JSON.stringify(process.execPath));
      assert.match(child.args[3], /^mcp_servers\.super_mario\.args=\[".*\/worker-topic-mcp\.ts"\]$/);
      assert.deepEqual(JSON.parse(child.args[5].split('=')[1]), ['SUPER_MARIO_WORKER_KEY','SUPER_MARIO_WORKER_URL','SUPER_MARIO_WORKER_SESSION']);
      assert.ok(!JSON.stringify(child.args).includes(key));
      assert.deepEqual(child.args.slice(-1), ['--literal']);
      for (const raw of [await readFile(join(dataDir, 'executor-sessions.json'), 'utf8'),
        JSON.stringify(await service.handlers['executor.sessions']!({}, () => {}))]) {
        assert.ok(!raw.includes(key) && !raw.includes(String(result.workerToolKeyHash)));
      }
    }
  }
  for (const executorId of ['claude-code', 'pi']) {
    const result = await service.handlers['executor.start']!({ executorId, prompt: 'fixture', cwd: dir, mode: 'task' }, () => {}) as JsonObject;
    assert.ok(!Object.hasOwn(result, 'workerToolKeyHash'));
    assert.equal(creates.at(-1)!.env, undefined);
  }
  for (const url of ['ftp://invalid.test', 'https://user:pass@invalid.test/', '/relative']) {
    assert.throws(() => createExecutionServices({ host, dataDir, workerToolUrl: url }), /endpoint/);
  }
});

test('Herdr receives a scoped credential only in tab.create socket environment', async t => {
  const { dir, command } = await fixture(t);
  const path = join(dir, 'test.sock');
  const source = { SUPER_MARIO_WORKER_KEY: 'a'.repeat(43), SUPER_MARIO_WORKER_SESSION: '12345678-1234-4123-a123-123456789abc',
    SUPER_MARIO_WORKER_URL: 'https://workbench.example.test/api/v1/worker-tools/todo-bind-thread' };
  let request: {method:string;params:{env:Record<string,string>}} | undefined;
  const socket = createServer(connection => connection.once('data', raw => {
    request = JSON.parse(String(raw));
    connection.end(JSON.stringify({ id: JSON.parse(String(raw)).id, result: { root_pane: { pane_id: 'pane', cwd: dir } } }) + '\n');
  }));
  await new Promise<void>(resolve => socket.listen(path, resolve));
  t.after(() => new Promise<void>(resolve => socket.close(() => resolve())));
  const log = join(dir, 'host-argv.jsonl');
  await writeFile(command, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
  const host = createTerminalHost({ command, env: { HERDR_SOCKET_PATH: path } });
  const spec = { cwd: dir, name: 'worker', argv: ['fixture'] };
  await assert.rejects(host.create({ ...spec, env: { SUPER_MARIO_WORKER_KEY: source.SUPER_MARIO_WORKER_KEY } }), /environment/);
  await host.create({ ...spec, env: source });
  assert.equal(request?.method, 'tab.create');
  assert.deepEqual(request?.params.env, { ...source, SUPER_MARIO_TERMINAL_ARG_0: 'fixture' });
  assert.ok(!(await readFile(log, 'utf8')).includes(source.SUPER_MARIO_WORKER_KEY));
});
