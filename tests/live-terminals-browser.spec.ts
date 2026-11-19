import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createLiveTerminalServices } from '../plugins/live-terminals.ts';

test('项目执行页发现独立CLI：真实HTTP/RPC观察、近期输出、显式接管输入、停止接管与关闭', { timeout: 40000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-live-browser-'));
  const command = join(dir, 'fake-herdr');
  await writeFile(command, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');
const args=process.argv.slice(2),dir=process.env.FAKE_LIVE_DIR;
if(args[0]==='pane'&&args[1]==='list')console.log(JSON.stringify({result:{panes:[{pane_id:'live-pane',terminal_id:'live-terminal',foreground_cwd:dir,agent:'codex',agent_status:'working',terminal_title_stripped:'独立启动的 Codex'}]}}));
else if(args[0]==='pane'&&args[1]==='read')console.log('独立CLI近期输出：正在修改页面');
else if(args[0]==='terminal'){
fs.appendFileSync(path.join(dir,'opens'),args[2]+'\\n');
console.log(JSON.stringify({type:'terminal.frame',seq:0,full:true,encoding:'ansi',width:80,height:24,bytes:Buffer.from('LIVE CODEX OUTPUT').toString('base64')}));
rl.createInterface({input:process.stdin}).on('line',line=>{const data=JSON.parse(line);fs.appendFileSync(path.join(dir,'inputs'),line+'\\n');if(data.type==='terminal.release')process.exit(0)});setInterval(()=>{},1000);
}else process.exit(2);
`, { mode: 0o700 });
  const live = createLiveTerminalServices({ command, env: { HERDR_ENV: '1', FAKE_LIVE_DIR: dir } });
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token: 'offline-token' });
  const node = startAgentNode({ url: server.url, token: 'offline-token', machineId: 'live-machine', name: '测试电脑', dataDir: join(dir, 'node'), handlers: live.handlers, executors: [], onDisconnect: live.disconnect });
  const project = server.app.projects.create({ name: 'CLI 现场项目', workspace: { machineId: 'live-machine', cwd: dir } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  async function inputs() { try { return (await readFile(join(dir, 'inputs'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    await expect.poll(() => server.machines.list().some(machine => machine.online)).toBe(true);
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, reducedMotion: 'reduce' });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    await page.goto(`${server.url}/#projects/${project.id}/runs?token=offline-token`);
    const panel = page.locator('#project-live-terminals');
    await expect(panel).toContainText('独立启动的 Codex');
    await expect(panel).toContainText('正在工作');
    assert.equal(server.app.store.list('runs').length, 0, '独立现场不伪造工作台执行');
    await panel.getByRole('button', { name: '打开现场' }).click();
    const drawer = page.getByRole('dialog', { name: '现场终端', exact: true });
    await expect(drawer.getByRole('status')).toContainText('只读');
    assert.equal((await inputs()).length, 0);
    await drawer.getByRole('button', { name: '最近输出' }).click();
    await expect(drawer.locator('pre')).toContainText('正在修改页面');
    await drawer.getByRole('button', { name: '接管输入', exact: true }).click();
    await expect(drawer.getByRole('status')).toContainText('已接管');
    await drawer.locator('.xterm-helper-textarea').pressSequentially('test');
    await expect.poll(async () => (await inputs()).filter(input => input.type === 'terminal.input').map(input => Buffer.from(input.bytes, 'base64').toString()).join('')).toBe('test');
    // Keep one frame response in flight while input fails. It must not revive control.
    let frameStarted!: () => void, unblockFrame!: () => void;
    const framePending = new Promise<void>(resolve => { frameStarted = resolve; });
    const frameGate = new Promise<void>(resolve => { unblockFrame = resolve; });
    let failedInputs = 0;
    await page.route('**/machines/live-machine/call', async route => {
      const method = route.request().postDataJSON()?.method;
      if (method === 'terminal.live.frames') {
        const response = await route.fetch(); frameStarted(); await frameGate;
        await route.fulfill({ response });
      } else if (method === 'terminal.live.input') {
        failedInputs++;
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture input failure' }) });
      } else await route.continue();
    });
    await framePending;
    await drawer.locator('.xterm-helper-textarea').pressSequentially('xyz');
    await expect(drawer.getByRole('status')).toContainText('已断开');
    unblockFrame();
    await expect(drawer.getByRole('button', { name: '接管输入', exact: true })).toBeDisabled();
    await expect(drawer).toContainText('输入未自动重试');
    await page.waitForTimeout(800);
    assert.equal(failedInputs, 1, '排队输入在首次失败后丢弃');
    await expect(drawer.getByRole('button', { name: '接管输入', exact: true })).toBeDisabled();
    await page.unrouteAll({ behavior: 'wait' });
    await drawer.getByRole('button', { name: '重新观察' }).click();
    await expect(drawer.getByRole('status')).toContainText('只读');
    // A delayed recent-output response must not survive a project switch.
    let readStarted!: () => void, unblockRead!: () => void;
    const readPending = new Promise<void>(resolve => { readStarted = resolve; });
    const readGate = new Promise<void>(resolve => { unblockRead = resolve; });
    await page.route('**/machines/live-machine/call', async route => {
      if (route.request().postDataJSON()?.method !== 'terminal.live.read') return route.continue();
      const response = await route.fetch(); readStarted(); await readGate; await route.fulfill({ response });
    });
    await drawer.getByRole('button', { name: '最近输出' }).click();
    await readPending;
    const other = server.app.projects.create({ name: '另一个项目' });
    await page.evaluate(id => { location.hash = `projects/${id}/runs`; }, other.id);
    await expect(drawer).toHaveCount(0);
    unblockRead();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(drawer).toHaveCount(0);
    assert.equal(server.app.store.list('runs').length, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    assert.match(await readFile(join(dir, 'opens'), 'utf8'), /^observe\ncontrol\nobserve\n$/);
  } finally { await browser?.close(); await node.close(); await live.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});
