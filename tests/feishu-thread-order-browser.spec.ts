import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('Web 调整独立对话顺序可取消、保存，以及恢复按最近活动排序', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-order-ui-'));
  let receiver!: FeishuOptions;
  const replies: string[] = [];
  const token = 'fixture-order';
  const server = await startServer({ host: '127.0.0.1', port: 0, demo: true, token, dataDir }, {
    botFactory(options) {
      receiver = options;
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
        async send(_target, text) { replies.push(text); } };
    },
  });
  t.after(async () => { try { await server.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const bot = await server.bots.create({ appId: 'cli_9999999999999999', appSecret: 'fixture-app', name: '排序验收',
    scope: { kind: 'global' }, requireConfirmation: false });
  const send = (text: string, messageId: string) => receiver.onMessage(text, {
    messageId, senderId: 'owner', chatId: 'private', chatType: 'p2p', senderType: 'user',
  });
  await send(bot.pairingCode!, 'pair');
  for (const title of ['先讨论的甲', '后讨论的乙']) {
    await send('/new ' + title, title);
    await t.waitFor(() => assert.ok(replies.some(text => text.includes(title))));
  }
  const endpoint = server.url + '/api/v1/feishu/bots/' + bot.id + '/threads';
  const headers = { authorization: 'Bearer ' + token };
  const initial = await (await fetch(endpoint, { headers })).json() as Array<{ title: string; threadId: string }>;
  assert.deepEqual(initial.map(row => row.title), ['后讨论的乙', '先讨论的甲']);
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url + '/#agent?token=' + token);
  await page.locator('#agent-bot .row').filter({ hasText: '排序验收' }).getByRole('button', { name: '独立对话记录' }).click();
  const drawer = page.getByRole('dialog', { name: '独立对话记录' });
  const editor = page.getByRole('dialog', { name: '调整对话顺序' });
  const titles = drawer.getByRole('button', { name: /先讨论的甲|后讨论的乙/ });
  const open = drawer.getByRole('button', { name: '调整对话顺序' });
  await open.click();
  await editor.getByRole('button', { name: '上移 先讨论的甲' }).click();
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(titles.first()).toContainText('后讨论的乙');
  await open.click();
  const rows = editor.getByRole('listitem');
  await rows.filter({ hasText: '先讨论的甲' }).dragTo(rows.filter({ hasText: '后讨论的乙' }));
  await expect(rows.first()).toContainText('先讨论的甲');
  await editor.getByRole('button', { name: '保存顺序' }).click();
  await expect(editor).not.toBeVisible();
  await expect(titles.first()).toContainText('先讨论的甲');
  const manual = await (await fetch(endpoint + '/order', { headers })).json();
  assert.deepEqual(manual.order, [initial[1].threadId, initial[0].threadId]);
  await open.click();
  await editor.getByRole('button', { name: '恢复按最近活动' }).click();
  await expect(editor).not.toBeVisible();
  await expect(titles.first()).toContainText('后讨论的乙');
  assert.deepEqual((await (await fetch(endpoint + '/order', { headers })).json()).order, []);
  await open.click();
  await editor.getByRole('button', { name: '保存顺序' }).click();
  await expect(editor).not.toBeVisible();
  const archive = await fetch(endpoint + '/' + initial[0].threadId, { method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ version: 0, archived: true }) });
  assert.equal(archive.status, 200);
  await open.click();
  await expect(rows).toHaveCount(1);
  await editor.getByRole('button', { name: '保存顺序' }).click();
  await expect(editor).not.toBeVisible();
  assert.deepEqual((await (await fetch(endpoint + '/order', { headers })).json()).order, [initial[1].threadId, initial[0].threadId]);
});
