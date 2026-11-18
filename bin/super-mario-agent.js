#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { hostname, homedir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

async function main() {
  const { values } = parseArgs({ options: { url: { type: 'string' }, token: { type: 'string' }, name: { type: 'string' }, 'data-dir': { type: 'string' }, 'codex-command': { type: 'string' }, 'codex-config-dir': { type: 'string' }, 'claude-command': { type: 'string' }, 'claude-config-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('用法: super-mario-agent --url http://127.0.0.1:3000 --token <服务端令牌> [--name 名称] [--data-dir 目录]\n提供执行机注册、真实 CLI 会话和终端 RPC。终端命令默认 herdr，可用 SUPER_MARIO_TERMINAL_COMMAND 指定。\n执行者可选配置：--codex-command <启动器> --codex-config-dir <绝对配置目录> --claude-command <启动器> --claude-config-dir <绝对配置目录>。仅作用于此执行机，不自动登录。'); return; }
  const url = values.url ?? process.env.SUPER_MARIO_SERVER_URL;
  const token = values.token ?? process.env.SUPER_MARIO_TOKEN;
  if (!url || !token) throw new Error('请设置 --url 和 --token，或对应的 SUPER_MARIO_SERVER_URL / SUPER_MARIO_TOKEN');
  const dataDir = resolve(values['data-dir'] ?? join(homedir(), '.super-mario', 'agent'));
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, 'machine.json');
  let machineId;
  try { machineId = JSON.parse(await readFile(file, 'utf8')).id; }
  catch (error) { if (error.code !== 'ENOENT') throw error; machineId = randomUUID(); await writeFile(file, JSON.stringify({ id: machineId }), { mode: 0o600 }); }
  if (typeof machineId !== 'string' || !machineId) throw new Error('执行机标识无效，请检查 machine.json');
  const compiled = process.env.SUPER_MARIO_DEV !== '1' && existsSync(new URL('../dist/apps/agent-node/src/index.js', import.meta.url));
  const { startAgentNode } = await import(compiled ? '../dist/apps/agent-node/src/index.js' : '../apps/agent-node/src/index.ts');
  const { loadDefaultNodePlugins } = await import(compiled ? '../dist/apps/agent-node/src/node-plugins.js' : '../apps/agent-node/src/node-plugins.ts');
  const launchers = { codex: { command: 'codex' }, 'claude-code': { command: 'claude' } };
  for (const [id, prefix, fallback] of [['codex', 'CODEX', 'codex'], ['claude-code', 'CLAUDE', 'claude']]) {
    const flag = id === 'codex' ? 'codex' : 'claude';
    const command = values[`${flag}-command`] ?? process.env[`SUPER_MARIO_${prefix}_COMMAND`];
    const configDir = values[`${flag}-config-dir`] ?? process.env[`SUPER_MARIO_${prefix}_CONFIG_DIR`] ?? process.env[id === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'];
    if (command || configDir) launchers[id] = { command: command || fallback, ...(configDir ? { profile: { configDir: resolve(configDir) } } : {}) };
  }
  const agentInstanceId = randomUUID();
  const nodePlugins = await loadDefaultNodePlugins({
    dataDir,
    machineId,
    agentInstanceId,
    launchers,
    terminalCommand: process.env.SUPER_MARIO_TERMINAL_COMMAND,
  });
  const agent = await startAgentNode({
    url, token, machineId, agentInstanceId, name: values.name ?? hostname(), dataDir,
    handlers: nodePlugins.handlers, executors: nodePlugins.executors, onDisconnect: nodePlugins.onDisconnect,
  });
  console.log(`Super Mario 执行机代理已启动：${values.name ?? hostname()} (${machineId})`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await nodePlugins.close(); await agent.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
