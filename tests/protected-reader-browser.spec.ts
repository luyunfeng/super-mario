import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';

const missing = { enabled: false, trustedHosts: [] as string[], revision: 1, connection: 'missing', authorization: 'unchecked' };
const curator = { settings: { enabled: false, machineId: 'offline', provider: 'claude-code' }, worker: { state: 'disabled' }, jobs: [{ id: 'failed-source', url: 'https://test.feishu.cn/docx/test', status: 'failed', error: 'UNAUTHORIZED：来源权限不足', createdAt: new Date().toISOString() }] };
type Reply = { status?: number; body: unknown };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };

async function fixture(t: TestContext, width = 1000) {
  const requests: { method: string; path: string; body: any; token?: string }[] = [];
  let reader: Record<string, any> = { ...missing };
  let handler: ((method: string, body: any) => Promise<Reply> | Reply) | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.startsWith('/api/v1/')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const method = req.method!; const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method, path: url.pathname, body, token: req.headers.authorization });
      let reply: Reply;
      if (url.pathname.endsWith('/source-reader')) {
        if (handler) reply = await handler(method, body);
        else { if (method === 'PUT') reader = { ...reader, ...body, profile: body.profile, revision: reader.revision + 1 }; reply = { body: reader }; }
      } else if (url.pathname.endsWith('/curator')) reply = { body: curator };
      else if (url.pathname.endsWith('/retry')) reply = { body: { ok: true } };
      else reply = { status: 500, body: { error: 'Unexpected API' } };
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(reply.body)); return;
    }
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/components.css">
        <body><script type="module">
        import { openCuratorDrawer } from '/js/features/curator.js';
        import { createApi } from '/js/lib/api.js';
        const listeners = new Set(); const api = createApi(); api.setToken('fixture-a');
        const store = { view: { connection: 'online', snapshot: { machines: [] } }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
        window.harness = { api, changed: 0, open() { return openCuratorDrawer({ api, store, onChanged: async () => { window.harness.changed++; } }); },
          emit(patch = {}) { Object.assign(store.view, patch); for (const fn of listeners) fn(store.view); }, listeners };
        window.harness.open();
        </script></body></html>`); return;
    }
    try {
      const path = resolve('apps/web', '.' + url.pathname);
      if (!path.startsWith(resolve('apps/web') + '/')) throw new Error('path');
      const content = await readFile(path);
      res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : 'text/css'); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  const address = server.address() as { port: number };
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: '受保护来源读取', exact: true }) });
  await expect(card.getByRole('button', { name: '保存来源读取设置' })).toBeEnabled();
  return { page, card, requests, setReader(value: Record<string, any>) { reader = value; }, setHandler(value?: typeof handler) { handler = value; } };
}
const emit = (page: Page, patch = {}) => page.evaluate(patch => (window as any).harness.emit(patch), patch);
const writes = <T extends { method: string }>(requests: T[]) => requests.filter(r => r.method !== 'GET');

test('无连接默认关闭，不假授权，渠道入口关闭抽屉且不触发登录', { timeout: 20000 }, async t => {
  const { page, card, requests } = await fixture(t);
  await expect(card.getByLabel('启用受保护来源读取')).not.toBeChecked();
  await expect(card).toContainText('缺少连接');
  await expect(card).toContainText('读取权限尚未检查');
  await expect(card).not.toContainText('已可读取');
  await expect(card.getByLabel('已有命令行连接名称')).not.toBeVisible();
  await card.getByRole('link', { name: '去渠道连接飞书账号' }).click();
  await expect(page).toHaveURL(/#channels$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.deepEqual(writes(requests), []);
});

test('高级保存只发送可写字段，刷新和整理重绘保留草稿及旧配置，防止重复提交', { timeout: 20000 }, async t => {
  const f = await fixture(t); const { page, card, requests } = f;
  f.setReader({ ...missing, profile: 'old-profile', trustedHosts: ['old.example.com'], connection: 'explicit-profile' });
  await emit(page); await card.getByText('高级设置', { exact: true }).click();
  await expect(card.getByLabel('已有命令行连接名称')).toHaveValue('old-profile');
  await card.getByLabel('已有命令行连接名称').fill('custom-reader');
  for (let n = 0; n < 3; n++) await emit(page);
  await expect(card.getByLabel('已有命令行连接名称')).toHaveValue('custom-reader');
  await card.getByLabel('额外精确受信域名').fill('docs.example.com files.example.com');
  await page.getByRole('button', { name: '保存整理设置', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).harness.changed)).toBe(1);
  await expect(card.getByLabel('已有命令行连接名称')).toHaveValue('custom-reader');
  const gate = deferred(); t.after(gate.release);
  f.setHandler(async (method, body) => { if (method === 'PUT') await gate.promise; return { body: { ...missing, ...body, connection: 'explicit-profile' } }; });
  const save = card.getByRole('button', { name: '保存来源读取设置' });
  await save.click(); await expect(save).toBeDisabled();
  await save.evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
  await card.getByLabel('已有命令行连接名称').fill('next-draft');
  gate.release(); await expect(save).toBeEnabled();
  const puts = requests.filter(r => r.method === 'PUT' && r.path.endsWith('/source-reader'));
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, { enabled: false, profile: 'custom-reader', trustedHosts: ['docs.example.com', 'files.example.com'] });
  await expect(card.getByLabel('已有命令行连接名称')).toHaveValue('next-draft');
});

test('来源开关独立于 worker 和采集；复用个人账号不回显名称，任务错误与重试保留', { timeout: 20000 }, async t => {
  const f = await fixture(t); const { page, card, requests } = f;
  f.setReader({ ...missing, trustedHosts: ['legacy.example.com'], connection: 'personal-feishu' });
  await emit(page); await expect(card).toContainText('已授权飞书账号');
  await card.getByLabel('启用受保护来源读取').check();
  await card.getByRole('button', { name: '保存来源读取设置' }).click();
  await expect(card).toContainText('来源读取设置已保存');
  assert.deepEqual(writes(requests).map(r => [r.path, r.body]), [['/api/v1/knowledge/source-reader', { enabled: true, trustedHosts: ['legacy.example.com'] }]]);
  await expect(page.getByLabel('启用整理 Agent', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('在哪台电脑上整理')).toHaveValue('offline');
  await expect(page.getByLabel('用哪个执行者')).toHaveValue('claude-code');
  await expect(page.getByRole('dialog')).toContainText('UNAUTHORIZED：来源权限不足');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).harness.changed)).toBe(1);
  assert.equal(requests.filter(r => r.path.endsWith('/retry')).length, 1);
  await expect(card.getByLabel('已有命令行连接名称')).toHaveValue('');
});

test('读取失败及旧 API 明确未知且不丢草稿；关闭和切 token 隔离迟到 GET/PUT', { timeout: 25000 }, async t => {
  const f = await fixture(t); const { page, card } = f;
  await card.getByText('高级设置', { exact: true }).click();
  await card.getByLabel('已有命令行连接名称').fill('keep-draft');
  f.setHandler(() => ({ status: 404, body: { error: '旧 API' } }));
  await emit(page); await expect(card).toContainText('请升级服务端');
  await expect(card.getByRole('button', { name: '保存来源读取设置' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存整理设置', exact: true })).toBeVisible();
  await expect(card.getByLabel('已有命令行连接名称')).toHaveValue('keep-draft');
  await emit(page, { connection: 'offline' }); await expect(card).toContainText('事件或状态读取失败');
  const gate = deferred(); t.after(gate.release);
  f.setHandler(async () => { await gate.promise; return { body: { ...missing, profile: 'late-old' } }; });
  const before = f.requests.length;
  await emit(page, { connection: 'online' });
  await expect.poll(() => f.requests.length).toBeGreaterThan(before);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  f.setHandler(undefined);
  await page.evaluate(() => { (window as any).harness.api.setToken('fixture-b'); (window as any).harness.open(); });
  gate.release();
  await expect(card.getByRole('button', { name: '保存来源读取设置' })).toBeEnabled();
  await expect(card.getByLabel('已有命令行连接名称')).toHaveValue('');
  const put = deferred(); t.after(put.release);
  f.setHandler(async () => { await put.promise; return { body: { ...missing, enabled: true, connection: 'personal-feishu' } }; });
  await card.getByLabel('启用受保护来源读取').check(); await card.getByRole('button', { name: '保存来源读取设置' }).click();
  await page.evaluate(() => (window as any).harness.api.setToken('fixture-c'));
  put.release(); await emit(page);
  await expect(card).not.toContainText('来源读取设置已保存');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  f.setHandler(undefined); await page.evaluate(() => (window as any).harness.open());
  await expect(card.getByLabel('启用受保护来源读取')).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => (window as any).harness.listeners.size)).toBe(1);
});

test('390px 长连接名称和精确域名无横向溢出，非法域名阻止提交', { timeout: 20000 }, async t => {
  const f = await fixture(t, 390); const { page, card, requests } = f;
  f.setReader({ ...missing, profile: 'reader-' + 'a'.repeat(100), trustedHosts: [Array(3).fill('a'.repeat(60)).join('.') + '.example.com'], connection: 'explicit-profile' });
  await emit(page); await card.getByText('高级设置', { exact: true }).click();
  await expect(card.getByLabel('已有命令行连接名称')).toHaveValue('reader-' + 'a'.repeat(100));
  assert.ok(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth));
  assert.ok(await card.evaluate(el => el.scrollWidth <= el.clientWidth));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await card.getByLabel('额外精确受信域名').fill('*.example.com');
  await card.getByRole('button', { name: '保存来源读取设置' }).click();
  await expect(card).toContainText('请填写精确受信域名'); assert.deepEqual(writes(requests), []);
  await expect(card).toContainText('PDF 文字层和 DOCX');
  await expect(card).toContainText('扫描件不做 OCR');
});
