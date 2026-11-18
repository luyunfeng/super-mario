import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Page, type Route } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

const at = '2026-11-17T08:25:00Z';
const decision = (extra = {}) => ({ id: 'one', key: 'key-one', text: '明确决定', scope: { kind: 'global' }, version: 3, status: 'active', source: { messageId: 'user-original', createdAt: at }, recordSource: { messageId: 'user-edit', createdAt: at }, createdAt: at, updatedAt: at, ...extra });
const response = (items: any[], truncated = false) => ({ items, counts: { total: items.length, active: items.filter(i => i.status === 'active').length, withdrawn: items.filter(i => i.status === 'withdrawn').length }, truncated, limit: 100 });

// 真实 Chromium、生产记忆页及纸色 CSS；只替换 API，不连接外部账号或模型。
async function fixture(body: (f: any) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-decisions-browser-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const f: any = { page, items: [decision()], reads: [] as string[], writes: [] as any[], conflict: false, readError: false, failCreate: false, truncated: false, delayed: new Map<string, Route>() };
    await page.route('**/js/main.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/api/v1/**', async route => {
      const req = route.request(), url = new URL(req.url()), path = url.pathname.replace('/api/v1', '');
      const json = (data: any, status = 200) => route.fulfill({ status, json: data });
      if (req.method() === 'GET') {
        if (path === '/knowledge/curator') return json({ settings: { enabled: false }, jobs: [] });
        assert.equal(path, '/work-decisions');
        f.reads.push(url.search);
        if (f.hold === url.searchParams.get('projectId')) { f.delayed.set(f.hold, route); return; }
        if (f.readError) return json({ error: '离线读取失败' }, 503);
        return json(response(f.items, f.truncated));
      }
      const data = req.postDataJSON();
      f.writes.push({ method: req.method(), path, data });
      assert.ok(path.startsWith('/work-decisions'), '不得写知识或发消息');
      if (f.conflict) return json({ error: '旧版本' }, 409);
      if (f.failCreate && path === '/work-decisions') return json({ error: '结果未确认' }, 503);
      if (path === '/work-decisions') {
        const item = decision({ id: 'created', key: data.key, text: data.text, version: 1, scope: data.projectId ? { kind: 'project', projectId: data.projectId } : { kind: 'global' } });
        f.items = [...f.items, item]; return json(item, 201);
      }
      const id = path.split('/')[2], item = f.items.find((i: any) => i.id === id);
      assert.equal(data.version, item.version);
      const updated = { ...item, version: item.version + 1, ...(path.endsWith('/withdraw') ? { status: 'withdrawn' } : { text: data.text }) };
      f.items = f.items.map((i: any) => i.id === id ? updated : i);
      return json(updated);
    });
    await page.goto(server.url + '/#memory');
    await page.evaluate(async () => {
      const memoryPath = '/js/pages/memory.js', apiPath = '/js/lib/api.js', scopePath = '/js/lib/scope.js';
      const { createMemoryPage } = await import(memoryPath), { createApi } = await import(apiPath), { createScope } = await import(scopePath);
      const scope = createScope(); scope.set('');
      const listeners: any[] = [];
      const snapshot = { projects: [{ id: 'a', name: '项目甲' }, { id: 'b', name: '项目乙' }], knowledge: [{ id: 'k', title: '原有知识', content: '保留原知识流程', layer: 'personal', updatedAt: '2026-11-17T08:25:00Z' }] };
      const store = { view: { snapshot }, subscribe(fn: any) { listeners.push(fn); }, refresh() {} };
      const router = { current: { page: 'memory' }, href: () => '#memory' };
      const component = createMemoryPage({ api: createApi(), store, scope, router });
      document.body.replaceChildren(component.el); component.el.classList.add('is-active');
      (window as any).decisionsTest = { scope, store, emit: (fresh: boolean) => { if (fresh) store.view.snapshot = { ...store.view.snapshot }; listeners.forEach(fn => fn(store.view)); component.onState(); } };
      component.onShow({ query: new URLSearchParams(), parts: [] });
    });
    await expect(page.locator('#work-decisions')).toContainText('版本 3');
    await body(f);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
}
const panel = (page: Page) => page.locator('#work-decisions');
const row = (page: Page, id = 'one') => page.locator(`[data-decision-id="${id}"]`);
const editor = (page: Page) => page.getByRole('dialog', { name: /^(新增|编辑)工作决定$/ });

test('创建、编辑、撤回使用当前版本，来源只展示标识与时间，原知识流程保留', { timeout: 30000 }, async () => fixture(async ({ page, writes }: any) => {
  await expect(page.getByText('原有知识', { exact: true })).toBeVisible();
  await expect(panel(page)).toContainText('后续对话按最新版本继续');
  await expect(row(page)).toContainText('user-original'); await expect(row(page)).toContainText('user-edit');
  await panel(page).getByRole('button', { name: '新增工作决定' }).click();
  await editor(page).getByLabel('工作决定内容').fill('新决定');
  await editor(page).getByRole('button', { name: '保存决定' }).click();
  await expect(row(page, 'created')).toContainText('版本 1');
  assert.match(writes[0].data.key, /^[0-9a-f-]{36}$/); assert.equal(writes[0].data.projectId, undefined);
  await row(page, 'created').getByRole('button', { name: '编辑决定' }).click();
  await editor(page).getByLabel('工作决定内容').fill('修改决定');
  await editor(page).getByRole('button', { name: '保存决定' }).click();
  await expect(row(page, 'created')).toContainText('版本 2');
  assert.deepEqual(writes[1].data, { version: 1, text: '修改决定' });
  await row(page, 'created').getByRole('button', { name: '撤回决定' }).click();
  assert.equal(writes.length, 2);
  await page.getByRole('dialog', { name: '撤回这条工作决定？' }).getByRole('button', { name: '确认撤回' }).click();
  await expect(row(page, 'created')).toContainText('已撤回');
  assert.deepEqual(writes[2].data, { version: 2 });
  await expect(row(page, 'created').getByRole('button')).toHaveCount(0);
}));

test('409 保留草稿，刷新当前版本后才允许显式保存；撤回冲突不假成功', { timeout: 30000 }, async () => fixture(async (f: any) => {
  const { page } = f;
  await row(page).getByRole('button', { name: '编辑决定' }).click();
  await editor(page).getByLabel('工作决定内容').fill('我的草稿'); f.conflict = true;
  await editor(page).getByRole('button', { name: '保存决定' }).click();
  await expect(editor(page)).toContainText('版本冲突（409）');
  await expect(editor(page).getByLabel('工作决定内容')).toHaveValue('我的草稿');
  await expect(editor(page).getByRole('button', { name: '保存决定' })).toBeDisabled();
  assert.equal(f.writes.length, 1);
  f.items = [decision({ version: 4, text: '远端新决定' })]; f.conflict = false;
  await editor(page).getByRole('button', { name: '刷新当前版本' }).click();
  await expect(editor(page)).toContainText('已读取版本 4');
  await expect(editor(page)).toContainText('当前参考版本 4：远端新决定');
  await expect(editor(page).getByLabel('工作决定内容')).toHaveValue('我的草稿');
  await editor(page).getByRole('button', { name: '保存决定' }).click();
  await expect(row(page)).toContainText('版本 5'); assert.equal(f.writes[1].data.version, 4);
  f.conflict = true;
  await row(page).getByRole('button', { name: '撤回决定' }).click();
  await page.getByRole('button', { name: '确认撤回' }).click();
  await expect(panel(page)).toContainText('撤回遇到版本冲突');
  await expect(row(page)).toContainText('生效'); assert.equal(f.writes.length, 3);
}));

test('切项目隔离晚到响应和抽屉；重复 store 通知不重复 GET，新快照合并刷新', { timeout: 30000 }, async () => fixture(async (f: any) => {
  const { page } = f;
  const setScope = (id: string) => page.evaluate((id: string) => (window as any).decisionsTest.scope.set(id), id);
  f.hold = 'a'; await setScope('a');
  await expect.poll(() => f.delayed.has('a')).toBe(true);
  f.items = [decision({ id: 'b-one', text: '乙决定', scope: { kind: 'project', projectId: 'b' } })];
  await setScope('b'); await expect(panel(page)).toContainText('乙决定');
  await f.delayed.get('a').fulfill({ json: response([decision({ text: '甲迟到决定' })]) });
  await expect(panel(page)).not.toContainText('甲迟到决定');
  await panel(page).getByRole('button', { name: '新增工作决定' }).click();
  await editor(page).getByLabel('工作决定内容').fill('乙项目人编辑');
  await editor(page).getByRole('button', { name: '保存决定' }).click();
  await expect(row(page, 'created')).toBeVisible(); assert.equal(f.writes[0].data.projectId, 'b');
  const before = f.reads.length;
  await page.evaluate(() => { for (let i = 0; i < 20; i++) (window as any).decisionsTest.emit(false); });
  await page.waitForTimeout(180); assert.equal(f.reads.length, before);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) (window as any).decisionsTest.emit(true); });
  await expect.poll(() => f.reads.length).toBe(before + 1);
  await panel(page).getByRole('button', { name: '新增工作决定' }).click();
  await setScope(''); await expect(editor(page)).toHaveCount(0);
  await expect.poll(() => f.reads.at(-1)).toBe('');
}));

test('读取失败保留数据和未知状态，截断提示；创建失败保留 key 到成功', { timeout: 30000 }, async () => fixture(async (f: any) => {
  const { page } = f;
  f.readError = true; await page.evaluate(() => (window as any).decisionsTest.emit(true));
  await expect(panel(page)).toContainText('工作决定读取失败'); await expect(row(page)).toContainText('明确决定');
  await expect(panel(page)).toContainText('保留上次读取的数据');
  f.readError = false; f.truncated = true;
  await panel(page).getByRole('button', { name: '重试读取' }).click(); await expect(panel(page)).toContainText('仅显示前 100 条');
  f.failCreate = true;
  await panel(page).getByRole('button', { name: '新增工作决定' }).click();
  await editor(page).getByLabel('工作决定内容').fill('创建草稿');
  await editor(page).getByRole('button', { name: '保存决定' }).click();
  await expect(editor(page)).toContainText('保存未确认');
  await editor(page).getByRole('button', { name: '取消' }).click();
  await panel(page).getByRole('button', { name: '新增工作决定' }).click();
  await expect(editor(page).getByLabel('工作决定内容')).toHaveValue('创建草稿');
  f.failCreate = false; await editor(page).getByRole('button', { name: '保存决定' }).click();
  await expect(row(page, 'created')).toBeVisible(); assert.equal(f.writes[0].data.key, f.writes[1].data.key);
  await panel(page).getByRole('button', { name: '新增工作决定' }).click();
  await editor(page).getByLabel('工作决定内容').fill('第二条'); await editor(page).getByRole('button', { name: '保存决定' }).click();
  await expect(editor(page)).toHaveCount(0); assert.notEqual(f.writes[2].data.key, f.writes[1].data.key);
}));

test('390px 长决定与来源换行，抽屉和4000字校验可用', { timeout: 30000 }, async () => fixture(async (f: any) => {
  const { page } = f;
  await page.setViewportSize({ width: 390, height: 844 });
  f.items = [decision({ text: '长决定'.repeat(1200), scope: { kind: 'task', projectId: 'a', todoId: 'todo'.repeat(80) }, source: { messageId: 'source'.repeat(120), createdAt: at } })];
  await page.evaluate(() => (window as any).decisionsTest.emit(true));
  await expect(row(page)).toContainText('任务：项目甲');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await row(page).getByRole('button', { name: '编辑决定' }).click();
  const text = editor(page).getByLabel('工作决定内容'); await expect(text).toHaveAttribute('maxlength', '4000');
  await text.fill('字'.repeat(4001)); await expect(text).toHaveValue('字'.repeat(4000));
  // 浏览器本身会限制粘贴长度；额外验证程序性赋值仍不能绕过写入校验。
  await text.evaluate((el: HTMLTextAreaElement) => { el.value = '字'.repeat(4001); el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(editor(page).getByRole('button', { name: '保存决定' })).toBeDisabled();
  await text.fill('字'.repeat(4000)); await expect(editor(page).getByRole('button', { name: '保存决定' })).toBeEnabled();
  assert.equal(await page.evaluate(() => { const d = document.querySelector('dialog')!; return d.scrollWidth > d.clientWidth; }), false);
  assert.equal(f.writes.length, 0);
}));
