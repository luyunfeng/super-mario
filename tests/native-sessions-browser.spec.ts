import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Page, type Route, type Browser } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

const longPath = '/work/' + '完整目录'.repeat(90);
const session = (n: number, machineId = 'a') => ({ ...(n === 12 ? { archived: true } : {}), id: `${machineId}-${n}`, executorId: 'codex', nativeSessionId: `native-${machineId}-${n}`, cwd: n === 12 ? longPath : `/work/${n}`, observedAt: '2026-11-17T00:00:00Z', metadataTimestamp: '2026-11-16T00:00:00Z', source: 'session-metadata', state: 'historical', writable: false, machineId, remoteExecutorId: 'remote-codex', resumable: true, relatedRunIds: [] });
const result = (id = '') => ({ capturedAt: '2026-11-17T00:00:00Z', machines: [
  { machineId: 'a', machineName: '电脑甲', online: true, available: true, roots: ['/work'], warnings: ['仅元数据'], truncated: true, sessions: Array.from({ length: 13 }, (_, n) => session(n)) },
  { machineId: 'b', machineName: '电脑乙', online: true, available: true, roots: [], warnings: [], truncated: false, sessions: [session(1, 'b')] },
  { machineId: 'off', machineName: '离线电脑', online: false, available: false, reason: '节点离线，未读取磁盘', roots: [], warnings: [], truncated: false, sessions: [] },
  { machineId: 'old', machineName: '旧节点', online: true, available: false, reason: '旧代理不支持会话发现', roots: [], warnings: [], truncated: false, sessions: [] },
].filter(m => !id || m.machineId === id) });
const approval = { id: 'resume-approval', kind: 'dispatch', version: 1, status: 'pending', title: '恢复历史会话', params: { cwd: '/work/0', prompt: '继续任务' } };
async function fixture(run: (ctx: {page: Page; json: (route: Route, data: any, status?: number) => Promise<void>; reads: string[]; writes: any[]; otherWrites: string[]; state: any; go: (page: string) => Promise<void>}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-native-browser-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  let browser: Browser | undefined;
  const json = (route: Route, data: any, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
    page.setDefaultTimeout(6000);
    await page.addInitScript(() => { localStorage.setItem('sm.splash.seen', 'true'); Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }); });
    const state = { todos: [{ id: 'topic-todo', title: '合成话题待办' }, { id: 'project-todo', projectId: 'match', title: '合成项目待办' }], machines: result().machines.map(m => ({ id: m.machineId, name: m.machineName, online: m.online, capabilities: m.machineId === 'old' ? [] : ['sessions.discover'] })), projects: [{ id: 'match', name: '同目录项目', workspace: { machineId: 'a', cwd: '/work/0' } }, { id: 'wrong', name: '其他目录项目', workspace: { machineId: 'b', cwd: '/else' } }] };
    const reads: string[] = [], writes: any[] = [], otherWrites: string[] = [], errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.url().includes('/api/v1/') && r.method() !== 'GET' && !r.url().endsWith('/agents/sessions/resume')) otherWrites.push(new URL(r.url()).pathname); });
    await page.route('**/api/v1/state', async route => { const response = await route.fetch(); await json(route, { ...await response.json(), ...state }); });
    await page.route('**/api/v1/agents/sessions?*', route => { const url = new URL(route.request().url()); reads.push(url.search); return json(route, result(url.searchParams.get('machineId') ?? '')); });
    await page.route('**/api/v1/agents/sessions', route => { reads.push('all'); return json(route, result()); });
    await page.route('**/api/v1/agents/sessions/resume', route => { writes.push(route.request().postDataJSON()); return json(route, approval); });
    await page.route('**/api/v1/agents/sessions/resume-request?*', route => json(route, { approval: null }));
    const go = async (name: string) => { await page.evaluate(name => { location.hash = name; }, name); await expect(page.locator(`#${name}`)).toBeVisible(); };
    await page.goto(server.url + '/#chat');
    await expect(page.locator('#chat')).toBeVisible();
    await run({ page, json, reads, writes, otherWrites, state, go });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
}
const fill = async (page: Page) => {
  await page.getByLabel('恢复后要做什么').fill('继续任务');
  await page.getByLabel('完成标准').fill('测试通过');
  await page.getByLabel('预计用时（分钟）').fill('10');
};

test('CLI 历史全部展示、只读筛选、窄屏完整路径与页面缓存', { timeout: 40000 }, async () => fixture(async ({ page, reads, writes, go }) => {
  assert.equal(reads.length, 0);
  await go('agent');
  const card = page.locator('#agent-cli-sessions');
  await expect(card.locator('[data-cli-session]')).toHaveCount(14);
  await expect(card).toContainText('历史 ≠ 当前运行或空闲');
  await expect(card).toContainText('旧代理不支持会话发现');
  await expect(card).toContainText('节点离线，未读取磁盘');
  await expect(card).toContainText('结果已截断');
  const archiveFilter = page.getByLabel('CLI 会话归档筛选');
  const beforeFilter = reads.length;
  await archiveFilter.selectOption('archived');
  await expect(card.locator('[data-cli-session]')).toHaveCount(1);
  await expect(card.locator('[data-cli-session]')).toContainText('已归档');
  assert.equal(reads.length, beforeFilter);
  await archiveFilter.selectOption('');
  await expect(card.locator('[data-cli-session]')).toHaveCount(14);
  await page.getByLabel('CLI 会话关键词').fill('native-a-12');
  await expect(card.locator('[data-cli-session]')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  const path = card.locator('p').filter({ hasText: `目录：${longPath}` });
  assert.ok(await path.evaluate(el => el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).lineHeight) * 2));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByLabel('CLI 会话关键词').fill('');
  const count = reads.length;
  await go('chat'); await go('agent');
  await expect(card.locator('[data-cli-session]')).toHaveCount(14);
  assert.equal(reads.length, count);
  await page.getByLabel('CLI 会话项目').selectOption('match');
  await expect.poll(() => reads.some(r => r.includes('projectId=match'))).toBe(true);
  assert.deepEqual(writes, []);
}));

test('迟到选择不覆盖新电脑，离页响应丢弃，能力变化重新读取', { timeout: 40000 }, async () => fixture(async ({ page, json, reads, go, state }) => {
  await go('agent'); await expect(page.locator('[data-cli-session]')).toHaveCount(14);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/api/v1/agents/sessions?machineId=a', async route => { requested = true; await gate; await json(route, result('a')); });
  await page.getByLabel('CLI 会话电脑').selectOption('a');
  await expect.poll(() => requested).toBe(true);
  await page.getByLabel('CLI 会话电脑').selectOption('b');
  await expect(page.locator('[data-cli-session]')).toHaveCount(1);
  release(); await expect(page.locator('[data-cli-session]')).toHaveAttribute('data-cli-session', 'b-1');
  let finish!: () => void; const hiddenGate = new Promise<void>(resolve => { finish = resolve; });
  let hiddenRequested = false, returnedReads = 0;
  await page.route('**/api/v1/agents/sessions?machineId=b', async route => {
    returnedReads++;
    if (returnedReads === 1) { hiddenRequested = true; await hiddenGate; }
    const late = result('b'); late.machines[0].sessions[0].id = 'hidden-late';
    await json(route, late);
  });
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect.poll(() => hiddenRequested).toBe(true);
  await go('chat'); finish();
  await go('agent');
  assert.equal(returnedReads, 1);
  await expect(page.locator('[data-cli-session]')).toHaveAttribute('data-cli-session', 'b-1');
  await expect(page.locator('[data-cli-session]')).toHaveCount(1);
  let refreshReads = 0;
  await page.route('**/api/v1/agents/sessions?machineId=b', async route => { refreshReads++; await json(route, result('b')); });
  state.machines[0].capabilities.push('sessions.resume');
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.locator('#agent-cli-sessions')).toContainText('连接不可用');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => refreshReads).toBeGreaterThan(0);
  await expect(page.locator('[data-cli-session]')).toHaveCount(1);
}));

test('恢复必须勾选和填写，仅提出审批，项目不匹配不改目录，非 HTTPS UUID fallback', { timeout: 40000 }, async () => fixture(async ({ page, writes, otherWrites, go }) => {
  await go('agent');
  await page.locator('[data-cli-session="a-0"]').getByRole('button', { name: '申请恢复' }).click();
  const submit = page.getByRole('button', { name: '提交恢复审批' });
  await expect(submit).toBeDisabled();
  await page.getByRole('checkbox', { name: '我已确认原终端已停止' }).check();
  await expect(submit).toBeDisabled();
  await page.getByRole('checkbox', { name: '我已确认原终端已停止' }).uncheck();
  await fill(page); await expect(submit).toBeDisabled();
  await page.getByRole('checkbox', { name: '我已确认原终端已停止' }).check();
  await page.getByLabel('关联项目（可选）').selectOption('wrong');
  await expect(submit).toBeDisabled();
  await expect(page.getByRole('dialog', { name: '申请恢复 CLI 会话' })).toContainText('workspace 与此会话的电脑或目录不匹配');
  await page.getByLabel('关联项目（可选）').selectOption('match');
  await expect(submit).toBeEnabled(); await submit.click();
  await expect(page.getByRole('dialog', { name: '申请恢复 CLI 会话' })).toContainText('尚未执行');
  await expect(submit).toBeDisabled();
  assert.equal(writes.length, 1); assert.equal(writes[0].executorId, 'codex'); assert.equal(writes[0].cwd, '/work/0'); assert.equal(writes[0].projectId, 'match');
  assert.match(writes[0].key, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  await page.getByRole('button', { name: '查看审批', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '恢复申请审批' })).toContainText('resume-approval');
  assert.equal(otherWrites.some(path => /approve|dispatch|\/runs$/.test(path)), false);
}));

test('可将交互恢复申请关联到当前项目范围内的待办', async () => fixture(async ({ page, writes, go }) => {
  await go('agent');
  await page.locator('[data-cli-session="a-0"]').getByRole('button', { name: '申请恢复' }).click();
  const todo = page.getByLabel('关联待办（可选）');
  await todo.selectOption('topic-todo');
  await page.getByLabel('关联项目（可选）').selectOption('match');
  await expect(todo).toHaveValue('');
  await expect(todo.locator('option[value="topic-todo"]')).toHaveCount(0);
  await todo.selectOption('project-todo');
  await page.getByLabel('恢复方式').selectOption('interactive');
  await page.getByLabel('恢复后要做什么').fill('继续本事项');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '提交恢复审批' }).click();
  await expect.poll(() => writes.length).toBe(1);
  assert.equal(writes[0].todoId, 'project-todo');
  assert.equal(writes[0].executionMode, 'interactive');
  assert.equal(writes[0].expectMinutes, undefined);
}));

test('unknown 保留 payload/key、跨抽屉锁定，只读核对不重放', { timeout: 40000 }, async () => fixture(async ({ page, json, go }) => {
  const bodies: any[] = [], queries: string[] = [];
  await page.route('**/api/v1/agents/sessions/resume', route => { bodies.push(route.request().postDataJSON()); return json(route, { error: 'unknown' }, 502); });
  let found = false;
  await page.route('**/api/v1/agents/sessions/resume-request?*', route => { queries.push(route.request().url()); return json(route, { approval: found ? approval : null }); });
  await go('agent'); await page.locator('[data-cli-session="a-0"]').getByRole('button', { name: '申请恢复' }).click();
  await fill(page); await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '提交恢复审批' }).click();
  await expect(page.getByRole('dialog', { name: '申请恢复 CLI 会话' })).toContainText('申请结果未知');
  await page.getByRole('button', { name: '只读核对申请' }).click();
  await expect(page.getByRole('dialog', { name: '申请恢复 CLI 会话' })).toContainText('尚未查到审批');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('[data-cli-session="a-0"]').getByRole('button', { name: '申请恢复' }).click();
  await expect(page.getByLabel('恢复后要做什么')).toHaveValue('继续任务');
  await expect(page.getByRole('button', { name: '提交恢复审批' })).toBeDisabled();
  found = true; await page.getByRole('button', { name: '只读核对申请' }).click();
  await expect(page.getByRole('button', { name: '查看审批', exact: true })).toBeVisible();
  assert.equal(bodies.length, 1); assert.equal(queries.length, 2);
  for (const query of queries) assert.equal(new URL(query).searchParams.get('key'), bodies[0].key);
}));

test('令牌与连接变化丢弃旧结果；普通 state 更新不重复发现，capability 变化失效缓存', { timeout: 40000 }, async () => fixture(async ({ page }) => {
  // 单独挂载组件以控制 store/令牌事件的顺序，模拟已经在网络中的旧响应。
  const counts = await page.evaluate(async (discovery) => {
    const modulePath = '/js/features/cli-sessions.js';
    const { createCliSessions } = await import(modulePath);
    let token = 'first', calls = 0;
    const pending: Array<(data: any) => void> = [];
    const api = { token: () => token, get: () => { calls++; return new Promise(resolve => pending.push(resolve)); } };
    const store = { view: { connection: 'online', unauthorized: false, snapshot: { machines: [{ id: 'a', name: '甲', online: true, capabilities: ['sessions.discover'] }], projects: [] } } };
    const router = { current: { page: 'agent' }, subscribe() {} };
    const component = createCliSessions({ api, store, router });
    document.body.append(component.el); component.onShow();
    const initial = calls;
    for (let i = 0; i < 10; i++) component.onState();
    const ordinary = calls;
    token = 'second';
    pending.shift()!(discovery); await Promise.resolve();
    const tokenDiscarded = component.el.querySelectorAll('[data-cli-session]').length === 0;
    component.onState();
    const tokenCalls = calls;
    store.view.connection = 'offline';
    pending.shift()!(discovery); await Promise.resolve(); component.onState();
    const offlineDiscarded = component.el.querySelectorAll('[data-cli-session]').length === 0;
    store.view.connection = 'online'; component.onState(); pending.shift()!(discovery); await Promise.resolve();
    const reconnectCalls = calls;
    store.view.snapshot.machines[0].capabilities.push('sessions.resume'); component.onState();
    const capabilityCalls = calls;
    pending.shift()!(discovery); await Promise.resolve();
    component.el.remove();
    return { initial, ordinary, tokenDiscarded, tokenCalls, offlineDiscarded, reconnectCalls, capabilityCalls };
  }, result('a'));
  assert.deepEqual(counts, { initial: 1, ordinary: 1, tokenDiscarded: true, tokenCalls: 2, offlineDiscarded: true, reconnectCalls: 3, capabilityCalls: 4 });
}));
