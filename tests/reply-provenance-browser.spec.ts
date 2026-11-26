import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('对话里每条回复下面写这一轮的用量；换模型后的第一条回复标出切换到了哪个模型', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-provenance-page-'));
  const token = 'provenance-page-fixture';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token, demo: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  // Three replies as the runtime writes them: two from one model, then one from another.
  const base = { conversationId: 'main', role: 'assistant' as const, status: 'done' as const };
  const replies: Message[] = [
    { ...base, id: 'ask-1', role: 'user', text: '第一个问题', createdAt: '2026-11-27T10:00:00.000Z' },
    { ...base, id: 'reply-1', replyTo: 'ask-1', text: '第一个回答', createdAt: '2026-11-27T10:00:02.000Z',
      model: { provider: 'openai', model: 'gpt-x' }, usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 1050 } },
    { ...base, id: 'ask-2', role: 'user', text: '第二个问题', createdAt: '2026-11-27T10:01:00.000Z' },
    { ...base, id: 'reply-2', replyTo: 'ask-2', text: '第二个回答', createdAt: '2026-11-27T10:01:02.000Z',
      model: { provider: 'openai', model: 'gpt-x' }, usage: { input: 9000, output: 400, cacheRead: 8000, cacheWrite: 0, totalTokens: 17400 } },
    { ...base, id: 'ask-3', role: 'user', text: '第三个问题', createdAt: '2026-11-27T10:02:00.000Z' },
    { ...base, id: 'reply-3', replyTo: 'ask-3', text: '第三个回答', createdAt: '2026-11-27T10:02:02.000Z',
      model: { provider: 'anthropic', model: 'claude-y' }, usage: { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 2100 } },
    // A reply from before the runtime kept the model, as an old conversation has.
    { ...base, id: 'reply-0', text: '更早的回答', createdAt: '2026-11-27T09:00:00.000Z' },
  ];
  for (const reply of replies) server.app.store.put('messages', reply.id, reply);
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#chat?token=' + token);
  const article = (id: string) => page.locator('article[data-id="' + id + '"]');
  // Each reply says what the exchange used, with the cache only when something was read from it.
  await expect(article('reply-1')).toContainText('输入 1,000 · 输出 50');
  await expect(article('reply-2')).toContainText('输入 9,000 · 输出 400 · 缓存读取 8,000');
  await expect(article('reply-3')).toContainText('输入 2,000 · 输出 100');
  // Before the first reply that says its model there is one that does not say: so this is a switch.
  await expect(article('reply-1').locator('[data-model-switch]')).toHaveText('切换到 openai / gpt-x');
  // The second kept the same model: no mark.
  await expect(article('reply-2').locator('[data-model-switch]')).toHaveCount(0);
  // The third is where the model changed: it says what was switched to.
  await expect(article('reply-3').locator('[data-model-switch]')).toHaveText('切换到 anthropic / claude-y');
  // An old reply without a model says nothing about a model, and no usage.
  await expect(article('reply-0').locator('[data-model-switch]')).toHaveCount(0);
  await expect(article('reply-0')).not.toContainText('输入');
  // Three marks in all across the conversation: the first naming, and the one change.
  assert.equal(await page.locator('[data-model-switch]').count(), 2);
  // In a conversation whose first reply says its model, the first reply names it and is not a switch.
  const fresh = await browser.newPage();
  await fresh.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  for (const id of ['ask-1', 'reply-1', 'ask-2', 'reply-2', 'ask-3', 'reply-3', 'reply-0']) server.app.store.remove('messages', id);
  server.app.store.put('messages', 'fresh-reply', { ...base, id: 'fresh-reply', text: '新对话的回答', createdAt: '2026-11-27T11:00:00.000Z',
    model: { provider: 'openai', model: 'gpt-x' }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } });
  await fresh.goto(server.url + '/#chat?token=' + token);
  await expect(fresh.locator('article[data-id="fresh-reply"] [data-model-switch]')).toHaveText('openai / gpt-x');
});
