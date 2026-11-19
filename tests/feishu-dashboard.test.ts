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
