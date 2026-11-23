import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('Agent 页显示配对机器人最新工作台置顶回执', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-pinned-browser-'));
  let receiver!: FeishuOptions;
  const pinned: string[] = [];
  let messages = 0, rejected = false;
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token: 'board-test-token' }, {
    botFactory(options) {
      receiver = options;
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
        async send(_target, _text, context) { context?.onSent?.('card-' + ++messages, context.card ? 'interactive' : 'text'); },
        async pinMessage(id: string) {
          if (rejected) throw Object.assign(new Error('fixture denied'), { delivery: 'no' });
          pinned.push(id);
        }, async unpinMessage() {}, async recallMessage() {}, async updateCard() {} };
    },
  });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const bot = await server.bots.create({ name: '合成工作台助手', appId: 'cli_3333333333333333', appSecret: 'fixture', scope: { kind: 'global' } });
  const source = { chatType: 'p2p', chatId: 'private-chat', senderType: 'user', senderId: 'owner' } as const;
  const send = (text: string, messageId: string) => receiver.onMessage(text, { ...source, messageId });
  await send(bot.pairingCode!, 'pair');
  const page = await browser.newPage();
  await page.goto(server.url + '/#agent?token=board-test-token');
  const panel = page.locator('#agent-bot');
  await expect(panel).toContainText('暂无工作台置顶回执');
  await send('/home', 'first');
  await expect(panel).toContainText('工作台置顶已确认');
  assert.equal(pinned.length, 1);
  rejected = true;
  await send('/home', 'second');
  await expect(panel).toContainText('工作台置顶未确认');
  assert.equal(pinned.length, 1);
});
