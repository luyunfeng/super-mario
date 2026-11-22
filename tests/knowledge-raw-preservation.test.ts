import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createKnowledgeCurator, type Job } from '../packages/core/src/knowledge-curator.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createLocalKnowledge } from '../plugins/knowledge-local.ts';
import type { ExtensionContext, MachineClient } from '../packages/plugin-sdk/src/index.ts';
import type { KnowledgeSourceResult } from '../packages/protocol/src/knowledge-source-reader.ts';

const url = 'https://synthetic.example/docx/Synthetic';
const tail = 'RAW_TAIL_secret_profile_marker';
const long = 'a'.repeat(210000) + tail;
const normalized = (text: string): KnowledgeSourceResult => ({ source: url, title: 'Synthetic', text, format: 'text', trust: 'untrusted', references: [{ url, title: 'Reference', type: 'docx', token: 'Synthetic' }] });
async function fixture(t: TestContext, readSource?: Parameters<typeof createKnowledgeCurator>[0]['readSource']) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-raw-'));
  const store = createStore(join(dir, 'store.sqlite'));
  const knowledge = createLocalKnowledge({ store, dataDir: join(dir, 'plugins', 'knowledge-local') } as ExtensionContext);
  const submissions: string[] = [];
  let valid = true;
  const client: MachineClient = {
    list: () => [{ id: 'node', name: 'Synthetic', online: true, platform: 'linux', connectedAt: 'now', capabilities: ['executor.knowledge.start'] }],
    async call(_id, method, params) {
      if (method === 'executor.knowledge.submit') { submissions.push(String(params.prompt)); return {}; }
      return { workerId: 'worker-' + JSON.stringify(params.scope), provider: 'codex', scope: params.scope, state: 'idle', ...(params.jobId ? { job: { id: params.jobId, scope: params.scope, status: 'completed', text: JSON.stringify({ pages: [{ title: '整理', content: '短源整理结果' }] }) } } : {}) };
    },
  };
  t.mock.timers.enable({ apis: ['setInterval'] });
  const make = () => createKnowledgeCurator({ store, events: createEventBus(store), dataDir: dir, knowledge: () => knowledge, machines: () => client, enabled: () => true, validProject: () => valid, readSource });
  let curator = make();
  t.after(async () => { await curator.close(); store.close(); t.mock.timers.reset(); await rm(dir, { recursive: true, force: true }); });
  await curator.configure({ enabled: true, machineId: 'node', provider: 'codex' });
  const job = (id: string) => store.get<Job>('knowledge.sources', id)!;
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 200; i++) { if (predicate()) return; t.mock.timers.tick(2000); await delay(10); }
    assert.fail('curator queue did not settle');
  }
  return { dir, store, knowledge, submissions, job, until, get curator() { return curator; }, archive: () => { valid = false; },
    raw: (id: string) => join(dir, 'plugins', 'knowledge-local', 'raw', id + '.md'),
    restart: async () => { await curator.close(); curator = make(); } };
}
function failed(job: Job) {
  assert.equal(job.status, 'failed');
  assert.match(job.error!, /200000/);
  assert.match(job.error!, /预算/);
  assert.match(job.error!, /原始资料已保存/);
  assert.match(job.error!, /拆分/);
  assert.doesNotMatch(job.error!, /synthetic|secret|profile|RAW_TAIL/);
}

for (const kind of ['HTTP', 'protected'] as const) test(`${kind}: 保存完整长正文与引用，预算失败且零 submit`, async t => {
  const f = await fixture(t, kind === 'protected' ? async () => normalized(long) : undefined);
  let source = url;
  if (kind === 'HTTP') {
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(long); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    source = `http://127.0.0.1:${(server.address() as { port: number }).port}/synthetic`;
  }
  const job = f.curator.addSource({ url: source });
  await f.until(() => ['running', 'failed'].includes(f.job(job.id).status));
  const raw = await readFile(f.raw(job.id), 'utf8');
  assert.ok(raw.endsWith(long), `raw 丢失尾部标记；实际长度 ${raw.length}`);
  assert.ok(raw.includes(source));
  if (kind === 'protected') assert.ok(raw.includes(JSON.stringify(normalized(long).references)));
  failed(f.job(job.id)); assert.equal(f.submissions.length, 0);
});

test('完整 source 头信息计入预算；短源仍完成真实知识写入', async t => {
  const f = await fixture(t);
  const large = f.curator.addSource({ text: 'b'.repeat(200000) });
  await f.until(() => ['running', 'failed'].includes(f.job(large.id).status));
  assert.ok((await readFile(f.raw(large.id), 'utf8')).endsWith('b'.repeat(200000)));
  failed(f.job(large.id)); assert.equal(f.submissions.length, 0);
  const short = f.curator.addSource({ text: 'SHORT_SOURCE_FULL' });
  await f.until(() => f.job(short.id).status === 'completed');
  assert.equal(f.submissions.length, 1); assert.ok(f.submissions[0]!.includes('SHORT_SOURCE_FULL'));
  assert.equal((await f.knowledge.list()).length, 1);
});

test('重启读取已有长缓存仍受预算限制，不重读原文或 submit', async t => {
  let reads = 0;
  const f = await fixture(t, async () => { reads++; return normalized('should not read'); });
  await f.curator.close();
  const job = f.curator.addSource({ url }); // closed curator only persists the queued job
  await mkdir(join(f.dir, 'plugins', 'knowledge-local', 'raw'), { recursive: true });
  const cached = '# cached\n' + long;
  await writeFile(f.raw(job.id), cached);
  await f.restart();
  await f.until(() => ['running', 'failed'].includes(f.job(job.id).status));
  failed(f.job(job.id)); assert.equal(reads, 0); assert.equal(f.submissions.length, 0);
  assert.equal(await readFile(f.raw(job.id), 'utf8'), cached);
});

for (const action of ['cancel', 'archive'] as const) test(`${action}: 读取中止后不保存 late raw、不 submit`, async t => {
  let release!: (value: KnowledgeSourceResult) => void;
  let started = false;
  const f = await fixture(t, async () => { started = true; return new Promise(resolve => { release = resolve; }); });
  const job = f.curator.addSource({ url, layer: 'project', projectId: 'p' });
  await f.until(() => started);
  if (action === 'cancel') await f.curator.close(); else f.archive();
  release(normalized(long));
  await f.until(() => f.job(job.id).status === 'failed');
  assert.match(f.job(job.id).error!, action === 'cancel' ? /CANCELLED/ : /归档/);
  await assert.rejects(readFile(f.raw(job.id)), { code: 'ENOENT' });
  assert.equal(f.submissions.length, 0);
});

test('重复采集会议文档在重启后仍只整理一份，个人知识保留正文和原消息来源', async t => {
  let reads = 0;
  const f = await fixture(t, async () => { reads++; return normalized('会议决定：以合成数据验收。'); });
  const provenance = { requestOrigin: 'meeting' as const, sourceMessageId: 'inbox-1', sourceKey: 'account/docx/Synthetic' };
  const input = { layer: 'personal', url };
  assert.throws(() => f.curator.addSource({ ...input, layer: 'project', projectId: 'p' }, provenance), /个人未分类/);
  assert.throws(() => f.curator.addSource({ ...input, text: '通知预览' }, provenance), /须通过来源读取器/);
  const job = f.curator.addSource(input, provenance);
  assert.equal(f.job(job.id).sourceKey, provenance.sourceKey);
  assert.equal(f.curator.addSource(input, { ...provenance, sourceMessageId: 'inbox-2' }).id, job.id);
  await f.until(() => f.job(job.id).status === 'completed');
  const [page] = await f.knowledge.list({ layer: 'personal' });
  assert.ok(page?.content.includes(url));
  assert.ok(page.content.includes('来源收件记录：inbox-1'));
  assert.match(f.submissions[0]!, /保留支撑决定的原文时间戳/);
  assert.match(f.submissions[0]!, /只有意见分歧时保留分歧/);
  assert.match(f.submissions[0]!, /不用提问日或资料保存日代替会议日/);
  assert.match(f.submissions[0]!, /会议决定：以合成数据验收/);
  assert.match(await readFile(f.raw(job.id), 'utf8'), /以合成数据验收/);
  await f.restart();
  const evidence = await f.curator.pageSources(page.id);
  assert.deepEqual(evidence.sources?.map(row => row.id), [job.id]);
  const original = await f.curator.pageSources(page.id, job.id);
  await assert.rejects(f.curator.pageSources(page.id, job.id, undefined, true), /不是已核对的会议转写/);
  assert.equal(original.content, await readFile(f.raw(job.id), 'utf8'));
  assert.equal(f.curator.addSource(input, provenance).status, 'completed');
  assert.equal(f.curator.status().jobs.length, 1);
  assert.equal(reads, 1);
});

test('会议文档未被受保护读取器接管时，初次整理与显式重试均不发起公网请求', async t => {
  let reads = 0;
  const f = await fixture(t, async () => { reads++; return undefined; });
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('unexpected fetch'); });
  const provenance = { requestOrigin: 'meeting' as const, sourceMessageId: 'inbox-1', sourceKey: 'account/docx/Synthetic' };
  const job = f.curator.addSource({ url }, provenance);
  await f.until(() => f.job(job.id).status === 'failed');
  assert.match(f.job(job.id).error!, /MEETING_READER_REQUIRED/);
  assert.equal(f.curator.addSource({ url }, provenance).status, 'failed');
  const retry = f.curator.retry(job.id);
  assert.equal(retry.sourceMessageId, job.sourceMessageId);
  assert.equal(f.job(retry.id).sourceKey, provenance.sourceKey);
  await f.until(() => f.job(retry.id).status === 'failed');
  assert.match(f.job(retry.id).error!, /MEETING_READER_REQUIRED/);
  assert.equal(reads, 2);
  assert.equal(network.mock.callCount(), 0);
  assert.equal(f.submissions.length, 0);
});

test('核对后的项目会议转写按会议提示词整理，重复提交复用任务', async t => {
  const f = await fixture(t);
  const input = { materialKind: 'meeting-transcript', speakerNames: { A: '样本发言人' }, title: '样本评审', text: '提议周五复核，负责人未定。', meetingStartedAt: '2032-02-29T00:10+05:45', layer: 'project', projectId: 'sample' };
  assert.throws(() => f.curator.addSource({ ...input, meetingStartedAt: '2031-02-29T00:10+05:45' }), /有效日期/);
  assert.throws(() => f.curator.addSource({ ...input, meetingStartedAt: '2032-02-29T00:10' }), /UTC 偏移/);
  const job = f.curator.addSource(input);
  await f.until(() => f.job(job.id).status === 'completed');
  assert.ok(f.submissions[0]!.includes('用户填写的会议开始时间：2032-02-29T00:10:00+05:45'));
  assert.match(f.submissions[0]!, /不用上传时间推算相对期限/);
  assert.match(f.submissions[0]!, /识别有歧义的人名、数字和术语保留原话/);
  assert.match(f.submissions[0]!, /不能由片段结尾推断会议已结束/);
  assert.match(f.submissions[0]!, /暂停时段没有录音证据/);
  assert.match(f.submissions[0]!, /未核实的人名不作对应/);
  assert.match(f.submissions[0]!, /按议题区分已决定事项、提议、行动项和未决问题/);
  const [page] = await f.knowledge.list({ projectId: 'sample' });
  assert.match(page!.content, /用户核对的会议转写/);
  assert.ok(page!.content.includes('会议开始时间：2032-02-29T00:10:00+05:45'));
  assert.ok((await readFile(f.raw(job.id), 'utf8')).endsWith(input.text));
  await f.restart();
  const { sources } = await f.curator.pageSources(page!.id, undefined, 'sample');
  assert.deepEqual(sources?.[0].speakerNames, { A: '样本发言人' });
  assert.match(f.submissions[0]!, /本次录音由用户核对的说话人/);
  assert.equal(sources?.[0].meetingStartedAt, '2032-02-29T00:10:00+05:45');
  const original = await f.curator.pageSources(page!.id, job.id, 'sample');
  assert.ok(original.content?.endsWith(input.text));
  const attachment = await f.curator.pageSources(page!.id, job.id, 'sample', true);
  assert.equal(attachment.content, input.text);
  assert.equal(attachment.truncated, false);
  assert.equal(f.curator.addSource({ ...input, meetingStartedAt: '2032-02-29T00:10:00+05:45' }).id, job.id);
  assert.notEqual(f.curator.addSource({ ...input, meetingStartedAt: '2032-03-01T00:10+05:45' }).id, job.id);
  assert.throws(() => f.curator.addSource({ ...input, speakerNames: { A: '甲\n乙' } }), /单行文本/);
  const legacy = createHash('sha256').update(JSON.stringify([input.layer, input.projectId, input.title, input.text])).digest('hex');
  assert.equal(f.curator.addSource({ ...input, meetingStartedAt: undefined, speakerNames: undefined }).id, 'transcript-' + legacy);
  assert.equal(f.submissions.length, 1);
  assert.throws(() => f.curator.addSource({ ...input, url }), /须提供正文/);
  f.archive();
  assert.throws(() => f.curator.addSource(input), /有效的未归档项目/);
});

test('会议日回顾按用户时区跨夏令时分页，重试只列一次并校验知识页现归属', async t => {
  const f = await fixture(t);
  const same = await f.knowledge.put({ title: '可见页', content: '意见待核对', layer: 'project', projectId: 'sample' });
  const moved = await f.knowledge.put({ title: '其他范围', content: '独立资料', layer: 'personal' });
  const base: Job = { id: 'first', title: '秋季评审', layer: 'project', projectId: 'sample', status: 'failed', knowledgeIds: [],
    materialKind: 'meeting-transcript', meetingStartedAt: '2030-11-03T01:30:00-04:00', createdAt: '2030-11-04T12:00:00Z', updatedAt: '2030-11-04T12:00:00Z' };
  const put = (id: string, patch: Partial<Job>) => f.store.put('knowledge.sources', id, { ...base, ...patch, id });
  put(base.id, {});
  put('retry', { retryOf: base.id, status: 'completed', knowledgeIds: [same.id, moved.id] });
  for (let i = 0; i < 25; i++) put('later-' + i, { meetingStartedAt: '2030-11-03T01:30:00-05:00', status: 'queued' });
  put('last', { meetingStartedAt: '2030-11-04T04:59:59Z' });
  put('next-day', { meetingStartedAt: '2030-11-04T05:00:00Z' });
  put('undated', { meetingStartedAt: undefined });
  const read = (offset = 0) => f.curator.meetingDay('2030-11-03', 'America/New_York', 'sample', offset);
  const first = await read();
  assert.equal(first.total, 27);
  assert.equal(first.undated, 1);
  assert.equal(first.nextOffset, 25);
  assert.equal(first.meetings[0].sourceId, 'retry');
  assert.deepEqual(f.curator.renameMeeting('retry', { expectedTitle: base.title, title: '已核对的评审名称' }), { title: '已核对的评审名称' });
  assert.equal((await read()).meetings[0].title, '已核对的评审名称');
  const search = (query: string, offset = 0) => f.curator.searchMeetings(query, 'sample', offset);
  const renamed = await search('核对的评审');
  assert.equal(renamed.total, 1);
  assert.deepEqual(renamed.meetings[0].pages, [{ id: same.id, title: same.title }]);
  const original = await search(base.title);
  assert.equal(original.nextOffset, 25);
  assert.ok(original.meetings.some(row => row.sourceId === 'undated' && row.startedAt === null));
  const remaining = await search(base.title, original.nextOffset!);
  assert.ok(remaining.meetings.some(row => row.sourceId === 'retry' && row.title === '已核对的评审名称'));
  assert.equal(remaining.nextOffset, null);
  assert.throws(() => f.curator.renameMeeting(base.id, { expectedTitle: base.title, title: '并发修改' }), /标题已变化/);
  assert.equal((await f.curator.pageSources(same.id)).sources?.[0].title, '已核对的评审名称');
  await f.restart();
  assert.equal((await read()).meetings[0].title, '已核对的评审名称');
  assert.equal(f.curator.renameMeeting(base.id, { expectedTitle: '已核对的评审名称', title: '' }).title, base.title);
  assert.equal((await read()).meetings[0].title, base.title);
  assert.deepEqual(first.meetings[0].pages, [{ id: same.id, title: same.title }]);
  const last = await read(first.nextOffset!);
  assert.equal(last.meetings.length, 2);
  assert.equal(last.meetings.at(-1)?.sourceId, 'last');
  assert.equal(last.nextOffset, null);
  await assert.rejects(f.curator.meetingDay('2030-02-31', 'UTC'), /日期/);
  await assert.rejects(f.curator.meetingDay('2030-11-03', 'Invalid/Zone'), /时区/);
  f.archive();
  await assert.rejects(search(base.title), /项目不可用/);
  await assert.rejects(read(), /项目不可用/);
  assert.equal((await f.curator.meetingDay('2030-11-03', 'UTC')).total, 0);
});
