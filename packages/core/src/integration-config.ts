import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../protocol/src/index.ts';

export interface FeishuSettings { enabled: boolean; appId: string; appSecret: string; profile?: string; collectEnabled?: boolean }
/** Credentials stay in a private local file, never in snapshots, events, or the repository. */
export function createIntegrationConfig(dataDir: string, override?: AppConfig['feishu']) {
  const file = join(dataDir, 'integrations.json');
  let current: FeishuSettings = { enabled: false, appId: '', appSecret: '' };
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as FeishuSettings;
    if (typeof saved.enabled !== 'boolean' || typeof saved.appId !== 'string' || typeof saved.appSecret !== 'string' || (saved.profile !== undefined && typeof saved.profile !== 'string')) throw new Error('飞书配置文件格式无效');
    if (saved.collectEnabled !== undefined && typeof saved.collectEnabled !== 'boolean') throw new Error('自动采集配置必须为布尔值');
    current = { ...saved, collectEnabled: saved.collectEnabled === true };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (override) current = { enabled: true, ...override };
  return {
    read(): FeishuSettings { return { ...current }; },
    public() { return { enabled: current.enabled, configured: Boolean(current.appId && current.appSecret), appId: current.appId, profile: current.profile, collectEnabled: current.collectEnabled === true }; },
    write(input: Record<string, unknown>) {
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('enabled必须为布尔值');
      if (input.appId !== undefined && typeof input.appId !== 'string') throw new Error('应用ID必须是文本');
      if (input.appSecret !== undefined && typeof input.appSecret !== 'string') throw new Error('应用密钥必须是文本');
      if (input.collectEnabled !== undefined && typeof input.collectEnabled !== 'boolean') throw new Error('自动采集配置必须为布尔值');
      if (input.profile !== undefined && typeof input.profile !== 'string') throw new Error('profile必须是文本');
      const appId = (input.appId as string | undefined)?.trim() ?? current.appId;
      const appSecret = (input.appSecret as string | undefined)?.trim() || (appId === current.appId ? current.appSecret : '');
      const next: FeishuSettings = { collectEnabled: input.collectEnabled as boolean | undefined ?? current.collectEnabled ?? false, enabled: input.enabled as boolean | undefined ?? true, appId, appSecret, profile: input.profile === undefined ? current.profile : (input.profile as string).trim() || undefined };
      if (next.enabled && (!/^cli_[A-Za-z0-9]+$/.test(appId) || !appSecret)) throw new Error('请填写有效的应用ID和应用密钥');
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 }); renameSync(temporary, file);
      const identityChanged = current.appId !== next.appId;
      current = next;
      return { identityChanged };
    },
  };
}
