import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('Web 保存标签筛选顺序与空选择，同一机器人可恢复自动显示', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-label-choice-'));
  let adapter!: FeishuOptions;
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, demo: true, token: 'fixture' }, {
    botFactory(options) {
      adapter = options;
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }), async send() {} };
    },
  });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const bot = await server.bots.create({ name: '筛选测试', appId: 'cli_3333333333333333', appSecret: 'fixture', scope: { kind: 'global' } });
  await adapter.onMessage(bot.pairingCode!, { messageId: 'pair', chatId: 'private', senderId: 'owner', senderType: 'user', chatType: 'p2p' });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url + '/#agent?token=fixture');
  await page.getByRole('button', { name: '独立对话记录' }).click();
  const history = page.getByRole('dialog', { name: '独立对话记录' });
  const prefs = page.getByRole('dialog', { name: '管理标签筛选' });
  const open = () => history.getByRole('button', { name: '管理标签筛选' }).click();
  const read = async () => (await fetch(server.url + '/api/v1/feishu/bots/' + bot.id + '/threads/tags',
    { headers: { authorization: 'Bearer fixture' } })).json();
  await open();
  for (const tag of ['周报', '验收']) {
    await prefs.getByLabel('新筛选标签').fill(tag);
    await prefs.getByRole('button', { name: '添加筛选', exact: true }).click();
  }
  await prefs.getByRole('button', { name: '上移 验收' }).click();
  await prefs.getByRole('button', { name: '保存筛选顺序' }).click();
  await expect(prefs).not.toBeVisible();
  assert.deepEqual((await read()).filters, ['验收', '周报']);
  await open();
  for (const tag of ['周报', '验收']) await prefs.getByRole('button', { name: '移除 ' + tag }).click();
  await prefs.getByRole('button', { name: '保存筛选顺序' }).click();
  await expect(prefs).not.toBeVisible();
  assert.deepEqual((await read()).filters, []);
  await open();
  await prefs.getByRole('button', { name: '自动显示已使用标签' }).click();
  await expect(prefs).not.toBeVisible();
  assert.equal((await read()).filters, null);
});
