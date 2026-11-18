// Chromium → 真实 HTTP → 临时 SQLite；只用显式来源元数据，不连接飞书、模型或 CLI。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect, type Locator, type Page } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { InboxItem, InboxThing, Project, Todo } from '../packages/protocol/src/index.ts';

const token = 'offline-inbox-filters-test-only';
const things: InboxThing[] = [
  { thread: 'direct-fyi', last: '1', title: '离线私聊知会', text: '周报已同步',
    origin: { kind: 'direct', connector: 'feishu', chatId: 'oc_direct_fixture', senderName: '离线甲' } },
  { thread: 'direct-archived', last: '1', title: '离线已归档私聊', text: '历史讨论内容', origin: { kind: 'direct' } },
  // 正文相同；只有精确个人 @ 元数据不同，不能根据 @ 字面内容判断。
  { thread: 'group-me', last: '1', title: '离线个人提及', text: '@某位同事 请核对离线报告',
    origin: { kind: 'group', chatName: '离线群甲', mentionedMe: true } },
  { thread: 'group-other', last: '1', title: '离线他人提及', text: '@某位同事 请核对离线报告',
    origin: { kind: 'group', chatName: '离线群乙', mentionedMe: false } },
  { thread: 'group-unverified', last: '1', title: '离线群普通消息', text: '@我 全员通知', origin: { kind: 'group' } },
  { thread: 'agent', last: '1', title: '离线协作回执', text: '离线协作结果', origin: { kind: 'agent', connector: 'fixture-agent' } },
  { thread: 'oc_unknown_fixture', last: '1', title: '群聊 @我 私聊标题不能推断来源', text: '@我 请核对未知来源' },
  { thread: 'unknown-explicit', last: '1', title: '离线明确未知', text: '普通内容', origin: { kind: 'unknown' } },
];

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-inbox-filters-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  // 必须早于 chromium.launch 注册；启动失败也清理服务与临时数据库。
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      try { await server?.close(); }
      finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  });
  server = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, token });
  const running = server;
  async function api<T>(path: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
    const response = await fetch(running.url + '/api/v1' + path, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`);
    return value as T;
  }
  function stored<T>(collection: string, id: string): T | undefined {
    const db = new DatabaseSync(join(dataDir, 'workbench.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT value FROM documents WHERE collection = ? AND id = ?').get(collection, id);
      return row ? JSON.parse(row.value as string) as T : undefined;
    } finally { db.close(); }
  }
  const project = await api<Project>('/projects', 'POST', { name: '离线收件归类项目' }, 201);
  const otherProject = await api<Project>('/projects', 'POST', { name: '离线另一项目' }, 201);
  await running.app.inbox.ingest('feishu:fixture', things);
  const item = (thread: string) => {
    const found = running.app.inbox.list().find(entry => entry.thread === thread);
    assert.ok(found, `缺少 fixture ${thread}`);
    return found;
  };
  const archived = item('direct-archived');
  await api(`/inbox/${archived.id}/archive`, 'POST', { version: archived.version });
  const pageErrors: string[] = [];
  async function open() {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${running.url}/#inbox?token=${token}`);
    await expect(page.locator('#inbox h1')).toHaveText('收件箱');
    return page;
  }
  t.after(() => assert.deepEqual(pageErrors, []));
  return { api, stored, project, otherProject, item, open, server: running };
}

const cards = (page: Page) => page.locator('#inbox .mailbox-card');
const card = (page: Page, title: string) => cards(page).filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const chip = (page: Page, name: string) => page.locator('#inbox').getByRole('button', { name: new RegExp(`^${name}(?:\\s|\\d|[（(]|$)`) });

// 只观察真实写请求与响应，不使用 route.fulfill 或替换任何新 API。
async function write(page: Page, control: Locator, path: string, method: string, status = 200) {
  const [response] = await Promise.all([
    page.waitForResponse(value => new URL(value.url()).pathname === '/api/v1' + path && value.request().method() === method),
    control.click(),
  ]);
  const body = await response.json();
  assert.equal(response.status(), status, `${method} ${path}: ${JSON.stringify(body)}`);
  return { body, request: response.request().postDataJSON() };
}

test('来源 chips 完整计数；个人 @ 只信元数据，不把他人 @、正文或 oc_ 前缀当证据', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  // 在浏览器启动前核对真实采集与 SQLite，避免 UI mock 掩盖来源丢失。
  for (const input of things) assert.deepEqual(f.stored<InboxItem>('inbox', f.item(input.thread).id)!.origin, input.origin);
  const page = await f.open();
  await expect(cards(page)).toHaveCount(things.length);
  for (const [label, count] of [['私聊', 2], ['群@我', 1], ['群聊', 3], ['Agent协作', 1], ['未识别', 2]] as const) {
    await expect(chip(page, label)).toHaveText(new RegExp(`^${label}\\s*${count}$`));
    await chip(page, label).click();
    await expect(cards(page)).toHaveCount(count);
  }
  await chip(page, '群@我').click();
  await expect(chip(page, '群@我')).toHaveAttribute('aria-pressed', 'true');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('离线群甲');
  await expect(cards(page)).not.toContainText('离线群乙');
  await expect(card(page, '离线群普通消息')).toHaveCount(0);
  await chip(page, '私聊').click();
  await expect(card(page, '离线私聊知会')).toBeVisible();
  await chip(page, '未识别').click();
  await expect(card(page, '群聊 @我 私聊标题不能推断来源')).toBeVisible();
});

test('待人决策优先于知会分拣；fyi 私聊仍可转待办，筛选不执行 AI', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.item('direct-fyi').tier, 'fyi');
  const beforeRuns = f.server.app.store.list('runs');
  const page = await f.open();
  await expect(cards(page)).toHaveCount(things.length);
  const decisions = (await cards(page).allTextContents()).map(text => text.includes('待人决策'));
  assert.deepEqual(decisions, [true, true, true, true, false, false, false, false], '待人决策必须排在列表最前');
  await chip(page, '待人决策').click();
  await chip(page, '私聊').click();
  await expect(cards(page)).toHaveCount(1);
  const direct = card(page, '离线私聊知会');
  await expect(direct).toContainText('知会');
  await expect(direct).toContainText('待人决策');
  await expect(direct.getByRole('button', { name: '转为待办', exact: true })).toBeVisible();
  assert.equal(f.server.app.todos().length, 0);
  assert.deepEqual(f.server.app.store.list('runs'), beforeRuns);
});

test('来源、状态、关键词与项目组合筛选；空结果清除恢复完整清单，390px 无横溢', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  const target = f.item('group-me');
  await f.api(`/inbox/${target.id}/project`, 'PATCH', { version: target.version, projectId: f.project.id });
  const extras = Array.from({ length: 13 }, (_, index): InboxThing => ({
    thread: `extra-${index}`, last: '1', title: `完整清单-${index}`, text: '离线长消息' + '长内容'.repeat(100), origin: { kind: 'unknown' },
  }));
  await f.server.app.inbox.ingest('feishu:fixture', extras);
  const page = await f.open();
  await expect(cards(page)).toHaveCount(things.length + extras.length);
  await chip(page, '群@我').click();
  await chip(page, '待人决策').click();
  await page.getByLabel('收件项目', { exact: true }).selectOption(f.project.id);
  await expect(cards(page)).toHaveCount(1);
  await page.getByLabel('收件项目', { exact: true }).selectOption(f.otherProject.id);
  await expect(cards(page)).toHaveCount(0);
  await page.getByLabel('收件项目', { exact: true }).selectOption(f.project.id);
  await page.getByLabel('搜索收件箱', { exact: true }).fill('离线报告');
  await expect(cards(page)).toHaveCount(1);
  await page.getByLabel('搜索收件箱', { exact: true }).fill('不存在的关键词');
  await expect(page.getByText('没有匹配的消息', { exact: true })).toBeVisible();
  await page.locator('#inbox').getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(cards(page)).toHaveCount(things.length + extras.length);
  await expect(card(page, '完整清单-12')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cards(page)).toHaveCount(things.length + extras.length);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('已归档消息可以归入项目；归类保留归档、原文和分拣，不复活、不执行 AI', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  const archived = f.item('direct-archived');
  const beforeRuns = f.server.app.store.list('runs');
  const page = await f.open();
  await page.getByLabel('收件箱状态', { exact: true }).selectOption('archived');
  await card(page, archived.title).getByRole('button', { name: '查看原文与详情', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '收件箱消息详情', exact: true });
  await drawer.getByLabel('归入项目', { exact: true }).selectOption(f.project.id);
  await write(page, drawer.getByRole('button', { name: '保存项目', exact: true }), `/inbox/${archived.id}/project`, 'PATCH');
  const saved = f.stored<InboxItem>('inbox', archived.id)!;
  assert.equal(saved.projectId, f.project.id);
  assert.equal(saved.archivedAt, archived.archivedAt);
  assert.equal(saved.text, archived.text);
  assert.equal(saved.tier, archived.tier);
  assert.equal(saved.todoId, undefined);
  assert.equal(f.server.app.todos().length, 0);
  assert.deepEqual(f.server.app.store.list('runs'), beforeRuns);
  await drawer.locator('.drawer__foot').getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await page.getByLabel('收件箱状态', { exact: true }).selectOption('archived');
  await expect(card(page, archived.title)).toContainText(f.project.name);
});

test('归入项目后转待办继承项目；刷新和重复确认均不重复创建', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  const input = f.item('direct-fyi');
  const page = await f.open();
  await card(page, input.title).getByRole('button', { name: '查看原文与详情', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '收件箱消息详情', exact: true });
  await drawer.getByLabel('归入项目', { exact: true }).selectOption(f.project.id);
  await write(page, drawer.getByRole('button', { name: '保存项目', exact: true }), `/inbox/${input.id}/project`, 'PATCH');
  const classified = f.stored<InboxItem>('inbox', input.id)!;
  assert.equal(classified.projectId, f.project.id);
  assert.equal(classified.archivedAt, undefined, '归类不能代替归档或确认');
  assert.equal(f.server.app.todos().length, 0);
  const confirmed = await write(page, drawer.getByRole('button', { name: '转为待办', exact: true }), `/inbox/${input.id}/confirm`, 'POST', 201);
  await expect(drawer.getByRole('link', { name: '查看待办', exact: true })).toBeVisible();
  const saved = f.stored<InboxItem>('inbox', input.id)!;
  assert.ok(saved.todoId);
  assert.ok(saved.archivedAt);
  assert.equal(f.stored<Todo>('todos', saved.todoId)!.projectId, f.project.id);
  assert.equal(f.stored<Todo>('todos', saved.todoId)!.title, input.title);
  await f.api(`/inbox/${input.id}/confirm`, 'POST', confirmed.request, 409);
  assert.equal(f.server.app.todos().length, 1);
  await page.reload();
  await card(page, input.title).getByRole('button', { name: '查看原文与详情', exact: true }).click();
  await expect(drawer.getByRole('link', { name: '查看待办', exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: '转为待办', exact: true })).toHaveCount(0);
  assert.equal(f.server.app.todos().length, 1);
  assert.equal(f.server.app.store.list('runs').length, 0);
});
