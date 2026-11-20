import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeishuDashboard } from '../apps/server/src/feishu-dashboard.ts';
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
