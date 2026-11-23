import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAttention } from '../packages/core/src/attention.ts';
import type { Approval, InboxItem, MailboxEntry } from '../packages/protocol/src/index.ts';

const stamp = '2026-11-16T10:00:00Z';
const approval = (extra: Partial<Approval> = {}): Approval => ({ id: 'approve', title: '运行测试', details: '运行项目测试', version: 2, kind: 'dispatch', params: {}, status: 'pending', createdAt: stamp, updatedAt: stamp, ...extra });
const question = (extra = {}) => ({ id: 'question', title: '选择测试环境', body: '用哪个环境？', version: 3, kind: 'question', handler: 'user', status: 'open', createdAt: stamp, ...extra });
const inbox = (extra: Partial<InboxItem> = {}): InboxItem => ({ id: 'message', title: '确认评审时间', text: '请安排评审', source: 'feishu:account:profile', thread: 'thread', last: 'last', reason: '需要安排', tier: 'action', version: 4, updatedAt: stamp, ...extra });

test('attention only merges pending approvals, human-owned questions and unarchived actionable Feishu messages', () => {
  const input = { approvals: [approval(), approval({ id: 'running', status: 'running' }), approval({ id: 'unknown', status: 'unknown' })],
    interactions: [question(), question({ id: 'automatic', handler: 'main_agent', userNotifiedAt: stamp }), question({ id: 'closed', status: 'answered' })],
    inbox: [inbox(), inbox({ id: 'archived', archivedAt: stamp }), inbox({ id: 'info', tier: 'fyi' }), inbox({ id: 'other', source: 'other' })] };
  const before = structuredClone(input);
  const items = collectAttention(input);
  assert.deepEqual(items.map(item => item.type).sort(), ['approval', 'inbox', 'interaction']);
  assert.deepEqual(input, before);
  assert.deepEqual(collectAttention(), []);
});

test('action descriptions use existing versioned endpoints and never add undo or duplicate todo creation', () => {
  const items = collectAttention({ approvals: [approval({ id: 'a/b' })], interactions: [question()], inbox: [inbox(), inbox({ id: 'linked', todoId: 'existing' })] });
  assert.deepEqual(items.find(item => item.type === 'approval')?.actions[0], { label: '批准', method: 'POST', path: '/approvals/a%2Fb/approve', body: { version: 2 }, highRisk: false });
  assert.deepEqual(items.find(item => item.type === 'interaction')?.actions[0], { label: '回答', method: 'POST', path: '/interactions/question/answer', body: { version: 3 }, requiresText: true, highRisk: false });
  assert.deepEqual(items.find(item => item.id === 'inbox:message')?.actions.map(action => action.path), ['/inbox/message/confirm', '/inbox/message/archive']);
  assert.deepEqual(items.find(item => item.id === 'inbox:linked')?.actions.map(action => action.label), ['忽略']);
  assert.ok(items.every(item => item.actions.every(action => action.method === 'POST' && !action.path.includes('undo'))));
});

test('projection enriches project names without adding mailbox duplicates, flags destructive operations', () => {
  const items = collectAttention({ approvals: [approval({ params: { projectId: 'p', model: 'fixture-a', command: 'rm -rf /tmp/example' } })],
    projects: [{ id: 'p', name: '测试项目', description: '', createdAt: stamp, updatedAt: stamp }],
    interactions: [question({ id: 'permission', kind: 'permission' })] });
  assert.equal(items[0]?.projectName, '测试项目');
  assert.match(items[0]!.detail, /执行命令：rm -rf \/tmp\/example/);
  assert.match(items[0]!.detail, /指定模型：fixture-a/);
  assert.doesNotMatch(items[0]!.detail, /projectId/);
  assert.ok(items.every(item => item.highRisk));
  assert.equal(collectAttention({ approvals: [approval({ kind: 'plugin:example.write' })] })[0]?.highRisk, true);
});


test('robot inbox/outbox use the same attention flow without implicit scope or duplicate sources', () => {
 const mail:MailboxEntry={id:'mail',version:1,direction:'inbox',scope:{kind:'unmarked'},botId:'b',eventKey:'e',title:'机器人消息',text:'请处理',requiresConfirmation:true,status:'pending',createdAt:stamp,updatedAt:stamp};
 const rows=collectAttention({mailboxes:[mail,{...mail,id:'project',scope:{kind:'project',projectId:'p'}},{...mail,id:'sent',status:'completed'},{...mail,id:'out',direction:'outbox',scope:{kind:'global'}}],bots:[{id:'b',name:'主 Agent 机器人'}]});
 assert.equal(rows.length,3);assert.equal(rows.find(row=>row.id==='mailbox:mail')?.route?.href,'#channels/advanced');
 assert.deepEqual(rows.find(row=>row.id==='mailbox:mail')?.actions.map(action=>action.label),['拒绝']);
 assert.equal(rows.find(row=>row.id==='mailbox:project')?.actions[0]?.path,'/mailboxes/project/confirm');
 assert.equal(rows.find(row=>row.id==='mailbox:out')?.type,'approval');
 assert.equal(rows[0]?.source,'飞书 · 主 Agent 机器人');
 assert.equal(collectAttention({inbox:[inbox()],mailboxes:[{...mail,resultId:'message'}]}).length,1);
});

test('待启动的任务计划进入待处理，启动与拒绝都带版本；已处理的计划不再出现', () => {
  const plan = (status: string) => ({ id: 'p/1', title: '发布 v0.2', version: 3, status, createdAt: '2026-11-16T00:00:00.000Z',
    tasks: [{ prompt: '跑测试', doneWhen: '全部通过', expectMinutes: 10, model: 'fixture-first', projectId: 'proj' }, { prompt: '打包', doneWhen: '产物存在', expectMinutes: 5 }] });
  const [item] = collectAttention({ plans: [plan('pending') as never], projects: [{ id: 'proj', name: '官网', description: '', createdAt: '', updatedAt: '' }] });
  assert.equal(item?.type, 'plan');
  assert.equal(item?.projectName, '官网');
  assert.match(item?.context ?? '', /2 项任务/);
  assert.match(item?.detail ?? '', /指定模型：fixture-first[^]*2\. 打包/);
  assert.match(item?.detail ?? '', /完成标准：全部通过/);
  assert.deepEqual(item?.actions.map(action => [action.label, action.path, action.body]), [['开始执行', '/plans/p%2F1/start', { version: 3 }], ['拒绝', '/plans/p%2F1/reject', { version: 3 }]]);
  for (const status of ['running', 'started', 'rejected', 'partial', 'unknown']) assert.deepEqual(collectAttention({ plans: [plan(status) as never] }), [], status);
});
