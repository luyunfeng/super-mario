import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import { readBriefingSettings } from '../packages/core/src/briefing.ts';

test('简报设置里可以关掉电脑告警，关掉后巡检不再读电脑；重新打开后恢复', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-alerts-page-'));
  const token = 'alerts-page-fixture';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token, demo: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#agent?token=' + token);
  await page.getByRole('button', { name: '简报与离场通知设置' }).click();
  const drawer = page.getByRole('dialog', { name: '简报与离场通知' });
  const toggle = drawer.getByRole('checkbox', { name: /电脑快出问题时通知我/ });
  // On to begin with.
  await expect(toggle).toBeChecked();
  await toggle.click();
  await drawer.getByRole('button', { name: '保存简报设置' }).click();
  await expect(drawer).toBeHidden();
  assert.equal(readBriefingSettings(server.app.store).machineAlerts, false);
  // Turned off, the check reads no computer. There are none online, so this is shown by its result.
  assert.deepEqual(await server.app.machineAlertsCheck(), { checked: 0, told: 0 });
  // Opened again, the setting as it was saved is what is shown, and it can be turned back on.
  await page.getByRole('button', { name: '简报与离场通知设置' }).click();
  await expect(drawer.getByRole('checkbox', { name: /电脑快出问题时通知我/ })).not.toBeChecked();
  await drawer.getByRole('checkbox', { name: /电脑快出问题时通知我/ }).click();
  await drawer.getByRole('button', { name: '保存简报设置' }).click();
  await expect(drawer).toBeHidden();
  assert.equal(readBriefingSettings(server.app.store).machineAlerts, true);
});
