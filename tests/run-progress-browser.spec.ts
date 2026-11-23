import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Page, type Browser } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

const observedAt = '2026-11-17T08:25:00Z';
const progress = <T extends object = object>(phase: string, extra = {} as T) => ({ phase, observedAt, ...extra });
const run = (id = 'one', extra = {}) => ({ id, status: 'running', prompt: `执行 ${id}`, executorId: 'codex', createdAt: observedAt, updatedAt: observedAt, ...extra });

// 用真实路由和生产组件、样式，API 保持可控，检查网络迟到和快照更新顺序。
async function fixture(body: (page: Page) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-progress-browser-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // 不启动应用自身的 websocket。其余生产模块和 CSS 由真实服务提供。
    await page.route('**/js/main.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.goto(server.url + '/#projects/all/runs');
    await page.evaluate(async () => {
      const featurePath = '/js/features/runs.js', routerPath = '/js/lib/router.js';
      const { createRunsTab } = await import(featurePath);
      const { createRouter } = await import(routerPath);
      const router = createRouter();
      const state: any = { runs: [], todos: [], projects: [], executors: [], approvals: [] };
      const pending: any[] = [], reads: string[] = [], writes: string[] = [];
      const api: any = { draftOwner: () => 'test-owner', token: () => '', get: (path: string) => {
        reads.push(path);
        if (path === '/plans') return Promise.resolve([]);
        return new Promise((resolve, reject) => pending.push({ path, resolve, reject }));
      } };
      for (const method of ['post', 'patch', 'put', 'del']) api[method] = (path: string) => { writes.push(path); return Promise.resolve({}); };
      const store = { view: { snapshot: state, attention: [], connection: 'online' }, refresh() {} };
      const component = createRunsTab({ api, store, router, consoleDrawer: { open() {} }, markRunSeen() {} });
      const host = document.createElement('main'); host.className = 'page__inner'; host.append(component.el);
      document.body.replaceChildren(host);
      router.subscribe((route: any) => { if (route.page === 'projects') component.show(route.parts[0], route.parts[1] === 'runs' ? route.parts[2] : ''); });
      (window as any).progressTest = { state, pending, reads, writes, update: () => component.update() };
      router.start();
    });
    await body(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => (window as any).progressTest.writes), [], '观察功能不得产生写请求');
  } finally { await browser?.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
}
async function setRuns(page: Page, runs: any[]) {
  await page.evaluate(runs => { const t = (window as any).progressTest; t.state.runs = runs; t.update(); }, runs);
}
async function go(page: Page, id = '') {
  await page.evaluate(id => { location.hash = `projects/all/runs${id ? '/' + id : ''}`; }, id);
  await expect.poll(() => new URL(page.url()).hash).toBe(`#projects/all/runs${id ? '/' + id : ''}`);
}
async function reply(page: Page, id: string, data: any) {
  await expect.poll(() => page.evaluate(id => (window as any).progressTest.pending.some((p: any) => p.path === `/runs/${id}/observations`), id)).toBe(true);
  await page.evaluate(({ id, data }) => {
    const pending = (window as any).progressTest.pending;
    const index = pending.findIndex((p: any) => p.path === `/runs/${id}/observations`);
    pending.splice(index, 1)[0].resolve({ runId: id, status: 'running', progress: null, blockedBy: [], ...data });
  }, { id, data });
}

test('running → 工具 → 回复：最近观察更新，普通快照不重复读取，保留验收与终端', { timeout: 30000 }, async () => fixture(async page => {
  await setRuns(page, [run('one', { progress: progress('thinking'), sessionId: 'terminal', todoId: 'todo', doneWhen: '测试通过' })]);
  await expect(page.locator('[data-run-progress="one"]:visible')).toContainText('最近观察：思考');
  await go(page, 'one');
  await reply(page, 'one', { progress: progress('thinking') });
  await page.evaluate(() => { const t = (window as any).progressTest; t.state.todos = [{ id: 'todo', title: '任务' }]; t.update(); });
  await expect(page.getByRole('button', { name: '验收交付', exact: true })).toBeVisible();
  for (const [phase, label] of [['tool', '调用工具'], ['responding', '生成回复']]) {
    await setRuns(page, [run('one', { progress: progress(phase, phase === 'tool' ? { toolName: 'exec_command' } : {}) })]);
    await reply(page, 'one', { progress: progress(phase, phase === 'tool' ? { toolName: 'exec_command' } : {}) });
    await expect(page.locator('[data-run-progress="one"]:visible')).toContainText(label);
    await go(page);
    await expect(page.locator('[data-run-progress="one"]:visible')).toContainText(label);
    await go(page, 'one');
    await reply(page, 'one', { progress: progress(phase, phase === 'tool' ? { toolName: 'exec_command' } : {}) });
  }
  const before = await page.evaluate(() => (window as any).progressTest.reads.length);
  await page.evaluate(() => { const t = (window as any).progressTest; for (let i = 0; i < 20; i++) t.update(); });
  assert.equal(await page.evaluate(() => (window as any).progressTest.reads.length), before);
  await setRuns(page, [run('one', { progress: progress('responding'), sessionId: 'terminal' })]);
  await reply(page, 'one', { progress: progress('responding') });
  await page.getByRole('tab', { name: '终端', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开终端', exact: true })).toBeVisible();
}));

test('completed / failed 保留最后观察，不声称正在执行；unknown 缺上报不假成功', { timeout: 30000 }, async () => fixture(async page => {
  for (const status of ['completed', 'failed']) {
    await setRuns(page, [run('one', { status, progress: progress('tool', { toolName: 'exec_command' }) })]);
    await go(page, 'one');
    await reply(page, 'one', { status, progress: progress('tool', { toolName: 'exec_command' }) });
    await expect(page.locator('[data-run-progress="one"]:visible')).toContainText('最后观察：调用工具');
    await expect(page.locator('#panel-runs')).not.toContainText('正在执行');
    await go(page);
  }
  await setRuns(page, [run('one', { status: 'unknown' })]);
  await expect(page.locator('[data-run-progress="one"]:visible')).toContainText('最近观察，状态未确认：未上报结构化进展');
  await go(page, 'one'); await reply(page, 'one', { status: 'unknown' });
  await expect(page.locator('#panel-runs')).toContainText('不要重复发起');
  await expect(page.locator('[data-run-progress="one"]:visible')).toContainText('未上报结构化进展');
  await expect(page.getByRole('button', { name: '中断', exact: true })).toHaveCount(0);
}));

test('等待你仅列真实阻塞入口；waiting 不表示已批准；迟到切 run 与离页隔离', { timeout: 30000 }, async () => fixture(async page => {
  await setRuns(page, [run('one', { progress: progress('waiting', { detail: '模型说：已批准' }) }), run('two')]);
  await go(page, 'one');
  await reply(page, 'one', { progress: progress('waiting'), blockedBy: [
    { id: 'question', kind: 'question', title: '请确认工作目录', version: 1, createdAt: observedAt, href: '#chat?interaction=question',
      questions:[{question:'使用哪个目录？', recommend:'样例目录', reason:'已准备示例配置。'}, {question:'如何命名？',recommend:'按日期'}] },
    { id: 'permission', kind: 'permission', title: '允许写入吗', version: 2, createdAt: observedAt, href: '#chat' },
  ] });
  const blockers = page.locator('[data-run-blockers="one"]');
  await expect(blockers.getByRole('link')).toHaveCount(2);
  await expect(blockers.getByRole('link').first()).toHaveAttribute('href', '#chat?interaction=question');
  const original = blockers.getByRole('listitem').first();
  for (const text of ['使用哪个目录？','推荐选项：样例目录','理由：已准备示例配置。','推荐选项：按日期']) await expect(original).toContainText(text);
  await expect(blockers.getByRole('listitem').last()).not.toContainText('推荐选项');
  await expect(blockers).not.toContainText('已批准');
  await page.evaluate(() => { const t = (window as any).progressTest; t.state.approvals = [{ id: 'new', status: 'pending' }]; t.update(); });
  await go(page, 'two');
  await reply(page, 'two', { blockedBy: [] });
  await reply(page, 'one', { blockedBy: [{ id: 'late', title: '迟到错误阻塞', href: '#chat' }] });
  await expect(page.locator('[data-run-blockers="two"]')).toContainText('没有待你处理');
  await expect(page.locator('#panel-runs')).not.toContainText('迟到错误阻塞');
  await go(page, 'one');
  await page.evaluate(() => { location.hash = 'chat'; });
  await expect.poll(() => new URL(page.url()).hash).toBe('#chat');
  await reply(page, 'one', { blockedBy: [{ id: 'hidden', title: '离页旧响应', href: '#chat' }] });
  await go(page, 'one'); await reply(page, 'one', { blockedBy: [] });
  await expect(page.locator('[data-run-blockers="one"]')).not.toContainText('离页旧响应');
  await expect(page.locator('[data-run-blockers="one"] a')).toHaveCount(0);
}));

test('读取失败如实显示；390px 长工具名和详情自然换行、不横向溢出', { timeout: 30000 }, async () => fixture(async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  const long = progress('tool', { toolName: 'very_long_tool_'.repeat(45), detail: '很长的观察详情'.repeat(110) });
  await setRuns(page, [run('one', { progress: long })]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await go(page, 'one');
  await reply(page, 'one', { progress: long });
  await expect(page.locator('[data-run-progress="one"]:visible')).toContainText(long.detail);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => {
    const t = (window as any).progressTest;
    t.state.runs[0].updatedAt = '2026-11-17T08:26:00Z'; t.update();
    const index = t.pending.findIndex((request: {path:string}) => request.path === '/runs/one/observations');
    if (index < 0) throw new Error('未发起执行观察请求');
    t.pending.splice(index, 1)[0].reject(new Error('网络中断'));
  });
  await expect(page.locator('[data-run-blockers="one"]')).toContainText('未能读取执行观察与阻塞项：网络中断。状态未确认');
  const blockers = page.locator('[data-run-blockers="one"]');
  await expect(blockers).not.toContainText('没有待你处理');
  await blockers.getByRole('button', { name: '重试读取' }).click();
  await reply(page, 'one', { blockedBy: [{ id: 'decision', title: '核对目标', href: '#chat?approval=decision' }] });
  await expect(blockers.getByRole('link', { name: '核对目标' })).toBeVisible();
  await blockers.getByRole('button', { name: '刷新执行观察' }).click();
  await reply(page, 'one', { blockedBy: [] });
  await expect(blockers).toContainText('没有待你处理的阻塞项');
  await expect(blockers.getByRole('link')).toHaveCount(0);
}));
