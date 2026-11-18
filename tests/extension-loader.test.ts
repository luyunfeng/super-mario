import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { loadExtensions } from '../packages/core/src/extension-loader.ts';
import { PluginHost, createContributions } from '../packages/core/src/plugin-host.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';

async function setup(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'extension-loader-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  async function install(directory: string, manifest: Record<string, unknown> = {}, source?: string) {
    const folder = join(dataDir, 'extensions', directory);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(folder, 'super-mario.extension.json'), JSON.stringify({ id: directory, version: '1.0.0', apiVersion: 1, main: 'index.js', ...manifest }));
    await writeFile(join(folder, 'index.js'), source ?? `export default { id: ${JSON.stringify(manifest.id ?? directory)}, name: 'Test', capabilities: [], activate() {} };`);
    return folder;
  }
  const store = createStore(':memory:');
  const contributions = createContributions();
  const host = new PluginHost({ dataDir, store, contributions, events: createEventBus(store) });
  t.after(async () => { await host.close(); store.close(); });
  return { dataDir, install, host, contributions, store };
}

test('imports real JS object/factory exports and manages config, dependencies and tool lifecycle', async t => {
  const { dataDir, install, host, contributions, store } = await setup(t);
  await install('a-consumer', { dependencies: ['provider'], config: { answer: 42 } }, `
    export default async () => ({ id: 'a-consumer', name: 'Consumer', capabilities: ['tools'], activate(ctx) {
      ctx.contribute('tools', 'answer', { name: 'answer', description: 'test', parameters: {}, async execute() { return ctx.config.answer; } });
      ctx.onEvent(() => ctx.store.put('test', 'observed', true));
      ctx.defer(() => ctx.store.put('test', 'disposed', true));
    } });`);
  await install('provider');
  const loaded = await loadExtensions(dataDir);
  for (const { extension, config } of loaded) host.register(extension, config);
  await host.start();
  assert.ok(host.list().every(item => item.status === 'active'));
  assert.equal(await contributions.list('tools')[0]!.value.execute({}, new AbortController().signal), 42);
  await host.setEnabled('provider', false);
  assert.deepEqual(contributions.list('tools'), []);
  assert.equal(store.get('test', 'disposed'), true);
  await host.setEnabled('provider', true);
  assert.equal(contributions.list('tools').length, 1);
  await host.close();
  assert.deepEqual(contributions.list('tools'), []);
});

test('bad manifests, imports, factories, exports and activation failures stay isolated', async t => {
  const { dataDir, install, host, contributions } = await setup(t);
  await install('good');
  const broken = await install('bad-json');
  await writeFile(join(broken, 'super-mario.extension.json'), '{');
  await install('bad-id', { id: '../invalid' });
  await install('bad-version', { version: 'latest' });
  await install('bad-api', { apiVersion: 2 });
  await install('bad-config', { config: [] });
  await install('bad-permissions', { permissions: ['nonexistent.right'] }, 'throw new Error("must not import invalid permissions");');
  await install('bad-runtime', { runtime: 'process' });
  await install('bad-deps', { dependencies: ['../x'] });
  await install('bad-import', {}, 'throw new Error("import failed");');
  await install('bad-factory', {}, 'export default () => { throw new Error("factory failed"); };');
  await install('bad-export', {}, 'export default {};');
  await install('bad-activate', {}, `export default { id: 'bad-activate', name: 'Bad', capabilities: [], activate(ctx) {
    ctx.contribute('tools', 'partial', {}); throw new Error('activation failed');
  } };`);
  const loaded = await loadExtensions(dataDir);
  for (const { extension, config } of loaded) host.register(extension, config);
  await host.start();
  assert.equal(host.list().find(item => item.id === 'good')!.status, 'active');
  assert.equal(host.list().filter(item => item.status === 'failed').length, 12);
  assert.ok(host.list().find(item => item.id === 'error.bad-json'));
  assert.ok(host.list().find(item => item.id === 'error.bad-id'));
  assert.deepEqual(contributions.list('tools'), []);
  assert.deepEqual(loaded.map(item => item.extension.id), (await loadExtensions(dataDir)).map(item => item.extension.id));
});

test('reserved and duplicate IDs get unique stable diagnostic IDs, and cycles cannot break registration', async t => {
  const { dataDir, install, host } = await setup(t);
  await install('a', { id: 'builtin' });
  await install('b', { id: 'same' });
  await install('c', { id: 'same' });
  await install('d', { id: 'error.a' });
  await install('cycle-a', { dependencies: ['cycle-b'] });
  await install('cycle-b', { dependencies: ['cycle-a'] });
  const loaded = await loadExtensions(dataDir, { reservedIds: ['builtin'] });
  assert.deepEqual(loaded.map(item => item.extension.id), ['error.a.2', 'same', 'error.c', 'cycle-a', 'cycle-b', 'error.a']);
  host.register({ id: 'builtin', name: 'Builtin', capabilities: [], activate() {} });
  for (const { extension, config } of loaded) host.register(extension, config);
  await host.start();
  assert.equal(host.list().find(item => item.id === 'builtin')!.status, 'active');
  assert.equal(host.list().filter(item => item.status === 'failed').length, 4);
});

test('rejects traversal, entry symlinks, parent symlinks, manifest symlinks and plugin directory symlinks before import', async t => {
  const { dataDir, install, host } = await setup(t);
  const outside = join(dataDir, 'outside.js');
  await writeFile(outside, 'throw new Error("ESCAPED");');
  await install('traversal', { main: '../../outside.js' });
  await install('absolute', { main: outside });
  const entry = await install('entry-link');
  await rm(join(entry, 'index.js'));
  await symlink(outside, join(entry, 'index.js'));
  const parent = await install('parent-link', { main: 'linked/outside.js' });
  await symlink(dataDir, join(parent, 'linked'));
  const manifest = await install('manifest-link');
  await rm(join(manifest, 'super-mario.extension.json'));
  await symlink(outside, join(manifest, 'super-mario.extension.json'));
  await symlink(entry, join(dataDir, 'extensions', 'directory-link'));
  for (const { extension, config } of await loadExtensions(dataDir)) host.register(extension, config);
  await host.start();
  assert.equal(host.list().length, 6);
  assert.ok(host.list().every(item => item.status === 'failed' && !item.error?.includes('ESCAPED')));
});

test('missing extensions directory is empty; symlink root is reported as a failed extension', async t => {
  const { dataDir, host } = await setup(t);
  assert.deepEqual(await loadExtensions(dataDir), []);
  await symlink(tmpdir(), join(dataDir, 'extensions'));
  for (const { extension, config } of await loadExtensions(dataDir)) host.register(extension, config);
  await host.start();
  assert.equal(host.list()[0]!.status, 'failed');
});
