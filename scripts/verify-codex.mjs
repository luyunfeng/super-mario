// Explicit live acceptance: uses the caller's Codex login, only a newly created temp directory and PTY.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../apps/server/src/index.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createTerminalHost } from '../plugins/terminal-host.ts';
import { createExecutionServices } from '../plugins/executors.ts';

const dir = await mkdtemp(join(tmpdir(), 'super-mario-acceptance-'));
const credentialPath = join(dir, 'server', 'pi', 'auth.json');
process.once('exit', () => rmSync(credentialPath, { force: true }));
const codexMain = process.argv.includes('--codex-main');
const withMain = codexMain || process.argv.includes('--with-main-agent');
const workdir = join(dir, 'work'); await mkdir(workdir);
// This explicit acceptance flag uses an existing, unexpired login in a temporary copy only.
// Production startup never imports the caller's Codex credentials.
if (withMain && !codexMain) {
  const auth = JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), 'utf8'));
  const tokens = auth.tokens;
  const expires = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString()).exp * 1000;
  assert.ok(expires > Date.now() + 15 * 60_000, '测试需要至少还有15分钟有效期的登录，不自动刷新原凭证');
  await mkdir(join(dir, 'server', 'pi'), { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'server', 'pi', 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: tokens.access_token, refresh: 'disabled-during-acceptance', expires, accountId: tokens.account_id } }), { mode: 0o600 });
}
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token: 'temporary-local-acceptance', demo: !withMain,
  ...(withMain ? { model: codexMain ? { provider: 'codex-cli', model: 'default' } : { provider: 'openai-codex', model: process.env.SUPER_MARIO_ACCEPTANCE_MODEL || 'gpt-6.1-sol' } } : {}) });
const host = createTerminalHost();
const services = createExecutionServices({ host, dataDir: join(dir, 'node') });
// Exercise the shipped execution-node command in its own process, not an in-process fake.
const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/super-mario-agent.js', import.meta.url)), '--url', server.url, '--token', 'temporary-local-acceptance', '--name', '真实 Codex 验收', '--data-dir', join(dir, 'node')], {
  env: { ...process.env, SUPER_MARIO_DEV: '1' }, stdio: ['ignore', 'ignore', 'pipe'],
});
let childError = ''; child.stderr.on('data', chunk => { childError += chunk; });
let stopping;
const node = { close() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  })(); return stopping;
} };
let machineId;
let paneId;
const streams = new Set();
async function until(read, check, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) { const value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error('验收等待超时');
}
async function fullFrame() {
  const query = new URLSearchParams({ token: 'temporary-local-acceptance', machineId, paneId });
  const ws = new WebSocket(`${server.url.replace('http:', 'ws:')}/api/v1/terminal?${query}`); streams.add(ws);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('真实终端首帧超时')); }, 10000);
    ws.on('message', raw => { const frame = JSON.parse(raw.toString()); if (frame.full) { clearTimeout(timer); ws.close(); streams.delete(ws); resolve(frame); } });
    ws.on('error', error => { clearTimeout(timer); reject(error); });
    ws.on('close', code => { if (code !== 1000 && code !== 1005) { clearTimeout(timer); reject(new Error(`真实终端连接关闭 ${code}`)); } });
  });
}
try {
  assert.equal((await host.status()).available, true);
  const registered = await until(() => { if (child.exitCode !== null) throw new Error(`执行节点命令启动失败：${childError.slice(-500)}`); return server.app.snapshot(); }, state => state.machines.some(machine => machine.online), 10);
  machineId = registered.machines.find(machine => machine.online).id;
  const todo = server.app.createTodo({ title: '真实 Codex 隔离验收' });
  let delegatedInput;
  if (withMain) {
    await until(() => server.app.agent.status(), state => state.available, 15);
    await server.app.knowledge().put({ layer: 'global', title: '验收工作原则', content: '只使用工作台注册工具派活，不能虚构执行或完成。外部工作必须填写doneWhen和expectMinutes。' });
    await server.app.knowledge().put({ layer: 'project', projectId: 'acceptance', title: '隔离验收项目', content: `项目工作目录：${workdir}。执行者为运行在验收执行节点上的 Codex，请使用executors_list查实时ID。验收产物为acceptance.txt。` });
    delegatedInput = await server.app.agent.post('请处理验收待办 '+todo.id+'：让外部执行者在测试项目目录创建 acceptance.txt，内容恰好是 SUPER_MARIO_ACCEPTED 和一个换行，检查文件后报告。请依据项目知识和在线执行者自主选择并调用 work_dispatch，提供验收标准与预计2分钟；不要只提出建议，也不要把派发当成完成。', 'main', { projectId: 'acceptance' });
    console.log(JSON.stringify({ stage: 'main-agent-requested', directory: dir, inputId: delegatedInput.id }));
  }
  const response = withMain ? undefined : await fetch(`${server.url}/api/v1/runs`, { method: 'POST', headers: { authorization: 'Bearer temporary-local-acceptance', 'content-type': 'application/json' }, body: JSON.stringify({
    executorId: `${machineId}/codex`, executionMode: 'task', cwd: workdir, todoId: todo.id,
    prompt: '你是工作台派来的外部执行 Agent。只在当前临时目录创建 acceptance.txt，内容恰好为 SUPER_MARIO_ACCEPTED 和一个换行。检查文件后用一句中文报告。不要读取其他目录，不要发送消息或启动其他Agent。',
    doneWhen: 'acceptance.txt 内容恰好为 SUPER_MARIO_ACCEPTED 和换行', expectMinutes: 2,
  }) });
  if (response) assert.equal(response.status, 202);
  const run = response ? await response.json() : (await until(async () => { const state = await server.app.snapshot(); const failure = state.messages.find(message => message.role === 'assistant' && message.status === 'failed'); if (failure) throw new Error(failure.text); return state; }, state => state.runs.length > 0, 90)).runs[0];
  if (withMain) assert.equal(run.sourceMessageId, delegatedInput.id);
  console.log(JSON.stringify({ stage: 'dispatched', directory: dir, runId: run.id }));
  const started = await until(() => server.app.snapshot(), state => state.runs.some(item => item.id === run.id && item.sessionId));
  const active = started.runs.find(item => item.id === run.id);
  const sessions = await server.machines.call(machineId, 'executor.sessions', {});
  paneId = sessions.find(session => session.sessionId === active.sessionId).paneId;
  const first = await fullFrame(); const second = await fullFrame();
  assert.notEqual(first.epoch, second.epoch); assert.ok(first.data); assert.ok(second.data);
  const finished = await until(async () => { await server.app.monitor.poll(); return server.app.snapshot(); }, state => state.runs.some(item => item.id === run.id && ['completed', 'failed'].includes(item.status)));
  const result = finished.runs.find(item => item.id === run.id);
  assert.equal(result.status, 'completed', result.error ?? result.output);
  assert.equal(result.resultSource, 'codex-json');
  const afterCompletion = await fullFrame(); assert.ok(afterCompletion.data); assert.notEqual(afterCompletion.epoch, second.epoch);
  assert.equal(await readFile(join(workdir, 'acceptance.txt'), 'utf8'), 'SUPER_MARIO_ACCEPTED\n');
  assert.equal(finished.messages.filter(message => message.id === `run-result:${run.id}`).length, 1);
  assert.equal(finished.todos.find(item => item.id === todo.id).completedAt, undefined);
  let supervisorReview;
  if (withMain) {
    const replied = await until(() => server.app.snapshot(), state => state.messages.some(message => message.replyTo === delegatedInput.id && message.origin !== 'result' && message.status === 'done'), 90);
    assert.ok(replied.messages.some(message => message.replyTo === delegatedInput.id && message.status === 'done'));
    server.app.supervision.tick();
    supervisorReview = await server.app.supervisorAgent.flush();
    assert.equal(supervisorReview?.status, 'suggestion');
    assert.ok(supervisorReview.text.trim());
    assert.ok(!supervisorReview.text.includes('【本地演示】'));
  }
  // Reconnect the execution node and confirm the same native result, without launching again.
  await node.close();
  const recovered = createExecutionServices({ host, dataDir: join(dir, 'node') });
  const persisted = await recovered.handlers['executor.result']({ sessionId: active.sessionId }, () => {});
  assert.equal(persisted.state, 'completed');
  const evidence = { passed: true, directory: dir, runId: run.id, resultSource: result.resultSource, nativeSessionId: persisted.nativeSessionId, output: result.output, artifact: 'SUPER_MARIO_ACCEPTED\n', terminalFullFrames: 3, completedScreenRetained: true, distinctEpochs: true, resultMessages: 1, todoNotAutoCompleted: true, recoveredResult: true, mainAgentMode: withMain ? 'real pi SDK + live model' : 'demo', modelProvider: codexMain ? 'codex-cli' : withMain ? 'openai-codex' : 'demo', supervisorReviewed: Boolean(supervisorReview), externalExecutor: 'real Codex CLI', executionNodeProcess: 'super-mario-agent child process' };
  await writeFile(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  for (const ws of streams) ws.terminate();
  await node.close(); await server.close(); await services.disconnect();
  if (withMain && !codexMain) await rm(credentialPath, { force: true });
  if (paneId) { try { await host.close(paneId); } catch { /* Only this test's own PTY is eligible for cleanup. */ } }
}
