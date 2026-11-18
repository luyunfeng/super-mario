import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Page, type Route } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

const evidence = (extra = {}) => ({ executorId: 'codex', checkedAt: '2026-11-17T00:00:00Z', executable: { state: 'available', source: 'path' }, launcher: { state: 'available' }, version: { state: 'known', value: '1.2.3' }, authentication: { state: 'unknown', scope: 'local-default' }, errors: [], notes: ['SECRET-account-token'], ...extra });
async function fixture(body: (page: Page, json: (r: Route, data: any, status?: number) => Promise<void>, calls: any[]) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-diagnostics-ui-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const json = (r: Route, data: any, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(5000);
    const errors: string[] = [], calls: any[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/js/main.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/api/v1/**', r => { calls.push({ path: new URL(r.request().url()).pathname, method: r.request().method(), body: r.request().postDataJSON() }); return json(r, r.request().url().endsWith('/call') || r.request().url().endsWith('/sessions') ? [] : { machineId: 'a', host: { identity: { state: 'unknown' }, atomicControl: { state: 'unsupported' } }, sessions: [] }); });
    await page.goto(server.url);
    await page.evaluate(async () => {
      const p = '/js/features/computers.js', a = '/js/lib/api.js';
      const { openComputer } = await import(p); const { createApi } = await import(a);
      const api = createApi();
      (window as any).diag = { api, open: (extra = {}) => openComputer({ api, machine: { id: 'a', name: '测试电脑', online: true, capabilities: ['executor.diagnostics', 'executor.recovery'], ...extra }, state: () => ({ runs: [] }), consoleDrawer: {} }) };
      (window as any).diag.open();
    });
    await body(page, json, calls); assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
}

test('只有显式点击执行诊断；390px 展示证据、不显示 raw notes、不溢出', { timeout: 30000 }, async () => fixture(async (page, json, calls) => {
  const requests: any[] = [];
  await page.route('**/diagnostics', r => { requests.push(r.request().postDataJSON()); return json(r, evidence({ authentication: { state: 'authenticated' } })); });
  await expect(page.getByRole('dialog')).toContainText('终端实例未知');
  assert.equal(requests.length, 0);
  await page.getByRole('button', { name: '检查安装与登录' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('已认证（本地检查）');
  await expect(page.getByRole('dialog')).toContainText('不证明模型调用成功');
  await expect(page.getByRole('dialog')).toContainText('1.2.3');
  await expect(page.getByRole('dialog')).not.toContainText('SECRET');
  assert.deepEqual(requests, [{ executorId: 'codex' }]);
  assert.equal(calls.some(c => c.body?.method?.includes('status')), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.getByRole('dialog').evaluate(el => el.scrollWidth > el.clientWidth), false);
}));

test('认证 unknown/timeout 不假成功，关闭、切电脑和令牌变化隔离迟到响应', { timeout: 30000 }, async () => fixture(async (page, json) => {
  await page.route('**/diagnostics', r => json(r, evidence({ errors: [{ stage: 'authentication', code: 'timeout', stderr: 'SECRET' }] })));
  await page.getByRole('button', { name: '检查安装与登录' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('检查超时，状态未知');
  await expect(page.getByRole('dialog')).not.toContainText('已认证');
  for (const change of ['close', 'machine', 'token']) {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let started = false;
    await page.route('**/diagnostics', async r => { started = true; await gate; await json(r, evidence({ authentication: { state: 'authenticated' } })); });
    await page.getByRole('button', { name: '检查安装与登录' }).first().click();
    await expect.poll(() => started).toBe(true);
    if (change === 'close') await page.getByRole('button', { name: '关闭', exact: true }).click();
    if (change === 'machine') await page.evaluate(() => (window as any).diag.open({ id: 'b', name: '新电脑' }));
    if (change === 'token') await page.evaluate(() => (window as any).diag.api.setToken('different-test-token'));
    release();
    await expect(page.locator('body')).not.toContainText('已认证');
    if (change !== 'token') await page.evaluate(() => (window as any).diag.open());
    else await expect(page.getByRole('dialog')).toHaveCount(0);
  }
}));

test('旧代理诊断禁用，API 不支持或超时只报告未知，不显示服务端任意文本', { timeout: 30000 }, async () => fixture(async (page, json, calls) => {
  await page.evaluate(() => (window as any).diag.open({ capabilities: [] }));
  await expect(page.getByRole('button', { name: '检查安装与登录' }).first()).toBeDisabled();
  await expect(page.getByRole('dialog')).toContainText('请升级执行机代理');
  assert.equal(calls.filter(c => c.path.endsWith('/diagnostics')).length, 0);
  await page.evaluate(() => (window as any).diag.open());
  await page.route('**/diagnostics', r => json(r, { error: 'SECRET-stderr-token' }, 404));
  await page.getByRole('button', { name: '检查安装与登录' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('代理缺少诊断支持');
  await page.route('**/diagnostics', r => json(r, { error: 'SECRET-stderr-token' }, 504));
  await page.getByRole('button', { name: '检查安装与登录' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('本地凭证状态未知');
  await expect(page.getByRole('dialog')).not.toContainText('SECRET');
}));
