import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import { createPersonalProvider } from '../plugins/feishu-personal.ts';
import { PERSONAL_MESSAGE_SCOPES, PersonalAuthError } from '../plugins/feishu-personal.ts';

test('个人消息：点击授权→显示二维码→确认后自动连接→开启采集→持久收件箱→停止', { timeout: 40000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-personal-browser-'));
  let grant!: () => void; const confirmation = new Promise<void>(resolve => { grant = resolve; });
  let reads = 0;
  const provider = createPersonalProvider({ application: () => undefined, runCLI: async args => {
    if (args.includes('show')) return { profile: 'private-profile', appId: 'cli_0123456789abcdef' };
    if (args.includes('--no-wait')) return { verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?test=opaque%2B123', device_code: 'private-device-code', expires_in: 60 };
    if (args.includes('--device-code')) { await confirmation; return { ok: true }; }
    if (args.includes('status')) return { appId: 'cli_0123456789abcdef', identity: 'user', verified: true, identities: { user: { available: true, openId: 'ou_offline', userName: '离线测试账号', scope: PERSONAL_MESSAGE_SCOPES.join(' ') } } };
    if (args.includes('im')) {
      reads++;
      return { ok: true, identity: 'user', data: { has_more: false, messages: [{ message_id: 'om_offline', chat_id: 'oc_offline', content: '请处理测试事项', create_time: String(Date.now()), sender: { id: 'ou_sender', name: '测试发送人' } }] } };
    }
    throw new Error('unexpected command');
  } });
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, demo: true, token: 'offline-test-token' }, { personalProvider: provider });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const payloads: string[] = [];
    page.on('response', async response => { if (response.url().includes('/feishu/personal')) payloads.push(await response.text()); });
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    await page.goto(`${server.url}/#channels?token=offline-test-token`);
    await page.locator('#channel-collect').getByRole('button', { name: '授权飞书账号' }).click();
    const drawer = page.getByRole('dialog', { name: '个人消息采集', exact: true });
    await expect(drawer.locator('input, pre')).toHaveCount(0);
    await drawer.getByRole('button', { name: '授权飞书账号', exact: true }).click();
    await expect(drawer.getByRole('img', { name: '用飞书扫码授权个人消息读取' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: '在浏览器中打开飞书授权页' })).toHaveAttribute('href', 'https://accounts.feishu.cn/oauth/v1/device/verify?test=opaque%2B123');
    assert.equal(reads, 0);
    grant();
    await expect(drawer).toContainText('飞书账号：离线测试账号');
    assert.equal(reads, 0);
    await drawer.getByRole('button', { name: '开启采集', exact: true }).click();
    await expect(drawer.getByRole('button', { name: '停止采集' })).toBeVisible();
    await expect.poll(() => server.app.inbox.list().length).toBe(1);
    assert.ok(reads >= 2);
    await drawer.getByRole('button', { name: '停止采集' }).click();
    await expect(drawer.getByRole('button', { name: '开启采集', exact: true })).toBeVisible();
    assert.equal(server.personal.status().enabled, false);
    assert.ok(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth));
    assert.deepEqual(errors, []);
    for (const payload of payloads) for (const secret of ['private-profile', 'private-device-code']) assert.ok(!payload.includes(secret));
    const unauthorized = await fetch(`${server.url}/api/v1/feishu/personal`); assert.equal(unauthorized.status, 401);
  } finally { grant(); await browser.close(); await server.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('应用权限不足给出当前应用的处理入口，可以直接重新授权', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-personal-permissions-'));
  const provider = createPersonalProvider({ application: () => undefined, runCLI: async args => {
    if (args.includes('show')) return { profile: 'private-profile', appId: 'cli_0123456789abcdef' };
    throw new PersonalAuthError('permissions');
  } });
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, demo: true }, { personalProvider: provider });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage(); await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    await page.goto(`${server.url}/#channels`);
    await page.locator('#channel-collect').getByRole('button', { name: '授权飞书账号' }).click();
    const drawer = page.getByRole('dialog', { name: '个人消息采集', exact: true });
    await drawer.getByRole('button', { name: '授权飞书账号', exact: true }).click();
    await expect(drawer.getByRole('link', { name: /打开此应用的飞书权限设置/ })).toHaveAttribute('href', 'https://open.feishu.cn/app/cli_0123456789abcdef/auth');
    await expect(drawer.getByRole('button', { name: '重新授权' })).toBeVisible();
    await expect(drawer.locator('input, pre')).toHaveCount(0);
    assert.equal(server.personal.status().enabled, false);
  } finally { await browser.close(); await server.close(); await rm(dataDir, { recursive: true, force: true }); }
});
