import type { ReviewEvidenceReader } from './run-review.ts';
import { botConversationId } from './bot-agent-routing.ts';
import type { BotScope } from '../../protocol/src/bots.ts';
import type { AppConfig, MainAssistantProfile, ExecutorInfo, Message, Project, Todo, Json } from '../../protocol/src/index.ts';
import type { Contributions, EventBus, Store } from '../../plugin-sdk/src/index.ts';
import { MAIN_AGENT_SYSTEM_PROMPT, SCOPED_WORK_SYSTEM_PROMPT, WEB_THREAD_GUIDANCE, webThreadAssistantGuidance } from './prompts.ts';
import { conversationModels } from './agent-runtime/model-catalog.ts';
import { createAgentRuntime, recoverInterruptedInputs, removeScopedTranscript } from './agent-runtime/index.ts';

type Runtime = ReturnType<typeof createAgentRuntime>;
type ScopedPostContext = Omit<NonNullable<Parameters<Runtime['post']>[2]>, 'readOnlyAction'>;
interface Options {
  webThreadAssistant?(threadId:string):{id:string;name:string;instructions:string}|undefined;
  webConversationAllowed?(id:string,projectId?:string):boolean;
  chatFilesEnabled?():boolean;
  canReadChatFiles?(message:Message):boolean;
  readChatFileText?:NonNullable<Parameters<typeof createAgentRuntime>[0]['readChatFileText']>;
  chatImagesEnabled?():boolean;
  canReadChatImages?(message:Message):boolean;
  canGenerateOffice?(message:Message):boolean;
  canOpenQuestion?(message:Message):boolean;
  validateQueuedWebInput?(input:Message):void;
  onDirectWebInput?(message:Message):void;
  onInternalQueued?(message:Message,sourceId:string):()=>void;
  inboxConversations?: () => import('../../protocol/src/inbox-conversations.ts').InboxConversation[];
  reviewEvidence?: ReviewEvidenceReader;
  config: AppConfig; store: Store; events: EventBus; contributions: Contributions;
  /** Optional host validation (for example, whether this bot binding is still enabled). */
  executors?: () => ExecutorInfo[];
  botContext?: (conversationId:string, scope?:BotScope, threadId?:string)=>Json;
  mainSkillCatalog?: () => Promise<string>;
  mainAssistantProfile?: () => Promise<MainAssistantProfile | undefined>;
  projectInstructions?: (projectId: string) => Promise<string>;
  projectContext?: (projectId:string)=>Json;
  workDecisions?: (scope?:BotScope, projectId?:string)=>unknown;
  validScope?: (scope: BotScope, botId: string, input?: Message, threadId?: string) => boolean | void;
}

/** Owns lazy, independent queues and histories. Shared records/events stay in the host store.
 * Configuration coordination: lock main + supervisor + this manager before updating config,
 * reload all three while locked, and unlock in finally. No pi dependency escapes the bridge.
 */
export function createScopedAgents(options: Options) {
  // Project conversations stay lazy, but their durable queue must be recovered
  // before a workspace view can display its terminal state or manual retry.
  recoverInterruptedInputs(options.store,options.events,id=>id.startsWith('web:') || (id.startsWith('project:') && id.endsWith(':work')));
  const agents = new Map<string, { botId: string; scope: BotScope; conversationId: string; runtime: Runtime }>();
  const deleting = new Map<string, Promise<void>>();
  let closed = false;
  let configuring = false;

  function identity(input: BotScope, botId: string, threadId?: string) {
    if (typeof botId !== 'string' || !botId.trim()) throw Object.assign(new Error('botId 必须为非空字符串'), { status: 400 });
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
    const conversationId = botConversationId({ id: botId, scope }, threadId);
    if (options.validScope?.(structuredClone(scope), botId, undefined, threadId) === false) throw Object.assign(new Error('Bot 作用域已失效'), { status: 403 });
    return { scope, conversationId, conversationThreadId: threadId };
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
        ...(role==='memory'?{contextMode:'project-memory' as const,allowedTools:[]}:{systemPrompt:SCOPED_WORK_SYSTEM_PROMPT})});
      entry={botId:`workspace:${projectId}:${role}`,scope,conversationId,runtime};agents.set(conversationId,entry);
    }
    return entry.runtime;
  }
  function assertIdle(id:string) {
    if (configuring || agents.get(id)?.runtime.configurationBusy())
      throw Object.assign(new Error('独立对话仍有进行中的操作，请稍后再删除'), { status: 409 });
  }
  function forgetRuntime(id:string):Promise<void> {
    const pending=deleting.get(id);
    if(pending)return pending;
    const job=(async()=>{
      const entry=agents.get(id);
      if(entry){
        try {await entry.runtime.close();}
        finally {agents.delete(id);}
      }
      await removeScopedTranscript(options.config.dataDir,id);
    })().finally(()=>deleting.delete(id));
    deleting.set(id,job);
    return job;
  }
  return {
    retryFailedInput(original:Message,failed:Message) {
      const source = options.store.get<Message>('messages',original.id);
      if (!source?.projectId || source.conversationId !== 'project:' + source.projectId + ':work')
        throw Object.assign(new Error('仅可重试原项目工作会话的回复'),{status:403});
      return projectAgent(source.projectId).retryFailedInput(source,failed);
    },
    postWebConversation(id:string,projectId:string|undefined,text:string,context:Pick<ScopedPostContext,'requestId'|'files'>={}) {
      if(closed||configuring)throw Object.assign(new Error('对话运行时正在关闭或应用配置'),{status:503});
      const conversationId='web:'+id;
      const current=()=>options.webConversationAllowed?.(id,projectId)===true;
      if(!current())throw Object.assign(new Error('独立对话已停用或范围已变化'),{status:409});
      let entry=agents.get(conversationId);
      if(!entry){
        const scope:BotScope=projectId?{kind:'project',projectId}:{kind:'global'};
        const assistantId = options.webThreadAssistant?.(id)?.id;
        const runtime=createAgentRuntime({...options,scope,conversationId,canUseScope:current,botContext:undefined,
          ...(assistantId && {mainAssistantProfile:undefined, threadAssistantGuidance:() => {
            const current = options.webThreadAssistant?.(id);
            if (current?.id !== assistantId) throw new Error('助理与当前对话的绑定已变化，请重新打开');
            return webThreadAssistantGuidance(current);
          }}),
          systemPrompt:(projectId?SCOPED_WORK_SYSTEM_PROMPT:MAIN_AGENT_SYSTEM_PROMPT)+'\n'+WEB_THREAD_GUIDANCE});
        entry={botId:conversationId,scope,conversationId,runtime};agents.set(conversationId,entry);
      }
      return entry.runtime.post(text,conversationId,{requestId:context.requestId,files:context.files,directWebInput:true,projectId});
    },
    postProject(projectId:string, text:string, context?:ScopedPostContext) {
      return projectAgent(projectId).post(text, undefined, context);
    },
    askMemory(projectId:string,text:string){return projectAgent(projectId,'memory').ask(text,{readOnly:true});},
    projectStatus(projectId:string){const id=`project:${projectId}:work`;return{conversationId:id,...(agents.get(id)?.runtime.status()??{available:options.config.demo||Boolean(options.config.model),reason:'项目 Agent 按需初始化'})};},
    async post(text: string, scope: BotScope, botId: string, context?: ScopedPostContext, threadId?: string): Promise<Message> {
      if (closed) throw new Error('Bot 运行时已关闭');
      if (configuring) throw new Error('正在应用模型配置，请稍后发送消息');
      if (typeof text !== 'string' || !text.trim()) throw new Error('消息不能为空');
      const binding = identity(scope, botId, threadId);
      let agent = agents.get(binding.conversationId);
      if (!agent) {
        const systemPrompt = ['project', 'task'].includes(binding.scope.kind) ? SCOPED_WORK_SYSTEM_PROMPT : undefined;
        const runtime = createAgentRuntime({ ...options, ...binding, systemPrompt,
          ...(scope.kind === 'global' && !threadId && { feishuBotId: botId }), canUseScope: input => options.validScope?.(structuredClone(binding.scope), botId, input, threadId) !== false });
        agent = { botId, ...binding, runtime };
        agents.set(binding.conversationId, agent);
      }
      return agent.runtime.post(text, binding.conversationId, context);
    },
    assertThreadIdle(botId: string, threadId: string) {
      assertIdle(botConversationId({ id: botId, scope: { kind: 'global' } }, threadId));
    },
    forgetDeletedThread(botId: string, threadId: string) {
      return forgetRuntime(botConversationId({ id: botId, scope: { kind: 'global' } }, threadId));
    },
    assertWebThreadIdle(id:string) { assertIdle('web:'+id); },
    forgetDeletedWebThread(id:string) { return forgetRuntime('web:'+id); },
    queuedWebInputs(conversationId:string):Message[] {
      const entry=agents.get(conversationId);
      if (entry?.scope.kind!=='project' || conversationId !== 'project:'+entry.scope.projectId+':work') return [];
      return entry.runtime.queuedWebInputs();
    },
    reorderQueuedInputs(conversationId:string,expected:string[],ordered:string[]) {
      const entry=agents.get(conversationId);
      if (entry?.scope.kind!=='project' || conversationId !== 'project:'+entry.scope.projectId+':work')
        throw Object.assign(new Error('项目排队消息已变化'),{status:409});
      entry.runtime.reorderQueuedInputs(expected,ordered);
    },
    cancelQueuedTurn(conversationId:string,inputId:string,beforeWithdraw?:()=>void):{outcome:'cancelled'|'started'|'idle'} {
      const input = options.store.get<Message>('messages',inputId);
      if (!input?.projectId || !input.directWebInput || input.role !== 'user' || input.replyTo || (input.origin && input.origin!=='user') ||
          input.conversationId!==conversationId || conversationId!=='project:'+input.projectId+':work' ||
          options.store.get('message.routes',input.id)) return {outcome:'idle'};
      const project=options.store.get<Project>('projects',input.projectId);
      if (!project || project.archivedAt) return {outcome:'idle'};
      const runtime=agents.get(conversationId)?.runtime;
      if (runtime) return runtime.cancelQueuedTurn(inputId,beforeWithdraw);
      return {outcome:!beforeWithdraw && input.queueState==='cancelled' && input.status==='failed' && input.stoppedByUser ? 'cancelled' : 'idle'};
    },
    interruptTurn(conversationId: string, inputId: string) {
      const entry = agents.get(conversationId);
      if (!entry || !(conversationId.startsWith('bot:') || conversationId.endsWith(':work'))) return { outcome: 'idle' as const };
      return entry.runtime.interruptTurn(inputId);
    },
    modelCatalog(botId: string, threadId?: string) {
      const binding = identity({ kind: 'global' }, botId, threadId);
      return agents.get(binding.conversationId)?.runtime.modelCatalog()
        ?? conversationModels(options.config, options.store, binding.conversationId).catalog();
    },
    pickConversationModel(model: string, botId: string, typed = false, threadId?: string) {
      if (closed || configuring) throw Object.assign(new Error('正在应用模型配置，请稍后修改型号'), { status: 409 });
      const { conversationId } = identity({ kind: 'global' }, botId, threadId);
      const runtime = agents.get(conversationId)?.runtime;
      return runtime ? runtime.pickConversationModel(model, typed) : conversationModels(options.config, options.store, conversationId).pick(model, typed);
    },
    forgetConversationModel(model: string, botId: string, threadId?: string) {
      if (closed || configuring) throw Object.assign(new Error('正在应用模型配置'), { status: 409 });
      const { conversationId } = identity({ kind: 'global' }, botId, threadId);
      return conversationModels(options.config, options.store, conversationId).forget(model);
    },
    status(scope?: BotScope, botId?: string, threadId?: string) {
      if (closed) return { available: false, reason: 'Bot 运行时已关闭' };
      if (configuring) return { available: false, reason: '正在应用模型配置' };
      if (scope === undefined && botId === undefined) {
        return { available: true, reason: 'Bot 运行时按需初始化；模型可用性请查询具体 Bot。' };
      }
      if (!scope || !botId) throw new Error('查询 Bot 状态需要 scope 和 botId');
      const binding = identity(scope, botId, threadId);
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
