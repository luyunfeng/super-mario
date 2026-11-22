import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message, Run, Snapshot, Todo, TodoHistory } from '../packages/protocol/src/index.ts';
import type { Plan } from '../packages/core/src/plans.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import type { PolicyConfig } from '../packages/core/src/policies.ts';
import type { SupervisorReview } from '../packages/core/src/supervisor-agent.ts';

const task = { prompt: '本地演示检查', executorId: 'demo', doneWhen: '用户核对演示输出', expectMinutes: 1 };
async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-governance-http-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, demo: true, token: 'local-governance-test' };
  let server = await startServer(config);
  t.after(async () => { try { await server.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  async function request(path: string, method = 'GET', body?: unknown) {
    return fetch(`${server.url}/api/v1${path}`, { method,
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function json<T>(path: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
    const response = await request(path, method, body);
    const value = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`);
    return value as T;
  }
  return { get app() { return server.app; }, request, json,
    state: () => json<Snapshot>('/state'),
    async restart() { await server.close(); server = await startServer(config); } };
}
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await delay(10);
  }
  assert.fail('本地治理流程等待状态超时');
}

test('HTTP plans validate all 1–8 tasks before writes; concurrent start dispatches each once without completing todo', async t => {
  const f = await fixture(t);
  const initial = await f.state();
  const invalid = [[], Array(9).fill(task), [task, { ...task, doneWhen: '' }],
    [task, { ...task, expectMinutes: 0 }], [task, { ...task, expectMinutes: -1 }],
    [task, { ...task, expectMinutes: undefined }], [task, { ...task, doneWhen: undefined }],
    [task, { ...task, expectMinutes: '1' }], [task, { ...task, executionMode: 'wrong' }]];
  for (const tasks of invalid) await f.json('/plans', 'POST', { title: '无效计划', tasks }, 400);
  assert.deepEqual(await f.json('/plans'), []);
  assert.equal(f.app.store.list('plan-origins').length, 0);
  assert.equal((await f.state()).runs.length, initial.runs.length);
  const todo = await f.json<Todo>('/todos', 'POST', { title: '仍需用户验收' }, 201);
  const plan = await f.json<Plan>('/plans', 'POST', { title: '八项检查', tasks: Array.from({ length: 8 }, (_, index) => ({ ...task, prompt: `本地演示 ${index}`, todoId: todo.id })) }, 201);
  assert.equal(plan.status, 'pending');
  assert.equal(plan.version, 1);
  const acceptedRunStates: string[] = [];
  const off = f.app.events.subscribe(event => {
    if (event.type !== 'plans.changed' || f.app.plans.get(plan.id).status !== 'started') return;
    for (const item of f.app.plans.get(plan.id).tasks) acceptedRunStates.push(f.app.store.get<Run>('runs', item.runId!)!.status);
  });
  t.after(() => { void off(); });
  const responses = await Promise.all(Array.from({ length: 5 }, () => f.request(`/plans/${plan.id}/start`, 'POST', { version: 1 })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409, 409, 409, 409]);
  const started = await responses.find(response => response.status === 200)!.json() as Plan;
  assert.equal(started.status, 'started');
  assert.equal(new Set(started.tasks.map(item => item.runId)).size, 8);
  assert.equal(acceptedRunStates.length, 8);
  assert.ok(acceptedRunStates.every(status => status === 'queued'), 'started is emitted before execution completion');
  const state = await eventually(f.state, state => state.runs.length === 8 && state.runs.every(run => run.status === 'completed'));
  assert.ok(state.runs.every(run => /演示|demo/i.test(run.output)));
  assert.equal(state.todos.find(item => item.id === todo.id)!.completedAt, undefined);
  assert.equal((await f.json<Plan[]>('/plans'))[0].status, 'started');
  await f.json(`/plans/${plan.id}/start`, 'POST', { version: 2 }, 409);
});

test('HTTP plan dispatch inherits persisted origin project/source and preserves explicit task project', async t => {
  const f = await fixture(t);
  for (const id of ['origin-project', 'explicit-project']) { const now = new Date().toISOString(); f.app.store.put('projects', id, { id, name: id, description: '', createdAt: now, updatedAt: now }); }
  const plan = await f.json<Plan>('/plans', 'POST', { title: '来源继承', tasks: [task, { ...task, projectId: 'explicit-project' }] }, 201);
  assert.deepEqual(f.app.store.get('plan-origins', plan.id), {});
  // Demo replies cannot invoke tools. Seed the origin a live main-agent tool would persist;
  // proposal, start, dispatch and run reads still traverse the real HTTP/SQLite services.
  const source: Message = { id: 'origin-message', conversationId: 'main', role: 'user', text: '项目请求', projectId: 'origin-project', createdAt: new Date().toISOString() };
  f.app.store.put('messages', source.id, source);
  f.app.store.put('plan-origins', plan.id, { sourceMessageId: source.id, projectId: source.projectId });
  const started = await f.json<Plan>(`/plans/${plan.id}/start`, 'POST', { version: 1 });
  const state = await f.state();
  const runs = started.tasks.map(item => state.runs.find(run => run.id === item.runId)!);
  assert.deepEqual(runs.map(run => run.projectId), ['origin-project', 'explicit-project']);
  assert.ok(runs.every(run => run.sourceMessageId === source.id));
  assert.deepEqual(f.app.store.get('plan-origins', plan.id), { sourceMessageId: source.id, projectId: 'origin-project' });
});

test('HTTP policies resolve global/project/task overrides; dangerous permissions default to user and malformed inputs return 400', async t => {
  const f = await fixture(t);
  const permission = await f.json<Card>('/interactions', 'POST', { kind: 'permission', title: '删除目录并发布', body: '危险操作必须由用户决定' }, 201);
  assert.equal(permission.handler, 'user');
  assert.equal(permission.mode, 'suggest');
  assert.equal(permission.status, 'open');
  assert.equal(permission.suggestion, undefined);
  const global = { rules: [{ id: 'global', kind: 'question', handler: 'rules', answer: '全局建议' }], escalateAfterMinutes: 10 };
  await f.json('/policies', 'PUT', global);
  await f.json('/policies?projectId=p', 'PUT', { rules: [{ ...global.rules[0], id: 'project', answer: '项目建议' }] });
  f.app.store.put<Run>('runs', 'r', { id:'r',conversationId:'main',executorId:'demo',prompt:'policy fixture',projectId:'p',cwd:'/tmp/policy-project',status:'completed',output:'demo',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString() });
  const scoped = await f.json<PolicyConfig>('/policies?projectId=p&runId=r', 'PUT', { escalateAfterMinutes: 2 });
  assert.equal(scoped.rules[0].id, 'project');
  assert.equal(scoped.escalateAfterMinutes, 2);
  await f.json('/policies?projectId=p&runId=r', 'PUT', { rules: [{ ...global.rules[0], id: 'task', answer: '任务建议' }] });
  for (const [scope, layer, ruleId, suggestion] of [
    [{}, 'global', 'global', '全局建议'], [{ projectId: 'p' }, 'project', 'project', '项目建议'],
    [{ projectId: 'p', runId: 'r' }, 'task', 'task', '任务建议'],
  ] as const) {
    const card = await f.json<Card>('/interactions', 'POST', { kind: 'question', title: '按哪层规则', body: '', ...scope }, 201);
    assert.equal(card.layer, layer);
    assert.equal(card.ruleId, ruleId);
    const cards = await eventually(() => f.json<Card[]>('/interactions'), cards => cards.some(item => item.id === card.id && item.suggestion === suggestion));
    assert.equal(cards.find(item => item.id === card.id)!.status, 'open');
  }
  const derived = await f.json<Card>('/interactions','POST',{kind:'question',title:'由执行事实选策略',body:'',runId:'r',projectId:'forged-project',executorId:'forged-executor',cwd:'/forged-directory'},201);
  assert.equal(derived.projectId,'p'); assert.equal(derived.executorId,'demo'); assert.equal(derived.cwd,'/tmp/policy-project'); assert.equal(derived.ruleId,'task');
  const before = await f.json('/policies');
  for (const patch of [{ unknown: true }, { escalateAfterMinutes: 0 }, { rules: {} },
    { rules: [{ id: 'bad', kind: 'bad', handler: 'user' }] },
    { rules: [{ id: 'bad', kind: 'permission', handler: 'rules', mode: 'auto' }] }]) {
    await f.json('/policies', 'PUT', patch, 400);
  }
  await f.json('/policies?projectId=', 'GET', undefined, 400);
  await f.json('/interactions', 'POST', { kind: 'invalid', title: 'bad', body: '' }, 400);
  await f.json('/interactions', 'POST', { kind: 'question', title: '', body: '' }, 400);
  assert.deepEqual(await f.json('/policies'), before);
});

type SupervisorState = { agent: { available: boolean; mode: string; reason?: string }; reviews: SupervisorReview[]; messages: Message[] };
test('HTTP independent demo supervisor suggests without answering, rejects stale/duplicate user answers and persists governance across restart', async t => {
  const f = await fixture(t);
  const initial = await f.state();
  const card = await f.json<Card>('/interactions', 'POST', { kind: 'question', title: '下一步建议', body: '请核对证据' }, 201);
  assert.equal(card.handler, 'supervisor');
  assert.equal(card.status, 'open');
  const cards = await eventually(() => f.json<Card[]>('/interactions'), cards => cards.some(item => item.id === card.id && !!item.suggestion));
  const suggested = cards.find(item => item.id === card.id)!;
  assert.equal(suggested.status, 'open');
  assert.ok(suggested.version > card.version);
  assert.equal(suggested.answer, undefined);
  assert.match(suggested.suggestion!, /【本地演示】/);
  assert.match(suggested.suggestion!, /固定演示回复，没有调用模型或外部 CLI/);
  const notified=(await f.state()).messages;
  assert.deepEqual(notified.filter(message=>message.origin!=='notification'),initial.messages);
  assert.equal(notified.filter(message=>message.id===`interaction-notice:${card.id}`).length,1);
  await f.json(`/interactions/${card.id}/answer`, 'POST', { version: card.version, text: '过时回答' }, 409);
  const answers = await Promise.all(Array.from({ length: 4 }, () => f.request(`/interactions/${card.id}/answer`, 'POST', { version: suggested.version, text: '用户确认一次' })));
  assert.deepEqual(answers.map(response => response.status).sort(), [200, 409, 409, 409]);
  const answered = await answers.find(response => response.status === 200)!.json() as Card;
  assert.equal(answered.answeredBy, 'user');
  assert.equal(answered.delivery, 'confirmed');
  assert.equal(answered.status, 'answered');
  const main = (await f.state()).messages;
  assert.equal(main.filter(message => message.id===`interaction-answer:${card.id}`).length, 1);
  assert.equal(main.filter(message => message.role==='user' && message.text.includes('用户已回答交互卡片')).length, 0);
  assert.ok(main.every(message => message.conversationId === 'main'));
  await f.json('/policies', 'PUT', { escalateAfterMinutes: 7, rules: [{ id: 'saved', kind: 'permission', handler: 'user' }] });
  const policy = await f.json('/policies');
  const plan = await f.json<Plan>('/plans', 'POST', { title: '持久化检查', tasks: [task] }, 201);
  const started = await f.json<Plan>(`/plans/${plan.id}/start`, 'POST', { version: 1 });
  await eventually(f.state, state => state.runs.some(run => run.id === started.tasks[0].runId && run.status === 'completed'));
  // Executor result notifications belong in main; compare isolation only after those settle.
  const mainAfterRun = (await f.state()).messages;
  const review = await f.json<SupervisorReview>('/supervisor/flush', 'POST', {});
  assert.equal(review.status, 'suggestion');
  assert.ok(review.runIds.includes(started.tasks[0].runId!));
  assert.ok(review.signalIds.length > 0);
  assert.match(review.text, /【本地演示】.*|固定演示回复/);
  const supervisor = await f.json<SupervisorState>('/supervisor');
  assert.equal(supervisor.agent.mode, 'demo');
  assert.equal(supervisor.agent.available, true);
  assert.match(supervisor.agent.reason!, /固定回复/);
  assert.ok(supervisor.messages.length >= 4);
  assert.ok(supervisor.messages.every(message => message.conversationId === 'supervisor'));
  assert.ok(supervisor.messages.some(message => message.role === 'user' && message.text.includes('独立后台督办 Agent')));
  const reviewCard = (await f.json<Card[]>('/interactions')).find(item => item.kind === 'review' && item.body === review.text)!;
  assert.ok(reviewCard);
  assert.equal(reviewCard.status, 'open');
  assert.equal(reviewCard.handler, 'user');
  const withReview=(await f.state()).messages;
  assert.deepEqual(withReview.filter(message=>message.id!==`interaction-notice:${reviewCard.id}`),mainAfterRun);
  assert.equal(withReview.filter(message=>message.id===`interaction-notice:${reviewCard.id}`).length,1);
  const runIds = (await f.state()).runs.map(run => run.id).sort();
  const keys = f.app.store.list('dispatch-keys');
  await f.restart();
  assert.deepEqual(await f.json('/policies'), policy);
  assert.deepEqual((await f.json<Plan[]>('/plans')).find(item => item.id === plan.id), started);
  assert.deepEqual((await f.json<SupervisorState>('/supervisor')).reviews, [review]);
  assert.deepEqual((await f.json<Card[]>('/interactions')).find(item => item.id === card.id), answered);
  await f.json(`/plans/${plan.id}/start`, 'POST', { version: 1 }, 409);
  await f.json(`/interactions/${card.id}/answer`, 'POST', { version: answered.version, text: '重启后重复' }, 409);
  await f.json('/supervisor/flush', 'POST', {});
  assert.deepEqual((await f.state()).runs.map(run => run.id).sort(), runIds);
  assert.deepEqual(f.app.store.list('dispatch-keys'), keys);
  assert.deepEqual((await f.json<SupervisorState>('/supervisor')).reviews, [review]);
  assert.deepEqual((await f.state()).messages, withReview);
});

test('answering an Agent question resumes the original goal and keeps its channel route', async t => {
  const f=await fixture(t);
  const todo = f.app.createTodo({ title: '核对任务', projectId: 'resume-project' });
  const original=await f.app.agent.post('处理验收目标','main',{projectId:'resume-project', todoId: todo.id});
  f.app.store.put('message.routes',original.id,{channel:'feishu',accountId:'offline-test',target:'owner'});
  const card=await f.json<Card>('/interactions','POST',{kind:'question',title:'用哪个项目',body:'请确认项目',projectId:'resume-project'},201);
  f.app.store.put('interaction-origins',card.id,{inputId:original.id});
  const cards=await eventually(()=>f.json<Card[]>('/interactions'),items=>items.some(item=>item.id===card.id&&item.suggestion));
  const current=cards.find(item=>item.id===card.id)!;
  await f.json(`/interactions/${card.id}/answer`,'POST',{version:current.version,text:'resume-project'});
  const state=await eventually(f.state,s=>s.messages.some(message=>message.role==='user'&&message.text.includes('用户已回答交互卡片')));
  const resumed=state.messages.find(message=>message.role==='user'&&message.text.includes('用户已回答交互卡片'))!;
  const history = await f.json<TodoHistory>('/todos/' + todo.id + '/history');
  assert.equal(history.total, 0);
  assert.equal(history.conversationReceipts?.[0]?.cardId, card.id);
  assert.equal(history.conversationReceipts?.[0]?.continuationAccepted, true);
  assert.equal(history.conversationReceipts?.[0]?.delivery, 'confirmed');
  assert.match(resumed.text,/处理验收目标/);assert.equal(resumed.projectId,'resume-project');
  assert.deepEqual(f.app.store.get('message.routes',resumed.id),{channel:'feishu',accountId:'offline-test',target:'owner',resumed:true});
});

test('task policy overrides wait for explicit plan start and are applied before executor activation', async t => {
  const f=await fixture(t);
  const now=new Date().toISOString();f.app.store.put('projects','policy-project',{id:'policy-project',name:'策略项目',description:'',createdAt:now,updatedAt:now});
  const policy={rules:[{id:'task-only',kind:'question' as const,handler:'user' as const}],userDeadlineMinutes:20};
  const card=await f.json<Plan>('/plans','POST',{title:'单任务覆盖',tasks:[{...task,projectId:'policy-project',policy}]},201);
  assert.equal(card.status,'pending');assert.deepEqual(card.tasks[0].policy,policy);assert.equal((await f.state()).runs.length,0);
  const started=await f.json<Plan>(`/plans/${card.id}/start`,'POST',{version:card.version});
  const runId=started.tasks[0].runId!;
  assert.equal(f.app.policies.decide({kind:'question',runId,projectId:'policy-project'}).handler,'user');
  assert.equal(f.app.policies.decide({kind:'question',runId,projectId:'policy-project'}).ruleId,'task-only');
  await f.json('/plans','POST',{title:'拒绝非法覆盖',tasks:[{...task,policy:{ladder:['supervisor']}}]},400);
});

test('回答项目工作 Agent 的问题后在原项目续聊并沿用原渠道', async t => {
  const f = await fixture(t), project = await f.app.createProject({name:'原会话'});
  const source = await f.app.projectWorkspace.post(project.id,'继续这个项目');
  const route = {channel:'feishu',accountId:'test',target:'original-thread'};
  f.app.store.put('message.routes',source.id,route);
  const q = f.app.interactions.open({kind:'question',title:'选哪一项',body:'请选 A 或 B'},source);
  assert.equal(q.projectId,project.id);
  const answered = await f.app.interactions.answer(q.id,q.version,'选择 A','user_feishu');
  assert.equal(answered.delivery,'confirmed');
  const resumed = f.app.store.list<Message>('messages').find(m=>m.role==='user' && m.text.includes('用户已回答交互卡片'));
  assert.equal(resumed?.conversationId,source.conversationId);
  assert.deepEqual(f.app.store.get('message.routes',resumed!.id),{...route,resumed:true});
});
