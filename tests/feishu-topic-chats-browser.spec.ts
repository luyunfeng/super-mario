import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('Web 从配对机器人管理话题群，保存群策略、切换主群并核对版本冲突', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-topic-settings-'));
  const token = 'offline-browser';
  const clients = new Map<string, FeishuOptions>();
  const server = await startServer({ host: '127.0.0.1', port: 0, demo: true, token, dataDir: dir }, {
    botFactory(opts) {
      clients.set(opts.appId, opts);
      return { async start() {}, async close() {}, async collect() { return []; },
        status: () => ({ connected: true }), async send() {} };
    },
  });
  t.after(async () => { try { await server.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  const bot = await server.bots.create({ name: '合成话题机器人', appId: 'cli_8888888888888888', appSecret: 'fixture', scope: { kind: 'global' } });
  await server.bots.create({ name: '未配对机器人', appId: 'cli_7777777777777777', appSecret: 'fixture', scope: { kind: 'global' } });
  await clients.get(bot.appId)!.onMessage(bot.pairingCode!, { chatType: 'p2p', chatId: 'oc_owner', senderId: 'ou_owner', senderType: 'user', messageId: 'om_pair' });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const path = server.url + '/api/v1/feishu/bots/' + bot.id + '/topic-chats';
  const headers = { authorization: 'Bearer ' + token };
  await page.goto(server.url + '/#agent?token=' + token);
  const bots = page.locator('#agent-bot .row');
  await expect(bots.filter({ hasText: '未配对机器人' }).getByRole('button', { name: '话题群管理' })).toHaveCount(0);
  const opener = bots.filter({ hasText: bot.name }).getByRole('button', { name: '话题群管理' });
  await opener.click();
  const drawer = page.getByRole('dialog', { name: '话题群管理' });
  await expect(drawer).toContainText('尚未登记话题群');
  const group = (name: string) => drawer.getByRole('group', { name, exact: true });
  const save = drawer.getByRole('button', { name: '保存话题群设置' });
  async function add(id: string, name: string) {
    await drawer.getByRole('button', { name: '添加话题群' }).click();
    const row = group('新增话题群').last();
    await row.getByLabel('群 chatId').fill(id);
    await row.getByLabel('群名称（可选）').fill(name);
    return row;
  }
  await add('oc_topicA', '甲');
  const second = await add('oc_topicB', '乙');
  await second.getByRole('checkbox').check();
  await second.getByRole('radio').check();
  const firstWrite = page.waitForRequest(req => req.url() === path && req.method() === 'PUT');
  await save.click();
  const payload = (await firstWrite).postDataJSON();
  assert.ok(payload.binding); assert.ok(Number.isInteger(payload.version));
  await expect(group('oc_topicB').getByRole('radio')).toBeChecked();
  await expect(group('oc_topicB').getByRole('checkbox')).toBeChecked();
  await drawer.getByRole('button', { name: '关闭' }).click();
  await opener.click();
  await expect(group('oc_topicB').getByLabel('群名称（可选）')).toHaveValue('乙');
  await group('oc_topicA').getByLabel('群名称（可选）').fill('本页改名');
  const draft = await add('oc_topicC', '未保存登记');
  await draft.getByRole('checkbox').check();
  const state = await (await page.request.get(path, { headers })).json();
  const res = await page.request.put(path, { headers, data: { binding: state.binding, version: state.version,
    items: [{ chatId: 'oc_topicA', name: '远端新名', requireOwnerMention: true }, { chatId: 'oc_topicD', name: '其他窗口登记' }, { chatId: 'oc_topicB', name: '乙', requireOwnerMention: true, home: true }] } });
  assert.equal(res.status(), 200);
  await save.click();
  await expect(drawer).toContainText('已在别处修改');
  await expect(group('oc_topicA').getByLabel('群名称（可选）')).toHaveValue('远端新名');
  const review = drawer.getByRole('region', { name: '未保存的修改' });
  await expect(review).toContainText('本页改名');
  await expect(review).toContainText('oc_topicC · 群名称：未保存登记 · 要求主人明确 @');
  await expect(group('oc_topicD').getByLabel('群名称（可选）')).toHaveValue('其他窗口登记');
  await review.getByRole('button', { name: '采用此项' }).first().click();
  await expect(group('oc_topicA').getByLabel('群名称（可选）')).toHaveValue('本页改名');
  await expect(group('oc_topicA').getByRole('checkbox')).toBeChecked();
  await review.getByRole('button', { name: '采用此项' }).click();
  await expect(group('新增话题群').getByRole('checkbox')).toBeChecked();
  await group('oc_topicB').getByRole('button', { name: '移除此群' }).click();
  await save.click();
  await expect(drawer).toContainText('设置已保存');
  await expect(group('oc_topicB')).toHaveCount(0);
  await expect(group('oc_topicD')).toBeVisible();
  await expect(group('oc_topicC').getByRole('checkbox')).toBeChecked();
  await group('oc_topicD').getByLabel('群名称（可选）').fill('未知回执草稿');
  await page.route(path, async intercepted => {
    if (intercepted.request().method() === 'PUT') await intercepted.fulfill({ status: 502, json: { error: 'offline fixture' } });
    else await intercepted.continue();
  });
  await save.click();
  await expect(review).toContainText('未知回执草稿');
  await expect(group('oc_topicD').getByLabel('群名称（可选）')).toHaveValue('其他窗口登记');
  await drawer.getByRole('button', { name: '关闭' }).click();
  await opener.click();
  await expect(group('oc_topicD')).toBeVisible();
  await expect(review).not.toBeVisible();
  await server.bots.update(bot.id, { enabled: false });
  await expect(drawer).not.toBeVisible();
});
