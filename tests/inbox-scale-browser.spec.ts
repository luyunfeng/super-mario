// Production mailbox/API/store/router and CSS in Chromium; all 5000 source rows
// and HTTP responses are offline fixtures. No account, model, or real message IO.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';

const rows = () => Array.from({ length: 5000 }, (_, i) => ({
  id: `scale-${i}`, version: 1, title: `离线消息-${i}`, text: `全量正文 索引-${i}-终 ${'长消息'.repeat(40)}`,
  tier: 'fyi', receivedAt: new Date(Date.UTC(2026, 10, 17) - i * 1000).toISOString(),
  projectId: i % 2 ? 'b' : 'a',
  ...(i % 10 === 9 ? { archivedAt: '2026-11-17T01:00:00Z' } : {}),
  ...(i % 10 === 8 ? { todoId: `todo-${i}` } : {}),
  origin: { kind: ['direct', 'group', 'agent', 'unknown'][i % 4], mentionedMe: i % 8 === 1,
    chatName: `离线会话-${i}`, senderName: `离线作者-${i}` },
}));
type Reply = { status?: number; body: unknown };
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>(r => { release = r; });
  return { promise, release };
};

async function fixture(t: TestContext) {
  const snapshot = { inbox: rows(), projects: [{ id: 'a', name: '项目甲' }, { id: 'b', name: '项目乙' }], todos: [], runs: [] };
  const calls: { method: string; path: string; body: any }[] = [];
  let mailbox: Record<string, any>[] = [];
  let mailboxGate: ReturnType<typeof deferred> | undefined;
  let patch: ((path: string, body: any) => Promise<Reply> | Reply) | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.startsWith('/api/v1/')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const path = url.pathname.slice('/api/v1'.length), method = req.method!, body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method, path: path + url.search, body });
      let reply: Reply;
      if (method === 'GET' && path === '/state') reply = { body: snapshot };
      else if (method === 'GET' && path === '/attention') reply = { body: [] };
      else if (method === 'GET' && path === '/mailboxes') {
        // Capture the response at request time, so a delayed read can be tested.
        const value = structuredClone(mailbox);
        await mailboxGate?.promise;
        reply = { body: value };
      } else if (method === 'GET' && path === '/outbox') reply = { body: [] };
      else if (method === 'PATCH' && patch) reply = await patch(path, body);
      else reply = { status: 500, body: { error: 'Unexpected offline API' } };
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(reply.body)); return;
    }
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css">
        <link rel="stylesheet" href="/css/components.css"><link rel="stylesheet" href="/css/pages.css">
        <body><main id="host"></main><script type="module">
        import { createMailboxPage } from '/js/pages/mailbox.js';
        import { createStore } from '/js/lib/store.js';
        import { createApi } from '/js/lib/api.js';
        import { createRouter } from '/js/lib/router.js';
        import { computeAlerts } from '/js/lib/alerts.js';
        const store = createStore(createApi()), router = createRouter();
        const inbox = createMailboxPage({ api: createApi(), store, router, direction: 'inbox' });
        const outbox = createMailboxPage({ api: createApi(), store, router, direction: 'outbox' });
        document.querySelector('#host').append(inbox.el, outbox.el);
        // Same state fan-out and page lifecycle as main.js. Unselected pages
        // remain mounted, and only the selected page receives onShow.
        store.subscribe(view => {
          window.harness.alerts = computeAlerts(view.snapshot, view.attention);
          inbox.onState(view); outbox.onState(view);
        });
        router.subscribe(route => {
          for (const ui of [inbox, outbox]) ui.el.classList.toggle('is-active', ui.el.id === route.page);
          ({ inbox, outbox })[route.page]?.onShow(route);
        });
        window.harness = { store, router, inbox, outbox, added: 0 };
        const seenCards = new WeakSet();
        new MutationObserver(changes => {
          for (const change of changes) for (const node of change.addedNodes) {
            if (node.nodeType !== 1) continue;
            const cards = [...node.querySelectorAll('.mailbox-card')];
            if (node.matches('.mailbox-card')) cards.push(node);
            for (const card of cards) if (!seenCards.has(card)) { seenCards.add(card); window.harness.added++; }
          }
        }).observe(document.querySelector('#host'), { childList: true, subtree: true });
        router.start(); await store.refresh(); window.harness.ready = true;
        </script></body></html>`); return;
    }
    try {
      const path = resolve('apps/web', '.' + url.pathname);
      if (!path.startsWith(resolve('apps/web') + '/')) throw new Error('path');
      res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : 'text/css');
      res.end(await readFile(path));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { mailboxGate?.release(); return new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }); });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/#agent`);
  await expect.poll(() => page.evaluate(() => (window as any).harness?.ready)).toBe(true);
  return { page, snapshot, calls, setMailbox(value: typeof mailbox) { mailbox = value; },
    gate() { mailboxGate = deferred(); return mailboxGate; },
    setPatch(handler: typeof patch) { patch = handler; } };
}
const cards = (page: Page, direction = 'inbox') => page.locator(`#${direction} .mailbox-card`);
const chip = (page: Page, label: string) => page.locator('#inbox').getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) });
const go = (page: Page, name: string) => page.evaluate(name => (window as any).harness.router.go(name), name);
const refresh = (page: Page) => page.evaluate(() => (window as any).harness.store.refresh());
const summary = (page: Page, direction = 'inbox') => page.locator(`#${direction} p[role="status"]`);
const writes = (calls: { method: string }[]) => calls.filter(c => c.method !== 'GET');
async function idleReads(page: Page, direction = 'inbox') {
  // A response marker avoids a timing assertion or arbitrary sleep.
  await page.evaluate(async direction => {
    const h = (window as any).harness;
    await new Promise<void>(resolve => {
      const original = window.fetch;
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (String(args[0]).includes(`/mailboxes?direction=${direction}`)) {
          await response.clone().json(); setTimeout(resolve, 0); window.fetch = original;
        }
        return response;
      };
      h[direction].onShow();
    });
  }, direction);
}

test('5000 条全量筛选与计数，DOM 初始 50、加载更多和精确搜索可达尾部，390px 无溢出', { timeout: 30000 }, async t => {
  const { page, calls } = await fixture(t);
  await expect(cards(page)).toHaveCount(0);
  await expect(cards(page, 'outbox')).toHaveCount(0);
  assert.equal(calls.some(c => c.path.startsWith('/mailboxes')), false, '首次进入 Agent 不应加载隐藏收件箱');
  await go(page, 'inbox'); await idleReads(page);
  await expect(cards(page)).toHaveCount(50);
  assert.equal(await page.evaluate(() => (window as any).harness.added), 50, '首次绘制只创建展示窗内的卡片');
  await expect(summary(page)).toHaveText('共 5000 条收件记录，显示 50 / 匹配 5000 条');
  for (const [label, count] of [['全部', 5000], ['私聊', 1250], ['群@我', 625], ['群聊', 1250], ['Agent协作', 1250], ['未识别', 1250]] as const) {
    await expect(page.locator('[aria-label="消息来源"]').getByRole('button', { name: new RegExp(`^${label}\\s*${count}$`) })).toBeVisible();
  }
  await expect(chip(page, '已处理')).toHaveText('已处理1000');
  await expect(page.getByLabel('收件项目', { exact: true }).locator('option[value="a"]')).toHaveText('项目甲 (2500)');
  await expect(cards(page).first()).toContainText('待人决策');
  await expect(page.getByRole('heading', { name: '离线消息-200', exact: true })).toHaveCount(0);
  await page.locator('#inbox').getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(cards(page)).toHaveCount(100);
  await expect(page.getByRole('heading', { name: '离线消息-200', exact: true })).toBeVisible();
  // Each filter dimension resets the display window, without truncating counts.
  await chip(page, '私聊').click(); await expect(cards(page)).toHaveCount(50);
  await expect(summary(page)).toContainText('匹配 1250 条');
  await page.locator('[aria-label="消息来源"]').getByRole('button', { name: /^全部/ }).click();
  await page.locator('#inbox').getByRole('button', { name: '加载更多', exact: true }).click();
  await chip(page, '已处理').click(); await expect(cards(page)).toHaveCount(50);
  await page.locator('[aria-label="处理阶段"]').getByRole('button', { name: /^全部/ }).click();
  await page.locator('#inbox').getByRole('button', { name: '加载更多', exact: true }).click();
  await page.getByLabel('收件项目', { exact: true }).selectOption('b'); await expect(cards(page)).toHaveCount(50);
  await page.getByLabel('收件项目', { exact: true }).selectOption('all');
  await page.locator('#inbox').getByRole('button', { name: '加载更多', exact: true }).click();
  await page.getByLabel('收件箱状态', { exact: true }).selectOption('fyi'); await expect(cards(page)).toHaveCount(50);
  await page.getByLabel('收件箱状态', { exact: true }).selectOption('all');
  await page.getByLabel('搜索收件箱', { exact: true }).fill('全量正文');
  await expect(summary(page)).toContainText('匹配 5000 条');
  await page.getByLabel('搜索收件箱', { exact: true }).fill('索引-4999-终');
  await expect(cards(page)).toHaveCount(1); await expect(cards(page)).toContainText('离线消息-4999');
  await expect(summary(page)).toContainText('显示 1 / 匹配 1 条');
  await expect(page.getByRole('button', { name: '加载更多', exact: true })).toBeHidden();
  await page.getByLabel('搜索收件箱', { exact: true }).fill('没有这个词');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(cards(page)).toHaveCount(50);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(writes(calls), []);
});

test('隐藏页快照与迟到读取不建卡片；可见快照复用卡片、只替换变化行，提醒仍读全量 state', { timeout: 30000 }, async t => {
  const f = await fixture(t); const { page } = f;
  f.snapshot.inbox[4996]!.tier = 'action';
  await refresh(page);
  await expect(cards(page)).toHaveCount(0);
  assert.equal(await page.evaluate(() => (window as any).harness.alerts.inbox.count), 1);
  const gate = f.gate();
  f.setMailbox([{ id: 'late', title: '迟到机器人记录', text: '离线', status: 'pending', updatedAt: '2026-11-18' }]);
  await go(page, 'inbox'); await expect(cards(page)).toHaveCount(50);
  await expect.poll(() => f.calls.filter(c => c.path === '/mailboxes?direction=inbox').length).toBe(1);
  await page.evaluate(() => { const h = (window as any).harness; h.first = document.querySelector('#inbox .mailbox-card'); h.added = 0; });
  await go(page, 'agent');
  const response = page.waitForResponse(r => r.url().includes('/mailboxes?direction=inbox'));
  gate.release(); await response;
  await refresh(page); // Allows the late JSON response and its paint to settle.
  assert.equal(await page.evaluate(() => (window as any).harness.added), 0);
  await expect(cards(page)).toHaveCount(50);
  await go(page, 'inbox'); await idleReads(page);
  await expect(summary(page)).toContainText('共 5001 条');
  await page.evaluate(() => { (window as any).harness.first = document.querySelector('#inbox .mailbox-card'); (window as any).harness.added = 0; });
  await refresh(page); await idleReads(page);
  assert.equal(await page.evaluate(() => (window as any).harness.first === document.querySelector('#inbox .mailbox-card')), true);
  assert.equal(await page.evaluate(() => (window as any).harness.added), 0, '等值新快照和读取不重建卡片');
  f.snapshot.inbox[0]!.text = '变化的一条离线正文';
  await refresh(page); await idleReads(page);
  assert.equal(await page.evaluate(() => (window as any).harness.added), 1, '只重建变化的卡片');
  assert.deepEqual(writes(f.calls), []);
});

test('规模下详情项目选择与草稿跨快照保留；409 保留各条草稿和独立版本，不自动重放', { timeout: 30000 }, async t => {
  const f = await fixture(t); const { page } = f;
  await go(page, 'inbox'); await idleReads(page);
  await cards(page).filter({ has: page.getByRole('heading', { name: '离线消息-0', exact: true }) }).getByRole('button', { name: '查看原文与详情' }).click();
  const drawer = page.getByRole('dialog', { name: '收件箱消息详情', exact: true });
  await drawer.getByLabel('归入项目', { exact: true }).selectOption('b');
  await refresh(page); await idleReads(page);
  await expect(drawer.getByLabel('归入项目', { exact: true })).toHaveValue('b');
  const gate = deferred(); t.after(() => gate.release());
  f.setPatch(async () => { await gate.promise; return { status: 409, body: { error: '离线版本冲突' } }; });
  await drawer.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect.poll(() => writes(f.calls).length).toBe(1);
  await drawer.locator('.drawer__foot').getByRole('button', { name: '关闭', exact: true }).click();
  await cards(page).filter({ has: page.getByRole('heading', { name: '离线消息-4', exact: true }) }).getByRole('button', { name: '查看原文与详情' }).click();
  await drawer.getByLabel('归入项目', { exact: true }).selectOption('b');
  f.snapshot.inbox[0]!.version = 2;
  const response = page.waitForResponse(r => r.request().method() === 'PATCH'); gate.release(); await response;
  await expect(drawer.getByRole('button', { name: '保存项目', exact: true })).toBeEnabled();
  await refresh(page); await idleReads(page);
  await expect(drawer.getByLabel('归入项目', { exact: true })).toHaveValue('b');
  await expect(drawer.getByRole('heading', { name: '离线消息-4', exact: true })).toBeVisible();
  await drawer.locator('.drawer__foot').getByRole('button', { name: '关闭', exact: true }).click();
  await cards(page).filter({ has: page.getByRole('heading', { name: '离线消息-0', exact: true }) }).getByRole('button', { name: '查看原文与详情' }).click();
  await expect(drawer.getByLabel('归入项目', { exact: true })).toHaveValue('b');
  assert.ok(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth));
  assert.deepEqual(writes(f.calls), [{ method: 'PATCH', path: '/inbox/scale-0/project', body: { version: 1, projectId: 'b' } }]);
  assert.equal(f.snapshot.inbox[0]!.projectId, 'a', '失败请求不伪造保存成功');
  f.setPatch((path, body) => {
    const index = Number(path.match(/scale-(\d+)/)![1]);
    const row = f.snapshot.inbox[index]!;
    assert.equal(body.version, row.version);
    Object.assign(row, { projectId: body.projectId, version: row.version + 1 });
    return { body: row };
  });
  // Only an explicit click retries A, using A's latest version, then saves B
  // with B's original version. A's late 409 must not alter B's draft/version.
  await drawer.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect.poll(() => f.snapshot.inbox[0]!.projectId).toBe('b');
  await expect(drawer.getByRole('button', { name: '保存项目', exact: true })).toBeEnabled();
  await drawer.locator('.drawer__foot').getByRole('button', { name: '关闭', exact: true }).click();
  await cards(page).filter({ has: page.getByRole('heading', { name: '离线消息-4', exact: true }) }).getByRole('button', { name: '查看原文与详情' }).click();
  await expect(drawer.getByLabel('归入项目', { exact: true })).toHaveValue('b');
  await drawer.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect.poll(() => f.snapshot.inbox[4]!.projectId).toBe('b');
  assert.deepEqual(writes(f.calls).slice(1), [
    { method: 'PATCH', path: '/inbox/scale-0/project', body: { version: 2, projectId: 'b' } },
    { method: 'PATCH', path: '/inbox/scale-4/project', body: { version: 1, projectId: 'b' } },
  ]);
});

test('5000 机器人收件按真实状态区分人、AI、处理中和已处理，项目统计不随展示窗截断', { timeout: 30000 }, async t => {
  const f = await fixture(t); const { page } = f;
  f.snapshot.inbox.length = 0;
  f.setMailbox(Array.from({ length: 5000 }, (_, i) => ({ id: `bot-${i}`, title: `离线机器人-${i}`, text: `机器人原文-${i}`,
    status: ['pending', 'ready', 'processing', 'completed'][i % 4], origin: { kind: 'agent' },
    scope: { kind: 'project', projectId: i % 2 ? 'b' : 'a' }, updatedAt: '2026-11-17' })));
  await refresh(page); await go(page, 'inbox'); await idleReads(page);
  await expect(cards(page)).toHaveCount(50);
  await expect(chip(page, 'Agent协作')).toHaveText('Agent协作5000');
  for (const label of ['待人决策', '待AI执行', '处理中', '已处理']) {
    await expect(chip(page, label)).toHaveText(`${label}1250`);
    await chip(page, label).click();
    await expect(cards(page)).toHaveCount(50);
    await expect(summary(page)).toContainText('匹配 1250 条');
  }
  await page.locator('[aria-label="处理阶段"]').getByRole('button', { name: /^全部/ }).click();
  await expect(page.getByLabel('收件项目', { exact: true }).locator('option[value="a"]')).toHaveText('项目甲 (2500)');
  await page.getByLabel('搜索收件箱', { exact: true }).fill('机器人原文-4999');
  await expect(cards(page)).toHaveCount(1);
  assert.deepEqual(writes(f.calls), []);
});

test('5000 机器人发件同样有界，确认与未知结果仅展示，筛选和加载不会发送', { timeout: 30000 }, async t => {
  const f = await fixture(t); const { page } = f;
  f.setMailbox(Array.from({ length: 5000 }, (_, i) => ({ id: `out-${i}`, title: `离线发件-${i}`, text: `待发正文-${i}`,
    status: i === 4999 ? 'unknown' : 'pending', target: 'offline-target', updatedAt: new Date(Date.UTC(2026, 10, 17) - i * 1000).toISOString() })));
  await go(page, 'outbox'); await idleReads(page, 'outbox');
  await expect(cards(page, 'outbox')).toHaveCount(50);
  await expect(summary(page, 'outbox')).toContainText('显示 50 / 匹配 5000 条');
  await page.locator('#outbox').getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(cards(page, 'outbox')).toHaveCount(100);
  await cards(page, 'outbox').first().getByRole('button', { name: '查看原文与详情' }).click();
  const drawer = page.getByRole('dialog', { name: '发件箱消息详情', exact: true });
  await expect(drawer).toContainText('尚未发送');
  await drawer.locator('.drawer__foot').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByLabel('发件箱状态', { exact: true }).selectOption('failed');
  await expect(cards(page, 'outbox')).toHaveCount(1);
  await cards(page, 'outbox').getByRole('button', { name: '查看原文与详情' }).click();
  await expect(drawer).toContainText('不会自动重复发送');
  await drawer.locator('.drawer__foot').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByLabel('发件箱状态', { exact: true }).selectOption('all');
  await expect(cards(page, 'outbox')).toHaveCount(50);
  await go(page, 'agent'); await refresh(page);
  await expect(cards(page)).toHaveCount(0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(writes(f.calls), []);
});
