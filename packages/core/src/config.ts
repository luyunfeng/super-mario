import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { AppConfig } from '../../protocol/src/index.ts';

export function readServerOptions(args: string[], env: NodeJS.ProcessEnv = process.env): AppConfig & { help: boolean; version: boolean } {
  const { values } = parseArgs({ args, options: { host: { type: 'string' }, port: { type: 'string' }, 'data-dir': { type: 'string' }, token: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, demo: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } } });
  const host = values.host ?? env.SUPER_MARIO_HOST ?? '127.0.0.1';
  const port = Number(values.port ?? env.SUPER_MARIO_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须是0–65535的整数');
  const token = values.token ?? env.SUPER_MARIO_TOKEN;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !token) throw new Error('监听外部地址时请设置 SUPER_MARIO_TOKEN 或 --token');
  const provider = values.provider ?? env.SUPER_MARIO_PROVIDER;
  const model = values.model ?? env.SUPER_MARIO_MODEL;
  if (Boolean(provider) !== Boolean(model)) throw new Error('请同时设置 provider 和 model');
  const feishuEnabled = env.SUPER_MARIO_FEISHU_ENABLED === '1';
  const feishu = feishuEnabled ? { appId: env.SUPER_MARIO_FEISHU_APP_ID ?? '', appSecret: env.SUPER_MARIO_FEISHU_APP_SECRET ?? '', profile: env.SUPER_MARIO_FEISHU_USER_PROFILE } : undefined;
  return { feishu, host, port, token, dataDir: resolve(values['data-dir'] ?? env.SUPER_MARIO_DATA_DIR ?? join(homedir(), '.super-mario')), demo: values.demo ?? env.SUPER_MARIO_DEMO === '1', model: provider && model ? { provider, model } : undefined, help: values.help ?? false, version: values.version ?? false };
}
