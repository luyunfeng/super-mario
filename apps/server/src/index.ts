import { privateThreadPage, searchPrivateThreads } from './feishu-thread-history.ts';
import { createSessionAnalysis } from './session-analysis.ts';
import { nativeExportProgress } from '../../../packages/core/src/native-conversation-export.ts';
import { maxChatFileBytes } from '../../../packages/core/src/chat-files.ts';
import { chatImageRequestBytes } from '../../../packages/core/src/chat-images.ts';
import { readMessageReceipt } from '../../../packages/core/src/message-receipts.ts';
import { createProjectFolders } from '../../../packages/core/src/project-folders.ts';
import { policyPresets, applyPolicyPreset, policyRuleHits } from '../../../packages/core/src/policy-presets.ts';
import { todoSections, todoDecisionIds } from '../../../packages/core/src/todo-sections.ts';
import { createAgentArtifacts } from './agent-artifacts.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { runCompletionTiming } from '../../../packages/core/src/run-completion-timing.ts';
import { todoBrief } from '../../../packages/core/src/todo-brief.ts';
import { todoLineage } from '../../../packages/core/src/todo-lineage.ts';
import { currentWorkerTodo } from './worker-session.ts';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { readFile, stat } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { createWorkbench, InputError, requiredText } from '../../../packages/core/src/workbench.ts';
import { listTraceSessions, readTraceSession, readTurnTrace } from '../../../packages/core/src/agent-traces.ts';
import { createMachineHub } from '../../../packages/core/src/machines.ts';
import type { FeishuRegistrationInput } from './feishu-registration.ts';
import { createFeishuGateway, type FeishuGatewayDependencies } from './feishu-gateway.ts';
import { validateBotScope } from '../../../packages/core/src/bot-scopes.ts';
import type { AppConfig, ChatFileInput, ChatImageInput, FeishuBotInput, JsonObject, KnowledgeImportance, Message, NodeMessage, QuestionResponse, Run, Todo } from '../../../packages/protocol/src/index.ts';

async function body(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new InputError('请求内容过大', 413);
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new InputError('请求必须是有效JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('请求必须是JSON对象');
  return value as Record<string, unknown>;
}
function answerInput(input: Record<string,unknown>, versioned = false): string | QuestionResponse[] {
  if (Object.keys(input).some(key => key !== 'text' && key !== 'answers' && !(key === 'version' && versioned)) ||
      Object.hasOwn(input,'text') === Object.hasOwn(input,'answers')) throw new InputError('请提交一种回答格式');
  if (!Object.hasOwn(input,'answers')) return requiredText(input.text,'回答');
  if (!Array.isArray(input.answers)) throw new InputError('逐题回答须为数组');
  // The core validates every answer against the persisted card.
  return input.answers as QuestionResponse[];
}
async function chatMessageBody(req:IncomingMessage):Promise<Record<string,unknown> & {text:string;images?:ChatImageInput[];files?:ChatFileInput[]}> {
  const input = await body(req,chatImageRequestBytes);
  const {images,...fields} = input;
  if (Buffer.byteLength(JSON.stringify(fields)) > 1024*1024) throw new InputError('消息内容过大',413);
  if (images !== undefined && !Array.isArray(images)) throw new InputError('图片列表格式无效');
  if (input.files !== undefined && !Array.isArray(input.files)) throw new InputError('文件列表格式无效');
  const text = input.text === undefined ? '' : input.text;
  if (typeof text !== 'string' || (!text.trim() && !images?.length && !input.files?.length)) throw new InputError('消息不能为空');
  // The runtime validates media types, image bytes and counts before accepting or queuing the message.
  return {...fields,text,files:input.files as ChatFileInput[]|undefined,images:images as ChatImageInput[]|undefined};
}
function messageRequestId(req: IncomingMessage) {
  const keys = req.headersDistinct['idempotency-key'];
  if (keys && keys.length !== 1) throw new InputError('发送请求号只能指定一次');
  return keys?.[0];
}

// A drawer can stay open while another client moves the todo. Pin writes to the
// project the user saw, including the unassigned scope (null).
function checkTodoScope(app: Awaited<ReturnType<typeof createWorkbench>>, id: string, input: Record<string, unknown>) {
  if (!('expectedProjectId' in input)) return;
  const todo = app.store.get<Todo>('todos', id);
  if (!todo) throw new InputError('待办不存在', 404);
  if (input.expectedProjectId !== (todo.projectId ?? null)) throw new InputError('待办所属项目已改变，请重新打开', 409);
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
const conversationReaders = new Map<string, { id: string; disabled: string; service: string; limit?: number; timeoutMs?: number }>([
  ['/api/v1/briefing/today', { id: 'daily-brief', disabled: '每日简报插件已停用', service: 'daily-brief.today', limit: 1024 }],
  ['/api/v1/conversation-message-search', { id: 'conversation-search', disabled: '对话搜索插件已停用', service: 'conversation-search.messages', limit: 8192 }],
  ['/api/v1/conversation-tool-records', { id: 'conversation-search', disabled: '对话搜索插件已停用', service: 'conversation-search.tool-records', limit: 4096 }],
  ['/api/v1/project-message-search', { id: 'conversation-search', disabled: '对话搜索插件已停用', service: 'conversation-search.projects', limit: 4096 }],
  ['/api/v1/conversation-export', { id: 'conversation-export', disabled: '对话导出插件已停用', service: 'conversation-export.markdown' }],
  ['/api/v1/message-favorites', { id: 'message-favorites', disabled: '消息收藏插件已停用', service: 'message-favorites.manage', limit: 8 * 1024 * 1024 + 1024 }],
  ['/api/v1/inbox-translation', { id: 'reply-translation', disabled: '回复翻译插件已停用', service: 'reply-translation.inbox', timeoutMs: 120000 }],
  ['/api/v1/reply-translation', { id: 'reply-translation', disabled: '回复翻译插件已停用', service: 'reply-translation.translate', timeoutMs: 120000 }],
]);

/** One HTTP server serves both the product and its API; no second frontend process is needed. */
export async function startServer(config: AppConfig, dependencies: FeishuGatewayDependencies = {}) {
  const app = await createWorkbench(config);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const machines = createMachineHub(app);
  app.setMachineClient(machines);
  const sessionAnalysis = createSessionAnalysis({ store: app.store, config: app.config, available: () => app.agent.status().available, call: (id, method, params) => machines.call(id, method, params) });
  const projectFolders = createProjectFolders(machines);
  const artifacts = createAgentArtifacts({ store: app.store, events: app.events, machines: () => machines });
  const gateway = createFeishuGateway(app, config, dependencies);
  const { feishu, personal, personalAi, personalAiView, configurePersonalAi, personalView, bots, registrations, registrationView, proposeMail } = gateway;
  const authorized = (req: IncomingMessage, url: URL) => !config.token || req.headers.authorization === `Bearer ${config.token}` || url.searchParams.get('token') === config.token;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (path === '/api/health' || path === '/api/v1/health') return json(res, 200, { ok: true, version: '0.1.0' });
      if (path === '/api/v1/worker-tools/todo-bind-thread' || path === '/api/v1/worker-tools/todo-decisions' || path === '/api/v1/worker-tools/todo-decision-add') {
        if (req.method !== 'POST') throw new InputError('此工具需要 POST', 405);
        const key = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
        if (!key || req.headersDistinct.authorization?.length !== 1) throw new InputError('执行会话凭证无效', 401);
        const adding = path.endsWith('/todo-decision-add');
        const input = await body(req, adding ? 192 * 1024 : 8192);
        if (Object.keys(input).some(k => !['sessionId','arguments'].includes(k)) || typeof input.sessionId !== 'string' ||
          !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) throw new InputError('执行会话请求无效');
        const {todo, prompt, run} = currentWorkerTodo(app.store, machines.list(), input.sessionId, key);
        if (!app.listExecutors().some(item => item.id === run.executorId && item.available)) throw new InputError('执行者已停用或不可用', 403);
        if (adding) {
          const decision = app.todoDecisions.addAgent(todo.id, run, input.arguments as Record<string, unknown>);
          app.events.publish('todo-decisions.changed', {todoId:todo.id});
          return json(res, 201, {message:'已记录执行会话的决定。', decisionId:decision.id});
        }
        if (path.endsWith('/todo-decisions')) {
          if (Object.keys(input.arguments).length) throw new InputError('读取负责待办的决定无需参数');
          const decisions = app.todoDecisions.list(todo.id).filter(item => item.active).map(item => {
            const {id, text, source, sourceId} = item;
            return source === 'agent'
              ? {id, text, source, sourceId, by:'agent', question:item.question, choice:item.choice, reason:item.reason,
                supersedesId:item.supersedesId, createdAt:item.createdAt}
              : {id, text, source, sourceId, by:'user'};
          });
          return json(res, 200, {message:decisions.length ? '当前负责待办的有效决定。' : '当前负责待办没有有效决定。', decisions});
        }
        if (todo.projectId) throw new InputError('会话没有可绑定的负责待办', 403);
        return json(res, 200, bots.bindWorkerTopic(todo.id, prompt, input.arguments as Record<string,unknown>));
      }
      if (path.startsWith('/api/')) {
        if (!authorized(req, url)) throw new InputError('访问令牌无效', 401);
        const method = req.method;
        if (path === '/api/v1/conversation-status' && method === 'POST') {
          if (!app.plugins.list().some(p => p.id === 'conversation-search' && p.status === 'active')) throw new InputError('对话历史搜索插件已停用', 503);
          const input = await body(req, 2048);
          if (Object.keys(input).some(k => !['target', 'projectId', 'todoId'].includes(k)) || !['main', 'project'].includes(String(input.target)))
            throw new InputError('会话状态请求无效');
          const projectId = input.projectId === undefined ? undefined : requiredText(input.projectId, '项目');
          const todoId = input.todoId === undefined ? undefined : requiredText(input.todoId, '待办');
          if (input.target === 'project' && !projectId) throw new InputError('缺少项目');
          if (projectId && !app.projects.list().some(p => p.id === projectId && !p.archivedAt)) throw new InputError('项目不存在或已归档', 404);
          if (todoId) checkTodoScope(app, todoId, { expectedProjectId: projectId ?? null });
          const conversationId = input.target === 'project' ? `project:${projectId}:work` : 'main';
          return json(res, 200, await app.plugins.invocations.use('conversation-search.status', { conversationId,
            ...(projectId && { projectId }), ...(todoId && { todoId }) }));
        }
        if (path === '/api/v1/briefing/settings' && method === 'GET') return json(res, 200, app.briefing.settings());
        if (path === '/api/v1/briefing/settings' && method === 'PUT') {
          try { const settings = app.briefing.configure(await body(req)); app.awayNotifications.flush(); return json(res,200,settings); }
          catch (error) { throw new InputError(error instanceof Error ? error.message : '简报配置无效'); }
        }
        if (path === '/api/v1/presence' && method === 'POST') { const status=app.presence.heartbeat(await body(req) as unknown as import('../../../packages/protocol/src/index.ts').WebPresenceInput); if(status.present)app.awayNotifications.flush();return json(res,200,status); }
        if (path === '/api/v1/presence' && method === 'GET') return json(res, 200, { ...app.presence.status(), notifications: app.awayNotifications.list() });
        if (path === '/api/v1/eventbox' && method === 'GET') return json(res,200,{
          summary:app.background.summary(), settings:app.background.eventbox.settings(), events:app.background.eventbox.events().slice(0,200), subscriptions:app.background.eventbox.subscriptions(),
          deliveries:app.background.eventbox.deliveries().filter(d=>(!url.searchParams.get('status')||d.status===url.searchParams.get('status'))&&(!url.searchParams.get('subscription')||d.subscriptionId===url.searchParams.get('subscription'))).slice(0,200),
          schedules:app.background.schedules.list(),outbox:app.background.outbox.list().slice(0,200),grants:app.background.outbox.grants(),modelGrants:app.background.modelGrants(),briefs:app.store.list('background.briefs').slice(-20),
        });
        if(path==='/api/v1/eventbox/settings'&&method==='PUT')return json(res,200,app.background.eventbox.configure(await body(req)));
        if (path === '/api/v1/eventbox/deliveries' && method === 'GET') return json(res,200,app.background.eventbox.deliveries().slice(0,200));
        const delivery=path.match(/^\/api\/v1\/eventbox\/deliveries\/([^/]+)\/(retry|acknowledge)$/);
        if(delivery&&method==='POST') { const input=await body(req); if(delivery[2]==='retry')app.background.eventbox.retry(delivery[1],'user',input.confirmedNotExecuted===true);else app.background.eventbox.acknowledge(delivery[1]);return json(res,200,{ok:true}); }
        if(path==='/api/v1/eventbox/schedules'&&method==='GET')return json(res,200,app.background.schedules.list());
        if(path==='/api/v1/eventbox/schedules'&&method==='POST')return json(res,201,app.background.schedules.forOwner('core').create(await body(req) as unknown as import('../../../packages/plugin-sdk/src/index.ts').ScheduleInput));
        const schedule=path.match(/^\/api\/v1\/eventbox\/schedules\/([^/]+)$/);
        if(schedule&&method==='PATCH'){const input=await body(req);if(!Number.isSafeInteger(input.version))throw new InputError('请提供调度版本');const{version,...patch}=input;return json(res,200,app.background.schedules.update(schedule[1],patch as Parameters<typeof app.background.schedules.update>[1],version as number));}
        if (path === '/api/v1/outbox' && method === 'GET') {
          const id = url.searchParams.get('id');
          if (id === null) return json(res, 200, app.background.outbox.list().slice(0, 200));
          const item = app.background.outbox.find(id);
          return json(res, 200, item ? [item] : []);
        }
        if(path==='/api/v1/outbox'&&method==='POST'){const{owner,...input}=await body(req);return json(res,201,app.background.outbox.enqueue(typeof owner==='string'?owner:'user',input as unknown as import('../../../packages/plugin-sdk/src/index.ts').OutboxInput));}
        if(path==='/api/v1/outbox/grants'&&method==='PUT'){const input=await body(req);app.background.outbox.grant(requiredText(input.owner,'发布者'),requiredText(input.channel,'渠道'),input.enabled as boolean);return json(res,200,app.background.outbox.grants());}
        const outgoing=path.match(/^\/api\/v1\/outbox\/([^/]+)\/(cancel|verify)$/);
        if(outgoing&&method==='POST'){const input=await body(req);if(!Number.isSafeInteger(input.version))throw new InputError('请提供发件版本');if(outgoing[2]==='cancel')return json(res,200,app.background.outbox.cancel(outgoing[1],input.version as number));if(typeof input.delivered!=='boolean')throw new InputError('请明确核实是否送达');return json(res,200,app.background.outbox.verify(outgoing[1],input.delivered,input.version as number));}
        if(path==='/api/v1/eventbox/cleanup-plugin'&&method==='POST'){const input=await body(req);const owner=requiredText(input.owner,'插件');if(input.confirm!==true||owner==='core'||!app.plugins.list().some(p=>p.id===owner&&p.status==='disabled'))throw new InputError('请先停用插件，并显式确认清理',409);app.background.cleanupOwner(owner);return json(res,200,{ok:true});}
        if(path==='/api/v1/eventbox/model-grants'&&method==='PUT'){const input=await body(req);app.background.modelGrant(requiredText(input.owner,'插件'),input.enabled as boolean,input.dailyLimit as number);return json(res,200,app.background.modelGrants());}
        if(path==='/api/v1/supervisor/resume'&&method==='POST'){await app.supervisorAgent.resume();return json(res,200,app.supervisorAgent.settings());}
        const conversationModel = path.match(/^\/api\/v1\/(?:feishu\/bots\/([^/]+)\/(?:threads\/([0-9a-f]{64})\/)?)?model\/(catalog|pick|custom)$/);
        if (conversationModel) {
          const botId = conversationModel[1] && decodeURIComponent(conversationModel[1]);
          if (botId !== undefined) {
            const bot = bots.list().find(row => row.id === botId);
            if (!bot) throw new InputError('机器人不存在', 404);
            if (bot.scope.kind !== 'global' || !bot.paired || !bot.enabled) throw new InputError('请选择已启用并配对的全局机器人', 409);
          }
          const threadId = conversationModel[2];
          const checkThread = () => {
            if (threadId) bots.requireThread(botId!, threadId);
          };
          checkThread();
          const action = conversationModel[3];
          const checkRevision = (revision: unknown) => {
            if (revision !== undefined && revision !== app.modelConfigurationRevision())
              throw new InputError('模型接入已变化，请重新查看清单', 409);
          };
          if (action === 'custom' && method === 'DELETE') {
            checkRevision(url.searchParams.get('revision') ?? undefined);
            return json(res, 200, await app.forgetConversationModel(requiredText(url.searchParams.get('model'), '模型'), botId, threadId));
          }
          if (action === 'catalog' && method === 'GET') {
            const catalog = app.modelCatalog(botId, threadId);
            return json(res, 200, catalog.typed ? { ...catalog, revision: app.modelConfigurationRevision() } : catalog);
          }
          if (action === 'pick' && method === 'PUT') {
            const input = await body(req);
            if (Object.keys(input).some(key => !['model', 'typed', 'revision'].includes(key))) throw new InputError('会话模型选择包含未知字段');
            if (input.typed !== undefined && typeof input.typed !== 'boolean') throw new InputError('typed 必须为布尔值');
            checkRevision(input.revision);
            checkThread();
            return json(res, 200, await app.pickConversationModel(requiredText(input.model, '模型'), botId, input.typed === true, threadId));
          }
        }
        if (path === '/api/v1/model' && method === 'GET') return json(res, 200, app.modelStatus());
        if (path === '/api/v1/model' && method === 'PUT') return json(res, 200, await app.configureModel(await body(req)));
        if (path === '/api/v1/agent-artifacts' && method === 'GET') return json(res, 200, artifacts.list());
        if (path === '/api/v1/agent-artifacts' && method === 'POST') return json(res, 201, artifacts.stage(await body(req)));
        const artifact = path.match(/^\/api\/v1\/agent-artifacts\/([^/]+)\/(approve|deploy|status|call)$/);
        if (artifact && artifact[2] === 'approve' && method === 'POST') return json(res, 200, artifacts.approve(decodeURIComponent(artifact[1]), await body(req)));
        if (artifact && artifact[2] === 'deploy' && method === 'POST') return json(res, 200, await artifacts.deploy(decodeURIComponent(artifact[1])));
        if (artifact && artifact[2] === 'call' && method === 'POST') return json(res, 200, await artifacts.call(decodeURIComponent(artifact[1]), await body(req)));
        if (artifact && artifact[2] === 'status' && method === 'GET') return json(res, 200, await artifacts.status(decodeURIComponent(artifact[1])));
        if (path === '/api/v1/attention' && method === 'GET') return json(res, 200, app.attention());
        if (path === '/api/v1/setup/channel-skip' && method === 'POST') return json(res, 200, app.skipChannel());
        if (path === '/api/v1/state' && method === 'GET') return json(res, 200, await app.snapshot());
        if (path === '/api/v1/plans' && method === 'GET') return json(res, 200, app.plans.list());
        if (path === '/api/v1/plans' && method === 'POST') return json(res, 201, app.proposePlan(await body(req)));
        const plan = path.match(/^\/api\/v1\/plans\/([^/]+)\/(start|reject)$/);
        if (plan && method === 'POST') {
          const input = await body(req);
          return json(res, 200, plan[2] === 'start' ? app.plans.start(plan[1], input.version as number) : app.plans.reject(plan[1], input.version as number));
        }
        if (path === '/api/v1/interactions' && method === 'GET') return json(res, 200, app.interactions.list());
        if (path === '/api/v1/interactions' && method === 'POST') return json(res, 201, app.interactions.openFromWeb(await body(req) as unknown as Parameters<typeof app.interactions.open>[0]));
        const card = path.match(/^\/api\/v1\/interactions\/([^/]+)\/(answer|withdraw|context|mismatch|delegate|confirm-delegation)$/);
        if (card && method === 'POST') {
          const input = await body(req);
          if (card[2] === 'delegate') return json(res,200,await app.interactions.delegateDecision(card[1],input.version as number));
          if (card[2] === 'confirm-delegation') return json(res,200,await app.interactions.confirmDelegation(card[1],input.version as number,input.accept as boolean));
          if (card[2] === 'mismatch') return json(res,200,app.interactions.reportMismatch(card[1],input.version as number));
          if (card[2] === 'context') return json(res,200,await app.interactions.requestContext(card[1],input.version as number));
          return json(res, 200, card[2] === 'answer' ? await app.interactions.answer(card[1], input.version as number, answerInput(input,true)) : app.interactions.withdraw(card[1], input.version as number));
        }
        if (path === '/api/v1/policies/presets') {
          const input = method === 'POST' ? await body(req) : {};
          const projectId = method === 'GET' ? url.searchParams.get('projectId') ?? undefined : input.projectId;
          if (projectId !== undefined && (typeof projectId !== 'string' || !app.projects.list().some(item => item.id === projectId && !item.archivedAt))) throw new InputError('请选择可用的项目');
          const scope = projectId ? { projectId: projectId as string } : {};
          const current = app.policies.read(scope);
          const directories = method === 'GET' ? url.searchParams.getAll('trustedDirectory') : input.trustedDirectories;
          if (directories !== undefined && (!Array.isArray(directories) || !directories.every(value => typeof value === 'string'))) throw new InputError('受信目录必须为文本列表');
          const options = { trustedDirectories: directories as string[] | undefined, confirmed: input.confirmed === true };
          try {
            if (method === 'GET') return json(res, 200, { presets: policyPresets(current, options), hits: policyRuleHits(app.interactions.list(), scope) });
            if (method === 'POST') return json(res, 200, { config: app.policies.write(scope, applyPolicyPreset(current, requiredText(input.preset, '预设'), options)) });
          } catch (error) { throw new InputError(error instanceof Error ? error.message : '预设无效'); }
        }
        if (path === '/api/v1/supervisor/settings' && method === 'GET') return json(res, 200, app.supervisorAgent.settings());
        if (path === '/api/v1/policies') {
          const scope: { projectId?: string; runId?: string } = {};
          if (url.searchParams.has('projectId')) scope.projectId = requiredText(url.searchParams.get('projectId'), '项目');
          if (url.searchParams.has('runId')) scope.runId = requiredText(url.searchParams.get('runId'), '任务');
          try {
            if (method === 'GET') return json(res, 200, app.policies.read(scope));
            if (method === 'PUT') return json(res, 200, app.policies.write(scope, await body(req)));
          } catch (error) { throw new InputError(error instanceof Error ? error.message : '策略设置无效'); }
        }
        if (path === '/api/v1/supervisor' && method === 'GET') return json(res, 200, {
          agent: { ...app.supervisorRuntime.status(), mode: config.demo ? 'demo' : 'live' }, settings: app.supervisorAgent.settings(),
          reviews: app.supervisorAgent.reviews(), messages: app.store.list<import('../../../packages/protocol/src/index.ts').Message>('messages').filter(message => message.conversationId === 'supervisor'),
        });
        if (path === '/api/v1/supervisor/settings' && method === 'PUT') {
          try { return json(res, 200, app.supervisorAgent.configure(await body(req))); }
          catch (error) { throw new InputError(error instanceof Error ? error.message : '督办配置无效'); }
        }
        if (path === '/api/v1/supervisor/flush' && method === 'POST') { app.supervision.tick(); return json(res, 200, await app.supervisorAgent.flush() ?? { pending: true }); }
        if (path === '/api/v1/agents/sessions' && method === 'GET') return json(res, 200, await app.agentSessions.discover({
          ...(url.searchParams.has('machineId') ? { machineId: requiredText(url.searchParams.get('machineId'), '电脑') } : {}),
          ...(url.searchParams.has('projectId') ? { projectId: requiredText(url.searchParams.get('projectId'), '项目') } : {}),
          ...(url.searchParams.has('todoId') ? { todoId: requiredText(url.searchParams.get('todoId'), '事项') } : {}),
        }));
        if (path === '/api/v1/agents/sessions/usage' && method === 'GET') {
          const machine = machines.list().find(m => m.id === url.searchParams.get('machineId'));
          if (!machine?.online) throw new InputError('执行机离线', 503);
          if (!machine.capabilities.includes('agents.usage')) throw new InputError('请升级执行机代理以查看会话用量', 409);
          const field = (key: string) => requiredText(url.searchParams.get(key), key);
          return json(res, 200, await machines.call(machine.id, 'agents.usage', { executorId: field('executorId'), nativeSessionId: field('nativeSessionId'), cwd: field('cwd') }));
        }
        if (path === '/api/v1/agents/sessions/analysis-sources' && method === 'GET') {
          const machine = machines.list().find(row => row.id === url.searchParams.get('machineId'));
          if (!machine?.online) throw new InputError('执行机离线', 503);
          const cwd = requiredText(url.searchParams.get('cwd'), '会话目录');
          return json(res, 200, await machines.call(machine.id, 'agents.sessions', { roots: [cwd] }));
        }
        if (path === '/api/v1/agents/sessions/analyze' && method === 'POST') {
          const input = await body(req), machine = machines.list().find(row => row.id === input.machineId);
          if (!machine?.online) throw new InputError('执行机离线', 503);
          if (!machine.capabilities.includes('agents.transcript')) throw new InputError('请升级执行机代理以读取完整会话', 409);
          return json(res, 202, sessionAnalysis.start(input));
        }
        const analysisJob = path.match(/^\/api\/v1\/agents\/sessions\/analysis\/([^/]+)$/);
        if (analysisJob && method === 'GET') {
          const job = sessionAnalysis.get(decodeURIComponent(analysisJob[1]!));
          if (!job) throw new InputError('分析记录不存在', 404);
          return json(res, 200, job);
        }
        if (path === '/api/v1/agents/sessions/resume' && method === 'POST') return json(res, 201, await app.agentSessions.proposeResume(await body(req)));
        if (path === '/api/v1/agents/sessions/resume-request' && method === 'GET') return json(res, 200, { approval: app.agentSessions.request(requiredText(url.searchParams.get('machineId'), '电脑'), requiredText(url.searchParams.get('key'), '请求标识')) });
        if (path === '/api/v1/feishu/web/login' && method === 'POST') return json(res, 200, await app.startFeishuWebLogin());
        if (path === '/api/v1/feishu/web/login/poll' && method === 'POST') return json(res, 200, await app.pollFeishuWebLogin());
        if (path === '/api/v1/feishu/web/settings') {
          if (method === 'GET') return json(res, 200, app.feishuWebSettings());
          if (method === 'PUT') return json(res, 200, await app.configureFeishuWeb(await body(req)));
        }
        if (path === '/api/v1/feishu/web' && method === 'GET') return json(res, 200, app.feishuWebStatus());
        if (path === '/api/v1/feishu/personal/ai') {
          if (method === 'GET') return json(res, 200, personalAiView());
          if (method === 'PUT') return json(res, 200, configurePersonalAi(await body(req)));
        }
        if (path === '/api/v1/feishu/personal' && method === 'GET') return json(res, 200, await personalView());
        if (path === '/api/v1/feishu/personal/authorize' && method === 'POST') { personal.authorize(); return json(res, 202, await personalView()); }
        if (path === '/api/v1/feishu/personal/cancel' && method === 'POST') return json(res, 200, personal.cancel());
        if (path === '/api/v1/feishu/personal' && method === 'PUT') {
          try { await personal.enable((await body(req)).enabled); return json(res, 200, await personalView()); }
          catch (error) { throw new InputError(error instanceof Error ? error.message : '采集设置未保存'); }
        }
        if (path === '/api/v1/feishu/personal/collect' && method === 'POST') {
          try { return json(res, 200, await personal.collect()); }
          catch (error) { throw new InputError(error instanceof Error ? error.message : '消息采集失败'); }
        }
        if (path === '/api/v1/feishu' && method === 'GET') return json(res, 200, feishu.status());
        if (path === '/api/v1/feishu/command-group') {
          if (method === 'GET') return json(res,200,gateway.commandGroup.get());
          if (method === 'POST') return json(res,200,await gateway.commandGroup.sync(await body(req)));
        }
        if (path === '/api/v1/feishu/bots' && method === 'GET') {
          return json(res, 200, bots.list().map(bot => bot.scope.kind === 'global' && bot.paired
            ? { ...bot, workbench: bots.workbenchStatus(bot.id) } : bot));
        }
        const todoThread = path.match(/^\/api\/v1\/todos\/([^/]+)\/thread$/);
        if (todoThread && (method === 'GET' || method === 'DELETE' || method === 'PUT')) {
          if (method === 'PUT' && !app.plugins.list().some(p => p.id === 'feishu' && p.status === 'active')) throw new InputError('飞书插件已停用', 503);
          const id = decodeURIComponent(todoThread[1]!);
          const change = method === 'GET' ? {} : await body(req);
          checkTodoScope(app, id, change);
          return json(res, 200, bots.todoThread(id, method, change));
        }
        const topicChats = path.match(/^\/api\/v1\/feishu\/bots\/([^/]+)\/topic-chats$/);
        if (topicChats && (method === 'GET' || method === 'PUT')) {
          if (!app.plugins.list().some(p => p.id === 'feishu' && p.status === 'active')) throw new InputError('飞书插件已停用', 503);
          return json(res, 200, bots.topicChats(decodeURIComponent(topicChats[1]!), method === 'PUT' ? await body(req) : undefined));
        }
        const groupReads = path.match(/^\/api\/v1\/feishu\/bots\/([^/]+)\/group-reads$/);
        if (method === 'GET' && groupReads) {
          if (!app.plugins.list().some(p => p.id === 'feishu' && p.status === 'active')) throw new InputError('飞书插件已停用', 503);
          if (url.searchParams.getAll('before').length > 1) throw new InputError('只能指定一个读群记录游标');
          return json(res, 200, bots.listGroupReads(decodeURIComponent(groupReads[1]!), url.searchParams.get('before') ?? undefined));
        }
        const selectThread=path.match(/^\/api\/v1\/feishu\/bots\/([^/]+)\/threads\/([0-9a-f]{64})\/select$/);
        if (selectThread && method==='POST') {
          const input=await body(req,1024);
          return json(res,200,bots.privateThreadSelection(decodeURIComponent(selectThread[1]!),selectThread[2]!,input));
        }
        const botThreads = path.match(/^\/api\/v1\/feishu\/bots\/([^/]+)\/threads(?:\/(order|search|tags|[0-9a-f]{64}))?$/);
        if (botThreads && (method === 'GET' || (method === 'DELETE' && /^[0-9a-f]{64}$/.test(botThreads[2] ?? '')) || (method === 'PATCH' && botThreads[2] && botThreads[2] !== 'search'))) {
          if (!app.plugins.list().some(p => p.id === 'feishu' && p.status === 'active')) throw new InputError('飞书插件已停用', 503);
          const id = decodeURIComponent(botThreads[1]!);
          if (!bots.list().some(bot => bot.id === id && bot.scope.kind === 'global' && bot.enabled && bot.paired))
            throw new InputError('已配对的全局机器人不存在或已停用', 404);
          if (method === 'DELETE') return json(res, 200, await bots.deletePrivateThread(id, botThreads[2]!, await body(req)));
          if (botThreads[2] === 'order' || botThreads[2] === 'tags') {
            const binding = bots.threadPreferenceKey(id);
            const input = method === 'PATCH' ? await body(req) : undefined;
            if (botThreads[2] === 'order') return json(res, 200, bots.threadOrder(id, binding, input));
            return json(res, 200, bots.threadTagPreferences(id, binding, input));
          }
          if (method === 'PATCH') return json(res, 200, bots.updatePrivateThread(id, botThreads[2]!, await body(req)));
          const params = url.searchParams;
          const tag = params.get('tag') ?? undefined;
          if (!botThreads[2]) return json(res, 200, bots.listPrivateHistory(id, params.get('archived') === '1', tag));
          if (botThreads[2] === 'search') {
            if (!app.plugins.list().some(p => p.id === 'conversation-search' && p.status === 'active'))
              throw new InputError('对话历史搜索插件已停用', 503);
            if (params.has('around') || params.has('after') || params.getAll('before').length > 1)
              throw new InputError('搜索仅支持一个 before 游标');
            if (!['0', '1'].includes(params.get('archived') ?? '0')) throw new InputError('归档筛选值无效');
            return json(res, 200, searchPrivateThreads(app.store, bots.privateThreads(id), params.get('q') ?? '', params.get('archived') === '1', params.get('before'), tag));
          }
          const row = bots.requireThread(id, botThreads[2]);
          if (['before', 'after', 'around'].some(key => params.getAll(key).length > 1)) throw new InputError('消息位置不可重复');
          return json(res, 200, {...privateThreadPage(app.store, row, params.get('before'), params.get('after'), params.get('around'), app.canReadMessageFiles, bots.canReadPrivateImage),
            selection:bots.privateThreadSelection(id,row.threadId)});
        }
        const botWorkbench = path.match(/^\/api\/v1\/feishu\/bots\/([^/]+)\/workbench$/);
        if (botWorkbench && method === 'GET') {
          const id = decodeURIComponent(botWorkbench[1]!);
          if (!bots.list().some(bot => bot.id === id && bot.scope.kind === 'global')) throw new InputError('全局机器人不存在', 404);
          return json(res, 200, bots.workbenchStatus(id));
        }
        if (path === '/api/v1/feishu/registrations' && method === 'GET') return json(res, 200, await Promise.all(registrations.list().map(registrationView)));
        if (path === '/api/v1/feishu/registrations' && method === 'POST') {
          const input = await body(req);
          const scope = validateBotScope(app.store, input.scope);
          try { return json(res, 202, await registrationView(registrations.start({ ...input, scope } as unknown as FeishuRegistrationInput))); }
          catch (error) { throw new InputError(error instanceof Error ? error.message : '无法开始扫码接入'); }
        }
        const registrationRoute = path.match(/^\/api\/v1\/feishu\/registrations\/([^/]+)(?:\/(cancel))?$/);
        if (registrationRoute) {
          const id = decodeURIComponent(registrationRoute[1]);
          const job = registrations.get(id);
          if (!job) throw new InputError('注册记录不存在', 404);
          if (method === 'GET' && !registrationRoute[2]) return json(res, 200, await registrationView(job));
          if (method === 'POST' && registrationRoute[2] === 'cancel') return json(res, 200, await registrationView(registrations.cancel(id)!));
        }
        if (path === '/api/v1/feishu/bots' && method === 'POST') {
          try { return json(res, 201, await bots.create(await body(req) as unknown as FeishuBotInput)); }
          catch (error) { throw new InputError(error instanceof Error ? error.message : '机器人配置无效'); }
        }
        const relayRoute = path.match(/^\/api\/v1\/feishu\/bots\/([^/]+)\/relay$/);
        if (relayRoute && method === 'POST') {
          const input = await body(req);
          if (Object.keys(input).some(key => !['targetBotId', 'text', 'key', 'parentEntryId', 'chatId'].includes(key))) throw new InputError('协作请求包含未知字段');
          const sourceBotId = decodeURIComponent(relayRoute[1]);
          if (!bots.list().some(bot => bot.id === sourceBotId)) throw new InputError('机器人不存在', 404);
          try { return json(res, 201, await bots.relay({ sourceBotId, targetBotId: requiredText(input.targetBotId, '协作目标'),
            text: requiredText(input.text, '协作请求'), key: requiredText(input.key, '协作标识'),
            ...(input.parentEntryId === undefined ? {} : { parentEntryId: requiredText(input.parentEntryId, '父信件') }),
            ...(input.chatId === undefined ? {} : { chatId: requiredText(input.chatId, '群会话') }) })); }
          catch (error) { const status = Number((error as { status?: number })?.status); throw new InputError(error instanceof Error ? error.message : '协作请求被拒绝', [400, 403, 404, 409, 503].includes(status) ? status : 409); }
        }
        const botRoute = path.match(/^\/api\/v1\/feishu\/bots\/([^/]+)(?:\/(collect))?$/);
        if (botRoute) {
          const id = decodeURIComponent(botRoute[1]);
          if (!bots.list().some(bot => bot.id === id)) throw new InputError('机器人不存在', 404);
          try {
            if (method === 'PATCH' && !botRoute[2]) return json(res, 200, await bots.update(id, await body(req) as unknown as Partial<FeishuBotInput>));
            if (method === 'DELETE' && !botRoute[2]) return json(res, 200, await bots.archive(id));
            if (method === 'POST' && botRoute[2] === 'collect') return json(res, 200, await bots.collect(id));
          } catch (error) { throw new InputError(error instanceof Error ? error.message : '机器人操作失败'); }
        }
        if (path === '/api/v1/mailboxes' && method === 'GET') {
          return json(res, 200, app.mailboxes.list(Object.fromEntries([...url.searchParams].filter(([key]) => ['direction', 'scope', 'projectId', 'todoId', 'botId', 'status'].includes(key)))));
        }
        if (path === '/api/v1/mailboxes' && method === 'POST') {
          const input = await body(req);
          if (input.direction !== undefined && input.direction !== 'outbox') throw new InputError('手动消息只能提交到发件箱');
          return json(res, 201, proposeMail(input));
        }
        const mailRoute = path.match(/^\/api\/v1\/mailboxes\/([^/]+)(?:\/(confirm|reject))?$/);
        if (mailRoute && (method === 'POST' || method === 'PATCH')) {
          const id = decodeURIComponent(mailRoute[1]), input = await body(req);
          if (method === 'PATCH' && !mailRoute[2]) return json(res, 200, app.mailboxes.assign(id, input.version as number, input.scope as Parameters<typeof app.mailboxes.assign>[2]));
          if (method === 'POST' && mailRoute[2] === 'confirm') return json(res, 200, await app.mailboxes.confirm(id, input.version as number));
          if (method === 'POST' && mailRoute[2] === 'reject') return json(res, 200, app.mailboxes.reject(id, input.version as number));
        }
        if (path === '/api/v1/feishu' && method === 'PUT') {
          const input = await body(req);
          const requestedAppId = typeof input.appId === 'string' ? input.appId.trim() : undefined;
          if (requestedAppId && bots.list().some(bot => bot.appId === requestedAppId)) throw new InputError('应用已用于另一个机器人，不能重复连接');
          try { return json(res, 200, await feishu.update(input)); }
          catch (error) { throw new InputError(error instanceof Error ? error.message : '飞书配置失败'); }
        }
        if (path === '/api/v1/feishu/collect' && method === 'POST') return json(res, 200, await feishu.collect());
        if (path === '/api/v1/scheduled-work' && method === 'GET') {
          if ([...url.searchParams.keys()].some(key=>!['projectId','todoId','offset','repeat'].includes(key))) throw new InputError('周期工作查询参数无效');
          const offset = url.searchParams.get('offset');
          if (offset !== null && !/^\d+$/.test(offset)) throw new InputError('分页起点须为非负整数');
          return json(res,200,app.scheduledWork.list({ ...Object.fromEntries(url.searchParams), offset: offset === null ? undefined : Number(offset) }));
        }
        if (path === '/api/v1/scheduled-work/templates' && method === 'GET') {
          if (!app.plugins.list().some(plugin => plugin.id === 'daily-brief' && plugin.status === 'active')) throw new InputError('定时工作插件已停用', 503);
          return json(res, 200, await app.plugins.invocations.use('daily-brief.templates', {}));
        }
        if (path === '/api/v1/scheduled-work/cron-preview' && method === 'GET') return json(res, 200, app.scheduledWork.previewCron(Object.fromEntries(url.searchParams)));
        if (path === '/api/v1/scheduled-work/history' && method === 'POST') return json(res, 200, app.scheduledWork.readHistory(await body(req)));
        if (path === '/api/v1/scheduled-work/brief' && method === 'POST') return json(res, 200, app.scheduledWork.readBrief(await body(req)));
        if (path === '/api/v1/scheduled-work' && method === 'POST') return json(res,201,app.scheduledWork.propose(await body(req)));
        const skipScheduled = path.match(/^\/api\/v1\/scheduled-work\/([^/]+)\/skip-next$/);
        if (skipScheduled && method === 'POST') {
          const input = await body(req);
          if (Object.keys(input).some(key => !['version', 'scheduleVersion', 'at', 'undoToken'].includes(key))) throw new InputError('跳过参数无效');
          return json(res, 200, app.scheduledWork.skipNext({ ...input, id: decodeURIComponent(skipScheduled[1]!) }));
        }
        const pauseScheduled = path.match(/^\/api\/v1\/scheduled-work\/([^/]+)\/(pause|resume)$/);
        if (pauseScheduled && method === 'POST') {
          const input = await body(req);
          if (Object.keys(input).some(key => !['version', 'scheduleVersion'].includes(key))) throw new InputError('周期工作参数无效');
          return json(res, 200, app.scheduledWork.changeTiming({ ...input, id: decodeURIComponent(pauseScheduled[1]!), paused: pauseScheduled[2] === 'pause' }));
        }
        const cancelScheduled=path.match(/^\/api\/v1\/scheduled-work\/([^/]+)\/cancel$/);
        if(cancelScheduled&&method==='POST') {
          const input=await body(req);if(Object.keys(input).some(key=>key!=='version'))throw new InputError('周期工作取消参数无效');
          return json(res,200,app.scheduledWork.cancel({id:decodeURIComponent(cancelScheduled[1]!),version:input.version}));
        }
        if (path === '/api/v1/followups' && method === 'GET') {
          return json(res, 200, { items: app.followups.list(Object.fromEntries(url.searchParams)) });
        }
        if (path === '/api/v1/followups' && method === 'POST') {
          return json(res, 201, app.followups.create(await body(req)));
        }
        const cancelFollowup = path.match(/^\/api\/v1\/followups\/([^/]+)\/cancel$/);
        if (cancelFollowup && method === 'POST') {
          return json(res, 200, app.followups.cancel(decodeURIComponent(cancelFollowup[1]!)));
        }
        if (path === '/api/v1/traces/sessions' && method === 'GET') {
          return json(res, 200, { sessions: listTraceSessions(app.store) });
        }
        const traceSessionMatch = path.match(/^\/api\/v1\/traces\/sessions\/([^/]+)$/);
        if (traceSessionMatch && method === 'GET') {
          return json(res, 200, readTraceSession(app.store, decodeURIComponent(traceSessionMatch[1]!)));
        }
        const traceTurnMatch = path.match(/^\/api\/v1\/traces\/turns\/([^/]+)$/);
        if (traceTurnMatch && method === 'GET') {
          const trace = readTurnTrace(app.store, decodeURIComponent(traceTurnMatch[1]!));
          if (!trace) throw new InputError('未找到该轮次的上下文追踪记录', 404);
          return json(res, 200, trace);
        }
        if (path === '/api/v1/takeover' && method === 'GET') {
          return json(res, 200, { settings: app.autoTakeover.settings(), items: app.autoTakeover.list() });
        }
        if (path === '/api/v1/takeover' && method === 'PUT') {
          return json(res, 200, { settings: app.autoTakeover.configure(await body(req)) });
        }
        if (path === '/api/v1/takeover/scan' && method === 'POST') {
          return json(res, 200, { items: await app.autoTakeover.scanOnce() });
        }
        if (path === '/api/v1/takeover/answer' && method === 'POST') {
          const input = await body(req);
          return json(res, 200, await app.autoTakeover.answerPrompt(requiredText(input.key, 'key'), String(input.keys ?? ''), 'user'));
        }
        if (path === '/api/v1/work-decisions' && method === 'GET') {
          for (const key of url.searchParams.keys()) if (!['projectId', 'todoId'].includes(key)) throw new InputError('工作决定查询参数无效');
          return json(res, 200, app.workDecisions.list(Object.fromEntries(url.searchParams)));
        }
        if (path === '/api/v1/work-decisions' && method === 'POST') {
          const input = await body(req);
          if (Object.keys(input).some(key => !['key', 'text', 'projectId', 'todoId'].includes(key))) throw new InputError('工作决定参数无效');
          return json(res, 201, app.workDecisions.recordFromWeb(input));
        }
        const decisionChange = path.match(/^\/api\/v1\/work-decisions\/([^/]+)(\/withdraw)?$/);
        if (decisionChange && (method === 'PATCH' && !decisionChange[2] || method === 'POST' && decisionChange[2])) {
          const input = await body(req);
          if (Object.keys(input).some(key => !(decisionChange[2] ? ['version'] : ['version', 'text']).includes(key))) throw new InputError('工作决定修改参数无效');
          return json(res, 200, app.workDecisions.changeFromWeb({ ...input, id: decodeURIComponent(decisionChange[1]!) }, !!decisionChange[2]));
        }
        if (path === '/api/v1/inbox' && method === 'GET') return json(res, 200, app.inbox.list());
        if (path === '/api/v1/inbox/bulk' && method === 'POST') {
          const result=app.inbox.bulk(await body(req,64*1024));
          for (const todo of result.created ?? []) app.events.publish('todos.changed',{id:todo.todoId});
          return json(res,200,result);
        }
        const handling = path.match(/^\/api\/v1\/inbox-handling\/(personal|mailbox)\/([^/]+)(?:\/(messages|suggestions)(?:\/([^/]+)\/(confirm|discard))?)?$/);
        if(handling){
          const ref={kind:handling[1] as 'personal'|'mailbox',id:decodeURIComponent(handling[2]!)};
          if(method==='GET'&&!handling[3])return json(res,200,app.inboxHandling.read(ref));
          if(method==='POST'){
            const input=await body(req);
            if(handling[3]==='messages'&&!handling[4])return json(res,202,app.inboxHandling.post(ref,input as unknown as Parameters<typeof app.inboxHandling.post>[1]));
            if(handling[3]==='suggestions'){
              if(handling[4]){
                if(Object.keys(input).some(key=>!['sourceVersion','version'].includes(key)))throw new InputError('建议操作参数无效');
                const change = {sourceVersion:input.sourceVersion as number,version:input.version as number,id:decodeURIComponent(handling[4])};
                if (handling[5] === 'discard') return json(res,200,app.inboxHandling.discard(ref,change));
                return json(res,201,app.inboxHandling.confirm(ref,change));
              }
              return json(res,input.id?200:201,app.inboxHandling.save(ref,input as unknown as Parameters<typeof app.inboxHandling.save>[1]));
            }
          }
        }
        const inboxRelation=path.match(/^\/api\/v1\/inbox\/([^/]+)\/(tree|parent)$/);
        if(inboxRelation && (inboxRelation[2]==='tree' && method==='GET' || inboxRelation[2]==='parent' && method==='PUT')) {
          if(!app.plugins.list().some(p=>p.id==='inbox-triage' && p.status==='active')) throw new InputError('收件箱整理插件已停用',503);
          const id=decodeURIComponent(inboxRelation[1]!);
          if(method==='GET') return json(res,200,app.inbox.tree(id));
          const input=await body(req);
          if(Object.keys(input).some(key=>!['parentId','version'].includes(key)) || (input.parentId!==null && typeof input.parentId!=='string'))
            throw new InputError('收件关联参数无效');
          return json(res,200,app.inbox.setParent(id,input.parentId,input.version as number));
        }
        const inboxProject = path.match(/^\/api\/v1\/inbox\/([^/]+)\/project$/);
        if (inboxProject && method === 'PATCH') {
          const input = await body(req);
          if (Object.keys(input).some(key => !['version', 'projectId'].includes(key)) || (input.projectId !== undefined && typeof input.projectId !== 'string')) throw new InputError('项目归类参数无效');
          return json(res, 200, app.inbox.assignProject(decodeURIComponent(inboxProject[1]!), input.version as number, typeof input.projectId === 'string' ? input.projectId.trim() || undefined : undefined));
        }
        const inbox = path.match(/^\/api\/v1\/inbox\/([^/]+)\/(confirm|archive|reopen)$/);
        if (inbox && method === 'POST') {
          const input = await body(req);
          if (inbox[2] === 'confirm') {
            const result = app.inbox.confirm(inbox[1], input.version as number);
            app.events.publish('todos.changed', { id: result.todoId }); return json(res, 201, result);
          }
          if (inbox[2] === 'archive') app.inbox.archive(inbox[1], input.version as number);
          else app.inbox.reopen(inbox[1]);
          return json(res, 200, { ok: true });
        }
        const machineDirectories = path.match(/^\/api\/v1\/machines\/([^/]+)\/directories$/);
        if (machineDirectories && method === 'POST') return json(res, 201, await projectFolders.createDirectory(decodeURIComponent(machineDirectories[1]), await body(req)));
        const discoveredProjects = path.match(/^\/api\/v1\/machines\/([^/]+)\/projects$/);
        if (discoveredProjects && method === 'GET') return json(res, 200, await projectFolders.discover(decodeURIComponent(discoveredProjects[1]), url.searchParams.getAll('root')));
        const machineSkills = path.match(/^\/api\/v1\/machines\/([^/]+)\/skills$/);
        if (machineSkills && method === 'GET') {
          if (url.searchParams.size) throw new InputError('技能清单不接受路径或查询参数');
          if (!app.plugins.list().some(plugin => plugin.id === 'assistant-skills' && plugin.status === 'active'))
            throw new InputError('助手技能插件已停用', 503);
          return json(res, 200, await app.plugins.invocations.use('assistant-skills.machine-catalog', { machineId: decodeURIComponent(machineSkills[1]!) }));
        }
        const diagnose = path.match(/^\/api\/v1\/machines\/([^/]+)\/diagnostics$/);
        if (diagnose && method === 'POST') {
          const input = await body(req);
          if (Object.keys(input).some(key => key !== 'executorId') || !['codex', 'claude-code', 'pi'].includes(input.executorId as string)) throw new InputError('执行者诊断参数无效');
          return json(res, 200, await machines.call(decodeURIComponent(diagnose[1]!), 'executor.diagnostics', { executorId: input.executorId as string }, { timeoutMs: 25000 }));
        }
        const recovery = path.match(/^\/api\/v1\/machines\/([^/]+)\/recovery$/);
        if (recovery && method === 'GET') {
          if ([...url.searchParams.keys()].some(key => key !== 'sessionId')) throw new InputError('终端恢复查询参数无效');
          const sessionId = url.searchParams.get('sessionId');
          return json(res, 200, await machines.call(decodeURIComponent(recovery[1]!), 'executor.recovery', sessionId ? { sessionId } : {}));
        }
        const machineCode = path.match(/^\/api\/v1\/machines\/([^/]+)\/code$/);
        if (machineCode && method === 'GET') {
          const m = machines.list().find(item => item.id === decodeURIComponent(machineCode[1]!));
          if (!m?.online) throw new InputError('电脑已离线', 503);
          if (!m.capabilities.includes('workspace.code')) throw new InputError('请升级电脑代理以浏览代码', 409);
          const cwd = requiredText(url.searchParams.get('cwd'), '目录');
          const kind = url.searchParams.get('kind') ?? 'tree';
          if (!['tree', 'file', 'diff'].includes(kind)) throw new InputError('浏览类型无效');
          return json(res, 200, await machines.call(m.id, 'workspace.code', { cwd, kind, path: url.searchParams.get('path') ?? '' }));
        }
        const machine = path.match(/^\/api\/v1\/machines\/([^/]+)\/(sessions|call)$/);
        if (machine && method === 'GET' && machine[2] === 'sessions') return json(res, 200, await machines.call(decodeURIComponent(machine[1]), 'executor.sessions', {}));
        if (machine && method === 'POST' && machine[2] === 'call') {
          const input = await body(req);
          if (!app.plugins.list().some(plugin => plugin.id === 'terminal-host' && plugin.status === 'active')) throw new InputError('请启用终端宿主插件', 503);
          const rpc = requiredText(input.method, '执行机方法');
          if (!rpc.startsWith('executor.') && !rpc.startsWith('terminal.')) throw new InputError('不支持的执行机方法');
          if (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)) throw new InputError('params必须是对象');
          return json(res, 200, await machines.call(decodeURIComponent(machine[1]), rpc, input.params as JsonObject, rpc === 'terminal.host.start' ? { timeoutMs: 50_000 } : undefined));
        }
        const waitingReply = path.match(/^\/api\/v1\/todos\/([^/]+)\/waiting-reply(\/sources)?$/);
        if (waitingReply && method === 'GET') {
          const id = decodeURIComponent(waitingReply[1]!);
          if (waitingReply[2]) return json(res, 200, app.waitingReplies.sources(id, url.searchParams.get('query') ?? ''));
          return json(res, 200, url.searchParams.get('view') === 'summary' ? app.waitingReplies.summary(id) : app.waitingReplies.get(id));
        }
        if (waitingReply && method === 'POST' && !waitingReply[2]) return json(res, 201, app.waitingReplies.arm(decodeURIComponent(waitingReply[1]!), await body(req)));
        if (path === '/api/v1/approvals' && method === 'GET') return json(res, 200, app.approvals.list());
        if (path === '/api/v1/approvals' && method === 'POST') {
          const input = await body(req);
          return json(res, 201, app.approvals.propose(input as unknown as Parameters<typeof app.approvals.propose>[0]));
        }
        const approval = path.match(/^\/api\/v1\/approvals\/([^/]+)(?:\/(approve|reject))?$/);
        if (approval && method === 'PATCH' && !approval[2]) {
          const { version, ...patch } = await body(req);
          return json(res, 200, app.approvals.edit(approval[1], version as number, patch));
        }
        if (approval && method === 'POST' && approval[2]) {
          const input = await body(req);
          return json(res, 200, approval[2] === 'approve' ? await app.approvals.approve(approval[1], input.version as number) : app.approvals.reject(approval[1], input.version as number));
        }
        if ((path === '/api/v1/brief' || path === '/api/v1/brief/current') && method === 'GET') {
          if (path === '/api/v1/brief') app.supervision.tick();
          const brief = app.supervision.brief();
          if (!brief) throw new InputError('请启用每日简报插件', 503);
          return json(res, 200, brief);
        }
        if (path === '/api/v1/automation' && method === 'GET') return json(res, 200, app.supervision.settings());
        if (path === '/api/v1/automation' && method === 'PUT') {
          const input = await body(req);
          try { return json(res, 200, app.supervision.configure(input)); }
          catch (error) { throw new InputError(error instanceof Error ? error.message : '督办设置无效'); }
        }
        if (path === '/api/v1/effects' && method === 'GET') return json(res, 200, app.effects.list());
        if (path === '/api/v1/task-closure/settings' && method === 'GET') return json(res, 200, app.taskClosure.settings());
        if (path === '/api/v1/task-closure/settings' && method === 'PUT') return json(res, 200, app.taskClosure.configureSettings(await body(req)));
        const todoDecisions = path.match(/^\/api\/v1\/todos\/([^/]+)\/decisions(?:\/([^/]+)\/withdraw)?$/);
        if (todoDecisions) {
          const todoId = decodeURIComponent(todoDecisions[1]!);
          const decisionId = todoDecisions[2];
          if (method === 'GET' && !decisionId) return json(res, 200, { decisions: app.todoDecisions.list(todoId) });
          if (method === 'POST') {
            const input = await body(req);
            checkTodoScope(app, todoId, input);
            const decision = decisionId ? app.todoDecisions.withdraw(todoId, decodeURIComponent(decisionId)) : app.todoDecisions.add(todoId, input.text);
            app.events.publish('todo-decisions.changed', {todoId});
            return json(res, decisionId ? 200 : 201, decision);
          }
        }
        const reminderDeliveries = path.match(/^\/api\/v1\/todos\/([^/]+)\/reminder-deliveries$/);
        if (reminderDeliveries && method === 'GET') return json(res, 200, app.taskClosure.reminderDeliveries(decodeURIComponent(reminderDeliveries[1]!)));
        const todoHistory = path.match(/^\/api\/v1\/todos\/([^/]+)\/history$/);
        if (todoHistory && method === 'GET') return json(res, 200, app.taskClosure.history(decodeURIComponent(todoHistory[1]!), url.searchParams.get('before') ?? undefined));
        const closure = path.match(/^\/api\/v1\/todos\/([^/]+)\/(closure|reporting|report|review|review\/decide)$/);
        if (closure) {
          const todoId = decodeURIComponent(closure[1]!);
          if (closure[2] === 'closure' && method === 'GET') return json(res, 200, app.taskClosure.state(todoId));
          const input = method === 'PUT' || method === 'POST' ? await body(req) : {};
          if ('todoId' in input) throw new InputError('事项标识由请求路径确定');
          if (closure[2] === 'reporting' && method === 'PUT') return json(res, 200, app.taskClosure.reporting.configure({ ...input, todoId } as Parameters<typeof app.taskClosure.reporting.configure>[0]));
          if (closure[2] === 'report' && method === 'POST') return json(res, 200, app.taskClosure.reporting.report({ ...input, todoId } as Parameters<typeof app.taskClosure.reporting.report>[0]));
          if (closure[2] === 'review' && method === 'POST') return json(res, 200, app.taskClosure.review.attach({ ...input, todoId } as Parameters<typeof app.taskClosure.review.attach>[0]));
          if (closure[2] === 'review/decide' && method === 'POST') return json(res, 200, app.taskClosure.review.decide({ ...input, todoId } as Parameters<typeof app.taskClosure.review.decide>[0]));
        }
        const lineage = path.match(/^\/api\/v1\/todos\/([^/]+)\/(lineage|brief)$/);
        if (lineage && method === 'GET') {
          const id = decodeURIComponent(lineage[1]!);
          if (!app.store.get<Todo>('todos',id)) throw new InputError('待办不存在',404);
          if (url.searchParams.has('expectedProjectId')) checkTodoScope(app,id,{expectedProjectId:url.searchParams.get('expectedProjectId') || null});
          return json(res,200,lineage[2] === 'brief' ? todoBrief(app.store,id) : {steps:todoLineage(app.store,id)});
        }
        const continuation = path.match(/^\/api\/v1\/todos\/([^/]+)\/continue$/);
        if (continuation && method === 'POST') return json(res, 201, app.continueTodo(decodeURIComponent(continuation[1]!), await body(req)));
        const delegate = path.match(/^\/api\/v1\/todos\/([^/]+)\/delegate$/);
        if (delegate && method === 'POST') {
          const todoId = decodeURIComponent(delegate[1]!);
          const input = await body(req);
          checkTodoScope(app, todoId, input);
          return json(res, 202, await app.delegateTodo(todoId, input.executorId, input.doneWhen, input.expectMinutes));
        }
        if(path==='/api/v1/inbox/assistant'&&method==='GET')return json(res,200,{...app.inboxAssistant.status(),conversations:app.inboxAssistant.list()});
        if(path==='/api/v1/inbox/assistant'&&method==='PUT')return json(res,200,app.inboxAssistant.configure((await body(req)).enabled));
        const matterAction = path.match(/^\/api\/v1\/inbox\/conversations\/([^/]+)\/matters\/([^/]+)$/);
        if (matterAction && method === 'POST') {
          const input = await body(req);
          if (typeof input.done !== 'boolean' || !Number.isSafeInteger(input.version) || Number(input.version) < 1 ||
            Object.keys(input).some(key => key !== 'version' && key !== 'done')) throw new InputError('请提供会话版本和事项处理状态');
          return json(res, 200, app.inboxAssistant.setMatterDone(
            decodeURIComponent(matterAction[1]!), decodeURIComponent(matterAction[2]!), input.version as number, input.done));
        }
        const conversationAction=path.match(/^\/api\/v1\/inbox\/conversations\/([^/]+)\/(answer|archive|retry)$/);
        if(conversationAction&&method==='POST'){const input=await body(req),id=decodeURIComponent(conversationAction[1]!);
          return json(res,200,conversationAction[2]==='answer'?app.inboxAssistant.answer(id,input.version as number,input.text as string):conversationAction[2]==='archive'?app.inboxAssistant.archive(id,input.version as number):app.inboxAssistant.retry(id,input.version as number));}
        if (path === '/api/v1/todos' && method === 'GET') return json(res, 200, url.searchParams.get('view') === 'sections' ? todoSections(app.todos(), new Date(), todoDecisionIds(app.store)) : app.todos());
        if (path === '/api/v1/todos' && method === 'POST') return json(res, 201, app.createTodo(await body(req),true,'web'));
        const questionAnswer=path.match(/^\/api\/v1\/todos\/([^/]+)\/question-answer$/);
        if (questionAnswer && method==='POST') {
          const input=await body(req);
          return json(res,200,await app.answerDeferredQuestion(decodeURIComponent(questionAnswer[1]!),answerInput(input)));
        }
        const todo = path.match(/^\/api\/v1\/todos\/([^/]+)$/);
        if (todo && method === 'PATCH') return json(res, 200, app.updateTodo(todo[1], await body(req), true));
        if (path === '/api/v1/projects' && method === 'GET') return json(res, 200, app.projects.list());
        if (path === '/api/v1/projects' && method === 'POST') return json(res, 201, await app.createProject(await body(req)));
        const restoreProject = path.match(/^\/api\/v1\/projects\/([^/]+)\/restore$/);
        if (restoreProject && method === 'POST') return json(res, 200, app.projects.restore(decodeURIComponent(restoreProject[1])));
        const projectFollowUp = path.match(/^\/api\/v1\/projects\/([^/]+)\/follow-up$/);
        if (projectFollowUp && method === 'PUT') {
          const input = await body(req);
          if (!('followUp' in input) || Object.keys(input).some(key => !['followUp', 'expectedUpdatedAt', 'confirmed'].includes(key))) throw new InputError('项目跟进参数无效');
          return json(res, 200, app.updateProject(decodeURIComponent(projectFollowUp[1]!), input));
        }
        const projectWorkspace=path.match(/^\/api\/v1\/projects\/([^/]+)\/(workspace|messages|memory)$/);
        const code = path.match(/^\/api\/v1\/projects\/([^/]+)\/code$/);
        if (code && method === 'GET') {
          const kind = url.searchParams.get('kind') ?? 'tree';
          if (kind === 'search') {
            if (!app.plugins.list().some(p => p.id === 'conversation-search' && p.status === 'active'))
              throw new InputError('对话搜索插件已停用', 503);
            const query = url.searchParams.get('query');
            if (url.searchParams.size !== 2 || query === null) throw new InputError('文件检索只接受 kind 和 query');
            return json(res, 200, await app.plugins.invocations.use('conversation-search.files', { projectId: decodeURIComponent(code[1]!), query }));
          }
          const project = app.projects.list().find(p => p.id === decodeURIComponent(code[1]));
          if (!project || project.archivedAt) throw new InputError('项目不存在', 404);
          if (!project.workspace) throw new InputError('项目尚未绑定电脑目录', 409);
          const machine = machines.list().find(m => m.id === project.workspace!.machineId);
          if (!machine?.online) throw new InputError('绑定电脑已离线', 503);
          if (!machine.capabilities.includes('workspace.code')) throw new InputError('请升级绑定电脑的代理以浏览代码', 409);
          if (!['tree','file','diff'].includes(kind)) throw new InputError('浏览类型无效');
          return json(res, 200, await machines.call(machine.id, 'workspace.code', { cwd: project.workspace.cwd, kind, path: url.searchParams.get('path') ?? '' }));
        }
        if(projectWorkspace){const id=decodeURIComponent(projectWorkspace[1]);
          if (projectWorkspace[2] === 'workspace' && method === 'GET') {
            const cursors = (['at', 'before', 'after'] as const).flatMap(kind => url.searchParams.getAll(kind).map(value => ({ kind, id: value })));
            if (cursors.length > 1 || cursors.some(cursor => !cursor.id.trim())) throw new InputError('请指定一个有效的消息位置');
            return json(res, 200, await app.projectWorkspace.view(id, cursors[0]));
          }
          if (projectWorkspace[2] === 'messages' && method === 'POST') {
            const input = await chatMessageBody(req);
            const todoId = input.todoId === undefined ? undefined : requiredText(input.todoId, '待办标识');
            return json(res, 202, await app.projectWorkspace.post(id, input.text, messageRequestId(req), todoId, true, input.images, input.files));
          }
          if(projectWorkspace[2]==='memory'&&method==='GET')return json(res,200,app.projectWorkspace.memoryConversation(id));
          if(projectWorkspace[2]==='memory'&&method==='POST')return json(res,202,app.projectWorkspace.request(id));
          if(projectWorkspace[2]==='memory'&&method==='PUT')return json(res,200,app.projectWorkspace.configure(id,(await body(req)).enabled as boolean));
        }
        const project = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
        if (project && method === 'PATCH') return json(res, 200, app.updateProject(decodeURIComponent(project[1]), await projectFolders.prepare(await body(req))));
        if (project && method === 'DELETE') return json(res, 200, app.projects.archive(decodeURIComponent(project[1])));
        if (path === '/api/v1/knowledge/source-reader' && method === 'GET') return json(res, 200, app.knowledgeSources.status());
        if (path === '/api/v1/knowledge/source-reader' && method === 'PUT') { app.knowledgeSources.configure(await body(req)); return json(res, 200, app.knowledgeSources.status()); }
        if (path === '/api/v1/knowledge/curator' && method === 'GET') return json(res, 200, app.knowledgeCurator.status());
        if (path === '/api/v1/knowledge/curator' && method === 'PUT') return json(res, 200, await app.knowledgeCurator.configure(await body(req)));
        if (path === '/api/v1/knowledge/meeting-search' && method === 'GET') {
          return json(res, 200, await app.knowledgeCurator.searchMeetings(url.searchParams.get('query') ?? '',
            url.searchParams.get('projectId') || undefined, Number(url.searchParams.get('offset') ?? 0)));
        }
        if (path === '/api/v1/knowledge/meeting-day' && method === 'GET') {
          return json(res, 200, await app.knowledgeCurator.meetingDay(url.searchParams.get('date') ?? '',
            url.searchParams.get('timezone') ?? app.briefing.settings().timezone, url.searchParams.get('projectId') || undefined,
            Number(url.searchParams.get('offset') ?? 0)));
        }
        if (path === '/api/v1/knowledge/index' && method === 'GET') return json(res, 200, await app.knowledgeCurator.index());
        if (path === '/api/v1/knowledge/sources' && method === 'POST') return json(res, 201, app.knowledgeCurator.addSource(await body(req)));
        const knowledgeRevision = path.match(/^\/api\/v1\/knowledge\/([^/]+)\/revision$/);
        if (knowledgeRevision && method === 'GET') {
          return json(res, 200, { revision: await app.knowledgeRevision(decodeURIComponent(knowledgeRevision[1]!), url.searchParams.get('commit') ?? undefined) });
        }
        const pageSources = path.match(/^\/api\/v1\/knowledge\/([^/]+)\/sources(?:\/([^/]+))?$/);
        if (pageSources && method === 'GET') return json(res, 200, await app.knowledgeCurator.pageSources(
          decodeURIComponent(pageSources[1]!), pageSources[2] && decodeURIComponent(pageSources[2]), undefined, url.searchParams.get('view') === 'handoff'));
        const meetingTitle = path.match(/^\/api\/v1\/knowledge\/sources\/([^/]+)\/title$/);
        if (meetingTitle && method === 'PUT') return json(res, 200, app.knowledgeCurator.renameMeeting(
          decodeURIComponent(meetingTitle[1]!), await body(req)));
        const retrySource = path.match(/^\/api\/v1\/knowledge\/sources\/([^/]+)\/retry$/);
        if (retrySource && method === 'POST') {
          const input = await body(req);
          if (Object.keys(input).some(key => key !== 'key') || (input.key !== undefined && typeof input.key !== 'string')) throw new InputError('重试请求参数无效');
          return json(res, 201, app.knowledgeCurator.retry(decodeURIComponent(retrySource[1]), input.key as string | undefined));
        }
        if (path === '/api/v1/knowledge' && method === 'GET') return json(res, 200, await app.knowledge().list());
        if (path === '/api/v1/knowledge' && method === 'POST') {
          const input = await body(req);
          if (!['personal', 'global', 'project'].includes(String(input.layer))) throw new InputError('请选择个人、全局或项目知识');
          if (typeof input.title !== 'string' || typeof input.content !== 'string') throw new InputError('知识标题和内容必须是文本');
          if (input.projectId !== undefined && typeof input.projectId !== 'string') throw new InputError('项目必须是文本');
          if (input.id !== undefined && typeof input.id !== 'string') throw new InputError('知识标识必须是文本');
          const layer = input.layer as 'personal' | 'global' | 'project';
          const projectId = layer === 'project' ? requiredText(input.projectId, '项目') : undefined;
          const entry = await app.knowledge().put({ aliases: input.aliases as string[] | undefined, contentLocked: input.contentLocked as boolean | undefined, confirmedFacts: input.confirmedFacts as string | undefined, relevance: input.relevance as number | null | undefined, importance: input.importance as KnowledgeImportance | null | undefined, tags: input.tags as string[] | undefined, id: input.id as string | undefined, layer, title: requiredText(input.title, '标题'), content: requiredText(input.content, '内容'), projectId }, undefined, 'workbench');
          await app.knowledgeCurator.rebuildIndex();
          app.events.publish('knowledge.changed', { id: entry.id }); return json(res, 201, entry);
        }
        const actionTodos = path.match(/^\/api\/v1\/knowledge\/([^/]+)\/action-todos(\/status)?$/);
        if (actionTodos && method === 'POST') {
          const input = await body(req);
          if (!Array.isArray(input.actions)) throw new InputError('请选择行动项');
          const selection = { id: decodeURIComponent(actionTodos[1]), updatedAt: input.updatedAt, actions: input.actions };
          if (actionTodos[2]) return json(res, 200, await app.knowledgeActionStatus(selection));
          const results = await app.confirmKnowledgeActions(selection);
          return json(res, 200, { results });
        }
        const knowledge = path.match(/^\/api\/v1\/knowledge\/([^/]+)$/);
        if (knowledge && method === 'PATCH') {
          const id = decodeURIComponent(knowledge[1]);
          const previous = (await app.knowledge().list()).find(entry => entry.id === id);
          if (!previous) throw new InputError('知识不存在', 404);
          const input = await body(req);
          if (input.expectedUpdatedAt !== undefined && typeof input.expectedUpdatedAt !== 'string') throw new InputError('知识页版本无效');
          const layer = input.layer ?? previous.layer;
          if (!['personal', 'global', 'project'].includes(String(layer))) throw new InputError('知识层级无效');
          const projectId = layer === 'project' ? requiredText(input.projectId ?? previous.projectId, '项目') : undefined;
          if (input.title !== undefined && typeof input.title !== 'string') throw new InputError('标题必须为文本');
          if (input.content !== undefined && typeof input.content !== 'string') throw new InputError('内容必须为文本');
          const entry = await app.knowledge().put({ aliases: input.aliases as string[] | undefined, contentLocked: input.contentLocked as boolean | undefined, confirmedFacts: input.confirmedFacts as string | undefined, relevance: input.relevance as number | null | undefined, importance: input.importance as KnowledgeImportance | null | undefined, tags: input.tags as string[] | undefined, id, layer: layer as 'personal' | 'global' | 'project', title: input.title === undefined ? previous.title : requiredText(input.title, '标题'), content: input.content === undefined ? previous.content : requiredText(input.content, '内容'), ...(projectId ? { projectId } : {}) }, input.expectedUpdatedAt ?? previous.updatedAt, 'workbench');
          await app.knowledgeCurator.rebuildIndex(); app.events.publish('knowledge.changed', { id }); return json(res, 200, entry);
        }
        if (knowledge && method === 'DELETE') {
          const removed = await app.knowledge().remove(knowledge[1]);
          if (!removed) throw new InputError('知识不存在', 404);
          await app.knowledgeCurator.rebuildIndex();
          app.events.publish('knowledge.changed', { id: knowledge[1] }); return json(res, 200, { removed });
        }
        const retryReply = path.match(/^\/api\/v1\/messages\/([^/]+)\/retry$/);
        if (retryReply && method === 'POST') {
          const input=await body(req);
          if (Object.keys(input).some(key=>key!=='conversationId')) throw new InputError('重试仅接受原会话标识');
          const conversationId=requiredText(input.conversationId,'原会话');
          return json(res,202,await app.retryFailedReply(decodeURIComponent(retryReply[1]!),conversationId));
        }
        const queueView = path.match(/^\/api\/v1(?:\/projects\/([^/]+))?\/messages\/queue$/);
        if (queueView && (method==='GET' || method==='POST')) {
          const project = queueView[1] && decodeURIComponent(queueView[1]);
          const filter = url.searchParams.get('projectId') || undefined;
          const todoId = url.searchParams.get('todoId') || undefined;
          if (project && filter && filter!==project || !project && todoId)
            throw new InputError('队列筛选范围与当前会话不符');
          const conversationId=project ? `project:${project}:work` : 'main';
          if (method==='POST') return json(res,200,app.reorderQueuedMessages(conversationId,project || filter,todoId,await body(req)));
          return json(res,200,app.queuedMessages(conversationId,project || filter,todoId));
        }
        const stopMessage = path.match(/^\/api\/v1(?:\/projects\/([^/]+))?\/messages\/([^/]+)\/(stop|cancel-queued|edit-queued)$/);
        if (stopMessage && method === 'POST') {
          const projectId = stopMessage[1] && decodeURIComponent(stopMessage[1]);
          if (projectId && !app.projects.list().some(p => p.id === projectId && !p.archivedAt))
            throw new InputError('项目不存在或已归档', 404);
          const conversationId = projectId ? `project:${projectId}:work` : 'main';
          const inputId = decodeURIComponent(stopMessage[2]!);
          if (stopMessage[3]==='edit-queued') {
            const input=await body(req);
            if (Object.keys(input).some(key=>key!=='projectId' && key!=='todoId')) throw new InputError('取回编辑仅接受原草稿范围');
            const draftProject=input.projectId===undefined ? projectId || undefined : requiredText(input.projectId,'项目标识');
            const todoId=input.todoId===undefined ? undefined : requiredText(input.todoId,'待办标识');
            if (projectId && projectId!==draftProject) throw new InputError('编辑框与消息项目不一致',409);
            return json(res,200,app.editQueuedTurn(conversationId,inputId,draftProject,todoId));
          }
          if (stopMessage[3]==='cancel-queued') return json(res,200,app.cancelQueuedTurn(conversationId,inputId));
          const message = app.store.get<Message>('messages',inputId);
          if (!message || message.role !== 'user' || message.conversationId !== conversationId)
            throw new InputError('当前会话中未找到这条输入', 404);
          return json(res, 200, await app.interruptTurn(conversationId, message.id));
        }
        if (path === '/api/v1/chat-files/uploads' && method === 'PUT') {
          const conversationId=requiredText(url.searchParams.get('conversationId'),'目标会话');
          const projectId=url.searchParams.get('projectId') || undefined, todoId=url.searchParams.get('todoId') || undefined;
          if (conversationId==='main' ? !!todoId : !projectId || conversationId!==`project:${projectId}:work`)
            throw new InputError('文件上传目标必须为当前主对话或项目对话',403);
          if (Number(req.headers['content-length'])>maxChatFileBytes) throw new InputError('单个文件最多 200 MiB',413);
          const name=url.searchParams.get('name') ?? '';
          const uploaded=await app.uploadChatFile({conversationId,projectId,todoId},name,req.headers['content-type'] || 'application/octet-stream',req);
          return json(res,201,uploaded);
        }
        const fileRoute=path.match(/^\/api\/v1\/messages\/([^/]+)\/files\/(0|[1-9]\d*)(\/preview)?$/);
        if (fileRoute && method === 'GET') {
          const messageId=decodeURIComponent(fileRoute[1]!), conversationId=requiredText(url.searchParams.get('conversationId'),'原会话');
          if (fileRoute[3]) {
            const controller=new AbortController();
            const disconnected=()=>controller.abort();
            res.once('close',disconnected);
            try {
              const preview=await app.previewMessageFile(messageId,conversationId,Number(fileRoute[2]),controller.signal);
              if (!res.destroyed) return json(res,200,preview);
            } finally { res.off('close',disconnected); }
            return;
          }
          const {path:diskPath,ref}=app.messageFile(messageId,conversationId,Number(fileRoute[2]));
          res.writeHead(200,{'content-type':'application/octet-stream','content-length':ref.bytes,'cache-control':'private, no-store',
            'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(ref.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16)),
            'x-content-type-options':'nosniff','content-security-policy':"sandbox"});
          try { await pipeline(createReadStream(diskPath),res); } catch { res.destroy(); }
          return;
        }
        const messageImage = path.match(/^\/api\/v1\/messages\/([^/]+)\/images\/(0|[1-9]\d*)$/);
        if (messageImage && method === 'GET') {
          const conversationId = requiredText(url.searchParams.get('conversationId'),'原会话');
          const image = app.messageImage(decodeURIComponent(messageImage[1]!),conversationId,Number(messageImage[2]));
          res.writeHead(200,{'content-type':image.mime,'cache-control':'private, no-store','x-content-type-options':'nosniff'});
          return res.end(Buffer.from(image.data,'base64'));
        }
        const messageReceipt = path.match(/^\/api\/v1(?:\/projects\/([^/]+))?\/messages\/receipts\/([^/]+)$/);
        if (messageReceipt && method === 'GET') {
          const projectId = messageReceipt[1] && decodeURIComponent(messageReceipt[1]);
          if (projectId && !app.projects.list().some(p => p.id === projectId && !p.archivedAt))
            throw new InputError('项目不存在或已归档', 404);
          const receipt = readMessageReceipt(app.store, projectId ? `project:${projectId}:work` : 'main', messageReceipt[2]!);
          if (!receipt) return json(res,404,{error:'当前会话中未找到这次发送的回执',code:'MESSAGE_RECEIPT_NOT_FOUND'});
          return json(res, 200, receipt);
        }
        if (path === '/api/v1/messages' && method === 'POST') {
          const input = await chatMessageBody(req);
          const projectId = typeof input.projectId === 'string' ? input.projectId.trim() || undefined : undefined;
          if (projectId && !app.projects.list().some(p=>p.id===projectId && !p.archivedAt))
            throw new InputError('项目不存在或已归档',404);
          return json(res, 202, await app.agent.post(input.text, 'main', { directWebInput:true, images:input.images, files:input.files, requestId: messageRequestId(req), projectId, ...(input.readOnly === true ? { readOnly: true } : {}) }));
        }
        if (path === '/api/v1/runs' && method === 'POST') return json(res, 202, app.dispatch(await body(req), typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined));
        const completion = path.match(/^\/api\/v1\/runs\/([^/]+)\/completion$/);
        if (completion && method === 'GET') {
          const id = decodeURIComponent(completion[1]!);
          const run = app.store.get<Run>('runs',id);
          if (!run || run.id !== id) throw new InputError('执行不存在',404);
          if (!url.searchParams.has('expectedProjectId')) throw new InputError('请指定预期项目');
          if (url.searchParams.get('expectedProjectId') !== (run.projectId ?? '')) throw new InputError('执行所在项目已变化',409);
          return json(res,200,{runId:id,completionTiming:runCompletionTiming(app.store,run) ?? null});
        }
        if (path === '/api/v1/source-subscriptions' && method === 'GET') {
          return json(res,200,{sources:app.subscriptions.sources(),subscriptions:app.subscriptions.service().list(),timezone:app.subscriptions.timezone()});
        }
        if (path === '/api/v1/source-subscriptions/drafts' && method === 'GET')
          return json(res,200,{items:app.subscriptions.drafts.list()});
        const subscriptionDraft=path.match(/^\/api\/v1\/source-subscriptions\/drafts\/([^/]+)$/);
        if (subscriptionDraft && method === 'GET') return json(res,200,app.subscriptions.drafts.get(decodeURIComponent(subscriptionDraft[1]!)));
        if (path === '/api/v1/source-subscriptions/preview' && method === 'POST') {
          return json(res,200,await app.subscriptions.service().preview(await body(req)));
        }
        if (path === '/api/v1/source-subscriptions' && method === 'POST') {
          return json(res,201,app.subscriptions.drafts.create(await body(req)));
        }
        const subscriptionHistory=path.match(/^\/api\/v1\/source-subscriptions\/([^/]+)\/(runs|snapshot-history)$/);
        if(subscriptionHistory && method==='GET') {
          const id=decodeURIComponent(subscriptionHistory[1]!);
          const service=app.subscriptions.service();
          return json(res,200,subscriptionHistory[2]==='runs' ? service.runHistory(id) : service.snapshotHistory(id));
        }
        const subscription = path.match(/^\/api\/v1\/source-subscriptions\/([^/]+)(\/pull)?$/);
        if (subscription && ((method === 'POST' && subscription[2]) || ((method === 'PATCH' || method === 'DELETE') && !subscription[2]))) {
          const id = decodeURIComponent(subscription[1]!), input = await body(req);
          const service = app.subscriptions.service();
          return json(res,200,method === 'DELETE' ? service.remove(id,input.version) : method === 'PATCH' ? service.update(id,input) : await service.pull(id,input.version));
        }
        const runScope = path.match(/^\/api\/v1\/runs\/([^/]+)\/scope$/);
        if (runScope && (method === 'GET' || method === 'POST')) {
          const id = decodeURIComponent(runScope[1]!);
          const input = method === 'POST' ? await body(req) : {expectedProjectId:url.searchParams.get('expectedProjectId') || null};
          const scope = app.runScopes.read(id);
          if (input.expectedProjectId !== (scope.projectId ?? null)) throw new InputError('执行所在项目已变化，请重新核对',409);
          return json(res,200, method === 'GET' ? scope : app.runScopes.reviseWeb(id,input));
        }
        const worktreeName = path.match(/^\/api\/v1\/runs\/([^/]+)\/worktree-name$/);
        if (worktreeName && method === 'PATCH')
          return json(res, 200, app.renameRunWorktree(decodeURIComponent(worktreeName[1]!), await body(req)));
        const retainedBranch = path.match(/^\/api\/v1\/runs\/([^/]+)\/retained-branch$/);
        if (retainedBranch && (method === 'GET' || method === 'POST'))
          return json(res, 200, await app.retainedRunBranch(decodeURIComponent(retainedBranch[1]!), method === 'POST' ? await body(req) : undefined));
        const cleanupWorktree = path.match(/^\/api\/v1\/runs\/([^/]+)\/worktree-cleanup$/);
        if (cleanupWorktree && method === 'POST')
          return json(res, 200, await app.cleanupRunWorktree(decodeURIComponent(cleanupWorktree[1]!), await body(req)));
        const history = path.match(/^\/api\/v1\/runs\/([^/]+)\/worktree-history$/);
        if (history && method === 'GET') return json(res, 200, await app.runWorktreeHistory(decodeURIComponent(history[1]!),
          url.searchParams.get('mode') ?? 'all', Number(url.searchParams.get('offset') ?? 0), url.searchParams.get('version') ?? undefined, url.searchParams.get('commit') ?? undefined, url.searchParams.get('path') ?? undefined));
        const worktreeChange = path.match(/^\/api\/v1\/runs\/([^/]+)\/worktree-change$/);
        if (worktreeChange && method === 'GET')
          return json(res, 200, await app.readRunWorktreeChange(decodeURIComponent(worktreeChange[1]!), url.searchParams.get('path') ?? '', url.searchParams.get('area') ?? ''));
        const worktreeStatus = path.match(/^\/api\/v1\/runs\/([^/]+)\/worktree-status$/);
        if (worktreeStatus && method === 'GET') {
          if ([...url.searchParams.keys()].some(key => key !== 'offset' && key !== 'version')) throw new InputError('工作树状态仅接受分页参数');
          return json(res, 200, await app.runWorktreeStatus(decodeURIComponent(worktreeStatus[1]!), false, Number(url.searchParams.get('offset') ?? 0), url.searchParams.get('version') ?? undefined));
        }
        const commitDiff = path.match(/^\/api\/v1\/runs\/([^/]+)\/commit-diff$/);
        if (commitDiff && method === 'GET') {
          if ([...url.searchParams.keys()].some(key => key !== 'path')) throw new InputError('仅接受文件路径');
          return json(res, 200, await app.readRunCommitDiff(decodeURIComponent(commitDiff[1]!), url.searchParams.get('path') ?? undefined));
        }
        const observations = path.match(/^\/api\/v1\/runs\/([^/]+)\/observations$/);
        if (observations && method === 'GET') return json(res, 200, app.runObservations(decodeURIComponent(observations[1]!)));
        const cancel = path.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/);
        if (cancel && method === 'POST') return json(res, 202, await app.cancel(cancel[1]));
        // These services read conversation content and cancel work when the browser disconnects.
        const reader = conversationReaders.get(path);
        if (reader && method === 'POST') {
          if (!app.plugins.list().some(plugin => plugin.id === reader.id && plugin.status === 'active'))
            throw new InputError(reader.disabled, 503);
          const input = await body(req, reader.limit) as JsonObject;
          const controller = new AbortController();
          const abort = () => controller.abort();
          res.once('close', abort);
          if (res.destroyed) abort();
          try {
            const read = () => app.plugins.invocations.use(reader.service, input, { signal: controller.signal, timeoutMs: reader.timeoutMs ?? 30000 });
            if (reader.id !== 'conversation-export' || !input?.native || req.headers.accept !== 'application/x-ndjson')
              return json(res, 200, await read());
            const result = await nativeExportProgress.run((bytes, total, messages) => {
              if (res.destroyed || res.writableEnded) return;
              if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
              res.write(JSON.stringify({ progress: { bytes, total, messages } }) + '\n');
            }, read);
            if (res.destroyed) return;
            if (!res.headersSent) return json(res, 200, result);
            res.end(JSON.stringify({ result }) + '\n');
            return;
          } catch (error) {
            if (res.destroyed) return;
            if (!res.headersSent) throw error;
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : '导出失败' }) + '\n');
            return;
          } finally { res.off('close', abort); }
        }
        if (path === '/api/v1/office-documents' && method === 'POST') {
          if (!app.plugins.list().some(plugin => plugin.id === 'office-documents' && plugin.status === 'active'))
            throw new InputError('办公文件插件已停用', 503);
          return json(res, 200, await app.plugins.invocations.use('office-documents.manage', await body(req, 17 * 1024 * 1024) as JsonObject));
        }
        if (path === '/api/v1/assistant-skills' && method === 'POST') {
          if (!app.plugins.list().some(plugin => plugin.id === 'assistant-skills' && plugin.status === 'active'))
            throw new InputError('主助手技能插件已停用', 503);
          return json(res, 200, await app.plugins.invocations.use('assistant-skills.manage', await body(req, 6 * 1024 * 1024) as JsonObject));
        }
        if (path === '/api/v1/start-page' && method === 'POST') {
          if (!app.plugins.list().some(p => p.id === 'start-page' && p.status === 'active')) throw new InputError('启动页插件已停用', 503);
          return json(res, 200, await app.plugins.invocations.use('start-page.save', await body(req, 4096) as JsonObject));
        }
        if (path === '/api/v1/assistant-profile' && method === 'POST') {
          if (!app.plugins.list().some(plugin => plugin.id === 'assistant-profile' && plugin.status === 'active')) {
            throw new InputError('主助手资料插件已停用', 503);
          }
          return json(res, 200, await app.plugins.invocations.use('assistant-profile.manage', await body(req) as JsonObject));
        }
        if (path === '/api/v1/project-instructions' && method === 'POST') {
          if (!app.plugins.list().some(plugin => plugin.id === 'project-instructions' && plugin.status === 'active')) {
            throw new InputError('项目工作指令插件已停用', 503);
          }
          return json(res, 200, await app.plugins.invocations.use('project-instructions.manage', await body(req) as JsonObject));
        }
        if (path === '/api/v1/workspace-board' && method === 'POST') {
          if (!app.plugins.list().some(plugin => plugin.id === 'workspace-board' && plugin.status === 'active'))
            throw new InputError('工作区看板插件已停用', 503);
          return json(res, 200, await app.plugins.invocations.use('workspace-board.manage', await body(req) as JsonObject));
        }
        if (path === '/api/v1/saved-prompts' && method === 'POST') {
          if (!app.plugins.list().some(plugin => plugin.id === 'saved-prompts' && plugin.status === 'active')) {
            throw new InputError('常用提示词插件已停用', 503);
          }
          return json(res, 200, await app.plugins.invocations.use('saved-prompts.manage', await body(req) as JsonObject));
        }
        if (path === '/api/v1/saved-searches' && (method === 'GET' || method === 'POST')) {
          const input = method === 'GET' ? { action: 'list' } : await body(req) as JsonObject;
          if (!app.plugins.list().some(plugin => plugin.id === 'conversation-search' && plugin.status === 'active')) {
            throw new InputError('对话历史搜索插件已停用', 503);
          }
          return json(res, 200, await app.plugins.invocations.use('conversation-search.saved', input));
        }
        const plugin = path.match(/^\/api\/v1\/plugins\/([^/]+)$/);
        if (plugin && method === 'POST') {
          const input = await body(req);
          if (typeof input.enabled !== 'boolean') throw new InputError('enabled必须为布尔值');
          if (!app.plugins.list().some(entry => entry.id === plugin[1])) throw new InputError('插件不存在', 404);
          await app.plugins.setEnabled(plugin[1], input.enabled);
          app.events.publish('plugins.changed', { id: plugin[1] }); return json(res, 200, app.plugins.list());
        }
        throw new InputError('接口不存在', 404);
      }
      // 静态资源按目录提供：只允许 apps/web 下已知类型的文件，拒绝 .. 和隐藏文件。
      if (req.method !== 'GET') throw new InputError('页面不存在', 404);
      if (/^\/assets\/boot\/(intro|loop)(-avc)?\.mp4$/.test(path)) {
        const file = new URL('../../web' + path, import.meta.url);
        const { size } = await stat(file);
        const range = req.headers.range;
        const match = range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (start > end) {
          res.writeHead(416, { 'content-range': 'bytes */' + size }).end(); return;
        }
        res.writeHead(match ? 206 : 200, {
          'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1,
          ...(match ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
        });
        // 跳过开屏会取消浏览器读流，连接已关闭时无需再回错误响应。
        try { await pipeline(createReadStream(file, { start, end }), res); }
        catch (error) { if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined); }
        return;
      }
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      let assetURL: URL;
      let contentType: string;
      if (path === '/vendor/sha256.js') {
        assetURL = new URL(import.meta.resolve('fast-sha256'));
        contentType = 'text/javascript';
      } else if (path === '/vendor/xterm.js' || path === '/vendor/xterm.css') {
        assetURL = new URL(path.endsWith('.css') ? '../css/xterm.css' : './xterm.js', import.meta.resolve('@xterm/xterm'));
        contentType = path.endsWith('.css') ? 'text/css' : 'text/javascript';
      } else {
        const relative = path === '/' ? 'index.html' : path.slice(1);
        const extension = relative.slice(relative.lastIndexOf('.'));
        if (!/^[\w./-]+$/.test(relative) || relative.split('/').some(part => part === '..' || part.startsWith('.')) || !types[extension]) throw new InputError('页面不存在', 404);
        assetURL = new URL(`../../web/${relative}`, import.meta.url);
        contentType = types[extension];
      }
      const content = await readFile(assetURL).catch(() => { throw new InputError('页面不存在', 404); });
      res.writeHead(200, { 'content-type': `${contentType}; charset=utf-8`, 'x-content-type-options': 'nosniff' }); res.end(content);
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500;
      const retryAt = status===429 && error instanceof Error && 'retryAt' in error && typeof error.retryAt==='string'
        ? Date.parse(error.retryAt) : NaN;
      if (Number.isFinite(retryAt)) res.setHeader('Retry-After',String(Math.max(1,Math.ceil((retryAt-Date.now())/1000))));
      const retryKind=error instanceof Error && 'retryKind' in error ? error.retryKind : undefined;
      json(res, status, { error: error instanceof Error ? error.message : '请求失败',
        ...(Number.isFinite(retryAt) && {retryAt:new Date(retryAt).toISOString(),
          ...((retryKind==='failures' || retryKind==='rate_limit') && {retryKind})}) });
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!authorized(req, url) || !['/api/v1/events', '/api/v1/node', '/api/v1/terminal', '/api/v1/live-terminal'].includes(url.pathname) || (url.pathname.endsWith('/node') && !config.token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
      if (url.pathname === '/api/v1/live-terminal') {
        const machineId = url.searchParams.get('machineId') || '';
        const mode = url.searchParams.get('mode') || 'full';
        if (!app.plugins.list().some(plugin => plugin.id === 'terminal-host' && plugin.status === 'active')) { ws.close(1008, '终端宿主插件已停用'); return; }
        if (!machineId || !['full', 'observe', 'control'].includes(mode)) { ws.close(1008, '执行机或终端模式无效'); return; }
        const sessionName = url.searchParams.get('session');
        const selection: JsonObject = sessionName === null ? {} : { session: sessionName };
        let connectionId = '';
        let seq = -1;
        let closed = false;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        let writeChain = Promise.resolve();
        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearTimeout(pollTimer);
          if (connectionId) {
            const id = connectionId; connectionId = '';
            void machines.call(machineId, 'terminal.live.release', { connectionId: id }).catch(() => {});
          }
        };
        function fail(error: unknown) {
          if (closed) return;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : '终端连接中断' }));
            ws.close();
          }
          cleanup();
        }
        let pendingWrites = 0;
        ws.on('close', cleanup);
        ws.on('message', raw => {
          if (closed) return;
          try {
            if (!connectionId) throw new Error('请等待终端连接就绪');
            const msg = JSON.parse(String(raw)) as Record<string, unknown>;
            const id = connectionId;
            let method: string, params: JsonObject;
            if (mode !== 'observe' && msg.type === 'input' && typeof msg.data === 'string' && msg.data.length <= 65536) {
              method = 'terminal.live.input';
              params = { connectionId: id, data: msg.data };
            } else if (mode === 'full' && msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
              method = 'terminal.live.resize';
              params = { connectionId: id, cols: msg.cols as number, rows: msg.rows as number };
            } else throw new Error('当前终端模式不支持此操作');
            if (++pendingWrites > 256) throw new Error('终端输入积压，请重新连接');
            writeChain = writeChain.then(async () => {
              if (!closed) await machines.call(machineId, method, params);
            }).catch(fail).finally(() => { pendingWrites--; });
          } catch (error) { fail(error); }
        });
        void (async () => {
          try {
            const openRes = mode === 'full'
              ? await machines.call(machineId, 'terminal.live.full.open', {
                  ...selection, cols: Number(url.searchParams.get('cols')) || 120,
                  rows: Number(url.searchParams.get('rows')) || 36,
                }, { timeoutMs: 45_000 }) as { connectionId: string; session?: string }
              : await machines.call(machineId, 'terminal.live.open', {
                  ...selection, paneId: url.searchParams.get('paneId') || '',
                  terminalId: url.searchParams.get('terminalId') || '',
                  cwd: url.searchParams.get('cwd') || '',
                  mode: mode === 'control' ? 'control' : 'observe',
                }, { timeoutMs: 45_000 }) as { connectionId: string; session?: string };
            if (closed) { void machines.call(machineId, 'terminal.live.release', { connectionId: openRes.connectionId }).catch(() => {}); return; }
            connectionId = openRes.connectionId;
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ready', connectionId, mode, session: openRes.session ?? sessionName ?? undefined }));
            const pump = async () => {
              if (closed || !connectionId || ws.readyState !== WebSocket.OPEN) return;
              try {
                const res = await machines.call(machineId, 'terminal.live.frames', { connectionId, after: seq }) as { frames?: Array<{ seq: number; width?: number; height?: number; data: string }> };
                if (closed || ws.readyState !== WebSocket.OPEN) return;
                for (const frame of res.frames ?? []) {
                  if (ws.bufferedAmount > 2 * 1024 * 1024) throw new Error('浏览器接收画面过慢，请重新连接');
                  ws.send(JSON.stringify({ type: 'frame', ...frame }));
                  seq = frame.seq;
                }
                pollTimer = setTimeout(() => { void pump(); }, 60);
              } catch (err) { fail(err); }
            };
            void pump();
          } catch (err) { fail(err); }
        })();
        return;
      }
      if (url.pathname === '/api/v1/events') {
        ws.send(JSON.stringify({ type: 'connected' }));
        const off = app.events.subscribe(event => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, '请重新连接刷新状态'); return; }
          ws.send(JSON.stringify(event));
        });
        ws.on('close', () => { void off(); });
        return;
      }
      if (url.pathname === '/api/v1/terminal') {
        const machineId = url.searchParams.get('machineId'), paneId = url.searchParams.get('paneId');
        if (!app.plugins.list().some(plugin => plugin.id === 'terminal-host' && plugin.status === 'active')) { ws.close(1008, '终端宿主插件已停用'); return; }
        if (!machineId || !paneId) { ws.close(1008, '缺少机器或终端'); return; }
        let watchId: string | undefined, done = false;
        const early: JsonObject[] = [];
        let earlyBytes = 0;
        const send = (data: JsonObject) => {
          if (ws.readyState !== WebSocket.OPEN || data.watchId !== watchId) return;
          if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, '请重新连接同步完整画面'); return; }
          const { watchId: _, paneId: __, ...frame } = data;
          ws.send(JSON.stringify(frame));
        };
        const off = machines.onEvent(event => {
          if (event.machineId !== machineId || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
          const data = event.data;
          if (data.paneId !== paneId) return;
          if (event.event === 'terminal.error') { ws.close(1011, '终端观察失败，请重新连接'); return; }
          if (event.event !== 'terminal.frame') return;
          if (!watchId) {
            earlyBytes += JSON.stringify(data).length;
            if (earlyBytes > 1024 * 1024) { ws.close(1013, '终端初始画面过大'); return; }
            early.push(data);
          } else send(data);
        });
        const unwatch = () => watchId ? machines.call(machineId, 'terminal.unwatch', { watchId }).catch(() => {}) : Promise.resolve();
        ws.on('close', () => { done = true; void off(); void unwatch(); });
        void machines.call(machineId, 'terminal.watch', { paneId }).then(async result => {
          if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.watchId !== 'string') throw new Error('无效的终端订阅');
          watchId = result.watchId;
          if (done) { await unwatch(); return; }
          for (const data of early) send(data);
          early.length = 0;
        }).catch(() => { if (!done) ws.close(1011, '无法观察终端'); });
        const disconnect = app.events.subscribe(event => {
          if (event.type === 'machines.changed' && !machines.list().some(machine => machine.id === machineId && machine.online)) ws.close(1012, '执行机断线');
        });
        ws.once('close', () => { void disconnect(); });
        return;
      }
      let registered = false;
      ws.on('message', raw => {
        try {
          const message = JSON.parse(raw.toString()) as NodeMessage;
          if (message.type === 'hello') {
            if (registered) throw new Error('重复执行机注册');
            machines.attach(ws, message); registered = true;
          } else {
            if (!registered) throw new Error('请先注册执行机');
            machines.handle(ws, message);
          }
        } catch { ws.close(1008, '无效的执行机消息'); }
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { await Promise.allSettled([sessionAnalysis.close(), personalAi.close(), personal.close(), registrations.close(), feishu.close(), bots.close()]); machines.close(); await app.close(); throw error; }
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`;
  void feishu.start().catch(() => {}); // Failure is visible in connection settings, never blocks Web startup.
  void bots.start().catch(() => {});
  personal.start();
  let closing: Promise<void> | undefined;
  return { app, server, url, machines, feishu, bots, registrations, personal, close() {
    if (closing) return closing;
    closing = (async () => {
      // Cancel read-only model work before waiting for collectors that may be
      // awaiting it. Otherwise an in-flight triage turn deadlocks shutdown.
      const readonlyStop = Promise.allSettled([sessionAnalysis.close(), app.supervisorRuntime.close({ abort: true }), app.inboxClassifier.close(), app.inboxHandlingRuntime.close()]);
      await personal.close();
      await personalAi.close();
      await registrations.close();
      await feishu.close();
      await bots.close();
      machines.close();
      const httpClosed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const ws of sockets.clients) ws.terminate();
      // Node close handlers persist offline state. Drain them before closing SQLite.
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await httpClosed;
      await app.close();
      const readonlyFailure = (await readonlyStop).find(result => result.status === 'rejected');
      if (readonlyFailure?.status === 'rejected') throw readonlyFailure.reason;
    })();
    return closing;
  } };
}
