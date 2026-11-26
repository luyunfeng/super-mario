import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { assistantProfile, avatarChange, AVATAR_MAX_BYTES } from '../plugins/assistant-profile.ts';

/** The smallest picture of each kind that says what it is: only its signature bytes. */
const picture = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from([0, 0])]),
  gif: Buffer.from('GIF89a' + String.fromCharCode(1, 0, 1, 0, 0, 0)),
};
const dataUrl = (kind: keyof typeof picture) => 'data:image/' + kind + ';base64,' + picture[kind].toString('base64');
/** The status a refusal was given, as the service gives it: on the error, beside the message. */
const refusal = (error: unknown) => (error as { status?: unknown }).status;

test('头像只接受四种图片的数据地址，字节和类型要对得上，大小有上限', () => {
  // Left out, the avatar is left alone. Null removes it.
  assert.equal(avatarChange(undefined), undefined);
  assert.deepEqual(avatarChange(null), { set: null });
  for (const kind of Object.keys(picture) as Array<keyof typeof picture>) {
    assert.deepEqual(avatarChange(dataUrl(kind)), { set: dataUrl(kind) }, kind);
  }
  const refused = (value: unknown, message: RegExp) => assert.throws(() => avatarChange(value),
    (error: unknown) => refusal(error) === 400 && message.test((error as Error).message));
  // Not a picture address at all.
  refused('https://evil.invalid/a.png', /头像/);
  refused('data:text/html;base64,PGh0bWw+', /头像/);
  // SVG can hold a script, and is not among the kinds taken.
  refused('data:image/svg+xml;base64,PHN2Zz4=', /头像/);
  // Empty, or not base64.
  refused('data:image/png;base64,', /头像/);
  refused('data:image/png;base64,not base64!', /头像/);
  // The bytes are not what the address says: a JPEG offered as a PNG.
  refused('data:image/png;base64,' + picture.jpeg.toString('base64'), /不一致/);
  // Over the bound, even though it is a PNG.
  const big = Buffer.concat([picture.png, Buffer.alloc(AVATAR_MAX_BYTES)]);
  refused('data:image/png;base64,' + big.toString('base64'), /256 KB/);
  // Not a string.
  refused(5, /头像/);
});

test('头像随主助手资料保存，和名称一起核对版本，可移除，重开数据库后还在', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-avatar-'));
  let runtime = await openProfile(dir);
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const read = { action: 'read' };
  // A stale revision does not take the avatar, and nothing is written.
  await assert.rejects(runtime.call({ action: 'save', name: '主 Agent', revision: 7, avatar: dataUrl('webp') }), (error: unknown) => refusal(error) === 409);
  assert.deepEqual(await runtime.call(read), { name: '主 Agent', revision: 0 });
  // Saved with the same name: only the avatar is new, and that is one change.
  const first = await runtime.call({ action: 'save', name: '主 Agent', revision: 0, avatar: dataUrl('webp') });
  assert.equal(asPicture(first).avatar, dataUrl('webp'));
  assert.equal(asPicture(first).revision, 1);
  // Saving with the name alone leaves the avatar as it is.
  const renamed = await runtime.call({ action: 'save', name: '小助', revision: 1 });
  assert.equal(asPicture(renamed).name, '小助');
  assert.equal(asPicture(renamed).avatar, dataUrl('webp'));
  // A bad avatar changes nothing, whatever else is right.
  await assert.rejects(runtime.call({ action: 'save', name: '小助', revision: 2, avatar: 'data:image/svg+xml;base64,PHN2Zz4=' }), /头像/);
  assert.deepEqual(await runtime.call(read), renamed);
  // Null removes it.
  const removed = await runtime.call({ action: 'save', name: '小助', revision: 2, avatar: null });
  assert.equal('avatar' in asPicture(removed), false);
  // Kept across a reopen.
  await runtime.close();
  runtime = await openProfile(dir);
  assert.deepEqual(await runtime.call(read), removed);
  const back = await runtime.call({ action: 'save', name: '小助', revision: 3, avatar: dataUrl('webp') });
  assert.equal(asPicture(back).avatar, dataUrl('webp'));
  await runtime.close();
  runtime = await openProfile(dir);
  assert.equal(asPicture(await runtime.call(read)).avatar, dataUrl('webp'));
});

type Profile = { name: string; revision: number; avatar?: string };

/** What the service answers with, as the profile it is. The service says it is a Json value. */
function asPicture(value: unknown): Profile {
  assert.ok(isProfile(value), 'the service answers with a profile');
  return value;
}
function isProfile(value: unknown): value is Profile {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function openProfile(dir: string) {
  const store = createStore(join(dir, 'test.sqlite'));
  const events = createEventBus(store);
  const host = new PluginHost({ dataDir: dir, store, events, contributions: createContributions() });
  host.register(assistantProfile);
  await host.start();
  return {
    call: (input: JsonObject) => host.invocations.use('assistant-profile.manage', input),
    changes: () => events.since(0).filter(event => event.type === 'assistant-profile.changed').map(event => event.data),
    close: async () => { await host.close(); store.close(); },
    host,
  };
}

test('assistant profile defaults, handles conflicting writes and survives a database reopen', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-profile-'));
  let runtime = await openProfile(dir);
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const read = { action: 'read' }, save = { action: 'save', name: '  欧阳·安娜  ', revision: 0 };
  assert.deepEqual(await runtime.call(read), { name: '主 Agent', revision: 0 });
  const race = await Promise.allSettled([runtime.call(save), runtime.call(save)]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(race.find(result => result.status === 'rejected')?.reason.status, 409);
  const updated = { name: '欧阳·安娜', revision: 1 };
  assert.deepEqual(await runtime.call({ ...save, revision: 1 }), updated);
  assert.deepEqual(runtime.changes(), [{ revision: 1 }]);
  await runtime.close();
  runtime = await openProfile(dir);
  assert.deepEqual(await runtime.call(read), updated);
  await runtime.host.setEnabled('assistant-profile', false);
  await assert.rejects(runtime.call(read), /unavailable/);
  await runtime.host.setEnabled('assistant-profile', true);
  assert.deepEqual(await runtime.call({ ...save, name: '主 Agent', revision: 1 }), { name: '主 Agent', revision: 2 });
  assert.deepEqual(runtime.changes(), [{ revision: 1 }, { revision: 2 }]);
});

test('assistant profile rejects controls, forged fields and invalid revisions, and counts Unicode characters', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-profile-')), runtime = await openProfile(dir);
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const save = { action: 'save', revision: 0, name: '𠮷'.repeat(40) };
  for (const name of ['  ', '\nName', 'Name\t', 'a\u0085b', 'a\u2028b', '\u200E姓名', '\u202E名', '名\u2069', '\uDFFF', save.name + '一']) {
    await assert.rejects(runtime.call({ ...save, name }), { status: 400 });
  }
  const invalid: JsonObject[] = [{ action: 'save', name: '名' }, { ...save, revision: -1 },
    { ...save, revision: '0' }, { ...save, projectId: 'foreign' }, { action: 'read', name: 'name' }];
  for (const input of invalid) await assert.rejects(runtime.call(input), { status: 400 });
  assert.deepEqual(runtime.changes(), []);
  assert.deepEqual(await runtime.call(save), { revision: 1, name: save.name });
});
