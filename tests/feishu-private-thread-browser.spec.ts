import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('Web 从当前机器人打开独立对话，核对其正文和机器人归属', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-private-browser-'));
  const clients = new Map<string, FeishuOptions>();
  const token = 'offline-browser';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token }, {
    botFactory(opts) {
      clients.set(opts.appId, opts);
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
        async send() {} };
    },
  });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const create = async (name: string, appId: string) => {
    const bot = await server.bots.create({ name, appId, appSecret: 'fixture', scope: { kind: 'global' }, requireConfirmation: false });
    const send = (text: string, messageId: string) => clients.get(appId)!.onMessage(text,
      { messageId, senderType: 'user', senderId: name, chatId: 'chat-' + name, chatType: 'p2p' });
    await send(bot.pairingCode!, 'pair');
    return { bot, send };
  };
  const first = await create('合成甲', 'cli_3333333333333333');
  const second = await create('合成乙', 'cli_4444444444444444');
  await second.send('/new 其他机器人的讨论', 'second');
  await first.send('/new 核对独立方案', 'first');
  const base = '/api/v1/feishu/bots/';
  const get = (path: string) => fetch(server.url + path, { headers: { authorization: 'Bearer ' + token } });
  let thread = '';
  await t.waitFor(async () => {
    const res = await get(base + first.bot.id + '/threads');
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.equal(rows.length, 1);
    thread = rows[0].threadId;
  });
  assert.equal((await get(base + second.bot.id + '/threads/' + thread)).status, 404);
  assert.equal((await fetch(server.url + base + first.bot.id + '/threads')).status, 401);
  const page = await browser.newPage();
  const clipboardWrites: string[] = [];
  await page.exposeFunction('captureThreadClipboard', (text: string) => { clipboardWrites.push(text); });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: (text: string) => (window as unknown as { captureThreadClipboard(value: string): Promise<void> }).captureThreadClipboard(text),
    } });
  });
  await page.goto(server.url + '/#agent?token=' + token);
  const row = page.locator('#agent-bot .row').filter({ has: page.getByText('合成甲', { exact: true }) });
  await row.getByRole('button', { name: '独立对话记录' }).click();
  const drawer = page.getByRole('dialog', { name: '独立对话记录' });
  await drawer.getByRole('button', { name: /核对独立方案/ }).click();
  await expect(drawer.locator('section').first()).toContainText('核对独立方案');
  await expect(drawer).not.toContainText('其他机器人的讨论');
  await drawer.getByRole('button', { name: '复制对话 ID' }).click();
  await expect(drawer).toContainText('已复制对话 ID。');
  assert.deepEqual(clipboardWrites, [thread]);
  await drawer.getByRole('button', { name: '查看当前配置的模型清单' }).click();
  await expect(drawer).toContainText('演示模式');
  await drawer.getByRole('button', { name: '返回列表' }).click();
  await expect(drawer.getByRole('button', { name: /核对独立方案/ })).toBeVisible();
  await drawer.getByRole('button', { name: /核对独立方案/ }).click();
  await drawer.getByRole('textbox', { name: '对话标题' }).fill('归档核验方案');
  await drawer.getByRole('button', { name: '保存标题' }).click();
  await expect(drawer.getByRole('heading', { name: '归档核验方案' })).toBeVisible();
  await drawer.getByRole('button', { name: '归档对话' }).click();
  await expect(drawer.getByRole('button', { name: '恢复对话' })).toBeVisible();
  await drawer.getByRole('button', { name: '返回列表' }).click();
  await expect(drawer.getByRole('button', { name: /归档核验方案/ })).toBeVisible();
  await drawer.getByRole('button', { name: '未归档', exact: true }).click();
  await expect(drawer.getByRole('button', { name: /归档核验方案/ })).toHaveCount(0);
  await drawer.getByRole('button', { name: '已归档', exact: true }).click();
  await drawer.getByRole('button', { name: /归档核验方案/ }).click();
  await drawer.getByRole('button', { name: '恢复对话' }).click();
  await expect(drawer.getByRole('button', { name: '归档对话' })).toBeVisible();
  const saved = await (await get(base + first.bot.id + '/threads/' + thread)).json();
  assert.equal(saved.title, '归档核验方案');
  assert.equal(saved.archived, false);
  const changedElsewhere = await fetch(server.url + base + first.bot.id + '/threads/' + thread, {
    method: 'PATCH', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ version: saved.version, title: '另一个页面的新标题' }),
  });
  assert.equal(changedElsewhere.status, 200);
  await drawer.getByRole('textbox', { name: '对话标题' }).fill('不应覆盖的新标题');
  await drawer.getByRole('button', { name: '保存标题' }).click();
  await expect(drawer).toContainText('已在别处修改');
  await expect(drawer.getByRole('heading', { name: '另一个页面的新标题' })).toBeVisible();
  await drawer.getByRole('button', { name: '还原默认标题' }).click();
  await expect(drawer.getByRole('heading', { name: '核对独立方案' })).toBeVisible();
  await server.bots.update(first.bot.id, { enabled: false });
  await expect(drawer).not.toBeVisible();
  assert.equal((await get(base + first.bot.id + '/threads/' + thread)).status, 404);
});
