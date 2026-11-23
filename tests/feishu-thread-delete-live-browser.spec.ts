import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect, type Page } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('跨窗口删除清除旧详情，保留其他草稿，重连核对漏收的删除', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-delete-live-'));
  const token = 'offline-live';
  let client!: FeishuOptions;
  const replies: string[] = [];
  const server = await startServer({ host: '127.0.0.1', port: 0, demo: true, token, dataDir }, {
    botFactory(options) {
      client = options;
      return { async start() {}, async close() {}, async collect() { return []; },
        status: () => ({ connected: true }), async send(_to, text) { replies.push(text); } };
    },
  });
  t.after(async () => { try { await server.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const bot = await server.bots.create({ appId: 'cli_8888888888888888', appSecret: 'fixture', name: '合成机器人',
    scope: { kind: 'global' }, requireConfirmation: false });
  const send = (text: string, messageId: string) => client.onMessage(text,
    { messageId, senderId: 'sender', chatId: 'chat', chatType: 'p2p', senderType: 'user' });
  await send(bot.pairingCode!, 'pair');
  for (const title of ['甲主题', '乙主题', '丙主题']) {
    await send('/new ' + title, title);
    await t.waitFor(() => assert.ok(replies.some(reply => reply.includes(title))));
  }
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const drawer = (p: Page) => p.getByRole('dialog', { name: '独立对话记录' });
  const confirmation = (p: Page) => p.getByRole('dialog', { name: '删除独立对话' });
  async function openDrawer(page: Page) {
    await page.goto(server.url + '/#agent?token=' + token);
    await page.locator('#agent-bot .row').filter({ hasText: bot.name }).getByRole('button', { name: '独立对话记录' }).click();
  }
  const [writer, viewing, other, searching] = await Promise.all(Array.from({ length: 4 }, () => browser.newPage()));
  // Drop event frames in one window, then close its actual socket to exercise reconnection.
  await other.addInitScript(() => {
    const w = window as typeof window & { drop?: boolean; liveSocket?: WebSocket };
    window.WebSocket = class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        w.liveSocket = this;
        this.addEventListener('message', event => { if (w.drop) event.stopImmediatePropagation(); });
      }
    };
  });
  await Promise.all([writer, viewing, other, searching].map(openDrawer));
  for (const p of [writer, viewing]) {
    await drawer(p).getByRole('button', { name: /甲主题/ }).click();
    await drawer(p).getByRole('button', { name: '删除对话' }).click();
  }
  await drawer(other).getByRole('button', { name: /乙主题/ }).click();
  await drawer(other).getByLabel('对话标题').fill('保留此草稿');
  await drawer(searching).getByLabel('搜索独立对话').fill('甲主题');
  await drawer(searching).getByRole('button', { name: '搜索', exact: true }).click();
  await expect(drawer(searching).getByRole('button', { name: /甲主题/ }).first()).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await writer.route('**/threads/*', async route => {
      if (route.request().method() !== 'DELETE') return route.continue();
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    await confirmation(writer).getByRole('button', { name: '确认删除' }).click();
    await expect(confirmation(viewing)).not.toBeVisible();
    await expect(drawer(viewing)).toContainText('此前已被删除');
    await expect(drawer(searching)).toContainText('没有找到匹配的独立对话');
    await expect(drawer(other).getByLabel('对话标题')).toHaveValue('保留此草稿');
    await expect(drawer(writer)).toContainText('正在删除');
  } finally { release(); }
  await expect(drawer(writer)).toContainText('已删除独立对话。');
  await other.evaluate(() => { (window as typeof window & { drop: boolean }).drop = true; });
  await drawer(writer).getByRole('button', { name: /乙主题/ }).click();
  await drawer(writer).getByRole('button', { name: '删除对话' }).click();
  await confirmation(writer).getByRole('button', { name: '确认删除' }).click();
  await expect(drawer(writer)).toContainText('已删除独立对话。');
  await expect(drawer(other).getByLabel('对话标题')).toHaveValue('保留此草稿');
  await other.evaluate(() => {
    const w = window as typeof window & { drop: boolean; liveSocket: WebSocket };
    w.drop = false;
    w.liveSocket.close();
  });
  await expect(drawer(other)).toContainText('此前已被删除', { timeout: 10000 });
  await expect(drawer(other).getByRole('button', { name: /丙主题/ })).toBeVisible();
});
