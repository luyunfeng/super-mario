import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('model drawer submits only active mode and preserves CLI drafts after switches and failed saves', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-launcher-ui-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async()=>{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/js/main.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.goto(server.url);
  await page.evaluate(async () => {
    const path = '/js/features/model-drawer.js';
    const { openModelDrawer } = await import(path);
    const state:any = (window as any).launcherTest = { calls: [], fail: true, saved: 0 };
    state.open = (config = { mode: 'codex-cli', model: 'default' }) => openModelDrawer({ config,
      api: { put: async (path: string, body: unknown) => { state.calls.push({ path, body }); if (state.fail) throw Object.assign(new Error('fixture rejected'), { status: 400 }); } },
      onSaved: () => { state.saved++; },
    });
    state.open();
  });
  const command = page.getByLabel('启动命令（可选）', { exact: true });
  const directory = page.getByLabel('命令行配置目录（可选）', { exact: true });
  const mode = page.getByLabel('接入方式');
  await expect(command).toHaveValue('');
  await expect(directory).toHaveValue('');
  await command.fill('/tmp/test launcher/codex');
  await directory.fill('/tmp/test config');
  await mode.selectOption('api');
  await expect(command).toBeHidden();
  await page.getByRole('combobox',{name:/^服务商/}).fill('openai');
  await page.getByRole('textbox',{name:/^模型/}).fill('fixture');
  await page.getByLabel('密钥', { exact: true }).fill('fixture-key');
  await page.getByRole('button', { name: '保存并应用' }).click();
  await expect(page.getByRole('alert').first()).toContainText('保存失败');
  await expect(page.getByLabel('密钥', { exact: true })).toHaveValue('fixture-key');
  await mode.selectOption('codex-cli');
  await expect(command).toHaveValue('/tmp/test launcher/codex');
  await expect(directory).toHaveValue('/tmp/test config');
  await page.getByRole('button', { name: '保存并应用' }).click();
  await expect(page.getByRole('alert').first()).toContainText('保存失败');
  await expect(command).toHaveValue('/tmp/test launcher/codex');
  await page.evaluate(() => { (window as any).launcherTest.fail = false; });
  await page.getByRole('button', { name: '保存并应用' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const state = await page.evaluate(() => ({ calls: (window as any).launcherTest.calls, saved: (window as any).launcherTest.saved }));
  assert.deepEqual(state.calls, [
    { path: '/model', body: { mode: 'api', provider: 'openai', model: 'fixture', apiKey: 'fixture-key' } },
    ...Array.from({ length: 2 }, () => ({ path: '/model', body: { mode: 'codex-cli', provider: 'codex-cli', model: 'default', cliCommand: '/tmp/test launcher/codex', cliConfigDir: '/tmp/test config' } })),
  ]);
  assert.equal(state.saved, 1);
  assert.deepEqual(errors, []);
});
