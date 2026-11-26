import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('模型抽屉里可以按用途设置型号、备用型号和每日上限，留空跟随主模型', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-routing-page-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token: 'routing-page-fixture',
    model: { provider: 'openai', model: 'fixture-main', baseUrl: 'http://127.0.0.1:1' } });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.goto(server.url + '/#agent?token=routing-page-fixture');
  await page.getByRole('button', { name: '更改模型' }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByText('按用途分模型', { exact: true }).click();
  // Every purpose but the main one is listed, and each follows the main model to begin with.
  const supervisor = drawer.getByRole('group', { name: '后台督办' });
  await expect(supervisor).toBeVisible();
  await expect(supervisor.getByRole('combobox', { name: '型号', exact: true })).toHaveValue('');
  await expect(supervisor).toContainText('当前跟随主模型：fixture-main');
  assert.equal(await drawer.getByRole('group', { name: '主对话' }).count(), 0, 'the main conversation is set above, not here');
  // A model of its own, a fallback, and a day limit.
  await supervisor.getByRole('combobox', { name: '型号', exact: true }).fill('fixture-cheap');
  await supervisor.getByRole('combobox', { name: '备用型号', exact: true }).fill('fixture-spare');
  await supervisor.getByRole('spinbutton', { name: '每日上限（次）' }).fill('30');
  await supervisor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(supervisor).toContainText('今日已用 0 / 30 次');
  await expect(supervisor).toContainText('备用：fixture-spare');
  await expect(supervisor).not.toContainText('当前跟随主模型');
  // What was saved is what the server has, and the other purposes were not touched.
  const saved = server.app.store.get<{ supervisor?: { model?: string; fallback?: string; dailyLimit?: number } }>('settings', 'model-routing');
  assert.deepEqual(saved, { supervisor: { model: 'fixture-cheap', fallback: 'fixture-spare', dailyLimit: 30 } });
  // The choices typed are offered to the next field, as the model list is for the main model.
  const options = await drawer.locator('#model-routing-models option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value));
  assert.deepEqual(options.sort(), ['fixture-cheap', 'fixture-main', 'fixture-spare']);
  // A bad value is refused by the server, and the page says so without losing what was typed.
  await supervisor.getByRole('combobox', { name: '备用型号', exact: true }).fill('fixture-cheap');
  await supervisor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(supervisor.getByRole('status')).toContainText('备用型号不能和首选型号相同');
  // Clearing the model goes back to following the main one; the limit is kept.
  await supervisor.getByRole('combobox', { name: '备用型号', exact: true }).fill('');
  await supervisor.getByRole('combobox', { name: '型号', exact: true }).fill('');
  await supervisor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(supervisor).toContainText('当前跟随主模型：fixture-main');
  await expect(supervisor).toContainText('今日已用 0 / 30 次');
  assert.deepEqual(server.app.store.get('settings', 'model-routing'), { supervisor: { dailyLimit: 30 } });
});
