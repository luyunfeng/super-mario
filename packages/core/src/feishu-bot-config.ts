import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateBotGroupConfig } from './bot-group-policy.ts';
import type { BotGroupAccess, BotCollaboration, BotScope, FeishuBotInput } from '../../protocol/src/bots.ts';

/** Private configuration only. Never publish these records into events or snapshots. */
export interface FeishuBotSettings {
  id: string; name: string; appId: string; appSecret: string; enabled: boolean;
  scope: BotScope; requireConfirmation: boolean; profile?: string;
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
      return { ...row, scope: validateBotScope(row.scope) };
    });
    if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.appId)).size !== rows.length) throw new Error('机器人配置包含重复标识');
    chmodSync(file, 0o600);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取机器人配置文件'); }
  function validateInput(input: Partial<FeishuBotInput>) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('机器人配置必须为对象');
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw new Error('机器人名称不能为空');
    if (input.appId !== undefined && (typeof input.appId !== 'string' || !/^cli_[A-Za-z0-9]+$/.test(input.appId.trim()))) throw new Error('机器人 appId 无效');
    for (const key of ['enabled', 'requireConfirmation'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} 必须为布尔值`);
    for (const key of ['appSecret', 'profile'] as const) if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error(`${key} 必须为文本`);
    if (input.scope !== undefined) validateBotScope(input.scope);
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
      assertUnique(appId, id);
      const now = new Date().toISOString();
      const row: FeishuBotSettings = {
        id: previous?.id ?? randomUUID(), name, appId, scope,
        appSecret: input.appSecret?.trim() || (previous?.appId === appId ? previous.appSecret : ''),
        enabled: input.enabled ?? previous?.enabled ?? true,
        requireConfirmation: input.requireConfirmation ?? previous?.requireConfirmation ?? true,
        ...(input.profile === undefined ? (previous?.profile ? { profile: previous.profile } : {}) : { profile: input.profile.trim() }),
        revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now,
      };
      const extra = validateBotGroupConfig({ executorId: input.executorId, groupChats: input.groupChats, collaboration: input.collaboration });
      row.executorId = extra.executorId === undefined ? previous?.executorId : extra.executorId || undefined;
      row.groupChats = extra.groupChats ?? previous?.groupChats;
      row.collaboration = extra.collaboration ?? previous?.collaboration;
      if (row.collaboration?.peerBotIds.includes(row.id)) throw new Error('peerBotIds 不能包含机器人自身');
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
