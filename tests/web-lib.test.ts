// 前端纯函数：提醒点、路由、作用说明文案、时间文案。这些模块不依赖 DOM，可直接在 Node 里测试。
import test from 'node:test';
import assert from 'node:assert/strict';

const lib = (path: string) => import(new URL(`../apps/web/js/${path}`, import.meta.url).href);

test('提醒点：为 0 不出现；红点只表示需要你行动', async () => {
  const { computeAlerts } = await lib('lib/alerts.js');
  const base = { agent: { available: true }, setup: { agent: true, channel: 'done' }, problems: [], todos: [], runs: [] };
  assert.deepEqual(computeAlerts(null, []), { chat: null, inbox: null, outbox: null, agent: null, projects: null, memory: null, channels: null });
  assert.deepEqual(computeAlerts(base, []), { chat: null, inbox: null, outbox: null, agent: null, projects: null, memory: null, channels: null });
  assert.deepEqual(computeAlerts(base, [{}, {}, {}]).chat, { count: 3 });
});

test('提醒点：还没设置（没有电脑、没连飞书）不报警，原本可用现在坏了才报警', async () => {
  const { computeAlerts } = await lib('lib/alerts.js');
  const problems = [{ area: 'agent' }, { area: 'channel' }];
  const fresh = computeAlerts({ agent: { available: true }, setup: { agent: false, channel: 'todo' }, problems, todos: [], runs: [] }, []);
  assert.equal(fresh.agent, null);
  assert.equal(fresh.channels, null);
  const broken = computeAlerts({ agent: { available: true }, setup: { agent: true, channel: 'done' }, problems, todos: [], runs: [] }, []);
  assert.deepEqual(broken.agent, { dot: true });
  assert.deepEqual(broken.channels, { dot: true });
  assert.deepEqual(computeAlerts({ agent: { available: false }, setup: {}, problems: [], todos: [], runs: [] }, []).agent, { dot: true });
});

test('提醒点：逾期待办和未查看的失败执行出现在项目；查看后失败不再计入', async () => {
  const { computeAlerts } = await lib('lib/alerts.js');
  const snapshot = { agent: { available: true }, setup: {}, problems: [], todos: [], runs: [{ id: 'r1', status: 'failed' }] };
  assert.deepEqual(computeAlerts(snapshot, []).projects, { dot: true });
  assert.equal(computeAlerts(snapshot, [], { seenRunIds: ['r1'] }).projects, null);
  const overdue = { ...snapshot, runs: [], todos: [{ id: 't', dueAt: '2026-01-01T00:00:00Z' }] };
  assert.deepEqual(computeAlerts(overdue, []).projects, { dot: true });
  assert.equal(computeAlerts({ ...overdue, todos: [{ id: 't', dueAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z' }] }, []).projects, null);
  assert.equal(computeAlerts({ ...snapshot, runs: [{ id: 'u', status: 'unknown' }] }, [], { seenRunIds: [] }).projects?.dot, true);
});

test('路由：旧地址重定向到新位置，未知地址回到对话', async () => {
  const { parseRoute } = await lib('lib/router.js');
  const cases: Record<string, [string, string[]]> = {
    '': ['chat', []], '#overview': ['chat', []], '#inbox': ['inbox', []], '#outbox': ['outbox', []], '#approvals': ['chat', []], '#interactions': ['chat', []],
    '#todos': ['projects', ['all', 'todos']], '#runs': ['projects', ['all', 'runs']], '#plans': ['projects', ['all', 'runs']], '#terminals': ['projects', ['all', 'runs']],
    '#knowledge': ['memory', []], '#supervision': ['agent', ['follow-up']], '#policies': ['agent', ['rules']], '#settings': ['agent', []],
    '#projects/abc/runs/r1': ['projects', ['abc', 'runs', 'r1']], '#nope': ['chat', []],
  };
  for (const [hash, [page, parts]] of Object.entries(cases)) {
    const route = parseRoute(hash);
    assert.equal(route.page, page, hash);
    assert.deepEqual(route.parts, parts, hash);
  }
  assert.equal(parseRoute('#todos').canonical, '#projects/all/todos');
  assert.equal(parseRoute('#memory?entry=a%20b').query.get('entry'), 'a b');
});

test('作用说明：每条都有一句话、说明和例子，一句话不超过 12 个汉字', async () => {
  const { hints } = await lib('copy/hints.js');
  for (const [key, copy] of Object.entries(hints) as [string, { tag: string; detail: string; example: string }][]) {
    assert.ok((copy.tag.match(/\p{Script=Han}/gu) ?? []).length <= 12, `${key}: ${copy.tag}`);
    assert.ok(copy.detail.includes('。'), key);
    assert.ok(copy.example, key);
  }
  for (const page of ['chat', 'agent', 'projects', 'memory', 'channels']) assert.ok(hints[`nav.${page}`], page);
  for (const key of ['agent.model', 'agent.executors', 'agent.rules', 'agent.followup', 'project.todos', 'project.runs', 'project.memory', 'project.followup', 'memory.personal', 'memory.global', 'memory.project', 'channel.bot', 'channel.collect']) assert.ok(hints[key], key);
});

test('用词：系统文案不出现内部名词', async () => {
  const { systemText, forbiddenTerms } = await lib('copy/terms.js');
  const { hints } = await lib('copy/hints.js');
  const visible = Object.values(hints).flatMap((copy: any) => [copy.tag, copy.detail, copy.example]).join('\n');
  for (const term of ['Herdr', 'SSH', 'WebSocket', '终端宿主', '制品', '交互卡', '分层策略']) assert.ok(!visible.includes(term), term);
  assert.ok(forbiddenTerms.includes('Herdr'));
  assert.equal(systemText('终端宿主不可用，执行机离线'), '终端不可用，电脑离线');
  assert.equal(systemText('CLI 未登录'), '命令行 未登录');
});

test('时间与状态文案', async () => {
  const { timeAgo, duration, runStatus, isRunActive, isRunProblem } = await lib('lib/format.js');
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.equal(timeAgo('2026-11-16T11:59:50Z', now), '刚刚');
  assert.equal(timeAgo('2026-11-16T11:30:00Z', now), '30 分钟前');
  assert.equal(timeAgo('2026-11-16T07:00:00Z', now), '5 小时前');
  assert.equal(timeAgo('2026-11-14T12:00:00Z', now), '2 天前');
  assert.equal(timeAgo('', now), '');
  assert.equal(duration('2026-11-16T10:30:00Z', '2026-11-16T12:00:00Z'), '1 小时 30 分钟');
  assert.equal(runStatus.completed.text, '已结束', '“已结束”不写成“成功”或“完成”');
  assert.equal(runStatus.unknown.tone, 'danger');
  assert.ok(isRunActive({ status: 'running' }) && !isRunActive({ status: 'completed' }));
  assert.ok(isRunProblem({ status: 'failed' }) && isRunProblem({ status: 'unknown' }) && !isRunProblem({ status: 'cancelled' }));
});
