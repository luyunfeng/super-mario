import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('网页版网关独立展示状态，启停走插件管理，CLI 保持开启', { timeout: 40000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-web-gateway-ui-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, demo: true, dataDir });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let enabled = false, fail = false, connected = false;
  const writes: string[] = [];
  const received = '2026-11-20T02:30:00Z';
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && path !== '/api/v1/presence') writes.push(path);
    if (path === '/api/v1/feishu/web') return route.fulfill(fail ? { status: 503, json: { error: '暂不可用' } }
      : { json: { enabled, connected, ...(enabled ? { lastReceivedAt: received, error: connected ? undefined : '连接已断开' } : {}) } });
    if (path === '/api/v1/feishu/personal') return route.fulfill({ json: { status: 'connected', enabled: true } });
    if (path === '/api/v1/plugins/feishu-web') {
      enabled = request.postDataJSON().enabled;
      return route.fulfill({ json: {} });
    }
    if (path === '/api/v1/state') {
      const response = await route.fetch(), state = await response.json();
      state.plugins = [...state.plugins.filter((p: { id: string }) => p.id !== 'feishu-web'),
        { id: 'feishu-web', name: '飞书网页版网关', enabled, status: enabled ? 'active' : 'disabled' }];
      return route.fulfill({ json: state });
    }
    return route.continue();
  });
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#channels');
  const web = page.locator('#channel-feishu-web'), cli = page.locator('#channel-collect');
  await expect(web).toContainText('已停用');
  await expect(web).toContainText('网关与工作台服务端同机时，点击「配置网关」，保留默认地址并填写网关令牌');
  await expect(web).toContainText('每 15 秒同步一次私聊');
  await expect(web).toContainText('无法核实群聊的折叠状态，因此小群也暂不采集');
  await expect(web).toContainText('需要处理群聊时可使用飞书 CLI');
  await expect(cli).toContainText('自动采集已开启');
  await expect(page.getByText(/同一飞书账号建议只开启一种/)).toBeVisible();
  for (const label of ['启用', '停用']) {
    await web.getByRole('button', { name: '管理网页版插件' }).click();
    const dialog = page.getByRole('dialog', { name: '插件配置' });
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await expect(dialog.getByRole('button', { name: label === '启用' ? '停用' : '启用', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    if (label === '启用') {
      await expect(web).toContainText('连接已断开');
      connected = true;
      await web.getByRole('button', { name: '刷新网关状态' }).click();
      await expect(web).toContainText('已连接');
      await expect(web.locator('time')).toHaveAttribute('datetime', received);
    } else await expect(web).toContainText('已停用');
    await expect(cli).toContainText('自动采集已开启');
  }
  fail = true;
  await web.getByRole('button', { name: '刷新网关状态' }).click();
  await expect(web).toContainText('无法读取网页版网关状态');
  await expect(cli).toContainText('自动采集已开启');
  assert.deepEqual(writes, ['/api/v1/plugins/feishu-web', '/api/v1/plugins/feishu-web']);
});

test('网关配置只读取公开状态，同地址留空保留令牌，换地址须填写新令牌', { timeout: 40000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-web-settings-ui-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, demo: true, dataDir });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let baseUrl = 'http://127.0.0.1:9000', hasToken = false, rejectSave = false;
  const writes: { baseUrl: string; token?: string }[] = [];
  await page.route('**/api/v1/feishu/web/settings', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { baseUrl, hasToken } });
    assert.equal(route.request().method(), 'PUT');
    const payload = route.request().postDataJSON();
    writes.push(payload);
    if (rejectSave) return route.fulfill({ status: 400, json: { error: 'invalid' } });
    baseUrl = payload.baseUrl;
    hasToken ||= !!payload.token;
    return route.fulfill({ json: { baseUrl, hasToken } });
  });
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#channels');
  const open = page.getByRole('button', { name: '配置网关', exact: true });
  const drawer = page.getByRole('dialog', { name: '配置网关' });
  const address = drawer.getByLabel('网关地址'), token = drawer.getByLabel('网关令牌');
  const save = drawer.getByRole('button', { name: '保存配置' });
  await open.click();
  await expect(drawer).toContainText('默认地址指向运行工作台服务端的本机');
  await expect(address).toHaveValue(baseUrl);
  await expect(token).toHaveAttribute('type', 'password');
  await save.click();
  await expect(drawer.getByRole('alert')).toHaveText('首次配置，请填写网关令牌。');
  await expect(token).toBeFocused();
  await expect(address).toHaveValue(baseUrl);
  assert.equal(writes.length, 0);
  await token.fill('initial-test-token');
  await save.click();
  await expect(drawer).not.toBeVisible();
  assert.deepEqual(writes[0], { baseUrl, token: 'initial-test-token' });
  await open.click();
  await expect(token).toHaveValue('');
  await expect(drawer).toContainText('留空保留原令牌');
  await save.click();
  await expect(drawer).not.toBeVisible();
  assert.deepEqual(writes[1], { baseUrl });
  await open.click();
  const next = 'http://127.0.0.1:9111';
  await address.fill(next);
  await save.click();
  await expect(token).toBeFocused();
  assert.equal(writes.length, 2);
  await token.fill('replacement-test-token');
  rejectSave = true;
  await save.click();
  await expect(drawer.getByRole('alert')).toContainText('保存失败');
  rejectSave = false;
  await save.click();
  await expect(drawer).not.toBeVisible();
  assert.deepEqual(writes.at(-1), { baseUrl: next, token: 'replacement-test-token' });
  await open.click();
  await expect(address).toHaveValue(next);
  await expect(token).toHaveValue('');
});
