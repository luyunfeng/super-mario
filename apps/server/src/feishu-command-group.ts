import { createHash, randomUUID } from 'node:crypto';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { FeishuBot, Project } from '../../../packages/protocol/src/index.ts';

type MemberStatus = 'joined' | 'unknown' | 'failed';
type Member = {
  botId: string;
  appId: string;
  name: string;
  projectId?: string;
  openId?: string;
  status: MemberStatus;
  reason?: string;
};
export type CommandGroupView = {
  status: 'not_created' | 'ready' | 'partial' | 'unknown' | 'failed';
  canRetry: boolean;
  mainBotId?: string;
  chatId?: string;
  members: Member[];
  reason?: string;
};
type Saved = CommandGroupView & {
  mainBotId: string;
  mainAppId: string;
  ownerFingerprint: string;
  uuid: string;
  startedAt: number;
  invitees: string[];
  revision?: number;
};
export interface CommandGroupPlatform {
  create(mainAppId: string, ownerOpenId: string, botAppIds: string[], uuid: string): Promise<string>;
  join(mainAppId: string, chatId: string, botAppId: string): Promise<MemberStatus>;
  isMember?(chatId: string, botAppId: string): Promise<boolean | undefined>;
  resolveOpenId?(
    mainAppId: string,
    botAppId: string,
    chatId: string,
    stillCurrent: () => boolean,
  ): Promise<string | undefined>;
}
type ChatClient = Pick<Client, 'request'> & {
  im: {
    chat: Pick<Client['im']['chat'], 'create'>;
    chatMembers: Pick<Client['im']['chatMembers'], 'create' | 'isInChat'>;
    message: Pick<Client['im']['message'], 'create' | 'get' | 'list'>;
  };
};
type SenderEvidence = {
  message_id?: string;
  chat_id?: string;
  sender?: { id_type: string; id: string; sender_type: string; open_bot_id?: string };
};
function identity(items: SenderEvidence[] | undefined, chatId: string, appId: string, messageId?: string) {
  const matches = new Set<string>();
  for (const item of items ?? []) {
    const sender = item.sender;
    if (
      item.chat_id === chatId &&
      (!messageId || item.message_id === messageId) &&
      sender?.sender_type === 'app' &&
      sender.id_type === 'app_id' &&
      sender.id === appId &&
      validOpen(sender.open_bot_id)
    )
      matches.add(sender.open_bot_id);
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}
class PlatformError extends Error {
  readonly apiCode: number;
  constructor(code: number) {
    super('飞书接口返回错误码 ' + code);
    this.apiCode = code;
  }
}
async function checked<T extends { code?: number }>(request: Promise<T>) {
  let result: T;
  try {
    result = await request;
  } catch (error) {
    // Axios errors may contain bearer tokens, request bodies and app secrets.
    const code = (error as { response?: { data?: { code?: number } } })?.response?.data?.code;
    if (typeof code === 'number' && code > 0) throw new PlatformError(code);
    throw new Error('飞书回执未知');
  }
  if (result?.code !== 0) {
    if (typeof result?.code === 'number' && result.code > 0) throw new PlatformError(result.code);
    throw new Error('飞书回执未知');
  }
  return result;
}
export function createCommandGroupPlatform(
  client: (appId: string) => ChatClient,
  store: Pick<Store, 'get' | 'put' | 'transaction'>,
): CommandGroupPlatform {
  return {
    async create(appId, owner, invitees, uuid) {
      const { data } = await checked(
        client(appId).im.chat.create({
          params: { user_id_type: 'open_id', uuid },
          data: {
            name: '总指挥群',
            chat_type: 'private',
            chat_mode: 'group',
            external: false,
            user_id_list: [owner],
            bot_id_list: invitees,
          },
        }),
      );
      if (!validChat(data?.chat_id)) throw new Error('飞书未确认群标识');
      return data.chat_id;
    },
    async isMember(chatId, target) {
      // This endpoint reports membership of the app whose tenant token is used.
      const result = await checked(client(target).im.chatMembers.isInChat({ path: { chat_id: chatId } }));
      return result.data?.is_in_chat;
    },
    async resolveOpenId(mainAppId, target, chatId, stillCurrent) {
      const main = client(mainAppId);
      if (target === mainAppId) {
        const info = await checked(
          main.request<{ code: number; bot?: { open_id?: string } }>({ method: 'GET', url: '/open-apis/bot/v3/info' }),
        );
        return validOpen(info.bot?.open_id) ? info.bot.open_id : undefined;
      }
      const receipts = 'feishu.command-group.checkins';
      const key = JSON.stringify([mainAppId, chatId, target]);
      const prior = store.get<{ uuid: string; messageId?: string }>(receipts, key);
      const readBack = async (id: string) => {
        const response = await checked(
          main.im.message.get({ path: { message_id: id }, params: { user_id_type: 'open_id' } }),
        );
        return identity(response.data?.items, chatId, target, id);
      };
      if (prior?.messageId) return readBack(prior.messageId);
      // Look at sender metadata on one page of this specific group only. Never
      // persist message bodies. A lost acknowledgement can be recovered here.
      const recent = await checked(
        main.im.message.list({
          params: { container_id_type: 'chat', container_id: chatId, sort_type: 'ByCreateTimeDesc', page_size: 20 },
        }),
      ).catch(() => undefined);
      const known = identity(recent?.data?.items, chatId, target);
      if (known || prior || !stillCurrent()) return known;
      const uuid = randomUUID();
      const claimed = store.transaction(() => {
        if (store.get(receipts, key)) return false;
        store.put(receipts, key, { uuid });
        return true;
      });
      if (!claimed) return;
      const sent = await checked(
        client(target).im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: '项目机器人已加入总指挥群。' }),
            uuid,
          },
        }),
      );
      const messageId = sent.data?.message_id;
      if (!messageId) return;
      store.put(receipts, key, { uuid, messageId });
      if (stillCurrent()) return readBack(messageId);
    },
    async join(appId, chatId, target) {
      const { data } = await checked(
        client(appId).im.chatMembers.create({
          path: { chat_id: chatId },
          params: { member_id_type: 'app_id', succeed_type: 2 },
          data: { id_list: [target] },
        }),
      );
      if (!data) return 'unknown';
      if (data.invalid_id_list?.includes(target) || data.not_existed_id_list?.includes(target)) return 'failed';
      if (data.pending_approval_id_list?.includes(target)) return 'unknown';
      return 'joined';
    },
  };
}
const validChat = (id: unknown): id is string => typeof id === 'string' && /^oc_[A-Za-z0-9_-]+$/.test(id);
const validOpen = (id: unknown): id is string => typeof id === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(id);
const reject = (message: string, status = 409): never => {
  throw Object.assign(new Error(message), { status });
};
const dedupWindow = 10 * 60 * 60 * 1000;
const collection = 'feishu.command-group';
const sameMember = (a: Member, b: Member) => a.botId === b.botId && a.appId === b.appId && a.projectId === b.projectId;
function reason(error: unknown) {
  return error instanceof PlatformError
    ? '飞书返回 ' + error.apiCode + '，请核对租户限制、应用可见范围和机器人权限'
    : '未收到可核验的飞书回执';
}
// Only documented rejection codes prove that no group was created. In particular
// 232068 means "being created", and a network error may follow a successful create.
const denied = (error: unknown) =>
  error instanceof PlatformError &&
  [99991672, 232001, 232004, 232019, 232021, 232022, 232023, 232025, 232030, 232032, 232033, 232034, 232043].includes(
    error.apiCode,
  );

export function createCommandGroup(options: {
  store: Pick<Store, 'get' | 'put' | 'transaction'>;
  bots: () => FeishuBot[];
  projects: () => Project[];
  enabled: () => boolean;
  platform: CommandGroupPlatform;
  refresh: () => Promise<void>;
  now?: () => number;
}) {
  const { store, platform } = options;
  const now = options.now ?? Date.now;
  const read = () => store.get<Saved>(collection, 'current');
  function save(s: Saved) {
    const expected = s.revision ?? 0;
    store.transaction(() => {
      if ((read()?.revision ?? 0) !== expected) reject('另一请求已更新总指挥群，请刷新');
      store.put(collection, 'current', { ...s, revision: expected + 1 });
    });
    s.revision = expected + 1;
  }
  function selected(mainId: string) {
    const projects = new Set(
      options
        .projects()
        .filter((p) => !p.archivedAt)
        .map((p) => p.id),
    );
    return options
      .bots()
      .filter(
        (b) =>
          b.enabled &&
          b.configured &&
          ((b.id === mainId && b.scope.kind === 'global') ||
            (b.scope.kind === 'project' && projects.has(b.scope.projectId))),
      )
      .map(
        (b): Member => ({
          botId: b.id,
          appId: b.appId,
          name: b.name,
          ...(b.scope.kind === 'project' ? { projectId: b.scope.projectId } : {}),
          status: 'unknown',
        }),
      );
  }
  function owner(mainBotId: string, mainAppId: string) {
    const paired = store.get<{ senderId?: string; chatId?: string }>(
      'settings',
      `feishu.bot.owner:${mainBotId}:${mainAppId}`,
    );
    if (!validOpen(paired?.senderId) || !paired.chatId) return;
    return {
      id: paired.senderId,
      fingerprint: createHash('sha256')
        .update(JSON.stringify([mainBotId, mainAppId, paired.senderId, paired.chatId]))
        .digest('hex'),
    };
  }
  function get(): CommandGroupView {
    const s = read();
    if (!s) return { status: 'not_created', members: [], canRetry: true };
    const members = selected(s.mainBotId).map((candidate) => {
      const value = s.members.find((m) => sameMember(candidate, m));
      return value
        ? {
            ...candidate,
            status: value.status,
            ...(value.openId ? { openId: value.openId } : {}),
            ...(value.reason ? { reason: value.reason } : {}),
          }
        : candidate;
    });
    let { status, reason } = s;
    let canRetry = true;
    if (!s.chatId && status === 'unknown' && now() - s.startedAt >= dedupWindow) {
      canRetry = false;
      reason = '建群回执未知，已超过飞书去重时限，请人工核对原群';
    }
    if (
      !options.enabled() ||
      !members.some((m) => m.botId === s.mainBotId && m.appId === s.mainAppId && !m.projectId) ||
      owner(s.mainBotId, s.mainAppId)?.fingerprint !== s.ownerFingerprint
    ) {
      canRetry = false;
      status = 'failed';
      reason = '主机器人、配对主人或插件状态已改变';
    } else if (status === 'ready' && members.some((m) => m.status !== 'joined')) status = 'partial';
    return {
      status,
      canRetry,
      members,
      mainBotId: s.mainBotId,
      ...(s.chatId ? { chatId: s.chatId } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  let pending: Promise<CommandGroupView> | undefined;
  let pendingMain: string | undefined;
  async function execute(id?: string): Promise<CommandGroupView> {
    if (!options.enabled()) reject('飞书插件已停用');
    let s = read();
    const mains = options.bots().filter((b) => b.scope.kind === 'global' && b.configured && b.enabled);
    if (s && id && id !== s.mainBotId) reject('总指挥群已绑定其他主机器人');
    const main = mains.find((b) => b.id === (s?.mainBotId ?? id ?? (mains.length === 1 ? mains[0]!.id : undefined)));
    if (!main) return reject('请选择一个已启用且已配置的全局主机器人');
    const paired = owner(main.id, main.appId);
    if (!paired) return reject('请先在主机器人私聊中完成主人配对');
    if (s && !get().canRetry) return reject(get().reason ?? '无法安全重试');
    const desired = selected(main.id);
    const projects = desired.filter((m) => m.projectId);
    if (!s || (!s.chatId && s.status === 'failed')) {
      // On a definite refusal isolate invitation failures on retry by creating
      // the private owner group first, then adding each eligible app separately.
      const invitees = s ? [] : projects.slice(0, 5).map((m) => m.appId);
      s = {
        revision: s?.revision,
        mainBotId: main.id,
        mainAppId: main.appId,
        ownerFingerprint: paired.fingerprint,
        uuid: randomUUID(),
        startedAt: now(),
        invitees,
        members: desired,
        status: 'unknown',
        canRetry: true,
      };
    }
    if (!s.chatId) {
      if (
        s.invitees.some((appId) => !projects.some((m) => m.appId === appId && s!.members.some((old) => sameMember(old, m))))
      )
        return reject('上次建群请求中的项目绑定已变化，请人工核对');
      const fresh = !read() || read()?.status === 'failed';
      save(s);
      try {
        const chat = await platform.create(main.appId, paired.id, s.invitees, s.uuid);
        if (!validChat(chat)) throw new Error('缺少群标识');
        s.chatId = chat;
        s.status = 'partial';
        delete s.reason;
      } catch (error) {
        s.status = fresh && denied(error) ? 'failed' : 'unknown';
        s.reason = reason(error);
        save(s);
        return get();
      }
      save(s);
    }
    const chatId = s.chatId;
    // Re-read scope and owner after every await. Never grant membership or an
    // identity mapping to a replacement bot/project using an old acknowledgement.
    const authorized = () =>
      options.enabled() &&
      owner(main.id, main.appId)?.fingerprint === paired.fingerprint &&
      selected(main.id).some((m) => m.botId === main.id && m.appId === main.appId && !m.projectId);
    const previous = s.members;
    if (!authorized()) return reject('主机器人或配对已改变');
    const current = selected(main.id);
    s.members = desired
      .filter((m) => current.some((candidate) => sameMember(m, candidate)))
      .map((m) => {
        const old = previous.find((item) => sameMember(m, item));
        return {
          ...m,
          ...(old?.openId ? { openId: old.openId } : {}),
          status: m.botId === main.id ? 'joined' : (old?.status ?? 'unknown'),
        };
      });
    save(s);
    for (const m of s.members) {
      if (!authorized()) return reject('主机器人或配对已改变');
      if (!selected(main.id).some((current) => sameMember(current, m))) continue;
      const old = previous.find((item) => sameMember(m, item));
      if (m.projectId) {
        try {
          const present = platform.isMember
            ? await platform.isMember(chatId, m.appId).catch(() => undefined)
            : old?.status === 'joined';
          if (!authorized() || !selected(main.id).some((current) => sameMember(current, m))) continue;
          m.status = present === true ? 'joined' : await platform.join(main.appId, chatId, m.appId);
        } catch (error) {
          m.status = error instanceof PlatformError && error.apiCode !== 232068 ? 'failed' : 'unknown';
          m.reason = reason(error);
        }
        if (m.status !== 'joined') delete m.openId;
        if (m.status !== 'joined' && !m.reason)
          m.reason = m.status === 'failed' ? '飞书拒绝邀请，请检查应用可见范围和租户限制' : '入群尚未确认，请检查待审批邀请';
      }
      if (m.status === 'joined') {
        try {
          const openId =
            old?.openId ??
            (await platform.resolveOpenId?.(
              main.appId,
              m.appId,
              chatId,
              () => authorized() && selected(main.id).some((current) => sameMember(current, m)),
            ));
          if (validOpen(openId)) m.openId = openId;
        } catch {
          /* Joining does not prove an open ID in the main app's namespace. */
        }
        if (!m.openId && m.projectId) m.reason = '已入群，主应用尚未核实该机器人的 @ 身份';
      }
      if (!authorized()) return reject('主机器人或配对已改变');
      if (!selected(main.id).some((current) => sameMember(current, m))) {
        m.status = 'unknown';
        delete m.openId;
      }
      save(s);
    }
    s.members = s.members.filter((m) => selected(main.id).some((current) => sameMember(current, m)));
    s.status = s.members.every((m) => m.status === 'joined') ? 'ready' : 'partial';
    delete s.reason;
    save(s);
    try {
      await options.refresh();
    } catch {
      s.status = 'partial';
      s.reason = '请重试同步以刷新主机器人订阅';
      save(s);
    }
    return get();
  }
  return {
    get,
    async sync(input: Record<string, unknown>) {
      if (
        Object.keys(input).some((k) => k !== 'mainBotId') ||
        ('mainBotId' in input && (typeof input.mainBotId !== 'string' || !input.mainBotId.trim()))
      )
        return reject('仅支持可选的 mainBotId', 400);
      const id = input.mainBotId as string | undefined;
      if (pending) {
        if (id && id !== (read()?.mainBotId ?? pendingMain)) return reject('另一主机器人正在同步');
        return pending;
      }
      pendingMain = id;
      pending = execute(id).finally(() => {
        pending = undefined;
        pendingMain = undefined;
      });
      return pending;
    },
  };
}
