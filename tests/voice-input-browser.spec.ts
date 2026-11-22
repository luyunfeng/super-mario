import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('听写仅追加确认的文字，退出对话丢弃迟到字幕，拒绝授权后可继续编辑', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-dictation-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token: 'fixture' });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('sm.splash.seen', 'true');
    class Recognition {
      start() { Object.assign(window, { dictation: this }); }
      onend?: () => void;
      stop() { this.onend?.(); }
      abort() {}
    }
    Object.assign(window, { SpeechRecognition: Recognition });
  });
  const result = (final: boolean) => page.evaluate(final => {
    const recognition = (window as unknown as { dictation: { onresult(event: unknown): void } }).dictation;
    recognition.onresult({ resultIndex: 0, results: [{ isFinal: final, 0: { transcript: '测试字幕' } }] });
  }, final);
  await page.goto(server.url + '/#chat?token=fixture');
  const input = page.getByLabel('给 Agent 的消息'), start = page.getByRole('button', { name: '语音输入', exact: true });
  await input.fill('已有草稿');
  await start.click(); await result(false);
  await expect(page.getByRole('status').filter({ hasText: '测试字幕' })).toBeVisible();
  await expect(input).toHaveValue('已有草稿');
  await result(true);
  await expect(input).toHaveValue('已有草稿测试字幕');
  await page.evaluate(() => { location.hash = '#home'; });
  await expect(input).toBeHidden();
  await result(true);
  await page.evaluate(() => { location.hash = '#chat'; });
  await expect(input).toHaveValue('已有草稿测试字幕');
  await start.click();
  await page.evaluate(() => (window as unknown as { dictation: { onerror(e: unknown): void } }).dictation.onerror({ error: 'not-allowed' }));
  await expect(page.getByText('麦克风权限被拒绝，可继续输入文字。')).toBeVisible();
  await expect(input).toBeEditable();
  await start.click();
  await page.getByRole('button', { name: '结束听写' }).click();
  await expect(start).toBeEnabled();
  await start.click();
  const disabled = await page.request.post(server.url + '/api/v1/plugins/voice-input', {
    headers: { authorization: 'Bearer fixture' }, data: { enabled: false },
  });
  expect(disabled.ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: /^(语音输入|结束听写)$/ })).toHaveCount(0);
  await result(true);
  await expect(input).toHaveValue('已有草稿测试字幕');
});
