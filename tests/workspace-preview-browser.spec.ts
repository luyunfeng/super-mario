import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { promisify } from 'node:util';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createWorkspacePreviewNode } from '../apps/agent-node/src/workspace-preview.ts';
import { startServer } from '../apps/server/src/index.ts';
import { workspaceCode } from '../plugins/workspace-code.ts';

test('项目工作区可以预览这台电脑上正在运行的服务：读到状态、类型、用时和页面；关闭只收起面板', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-preview-page-'));
  const token = 'preview-page-fixture';
  const root = join(dir, 'project');
  await promisify(execFile)('mkdir', ['-p', root]);
  await writeFile(join(root, 'README.md'), 'x\n');
  // A server on this computer, as one the owner started in a terminal.
  const service = createServer((req, res) => {
    if (req.url === '/gone') { res.writeHead(302, { location: '/elsewhere' }).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h1>合成页面</h1>');
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', () => resolve()));
  const port = (service.address() as { port: number }).port;
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token, demo: true });
  const node = startAgentNode({ url: server.url, token, machineId: 'preview-machine', name: '工作电脑', dataDir: join(dir, 'node'), executors: [],
    handlers: { 'workspace.code': workspaceCode, ...createWorkspacePreviewNode().handlers } });
  t.after(async () => { await node.close(); await server.close(); service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  for (let tries = 0; tries < 100 && !server.machines.list().some(item => item.id === 'preview-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const project = await server.app.projects.create({ name: '预览项目', workspace: { machineId: 'preview-machine', cwd: root } });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#projects/' + project.id + '/workspace?token=' + token);
  const sidebar = page.locator('#panel-workspace .code-sidebar');
  await page.locator('#panel-workspace').getByRole('button', { name: '查看代码' }).click();
  const preview = sidebar.getByRole('region', { name: '预览', exact: true });
  await preview.getByRole('spinbutton', { name: '端口' }).fill(String(port));
  await preview.getByRole('button', { name: '打开预览' }).click();
  await expect(preview).toContainText('HTTP 200 · text/html');
  await expect(preview.locator('.code-sidebar__text')).toHaveText('<h1>合成页面</h1>');
  // A path that redirects is reported, and the redirect is not followed.
  await preview.getByRole('textbox', { name: '页面路径' }).fill('/gone');
  await preview.getByRole('button', { name: '打开预览' }).click();
  await expect(preview).toContainText('跳转到 /elsewhere');
  // A port with nothing on it says so.
  await preview.getByRole('spinbutton', { name: '端口' }).fill('1');
  await preview.getByRole('button', { name: '打开预览' }).click();
  await expect(preview).toContainText('没有打开');
  // Closing puts the page away and stops nothing: the server still answers.
  await preview.getByRole('spinbutton', { name: '端口' }).fill(String(port));
  await preview.getByRole('textbox', { name: '页面路径' }).fill('/');
  await preview.getByRole('button', { name: '打开预览' }).click();
  await expect(preview.locator('.code-sidebar__text')).toBeVisible();
  await preview.getByRole('button', { name: '关闭预览' }).click();
  await expect(preview.locator('.code-sidebar__text')).toBeHidden();
  await expect(preview).toContainText('服务没有停');
  assert.equal((await fetch('http://127.0.0.1:' + port + '/')).status, 200);
  // A bad port is refused by the page's own request, as the server refuses it.
  await preview.getByRole('spinbutton', { name: '端口' }).fill('70000');
  await preview.getByRole('button', { name: '打开预览' }).click();
  await expect(preview).toContainText('没有打开');
  assert.deepEqual(pageErrors, []);
});
