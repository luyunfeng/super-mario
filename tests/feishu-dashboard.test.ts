import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeishuDashboard, conversationListDashboard } from '../apps/server/src/feishu-dashboard.ts';
import type { FeishuBotsApp } from '../apps/server/src/feishu-bots.ts';

test('workbench card shows real progress, omits unverified group data and uses credential-free navigation', () => {
  const rows: Record<string, unknown[]> = {
    projects: [{ id: 'p', name: '试点' }], machines: [{online:true},{online:false}], todos: [],
    runs: [{id:'r', projectId:'p', prompt:'验收报表', status:'running', updatedAt:'2026-01-01'}],
    inbox: [
      { source:'feishu:personal', tier:'action', title:'私聊问题', origin:{kind:'direct'} },
      { source:'feishu:personal', tier:'action', title:'未知折叠情况', origin:{kind:'group',personalGroupUserCount:2} },
      { source:'feishu:personal', tier:'action', title:'大群', origin:{kind:'group',personalGroupObserved:true,personalGroupUserCount:51} },
    ],
  };
  const store = { list: (key: string) => rows[key] ?? [] } as FeishuBotsApp['store'];
  const { text, card } = buildFeishuDashboard({store}, 'https://work.example');
  assert.match(text, /1 项进行中/); assert.match(text, /私聊问题/); assert.match(text, /1 \/ 2 台在线/);
  assert.doesNotMatch(text, /未知折叠情况|大群/);
  assert.match(JSON.stringify(card), /#projects\/p\/runs\/r/);
  assert.match(JSON.stringify(card), /#projects\/all\/runs\/new/);
  assert.doesNotMatch(JSON.stringify(buildFeishuDashboard({store},'https://work.example/?token=secret').card), /"url"|secret/);
});

test('主人首页按项目工作会话的公开答复排序，最近三个会话可直接续聊', () => {
  const project = (id:string) => ({id,name:'项目'+id,workspace:{machineId:'m'}});
  const msg = (id:string,at:string,text:string,extra={}) => ({conversationId:'project:'+id+':work',createdAt:at,
    role:'assistant',status:'done',text,...extra});
  const rows:Record<string,unknown[]> = {
    projects:['a','b','c','d'].map(project),machines:[{id:'m',name:'研发机'}],
    messages:[msg('a','1','第一版'),msg('a','2','完成报表 token=private-value'),msg('b','3','刚修复'),
      msg('c','4','内部资料',{readOnly:true}),msg('d','5','记忆草稿',{conversationId:'project:d:memory'}),
      msg('a','6','用户原始输入',{role:'user'}),msg('a','7','通知草稿',{origin:'notification'})],
  };
  const app={store:{list:(k:string)=>rows[k]??[]} as FeishuBotsApp['store'],projectWorkspace:{post:async()=>{throw Error();}}};
  const home=buildFeishuDashboard(app,undefined,{navigation:'grant'});
  assert.ok(home.text.indexOf('项目b') < home.text.indexOf('项目a'));
  assert.match(home.text,/研发机\n完成报表 token=\[凭证已隐藏\]/);
  assert.doesNotMatch(home.text,/private-value|项目d|内部资料|记忆草稿|用户原始输入|通知草稿|第一版/);
  assert.match(JSON.stringify(home.card),/全部项目/);
  assert.match(buildFeishuDashboard(app,undefined,{view:'projects',navigation:'grant'}).text,/项目d/);
});


test('merged owner inbox counts conversations once and keeps other connector messages',()=>{
  const rows:Record<string,unknown[]>={inbox:[
    {id:'a',source:'feishu:personal',tier:'action',title:'不得逐条重复甲',origin:{kind:'direct'}},
    {id:'b',source:'feishu:personal',tier:'action',title:'不得逐条重复乙',origin:{kind:'direct'}},
    {id:'other',source:'plugin:synthetic',tier:'action',title:'其他连接器事项',text:'独立原文'},
  ]};
  const app={store:{list:(k:string)=>rows[k]??[]} as FeishuBotsApp['store'],inboxAssistant:{list:()=>[{
    id:'person',version:1,title:'合并联系人',person:'合成联系人',kind:'direct' as const,messageIds:['a','b'],pendingCount:2,latestAt:'2026-11-20',preview:'',status:'waiting_user' as const,summary:'两条消息一件工作',question:'选择哪个合成环境？',todoIds:[],
  }]}};
  const view=buildFeishuDashboard(app,undefined,{view:'inbox'});
  assert.match(view.text,/合并联系人/);
  assert.match(view.text,/其他连接器事项/);
  assert.doesNotMatch(view.text,/不得逐条重复/);
  assert.match(JSON.stringify(view.card),/待你回复/);
});

test('飞书对话列表按可公开的最近发言排序，并为项目工作对话提供 Web 链接', () => {
  const bot = { conversationId: 'bot-private', id: 'fixture', appId: 'app', revision: 4, chatId: 'owner-chat' };
  const projectId = 'a/b';
  const projectConversation = 'project:' + projectId + ':work';
  const message = (id: string, conversationId: string, day: string, extra = {}) => ({
    id, conversationId, createdAt: '2026-01-' + day + 'T00:00:00Z', role: 'user', text: id, ...extra,
  });
  const routes = new Map([['owner', {}], ['group', { group: {} }], ['relay', { relay: {} }],
    ['other-chat', { target: 'other' }], ['old', { revision: 2 }]]);
  const rows: Record<string, unknown[]> = {
    projects: [{ id: projectId, name: '近期项目' }, { id: 'archived', name: '归档项目', archivedAt: '2026-01-03' }],
    messages: [
      message('owner', bot.conversationId, '01'),
      message('owner-reply', bot.conversationId, '02', { role: 'assistant', status: 'done', replyTo: 'owner', text: '本次私聊答复' }),
      ...['group', 'relay', 'other-chat', 'old', 'unknown-route'].map(id => message(id, bot.conversationId, '24')),
      message('project', projectConversation, '03', { text: '最近的问题 token=fixture-secret', projectId }),
      message('task', projectConversation, '04', { todoId: 'fixture-task' }),
      message('another-project', projectConversation, '05', { projectId: 'other' }),
      message('internal', projectConversation, '06', { readOnly: true }),
      message('notice', projectConversation, '07', { origin: 'notification' }),
      message('partial-reply', projectConversation, '08', { role: 'assistant', status: 'pending' }),
    ],
  };
  const store = { list: (key: string) => rows[key] ?? [], get: (key: string, id: string) => {
    if (key !== 'message.routes' || !routes.has(id)) return;
    return { botId: bot.id, accountId: bot.appId, revision: bot.revision, target: bot.chatId, ...routes.get(id) };
  } } as FeishuBotsApp['store'];
  const app = { store, projectWorkspace: { post: async () => { throw Error('unexpected post'); } } };
  const history = [{threadId:'thread-one', title:'季度复核', latestAt:'2026-01-02'}];
  const { text, card } = conversationListDashboard(app, bot, 'grant', 'https://work.example', 0, history);
  assert.ok(JSON.stringify(card).includes('https://work.example/#agent/private-thread/' + bot.id + '/thread-one'));
  assert.ok(text.includes('本次私聊答复') && text.includes('最近的问题'));
  assert.ok(text.indexOf('近期项目') < text.indexOf('主对话'));
  assert.match(text, /2026-01-03/);
  assert.doesNotMatch(text, /fixture-secret|归档项目|group|relay|other-chat|unknown-route|old|task|another-project|internal|notice|partial-reply/);
  assert.match(JSON.stringify(card), /https:\/\/work\.example\/#projects\/a%2Fb\/workspace/);
  const sameTitle = ['甲组','乙组'].map((tag,index) => ({...history[0],threadId:'same-'+index,tags:[tag],hitCount:index*44}));
  const found = conversationListDashboard(app, bot, 'grant', undefined, 0, sameTitle, {query:'季度',snippets:{'same-1':'乙组摘录' + '长'.repeat(800)}});
  assert.match(found.text,/季度复核\n标签：甲组/);
  assert.match(found.text,/季度复核\n标签：乙组\n共匹配 44 条发言，此处显示最近一条。\n乙组摘录/);
  assert.match(JSON.stringify(found.card),/标签：乙组/);
  const local = conversationListDashboard(app, bot, 'grant', 'https://work.example/?token=private', 0, history);
  assert.doesNotMatch(JSON.stringify(local.card), /"url"|token=private/);
});
