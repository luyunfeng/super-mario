import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';

type Reply = { status?: number; body: any };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const job = (status: string, id = 'source-1') => ({ id, status, title: '待整理来源', error: '', createdAt: new Date().toISOString() });

async function fixture(t: TestContext, initial = 'queued', width = 1000) {
  let value: any = { settings: { enabled: false, machineId: 'offline', provider: 'claude-code' }, worker: { state: 'idle' }, jobs: [job(initial)] };
  let getHandler: (() => Reply | Promise<Reply>) | undefined;
  let postHandler: ((body: any) => Reply | Promise<Reply>) | undefined;
  const streams = new Set<ServerResponse>();
  const requests: { method: string; path: string; body: any; token?: string }[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.write(': ready\n\n');
      streams.add(res); req.on('close', () => streams.delete(res)); return;
    }
    if (url.pathname.startsWith('/api/v1/')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method!, path: url.pathname, body, token: req.headers.authorization });
      let reply: Reply = { status: 404, body: { error: 'unsupported' } };
      if (url.pathname.endsWith('/source-reader')) reply = { body: { enabled: false, trustedHosts: [], revision: 1, connection: 'missing' } };
      if (url.pathname.endsWith('/curator')) reply = req.method === 'GET' ? (getHandler ? await getHandler() : { body: value }) : { body: value };
      if (url.pathname.endsWith('/retry')) reply = postHandler ? await postHandler(body) : { body: { ...job('queued', 'new-1'), retryOf: 'source-1' } };
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(reply.body)); return;
    }
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/components.css"><body><script type="module">
        import { openCuratorDrawer } from '/js/features/curator.js'; import { createApi } from '/js/lib/api.js';
        const listeners = new Set(); const api = createApi(); api.setToken('fixture-a');
        const store = { view: { connection: 'online', snapshot: { machines: [], version: 0 } }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
        function emit(patch = {}) { Object.assign(store.view, patch); for (const fn of listeners) fn(store.view); }
        const events = new EventSource('/events'); events.onmessage = e => emit(JSON.parse(e.data));
        window.harness = { api, store, listeners, emit, changed: 0, open() { this.drawer = openCuratorDrawer({ api, store, onChanged: () => { this.changed++; } }); } };
        window.harness.open();
        </script></body></html>`); return;
    }
    try {
      const path = resolve('apps/web', '.' + url.pathname); if (!path.startsWith(resolve('apps/web') + '/')) throw new Error('path');
      res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : 'text/css'); res.end(await readFile(path));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => { for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(() => r()); }));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  await expect(page.getByRole('button', { name: '保存整理设置', exact: true })).toBeVisible();
  await expect.poll(() => streams.size).toBe(1);
  let version = 0;
  return { page, requests, get value() { return value; }, set value(v: any) { value = v; },
    setGet(fn?: typeof getHandler) { getHandler = fn; }, setPost(fn?: typeof postHandler) { postHandler = fn; },
    event(patch?: any) { const data = patch ?? { snapshot: { machines: [], version: ++version } }; for (const stream of streams) stream.write(`data: ${JSON.stringify(data)}\n\n`); },
  };
}
const queue = (page: Page) => page.getByRole('region', { name: '整理队列', exact: true });
const row = (page: Page, id = 'source-1') => queue(page).locator(`[data-job-id="${id}"]`);
const posts = (f: { requests: { method: string; body: any }[] }) => f.requests.filter(r => r.method === 'POST');
const gets = (f: { requests: { method: string; path: string }[] }) => f.requests.filter(r => r.method === 'GET' && r.path.endsWith('/curator'));
const pause = (page: Page) => page.waitForTimeout(280); // 跨过 120ms debounce，检查无请求而非立即断言。
const reopen = (page: Page) => page.evaluate(() => (window as any).harness.open());
const close = async (page: Page) => { await page.getByRole('button', { name: '关闭', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); };

test('SSE 快照推进 queued → running → awaiting_approval → completed，worker/reader 草稿与 DOM 始终保留', { timeout: 20000 }, async t => {
  const f = await fixture(t); const { page } = f;
  await page.getByLabel('启用整理 Agent', { exact: true }).check();
  await page.getByLabel('用哪个执行者').selectOption('pi');
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByLabel('已有命令行连接名称').fill('reader-draft');
  await page.getByLabel('额外精确受信域名').fill('draft.example.com');
  await page.getByLabel('用哪个执行者').evaluate(el => (window as any).originalControl = el);
  for (const [status, label] of [['queued', '等待整理'], ['running', '整理中'], ['awaiting_approval', '待主人确认'], ['completed', '已整理']]) {
    f.value.jobs = [{ ...job(status), ...(status === 'awaiting_approval' ? { approvalId: 'approval-1', pendingApprovalHref: '#chat?approval=approval-1' } : {}) }]; f.event();
    await expect(row(page).getByText(label, { exact: true })).toBeVisible();
    if (status === 'awaiting_approval') await expect(row(page).getByRole('link', { name: '去确认来源读取' })).toHaveAttribute('href', '#chat?approval=approval-1');
    await expect(page.getByLabel('启用整理 Agent', { exact: true })).toBeChecked();
    await expect(page.getByLabel('用哪个执行者')).toHaveValue('pi');
    await expect(page.getByLabel('已有命令行连接名称')).toHaveValue('reader-draft');
    await expect(page.getByLabel('额外精确受信域名')).toHaveValue('draft.example.com');
    assert.ok(await page.getByLabel('用哪个执行者').evaluate(el => el === (window as any).originalControl));
  }
  await pause(page); const count = gets(f).length;
  await page.evaluate(() => { const h = (window as any).harness; h.emit(); h.emit({ snapshot: structuredClone(h.store.view.snapshot) }); });
  await pause(page); assert.equal(gets(f).length, count); assert.equal(posts(f).length, 0);
  await close(page); await expect.poll(() => page.evaluate(() => (window as any).harness.listeners.size)).toBe(0);
  f.event(); await pause(page); assert.equal(gets(f).length, count);
});

test('会议资料队列显示纪要标题、原文档、目标归属和读取失败原因', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const url = 'https://example.feishu.cn/docx/SyntheticMinutes';
  f.value.jobs = [{ ...job('failed'), title: '样例会议纪要', url, requestOrigin: 'meeting', error: '所选账号没有这份资料的访问权限' }];
  f.event();
  const source = row(f.page);
  await expect(source.getByText('样例会议纪要', { exact: true })).toBeVisible();
  await expect(source.getByText('会议资料 · 个人记忆', { exact: true })).toBeVisible();
  await expect(source.getByRole('link', { name: '查看原文档' })).toHaveAttribute('href', url);
  await expect(source.getByText('失败', { exact: true })).toBeVisible();
  await expect(source).toContainText('所选账号没有这份资料的访问权限');
});

test('unknown 必须确认，取消不 POST；成功只显示新任务引用，活动 retryOf 阻止旧行重复整理', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'unknown'); const { page } = f;
  await expect(row(page)).toContainText('结果未确认');
  await row(page).getByRole('button', { name: '核对后重新整理', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '核对后重新整理', exact: true });
  await expect(confirm).toContainText('原任务可能已经执行'); await expect(confirm).toContainText('不会自动覆盖人工编辑');
  assert.equal(posts(f).length, 0); await confirm.getByRole('button', { name: '取消' }).click();
  assert.equal(posts(f).length, 0);
  f.setPost(() => { f.value.jobs.push({ ...job('queued', 'new-1'), retryOf: 'source-1' }); return { body: f.value.jobs[1] }; });
  await row(page).getByRole('button', { name: '核对后重新整理', exact: true }).click();
  await confirm.getByRole('button', { name: '确认重新整理' }).click();
  await expect(row(page)).toContainText('新整理任务：new-1（等待整理）');
  await expect(row(page)).not.toContainText('已整理');
  await expect(row(page).getByRole('button')).toHaveCount(0); assert.equal(posts(f).length, 1);
});

test('409 保留 key，重复点击锁；关闭重开先 GET 核对，显式重试复用 UUID，token 独立', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'failed'); const { page } = f;
  const gate = deferred(); t.after(gate.release);
  f.setPost(async () => { await gate.promise; return { status: 409, body: { error: 'profile=SECRET token=SECRET' } }; });
  await row(page).getByRole('button', { name: '重试', exact: true }).evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
  await expect.poll(() => posts(f).length).toBe(1); const key = posts(f)[0].body.key;
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  f.event(); await pause(page); await expect(row(page).getByRole('button', { name: '重试', exact: true })).toBeDisabled();
  gate.release(); await expect(row(page)).toContainText('HTTP 409'); await expect(row(page)).toContainText(key);
  await expect(page.getByRole('dialog')).not.toContainText('SECRET');
  await close(page);
  const getGate = deferred(); t.after(getGate.release); f.setGet(async () => { await getGate.promise; return { body: f.value }; });
  await reopen(page); await pause(page); assert.equal(posts(f).length, 1); await expect(row(page)).toHaveCount(0);
  getGate.release(); await expect(row(page).getByRole('button', { name: '重试', exact: true })).toBeEnabled(); f.setGet();
  f.setPost(() => ({ status: 409, body: { error: 'conflict' } }));
  await row(page).getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => posts(f).length).toBe(2); assert.equal(posts(f)[1].body.key, key);
  await close(page); await page.evaluate(() => (window as any).harness.api.setToken('fixture-b')); await reopen(page);
  await row(page).getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => posts(f).length).toBe(3); assert.notEqual(posts(f)[2].body.key, key);
  assert.equal(f.requests.filter(r => r.method === 'POST')[2].token, 'Bearer fixture-b');
});

test('关闭及 token 变化隔离迟到 GET/POST，不通知新身份、不重发写入', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'failed'); const { page } = f;
  const gate = deferred(); t.after(gate.release);
  f.setGet(async () => { await gate.promise; return { body: { ...f.value, jobs: [job('completed', 'late-old')] } }; });
  f.event(); await expect.poll(() => gets(f).length).toBe(2); await close(page);
  f.setGet(); await page.evaluate(() => (window as any).harness.api.setToken('fixture-b')); await reopen(page);
  gate.release(); await expect(row(page)).toContainText('失败'); await expect(queue(page)).not.toContainText('late-old');
  const writeGate = deferred(); t.after(writeGate.release);
  f.setPost(async () => { await writeGate.promise; return { body: job('queued', 'late-write') }; });
  await row(page).getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => posts(f).length).toBe(1);
  await page.evaluate(() => { const h = (window as any).harness; h.api.setToken('fixture-c'); h.emit({ snapshot: { version: 33 } }); });
  await expect.poll(() => page.evaluate(() => (window as any).harness.listeners.size)).toBe(0);
  writeGate.release(); await pause(page); await expect(queue(page)).not.toContainText('late-write');
  assert.equal(await page.evaluate(() => (window as any).harness.changed), 0);
  await close(page); await reopen(page); await expect(row(page).getByRole('button', { name: '重试', exact: true })).toBeEnabled();
  assert.equal(posts(f).length, 1);
});

test('读取失败/旧 API/事件断线保留旧队列与草稿，明确未确认且不自动重试', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'failed'); const { page } = f;
  await page.getByLabel('用哪个执行者').selectOption('codex');
  for (const status of [500, 404]) {
    f.setGet(() => ({ status, body: { error: 'token=SECRET profile=SECRET' } })); f.event();
    await expect(page.getByRole('dialog')).toContainText(status === 404 ? '旧 API 不支持状态读取' : 'HTTP 500');
    await expect(row(page)).toContainText('待整理来源'); await expect(queue(page)).toContainText('当前进度未确认');
    await expect(row(page).getByRole('button', { name: '重试', exact: true })).toBeDisabled();
    await expect(page.getByLabel('用哪个执行者')).toHaveValue('codex');
  }
  f.setGet(() => ({ body: { settings: f.value.settings, jobs: f.value.jobs } })); f.event();
  await expect(page.getByRole('dialog')).toContainText('旧 API 缺少 worker 状态');
  f.event({ connection: 'offline' }); await expect(page.getByRole('dialog')).toContainText('事件或状态读取失败');
  await expect(page.getByRole('dialog')).not.toContainText('SECRET'); assert.equal(posts(f).length, 0);
});

test('390px 长 URL/title/error/key 自然换行且按文本显示，不执行材料 HTML', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'failed', 390); const { page } = f;
  f.value.jobs = [{ ...job('failed'), url: 'https://example.com/' + 'path'.repeat(100), error: 'READ_FAILED_' + 'x'.repeat(300) },
    { ...job('unknown', 'text-source'), title: '<img src=x onerror="window.materialExecuted=true">' + 'title'.repeat(100) }];
  f.event(); await expect(row(page)).toContainText('READ_FAILED_');
  f.setPost(() => ({ status: 409, body: { error: 'conflict' } })); await row(page).getByRole('button', { name: '重试', exact: true }).click();
  await expect(row(page)).toContainText('请求 key：');
  await expect(queue(page).locator('img')).toHaveCount(0); assert.equal(await page.evaluate(() => (window as any).materialExecuted), undefined);
  for (const locator of [page.getByRole('dialog'), queue(page), row(page)]) assert.ok(await locator.evaluate(el => el.scrollWidth <= el.clientWidth));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

test('写入在途关闭后重开只读核对；迟到成功不重发，旧 API 无 retryOf 仍保留新任务引用', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'failed'); const { page } = f;
  const gate = deferred(); t.after(gate.release);
  f.setPost(async () => { await gate.promise; return { body: job('queued', 'legacy-new') }; });
  await row(page).getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => posts(f).length).toBe(1);
  await close(page); const before = gets(f).length; await reopen(page);
  await expect.poll(() => gets(f).length).toBe(before + 1);
  await expect(row(page).getByRole('button', { name: '重试', exact: true })).toBeDisabled();
  const key = posts(f)[0].body.key; gate.release(); await pause(page);
  await row(page).getByRole('button', { name: '核对现有队列', exact: true }).click();
  await expect(row(page)).toContainText('已提交新整理任务：legacy-new'); await expect(row(page)).toContainText(key);
  await expect(row(page)).not.toContainText('已整理');
  assert.equal(posts(f).length, 1);
  assert.equal(await page.evaluate(() => (window as any).harness.changed), 0);
});

test('连续快照合并一次 GET；较新快照使在途旧响应失效', { timeout: 20000 }, async t => {
  const f = await fixture(t); const { page } = f;
  const before = gets(f).length;
  for (let i = 0; i < 8; i++) f.event();
  await expect.poll(() => gets(f).length).toBe(before + 1); await pause(page); assert.equal(gets(f).length, before + 1);
  const gate = deferred(); t.after(gate.release);
  f.setGet(async () => { await gate.promise; return { body: { ...f.value, jobs: [job('failed', 'stale-snapshot')] } }; });
  f.event(); await expect.poll(() => gets(f).length).toBe(before + 2);
  f.setGet(); f.value.jobs = [job('completed')]; f.event();
  // 同 URL 的浏览器 HTTP 缓存锁可能串行化 GET；先确保新快照已到，再释放旧响应。
  await expect.poll(() => page.evaluate(() => (window as any).harness.store.view.snapshot.version)).toBe(10);
  gate.release(); await expect(row(page)).toContainText('已整理'); await pause(page);
  await expect(row(page)).toContainText('已整理'); await expect(queue(page)).not.toContainText('stale-snapshot');
});
