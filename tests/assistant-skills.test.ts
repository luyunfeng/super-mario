import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { createStore } from '../packages/core/src/store.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { assistantSkills } from '../plugins/assistant-skills.ts';

import { workGuide } from '../plugins/workbench-work-guide.ts';

const builtinSkills = [{ name: 'workbench.work', description: workGuide.description }];
const manifest = '---\nname: demo-skill\ndescription: >-\n  简要说明\n---\n\n# 技能正文\n';
const archive = (zip: JSZip) => zip.generateAsync({ type: 'base64', compression: 'DEFLATE', platform: 'UNIX' });

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-skills-'));
  const store = createStore(join(dir, 'test.sqlite')), contributions = createContributions();
  const host = new PluginHost({ store, dataDir: dir, events: createEventBus(store), contributions });
  host.register(assistantSkills);
  await host.start();
  t.after(async () => { await host.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (input: JsonObject) => await host.invocations.use('assistant-skills.manage', input) as JsonObject;
  return { store, contributions, host, call };
}

test('ZIP preview, digest-bound installation, resource reads and removal use one revisioned catalog', async t => {
  const { host, call, contributions, store } = await fixture(t);
  const zip = new JSZip();
  zip.file('bundle/SKILL.md', manifest).file('bundle/docs/参考.md', '说明正文').file('bundle/long.txt', '龟🦖'.repeat(3001), { compression: 'STORE' }).file('bundle/empty.txt', '').file('bundle/image.bin', Buffer.from([0xff, 0, 1]));
  const data = await archive(zip);
  const digest = createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
  const info = { name: 'demo-skill', description: '简要说明' };
  assert.deepEqual(await call({ action: 'preview', archive: data }), { ...info, files: ['SKILL.md','docs/参考.md','empty.txt','image.bin','long.txt'], digest });
  assert.deepEqual(await call({ action: 'list' }), { revision: 0, skills: [], builtinSkills });
  const install = { action: 'install', archive: data, digest, revision: 0 };
  await assert.rejects(call({ ...install, digest: '1'.repeat(64) }), { status: 409 });
  const race = await Promise.allSettled([call(install), call(install)]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(race.find(result => result.status === 'rejected')?.reason.status, 409);
  assert.deepEqual(race.find(result => result.status === 'fulfilled')?.value, { revision: 1, skills: [info], builtinSkills });
  assert.deepEqual(await call({ action: 'list' }), { revision: 1, skills: [info], builtinSkills });
  await assert.rejects(call({ ...install, revision: 1 }), { status: 409 });
  await assert.rejects(call({ action: 'preview', archive: data }), { status: 409 });
  const read = { action: 'read', name: info.name };
  assert.equal((await call(read)).text, manifest);
  const tool = contributions.list('tools')[0].value;
  assert.equal(tool.name, 'assistant_skill_read');
  const args = { name: info.name, path: 'docs/参考.md' };
  assert.deepEqual(await tool.execute(args, new AbortController().signal), { ...args, text: '说明正文', nextOffset: null });
  const long = { name: info.name, path: 'long.txt' }, signal = new AbortController().signal;
  assert.deepEqual(await tool.execute(long, signal), { ...long, text: '龟🦖'.repeat(3000), nextOffset: 6000 });
  assert.deepEqual(await tool.execute({ ...long, offset: 6000 }, signal), { ...long, text: '龟🦖', nextOffset: null });
  assert.equal((await call({ ...read, path: long.path })).text, '龟🦖'.repeat(3001));
  for (const offset of [-1, 6003, 0.5, '0']) await assert.rejects(tool.execute({ ...long, offset }, signal), { status: 400 });
  await assert.rejects(call({ ...read, path: '../other' }), { status: 400 });
  assert.equal((await call({ ...read, path: 'empty.txt' })).text, '');
  await assert.rejects(call({ ...read, path: 'image.bin' }), { status: 415 });
  await assert.rejects(call({ action: 'remove', name: info.name, revision: 0 }), { status: 409 });
  await host.setEnabled('assistant-skills', false);
  await assert.rejects(tool.execute(args, new AbortController().signal), { status: 503 });
  await host.setEnabled('assistant-skills', true);
  assert.equal((await call(read)).text, manifest);
  assert.deepEqual(await call({ action: 'remove', name: info.name, revision: 1 }), { revision: 2, skills: [], builtinSkills });
  assert.deepEqual(store.list('assistant-skills.files'), []);
  await assert.rejects(call(read), { status: 404 });
});

test('archive validation rejects ambiguous layouts, nonregular entries and size limits before installation', async t => {
  const { call } = await fixture(t);
  const invalidPackages = [
    new JSZip().file('readme.md', 'no manifest'),
    new JSZip().file('a/SKILL.md', manifest).file('b/other.txt', 'unrelated'),
    new JSZip().file('SKILL.md', manifest).file('docs/A.md', 'a').file('docs/a.md', 'b'),
    new JSZip().file('SKILL.md', manifest).file('linked', 'name', { unixPermissions: 0o120777 }),
    new JSZip().file('SKILL.md', manifest.replace('demo-skill', 'Bad Name')),
    new JSZip().file('SKILL.md', manifest.replace('简要说明', '龟'.repeat(257))),
    new JSZip().file('SKILL.md', manifest).file('large.txt', 'A'.repeat(200_000)),
  ];
  for (const zip of invalidPackages) await assert.rejects(call({ action: 'preview', archive: await archive(zip) }), { status: 400 });
  await assert.rejects(call({ action: 'preview', archive: 'bad base64!' }), { status: 400 });
  assert.deepEqual(await call({ action: 'list' }), { revision: 0, skills: [], builtinSkills });
});

test('skill catalog refuses a 33rd installation and accepts another after removal', async t => {
  const { call } = await fixture(t);
  async function bundle(index: number) {
    const data = await archive(new JSZip().file('SKILL.md', manifest.replace('demo-skill', 'test-' + index)));
    return { archive: data, digest: createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex') };
  }
  for (let i = 0; i < 32; i++) await call({ action: 'install', ...await bundle(i), revision: i });
  const extra = await bundle(32);
  await assert.rejects(call({ action: 'preview', archive: extra.archive }), { status: 400 });
  await assert.rejects(call({ action: 'install', ...extra, revision: 32 }), { status: 400 });
  await call({ action: 'remove', name: 'test-0', revision: 32 });
  assert.equal((await call({ action: 'install', ...extra, revision: 33 })).revision, 34);
});

test('builtin guide uses release resources with an existing catalog and never changes its stored revision', async t => {
  const { call, store, contributions } = await fixture(t);
  const existing = { revision: 8, skills: [{ name: 'old-skill', description: '既有技能' }] };
  store.put('assistant-skills', 'catalog', existing);
  assert.deepEqual(await call({ action: 'list' }), { ...existing, builtinSkills });
  const read = { action: 'read', name: 'workbench.work' };
  assert.ok(workGuide.files.has('SKILL.md'));
  assert.equal((await call(read)).text, workGuide.files.get('SKILL.md'));
  const tool = contributions.list('tools')[0].value;
  for (const [path, text] of workGuide.files) {
    assert.deepEqual(await call({ ...read, path }), { name: read.name, path, text });
    const page = await tool.execute({ name: read.name, path }, new AbortController().signal) as JsonObject;
    assert.equal(page.text, Array.from(text).slice(0, 6000).join(''));
  }
  await assert.rejects(call({ ...read, path: 'missing.md' }), { status: 404 });
  await assert.rejects(call({ ...read, path: '../outside' }), { status: 400 });
  await assert.rejects(call({ action: 'remove', name: read.name, revision: 8 }), { status: 409 });
  const shadow = await archive(new JSZip().file('SKILL.md', manifest.replace('demo-skill', read.name)));
  await assert.rejects(call({ action: 'preview', archive: shadow }), { status: 400 });
  assert.deepEqual(store.get('assistant-skills', 'catalog'), existing);
  assert.deepEqual(store.list('assistant-skills.files'), []);
});
