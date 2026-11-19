import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeishuBot, Project } from '../packages/protocol/src/index.ts';
import { createStore } from '../packages/core/src/store.ts';
import {
  createCommandGroup,
  createCommandGroupPlatform,
  type CommandGroupPlatform,
} from '../apps/server/src/feishu-command-group.ts';

function bot(id: string, projectId?: string): FeishuBot {
  return {
    id,
    name: id,
    appId: 'cli_' + id,
    scope: projectId ? { kind: 'project', projectId } : { kind: 'global' },
    enabled: true,
    configured: true,
    paired: true,
    connected: true,
    requireConfirmation: true,
    createdAt: 'now',
    updatedAt: 'now',
    pairingCode: 'private-pairing-code',
  };
}
function setup(t: { after(fn: () => void): void }, platform: CommandGroupPlatform) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const bots = [
    bot('main'),
    ...Array.from({ length: 7 }, (_, i) => bot('bot' + i, 'p' + i)),
    bot('archived', 'gone'),
    { ...bot('disabled', 'disabled-project'), enabled: false },
  ];
  const projects = bots.flatMap((b) =>
    b.scope.kind === 'project'
      ? [{ id: b.scope.projectId, archivedAt: b.id === 'archived' ? 'past' : undefined } as Project]
      : [],
  );
  const pair = () => store.put('settings', 'feishu.bot.owner:main:cli_main', { chatId: 'oc_private', senderId: 'ou_owner' });
  let time = 10;
  const service = () =>
    createCommandGroup({
      store,
      bots: () => bots,
      projects: () => projects,
      platform,
      enabled: () => true,
      now: () => time,
      refresh: async () => {},
    });
  return {
    store,
    bots,
    projects,
    pair,
    service,
    expire: () => {
      time += 10 * 3600000;
    },
  };
}

test('command group pins owner, filters live project bindings, serializes create and retries failed members only', async (t) => {
  let creates = 0,
    repaired = false;
  const joins: string[] = [];
  const f = setup(t, {
    async create(app, owner, ids, uuid) {
      creates++;
      assert.equal(app, 'cli_main');
      assert.equal(owner, 'ou_owner');
      assert.ok(uuid);
      assert.deepEqual(ids, ['cli_bot0', 'cli_bot1', 'cli_bot2', 'cli_bot3', 'cli_bot4']);
      return 'oc_command';
    },
    async join(app, chat, target) {
      assert.equal(chat, 'oc_command');
      joins.push(target);
      return !repaired && target === 'cli_bot0' ? 'failed' : 'joined';
    },
    async resolveOpenId(app, target, chat) {
      assert.equal(chat, 'oc_command');
      return target === 'cli_main' ? 'ou_main' : 'ou_' + target;
    },
  });
  const service = f.service();
  assert.equal(service.get().status, 'not_created');
  await assert.rejects(service.sync({}), { status: 409 });
  f.pair();
  f.bots.push(bot('othermain'));
  await assert.rejects(service.sync({}), { status: 409 });
  await assert.rejects(service.sync({ members: [] }), { status: 400 });
  const views = await Promise.all([service.sync({ mainBotId: 'main' }), service.sync({ mainBotId: 'main' })]);
  assert.deepEqual(views[0], views[1]);
  assert.equal(views[0].status, 'partial');
  assert.equal(views[0].members.length, 8);
  assert.equal(creates, 1);
  assert.equal(joins.length, 7);
  assert.doesNotMatch(JSON.stringify(views[0]), /private-pairing-code|oc_private|ou_owner|ownerFingerprint/);
  repaired = true;
  assert.equal((await f.service().sync({})).status, 'ready');
  assert.equal(creates, 1);
  assert.equal(joins.length, 8);
  f.projects.find((p) => p.id === 'p0')!.archivedAt = 'today';
  assert.ok(!(await service.sync({})).members.some((m) => m.appId === 'cli_bot0'));
  f.store.put('settings', 'feishu.bot.owner:main:cli_main', { senderId: 'ou_replaced', chatId: 'oc_private' });
  assert.equal(service.get().canRetry, false);
  await assert.rejects(service.sync({ mainBotId: 'othermain' }), { status: 409 });
  await assert.rejects(service.sync({}), { status: 409 });
});

test('unknown create never leaks SDK errors, reuses its UUID across restart and stops at the dedup deadline', async (t) => {
  const keys: string[] = [];
  const f = setup(t, {
    async create(_main, _owner, _ids, uuid) {
      keys.push(uuid);
      throw Error('secret-token');
    },
    async join() {
      throw Error('unexpected');
    },
  });
  f.pair();
  let view = await f.service().sync({});
  assert.equal(view.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(view), /secret-token/);
  view = await f.service().sync({});
  assert.equal(view.status, 'unknown');
  assert.equal(keys.length, 2);
  assert.equal(keys[1], keys[0]);
  f.expire();
  assert.equal(f.service().get().canRetry, false);
  await assert.rejects(f.service().sync({}), { status: 409 });
  assert.equal(keys.length, 2);
});

type SdkClient = ReturnType<Parameters<typeof createCommandGroupPlatform>[0]>;
function evidence(chat = 'oc_group', id = 'cli_project', open = 'ou_seen_by_main') {
  return {
    chat_id: chat,
    message_id: 'om_receipt',
    sender: { id_type: 'app_id', sender_type: 'app', id, open_bot_id: open },
  };
}
test('SDK contract uses app_id for invitations, private chat, and explicit partial/approval responses', async (t) => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  let reply = { pending_approval_id_list: ['cli_p'], invalid_id_list: [] as string[], not_existed_id_list: [] as string[] };
  const sdk = {
    im: {
      chat: {
        async create(input: unknown) {
          assert.deepEqual(input, {
            params: { user_id_type: 'open_id', uuid: 'once' },
            data: {
              chat_type: 'private',
              chat_mode: 'group',
              external: false,
              name: '总指挥群',
              user_id_list: ['ou_owner'],
              bot_id_list: ['cli_p'],
            },
          });
          return { code: 0, data: { chat_id: 'oc_group' } };
        },
      },
      chatMembers: {
        async create(input: unknown) {
          assert.deepEqual(input, {
            params: { member_id_type: 'app_id', succeed_type: 2 },
            path: { chat_id: 'oc_group' },
            data: { id_list: ['cli_p'] },
          });
          return { code: 0, data: reply };
        },
      },
    },
  } as unknown as SdkClient;
  const api = createCommandGroupPlatform(() => sdk, store);
  assert.equal(await api.create('cli_main', 'ou_owner', ['cli_p'], 'once'), 'oc_group');
  assert.equal(await api.join('cli_main', 'oc_group', 'cli_p'), 'unknown');
  reply = { ...reply, pending_approval_id_list: [], not_existed_id_list: ['cli_p'] };
  assert.equal(await api.join('cli_main', 'oc_group', 'cli_p'), 'failed');
  reply = { ...reply, not_existed_id_list: [], invalid_id_list: ['cli_p'] };
  assert.equal(await api.join('cli_main', 'oc_group', 'cli_p'), 'failed');
  reply = { ...reply, invalid_id_list: [] };
  assert.equal(await api.join('cli_main', 'oc_group', 'cli_p'), 'joined');
});

test('main-app SDK verifies sender and chat on readback; check-in with lost receipt is never resent', async (t) => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  let list = [evidence('oc_wrong'), evidence('oc_group', 'cli_other')],
    read = [{ ...evidence(), sender: { ...evidence().sender, sender_type: 'user' } }];
  let sends = 0,
    gets = 0,
    lose = false;
  const sdk = (app: string) =>
    ({
      im: {
        message: {
          async list({ params }: { params: { container_id: string; page_size: number } }) {
            assert.equal(app, 'cli_main');
            assert.equal(params.container_id, 'oc_group');
            assert.ok(params.page_size <= 20);
            return { code: 0, data: { items: list } };
          },
          async get({ path }: { path: { message_id: string } }) {
            gets++;
            assert.equal(app, 'cli_main');
            assert.equal(path.message_id, 'om_receipt');
            return { code: 0, data: { items: read } };
          },
          async create({
            params,
            data,
          }: {
            params: { receive_id_type: string };
            data: { receive_id: string; uuid: string };
          }) {
            sends++;
            assert.ok(['cli_project', 'cli_lost'].includes(app));
            assert.equal(params.receive_id_type, 'chat_id');
            assert.equal(data.receive_id, 'oc_group');
            assert.ok(data.uuid);
            if (lose) throw Error('lost');
            return { code: 0, data: { message_id: 'om_receipt' } };
          },
        },
      },
    }) as unknown as SdkClient;
  const resolve = (target: string, live = true) =>
    createCommandGroupPlatform(sdk, store).resolveOpenId!('cli_main', target, 'oc_group', () => live);
  assert.equal(await resolve('cli_project', false), undefined);
  assert.equal(sends, 0);
  assert.equal(await resolve('cli_project'), undefined);
  assert.equal(sends, 1);
  assert.equal(gets, 1);
  read = [{ ...evidence(), message_id: 'om_other' }];
  assert.equal(await resolve('cli_project'), undefined);
  read = [evidence()];
  assert.equal(await resolve('cli_project'), 'ou_seen_by_main');
  assert.equal(sends, 1);
  lose = true;
  await assert.rejects(resolve('cli_lost'));
  assert.equal(sends, 2);
  assert.equal(await resolve('cli_lost'), undefined);
  assert.equal(sends, 2);
  list = [evidence('oc_group', 'cli_lost', 'ou_recovered')];
  assert.equal(await resolve('cli_lost'), 'ou_recovered');
  assert.equal(sends, 2);
});
