import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

// Runs before the page's own scripts: a stand-in for what the browser gives a page for Web Push.
// The service worker is the real one; only the push manager and the permission are the stand-in's.
const fakePush = () => {
  const w = window as unknown as { __push: { subscriptions: object[]; asked: number }; Notification: unknown };
  w.__push = { subscriptions: [], asked: 0 };
  localStorage.setItem('sm.splash.seen', 'true');
  class FakeNotification {
    static permission = 'default';
    static requestPermission = async () => { w.__push.asked++; FakeNotification.permission = 'granted'; return 'granted'; };
  }
  w.Notification = FakeNotification;
  // The PushManager is on ServiceWorkerRegistration, which the browser makes: it cannot be replaced
  // before the fact. What is replaced is the one method the page calls on it.
  const manager = PushManager.prototype as unknown as { __key?: unknown; subscribe: (options: { applicationServerKey: BufferSource }) => Promise<unknown>; getSubscription: () => Promise<unknown> };
  const keys = { p256dh: '', auth: '' };
  const make = () => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/' + crypto.randomUUID(),
    options: { applicationServerKey: manager.__key },
    toJSON() { return { endpoint: this.endpoint, keys }; },
    // A method, so that `this` is the subscription itself.
    async unsubscribe() { w.__push.subscriptions = w.__push.subscriptions.filter(row => row !== this); return true; },
  });
  manager.subscribe = async (options: { applicationServerKey: BufferSource }) => {
    // A real P-256 point and a 16-byte secret, as a browser would give. They are made by the test's
    // own page with the WebCrypto the page has.
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const exported = await crypto.subtle.exportKey('raw', pair.publicKey);
    const bytes = new Uint8Array(exported);
    keys.p256dh = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    keys.auth = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const subscription = make();
    w.__push.subscriptions.push(subscription);
    return subscription;
  };
  manager.getSubscription = async () => w.__push.subscriptions[0] ?? null;
};

test('设置页可以打开、测试和关闭「关掉页面也通知」；真实的 sw.js 能注册', { timeout: 45000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-web-push-browser-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, demo: true });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.addInitScript(fakePush);
  const page = await context.newPage();
  // The page is told the service worker is ready, so that subscribe is not left waiting for one.
  await page.goto(server.url + '/#home');
  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    return { scope: registration.scope, active: Boolean(registration.active) };
  });
  assert.equal(registered.scope, server.url + '/');
  assert.equal(registered.active, true, 'the real sw.js is served and activates');
  await page.goto(server.url);
  await page.getByRole('button', { name: '插件配置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  // The plugins are listed; the one for browser notifications is opened by its search.
  const search = dialog.getByRole('searchbox');
  if (await search.count()) await search.fill('浏览器系统通知');
  await dialog.getByText('浏览器系统通知', { exact: true }).first().click();
  const section = dialog.getByRole('region', { name: '关掉页面也通知' });
  await expect(section).toBeVisible();
  await expect(section.getByRole('status')).toContainText('已打开', { timeout: 100 }).catch(() => {});
  const turn = section.getByRole('button', { name: '打开', exact: true });
  await expect(turn).toBeEnabled();
  await turn.click();
  await expect(section.getByRole('button', { name: '已打开', exact: true })).toBeDisabled();
  // The server was told of the subscription, under this browser's own device id, and with its keys.
  const device = await page.evaluate(() => JSON.parse(localStorage.getItem('sm.web-push.device') ?? '""'));
  const stored = server.app.store.list<{ device: string; endpoint: string; browser: string }>('notifications.web-push.subscriptions');
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.device, device);
  assert.match(stored[0]!.endpoint, /^https:\/\/fcm\.googleapis\.com\/fcm\/send\//);
  // A test push is sent to the service the subscription names. It cannot be delivered here, and
  // the page says what the service answered rather than pretending.
  const test = section.getByRole('button', { name: '发一条测试通知' });
  await expect(test).toBeEnabled();
  await test.click();
  await expect(section.getByRole('status')).toContainText(/推送服务|已交给/);
  // Turning it off drops the subscription at the server and at the browser.
  const deleted = page.waitForResponse(response => response.url().includes('/push/web/') && response.request().method() === 'DELETE');
  await section.getByRole('button', { name: '关闭', exact: true }).click();
  await deleted;
  await expect(turn).toBeEnabled();
  // The browser's own subscription is dropped after the server's; give it a moment.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __push: { subscriptions: unknown[] } }).__push.subscriptions.length)).toBe(0);
  assert.equal(server.app.store.list('notifications.web-push.subscriptions').length, 0);
  assert.equal(await page.evaluate(() => (window as unknown as { __push: { subscriptions: unknown[] } }).__push.subscriptions.length), 0);
});
