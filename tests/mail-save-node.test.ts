import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanFilename, cleanSubdir, createMailAttachmentNode, fetchClaim, SaveError, writeAttachment } from '../apps/agent-node/src/mail-attachment.ts';
import { AttachmentClaimError, createAttachmentClaims, MAX_CLAIMS } from '../packages/core/src/mail-attachment-claims.ts';
import type { AttachmentFile } from '../packages/core/src/mail-message.ts';

const slash = String.fromCharCode(92);
const newline = String.fromCharCode(10);
const signal = () => new AbortController().signal;

async function folder(t: { after(fn: () => void): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mail-save-node-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('保存目录只接受相对的普通子目录', () => {
  assert.equal(cleanSubdir(undefined), '');
  assert.equal(cleanSubdir(''), '');
  assert.equal(cleanSubdir('  bills/2026-10  '), 'bills/2026-10');
  // Each of these would leave the folder, name a hidden folder, or mean something else on
  // another system. All are refused before anything is taken.
  const bad = ['/etc', 'C:/x', '~/x', '../x', 'a/../b', '.hidden', 'a/.b', 'a//b', 'a/', 'a' + slash + 'b', 'a:b', 'a' + newline + 'b', '.', 'x'.repeat(600), 5];
  for (const value of bad) assert.throws(() => cleanSubdir(value), (error: unknown) => error instanceof SaveError && error.kind === 'bad-dir', String(value));
});

test('认领只能由所属电脑取一次，会过期，同时存在的数量有上限', async () => {
  const file = (name: string, size = 3): AttachmentFile => ({ id: 'id-' + name, filename: name + '.pdf', mimeType: 'application/pdf', size, content: Buffer.from('abc') });
  const claims = createAttachmentClaims({ ttlMs: 40 });
  const one = claims.put(file('one'), 'machine-a');
  // Another machine, a wrong token and another id all give nothing, and each try spends the claim.
  assert.equal(claims.take(one.id, one.token, 'machine-b'), undefined);
  assert.equal(claims.take(one.id, one.token, 'machine-a'), undefined, 'a wrong first try spent it');
  const two = claims.put(file('two'), 'machine-a');
  assert.equal(claims.take(two.id, 'not-the-token', 'machine-a'), undefined);
  assert.equal(claims.take(two.id, two.token, 'machine-a'), undefined, 'a wrong token spent it');
  const three = claims.put(file('three'), 'machine-a');
  assert.equal(claims.take(three.id, three.token, 'machine-a')?.filename, 'three.pdf');
  // A claim that nobody comes for is dropped when the next one is put up.
  const stale = claims.put(file('stale'), 'machine-a');
  await new Promise(resolve => setTimeout(resolve, 60));
  claims.put(file('fresh'), 'machine-a');
  assert.equal(claims.take(stale.id, stale.token, 'machine-a'), undefined);
  assert.equal(claims.size(), 1);
  // An attachment over the bound is refused before it is held.
  const big = file('big', 26 * 1024 * 1024);
  assert.throws(() => claims.put(big, 'machine-a'), (error: unknown) => error instanceof AttachmentClaimError && error.status === 413);
  claims.close();
  assert.equal(claims.size(), 0);
  // Only so many are held at one time.
  const burst = createAttachmentClaims();
  for (let index = 0; index < MAX_CLAIMS; index++) burst.put(file('many' + index), 'machine-a');
  assert.throws(() => burst.put(file('one-too-many'), 'machine-a'), (error: unknown) => error instanceof AttachmentClaimError && error.status === 429);
  burst.close();
});

test('文件名去掉路径、控制字符和开头的点，长名字按字符截断', () => {
  assert.equal(cleanFilename('../../etc/passwd'), 'passwd');
  assert.equal(cleanFilename('C:' + slash + 'Users' + slash + 'x' + slash + 'report.pdf'), 'report.pdf');
  assert.equal(cleanFilename('.bashrc'), 'bashrc');
  assert.equal(cleanFilename('a' + newline + 'b:c.txt'), 'a_b_c.txt');
  assert.equal(cleanFilename('   '), 'attachment');
  const long = cleanFilename('很长的名字'.repeat(40) + '.pdf');
  assert.ok(Buffer.byteLength(long) <= 200);
  assert.ok(long.endsWith('.pdf'));
  // No half character is left at the cut.
  assert.equal(Buffer.from(long, 'utf8').toString('utf8'), long);
  // The cut is on bytes and lands on a whole character: the name is the first characters of
  // the long one, each whole.
  assert.ok('很长的名字'.repeat(40).startsWith(long.slice(0, -4)));
  assert.ok(long.length >= 60, long);
});

test('同名文件不覆盖，新文件带序号；指向外面的链接不写', async t => {
  const dir = await folder(t);
  const root = join(dir, 'data', 'attachments', 'mail');
  const first = await writeAttachment(root, 'bills/2026-10', 'report.pdf', Buffer.from('one'));
  const second = await writeAttachment(root, 'bills/2026-10', 'report.pdf', Buffer.from('two'));
  assert.ok(first.endsWith(join('bills', '2026-10', 'report.pdf')));
  assert.ok(second.endsWith(join('bills', '2026-10', 'report (2).pdf')));
  assert.equal(await readFile(first, 'utf8'), 'one');
  assert.equal(await readFile(second, 'utf8'), 'two');
  // A link inside the folder that points outside it is not written through.
  const outside = join(dir, 'outside');
  await mkdir(outside);
  await symlink(outside, join(root, 'escape'));
  await assert.rejects(writeAttachment(root, 'escape', 'x.txt', Buffer.from('x')), (error: unknown) => error instanceof SaveError && error.kind === 'write-failed');
  assert.deepEqual(await readdir(outside), []);
});

test('取字节时带两个凭据，字节数要和说好的一致', async t => {
  const dir = await folder(t);
  const seen: Array<{ url: string; authorization?: string; machine?: string }> = [];
  const claim = { url: 'http://server.invalid/api/v1/mail/claims/one', token: 'claim-token', size: 5, machineToken: 'smmc_machine' };
  const good = (body: Uint8Array) => (async (url: string, init: RequestInit) => {
    seen.push({ url, authorization: (init.headers as Record<string, string>).authorization, machine: (init.headers as Record<string, string>)['x-machine-credential'] });
    return new Response(Buffer.from(body), { status: 200 });
  }) as typeof fetch;
  assert.equal(Buffer.from(await fetchClaim(claim, good(Buffer.from('hello')))).toString(), 'hello');
  assert.deepEqual(seen, [{ url: claim.url, authorization: 'Bearer claim-token', machine: 'Bearer smmc_machine' }]);
  // A body with other than the number of bytes that was said is not saved.
  await assert.rejects(fetchClaim(claim, good(Buffer.from('hi'))), (error: unknown) => error instanceof SaveError && error.kind === 'incomplete');
  await assert.rejects(fetchClaim(claim, good(Buffer.from('too long'))), (error: unknown) => error instanceof SaveError && error.kind === 'incomplete');
  // A server that refuses gives nothing.
  await assert.rejects(fetchClaim(claim, (async () => new Response('no', { status: 404 })) as typeof fetch), (error: unknown) => error instanceof SaveError && error.kind === 'fetch-failed');
  // A size over the bound is refused before any request is made.
  let asked = 0;
  await assert.rejects(fetchClaim({ ...claim, size: 26 * 1024 * 1024 }, (async () => { asked++; return new Response(); }) as typeof fetch), (error: unknown) => error instanceof SaveError && error.kind === 'too-large');
  assert.equal(asked, 0);
});

test('节点处理器：只认本服务端的认领路径，坏目录不取字节，保存后给出路径', async t => {
  const dir = await folder(t);
  const asked: string[] = [];
  const report = Buffer.from('%PDF-1.4 a report');
  const fetcher = (async (url: string, init: RequestInit) => {
    asked.push(url);
    assert.equal((init.headers as Record<string, string>)['x-machine-credential'], 'Bearer smmc_machine');
    return new Response(Buffer.from(report), { status: 200 });
  }) as typeof fetch;
  const { handlers } = createMailAttachmentNode({ dataDir: join(dir, 'data'), serverUrl: 'http://127.0.0.1:48080/', machineToken: 'smmc_machine', fetch: fetcher });
  const save = handlers['mail.save-attachment']!;
  const claim = { path: '/api/v1/mail/claims/abc', token: 'claim-token', filename: '../../report.pdf', mimeType: 'application/pdf', size: report.byteLength };
  // A bad folder is refused before anything is taken.
  const badDir = await save({ ...claim, dir: '../out' }, () => {});
  assert.equal((badDir as { ok: boolean }).ok, false);
  assert.equal((badDir as { reason: string }).reason, 'bad-dir');
  assert.deepEqual(asked, []);
  // A path that is not a claim of this server is refused.
  const other = await save({ ...claim, path: 'http://evil.invalid/x' }, () => {});
  assert.equal((other as { reason: string }).reason, 'fetch-failed');
  // The save itself.
  const saved = await save({ ...claim, dir: 'bills/2026-10' }, () => {}) as { ok: boolean; path: string; size: number };
  assert.equal(saved.ok, true);
  assert.equal(saved.size, report.byteLength);
  assert.ok(saved.path.endsWith(join('attachments', 'mail', 'bills', '2026-10', 'report.pdf')));
  assert.equal(await readFile(saved.path, 'utf8'), report.toString());
  assert.equal(asked.length, 1);
  assert.equal(asked.length, 1);
  assert.ok(String(asked[0]).startsWith('http://127.0.0.1:48080/api/v1/mail/claims/abc'));
  // An argument that is not part of the save is refused.
  const extra = await save({ ...claim, who: 'me' }, () => {});
  assert.equal((extra as { reason: string }).reason, 'fetch-failed');
});
