import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

test('主对话与项目会话在光标处插入文件提及，切换项目或停用后忽略旧候选', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-file-mentions-'));
  const token = 'mentions-browser-fixture', machineId = 'mentions-fixture-node';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token, demo: true });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let node: ReturnType<typeof startAgentNode> | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => {
    release();
    await browser?.close();
    await node?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const alphaDir = join(dir, 'alpha'), betaDir = join(dir, 'beta');
  const folder = '报表 草稿', first = folder + '/01 汇总.md', second = folder + '/02 分析.md';
  await mkdir(join(alphaDir, folder), { recursive: true });
  await mkdir(betaDir);
  await writeFile(join(alphaDir, first), '合成汇总');
  await writeFile(join(alphaDir, second), '合成分析');
  await writeFile(join(alphaDir, 'pending-甲.md'), '甲');
  await writeFile(join(betaDir, 'pending-乙.md'), '乙');
  const discovery = createProjectDiscovery({ home: dir, cwd: alphaDir, roots: [], temporaryRoots: [], ignoreEnvironmentRoots: true });
  const reads: { cwd: string; kind: string; value: string }[] = [];
  let held = false, failBeta = true;
  node = startAgentNode({ url: server.url, token, machineId, name: '文件提及验收电脑', dataDir: join(dir, 'node'), executors: [],
    handlers: {
      'workspace.directory': discovery.handlers['workspace.directory'],
      'workspace.code': async (params, emit) => {
        reads.push({ cwd: String(params.cwd), kind: String(params.kind), value: String(params.query ?? params.path ?? '') });
        if (params.cwd === alphaDir && params.kind === 'search' && params.query === 'pending') {
          held = true;
          await gate;
        }
        if (params.cwd === betaDir && params.kind === 'search' && failBeta) {
          failBeta = false;
          throw new Error('合成文件名称检索暂不可用');
        }
        return discovery.handlers['workspace.code'](params, emit);
      },
    },
  });
  await expect.poll(() => server.machines.list().some(m => m.id === machineId && m.online)).toBe(true);
  const alpha = await server.app.createProject({ name: '文件提及项目甲', workspace: { machineId, cwd: alphaDir } });
  const beta = await server.app.createProject({ name: '文件提及项目乙', workspace: { machineId, cwd: betaDir } });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  const sent: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/v1\/(projects\/[^/]+\/)?messages$/.test(request.url())) sent.push(request.url());
  });
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#chat?token=' + token);
  const main = page.getByLabel('给 Agent 的消息'), projectInput = page.getByLabel('项目目标');
  const menu = page.getByRole('listbox', { name: '文件提及候选' });
  const candidate = (path: string) => menu.getByRole('option', { name: path, exact: true });
  await page.locator('#scope-select').selectOption(alpha.id);
  const prefix = '请复核 ', suffix = '再核对结论。';
  await main.fill('fixture@example.invalid');
  await expect(menu).toBeHidden();
  await main.fill(prefix + ' ' + suffix);
  await main.evaluate((el: HTMLTextAreaElement, cursor) => el.setSelectionRange(cursor, cursor), prefix.length);
  await page.keyboard.insertText('@');
  await candidate(folder + '/').click();
  await expect(main).toHaveValue(prefix + '@' + folder + '/ ' + suffix);
  await expect(candidate(first)).toBeVisible();
  await expect(candidate(second)).toBeVisible();
  await main.press('ArrowUp');
  await expect(candidate(second)).toHaveAttribute('aria-selected', 'true');
  await main.press('ArrowDown');
  await expect(candidate(first)).toHaveAttribute('aria-selected', 'true');
  await main.press('ArrowDown');
  await expect(candidate(second)).toHaveAttribute('aria-selected', 'true');
  await main.press('Alt+Enter');
  await main.press('Control+Enter');
  await expect(menu).toBeVisible();
  await main.press('Enter');
  await expect(menu).toBeHidden();
  const inserted = prefix + '@' + second + ' ';
  await expect(main).toHaveValue(inserted + suffix);
  assert.equal(await main.evaluate((el: HTMLTextAreaElement) => el.selectionStart), inserted.length);
  assert.ok(reads.some(r => r.cwd === alphaDir && r.kind === 'tree' && r.value === folder));

  await page.evaluate(id => { location.hash = 'projects/' + id + '/workspace'; }, alpha.id);
  await expect(projectInput).toBeEnabled();
  const nextRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/v1/projects/' + alpha.id + '/code' && url.searchParams.get('query') === 'pending';
  });
  await projectInput.fill('参考 @pending');
  const pending = await nextRequest;
  await expect.poll(() => held).toBe(true);
  await page.evaluate(id => { location.hash = 'projects/' + id + '/workspace'; }, beta.id);
  await expect(projectInput).toHaveValue('');
  await projectInput.fill('参考 @pending');
  const betaOption = candidate('pending-乙.md');
  await expect(menu.getByRole('alert')).toContainText('合成文件名称检索暂不可用');
  await projectInput.press('Enter');
  await expect(projectInput).toHaveValue('参考 @pending');
  await menu.getByRole('button', { name: '重试文件提及' }).click();
  await expect(betaOption).toBeVisible();
  release();
  await (await pending.response())?.finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(candidate('pending-甲.md')).toHaveCount(0);
  await projectInput.press('Tab');
  await expect(projectInput).toHaveValue('参考 @pending-乙.md ');
  await expect(menu).toBeHidden();
  await projectInput.fill('第二次 @pending');
  await expect(betaOption).toBeVisible();
  await projectInput.press('Escape');
  await expect(menu).toBeHidden();
  await projectInput.evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', isComposing: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  await expect(projectInput).toHaveValue('第二次 @pending');
  await projectInput.fill('第三次 @pending');
  await expect(betaOption).toBeVisible();
  const disabled = await page.request.post(server.url + '/api/v1/plugins/conversation-search', {
    headers: { Authorization: 'Bearer ' + token }, data: { enabled: false },
  });
  assert.ok(disabled.ok());
  await expect(menu).toBeHidden();
  await expect(projectInput).toHaveValue('第三次 @pending');
  assert.deepEqual(sent, []);
  assert.equal(server.app.store.list<Message>('messages').filter(m => m.role === 'user').length, 0);
  assert.ok(reads.every(read => read.kind === 'search' || read.kind === 'tree'));
  assert.ok(!reads.some(read => read.value === 'example.invalid'));

  // Reopening the main conversation restores the chosen path as editable draft text.
  await page.evaluate(() => { location.hash = 'chat'; });
  await page.locator('#scope-select').selectOption(alpha.id);
  await expect(main).toHaveValue(inserted + suffix);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => server.app.store.list<Message>('messages').filter(m => m.conversationId === 'main' && m.role === 'user')
    .map(m => m.text)).toEqual([inserted + suffix]);
  assert.equal(sent.length, 1);
});
