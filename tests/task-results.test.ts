import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createNativeCollector, readTaskResult, saveTaskResult } from '../plugins/task-results.ts';
import type { TaskConfig } from '../plugins/task-results.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }, script: string, executorId: TaskConfig['executorId'] = 'codex', nativeSessionId?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'super-mario-task-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const cli = join(bin, executorId === 'codex' ? 'codex' : 'claude');
  await writeFile(cli, `#!${process.execPath}\n${script}`);
  await chmod(cli, 0o700);
  const config: TaskConfig = { prompt: '--help $(touch unsafe); "quoted"\nnext', cwd: dir, executorId, resultsPath: join(dir, 'result.json'), ...(nativeSessionId !== undefined ? { nativeSessionId } : {}) };
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../plugins/task-runner.ts', import.meta.url)), configPath], {
    cwd: dir, env: { ...process.env, PATH: bin }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { dir, config, child, done, output: () => ({ stdout, stderr }) };
}
const codexSuccess = `console.log(JSON.stringify({type:'thread.started',thread_id:'native-codex'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'task done'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{}}));`;

test('Codex subprocess preserves prompt/flags, tees output, and persists native completion', async t => {
  const f = await fixture(t, `require('node:fs').writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));\n${codexSuccess}\nconsole.error('diagnostic');`);
  assert.equal(await f.done, 0);
  const { progress, ...result } = readTaskResult(f.config.resultsPath);
  assert.deepEqual(result, { state: 'completed', text: 'task done', source: 'codex-json', exitCode: 0, nativeSessionId: 'native-codex' });
  assert.equal(progress?.phase, 'responding');
  assert.ok(Number.isFinite(Date.parse(progress!.observedAt)));
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'argv.json'), 'utf8')), [
    'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--output-last-message', `${f.config.resultsPath}.last-message`, '--', f.config.prompt,
  ]);
  assert.match(f.output().stdout, /turn.completed/);
  assert.match(f.output().stderr, /diagnostic/);
  assert.equal((await stat(f.config.resultsPath)).mode & 0o777, 0o600);
  await assert.rejects(stat(join(f.dir, 'unsafe')));
});

test('Claude subprocess collects native result and session ID without shell interpolation', async t => {
  const f = await fixture(t, `require('node:fs').writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'native-claude'}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Claude done',session_id:'native-claude'}));`, 'claude-code');
  assert.equal(await f.done, 0);
  const { progress, ...result } = readTaskResult(f.config.resultsPath);
  assert.deepEqual(result, { state: 'completed', text: 'Claude done', source: 'claude-stream-json', exitCode: 0, nativeSessionId: 'native-claude' });
  assert.equal(progress?.phase, 'starting');
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'argv.json'), 'utf8')), ['-p', '--output-format', 'stream-json', '--verbose', '--', f.config.prompt]);
});

test('runner persists native tool progress before exit and keeps the final response observation', async t => {
  const f = await fixture(t, `const fs = require('node:fs');
console.log(JSON.stringify({type:'thread.started',thread_id:'progress-native'}));
console.log(JSON.stringify({type:'item.started',item:{id:'c1',type:'command_execution',command:'fixture --token=private',status:'in_progress'}}));
const deadline = setTimeout(() => process.exit(5), 5000);
const timer = setInterval(() => {
  if (!fs.existsSync('release')) return;
  clearInterval(timer); clearTimeout(deadline);
  console.log(JSON.stringify({type:'item.completed',item:{id:'a1',type:'agent_message',text:'task done'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{}}));
}, 10);`);
  const deadline = Date.now() + 4000;
  let running = readTaskResult(f.config.resultsPath);
  while (running.progress?.phase !== 'tool' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
    running = readTaskResult(f.config.resultsPath);
  }
  assert.equal(running.state, 'running');
  assert.equal(running.progress?.phase, 'tool');
  assert.equal(running.progress?.toolName, 'command_execution');
  assert.ok(!JSON.stringify(running.progress).includes('private'));
  await writeFile(join(f.dir, 'release'), '');
  assert.equal(await f.done, 0);
  const completed = readTaskResult(f.config.resultsPath);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.progress?.phase, 'responding');
  assert.equal(completed.progress?.toolName, undefined);
  assert.equal(completed.text, 'task done');
});

for (const [name, script, state] of [
  ['screen success text with exit zero', "console.log('done'); console.log('{bad-json');", 'unknown'],
  ['native success followed by failed exit', `${codexSuccess}\nprocess.exitCode=7;`, 'failed'],
  ['native turn failure with exit zero', "console.log(JSON.stringify({type:'turn.failed',error:{message:'rejected'}}));", 'failed'],
  ['native success followed by process signal', `${codexSuccess}\nprocess.kill(process.pid,'SIGTERM');`, 'unknown'],
] as const) {
  test(name, async t => {
    const f = await fixture(t, script);
    await f.done;
    assert.equal(readTaskResult(f.config.resultsPath).state, state);
  });
}

test('Claude native error remains failed even when the process exits zero', async t => {
  const f = await fixture(t, "console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,errors:['CLI failed'],session_id:'failed-native'}));", 'claude-code');
  await f.done;
  assert.deepEqual(readTaskResult(f.config.resultsPath), { state: 'failed', text: 'CLI failed', source: 'claude-stream-json', exitCode: 0, nativeSessionId: 'failed-native' });
});

test('spawn failure is recorded as failed without retry', async t => {
  const f = await fixture(t, '');
  // Launch an additional runner with an empty PATH; neither the real CLI nor a model is reachable.
  await f.done;
  const configPath = join(f.dir, 'config.json');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../plugins/task-runner.ts', import.meta.url)), configPath], { env: { ...process.env, PATH: '' }, stdio: 'ignore' });
  await new Promise(resolve => child.on('close', resolve));
  assert.equal(readTaskResult(f.config.resultsPath).state, 'failed');
  assert.match(readTaskResult(f.config.resultsPath).text, /ENOENT/);
});

test('disappeared runner is unknown; stored results remain readable without PTY access', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'super-mario-task-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'result.json');
  assert.equal(readTaskResult(path).state, 'unknown');
  saveTaskResult(path, { state: 'running', text: '', source: 'codex-json' }, 2147483647);
  assert.equal(readTaskResult(path).state, 'unknown');
  saveTaskResult(path, { state: 'completed', text: 'persisted', source: 'codex-json', exitCode: 0 });
  assert.equal(readTaskResult(path).text, 'persisted');
});

test('runner signal records unknown and does not replay the CLI', async t => {
  const f = await fixture(t, "console.log(JSON.stringify({type:'thread.started',thread_id:'interrupted'})); setInterval(()=>{},1000);");
  // Wait for native startup, avoiding timing assumptions about subprocess initialization.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake CLI startup timeout')), 5000);
    const check = (data: Buffer) => { if (data.toString().includes('thread.started')) { clearTimeout(timer); f.child.stdout.off('data', check); resolve(); } };
    f.child.stdout.on('data', check);
  });
  f.child.kill('SIGTERM');
  await f.done;
  assert.equal(readTaskResult(f.config.resultsPath).state, 'unknown');
  assert.equal(readTaskResult(f.config.resultsPath).nativeSessionId, 'interrupted');
});

// This host only records calls: it never creates or writes a real personal PTY.
async function taskServiceFixture(t: { after(fn: () => Promise<void>): void }, restored = true) {
  const { createExecutionServices } = await import('../plugins/executors.ts');
  const dir = await mkdtemp(join(tmpdir(), 'super-mario-task-input-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writes: Array<{ text?: string; keys?: string[] }> = [];
  let panePresent = true;
  let reads = 0, watches = 0;
  const host: import('../packages/plugin-sdk/src/index.ts').TerminalHost = {
    status: async () => ({ available: true }),
    create: async () => ({ id: 'task-pane', cwd: dir, title: 'fake task' }),
    list: async () => panePresent ? [{ id: 'task-pane', cwd: dir, title: 'fake task' }] : [],
    read: async () => { reads++; if (!panePresent) throw new Error('missing pane'); return { text: 'task output', ansi: 'task output' }; },
    input: async (_paneId, text) => { writes.push({ text }); },
    keys: async (_paneId, keys) => { writes.push({ keys }); },
    watch: async () => { watches++; return () => {}; },
    close: async () => { throw new Error('Must not close a PTY'); },
  };
  const options = { host, dataDir: join(dir, 'data'), hasCommand: () => true };
  const initial = createExecutionServices(options);
  const binding = await initial.handlers['executor.start']!({ executorId: 'codex', prompt: 'task', cwd: dir, mode: 'task' }, () => {}) as unknown as { sessionId: string; paneId: string };
  // Test restored services too: an in-memory mode flag would lose the input restriction.
  const service = restored ? createExecutionServices(options) : initial;
  t.after(() => service.disconnect());
  const call = (method: string, params: import('../packages/protocol/src/index.ts').JsonObject) => service.handlers[method]!(params, () => {});
  return { dir, binding, writes, call, removePane: () => { panePresent = false; }, counts: () => ({ reads, watches }) };
}

test('persisted task sessions refuse every legacy pane write after agent restart', async t => {
  const { binding: b, writes, call } = await taskServiceFixture(t);
  await assert.rejects(call('executor.input', { sessionId: b.sessionId, text: 'follow up' }), /Historical session ownership/);
  await assert.rejects(call('terminal.input', { paneId: b.paneId, text: 'follow up' }), /Historical session ownership/);
  for (const keys of [['Enter'], ['C-c'], ['C-c', 'Enter'], ['C-c', 'C-c'], ['x']]) {
    await assert.rejects(call('terminal.keys', { paneId: b.paneId, keys }), /Historical session ownership/);
  }
  assert.deepEqual(writes, []);
});

test('task read/watch and interrupts work; persisted results survive the normal disappearance of its pane', async t => {
  const { dir, binding: b, writes, call, removePane, counts } = await taskServiceFixture(t, false);
  await call('executor.read', { sessionId: b.sessionId });
  await call('terminal.read', { paneId: b.paneId });
  await call('terminal.watch', { paneId: b.paneId });
  await call('executor.interrupt', { sessionId: b.sessionId });
  await call('terminal.keys', { paneId: b.paneId, keys: ['C-c'] });
  assert.deepEqual(writes, [{ keys: ['C-c'] }, { keys: ['C-c'] }]);
  assert.deepEqual(counts(), { reads: 2, watches: 1 });
  const result = { state: 'completed' as const, text: 'finished', source: 'codex-json', exitCode: 0, nativeSessionId: 'native-task' };
  saveTaskResult(join(dir, 'data', 'task-results', `${b.sessionId}.json`), result);
  removePane();
  assert.deepEqual(await call('executor.result', { sessionId: b.sessionId }), result);
  await assert.rejects(call('executor.input', { sessionId: b.sessionId, text: 'too late' }), /do not accept interactive input/);
  assert.deepEqual(counts(), { reads: 2, watches: 1 });
});

for (const executorId of ['codex', 'claude-code'] as const) {
  for (const evidence of ['matching', 'missing', 'different', 'different-then-matching'] as const) {
    test(`${executorId} resume requires matching native event evidence: ${evidence}`, async t => {
      const expected = 'requested-native';
      const ids = evidence === 'matching' ? [expected] : evidence === 'missing' ? []
        : evidence === 'different' ? ['other-native'] : ['other-native', expected];
      const events: Array<Record<string, unknown>> = ids.map(id => executorId === 'codex'
        ? { type: 'thread.started', thread_id: id }
        : { type: 'system', subtype: 'init', session_id: id });
      events.push(executorId === 'codex' ? { type: 'turn.completed' }
        : { type: 'result', subtype: 'success', is_error: false, result: 'done' });
      const script = `require('node:fs').writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));
require('node:fs').writeFileSync('cwd.txt',process.cwd());
for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`;
      const f = await fixture(t, script, executorId, expected);
      const exit = await f.done;
      assert.ok(evidence === 'matching' || evidence === 'missing' ? exit === 0 : (exit === 0 || exit === 1), 'a mismatched owned process may exit naturally or be stopped');
      assert.equal(readTaskResult(f.config.resultsPath).state, evidence === 'matching' ? 'completed' : evidence === 'missing' ? 'unknown' : 'failed');
      const actualId = readTaskResult(f.config.resultsPath).nativeSessionId;
      if (evidence === 'different' || evidence === 'different-then-matching') { assert.ok(actualId && ids.includes(actualId)); assert.match(readTaskResult(f.config.resultsPath).text, /不同的线程/); }
      else assert.equal(actualId, ids.at(-1));
      assert.equal(await readFile(join(f.dir, 'cwd.txt'), 'utf8'), f.dir);
      assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'argv.json'), 'utf8')), executorId === 'codex'
        ? ['--sandbox', 'workspace-write', 'exec', 'resume', '--json', '--skip-git-repo-check',
          '--output-last-message', `${f.config.resultsPath}.last-message`, '--', expected, f.config.prompt]
        : ['--resume', expected, '-p', '--output-format', 'stream-json', '--verbose', '--', f.config.prompt]);
    });
  }
  test(`${executorId} matching resume with nonzero exit stays failed`, async t => {
    const event = executorId === 'codex' ? { type: 'thread.started', thread_id: 'requested-native' }
      : { type: 'system', session_id: 'requested-native' };
    const terminal = executorId === 'codex' ? { type: 'turn.completed' }
      : { type: 'result', subtype: 'success', is_error: false };
    const f = await fixture(t, `console.log(${JSON.stringify(JSON.stringify(event))});
console.log(${JSON.stringify(JSON.stringify(terminal))}); process.exitCode=9;`, executorId, 'requested-native');
    assert.equal(await f.done, 9);
    assert.equal(readTaskResult(f.config.resultsPath).state, 'failed');
  });
}

test('resume identity mismatch remains failed before exit, after matching events, and on signal', () => {
  for (const executorId of ['codex', 'claude-code'] as const) {
    const collector = createNativeCollector(executorId, 'expected');
    const identity = (id: string) => executorId === 'codex'
      ? { type: 'thread.started', thread_id: id } : { type: 'system', session_id: id };
    collector.event(identity('different'));
    assert.equal(collector.result().state, 'failed');
    collector.event(identity('expected'));
    collector.event(executorId === 'codex' ? { type: 'turn.completed' }
      : { type: 'result', subtype: 'success', is_error: false });
    assert.equal(collector.result(0).state, 'failed');
    assert.equal(collector.result(undefined, 'SIGTERM').state, 'failed');
  }
});

test('a resumed CLI that reports the wrong identity is stopped instead of continuing an unapproved thread',async t=>{
 const f=await fixture(t,`console.log(JSON.stringify({type:'thread.started',thread_id:'wrong-native'}));setInterval(()=>{},1000);`,'codex','expected-native');
 await f.done;
 const result=readTaskResult(f.config.resultsPath);assert.equal(result.state,'failed');assert.match(result.text,/不同的线程/);assert.equal(result.nativeSessionId,'wrong-native');
});
