import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Page, type Route } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

const recovery = (extra = {}) => ({ machineId: 'a', agentInstanceId: 'agent-new', host: { identity: { state: 'unknown', reason: 'raw-secret' }, atomicControl: { state: 'unsupported' } }, sessions: [{ sessionId: 'one', paneId: 'pane-one', origin: 'current-agent', canObserve: true, canControl: true, ...extra }] });
async function fixture(body: (ctx: { page: Page; json: (r: Route, d: any, status?: number) => Promise<void>; writes: any[]; sockets: string[]; disconnect: () => void }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-recovery-ui-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const json = (r: Route, d: any, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(5000);
    const errors: string[] = [], writes: any[] = [], sockets: string[] = [];
    let disconnect = () => {};
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/js/main.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/api/v1/**', r => {
      if (r.request().method() !== 'GET') writes.push(r.request().postDataJSON());
      const url = new URL(r.request().url());
      return json(r, url.pathname.endsWith('/state') ? { machines: [{ id: 'a', capabilities: ['executor.recovery'] }] } : url.pathname.endsWith('/sessions') ? [{ sessionId: 'one', paneId: 'pane-one' }, { sessionId: 'two', paneId: 'pane-two' }] : url.pathname.endsWith('/recovery') ? recovery() : {});
    });
    await page.routeWebSocket('**/api/v1/terminal*', ws => {
      sockets.push(ws.url()); disconnect = () => ws.close();
      ws.send(JSON.stringify({ epoch: 'test', seq: 0, full: true, data: Buffer.from('当前会话画面').toString('base64'), width: 80, height: 24 }));
    });
    await page.goto(server.url);
    await page.evaluate(async () => {
      const p = '/js/legacy/terminal.js', a = '/js/lib/api.js';
      const { createConsole } = await import(p); const { createApi } = await import(a); const api = createApi();
      // Chromium runs the real drawer; only xterm painting and remote services are substitutes.
      (globalThis as any).Terminal = class { el: any; open(el: any) { this.el = el; } reset() { this.el.textContent = ''; } resize() {} write(bytes: any, done: any) { this.el.textContent += new TextDecoder().decode(bytes); done(); } dispose() {} };
      const consoleDrawer = createConsole({ api, getToken: () => api.token() });
      (window as any).recoveryTest = { api, consoleDrawer, open: (extra = {}) => consoleDrawer.open({ machineId: 'a', sessionId: 'one', status: 'running', executionMode: 'interactive', title: '测试会话', output: '旧 run 历史输出', ...extra }) };
    });
    await body({ page, json, writes, sockets, disconnect: () => disconnect() }); assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
}
const open = (page: Page, extra = {}) => page.evaluate(extra => { void (window as any).recoveryTest.open(extra); }, extra);

test('restored 禁止旧 pane WS、重试和写入；保留历史与 CLI 入口，390px', { timeout: 30000 }, async () => fixture(async ({ page, json, writes, sockets }) => {
  await page.route('**/recovery?*', r => json(r, recovery({ origin: 'restored', canObserve: false, canControl: false, reason: 'raw-secret-token' })));
  await open(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('代理重启前的旧绑定');
  await expect(dialog).toContainText('旧 run 历史输出');
  await expect(dialog).not.toContainText('raw-secret');
  await expect(dialog.getByRole('button', { name: '接管输入' })).toBeHidden();
  await expect(dialog.getByRole('button', { name: '中断会话' })).toBeHidden();
  await expect(dialog.getByRole('button', { name: '重新同步画面' })).toBeDisabled();
  await expect(dialog.getByRole('link')).toHaveAttribute('href', '#agent');
  await page.locator('.console-controls').evaluate(el => el.dispatchEvent(new Event('submit', { cancelable: true })));
  await page.waitForTimeout(2150); // Prove the old automatic reconnect deadline never starts a socket.
  assert.deepEqual(sockets, []); assert.deepEqual(writes, []);
  assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
  await dialog.getByRole('link').click(); await expect(dialog).not.toBeVisible(); assert.deepEqual(writes, []);
}));

test('当前会话保留观察、先接管再输入及重新同步；只读不写命令', { timeout: 30000 }, async () => fixture(async ({ page, writes, sockets, disconnect }) => {
  await open(page); const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('当前会话画面');
  await expect(dialog).toContainText('终端实例未知');
  await expect(dialog.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  assert.deepEqual(writes, []);
  disconnect();
  await expect.poll(() => sockets.length).toBe(2);
  await expect(dialog).toContainText('当前会话画面');
  await dialog.getByRole('button', { name: '重新同步画面' }).click();
  await expect.poll(() => sockets.length).toBe(3);
  await expect(dialog.getByRole('button', { name: '接管输入' })).toBeEnabled();
  await dialog.getByRole('button', { name: '接管输入' }).click();
  await dialog.getByRole('textbox').fill('补充要求');
  await dialog.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  assert.deepEqual(writes, [{ method: 'executor.input', params: { sessionId: 'one', text: '补充要求' } }]);
  await page.evaluate(() => (window as any).recoveryTest.api.setToken('changed-after-reconnect'));
  await expect(dialog).not.toBeVisible(); assert.equal(writes.length, 1);
}));

test('旧代理明确回退，失败不假确认；切 Run、关闭与 token 隔离迟到恢复响应', { timeout: 30000 }, async () => fixture(async ({ page, json, sockets, writes }) => {
  await page.route('**/recovery?*', r => json(r, { error: 'unsupported' }, 404));
  await open(page);
  await expect(page.getByRole('dialog')).toContainText('当前会话画面');
  await expect(page.getByRole('dialog')).toContainText('旧代理未报告新恢复状态');
  await page.getByRole('button', { name: '关闭观察' }).click();
  await page.route('**/recovery?*', r => json(r, { error: 'raw-secret' }, 502));
  await open(page);
  await expect(page.getByRole('dialog')).toContainText('尚未确认');
  assert.equal(sockets.length, 1);
  await page.route('**/recovery?*', r => json(r, recovery({ canObserve: undefined, canControl: undefined })));
  await open(page); await expect(page.getByRole('dialog')).toContainText('未报告此会话的观察权限');
  assert.equal(sockets.length, 1);
  for (const change of ['run', 'close', 'token']) {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let started = false;
    await page.route('**/recovery?*', async r => { started = true; await gate; await json(r, recovery()); });
    await open(page); await expect.poll(() => started).toBe(true);
    if (change === 'close') await page.getByRole('button', { name: '关闭观察' }).click();
    if (change === 'run') {
      await page.route('**/recovery?sessionId=two', r => json(r, recovery({ sessionId: 'two', paneId: 'pane-two', origin: 'restored', canObserve: false, canControl: false })));
      await open(page, { sessionId: 'two', title: '新 Run' }); await expect(page.getByRole('dialog')).toContainText('旧绑定');
    }
    if (change === 'token') await page.evaluate(() => (window as any).recoveryTest.api.setToken('second-test-token'));
    release();
    if (change === 'run') await expect(page.getByRole('dialog')).toContainText('新 Run');
    else await expect(page.getByRole('dialog')).not.toBeVisible();
    assert.equal(sockets.length, 1);
  }
  assert.deepEqual(writes, []);
}));
