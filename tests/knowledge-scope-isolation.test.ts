import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createKnowledgeWorker } from '../plugins/knowledge-worker.ts';
import { createExecutionServices } from '../plugins/executors.ts';
import { createKnowledgeCurator, type Job } from '../packages/core/src/knowledge-curator.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createLocalKnowledge } from '../plugins/knowledge-local.ts';
import type { ExtensionContext, MachineClient, NodeHandler, TerminalHost } from '../packages/plugin-sdk/src/index.ts';
import type { Json, JsonObject } from '../packages/protocol/src/index.ts';

const personal = { layer: 'personal' };
const project = (projectId: string) => ({ layer: 'project', projectId });
const secret = 'fake-secret-prompt-account-profile';
// Actual child processes retain a history buffer, report their native session and
// observe cwd/env. No model, terminal host, network or personal files are used.
const fake = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const codex = process.argv.includes('app-server');
const session = codex ? 'thread-' + process.pid : process.argv[process.argv.indexOf('--session-id') + 1];
const secret = 'fake-secret-prompt-account-profile';
const log = value => fs.appendFileSync('../wire.jsonl', JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
log({type:'boot',pid:process.pid,session,cwd:process.cwd(),command:process.argv[1],
 args:process.argv.slice(2),codex:process.env.CODEX_HOME,claude:process.env.CLAUDE_CONFIG_DIR,
 home:process.env.HOME,path:process.env.PATH});
const history = [];
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'config/read') { send({id:m.id,result:{config:{mcp_servers:{'test.canary':{command:'never-run'}}}}}); return; }
 if(m.method === 'initialize') {
  if(process.argv[1].includes('init-rpc')) { send({id:m.id,error:{message:secret}}); return; }
  if(process.argv[1].includes('init-json')) { process.stdout.write(secret+'\n'); return; }
  if(process.argv[1].includes('init-exit')) { process.stderr.write(secret,()=>process.exit(7)); return; }
  send({id:m.id,result:{}}); return;
 }
 if(m.method === 'thread/start') { send({id:m.id,result:{thread:{id:session}}}); return; }
 if(m.method !== 'turn/start' && m.type !== 'user') return;
 const prompt = codex ? m.params.input[0].text : m.message.content;
 history.push(prompt);
 const id = 'turn-' + history.length;
 log({type:'turn',pid:process.pid,session,cwd:process.cwd(),prompt,history:[...history]});
 if(codex) send({id:m.id,result:{turn:{id,status:'inProgress'}}});
 if(prompt === 'hold' || prompt.includes('HOLD_SCOPE_JOB')) return;
 if(prompt === 'exit-secret') { process.stderr.write(secret,()=>process.exit(7)); return; }
 if(prompt === 'json-secret') { process.stdout.write(secret+'\n'); return; }
 if(prompt === 'rpc-secret' && codex) { send({method:'error',params:{threadId:session,error:{message:secret}}}); return; }
 if(prompt === 'failed-secret') {
  send(codex ? {method:'turn/completed',params:{threadId:session,turn:{id,status:'failed',error:{message:secret}}}}
   : {type:'result',session_id:session,subtype:'error_during_execution',is_error:true,errors:[secret]}); return;
 }
 let payload;
 try { payload=JSON.parse(prompt.split('\n').at(-1)); } catch {}
 let config = {};
 try { config=JSON.parse(fs.readFileSync('../response.json','utf8')); } catch {}
 const value = {pages:[{id:config.pageId || (config.update && payload?.existingPages[0]?.id) || null,
  title:'整理页',content:payload ? '整理后的知识' : JSON.stringify({history,pid:process.pid,session})}],summary:'完成'};
 if(codex) send({method:'turn/completed',params:{threadId:session,turn:{id,status:'completed',items:[{type:'agentMessage',text:JSON.stringify(value)}]}}});
 else send({type:'result',session_id:session,subtype:'success',is_error:false,structured_output:value});
});
`;
type Service = { handlers: Record<string, NodeHandler>; close(): Promise<void> };
const callService = (service: Service) => async (method: string, params: JsonObject = {}) =>
  await service.handlers[`executor.knowledge.${method}`]!(params, () => {}) as JsonObject;
const jobOf = (value: JsonObject) => value.job as JsonObject;
async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 500; i++) { const value = await read(); if (done(value)) return value; await delay(10); }
  throw new Error('Fake CLI status timed out');
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-scope-'));
  const command = join(dir, 'fake.cjs');
  await writeFile(command, `#!${process.execPath}\n${fake}`, { mode: 0o700 });
  const make = () => createKnowledgeWorker({ dataDir: dir, commands: { codex: command, claude: command } });
  const service = make();
  const cleanup: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    try { for (const action of cleanup.reverse()) await action(); }
    finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
  });
  const call = callService(service);
  const wire = async (): Promise<Record<string, any>[]> => {
    try { return (await readFile(join(dir, 'wire.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(v => JSON.parse(v)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const submit = async (w: JsonObject, jobId: string, prompt: string) => {
    await call('submit', { workerId: w.workerId!, jobId, prompt });
    return until(() => call('status', { workerId: w.workerId!, jobId }), v => jobOf(v).status !== 'running');
  };
  return { dir, command, service, make, call, wire, submit, cleanup };
}
const alive = (pid: Json | undefined) => { assert.equal(typeof pid, 'number'); process.kill(pid as number, 0); };
const dead = (pid: Json | undefined) => assert.throws(() => process.kill(pid as number, 0), /ESRCH/);

for (const provider of ['codex', 'claude-code']) {
  test(`${provider}: personal → A → B → personal uses isolated persistent histories and private hashed cwd`, async t => {
    const f = await fixture(t);
    const p = await f.call('start', { provider });
    await f.submit(p, 'p1', 'personal-one'); await f.submit(p, 'p2', 'personal-two');
    const a = await f.call('start', { provider, scope: project('A/../项目') });
    await f.submit(a, 'a1', 'project-A-only');
    const b = await f.call('start', { provider, scope: project('B') });
    await f.submit(b, 'b1', 'project-B-only');
    const again = await f.call('start', { provider, scope: personal });
    assert.deepEqual(again, p);
    const last = await f.submit(again, 'p3', 'personal-three');
    const body = JSON.parse(JSON.parse(jobOf(last).text as string).pages[0].content);
    assert.deepEqual(body.history, ['personal-one', 'personal-two', 'personal-three']);
    const wire = await f.wire(), boots = wire.filter(v => v.type === 'boot'), turns = wire.filter(v => v.type === 'turn');
    assert.equal(boots.length, 3); assert.equal(new Set(boots.map(v => v.pid)).size, 3);
    assert.equal(new Set(boots.map(v => v.session)).size, 3);
    assert.equal(boots[0]!.cwd, join(f.dir, 'knowledge-workspace'));
    for (const boot of boots.slice(1)) { assert.equal(dirname(boot.cwd), f.dir); assert.match(boot.cwd, /knowledge-workspace-[a-f0-9]{64}$/); }
    assert.deepEqual(turns.find(v => v.pid === a.pid)!.history, ['project-A-only']);
    assert.deepEqual(turns.find(v => v.pid === b.pid)!.history, ['project-B-only']);
    for (const w of [p, a, b]) alive(w.pid);
    const status = await f.call('status'); assert.equal((status.pool as Json[]).length, 3);
    assert.doesNotMatch(JSON.stringify(status.pool), /personal-one|project-A-only|profile|prompt|body/);
    await f.service.close(); for (const w of [p, a, b]) dead(w.pid);
  });
}

test('scope validation and durable jobId ownership prevent cross-scope result borrowing, including after restart', async t => {
  const f = await fixture(t);
  for (const scope of [null, [], 'personal', {}, { layer: 'global' }, { layer: 'project' }, project(''), project(' A'), project('x\0y'), { ...personal, projectId: 'A' }, { ...project('A'), command: 'x' }] as Json[]) {
    await assert.rejects(f.call('start', { provider: 'codex', scope }), /scope/);
  }
  const p = await f.call('start', { provider: 'codex' });
  const a = await f.call('start', { provider: 'codex', scope: project('A') });
  await f.submit(a, 'shared', 'A-private');
  await assert.rejects(f.call('submit', { workerId: p.workerId!, jobId: 'shared', prompt: 'personal' }), /another scope/);
  await assert.rejects(f.call('status', { workerId: p.workerId!, jobId: 'shared' }), /another scope/);
  await assert.rejects(f.call('status', { jobId: 'shared' }), /another scope/);
  for (const method of ['status', 'stop', 'submit']) await assert.rejects(f.call(method, { workerId: a.workerId!, scope: personal, jobId: 'shared', prompt: 'x' }), /scope mismatch/);
  await f.call('submit', { workerId: a.workerId!, jobId: 'uncertain', prompt: 'exit-secret' });
  await until(() => f.call('status', { scope: project('A'), jobId: 'uncertain' }), v => jobOf(v).status === 'unknown');
  await f.service.close();
  // Simulate an unclean service exit with a durable running job.
  await writeFile(join(f.dir, 'knowledge-jobs', 'crashed.json'), JSON.stringify({ id: 'crashed', scope: project('A'), status: 'running' }));
  const restored = f.make(), call = callService(restored); f.cleanup.push(() => restored.close());
  for (const id of ['shared', 'uncertain', 'crashed']) await assert.rejects(call('status', { jobId: id, scope: personal }), /another scope/);
  assert.equal(jobOf(await call('status', { jobId: 'shared', scope: project('A') })).status, 'completed');
  const w = await call('start', { provider: 'codex', scope: project('A') });
  for (const id of ['shared', 'uncertain', 'crashed']) await call('submit', { workerId: w.workerId!, scope: project('A'), jobId: id, prompt: 'never-replay' });
  assert.equal(jobOf(await call('status', { jobId: 'crashed', scope: project('A') })).status, 'unknown');
  assert.equal((await f.wire()).filter(v => v.type === 'turn').length, 2);
});

test('bounded pool evicts only idle scopes, refuses active eviction/provider switch, and stop closes all children', async t => {
  const f = await fixture(t);
  const p = await f.call('start', { provider: 'codex' });
  await f.call('submit', { workerId: p.workerId!, jobId: 'hold-p', prompt: 'hold' });
  const a = await f.call('start', { provider: 'codex', scope: project('A') });
  await f.submit(a, 'evicted-result', 'A-result');
  const b = await f.call('start', { provider: 'codex', scope: project('B') });
  const c = await f.call('start', { provider: 'codex', scope: project('C') });
  const d = await f.call('start', { provider: 'codex', scope: project('D') });
  dead(a.pid); for (const w of [p, b, c, d]) alive(w.pid);
  const evicted = await f.call('status', { scope: project('A'), jobId: 'evicted-result' });
  assert.equal(evicted.state, 'stopped'); assert.equal(jobOf(evicted).status, 'completed');
  assert.deepEqual(evicted.scope, project('A'));
  for (const key of ['workerId', 'provider', 'pid', 'sessionId']) assert.equal(evicted[key], undefined);
  assert.equal(jobOf(await f.call('status', { jobId: 'hold-p' })).status, 'running');
  for (const [i, w] of [b, c, d].entries()) await f.call('submit', { workerId: w.workerId!, jobId: 'hold-' + i, prompt: 'hold' });
  await assert.rejects(f.call('start', { provider: 'codex', scope: project('E') }), /full.*inflight/);
  await assert.rejects(f.call('start', { provider: 'claude-code', scope: project('E') }), /inflight/);
  for (const w of [p, b, c, d]) alive(w.pid);
  await f.call('stop');
  for (const w of [p, b, c, d]) { dead(w.pid); assert.equal((await f.call('status', { workerId: w.workerId! })).state, 'stopped'); }
  assert.equal(jobOf(await f.call('status', { jobId: 'hold-p' })).status, 'unknown');
  const turns = (await f.wire()).filter(v => v.type === 'turn').length;
  const replacement = await f.call('start', { provider: 'codex', scope: project('A') });
  assert.notEqual(replacement.workerId, a.workerId);
  await f.call('submit', { workerId: replacement.workerId!, jobId: 'evicted-result', prompt: 'never-replay' });
  assert.equal((await f.wire()).filter(v => v.type === 'turn').length, turns);
});

test('provider replacement retires all idle scopes while preserving durable results', async t => {
  const f = await fixture(t);
  const old = [];
  for (const scope of [personal, project('A'), project('B')]) old.push(await f.call('start', { provider: 'codex', scope }));
  await f.submit(old[1]!, 'retained', 'project-A');
  const next = await f.call('start', { provider: 'claude-code', scope: project('A') });
  old.forEach(w => dead(w.pid)); alive(next.pid);
  await f.call('submit', { workerId: next.workerId!, jobId: 'retained', prompt: 'never-replay' });
  assert.equal((await f.wire()).filter(v => v.type === 'turn').length, 1);
  assert.equal(jobOf(await f.call('status', { scope: project('A'), jobId: 'retained' })).status, 'completed');
});

for (const provider of ['codex', 'claude-code'] as const) {
  test(`${provider}: execution services inject a copied trusted launcher/profile into actual knowledge children`, async t => {
    const f = await fixture(t);
    const configDir = join(f.dir, "profile ' $(literal)"); await mkdir(configDir);
    const launcher = { command: f.command, profile: { configDir } };
    const host: TerminalHost = { status: async () => ({ available: true }), list: async () => [],
      create: async () => { throw new Error('No terminal host should be called'); },
      read: async () => ({ text: '', ansi: '' }), input: async () => {}, keys: async () => {}, close: async () => {}, watch: async () => () => {} };
    const service = createExecutionServices({ host, dataDir: f.dir, launchers: { [provider]: launcher } });
    f.cleanup.push(() => service.close());
    launcher.command = '/must-not-run'; launcher.profile.configDir = '/must-not-use';
    const call = callService(service), w = await call('start', { provider });
    await call('submit', { workerId: w.workerId!, jobId: 'configured', prompt: 'test' });
    await until(() => call('status', { jobId: 'configured' }), v => jobOf(v).status === 'completed');
    const boot = (await f.wire()).find(v => v.pid === w.pid && v.type === 'boot')!;
    assert.equal(boot.command, f.command); assert.equal(boot[provider === 'codex' ? 'codex' : 'claude'], configDir);
    assert.equal(boot.home, process.env.HOME); assert.equal(boot.path, process.env.PATH);
    for (const method of ['start', 'status', 'submit', 'stop']) for (const key of ['command', 'argv', 'env', 'profile', 'launcher', 'launchers']) {
      await assert.rejects(call(method, { provider, workerId: w.workerId!, [key]: secret }), /local only/);
    }
    assert.doesNotMatch(JSON.stringify(await call('status')), /profile|literal|must-not-use/);
  });
}

test('trusted launchers take precedence over legacy commands and are validated at construction', async t => {
  const f = await fixture(t);
  const service = createKnowledgeWorker({ dataDir: f.dir, commands: { codex: '/must-not-run' }, launchers: { codex: { command: f.command } } });
  f.cleanup.push(() => service.close());
  assert.equal((await callService(service)('start', { provider: 'codex' })).state, 'idle');
  for (const launcher of [{ command: 'relative/path' }, { command: f.command, env: { TOKEN: secret } }, { command: f.command, profile: { configDir: 'relative' } }]) {
    assert.throws(() => createKnowledgeWorker({ dataDir: f.dir, launchers: { codex: launcher } }), /launcher/);
  }
});

for (const provider of ['codex', 'claude-code']) {
  test(`${provider}: stderr, malformed stdout and model errors never enter public reason/error; result text is preserved`, async t => {
    const f = await fixture(t);
    for (const [i, prompt] of ['exit-secret', 'json-secret', 'failed-secret', ...(provider === 'codex' ? ['rpc-secret'] : [])].entries()) {
      const w = await f.call('start', { provider, scope: project(String(i)) });
      const result = await f.submit(w, 'failure-' + i, prompt);
      assert.ok(['failed', 'unknown'].includes(String(jobOf(result).status)));
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
      assert.doesNotMatch(await readFile(join(f.dir, 'knowledge-jobs', 'failure-' + i + '.json'), 'utf8'), new RegExp(secret));
    }
    const w = await f.call('start', { provider, scope: project('valid') });
    const result = await f.submit(w, 'success', secret);
    assert.equal(jobOf(result).status, 'completed'); assert.ok(String(jobOf(result).text).includes(secret));
    assert.doesNotMatch(JSON.stringify(result.pool), new RegExp(secret));
  });
}

test('initialization failures and NodeHandler filesystem errors return only safe stage descriptions', async t => {
  const f = await fixture(t);
  for (const mode of ['init-rpc', 'init-json', 'init-exit']) {
    const command = join(f.dir, mode + '-' + secret + '.cjs');
    await writeFile(command, `#!${process.execPath}\n${fake}`, { mode: 0o700 });
    const service = createKnowledgeWorker({ dataDir: f.dir, commands: { codex: command } });
    try {
      const result = await callService(service)('start', { provider: 'codex' });
      assert.equal(result.state, 'failed'); assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    } finally { await service.close(); }
  }
  const w = await f.call('start', { provider: 'codex' });
  // A failure saving a job must not return filesystem diagnostics or a sensitive path.
  await rm(join(f.dir, 'knowledge-jobs'), { recursive: true });
  await assert.rejects(f.call('submit', { workerId: w.workerId!, jobId: 'save', prompt: secret }), { message: 'Knowledge worker operation failed' });
});

async function curatorFixture(t: TestContext, readSource?: Parameters<typeof createKnowledgeCurator>[0]['readSource']) {
  const f = await fixture(t);
  const store = createStore(join(f.dir, 'store.sqlite'));
  const events = createEventBus(store);
  const knowledge = createLocalKnowledge({ store, dataDir: join(f.dir, 'plugins', 'knowledge-local') } as ExtensionContext);
  let online = true, pluginEnabled = true, loseAck = false;
  const calls: { method: string; scope?: Json; jobId?: Json; workerId?: Json }[] = [];
  const client: MachineClient = {
    list: () => [{ id: 'node', name: 'Fake', online, platform: 'linux', connectedAt: 'now', capabilities: ['executor.knowledge.start'] }],
    async call(_id, method, params) {
      if (!online) throw new Error('Fake node disconnected');
      calls.push({ method, scope: params.scope, jobId: params.jobId, workerId: params.workerId });
      const result = await f.service.handlers[method]!(params, () => {});
      if (loseAck && method === 'executor.knowledge.submit') { loseAck = false; throw new Error('Lost acceptance acknowledgement'); }
      return result;
    },
  };
  const makeCurator = () => createKnowledgeCurator({ store, events, dataDir: f.dir, knowledge: () => knowledge,
    machines: () => client, enabled: () => pluginEnabled, validProject: id => ['A', 'B', 'C', 'D', 'E'].includes(id), ...(readSource ? { readSource } : {}) });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const curator = makeCurator();
  f.cleanup.push(async () => { online = true; await curator.close(); store.close(); t.mock.timers.reset(); });
  const pulse = async () => { t.mock.timers.tick(2000); await delay(10); };
  const job = (id: string) => store.get<Job>('knowledge.sources', id)!;
  const finish = async (id: string, status = 'completed') => until(async () => { await pulse(); return job(id); }, value => value.status === status);
  await curator.configure({ enabled: true, machineId: 'node', provider: 'codex' });
  return { ...f, store, knowledge, curator, calls, job, finish, pulse, makeCurator,
    setOnline: (value: boolean) => { online = value; }, setEnabled: (value: boolean) => { pluginEnabled = value; }, loseNextAck: () => { loseAck = true; } };
}

test('curator routes personal/A/B/personal to original bindings, supplies only scoped pages plus read-only global guidance, disable closes every CLI', async t => {
  const f = await curatorFixture(t);
  const global = await f.knowledge.put({ id: 'guide', layer: 'global', title: '工作方式', content: 'GLOBAL_GUIDANCE_ONLY' });
  const own = await f.knowledge.put({ id: 'personal-page', layer: 'personal', title: '个人', content: 'PERSONAL_PAGE_ONLY' });
  const a = await f.knowledge.put({ id: 'a-page', layer: 'project', projectId: 'A', title: 'A页', content: 'A_PAGE_ONLY' });
  const b = await f.knowledge.put({ id: 'b-page', layer: 'project', projectId: 'B', title: 'B页', content: 'B_PAGE_ONLY' });
  const inputs = [
    { ...personal, text: 'PERSONAL_SOURCE_ONE' }, { ...project('A'), text: 'A_SOURCE_ONE' },
    { ...project('B'), text: 'B_SOURCE_ONE' }, { ...personal, text: 'PERSONAL_SOURCE_TWO' },
  ];
  for (const input of inputs) { const job = f.curator.addSource(input); await f.finish(job.id); }
  const wire = await f.wire(), turns = wire.filter(v => v.type === 'turn'), boots = wire.filter(v => v.type === 'boot');
  assert.equal(boots.length, 3); assert.equal(turns.length, 4);
  assert.equal(turns[0]!.pid, turns[3]!.pid); assert.equal(turns[0]!.session, turns[3]!.session);
  assert.notEqual(turns[1]!.pid, turns[2]!.pid); assert.notEqual(turns[0]!.pid, turns[1]!.pid);
  for (const [i, turn] of turns.entries()) {
    const payload = JSON.parse(turn.prompt.split('\n').at(-1));
    assert.deepEqual(payload.destination, { layer: inputs[i]!.layer, ...('projectId' in inputs[i]! ? { projectId: inputs[i]!.projectId } : {}) });
    assert.deepEqual(payload.globalGuidance, [{ title: global.title, content: global.content }]);
    const expected = i === 1 ? a : i === 2 ? b : own;
    assert.ok(payload.existingPages.some((page: { id: string; content: string }) => page.id === expected.id && page.content === expected.content));
    assert.ok(!payload.existingPages.some((page: { id: string }) => page.id === global.id));
    for (const page of [own, a, b].filter(page => page.id !== expected.id)) assert.ok(!turn.prompt.includes(page.content));
    for (const input of inputs.filter(input => input.layer !== inputs[i]!.layer || ('projectId' in input && input.projectId !== ('projectId' in inputs[i]! ? inputs[i]!.projectId : undefined)))) {
      assert.ok(!turn.prompt.includes(input.text));
    }
    assert.ok(turn.prompt.includes('不能修改全局知识'));
  }
  assert.equal(turns[1]!.history.length, 1); assert.equal(turns[2]!.history.length, 1); assert.equal(turns[3]!.history.length, 2);
  assert.deepEqual((await f.knowledge.list({ layer: 'global' }))[0], global);
  assert.equal(f.curator.status().worker.pool?.length, 3);
  await f.curator.configure({ enabled: false, machineId: 'node', provider: 'codex' });
  boots.forEach(boot => dead(boot.pid));
});

test('curator keeps the active scope across queued work and disconnect, never turns an awaiting-approval source, close terminates all owned scopes', async t => {
  const f = await curatorFixture(t, async (_url, _signal, job) => {
    f.store.put('approvals', 'approval', { kind: 'plugin:knowledge-local.read-source', params: { jobId: job!.id } });
    throw Object.assign(new Error('Awaiting owner'), { code: 'AWAITING_APPROVAL', approvalId: 'approval' });
  });
  const pending = f.curator.addSource({ ...project('B'), url: 'https://fake.example/protected' });
  await f.finish(pending.id, 'awaiting_approval');
  assert.equal((await f.wire()).filter(v => v.type === 'turn').length, 0);
  const holding = f.curator.addSource({ ...project('A'), text: 'HOLD_SCOPE_JOB' });
  await f.finish(holding.id, 'running');
  await until(f.wire, wire => wire.some(v => v.type === 'turn'));
  const active = (await f.wire()).find(v => v.type === 'turn')!;
  const queued = f.curator.addSource({ text: 'PERSONAL_QUEUED' });
  for (let i = 0; i < 3; i++) await f.pulse();
  assert.deepEqual(f.curator.status().worker.scope, project('A')); assert.equal(f.job(queued.id).status, 'queued');
  assert.ok(!f.calls.filter(call => call.jobId === holding.id).some(call => JSON.stringify(call.scope) !== JSON.stringify(project('A'))));
  f.setOnline(false);
  for (let i = 0; i < 3; i++) await f.pulse();
  alive(active.pid); assert.equal(f.job(holding.id).status, 'running'); assert.equal(f.curator.status().worker.state, 'waiting');
  await assert.rejects(f.curator.configure({ enabled: true, machineId: 'node', provider: 'claude-code' }), /正在整理/);
  f.setOnline(true); await f.pulse(); assert.deepEqual(f.curator.status().worker.scope, project('A'));
  assert.equal((await f.wire()).filter(v => v.type === 'turn').length, 1);
  const boots = (await f.wire()).filter(v => v.type === 'boot');
  await f.curator.close(); boots.forEach(boot => dead(boot.pid));
  const outcome = await f.call('status', { scope: project('A'), jobId: holding.id });
  assert.equal(jobOf(outcome).status, 'unknown');
  assert.equal(f.job(pending.id).status, 'awaiting_approval');
});

test('curator recovers accepted unknown delivery and idle eviction without replay; provider changes and plugin disable clean every scope', async t => {
  const f = await curatorFixture(t);
  f.loseNextAck();
  const uncertain = f.curator.addSource({ ...project('A'), text: 'ACK_UNCERTAIN_SOURCE' });
  await f.finish(uncertain.id);
  assert.equal(f.calls.filter(call => call.method === 'executor.knowledge.submit' && call.jobId === uncertain.id).length, 1);
  for (const scope of [project('B'), project('C'), project('D'), project('E'), project('A')]) {
    const job = f.curator.addSource({ ...scope, text: 'SCOPED_SOURCE_' + scope.projectId }); await f.finish(job.id);
  }
  assert.equal((await f.wire()).filter(v => v.type === 'turn').length, 6);
  const boots = (await f.wire()).filter(v => v.type === 'boot');
  assert.ok(boots.length > 4);
  await f.curator.configure({ enabled: true, machineId: 'node', provider: 'claude-code' });
  boots.forEach(boot => dead(boot.pid));
  const more = f.curator.addSource({ ...project('B'), text: 'CLAUDE_SOURCE' }); await f.finish(more.id);
  const current = (await f.wire()).filter(v => v.type === 'boot' && !boots.some(old => old.pid === v.pid));
  assert.equal(current.length, 2);
  f.setEnabled(false); await f.pulse();
  await until(async () => { await f.pulse(); return f.curator.status().worker.state; }, state => state === 'disabled');
  current.forEach(boot => dead(boot.pid));
});

test('curator rejects generated global edits and preserves human versions with scoped existing pages', async t => {
  const f = await curatorFixture(t);
  const global = await f.knowledge.put({ id: 'global-protected', layer: 'global', title: '全局', content: 'GLOBAL_INTACT' });
  await writeFile(join(f.dir, 'response.json'), JSON.stringify({ pageId: global.id }));
  const malicious = f.curator.addSource({ ...project('A'), text: 'GLOBAL_EDIT_ATTEMPT' });
  const failed = await f.finish(malicious.id, 'failed'); assert.match(failed.error!, /归属以外/);
  assert.deepEqual((await f.knowledge.list({ layer: 'global' }))[0], global);
  const page = await f.knowledge.put({ id: 'scoped-human', layer: 'project', projectId: 'A', title: '人工', content: 'OLD_VERSION' });
  await writeFile(join(f.dir, 'response.json'), JSON.stringify({ pageId: page.id }));
  const held = f.curator.addSource({ ...project('A'), text: 'HOLD_SCOPE_JOB' }); await f.finish(held.id, 'running');
  await f.knowledge.put({ ...page, content: 'HUMAN_LATEST' });
  // Replace only the fake's durable model result; the real curator import path
  // still checks the captured version and scope before touching canonical files.
  await f.call('stop', { scope: project('A') });
  const path = join(f.dir, 'knowledge-jobs', held.id + '.json');
  await writeFile(path, JSON.stringify({ id: held.id, scope: project('A'), status: 'completed', text: JSON.stringify({ pages: [{ id: page.id, title: page.title, content: 'OUTDATED' }], summary: '完成' }) }));
  // A fresh worker service reads the durable response, as after an execution-node restart.
  const restored = f.make(); f.cleanup.push(() => restored.close());
  const reader = callService(restored);
  const original = f.service.handlers['executor.knowledge.status']!;
  f.service.handlers['executor.knowledge.status'] = (params, emit) => params.jobId === held.id
    ? restored.handlers['executor.knowledge.status']!(params, emit) : original(params, emit);
  const conflict = await f.finish(held.id, 'failed'); assert.match(conflict.error!, /已被修改/);
  assert.equal((await f.knowledge.list({ layer: 'project', projectId: 'A' })).find(p => p.id === page.id)!.content, 'HUMAN_LATEST');
  assert.equal(jobOf(await reader('status', { jobId: held.id, scope: project('A') })).status, 'completed');
});

test('curator restart reads original scoped unknown evidence without starting or resubmitting a job', async t => {
  const f = await curatorFixture(t);
  const active = f.curator.addSource({ ...project('A'), text: 'HOLD_SCOPE_JOB' });
  await f.finish(active.id, 'running');
  await until(f.wire, wire => wire.some(v => v.type === 'turn'));
  await f.curator.close();
  assert.equal(f.job(active.id).status, 'running');
  assert.equal(jobOf(await f.call('status', { scope: project('A'), jobId: active.id })).status, 'unknown');
  const previousCalls = f.calls.length;
  const restored = f.makeCurator(); f.cleanup.push(() => restored.close());
  await f.finish(active.id, 'unknown');
  assert.equal(f.job(active.id).recoveryPending, false);
  const recoveryCalls = f.calls.slice(previousCalls);
  assert.ok(recoveryCalls.some(call => call.method === 'executor.knowledge.status' && call.jobId === active.id && JSON.stringify(call.scope) === JSON.stringify(project('A'))));
  assert.equal(recoveryCalls.filter(call => call.method === 'executor.knowledge.submit' || call.method === 'executor.knowledge.start').length, 0);
  for (let i = 0; i < 4; i++) await f.pulse();
  assert.equal(f.calls.filter(call => call.method === 'executor.knowledge.submit').length, 1);
  assert.equal((await f.wire()).filter(v => v.type === 'turn').length, 1);
});

test('pool cleanup still terminates all children if persisting an active unknown fails', async t => {
  const f = await fixture(t);
  const workers = [];
  for (const [i, scope] of [personal, project('A'), project('B')].entries()) {
    const w = await f.call('start', { provider: 'codex', scope }); workers.push(w);
    await f.call('submit', { workerId: w.workerId!, jobId: 'held-' + i, prompt: 'hold' });
  }
  await rm(join(f.dir, 'knowledge-jobs'), { recursive: true });
  await assert.rejects(f.call('stop'), { message: 'Knowledge worker operation failed' });
  workers.forEach(w => dead(w.pid));
  // Restore the directory so teardown can finish recording the unknown outcomes.
  await mkdir(join(f.dir, 'knowledge-jobs'));
});

test('offline disable retains all bindings, refuses provider changes and cleans the scopes after reconnect', async t => {
  const f = await curatorFixture(t);
  for (const scope of [project('A'), project('B')]) {
    const job = f.curator.addSource({ ...scope, text: 'OFFLINE_LIFECYCLE_SOURCE' }); await f.finish(job.id);
  }
  const boots = (await f.wire()).filter(v => v.type === 'boot'); assert.equal(boots.length, 3);
  f.setOnline(false);
  await assert.rejects(f.curator.configure({ enabled: false, machineId: 'node', provider: 'claude-code' }), /离线/);
  boots.forEach(boot => alive(boot.pid));
  await f.curator.configure({ enabled: false, machineId: 'node', provider: 'codex' });
  assert.equal(f.store.get<unknown[]>('knowledge.curator', 'bindings')!.length, 3);
  boots.forEach(boot => alive(boot.pid));
  const count = f.calls.length;
  f.setOnline(true);
  await until(async () => { await f.pulse(); return f.store.get<unknown[]>('knowledge.curator', 'bindings')!.length; }, size => size === 0);
  boots.forEach(boot => dead(boot.pid));
  assert.equal(f.calls.slice(count).filter(call => call.method === 'executor.knowledge.start').length, 0);
});

test('curator shutdown attempts every scope even if one node stop fails and retains that binding for cleanup', async t => {
  const f = await curatorFixture(t);
  for (const scope of [project('A'), project('B')]) {
    const job = f.curator.addSource({ ...scope, text: 'CLEANUP_SOURCE' }); await f.finish(job.id);
  }
  const original = f.service.handlers['executor.knowledge.stop']!;
  f.service.handlers['executor.knowledge.stop'] = async (params, emit) => {
    if ((params.scope as JsonObject)?.projectId === 'A') throw new Error('Fake stop failure');
    return original(params, emit);
  };
  await assert.rejects(f.curator.close(), /Fake stop failure/);
  const boots = (await f.wire()).filter(v => v.type === 'boot');
  for (const boot of boots) {
    const scopes = f.calls.filter(call => call.method === 'executor.knowledge.start');
    const aStarted = scopes.find(call => (call.scope as JsonObject)?.projectId === 'A'); assert.ok(aStarted);
    if (boot.cwd === (await f.wire()).find(v => v.type === 'turn' && v.prompt.includes('"projectId":"A"'))!.cwd) alive(boot.pid);
    else dead(boot.pid);
  }
  assert.equal(f.store.get<unknown[]>('knowledge.curator', 'bindings')!.length, 1);
  f.service.handlers['executor.knowledge.stop'] = original;
  await f.curator.close(); boots.forEach(boot => dead(boot.pid));
});

test('curator clears obsolete scope pointers after node restart using explicit absence and preserves durable knowledge', async t => {
  const f = await curatorFixture(t);
  const ids: string[] = [];
  for (const scope of [project('A'), project('B')]) {
    const job = f.curator.addSource({ ...scope, text: 'NODE_RESTART_SOURCE' });
    await f.finish(job.id); ids.push(job.id);
  }
  const pages = await f.knowledge.list();
  assert.equal(f.store.get<unknown[]>('knowledge.curator', 'bindings')!.length, 3);
  await f.service.close();
  const restored = f.make(); f.cleanup.push(() => restored.close());
  f.service.handlers['executor.knowledge.status'] = restored.handlers['executor.knowledge.status']!;
  const before = f.calls.length;
  await f.curator.configure({ enabled: false, machineId: 'node', provider: 'codex' });
  const cleanup = f.calls.slice(before);
  assert.equal(cleanup.filter(call => call.method === 'executor.knowledge.status').length, 3);
  assert.ok(cleanup.every(call => call.method === 'executor.knowledge.status'));
  assert.deepEqual(f.store.get('knowledge.curator', 'bindings'), []);
  assert.deepEqual(await f.knowledge.list(), pages);
  for (const id of ids) {
    assert.equal(f.job(id).status, 'completed');
    assert.equal(jobOf(await callService(restored)('status', { scope: project(f.job(id).projectId!), jobId: id })).status, 'completed');
  }
});
