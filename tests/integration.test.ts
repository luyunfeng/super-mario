import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import type { Snapshot } from '../packages/protocol/src/index.ts';

async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('等待状态更新超时');
}

test('local product: authenticated Web/API, knowledge, todos, asynchronous work and persistence', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'super-mario-product-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, token: 'test-token', demo: true };
  let running = await startServer(config);
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(`${running.url}/api/v1${path}`, { method, headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const state = async () => await (await request('/state')).json() as Snapshot;
  try {
    assert.equal((await fetch(`${running.url}/api/health`)).status, 200);
    assert.equal((await fetch(`${running.url}/api/v1/state`)).status, 401);
    assert.match(await (await fetch(running.url)).text(), /Super Mario/);
    assert.equal((await fetch(`${running.url}/js/main.js`)).status, 200);
    assert.equal((await fetch(`${running.url}/missing.js`)).status, 404);
    const initial = await state();
    assert.equal(initial.mode, 'demo');
    const featureIds = new Set(['conversation-files', 'conversation-images', 'conversation-outbox', 'conversation-queue', 'conversation-retry', 'reading-fonts', 'release-source', 'source-subscriptions', 'run-comparison', 'shortcut-settings', 'start-page', 'workspace-splash', 'token-statistics', 'feishu-web', 'todo-calendar', 'conversation-drafts', 'conversation-quotes', 'conversation-edit', 'reply-translation', 'conversation-search', 'conversation-export', 'message-favorites', 'saved-prompts', 'project-instructions', 'assistant-profile', 'assistant-skills', 'office-documents']);
    assert.equal((await request('/audio-transcription', 'POST', {})).status, 404);
    const coreIds = initial.plugins.map(plugin => plugin.id).filter(id => !featureIds.has(id)).sort();
    assert.deepEqual(coreIds, [
      'builtin-tools', 'daily-brief', 'executor-claude-code', 'executor-codex', 'executor-pi',
      'feishu', 'inbox-triage', 'knowledge-local', 'terminal-host',
    ]);
    assert.ok(initial.webExtensions?.some(entry => entry.id === 'workspace-splash'));
    const tokenStats = initial.plugins.find(plugin => plugin.id === 'token-statistics');
    assert.ok(tokenStats);
    assert.equal(tokenStats.status, 'active');
    assert.deepEqual(tokenStats.capabilities, ['usage.read']);
    assert.deepEqual(tokenStats.navigation, [{ id: 'dashboard', label: 'Token 统计', route: '#agent?tokenStats=1' }]);
    assert.equal(initial.plugins.find(plugin => plugin.id === 'feishu-web')?.status, 'disabled');
    assert.ok(initial.plugins.filter(plugin => plugin.id !== 'feishu-web').every(plugin => plugin.enabled));
    assert.ok(initial.executors.find(executor => executor.id === 'demo' && executor.mode === 'demo'));
    assert.equal((await request('/todos', 'POST', { title: ' ' })).status, 400);
    assert.equal((await request('/knowledge', 'POST', { layer: 'project', title: '项目', content: '资料' })).status, 400);
    const promptsPath = '/saved-prompts';
    assert.equal((await request(promptsPath, 'POST', { action: 'list' }, { authorization: '' })).status, 401);
    const prompt = await request(promptsPath, 'POST', { action: 'create', revision: 0, name: '复核', text: '合成跨重启草稿' });
    assert.equal(prompt.status, 200);
    const promptBook = await prompt.json();
    const saved = await request('/knowledge', 'POST', { layer: 'global', title: '工作方式', content: '尽量简单，先本地验证。' });
    assert.equal(saved.status, 201);
    const knowledge = await saved.json() as { id: string };
    const todo = await (await request('/todos', 'POST', { title: '验收基础闭环', notes: '持久化并重新打开' })).json() as { id: string };
    assert.equal((await request(`/todos/${todo.id}`, 'PATCH', { completed: true })).status, 200);
    assert.equal((await request(`/todos/${todo.id}`, 'PATCH', { completed: false })).status, 200);
    assert.equal((await request('/messages', 'POST', { text: '你好' })).status, 202);
    await eventually(state, value => value.messages.some(message => message.role === 'assistant'));
    const dispatched = await request('/runs', 'POST', { executorId: 'demo', prompt: '测试演示执行' }, { 'idempotency-key': 'one-work' });
    assert.equal(dispatched.status, 202);
    const run = await dispatched.json() as { id: string };
    const repeated = await (await request('/runs', 'POST', { executorId: 'demo', prompt: '测试演示执行' }, { 'idempotency-key': 'one-work' })).json() as { id: string };
    assert.equal(repeated.id, run.id);
    const finished = await eventually(state, value => value.runs.some(item => item.id === run.id && item.status === 'completed'));
    assert.match(finished.runs.find(item => item.id === run.id)!.output, /演示|demo/i);
    await running.close();
    running = await startServer(config);
    const restored = await state();
    assert.equal((await request('/plugins/saved-prompts', 'POST', { enabled: false })).status, 200);
    assert.equal((await request(promptsPath, 'POST', { action: 'list' })).status, 503);
    assert.equal((await request('/plugins/saved-prompts', 'POST', { enabled: true })).status, 200);
    assert.deepEqual(await (await request(promptsPath, 'POST', { action: 'list' })).json(), promptBook);
    assert.equal(restored.messages[0].role, 'user');
    assert.equal(restored.messages[1].role, 'assistant');
    assert.ok(restored.knowledge.some(item => item.id === knowledge.id));
    assert.ok(restored.todos.some(item => item.id === todo.id && !item.completedAt));
    assert.ok(restored.runs.some(item => item.id === run.id));
    assert.equal((await request('/plugins/knowledge-local', 'POST', { enabled: false })).status, 200);
    assert.equal((await request('/knowledge')).status, 503);
    assert.equal((await request('/plugins/knowledge-local', 'POST', { enabled: true })).status, 200);
    assert.equal((await request('/knowledge')).status, 200);
    const tool = running.app.contributions.list('tools').find(item => item.value.name === 'todo_create')!.value;
    await tool.execute({ title: '通过插件工具创建' }, new AbortController().signal);
    assert.ok((await state()).todos.some(item => item.title === '通过插件工具创建'));
    assert.equal((await request(`/knowledge/${knowledge.id}`, 'DELETE')).status, 200);
  } finally { await running.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('local execution node appears in Web state, and disconnect is recorded without remote execution', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'super-mario-node-'));
  const running = await startServer({ host: '127.0.0.1', port: 0, dataDir, token: 'node-test', demo: true });
  const node = startAgentNode({ url: running.url, token: 'node-test', machineId: 'local-test', name: '本地测试机器', dataDir, reconnectMs: 20 });
  const snapshot = async () => await (await fetch(`${running.url}/api/v1/state`, { headers: { authorization: 'Bearer node-test' } })).json() as Snapshot;
  try {
    await eventually(snapshot, state => state.machines.some(machine => machine.id === 'local-test' && machine.online));
    await node.close();
    await eventually(snapshot, state => state.machines.some(machine => machine.id === 'local-test' && !machine.online));
  } finally { await node.close(); await running.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Web event connection observes persisted mutations', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'super-mario-events-'));
  const running = await startServer({ host: '127.0.0.1', port: 0, dataDir, demo: true });
  const ws = new WebSocket(`${running.url.replace('http:', 'ws:')}/api/v1/events`);
  try {
    await once(ws, 'open');
    const event = new Promise<{ type: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('事件未送达')), 3000);
      ws.on('message', raw => { const value = JSON.parse(raw.toString()); if (value.type === 'todos.changed') { clearTimeout(timeout); resolve(value); } });
    });
    const response = await fetch(`${running.url}/api/v1/todos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '测试刷新' }) });
    assert.equal(response.status, 201);
    assert.equal((await event).type, 'todos.changed');
  } finally { ws.terminate(); await running.close(); await rm(dataDir, { recursive: true, force: true }); }
});
