import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import extension, { createCommandInboxConnector } from '../plugins/command-inbox/index.ts';
import type { CommandInboxConfig } from '../plugins/command-inbox/index.ts';
import { PluginHost, createContributions } from '../packages/core/src/plugin-host.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { loadExtensions } from '../packages/core/src/extension-loader.ts';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';

const item = { thread: 'oc_unknown', last: 'm1', title: '@我 group', text: 'private body' };
const signal = () => new AbortController().signal;
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-command-inbox-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function command(t: test.TestContext, body: string, args: string[] = []) {
  const dir = await fixture(t);
  const script = join(dir, 'fake.mjs');
  await writeFile(script, body);
  const config: CommandInboxConfig = { command: process.execPath, args: [script, ...args], collectEnabled: true };
  return { dir, config, connector: createCommandInboxConnector(config) };
}

test('real command preserves explicit provenance and does not infer group or mentions', async t => {
  const items = [item, { ...item, last: 'm2', origin: { kind: 'group', chatId: 'chat', mentionedMe: true, senderName: 'sender' } },
    { ...item, last: 'm3', origin: { kind: 'direct', connector: 'wrapper', mentionedMe: true } }];
  const f = await command(t, `console.log(${JSON.stringify(JSON.stringify({ items }))});`);
  const result = await f.connector.collect(signal());
  assert.deepEqual(result[0].origin, { kind: 'unknown', connector: '命令收件箱' });
  assert.deepEqual(result[1].origin, { kind: 'group', connector: '命令收件箱', chatId: 'chat', senderName: 'sender', mentionedMe: true });
  assert.deepEqual(result[2].origin, { kind: 'direct', connector: 'wrapper' });
  const custom = createCommandInboxConnector({ ...f.config, name: '企业 wrapper' });
  assert.equal((await custom.collect(signal()))[0].origin?.connector, '企业 wrapper');
});

test('execFile passes shell metacharacters literally and snapshots argv', async t => {
  const dir = await fixture(t), marker = join(dir, 'SHOULD_NOT_EXIST'), capture = join(dir, 'argv.json');
  const argv = [`; touch ${marker}`, `$(touch ${marker})`, '`id`', 'a b', '"quoted"'];
  const f = await command(t, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))); console.log('[]');`, argv);
  f.config.args.push('mutated');
  assert.deepEqual(await f.connector.collect(signal()), []);
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), argv);
  await assert.rejects(access(marker));
});

test('disabled, missing and invalid configuration never execute a command', async () => {
  let calls = 0;
  for (const config of [
    { command: 'fake', args: [], collectEnabled: false },
    { command: '', args: [], collectEnabled: true },
    { command: 'fake', args: [], collectEnabled: true, timeoutMs: 0 },
    { command: 'fake', args: 'bad', collectEnabled: true },
  ]) {
    const c = createCommandInboxConnector(config as CommandInboxConfig, { run: async () => { calls++; return '[]'; } });
    assert.equal(c.status().available, false);
    assert.ok(c.status().reason);
    await assert.rejects(c.collect(signal()));
  }
  assert.equal(calls, 0);
});

test('strict schema rejects malformed batches and injected project/processed state', async () => {
  const malformed = ['secret invalid JSON', { items: [item], extra: 'forbidden' }, { items: [item, { ...item, projectId: 'p' }] },
    [{ ...item, archivedAt: 'now' }], [{ ...item, text: 1 }], [{ ...item, origin: { kind: 'group', mentionedMe: 'true' } }],
    [{ ...item, origin: { kind: 'invented' } }], [{ ...item, receivedAt: 'yesterday' }], Array(501).fill(item)];
  for (const value of malformed) {
    const c = createCommandInboxConnector({ command: 'fake', args: [], collectEnabled: true }, {
      run: async () => typeof value === 'string' ? value : JSON.stringify(value),
    });
    await assert.rejects(c.collect(signal()), error => {
      assert.match(String(error), /invalid_json|invalid_schema/);
      assert.doesNotMatch(String(error), /secret|private body/);
      return true;
    });
  }
});

test('real command failures and oversized stdout/stderr never expose output', async t => {
  for (const body of [
    `console.log('stdout secret'); console.error('stderr secret'); process.exit(1);`,
    `console.log('secret invalid JSON');`,
    `process.stdout.write('secret'.repeat(200000));`,
    `process.stderr.write('secret'.repeat(200000)); setTimeout(() => {}, 10000);`,
  ]) {
    const f = await command(t, body);
    await assert.rejects(f.connector.collect(signal()), error => {
      assert.doesNotMatch(String(error), /secret|fake.mjs/);
      return true;
    });
  }
});

test('real timeout and cancellation abort execution with unknown outcome', async t => {
  const f = await command(t, `setTimeout(() => console.log('[]'), 10000);`);
  const timeout = createCommandInboxConnector({ ...f.config, timeoutMs: 30 });
  await assert.rejects(timeout.collect(signal()), (error: any) => error.delivery === 'unknown');
  const controller = new AbortController();
  const pending = f.connector.collect(controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: any) => error.code === 'cancelled' && error.delivery === 'unknown');
  const never = new AbortController(); never.abort();
  await assert.rejects(f.connector.collect(never.signal), /cancelled/);
});

test('close aborts the active runner, blocks new work, and refuses overlapping collection', async () => {
  let calls = 0, started!: () => void, aborted = false;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const c = createCommandInboxConnector({ command: 'fake', args: [], collectEnabled: true }, { run: async (_, __, options) => {
    calls++; started();
    options.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } });
  const pending = c.collect(signal());
  await ready;
  await assert.rejects(c.collect(signal()), /collection_in_progress/);
  c.close();
  await assert.rejects(pending, (error: any) => error.delivery === 'unknown');
  assert.equal(aborted, true);
  await assert.rejects(c.collect(signal()), /closed/);
  assert.equal(c.status().available, false);
  assert.equal(calls, 1);
});

test('PluginHost contributes metadata and a no-argument tool; only valid batches reach the fixed service', async t => {
  const f = await command(t, `console.log(${JSON.stringify(JSON.stringify([item]))});`);
  const store = createStore(':memory:'), contributions = createContributions();
  const host = new PluginHost({ store, contributions, dataDir: f.dir, events: createEventBus(store) });
  t.after(async () => { await host.close(); store.close(); });
  const calls: JsonObject[] = [];
  contributions.add('services', 'test/core.inbox.ingest', { name: 'core.inbox.ingest', version: 1, handler(input) {
    calls.push(input as JsonObject);
    return { accepted: true, count: (input as any).items.length, source: 'plugin:command-inbox:messages' };
  } });
  host.register(extension, f.config as unknown as JsonObject);
  await host.start();
  assert.equal(host.list().find(p => p.id === 'command-inbox')?.status, 'active');
  assert.equal(calls.length, 0);
  assert.deepEqual(contributions.list('connectors')[0].value, {
    id: 'command-inbox', name: '命令收件箱', sourceId: 'messages', available: true, automatic: false,
  });
  const tool = contributions.list('tools').find(t => t.value.name === 'command_inbox_collect')!.value;
  await assert.rejects(tool.execute({ command: 'injected' }, signal()), /unexpected_arguments/);
  assert.deepEqual(await tool.execute({}, signal()), { accepted: true, count: 1, source: 'plugin:command-inbox:messages' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceId, 'messages');
  assert.equal(calls[0].__owner, 'command-inbox');
  assert.deepEqual((calls[0].items as any[])[0].origin, { kind: 'unknown', connector: '命令收件箱' });
  await writeFile(f.config.args[0], `console.log(${JSON.stringify(JSON.stringify([item, { ...item, projectId: 'forbidden' }]))});`);
  await assert.rejects(tool.execute({}, signal()), /invalid_schema/);
  assert.equal(calls.length, 1, 'a partially valid batch must not ingest anything');
  await writeFile(f.config.args[0], `setTimeout(() => console.log('[]'), 10000);`);
  const active = assert.rejects(tool.execute({}, signal()), (error: any) => error.delivery === 'unknown');
  await new Promise<void>(resolve => setImmediate(resolve));
  await host.setEnabled('command-inbox', false);
  await active;
  assert.equal(calls.length, 1, 'disabling an active collector must not ingest late output');
  assert.equal(contributions.list('tools').length, 0);
  assert.equal(contributions.list('connectors').length, 0);
  await assert.rejects(tool.execute({}, signal()), /closed/);
});

test('manifest loads through existing loader and stays unavailable without explicit configuration', async t => {
  const dir = await fixture(t), folder = join(dir, 'extensions', 'command-inbox');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(folder, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const source = new URL('../plugins/command-inbox/', import.meta.url);
  await writeFile(join(folder, 'super-mario.extension.json'), await readFile(new URL('super-mario.extension.json', source)));
  // The loader requires regular files. This installed entry re-exports the real plugin.
  await writeFile(join(folder, 'index.js'), `export { default } from ${JSON.stringify(new URL('index.ts', source).href)};`);
  const loaded = await loadExtensions(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].extension.id, 'command-inbox');
  const store = createStore(':memory:'), contributions = createContributions();
  const host = new PluginHost({ store, contributions, dataDir: dir, events: createEventBus(store) });
  t.after(async () => { await host.close(); store.close(); });
  host.register(loaded[0].extension, loaded[0].config);
  await host.start();
  assert.equal(host.list()[0].status, 'active');
  assert.equal((contributions.list('connectors')[0].value as JsonObject).available, false);
  await assert.rejects(contributions.list('tools')[0].value.execute({}, signal()), /采集未开启/);
});
