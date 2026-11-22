import { officeWorkerGuide } from '../../../plugins/office/guide.ts';
import { createMachineSkills } from '../../../plugins/machine-skills.ts';
import { createAgentDiagnostics } from '../../../plugins/agent-diagnostics.ts';
import { createCliSessionDiscovery } from '../../../plugins/cli-session-discovery.ts';
import { createExecutionServices } from '../../../plugins/executors.ts';
import { createProjectDiscovery } from '../../../plugins/project-discovery.ts';
import { createTerminalHost } from '../../../plugins/terminal-host.ts';
import { createLiveTerminalServices } from '../../../plugins/live-terminals.ts';
import { createAgentArtifactLoader } from './agent-artifacts.ts';
import type { startAgentNode } from './index.ts';
import type { ExecutorInfo } from '../../../packages/protocol/src/index.ts';

export type NodeHandler = NonNullable<Parameters<typeof startAgentNode>[0]['handlers']>[string];

export interface NodePlugin {
  id: string;
  handlers: Record<string, NodeHandler>;
  executors?: ExecutorInfo[];
  onDisconnect?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
}

export interface ComposedNodePlugins {
  handlers: Record<string, NodeHandler>;
  executors: ExecutorInfo[];
  onDisconnect: () => Promise<void>;
  close: () => Promise<void>;
}

async function runLifecycleHooks(hooks: Array<(() => void | Promise<void>) | undefined>, label: string): Promise<void> {
  const errors: unknown[] = [];
  for (const hook of hooks) {
    if (!hook) continue;
    try {
      await hook();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, label);
}

/** Composes node-side plugins into one conflict-checked handler map and ordered lifecycle hooks. */
export function composeNodePlugins(plugins: NodePlugin[]): ComposedNodePlugins {
  const seenIds = new Set<string>();
  const owners = new Map<string, string>();
  const handlers: Record<string, NodeHandler> = {};
  const executors: ExecutorInfo[] = [];

  for (const plugin of plugins) {
    if (seenIds.has(plugin.id)) throw new Error(`节点插件标识重复：${plugin.id}`);
    seenIds.add(plugin.id);

    for (const [method, handler] of Object.entries(plugin.handlers)) {
      if (Object.hasOwn(handlers, method)) {
        throw new Error(`节点插件处理器冲突：${method}（${owners.get(method)} 与 ${plugin.id}）`);
      }
      owners.set(method, plugin.id);
      handlers[method] = handler;
    }

    if (plugin.executors?.length) executors.push(...plugin.executors);
  }

  return {
    handlers,
    executors,
    onDisconnect: () => runLifecycleHooks(plugins.map(plugin => plugin.onDisconnect), '节点插件断连清理失败'),
    close: () => runLifecycleHooks(plugins.map(plugin => plugin.close), '节点插件关闭失败'),
  };
}

export interface DefaultNodePluginOptions {
  dataDir: string;
  machineId: string;
  agentInstanceId: string;
  launchers: NonNullable<Parameters<typeof createExecutionServices>[0]['launchers']>;
  terminalCommand?: string;
}

/** Loads and composes the built-in agent-node plugins in their standard capability order. */
export async function loadDefaultNodePlugins(options: DefaultNodePluginOptions): Promise<ComposedNodePlugins> {
  const { dataDir, machineId, agentInstanceId, launchers, terminalCommand } = options;
  // Validate and snapshot explicit launchers without probing login or starting a model.
  const diagnostics = createAgentDiagnostics({ launchers });
  const historyRoots = {
    ...(launchers.codex?.profile ? { codexHome: launchers.codex.profile.configDir } : {}),
    ...(launchers['claude-code']?.profile ? { claudeHome: launchers['claude-code'].profile.configDir } : {}),
  };
  const cliSessions = createCliSessionDiscovery(historyRoots);
  const discovery = createProjectDiscovery(historyRoots);
  const artifacts = createAgentArtifactLoader({ dataDir });
  const host = createTerminalHost({ command: terminalCommand });
  const services = createExecutionServices({ host, dataDir, machineId, agentInstanceId, launchers, validateResume: cliSessions.validateResume });
  const live = createLiveTerminalServices({ command: terminalCommand });
  const executors = await services.describe(machineId);

  return composeNodePlugins([
    { id: 'office-documents', handlers: { 'office.guide': async params => {
      if (Object.keys(params).length) throw new Error('Office 指南不接受参数');
      return { guide: officeWorkerGuide };
    } } },
    { id: 'machine-skills', handlers: createMachineSkills(historyRoots).handlers },
    { id: 'live-terminals', handlers: { ...live.handlers, 'terminal.host.start': async () => host.startServer() }, onDisconnect: live.disconnect, close: live.close },
    {
      id: 'executors',
      handlers: services.handlers,
      executors,
      onDisconnect: services.disconnect,
      close: services.close,
    },
    {
      id: 'agent-diagnostics',
      handlers: diagnostics.handlers,
    },
    {
      id: 'agent-artifacts',
      handlers: artifacts.handlers,
      close: artifacts.close,
    },
    {
      id: 'project-discovery',
      handlers: discovery.handlers,
    },
    {
      id: 'cli-session-discovery',
      handlers: cliSessions.handlers,
    },
  ]);
}
