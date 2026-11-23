import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import { createStore } from '../packages/core/src/store.ts';
import { buildWindowBrief, formatWindowBrief, formatDeferredQuestions } from '../packages/core/src/briefing.ts';
import type { Todo } from '../packages/protocol/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

const hour = 3600000;
const at = (hours: number) => new Date(Date.UTC(2026, 0, 1) + hours * hour).toISOString();
const question = (id: string, createdAt: string, projectId?: string): Todo => ({
  id, title: '合成问题 ' + id, notes: '私有选项说明', projectId, createdAt, updatedAt: createdAt,
  deferredQuestion: { cardId: 'card-' + id, askedAt: new Date(Date.parse(createdAt) - 2 * hour).toISOString() },
});

test('早晚简报保留未回答的问题七天，按项目隔离，结案即移除', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  for (const id of ['a', 'b']) store.put('projects', id, { id, name: id });
  for (const id of ['a', 'b', 'unassigned']) store.put('todos', id, question(id, at(0), id === 'unassigned' ? undefined : id));
  store.put('todos', 'future', question('future', at(240), 'a'));
  store.put('todos', 'done', { ...question('done', at(0), 'a'), completedAt: at(1) });
  for (const name of ['morning', 'evening']) {
    const facts = buildWindowBrief(store, at(144), at(167), 'a');
    assert.deepEqual(facts.projects[0].deferredQuestions, [{ id: 'a', title: '合成问题 a' }]);
    assert.deepEqual(facts.projects[0].todoUpdates, []);
    assert.match(formatWindowBrief(facts, name), /可稍后回答 1：合成问题 a/);
    assert.doesNotMatch(formatWindowBrief(facts, name), /私有选项说明|合成问题 b|unassigned|future|done/);
    assert.match(formatDeferredQuestions(facts, name, '模型给出的一句话摘要'), /合成问题 a/);
    assert.equal(formatDeferredQuestions(facts, name, formatWindowBrief(facts, name)), '');
    assert.doesNotMatch(formatWindowBrief(facts, 'interval'), /可稍后回答|合成问题 a/);
  }
  assert.deepEqual(buildWindowBrief(store, at(167), at(168), 'a').projects[0].deferredQuestions, []);
  assert.ok(store.get('todos', 'a'));
});

test('Web 简报与飞书早晚定时简报共享待回答事实，主人结案后退出', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-question-brief-'));
  let options!: FeishuOptions;
  const sent: string[] = [];
  const server = await startServer({ port: 0, host: '127.0.0.1', dataDir, demo: true }, {
    botFactory: opts => {
      options = opts;
      return { start: async () => {}, close: async () => {}, collect: async () => [], status: () => ({connected:true}),
        send: async (_target, text) => { sent.push(text); } };
    },
  });
  t.after(async () => { await server.close(); await rm(dataDir, {recursive:true,force:true}); });
  async function api(path: string, method = 'GET', value?: unknown) {
    const response = await fetch(server.url + '/api/v1' + path, {method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(value)});
    assert.equal(response.ok, true, path + ' ' + response.status);
    return response.json();
  }
  const bot = await api('/feishu/bots', 'POST', {name:'合成简报机器人', appId:'cli_1111222233334444', appSecret:'synthetic-brief-test-only', scope:{kind:'global'}});
  await options.onMessage(bot.pairingCode, {messageId:'pair',chatId:'brief-owner-chat',senderId:'brief-owner',chatType:'p2p'});
  sent.length = 0;
  const now = Date.now();
  const todo = question('fixture', new Date(now - 48 * hour).toISOString());
  server.app.store.put('todos', todo.id, todo);
  const webRows = async () => (await api('/brief')).window.projects.find((p:{projectId:string}) => !p.projectId).deferredQuestions;
  assert.deepEqual(await webRows(), [{id:todo.id,title:todo.title}]);
  async function push(name: string, offset: number) {
    const scheduledFor = new Date(now + offset * hour).toISOString();
    server.app.background.publish({type:'schedule.due',typeVersion:1,sourceId:'brief-' + offset, data:{owner:'daily-brief',name,scheduleId:name,scheduledFor}});
    await server.app.background.eventbox.drain();
    await server.app.background.outbox.tick();
  }
  await push('morning', 0);
  await push('evening', 9);
  assert.equal(sent.filter(text => text.includes('可稍后回答 1：合成问题 fixture')).length, 2);
  await api('/todos/' + todo.id, 'PATCH', {completed:true});
  assert.deepEqual(await webRows(), []);
  await push('morning', 24);
  assert.equal(sent.length, 3);
  assert.doesNotMatch(sent[2], /可稍后回答|私有选项说明/);
});
