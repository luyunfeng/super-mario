import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createKnowledgeWorker } from '../plugins/knowledge-worker.ts';
import type { JsonObject } from '../packages/protocol/src/index.ts';

// Synchronous fd IO keeps the fake independent of child-process stream polling in sandboxes.
const fake = String.raw`
const fs = require('node:fs');
const codex = process.argv.includes('app-server');
const session = codex ? 'thread-1' : process.argv[process.argv.indexOf('--session-id')+1];
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = value => fs.appendFileSync('wire.jsonl', JSON.stringify(value)+'\n');
function write(text) {
 const data = Buffer.from(text);
 for(let offset=0;offset<data.length;) {
  try { offset += fs.writeSync(1,data,offset,data.length-offset); }
  catch(e) { if(e.code !== 'EAGAIN') throw e; pause(1); }
 }
}
const send = value => write(JSON.stringify(value)+'\n');
function* messages() {
 const data = Buffer.alloc(65536); let buffer = '';
 while(true) {
  let count;
  try { count = fs.readSync(0,data,0,data.length,null); }
  catch(e) { if(e.code !== 'EAGAIN') throw e; pause(1); continue; }
  if (!count) return;
  buffer += data.toString('utf8',0,count);
  let index;
  while((index=buffer.indexOf('\n'))>=0) {
   const line=buffer.slice(0,index); buffer=buffer.slice(index+1);
   yield JSON.parse(line);
  }
 }
}
log({argv:process.argv.slice(2),pid:process.pid,cwd:process.cwd()});
let count = 0;
for(const m of messages()) {
 log(m);
 if (m.method === 'config/read') { send({id:m.id,result:{config:{mcp_servers:{'test.canary':{command:'never-run'}}}}}); continue; }
 if (m.method === 'initialize') { send({id:m.id,result:process.argv[1].includes('broken-init') ? null : {}}); continue; }
 if (m.method === 'thread/start') { send({id:m.id,result:{thread:{id:session}}}); continue; }
 if (m.method !== 'turn/start' && m.type !== 'user') continue;
 const prompt = codex ? m.params.input[0].text : m.message.content;
 const id = 'turn-' + (++count);
 if (codex) {
  send({id:m.id,result:{turn:{id,status:'inProgress'}}});
  send({method:'turn/started',params:{threadId:session,turn:{id,status:'inProgress'}}});
 }
 if (prompt === 'hold') continue;
 if (prompt === 'exit') process.exit(7);
 if (prompt === 'malformed') { write('not json\n'); continue; }
 if (prompt === 'oversized') { write('x'.repeat(2*1024*1024+1)); continue; }
 if (codex && prompt.startsWith('native-')) {
  const item = {type:prompt.slice(7),text:'secret-auth'};
  if (item.type === 'completionOnly') send({method:'turn/completed',params:{threadId:session,turn:{id,status:'completed',items:[{type:'dynamicToolCall'}]}}});
  else send({method:'item/started',params:{threadId:session,turnId:id,item}});
  continue;
 }
 if (prompt === 'denied') {
  send(codex ? {id:90,method:'item/commandExecution/requestApproval',params:{threadId:session,turnId:id}} : {type:'control_request',request_id:'deny-me',request:{subtype:'can_use_tool'}});
  continue;
 }
 const value = prompt === 'bad-schema' ? {pages:[],summary:'invalid'} : {pages:[{title:'Knowledge',content:prompt}],summary:'summary'};
 const text = JSON.stringify(value);
 pause(10);
 if (codex) {
  send({method:'turn/completed',params:{threadId:'unrelated-thread',turn:{id,status:'completed',items:[]}}});
  send({method:'item/completed',params:{threadId:session,turnId:id,item:{type:'agentMessage',text,phase:'final_answer'}}});
  if (prompt === 'assistant-only') continue;
  send({method:'turn/completed',params:{threadId:session,turn:{id,status:prompt === 'interrupted' ? 'interrupted' : prompt === 'failed' ? 'failed' : 'completed',items:[],error:prompt === 'failed' ? {message:'fake failure'} : null}}});
 } else {
  if (prompt !== 'text-fallback') send({type:'assistant',session_id:session,message:{content:[{type:'tool_use',name:'StructuredOutput',id:'format-1',input:value}]}});
  send({type:'assistant',session_id:session,message:{content:[{type:'text',text}]}});
  if (prompt === 'assistant-only') continue;
  const result = {type:'result',session_id:session,subtype:prompt === 'failed' ? 'error_during_execution' : 'success',is_error:prompt === 'failed'};
  if (prompt !== 'text-fallback') result.structured_output = value;
  send(result);
 }
}
`;
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mario-knowledge-test-'));
  const command = join(dir, 'fake-cli.cjs');
  writeFileSync(command, `#!${process.execPath}\n${fake}`); chmodSync(command, 0o700);
  const make = () => createKnowledgeWorker({ dataDir: dir, commands: { codex: command, claude: command } });
  const service = make();
  return { dir, service, make, call: async (name: string, params: JsonObject = {}) => await service.handlers[`executor.knowledge.${name}`]!(params, () => {}) as JsonObject,
    wire: () => readFileSync(join(dir, 'knowledge-workspace', 'wire.jsonl'), 'utf8').trim().split('\n').map(v => JSON.parse(v)),
    cleanup: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function until(read: () => Promise<JsonObject>, predicate: (value: JsonObject) => boolean): Promise<JsonObject> {
  for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value; await delay(10); }
  throw new Error('Timed out polling fake CLI');
}
function job(value: JsonObject): JsonObject { return value.job as JsonObject; }

for (const provider of ['codex', 'claude-code']) {
  test(`${provider}: persistent process/session, dedupe, structured results and restrictions`, async () => {
    const f = setup();
    try {
      const first = await f.call('start', { provider });
      assert.equal(first.state, 'idle', JSON.stringify(first)); assert.equal(typeof first.pid, 'number');
      assert.deepEqual(await f.call('start', { provider }), first);
      for (const id of ['one', 'two', 'text-fallback']) {
        assert.deepEqual(await f.call('submit', { workerId: first.workerId!, jobId: id, prompt: id }), { accepted: true });
        const status = await until(() => f.call('status', { jobId: id }), v => job(v).status !== 'running');
        assert.equal(job(status).status, 'completed', JSON.stringify(status)); assert.equal(status.pid, first.pid); assert.equal(status.sessionId, first.sessionId);
        assert.equal(JSON.parse(job(status).text as string).pages[0].content, id);
        await f.call('submit', { workerId: first.workerId!, jobId: id, prompt: 'never execute again' });
      }
      const wire = f.wire();
      assert.equal(wire.filter(m => m.method === 'turn/start' || m.type === 'user').length, 3);
      assert.equal(wire.filter(m => m.argv).length, 1);
      assert.equal(wire[0].cwd, join(f.dir, 'knowledge-workspace'));
      if (provider === 'codex') {
        const start = wire.find(m => m.method === 'thread/start').params;
        assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalPolicy, 'never');
        assert.equal(start.config['features.shell_tool'], false);
        assert.deepEqual(start.config.mcp_servers, {'test.canary':{enabled:false}});
        assert.equal(wire.filter(m => m.method === 'config/read').length, 1);
        assert.equal(wire.find(m => m.method === 'turn/start').params.outputSchema.properties.pages.maxItems, 8);
        assert(wire[0].argv.includes('--stdio'));
      } else {
        const args: string[] = wire[0].argv;
        assert.equal(args[args.indexOf('--tools') + 1], '');
        assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
        assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
        assert(args.includes('--strict-mcp-config')); assert(args.includes('--safe-mode'));
      }
      await f.call('stop', { workerId: first.workerId! });
      const stopped = await f.call('status'); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.pid, undefined);
      const restored = f.make();
      try {
        const result = await restored.handlers['executor.knowledge.status']!({ jobId: 'one' }, () => {}) as JsonObject;
        assert.equal(result.state, 'stopped'); assert.equal(job(result).status, 'completed');
      } finally { await restored.close(); }
    } finally { await f.cleanup(); }
  });
}

test('single inflight, concurrent start, provider replacement and old worker validation', async () => {
  const f = setup();
  try {
    const [a, b] = await Promise.all([f.call('start', { provider: 'codex' }), f.call('start', { provider: 'codex' })]);
    assert.equal(a.workerId, b.workerId);
    await f.call('submit', { workerId: a.workerId!, jobId: 'holding', prompt: 'hold' });
    await assert.rejects(f.call('submit', { workerId: a.workerId!, jobId: 'other', prompt: 'other' }), /not idle/);
    await assert.rejects(f.call('start', { provider: 'claude-code' }), /inflight/);
    await f.call('stop');
    assert.equal(job(await f.call('status', { jobId: 'holding' })).status, 'unknown');
    const c = await f.call('start', { provider: 'claude-code' });
    assert.notEqual(c.workerId, a.workerId);
    await assert.rejects(f.call('status', { workerId: a.workerId! }), /Unknown/);
    await assert.rejects(f.call('stop', { workerId: a.workerId! }), /Unknown/);
    await f.call('submit', { workerId: c.workerId!, jobId: 'holding', prompt: 'do not replay' });
    assert.equal((await f.call('status')).state, 'idle');
    const d = await f.call('start', { provider: 'codex' }); assert.notEqual(d.pid, c.pid);
  } finally { await f.cleanup(); }
});

for (const provider of ['codex', 'claude-code']) {
  for (const [prompt, expected] of [['exit', 'unknown'], ['malformed', 'failed'], ['oversized', 'unknown'], ['denied', 'failed'], ['failed', 'failed'], ['bad-schema', 'failed'], ...(provider === 'codex' ? [['interrupted', 'unknown']] : [])]) {
    test(`${provider}: ${prompt} is ${expected}, never completed`, async () => {
      const f = setup();
      try {
        const start = await f.call('start', { provider });
        await f.call('submit', { workerId: start.workerId!, jobId: 'failure', prompt: prompt! });
        const result = await until(() => f.call('status', { jobId: 'failure' }), v => job(v).status !== 'running');
        assert.equal(job(result).status, expected); assert.equal(job(result).text, undefined);
        assert.equal(typeof job(result).error, 'string');
        const persisted = JSON.parse(readFileSync(join(f.dir, 'knowledge-jobs', 'failure.json'), 'utf8'));
        assert.equal(persisted.status, expected);
      } finally { await f.cleanup(); }
    });
  }
}

test('restart recovers running as unknown, unsafe ids rejected, completed stays queryable', async () => {
  const f = setup();
  try {
    await f.service.close();
    writeFileSync(join(f.dir, 'knowledge-jobs', 'recover.json'), JSON.stringify({ id: 'recover', status: 'running' }));
    const recovered = f.make();
    const call = async (name: string, params: JsonObject = {}) => await recovered.handlers[`executor.knowledge.${name}`]!(params, () => {}) as JsonObject;
    try {
      const status = await call('status', { jobId: 'recover' });
      assert.equal(status.state, 'stopped'); assert.equal(job(status).status, 'unknown');
      assert.equal(JSON.parse(readFileSync(join(f.dir, 'knowledge-jobs', 'recover.json'), 'utf8')).status, 'unknown');
      const start = await call('start', { provider: 'codex' });
      await call('submit', { workerId: start.workerId!, jobId: 'recover', prompt: 'no replay' });
      for (const id of ['../oops', 'x/y', 'a'.repeat(129), '.', 'hello.json']) {
        await assert.rejects(call('submit', { workerId: start.workerId!, jobId: id, prompt: 'text' }), /jobId/);
        await assert.rejects(call('status', { jobId: id }), /jobId/);
      }
      await assert.rejects(call('status', { jobId: 'not-found' }), /Unknown/);
      assert.equal(f.wire().filter(m => m.method === 'turn/start').length, 0);
    } finally { await recovered.close(); }
  } finally { await f.cleanup(); }
});

test('missing executable returns failed, close marks inflight unknown and terminates owned CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-knowledge-missing-'));
  const service = createKnowledgeWorker({ dataDir: dir, commands: { codex: join(dir, 'nonexistent') } });
  try {
    const result = await service.handlers['executor.knowledge.start']!({ provider: 'codex' }, () => {}) as JsonObject;
    assert.equal(result.state, 'failed'); assert.equal(result.pid, undefined); assert.match(String(result.reason), /ENOENT/);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
  const f = setup();
  try {
    const start = await f.call('start', { provider: 'claude-code' });
    await f.call('submit', { workerId: start.workerId!, jobId: 'close', prompt: 'hold' });
    await f.service.close();
    assert.equal(job(await f.call('status', { jobId: 'close' })).status, 'unknown');
    assert.equal((await f.call('status')).pid, undefined);
    await assert.rejects(f.call('start', { provider: 'codex' }), /closed/);
    assert.throws(() => process.kill(start.pid as number, 0), /ESRCH/);
  } finally { await f.cleanup(); }
});

test('job timeout persists unknown and kills a worker without replay', async t => {
  const f = setup();
  try {
    const start = await f.call('start', { provider: 'codex' });
    await f.call('submit', { workerId: start.workerId!, jobId: 'timeout', prompt: 'hold' });
    // Allow the fake server to acknowledge turn/start before advancing only our timers.
    await delay(30);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Install the job timer under the mocked clock on a fresh held job.
    await f.call('stop');
    const fresh = await f.call('start', { provider: 'claude-code' });
    await f.call('submit', { workerId: fresh.workerId!, jobId: 'timeout-two', prompt: 'hold' });
    t.mock.timers.tick(300_001);
    const status = await f.call('status', { jobId: 'timeout-two' });
    assert.equal(job(status).status, 'unknown'); assert.match(String(job(status).error), /timed out/);
    t.mock.timers.reset();
    await until(() => f.call('status'), v => v.pid === undefined);
    assert.equal((await f.call('status')).state, 'failed');
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

for (const provider of ['codex', 'claude-code']) {
  test(`${provider}: assistant text alone cannot complete a job`, async () => {
    const f = setup();
    try {
      const start = await f.call('start', { provider });
      await f.call('submit', { workerId: start.workerId!, jobId: 'no-result', prompt: 'assistant-only' });
      await delay(60);
      assert.equal(job(await f.call('status', { jobId: 'no-result' })).status, 'running');
      await f.call('stop');
      assert.equal(job(await f.call('status', { jobId: 'no-result' })).status, 'unknown');
    } finally { await f.cleanup(); }
  });
}

test('malformed initialization response fails promptly instead of leaving start pending', async () => {
  const f = setup();
  const command = join(f.dir, 'broken-init.cjs');
  writeFileSync(command, `#!${process.execPath}\n${fake}`); chmodSync(command, 0o700);
  const service = createKnowledgeWorker({ dataDir: f.dir, commands: { codex: command } });
  try {
    const start = await service.handlers['executor.knowledge.start']!({ provider: 'codex' }, () => {}) as JsonObject;
    assert.equal(start.state, 'failed'); assert.match(String(start.reason), /Invalid CLI RPC response/);
    assert.equal(start.pid, undefined);
  } finally { await service.close(); await f.cleanup(); }
});


for (const kind of ['commandExecution','mcpToolCall','webSearch','fileChange','requestUserInput','dynamicToolCall','futureTool','completionOnly']) {
  test(`codex: rejects native ${kind} without accepting a knowledge result`, async t => {
    const f = setup(); t.after(f.cleanup);
    const w = await f.call('start', {provider:'codex'});
    await f.call('submit', {workerId:w.workerId!,jobId:'native-test',prompt:`native-${kind}`});
    const status = await until(() => f.call('status', {jobId:'native-test'}), value => job(value).status !== 'running');
    assert.equal(job(status).status, 'failed');
    assert.equal(job(status).text, undefined);
    assert.doesNotMatch(JSON.stringify(status), /secret-auth/);
  });
}

test('codex: config/read failure prevents thread creation and never falls back', async t => {
  const f = setup(); t.after(f.cleanup);
  const file = join(f.dir, 'fake-cli.cjs');
  writeFileSync(file, readFileSync(file,'utf8').replace("result:{config:{mcp_servers:{'test.canary':{command:'never-run'}}}}", "error:{message:'secret-auth'}"));
  const state = await f.call('start', {provider:'codex'});
  assert.equal(state.state, 'failed');
  assert.equal(f.wire().filter(m => m.method === 'thread/start' || m.method === 'turn/start').length, 0);
  assert.doesNotMatch(JSON.stringify(state), /secret-auth/);
});

test('status explicitly echoes requested scope without inventing worker identity when no worker exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-worker-absent-'));
  const service = createKnowledgeWorker({ dataDir: dir });
  // No CLI is started: an empty pool can confirm only scoped absence.
  try {
    for (const scope of [{ layer: 'personal' }, { projectId: 'A', layer: 'project' }] as JsonObject[]) {
      const result = await service.handlers['executor.knowledge.status']!({ scope }, () => {}) as JsonObject;
      assert.deepEqual(result, { state: 'stopped', scope: scope.layer === 'personal' ? { layer: 'personal' } : { layer: 'project', projectId: 'A' }, pool: [] });
      for (const key of ['workerId', 'provider', 'sessionId', 'pid']) assert.equal(result[key], undefined);
    }
    const legacy = await service.handlers['executor.knowledge.status']!({}, () => {}) as JsonObject;
    assert.equal(legacy.scope, undefined);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('project purge stops only its scoped worker, validates files and is idempotent after restart', async () => {
  const f = setup();
  const target = { layer: 'project', projectId: 'A' }, other = { layer: 'project', projectId: 'B' };
  const cwd = (scope: typeof target) => join(f.dir, 'knowledge-workspace-' + createHash('sha256').update(JSON.stringify(scope)).digest('hex'));
  const purge = (service = f.service, params: JsonObject = { projectId: 'A' }) =>
    service.handlers['workspace.knowledge.purge']!(params, () => {});
  try {
    for (const scope of [other, target]) {
      const worker = await f.call('start', { scope, provider: 'codex' });
      await f.call('submit', { scope, workerId: worker.workerId!, jobId: scope.projectId, prompt: 'result-' + scope.projectId });
      await until(() => f.call('status', { scope, jobId: scope.projectId }), row => job(row).status === 'completed');
    }
    const native = join(f.dir, 'external-native');
    mkdirSync(native); writeFileSync(join(native, 'untouched'), 'native history');
    await assert.rejects(async () => purge(f.service, { projectId: 'A', cwd: native }));
    const link = join(cwd(target), 'redirect');
    symlinkSync(native, link);
    await assert.rejects(async () => purge());
    assert.equal((await f.call('status', { scope: target })).state, 'idle');
    assert.ok(existsSync(join(f.dir, 'knowledge-jobs', 'A.json')));
    rmSync(link);
    assert.deepEqual(await purge(), { projectId: 'A', purged: true });
    assert.equal(existsSync(cwd(target)), false);
    assert.equal(existsSync(join(f.dir, 'knowledge-jobs', 'A.json')), false);
    assert.equal((await f.call('status', { scope: target })).state, 'stopped');
    assert.equal((await f.call('status', { scope: other })).state, 'idle');
    assert.ok(existsSync(cwd(other)));
    assert.ok(existsSync(join(f.dir, 'knowledge-jobs', 'B.json')));
    assert.equal(readFileSync(join(native, 'untouched'), 'utf8'), 'native history');
    await f.service.close();
    const restarted = f.make();
    try { assert.deepEqual(await purge(restarted), { projectId: 'A', purged: true }); }
    finally { await restarted.close(); }
  } finally { await f.cleanup(); }
});
