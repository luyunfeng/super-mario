import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Page, type Route } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

const at = '2026-11-17T08:00:00Z';
const work = (extra = {}) => ({ id: 'work-one', version: 3, title: '每日项目事实', status: 'pending', projectId: 'a', schedule: { kind: 'cron', cron: '0 9 * * *', tz: 'Asia/Shanghai' }, action: { kind: 'brief' }, approvalId: 'creation-one', approvalStatus: 'pending', source: { messageId: 'source-message', createdAt: at }, occurrences: [], occurrenceTotal: 0, occurrencesTruncated: false, ...extra });
const panel = (page: Page) => page.locator('#agent-scheduled-work');
const drawer = (page: Page) => page.getByRole('dialog', { name: '创建定时工作', exact: true });
const json = (route: Route, data: any, status = 200) => route.fulfill({ status, json: data });
async function fixture(body: (f: any) => Promise<void>, noScope = false) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-scheduled-browser-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, timezoneId: 'America/Los_Angeles' });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const f: any = { page, items: [work()], reads: [], writes: [], readStatus: 200, writeStatus: 201, cancelStatus: 200, held: [] };
    await page.route('**/js/main.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/api/v1/**', async r => {
      const req = r.request(), url = new URL(req.url()), path = url.pathname.replace('/api/v1', '');
      if (path === '/scheduled-work' && req.method() === 'GET') {
        f.reads.push(url.search);
        if (f.holdRead) { f.held.push(r); return; }
        return json(r, f.readStatus === 200 ? { items: f.items, total: f.items.length, truncated: f.truncated ?? false, limit: 100 } : { error: 'test unavailable' }, f.readStatus);
      }
      if (path.startsWith('/scheduled-work') && req.method() === 'POST') {
        f.writes.push({ path, body: req.postDataJSON() });
        if (f.holdWrite) { f.held.push(r); return; }
        if (path.endsWith('/cancel')) {
          if (f.cancelStatus === 200) f.items = f.items.map((i: any) => ({ ...i, status: 'cancelled' }));
          return json(r, f.cancelStatus === 200 ? { id: 'work-one', status: 'cancelled' } : { error: 'changed' }, f.cancelStatus);
        }
        return json(r, f.writeStatus === 201 ? { id: 'new-approval', status: 'pending' } : { error: 'test conflict or unknown' }, f.writeStatus);
      }
      assert.equal(req.method(), 'GET', '不能执行任务、调用模型或批准审批');
      const defaults: Record<string, unknown> = {
        '/model': { mode: 'api', model: 'fixture' }, '/automation': { tickSeconds: 60 },
        '/supervisor/settings': { available: true }, '/briefing/settings': {}, '/presence': {},
        '/policies': { rules: [] }, '/policies/presets': { presets: [] }, '/agents/sessions': { machines: [] },
      };
      return json(r, defaults[path] ?? {});
    });
    await page.goto(server.url + '/#agent');
    await page.evaluate(async ({ noScope }) => {
      const p = '/js/pages/agent.js', a = '/js/lib/api.js', s = '/js/lib/scope.js';
      const { createAgentPage } = await import(p), { createApi } = await import(a), { createScope } = await import(s);
      const api = createApi(), scope = createScope(); scope.set('a');
      const snapshot = { agent: { available: true }, projects: [{ id: 'a', name: '项目甲' }, { id: 'b', name: '项目乙' }], todos: [{ id: 'todo-a', title: '甲待办', projectId: 'a' }, { id: 'todo-b', title: '乙待办', projectId: 'b' }], machines: [], executors: [{ id: 'real-cli', name: '实际 CLI', available: true }, { id: 'offline-cli', name: '离线 CLI', available: false, reason: '电脑离线' }], plugins: [], runs: [], knowledge: [] };
      const store = { view: { snapshot, connection: 'online', unauthorized: false }, refresh() {} };
      const component = createAgentPage({ api, store, ...(noScope ? {} : { scope }), router: { current: { page: 'agent' }, subscribe() {} }, consoleDrawer: {} });
      document.body.replaceChildren(component.el); component.el.classList.add('is-active');
      (window as any).scheduledTest = { api, store, scope, component, emit() { store.view.snapshot = { ...store.view.snapshot }; component.onState(store.view); } };
      component.onState(store.view); component.onShow({ parts: [] });
    }, { noScope });
    await expect(panel(page)).toContainText('每日项目事实');
    await body(f);
    for (const route of f.held) await json(route, { id: 'LATE-APPROVAL', status: 'pending' }).catch(() => {});
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
}
const emit = (page: Page) => page.evaluate(() => (window as any).scheduledTest.emit());
const open = (page: Page) => panel(page).getByRole('button', { name: '创建定时工作' }).click();
const submit = (page: Page) => drawer(page).getByRole('button', { name: '提交创建审批' }).click();

test('创建每天事实简报：预览与真实 body 一致，只提交审批、未执行', { timeout: 30000 }, async () => fixture(async f => {
  const { page } = f;
  await open(page);
  await drawer(page).getByRole('textbox', { name: '标题', exact: true }).fill('早间事实');
  await drawer(page).getByLabel('频率', { exact: true }).selectOption('daily');
  await drawer(page).getByLabel('每天时间', { exact: true }).fill('08:35');
  await drawer(page).getByLabel('IANA 时区', { exact: true }).fill('Asia/Shanghai');
  await drawer(page).getByLabel('关联待办', { exact: true }).selectOption('todo-a');
  const preview = await drawer(page).getByLabel('创建预览').innerText();
  const expected = JSON.parse(preview.slice(preview.indexOf('{')));
  assert.deepEqual(expected.schedule, { kind: 'cron', cron: '35 8 * * *', tz: 'Asia/Shanghai' });
  assert.deepEqual(expected.action, { kind: 'brief' });
  assert.equal(expected.projectId, 'a'); assert.equal(expected.todoId, 'todo-a');
  assert.match(expected.key, /^[\da-f-]{36}$/);
  assert.equal(f.writes.length, 0);
  await submit(page);
  await expect(drawer(page)).toContainText('已提交创建审批 · 待批准');
  await expect(drawer(page).getByRole('link', { name: '去对话核对与确认' })).toHaveAttribute('href', '#chat');
  assert.deepEqual(f.writes, [{ path: '/scheduled-work', body: expected }]);
  await expect(drawer(page).getByRole('button', { name: '提交创建审批' })).toBeDisabled();
}));

test('现有创建审批生效、单次已触发与到期派发审批 pending/completed/unknown 分开显示', { timeout: 30000 }, async () => fixture(async f => {
  const { page } = f;
  await expect(panel(page)).toContainText('待创建确认');
  await expect(panel(page).getByRole('link')).toHaveAttribute('href', '#chat');
  for (const approvalStatus of ['pending', 'completed', 'unknown']) {
    f.items = [work({ status: 'active', approvalStatus: 'completed', scheduleStatus: 'done', schedule: { kind: 'once', at }, action: { kind: 'dispatch', executorId: 'real-cli' }, occurrences: [{ key: 'o', kind: 'dispatch', status: 'completed', scheduledFor: at, approvalId: 'dispatch-one', approvalStatus }], occurrenceTotal: 30, occurrencesTruncated: true })];
    await emit(page);
    await expect(panel(page)).toContainText('已生效（仅配置生效）');
    await expect(panel(page)).toContainText('单次计划已触发');
    await expect(panel(page)).toContainText('已生成派发审批');
    await expect(panel(page)).toContainText('任务最终完成情况未确认');
    const details = panel(page).locator('details');
    if (!(await details.getAttribute('open') !== null)) await details.locator('summary').click();
    await expect(details).toContainText(`派发审批：dispatch-one · ${{pending:'待批准',completed:'已处理',unknown:'结果未知'}[approvalStatus]}`);
    await expect(details).toContainText('最近记录已截断');
    await expect(details).toContainText('source-message');
  }
}));

test('取消须明确确认当前 version；409 不盲重试，核对新版本再取消', { timeout: 30000 }, async () => fixture(async f => {
  const { page } = f;
  f.cancelStatus = 409;
  await panel(page).getByRole('button', { name: '取消计划', exact: true }).click();
  assert.equal(f.writes.length, 0);
  const cancel = page.getByRole('dialog', { name: '取消定时工作' });
  await expect(cancel).toContainText('不终止已派发的任务');
  await cancel.getByRole('button', { name: '确认取消版本 3' }).click();
  await expect(cancel).toContainText('版本已变化');
  await cancel.getByRole('button', { name: '确认取消版本 3' }).click();
  assert.deepEqual(f.writes, [{ path: '/scheduled-work/work-one/cancel', body: { version: 3 } }]);
  await cancel.getByRole('button', { name: '关闭', exact: true }).click();
  f.items = [work({ version: 4, title: '核对后的新版本' })]; f.cancelStatus = 200; await emit(page);
  await expect(panel(page)).toContainText('核对后的新版本');
  await panel(page).getByRole('button', { name: '取消计划', exact: true }).click();
  await cancel.getByRole('button', { name: '确认取消版本 4' }).click();
  await expect(cancel).toContainText('已取消计划');
  assert.deepEqual(f.writes[1].body, { version: 4 });
}));

test('创建失败/409 保留输入及 key；重复点击只有一个在途写入', { timeout: 30000 }, async () => fixture(async f => {
  const { page } = f;
  await open(page); await drawer(page).getByRole('textbox', { name: '标题', exact: true }).fill('保留草稿');
  await drawer(page).getByLabel('频率', { exact: true }).selectOption('interval');
  await drawer(page).getByLabel('间隔分钟', { exact: true }).fill('0.1'); await submit(page);
  await expect(drawer(page)).toContainText('间隔至少为 10 秒'); assert.equal(f.writes.length, 0);
  await drawer(page).getByLabel('间隔分钟', { exact: true }).fill('2');
  for (const [index,status] of [409, 503].entries()) {
    f.writeStatus = status; await submit(page);
    await expect.poll(()=>f.writes.length).toBe(index+1);
    await expect(drawer(page)).toContainText('草稿和请求标识已保留');
    await expect(drawer(page).getByRole('textbox', { name: '标题', exact: true })).toHaveValue('保留草稿');
  }
  assert.deepEqual(f.writes[0].body, f.writes[1].body);
  assert.equal(f.writes[0].body.schedule.everySec, 120);
  f.holdWrite = true;
  await submit(page); await expect.poll(() => f.held.length).toBe(1);
  await drawer(page).getByRole('button', { name: '提交创建审批' }).evaluate((el: HTMLButtonElement) => { el.click(); el.click(); });
  assert.equal(f.writes.length, 3);
  await json(f.held.shift(), { id: 'new-approval', status: 'unknown' }, 201);
  await expect(drawer(page)).toContainText('结果未知');
}));

test('关闭、scope、token 变更隔离晚到写入；晚到 GET 不覆盖新范围', { timeout: 30000 }, async () => fixture(async f => {
  const { page } = f;
  for (const change of ['close', 'scope', 'token']) {
    await open(page); await drawer(page).getByRole('textbox', { name: '标题', exact: true }).fill('旧范围草稿');
    await drawer(page).getByLabel('频率', { exact: true }).selectOption('interval');
    f.holdWrite = true; await submit(page); await expect.poll(() => f.held.length).toBe(1);
    if (change === 'close') await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();
    if (change === 'scope') await page.evaluate(() => (window as any).scheduledTest.scope.set('b'));
    if (change === 'token') await page.evaluate(() => (window as any).scheduledTest.api.setToken('fixture-other-token'));
    await expect(drawer(page)).toHaveCount(0);
    await json(f.held.shift(), { id: 'LATE-APPROVAL', status: 'pending' }, 201);
    await open(page);
    await expect(drawer(page)).not.toContainText('LATE-APPROVAL');
    await expect(drawer(page).getByRole('textbox', { name: '标题', exact: true })).toHaveValue('');
    await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();
  }
  f.holdRead = true; await emit(page); await expect.poll(() => f.held.length).toBe(1);
  f.holdRead = false; f.items = [work({ title: '新范围正确数据', projectId: 'a' })];
  await page.evaluate(() => (window as any).scheduledTest.scope.set('a'));
  await expect(panel(page)).toContainText('新范围正确数据');
  await json(f.held.shift(), { items: [work({ title: '过时数据' })], total: 1 });
  await expect(panel(page)).not.toContainText('过时数据');
}));

test('390px 长 title/cron/cwd 无溢出；真实执行者和同项目待办校验', { timeout: 30000 }, async () => fixture(async f => {
  const { page } = f;
  await page.setViewportSize({ width: 390, height: 844 });
  const long = 'long-name-no-space'.repeat(45);
  f.items = [work({ title: long, schedule: { kind: 'cron', cron: long, tz: 'Asia/Shanghai' }, action: { kind: 'dispatch', executorId: 'real-cli', cwd: '/' + long } })];
  await emit(page); await expect(panel(page)).toContainText(long);
  await panel(page).locator('summary').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await open(page);
  const d = drawer(page);
  await d.getByRole('textbox', { name: '标题', exact: true }).fill(long);
  await d.getByLabel('项目', { exact: true }).selectOption('b');
  await expect(d.getByLabel('关联待办', { exact: true }).locator('option')).toHaveText(['不关联待办', '乙待办']);
  await d.getByLabel('关联待办', { exact: true }).selectOption('todo-b');
  await d.getByLabel('频率', { exact: true }).selectOption('cron');
  await d.getByLabel('cron 表达式', { exact: true }).fill(long);
  await d.getByLabel('动作', { exact: true }).selectOption('dispatch');
  await d.getByLabel('执行者', { exact: true }).selectOption('offline-cli');
  await submit(page); await expect(d).toContainText('执行者不可用：电脑离线'); assert.equal(f.writes.length, 0);
  await d.getByLabel('执行者', { exact: true }).selectOption('real-cli');
  await d.getByLabel('目标', { exact: true }).fill('真实目标');
  await d.getByLabel('完成标准', { exact: true }).fill('核对结果');
  await d.getByLabel('工作目录', { exact: true }).fill('/' + long);
  assert.equal(await d.evaluate(el => el.scrollWidth > el.clientWidth), false);
  assert.equal(await d.locator('.drawer__body').evaluate(el => el.scrollWidth > el.clientWidth), false);
  await submit(page);
  await expect(d).toContainText('已提交创建审批');
  assert.deepEqual(f.writes[0].body.action, { kind: 'dispatch', executorId: 'real-cli', prompt: '真实目标', doneWhen: '核对结果', expectMinutes: 30, cwd: '/' + long });
  assert.equal(f.writes[0].body.projectId, 'b'); assert.equal(f.writes[0].body.todoId, 'todo-b');
  assert.equal(f.writes[0].body.schedule.cron, long, '不在前端实现 cron 解析，交给后端校验');
}));

test('once 拒绝 DST 不存在的本地时间，并转换正常本地时间为 ISO', { timeout: 30000 }, async () => fixture(async f => {
  const { page } = f;
  await open(page); await drawer(page).getByRole('textbox', { name: '标题', exact: true }).fill('单次');
  await drawer(page).getByLabel('本地触发时间', { exact: true }).fill('2027-03-14T02:30'); await submit(page);
  await expect(drawer(page)).toContainText('本地触发时间无效'); assert.equal(f.writes.length, 0);
  await drawer(page).getByLabel('本地触发时间', { exact: true }).fill('2027-03-14T03:30'); await submit(page);
  await expect(drawer(page)).toContainText('已提交创建审批');
  assert.deepEqual(f.writes[0].body.schedule, { kind: 'once', at: '2027-03-14T10:30:00.000Z' });
}));

test('旧 fixture 无 scope 兼容；GET 失败/404 保留旧数据、明确缺支持且其他 Agent 功能可用', { timeout: 30000 }, async () => fixture(async f => {
  const { page } = f;
  assert.equal(f.reads[0], '');
  await expect(page.locator('#agent-model')).toContainText('fixture');
  await expect(page.locator('#agent-computers')).toContainText('实际 CLI');
  await open(page); await drawer(page).getByRole('textbox', { name: '标题', exact: true }).fill('编辑中不要覆盖');
  await emit(page); await expect(drawer(page).getByRole('textbox', { name: '标题', exact: true })).toHaveValue('编辑中不要覆盖');
  await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();
  for (const status of [503, 404]) {
    f.readStatus = status; await emit(page);
    await expect(panel(page)).toContainText('列表状态未确认');
    await expect(panel(page)).toContainText('每日项目事实');
    if (status === 404) await expect(panel(page)).toContainText('缺少定时工作 API 支持');
  }
  await expect(page.locator('#agent-model').getByRole('button', { name: '更改模型' })).toBeEnabled();
  await page.locator('#agent-model').getByRole('button', { name: '更改模型' }).click();
  await expect(page.getByRole('dialog', { name: '主 Agent 模型' })).toBeVisible();
}, true));
