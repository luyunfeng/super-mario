import { createHash } from 'node:crypto';
import type { BotScope } from '../../protocol/src/bots.ts';
import type { AppConfig, MainAssistantProfile, ExecutorInfo, Message, Project, Todo, Json } from '../../protocol/src/index.ts';
import type { Contributions, EventBus, Store } from '../../plugin-sdk/src/index.ts';
import { SCOPED_WORK_SYSTEM_PROMPT } from './prompts.ts';
import { createAgentRuntime } from './agent-runtime/index.ts';

type Runtime = ReturnType<typeof createAgentRuntime>;
interface Options {
  config: AppConfig; store: Store; events: EventBus; contributions: Contributions;
  /** Optional host validation (for example, whether this bot binding is still enabled). */
  executors?: () => ExecutorInfo[];
  botContext?: (conversationId:string, scope?:BotScope)=>Json;
  mainSkillCatalog?: () => Promise<string>;
  mainAssistantProfile?: () => Promise<MainAssistantProfile | undefined>;
  projectInstructions?: (projectId: string) => Promise<string>;
  projectContext?: (projectId:string)=>Json;
  workDecisions?: (scope?:BotScope, projectId?:string)=>unknown;
  validScope?: (scope: BotScope, botId: string, input?: Message) => boolean | void;
}

/** Owns lazy, independent queues and histories. Shared records/events stay in the host store.
 * Configuration coordination: lock main + supervisor + this manager before updating config,
 * reload all three while locked, and unlock in finally. No pi dependency escapes the bridge.
 */
export function createScopedAgents(options: Options) {
  const agents = new Map<string, { botId: string; scope: BotScope; conversationId: string; runtime: Runtime }>();
  let closed = false;
  let configuring = false;

  function identity(input: BotScope, botId: string) {
    if (typeof botId !== 'string' || !botId.trim()) throw new Error('botId 必须为非空字符串');
    if (!input || !['global', 'unmarked', 'project', 'task'].includes(input.kind)) throw new Error('无效 Bot 作用域');
    let scope: BotScope;
    if (input.kind === 'project') {
      if (typeof input.projectId !== 'string' || !input.projectId.trim()) throw new Error('projectId 必须为非空字符串');
      const project = options.store.get<Project>('projects', input.projectId);
      if (!project || project.archivedAt) throw new Error('Bot 项目不存在或已归档');
      scope = { kind: 'project', projectId: input.projectId };
    } else if (input.kind === 'task') {
      if (typeof input.todoId !== 'string' || !input.todoId.trim()) throw new Error('todoId 必须为非空字符串');
      const todo = options.store.get<Todo>('todos', input.todoId);
      if (!todo) throw new Error('Bot 待办不存在');
      if (input.projectId !== undefined && input.projectId !== todo.projectId) throw new Error('Bot 待办 projectId 不符');
      if (todo.projectId) {
        const project = options.store.get<Project>('projects', todo.projectId);
        if (!project || project.archivedAt) throw new Error('Bot 项目不存在或已归档');
      }
      scope = { kind: 'task', todoId: todo.id, ...(todo.projectId ? { projectId: todo.projectId } : {}) };
    } else scope = { kind: input.kind };
    if (options.validScope?.(structuredClone(scope), botId) === false) throw new Error('Bot 作用域已失效');
    const digest = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    return { scope, conversationId: `bot:${botId}:${digest}` };
  }

  function projectAgent(projectId:string,role:'work'|'memory'='work') {
    if(closed||configuring)throw new Error('项目 Agent 已关闭或正在应用配置');
    const project=options.store.get<Project>('projects',projectId);
    if(!project||project.archivedAt)throw Object.assign(new Error('项目不存在或已归档'),{status:404});
    const conversationId=`project:${projectId}:${role}`;
    let entry=agents.get(conversationId);
    if(!entry){
      const scope:BotScope={kind:'project',projectId};
      const runtime=createAgentRuntime({...options,scope,conversationId,canUseScope:()=>{const project=options.store.get<Project>('projects',projectId);return Boolean(project&&!project.archivedAt);},
        ...(role==='memory'?{projectInstructions:undefined,allowedTools:[],systemPrompt:'你是此项目的独立记忆 Agent。只根据提供的证据提炼项目记忆，不执行工具，不将建议当成已完成事实。'}:{systemPrompt:SCOPED_WORK_SYSTEM_PROMPT})});
      entry={botId:`workspace:${projectId}:${role}`,scope,conversationId,runtime};agents.set(conversationId,entry);
    }
    return entry.runtime;
  }
  return {
    postProject(projectId:string,text:string,requestId?:string){return projectAgent(projectId).post(text,undefined,{requestId});},
    askMemory(projectId:string,text:string){return projectAgent(projectId,'memory').ask(text,{readOnly:true});},
    projectStatus(projectId:string){const id=`project:${projectId}:work`;return{conversationId:id,...(agents.get(id)?.runtime.status()??{available:options.config.demo||Boolean(options.config.model),reason:'项目 Agent 按需初始化'})};},
    async post(text: string, scope: BotScope, botId: string, context?: { readOnly?: boolean; origin?: Message['origin']; replyTo?: string }): Promise<Message> {
      if (closed) throw new Error('Bot 运行时已关闭');
      if (configuring) throw new Error('正在应用模型配置，请稍后发送消息');
      if (typeof text !== 'string' || !text.trim()) throw new Error('消息不能为空');
      const binding = identity(scope, botId);
      let agent = agents.get(binding.conversationId);
      if (!agent) {
        const systemPrompt = ['project', 'task'].includes(binding.scope.kind) ? SCOPED_WORK_SYSTEM_PROMPT : undefined;
        const runtime = createAgentRuntime({ ...options, ...binding, systemPrompt, canUseScope: input => options.validScope?.(structuredClone(binding.scope), botId, input) !== false });
        agent = { botId, ...binding, runtime };
        agents.set(binding.conversationId, agent);
      }
      return agent.runtime.post(text, binding.conversationId, context);
    },
    status(scope?: BotScope, botId?: string) {
      if (closed) return { available: false, reason: 'Bot 运行时已关闭' };
      if (configuring) return { available: false, reason: '正在应用模型配置' };
      if (scope === undefined && botId === undefined) {
        return { available: true, reason: 'Bot 运行时按需初始化；模型可用性请查询具体 Bot。' };
      }
      if (!scope || !botId) throw new Error('查询 Bot 状态需要 scope 和 botId');
      const binding = identity(scope, botId);
      return agents.get(binding.conversationId)?.runtime.status() ?? { available: false, reason: 'Bot 运行时尚未初始化' };
    },
    list() {
      return [...agents.values()].map(({ botId, scope, conversationId, runtime }) => ({
        botId, scope: structuredClone(scope), conversationId, ...runtime.status(),
      }));
    },
    tryLockConfiguration(): boolean {
      if (closed || configuring || [...agents.values()].some(agent => agent.runtime.configurationBusy())) return false;
      const locked: Runtime[] = [];
      try {
        for (const { runtime } of agents.values()) { runtime.lockConfiguration(); locked.push(runtime); }
        configuring = true;
        return true;
      } catch {
        for (const runtime of locked) runtime.unlockConfiguration();
        return false;
      }
    },
    unlockConfiguration() {
      for (const { runtime } of agents.values()) runtime.unlockConfiguration();
      configuring = false;
    },
    async reloadConfiguration(newConfig?: AppConfig) {
      if (!configuring || closed) throw new Error('重载 Bot 配置前必须锁定配置');
      // Runtimes retain this shared config object, as the main runtime does.
      if (newConfig && newConfig !== options.config) {
        for (const key of Object.keys(options.config)) delete (options.config as unknown as Record<string, unknown>)[key];
        Object.assign(options.config, newConfig);
      }
      const results = await Promise.allSettled([...agents.values()].map(agent => agent.runtime.reloadConfiguration()));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Bot 模型配置重载失败');
    },
    async close(closeOptions: { abort?: boolean } = {}) {
      closed = true;
      const results = await Promise.allSettled([...agents.values()].map(agent => agent.runtime.close(closeOptions)));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Bot 运行时关闭失败');
    },
  };
}
