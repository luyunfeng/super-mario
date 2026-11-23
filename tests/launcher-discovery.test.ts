import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { createCliSessionDiscovery } from '../plugins/cli-session-discovery.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'mario-launcher-discovery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home'), codexHome = join(base, 'profiles/codex'), claudeHome = join(base, 'profiles/claude');
  const temporary = join(base, 'temporary');
  for (const path of [home, codexHome, claudeHome]) await mkdir(path, { recursive: true });
  async function dir(name: string) { const path = join(base, name); await mkdir(path, { recursive: true }); return path; }
  async function file(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  }
  async function codex(root: string, id: string, cwd: string) {
    await file(join(root, 'sessions/2026/11/17', `${id}.jsonl`), [
      { type: 'session_meta', payload: { id, cwd } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Review the project tests.' } },
    ].map(record => JSON.stringify(record)).join('\n'));
  }
  async function claude(root: string, id: string, cwd: string) {
    await file(join(root, 'projects/encoded', `${id}.jsonl`), { sessionId: id, cwd, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Review the project tests.' }] } });
  }
  const defaults = { home, temporaryRoots: [temporary], ignoreEnvironmentRoots: true, roots: [] };
  const explicit = { ...defaults, codexHome, claudeHome };
  return { base, home, codexHome, claudeHome, temporary, defaults, explicit, dir, file, codex, claude };
}

test('explicit CLI config roots isolate history, project indexes and exact resume from default accounts', async t => {
  const f = await fixture(t), selected = await f.dir('selected'), other = await f.dir('other-account');
  const configOnly = await f.dir('config-only'), indexOnly = await f.dir('index-only');
  await f.codex(f.codexHome, 'shared', selected);
  await f.claude(f.claudeHome, 'shared', selected);
  await f.codex(join(f.home, '.codex'), 'shared', other);
  await f.claude(join(f.home, '.claude'), 'shared', other);
  await f.codex(join(f.home, '.codex'), 'default-only', other);
  await f.claude(join(f.home, '.claude'), 'default-only', other);
  await f.file(join(f.home, '.claude.json'), { projects: { [other]: {} } });
  await f.file(join(f.home, '.claude/config.json'), { projects: { [other]: {} } });
  await f.file(join(f.claudeHome, 'config.json'), { projects: { [configOnly]: {} } });
  await f.file(join(f.claudeHome, 'projects/index/sessions-index.json'), {
    entries: [{ sessionId: 'indexed', projectPath: indexOnly }],
  });
  const headerOnly = await f.dir('header-only');
  await f.file(join(f.claudeHome, 'sessions/pretty.json'), { session_id: 'pretty', cwd: headerOnly });
  const d = createCliSessionDiscovery(f.explicit);
  const inventory = await d.handlers['agents.sessions']({});
  // roots: [] limits the session inventory; omit it to inspect all profile history.
  const all = await d.handlers['agents.sessions']({ roots: [f.base] });
  assert.deepEqual(inventory.sessions, []);
  assert.deepEqual(all.sessions.map(s => s.id).sort(), ['claude-code:indexed', 'claude-code:pretty', 'claude-code:shared', 'codex:shared']);
  assert.equal(all.truncated, false);
  for (const [nativeSessionId, cwd] of [['pretty', headerOnly], ['indexed', indexOnly]]) {
    assert.equal((await d.validateResume({ executorId: 'claude-code', nativeSessionId, cwd })).cwd, cwd);
  }
  const projects = await createProjectDiscovery(f.explicit).handlers['workspace.projects']({});
  assert.deepEqual(projects.projects.map(p => p.cwd).sort(), [selected]);
  for (const executorId of ['codex', 'claude-code'] as const) {
    assert.equal((await d.validateResume({ executorId, nativeSessionId: 'shared', cwd: selected })).cwd, selected);
    await assert.rejects(d.validateResume({ executorId, nativeSessionId: 'shared', cwd: other }), /未找到/);
    await assert.rejects(d.validateResume({ executorId, nativeSessionId: 'default-only', cwd: other }), /未找到/);
  }
});

test('omitted provider roots retain default home history independently and leave other home paths intact', async t => {
  const f = await fixture(t), defaultCode = await f.dir('default-code'), defaultClaude = await f.dir('default-claude');
  const global = await f.dir('global-config'), configured = await f.dir('configured-code');
  await f.codex(join(f.home, '.codex'), 'default-code', defaultCode);
  await f.claude(join(f.home, '.claude'), 'default-claude', defaultClaude);
  await f.file(join(f.home, '.claude.json'), { projects: { [global]: {} } });
  await f.codex(f.codexHome, 'configured', configured);
  const defaults = await createProjectDiscovery(f.defaults).handlers['workspace.projects']({});
  assert.deepEqual(defaults.projects.map(p => p.cwd).sort(), [defaultCode, defaultClaude].sort());
  const mixed = { ...f.defaults, codexHome: f.codexHome };
  assert.deepEqual((await createProjectDiscovery(mixed).handlers['workspace.projects']({})).projects.map(p => p.cwd).sort(), [configured, defaultClaude].sort());
  assert.deepEqual((await createCliSessionDiscovery(mixed).handlers['agents.sessions']({ roots: [f.base] })).sessions.map(s => s.nativeSessionId).sort(), ['configured', 'default-claude']);
  const claudeOnly = { ...f.defaults, claudeHome: f.claudeHome };
  assert.deepEqual((await createProjectDiscovery(claudeOnly).handlers['workspace.projects']({})).projects.map(p => p.cwd), [defaultCode]);
});

test('missing or non-directory explicit roots return empty warnings without fallback or directory creation', async t => {
  const f = await fixture(t), cwd = await f.dir('project');
  await f.codex(join(f.home, '.codex'), 'default', cwd);
  await f.claude(join(f.home, '.claude'), 'default', cwd);
  await f.file(join(f.home, '.claude.json'), { projects: { [cwd]: {} } });
  const missing = join(f.base, 'absent-profile'), ordinary = join(f.base, 'file');
  await f.file(ordinary, 'ordinary file');
  for (const root of [missing, ordinary]) {
    const options = { ...f.defaults, codexHome: root, claudeHome: root };
    const d = createCliSessionDiscovery(options);
    const sessions = await d.handlers['agents.sessions']({ roots: [f.base] });
    const projects = await createProjectDiscovery(options).handlers['workspace.projects']({});
    assert.deepEqual(sessions.sessions, []); assert.deepEqual(projects.projects, []);
    for (const result of [sessions, projects]) {
      assert.equal(result.truncated, false);
      assert.ok(result.warnings.some(w => w.includes('Codex') && w.includes('显式配置目录')));
      assert.ok(result.warnings.some(w => w.includes('Claude') && w.includes('显式配置目录')));
    }
    for (const executorId of ['codex', 'claude-code'] as const) await assert.rejects(d.validateResume({ executorId, nativeSessionId: 'default', cwd }), /未找到/);
  }
  await assert.rejects(access(missing), { code: 'ENOENT' });
});

test('both factories reject relative, unbounded and control-character explicit config paths', () => {
  for (const factory of [createCliSessionDiscovery, createProjectDiscovery]) {
    for (const key of ['codexHome', 'claudeHome']) {
      for (const root of ['relative', '', '/', '/a/..', '/bad\npath', '/bad\0path', '/' + 'x'.repeat(4096)]) {
        assert.throws(() => factory({ home: tmpdir(), [key]: root }), /绝对|目录/);
      }
    }
  }
});

test('explicit root aliases pin once; metadata child and ancestor symlinks remain excluded', async t => {
  const f = await fixture(t), cwd = await f.dir('project'), outside = await f.dir('outside');
  await f.codex(f.codexHome, 'selected-code', cwd);
  await f.claude(f.claudeHome, 'selected-claude', cwd);
  const codexAlias = join(f.base, 'codex-alias'), claudeAlias = join(f.base, 'claude-alias');
  await symlink(f.codexHome, codexAlias); await symlink(f.claudeHome, claudeAlias);
  const options = { ...f.explicit, codexHome: codexAlias, claudeHome: claudeAlias };
  const d = createCliSessionDiscovery(options), p = createProjectDiscovery(options);
  async function check() {
    assert.deepEqual((await d.handlers['agents.sessions']({ roots: [f.base] })).sessions.map(s => s.nativeSessionId).sort(), ['selected-claude', 'selected-code']);
    assert.deepEqual((await p.handlers['workspace.projects']({})).projects.map(p => p.cwd), [cwd]);
    assert.equal((await d.validateResume({ executorId: 'codex', nativeSessionId: 'selected-code', cwd })).cwd, cwd);
  }
  await check();
  await rm(codexAlias); await symlink(outside, codexAlias);
  await rm(claudeAlias); await symlink(outside, claudeAlias);
  const hidden = await f.dir('hidden-project');
  await f.codex(outside, 'hidden-code', hidden); await f.claude(outside, 'hidden-claude', hidden);
  await symlink(join(outside, 'sessions'), join(f.codexHome, 'sessions/linked'));
  await symlink(join(outside, 'projects'), join(f.claudeHome, 'projects/linked'));
  await symlink(join(outside, 'sessions/2026/11/17/hidden-code.jsonl'), join(f.codexHome, 'sessions/file.jsonl'));
  await f.file(join(outside, 'config.json'), { projects: { [hidden]: {} } });
  await symlink(join(outside, 'config.json'), join(f.claudeHome, 'config.json'));
  await check();
  // A link above the sessions root must also be refused, not just directory entries.
  await rm(join(f.codexHome, 'sessions'), { recursive: true });
  await symlink(join(outside, 'sessions'), join(f.codexHome, 'sessions'));
  await rm(join(f.claudeHome, 'projects'), { recursive: true });
  await symlink(join(outside, 'projects'), join(f.claudeHome, 'projects'));
  assert.deepEqual((await d.handlers['agents.sessions']({ roots: [f.base] })).sessions, []);
  assert.deepEqual((await p.handlers['workspace.projects']({})).projects, []);
  await assert.rejects(d.validateResume({ executorId: 'codex', nativeSessionId: 'hidden-code', cwd: hidden }), /未找到|读取不足/);
});

test('explicit histories reuse real Git worktree and canonical temporary filters; manual resume still validates', async t => {
  const f = await fixture(t), git = promisify(execFile);
  const main = join(f.base, 'main'), linked = join(f.base, 'ordinary-feature');
  await git('git', ['init', main]);
  await git('git', ['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  await git('git', ['-C', main, 'worktree', 'add', '--detach', linked, 'HEAD']);
  const nested = await f.dir('ordinary-feature/src'), tmp = await f.dir('temporary/work');
  const named = await f.dir('worktrees-real-project'), alias = join(f.base, 'temporary-alias');
  await symlink(tmp, alias);
  const marker = await readFile(join(linked, '.git'), 'utf8');
  await f.file(join(linked, '.git'), 'gitdir: ' + relative(linked, marker.slice(8).trim()) + '\n');
  for (const [id, cwd] of [['main', main], ['linked', linked], ['nested', nested], ['tmp', tmp], ['alias', alias], ['named', named]]) {
    await f.codex(f.codexHome, id, cwd); await f.claude(f.claudeHome, id, cwd);
  }
  const d = createCliSessionDiscovery(f.explicit), p = createProjectDiscovery(f.explicit);
  for (const roots of [[f.base], [linked], [f.temporary]]) {
    const sessions = await d.handlers['agents.sessions']({ roots });
    assert.deepEqual(sessions.sessions.map(s => s.nativeSessionId).sort(), roots[0] === f.base ? ['main', 'main', 'named', 'named'] : []);
    const projects = await p.handlers['workspace.projects']({ roots });
    assert.deepEqual(projects.projects.map(p => p.cwd).sort(), roots[0] === f.base ? [main, named].sort() : []);
  }
  for (const executorId of ['codex', 'claude-code'] as const) {
    assert.equal((await d.validateResume({ executorId, nativeSessionId: 'nested', cwd: nested })).cwd, nested);
    assert.equal((await d.validateResume({ executorId, nativeSessionId: 'tmp', cwd: tmp })).cwd, tmp);
  }
});

test('explicit metadata recursion keeps existing depth budgets', async t => {
  const f = await fixture(t), cwd = await f.dir('project');
  await f.file(join(f.codexHome, 'sessions/a/b/c/d/deep.jsonl'), { type: 'session_meta', payload: { id: 'deep', cwd } });
  const sessions = await createCliSessionDiscovery(f.explicit).handlers['agents.sessions']({ roots: [f.base] });
  const projects = await createProjectDiscovery(f.explicit).handlers['workspace.projects']({});
  assert.deepEqual(sessions.sessions, []); assert.equal(sessions.truncated, true);
  assert.deepEqual(projects.projects, []); assert.equal(projects.truncated, true);
});

test('Codex 归档历史沿用项目范围校验，跨目录重名时拒绝恢复', async t => {
  const f = await fixture(t);
  const cwd = await f.dir('project'), other = await f.dir('other');
  const nativeSessionId = 'archived-thread';
  await f.file(join(f.codexHome, 'archived_sessions', nativeSessionId + '.jsonl'), {
    type: 'session_meta', payload: { id: nativeSessionId, cwd },
  });
  const discovery = createCliSessionDiscovery(f.explicit);
  const list = (root: string) => discovery.handlers['agents.sessions']({ roots: [root] });
  assert.deepEqual((await list(cwd)).sessions.map(s => s.nativeSessionId), [nativeSessionId]);
  assert.deepEqual((await list(other)).sessions, []);
  await f.codex(f.codexHome, nativeSessionId, other);
  assert.deepEqual((await list(f.base)).sessions, []);
  await assert.rejects(discovery.validateResume({ executorId: 'codex', nativeSessionId, cwd }), /冲突/);
});

test('只有已归档 Codex 对话的项目仍可在项目选择器发现', async t => {
  const f = await fixture(t);
  const cwd = await f.dir('archived-project');
  await f.codex(f.codexHome, 'first-thread', cwd);
  const archive = join(f.codexHome, 'archived_sessions');
  await mkdir(archive);
  await rename(join(f.codexHome, 'sessions/2026/11/17/first-thread.jsonl'), join(archive, 'first-thread.jsonl'));
  const discovery = createProjectDiscovery(f.explicit);
  const result = await discovery.handlers['workspace.projects']({});
  assert.deepEqual(result.projects.map(p => p.cwd), [cwd]);
  assert.equal(result.truncated, false);
});
