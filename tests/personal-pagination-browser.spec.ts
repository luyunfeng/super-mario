import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Page, type Browser } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

const watermark = '2026-11-17T08:25:00Z';
const boundary = '首次读取最近24小时；后续从已完成水位重叠5分钟读取。分页未完成时保持原窗口；上下文每会话最多50条。不保证永久历史或任意旧编辑的全量同步。';
const connected = { status: 'connected', enabled: true, account: { name: '替身账号' }, collectionBoundary: boundary };
const dialog = (page: Page) => page.getByRole('dialog', { name: '个人消息采集', exact: true });
const evidence = (page: Page) => dialog(page).getByLabel('采集完整性');

// 生产组件和纸色 CSS 在真实 Chromium 中运行；仅替换 API，不接入外部账号。
async function fixture(body: (page: Page) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-personal-pagination-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, demo: true });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/js/main.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.goto(`${server.url}/#channels`);
    await page.clock.install();
    await page.evaluate(async () => {
      const modulePath = '/js/features/personal-messages.js';
      const { createPersonalMessagesUI } = await import(modulePath);
      const requests: any[] = [];
      const api: any = {};
      for (const method of ['get', 'post', 'put']) api[method] = (path: string, payload: unknown) => new Promise((resolve, reject) => {
        requests.push({ method, path, payload, resolve, reject, settled: false });
      });
      const store = { refresh() {} };
      const router = { current: { page: 'channels' }, href: (page: string) => `#${page}` };
      const ui = createPersonalMessagesUI({ api, store, router, onConnectApplication() { throw new Error('unexpected application authorization'); } });
      const host = document.createElement('main'); host.className = 'page__inner'; host.append(ui.el);
      document.body.replaceChildren(host);
      (window as any).personalTest = { requests, ui };
    });
    await page.locator('#channel-collect').getByRole('button').filter({ hasText: '授权飞书账号' }).click();
    await body(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await server.close(); await rm(dataDir, { recursive: true, force: true });
  }
}
async function reply(page: Page, method: string, value: unknown, error = false) {
  await expect.poll(() => page.evaluate(method => (window as any).personalTest.requests.some((r: any) => r.method === method && !r.settled), method)).toBe(true);
  await page.evaluate(({ method, value, error }) => {
    const r = (window as any).personalTest.requests.find((r: any) => r.method === method && !r.settled);
    r.settled = true;
    if (error) r.reject(new Error(String(value))); else r.resolve(value);
  }, { method, value, error });
}
async function refresh(page: Page) {
  await page.evaluate(() => { void (window as any).personalTest.ui.refresh().catch(() => {}); });
}
async function writes(page: Page) {
  return page.evaluate(() => (window as any).personalTest.requests.filter((r: any) => r.method !== 'get').map((r: any) => ({ method: r.method, path: r.path, payload: r.payload })));
}
async function noOverflow(page: Page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const locator of [dialog(page), dialog(page).locator('.drawer__body'), evidence(page), page.locator('#channel-collect')]) {
    assert.ok(await locator.evaluate(el => el.scrollWidth <= el.clientWidth), '390px 长说明不应水平溢出');
  }
}

test('分页未完成 → 完成水位 → 停止：保留历史证据，采集操作全程互斥', { timeout: 30000 }, async () => fixture(async page => {
  await reply(page, 'get', { ...connected, hasMore: true, collectionPages: 3 });
  await expect(evidence(page)).toContainText('未提供完整性证据');
  await expect(evidence(page)).toContainText('仍有后续页，尚未完整读取');
  await expect(evidence(page)).toContainText('3 页（检查点累计）');
  await expect(evidence(page)).toContainText(boundary);
  await noOverflow(page);
  await dialog(page).getByRole('button', { name: '采集一次', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: '停止采集', exact: true })).toBeDisabled();
  await expect(dialog(page).getByRole('button', { name: '采集一次', exact: true })).toBeDisabled();
  await reply(page, 'post', { collected: 2 });
  await expect(dialog(page).getByRole('button', { name: '停止采集', exact: true })).toBeDisabled();
  await reply(page, 'get', { ...connected, hasMore: false, collectionPages: 6, lastCompletedThrough: watermark });
  await expect(evidence(page).locator('time')).toHaveAttribute('datetime', watermark);
  await expect(evidence(page)).toContainText('当前没有待续页');
  await expect(evidence(page)).toContainText('6 页（检查点累计）');
  await dialog(page).getByRole('button', { name: '停止采集', exact: true }).click();
  await reply(page, 'put', { ...connected, enabled: false, hasMore: true, collectionPages: 7, lastCompletedThrough: watermark });
  await expect(dialog(page)).toContainText('已停止采集（账号已授权）');
  await expect(evidence(page)).toContainText('保留以上历史完成水位');
  await expect(evidence(page)).toContainText('后续页尚未继续读取');
  await expect(evidence(page).locator('time')).toHaveAttribute('datetime', watermark);
  await expect(page.locator('#channel-collect').getByLabel('采集完整性').locator('time')).toHaveAttribute('datetime', watermark);
  await noOverflow(page);
  assert.deepEqual(await writes(page), [
    { method: 'post', path: '/feishu/personal/collect', payload: undefined },
    { method: 'put', path: '/feishu/personal', payload: { enabled: false } },
  ]);
}));

test('旧 provider 无水位不宣称全量完成；边界隐藏内部信息，长文本安全换行', { timeout: 30000 }, async () => fixture(async page => {
  await reply(page, 'get', { ...connected, collectionBoundary: undefined, lastCollectedAt: watermark, collected: 8 });
  await expect(dialog(page)).toContainText('读取并提交 8 条消息记录');
  await expect(evidence(page)).toContainText('未提供完整性证据');
  await expect(evidence(page)).toContainText('未提供分页状态');
  await expect(evidence(page)).toContainText('未提供页数');
  await expect(evidence(page)).toContainText('未提供采集边界');
  await expect(evidence(page).locator('time')).toHaveCount(0);
  await expect(evidence(page)).not.toContainText('全量完成');
  for (const collectionBoundary of ['profile=private-account', 'page_token=private-cursor']) {
    await refresh(page);
    await reply(page, 'get', { ...connected, hasMore: false, collectionPages: 0, collectionBoundary });
    await expect(evidence(page)).toContainText('未提供完整性证据');
    await expect(evidence(page)).toContainText('0 页（检查点累计）');
    await expect(evidence(page)).toContainText('已隐藏');
    assert.ok(!(await page.locator('body').innerText()).includes(collectionBoundary));
  }
  await refresh(page);
  await reply(page, 'get', { ...connected, collectionBoundary: boundary.repeat(6) + 'BoundaryExplanation'.repeat(30) });
  await expect(evidence(page)).toContainText('BoundaryExplanation');
  await noOverflow(page);
  await dialog(page).getByRole('button', { name: '采集一次', exact: true }).click();
  await reply(page, 'post', '替身采集失败', true);
  await reply(page, 'get', { ...connected, enabled: false });
  await expect(dialog(page).getByRole('alert')).toContainText('替身采集失败');
  await expect(dialog(page).getByRole('button', { name: '开启采集', exact: true })).toBeEnabled();
  await expect(evidence(page)).toContainText('未提供完整性证据');
}));

test('停止操作隔离迟到读取及错误，较新读取优先', { timeout: 30000 }, async () => fixture(async page => {
  await reply(page, 'get', { ...connected, hasMore: true, collectionPages: 2, lastCompletedThrough: watermark });
  await refresh(page); // 保持 GET 未返回，随后执行停止。
  await dialog(page).getByRole('button', { name: '停止采集', exact: true }).click();
  await refresh(page); // 操作锁期间不发起新 GET。
  await reply(page, 'put', { ...connected, enabled: false, hasMore: true, collectionPages: 2, lastCompletedThrough: watermark });
  await reply(page, 'get', { ...connected, collectionPages: 99 });
  await expect(dialog(page)).toContainText('已停止采集（账号已授权）');
  await expect(evidence(page)).toContainText('2 页（检查点累计）');
  await expect(evidence(page).locator('time')).toHaveAttribute('datetime', watermark);
  await refresh(page);
  await dialog(page).getByRole('button', { name: '开启采集', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: '更换账号 / 重新授权' })).toBeDisabled();
  await reply(page, 'put', { ...connected, hasMore: true, collectionPages: 4, lastCompletedThrough: watermark });
  await reply(page, 'get', '过期读取错误', true);
  await expect(dialog(page).getByRole('button', { name: '停止采集', exact: true })).toBeEnabled();
  await expect(dialog(page)).not.toContainText('过期读取错误');
  await refresh(page);
  await refresh(page);
  // 按请求的相反顺序返回，旧响应不能覆盖较新的证据。
  await page.evaluate(state => {
    const pending = (window as any).personalTest.requests.filter((r: any) => r.method === 'get' && !r.settled);
    pending[1].settled = true; pending[1].resolve(state);
  }, { ...connected, hasMore: false, collectionPages: 8, lastCompletedThrough: watermark });
  await expect(evidence(page)).toContainText('8 页（检查点累计）');
  await reply(page, 'get', { ...connected, hasMore: true, collectionPages: 1 });
  await expect(evidence(page)).toContainText('8 页（检查点累计）');
  assert.deepEqual(await writes(page), [
    { method: 'put', path: '/feishu/personal', payload: { enabled: false } },
    { method: 'put', path: '/feishu/personal', payload: { enabled: true } },
  ]);
}));

test('扫码授权与采集开关分离：初始禁用、取消互斥、过期后重授，授权成功不自动开启', { timeout: 30000 }, async () => fixture(async page => {
  const authorize = () => dialog(page).getByRole('button', { name: '授权飞书账号', exact: true });
  await expect(authorize()).toBeDisabled();
  await reply(page, 'get', { status: 'disconnected', enabled: false });
  await authorize().click();
  await expect(authorize()).toBeDisabled();
  const url = 'https://accounts.feishu.cn/oauth/v1/device/verify?test=offline';
  const qrDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  await reply(page, 'post', { status: 'waiting_for_scan', enabled: false, url, qrDataUrl });
  await expect(dialog(page).getByRole('img', { name: '用飞书扫码授权个人消息读取' })).toBeVisible();
  await expect(dialog(page).getByRole('link', { name: '在浏览器中打开飞书授权页' })).toHaveAttribute('href', url);
  await dialog(page).getByRole('button', { name: '取消授权', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: '取消授权', exact: true })).toBeDisabled();
  await reply(page, 'post', { status: 'cancelled', enabled: false });
  await dialog(page).getByRole('button', { name: '重新授权', exact: true }).click();
  await reply(page, 'post', { status: 'expired', enabled: false });
  await expect(dialog(page)).toContainText('二维码已过期');
  await dialog(page).getByRole('button', { name: '重新授权', exact: true }).click();
  await reply(page, 'post', { ...connected, enabled: false });
  await expect(dialog(page).getByRole('button', { name: '开启采集', exact: true })).toBeEnabled();
  await expect(dialog(page).getByRole('button', { name: '采集一次', exact: true })).toHaveCount(0);
  assert.ok((await writes(page)).every((r: { method: string }) => r.method === 'post'), '授权流程不得开启采集');
  await dialog(page).getByRole('button', { name: '开启采集', exact: true }).click();
  await reply(page, 'put', { ...connected, hasMore: true, collectionPages: 0 });
  await expect(dialog(page).getByRole('button', { name: '停止采集', exact: true })).toBeEnabled();
  assert.equal((await writes(page)).length, 5);
}));

test('私聊进度与群补读分开显示；零消息说明范围，不冒充完整采集',()=>fixture(async page=>{
 const direct='2026-11-20T00:20:00Z';
 await reply(page,'get',{...connected,collecting:true,privateCompletedThrough:direct,hasMore:true,collectionPages:3,lastCompletedThrough:watermark,lastCollectedAt:direct,collected:0});
 await expect(dialog(page)).toContainText('正在读取一批消息');
 await expect(evidence(page)).toContainText('私聊最近读到');
 await expect(dialog(page)).toContainText('本批没有可入箱消息；其余读取仍在继续');
 await expect(evidence(page).locator(`time[datetime="${watermark}"]`)).toBeVisible();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(await writes(page),[]);
}));
