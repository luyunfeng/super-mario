import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('主人可以先聊天，稍后回答原卡或关闭提问；每个决定只受理一次', { timeout: 40000 }, async t => {
  const token = 'fixture-ask-later';
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-web-ask-later-'));
  const server = await startServer({ host:'127.0.0.1', port:0, dataDir, demo:true, token });
  t.after(async () => { await server.close(); await rm(dataDir,{ recursive:true, force:true }); });
  const browser = await chromium.launch({ executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url + '/#chat?token=' + token);
  const composer = page.getByRole('textbox', { name:'给 Agent 的消息' });
  async function speak(text: string): Promise<Message> {
    await composer.fill(text);
    const next = page.waitForResponse(res => res.url().endsWith('/api/v1/messages') && res.request().method() === 'POST');
    await composer.press('Enter');
    const receipt = await next;
    assert.equal(receipt.status(),202);
    return await receipt.json();
  }
  async function open(title: string) {
    const input = await speak('暂缓决定：' + title);
    return server.app.interactions.open({ kind:'question', title, body:'请确认合成表格的交付格式。', wait:false }, input);
  }
  const card = await open('选择表格格式');
  const row = page.locator('[data-id="interaction:' + card.id + '"]');
  await expect(row).toContainText('可继续聊天，稍后回到这张卡回答。');
  const reply = row.getByRole('textbox', { name:'回答：' + card.title });
  await reply.fill('采用 CSV');
  const other = await speak('先帮我看今天的简报。');
  await expect.poll(() => server.app.store.get<Message>('messages',other.id)?.status).toBe('done');
  await expect(reply).toHaveValue('采用 CSV');
  assert.equal(server.app.interactions.list().find(item => item.id === card.id)?.status,'open');
  const path = '/api/v1/interactions/' + card.id + '/answer';
  const next = page.waitForResponse(res => res.url().endsWith(path) && res.request().method() === 'POST');
  await row.getByRole('button', { name:'回答', exact:true }).click();
  const accepted = await next;
  assert.equal(accepted.status(),200);
  await expect(row).toHaveCount(0);
  const feedback = () => server.app.store.list<Message>('messages').filter(m => m.role === 'user' && m.text.includes('采用 CSV'));
  await expect.poll(() => feedback().length).toBe(1);
  assert.equal(feedback()[0].conversationId,'main');
  assert.ok(feedback()[0].text.includes(card.title));
  const duplicate = await page.request.post(server.url + path,{ headers:{Authorization:'Bearer ' + token}, data:accepted.request().postDataJSON() });
  assert.equal(duplicate.status(),409);
  assert.equal(feedback().length,1);

  const closed = await open('关闭一条稍后提问');
  const later = page.locator('[data-id="interaction:' + closed.id + '"]');
  const cancel = page.waitForResponse(res => res.url().endsWith('/interactions/' + closed.id + '/withdraw'));
  await later.getByRole('button',{name:'关闭提问',exact:true}).click();
  assert.equal((await cancel).status(),200);
  await expect(later).toHaveCount(0);
  const state = server.app.interactions.list().find(item => item.id === closed.id);
  assert.equal(state?.status,'withdrawn');
  assert.equal(state?.answer,undefined);
  const closedFeedback = () => server.app.store.list<Message>('messages').filter(m =>
    m.role === 'user' && m.conversationId === 'main' && m.text.includes(closed.id) && m.text.includes('未提供答案'));
  await expect.poll(() => closedFeedback().length).toBe(1);
  assert.equal(closedFeedback()[0].readOnly,true);
  await page.reload();
  await expect(later).toHaveCount(0);
  await expect(row).toHaveCount(0);
});
