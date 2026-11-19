import assert from 'node:assert/strict';
import { appendFile, lstat, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createCliSessionDiscovery } from '../plugins/cli-session-discovery.ts';
import { readNativeTranscript } from '../plugins/native-session-transcript.ts';

const pageBytes = 192 * 1024;
async function fixture(t: TestContext, executorId: 'codex' | 'claude-code' = 'codex') {
  const base = await mkdtemp(join(tmpdir(), 'mario-transcript-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home'), cwd = join(base, 'project');
  await mkdir(home); await mkdir(cwd);
  const nativeSessionId = 'test-session';
  const path = executorId === 'codex'
    ? join(home, '.codex/sessions', `${nativeSessionId}.jsonl`)
    : join(home, '.claude/projects/encoded', `${nativeSessionId}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  const header = JSON.stringify(executorId === 'codex'
    ? { type: 'session_meta', payload: { id: nativeSessionId, cwd } }
    : { sessionId: nativeSessionId, cwd }) + '\n';
  await writeFile(path, header);
  const params = { executorId, nativeSessionId, cwd };
  const rpc = createCliSessionDiscovery({ home, cwd, temporaryRoots: [] }).handlers['agents.transcript'];
  return { base, home, cwd, path, header, params, rpc };
}

for (const executorId of ['codex', 'claude-code'] as const) {
  test(`${executorId}: complete >300 records across pages, no whole-file or tail limit`, async t => {
    const f = await fixture(t, executorId);
    // Exceed the old usage reader's 8 MiB tail too. Front/middle/end all survive.
    const rows = Array.from({ length: 420 }, (_, index) => JSON.stringify({ index, text: `正文-${index}-` + 'x'.repeat(21000) }));
    const original = Buffer.from(f.header + rows.join('\n') + '\n');
    await writeFile(f.path, original);
    let page = await f.rpc(f.params);
    const snapshot = page.snapshot;
    const parts: Buffer[] = [];
    for (;;) {
      const bytes = Buffer.from(page.data, 'base64');
      assert.ok(bytes.length <= pageBytes);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
      assert.deepEqual(page.snapshot, snapshot);
      parts.push(bytes);
      if (page.eof) break;
      const offset = page.nextOffset;
      page = await f.rpc({ ...f.params, offset, snapshot });
      assert.ok(page.nextOffset > offset);
    }
    assert.ok(parts.length > 2);
    assert.deepEqual(Buffer.concat(parts), original);
    const parsed = Buffer.concat(parts).toString('utf8').trimEnd().split('\n').slice(1).map(line => JSON.parse(line));
    assert.equal(parsed.length, 420);
    for (const index of [0, 210, 419]) assert.equal(parsed[index].index, index);
    assert.equal(page.nextOffset, original.length);
    const eof = await f.rpc({ ...f.params, offset: page.nextOffset, snapshot });
    assert.deepEqual(eof, { data: '', nextOffset: original.length, snapshot, eof: true });
  });
}

test('append does not enter an existing snapshot; a fresh snapshot includes it', async t => {
  const f = await fixture(t);
  const original = Buffer.from(f.header + 'a'.repeat(pageBytes + 7));
  await writeFile(f.path, original);
  const first = await f.rpc(f.params);
  await appendFile(f.path, '追加内容😀');
  const last = await f.rpc({ ...f.params, offset: first.nextOffset, snapshot: first.snapshot });
  assert.equal(last.eof, true);
  assert.deepEqual(last.snapshot, first.snapshot);
  assert.deepEqual(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(last.data, 'base64')]), original);
  const fresh = await f.rpc({ ...f.params, offset: 0 });
  assert.equal(fresh.snapshot.size, original.length + Buffer.byteLength('追加内容😀'));
});

test('UTF-8 code points may span pages without changing any bytes', async t => {
  const f = await fixture(t);
  const original = Buffer.from(f.header + ' '.repeat(pageBytes - Buffer.byteLength(f.header) - 1) + '😀中文\n');
  await writeFile(f.path, original);
  const first = await f.rpc(f.params);
  const last = await f.rpc({ ...f.params, offset: first.nextOffset, snapshot: first.snapshot });
  assert.equal(Buffer.from(first.data, 'base64').at(-1), 0xf0);
  assert.equal(Buffer.from(last.data, 'base64')[0], 0x9f);
  assert.deepEqual(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(last.data, 'base64')]), original);
});

test('an exact page boundary returns EOF immediately, with no padding', async t => {
  const f = await fixture(t);
  await writeFile(f.path, f.header + 'x'.repeat(pageBytes - Buffer.byteLength(f.header)));
  const page = await f.rpc(f.params);
  assert.equal(Buffer.from(page.data, 'base64').length, pageBytes);
  assert.equal(page.nextOffset, pageBytes);
  assert.equal(page.eof, true);
});

test('truncation and same-path replacement invalidate an earlier snapshot', async t => {
  const f = await fixture(t);
  await appendFile(f.path, 'x'.repeat(pageBytes + 12));
  const first = await f.rpc(f.params);
  await truncate(f.path, Buffer.byteLength(f.header));
  await assert.rejects(f.rpc({ ...f.params, offset: first.nextOffset, snapshot: first.snapshot }), /快照|截短/);
  await rename(f.path, f.path + '.old');
  await writeFile(f.path, f.header + 'x'.repeat(pageBytes + 12));
  await assert.rejects(f.rpc({ ...f.params, offset: first.nextOffset, snapshot: first.snapshot }), /替换|快照/);
});

test('reject malformed params and forged or out-of-range snapshots', async t => {
  const f = await fixture(t);
  const first = await f.rpc(f.params);
  const s = first.snapshot;
  const invalid: unknown[] = [null, [], {}, { ...f.params, extra: true },
    { ...f.params, executorId: 'shell' }, { ...f.params, nativeSessionId: '../bad id' },
    { ...f.params, cwd: '.' }, { ...f.params, cwd: null }];
  for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, 1]) invalid.push({ ...f.params, offset });
  for (const snapshot of [null, [], {}, { ...s, extra: 0 }, { ...s, size: -1 }, { ...s, size: 0.5 },
    { ...s, size: s.size + 1 }, { ...s, size: Number.MAX_SAFE_INTEGER + 1 }, { ...s, size: Infinity },
    { ...s, dev: s.dev + 1 }, { ...s, ino: s.ino + 1 }, { ...s, ino: '1' }]) invalid.push({ ...f.params, snapshot });
  invalid.push({ ...f.params, snapshot: s, offset: s.size + 1 });
  for (const input of invalid) await assert.rejects(f.rpc(input));
  // A caller-supplied bounded prefix is valid; snapshots are not signed tokens.
  const empty = await f.rpc({ ...f.params, snapshot: { ...s, size: 0 }, offset: 0 });
  assert.equal(empty.data, ''); assert.equal(empty.eof, true);
});

test('cwd, filename, executor and duplicate metadata cannot cross session boundaries', async t => {
  const f = await fixture(t);
  const other = join(f.base, 'other'); await mkdir(other);
  await assert.rejects(f.rpc({ ...f.params, cwd: other }));
  await assert.rejects(f.rpc({ ...f.params, nativeSessionId: 'missing' }));
  await assert.rejects(f.rpc({ ...f.params, executorId: 'claude-code' }));
  await writeFile(f.path, JSON.stringify({ type: 'session_meta', payload: { id: 'different', cwd: f.cwd } }) + '\n');
  await assert.rejects(f.rpc(f.params));
  await writeFile(f.path, f.header);
  const duplicate = join(dirname(f.path), 'duplicate-test-session.jsonl');
  await writeFile(duplicate, f.header);
  await assert.rejects(f.rpc(f.params), /唯一/);
  await writeFile(duplicate, JSON.stringify({ type: 'session_meta', payload: { id: f.params.nativeSessionId, cwd: other } }) + '\n');
  await assert.rejects(f.rpc(f.params), /唯一/);
});

test('a valid snapshot from another session cannot be replayed', async t => {
  const f = await fixture(t);
  const first = await f.rpc(f.params);
  const nativeSessionId = 'another-session';
  await writeFile(join(dirname(f.path), `${nativeSessionId}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: nativeSessionId, cwd: f.cwd },
  }) + '\n' + 'x'.repeat(1000));
  await assert.rejects(f.rpc({ ...f.params, nativeSessionId, snapshot: first.snapshot }), /替换|快照/);
});

test('an incomplete metadata scan cannot authorize transcript bytes', async t => {
  const f = await fixture(t, 'claude-code');
  await writeFile(join(dirname(f.path), 'sessions-index.json'), JSON.stringify({
    entries: [], padding: 'x'.repeat(1024 * 1024),
  }));
  await assert.rejects(f.rpc(f.params), /完整/);
});

test('file and ancestor symlinks are rejected', async t => {
  const f = await fixture(t);
  await rename(f.path, f.path + '.real');
  await symlink(f.path + '.real', f.path);
  await assert.rejects(f.rpc(f.params));
  await rm(f.path);
  await rename(f.path + '.real', f.path);
  const directory = dirname(f.path);
  await rename(directory, directory + '.real');
  await symlink(directory + '.real', directory);
  await assert.rejects(f.rpc(f.params));
});

test('reader checks scanned identity and detects changes before returning bytes', async t => {
  const f = await fixture(t);
  const info = await lstat(f.path);
  const log = { path: f.path, dev: info.dev, ino: info.ino };
  await assert.rejects(readNativeTranscript({ ...log, ino: info.ino + 1 }, { offset: 0 }, async () => true), /替换/);
  // The injected ancestor check lets the test mutate deterministically between
  // open/read and the final path/fd checks, without process timing assumptions.
  let checks = 0;
  await assert.rejects(readNativeTranscript(log, { offset: 0 }, async () => {
    if (++checks === 2) {
      await rename(f.path, f.path + '.old');
      await writeFile(f.path, f.header);
    }
    return true;
  }), /替换/);
  const replacement = await lstat(f.path);
  checks = 0;
  await assert.rejects(readNativeTranscript({ ...log, ino: replacement.ino }, { offset: 0 }, async () => {
    if (++checks === 2) await truncate(f.path, 0);
    return true;
  }), /截短/);
});

test('reader allows append during a page but excludes new bytes', async t => {
  const f = await fixture(t);
  const info = await lstat(f.path);
  let checks = 0;
  const page = await readNativeTranscript({ path: f.path, dev: info.dev, ino: info.ino }, { offset: 0 }, async () => {
    if (++checks === 2) await appendFile(f.path, 'new bytes');
    return true;
  });
  assert.equal(Buffer.from(page.data, 'base64').toString('utf8'), f.header);
  assert.equal(page.snapshot.size, info.size);
  assert.equal(page.eof, true);
});

test('reader rejects a path that becomes a symlink after reading', async t => {
  const f = await fixture(t);
  const info = await lstat(f.path);
  let checks = 0;
  await assert.rejects(readNativeTranscript({ path: f.path, dev: info.dev, ino: info.ino }, { offset: 0 }, async () => {
    if (++checks === 2) {
      await rename(f.path, f.path + '.old');
      await symlink(f.path + '.old', f.path);
      return false;
    }
    return true;
  }), /软链接/);
});
