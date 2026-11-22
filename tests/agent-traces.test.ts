import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { estimateTokens, listTraceSessions, readTraceSession, readTurnTrace, redactTraceText, saveTurnTrace, summarizeTrace, type AgentTurnTrace } from '../packages/core/src/agent-traces.ts';

test('estimateTokens and redactTraceText handle CJK/ASCII and scrub secrets', () => {
  assert.ok(estimateTokens('你好世界 hello world') > 3);
  const { text } = redactTraceText('Bearer secret-token-value and sk-1234567890abcdef1234', 'my-custom-key');
  assert.doesNotMatch(text, /secret-token-value|sk-1234567890abcdef1234/);
  assert.match(text, /\[REDACTED\]/);
});

test('saveTurnTrace persists session history, summary breakdown and reads back turns', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-traces-'));
  const store = createStore(join(dir, 'test.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  store.put('projects', 'p1', { id: 'p1', name: '演示项目', createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z' });
  store.put('messages', 'u1', { id: 'u1', conversationId: 'main', role: 'user', text: '帮我查今天日程', status: 'done', createdAt: '2026-11-22T01:00:00Z' });
  store.put('messages', 'a1', { id: 'a1', conversationId: 'main', role: 'assistant', replyTo: 'u1', text: '今天有 2 个会', status: 'done', createdAt: '2026-11-22T01:00:02Z' });
  store.put('messages', 'p-u1', { id: 'p-u1', conversationId: 'project:p1:work', role: 'user', text: '查 diff', status: 'done', createdAt: '2026-11-22T01:05:00Z' });

  const items = [
    { id: 'sys', category: 'system' as const, label: '基础系统提示词', tokens: 1200, chars: 3200, content: '你是总调度官' },
    { id: 'think-0', category: 'thinking' as const, label: '思考过程 #1', tokens: 350, chars: 700, content: '先调用 calendar_agenda 核对今日日程' },
  ];
  const trace: AgentTurnTrace = {
    id: 'a1',
    conversationId: 'main',
    userMessageId: 'u1',
    status: 'done',
    provider: 'pi',
    model: 'demo-model',
    contextWindow: 128000,
    startedAt: '2026-11-22T01:00:00Z',
    finishedAt: '2026-11-22T01:00:02Z',
    durationMs: 2000,
    userText: '帮我查今天日程',
    assistantText: '今天有 2 个会',
    usage: { input: 1200, output: 350, cacheRead: 800, cacheWrite: 0, totalTokens: 1550, estimated: false },
    summary: summarizeTrace(items),
    contextItems: items,
    thinkingBlocks: [{ index: 0, text: '先调用 calendar_agenda 核对今日日程', tokens: 350 }],
    toolCalls: [{ id: 'c1', name: 'calendar_agenda', args: '{}', result: '{"events":[]}', isError: false, startedAt: '2026-11-22T01:00:01Z', finishedAt: '2026-11-22T01:00:01Z', tokens: 40 }],
  };
  saveTurnTrace(store, trace);

  const sessions = listTraceSessions(store);
  assert.equal(sessions[0]!.conversationId, 'main');
  assert.equal(sessions[0]!.turnCount, 1);
  assert.equal(sessions[0]!.latestTokens, 1550);
  assert.ok(sessions.some(s => s.conversationId === 'project:p1:work' && s.title.includes('演示项目')));

  const sessionDetail = readTraceSession(store, 'main');
  assert.equal(sessionDetail.turns.length, 1);
  assert.equal(sessionDetail.messages.length, 2);
  assert.equal(sessionDetail.messages[1]!.hasTrace, true);

  const turnDetail = readTurnTrace(store, 'a1');
  assert.equal(turnDetail?.thinkingBlocks[0]!.text, '先调用 calendar_agenda 核对今日日程');
  assert.equal(turnDetail?.summary.system, 1200);
});
