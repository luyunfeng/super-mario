import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chooseCommandTarget } from '../apps/server/src/feishu-command-routing.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';
import type { BotScope } from '../packages/protocol/src/bots.ts';

test('command handoff without a mention ID, actionable clarification, and revocation during routing or confirmation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-command-auth-'));
  const receivers = new Map<string, FeishuOptions>();
  const sent: { target: string; text: string }[] = [];
  const server = await startServer({ dataDir: dir, host: '127.0.0.1', port: 0, demo: true }, {
    botFactory(options) {
      receivers.set(options.appId, options);
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
        async send(target, text) { sent.push({ target, text }); } };
    },
  });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const { app, bots } = server;
  const project = app.projects.create({ name: '海星' });
  const chatId = 'oc_group';
  async function pair(appId: string, scope: BotScope) {
    const bot = await bots.create({ appId, appSecret: 'fixture', name: appId, scope, requireConfirmation: true });
    await receivers.get(appId)!.onMessage(bot.pairingCode!, { messageId: 'om_pair_' + appId, chatType: 'p2p',
      senderType: 'user', senderId: 'ou_' + appId, chatId: 'oc_private_' + appId });
    return bot;
  }
  const main = await pair('cli_1111111111111111', { kind: 'global' });
  const target = await pair('cli_2222222222222222', { kind: 'project', projectId: project.id });
  const senderId = 'ou_' + main.appId;
  app.store.put('feishu.command-group', 'current', { chatId, mainBotId: main.id, mainAppId: main.appId,
    ownerFingerprint: createHash('sha256').update(JSON.stringify([main.id, main.appId, senderId, 'oc_private_' + main.appId])).digest('hex'),
    members: [{ botId: main.id, appId: main.appId, status: 'joined' },
      { botId: target.id, appId: target.appId, projectId: project.id, status: 'joined' }] });
  await bots.refreshCommandGroup();
  const receive = (messageId: string) => receivers.get(main.appId)!.onMessage('检查进度',
    { messageId, chatId, chatType: 'group', senderType: 'user', senderId });
  app.routeCommandProject = async () => undefined;
  await receive('om_unclear');
  assert.ok(sent.some(s => s.target === chatId && /原任务再发一次.*只 @ 一个.*项目机器人/.test(s.text)));
  assert.equal(app.mailboxes.list().some(e => e.direction === 'inbox' && e.sourceMessageId === 'om_unclear'), false);

  const projectSource = { messageId: 'om_project_only', chatId, chatType: 'group', senderType: 'user' as const,
    senderId: 'ou_' + target.appId, mentionedSelf: true, mentions: [{ key: '@_user_1', openId: 'ou_self' }] };
  await receivers.get(target.appId)!.onMessage('检查进度', projectSource);
  await receivers.get(target.appId)!.onMessage('检查进度', projectSource);
  await t.waitFor(() => assert.ok(sent.some(s => s.text.includes('只 @ 总指挥机器人'))), { timeout: 6000 });
  const hints = sent.filter(s => s.text.includes('只 @ 总指挥机器人'));
  assert.deepEqual(hints.map(s => s.target), ['oc_private_' + target.appId]);
  assert.equal(app.mailboxes.list().some(e => e.direction === 'inbox' && e.sourceMessageId === projectSource.messageId), false);

  let classifications = 0;
  app.routeCommandProject = async () => { classifications++; return project.id; };
  const named = async (id: string, message: string) => receivers.get(main.appId)!.onMessage(message, {
    messageId: id, chatId, chatType: 'group', senderType: 'user', senderId,
    mentionedSelf: true, mentions: [{ appId: main.appId, key: '@_user_1' }],
  });
  await named('om_named', '@_user_1 项目：海星\r\n检查进度');
  assert.equal(app.mailboxes.list().find(e => e.direction === 'inbox' && e.sourceMessageId === 'om_named')?.status, 'pending');
  await named('om_typo', '@_user_1 项目：海星星\n检查进度');
  await named('om_empty', '@_user_1 项目：海星');
  assert.ok(sent.some(s => s.target === chatId && s.text.includes('没有对应唯一的项目机器人')));
  assert.ok(sent.some(s => s.target === chatId && s.text.includes('下一行写明要处理的任务')));
  assert.ok(!app.mailboxes.list().some(e => e.direction === 'inbox' && ['om_typo', 'om_empty'].includes(e.sourceMessageId ?? '')));
  assert.equal(classifications, 0);

  app.routeCommandProject = async () => project.id;
  await receive('om_pending');
  const inbox = app.mailboxes.list().find(e => e.direction === 'inbox' && e.sourceMessageId === 'om_pending');
  assert.equal(inbox?.status, 'pending');
  assert.ok(sent.some(s => s.target === chatId && s.text.includes('等待你在工作台确认')));
  app.routeCommandProject = async () => { app.projects.archive(project.id); return project.id; };
  await receive('om_removed');
  assert.ok(sent.some(s => s.target === chatId && s.text.includes('项目状态已变化')));
  assert.equal(app.mailboxes.list().some(e => e.direction === 'inbox' && e.sourceMessageId === 'om_removed'), false);
  assert.equal(bots.inboxHandlingStatus(inbox.id).active, false);
  await assert.rejects(app.mailboxes.confirm(inbox.id, inbox.version));
  await assert.rejects(bots.replyToInbox(inbox.id, inbox.version, '旧回复', 'revoked'), /项目/);
});

test('指定同名项目或一个项目对应多个机器人时，要求点名接收者', async () => {
  const main = { botId: 'main', appId: 'main-app', status: 'joined' as const };
  const first = { project: { id: 'one', name: '海星' }, target: { botId: 'first', appId: 'first-app',
    revision: 1, ownerId: 'owner', projectId: 'one', name: '一号' } };
  for (const projectId of ['one', 'two']) {
    const second = { project: { id: projectId, name: '海星' }, target: { ...first.target, projectId, botId: 'second', appId: 'second-app' } };
    const choice = await chooseCommandTarget('项目:海星\n检查进度', { chatId: 'group', messageId: 'task' }, main, [first, second]);
    assert.equal(choice.target, undefined);
    assert.match(choice.question ?? '', /没有对应唯一的项目机器人/);
  }
});
