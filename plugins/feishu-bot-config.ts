import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import type { BotCollaboration, BotGroupAccess, BotScope, FeishuBotInput } from '../packages/protocol/src/index.ts';

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

/** Private configuration only. Never publish these records into events or snapshots. */
export interface FeishuBotSettings {
  id: string; name: string; appId: string; appSecret: string; enabled: boolean;
  scope: BotScope; ownerDirectReply?: boolean; readGroup?: boolean; groupTaskReportDelayMinutes?: number; decisionNudgeMinutes?: number; requireConfirmation: boolean; profile?: string;
  executorId?: string; groupChats?: BotGroupAccess[]; collaboration?: BotCollaboration;
  revision: number; createdAt: string; updatedAt: string; archivedAt?: string;
}

export function validateBotScope(value: unknown): BotScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('机器人 scope 必须为对象');
  const scope = value as Record<string, unknown>;
  const text = (key: string) => typeof scope[key] === 'string' && Boolean(scope[key].trim());
  const allowed = scope.kind === 'task' ? ['kind', 'todoId', 'projectId'] : scope.kind === 'project' ? ['kind', 'projectId'] : ['kind'];
  if (Object.keys(scope).some(key => !allowed.includes(key)) || !['global', 'unmarked', 'project', 'task'].includes(String(scope.kind))
    || (scope.kind === 'project' && !text('projectId')) || (scope.kind === 'task' && (!text('todoId') || (scope.projectId !== undefined && !text('projectId'))))) throw new Error('机器人 scope 无效');
  return structuredClone(value) as BotScope;
}

export function sameBotScope(a: BotScope, b: BotScope): boolean {
  return a.kind === b.kind && (a.kind !== 'project' || (b.kind === 'project' && a.projectId === b.projectId))
    && (a.kind !== 'task' || (b.kind === 'task' && a.todoId === b.todoId && a.projectId === b.projectId));
}

export function createFeishuBotConfig(dataDir: string, legacyAppId?: string) {
  const file = join(dataDir, 'bots.json');
  let rows: FeishuBotSettings[] = [];
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(saved)) throw new Error('机器人配置文件格式无效');
    rows = saved.map(value => {
      if (!value || typeof value !== 'object') throw new Error('机器人配置文件格式无效');
      const row = value as FeishuBotSettings;
      validateInput(row);
      if (typeof row.id !== 'string' || !row.id || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string'
        || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.appSecret !== 'string'
        || typeof row.enabled !== 'boolean' || typeof row.requireConfirmation !== 'boolean') throw new Error('机器人配置文件格式无效');
      if (row.collaboration?.peerBotIds.includes(row.id)) throw new Error('peerBotIds 不能包含机器人自身');
      const scope = validateBotScope(row.scope);
      return { ...row, scope, decisionNudgeMinutes: row.decisionNudgeMinutes ?? 60, ...(scope.kind === 'global' && { groupTaskReportDelayMinutes: row.groupTaskReportDelayMinutes ?? 10 }) };
    });
    if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.appId)).size !== rows.length) throw new Error('机器人配置包含重复标识');
    chmodSync(file, 0o600);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取机器人配置文件'); }
  function validateInput(input: Partial<FeishuBotInput>) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('机器人配置必须为对象');
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw new Error('机器人名称不能为空');
    if (input.appId !== undefined && (typeof input.appId !== 'string' || !/^cli_[A-Za-z0-9]+$/.test(input.appId.trim()))) throw new Error('机器人 appId 无效');
    for (const key of ['enabled', 'requireConfirmation', 'ownerDirectReply', 'readGroup'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} 必须为布尔值`);
    for (const key of ['appSecret', 'profile'] as const) if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error(`${key} 必须为文本`);
    if (input.scope !== undefined) validateBotScope(input.scope);
    const nudge = input.decisionNudgeMinutes;
    if (nudge !== undefined && (!Number.isSafeInteger(nudge) || nudge < 0 || nudge > 8640))
      throw new Error('待决定提醒须为 0 至 8640 的整数分钟');
    const delay = input.groupTaskReportDelayMinutes;
    if (delay !== undefined && (!Number.isInteger(delay) || delay < 0 || delay > 60))
      throw new Error('群任务回报预览时长须为 0 至 60 的整数分钟');
    validateBotGroupConfig({ executorId: input.executorId, groupChats: input.groupChats, collaboration: input.collaboration });
    if (input.collaboration && new Set(input.collaboration.peerBotIds).size !== input.collaboration.peerBotIds.length) throw new Error('peerBotIds 包含重复机器人');
  }
  function assertUnique(appId: string, id?: string) {
    let existing: { appId?: string } = {};
    try { existing = JSON.parse(readFileSync(join(dataDir, 'integrations.json'), 'utf8')) as typeof existing; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法检查旧版飞书配置'); }
    if (appId === legacyAppId || appId === existing?.appId || rows.some(row => row.id !== id && row.appId === appId)) throw new Error('appId 已被其他机器人或旧版飞书配置使用');
  }
  function save(next: FeishuBotSettings[]) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); renameSync(temp, file); }
    catch { throw new Error('无法保存机器人配置文件'); }
    finally { rmSync(temp, { force: true }); }
    rows = next;
  }
  return {
    list: () => structuredClone(rows),
    read(id: string) { const row = rows.find(row => row.id === id); if (!row || row.archivedAt) throw new Error('机器人不存在或已归档'); return structuredClone(row); },
    assertUnique,
    write(id: string | undefined, input: Partial<FeishuBotInput>) {
      validateInput(input);
      const previous = id ? this.read(id) : undefined;
      const appId = input.appId?.trim() ?? previous?.appId;
      const name = input.name?.trim() ?? previous?.name;
      const scope = input.scope === undefined ? previous?.scope : validateBotScope(input.scope);
      if (!appId || !name || !scope) throw new Error('需要机器人名称、appId 和 scope');
      if (input.readGroup === true && scope.kind !== 'global') throw new Error('只有全局机器人可启用主人读群');
      if (input.groupTaskReportDelayMinutes !== undefined && scope.kind !== 'global') throw new Error('只有全局机器人可设置群任务回报预览时长');
      assertUnique(appId, id);
      const now = new Date().toISOString();
      const row: FeishuBotSettings = {
        id: previous?.id ?? randomUUID(), name, appId, scope,
        appSecret: input.appSecret?.trim() || (previous?.appId === appId ? previous.appSecret : ''),
        enabled: input.enabled ?? previous?.enabled ?? true,
        decisionNudgeMinutes: input.decisionNudgeMinutes ?? (previous?.appId === appId ? previous.decisionNudgeMinutes ?? 60 : 60),
        ownerDirectReply: input.ownerDirectReply ?? previous?.ownerDirectReply ?? false,
        readGroup: scope.kind === 'global' && (input.readGroup ?? (previous?.appId === appId && previous.readGroup === true)),
        ...(scope.kind === 'global' && { groupTaskReportDelayMinutes: input.groupTaskReportDelayMinutes ??
          (previous?.appId === appId ? previous.groupTaskReportDelayMinutes ?? 10 : 10) }),
        requireConfirmation: input.requireConfirmation ?? previous?.requireConfirmation ?? true,
        ...(input.profile === undefined ? (previous?.profile ? { profile: previous.profile } : {}) : { profile: input.profile.trim() }),
        revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now,
      };
      const extra = validateBotGroupConfig({ executorId: input.executorId, groupChats: input.groupChats, collaboration: input.collaboration });
      row.executorId = extra.executorId === undefined ? previous?.executorId : extra.executorId || undefined;
      row.groupChats = extra.groupChats ?? previous?.groupChats;
      row.collaboration = extra.collaboration ?? previous?.collaboration;
      if (row.collaboration?.peerBotIds.includes(row.id)) throw new Error('peerBotIds 不能包含机器人自身');
      // Reminder timing does not change a card's recipient or its authority to answer.
      if (previous && input.decisionNudgeMinutes !== undefined) {
        const identityFields = new Set([...Object.keys(previous), ...Object.keys(row)] as (keyof FeishuBotSettings)[]);
        for (const key of ['decisionNudgeMinutes', 'revision', 'updatedAt'] as const) identityFields.delete(key);
        // The Web form posts empty lists even when older configurations omitted them.
        const comparable = (value: FeishuBotSettings, key: keyof FeishuBotSettings) => {
          if (key === 'groupChats') return value.groupChats ?? [];
          if (key === 'collaboration') return value.collaboration?.peerBotIds ?? [];
          return value[key];
        };
        if ([...identityFields].every(key => isDeepStrictEqual(comparable(previous, key), comparable(row, key)))) {
          row.revision = previous.revision;
        }
      }
      save([...rows.filter(item => item.id !== row.id), row]);
      return structuredClone(row);
    },
    archive(id: string) {
      const row = this.read(id), now = new Date().toISOString();
      const next = { ...row, enabled: false, archivedAt: now, updatedAt: now, revision: row.revision + 1 };
      save(rows.map(item => item.id === id ? next : item)); return next;
    },
  };
}
