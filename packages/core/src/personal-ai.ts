import type { Store } from '../../plugin-sdk/src/index.ts';
import type { PersonalAiMessage } from '../../protocol/src/personal-ai.ts';

interface Settings {
  enabled: boolean;
  prefix: string;
  contextCount: number;
  chatIds: string[];
  triggerSenderIds: string[];
  enabledAt: number;
}
export interface PersonalAiTurn {
  messageId: string;
  status: 'pending' | 'completed' | 'failed' | 'unknown';
  inboxId?: string;
  error?: string;
}
interface Options {
  store: Store;
  account(): string | undefined;
  handle(source: string, trigger: PersonalAiMessage, question: string, context: PersonalAiMessage[],
    assertCurrent: () => void): Promise<{ inboxId: string }>;
}

const settingsKey = 'personal-ai.settings';
const historyKey = 'personal-ai.history';
const recentKey = 'personal-ai.recent';
const defaults: Settings = { enabled: false, prefix: '/ai', contextCount: 10, chatIds: [], triggerSenderIds: [], enabledAt: 0 };
const openId = /^ou_[A-Za-z0-9_]+$/;
const chatId = /^oc_[A-Za-z0-9_]+$/;

function ids(value: unknown, pattern: RegExp, field: string): string[] {
  if (!Array.isArray(value) || !value.every(id => typeof id === 'string' && pattern.test(id))) {
    throw new Error(field + ' 包含无效标识');
  }
  return [...new Set(value)];
}

function chronological(a: PersonalAiMessage, b: PersonalAiMessage) {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

function sameTopic(a: PersonalAiMessage, trigger: PersonalAiMessage) {
  if (a.chatId !== trigger.chatId || a.kind !== trigger.kind) return false;
  if (a.threadId && trigger.threadId) return a.threadId === trigger.threadId;
  const root = trigger.rootId || trigger.threadId;
  if (root) return a.messageId === root || (a.rootId || a.threadId) === root;
  return !(a.rootId || a.threadId);
}

export function createPersonalAi({ store, account, handle }: Options) {
  let closed = false;
  let generation = 0;
  let lastAccount: string | undefined;
  let queue = Promise.resolve();
  const pending = new Set<string>();

  function current() {
    const raw = account();
    const source = raw && /^feishu:[A-Za-z0-9_-]+:ou_[A-Za-z0-9_]+$/.test(raw) ? raw : undefined;
    if (source !== lastAccount) {
      generation++;
      lastAccount = source;
    }
    return source;
  }
  const settings = (source: string) => store.get<Settings>(settingsKey, source) ?? defaults;
  const turnKey = (source: string) => 'personal-ai.turns.' + source;
  const claimKey = (source: string, id: string) => JSON.stringify([source, id]);

  function status() {
    const source = current();
    const { enabledAt, ...config } = source ? settings(source) : defaults;
    const turns = (source ? store.get<string[]>(recentKey, source) ?? [] : []).map(id => {
      const turn = store.get<PersonalAiTurn>(turnKey(source!), id)!;
      // The durable claim survives a crash. An interrupted handler may already have created an inbox item.
      if (turn.status === 'pending' && !pending.has(claimKey(source!, id))) {
        return { ...turn, status: 'unknown' as const, error: '处理已中断，结果未知' };
      }
      return turn;
    });
    return { ...config, chatIds: [...config.chatIds], triggerSenderIds: [...config.triggerSenderIds], turns };
  }

  function configure(input: Record<string, unknown>) {
    const source = current();
    if (!source || closed) throw new Error('当前没有可用的飞书个人账号');
    const old = settings(source);
    const next = { ...old };
    if ('enabled' in input) {
      if (typeof input.enabled !== 'boolean') throw new Error('enabled 必须为布尔值');
      next.enabled = input.enabled;
    }
    if ('prefix' in input) {
      if (typeof input.prefix !== 'string' || !/^\S{1,64}$/u.test(input.prefix)) throw new Error('前缀须为 1–64 个非空白字符');
      next.prefix = input.prefix;
    }
    if ('contextCount' in input) {
      const count = input.contextCount;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 50) throw new Error('上下文条数须为 0–50 的整数');
      next.contextCount = count;
    }
    if ('chatIds' in input) next.chatIds = ids(input.chatIds, chatId, 'chatIds');
    if ('triggerSenderIds' in input) next.triggerSenderIds = ids(input.triggerSenderIds, openId, 'triggerSenderIds');
    if (JSON.stringify(old) !== JSON.stringify(next)) {
      if (next.enabled && !old.enabled) next.enabledAt = Date.now();
      store.transaction(() => {
        store.put(settingsKey, source, next);
        if (!next.enabled || !old.enabled) {
          store.remove(historyKey, source);
        } else {
          const history = store.get<PersonalAiMessage[]>(historyKey, source);
          if (history) store.put(historyKey, source, history.filter(msg =>
            msg.kind === 'direct' || next.chatIds.includes(msg.chatId)));
        }
      });
      generation++;
    }
    return status();
  }

  function observe(source: string, messages: readonly PersonalAiMessage[], assertCollection?: () => void) {
    if (closed || current() !== source) return;
    const config = settings(source);
    if (!config.enabled) return;
    const self = source.split(':')[2];
    const version = generation;
    let collectionRevoked = false;
    function assertCurrent() {
      if (closed || current() !== source || version !== generation) throw new Error('账号或个人 AI 设置已变更');
      if (!collectionRevoked) {
        try { assertCollection?.(); } catch { collectionRevoked = true; }
      }
      if (collectionRevoked) throw new Error('采集授权已变更');
    }
    assertCurrent();
    const jobs = new Map<string, () => Promise<void>>();
    store.transaction(() => {
      const history = store.get<PersonalAiMessage[]>(historyKey, source) ?? [];
      let changed = false;
      for (const msg of [...messages].sort(chronological)) {
        if (!msg.messageId || !chatId.test(msg.chatId) || typeof msg.text !== 'string' || !msg.text.trim()
          || msg.senderIdType !== 'open_id' || !openId.test(msg.senderId)
          || !(Date.parse(msg.createdAt) >= config.enabledAt)) continue;
        const authorized = msg.senderId === self || config.triggerSenderIds.includes(msg.senderId);
        if (msg.kind !== 'direct' && msg.kind !== 'group') continue;
        if (msg.kind === 'group' && (!config.chatIds.includes(msg.chatId)
          || msg.groupObserved !== true || !Number.isInteger(msg.groupUserCount)
          || msg.groupUserCount! < 1 || msg.groupUserCount! > 50)) continue;
        if (history.some(item => item.messageId === msg.messageId)) continue;
        const text = msg.text;
        const suffix = text.slice(config.prefix.length);
        if (authorized && text.startsWith(config.prefix) && /^\s/u.test(suffix) && suffix.trim()
          && !store.get(turnKey(source), msg.messageId)) {
          const context = config.contextCount ? history.filter(item => chronological(item, msg) <= 0 && sameTopic(item, msg))
            .slice(-config.contextCount) : [];
          const messageId = msg.messageId;
          store.put<PersonalAiTurn>(turnKey(source), messageId, { messageId, status: 'pending' });
          const recent = store.get<string[]>(recentKey, source) ?? [];
          store.put(recentKey, source, [messageId, ...recent.slice(0, 99)]);
          const trigger = { ...msg };
          jobs.set(messageId, async () => {
            const key = claimKey(source, messageId);
            try {
              assertCurrent();
              const result = await handle(source, trigger, suffix.trim(), context, assertCurrent);
              assertCurrent();
              if (typeof result?.inboxId !== 'string' || !result.inboxId.trim()) {
                store.put<PersonalAiTurn>(turnKey(source), messageId, { messageId, status: 'unknown', error: '未收到有效的收件箱记录标识' });
                return;
              }
              store.put<PersonalAiTurn>(turnKey(source), messageId, { messageId, status: 'completed', inboxId: result.inboxId });
            } catch {
              if (!closed) {
                const stale = collectionRevoked || current() !== source || version !== generation;
                store.put<PersonalAiTurn>(turnKey(source), messageId, { messageId, status: stale ? 'unknown' : 'failed',
                  error: stale ? '授权或设置已变更，处理结果未知' : '收件箱处理失败' });
              }
            } finally {
              pending.delete(key);
            }
          });
        }
        history.push({ ...msg, text: text.slice(0, 4096) });
        history.sort(chronological);
        if (history.length > 500) history.shift();
        changed = true;
      }
      if (changed) store.put(historyKey, source, history);
    });
    // Claims are committed before the collector can advance its cursor. Handler latency is independent.
    for (const [messageId, job] of jobs) {
      pending.add(claimKey(source, messageId));
      queue = queue.then(job, job);
    }
  }
  return { status, configure, observe, close() { closed = true; pending.clear(); return queue; } };
}
