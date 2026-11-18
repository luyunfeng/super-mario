import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'mario-discovery-'));
  const home = join(base, 'home');
  const cwd = join(base, 'current');
  await mkdir(home); await mkdir(cwd);
  const env = process.env.SUPER_MARIO_PROJECT_ROOTS;
  delete process.env.SUPER_MARIO_PROJECT_ROOTS;
  t.after(async () => {
    if (env === undefined) delete process.env.SUPER_MARIO_PROJECT_ROOTS;
    else process.env.SUPER_MARIO_PROJECT_ROOTS = env;
    await rm(base, { recursive: true, force: true });
  });
  async function file(path: string, text: string) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); }
  async function git(path: string, worktree = false) {
    await mkdir(path, { recursive: true });
    if (worktree) await file(join(path, '.git'), 'gitdir: /not-read');
    else await mkdir(join(path, '.git'));
    return path;
  }
  function discovery(roots: string[] = []) { return createProjectDiscovery({ home, cwd, roots, temporaryRoots: [join(base, 'temporary')] }).handlers; }
  return { base, home, cwd, file, git, discovery };
}

test('explicit shallow Git inventory retains ordinary gitfiles, skipped folders, symlinks and root de-duplication', async t => {
  const f = await fixture(t);
  const root = join(f.base, 'code');
  const repo = await f.git(join(root, 'repo'));
  const worktree = await f.git(join(root, 'org', 'worktree'), true);
  await f.git(join(root, 'node_modules', 'ignored'));
  await f.git(join(root, '.cache', 'ignored'));
  const outside = await f.git(join(f.base, 'outside'));
  await symlink(outside, join(root, 'linked'));
  await symlink(root, join(f.base, 'root-link'));
  await symlink(root, join(root, 'loop'));
  const result = await f.discovery()['workspace.projects']({ roots: [root, join(f.base, 'root-link')] });
  assert.deepEqual(result.projects.map(p => p.cwd).sort(), [repo, worktree].sort());
  assert.deepEqual(result.roots, [root]);
  assert.ok(result.projects.every(p => p.exists && p.sources.includes('git')));
  assert.equal(result.truncated, false);
});

test('history discovers folders without Git, missing folders and merges canonical sources with latest time', async t => {
  const f = await fixture(t);
  const project = join(f.base, 'plain'); await mkdir(project);
  const alias = join(f.base, 'alias'); await symlink(project, alias);
  const gone = join(f.base, 'gone');
  await f.file(join(f.home, '.codex/sessions/2026/11/16/new.jsonl'), JSON.stringify({ type: 'session_meta', timestamp: '2026-11-16T01:00:00Z', payload: { cwd: alias } }) + '\n' + 'private prompt\n'.repeat(10000));
  await f.file(join(f.home, '.claude.json'), JSON.stringify({ projects: { [project]: {}, [gone]: {} } }));
  await f.file(join(f.home, '.claude/projects/encoded/one.jsonl'), JSON.stringify({ type: 'user', cwd: project, timestamp: '2026-11-16T02:00:00Z', message: { content: 'PRIVATE-PROMPT' } }) + '\n');
  const result = await f.discovery()['workspace.projects']({});
  assert.equal(result.projects.length, 2);
  const row = result.projects.find(p => p.cwd === project)!;
  assert.deepEqual(row.sources.sort(), ['claude', 'codex']);
  assert.equal(row.lastUsedAt, '2026-11-16T02:00:00.000Z');
  assert.equal(result.projects.find(p => p.cwd === gone)?.exists, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-PROMPT'));
  assert.equal(result.truncated, false, 'large transcript body does not truncate a fully identified header');
});

test('Claude pretty session metadata and project indexes resolve paths without guessing encoded names', async t => {
  const f = await fixture(t);
  const first = join(f.base, 'first'); await mkdir(first);
  const second = join(f.base, 'second'); await mkdir(second);
  await f.file(join(f.home, '.claude/sessions/123.json'), JSON.stringify({ cwd: first }, null, 2));
  await f.file(join(f.home, '.claude/projects/not-a-decodable-path/sessions-index.json'), JSON.stringify({ originalPath: second, entries: [{ projectPath: second, modified: '2026-11-15T00:00:00Z' }] }));
  const result = await f.discovery()['workspace.projects']({});
  assert.deepEqual(result.projects.map(p => p.cwd).sort(), [first, second].sort());
});

test('bad, absent and unreadable metadata is skipped with bounded non-content warnings', async t => {
  const f = await fixture(t);
  await f.file(join(f.home, '.claude.json'), '{PRIVATE-BAD-JSON');
  await f.file(join(f.home, '.codex/sessions/bad.jsonl'), '{PRIVATE-SESSION\n');
  await f.file(join(f.home, '.claude/sessions/missing.json'), JSON.stringify({ sessionId: 'no-cwd' }));
  const locked = join(f.home, '.claude/projects/locked'); await mkdir(locked, { recursive: true });
  await chmod(locked, 0);
  t.after(() => chmod(locked, 0o700).catch(() => {}));
  const result = await f.discovery()['workspace.projects']({});
  assert.deepEqual(result.projects, []);
  assert.ok(result.warnings.length >= 2 && result.warnings.length <= 12);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('large header reads only bounded scalars and never treats a prompt string as cwd', async t => {
  const f = await fixture(t);
  const project = join(f.base, 'plain'); await mkdir(project);
  await f.file(join(f.home, '.codex/sessions/good.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: project, base_instructions: { text: 'x'.repeat(40000) } } }));
  await f.file(join(f.home, '.codex/sessions/trap.jsonl'), JSON.stringify({ type: 'session_meta', payload: { instructions: { cwd: '/must-not-be-discovered', text: 'x'.repeat(40000) } } }));
  const result = await f.discovery()['workspace.projects']({});
  assert.deepEqual(result.projects.map(p => p.cwd), [project]);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.length);
});

test('symlinked metadata files and directories are never traversed', async t => {
  const f = await fixture(t);
  const external = join(f.base, 'external');
  await f.file(join(external, 'meta.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: f.cwd } }));
  await mkdir(join(f.home, '.codex/sessions'), { recursive: true });
  await symlink(external, join(f.home, '.codex/sessions/link'));
  await symlink(join(external, 'meta.jsonl'), join(f.home, '.codex/sessions/link.jsonl'));
  assert.deepEqual((await f.discovery()['workspace.projects']({})).projects, []);
});

test('session and directory budgets report truncation and prefer recent dated session paths', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 270; i++) await f.file(join(f.home, '.codex/sessions/2026/11/16', `session-${String(i).padStart(4, '0')}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { cwd: join(f.base, `project-${i}`) } }));
  const result = await f.discovery()['workspace.projects']({});
  assert.equal(result.truncated, true);
  assert.equal(result.projects.length, 256);
  assert.ok(result.projects.some(p => p.cwd.endsWith('project-269')));
  assert.ok(!result.projects.some(p => p.cwd.endsWith('project-0')));
});

test('shallow depth and huge directory fan-out are bounded honestly', async t => {
  const f = await fixture(t);
  const root = join(f.base, 'code');
  await f.git(join(root, 'org', 'group', 'deep'));
  let result = await f.discovery([root])['workspace.projects']({});
  assert.deepEqual(result.projects, []);
  assert.equal(result.truncated, true);
  for (let i = 0; i < 520; i++) await mkdir(join(root, `empty-${i}`));
  result = await f.discovery([root])['workspace.projects']({});
  assert.equal(result.truncated, true);
});

test('default uses CLI history only; environment and RPC roots opt into directory scanning', async t => {
  const f = await fixture(t);
  const common = await f.git(join(f.home, 'code', 'common'));
  const sibling = await f.git(join(f.base, 'sibling'));
  const extra = await f.git(join(f.base, 'extra-root', 'extra'));
  const other = await f.git(join(f.base, 'other-root', 'other'));
  process.env.SUPER_MARIO_PROJECT_ROOTS = [join(f.base, 'extra-root'), 'relative-invalid'].join(delimiter);
  const handlers = createProjectDiscovery({ home: f.home, cwd: f.cwd, temporaryRoots: [] }).handlers;
  await f.file(join(f.home, '.claude.json'), JSON.stringify({ projects: { [common]: {} } }));
  const defaults = await handlers['workspace.projects']({});
  assert.ok([common, extra].every(cwd => defaults.projects.some(p => p.cwd === cwd)));
  assert.ok(!defaults.projects.some(p => p.cwd === sibling), 'nearby repositories are not implicitly scanned');
  const selected = await handlers['workspace.projects']({ roots: [join(f.base, 'other-root')] });
  assert.deepEqual(selected.projects.map(p => p.cwd).sort(), [common, extra, other].sort());
  assert.ok(selected.warnings.length > 0);
});

test('directory RPC canonicalizes existing folders, rejects invalid requests and never creates paths', async t => {
  const f = await fixture(t);
  const handlers = f.discovery();
  const alias = join(f.base, 'alias'); await symlink(f.cwd, alias);
  assert.deepEqual(await handlers['workspace.directory']({ cwd: alias }), { cwd: f.cwd, exists: true });
  const missing = join(f.base, 'never-created');
  await f.file(join(f.base, 'file'), 'not a folder');
  for (const params of [{}, { cwd: 'relative' }, { cwd: '/bad\0path' }, { cwd: f.cwd, extra: true }, { cwd: missing }, { cwd: join(f.base, 'file') }, { cwd: 1 }, null, []]) {
    await assert.rejects(handlers['workspace.directory'](params));
  }
  for (const params of [{ root: f.cwd }, { roots: 'bad' }, { roots: [1] }, { roots: ['relative'] }, { roots: Array(33).fill(f.cwd) }, null]) {
    await assert.rejects(handlers['workspace.projects'](params));
  }
  await assert.rejects(access(missing), { code: 'ENOENT' });
  const root = await handlers['workspace.projects']({ roots: ['/'] });
  assert.deepEqual(root.roots, []);
  assert.ok(root.warnings.length > 0);
});

test('real node transport advertises both read-only methods and returns directory validation errors', async t => {
  const f = await fixture(t);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const done = new Promise<void>((resolve, reject) => {
    server.on('connection', socket => socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'hello') {
          assert.ok(message.capabilities.includes('workspace.projects'));
          assert.ok(message.capabilities.includes('workspace.directory'));
          socket.send(JSON.stringify({ type: 'welcome', machineId: 'test' }));
          socket.send(JSON.stringify({ type: 'call', id: 'directory', method: 'workspace.directory', params: { cwd: f.cwd } }));
        } else if (message.id === 'directory') {
          assert.deepEqual(message.result, { cwd: f.cwd, exists: true });
          socket.send(JSON.stringify({ type: 'call', id: 'missing', method: 'workspace.directory', params: { cwd: join(f.base, 'missing') } }));
        } else if (message.id === 'missing') {
          assert.ok(message.error);
          socket.send(JSON.stringify({ type: 'call', id: 'projects', method: 'workspace.projects', params: {} }));
        } else if (message.id === 'projects') {
          assert.deepEqual(message.result, { projects: [], roots: [], warnings: [], truncated: false });
          resolve();
        }
      } catch (error) { reject(error); }
    }));
  });
  const agent = startAgentNode({ url: `http://127.0.0.1:${address.port}`, token: 'test-only', machineId: 'test', name: 'test', dataDir: f.base, handlers: f.discovery() });
  t.after(async () => { await agent.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await done;
  const entry = await readFile(new URL('../bin/super-mario-agent.js', import.meta.url), 'utf8');
  assert.ok(entry.includes('../dist/plugins/project-discovery.js'));
  assert.ok(entry.includes('../plugins/project-discovery.ts'));
  assert.ok(entry.includes('...discovery.handlers'));
});


test('real linked worktrees and their history subfolders are excluded, main repo and submodule gitfiles survive; manual binding remains available', async t => {
  const f = await fixture(t), git = promisify(execFile);
  const root = join(f.base, 'code'), main = join(root, 'main'), linked = join(root, 'feature');
  await mkdir(main, { recursive: true });
  await git('git', ['init', main]);
  await git('git', ['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  await git('git', ['-C', main, 'worktree', 'add', '--detach', linked, 'HEAD']);
  const nested = join(linked, 'src'); await mkdir(nested);
  // Relative gitdir pointers and canonical aliases use the same filter.
  const pointer = await readFile(join(linked, '.git'), 'utf8');
  await writeFile(join(linked, '.git'), 'gitdir: ' + relative(linked, pointer.slice(8).trim()) + '\n');
  const alias = join(root, 'alias'); await symlink(linked, alias);
  const ordinary = join(root, 'ordinary'); await mkdir(ordinary);
  const submodule = join(root, 'module'); await mkdir(submodule);
  const moduleGit = join(main, '.git', 'modules', 'module'); await mkdir(moduleGit, { recursive: true });
  await f.file(join(submodule, '.git'), 'gitdir: ' + moduleGit + '\n');
  const namedWorktree = await f.git(join(root, 'worktrees-real-project'));
  await f.file(join(f.home, '.claude.json'), JSON.stringify({ projects: { [linked]: {}, [nested]: {}, [alias]: {}, [main]: {}, [ordinary]: {}, [submodule]: {} } }));
  await f.file(join(f.home, '.codex/sessions/one.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: linked } }));
  const handlers = f.discovery();
  const history = await handlers['workspace.projects']({});
  assert.deepEqual(history.projects.map(p => p.cwd).sort(), [main, ordinary, submodule].sort());
  const scanned = await handlers['workspace.projects']({ roots: [root, linked, nested] });
  assert.deepEqual(scanned.projects.map(p => p.cwd).sort(), [main, ordinary, submodule, namedWorktree].sort());
  assert.deepEqual(await handlers['workspace.directory']({ cwd: linked }), { cwd: linked, exists: true });
  assert.ok(await readFile(join(linked, '.git'), 'utf8'), 'discovery leaves real directories intact');
});

test('temporary history directories and aliases are excluded but ordinary history projects and manual validation remain', async t => {
  const f = await fixture(t), temporary = join(f.base, 'temporary');
  const transient = await f.git(join(temporary, 'acceptance', 'work'));
  const ordinary = await f.git(join(f.base, 'temporary-looking-project'));
  const alias = join(f.base, 'alias-to-temp'); await symlink(transient, alias);
  await f.file(join(f.home, '.claude.json'), JSON.stringify({ projects: { [transient]: {}, [ordinary]: {}, [alias]: {}, [join(temporary, 'gone')]: {} } }));
  await f.file(join(f.home, '.codex/sessions/one.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: transient } }));
  const handlers = f.discovery();
  for (const params of [{}, { roots: [temporary, f.base] }]) {
    const result = await handlers['workspace.projects'](params);
    assert.deepEqual(result.projects.map(p => p.cwd), [ordinary]);
  }
  assert.deepEqual(await handlers['workspace.directory']({ cwd: transient }), { cwd: transient, exists: true });
  // Production defaults really exclude the OS temporary root; fixtures above inject a smaller one.
  const defaults = createProjectDiscovery({ home: f.home, cwd: ordinary }).handlers;
  assert.deepEqual((await defaults['workspace.projects']({})).projects, []);
});


test('CLI project indexes larger than a transcript header still supply history projects', async t => {
  const f = await fixture(t), project = join(f.base, 'index-project'); await mkdir(project);
  await f.file(join(f.home, '.claude.json'), JSON.stringify({ padding: 'PRIVATE'.repeat(4000), projects: { [project]: {} } }));
  const result = await f.discovery()['workspace.projects']({});
  assert.deepEqual(result.projects.map(p => p.cwd), [project]);
  assert.equal(result.truncated, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('internal history-only reuse ignores configured code roots without mutating process environment',async t=>{
 const f=await fixture(t), root=join(f.base,'extra-root');await f.git(join(root,'extra'));
 process.env.SUPER_MARIO_PROJECT_ROOTS=root;
 const handlers=createProjectDiscovery({home:f.home,roots:[],temporaryRoots:[],ignoreEnvironmentRoots:true}).handlers;
 const result=await handlers['workspace.projects']({});assert.deepEqual(result.projects,[]);assert.deepEqual(result.roots,[]);assert.equal(process.env.SUPER_MARIO_PROJECT_ROOTS,root);
});
