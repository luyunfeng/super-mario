import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { createKnowledgeSourceReader, isProtectedKnowledgeURL } from '../plugins/knowledge-source-reader.ts';
import type { Job } from '../packages/core/src/knowledge-curator.ts';
import type { Json } from '../packages/protocol/src/index.ts';

const origin = 'https://tenant.feishu.cn';
const url = `${origin}/docx/Original`;
const secret = 'fake-private-profile-account-stdout';
const codeMaterial = '# HTML 教程\n\n```html\n<!doctype html><html><body><form>示例</form></body></html>\n```\n\n表单示例是资料。';
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 12000;
  while (!await check()) { assert.ok(Date.now() < deadline, '等待本地状态超时'); await delay(10); }
}
async function fixture(t: TestContext, config: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-reader-host-'));
  const configFile = join(dir, 'cli.json'), log = join(dir, 'calls.jsonl'), release = join(dir, 'release');
  await writeFile(configFile, JSON.stringify(config));
  // Absolute Node shebang and PATH containing only this fake exclude real lark-cli/accounts.
  await writeFile(join(dir, 'lark-cli'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
const id = args[args.indexOf(args[1] === '+inspect' ? '--url' : '--doc')+1];
const send = () => {
 if(cfg.error) { process.stderr.write(JSON.stringify({error:{type:'authorization',message:${JSON.stringify(secret)}}})); process.exitCode=1; return; }
 const data = args[1] === '+inspect' ? {type:'docx',token:id,title:'本地来源',url:${JSON.stringify(origin)}+'/docx/'+id} : {document:{document_id:id,content:cfg.body || '# 本地资料'}};
 process.stdout.write(JSON.stringify({ok:true,identity:'user',data}));
};
if(cfg.hold) { const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);send();}},10); } else send();
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = dir;
  const app = await createWorkbench({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  app.setKnowledgeSourceAccount(() => undefined); // This fixture has finished checking: no personal account.
  t.after(async () => {
    try { await app.close(); } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  });
  let submits = 0;
  let onSubmit: (() => void | Promise<void>) | undefined;
  app.setMachineClient({
    list: () => [{ id: 'fake', name: 'fake', online: true, platform: 'linux', connectedAt: 'now', capabilities: ['executor.knowledge.start'] }],
    async call(_id, method, input): Promise<Json> {
      if (method === 'executor.knowledge.start') return { workerId: 'fake-worker-' + JSON.stringify(input.scope), provider: 'codex', scope: input.scope };
      if (method === 'executor.knowledge.submit') { submits++; await onSubmit?.(); return {}; }
      if (method === 'executor.knowledge.status') return { workerId: 'fake-worker-' + JSON.stringify(input.scope), provider: 'codex', scope: input.scope, state: 'idle', ...(input.jobId ? { job: { id: input.jobId, scope: input.scope, status: 'completed', text: JSON.stringify({ pages: [{ title: '整理结果', content: '已验证资料' }] }) } } : {}) };
      return {};
    },
  });
  app.knowledgeSources.configure({ enabled: true, profile: secret });
  await app.knowledgeCurator.configure({ enabled: true, machineId: 'fake', provider: 'codex' });
  const calls = async (): Promise<string[][]> => {
    try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
  };
  const job = (id: string) => app.store.get<Job>('knowledge.sources', id)!;
  return { app, dir, calls, job, submits: () => submits, onSubmit: (fn: () => void | Promise<void>) => { onSubmit = fn; },
    release: () => writeFile(release, ''), config: (value: unknown) => writeFile(configFile, JSON.stringify(value)),
    raw: (id: string) => readFile(join(dir, 'plugins/knowledge-local/raw', `${id}.md`), 'utf8'),
    async terminal(id: string) { try { await until(() => ['completed', 'failed', 'unknown'].includes(job(id).status)); } catch { throw new Error(JSON.stringify({curator:app.knowledgeCurator.status(),plugins:app.plugins.list()})); } return job(id); },
  };
}
function forbidFetch(t: TestContext) {
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('受保护来源不得回退 public fetch'); });
}

test('personal account verification keeps protected sources queued and resumes after identity becomes available', async t => {
  const f = await fixture(t);
  let ready = false;
  f.app.knowledgeSources.configure({ enabled: true });
  f.app.setKnowledgeSourceAccount(() => ready ? { profile: secret, appId: 'fake-app', openId: 'fake-owner' } : undefined, () => ready);
  const job = f.app.knowledgeCurator.addSource({ url });
  await until(() => !!f.job(job.id).error);
  assert.equal(f.job(job.id).status, 'queued');
  assert.match(f.job(job.id).error!, /SOURCE_READER_NOT_READY/);
  assert.equal((await f.calls()).length, 0); assert.equal(f.submits(), 0);
  ready = true;
  assert.equal((await f.terminal(job.id)).status, 'completed');
  assert.equal(f.submits(), 1);
});
async function wrapper(f: Awaited<ReturnType<typeof fixture>>, handler: Parameters<import('../packages/plugin-sdk/src/index.ts').ExtensionContext['wrap']>[1]) {
  f.app.plugins.register({ id: 'reader-test-wrapper', name: '本地 wrapper', capabilities: [], dependencies: ['knowledge-local'], activate(c) { c.wrap('knowledge-local.source.read', handler, { timeoutMs: 30000 }); } });
  await f.app.plugins.start();
  assert.equal(f.app.plugins.list().find(p => p.id === 'reader-test-wrapper')!.status, 'active');
}

test('reserved 公开 host 的开发文档沿用真实 curator fetch；租户异常 scheme/port 仍受保护', async t => {
  const f = await fixture(t);
  f.app.knowledgeSources.configure({ enabled: false });
  const fetched: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => { fetched.push(input); return new Response('<html><p>公开文档</p></html>', { headers: { 'content-type': 'text/html' } }); });
  for (const host of ['open.feishu.cn', 'www.feishu.cn', 'open.larksuite.com', 'www.larkoffice.com']) {
    const input = `https://${host}/document/server-docs`;
    assert.equal(isProtectedKnowledgeURL(input), false);
    const job = f.app.knowledgeCurator.addSource({ url: input });
    assert.equal((await f.terminal(job.id)).status, 'completed');
    assert.match(await f.raw(job.id), /公开文档/);
    assert.equal(isProtectedKnowledgeURL(`https://${host}/docx/Private`), true);
  }
  for (const prefix of ['http://tenant.feishu.cn', 'https://tenant.feishu.cn:8443', 'https://tenant.feishu.cn:invalid', 'https://tenant.feishu.cn.']) {
    assert.equal(isProtectedKnowledgeURL(`${prefix}/document/login`), true);
  }
  assert.equal(isProtectedKnowledgeURL('https://open.feishu.cn/document', ['open.feishu.cn']), true);
  assert.equal(fetched.length, 4); assert.equal((await f.calls()).length, 0);
});

test('真实 fake CLI → reader → curator 保留 Markdown HTML 代码；实际登录 HTML 失败且不写 raw', async t => {
  forbidFetch(t);
  const f = await fixture(t, { body: codeMaterial });
  const good = f.app.knowledgeCurator.addSource({ url });
  assert.equal((await f.terminal(good.id)).status, 'completed');
  assert.ok((await f.raw(good.id)).includes(codeMaterial));
  for (const body of ['<!doctype html><html><body><form action="/login">登录</form></body></html>', '    <html><form>登录</form></html>', '<div>\n    <form action="/login">登录</form>\n</div>', '# 登录\n<form action="/login">登录</form>']) {
    await f.config({ body });
    const bad = f.app.knowledgeCurator.addSource({ url });
    assert.match((await f.terminal(bad.id)).error!, /INVALID_RESPONSE/);
    await assert.rejects(f.raw(bad.id), { code: 'ENOENT' });
  }
  assert.equal(f.submits(), 1);
});

test('curator 独立校验也接受代码示例、拒绝 wrapper 伪造的登录页', async t => {
  forbidFetch(t);
  const f = await fixture(t);
  let text = codeMaterial;
  await wrapper(f, async (input, next) => ({ ...await next(input) as Record<string, Json>, text }));
  const good = f.app.knowledgeCurator.addSource({ url });
  assert.equal((await f.terminal(good.id)).status, 'completed');
  text = '<html><form>登录</form></html>';
  const bad = f.app.knowledgeCurator.addSource({ url });
  assert.match((await f.terminal(bad.id)).error!, /INVALID_RESPONSE/);
  await assert.rejects(f.raw(bad.id), { code: 'ENOENT' }); assert.equal(f.submits(), 1);
});

test('wrapper 替换同域私文档在 CLI 前拒绝；无害 query 清理仍可读', async t => {
  forbidFetch(t);
  const f = await fixture(t);
  let target = `${origin}/docx/OtherPrivate`;
  await wrapper(f, async (_input, next) => next({ url: target }));
  const bad = f.app.knowledgeCurator.addSource({ url });
  assert.match((await f.terminal(bad.id)).error!, /CROSS_ORIGIN/);
  assert.equal((await f.calls()).length, 0); assert.equal(f.submits(), 0);
  target = url;
  const good = f.app.knowledgeCurator.addSource({ url: `${url}?share=discard#anchor` });
  assert.equal((await f.terminal(good.id)).status, 'completed');
  assert.ok((await f.raw(good.id)).includes('?share=discard#anchor'));
  assert.ok((await f.calls()).every(args => args.includes(secret)));
});

for (const reenable of [false, true]) test(`旧服务 await 返回不能写 raw/提交 worker，停用再启用=${reenable}`, async t => {
  forbidFetch(t);
  const f = await fixture(t);
  let ready = false, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  await wrapper(f, async (input, next) => { const result = await next(input); ready = true; await gate; return result; });
  const job = f.app.knowledgeCurator.addSource({ url });
  await until(() => ready);
  await f.app.plugins.setEnabled('knowledge-local', false);
  if (reenable) await f.app.plugins.setEnabled('knowledge-local', true);
  finish();
  assert.match((await f.terminal(job.id)).error!, /CONNECTION_CHANGED/);
  await assert.rejects(f.raw(job.id), { code: 'ENOENT' }); assert.equal(f.submits(), 0);
});

for (const change of ['account', 'settings'] as const) test(`${change} 代次变化丢弃旧 CLI 结果，诊断不泄露原始 profile/account`, async t => {
  forbidFetch(t);
  const f = await fixture(t, { hold: true });
  let account = { profile: secret, appId: 'fake-app', openId: 'private-account-one' };
  f.app.setKnowledgeSourceAccount(() => account);
  if (change === 'account') f.app.knowledgeSources.configure({ enabled: true });
  const job = f.app.knowledgeCurator.addSource({ url });
  await until(async () => (await f.calls()).length > 0);
  if (change === 'account') account = { ...account, openId: 'private-account-two' };
  else f.app.knowledgeSources.configure({ enabled: true, profile: 'another-private-profile' });
  await f.release();
  assert.match((await f.terminal(job.id)).error!, /CONNECTION_CHANGED/);
  const stored = JSON.stringify(f.job(job.id));
  for (const value of [secret, account.openId, 'another-private-profile']) assert.ok(!stored.includes(value));
  assert.equal(f.submits(), 0); await assert.rejects(f.raw(job.id), { code: 'ENOENT' });
});

test('缺配置绝不回退 default profile；CLI 拒绝时 stdout/account 仅转固定错误', async t => {
  forbidFetch(t);
  const f = await fixture(t, { error: true });
  f.app.knowledgeSources.configure({ enabled: true });
  const missing = f.app.knowledgeCurator.addSource({ url });
  assert.match((await f.terminal(missing.id)).error!, /MISSING_PROFILE/); assert.equal((await f.calls()).length, 0);
  f.app.knowledgeSources.configure({ enabled: true, profile: secret });
  const denied = f.app.knowledgeCurator.addSource({ url });
  assert.match((await f.terminal(denied.id)).error!, /UNAUTHORIZED/);
  assert.ok(!JSON.stringify(f.job(denied.id)).includes(secret));
  const calls = await f.calls(); assert.equal(calls.length, 1);
  assert.equal(calls[0]![calls[0]!.indexOf('--profile') + 1], secret);
  assert.equal(f.submits(), 0);
});

for (const phase of ['reading', 'worker'] as const) test(`project 在 ${phase} 中途归档后不导入，其他项目/人工页保留`, async t => {
  forbidFetch(t);
  const f = await fixture(t, phase === 'reading' ? { hold: true } : {});
  const project = f.app.projects.create({ name: '目标项目' });
  const personal = await f.app.knowledge().put({ layer: 'personal', title: '人工页', content: '人工修订' });
  const foreign = await f.app.knowledge().put({ layer: 'project', projectId: 'other-project', title: '其他项目', content: '保留' });
  const archive = () => { f.app.store.put('projects', project.id, { ...project, archivedAt: new Date().toISOString() }); };
  if (phase === 'worker') f.onSubmit(archive);
  const job = f.app.knowledgeCurator.addSource({ url, layer: 'project', projectId: project.id });
  if (phase === 'reading') { await until(async () => (await f.calls()).length > 0); archive(); await f.release(); }
  assert.match((await f.terminal(job.id)).error!, /归档/);
  const pages = await f.app.knowledge().list();
  assert.deepEqual(pages.map(p => p.id).sort(), [personal.id, foreign.id].sort());
  assert.equal(pages.find(p => p.id === personal.id)!.content, '人工修订');
  assert.equal(pages.find(p => p.id === foreign.id)!.content, '保留');
  if (phase === 'reading') { assert.equal(f.submits(), 0); await assert.rejects(f.raw(job.id), { code: 'ENOENT' }); }
});

test('Host 沿用 SDK use 的 30s/signal；close 中止真实子进程且迟到结果不写入', async t => {
  forbidFetch(t);
  const f = await fixture(t, { hold: true });
  const original = f.app.plugins.invocations.use;
  let request: { timeoutMs?: number; signal?: AbortSignal } | undefined;
  t.mock.method(f.app.plugins.invocations, 'use', async (name: string, input: Json, options?: { timeoutMs?: number; signal?: AbortSignal }) => { request = options; return original(name, input, options); });
  let wrapperCalls = 0;
  await wrapper(f, async (input, next, signal) => { wrapperCalls++; assert.equal(signal.aborted, false); return next(input); });
  const job = f.app.knowledgeCurator.addSource({ url });
  await until(async () => (await f.calls()).length > 0);
  assert.equal(request!.timeoutMs, 30000); assert.equal(request!.signal!.aborted, false); assert.equal(wrapperCalls, 1);
  const start = Date.now(); await f.app.knowledgeCurator.close();
  assert.ok(Date.now() - start < 1500); assert.equal(request!.signal!.aborted, true);
  await delay(100); assert.equal(f.submits(), 0); await assert.rejects(f.raw(job.id), { code: 'ENOENT' });
});

test('并发 SDK service 请求不继承另一 Job 的固定 URL 上下文', async t => {
  forbidFetch(t);
  const f = await fixture(t);
  let ready = false, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  await wrapper(f, async (input, next) => {
    if ((input as { url: string }).url === url) { ready = true; await gate; }
    return next(input);
  });
  const job = f.app.knowledgeCurator.addSource({ url });
  await until(() => ready);
  const other = `${origin}/docx/Independent`;
  const result = await f.app.plugins.invocations.use('knowledge-local.source.read', { url: other });
  assert.equal((result as { source: string }).source, other);
  finish(); assert.equal((await f.terminal(job.id)).status, 'completed');
  assert.ok((await f.calls()).some(args => args.includes('Independent')));
  assert.ok((await f.calls()).some(args => args.includes('Original')));
});

test('Reader 本地代码样例保留不同长度/tilde fence，代码之后的真实 HTML 仍拒绝', async () => {
  for (const body of ['# 示例\n~~~~html\n<html><form>样例</form></html>\n~~~~', '# 示例\n````html\n```\n<html>样例</html>\n````', codeMaterial]) {
    const reader = createKnowledgeSourceReader({ profile: 'fake', runCLI: async argv => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, identity: 'user', data: argv[1] === '+inspect' ? { type: 'docx', token: 'Original', title: '示例' } : { document: { document_id: 'Original', content: body } } }) }) });
    assert.equal((await reader.read(url)).text, body);
    // A wrapper cannot hide a login page merely by placing an empty code fence before it.
    const bad = createKnowledgeSourceReader({ profile: 'fake', runCLI: async argv => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, identity: 'user', data: argv[1] === '+inspect' ? { type: 'docx', token: 'Original', title: '示例' } : { document: { document_id: 'Original', content: `${body}\n<form>登录</form>` } } }) }) });
    await assert.rejects(bad.read(url), { code: 'INVALID_RESPONSE' });
  }
});

for (const elapsed of [5001, 30001]) test(`SDK Host service 使用实际 30s 预算：推进 ${elapsed}ms`, async t => {
  forbidFetch(t);
  const f = await fixture(t, { hold: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const job = f.app.knowledgeCurator.addSource({ url });
  await until(async () => (await f.calls()).length > 0);
  t.mock.timers.tick(elapsed);
  await delay(30);
  if (elapsed < 30000) {
    assert.equal(f.job(job.id).status, 'queued', '不能在 SDK 默认 5s 提前失败');
    await f.release();
    await until(() => f.job(job.id).status === 'running');
    t.mock.timers.reset();
    assert.equal((await f.terminal(job.id)).status, 'completed');
  } else {
    await until(() => f.job(job.id).status === 'failed');
    assert.ok(!f.job(job.id).error!.includes(secret));
    assert.equal(f.submits(), 0); await assert.rejects(f.raw(job.id), { code: 'ENOENT' });
    t.mock.timers.reset();
  }
});

test('service 正在 await CLI 时停用再启用：旧结果不可进入 raw', async t => {
  forbidFetch(t);
  const f = await fixture(t, { hold: true });
  const job = f.app.knowledgeCurator.addSource({ url });
  await until(async () => (await f.calls()).length > 0);
  await f.app.plugins.setEnabled('knowledge-local', false);
  await f.app.plugins.setEnabled('knowledge-local', true);
  await f.release();
  assert.match((await f.terminal(job.id)).error!, /CONNECTION_CHANGED/);
  assert.equal((await f.calls()).length, 2); assert.equal(f.submits(), 0);
  await assert.rejects(f.raw(job.id), { code: 'ENOENT' });
});

test('wrapper await 期间 settings 换代：实际 CLI 前拒绝；wrapper 原始诊断不进 job', async t => {
  forbidFetch(t);
  const f = await fixture(t);
  let ready = false, finish!: () => void, leak = false;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  await wrapper(f, async (input, next) => {
    if (leak) throw new Error(secret);
    ready = true; await gate; return next(input);
  });
  const job = f.app.knowledgeCurator.addSource({ url });
  await until(() => ready);
  f.app.knowledgeSources.configure({ enabled: true, profile: 'new-private-profile' });
  finish();
  assert.match((await f.terminal(job.id)).error!, /CONNECTION_CHANGED/);
  assert.equal((await f.calls()).length, 0); assert.equal(f.submits(), 0);
  leak = true;
  const bad = f.app.knowledgeCurator.addSource({ url });
  assert.match((await f.terminal(bad.id)).error!, /SOURCE_READ_FAILED/);
  assert.ok(!JSON.stringify(f.job(bad.id)).includes(secret));
  assert.equal((await f.calls()).length, 0); assert.equal(f.submits(), 0);
});
