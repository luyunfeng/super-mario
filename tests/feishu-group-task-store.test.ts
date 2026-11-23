import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createGroupTasks } from '../apps/server/src/feishu-group-tasks.ts';
import type { Todo } from '../packages/protocol/src/index.ts';
import type { FeishuMessageSource } from '../plugins/feishu.ts';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-group-task-'));
  const path = join(dir, 'test.sqlite');
  let store = createStore(path);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const create = (input: { title: string; notes: string }): Todo => {
    const now = new Date().toISOString();
    const todo = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    store.put('todos', todo.id, todo);
    return todo;
  };
  return { store: () => store, create, service: () => createGroupTasks(store, create),
    restart() { store.close(); store = createStore(path); return createGroupTasks(store, create); } };
}
const source: FeishuMessageSource = { chatId: 'oc_group', messageId: 'om_request',
  senderId: 'ou_owner', senderType: 'user', chatType: 'group', mentionedSelf: true };
const gate = () => true;
const forbidden = async () => assert.fail('不应发送或交接');

test('真实待办与来源一起提交，重启只补交接并使用首次主人请求及引用', async t => {
  const f = await fixture(t);
  const faulty = createGroupTasks(f.store(), input => { f.create(input); throw Error('本地失败'); });
  await assert.rejects(faulty.open('b', 'app', 'owner', source, '未提交', gate, forbidden, forbidden), /本地失败/);
  assert.deepEqual(f.store().list('todos'), []);
  const text = '😀'.repeat(4300) + '保留结尾';
  const quoted = '背景'.repeat(200);
  let count = 0;
  await assert.rejects(f.service().open('b', 'app', 'owner', { ...source, quotedText: quoted }, text, gate,
    async todo => { count++; assert.ok(todo.notes.includes(text)); assert.equal(Array.from(todo.title).length, 80); return 'om_anchor'; },
    forbidden, async () => { throw Error('本地入箱暂不可用'); }), /本地入箱暂不可用/);
  const retry = f.restart();
  await retry.open('b', 'app', 'owner', { ...source, quotedText: '另一段引用' }, '替换了原文', gate, forbidden, forbidden,
    async (todo, id, frozen) => {
      assert.equal(id, 'om_anchor'); assert.equal(frozen.request, text);
      assert.equal(frozen.quote, '背景'.repeat(150)); assert.match(todo.notes, /仅作背景/);
    });
  await retry.open('b', 'app', 'owner', source, '重放', gate, forbidden, forbidden, forbidden);
  const [receipt] = f.store().list<{ botId: string; appId: string; handedOff: boolean }>('feishu.group-tasks');
  assert.deepEqual([receipt.botId, receipt.appId, receipt.handedOff], ['b', 'app', true]);
  assert.equal(f.store().list('todos').length, 1); assert.equal(count, 1);
});
test('送达未知及缺少回执不重发，明确未发送可由相同请求恢复', async t => {
  const f = await fixture(t);
  const service = f.service();
  await assert.rejects(service.open('b', 'app', 'owner', source, '任务', gate, async () => { throw Error('连接断开'); }, forbidden));
  const next = f.restart();
  await next.open('b', 'app', 'owner', source, '任务', gate, forbidden, forbidden, forbidden);
  const bare = { ...source, messageId: 'om_help' };
  await next.open('b', 'app', 'owner', bare, '', gate, forbidden, async text => { assert.match(text, /\/ai/); });
  await next.open('b', 'app', 'owner', bare, '替换裸命令', gate, forbidden, forbidden);
  const unsent = { ...source, messageId: 'om_unsent' };
  await assert.rejects(next.open('b', 'app', 'owner', unsent, '恢复任务', gate,
    async () => { throw Object.assign(Error('本地阻止'), { delivery: 'no' }); }, forbidden));
  let sent = 0;
  await next.open('b', 'app', 'owner', unsent, '重放', gate, async todo => {
    assert.equal(todo.title, '恢复任务'); sent++; return 'om_anchor2';
  }, forbidden);
  assert.equal(sent, 1); assert.equal(f.store().list('todos').length, 2);
});
test('提前撤回阻止建任务，投递中撤回阻止交接，普通或未知聊天类型不进入', async t => {
  const f = await fixture(t), service = f.service();
  service.recall('b', 'app', source.chatId, source.messageId);
  const next = f.restart();
  await next.open('b', 'app', 'owner', source, '撤回', gate, forbidden, forbidden);
  assert.equal(next.recalled('b', 'app', source.chatId, source.messageId), true);
  for (const chatType of ['p2p', undefined, 'other']) {
    await next.open('b', 'app', 'owner', { ...source, chatType, messageId: 'om_bad' }, '错误范围', gate, forbidden, forbidden);
  }
  assert.equal(f.store().list('todos').length, 0);
  const msg = { ...source, messageId: 'om_mid' };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const pending = next.open('b', 'app', 'owner', msg, '处理中', gate, async () => { await blocked; return 'om_anchor'; }, forbidden, forbidden);
  await next.open('b', 'app', 'owner', msg, '并发重放', gate, forbidden, forbidden, forbidden);
  next.recall('b', 'app', msg.chatId, msg.messageId); release(); await pending;
  assert.equal(f.store().list('todos').length, 1);
});
