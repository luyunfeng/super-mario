import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

async function fixture(t: TestContext, botIds: string[]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-command-group-web-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, demo: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  const bots = botIds.map(id => ({ id, name: id, enabled: true, configured: true, scope: { kind: 'global' } }));
  await page.route('**/api/v1/feishu/bots', route => route.fulfill({ json: bots }));
  return { page, card: page.locator('#agent-command-group'), open: (route = '#agent') => page.goto(server.url + '/' + route) };
}

const empty = { status: 'not_created', members: [], canRetry: true };
const main = { botId: 'main', appId: 'main-app', name: '全局助手', status: 'joined' };
const project = { botId: 'web', appId: 'web-app', name: '网页助手', projectId: 'web-project', status: 'unknown' };

test('用户创建总指挥群并重试部分失败的成员，刷新只读取状态', async t => {
  const { page, card, open } = await fixture(t, ['main']);
  const calls: unknown[] = [];
  let attempts = 0, reads = 0;
  const partial = { chatId: 'oc_test', mainBotId: 'main', status: 'partial', canRetry: true,
    members: [main, { ...project, status: 'failed', reason: '应用不可用' }, { ...project, botId: 'other', name: '测试助手', reason: '等待飞书确认' }] };
  const ready = { ...partial, status: 'ready', members: [main, { ...project, status: 'joined' }] };
  let release!: () => void;
  const waitForReply = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/feishu/command-group', async route => {
    if (route.request().method() === 'GET') {
      reads++;
      return route.fulfill({ json: attempts ? ready : empty });
    }
    assert.equal(route.request().method(), 'POST');
    calls.push(route.request().postDataJSON());
    if (++attempts === 1) await waitForReply;
    await route.fulfill({ json: attempts === 1 ? partial : ready });
  });
  await page.setViewportSize({ width: 390, height: 500 });
  await open('#agent/command-group');
  await expect(card.getByRole('heading', { name: '飞书总指挥群' })).toBeInViewport();
  await expect(card).toContainText('只有已入群且已配对的项目机器人才能处理任务');
  await expect(card).toContainText('由主 Agent 识别消息属于哪个项目');
  await expect(card).toContainText('接收群内全部消息的权限，并发布新版本');
  await expect(card).toContainText('项目机器人可继续只接收群内 @ 自己的消息');
  await expect(page.locator('#agent-bot + #agent-command-group')).toBeVisible();
  await expect(card).toContainText('尚未创建');
  assert.deepEqual(calls, []);
  await card.getByRole('button', { name: '创建总指挥群' }).click();
  await expect(card.getByRole('button', { name: '正在提交…' })).toBeDisabled();
  release();
  const row = (name: string) => card.getByRole('listitem').filter({ hasText: name });
  await expect(row('全局助手')).toContainText('已加入');
  await expect(row('网页助手')).toContainText('加入失败');
  await expect(row('网页助手')).toContainText('应用不可用');
  await expect(row('测试助手')).toContainText('加入结果未知');
  await expect(row('测试助手')).toContainText('等待飞书确认');
  await card.getByRole('button', { name: '重试' }).click();
  await expect(row('网页助手')).toContainText('已加入');
  await card.getByRole('button', { name: '同步成员' }).click();
  await expect(card.getByRole('button', { name: '同步成员' })).toBeEnabled();
  const previous = reads;
  await card.getByRole('button', { name: '刷新群状态' }).click();
  await expect.poll(() => reads).toBe(previous + 1);
  assert.deepEqual(calls, [{}, {}, {}]);
});

test('多个全局机器人须先选择；失败显示原因，未知操作按后端标记限制重试', async t => {
  const { page, card, open } = await fixture(t, ['main-A', 'main-B']);
  let gets = 0;
  const posts: unknown[] = [];
  await page.route('**/api/v1/feishu/command-group', async route => {
    if (route.request().method() === 'GET') {
      gets++;
      if (gets === 1) return route.fulfill({ status: 503, json: { error: '暂时无法读取' } });
      return route.fulfill({ json: posts.length ? {
        status: 'unknown', mainBotId: 'main-B', canRetry: false, members: [], reason: '建群结果未知，已超过去重时限',
      } : empty });
    }
    posts.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, json: { error: '飞书请求超时' } });
  });
  await open();
  await expect(card.getByRole('alert')).toContainText('暂时无法读取');
  await card.getByRole('button', { name: '刷新群状态' }).click();
  const create = card.getByRole('button', { name: '创建总指挥群' });
  await expect(create).toBeDisabled();
  await card.getByRole('combobox').selectOption('main-B');
  await create.click();
  await expect(card.getByRole('alert')).toContainText('飞书请求超时');
  await expect(create).toBeDisabled();
  await card.getByRole('button', { name: '刷新群状态' }).click();
  await expect(card).toContainText('已超过去重时限');
  await expect(card.getByRole('button', { name: '重试' })).toBeDisabled();
  assert.deepEqual(posts, [{ mainBotId: 'main-B' }]);
});
