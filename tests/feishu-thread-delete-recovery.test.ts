import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import { botConversationId } from '../packages/core/src/bot-agent-routing.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('SQLite 删除提交后磁盘暂时不可用，重启可完成旧配对清理并保护新配对文件', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-delete-restart-'));
  const config = { dataDir, demo: true, token: 'fixture', host: '127.0.0.1', port: 0 };
  let client!: FeishuOptions;
  const botFactory: FeishuBotFactory = options => {
    client = options;
    return { async start() {}, async close() {}, async collect() { return []; }, async send() {}, status: () => ({ connected: true }) };
  };
  let server = await startServer(config, { botFactory });
  t.after(async () => { try { await server.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const bot = await server.bots.create({ name: '恢复测试', appId: 'cli_7777777777777777', appSecret: 'fixture',
    scope: { kind: 'global' }, requireConfirmation: false });
  async function send(text: string, messageId: string) {
    await client.onMessage(text, { messageId, senderId: 'owner', chatId: 'chat', chatType: 'p2p', senderType: 'user' });
  }
  async function transcript(threadId: string, text: string) {
    const id = botConversationId(bot, threadId);
    const directory = join(dataDir, 'pi', 'agents', createHash('sha256').update(id).digest('hex'), 'sessions', 'conversation');
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'synthetic.jsonl');
    await writeFile(file, text);
    return file;
  }
  await send(bot.pairingCode!, 'pair');
  await send('/new', 'old-thread');
  const oldId = server.bots.privateThreads(bot.id)[0]!.threadId;
  const oldFile = await transcript(oldId, '旧会话合成记录');
  const failed = t.mock.method(server.app.scopedAgents, 'forgetDeletedThread', async () => { throw new Error('模拟磁盘暂时不可用'); });
  await assert.rejects(server.bots.deletePrivateThread(bot.id, oldId, { version: 0 }), /磁盘暂时不可用/);
  assert.throws(() => server.bots.requireThread(bot.id, oldId), { status: 410 });
  assert.equal(await readFile(oldFile, 'utf8'), '旧会话合成记录');
  await server.bots.update(bot.id, { name: '新配对设置' });
  await send('/new', 'new-thread');
  const newId = server.bots.privateThreads(bot.id)[0]!.threadId;
  assert.notEqual(newId, oldId);
  const newFile = await transcript(newId, '当前会话合成记录');
  assert.equal(failed.mock.callCount(), 1);
  await server.close();
  server = await startServer(config, { botFactory });
  await t.waitFor(async () => { await assert.rejects(access(oldFile), { code: 'ENOENT' }); });
  assert.equal(await readFile(newFile, 'utf8'), '当前会话合成记录');
  assert.throws(() => server.bots.requireThread(bot.id, oldId), { status: 404 });
  assert.equal(server.bots.requireThread(bot.id, newId).threadId, newId);
});
