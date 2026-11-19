import { createProjectFolders } from '../../../packages/core/src/project-folders.ts';
import { policyPresets, applyPolicyPreset, policyRuleHits } from '../../../packages/core/src/policy-presets.ts';
import { todoSections, todoDecisionIds } from '../../../packages/core/src/todo-sections.ts';
import { createAgentArtifacts } from './agent-artifacts.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { readFile, stat } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { createWorkbench, InputError, requiredText } from '../../../packages/core/src/workbench.ts';
import { createMachineHub } from '../../../packages/core/src/machines.ts';
import type { PersonalProvider } from '../../../plugins/feishu-personal.ts';
import type { FeishuBotFactory } from './feishu-bots.ts';
import type { FeishuRegistrationInput } from './feishu-registration.ts';
import type { FeishuRegistrationProvider } from '../../../plugins/feishu-registration.ts';
import { createFeishuGateway } from './feishu-gateway.ts';
import { validateBotScope } from '../../../packages/core/src/bot-scopes.ts';
import type { AppConfig, FeishuBotInput, JsonObject, NodeMessage } from '../../../packages/protocol/src/index.ts';

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new InputError('请求内容过大', 413);
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new InputError('请求必须是有效JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('请求必须是JSON对象');
  return value as Record<string, unknown>;
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
/** One HTTP server serves both the product and its API; no second frontend process is needed. */
export async function startServer(config: AppConfig, dependencies: { botFactory?: FeishuBotFactory; registrationProvider?: FeishuRegistrationProvider; personalProvider?: PersonalProvider } = {}) {
  const app = await createWorkbench(config);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const machines = createMachineHub(app);
  app.setMachineClient(machines);
  const projectFolders = createProjectFolders(machines);
  const artifacts = createAgentArtifacts({ store: app.store, events: app.events, machines: () => machines });
  const gateway = createFeishuGateway(app, config, dependencies);
  const { feishu, personal, personalView, bots, registrations, registrationView, proposeMail } = gateway;
  const authorized = (req: IncomingMessage, url: URL) => !config.token || req.headers.authorization === `Bearer ${config.token}` || url.searchParams.get('token') === config.token;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (path === '/api/health' || path === '/api/v1/health') return json(res, 200, { ok: true, version: '0.1.0' });
      if (path.startsWith('/api/')) {
        if (!authorized(req, url)) throw new InputError('访问令牌无效', 401);
        const method = req.method;
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
        if(path==='/api/v1/outbox'&&method==='GET')return json(res,200,app.background.outbox.list().slice(0,200));
        if(path==='/api/v1/outbox'&&method==='POST'){const{owner,...input}=await body(req);return json(res,201,app.background.outbox.enqueue(typeof owner==='string'?owner:'user',input as unknown as import('../../../packages/plugin-sdk/src/index.ts').OutboxInput));}
        if(path==='/api/v1/outbox/grants'&&method==='PUT'){const input=await body(req);app.background.outbox.grant(requiredText(input.owner,'发布者'),requiredText(input.channel,'渠道'),input.enabled as boolean);return json(res,200,app.background.outbox.grants());}
        const outgoing=path.match(/^\/api\/v1\/outbox\/([^/]+)\/(cancel|verify)$/);
        if(outgoing&&method==='POST'){const input=await body(req);if(!Number.isSafeInteger(input.version))throw new InputError('请提供发件版本');if(outgoing[2]==='cancel')return json(res,200,app.background.outbox.cancel(outgoing[1],input.version as number));if(typeof input.delivered!=='boolean')throw new InputError('请明确核实是否送达');return json(res,200,app.background.outbox.verify(outgoing[1],input.delivered,input.version as number));}
        if(path==='/api/v1/eventbox/cleanup-plugin'&&method==='POST'){const input=await body(req);const owner=requiredText(input.owner,'插件');if(input.confirm!==true||owner==='core'||!app.plugins.list().some(p=>p.id===owner&&p.status==='disabled'))throw new InputError('请先停用插件，并显式确认清理',409);app.background.cleanupOwner(owner);return json(res,200,{ok:true});}
        if(path==='/api/v1/eventbox/model-grants'&&method==='PUT'){const input=await body(req);app.background.modelGrant(requiredText(input.owner,'插件'),input.enabled as boolean,input.dailyLimit as number);return json(res,200,app.background.modelGrants());}
        if(path==='/api/v1/supervisor/resume'&&method==='POST'){await app.supervisorAgent.resume();return json(res,200,app.supervisorAgent.settings());}
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
        if (path === '/api/v1/interactions' && method === 'POST') return json(res, 201, app.interactions.open(await body(req) as unknown as Parameters<typeof app.interactions.open>[0]));
        const card = path.match(/^\/api\/v1\/interactions\/([^/]+)\/(answer|withdraw)$/);
        if (card && method === 'POST') {
          const input = await body(req);
          return json(res, 200, card[2] === 'answer' ? await app.interactions.answer(card[1], input.version as number, requiredText(input.text, '回答')) : app.interactions.withdraw(card[1], input.version as number));
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
        if (path === '/api/v1/agents/sessions/resume' && method === 'POST') return json(res, 201, await app.agentSessions.proposeResume(await body(req)));
        if (path === '/api/v1/agents/sessions/resume-request' && method === 'GET') return json(res, 200, { approval: app.agentSessions.request(requiredText(url.searchParams.get('machineId'), '电脑'), requiredText(url.searchParams.get('key'), '请求标识')) });
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
        if (path === '/api/v1/feishu/bots' && method === 'GET') return json(res, 200, bots.list());
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
          if ([...url.searchParams.keys()].some(key=>!['projectId','todoId'].includes(key))) throw new InputError('周期工作查询参数无效');
          return json(res,200,app.scheduledWork.list(Object.fromEntries(url.searchParams)));
        }
        if (path === '/api/v1/scheduled-work' && method === 'POST') return json(res,201,app.scheduledWork.propose(await body(req)));
        const cancelScheduled=path.match(/^\/api\/v1\/scheduled-work\/([^/]+)\/cancel$/);
        if(cancelScheduled&&method==='POST') {
          const input=await body(req);if(Object.keys(input).some(key=>key!=='version'))throw new InputError('周期工作取消参数无效');
          return json(res,200,app.scheduledWork.cancel({id:decodeURIComponent(cancelScheduled[1]!),version:input.version}));
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
        const handling = path.match(/^\/api\/v1\/inbox-handling\/(personal|mailbox)\/([^/]+)(?:\/(messages|suggestions)(?:\/([^/]+)\/confirm)?)?$/);
        if(handling){
          const ref={kind:handling[1] as 'personal'|'mailbox',id:decodeURIComponent(handling[2]!)};
          if(method==='GET'&&!handling[3])return json(res,200,app.inboxHandling.read(ref));
          if(method==='POST'){
            const input=await body(req);
            if(handling[3]==='messages'&&!handling[4])return json(res,202,app.inboxHandling.post(ref,input as unknown as Parameters<typeof app.inboxHandling.post>[1]));
            if(handling[3]==='suggestions'){
              if(handling[4]){
                if(Object.keys(input).some(key=>!['sourceVersion','version'].includes(key)))throw new InputError('建议确认参数无效');
                return json(res,201,app.inboxHandling.confirm(ref,{sourceVersion:input.sourceVersion as number,version:input.version as number,id:decodeURIComponent(handling[4])}));
              }
              return json(res,input.id?200:201,app.inboxHandling.save(ref,input as unknown as Parameters<typeof app.inboxHandling.save>[1]));
            }
          }
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
        const discoveredProjects = path.match(/^\/api\/v1\/machines\/([^/]+)\/projects$/);
        if (discoveredProjects && method === 'GET') return json(res, 200, await projectFolders.discover(decodeURIComponent(discoveredProjects[1]), url.searchParams.getAll('root')));
        const diagnose = path.match(/^\/api\/v1\/machines\/([^/]+)\/diagnostics$/);
        if (diagnose && method === 'POST') {
          const input = await body(req);
          if (Object.keys(input).some(key => key !== 'executorId') || !['codex', 'claude-code'].includes(input.executorId as string)) throw new InputError('执行者诊断参数无效');
          return json(res, 200, await machines.call(decodeURIComponent(diagnose[1]!), 'executor.diagnostics', { executorId: input.executorId as string }, { timeoutMs: 25000 }));
        }
        const recovery = path.match(/^\/api\/v1\/machines\/([^/]+)\/recovery$/);
        if (recovery && method === 'GET') {
          if ([...url.searchParams.keys()].some(key => key !== 'sessionId')) throw new InputError('终端恢复查询参数无效');
          const sessionId = url.searchParams.get('sessionId');
          return json(res, 200, await machines.call(decodeURIComponent(recovery[1]!), 'executor.recovery', sessionId ? { sessionId } : {}));
        }
        const machine = path.match(/^\/api\/v1\/machines\/([^/]+)\/(sessions|call)$/);
        if (machine && method === 'GET' && machine[2] === 'sessions') return json(res, 200, await machines.call(decodeURIComponent(machine[1]), 'executor.sessions', {}));
        if (machine && method === 'POST' && machine[2] === 'call') {
          const input = await body(req);
          if (!app.plugins.list().some(plugin => plugin.id === 'terminal-host' && plugin.status === 'active')) throw new InputError('请启用终端宿主插件', 503);
          const rpc = requiredText(input.method, '执行机方法');
          if (!rpc.startsWith('executor.') && !rpc.startsWith('terminal.')) throw new InputError('不支持的执行机方法');
          if (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)) throw new InputError('params必须是对象');
          return json(res, 200, await machines.call(decodeURIComponent(machine[1]), rpc, input.params as JsonObject));
        }
        const waitingReply = path.match(/^\/api\/v1\/todos\/([^/]+)\/waiting-reply(\/sources)?$/);
        if (waitingReply && method === 'GET') return json(res, 200, waitingReply[2] ? app.waitingReplies.sources(decodeURIComponent(waitingReply[1]!), url.searchParams.get('query') ?? '') : app.waitingReplies.get(decodeURIComponent(waitingReply[1]!)));
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
        if (path === '/api/v1/brief' && method === 'GET') {
          app.supervision.tick();
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
        const delegate = path.match(/^\/api\/v1\/todos\/([^/]+)\/delegate$/);
        if (delegate && method === 'POST') return json(res, 202, await app.delegateTodo(delegate[1]));
        if (path === '/api/v1/todos' && method === 'GET') return json(res, 200, url.searchParams.get('view') === 'sections' ? todoSections(app.todos(), new Date(), todoDecisionIds(app.store)) : app.todos());
        if (path === '/api/v1/todos' && method === 'POST') return json(res, 201, app.createTodo(await body(req)));
        const todo = path.match(/^\/api\/v1\/todos\/([^/]+)$/);
        if (todo && method === 'PATCH') return json(res, 200, app.updateTodo(todo[1], await body(req)));
        if (path === '/api/v1/projects' && method === 'GET') return json(res, 200, app.projects.list());
        if (path === '/api/v1/projects' && method === 'POST') return json(res, 201, await app.createProject(await body(req)));
        const projectFollowUp = path.match(/^\/api\/v1\/projects\/([^/]+)\/follow-up$/);
        if (projectFollowUp && method === 'PUT') {
          const input = await body(req);
          if (!('followUp' in input) || Object.keys(input).some(key => !['followUp', 'expectedUpdatedAt', 'confirmed'].includes(key))) throw new InputError('项目跟进参数无效');
          return json(res, 200, app.updateProject(decodeURIComponent(projectFollowUp[1]!), input));
        }
        const projectWorkspace=path.match(/^\/api\/v1\/projects\/([^/]+)\/(workspace|messages|memory)$/);
        const code = path.match(/^\/api\/v1\/projects\/([^/]+)\/code$/);
        if (code && method === 'GET') {
          const project = app.projects.list().find(p => p.id === decodeURIComponent(code[1]));
          if (!project || project.archivedAt) throw new InputError('项目不存在', 404);
          if (!project.workspace) throw new InputError('项目尚未绑定电脑目录', 409);
          const machine = machines.list().find(m => m.id === project.workspace!.machineId);
          if (!machine?.online) throw new InputError('绑定电脑已离线', 503);
          if (!machine.capabilities.includes('workspace.code')) throw new InputError('请升级绑定电脑的代理以浏览代码', 409);
          const kind = url.searchParams.get('kind') ?? 'tree';
          if (!['tree','file','diff'].includes(kind)) throw new InputError('浏览类型无效');
          return json(res, 200, await machines.call(machine.id, 'workspace.code', { cwd: project.workspace.cwd, kind, path: url.searchParams.get('path') ?? '' }));
        }
        if(projectWorkspace){const id=decodeURIComponent(projectWorkspace[1]);
          if(projectWorkspace[2]==='workspace'&&method==='GET')return json(res,200,await app.projectWorkspace.view(id));
          if(projectWorkspace[2]==='messages'&&method==='POST')return json(res,202,await app.projectWorkspace.post(id,requiredText((await body(req)).text,'目标')));
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
        if (path === '/api/v1/knowledge/index' && method === 'GET') return json(res, 200, await app.knowledgeCurator.index());
        if (path === '/api/v1/knowledge/sources' && method === 'POST') return json(res, 201, app.knowledgeCurator.addSource(await body(req)));
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
          const entry = await app.knowledge().put({ id: input.id as string | undefined, layer, title: requiredText(input.title, '标题'), content: requiredText(input.content, '内容'), projectId });
          await app.knowledgeCurator.rebuildIndex();
          app.events.publish('knowledge.changed', { id: entry.id }); return json(res, 201, entry);
        }
        const knowledge = path.match(/^\/api\/v1\/knowledge\/([^/]+)$/);
        if (knowledge && method === 'PATCH') {
          const id = decodeURIComponent(knowledge[1]);
          const previous = (await app.knowledge().list()).find(entry => entry.id === id);
          if (!previous) throw new InputError('知识不存在', 404);
          const input = await body(req);
          const layer = input.layer ?? previous.layer;
          if (!['personal', 'global', 'project'].includes(String(layer))) throw new InputError('知识层级无效');
          const projectId = layer === 'project' ? requiredText(input.projectId ?? previous.projectId, '项目') : undefined;
          if (input.title !== undefined && typeof input.title !== 'string') throw new InputError('标题必须为文本');
          if (input.content !== undefined && typeof input.content !== 'string') throw new InputError('内容必须为文本');
          const entry = await app.knowledge().put({ id, layer: layer as 'personal' | 'global' | 'project', title: input.title === undefined ? previous.title : requiredText(input.title, '标题'), content: input.content === undefined ? previous.content : requiredText(input.content, '内容'), ...(projectId ? { projectId } : {}) });
          await app.knowledgeCurator.rebuildIndex(); app.events.publish('knowledge.changed', { id }); return json(res, 200, entry);
        }
        if (knowledge && method === 'DELETE') {
          const removed = await app.knowledge().remove(knowledge[1]);
          if (!removed) throw new InputError('知识不存在', 404);
          await app.knowledgeCurator.rebuildIndex();
          app.events.publish('knowledge.changed', { id: knowledge[1] }); return json(res, 200, { removed });
        }
        if (path === '/api/v1/messages' && method === 'POST') {
          const input = await body(req);
          if (typeof input.text !== 'string' || !input.text.trim()) throw new InputError('消息不能为空');
          return json(res, 202, await app.agent.post(input.text, 'main', typeof input.projectId === 'string' && input.projectId.trim() ? { projectId: input.projectId.trim() } : undefined));
        }
        if (path === '/api/v1/runs' && method === 'POST') return json(res, 202, app.dispatch(await body(req), typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined));
        const observations = path.match(/^\/api\/v1\/runs\/([^/]+)\/observations$/);
        if (observations && method === 'GET') return json(res, 200, app.runObservations(decodeURIComponent(observations[1]!)));
        const cancel = path.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/);
        if (cancel && method === 'POST') return json(res, 202, await app.cancel(cancel[1]));
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
      if (path === '/assets/boot/intro.mp4' || path === '/assets/boot/intro-avc.mp4') {
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
      if (path === '/vendor/xterm.js' || path === '/vendor/xterm.css') {
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
      json(res, status, { error: error instanceof Error ? error.message : '请求失败' });
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!authorized(req, url) || !['/api/v1/events', '/api/v1/node', '/api/v1/terminal'].includes(url.pathname) || (url.pathname.endsWith('/node') && !config.token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
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
  } catch (error) { await Promise.allSettled([personal.close(), registrations.close(), feishu.close(), bots.close()]); machines.close(); await app.close(); throw error; }
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
      const readonlyStop = Promise.allSettled([app.supervisorRuntime.close({ abort: true }), app.inboxClassifier.close(), app.inboxHandlingRuntime.close()]);
      await personal.close();
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
