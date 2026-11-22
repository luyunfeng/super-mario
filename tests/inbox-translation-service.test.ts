import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { PluginHost, createContributions } from '../packages/core/src/plugin-host.ts';
import type { Json } from '../packages/plugin-sdk/src/index.ts';
import { createReplyTranslation } from '../plugins/reply-translation.ts';

test('收件只翻译当前飞书账号及会话的可见正文，每次模型调用与缓存命中都校验来源', async t => {
  const store = createStore(':memory:');
  const host = new PluginHost({ store, dataDir: ':memory:', events: createEventBus(store), contributions: createContributions() });
  t.after(async () => { await host.close(); store.close(); });
  const calls: string[] = [];
  let revision = 1;
  let changeDuringRequest = () => {};
  host.register(createReplyTranslation(async (text, language) => {
    calls.push(text);
    assert.equal(language, 'English');
    changeDuringRequest();
    return '合成译文 ' + calls.length;
  }, () => String(revision)));
  await host.start();
  const request = { kind: 'personal', id: 'same', account: 'feishu:app:user', chatId: 'oc_test', version: 1, target: 'en' };
  const call = (args: Record<string, Json> = {}) => host.invocations.use('reply-translation.inbox', { ...request, ...args });
  const project = { id: 'p', name: '合成项目' };
  store.put('projects', project.id, project);
  const origin = { kind: 'direct', connector: '飞书', chatId: request.chatId };
  const personal = { id: request.id, source: request.account, version: 1, origin, projectId: project.id,
    text: '[om_first] first\n[omt_second] second', title: '标题不应发送', sender: '发件人不应发送' };
  const putPersonal = (changes = {}) => store.put('inbox', request.id, { ...personal, ...changes });
  putPersonal();
  assert.deepEqual(await call(), { text: '合成译文 1' });
  assert.deepEqual(await call(), { text: '合成译文 1' });
  const otherContexts: Record<string, Json>[] = [{ chatId: 'oc_other' }, { account: 'feishu:other' }, { id: 'missing' }];
  for (const args of otherContexts) await assert.rejects(call(args), { status: 404 });
  await assert.rejects(call({ version: 2 }), { status: 409 });
  await assert.rejects(call({ text: '伪造正文' }), { status: 400 });
  await assert.rejects(call({ version: 1.5 }), { status: 400 });
  await assert.rejects(call({ target: 'unknown' }), { status: 400 });
  for (const bad of [{ origin: { ...origin, kind: 'unknown' } }, { origin: { ...origin, connector: '其他' } },
    { source: 'other' }, { text: '[om_hidden]' }]) {
    putPersonal(bad);
    await assert.rejects(call({ account: bad.source ?? request.account }), { status: 404 });
  }
  putPersonal();
  assert.deepEqual(calls, ['first\nsecond']);

  const bot = { ...request, kind: 'mailbox', account: 'synthetic-bot' };
  const entry = { id: request.id, version: 1, origin: { ...origin, kind: 'group', connector: '飞书机器人' }, direction: 'inbox',
    eventKey: 'feishu-in:fixture', botId: bot.account, sourceMessageId: 'om_input', target: bot.chatId,
    scope: { kind: 'global' }, text: '[om_input] 机器人原文' };
  const putMail = (changes = {}) => store.put('event.mailboxes', request.id, { ...entry, ...changes });
  putMail();
  assert.deepEqual(await call(bot), { text: '合成译文 2' });
  assert.deepEqual(await call(bot), { text: '合成译文 2' });
  for (const bad of [{ direction: 'outbox' }, { origin: undefined }, { sourceMessageId: undefined },
    { origin: { ...entry.origin, kind: 'agent' } }, { eventKey: 'feishu-a2a:internal' },
    { target: 'oc_other' }, { botId: 'other' }]) {
    putMail(bad);
    await assert.rejects(call(bot), { status: 404 });
  }
  assert.deepEqual(calls, ['first\nsecond', entry.text]);
  for (const [eventKey, connector] of [['feishu-collect:fixture', '飞书'], ['feishu-command:in:fixture', '飞书总指挥群']]) {
    putMail({ eventKey, origin: { ...origin, kind: 'group', connector }, version: 2 });
    assert.ok(await call({ ...bot, version: 2 }));
  }

  putMail();
  store.put('feishu.bot.envelopes', entry.id, { chatProject: project.id });
  store.put('projects', project.id, { ...project, archivedAt: '2026-01-01' });
  await assert.rejects(call(), { status: 404 });
  await assert.rejects(call(bot), { status: 404 });
  store.put('projects', project.id, project);
  revision++;
  changeDuringRequest = () => putPersonal({ version: 2 });
  await assert.rejects(call(), { status: 409 });
  changeDuringRequest = () => { revision++; };
  await assert.rejects(call(bot), { status: 409 });
});
