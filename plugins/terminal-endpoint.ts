import { constants, accessSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export function validTerminalSessionName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(value) && value !== '.' && value !== '..';
}

/** Match the Linux CLI's socket layout, including named sessions. */
export function terminalSocketPath(env: NodeJS.ProcessEnv): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const config = join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'herdr');
  const session = env.HERDR_SESSION;
  if (!session || session === 'default') return join(config, 'herdr.sock');
  if (!validTerminalSessionName(session)) throw new Error('Herdr 会话名称无效');
  return join(config, 'sessions', session, 'herdr.sock');
}

/** Service managers often omit the user's bin directory. Explicit paths always win. */
export function terminalCommand(command: string | undefined, env: NodeJS.ProcessEnv): string {
  const name = command || 'herdr';
  if (name.includes('/')) return resolve(name);
  const dirs = (env.PATH ?? '/usr/bin:/bin').split(delimiter);
  if (name === 'herdr') dirs.push(join(env.HOME || homedir(), '.local', 'bin'));
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue;
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch { /* Try the next PATH entry. */ }
  }
  return name;
}
