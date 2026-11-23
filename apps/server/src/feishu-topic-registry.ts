import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';

export type TopicChatInput = { chatId: string; name?: string; home?: boolean; requireOwnerMention?: boolean };
type TopicChat = Required<TopicChatInput> & { addedAt: string };
type Enrollment = TopicChat & { explicitHomeOnly: boolean; grant: string };
type Registry = { version: number; items: Enrollment[] };
type Command = 'on' | 'off' | 'home';

const collection = 'feishu.topic-registry';
const receipts = 'feishu.topic-commands';
const capacity = 50;

function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
function chatId(value: unknown) {
  if (typeof value !== 'string') fail('话题群 ID 无效');
  const id = value.trim();
  if (!id || Buffer.byteLength(id) > 100 || /[\s\p{Cc}]/u.test(id)) fail('话题群 ID 无效');
  return id;
}
function view(registry: Registry) {
  const home = registry.items.find(item => item.home) ?? registry.items.find(item => !item.explicitHomeOnly);
  return { version: registry.version, items: registry.items.map(({ chatId, name, addedAt, requireOwnerMention }) =>
    ({ chatId, name, addedAt, requireOwnerMention, home: chatId === home?.chatId })) };
}

export function createTopicRegistry(store: Pick<Store, 'get' | 'put' | 'transaction'>) {
  function load(binding: string): Registry {
    if (typeof binding !== 'string' || !binding.trim()) fail('机器人尚未配对', 403);
    return store.get<Registry>(collection, binding) ?? { version: 0, items: [] };
  }
  function save(binding: string, before: Registry, items: Enrollment[]) {
    if (JSON.stringify(before.items) === JSON.stringify(items)) return before;
    const next = { version: before.version + 1, items };
    store.put(collection, binding, next);
    return next;
  }
  function replace(binding: string, version: number, items: TopicChatInput[]) {
    return store.transaction(() => {
      const current = load(binding);
      if (!Number.isSafeInteger(version) || version < 0) fail('缺少有效的话题群版本');
      if (version !== current.version) fail('话题群列表已有更新，请刷新后再保存', 409);
      if (!Array.isArray(items) || items.length > capacity) fail('话题群列表最多可登记 50 个群');
      const seen = new Set<string>();
      const inputs = items.map((item: TopicChatInput) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) fail('话题群设置无效');
        const id = chatId(item.chatId);
        if (seen.has(id)) fail('话题群 ID 重复');
        seen.add(id);
        if (item.name !== undefined && typeof item.name !== 'string') fail('话题群名称无效');
        if (item.home !== undefined && typeof item.home !== 'boolean') fail('主群标记无效');
        if (item.requireOwnerMention !== undefined && typeof item.requireOwnerMention !== 'boolean') fail('点名设置无效');
        return { ...item, chatId: id };
      });
      if (inputs.filter(i => i.home).length > 1) fail('只能指定一个主群');
      const keepHome = inputs.every(i => i.home === undefined);
      const now = new Date().toISOString();
      const next = inputs.map(i => {
        const old = current.items.find(o => o.chatId === i.chatId);
        const requireOwnerMention = i.requireOwnerMention ?? old?.requireOwnerMention ?? false;
        // A strict enrollment needs an explicit home designation even if its mention rule later changes.
        return { chatId: i.chatId, name: i.name?.trim() ?? '', home: keepHome ? old?.home ?? false : i.home ?? false,
          requireOwnerMention, addedAt: old?.addedAt ?? now, explicitHomeOnly: old?.explicitHomeOnly ?? requireOwnerMention, grant: old?.grant ?? randomUUID() };
      });
      return view(save(binding, current, next));
    });
  }
  function command(binding: string, rawId: string, messageId: string, cmd: Command): string | undefined {
    return store.transaction(() => {
      const current = load(binding);
      const id = chatId(rawId);
      if (!messageId?.trim() || !['on', 'off', 'home'].includes(cmd)) fail('话题群命令无效');
      const key = createHash('sha256').update(JSON.stringify([binding, id, messageId])).digest('hex');
      if (store.get(receipts, key)) return;
      // Consume all outcomes, including a full list or a no-op. Redelivery cannot act on a newer registry.
      store.put(receipts, key, true);
      const old = current.items.find(item => item.chatId === id);
      if (cmd === 'off') {
        if (!old) return '本群尚未登记为话题群。';
        save(binding, current, current.items.filter(item => item.chatId !== id));
        return '本群已退出话题群列表。';
      }
      if (cmd === 'on' && old) return '本群已是话题群。';
      if (cmd === 'home' && old?.home) return '本群已是指定的主群。';
      if (!old && current.items.length >= capacity) return '话题群数量已达上限 50 个，请先移除一个群。';
      const next = cmd === 'home' ? current.items.map(item => ({ ...item, home: item.chatId === id })) : [...current.items];
      if (!old) next.push({ chatId: id, name: '', home: cmd === 'home', requireOwnerMention: false,
        addedAt: new Date().toISOString(), explicitHomeOnly: false, grant: randomUUID() });
      save(binding, current, next);
      return cmd === 'home' ? '本群已设为主话题群。' : '本群已登记为话题群。';
    });
  }
  function grant(binding: string, id: string) { return load(binding).items.find(item => item.chatId === id)?.grant; }
  return { read: (binding: string) => view(load(binding)), replace, command, grant };
}
