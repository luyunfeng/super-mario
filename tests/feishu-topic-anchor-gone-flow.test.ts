import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { startServer } from '../apps/server/src/index.ts';
import { createFeishuIntegration } from '../plugins/feishu.ts';
import type { Todo } from '../packages/protocol/src/index.ts';

test('飞书确认父消息消失后等待新主人发言，迟到的撤回回执与网络失败均保留更新的锚点', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-topic-gone-'));
  let dispatcher!: EventDispatcher;
  const attempts: Array<{ parent: string; inThread: boolean }> = [];
  let sequence = 0;
  let respond: () => Promise<Response> = async () => Response.json({ code: 0, data: { message_id: 'om_completed' } });
  const host = await startServer(
    { dataDir: dir, host: '127.0.0.1', port: 0, demo: true, token: 'fixture' },
    {
      botFactory: (options) =>
        createFeishuIntegration({
          ...options,
          fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path.includes('tenant_access_token'))
              return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
            if (path.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: 'ou_bot' } });
            const body = JSON.parse(String(init?.body ?? '{}'));
            if (body.msg_type === 'text' && JSON.parse(body.content).text === '这项待办已完成。') {
              attempts.push({
                parent: path.match(/\/messages\/([^/]+)\/reply$/)?.[1] ?? '',
                inThread: body.reply_in_thread === true,
              });
              return respond();
            }
            return Response.json({ code: 0, data: { message_id: 'om_offline_' + ++sequence } });
          },
          wsFactory: (options) => ({
            async start(input) {
              dispatcher = input.eventDispatcher;
              options.onReady?.();
            },
            close() {},
            getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }),
          }),
        }),
    }
  );
  t.after(async () => {
    try {
      await host.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  const bot = await host.bots.create({
    name: '合成助手',
    appId: 'cli_1111111111111111',
    appSecret: 'fixture',
    scope: { kind: 'global' },
    requireConfirmation: false,
  });
  const thread = 'omt_anchor',
    root = 'om_anchor_open';
  async function emit(id: string, text: string, privateChat = false, inThread = false, sender = 'ou_owner') {
    await dispatcher.invoke(
      {
        schema: '2.0',
        header: { event_type: 'im.message.receive_v1', event_id: 'ev_' + id },
        event: {
          sender: { sender_type: 'user', sender_id: { open_id: sender } },
          message: {
            message_id: id,
            chat_type: privateChat ? 'p2p' : 'group',
            chat_id: privateChat ? 'oc_private' : 'oc_group',
            message_type: 'text',
            content: JSON.stringify({ text }),
            ...(inThread && { thread_id: thread, ...(id !== root && { root_id: root, parent_id: root }) }),
          },
        },
      },
      { needCheck: false }
    );
  }
  const wait = (check: () => void) => t.waitFor(check, { timeout: 6000 });
  await emit('om_pair', bot.pairingCode!, true);
  await wait(() => assert.ok(host.bots.list().find((row) => row.id === bot.id)?.paired));
  await emit('om_enroll', '/topics');
  const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
  await t.waitFor(async () => {
    const response = await fetch(host.url + '/api/v1/feishu/bots/' + bot.id + '/topic-chats', { headers });
    assert.ok((await response.json()).items.some((r: { chatId: string }) => r.chatId === 'oc_group'));
  });
  await emit(root, '合成父消息归属测试', false, true);
  const todo = await t.waitFor(() => {
    const value = host.app.store.list<Todo>('todos').find((row) => row.title === '合成父消息归属测试');
    assert.ok(value);
    assert.ok(host.app.store.list<{ topic?: { opening?: boolean } }>('message.routes').some((r) => r.topic?.opening));
    return value;
  });
  async function update(completed: boolean) {
    const res = await fetch(host.url + '/api/v1/todos/' + todo.id, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ completed }),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as Todo).completedAt!;
  }
  const receipt = (generation: string) =>
    host.app.store
      .list<{ completedAt: string; delivery: string }>('feishu.topic-completions')
      .find((row) => row.completedAt === generation)?.delivery;
  const anchor = () => host.app.store.list<Array<{ messageId: string }>>('feishu.topic-anchors').flat()[0]?.messageId;
  const gone = async () => Response.json({ code: 230011 }, { status: 400 });
  const success = respond;
  async function ownerAnchor(id: string) {
    // An accepted topic message changes the destination without invoking an assistant turn.
    await emit(id, '/noreply', false, true);
    await wait(() => assert.equal(anchor(), id));
  }
  respond = gone;
  const first = await update(true);
  await wait(() => assert.equal(receipt(first), 'failed'));
  assert.equal(anchor(), undefined);
  await update(false);
  await emit('om_outsider', '/noreply', false, true, 'ou_other');
  const noParent = await update(true);
  assert.equal(host.app.store.get<Todo>('todos', todo.id)?.completedAt, noParent);
  assert.equal(receipt(noParent), undefined);
  assert.equal(attempts.length, 1);

  await update(false);
  await ownerAnchor('om_next');
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  respond = async () => {
    await paused;
    return gone();
  };
  const oldParent = await update(true);
  try {
    await wait(() => assert.equal(attempts.length, 2));
    await update(false);
    await ownerAnchor('om_newest');
  } finally {
    release();
  }
  await wait(() => assert.equal(receipt(oldParent), 'failed'));
  assert.equal(anchor(), 'om_newest');

  respond = async () => {
    throw new Error('合成连接中断');
  };
  const unknown = await update(true);
  await wait(() => assert.equal(attempts.length, 3));
  assert.equal(receipt(unknown), 'unknown');
  await update(false);
  respond = success;
  const final = await update(true);
  await wait(() => assert.equal(receipt(final), 'confirmed'));
  assert.deepEqual(
    attempts.map((x) => x.parent),
    [root, 'om_next', 'om_newest', 'om_newest']
  );
  assert.equal(receipt(noParent), undefined);
  assert.ok(attempts.every((x) => x.inThread));
});
