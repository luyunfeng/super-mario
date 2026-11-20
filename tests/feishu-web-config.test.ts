import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkbench } from '../packages/core/src/workbench.ts';

async function gateway(t: TestContext) {
  const cookies: string[] = [];
  const server = createServer((req, res) => {
    cookies.push(req.headers.cookie ?? '');
    res.writeHead(503).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { url: 'http://127.0.0.1:' + address.port, cookies };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await delay(10);
  assert.ok(predicate());
}

test('网页配置原子保存、热切换和并发启停严格隔离令牌，重启优先用已保存的地址', async t => {
  const a = await gateway(t), b = await gateway(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'web-config-'));
  const config = { dataDir, host: '127.0.0.1', port: 0, demo: true, feishuWeb: { baseUrl: a.url, pollIntervalMs: 10 } };
  let app = await createWorkbench(config);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.deepEqual(app.feishuWebSettings(), { baseUrl: a.url, hasToken: false });
  await assert.rejects(app.configureFeishuWeb({ baseUrl: a.url }), { status: 400 });
  const file = join(dataDir, 'feishu-web.json');
  await assert.rejects(stat(file), { code: 'ENOENT' });
  await app.configureFeishuWeb({ token: 'synthetic-A' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(a.cookies.length, 0);
  await app.plugins.setEnabled('feishu-web', true);
  await until(() => a.cookies.length > 0);
  const saved = await readFile(file, 'utf8');
  for (const input of [{ baseUrl: b.url, token: '' }, { baseUrl: 'http://example.org' },
    { baseUrl: 'https://host/path' }, { baseUrl: 'https://user@host' }, { baseUrl: 'https://host/?q=x' },
    { token: 'bad\nvalue' }, { token: 42 }]) {
    await assert.rejects(app.configureFeishuWeb(input), { status: 400 });
    assert.equal(await readFile(file, 'utf8'), saved);
  }
  assert.deepEqual(await app.configureFeishuWeb({ baseUrl: a.url + '/', token: '' }), { baseUrl: a.url, hasToken: true });
  assert.equal(b.cookies.length, 0);
  await app.configureFeishuWeb({ baseUrl: b.url, token: 'synthetic-B' });
  await until(() => b.cookies.length > 0);
  assert.deepEqual([...new Set(a.cookies)], ['agentdock_web=synthetic-A']);
  assert.deepEqual([...new Set(b.cookies)], ['agentdock_web=synthetic-B']);
  await Promise.all([app.configureFeishuWeb({ token: 'synthetic-C' }), app.plugins.setEnabled('feishu-web', false)]);
  assert.equal(app.feishuWebStatus().enabled, false);
  await Promise.all([app.plugins.setEnabled('feishu-web', true), app.configureFeishuWeb({ token: 'synthetic-D' })]);
  await until(() => b.cookies.includes('agentdock_web=synthetic-D'));
  await app.close();
  app = await createWorkbench(config);
  assert.deepEqual(app.feishuWebSettings(), { baseUrl: b.url, hasToken: true });
  assert.equal(app.feishuWebStatus().enabled, true);
  assert.ok(!JSON.stringify(await app.snapshot()).includes('synthetic-D'));
});

test('无效环境配置或损坏的私有配置只影响网页来源，修复须提供新令牌', async t => {
  const server = await gateway(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'web-config-repair-'));
  const file = join(dataDir, 'feishu-web.json');
  const target = join(dataDir, 'unrelated');
  const config = { dataDir, host: '127.0.0.1', port: 0, demo: true };
  const before = { baseUrl: process.env.SUPER_MARIO_FEISHU_WEB_BASE_URL, token: process.env.SUPER_MARIO_FEISHU_WEB_TOKEN };
  process.env.SUPER_MARIO_FEISHU_WEB_BASE_URL = 'http://remote.invalid';
  process.env.SUPER_MARIO_FEISHU_WEB_TOKEN = 'synthetic-env';
  let app = await createWorkbench(config);
  t.after(async () => {
    await app.close(); await rm(dataDir, { recursive: true, force: true });
    for (const [key, value] of [['SUPER_MARIO_FEISHU_WEB_BASE_URL', before.baseUrl], ['SUPER_MARIO_FEISHU_WEB_TOKEN', before.token]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await app.plugins.setEnabled('feishu-web', true);
  const fallback = { baseUrl: 'http://127.0.0.1:4310', hasToken: false };
  assert.deepEqual(app.feishuWebSettings(), fallback);
  assert.ok(app.feishuWebStatus().error);
  await assert.rejects(app.configureFeishuWeb({ baseUrl: server.url }), { status: 400 });
  await app.close();
  process.env.SUPER_MARIO_FEISHU_WEB_BASE_URL = server.url;
  await writeFile(file, '{broken', { mode: 0o600 });
  app = await createWorkbench(config);
  assert.deepEqual(app.feishuWebSettings(), fallback);
  assert.ok(app.feishuWebStatus().error);
  await app.close();
  await writeFile(file, JSON.stringify({ baseUrl: server.url, token: 'unsafe-fixture' }));
  await chmod(file, 0o644);
  app = await createWorkbench(config);
  assert.deepEqual(app.feishuWebSettings(), fallback);
  assert.ok(app.feishuWebStatus().error);
  await app.close();
  await rm(file);
  // A valid environment binding is still supported when there is no saved file.
  app = await createWorkbench(config);
  assert.deepEqual(app.feishuWebSettings(), { baseUrl: server.url, hasToken: true });
  await until(() => server.cookies.includes('agentdock_web=synthetic-env'));
  await app.close();
  server.cookies.length = 0;
  await writeFile(target, 'unrelated');
  await symlink(target, file);
  app = await createWorkbench(config);
  assert.deepEqual(app.feishuWebSettings(), fallback);
  await assert.rejects(app.configureFeishuWeb({ baseUrl: server.url }), { status: 400 });
  assert.deepEqual(server.cookies, []);
  await app.configureFeishuWeb({ baseUrl: server.url, token: 'fresh-fixture' });
  await until(() => server.cookies.length > 0);
  assert.deepEqual([...new Set(server.cookies)], ['agentdock_web=fresh-fixture']);
  assert.equal(await readFile(target, 'utf8'), 'unrelated');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
