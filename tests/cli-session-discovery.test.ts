import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { createCliSessionDiscovery } from '../plugins/cli-session-discovery.ts';

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'mario-native-sessions-'));
  const home = join(base, 'home'), cwd = join(base, 'project'), temporary = join(base, 'temporary');
  await mkdir(home); await mkdir(cwd);
  const previous = process.env.SUPER_MARIO_PROJECT_ROOTS;
  delete process.env.SUPER_MARIO_PROJECT_ROOTS;
  t.after(async () => {
    if (previous === undefined) delete process.env.SUPER_MARIO_PROJECT_ROOTS; else process.env.SUPER_MARIO_PROJECT_ROOTS = previous;
    await rm(base, { recursive: true, force: true });
  });
  async function file(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  }
  async function codex(id: string, path = cwd, extra: Record<string, unknown> = {}, name = id) {
    const target = join(home, '.codex/sessions', `${name}.jsonl`);
    await file(target, { type: 'session_meta', payload: { id, cwd: path, ...extra } });
    return target;
  }
  async function claude(id: string, path = cwd, extra: Record<string, unknown> = {}, name = id) {
    const target = join(home, '.claude/projects/encoded', `${name}.jsonl`);
    await file(target, { sessionId: id, cwd: path, ...extra });
    return target;
  }
  function discovery(roots?: string[]) { return createCliSessionDiscovery({ home, cwd, temporaryRoots: [temporary], ...(roots ? { roots } : {}) }); }
  return { base, home, cwd, temporary, file, codex, claude, discovery };
}

test('both providers preserve independent native threads, visible parents and historical read-only state', async t => {
  const f = await fixture(t);
  await f.codex('parent', f.cwd, { timestamp: '2026-01-01' });
  await f.codex('child', f.cwd, { parent_session_id: 'parent', timestamp: '2026-02-01' });
  await f.codex('other', f.cwd, { parent_session_id: 'hidden' });
  await f.claude('parent', f.cwd, { timestamp: '2026-03-01' });
  await f.claude('child', f.cwd, { parentSessionId: 'parent' });
  const before = Date.now();
  const { sessions, truncated } = await f.discovery().handlers['agents.sessions']({});
  assert.equal(sessions.length, 5); assert.equal(truncated, false);
  assert.equal(new Set(sessions.map(s => s.id)).size, 5);
  for (const row of sessions) {
    assert.equal(row.id, `${row.executorId}:${row.nativeSessionId}`);
    assert.equal(row.state, 'historical'); assert.equal(row.writable, false);
    assert.equal(row.source, 'session-metadata');
    assert.ok(Date.parse(row.observedAt) >= before && Date.parse(row.observedAt) <= Date.now());
  }
  assert.equal(sessions.find(s => s.id === 'codex:child')?.parentNativeSessionId, 'parent');
  assert.equal(sessions.find(s => s.id === 'claude-code:child')?.parentNativeSessionId, 'parent');
  assert.equal(sessions.find(s => s.id === 'codex:other')?.parentNativeSessionId, undefined);
  assert.equal(sessions.find(s => s.id === 'codex:other')?.metadataTimestamp, undefined);
});

test('session indexes and pretty metadata merge idempotently with latest metadata time', async t => {
  const f = await fixture(t);
  await f.claude('same', f.cwd, { timestamp: '2026-01-01' });
  await f.file(join(f.home, '.claude/projects/encoded/sessions-index.json'), {
    entries: [{ sessionId: 'same', projectPath: f.cwd, modified: '2026-04-01' }, { sessionId: 'index-only', projectPath: f.cwd, modified: '2026-03-01' }],
    padding: 'SECRET'.repeat(4000),
  });
  await f.file(join(f.home, '.claude/sessions/pretty.json'), JSON.stringify({ session_id: 'pretty', cwd: f.cwd }, null, 2));
  await f.codex('same', f.cwd, { timestamp: '2026-02-01' });
  await f.codex('same', f.cwd, { timestamp: '2026-01-01' }, 'duplicate');
  const d = f.discovery();
  const first = await d.handlers['agents.sessions']({}), second = await d.handlers['agents.sessions']({});
  assert.equal(first.sessions.length, 4); assert.equal(first.truncated, false);
  assert.equal(first.sessions.find(s => s.id === 'claude-code:same')?.metadataTimestamp, '2026-04-01T00:00:00.000Z');
  assert.equal(first.sessions.find(s => s.id === 'codex:same')?.metadataTimestamp, '2026-02-01T00:00:00.000Z');
  assert.deepEqual(first.sessions.map(({ observedAt, ...s }) => s), second.sessions.map(({ observedAt, ...s }) => s));
  assert.ok(!JSON.stringify(first).includes('SECRET'));
});

test('large structured heads work without interpreting prompt or instructions as metadata', async t => {
  const f = await fixture(t);
  await f.codex('large', f.cwd, { instructions: { text: 'SECRET'.repeat(6000) } });
  await f.file(join(f.home, '.claude/sessions/pretty.json'), JSON.stringify({ sessionId: 'pretty-large', cwd: f.cwd, prompt: 'SECRET'.repeat(6000) }, null, 2));
  const first = await f.discovery().handlers['agents.sessions']({});
  assert.deepEqual(first.sessions.map(s => s.nativeSessionId).sort(), ['large', 'pretty-large']);
  assert.equal(first.truncated, false);
  await f.file(join(f.home, '.codex/sessions/trap.jsonl'), JSON.stringify({ type: 'session_meta', payload: { instructions: { id: 'forged', cwd: f.cwd, text: 'SECRET'.repeat(6000) } } }));
  await f.file(join(f.home, '.claude/sessions/trap.json'), { prompt: { sessionId: 'forged', cwd: f.cwd } });
  const result = await f.discovery().handlers['agents.sessions']({});
  assert.equal(result.sessions.length, 2); assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal((await f.discovery().validateResume({ executorId: 'codex', nativeSessionId: 'large', cwd: f.cwd })).nativeSessionId, 'large', 'unrelated malformed history cannot invalidate a complete selected header');
  await assert.rejects(f.discovery().validateResume({executorId:'codex',nativeSessionId:'forged',cwd:f.cwd}),/未找到|读取不足/);
});

test('a complete header followed by a huge transcript is not reported as truncated', async t => {
  const f = await fixture(t);
  const path = await f.codex('normal');
  const initial = await readFile(path, 'utf8');
  await f.file(path, initial + '\n' + 'SECRET transcript\n'.repeat(10000));
  const result = await f.discovery().handlers['agents.sessions']({});
  assert.equal(result.sessions.length, 1); assert.equal(result.truncated, false);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('bad JSON, absent IDs, invalid IDs, missing directories and ordinary files never create sessions', async t => {
  const f = await fixture(t);
  await f.file(join(f.home, '.codex/sessions/bad.jsonl'), '{"type":"session_meta","payload":{"id":"bad","cwd":"' + f.cwd + '"}, BROKEN');
  await f.file(join(f.home, '.claude/sessions/no-id.json'), { cwd: f.cwd, prompt: { sessionId: 'fake' } });
  await f.file(join(f.home, '.claude/sessions/inferred-id.json'), { cwd: f.cwd });
  await f.file(join(f.base, 'ordinary'), 'file');
  await f.codex('missing', join(f.base, 'absent'));
  await f.codex('file', join(f.base, 'ordinary'));
  for (const [i, id] of ['', '-option', 'bad\nvalue', 'x'.repeat(257)].entries()) await f.codex(id, f.cwd, {}, `invalid-${i}`);
  const result = await f.discovery().handlers['agents.sessions']({});
  assert.deepEqual(result.sessions, []); assert.ok(result.warnings.length > 0 && result.warnings.length <= 12);
  assert.ok(!JSON.stringify(result).includes('BROKEN'));
  await assert.rejects(access(join(f.base, 'absent')), { code: 'ENOENT' });
});

test('same provider/id with conflicting canonical cwd is rejected before root filtering', async t => {
  const f = await fixture(t), other = join(f.base, 'other'); await mkdir(other);
  await f.codex('conflict'); await f.codex('conflict', other, {}, 'duplicate');
  await f.claude('conflict');
  const result = await f.discovery().handlers['agents.sessions']({ roots: [f.cwd] });
  assert.deepEqual(result.sessions.map(s => s.id), ['claude-code:conflict']);
  assert.ok(result.warnings.some(w => w.includes('不同目录')));
  await assert.rejects(f.discovery().validateResume({ executorId: 'codex', nativeSessionId: 'conflict', cwd: f.cwd }), /冲突/);
});

test('canonical root boundaries distinguish siblings and remove invisible parent IDs', async t => {
  const f = await fixture(t), sibling = join(f.base, 'project-other'); await mkdir(sibling);
  await f.codex('outside-parent', sibling); await f.codex('inside', f.cwd, { parent_session_id: 'outside-parent' });
  const result = await f.discovery([f.cwd]).handlers['agents.sessions']({});
  assert.deepEqual(result.roots, [f.cwd]);
  assert.deepEqual(result.sessions.map(s => s.nativeSessionId), ['inside']);
  assert.equal(result.sessions[0].parentNativeSessionId, undefined);
  assert.deepEqual((await f.discovery().handlers['agents.sessions']({ roots: ['/'] })).sessions, []);
  assert.deepEqual((await f.discovery().handlers['agents.sessions']({ roots: [] })).sessions, []);
  const emptyHome = join(f.base, 'empty-home'); await mkdir(emptyHome);
  assert.deepEqual((await createCliSessionDiscovery({ home: emptyHome, temporaryRoots: [] }).handlers['agents.sessions']({})).sessions, []);
});

test('metadata symlinks are never followed while cwd aliases canonicalize without losing legitimate history', async t => {
  const f = await fixture(t);
  const external = join(f.base, 'external');
  await f.file(join(external, 'linked.jsonl'), { type: 'session_meta', payload: { id: 'file-link', cwd: f.cwd } });
  await mkdir(join(f.home, '.codex/sessions'), { recursive: true });
  await symlink(join(external, 'linked.jsonl'), join(f.home, '.codex/sessions/link.jsonl'));
  await symlink(external, join(f.home, '.codex/sessions/link-dir'));
  const alias = join(f.base, 'alias'); await symlink(f.cwd, alias);
  await f.codex('cwd-link', alias);
  for (const params of [{}, { roots: [f.base] }, { roots: [alias] }]) { const result=await f.discovery().handlers['agents.sessions'](params); assert.deepEqual(result.sessions.map(s=>s.nativeSessionId),['cwd-link']);assert.equal(result.sessions[0].cwd,f.cwd); }
  await assert.rejects(f.discovery().validateResume({ executorId: 'codex', nativeSessionId: 'file-link', cwd: f.cwd }), /未找到/);
});

test('real linked Git worktrees are excluded, real submodules survive, manual worktree lookup succeeds', async t => {
  const f = await fixture(t), git = promisify(execFile);
  const main = join(f.base, 'main'), linked = join(f.base, 'feature'), module = join(main, 'module');
  await git('git', ['init', main]);
  await git('git', ['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  await git('git', ['-C', main, 'worktree', 'add', '--detach', linked, 'HEAD']);
  const source = join(f.base, 'module-source');
  await git('git', ['init', source]);
  await git('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  await git('git', ['-C', main, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'module']);
  const nested = join(linked, 'nested'); await mkdir(nested);
  const marker = await readFile(join(linked, '.git'), 'utf8');
  await writeFile(join(linked, '.git'), 'gitdir: ' + relative(linked, marker.slice(8).trim()) + '\n');
  await f.codex('main', main); await f.codex('worktree', linked); await f.claude('nested', nested); await f.claude('module', module);
  for (const params of [{}, { roots: [f.base] }, { roots: [linked] }]) {
    const result = await f.discovery().handlers['agents.sessions'](params);
    assert.ok(!result.sessions.some(s => s.nativeSessionId === 'worktree' || s.nativeSessionId === 'nested'));
    if (!params.roots || params.roots[0] === f.base) assert.deepEqual(result.sessions.map(s => s.cwd).sort(), [main, module].sort());
  }
  assert.equal((await f.discovery().validateResume({ executorId: 'codex', nativeSessionId: 'worktree', cwd: linked })).cwd, linked);
  assert.equal(await readFile(join(linked, '.git'), 'utf8'), 'gitdir: ' + relative(linked, marker.slice(8).trim()) + '\n');
});

test('temporary history is excluded automatically but exact manual lookup remains possible', async t => {
  const f = await fixture(t), transient = join(f.temporary, 'work'); await mkdir(transient, { recursive: true });
  await f.codex('tmp', transient); await f.claude('ordinary');
  for (const params of [{}, { roots: [f.base] }]) assert.deepEqual((await f.discovery().handlers['agents.sessions'](params)).sessions.map(s => s.nativeSessionId), ['ordinary']);
  const d = f.discovery();
  const selected = await d.handlers['agents.session']({ executorId: 'codex', nativeSessionId: 'tmp', cwd: transient });
  assert.equal(selected.cwd, transient); assert.equal(selected.writable, false);
  assert.deepEqual((await createCliSessionDiscovery({ home: f.home }).handlers['agents.sessions']({})).sessions, []);
});

test('exact lookup rejects missing/wrong provider or cwd and strict RPC params', async t => {
  const f = await fixture(t); await f.codex('one');
  const d = f.discovery(), valid = { executorId: 'codex' as const, nativeSessionId: 'one', cwd: f.cwd };
  assert.equal((await d.validateResume(valid)).id, 'codex:one');
  for (const params of [null, [], {}, { ...valid, extra: true }, { ...valid, nativeSessionId: '-bad' }, { ...valid, executorId: 'other' }, { ...valid, cwd: f.home }, { ...valid, cwd: join(f.base, 'missing') }, { ...valid, executorId: 'claude-code' }]) await assert.rejects(d.handlers['agents.session'](params));
  for (const params of [null, { cwd: f.cwd }, { roots: 'invalid' }, { roots: ['relative'] }, { roots: Array(33).fill(f.cwd) }]) await assert.rejects(d.handlers['agents.sessions'](params));
  await assert.rejects(access(join(f.base, 'missing')), { code: 'ENOENT' });
});

test('file, directory fan-out and index head limits report honest truncation and refuse exact validation', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2049; i++) await f.codex(`session-${i}`);
  let result = await f.discovery().handlers['agents.sessions']({});
  assert.equal(result.truncated, true); assert.ok(result.sessions.length <= 2048); assert.ok(result.warnings.length <= 12);
  await assert.rejects(f.discovery().validateResume({ executorId: 'codex', nativeSessionId: 'session-9', cwd: f.cwd }), /读取不足/);
  await rm(join(f.home, '.codex'), { recursive: true });
  await f.file(join(f.home, '.claude/projects/encoded/sessions-index.json'), JSON.stringify({ entries: [{ sessionId: 'oversize', projectPath: f.cwd }], padding: 'x'.repeat(1024 * 1024) }));
  result = await f.discovery().handlers['agents.sessions']({});
  assert.equal(result.truncated, true); assert.deepEqual(result.sessions, []);
});

test('extra project scan roots do not disable native history or cause implicit directory traversal', async t => {
  const f = await fixture(t); await f.codex('chosen');
  process.env.SUPER_MARIO_PROJECT_ROOTS = join(f.base, 'must-not-scan');
  const result = await f.discovery().handlers['agents.sessions']({});
  assert.deepEqual(result.sessions.map(s=>s.nativeSessionId), ['chosen']); assert.equal(result.truncated, false);
  assert.deepEqual(result.roots, []);
  assert.equal((await f.discovery().validateResume({ executorId: 'codex', nativeSessionId: 'chosen', cwd: f.cwd })).id, 'codex:chosen');
});

test('metadata root ancestors cannot be symlinks and excessive nesting reports truncation', async t => {
  const f = await fixture(t);
  const outside = join(f.base, 'metadata');
  await f.file(join(outside, 'sessions/session.jsonl'), { type: 'session_meta', payload: { id: 'hidden', cwd: f.cwd } });
  await symlink(outside, join(f.home, '.codex'));
  assert.deepEqual((await f.discovery().handlers['agents.sessions']({})).sessions, []);
  await assert.rejects(f.discovery().validateResume({ executorId: 'codex', nativeSessionId: 'hidden', cwd: f.cwd }), /未找到|读取不足/);
  await rm(join(f.home, '.codex'));
  await f.file(join(f.home, '.codex/sessions/one/two/three/four/deep.jsonl'), { type: 'session_meta', payload: { id: 'deep', cwd: f.cwd } });
  const result = await f.discovery().handlers['agents.sessions']({});
  assert.deepEqual(result.sessions, []); assert.equal(result.truncated, true);
});

test('exact indexed lookup does not fail just because unrelated transcripts exceed the discovery file budget',async t=>{
 const f=await fixture(t);
 for(let day=1;day<=3;day++)for(let i=0;i<1366;i++)await f.file(join(f.home,'.codex/sessions/2026/11',String(day),`native-${day}-${i}.jsonl`),{type:'session_meta',payload:{id:`native-${day}-${i}`,cwd:f.cwd}});
 const inventory=await f.discovery().handlers['agents.sessions']({});assert.equal(inventory.truncated,true);
 const found=await f.discovery().validateResume({executorId:'codex',nativeSessionId:'native-3-199',cwd:f.cwd});assert.equal(found.nativeSessionId,'native-3-199');assert.equal(found.cwd,f.cwd);assert.equal(found.writable,false);
});


test('an aliased OS home resolves once without weakening metadata-internal symlink refusal',async t=>{
 const f=await fixture(t);await f.codex('home-alias');const alias=join(f.base,'home-alias');await symlink(f.home,alias);
 const discovery=createCliSessionDiscovery({home:alias,cwd:f.cwd,temporaryRoots:[f.temporary]});
 const result=await discovery.handlers['agents.sessions']({});assert.deepEqual(result.sessions.map(s=>s.nativeSessionId),['home-alias']);
 assert.equal((await discovery.validateResume({executorId:'codex',nativeSessionId:'home-alias',cwd:f.cwd})).cwd,f.cwd);
});

test('actual Codex parent_thread_id and thread_spawn metadata preserve visible ancestry, never instruction payloads',async t=>{
 const f=await fixture(t);await f.codex('root-thread');await f.codex('direct-child',f.cwd,{parent_thread_id:'root-thread'});
 await f.codex('spawn-child',f.cwd,{source:{subagent:{thread_spawn:{parent_thread_id:'root-thread'}}},instructions:{text:'x'.repeat(40000)}});
 await f.codex('not-child',f.cwd,{instructions:{source:{subagent:{thread_spawn:{parent_thread_id:'root-thread'}}}}});
 const result=await f.discovery().handlers['agents.sessions']({});
 assert.equal(result.sessions.find(s=>s.nativeSessionId==='direct-child')?.parentNativeSessionId,'root-thread');
 assert.equal(result.sessions.find(s=>s.nativeSessionId==='spawn-child')?.parentNativeSessionId,'root-thread');
 assert.equal(result.sessions.find(s=>s.nativeSessionId==='not-child')?.parentNativeSessionId,undefined);
});


test('file record modification and metadata creation time remain distinct from process activity',async t=>{
 const f=await fixture(t),path=await f.codex('time-evidence',f.cwd,{timestamp:'2020-01-01T00:00:00Z'});
 await utimes(path,new Date('2026-11-17T01:00:00Z'),new Date('2026-11-17T01:00:00Z'));
 const row=(await f.discovery().handlers['agents.sessions']({})).sessions[0];
 assert.equal(row.metadataTimestamp,'2020-01-01T00:00:00.000Z');assert.equal(row.fileModifiedAt,'2026-11-17T01:00:00.000Z');assert.equal(row.state,'historical');assert.equal('lastActiveAt' in row,false);
});


test('metadata-only histories remain listed and support exact resume for both providers', async t => {
  const f = await fixture(t);
  await f.codex('legacy');
  await f.claude('legacy');
  const discovery = f.discovery();
  const inventory = await discovery.handlers['agents.sessions']({});
  assert.deepEqual(inventory.sessions.map(row => row.id).sort(), ['claude-code:legacy', 'codex:legacy']);
  for (const executorId of ['codex', 'claude-code'] as const) {
    const row = await discovery.validateResume({ executorId, nativeSessionId: 'legacy', cwd: f.cwd });
    assert.equal(row.id, executorId + ':legacy');
    assert.equal(row.cwd, f.cwd);
  }
});

test('usage reads native records on demand, preserves files and returns counts only', async t => {
  const f = await fixture(t);
  const path = await f.codex('thread');
  const original = await readFile(path,'utf8') + '\n' + [
    { type: 'response_item', payload: { type: 'function_call', arguments: 'private' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 90 }, last_token_usage: { cached_input_tokens: 20 }, model_context_window: 1000 } } },
  ].map(row => JSON.stringify(row)).join('\n');
  await writeFile(path, original);
  const usage = f.discovery().handlers['agents.usage'];
  const target = { executorId: 'codex', nativeSessionId: 'thread', cwd: f.cwd };
  const report = await usage(target);
  assert.equal(report.cumulative.input, 90);
  assert.equal(report.records[0]?.cached, 20);
  assert.equal(report.toolCalls, 1);
  assert.equal(report.windowTokens, 1000);
  assert.equal(JSON.stringify(report).includes('private'), false);
  assert.equal(await readFile(path,'utf8'), original);
  await assert.rejects(usage({ ...target, cwd: f.home }));
  const cp = await f.claude('test');
  const rows = [1,2].map(output_tokens => JSON.stringify({ type: 'assistant', sessionId: 'test', cwd: f.cwd, message: { id: 'msg', usage: { input_tokens: 15, output_tokens } } }));
  await writeFile(cp, rows.join('\n'));
  const c = await usage({ ...target, executorId: 'claude-code', nativeSessionId: 'test' });
  assert.deepEqual(c.cumulative, { input: 15, output: 2 });
  assert.equal(c.records.length, 1);
});
