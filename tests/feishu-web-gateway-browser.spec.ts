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
  await expect(web).toContainText('工作台读取网关快照，不主动将消息标记为已读');
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

test('网页版扫码只在点击后启动，展示失效、条件不足及成功，并在关闭后停止轮询', { timeout: 40000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-web-login-ui-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, demo: true, dataDir });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let starts = 0, polls = 0;
  // Hold each response until the browser has observed the preceding state.
  // Under parallel load a wall-clock fixture could expire the QR before the assertion runs.
  const advance: Array<() => void> = [];
  const gates = Array.from({ length: 3 }, (_, i) => new Promise<void>(resolve => { advance[i] = resolve; }));
  const qrDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j65kAAAAASUVORK5CYII=';
  await page.route('**/api/v1/feishu/web/login**', async route => {
    assert.equal(route.request().method(), 'POST');
    if (route.request().url().endsWith('/poll')) {
      const index = polls++;
      await gates[index];
      return route.fulfill({ json: [{ state: 'waiting', qrDataUrl }, { state: 'scanned' }, { state: 'expired' }, { state: 'success' }][index] });
    }
    starts++;
    return route.fulfill({ json: starts === 1 ? { state: 'starting' } : starts === 2 ? { state: 'failed', message: '请先启用网关监听' } : starts === 4 ? { state: 'idle' } : { state: 'waiting', qrDataUrl } });
  });
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#channels');
  const button = page.locator('#channel-feishu-web').getByRole('button', { name: '扫码登录' });
  const drawer = page.getByRole('dialog', { name: '网页版网关扫码登录' });
  await expect(button).toBeVisible();
  assert.equal(starts, 0);
  await button.click();
  await expect(drawer).toContainText('正在准备二维码');
  advance[0]();
  await expect(drawer.getByRole('img')).toHaveAttribute('src', qrDataUrl);
  advance[1]();
  await expect(drawer).toContainText('已扫码，请在飞书确认登录');
  advance[2]();
  await expect(drawer).toContainText('二维码已失效');
  await expect(drawer.getByRole('img')).toHaveCount(0);
  await drawer.getByRole('button', { name: '重新发起登录' }).click();
  await expect(drawer).toContainText('网关登录失败');
  await expect(drawer).toContainText('请先启用网关监听');
  await drawer.getByRole('button', { name: '重新发起登录' }).click();
  await expect(drawer).toContainText('网关登录成功');
  await page.keyboard.press('Escape');
  await button.click();
  await expect(drawer).toContainText('当前没有进行中的登录');
  await drawer.getByRole('button', { name: '重新发起登录' }).click();
  await expect(drawer.getByRole('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1800);
  assert.equal(starts, 5);
  assert.equal(polls, 4);
});

test('渠道页按可见性同步网关，扫码成功后限次加快刷新', { timeout: 40000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-web-follow-ui-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, demo: true, dataDir });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  let reads = 0, connected = false, success = false;
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  let lastReceivedAt = '2026-01-01T00:00:00Z';
  await page.route('**/api/v1/feishu/web', route => route.fulfill({ json: { enabled: true, connected, lastReceivedAt, error: '读取序号 ' + ++reads } }));
  await page.route('**/api/v1/feishu/web/login', route => route.fulfill({ json: { state: success ? 'success' : 'waiting' } }));
  await page.goto(server.url + '/#channels');
  const card = page.locator('#channel-feishu-web');
  const login = card.getByRole('button', { name: '扫码登录' });
  const drawer = page.getByRole('dialog', { name: '网页版网关扫码登录' });
  await expect(card).toContainText('未连接');

  async function expectRead(count: number) {
    await expect(card).toContainText('读取序号 ' + count);
  }
  async function startConfirmed() {
    const count = reads;
    await login.click();
    await expect(drawer).toContainText('网关登录成功');
    await page.keyboard.press('Escape');
    await expectRead(count + 1);
  }
  async function tickRead(ms: number) {
    const count = reads;
    await page.clock.fastForward(ms);
    await expectRead(count + 1);
  }
  connected = true;
  await tickRead(15000);
  await expect(card).toContainText('已连接');
  lastReceivedAt = '2026-01-02T00:00:00Z';
  await tickRead(15000);
  await expect(card.locator('time')).toHaveAttribute('datetime', lastReceivedAt);
  connected = false;
  await tickRead(15000);
  await login.click();
  await expect(drawer).toContainText('请用飞书扫描二维码');
  await page.keyboard.press('Escape');
  await expect(card).toContainText('未连接');
  success = true;
  await startConfirmed();
  for (let i = 1; i <= 3; i++) {
    connected = i === 3;
    await tickRead(5000);
  }
  await expect(card).toContainText('已连接');
  connected = false;
  await startConfirmed();
  for (let i = 0; i < 6; i++) await tickRead(5000);
  let stable = reads;
  await page.clock.fastForward(5000);
  assert.equal(reads, stable);
  await tickRead(10000);
  async function setHidden(hidden: boolean) {
    await page.evaluate(value => {
      Object.defineProperty(document, 'hidden', { configurable: true, value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  }
  // Delay delivery after fetch has resolved, when abort alone cannot discard the result.
  const held = await page.evaluateHandle(() => {
    const original = window.fetch;
    let ready!: () => void, release!: () => void;
    const captured = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).endsWith('/feishu/web')) {
        window.fetch = original;
        const data = await response.json();
        ready();
        await gate;
        return Response.json(data);
      }
      return response;
    };
    return { captured, release };
  });
  await page.clock.fastForward(15000);
  await held.evaluate(state => state.captured);
  await setHidden(true);
  stable = reads;
  await page.clock.fastForward(60000);
  assert.equal(reads, stable);
  await setHidden(false);
  await expectRead(stable + 1);
  await held.evaluate(state => state.release());
  await expectRead(stable + 1);
  await page.evaluate(() => { location.hash = '#home'; });
  await expect(card).toBeHidden();
  stable = reads;
  await page.clock.fastForward(60000);
  assert.equal(reads, stable);
});
