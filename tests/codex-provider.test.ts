import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { readCodexModelConfig } from '../packages/core/src/agent-runtime/codex-model-config.ts';
import { registerCodexProvider } from '../packages/core/src/agent-runtime/codex-provider.ts';

type Context = Parameters<ModelRuntime['streamSimple']>[1];
type CLIRecord = { args: string[]; cwd: string; pid: number; directoryMode: number; schemaMode: number; answerMode: number; prompt: string; schema: unknown; codexHome?: string };

async function fixture(t: TestContext, behavior = 'turns', modelId = 'default') {
  const dir = await mkdtemp(join(tmpdir(), 'mario-codex-test-'));
  const recordPath = join(dir, 'calls.jsonl');
  const command = join(dir, 'fake-codex');
  await writeFile(command, `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('app-server')) {
 const readline = await import('node:readline');
 if (${JSON.stringify(behavior)}.startsWith('preflight-')) {
  appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({cwd:process.cwd(),pid:process.pid,codexHome:process.env.CODEX_HOME})+'\\n');
  if (${JSON.stringify(behavior)} === 'preflight-exit') { process.stderr.write('secret-auth'); process.exit(7); }
  process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
 } else
 readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
  if (m.method === 'config/read') process.stdout.write(JSON.stringify(${JSON.stringify(behavior)} === 'config-unsupported'
    ? {id:m.id,error:{message:'secret-context'}} : {id:m.id,result:{config:{mcp_servers:{'test.canary':{command:'secret-context'}}},origins:{secret:'secret-value'}}})+'\\n');
 });
} else {

const schemaPath = args[args.indexOf('--output-schema') + 1];
const answerPath = args[args.indexOf('--output-last-message') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  args, prompt, cwd: process.cwd(), pid: process.pid, codexHome:process.env.CODEX_HOME,
  directoryMode: statSync(process.cwd()).mode & 0o777,
  schemaMode: statSync(schemaPath).mode & 0o777,
  answerMode: statSync(answerPath).mode & 0o777,
  schema: JSON.parse(readFileSync(schemaPath, 'utf8')),
}) + '\\n');
const behavior = ${JSON.stringify(behavior)};
const payload = JSON.parse(prompt.slice(prompt.indexOf('\\n\\n') + 2));
let answer = { text: '查询中', toolCalls: [{ name: 'lookup', arguments: '{"key":"测试"}' }] };
if (payload.messages.some(m => m.role === 'toolResult')) answer = { text: '已查到：42', toolCalls: [] };
if (behavior === 'unknown') answer.toolCalls[0].name = 'not_registered';
if (behavior === 'bad-arguments') answer.toolCalls[0].arguments = '{secret-context';
if (behavior === 'array-arguments') answer.toolCalls[0].arguments = '[]';
if (behavior === 'null-arguments') answer.toolCalls[0].arguments = 'null';
if (behavior === 'extra') answer.extra = 'secret-context';
if (behavior === 'text-only') answer = { text: '合成回复', toolCalls: [] };
if (behavior === 'empty') answer = { text: '', toolCalls: [] };
if (behavior === 'sleep') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (behavior === 'exit') { process.stderr.write('secret-context API_KEY=secret-value'); process.exitCode = 7; }
else if (behavior === 'flood') { process.stdout.write('x'.repeat(5 * 1024 * 1024)); }
else if (behavior === 'large-answer') writeFileSync(answerPath, 'x'.repeat(1024 * 1024 + 1));
else { if (behavior.startsWith('native:')) process.stdout.write(JSON.stringify({type:'item.started',item:{type:behavior.slice(7),text:'secret-context'}})+'\\n');
else process.stdout.write(JSON.stringify({type:'item.completed',item:{type:behavior === 'diagnostic' ? 'error' : 'agent_message',text:'secret-context startup diagnostic'}})+'\\n');
writeFileSync(answerPath, behavior === 'invalid' ? 'secret-context invalid JSON' : JSON.stringify(answer)); }
}
`, { mode: 0o700 });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'),
    modelsStorePath: join(dir, 'model-cache.json'), allowModelNetwork: false, refreshOnCreate: false,
  });
  registerCodexProvider(runtime, modelId, { command });
  const model = runtime.getModel('codex-cli', modelId)!;
  assert.ok(model);
  await runtime.getAvailable('codex-cli');
  t.after(async () => {
    await runtime.settleCredentialWrites();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const context: Context = {
    systemPrompt: '只查工具，不执行项目工作。',
    messages: [{ role: 'user', content: '查询测试值', timestamp: Date.now() }],
    tools: [{ name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: { key: { type: 'string' } } } }],
  };
  async function records(): Promise<CLIRecord[]> {
    try { return (await readFile(recordPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async function started() {
    for (let i = 0; i < 250; i++) {
      const calls = await records();
      if (calls.length) return calls[0];
      await delay(10);
    }
    assert.fail('fake CLI did not start');
  }
  async function cleaned() {
    for (const call of await records()) {
      await assert.rejects(access(call.cwd), { code: 'ENOENT' });
      assert.throws(() => process.kill(call.pid, 0), { code: 'ESRCH' });
    }
  }
  return { runtime, model, context, command, records, started, cleaned, recordPath };
}

test('native SDK provider sends two CLI turns and emits text/tool events without executing tools', async t => {
  const f = await fixture(t);
  assert.ok((await f.runtime.getAvailable('codex-cli')).some(model => model.id === 'default'));
  const stream = f.runtime.streamSimple(f.model, f.context);
  const events = [];
  for await (const event of stream) events.push(event);
  const first = await stream.result();
  assert.equal(first.stopReason, 'toolUse');
  assert.deepEqual(events.map(event => event.type), [
    'start', 'text_start', 'text_delta', 'text_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done',
  ]);
  const tool = first.content.find(block => block.type === 'toolCall');
  assert.ok(tool?.id);
  assert.equal(tool.name, 'lookup');
  assert.deepEqual(tool.arguments, { key: '测试' });
  assert.equal(events.filter(event => event.type === 'done').length, 1);
  const secondContext: Context = { ...f.context, messages: [...f.context.messages, first, {
    role: 'toolResult', toolCallId: tool.id, toolName: tool.name,
    content: [{ type: 'text', text: '42' }], isError: false, timestamp: Date.now(),
  }] };
  const second = await f.runtime.completeSimple(f.model, secondContext);
  assert.equal(second.stopReason, 'stop');
  assert.deepEqual(second.content, [{ type: 'text', text: '已查到：42' }]);
  const calls = await f.records();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].cwd, calls[1].cwd);
  for (const call of calls) {
    assert.equal(call.directoryMode, 0o700);
    assert.equal(call.schemaMode, 0o600);
    assert.equal(call.answerMode, 0o600);
    assert.deepEqual(call.args.slice(0, 6), ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json']);
    assert.deepEqual(call.args.slice(-2), ['--', '-']);
    assert.ok(!call.args.includes('--model'));
    assert.ok(!call.args.join(' ').includes('查询测试值'));
    assert.match(call.prompt, /Do not use your own tools/);
    const payload = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n\n') + 2));
    assert.equal(payload.systemPrompt, f.context.systemPrompt);
    assert.deepEqual(payload.tools, f.context.tools);
    assert.ok(payload.messages.some((message: { role: string }) => message.role === 'user'));
    assert.equal((call.schema as { additionalProperties: boolean }).additionalProperties, false);
  }
  await f.cleaned();
});

test('explicit model is forwarded; empty text is a valid stop; request hooks are honored', async t => {
  const f = await fixture(t, 'empty', 'chosen-model');
  const hooks: string[] = [];
  const result = await f.runtime.completeSimple(f.model, f.context, {
    onPayload(payload) { hooks.push('payload'); return { ...(payload as object), marker: 'replacement' }; },
    onResponse(response) { hooks.push('response'); assert.equal(response.status, 200); },
    onProviderStreamEvent() { hooks.push('event'); },
  });
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(result.content, []);
  assert.deepEqual(hooks, ['payload', 'response', 'event']);
  const [call] = await f.records();
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'chosen-model');
  assert.match(call.prompt, /"marker":"replacement"/);
  await f.cleaned();
});

test('non-actionable CLI diagnostics do not masquerade as native tool use or leak into the answer',async t=>{
  const f=await fixture(t,'diagnostic');const result=await f.runtime.completeSimple(f.model,f.context);
  assert.equal(result.stopReason,'toolUse');assert.ok(!JSON.stringify(result).includes('secret-context'));await f.cleaned();
});

for (const [behavior, summary] of [
  ['config-unsupported', /configuration preflight/], ['unknown', /unavailable tool/], ['invalid', /invalid JSON/],
  ['bad-arguments', /invalid tool arguments/], ['array-arguments', /JSON object/],
  ['null-arguments', /JSON object/], ['extra', /invalid response shape/],
  ...['command_execution','mcp_tool_call','web_search','file_change','todo_list','request_user_input','future_tool'].map(kind => [`native:${kind}`, /native tool use/] as const),
  ['exit', /exited unsuccessfully/], ['flood', /output exceeded/], ['large-answer', /answer exceeded/],
] as const) {
  test(`rejects ${behavior} with a sanitized terminal error and cleans files`, async t => {
    const f = await fixture(t, behavior);
    const stream = f.runtime.streamSimple(f.model, f.context);
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage!, summary);
    assert.doesNotMatch(result.errorMessage!, /secret-context|secret-value|API_KEY|查询测试值/);
    assert.deepEqual(result.content, []);
    assert.deepEqual(events.map(event => event.type), ['error']);
    await f.cleaned();
  });
}

test('current transcript tools form the whitelist after tool removal', async t => {
  const f = await fixture(t);
  const result = await f.runtime.completeSimple(f.model, { ...f.context, tools: [] });
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage!, /unavailable tool/);
  await f.cleaned();
});

test('abort kills a CLI ignoring SIGTERM and cleans private files before returning', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 'sleep');
  const controller = new AbortController();
  const stream = f.runtime.streamSimple(f.model, f.context, { signal: controller.signal });
  await f.started();
  controller.abort(new Error('secret-context'));
  const result = await stream.result();
  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.errorMessage, 'Codex CLI request aborted.');
  await f.cleaned();
});

test('already aborted request does not launch a CLI', async t => {
  const f = await fixture(t);
  const result = await f.runtime.completeSimple(f.model, f.context, { signal: AbortSignal.abort() });
  assert.equal(result.stopReason, 'aborted');
  assert.deepEqual(await f.records(), []);
});

test('missing executable reports a fixed summary and cleans temporary files', async t => {
  const f = await fixture(t);
  // A recorder wrapper notes the provider-created directory before exec fails.
  await writeFile(f.command, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
appendFileSync(${JSON.stringify(f.recordPath)}, JSON.stringify({cwd:process.cwd(),pid:process.pid})+'\\n');
spawn('/no-such-codex-executable', []).on('error', () => process.exit(127));
`, { mode: 0o700 });
  const result = await f.runtime.completeSimple(f.model, f.context);
  assert.equal(result.stopReason, 'error');
  assert.equal(result.errorMessage, 'Codex CLI configuration preflight failed.');
  await f.cleaned();
  registerCodexProvider(f.runtime, 'default', { command: join(f.command, 'missing') });
  const missing = await f.runtime.completeSimple(f.model, f.context);
  assert.equal(missing.stopReason, 'error');
  assert.equal(missing.errorMessage, 'Codex CLI configuration preflight failed.');
});

test('120 second deadline terminates the child without waiting for a real model', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 'sleep');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = f.runtime.streamSimple(f.model, f.context);
  await f.started();
  t.mock.timers.tick(120_000);
  t.mock.timers.tick(500);
  const result = await stream.result();
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage!, /120 second time limit/);
  await f.cleaned();
});


test('configDir changes only child CODEX_HOME; preflight config never enters model input', async t => {
  const f = await fixture(t);
  const parent = process.env.CODEX_HOME;
  const configDir = join(tmpdir(), "profile ' $(literal)");
  registerCodexProvider(f.runtime, 'default', {command:f.command, configDir});
  const result = await f.runtime.completeSimple(f.model, f.context);
  assert.equal(result.stopReason, 'toolUse');
  const [call] = await f.records();
  assert.equal(call.codexHome, configDir);
  assert.equal(process.env.CODEX_HOME, parent);
  assert.ok(call.args.includes('mcp_servers={"test.canary"={"enabled"=false}}'));
  assert.doesNotMatch(call.prompt, /secret-context|secret-value|test.canary|origins/);
  await f.cleaned();
});

for (const action of ['abort', 'timeout', 'exit']) test(`config-only preflight ${action} fails without a model turn or diagnostic leak`, {timeout:10000}, async t => {
  const f = await fixture(t, action === 'exit' ? 'preflight-exit' : 'preflight-hold');
  const controller = new AbortController();
  if (action === 'timeout') t.mock.timers.enable({apis:['setTimeout']});
  const pending = readCodexModelConfig(f.command, tmpdir(), {...process.env,CODEX_HOME:'isolated-test-config'}, controller.signal);
  // Attach rejection immediately; exit may precede recorder polling.
  const rejected = assert.rejects(pending, error => {
    assert.doesNotMatch(String(error), /secret-auth|isolated-test-config/);
    assert.match(String(error), /preflight/); return true;
  });
  const record = await f.started();
  if (action === 'abort') controller.abort();
  if (action === 'timeout') { t.mock.timers.tick(15000); t.mock.timers.tick(500); }
  await rejected;
  assert.throws(() => process.kill(record.pid, 0), {code:'ESRCH'});
  assert.equal((await f.records()).length,1);
});

test('命令行会话把自填型号作为单个参数交给本地协议替身，成功后计入目录', async t => {
  const f = await fixture(t, 'text-only');
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-cli-model-'));
  const app = await createWorkbench({ dataDir, host: '127.0.0.1', port: 0, demo: false,
    model: { provider: 'codex-cli', model: 'default', cliCommand: f.command, cliConfigDir: dataDir } });
  try {
    const model = '~fixture/model-v3[1m]';
    await app.pickConversationModel(model, undefined, true);
    assert.deepEqual(await f.records(), []);
    assert.equal((await app.agent.ask('核对型号')).text, '合成回复');
    const calls = await f.records();
    assert.equal(calls.length, 1);
    const flag = calls[0].args.indexOf('--model');
    assert.ok(flag >= 0);
    assert.equal(calls[0].args[flag + 1], model);
    assert.deepEqual(app.modelCatalog().custom, [model]);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
