import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('主对话与项目朗读指定正文，退出或停用插件后忽略迟到的分段回调', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-read-aloud-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token: 'fixture' });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const project = await server.app.createProject({ name: '朗读测试项目' });
  const text = '请保留原文。'.repeat(45) + '操作失败，等待确认🙂。';
  for (const [id, conversationId] of [['main-reply', 'main'], ['work-reply', 'project:' + project.id + ':work']]) {
    server.app.store.put('messages', id, { id, conversationId, text, role: 'assistant', status: 'done', createdAt: new Date().toISOString() });
  }
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('sm.splash.seen', 'true');
    const chunks: SpeechSynthesisUtterance[] = [];
    class Recognition {
      start() {
        Object.assign(window, { listening: this });
        document.body.dataset.speakerAtStart = document.body.dataset.speaker;
      }
      abort() { document.body.dataset.microphone = 'closed'; }
    }
    Object.assign(window, { chunks, SpeechRecognition: Recognition });
    Object.defineProperty(window, 'speechSynthesis', { value: {
      speak(u: SpeechSynthesisUtterance) { chunks.push(u); document.body.dataset.speaker = 'playing'; },
      cancel() { document.body.dataset.speaker = 'stopped'; },
    } });
  });
  const chunks = () => page.evaluate(() => (window as unknown as { chunks: SpeechSynthesisUtterance[] }).chunks.map(u => u.text));
  const ended = () => page.evaluate(() => (window as unknown as { chunks: SpeechSynthesisUtterance[] }).chunks.at(-1)?.dispatchEvent(new Event('end')));
  await page.goto(server.url + '/#chat?token=fixture');
  const play = page.getByRole('button', { name: '朗读回复', exact: true });
  await play.click();
  await ended();
  expect((await chunks()).join('')).toBe(text);
  await ended();
  await expect(play).toBeVisible();
  await play.click();
  const dictation = page.getByRole('button', { name: '语音输入', exact: true });
  await dictation.click();
  await expect(page.locator('body')).toHaveAttribute('data-speaker-at-start', 'stopped');
  await expect(play).toBeVisible();
  const interrupted = await chunks();
  await ended();
  expect(await chunks()).toEqual(interrupted);
  const result = (text: string) => page.evaluate(transcript => {
    const recognition = (window as unknown as { listening: { onresult(e: unknown): void } }).listening;
    recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript } }] });
  }, text);
  await result('草稿');
  await play.click();
  await expect(dictation).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-microphone', 'closed');
  await result('迟到字幕');
  await expect(page.getByLabel('给 Agent 的消息')).toHaveValue('草稿');
  await page.evaluate(id => { location.hash = '#projects/' + id + '/workspace'; }, project.id);
  await expect(page.getByLabel('项目目标')).toBeVisible();
  const before = await chunks();
  await ended();
  expect(await chunks()).toEqual(before);
  await play.click();
  const disabled = await page.request.post(server.url + '/api/v1/plugins/reply-read-aloud', {
    headers: { authorization: 'Bearer fixture' }, data: { enabled: false },
  });
  expect(disabled.ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: /^(朗读回复|停止朗读)$/ })).toHaveCount(0);
  const stopped = await chunks();
  await ended();
  expect(await chunks()).toEqual(stopped);
});
