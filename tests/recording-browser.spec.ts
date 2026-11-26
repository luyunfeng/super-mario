import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import type { Extension, Json, JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';

/** A stand-in engine. Its service is named after the plugin, as the host requires. */
function engine(seen: JsonObject[]): Extension {
  return {
    id: 'enginefixture', name: '夹具引擎', capabilities: ['transcription'],
    permissions: ['contribute:connectors', 'service.provide:enginefixture.transcribe'],
    activate(context) {
      context.contribute('connectors', 'enginefixture.transcribe', { kind: 'transcription', service: 'enginefixture.transcribe', name: '夹具引擎', languages: ['zh-CN'] } as Json);
      context.contribute('services', 'enginefixture.transcribe', { name: 'enginefixture.transcribe', version: 1, readOnly: true, async handler(value) {
        const input = value as JsonObject;
        seen.push(input);
        const seconds = Number(input.seconds);
        // It answers with what it was given, so the page shows real timings.
        return { segments: [{ from: 0, to: Math.min(1.5, seconds), text: '这是第一句。' }, ...(seconds > 3 ? [{ from: 2, to: Math.min(3, seconds), text: '这是第二句。' }] : [])],
          gaps: seconds > 4 ? [{ from: 3, to: Math.min(4, seconds) }] : [] };
      } });
    },
  };
}

/** A WAV file holding five seconds of a quiet tone, which the page decodes and resamples. */
function wav(seconds: number, sampleRate: number) {
  const samples = seconds * sampleRate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i / sampleRate * 440 * 2 * Math.PI) * 2000), 44 + i * 2);
  return buffer;
}

test('录音转写：上传音频后得到带时间的分段和没听清的区间，可存成知识页；没选引擎时先选', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-recording-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-recording' });
  const seen: JsonObject[] = [];
  server.app.plugins.register(engine(seen));
  await server.app.plugins.start();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    try { await browser?.close(); }
    finally { try { await server.close(); } finally { await rm(dir, { recursive: true, force: true }); } }
  });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#memory?token=offline-recording');
  await page.getByRole('button', { name: '录音转写' }).click();
  const drawer = page.getByRole('dialog', { name: '录音转写' });
  // No engine is chosen yet, so that is said and the installed one can be chosen here.
  await expect(drawer.getByText('还没有选择转写引擎。')).toBeVisible();
  await drawer.getByLabel('转写引擎').selectOption('enginefixture.transcribe');
  await drawer.getByRole('button', { name: '开始录音' }).waitFor();

  // A five second file at 48 kHz, which the page resamples to 16 kHz before sending.
  await drawer.getByLabel('上传音频文件').setInputFiles({ name: '会议.wav', mimeType: 'audio/wav', buffer: wav(5, 48000) });
  await expect(drawer.getByRole('list', { name: '转写结果' })).toContainText('这是第一句。');
  await expect(drawer.getByRole('list', { name: '转写结果' })).toContainText('这是第二句。');
  await expect(drawer.getByText(/没有听清、未编造内容：0:03–0:04/)).toBeVisible();
  await expect(drawer.getByText(/时长 0:05/)).toBeVisible();
  expect(seen.length).toBe(1);
  expect(seen[0]!.seconds).toBe(5);
  expect(seen[0]!.sampleRate).toBe(16000);
  // Exactly five seconds of PCM16 mono at 16 kHz arrived.
  expect(Buffer.from(String(seen[0]!.audio), 'base64').length).toBe(5 * 16000 * 2);

  await drawer.getByLabel('知识页标题').fill('周会录音');
  await drawer.getByRole('button', { name: '存为知识页' }).click();
  await expect(drawer).toHaveCount(0);
  const pages = await (await fetch(server.url + '/api/v1/knowledge', { headers: { authorization: 'Bearer offline-recording' } })).json() as { title: string; content: string }[];
  const saved = pages.find(item => item.title === '周会录音')!;
  expect(saved.content).toContain('[0:00–0:01] 这是第一句。');
  expect(saved.content).toContain('没有听清，未编造内容');
  expect(errors).toEqual([]);
});

test('录音转写：没有麦克风权限时说明原因，可以重试', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-recording-mic-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-recording-mic' });
  const seen: JsonObject[] = [];
  server.app.plugins.register(engine(seen));
  await server.app.plugins.start();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    try { await browser?.close(); }
    finally { try { await server.close(); } finally { await rm(dir, { recursive: true, force: true }); } }
  });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({ permissions: [] });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('sm.splash.seen', 'true');
    // The browser refuses the microphone, as it does when the owner denies it.
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  const headers = { authorization: 'Bearer offline-recording-mic', 'content-type': 'application/json' };
  await fetch(server.url + '/api/v1/transcription/choice', { method: 'PUT', headers, body: JSON.stringify({ service: 'enginefixture.transcribe' }) });
  await page.goto(server.url + '/#memory?token=offline-recording-mic');
  await page.getByRole('button', { name: '录音转写' }).click();
  const drawer = page.getByRole('dialog', { name: '录音转写' });
  await drawer.getByRole('button', { name: '开始录音' }).click();
  await expect(drawer.getByRole('status')).toContainText('没有拿到麦克风权限');
  // The way to try again is still there.
  await expect(drawer.getByRole('button', { name: '开始录音' })).toBeVisible();
  expect(seen).toEqual([]);
});
