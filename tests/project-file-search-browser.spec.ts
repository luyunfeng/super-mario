import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

test('顶栏按当前项目搜索文件，打开原文件，切换项目后丢弃延迟的旧结果', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-file-search-'));
  const token = 'local-file-search-browser', machineId = 'fixture-code-reader';
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
  const alphaPath = 'reports/forecast-甲 #1.md', betaPath = 'reports/forecast-乙.md';
  const alphaText = '仅在合成项目甲中出现的文件正文。', betaText = '合成项目乙 · 第二版记录。';
  await mkdir(join(alphaDir, 'reports'), { recursive: true });
  await mkdir(join(betaDir, 'reports'), { recursive: true });
  await writeFile(join(alphaDir, alphaPath), alphaText);
  await writeFile(join(betaDir, betaPath), betaText);
  const citedPath = 'reports/引用 & 复核.md', citedText = '助手引用指向的合成工作区文件。';
  await writeFile(join(alphaDir, citedPath), citedText);
  const discovery = createProjectDiscovery({ home: dir, cwd: alphaDir, roots: [], temporaryRoots: [], ignoreEnvironmentRoots: true });
  let holdAlpha = false, held = false, failNextSearch = false;
  node = startAgentNode({ url: server.url, token, machineId, name: '项目检索验收电脑', dataDir: join(dir, 'node'), executors: [],
    handlers: {
      'workspace.directory': discovery.handlers['workspace.directory'],
      'workspace.code': async (params, emit) => {
        if (params.kind === 'search' && params.query === 'forecast' && params.cwd === alphaDir && holdAlpha) {
          held = true;
          await gate;
        }
        if (params.kind === 'search' && failNextSearch) {
          failNextSearch = false;
          throw new Error('合成执行机暂时无法枚举文件');
        }
        return discovery.handlers['workspace.code'](params, emit);
      },
    },
  });
  await expect.poll(() => server.machines.list().some(m => m.id === machineId && m.online)).toBe(true);
  const alpha = await server.app.createProject({ name: '合成文件项目甲', workspace: { machineId, cwd: alphaDir } });
  const beta = await server.app.createProject({ name: '合成文件项目乙', workspace: { machineId, cwd: betaDir } });
  const citation = '#projects/' + alpha.id + '/workspace?' + new URLSearchParams({ file: citedPath });
  server.app.store.put('messages', 'file-citation', {
    id: 'file-citation', projectId: alpha.id, conversationId: 'project:' + alpha.id + ':work',
    role: 'assistant', status: 'done', createdAt: new Date().toISOString(),
    text: '核对依据 [查看文件](' + citation + ')。\n外部同名标签 [查看文件](https://example.invalid)。',
  });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ permissions: ['clipboard-read', 'clipboard-write'] });
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#projects/' + alpha.id + '/workspace?token=' + token);
  const input = page.locator('#workspace-search'), results = page.locator('#search-results');
  const fileLink = (project: '甲' | '乙') => results.getByRole('link', { name: new RegExp('forecast-' + project) });
  const code = page.locator('#panel-workspace .code-sidebar');
  await expect(page.locator('#panel-workspace').getByRole('button', { name: '查看代码' })).toBeEnabled();

  const reply = page.locator('#panel-workspace .msg--assistant[data-id="file-citation"]');
  const reference = reply.getByRole('link', { name: '查看文件', exact: true });
  await expect(reference).toHaveCount(1);
  await expect(reference).toHaveAttribute('href', citation);
  await expect(reply).toContainText('[查看文件](https://example.invalid)');
  await expect(reply.locator('a[href^="https://example.invalid"]')).toHaveCount(0);
  await reference.click();
  await expect(code.locator('pre')).toHaveText(citedText);

  const matches = (projectId: string, query: string, url: string) => {
    const parsed = new URL(url);
    return parsed.pathname === '/api/v1/projects/' + projectId + '/code' && parsed.searchParams.get('kind') === 'search'
      && parsed.searchParams.get('query') === query;
  };
  const firstSearch = page.waitForResponse(r => matches(alpha.id, 'forecast', r.url()));
  await input.fill('forecast');
  const first = await firstSearch;
  assert.equal(first.status(), 200, await first.text());
  assert.deepEqual((await first.json()).paths, [alphaPath]);
  await expect(fileLink('甲')).toBeVisible();
  await input.press('ArrowDown');
  await expect(fileLink('甲')).toBeFocused();
  const beforeCopy = page.url();
  for (const shortcut of ['Control+Enter', 'Meta+Enter']) {
    await page.evaluate(() => navigator.clipboard.writeText('待复制'));
    await fileLink('甲').press(shortcut);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('@' + alphaPath);
    assert.equal(page.url(), beforeCopy);
  }
  await fileLink('甲').click();
  await expect(code).toBeVisible();
  await expect(code.locator('pre')).toHaveText(alphaText);
  await expect(code.getByRole('status')).toContainText(alphaPath);
  await page.reload();
  await expect(code.locator('pre')).toHaveText(alphaText);

  holdAlpha = true;
  const nextRequest = page.waitForRequest(r => matches(alpha.id, 'forecast', r.url()));
  await input.fill('forecast');
  await expect.poll(() => held).toBe(true);
  const pendingAlpha = await nextRequest;
  await page.evaluate(id => { location.hash = 'projects/' + id + '/workspace'; }, beta.id);
  await input.focus();
  if (await input.inputValue() !== 'forecast') await input.fill('forecast');
  await expect(fileLink('乙')).toBeVisible();
  release();
  // Aborting an old request and discarding its late result are both valid.
  await (await pendingAlpha.response())?.finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(fileLink('甲')).toHaveCount(0);
  await input.press('ArrowDown');
  await expect(fileLink('乙')).toBeFocused();
  await fileLink('乙').press('Enter');
  await expect(code.locator('pre')).toHaveText(betaText);

  const noMatch = page.waitForResponse(r => matches(beta.id, 'unlisted-file-example', r.url()));
  await input.fill('unlisted-file-example');
  assert.deepEqual((await (await noMatch).json()).paths, []);
  await expect(results).toContainText(/没有找到|无匹配|未找到/);
  await expect(fileLink('乙')).toHaveCount(0);

  failNextSearch = true;
  await input.fill('forecast');
  await expect(results).toContainText('合成执行机暂时无法枚举文件');
  await expect(fileLink('乙')).toHaveCount(0);
  const retried = page.waitForResponse(r => matches(beta.id, 'forecast', r.url()) && r.ok());
  await results.getByRole('button', { name: '重试文件检索' }).click();
  assert.deepEqual((await (await retried).json()).paths, [betaPath]);
  await expect(fileLink('乙')).toBeVisible();
  await expect(results).not.toContainText('合成执行机暂时无法枚举文件');

  const disabled = await page.request.post(server.url + '/api/v1/plugins/conversation-search', {
    headers: { Authorization: 'Bearer ' + token }, data: { enabled: false },
  });
  assert.ok(disabled.ok());
  await expect(fileLink('乙')).toHaveCount(0);
  await expect(results).not.toContainText('项目文件');
  assert.equal(await input.inputValue(), 'forecast');
});
