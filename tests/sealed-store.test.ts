import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSealedStore, SealError } from '../packages/core/src/sealed-store.ts';

async function fixture(t: { after(fn: () => void): void }) {
  const root = await mkdtemp(join(tmpdir(), 'mario-sealed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  return { root, data, open: () => createSealedStore(data) };
}

test('封存的内容能原样读回，密文里不出现原文，同一句话两次封存的密文不同', async t => {
  const f = await fixture(t);
  const store = await f.open();
  const secret = '邮箱密码 with symbols !"\'\u0000 和中文';
  const first = await store.seal(secret);
  const second = await store.seal(secret);
  assert.equal(await store.unseal(first), secret);
  assert.equal(await store.unseal(second), secret);
  assert.notEqual(first, second, 'the same text sealed twice does not look the same');
  assert.equal(first.includes('密码'), false, 'the sealed text does not contain the secret');
  assert.match(first, /^smseal1\./);
  // An empty value is a value.
  assert.equal(await store.unseal(await store.seal('')), '');
});

test('密文被改动、不是本工作台封存的、或密钥换了，都读不出来，并说明原因', async t => {
  const f = await fixture(t);
  const store = await f.open();
  const sealed = await store.seal('a password');
  const [head, iv, tag, body] = sealed.split('.');
  // Flipping one character of each part breaks it.
  const flip = (part: string) => part[0] === 'A' ? 'B' + part.slice(1) : 'A' + part.slice(1);
  for (const broken of [[head, iv, flip(tag!), body], [head, iv, tag, flip(body!)], [head, flip(iv!), tag, body], ['smseal0', iv, tag, body]]) {
    await assert.rejects(store.unseal(broken.join('.')), (error: unknown) => error instanceof SealError);
  }
  for (const notSealed of ['', 'a.b.c', 'smseal1', 'smseal1.a.b', 'smseal1.a.b.c.d', 'hello', 'smseal1.....']) {
    await assert.rejects(store.unseal(notSealed), (error: unknown) => error instanceof SealError, JSON.stringify(notSealed));
  }
  // The message of a refusal says nothing about what was sealed.
  await assert.rejects(store.unseal('smseal1.' + flip(iv!) + '.' + tag + '.' + body), (error: unknown) =>
    error instanceof SealError && !error.message.includes('password') && !error.message.includes('a password'));
  // A different key cannot read what the first one sealed.
  const other = await createSealedStore(join(f.root, 'other'));
  await assert.rejects(other.unseal(sealed), /无法解开|密钥/);
});

test('密钥只建一次并留在数据目录，重启后用同一把；密钥文件只有本人可读', async t => {
  const f = await fixture(t);
  const first = await f.open();
  const sealed = await first.seal('keeps across restarts');
  const before = await readFile(join(f.data, 'secrets.key'));
  // A second store over the same directory reads the same key, so the old value still opens.
  const second = await f.open();
  assert.equal(await second.unseal(sealed), 'keeps across restarts');
  assert.deepEqual(await readFile(join(f.data, 'secrets.key')), before, 'the key is not replaced');
  assert.equal(before.length, 32);
  // Only the key is in the directory. No temporary file is left behind.
  assert.deepEqual((await readdir(f.data)).sort(), ['secrets.key']);
  if (process.platform !== 'win32') {
    const { statSync } = await import('node:fs');
    const mode = statSync(join(f.data, 'secrets.key')).mode & 0o777;
    assert.equal(mode, 0o600, 'the key is readable by its owner only');
    assert.equal(statSync(f.data).mode & 0o777, 0o700, 'so is the directory that holds it');
  }
});

test('同时打开同一数据目录时只建一把密钥，先封存的内容之后仍能读回', async t => {
  const f = await fixture(t);
  // Many stores are opened at once over one empty directory. Before the key was linked
  // into place rather than renamed, a later one could overwrite the key an earlier one had
  // already used, and what that one sealed would be lost.
  const stores = await Promise.all(Array.from({ length: 12 }, () => f.open()));
  const sealed = await Promise.all(stores.map((store, index) => store.seal('value ' + index)));
  for (const [index, store] of stores.entries()) {
    assert.equal(await store.unseal(sealed[index]!), 'value ' + index);
    // Every store reads every value, which is so only if they all share one key.
    assert.equal(await store.unseal(sealed[(index + 1) % sealed.length]!), 'value ' + ((index + 1) % sealed.length));
  }
  assert.equal((await readdir(f.data)).filter(name => name !== 'secrets.key').length, 0, 'no temporary key file is left');
});

test('密钥文件不是普通文件、长度不对或损坏时明确报错，不悄悄另建一把', async t => {
  const f = await fixture(t);
  await rm(f.data, { recursive: true, force: true });
  await (await import('node:fs/promises')).mkdir(f.data, { recursive: true });
  // A key of the wrong length is refused, because making a new one would lose what the old one sealed.
  await writeFile(join(f.data, 'secrets.key'), Buffer.alloc(16));
  const broken = await f.open();
  await assert.rejects(broken.seal('x'), /密钥文件损坏/);
  assert.deepEqual(await readFile(join(f.data, 'secrets.key')), Buffer.alloc(16), 'the broken key is left as it is');
  // A directory where the key should be is refused too.
  await rm(join(f.data, 'secrets.key'), { force: true });
  await (await import('node:fs/promises')).mkdir(join(f.data, 'secrets.key'));
  const wrongKind = await f.open();
  await assert.rejects(wrongKind.seal('x'), (error: unknown) => error instanceof SealError);
  // A symbolic link in place of the key is refused, so it cannot be pointed elsewhere.
  await rm(join(f.data, 'secrets.key'), { recursive: true, force: true });
  const elsewhere = join(f.root, 'elsewhere.key');
  await writeFile(elsewhere, Buffer.alloc(32, 7));
  await (await import('node:fs/promises')).symlink(elsewhere, join(f.data, 'secrets.key'));
  const linked = await f.open();
  await assert.rejects(linked.seal('x'), /不是普通文件/);
});
