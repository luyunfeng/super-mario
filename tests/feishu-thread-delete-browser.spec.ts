import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('Web 从详情取消或确认删除，成功后列表移除且旧详情返回已删除', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-remove-ui-'));
  let receiver!: FeishuOptions;
  const replies: string[] = [];
  const token = 'fixture-delete';
  const server = await startServer({ host: '127.0.0.1', port: 0, demo: true, token, dataDir }, {
    botFactory(options) {
      receiver = options;
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
        async send(_target, text) { replies.push(text); } };
    },
  });
  t.after(async () => { try { await server.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const bot = await server.bots.create({ appId: 'cli_9999999999999999', appSecret: 'fixture-app', name: '删除验收',
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
  await page.locator('#agent-bot .row').filter({ hasText: '删除验收' }).getByRole('button', { name: '独立对话记录' }).click();
  const drawer = page.getByRole('dialog', { name: '独立对话记录' });
  const confirmation = page.getByRole('dialog', { name: '删除独立对话' });
  const requests: string[] = [];
  page.on('request', request => {
    if (request.method() === 'DELETE') requests.push(new URL(request.url()).pathname);
  });
  const target = initial.find(row => row.title === '先讨论的甲')!;
  assert.ok(target);
  await drawer.getByRole('button', { name: /先讨论的甲/ }).click();
  const remove = drawer.getByRole('button', { name: '删除对话', exact: true });
  await remove.click();
  await expect(confirmation).toContainText('先讨论的甲');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  assert.deepEqual(requests, []);
  assert.equal((await fetch(endpoint + '/' + target.threadId, { headers })).status, 200);
  await remove.click();
  await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(drawer).toContainText('已删除独立对话。');
  await expect(drawer.getByRole('button', { name: /先讨论的甲/ })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: /后讨论的乙/ })).toBeVisible();
  assert.deepEqual(requests, [new URL(endpoint).pathname + '/' + target.threadId]);
  assert.equal((await fetch(endpoint + '/' + target.threadId, { headers })).status, 410);
});
