import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMachineSkills } from '../plugins/machine-skills.ts';

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'machine-skills-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = join(home, 'profile1'), claudeHome = join(home, 'profile2');
  const scan = createMachineSkills({ home, codexHome, claudeHome }).handlers['skills.catalog'];
  async function write(profile: string, id: string, body: string) {
    const dir = join(profile, 'skills', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), body);
    return dir;
  }
  return { home, codexHome, claudeHome, shared: join(home, '.agents'), scan, write };
}

test('catalog reads invocation metadata within configured profile roots and reports each physical manifest once', async t => {
  const { home, codexHome, claudeHome, shared, scan, write } = await fixture(t);
  const sharedSkill = await write(shared, 'review', '---\nname: 审阅\ndescription: |\n  分析结构\n  给出建议\n---\n机密正文');
  await write(codexHome, 'internal', '---\nname: private\nuser-invocable: false # hidden\n---');
  await write(codexHome, 'ambiguous', '---\nname: unknown\nuser-invocable: [true]\n---');
  await write(codexHome, '.hidden', '---\nname: hidden\n---');
  await write(codexHome, 'no-header', '不含前置元数据');
  await write(codexHome, 'nested/nested', '---\nname: nested\n---');
  await write(claudeHome, 'fallback', '---\nuser-invocable: true\n---\n' + '正文'.repeat(20_000));
  await symlink(sharedSkill, join(codexHome, 'skills', 'review'));
  const outside = await write(join(home, 'unconfigured'), 'outside', '---\nname: outside\n---');
  await symlink(outside, join(codexHome, 'skills', 'outside'));
  const externalFile = join(claudeHome, 'skills', 'external-file');
  await mkdir(externalFile);
  await symlink(join(outside, 'SKILL.md'), join(externalFile, 'SKILL.md'));
  await mkdir(join(shared, 'skills', 'nonregular', 'SKILL.md'), { recursive: true });
  await symlink(join(home, 'absent'), join(shared, 'skills', 'broken'));
  assert.deepEqual(await scan({}), { skills: [
    { name: '审阅', description: '分析结构 给出建议', source: 'codex' },
    { name: 'fallback', description: '', source: 'claude-code' },
  ], truncated: false });
  await assert.rejects(scan({ path: outside }), /不接受/);
});

test('catalog distinguishes missing optional roots from unreadable directories and invalid frontmatter', async t => {
  const { home, codexHome, claudeHome, scan, write } = await fixture(t);
  assert.deepEqual(await scan({}), { skills: [], truncated: false });
  await mkdir(claudeHome);
  await writeFile(join(claudeHome, 'skills'), 'ordinary file');
  await assert.rejects(scan({}), /claude-code.*无法读取/);
  await rm(join(claudeHome, 'skills'));
  const dir = await write(codexHome, 'bad', '---\ndescription: ' + 'a'.repeat(16 * 1024) + '\n---');
  await assert.rejects(scan({}), /codex.*元数据无法读取/);
  await writeFile(join(dir, 'SKILL.md'), '---\nname: [invalid\n---');
  await assert.rejects(scan({}), /codex.*元数据无法读取/);
  await rm(dir, { recursive: true });
  // Explicit profiles must not pick up a skill installed in the default profile.
  await write(join(home, '.codex'), 'default', '---\nname: default\n---');
  assert.deepEqual(await scan({}), { skills: [], truncated: false });
});

test('catalog marks a partial response when more than 512 invocable skills exist', async t => {
  const { shared, write, scan } = await fixture(t);
  for (let i = 0; i < 513; i++) await write(shared, 'skill-' + String(i).padStart(3, '0'), '---\ndescription: x\n---');
  const result = await scan({});
  assert.equal(result.skills.length, 512);
  assert.equal(result.truncated, true);
  assert.equal(result.skills[0].name, 'skill-000');
  assert.equal(result.skills.at(-1)?.name, 'skill-511');
});

test('an invalid optional profile leaves the machine handler registry available until the catalog is requested', async t => {
  const { home, claudeHome } = await fixture(t);
  const adapter = createMachineSkills({ home, claudeHome, codexHome: 'relative' });
  assert.equal(typeof adapter.handlers['skills.catalog'], 'function');
  await assert.rejects(adapter.handlers['skills.catalog']({}), /绝对目录/);
});

test('catalog truncates by serialized UTF-8 size before reaching the item count limit', async t => {
  const { shared, write, scan } = await fixture(t);
  const description = '🐢🐢🐢"'.repeat(128);
  const source = '---\ndescription: ' + JSON.stringify(description) + '\n---';
  for (let i = 0; i < 500; i++) await write(shared, 'wide-' + String(i).padStart(3, '0'), source);
  const result = await scan({});
  assert.equal(result.truncated, true);
  assert.ok(result.skills.length > 0 && result.skills.length < 500);
  const size = Buffer.byteLength(JSON.stringify(result));
  assert.ok(size <= 768 * 1024);
  const next = { name: 'wide-' + String(result.skills.length).padStart(3, '0'), description, source: 'shared' };
  assert.ok(size + 1 + Buffer.byteLength(JSON.stringify(next)) > 768 * 1024);
});

test('a configured skills directory can link to its canonical installation', async t => {
  const { home, codexHome, scan, write } = await fixture(t);
  const install = join(home, 'skill-packages');
  await write(install, 'linked-root', '---\ndescription: 共享安装路径\n---');
  await mkdir(codexHome);
  await symlink(join(install, 'skills'), join(codexHome, 'skills'));
  assert.deepEqual((await scan({})).skills, [{ name: 'linked-root', description: '共享安装路径', source: 'codex' }]);
});
