import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('Web 截止提醒沿原会话和当前离场设置投递，重复扫和重启只产生一条提醒', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sm-deadline-notice-'));
  const config = {dataDir, host:'127.0.0.1', port:0, demo:true};
  let server = await startServer(config);
  t.after(async () => { await server.close(); await rm(dataDir, {recursive:true,force:true}); });
  const {app} = server;
  app.presence.heartbeat({tabId:'deadline-web',visible:true,focused:true});
  const source = await app.agent.post('请我核对发件决定','main',{directWebInput:true});
  const card = app.interactions.open({kind:'question',title:'是否发送草稿？',body:'由本人决定',deadline:'2h',reversible:false,
    questions:[{question:'要发送吗？',recommend:'保留草稿',options:[{label:'保留草稿'},{label:'发送'}]}]}, source);
  await t.waitFor(()=>assert.ok(app.store.get('messages','interaction-notice:'+card.id)));
  app.presence.heartbeat({tabId:'deadline-web',visible:false,focused:false});
  app.interactions.expireTick(Date.parse(card.decisionDeadlineAt!));
  const id = 'question-deadline:'+card.id;
  await t.waitFor(()=>assert.equal(app.store.get<Message>('messages',id)?.replyTo,source.id));
  await app.background.eventbox.drain();
  const pending = app.awayNotifications.list().filter(n=>n.cardId===card.id && n.text.includes('截止时间'));
  assert.equal(pending.length,1);
  assert.equal(pending[0].status,'pending');
  await server.close();
  server = await startServer(config);
  server.app.interactions.expireTick(Date.parse(card.decisionDeadlineAt!)+1000);
  await server.app.background.eventbox.drain();
  assert.equal(server.app.awayNotifications.list().filter(n=>n.cardId===card.id && n.text.includes('截止时间')).length,1);
  assert.equal(server.app.store.get<Message>('messages',id)?.conversationId,source.conversationId);
});
