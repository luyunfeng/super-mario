import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentDiagnostics } from '../plugins/agent-diagnostics.ts';
import type { AgentDiagnosticsOptions, DiagnosticExecFile } from '../plugins/agent-diagnostics.ts';
import type { DiagnosticExecutorId } from '../packages/protocol/src/agent-diagnostics.ts';
import type { JsonObject } from '../packages/protocol/src/index.ts';

type Call = { file: string; args: string[]; options: Parameters<DiagnosticExecFile>[2] };
type Reply = { stdout?: string; stderr?: string; error?: Parameters<Parameters<DiagnosticExecFile>[3]>[0] };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-diagnostics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'fake-cli');
  await writeFile(file, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const profile = join(dir, 'profile');
  await mkdir(profile);
  function stub(id: DiagnosticExecutorId, replies: Reply[], extra: Partial<AgentDiagnosticsOptions> = {}) {
    const calls: Call[] = [];
    const execFile: DiagnosticExecFile = (file, args, options, cb) => {
      calls.push({ file, args, options });
      const next = replies.shift();
      assert.ok(next, 'unexpected CLI invocation');
      cb(next.error ?? null, next.stdout ?? '', next.stderr ?? '');
    };
    const service = createAgentDiagnostics({ launchers: { [id]: { command: file } }, execFile, env: { PATH: dir, HOME: dir }, ...extra });
    return { service, calls };
  }
  return { dir, file, profile, stub };
}
const codexVersion: Reply = { stdout: 'codex-cli 0.100.0\n' };
const claudeVersion: Reply = { stdout: '2.1.295 (Claude Code)\n' };

test('registration is lazy; only executorId is accepted by the NodeHandler', async t => {
  const { stub } = await fixture(t);
  const { service, calls } = stub('codex', [codexVersion, { stderr: 'Logged in using ChatGPT' }]);
  assert.equal(calls.length, 0);
  const handler = service.handlers['executor.diagnostics'];
  const invalid: JsonObject[] = [{}, { executorId: 'other' }, { executorId: 'codex', command: 'evil' },
    { executorId: 'codex', argv: ['login'] }, { executorId: 'codex', profile: 'default' },
    { executorId: 'codex', env: { OPENAI_API_KEY: 'fake-secret' } }];
  for (const params of invalid) {
    await assert.rejects(handler(params, () => {}), /Invalid diagnostic parameters/);
  }
  assert.equal(calls.length, 0);
  const result = await handler({ executorId: 'codex' }, () => {}) as { authentication: { state: string } };
  assert.equal(result.authentication.state, 'authenticated');
  assert.deepEqual(calls.map(call => call.args), [['--version'], ['login', 'status']]);
});

test('unconfigured launcher does not infer a command or inspect PATH', async () => {
  const service = createAgentDiagnostics({ execFile: () => assert.fail('must not execute') });
  const result = await service.probe('codex');
  assert.equal(result.executable.source, 'unconfigured');
  assert.equal(result.authentication.state, 'unknown');
  assert.deepEqual(result.errors, [{ stage: 'executable', code: 'not-configured' }]);
});

test('missing PATH CLI and missing explicit launcher never fall back', async t => {
  const { dir, file } = await fixture(t);
  for (const command of ['absent', join(dir, 'absent')]) {
    const result = await createAgentDiagnostics({ launchers: { codex: { command } }, env: { PATH: dir },
      execFile: () => assert.fail('must not execute') }).probe('codex');
    assert.equal(result.executable.state, 'missing');
    assert.equal(result.launcher.state, 'unavailable');
    assert.equal(result.authentication.state, 'unknown');
  }
  await chmod(file, 0o600);
  const result = await createAgentDiagnostics({ launchers: { codex: { command: file } } }).probe('codex');
  assert.equal(result.authentication.state, 'unknown');
  assert.equal(result.errors[0].code, 'permission-denied');
});

test('PATH presence is separate from a failing launcher, CLI version and authentication', async t => {
  const { stub } = await fixture(t);
  const { service, calls } = stub('codex', [{ error: { code: 126 }, stderr: 'launcher failed; token=fake-secret' }]);
  const result = await service.probe('codex');
  assert.equal(result.executable.state, 'available');
  assert.equal(result.launcher.state, 'unavailable');
  assert.equal(result.version.state, 'unknown');
  assert.equal(result.authentication.state, 'unknown');
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(result).includes('fake-secret'));
});

test('Codex normalizes supported stdout/stderr status variants without leaking keys', async t => {
  const { stub } = await fixture(t);
  for (const reply of [{ stderr: 'Logged in using ChatGPT\n' }, { stdout: 'Logged in using API key - fake-secret' },
    { stderr: 'API key configured - fake-secret\nAuthentication is checked when you send a request.\n' }]) {
    const { service } = stub('codex', [codexVersion, reply]);
    const result = await service.probe('codex');
    assert.equal(result.version.value, '0.100.0');
    assert.equal(result.authentication.state, 'authenticated');
    assert.ok(!JSON.stringify(result).includes('fake-secret'));
  }
});

test('known signed-out status differs from diagnostic errors and unfamiliar output', async t => {
  const { stub } = await fixture(t);
  const { service } = stub('codex', [codexVersion, { error: { code: 1 }, stderr: 'Not logged in\n' }]);
  assert.equal((await service.probe('codex')).authentication.state, 'unauthenticated');
  for (const reply of [{ stdout: '' }, { error: { code: 1 }, stderr: 'Error checking login status: fake-secret' },
    { error: { code: 2 }, stderr: 'unknown command login' }, { error: { code: 1 }, stderr: 'Logged in using ChatGPT' },
    { stdout: '{"loggedIn":true}' }, { stderr: 'fake-secret\nLogged in using ChatGPT' }]) {
    const result = await stub('codex', [codexVersion, reply]).service.probe('codex');
    assert.equal(result.authentication.state, 'unknown');
    assert.ok(result.errors.some(error => error.stage === 'authentication'));
    assert.ok(!JSON.stringify(result).includes('fake-secret'));
  }
});

test('Claude JSON test doubles normalize booleans and require matching exit codes', async t => {
  const { stub } = await fixture(t);
  for (const [loggedIn, code, expected] of [[true, 0, 'authenticated'], [false, 1, 'unauthenticated'], [true, 1, 'unknown'], [false, 0, 'unknown']] as const) {
    const { service, calls } = stub('claude-code', [claudeVersion, { stdout: JSON.stringify({ loggedIn, email: 'fake-private@example.test', token: 'fake-secret' }),
      ...(code ? { error: { code } } : {}), stderr: 'fake-secret' }]);
    const result = await service.probe('claude-code');
    assert.equal(result.authentication.state, expected);
    assert.equal(result.version.value, '2.1.295');
    assert.deepEqual(calls.map(call => call.args), [['--version'], ['auth', 'status', '--json']]);
    assert.ok(!JSON.stringify(result).includes('fake-secret'));
    assert.ok(!JSON.stringify(result).includes('fake-private'));
  }
});

test('Claude changed JSON schema, malformed JSON and unsupported status remain unknown', async t => {
  const { stub } = await fixture(t);
  for (const stdout of ['{"authenticated":true}', '{"loggedIn":"true"}', 'null', '[]', 'not JSON', '{"loggedIn":true}\nextra']) {
    const result = await stub('claude-code', [claudeVersion, { stdout, stderr: 'fake-secret' }]).service.probe('claude-code');
    assert.equal(result.authentication.state, 'unknown');
    assert.ok(!JSON.stringify(result).includes('fake-secret'));
  }
});

test('unknown version output is not echoed and does not imply authentication', async t => {
  const { stub } = await fixture(t);
  const result = await stub('codex', [{ stdout: 'custom launcher fake-secret version 42' }, { stdout: '' }]).service.probe('codex');
  assert.equal(result.launcher.state, 'available');
  assert.equal(result.version.state, 'unknown');
  assert.equal(result.authentication.state, 'unknown');
  assert.ok(!JSON.stringify(result).includes('fake-secret'));
});

test('timeouts, output overflow, spawn failure and thrown errors do not expose raw errors', async t => {
  const { stub, file, dir } = await fixture(t);
  for (const [error, expected] of [[{ code: 'ETIMEDOUT' }, 'timeout'], [{ killed: true, signal: 'SIGKILL' }, 'timeout'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'output-limit'], [{ code: 'ENOENT' }, 'missing'],
    [{ code: 'EACCES' }, 'permission-denied'], [{ code: 'UNKNOWN' }, 'execution-failed']] as const) {
    const result = await stub('codex', [codexVersion, { error, stderr: 'fake-secret', stdout: 'Logged in using ChatGPT' }]).service.probe('codex');
    assert.equal(result.authentication.state, 'unknown');
    assert.equal(result.errors.at(-1)?.code, expected);
    assert.ok(!JSON.stringify(result).includes('fake-secret'));
  }
  const result = await createAgentDiagnostics({ launchers: { codex: { command: file } }, env: { HOME: dir },
    execFile: () => { throw new Error('fake-secret'); } }).probe('codex');
  assert.equal(result.errors[0].code, 'execution-failed');
  assert.ok(!JSON.stringify(result).includes('fake-secret'));
});

test('explicit profile overrides selectors and omits ambient credentials; config snapshot is stable', async t => {
  const { stub, profile, file, dir } = await fixture(t);
  for (const id of ['codex', 'claude-code'] as const) {
    const launchers = { [id]: { command: file, profile: { configDir: profile } } };
    const env = { PATH: dir, HOME: dir, CODEX_HOME: '/default-codex', CLAUDE_CONFIG_DIR: '/default-claude',
      OPENAI_API_KEY: 'fake-secret', ANTHROPIC_API_KEY: 'fake-secret', CLAUDE_CODE_OAUTH_TOKEN: 'fake-secret', NODE_OPTIONS: '--bad' };
    const { service, calls } = stub(id, [id === 'codex' ? codexVersion : claudeVersion,
      id === 'codex' ? { stderr: 'Not logged in', error: { code: 1 } } : { stdout: JSON.stringify({ loggedIn: false, configDirectory: profile }), error: { code: 1 } }], { launchers, env });
    launchers[id]!.profile.configDir = '/default-after-registration';
    env.HOME = '/changed-after-registration';
    const result = await service.probe(id);
    assert.equal(result.authentication.state, 'unauthenticated');
    assert.equal(result.authentication.scope, 'configured-profile');
    for (const { options } of calls) {
      assert.equal(options.env[id === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'], profile);
      assert.equal(options.env[id === 'codex' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'], undefined);
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(options.env.NODE_OPTIONS, undefined);
      assert.equal(options.env.HOME, dir);
      assert.equal(options.cwd, profile);
    }
    assert.ok(!JSON.stringify(result).includes(profile));
  }
});

test('missing explicit profile never spawns or silently uses the default profile', async t => {
  const { stub, dir, file } = await fixture(t);
  const { service, calls } = stub('codex', [], { launchers: { codex: { command: file, profile: { configDir: join(dir, 'absent') } } } });
  const result = await service.probe('codex');
  assert.equal(result.authentication.state, 'unknown');
  assert.equal(result.errors[0].code, 'profile-unavailable');
  assert.equal(calls.length, 0);
});

test('Claude contradictory profile JSON cannot authenticate an explicitly configured profile', async t => {
  const { stub, profile, file } = await fixture(t);
  for (const configDirectory of ['/wrong-default', 'relative']) {
    const { service } = stub('claude-code', [claudeVersion, { stdout: JSON.stringify({ loggedIn: true, configDirectory }) }],
      { launchers: { 'claude-code': { command: file, profile: { configDir: profile } } } });
    const result = await service.probe('claude-code');
    assert.equal(result.authentication.state, 'unknown');
    assert.equal(result.errors.at(-1)?.code, 'profile-mismatch');
  }
});

test('configuration rejects shell command strings, argv, named profiles and invalid limits', () => {
  for (const command of ['codex --login', 'codex;evil', '$(evil)', '-codex', './codex', 'codex\0']) {
    assert.throws(() => createAgentDiagnostics({ launchers: { codex: { command } } }), /Invalid diagnostic/);
  }
  for (const options of [{ timeoutMs: 10_001 }, { timeoutMs: 0 }, { timeoutMs: NaN }, { maxOutputBytes: 65_537 },
    { launchers: { codex: { command: 'codex', profile: { configDir: 'relative' } } } },
    { launchers: { codex: { command: 'codex', argv: ['login'] } } },
    { launchers: { codex: { command: 'codex', profile: 'named' } } }]) {
    assert.throws(() => createAgentDiagnostics(options as AgentDiagnosticsOptions), /Invalid diagnostic/);
  }
});

test('real execFile receives only fixed argv and explicit profile environment (fake CLI)', async t => {
  const { dir, file, profile } = await fixture(t);
  const log = join(dir, 'argv.jsonl');
  await writeFile(file, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, profile: process.env.CLAUDE_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY }) + '\\n');
if (JSON.stringify(args) === '["--version"]') console.log('2.1.295 (Claude Code)');
else if (JSON.stringify(args) === '["auth","status","--json"]') console.log(JSON.stringify({ loggedIn: true, configDirectory: process.env.CLAUDE_CONFIG_DIR, token: 'fake-secret' }));
else process.exit(99);
`, { mode: 0o700 });
  const service = createAgentDiagnostics({ launchers: { 'claude-code': { command: 'fake-cli', profile: { configDir: profile } } }, env: { PATH: dir, HOME: dir, ANTHROPIC_API_KEY: 'fake-secret' } });
  const result = await service.probe('claude-code');
  assert.equal(result.executable.source, 'path');
  assert.equal(result.authentication.state, 'authenticated'); // Fake executable only; no real Claude login claim.
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [
    { args: ['--version'], profile }, { args: ['auth', 'status', '--json'], profile },
  ]);
  assert.ok(!JSON.stringify(result).includes('fake-secret'));
  assert.ok(!JSON.stringify(result).includes(dir));
});

test('real execFile enforces timeout and byte limits against fake executables', async t => {
  const { file, dir } = await fixture(t);
  await writeFile(file, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  const timed = await createAgentDiagnostics({ launchers: { codex: { command: file } }, env: { HOME: dir }, timeoutMs: 100 }).probe('codex');
  assert.equal(timed.errors[0].code, 'timeout');
  await writeFile(file, `#!${process.execPath}\nprocess.stderr.write('fake-secret'.repeat(10000));\n`);
  const overflow = await createAgentDiagnostics({ launchers: { codex: { command: file } }, env: { HOME: dir }, maxOutputBytes: 128 }).probe('codex');
  assert.equal(overflow.errors[0].code, 'output-limit');
  assert.equal(overflow.authentication.state, 'unknown');
  assert.ok(!JSON.stringify(overflow).includes('fake-secret'));
});

test('repeated explicit probes are fresh and honor bounded execFile options', async t => {
  const { stub } = await fixture(t);
  const { service, calls } = stub('codex', [codexVersion, { stderr: 'Logged in using ChatGPT' }, codexVersion, { error: { code: 1 }, stderr: 'Not logged in' }], { timeoutMs: 123, maxOutputBytes: 456 });
  assert.equal((await service.probe('codex')).authentication.state, 'authenticated');
  assert.equal(calls.length, 2);
  assert.equal((await service.probe('codex')).authentication.state, 'unauthenticated');
  assert.equal(calls.length, 4);
  for (const { options } of calls) {
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 123);
    assert.equal(options.maxBuffer, 456);
    assert.equal(options.killSignal, 'SIGKILL');
  }
});
