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
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  async function inputs() { try { return (await readFile(join(dir, 'inputs'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }
  try {
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
    await drawer.getByRole('button', { name: '停止接管' }).click();
    await expect(drawer.getByRole('status')).toContainText('只读');
    await drawer.getByRole('button', { name: '关闭观察' }).click();
    await expect(drawer).toHaveCount(0);
    assert.equal(server.app.store.list('runs').length, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    assert.match(await readFile(join(dir, 'opens'), 'utf8'), /^observe\ncontrol\nobserve\n$/);
  } finally { await browser.close(); await node.close(); await live.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});
