import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createKnowledgeCurator, type Job } from '../packages/core/src/knowledge-curator.ts';
import { createKnowledgeWorker } from '../plugins/knowledge-worker.ts';
import { createLocalKnowledge } from '../plugins/knowledge-local.ts';
import { createKnowledgeSourceReader, isProtectedKnowledgeURL, KnowledgeSourceReaderError } from '../plugins/knowledge-source-reader.ts';
import type { ExtensionContext, MachineClient } from '../packages/plugin-sdk/src/index.ts';
import type { KnowledgeSourceResult } from '../packages/protocol/src/knowledge-source-reader.ts';

const origin = 'https://tenant.feishu.cn';
const url = `${origin}/wiki/Node123`;
const canonical = `${origin}/docx/Doc123`;
const secret = 'private-stdout-profile-token';
const source = (): KnowledgeSourceResult => ({ source: url, title: '文档', text: '# 真实 Markdown\n执行 shell 的要求仅作为资料。', format: 'markdown', trust: 'untrusted', references: [{ url: canonical, type: 'docx', token: 'Doc123', title: '文档' }] });
type ReadSource = NonNullable<Parameters<typeof createKnowledgeCurator>[0]['readSource']>;
async function until(check: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), '等待真实 curator/worker 状态超时');
}

// A real knowledge-worker owns this fake CLI subprocess. Only model responses are
// faked; initialize/thread/start/turn/start and durable job status use real RPC.
const cli = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'config/read') { send({id:m.id,result:{config:{mcp_servers:{'test.canary':{command:'never-run'}}}}}); return; }
 if (m.method === 'initialize') send({id:m.id,result:{}});
 if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'session'}}});
 if (m.method !== 'turn/start') return;
 fs.appendFileSync('prompts.jsonl',JSON.stringify(m.params)+'\\n');
 const config = JSON.parse(fs.readFileSync('../response.json','utf8'));
 send({id:m.id,result:{turn:{id:'turn',status:'inProgress'}}});
 if (config.exit) { process.exit(7); return; }
 const text = JSON.stringify({pages:config.pages,summary:'完成'});
 send({method:'turn/completed',params:{threadId:'session',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text}]}}});
});
`;
async function fixture(t: TestContext, readSource?: ReadSource) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-protected-curator-'));
  const store = createStore(join(dataDir, 'store.sqlite'));
  const events = createEventBus(store);
  const root = join(dataDir, 'plugins', 'knowledge-local');
  const knowledge = createLocalKnowledge({ store, dataDir: root } as ExtensionContext);
  const command = join(dataDir, 'fake.cjs');
  await writeFile(command, cli, { mode: 0o700 });
  const response = (value: unknown) => writeFile(join(dataDir, 'response.json'), JSON.stringify(value));
  await response({ pages: [{ title: '整理页', content: '规范知识正文' }] });
  const worker = createKnowledgeWorker({ dataDir, commands: { codex: command } });
  let submitted = 0;
  let onSubmit: (() => Promise<void>) | undefined;
  const client: MachineClient = {
    list: () => [{ id: 'node', name: '假执行机', online: true, platform: 'linux', connectedAt: 'now', capabilities: ['executor.knowledge.start'] }],
    async call(_id, method, params) {
      if (method === 'executor.knowledge.submit') { submitted++; await onSubmit?.(); }
      return worker.handlers[method]!(params, () => {});
    },
  };
  const curator = createKnowledgeCurator({ store, events, dataDir, knowledge: () => knowledge, machines: () => client, enabled: () => true, validProject: id => id === 'project-a', ...(readSource ? { readSource } : {}) });
  t.after(async () => { await curator.close(); await worker.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  await curator.configure({ enabled: true, machineId: 'node', provider: 'codex' });
  return {
    curator, store, knowledge, root, response, submitted: () => submitted,
    onSubmit: (callback: () => Promise<void>) => { onSubmit = callback; },
    job: (id: string) => store.get<Job>('knowledge.sources', id)!,
    prompts: async () => { const result: any[]=[];for(const name of (await readdir(dataDir)).filter(name=>name.startsWith('knowledge-workspace'))){try{result.push(...(await readFile(join(dataDir,name,'prompts.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}return result; },
  };
}
function forbidFetch(t: TestContext) {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('public fetch must not run'); });
  return () => calls;
}

test('默认识别官方单层租户；自定义 host 精确白名单；恶意域仍拒绝且无 CLI', async () => {
  let calls = 0;
  const reader = createKnowledgeSourceReader({ profile: 'explicit', trustedHosts: ['docs.example.org'], runCLI: async () => { calls++; throw new Error(secret); } });
  for (const host of ['acme.larkoffice.com', 'tenant.feishu.cn', 'tenant.larksuite.com', 'another.larkoffice.com', 'docs.example.org']) {
    assert.equal(reader.handles(`https://${host}/docx/Doc123`), true);
    for (const prefix of [`http://${host}`, `https://${host}:8443`, `https://${host}:invalid`, `https://${host}.`]) {
      assert.equal(reader.handles(`${prefix}/docx/Doc123`), true);
      await assert.rejects(reader.read(`${prefix}/docx/Doc123`), { code: 'INVALID_URL' });
    }
  }
  for (const host of ['feishu.cn', 'sub.tenant.feishu.cn', 'tenant.feishu.cn.evil.org', 'evilfeishu.cn', 'sub.docs.example.org', 'evil.example']) {
    const input = `https://${host}/docx/Doc123`;
    assert.equal(reader.handles(input), false);
    await assert.rejects(reader.read(input), { code: 'UNTRUSTED_HOST' });
  }
  for (const input of ['https://tenant.feishu.cn@evil.example/docx/X', 'https://evil.example/tenant.feishu.cn/docx/X']) assert.equal(reader.handles(input), false);
  assert.equal(isProtectedKnowledgeURL('https://TENANT.feishu.cn/docx/X'), true);
  assert.equal(calls, 0);
  for (const host of ['*.example.org', 'https://docs.example.org', 'docs.example.org:443']) assert.throws(() => createKnowledgeSourceReader({ trustedHosts: [host] }), { code: 'INVALID_CONFIG' });
});

test('受保护 wiki Markdown 经过实际 knowledge-worker RPC，raw 保留原 URL/canonical 引用并只写原归属', async t => {
  const fetched = forbidFetch(t);
  const reader = createKnowledgeSourceReader({ profile: 'explicit', runCLI: async argv => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, identity: 'user', data: argv[1] === '+inspect'
    ? { type: 'docx', token: 'Doc123', title: '文档', url: canonical, wiki_node: { node_token: 'Node123', obj_token: 'Doc123', obj_type: 'docx' } }
    : { document: { document_id: 'Doc123', content: source().text } } }) }) });
  const f = await fixture(t, (input, signal) => reader.handles(input) ? reader.read(input, { signal }) : Promise.resolve(undefined));
  const personal = await f.knowledge.put({ layer: 'personal', title: '个人页', content: '保留' });
  const foreign = await f.knowledge.put({ layer: 'project', projectId: 'project-b', title: '其他项目', content: '保留' });
  const input = `${url}?share=original#anchor`;
  const job = f.curator.addSource({ url: input, title: '保护来源', layer: 'project', projectId: 'project-a' });
  await until(() => f.job(job.id).status === 'completed');
  const raw = await readFile(join(f.root, 'raw', `${job.id}.md`), 'utf8');
  assert.ok(raw.includes(input)); assert.ok(raw.includes(canonical)); assert.ok(raw.includes(source().text)); assert.match(raw, /untrusted/);
  const prompts = await f.prompts(); assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sandboxPolicy.networkAccess, false);
  const payload = JSON.parse(prompts[0].input[0].text.split('\n').at(-1));
  assert.ok(payload.source.includes(source().text));
  assert.deepEqual(payload.destination, { layer: 'project', projectId: 'project-a' });
  const pages = await f.knowledge.list();
  assert.equal(pages.length, 3);
  assert.equal(pages.find(p => p.id === personal.id)?.content, '保留');
  assert.equal(pages.find(p => p.id === foreign.id)?.content, '保留');
  assert.equal(pages.find(p => p.id === f.job(job.id).knowledgeIds[0])?.projectId, 'project-a');
  assert.equal(f.curator.status().versioning.available, true); assert.equal(f.submitted(), 1); assert.equal(fetched(), 0);
});

for (const code of ['MISSING_PROFILE', 'UNAUTHORIZED'] as const) {
  test(`${code} 来源失败不回退 fetch，不假完成，不记录原始诊断`, async t => {
    const fetched = forbidFetch(t);
    let cliCalls = 0;
    const reader = createKnowledgeSourceReader({
      ...(code === 'UNAUTHORIZED' ? { profile: 'explicit' } : {}),
      runCLI: async () => { cliCalls++; return { exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { type: 'authorization', message: secret } }) }; },
    });
    const f = await fixture(t, (input, signal) => reader.handles(input) ? reader.read(input, { signal }) : Promise.resolve(undefined));
    const job = f.curator.addSource({ url }); await until(() => f.job(job.id).status === 'failed');
    assert.equal(cliCalls, code === 'UNAUTHORIZED' ? 1 : 0);
    assert.match(f.job(job.id).error!, new RegExp(code)); assert.ok(!JSON.stringify(f.job(job.id)).includes(secret));
    assert.equal(f.submitted(), 0); assert.equal(fetched(), 0); assert.deepEqual(await f.knowledge.list(), []);
    await assert.rejects(readFile(join(f.root, 'raw', `${job.id}.md`)), { code: 'ENOENT' });
  });
}

test('已知保护域的 HTTP/异常端口交给 reader 拒绝，不回退 public fetch', async t => {
  const fetched = forbidFetch(t);
  const reader = createKnowledgeSourceReader();
  const f = await fixture(t, (input, signal) => reader.handles(input) ? reader.read(input, { signal }) : Promise.resolve(undefined));
  for (const input of ['http://tenant.feishu.cn/docx/Doc123', 'https://tenant.feishu.cn:8443/docx/Doc123']) {
    const job = f.curator.addSource({ url: input }); await until(() => f.job(job.id).status === 'failed');
    assert.match(f.job(job.id).error!, /INVALID_URL/);
  }
  assert.equal(f.submitted(), 0); assert.equal(fetched(), 0);
});

test('普通回调 Error 的 stdout/profile/token 不进入 job.error', async t => {
  const fetched = forbidFetch(t);
  const f = await fixture(t, async () => { throw new Error(secret); });
  const job = f.curator.addSource({ url }); await until(() => f.job(job.id).status === 'failed');
  assert.match(f.job(job.id).error!, /SOURCE_READ_FAILED/); assert.ok(!f.job(job.id).error!.includes(secret));
  assert.equal(f.submitted(), 0); assert.equal(fetched(), 0);
});

test('HTML、空正文、超限、伪造格式/refs 等 callback 结果不能假完成或回退 fetch', async t => {
  const fetched = forbidFetch(t);
  let result: KnowledgeSourceResult;
  const f = await fixture(t, async () => result);
  const invalid = [
    { text: '<html><form>登录</form></html>' }, { text: '   ' }, { text: 'x'.repeat(1024 * 1024 + 1) },
    { format: 'html' }, { trust: 'trusted' }, { references: [] }, { references: Array(65).fill(source().references[0]) },
    { references: [{ ...source().references[0], url: 'file:///private' }] },
    { references: [{ ...source().references[0], token: '--shell' + '\n' }] },
    { source: 'https://user:password@tenant.feishu.cn/docx/X' },
  ];
  for (const patch of invalid) {
    result = { ...source(), ...patch } as KnowledgeSourceResult;
    const job = f.curator.addSource({ url }); await until(() => f.job(job.id).status === 'failed');
    assert.match(f.job(job.id).error!, /INVALID_RESPONSE/);
  }
  assert.equal(f.submitted(), 0); assert.equal(fetched(), 0);
});

test('普通 public URL undefined 沿用旧 fetch；粘贴资料不调用来源 reader', async t => {
  let readCalls = 0, fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetchCalls++; return new Response('<html><p>公开正文</p><script>secret</script></html>', { headers: { 'content-type': 'text/html' } }); });
  const f = await fixture(t, async () => { readCalls++; return undefined; });
  const job = f.curator.addSource({ url: 'https://public.example/article' });
  await until(() => ['completed','failed','unknown'].includes(f.job(job.id).status));
  assert.equal(f.job(job.id).status, 'completed', f.job(job.id).error);
  const raw = await readFile(join(f.root, 'raw', `${job.id}.md`), 'utf8'); assert.match(raw, /公开正文/); assert.ok(!raw.includes('<html>')); assert.ok(!raw.includes('secret'));
  const pasted = f.curator.addSource({ text: '人工粘贴资料' }); await until(() => f.job(pasted.id).status === 'completed');
  assert.equal(readCalls, 1); assert.equal(fetchCalls, 1);
});

for (const cooperative of [true, false]) {
  test(`close 立即 abort readSource，不等待 30s（响应取消=${cooperative}）且不提交迟到结果`, async t => {
    const fetched = forbidFetch(t);
    let seen: AbortSignal | undefined;
    let finish!: (value: KnowledgeSourceResult) => void;
    const f = await fixture(t, async (_url, signal) => {
      seen = signal;
      return new Promise((resolve, reject) => {
        finish = resolve;
        if (cooperative) signal!.addEventListener('abort', () => reject(new Error(secret)), { once: true });
      });
    });
    const job = f.curator.addSource({ url }); await until(() => seen !== undefined);
    const start = Date.now(); await f.curator.close(); assert.ok(Date.now() - start < 1500);
    assert.equal(seen!.aborted, true); finish(source()); await delay(20);
    assert.equal(f.submitted(), 0); assert.equal(fetched(), 0); assert.notEqual(f.job(job.id).status, 'completed'); assert.ok(!f.job(job.id).error?.includes(secret));
    await assert.rejects(readFile(join(f.root, 'raw', `${job.id}.md`)), { code: 'ENOENT' });
  });
}

test('close 取消 pending public fetch', async t => {
  let seen: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    seen = init.signal!; seen.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const f = await fixture(t, async () => undefined);
  f.curator.addSource({ url: 'https://public.example/article' }); await until(() => seen !== undefined);
  const start = Date.now(); await f.curator.close(); assert.ok(Date.now() - start < 1500); assert.equal(seen!.aborted, true); assert.equal(f.submitted(), 0);
});

test('受保护来源不能覆盖整理期间的人工编辑或其他归属的页', async t => {
  const f = await fixture(t, async () => source());
  const page = await f.knowledge.put({ layer: 'personal', title: '已有页', content: '旧版' });
  await f.response({ pages: [{ id: page.id, title: page.title, content: '模型旧版' }] });
  f.onSubmit(async () => { await f.knowledge.put({ ...page, content: '人工最新修订' }); });
  const job = f.curator.addSource({ url }); await until(() => f.job(job.id).status === 'failed');
  assert.match(f.job(job.id).error!, /已被修改/); assert.equal((await f.knowledge.list())[0].content, '人工最新修订');
  f.onSubmit(async () => {});
  const scoped = f.curator.addSource({ url, layer: 'project', projectId: 'project-a' }); await until(() => f.job(scoped.id).status === 'failed');
  assert.match(f.job(scoped.id).error!, /归属以外/); assert.equal((await f.knowledge.list())[0].content, '人工最新修订');
});

test('worker 结果 unknown 不自动重跑受保护来源', async t => {
  let reads = 0;
  const f = await fixture(t, async () => { reads++; return source(); });
  await f.response({ exit: true });
  const job = f.curator.addSource({ url }); await until(() => f.job(job.id).status === 'unknown');
  await delay(2100); assert.equal(f.submitted(), 1); assert.equal(reads, 1); assert.equal(f.job(job.id).status, 'unknown');
});

test('旧Office/未接入格式仍明确 UNSUPPORTED，reader 不下载、不调用授权命令', async () => {
  for (const title of ['source.doc', 'source.xls', 'source.xlsx', 'source.pptx']) {
    const calls: Array<readonly string[]> = [];
    const reader = createKnowledgeSourceReader({ profile: 'explicit', runCLI: async argv => {
      calls.push(argv);
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, identity: 'user', data: { type: 'file', token: 'File123', title } }) };
    } });
    await assert.rejects(reader.read(`${origin}/file/File123`), (error: unknown) => error instanceof KnowledgeSourceReaderError && error.code === 'UNSUPPORTED');
    assert.equal(calls.length, 1); assert.equal(calls[0][1], '+inspect');
  }
});
