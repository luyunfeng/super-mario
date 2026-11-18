// Build and install into a disposable node_modules directory, exercising shipped JS only.
import { access, mkdtemp, rm, writeFile, readdir, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const dir = await mkdtemp(join(tmpdir(), 'super-mario-package-'));
let child;
try {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
  const archive = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { cwd: root, encoding: 'utf8' }))[0].filename;
  await writeFile(join(dir, 'package.json'), '{"private":true}');
  execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(dir, archive)], { cwd: dir, stdio: 'pipe', timeout: 120000 });
  await access(join(dir, 'node_modules/super-mario/docs/acceptance-report.md'));
  execFileSync(process.execPath, ['--input-type=module', '-e', "await import('super-mario/plugin-sdk'); await import('super-mario/protocol');"], { cwd: dir, stdio: 'pipe' });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('SUPER_MARIO_')) delete env[key];
  const connector = join(dir, 'data/extensions/command-inbox');
  await mkdir(connector, { recursive: true });
  await cp(join(dir, 'node_modules/super-mario/dist/plugins/command-inbox'), connector, { recursive: true });
  child = spawn(process.execPath, [join(dir, 'node_modules/super-mario/bin/super-mario.js'), '--demo', '--port', '0', '--data-dir', join(dir, 'data')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('安装包启动超时')), 15000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Web: (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('安装包提前退出')); });
  });
  const request = (path, method = 'GET', body) => fetch(url + '/api/v1' + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const webFiles = (await readdir(new URL('../apps/web/', import.meta.url), { recursive: true })).filter(name => /\.(html|js|css|svg)$/.test(name));
  for (const path of ['/', '/vendor/xterm.js', '/vendor/xterm.css', ...webFiles.map(name => '/' + name)]) assert.equal((await fetch(url + path)).status, 200, path);
  for(const name of ['change-watch','approval-followup'])await access(join(dir,`node_modules/super-mario/dist/plugins/examples/${name}/super-mario.extension.json`));
  const background=await (await request('/eventbox')).json();assert.equal(background.schedules.filter(s=>s.owner==='daily-brief').length,2);assert.ok(background.grants.every(g=>g.enabled!==true));
  const installed = await (await request('/state')).json();
  assert.equal(installed.plugins.find(p => p.id === 'command-inbox')?.status, 'active', 'Packaged connector loads from its real JS entry; collection remains disabled');
  const status = await (await request('/feishu')).json();
  assert.equal(status.configured, false); assert.equal('appSecret' in status, false);
  assert.equal((await request('/brief')).status, 200);
  assert.equal((await request('/automation', 'PUT', { tickSeconds: 3 })).status, 200);
  const todo = await (await request('/todos', 'POST', { title: '打包后验收' })).json();
  const proposal = await (await request('/approvals', 'POST', { kind: 'dispatch', title: '打包验证', details: '演示任务', todoId: todo.id, params: { executorId: 'demo', prompt: '安装包验收' } })).json();
  const approved = await (await request(`/approvals/${proposal.id}/approve`, 'POST', { version: proposal.version })).json();
  assert.equal(approved.status, 'completed'); assert.equal(approved.result.accepted, true);
  assert.equal(typeof approved.result.runId, 'string');
  let snapshot;
  for (let i = 0; i < 50; i++) {
    snapshot = await (await request('/state')).json();
    if (snapshot.runs.some(run => run.status === 'completed')) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(snapshot.messages.filter(message => message.origin === 'result').length, 1);
  assert.equal(snapshot.todos[0].completedAt, undefined);
  const planned = await (await request('/plans', 'POST', {title:'安装包批量计划',tasks:[{prompt:'A',executorId:'demo',doneWhen:'核对演示',expectMinutes:1},{prompt:'B',executorId:'demo',doneWhen:'核对演示',expectMinutes:1}]})).json();
  assert.equal(planned.tasks.length,2);
  const started = await (await request(`/plans/${planned.id}/start`, 'POST', {version:planned.version})).json(); assert.equal(started.status,'started');
  const policy = await (await request('/policies','PUT',{rules:[],escalateAfterMinutes:5})).json(); assert.equal(policy.escalateAfterMinutes,5);
  const card = await (await request('/interactions','POST',{kind:'permission',title:'包内权限确认',body:'待用户确认'})).json(); assert.equal(card.handler,'user');
  assert.equal((await request('/supervisor')).status,200);
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  const [code] = await exited; clearTimeout(timeout); assert.equal(code, 0);
  console.log('PASS: 安装包 CLI、SDK、Web、空凭证、审批到结果、SQLite、简报、文档和正常退出');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  await rm(dir, { recursive: true, force: true });
}
