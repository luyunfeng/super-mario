// Live Agent Bridge plugin: gives pi (Web & Feishu Super Agent) read-only visibility
// into live Herdr agents across bound project directories, plus approval-gated A2A control.
import { isAbsolute, relative, resolve } from 'node:path';
import type { Extension, Json, JsonObject, MachineClient, Tool } from '../packages/plugin-sdk/src/index.ts';
import type { Project } from '../packages/protocol/src/index.ts';

export const LIVE_AGENT_SEND_APPROVAL = 'plugin:live-agent-bridge.send';
export const LIVE_AGENT_ANSWER_APPROVAL = 'plugin:live-agent-bridge.answer_prompt';

export interface LiveTakeoverView {
  key: string;
  machineId: string;
  machineName: string;
  paneId: string;
  terminalId: string;
  cwd: string;
  paneTitle: string;
  agent: string;
  projectId?: string;
  kind: string;
  title: string;
  excerpt: string;
  options: Array<{ label: string; keys: string }>;
  status: string;
}

export interface LiveAgentBridgeHost {
  projects(): Project[];
  machines(): MachineClient | undefined;
  takeoverList(): LiveTakeoverView[];
  sessionCustomTitle(machineId: string, executorId: string, nativeSessionId: string): string | undefined;
  proposeSend(input: {
    machineId: string;
    machineName: string;
    paneId: string;
    terminalId: string;
    cwd: string;
    text: string;
    submit: boolean;
    reason: string;
    projectId?: string;
  }): Json;
  proposeAnswerPrompt(input: {
    prompt: LiveTakeoverView;
    optionLabel: string;
    keys: string;
    reason: string;
  }): Json;
}

function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
}

function matchProjects(all: Project[], projectId?: string, projectName?: string): Project[] {
  const active = all.filter(p => !p.archivedAt);
  if (projectId) return active.filter(p => p.id === projectId);
  if (projectName) {
    const q = projectName.trim().toLowerCase();
    return active.filter(p =>
      p.name.toLowerCase().includes(q)
      || (p.workspace?.cwd?.toLowerCase().includes(q) ?? false));
  }
  return active;
}

function tool(
  name: string,
  description: string,
  properties: JsonObject,
  required: string[],
  execute: (args: JsonObject, signal: AbortSignal) => Promise<Json>,
): Tool {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required },
    execute,
  };
}

/** Execute an owner-approved live_agent_send action safely via a short-lived control lease. */
export async function executeLiveAgentSend(
  machines: MachineClient | undefined,
  params: Record<string, unknown>,
): Promise<Json> {
  if (!machines) throw new Error('执行机网关未就绪');
  const machineId = String(params.machineId ?? '');
  const paneId = String(params.paneId ?? '');
  const terminalId = String(params.terminalId ?? '');
  const cwd = String(params.cwd ?? '');
  const text = String(params.text ?? '');
  const submit = params.submit !== false;
  if (!machineId || !paneId || !terminalId || !cwd || !text) throw new Error('终端发送参数不完整');
  const openRes = await machines.call(machineId, 'terminal.live.open', {
    paneId, terminalId, cwd, mode: 'control',
  }, { timeoutMs: 25_000 }) as { connectionId?: string };
  const connectionId = openRes.connectionId;
  if (!connectionId) throw new Error('无法取得终端输入租约');
  try {
    const payload = submit ? `${text}\r` : text;
    const data = Buffer.from(payload, 'utf8').toString('base64');
    await machines.call(machineId, 'terminal.live.input', { connectionId, data }, { timeoutMs: 15_000 });
    return { delivered: true, machineId, paneId, cwd, bytes: Buffer.byteLength(payload, 'utf8') };
  } finally {
    await machines.call(machineId, 'terminal.live.release', { connectionId }).catch(() => {});
  }
}

export function createLiveAgentBridge(host: LiveAgentBridgeHost): Extension {
  return {
    id: 'live-agent-bridge',
    name: '现场 Agent 协同桥接',
    capabilities: ['live-agent.observe', 'live-agent.control'],
    activate(context) {
      context.contribute('tools', 'live_agents_list', tool(
        'live_agents_list',
        '只读：查看已绑定项目目录（含子目录）下所有正在运行的现场 Agent 终端（Claude / Codex / agy 等）、状态、标题、活跃会话 ID，以及当前卡住等待确认的终端弹窗。主人问某项目下 agent 进度或谁卡住了时优先调用。',
        {
          projectId: { type: 'string', description: '可选：按项目 ID 筛选' },
          projectName: { type: 'string', description: '可选：按项目名称或目录关键词模糊筛选' },
        },
        [],
        async (args, signal): Promise<Json> => {
          signal.throwIfAborted();
          const hub = host.machines();
          if (!hub) return { onlineMachines: 0, agents: [], openPrompts: [], note: '执行机网关未就绪' };
          const projectId = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim() : undefined;
          const projectName = typeof args.projectName === 'string' && args.projectName.trim() ? args.projectName.trim() : undefined;
          const scopedProjects = matchProjects(host.projects(), projectId, projectName);
          if ((projectId || projectName) && !scopedProjects.length) {
            return { onlineMachines: 0, agents: [], openPrompts: [], note: '未找到匹配的已绑定项目' };
          }
          const online = hub.list().filter(m => m.online && m.capabilities.includes('terminal.live.list'));
          const agents: Json[] = [];
          const settled = await Promise.allSettled(online.map(async m => {
            const res = await hub.call(m.id, 'terminal.live.list', {}, { timeoutMs: 15_000 }) as {
              panes?: Array<{ paneId: string; terminalId: string; cwd: string; title: string; agent: string; state: string; focused?: boolean; nativeSessionId?: string }>;
            };
            return { machine: m, panes: res.panes ?? [] };
          }));
          for (const outcome of settled) {
            if (outcome.status !== 'fulfilled') continue;
            const { machine, panes } = outcome.value;
            for (const pane of panes) {
              const matchedProject = scopedProjects.find(p => p.workspace?.machineId === machine.id && within(p.workspace.cwd, pane.cwd));
              if ((projectId || projectName) && !matchedProject) continue;
              const execId = pane.agent === 'claude' || pane.agent === 'claude-code' ? 'claude-code' : pane.agent;
              const customTitle = pane.nativeSessionId ? host.sessionCustomTitle(machine.id, execId, pane.nativeSessionId) : undefined;
              agents.push({
                machineId: machine.id,
                machineName: machine.name,
                paneId: pane.paneId,
                terminalId: pane.terminalId,
                agent: pane.agent,
                state: pane.state,
                title: customTitle || pane.title,
                ...(customTitle ? { customTitle } : {}),
                cwd: pane.cwd,
                ...(pane.nativeSessionId ? { nativeSessionId: pane.nativeSessionId } : {}),
                ...(matchedProject ? { projectId: matchedProject.id, projectName: matchedProject.name } : {}),
                ...(pane.focused ? { focused: true } : {}),
              });
            }
          }
          const openPrompts = host.takeoverList()
            .filter(p => p.status === 'open')
            .filter(p => {
              if (!projectId && !projectName) return true;
              return scopedProjects.some(proj => proj.id === p.projectId || (proj.workspace?.machineId === p.machineId && within(proj.workspace.cwd, p.cwd)));
            })
            .map(p => ({
              key: p.key,
              machineId: p.machineId,
              paneId: p.paneId,
              paneTitle: p.paneTitle,
              cwd: p.cwd,
              kind: p.kind,
              title: p.title,
              excerpt: p.excerpt.slice(-300),
              options: p.options.map((o, idx) => ({ index: idx + 1, label: o.label })),
            }));
          const targetProjectId = scopedProjects.length === 1 ? scopedProjects[0]!.id : undefined;
          return {
            onlineMachines: online.length,
            agents,
            openPrompts,
            terminalsUrl: targetProjectId ? `/terminals.html?projectId=${encodeURIComponent(targetProjectId)}` : '/terminals.html',
          };
        },
      ));

      context.contribute('tools', 'live_agent_read', tool(
        'live_agent_read',
        '只读：读取某个正在运行的现场 Agent 终端最近屏幕输出（最多 200 行），用于判断它当前做到哪一步、是否报错或等待输入。需先通过 live_agents_list 获取 machineId、paneId、terminalId、cwd。',
        {
          machineId: { type: 'string', description: '执行机 ID' },
          paneId: { type: 'string', description: '窗格 ID' },
          terminalId: { type: 'string', description: '终端 ID' },
          cwd: { type: 'string', description: '终端当前工作目录' },
          lines: { type: 'number', description: '返回末尾行数，默认 80，最大 200' },
        },
        ['machineId', 'paneId', 'terminalId', 'cwd'],
        async (args, signal) => {
          signal.throwIfAborted();
          const hub = host.machines();
          if (!hub) throw new Error('执行机网关未就绪');
          const machineId = String(args.machineId ?? '').trim();
          const paneId = String(args.paneId ?? '').trim();
          const terminalId = String(args.terminalId ?? '').trim();
          const cwd = String(args.cwd ?? '').trim();
          const maxLines = typeof args.lines === 'number' && Number.isFinite(args.lines) ? Math.min(200, Math.max(10, Math.floor(args.lines))) : 80;
          const res = await hub.call(machineId, 'terminal.live.read', { paneId, terminalId, cwd }, { timeoutMs: 15_000 }) as { text?: string };
          const raw = String(res.text ?? '');
          const clean = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
          const tail = clean.split('\n').slice(-maxLines).join('\n').slice(-16_000);
          return { machineId, paneId, cwd, output: tail, note: '仅包含终端最近输出，不代表完整历史或任务已验收' };
        },
      ));

      context.contribute('tools', 'live_agent_sessions', tool(
        'live_agent_sessions',
        '只读：列出某个项目目录（含子目录）下最近的 CLI 会话（含自定义名称、对话标题、子目录和短 ID），方便了解历史及活跃会话。',
        {
          projectId: { type: 'string', description: '可选：项目 ID' },
          projectName: { type: 'string', description: '可选：项目名称关键词' },
          limit: { type: 'number', description: '最多返回条数，默认 20，最大 50' },
        },
        [],
        async (args, signal): Promise<Json> => {
          signal.throwIfAborted();
          const hub = host.machines();
          if (!hub) return { sessions: [], note: '执行机网关未就绪' };
          const projectId = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim() : undefined;
          const projectName = typeof args.projectName === 'string' && args.projectName.trim() ? args.projectName.trim() : undefined;
          const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(50, Math.max(1, Math.floor(args.limit))) : 20;
          const scopedProjects = matchProjects(host.projects(), projectId, projectName).filter(p => p.workspace?.machineId && p.workspace?.cwd);
          const byMachine = new Map<string, string[]>();
          for (const p of scopedProjects) {
            const list = byMachine.get(p.workspace!.machineId) ?? [];
            list.push(p.workspace!.cwd);
            byMachine.set(p.workspace!.machineId, list);
          }
          const online = hub.list().filter(m => m.online && m.capabilities.includes('agents.sessions') && (!byMachine.size || byMachine.has(m.id)));
          const all: Array<Record<string, Json>> = [];
          const settled = await Promise.allSettled(online.map(async m => {
            const roots = byMachine.get(m.id);
            const res = await hub.call(m.id, 'agents.sessions', roots?.length ? { roots } : {}, { timeoutMs: 25_000 }) as {
              sessions?: Array<{ executorId: string; nativeSessionId: string; cwd: string; title?: string; fileModifiedAt?: string; metadataTimestamp?: string }>;
            };
            return { machine: m, sessions: res.sessions ?? [] };
          }));
          for (const outcome of settled) {
            if (outcome.status !== 'fulfilled') continue;
            const { machine, sessions } = outcome.value;
            for (const s of sessions) {
              const customTitle = host.sessionCustomTitle(machine.id, s.executorId, s.nativeSessionId);
              all.push({
                machineId: machine.id,
                machineName: machine.name,
                executorId: s.executorId,
                nativeSessionId: s.nativeSessionId,
                title: customTitle || s.title || '',
                cwd: s.cwd,
                updatedAt: s.fileModifiedAt || s.metadataTimestamp || '',
              });
            }
          }
          all.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
          return { total: all.length, sessions: all.slice(0, limit) };
        },
      ));

      context.contribute('tools', 'live_agent_send', tool(
        'live_agent_send',
        '受控写操作（需主人审批）：申请向某个正在运行的现场 Agent 终端发送指令或回复。不会直接写入，会先生成审批卡；主人批准后才精准写入对应终端。',
        {
          machineId: { type: 'string', description: '执行机 ID' },
          paneId: { type: 'string', description: '窗格 ID' },
          terminalId: { type: 'string', description: '终端 ID' },
          cwd: { type: 'string', description: '终端工作目录' },
          text: { type: 'string', description: '要发送给该 Agent 的内容（最多 4000 字）' },
          submit: { type: 'boolean', description: '是否附带回车提交，默认 true' },
          reason: { type: 'string', description: '向主人说明为什么发这条指令' },
          projectId: { type: 'string', description: '可选：关联项目 ID' },
        },
        ['machineId', 'paneId', 'terminalId', 'cwd', 'text', 'reason'],
        async (args, signal) => {
          signal.throwIfAborted();
          const hub = host.machines();
          if (!hub) throw new Error('执行机网关未就绪');
          const machineId = String(args.machineId ?? '').trim();
          const machine = hub.list().find(m => m.id === machineId && m.online);
          if (!machine) throw new Error('目标执行机不在线');
          const paneId = String(args.paneId ?? '').trim();
          const terminalId = String(args.terminalId ?? '').trim();
          const cwd = String(args.cwd ?? '').trim();
          const text = String(args.text ?? '');
          const reason = String(args.reason ?? '').trim();
          if (!paneId || !terminalId || !cwd || !text.trim() || !reason) throw new Error('请完整填写目标终端、发送内容和原因');
          if (text.length > 4000) throw new Error('单次发送内容不能超过 4000 字');
          return host.proposeSend({
            machineId,
            machineName: machine.name,
            paneId,
            terminalId,
            cwd,
            text,
            submit: args.submit !== false,
            reason,
            ...(typeof args.projectId === 'string' && args.projectId.trim() ? { projectId: args.projectId.trim() } : {}),
          });
        },
      ));

      context.contribute('tools', 'live_agent_answer_prompt', tool(
        'live_agent_answer_prompt',
        '受控写操作（需主人审批）：针对 live_agents_list 返回的卡点终端弹窗（openPrompts），申请替主人按指定选项。不会直接按键，主人批准后才校验画面并按键。',
        {
          key: { type: 'string', description: 'openPrompts 中的 key' },
          optionIndex: { type: 'number', description: '选项序号（从 1 开始）' },
          reason: { type: 'string', description: '向主人说明推荐此选项的理由' },
        },
        ['key', 'optionIndex', 'reason'],
        async (args, signal) => {
          signal.throwIfAborted();
          const key = String(args.key ?? '').trim();
          const optionIndex = typeof args.optionIndex === 'number' && Number.isInteger(args.optionIndex) ? args.optionIndex : 0;
          const reason = String(args.reason ?? '').trim();
          const prompt = host.takeoverList().find(p => p.key === key && p.status === 'open');
          if (!prompt) throw new Error('未找到对应的待处理终端弹窗（可能已在本地处理）');
          const opt = prompt.options[optionIndex - 1];
          if (!opt) throw new Error(`选项序号无效，可选范围 1..${prompt.options.length}`);
          return host.proposeAnswerPrompt({
            prompt,
            optionLabel: opt.label,
            keys: opt.keys,
            reason: reason || `响应终端弹窗：${opt.label}`,
          });
        },
      ));
    },
  };
}
