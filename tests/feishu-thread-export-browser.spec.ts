import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('Web 将飞书独立对话的完整历史复制并下载，临时错误可重试', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-thread-export-ui-'));
  let receiver!: FeishuOptions;
  const replies: string[] = [];
  const token = 'synthetic-export';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, token, demo: true }, {
    botFactory(opts) {
      receiver = opts;
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
        async send(_target, text) { replies.push(text); } };
    },
  });
  t.after(async () => { try { await server.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const bot = await server.bots.create({ name: '导出验收', appId: 'cli_4444444444444444', appSecret: 'fixture',
    scope: { kind: 'global' }, requireConfirmation: false });
  const send = (text: string, messageId: string) => receiver.onMessage(text, {
    messageId, senderId: 'owner', chatId: 'private', senderType: 'user', chatType: 'p2p',
  });
  await send(bot.pairingCode!, 'pair');
  for (const title of ['独立导出甲', '其他会话乙']) {
    await send('/new ' + title, title);
    await t.waitFor(() => assert.ok(replies.some(text => text.includes(title))));
  }
  const store = server.app.store;
  const source = store.list<Message>('messages').find(m => m.role === 'user' && m.text === '独立导出甲')!;
  const route = store.get('message.routes', source.id)!;
  const history = Array.from({ length: 45 }, (_, i) => '合成发言-' + String(i + 1).padStart(3, '0'));
  for (const [i, text] of history.entries()) {
    const id = 'long-history-' + i;
    store.put('messages', id, { ...source, id, text, createdAt: new Date(Date.now() + 60000 + i).toISOString() });
    store.put('message.routes', id, route);
  }
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.goto(server.url + '/#agent?token=' + token);
  await page.locator('#agent-bot .row').filter({ hasText: '导出验收' }).getByRole('button', { name: '独立对话记录' }).click();
  const drawer = page.getByRole('dialog', { name: '独立对话记录' });
  await drawer.getByRole('button', { name: /独立导出甲/ }).click();
  await expect(drawer.getByText(history[0], { exact: true })).toHaveCount(0);
  const lastMessage = drawer.locator('section').filter({has:page.getByText(history.at(-1)!, {exact:true})}).last();
  await lastMessage.getByRole('button', {name:'复制正文'}).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(history.at(-1));
  await page.route('**/api/v1/conversation-export', route => route.fulfill({ status: 503,
    contentType: 'application/json', body: JSON.stringify({ error: '合成暂时错误' }) }), { times: 1 });
  await drawer.getByRole('button', { name: '导出对话', exact: true }).click();
  const result = page.getByRole('dialog', { name: '导出对话', exact: true });
  await result.getByRole('button', { name: '重试' }).click();
  const preview = result.getByLabel('Markdown 预览');
  await expect(preview).toContainText(history[0]);
  const markdown = await preview.textContent();
  assert.ok(markdown);
  assert.deepEqual(markdown.match(/合成发言-\d{3}/g), history);
  assert.match(markdown, /共 47 条消息/);
  assert.doesNotMatch(markdown, /其他会话乙/);
  await result.getByRole('button', { name: '复制 Markdown' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(markdown);
  const ready = page.waitForEvent('download');
  await result.getByRole('button', { name: '下载 .md' }).click();
  const downloaded = await ready;
  assert.match(downloaded.suggestedFilename(), /独立导出甲.*\d{4}-\d{2}-\d{2}\.md$/);
  const path = await downloaded.path();
  assert.ok(path);
  assert.equal(await readFile(path, 'utf8'), markdown);
  const disabled = await page.request.post(server.url + '/api/v1/plugins/conversation-export', {
    headers: { authorization: 'Bearer ' + token }, data: { enabled: false },
  });
  assert.equal(disabled.status(), 200);
  await expect(result).not.toBeVisible();
  await expect(drawer.getByRole('button', { name: '导出对话' })).toHaveCount(0);
});
