import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { createWorkspaceWrite } from '../plugins/workspace-write.ts';
import type { Json } from '../packages/plugin-sdk/src/index.ts';
import type { Project } from '../packages/protocol/src/index.ts';

const hash = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const TOKEN = 'workspace-write-fixture';

async function fixture(t: TestContext, options: { offers?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-write-http-'));
  const root = join(dir, 'project');
  await mkdir(root);
  await writeFile(join(root, 'README.md'), 'first\n');
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token: TOKEN });
  // The handler is the real one, as the agent node would offer it, on the project's own directory.
  const write = createWorkspaceWrite({ dataDir: join(dir, 'agent') });
  const asked: string[] = [];
  const node = startAgentNode({ url: server.url, token: TOKEN, machineId: 'write-machine', name: '工作电脑', dataDir: join(dir, 'node'), executors: [],
    handlers: options.offers === false ? {} : {
      'workspace.code': async () => ({}) as unknown as Json,
      'workspace.file.write': async params => { asked.push('write'); return write.handlers['workspace.file.write']!(params, () => {}); },
      'workspace.file.undo': async params => { asked.push('undo'); return write.handlers['workspace.file.undo']!(params, () => {}); },
    } });
  t.after(async () => { await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  for (let tries = 0; tries < 100 && !server.machines.list().some(item => item.id === 'write-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  let projectId = '';
  if (options.offers !== false) {
    const project = server.app.projects.create({ name: '写文件项目', workspace: { machineId: 'write-machine', cwd: root } }) as unknown as Project;
    projectId = project.id;
  }
  const call = async (path: string, method: string, body?: object) => {
    const answer = await fetch(server.url + '/api/v1' + path, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: answer.status, body: await answer.json() as Record<string, unknown> };
  };
  return { server, root, node, asked, call, projectId };
}

test('页面保存项目里的一个文件，服务端从项目绑定找到电脑并让它的执行机写；撤销走同一条路', async t => {
  const f = await fixture(t);
  const before = hash(await readFile(join(f.root, 'README.md'), 'utf8'));
  const saved = await f.call('/projects/' + f.projectId + '/code/file', 'PUT', { path: 'README.md', text: 'second\n', expected: before });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.written, true);
  assert.equal(typeof saved.body.undoId, 'string');
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'second\n');
  // The undo is asked for by its id and what is there now.
  const undone = await f.call('/projects/' + f.projectId + '/code/file/undo', 'POST', { undoId: saved.body.undoId, expected: saved.body.hash });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.undone, true);
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'first\n');
  assert.deepEqual(f.asked, ['write', 'undo']);
});

test('项目不存在、没有绑定、电脑离线、代理太旧、参数不对时各自说明原因，不写任何东西', async t => {
  const f = await fixture(t);
  const file = { path: 'README.md', text: 'x', expected: hash('first\n') };
  assert.equal((await f.call('/projects/no-such-project/code/file', 'PUT', file)).status, 404);
  assert.equal((await f.call('/projects/' + f.projectId + '/code/file', 'POST', file)).status, 404, 'writing is a PUT');
  assert.equal((await f.call('/projects/' + f.projectId + '/code/file', 'PUT', { ...file, cwd: '/etc' })).status, 400, 'the page cannot say which directory');
  // Without saying what was read, the computer refuses: a file that is there may have changed.
  assert.equal((await f.call('/projects/' + f.projectId + '/code/file', 'PUT', { path: 'README.md', text: 'x' })).status, 409);
  const extra = await f.call('/projects/' + f.projectId + '/code/file/undo', 'POST', { undoId: 'x', path: 'y' });
  assert.equal(extra.status, 400, JSON.stringify(extra.body));
  // A file that changed on the computer is refused by the computer, and the page is told why.
  await writeFile(join(f.root, 'README.md'), 'someone else\n');
  const stale = await f.call('/projects/' + f.projectId + '/code/file', 'PUT', file);
  assert.equal(stale.status, 409);
  assert.match(String(stale.body.error), /已经变化/);
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'someone else\n');
  // Without the owner's token there is no writing.
  const noToken = await fetch(f.server.url + '/api/v1/projects/' + f.projectId + '/code/file', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(file) });
  assert.equal(noToken.status, 401);
  // The computer goes offline: the writing is refused here and not left hanging.
  await f.node.close();
  for (let tries = 0; tries < 100 && f.server.machines.list().some(item => item.id === 'write-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await f.call('/projects/' + f.projectId + '/code/file', 'PUT', { ...file, expected: hash('someone else\n') })).status, 503);
  // The two writes that reached the computer were both refused by it; nothing else was asked.
  assert.deepEqual(f.asked, ['write', 'write']);
});

test('一台没有写文件能力的旧代理，服务端让页面升级', async t => {
  const f = await fixture(t, { offers: false });
  const project = f.server.app.projects.create({ name: '旧代理项目', workspace: { machineId: 'write-machine', cwd: f.root } }) as unknown as Project;
  assert.equal((await f.call('/projects/' + project.id + '/code/file', 'PUT', { path: 'README.md', text: 'x', expected: hash('first\n') })).status, 409);
  assert.equal((await f.call('/projects/' + project.id + '/code/file/undo', 'POST', { undoId: 'x' })).status, 409);
  assert.deepEqual(f.asked, []);
});
