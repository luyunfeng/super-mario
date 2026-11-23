import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { FeishuOptions } from '../plugins/feishu.ts';
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
      api: { get: async (path: string) => {
        if (path !== '/model/catalog') throw new Error('unexpected path');
        return { source: 'configured', provider: 'codex-cli', current: 'default', models: ['default'], demo: true };
      }, put: async (path: string, body: unknown) => { state.calls.push({ path, body }); if (state.fail) throw Object.assign(new Error('fixture rejected'), { status: 400 }); } },
      onSaved: () => { state.saved++; },
    });
    state.open();
  });
  const command = page.getByLabel('启动命令（可选）', { exact: true });
  const directory = page.getByLabel('命令行配置目录（可选）', { exact: true });
  const mode = page.getByLabel('接入方式');
  await page.getByRole('button', { name: '查看当前配置的模型清单' }).click();
  await expect(page.getByLabel('模型清单（1）', { exact: true })).toHaveValue('default');
  await expect(page.getByText(/演示模式。Web 主会话当前配置为 codex-cli/)).toBeVisible();
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

test('Agent 页读取已保存的模型清单，保留未提交的模型名称', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-catalog-page-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token: 'catalog-page-fixture',
    model: { provider: 'openai', model: 'fixture-current', baseUrl: 'http://127.0.0.1:1' } });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.goto(server.url + '/#agent?token=catalog-page-fixture');
  await page.getByRole('button', { name: '更改模型' }).click();
  const input = page.getByRole('textbox', { name: '模型', exact: true });
  await input.fill('fixture-draft');
  await page.getByRole('button', { name: '查看当前配置的模型清单' }).click();
  await expect(page.getByLabel('模型清单（1）')).toHaveValue('fixture-current');
  await expect(input).toHaveValue('fixture-draft');
  assert.equal(server.app.modelStatus().model, 'fixture-current');
});

test('Web 和飞书可以相互核对同一机器人的选型，Web 主会话独立', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-conversation-model-'));
  let receiver!: FeishuOptions;
  const replies: string[] = [];
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token: 'pick-fixture',
    model: { provider: 'openai', model: 'gpt-4o' } }, { botFactory(options) {
    receiver = options;
    return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
      async send(_target, text) { replies.push(text); } };
  } });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const bot = await server.bots.create({ name: '样例助手', appId: 'cli_3333333333333333', appSecret: 'offline-fixture', scope: { kind: 'global' } });
  const source = { chatId: 'private', senderId: 'owner', chatType: 'p2p', senderType: 'user' } as const;
  const send = (text: string, messageId: string) => receiver.onMessage(text, { ...source, messageId });
  const url = server.url + '/api/v1/feishu/bots/' + encodeURIComponent(bot.id) + '/model/pick';
  const options = { method: 'PUT', body: JSON.stringify({ model: 'gpt-4o-mini' }) };
  assert.equal((await fetch(url, options)).status, 401);
  assert.equal((await fetch(url, { ...options, headers: { Authorization: 'Bearer pick-fixture' } })).status, 409);
  await send(bot.pairingCode!, 'pair');
  const page = await browser.newPage();
  await page.goto(server.url + '/#agent?token=pick-fixture');
  await page.getByRole('button', { name: '会话模型', exact: true }).click();
  const list = page.getByRole('combobox', { name: /^模型清单/ });
  await expect(list).toHaveValue('gpt-4o');
  await list.selectOption('gpt-4o-mini');
  await page.getByRole('button', { name: '应用到此会话' }).click();
  await expect(page.getByRole('dialog')).toContainText('已保存，下条消息使用所选模型');
  await send('/modellist', 'check-from-bot');
  assert.match(replies.at(-1)!, /当前模型 · gpt-4o-mini/);
  await send('/modelchange gpt-4o', 'restore-from-bot');
  await page.getByRole('button', { name: '查看当前配置的模型清单' }).click();
  await expect(list).toHaveValue('gpt-4o');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '更改模型' }).click();
  await page.getByRole('button', { name: '查看当前配置的模型清单' }).click();
  await list.selectOption('gpt-4o-mini');
  await page.getByRole('button', { name: '应用到此会话' }).click();
  await expect(page.getByRole('dialog')).toContainText('已保存，下条消息使用所选模型');
  assert.equal(server.app.modelCatalog().current, 'gpt-4o-mini');
  assert.equal(server.app.modelCatalog(bot.id).current, 'gpt-4o');
  assert.equal(server.app.modelStatus().model, 'gpt-4o');
});
