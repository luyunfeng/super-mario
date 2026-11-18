import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Socket } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import type { ExecutorInfo, JsonObject, Message, Run, Snapshot, Todo } from '../packages/protocol/src/index.ts';

type ChatMessage = { role: string; content?: string | Array<{ type: string; text?: string }>; tool_call_id?: string };
type CompletionRequest = { model: string; stream: boolean; messages: ChatMessage[]; tools: Array<{ function: { name: string } }> };
function text(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n');
}
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (check(last)) return last;
    await delay(20);
  }
  assert.fail(`Pi HTTP acceptance timeout: ${JSON.stringify(last)}`);
}

test('real pi SDK discovers an executor through HTTP SSE, dispatches autonomously and returns one native task result', { timeout: 60000 }, async t => {
  // Guard the actual transport, including SDK fetch, HTTP and node WebSocket.
  // This delegates every permitted connection to the original implementation.
  const connections: string[] = [];
  const forbidden: string[] = [];
  const connect = Socket.prototype.connect;
  t.mock.method(Socket.prototype, 'connect', function (this: Socket, ...args: unknown[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = first && typeof first === 'object'
      ? String((first as { host?: string }).host ?? 'localhost')
      : typeof args[1] === 'string' ? args[1] : 'localhost';
    connections.push(host);
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      forbidden.push(host);
      throw new Error(`Non-loopback connection blocked: ${host}`);
    }
    return Reflect.apply(connect, this, args);
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-real-pi-http-'));
  let running: Awaited<ReturnType<typeof startServer>> | undefined;
  let node: ReturnType<typeof startAgentNode> | undefined;
  const requests: CompletionRequest[] = [];
  const fixtureErrors: unknown[] = [];
  const machineId = 'pi-fixture-node';
  const projectId = 'pi-http-project';
  const projectFact = 'PI_HTTP_PROJECT_FACT: 在临时工作目录生成验收结果。';
  const excludedFact = 'OTHER_PROJECT_SECRET_MUST_NOT_ENTER_PROMPT';
  const finalReply = '已派发，等待执行结果；待办需你验收。';
  let todoId = '';
  let selectedExecutor: string | undefined;
  let dispatchedRunId: string | undefined;
  const prompt = '生成本地验收结果';
  const doneWhen = '返回原生任务结果，供用户验收';
  const launches: JsonObject[] = [];
  let readyToComplete = false;
  let resultReads = 0;

  const modelServer = createServer(async (req, res) => {
    // A development readiness probe is not a model turn.
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200); res.end('local model fixture'); return; }
    try {
      assert.equal(req.method, 'POST', `unexpected model request: ${req.method} ${req.url}`);
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer offline-test-key');
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      const input = JSON.parse(body) as CompletionRequest;
      requests.push(input);
      assert.equal(input.model, 'fixture');
      assert.equal(input.stream, true);
      const system = input.messages.filter(message => ['system', 'developer'].includes(message.role)).map(text).join('\n');
      assert.ok(system.includes(projectFact), 'current project knowledge must reach the real SDK system prompt');
      assert.ok(system.includes(projectId));
      assert.ok(!system.includes(excludedFact), 'other project content must stay outside this turn');
      assert.ok(input.tools.some(tool => tool.function.name === 'executors_list'));
      assert.ok(input.tools.some(tool => tool.function.name === 'work_dispatch'));
      const toolResults = input.messages.filter(message => message.role === 'tool');
      const turn = requests.length;
      let delta: JsonObject;
      if (turn === 1) {
        assert.equal(toolResults.length, 0);
        delta = { tool_calls: [{ index: 0, id: 'call-executors', type: 'function', function: { name: 'executors_list', arguments: '{}' } }] };
      } else if (turn === 2) {
        assert.equal(toolResults.length, 1);
        assert.equal(toolResults[0].tool_call_id, 'call-executors');
        const executors = JSON.parse(text(toolResults[0])) as ExecutorInfo[];
        const executor = executors.find(item => item.machineId === machineId && item.available);
        assert.ok(executor, 'executor must come from the actual plugin tool response');
        selectedExecutor = executor.id;
        delta = { tool_calls: [{ index: 0, id: 'call-dispatch', type: 'function', function: { name: 'work_dispatch', arguments: JSON.stringify({
          executorId: selectedExecutor, cwd: dataDir, prompt, doneWhen, expectMinutes: 2, todoId,
        }) } }] };
      } else {
        assert.equal(turn, 3, 'only two tool calls and one final model response are expected');
        assert.equal(toolResults.length, 2);
        assert.equal(toolResults[1].tool_call_id, 'call-dispatch');
        const run = JSON.parse(text(toolResults[1])) as Run;
        assert.equal(run.executorId, selectedExecutor);
        assert.equal(run.todoId, todoId);
        assert.equal(run.projectId, projectId, 'project context must be inherited by work_dispatch');
        assert.ok(run.id);
        dispatchedRunId = run.id;
        delta = { content: finalReply };
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (value: JsonObject, finish: string | null) => res.write(`data: ${JSON.stringify({
        id: `fixture-${turn}`, object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta: value, finish_reason: finish }],
      })}\n\n`);
      chunk({ role: 'assistant', content: '' }, null);
      chunk(delta, null);
      chunk({}, turn < 3 ? 'tool_calls' : 'stop');
      res.end('data: [DONE]\n\n');
    } catch (error) {
      fixtureErrors.push(error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  t.after(async () => {
    try { await node?.close(); await running?.close(); }
    finally {
      modelServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => modelServer.close(error => error ? reject(error) : resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address();
  assert.ok(address && typeof address !== 'string');
  await mkdir(join(dataDir, 'pi'));
  await writeFile(join(dataDir, 'pi', 'models.json'), JSON.stringify({ providers: { 'local-test': {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'offline-test-key', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }],
  } } }));
  // Normal product entrypoint: no SDK loader replacement or injected agent session.
  running = await startServer({ host: '127.0.0.1', port: 0, dataDir, token: 'pi-http-test', demo: false,
    model: { provider: 'local-test', model: 'fixture' } });
  async function api<T>(path: string, method = 'GET', body?: unknown, expected = 200): Promise<T> {
    const response = await fetch(`${running!.url}/api/v1${path}`, {
      method, headers: { authorization: 'Bearer pi-http-test', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, expected, `${method} ${path}: ${await response.clone().text()}`);
    return await response.json() as T;
  }
  const now = new Date().toISOString();
  running.app.store.put('projects', projectId, { id: projectId, name: '模型验收项目', description: '', createdAt: now, updatedAt: now });
  const state = () => api<Snapshot>('/state');
  node = startAgentNode({ url: running.url, token: 'pi-http-test', machineId, name: 'Pi acceptance fake node', dataDir,
    executors: [{ id: 'codex', name: 'Local fake Codex', kind: 'cli', machineId, available: true, mode: 'real', description: 'Local fixture, no real CLI' }],
    handlers: {
      'executor.start': async params => { launches.push(params); return { sessionId: 'pi-native-session' }; },
      'executor.result': async params => {
        assert.equal(params.sessionId, 'pi-native-session');
        resultReads++;
        return { state: readyToComplete ? 'completed' : 'running', text: readyToComplete ? 'local native completion' : '', source: 'codex-json', exitCode: 0, nativeSessionId: 'fixture-native' };
      },
    },
  });
  await api('/knowledge', 'POST', { layer: 'project', projectId, title: '当前项目约束', content: projectFact }, 201);
  await api('/knowledge', 'POST', { layer: 'project', projectId: 'other-project', title: '其他项目', content: excludedFact }, 201);
  const todo = await api<Todo>('/todos', 'POST', { title: prompt, projectId }, 201);
  todoId = todo.id;
  const initialized = await eventually(state, value => value.agent.available && value.executors.some(item => item.id === `${machineId}/codex` && item.available));
  assert.equal(initialized.mode, 'live');
  const userText = `请处理待办 ${todo.id}，按项目知识自行选择执行者并派发。`;
  assert.ok(!userText.includes('codex'), 'the user does not choose an executor');
  const user = await api<Message>('/messages', 'POST', { text: userText, projectId }, 202);
  const replied = await eventually(state, value => value.messages.some(item => item.replyTo === user.id && item.origin !== 'result' && ['done', 'failed'].includes(item.status ?? '')));
  assert.deepEqual(fixtureErrors, []);
  const assistant = replied.messages.find(item => item.replyTo === user.id && item.origin !== 'result')!;
  assert.equal(assistant.status, 'done', assistant.text);
  assert.equal(assistant.text, finalReply);
  assert.equal(requests.length, 3);
  const active = await eventually(state, value => value.runs.length === 1 && Boolean(value.runs[0].sessionId));
  const run = active.runs[0];
  assert.equal(run.id, dispatchedRunId);
  assert.equal(run.sourceMessageId, user.id);
  assert.equal(run.projectId, projectId);
  assert.equal(run.todoId, todo.id);
  assert.equal(run.cwd, dataDir);
  assert.equal(run.doneWhen, doneWhen);
  assert.equal(run.expectMinutes, 2);
  assert.equal(run.executionMode, 'task');
  assert.equal(run.status, 'running');
  assert.deepEqual(launches, [{ executorId: 'codex', prompt, cwd: dataDir, mode: 'task' }]);
  assert.equal(active.messages.filter(item => item.origin === 'result').length, 0);
  readyToComplete = true;
  await running.app.monitor.poll();
  const completed = await eventually(state, value => value.runs[0].status === 'completed');
  assert.ok(resultReads > 0);
  assert.equal(completed.runs[0].resultSource, 'codex-json');
  const results = completed.messages.filter(item => item.origin === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, `run-result:${run.id}`);
  assert.equal(results[0].replyTo, user.id);
  assert.equal(results[0].projectId, projectId);
  assert.match(results[0].text, /local native completion/);
  assert.equal(completed.todos[0].completedAt, undefined);
  await Promise.all(Array.from({ length: 3 }, () => running!.app.monitor.poll()));
  assert.equal((await state()).messages.filter(item => item.origin === 'result').length, 1);
  assert.equal(running.app.events.since(0).filter(event => event.type === 'runs.result').length, 1);
  assert.equal(launches.length, 1);
  assert.equal(requests.length, 3, 'result delivery must not start another model turn');
  assert.ok(connections.length > 0);
  assert.deepEqual(forbidden, [], 'no external connection may even be attempted');
  assert.ok(connections.every(host => ['127.0.0.1', 'localhost', '::1'].includes(host)));
});
