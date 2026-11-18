// Real Chromium + production UI modules, local HTTP substitutes; no external accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { chromium, expect, type Browser, type Page } from '@playwright/test';

const todo = { id: 'a', title: '等待确认', waitingOn: '显示昵称', reminderAt: '2099-01-01T00:00:00Z' };
const observed = (extra = {}) => ({ id: 'observed-anchor', source: 'feishu:account-a', chatId: 'chat-a', messageId: 'real-message-a', senderId: 'ou_author', senderIdType: 'open_id', createdAt: '2026-11-17T01:00:00Z', preview: '请确认交付', ...extra });
const sources = [observed(), observed({ id: 'person-a', messageId: 'person-message', senderId: 'ou_actual-person', label: '同名用户', preview: '此前的真实消息' })];
const tracking = (body: any, extra = {}) => ({ ...body, todoId: 'a', anchor: sources[0], cycle: 1, status: 'waiting', startedAt: '2026-11-17T02:00:00Z', waitingOn: todo.waitingOn, reminderAt: todo.reminderAt, scope: {}, ...extra });
type Request = { path: string; method: string; body: any };
type Reply = { body: any; status?: number };
async function fixture(fn: (ctx: { page: Page; calls: Request[]; setHandler: (fn: (r: Request) => Reply | Promise<Reply> | undefined) => void }) => Promise<void>) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/components.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/pages.css">
    <body><script type="module">
    import { createApi } from '/js/lib/api.js';
    import { createTodosTab } from '/js/features/todos-tab.js';
    import { openWaitingReply, refreshWaitingReply } from '/js/features/waiting-reply.js';
    const api = createApi(), todo = ${JSON.stringify(todo)};
    const store = {view: {snapshot: {projects: [], todos: [todo]}}, refresh: async () => { window.refreshCount++; }};
    window.refreshCount = 0;
    window.waiting = {open: (id = 'a', title = todo.title) => openWaitingReply({api, store, todo: {...todo, id, title}}), refresh: () => refreshWaitingReply(api), token: value => api.setToken(value)};
    const tab = createTodosTab({api, store, router: {}}); document.body.append(tab.el); tab.show('all');
    </script>`;
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, 'http://localhost').pathname;
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
      if (!/^\/(js|css)\//.test(path) || path.includes('..')) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(`../apps/web${path}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(5000);
    const errors: string[] = [], calls: Request[] = [];
    page.on('pageerror', e => errors.push(e.message));
    let handler: (r: Request) => Reply | Promise<Reply> | undefined = () => undefined;
    await page.route('**/api/v1/**', async route => {
      const req = route.request();
      const request = { path: new URL(req.url()).pathname.replace('/api/v1', ''), method: req.method(), body: req.postDataJSON() };
      calls.push(request);
      const override = await handler(request);
      const body = request.path === '/todos' ? { sections: { 等待中: [todo, { ...todo, id: 'b', title: '第二条待办' }], 今天: [{ id: 'no-wait', title: '普通待办' }] } }
        : request.path.endsWith('/sources') ? { items: sources, total: sources.length, truncated: false, limit: 100 } : null;
      await route.fulfill({ status: override?.status ?? 200, json: override ? override.body : body });
    });
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await expect(page.getByRole('button', { name: '跟踪回复', exact: true })).toHaveCount(2);
    await fn({ page, calls, setHandler: fn => { handler = fn; } });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}
const dialog = (page: Page) => page.getByRole('dialog', { name: '跟踪回复', exact: true });
async function open(page: Page, id = 'a') {
  await page.evaluate(id => (window as any).waiting.open(id), id);
  await expect(dialog(page).getByLabel('原消息', { exact: true })).toBeEnabled();
}
async function select(page: Page) {
  await dialog(page).getByLabel('原消息', { exact: true }).selectOption('observed-anchor');
  await dialog(page).getByLabel('等待谁', { exact: true }).selectOption(JSON.stringify(['open_id', 'ou_actual-person']));
}

test('真实来源 ID 与身份提交；命中仅停催，不完成待办或发送消息', { timeout: 30000 }, async () => fixture(async ({ page, calls, setHandler }) => {
  let snapshot: any = null;
  setHandler(r => {
    if (r.method === 'POST') { snapshot = tracking(r.body); return { body: snapshot }; }
    if (r.path.endsWith('/waiting-reply')) return { body: snapshot };
  });
  // The entry belongs to saved rows, never the unsaved editor.
  await page.locator('.todo[data-id="a"] .item__title').click();
  const editor = page.getByRole('dialog', { name: '编辑待办' });
  await editor.getByRole('textbox', { name: /标题/ }).fill('保留编辑草稿');
  await expect(editor.getByRole('button', { name: '跟踪回复' })).toHaveCount(0);
  await open(page); await select(page);
  await dialog(page).getByRole('button', { name: '跟踪所选回复' }).click();
  await expect(dialog(page)).toContainText('等待回复 · 第 1 轮');
  const submitted = calls.find(r => r.method === 'POST')!.body;
  assert.deepEqual(Object.keys(submitted).sort(), ['anchorId', 'expectedSenderId', 'expectedSenderIdType', 'key']);
  assert.equal(submitted.anchorId, 'observed-anchor');
  assert.equal(submitted.expectedSenderId, 'ou_actual-person');
  assert.equal(submitted.expectedSenderIdType, 'open_id');
  assert.match(submitted.key, /^[\da-f-]{36}$/);
  await expect(dialog(page)).toContainText('不能据此断定对方未回复');
  snapshot = { ...snapshot, status: 'matched', endedAt: '2026-11-17T03:00:00Z', hit: { evidence: observed({ messageId: 'actual-direct-reply', parentId: 'real-message-a', senderId: 'ou_actual-person', createdAt: '2026-11-17T02:30:00Z' }), reason: 'direct_reply', processedAt: '2026-11-17T03:00:00Z' } };
  await page.evaluate(() => (window as any).waiting.refresh());
  await expect(dialog(page)).toContainText('本轮提醒已停止；待办仍需手动确认完成');
  await expect(dialog(page)).toContainText('actual-direct-reply');
  await dialog(page).getByText('查看来源证据', { exact: true }).click();
  await expect(dialog(page)).toContainText('direct_reply');
  await dialog(page).getByRole('button', { name: '关闭', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: /标题/ })).toHaveValue('保留编辑草稿');
  assert.equal(calls.some(r => ['PATCH', 'PUT', 'DELETE'].includes(r.method)), false);
  assert.equal(calls.filter(r => r.method === 'POST').length, 1);
}));

test('同 source/chat 筛身份，昵称不作为 ID；空来源与截断如实说明', { timeout: 30000 }, async () => fixture(async ({ page, setHandler, calls }) => {
  let items = [...sources, observed({ id: 'wrong-chat', chatId: 'other-chat', senderId: 'wrong-chat-person', label: '同名用户' }), observed({ id: 'wrong-source', source: 'feishu:other-account', senderId: 'wrong-source-person', label: '同名用户' }), observed({ id: 'different-type', senderId: 'ou_actual-person', senderIdType: 'user_id', label: undefined })];
  setHandler(r => r.path.endsWith('/sources') ? { body: { items, total: 125, truncated: true, limit: 100 } } : undefined);
  await open(page); await select(page);
  await expect(dialog(page)).toContainText('来源列表已截断');
  const options = await dialog(page).getByLabel('等待谁', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(n => (n as HTMLOptionElement).value));
  assert.deepEqual(options, ['', JSON.stringify(['open_id', 'ou_author']), JSON.stringify(['open_id', 'ou_actual-person']), JSON.stringify(['user_id', 'ou_actual-person'])]);
  await expect(dialog(page)).toContainText('身份标识：ou_actual-person');
  items = [];
  await dialog(page).getByRole('button', { name: '核对当前状态' }).click();
  await expect(dialog(page)).toContainText('明确开启只读采集');
  await expect(dialog(page).getByRole('button', { name: '跟踪所选回复' })).toBeDisabled();
  assert.equal(calls.some(r => r.method !== 'GET'), false);
}));

test('409 保留选择与 key，重复点击锁定；核对前不重试，改选择使用新 key', { timeout: 30000 }, async () => fixture(async ({ page, calls, setHandler }) => {
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  setHandler(r => r.method === 'POST' ? gate.then(() => ({ status: 409, body: { error: '来源冲突' } })) : undefined);
  await open(page); await select(page);
  const save = dialog(page).getByRole('button', { name: '跟踪所选回复' });
  await save.evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
  await expect.poll(() => calls.filter(r => r.method === 'POST').length).toBe(1);
  await expect(save).toBeDisabled(); release();
  await expect(dialog(page)).toContainText('409 冲突');
  await expect(dialog(page).getByLabel('原消息', { exact: true })).toHaveValue('observed-anchor');
  await expect(save).toBeDisabled();
  const firstKey = calls.find(r => r.method === 'POST')!.body.key;
  await dialog(page).getByRole('button', { name: '关闭', exact: true }).click();
  await open(page);
  await expect(dialog(page).getByLabel('等待谁', { exact: true })).toHaveValue(JSON.stringify(['open_id', 'ou_actual-person']));
  gate = Promise.resolve();
  await save.click(); await expect(dialog(page)).toContainText('409 冲突');
  assert.equal(calls.filter(r => r.method === 'POST')[1].body.key, firstKey);
  await dialog(page).getByRole('button', { name: '核对当前状态' }).click();
  await expect(save).toBeEnabled();
  await dialog(page).getByLabel('等待谁', { exact: true }).selectOption(JSON.stringify(['open_id', 'ou_author']));
  await save.click(); await expect(dialog(page)).toContainText('409 冲突');
  assert.notEqual(calls.filter(r => r.method === 'POST')[2].body.key, firstKey);
}));

test('切待办、关闭与 token 变化隔离迟到；390px 长消息和身份自然换行', { timeout: 30000 }, async () => fixture(async ({ page, setHandler }) => {
  const long = 'long-identifier-'.repeat(30);
  const longSources = [observed({ preview: long, messageId: long, source: long, chatId: long }), observed({ id: 'long-person', preview: long, source: long, chatId: long, senderId: long })];
  let release!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  setHandler(r => {
    if (r.path === '/todos/a/waiting-reply') { started = true; return gate.then(() => ({ body: tracking({ key: 'old' }, { status: 'matched', cycle: 99 }) })); }
    if (r.path.endsWith('/sources')) return { body: { items: longSources, total: 2, truncated: false, limit: 100 } };
  });
  await page.evaluate(() => (window as any).waiting.open('a'));
  await expect.poll(() => started).toBe(true);
  await page.evaluate(() => (window as any).waiting.refresh());
  await open(page, 'b'); release();
  await dialog(page).getByLabel('原消息', { exact: true }).selectOption('observed-anchor');
  await dialog(page).getByLabel('等待谁', { exact: true }).selectOption(JSON.stringify(['open_id', long]));
  await expect(dialog(page)).not.toContainText('第 99 轮');
  await expect(dialog(page)).toContainText(long);
  assert.equal(await dialog(page).evaluate(el => el.scrollWidth > el.clientWidth), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  for (const change of ['close', 'token']) {
    let finish!: () => void, posting = false;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    setHandler(r => {
      if (r.method === 'POST') { posting = true; return wait.then(() => ({ body: tracking(r.body, { todoId: 'b', cycle: 88 }) })); }
      if (r.path.endsWith('/sources')) return { body: { items: longSources, total: 2, truncated: false, limit: 100 } };
    });
    await dialog(page).getByRole('button', { name: '跟踪所选回复' }).click();
    await expect.poll(() => posting).toBe(true);
    if (change === 'close') {
      await dialog(page).getByRole('button', { name: '关闭', exact: true }).click();
      await open(page, 'c');
    } else await page.evaluate(() => (window as any).waiting.token('another-test-token'));
    finish();
    if (change === 'token') await expect(dialog(page)).toHaveCount(0);
    else {
      await expect(dialog(page)).not.toContainText('第 88 轮');
      await dialog(page).getByLabel('原消息', { exact: true }).selectOption('observed-anchor');
      await dialog(page).getByLabel('等待谁', { exact: true }).selectOption(JSON.stringify(['open_id', long]));
    }
  }
}));
