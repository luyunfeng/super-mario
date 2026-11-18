import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createAgentDiagnostics } from '../plugins/agent-diagnostics.ts';
import { createExecutionServices } from '../plugins/executors.ts';
import { createTerminalHost } from '../plugins/terminal-host.ts';

const exec = promisify(execFile);

// Review regressions: only generated local executables, no real host or paid CLI.
test('review: terminal status stderr must not reach persisted machine metadata or public state', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-review-metadata-'));
  const token = 'review-only-fake-server-token';
  const command = join(dir, 'fake-host.cjs');
  await writeFile(command, `#!${process.execPath}
console.error('upstream authorization: Bearer ' + process.env.SUPER_MARIO_TOKEN);
process.exitCode = 1;
`);
  await chmod(command, 0o700);
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token });
  const host = createTerminalHost({ command, env: { SUPER_MARIO_TOKEN: token } });
  const services = createExecutionServices({ host, dataDir: join(dir, 'agent'), machineId: 'review-machine', hasCommand: () => true });
  const executors = await services.describe('review-machine');
  const agent = startAgentNode({ url: server.url, token, machineId: 'review-machine', name: 'Review fake host',
    dataDir: join(dir, 'agent'), executors, handlers: services.handlers, onDisconnect: services.disconnect });
  t.after(async () => {
    await agent.close();
    await services.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let n = 0; !server.machines.list().some(m => m.id === 'review-machine'); n++) {
    assert.ok(n < 200, 'local agent hello timed out');
    await delay(10);
  }
  const response = await fetch(server.url + '/api/v1/state', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const state = await response.json() as { machines: { id: string }[] };
  const machine = state.machines.find(m => m.id === 'review-machine');
  assert.ok(machine, 'real temporary SQLite store must expose the registered machine');
  assert.equal(JSON.stringify(machine).includes(token), false, 'status stderr leaked the fake access token through hello and /state');
});

for (const executorId of ['codex', 'claude-code'] as const) {
  test(`review: ${executorId} diagnostics and task runner must inspect the same ambient profile`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'mario-review-profile-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const configDir = join(dir, 'selected-profile');
    await mkdir(configDir);
    const command = join(dir, 'fake-cli.cjs');
    const selector = executorId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    const observedPath = join(dir, 'task-profile.json');
    await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const selected = process.env[${JSON.stringify(selector)}];
if (args[0] === '--version') {
 console.log(${JSON.stringify(executorId === 'codex' ? 'codex-cli 1.2.3' : '1.2.3 (Claude Code)')});
} else if (args[0] === 'login' || args[0] === 'auth') {
 const loggedIn = selected === ${JSON.stringify(configDir)};
 if (args[0] === 'login') console.error(loggedIn ? 'Logged in using ChatGPT' : 'Not logged in');
 else console.log(JSON.stringify({ loggedIn }));
 process.exitCode = loggedIn ? 0 : 1;
} else {
 fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({ selected, authenticated: selected === ${JSON.stringify(configDir)} }));
 console.log(JSON.stringify({ type: 'thread.started', thread_id: 'review-native' }));
 console.log(JSON.stringify({ type: 'turn.completed' }));
 console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'review-native', result: 'fake local result' }));
}
`);
    await chmod(command, 0o700);
    const env = { ...process.env, HOME: dir, [selector]: configDir };
    const launcher = { command };
    const diagnostics = createAgentDiagnostics({ launchers: { [executorId]: launcher }, env });
    const evidence = await diagnostics.probe(executorId);
    const configPath = join(dir, 'task.config.json');
    await writeFile(configPath, JSON.stringify({ executorId, launcher, cwd: dir, prompt: 'local fake task', resultsPath: join(dir, 'result.json') }));
    await exec(process.execPath, ['plugins/task-runner.ts', configPath], { env });
    const taskProfile = JSON.parse(await readFile(observedPath, 'utf8'));
    assert.equal(taskProfile.selected, configDir, 'actual task child retained the ambient profile');
    assert.equal(taskProfile.authenticated, true);
    assert.equal(evidence.authentication.state, 'authenticated', 'diagnostics checked a different profile from the task child');
  });
}
