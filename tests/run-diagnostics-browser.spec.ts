import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { RunDiagnostics } from '../packages/core/src/run-failure.ts';
import type { Run } from '../packages/protocol/src/index.ts';

test('Web 执行详情导出诊断报告：文件里没有提示词、输出和错误原文', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mario-run-diag-'));
  const server = await startServer({ dataDir: join(root, 'server'), host: '127.0.0.1', port: 0, demo: true, token: 'run-diag-fixture' });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const web = async <T>(path: string, method = 'GET', body?: object): Promise<T> => {
    const answer = await fetch(server.url + '/api/v1/' + path, { method,
      headers: { authorization: 'Bearer run-diag-fixture', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!answer.ok) throw new Error(path + ' ' + answer.status + ' ' + (await answer.text()).slice(0, 200));
    return await answer.json() as T;
  };
  const todo = await web<{ id: string }>('todos', 'POST', { title: '合成执行任务' });
  // The demo executor's answer is fixed. The prompt is the person's own content and must not be
  // written into the report.
  const prompt = '合成：诊断报告不应包含的提示词';
  const run = await web<Run>('runs', 'POST', { executorId: 'demo', executionMode: 'task', todoId: todo.id, doneWhen: '有明确的合成结果', expectMinutes: 1, prompt, cwd: tmpdir() });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#projects/all/runs/' + run.id + '?token=run-diag-fixture');
  await expect.poll(async () => (await web<{ runs: Run[] }>('state')).runs.find(row => row.id === run.id)?.status).toBe('completed');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出诊断报告', exact: true }).click();
  const download = await downloaded;
  const file = join(root, await download.suggestedFilename());
  await download.saveAs(file);
  const report = JSON.parse(await readFile(file, 'utf8')) as RunDiagnostics;
  assert.equal(report.format, 'super-mario.run-diagnostics');
  assert.equal(report.run.id, run.id);
  assert.equal(JSON.stringify(report).includes(prompt), false);
});
