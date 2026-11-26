import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { isAbsolute, resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { AppConfig } from '../../protocol/src/index.ts';

export function serverDataDirectory(directory?: string, env: NodeJS.ProcessEnv = process.env): string {
  const cacheRoot = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(homedir(), '.cache');
  return resolve(directory ?? env.SUPER_MARIO_DATA_DIR ?? (env.SUPER_MARIO_DEV === '1' ? join(cacheRoot, 'super-mario', 'dev') : join(homedir(), '.super-mario')));
}

export function readServerOptions(args: string[], env: NodeJS.ProcessEnv = process.env): AppConfig & { help: boolean; version: boolean } {
  const { values } = parseArgs({ args, options: { host: { type: 'string' }, port: { type: 'string' }, 'data-dir': { type: 'string' }, token: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, demo: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } } });
  const host = String(values.host ?? env.SUPER_MARIO_HOST ?? '127.0.0.1').trim();
  // The address is handed straight to listen(). A mistyped one would otherwise fail later
  // with a system error that does not say what was wrong.
  // A host name is dot-separated labels. Each label starts and ends with a letter or digit,
  // so an empty label, as in "a..b", is refused rather than left for listen() to report.
  const hostname = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  if (!host || host.length > 253 || !isIP(host) && !hostname.test(host)) throw new Error('监听地址须为 IP 或主机名');
  const dev = env.SUPER_MARIO_DEV === '1';
  const portText = values.port ?? env.SUPER_MARIO_PORT;
  // An empty string would read as 0, which means any free port. That is not what a blank means.
  if (portText !== undefined && !/^\d{1,5}$/.test(portText.trim())) throw new Error('端口必须是0–65535的整数');
  const port = portText === undefined ? (dev ? 3001 : 3000) : Number(portText.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须是0–65535的整数');
  // A token made of spaces would pass the "listening outside needs a token" check while
  // protecting nothing, and would also lock local access out. It is no token.
  const token = (values.token ?? env.SUPER_MARIO_TOKEN)?.trim() || undefined;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !token) throw new Error('监听外部地址时请设置 SUPER_MARIO_TOKEN 或 --token');
  const provider = values.provider ?? env.SUPER_MARIO_PROVIDER;
  const model = values.model ?? env.SUPER_MARIO_MODEL;
  if (Boolean(provider) !== Boolean(model)) throw new Error('请同时设置 provider 和 model');
  const feishuEnabled = env.SUPER_MARIO_FEISHU_ENABLED === '1';
  const feishu = feishuEnabled ? { appId: env.SUPER_MARIO_FEISHU_APP_ID ?? '', appSecret: env.SUPER_MARIO_FEISHU_APP_SECRET ?? '', profile: env.SUPER_MARIO_FEISHU_USER_PROFILE } : undefined;
  const dataDir = serverDataDirectory(values['data-dir'], env);
  return { feishu, host, port, token, dataDir, demo: values.demo ?? env.SUPER_MARIO_DEMO === '1', model: provider && model ? { provider, model } : undefined, help: values.help ?? false, version: values.version ?? false };
}
