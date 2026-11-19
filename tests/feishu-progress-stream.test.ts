import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createEventMailboxes } from '../packages/core/src/event-mailboxes.ts';
import { createFeishuBotsController } from '../apps/server/src/feishu-bots.ts';
import type { FeishuBotsApp, FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';
import type { Message } from '../packages/protocol/src/index.ts';

async function until(check: () => boolean) { for (let n = 0; n < 500; n++) { if (check()) return; await delay(5); } assert.fail('进度没有收敛'); }
async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'mario-progress-'));
  const store = createStore(join(dir, 'test.sqlite')), events = createEventBus(store), mailboxes = createEventMailboxes({ store, events });
  let adapterOptions!: FeishuOptions, patchFails = false;
  const sends: Array<{ text: string; card?: unknown }> = [], patches: Array<{ id: string; card: unknown }> = [];
  const factory: FeishuBotFactory = options => {
    adapterOptions = options;
    return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
      async send(_target, text, context) { sends.push({ text, card: context?.card }); context?.onSent?.('om_progress'); },
      async updateCard(id, card) { patches.push({ id, card }); if (patchFails) throw new Error('fake patch failure'); },
    };
  };
  const app: FeishuBotsApp = { store, events, mailboxes, async postScoped() {
    const message: Message = { id: 'input', role: 'user', text: '测试请求', status: 'pending', createdAt: new Date().toISOString(), conversationId: 'bot-test' };
    store.put('messages', message.id, message); return message;
  } };
  const controller = createFeishuBotsController(app, { host: '127.0.0.1', port: 0, dataDir: dir, demo: true }, { factory });
  mailboxes.setHandlers({ inbox: entry => controller.dispatchInbox(entry), outbox: entry => controller.send(entry.botId, entry.target!, entry.text, entry.eventKey) });
  const bot = await controller.create({ name: '测试Agent', appId: 'cli_OfflineProgress', appSecret: 'test-secret', scope: { kind: 'global' }, requireConfirmation: false });
  const source = (messageId: string) => ({ messageId, chatId: 'owner', senderId: 'human', senderType: 'user' as const, chatType: 'p2p' });
  await adapterOptions.onMessage(controller.list()[0]!.pairingCode!, source('pair')); sends.length = 0;
  await adapterOptions.onMessage('测试请求', source('request'));
  const publish = (patch: Partial<Message>) => {
    const old = store.get<Message>('messages', 'answer');
    const message: Message = { id: 'answer', replyTo: 'input', role: 'assistant', conversationId: 'bot-test', text: '', status: 'pending', createdAt: new Date().toISOString(), progress: { phase: 'thinking', detail: '正在分析', observedAt: new Date().toISOString() }, ...old, ...patch };
    store.put('messages', message.id, message); events.publish('messages.changed', { messageId: message.id });
  };
  t.after(async () => { await controller.close(); await mailboxes.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, controller, bot, sends, patches, publish, failPatch() { patchFails = true; } };
}

test('一轮只创建一张进度卡，工具/答复更新同一ID，完成后不重复发送最终文本', async t => {
  const f = await fixture(t); f.publish({}); await until(() => f.sends.length === 1);
  assert.ok(f.sends[0]!.card);
  f.publish({ text: '部分回复', progress: { phase: 'tool', toolName: 'read', detail: '读取资料', observedAt: new Date().toISOString() } });
  f.publish({ status: 'done', text: '最终回复' });
  await until(() => f.patches.some(item => JSON.stringify(item.card).includes('回复完成')));
  assert.equal(f.sends.length, 1); assert.ok(f.patches.every(item => item.id === 'om_progress'));
  assert.match(JSON.stringify(f.patches.at(-1)!.card), /最终回复/);
  f.publish({ status: 'done', text: '最终回复' }); await delay(15); assert.equal(f.sends.length, 1);
});
test('卡片更新失败停止增量；最终回复沿用原通道且不重发创建', async t => {
  const f = await fixture(t); f.publish({}); await until(() => f.sends.length === 1);
  f.failPatch(); f.publish({ status: 'done', text: '保留最终答复' });
  await until(() => f.sends.length === 2);
  assert.equal(f.patches.length, 1); assert.equal(f.sends[1]!.text, '保留最终答复');
});
test('机器人停用后迟到进度和结果不能再更新卡片或发送', async t => {
  const f = await fixture(t); f.publish({}); await until(() => f.sends.length === 1);
  await f.controller.update(f.bot.id, { enabled: false });
  f.publish({ status: 'done', text: '迟到结果' }); await delay(20);
  assert.equal(f.sends.length, 1); assert.equal(f.patches.length, 0);
});


test('长回复保留完整正文，不能只交付截断的进度预览', async t => {
  const f = await fixture(t); f.publish({}); await until(() => f.sends.length === 1);
  const text = '完整正文'.repeat(1100); f.publish({ status: 'done', text });
  await until(() => f.sends.length === 2); assert.equal(f.sends[1]!.text, text);
});
