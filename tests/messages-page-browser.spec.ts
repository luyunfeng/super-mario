import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

// The messages page lists the owner's independent conversations across every paired bot,
// and opens one of them in the existing thread drawer.
test('消息页列出所有机器人的独立对话，能检索、切归档、打开', { timeout: 90000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-messages-browser-'));
  const clients = new Map<string, { onMessage(text: string, context: object): Promise<unknown> }>();
  const token = 'offline-browser';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token }, {
    botFactory(opts) {
      const options = opts as unknown as { appId: string };
      clients.set(options.appId, opts as unknown as { onMessage(text: string, context: object): Promise<unknown> });
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
        async readPrivateForward() { return '合成聊天记录正文'; },
        async readPrivateImage() { return { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }; },
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
    await send(bot.pairingCode!, 'pair-' + appId);
    return { bot, send };
  };
  const input = async (text: string) => t.waitFor(() => {
    const m = server.app.store.list<Message>('messages').find(m => m.role === 'user' && m.text === text && m.status === 'done');
    assert.ok(m); return m;
  });
  const first = await create('合成甲', 'cli_5555555555555555');
  const second = await create('合成乙', 'cli_6666666666666666');
  await first.send('/new 消息页核对甲', 'first');
  await input('消息页核对甲');
  await second.send('/new 消息页核对乙', 'second');
  await input('消息页核对乙');
  await second.send('接着聊预算', 'second-more');
  await input('接着聊预算');
  const page = await browser.newPage();
  await page.goto(server.url + '/#messages?token=' + token);
  const nav = page.locator('nav');
  await expect(nav.getByRole('link', { name: /消息/ })).toBeVisible();
  await expect(page.locator('#page-messages')).toContainText('共 2 个对话');
  const items = page.locator('#page-messages .item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('合成乙');
  await expect(items.nth(0)).toContainText('消息页核对乙');
  await expect(items.nth(1)).toContainText('合成甲');
  await page.getByRole('searchbox', { name: '检索独立对话' }).fill('预算');
  await expect(page.locator('#page-messages')).toContainText('共 1 个对话');
  await expect(items).toHaveCount(1);
  await expect(items.nth(0)).toContainText('合成乙');
  await page.getByRole('searchbox', { name: '检索独立对话' }).fill('');
  await expect(page.locator('#page-messages')).toContainText('共 2 个对话');
  await page.getByRole('button', { name: '已归档' }).click();
  await expect(page.locator('#page-messages')).toContainText('没有已归档的对话');
  await page.getByRole('button', { name: '进行中' }).click();
  await expect(page.locator('#page-messages')).toContainText('共 2 个对话');
  await items.nth(1).getByRole('button', { name: /消息页核对甲/ }).click();
  const drawer = page.getByRole('dialog', { name: '独立对话记录' });
  await expect(drawer).toContainText('合成甲');
  await expect(drawer.locator('section').first()).toContainText('消息页核对甲');
  await drawer.getByRole('button', { name: '关闭' }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator('#page-messages [role="status"]')).toHaveText('共 2 个对话。');
  // Let the compositor catch up, so that the picture shows the status the assertion just read.
  const nextFrames = () => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  await page.evaluate(nextFrames);
  await page.screenshot({ path: 'docs/evidence/workbench-experience/messages-page.png' });
});

