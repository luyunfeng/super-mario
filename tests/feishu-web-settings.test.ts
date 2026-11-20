import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';

test('网页版默认停用，切换网页版保留个人 CLI 的采集选择', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'web-connector-'));
  const service = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, feishuWeb: { baseUrl: '' } });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  const state = async (path: string) => {
    const response = await fetch(service.url + '/api/v1/feishu/' + path);
    assert.equal(response.status, 200);
    return response.json();
  };
  const cliBefore = await state('personal');
  assert.equal((await state('web')).enabled, false);
  for (const enabled of [true, false]) {
    const response = await fetch(service.url + '/api/v1/plugins/feishu-web', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
    });
    assert.equal(response.status, 200);
    const web = await state('web');
    assert.equal(web.enabled, enabled);
    assert.equal(web.connected, false);
    assert.equal((await state('personal')).enabled, cliBefore.enabled);
  }
});

test('渠道配置接口要求工作台认证，保存结果不回显网关令牌', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'web-settings-'));
  const service = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, token: 'fixture-workbench',
    feishuWeb: { baseUrl: 'http://127.0.0.1:4310' } });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = service.url + '/api/v1/feishu/web/settings';
  const headers = { authorization: 'Bearer fixture-workbench', 'content-type': 'application/json' };
  assert.equal((await fetch(url)).status, 401);
  const fixture = 'synthetic-test-gateway';
  const response = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ baseUrl: 'http://127.0.0.1:4310', token: fixture }) });
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes(fixture));
  const saved = await (await fetch(url, { headers })).json();
  assert.equal(saved.hasToken, true);
  assert.ok(!JSON.stringify(saved).includes(fixture));
});
