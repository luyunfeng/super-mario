import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('在 Web 机器人卡片打开读群记录、翻页并刷新已撤回的结果', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-read-records-ui-'));
  let botApi!: FeishuOptions;
  const host = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, token: 'fixture' }, {
    readGroup: { account: () => 'binding', async run(input) { return '群内已送达结论-' + input.messageId; } },
    botFactory(opts) {
      botApi = opts;
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
        async send(_target, _text, ctx) { ctx?.onSent?.('om_reply_' + ctx.replyTo, 'text'); } };
    },
  });
  t.after(async () => { try { await host.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const bot = await host.bots.create({ name: '读群验收机器人', appId: 'cli_4444444444444444', appSecret: 'fixture-only',
    scope: { kind: 'global' }, readGroup: true });
  await botApi.onMessage(bot.pairingCode!, { chatType: 'p2p', chatId: 'oc_owner', senderId: 'ou_owner', senderType: 'user', messageId: 'pair' });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(host.url + '/#agent?token=fixture');
  await page.locator('#agent-bot .row').filter({ hasText: '读群验收机器人' }).getByRole('button', { name: '读群记录', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '读群记录', exact: true });
  await expect(drawer).toContainText('暂无读群记录');
  for (let i = 0; i < 21; i++) {
    const id = 'case-' + String(i).padStart(2, '0');
    await botApi.onMessage('/读群 合成请求-' + id, { chatType: 'group', chatId: 'oc_fixture', senderId: 'ou_owner',
      senderType: 'user', messageId: id, mentionedSelf: true });
  }
  await drawer.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(drawer).toContainText('合成请求-case-20');
  await expect(drawer).toContainText('群内已送达结论-case-20');
  await expect(drawer).toContainText('已送达');
  await expect(drawer).not.toContainText('合成请求-case-00');
  await drawer.getByRole('button', { name: '加载更早记录' }).click();
  await expect(drawer).toContainText('群内已送达结论-case-00');
  botApi.onRecall!('oc_fixture', 'case-20');
  await drawer.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(drawer).toContainText('已撤回');
  await expect(drawer).not.toContainText('群内已送达结论-case-20');
  await expect(drawer).not.toContainText('合成请求-case-20');
  await expect(drawer).toContainText('群内已送达结论-case-19');
});
