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
if(args[0]==='pane'&&args[1]==='list')console.log(JSON.stringify({result:{panes:[{pane_id:'live-pane',terminal_id:'live-terminal',foreground_cwd:dir,agent:'codex',agent_session:{kind:'id',value:'native-full-thread'},agent_status:'working',terminal_title_stripped:'独立启动的 Codex'}]}}));
else if(args[0]==='pane'&&args[1]==='read')console.log('独立CLI近期输出：正在修改页面');
else if(args[0]==='terminal'){
fs.appendFileSync(path.join(dir,'opens'),args[2]+'\\n');
console.log(JSON.stringify({type:'terminal.frame',seq:0,full:true,encoding:'ansi',width:80,height:24,bytes:Buffer.from('LIVE CODEX OUTPUT').toString('base64')}));
let seq=0;setInterval(()=>console.log(JSON.stringify({type:'terminal.frame',seq:++seq,full:true,encoding:'ansi',width:80,height:24,bytes:Buffer.from('LIVE CODEX OUTPUT').toString('base64')})),600);
rl.createInterface({input:process.stdin}).on('line',line=>{const data=JSON.parse(line);fs.appendFileSync(path.join(dir,'inputs'),line+'\\n');if(data.type==='terminal.release')process.exit(0)});setInterval(()=>{},1000);
}else process.exit(2);
`, { mode: 0o700 });
  const live = createLiveTerminalServices({ command, env: { HERDR_ENV: '1', FAKE_LIVE_DIR: dir } });
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token: 'offline-token' });
  let hideNative = false;
  const node = startAgentNode({ url: server.url, token: 'offline-token', machineId: 'live-machine', name: '测试电脑', dataDir: join(dir, 'node'), handlers: { ...live.handlers, 'terminal.live.list': async params => { const value = await live.handlers['terminal.live.list']!(params, () => {}) as any; if (hideNative) for (const pane of value.panes) delete pane.nativeSessionId; return value; }, 'agents.sessions': async () => ({ sessions: [{ executorId: 'codex', nativeSessionId: 'native-full-thread', cwd: dir, metadataTimestamp: '2026-11-20T00:00:00Z' }], roots: [dir], warnings: [], truncated: false }), 'agents.session': async () => ({}), 'agents.transcript': async () => { const data = Buffer.from(Array.from({ length: 601 }, (_, i) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `完整对话第${i}条` }] } })).join('\n') + '\n'); return { data: data.toString('base64'), nextOffset: data.length, snapshot: { size: data.length, dev: 1, ino: 2 }, eof: true }; } }, executors: [], onDisconnect: live.disconnect });
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
    await page.evaluate(() => {
      const Original = (window as any).Terminal;
      (window as any).terminalPaint = { resets: 0, resizes: 0, writes: [], contrast: 0 };
      (window as any).Terminal = class extends Original {
        constructor(options: any) { super(options); (window as any).terminalPaint.contrast = options.minimumContrastRatio; }
        reset() { (window as any).terminalPaint.resets++; return super.reset(); }
        resize(cols: number, rows: number) { (window as any).terminalPaint.resizes++; return super.resize(cols, rows); }
        write(data: Uint8Array, callback: () => void) { (window as any).terminalPaint.writes.push(new TextDecoder().decode(data)); return super.write(data, callback); }
      };
    });
    await panel.getByRole('button', { name: '打开现场' }).click();
    const drawer = page.getByRole('dialog', { name: '现场终端', exact: true });
    await expect(drawer.getByRole('status')).toContainText('只读');
    assert.equal((await inputs()).length, 0);
    await page.waitForTimeout(900);
    const paint = await page.evaluate(() => (window as any).terminalPaint);
    assert.equal(paint.contrast, 7); assert.equal(paint.resets, 0); assert.equal(paint.resizes, 0, '相同尺寸的完整帧不重复调整画布'); assert.ok(paint.writes.length >= 2);
    assert.match(paint.writes[0], /\x1b\[\?2026h.*LIVE CODEX OUTPUT.*\x1b\[\?2026l/s);
    const accepted = page.waitForResponse(response => response.url().endsWith('/api/v1/agents/sessions/analyze') && response.request().method() === 'POST');
    await drawer.getByRole('button', { name: '一键分析完整对话' }).click();
    const response = await accepted, job = await response.json();
    assert.equal(response.request().postDataJSON().nativeSessionId, 'native-full-thread');
    const analysis = drawer.getByRole('region', { name: '对话分析结果' });
    await expect(analysis).toContainText('601 条公开对话');
    await expect(analysis).toContainText(/演示模式.*未调用模型/);
    assert.equal((await inputs()).length, 0, '分析不能向现场终端发送输入');
    await drawer.getByRole('button', { name: '最近输出' }).click();
    await expect(drawer.locator('pre')).toContainText('正在修改页面');
    await drawer.getByRole('button', { name: '关闭观察' }).click();
    hideNative = true;
    const withoutId = page.waitForResponse(async response => response.url().includes('/machines/live-machine/call') && response.request().postDataJSON()?.method === 'terminal.live.list' && !(await response.json()).panes[0]?.nativeSessionId);
    await panel.getByRole('button', { name: '重新读取现场' }).click();
    await withoutId; await page.evaluate(() => new Promise(requestAnimationFrame));
    await panel.getByRole('button', { name: '打开现场' }).click();
    await drawer.getByRole('button', { name: '一键分析完整对话' }).click();
    await expect(drawer).toContainText('终端未提供可核验的会话 ID');
    await drawer.getByRole('button', { name: /2026-11-20.*native-full-thread/ }).click();
    await expect(drawer.getByRole('region', { name: '对话分析结果' })).toContainText('601 条公开对话');
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
    assert.match(await readFile(join(dir, 'opens'), 'utf8'), /^observe\nobserve\ncontrol\nobserve\n$/);
  } finally { await browser?.close(); await node.close(); await live.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('工作台两个入口原地打开多屏，切换命名会话，完整界面聚焦并释放连接', { timeout: 40000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-wall-browser-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token: 'wall-fixture' });
  const opened: Array<{ session: unknown; mode: unknown }> = [];
  const leases = new Set<string>();
  let selectedPane = 'pane-a', started = false;
  const lease = (session: unknown, mode: unknown) => {
    opened.push({ session, mode });
    const connectionId = 'lease-' + opened.length;
    leases.add(connectionId);
    return { connectionId, session: String(session) };
  };
  const node = startAgentNode({
    url: server.url, token: 'wall-fixture', machineId: 'wall-machine', name: '测试执行机',
    dataDir: join(dir, 'node'), executors: [],
    handlers: {
      'terminal.host.start': async () => { started = true; return { started }; },
      'terminal.live.sessions': async () => ({ sessions: started ? [
        { name: 'first', running: true, default: true }, { name: 'second', running: true, default: false },
      ] : [] }),
      'terminal.live.list': async ({ session }) => ({ panes: ['pane-a', 'pane-b'].map(paneId => ({
        paneId, terminalId: paneId, title: String(session) + ' ' + paneId, cwd: dir, agent: 'shell', focused: paneId === selectedPane,
      })) }),
      'terminal.live.open': async ({ session, mode }) => lease(session, mode),
      'terminal.live.full.open': async ({ session }) => lease(session, 'full'),
      'terminal.live.focus': async ({ session, paneId }) => {
        assert.equal(session, 'second'); selectedPane = String(paneId); return { focused: true };
      },
      'terminal.live.frames': async () => ({ frames: [] }),
      'terminal.live.release': async ({ connectionId }) => ({ released: leases.delete(String(connectionId)) }),
    },
  });
  const project = server.app.projects.create({ name: '终端测试项目', workspace: { machineId: 'wall-machine', cwd: dir } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    await expect.poll(() => server.machines.list().some(m => m.id === 'wall-machine' && m.online)).toBe(true);
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    const errors: string[] = []; page.on('pageerror', err => errors.push(err.message));
    await page.goto(server.url + '/#projects/' + project.id + '/runs?token=wall-fixture');
    const top = page.getByRole('button', { name: '多屏现场', exact: true });
    await expect(top).toBeVisible();
    const before = page.url();
    await page.evaluate(() => localStorage.removeItem('super-mario-token'));
    await page.locator('#project-live-terminals').getByRole('button', { name: '多屏现场墙' }).click();
    const wall = page.getByRole('dialog', { name: '多屏现场', exact: true });
    const frame = wall.frameLocator('iframe');
    await expect(frame.getByRole('button', { name: '启动终端宿主' })).toBeVisible();
    await frame.getByRole('button', { name: '启动终端宿主' }).click();
    await expect(frame.locator('.multi-tile')).toHaveCount(2);
    await expect.poll(() => opened.filter(c => c.session === 'first' && c.mode === 'observe').length).toBe(2);
    assert.equal(page.url(), before);
    assert.equal(page.context().pages().length, 1);
    assert.ok(!(await wall.locator('iframe').getAttribute('src'))?.includes('token'));
    await expect(frame.locator('input[type=password]')).toHaveCount(0);
    await frame.getByLabel('Herdr 会话').selectOption('second');
    await expect(frame.locator('.multi-tile').first()).toContainText('second pane-a');
    await frame.getByRole('button', { name: '完整界面' }).click();
    await expect(frame.locator('#conn-text')).toContainText('可输入');
    await frame.locator('.pane-card').filter({ hasText: 'second pane-b' }).click();
    await expect(frame.locator('#top-sub')).toContainText('second pane-b');
    assert.equal(opened.filter(c => c.mode === 'full' && c.session === 'second').length, 1);
    await wall.getByRole('button', { name: '关闭', exact: true }).click();
    await expect.poll(() => leases.size).toBe(0);
    await top.click();
    await expect(frame.locator('.multi-tile')).toHaveCount(2);
    await wall.getByRole('button', { name: '关闭', exact: true }).click();
    await expect.poll(() => leases.size).toBe(0);
    assert.equal(page.url(), before);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await node.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});
