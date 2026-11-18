import type { BotCollaboration, BotGroupAccess, BotScope, FeishuBot } from '../../protocol/src/bots.ts';

function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是对象');
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('配置包含未知字段');
  return value as Record<string, unknown>;
}

function identifier(value: unknown, prefix = ''): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || /\s/.test(value)
    || !value.startsWith(prefix) || value.length <= prefix.length) throw new Error('标识符无效');
  return value;
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`数组最多允许 ${max} 项`);
  return value;
}

/** Undefined preserves existing configuration; explicit empty values clear it. No remote lookups. */
export function validateBotGroupConfig(input: { groupChats?: unknown; collaboration?: unknown; executorId?: unknown }): {
  groupChats?: BotGroupAccess[]; collaboration?: BotCollaboration; executorId?: string;
} {
  const config = record(input, ['groupChats', 'collaboration', 'executorId']);
  const result: { groupChats?: BotGroupAccess[]; collaboration?: BotCollaboration; executorId?: string } = {};
  if (config.executorId !== undefined) {
    if (typeof config.executorId !== 'string' || config.executorId.trim() !== config.executorId) throw new Error('executorId 无效');
    result.executorId = config.executorId;
  }
  if (config.groupChats !== undefined) {
    const groups = array(config.groupChats, 20).map(value => {
      const group = record(value, ['chatId', 'mentionOnly', 'allowedSenderIds']);
      const chatId = identifier(group.chatId, 'oc_');
      if (typeof group.mentionOnly !== 'boolean') throw new Error('mentionOnly 必须是布尔值');
      const allowedSenderIds = [...new Set(array(group.allowedSenderIds, 100).map(id => identifier(id, 'ou_')))];
      return { chatId, mentionOnly: group.mentionOnly, allowedSenderIds };
    });
    // Duplicate groups must agree: silently selecting one could widen permissions.
    const unique = new Map<string, BotGroupAccess>();
    for (const group of groups) {
      const previous = unique.get(group.chatId);
      if (previous && (previous.mentionOnly !== group.mentionOnly
        || previous.allowedSenderIds.length !== group.allowedSenderIds.length
        || previous.allowedSenderIds.some(id => !group.allowedSenderIds.includes(id)))) throw new Error('重复群配置冲突');
      unique.set(group.chatId, group);
    }
    result.groupChats = [...unique.values()];
  }
  if (config.collaboration !== undefined) {
    const collaboration = record(config.collaboration, ['peerBotIds']);
    result.collaboration = { peerBotIds: [...new Set(array(collaboration.peerBotIds, 32).map(id => identifier(id)))] };
  }
  return result;
}

/** Group messages only. Pairing and p2p admission belong to the caller. */
export function allowedBotGroup(bot: Pick<FeishuBot, 'groupChats'>, source: {
  chatId?: string; senderId?: string; mentionedSelf?: boolean;
}, ownerId?: string): boolean {
  if (!source.chatId || !source.senderId || !source.senderId.startsWith('ou_') || source.senderId.length <= 3) return false;
  const group = bot.groupChats?.find(item => item.chatId === source.chatId);
  return !!group && (!group.mentionOnly || source.mentionedSelf === true)
    && (source.senderId === ownerId || group.allowedSenderIds.includes(source.senderId));
}

export function canRelayBotScope(from: BotScope, to: BotScope): boolean {
  if (from.kind === 'unmarked' || to.kind === 'unmarked') return false;
  if (from.kind === 'global') return true;
  if (from.kind === 'project') return (to.kind === 'project' || to.kind === 'task') && from.projectId === to.projectId;
  return to.kind === 'task' && from.todoId === to.todoId && from.projectId === to.projectId;
}

export function nextRelayPath(sourceBotId: string, targetBotId: string, parentPath?: string[]): string[] {
  identifier(sourceBotId);
  identifier(targetBotId);
  const path = parentPath === undefined ? [sourceBotId] : [...array(parentPath, 8).map(id => identifier(id))];
  if (sourceBotId === targetBotId || path.length === 0 || path.at(-1) !== sourceBotId
    || new Set(path).size !== path.length || path.includes(targetBotId) || path.length >= 8) throw new Error('协作路径无效或超过 8 个机器人');
  return [...path, targetBotId];
}
