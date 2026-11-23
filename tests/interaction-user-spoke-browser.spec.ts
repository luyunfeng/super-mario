import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import type { Message } from '../packages/protocol/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';

test('Web 主对话发送新消息后，原提问卡显示撤回原因且无法重复回答', { timeout: 40_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-chat-question-'));
  const token = 'synthetic-browser-question';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, demo: true, token });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(`${server.url}/#chat?token=${token}`);
  const composer = page.getByRole('textbox', { name: '给 Agent 的消息' });
  async function speak(text: string): Promise<Message> {
    await composer.fill(text);
    const accepted = page.waitForResponse(res => res.url().endsWith('/api/v1/messages') && res.request().method() === 'POST');
    await composer.press('Enter');
    const response = await accepted;
    assert.equal(response.status(), 202);
    return await response.json() as Message;
  }
  const first = await speak('请帮我比较两个合成方案。');
  const card = server.app.interactions.open({ kind: 'question', title: '先看哪个方案？', body: '甲或乙' }, first);
  const answer = page.getByRole('textbox', { name: `回答：${card.title}` });
  await expect(answer).toBeVisible();
  const notice = page.locator(`[data-id="interaction-notice:${card.id}"]`);
  await expect(notice).toContainText(card.title);
  await speak('我改主意了，请先处理另一件事。');
  await expect(answer).toHaveCount(0);
  await expect(notice).toContainText(`提问已撤回：${card.title}`);
  await notice.getByText('详情', { exact: true }).click();
  await expect(notice.getByText('你已在此对话发送新消息，无需再回答。')).toBeVisible();
  const stored = server.app.interactions.list().find(row => row.id === card.id);
  assert.equal(stored?.status, 'withdrawn');
  assert.equal(stored?.answer, undefined);
  const staleAnswer = await page.request.post(`${server.url}/api/v1/interactions/${card.id}/answer`, {
    headers: { Authorization: 'Bearer ' + token }, data: { version: card.version, text: '旧卡的迟到回答' },
  });
  assert.equal(staleAnswer.status(), 409);
  await page.goto(`${server.url}/#chat?interaction=${card.id}`);
  await page.reload();
  await page.getByRole('button', { name: '查看原提问通知' }).click();
  await expect(notice).toBeFocused();
  await expect(notice.getByText('你已在此对话发送新消息，无需再回答。')).toBeVisible();
  await expect(notice).toContainText(`提问已撤回：${card.title}`);
  await expect(answer).toHaveCount(0);
});
