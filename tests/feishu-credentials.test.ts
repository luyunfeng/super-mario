import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';

/** A made-up app and its key, of the shape a real one has. Neither is anyone's. */
const appId = 'cli_' + 'f'.repeat(16);
const secret = 'synthetic-secret-' + 'e'.repeat(24);
const token = 'offline-feishu-credentials';

test('飞书的应用密钥写入后留在私有文件里，任何接口、快照和事件都不回显它', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-feishu-credentials-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (method: string, path: string, body?: unknown) => {
    const answer = await fetch(server.url + '/api/v1' + path, { method,
      headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: answer.status, text: await answer.text() };
  };
  // A connection is not made here: the app is made up. Only what is kept and shown is looked at.
  const saved = await call('PUT', '/feishu', { appId, appSecret: secret, enabled: false });
  assert.equal(saved.status, 200, saved.text);
  // What comes back says the app is set up, and names the app, but not the key.
  const view = JSON.parse(saved.text) as Record<string, unknown>;
  assert.equal(view.appId, appId);
  assert.equal(view.configured, true);
  assert.equal('appSecret' in view, false);
  assert.equal(saved.text.includes(secret), false);
  const read = await call('GET', '/feishu');
  assert.equal(read.status, 200);
  assert.equal(read.text.includes(secret), false);
  assert.equal((JSON.parse(read.text) as Record<string, unknown>).appId, appId);
  // The workbench's whole state, and everything it has said so far, are without it too.
  const state = await call('GET', '/state');
  assert.equal(state.status, 200);
  assert.equal(state.text.includes(secret), false);
  const said = JSON.stringify(server.app.events.since(0));
  assert.equal(said.includes(secret), false);
  // It is kept in a file only its owner may read, and the key is there, so that it is not lost.
  const file = join(dir, 'integrations.json');
  const kept = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.equal(kept.appSecret, secret);
  assert.equal((await stat(file)).mode & 0o077, 0, 'no one else may read the file');
  // Writing the app again without a key keeps the key. Changing the app clears it.
  const again = await call('PUT', '/feishu', { appId });
  assert.equal(again.status, 200, again.text);
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>).appSecret, secret);
  // Changing the app clears the key: the old one is for another app. A new app without a key
  // cannot be switched on, so this is done with the connection off.
  const swapped = await call('PUT', '/feishu', { appId: 'cli_' + 'a'.repeat(16), enabled: false });
  assert.equal(swapped.status, 200, swapped.text);
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>).appSecret, '');
  // Switching it on with no key is refused, and nothing is written.
  const noKey = await call('PUT', '/feishu', { enabled: true });
  assert.equal(noKey.status, 400);
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>).enabled, false);
});
