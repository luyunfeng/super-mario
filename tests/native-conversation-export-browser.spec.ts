import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { createCliSessionDiscovery } from '../plugins/cli-session-discovery.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

async function writeJsonLines(path: string, records: unknown[]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

test('CLI 历史导出通过只读 RPC 读取选定会话，过滤内部数据并报告离线', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-native-export-'));
  const home = join(dir, 'home');
  const codexCwd = join(home, 'code', 'alpha'), claudeCwd = join(home, 'code', 'beta');
  await mkdir(codexCwd, { recursive: true });
  await mkdir(claudeCwd, { recursive: true });
  const codexId = 'synthetic-codex-export', claudeId = 'synthetic-claude-export';
  // The image spans an RPC page, so the final reply also proves full snapshot reading.
  const image = Buffer.from('synthetic image bytes '.repeat(11000)).toString('base64');
  await writeJsonLines(join(home, '.codex/sessions', codexId + '.jsonl'), [
    { type: 'session_meta', payload: { id: codexId, cwd: codexCwd } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '合成 Codex 请求' }, { type: 'input_image', image_url: 'data:image/png;base64,' + image },
    ] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'fixture_lookup', arguments: '{"query":"参数标记"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: '工具输出标记' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '合成 Codex 最终回复' }] } },
  ]);
  await writeJsonLines(join(home, '.claude/projects/beta', claudeId + '.jsonl'), [
    { sessionId: claudeId, cwd: claudeCwd, type: 'user', message: { content: [
      { type: 'text', text: '合成 Claude 请求' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
    ] } },
    { sessionId: claudeId, cwd: claudeCwd, type: 'assistant', message: { content: [
      { type: 'text', text: '准备读取' }, { type: 'thinking', thinking: '内部推理标记' },
      { type: 'tool_use', name: 'fixture_read', input: { path: '参数标记' } }, { type: 'text', text: '读取结束' },
    ] } },
    { sessionId: 'foreign-session', type: 'assistant', message: { content: '其他会话标记' } },
    { sessionId: claudeId, isSidechain: true, type: 'assistant', message: { content: '子会话标记' } },
    { sessionId: claudeId, type: 'user', message: { content: [{ type: 'tool_result', content: '工具输出标记' }] } },
    { sessionId: claudeId, type: 'assistant', message: { content: '合成 Claude 最终回复' } },
  ]);
  const token = 'isolated-export-browser', machineId = 'history-fixture';
  const server = await startServer({ dataDir: join(dir, 'data'), host: '127.0.0.1', port: 0, demo: true, token });
  const history = createCliSessionDiscovery({ home, cwd: codexCwd, temporaryRoots: [] });
  const projects = createProjectDiscovery({ home, cwd: codexCwd, roots: [], temporaryRoots: [], ignoreEnvironmentRoots: true });
  let holdNext = false;
  const held: (() => void)[] = [];
  const offsets: number[] = [];
  let releasedPages = 0, disconnected = 0;
  server.server.on('request', (req, res) => {
    if (req.url === '/api/v1/conversation-export') res.once('close', () => {
      if (!res.writableEnded) disconnected++;
    });
  });
  const transcript = async (params: unknown) => {
    offsets.push((params as { offset: number }).offset);
    if (holdNext) {
      holdNext = false;
      await new Promise<void>(resolve => held.push(resolve));
      releasedPages++;
    }
    return history.handlers['agents.transcript'](params);
  };
  const node = startAgentNode({ url: server.url, token, machineId, name: '合成历史电脑', dataDir: join(dir, 'node'),
    handlers: { ...history.handlers, 'agents.transcript': transcript, 'workspace.directory': projects.handlers['workspace.directory'] }, executors: [] });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await expect.poll(() => server.machines.list().some(m => m.id === machineId && m.online)).toBe(true);
  const project = await server.app.createProject({ name: '合成 Alpha', workspace: { machineId, cwd: codexCwd } });

  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#agent?token=' + token);
  const card = page.locator('#agent-cli-sessions');
  const rows = card.locator('[data-cli-session]');
  const drawer = page.getByRole('dialog', { name: '导出对话' });
  const preview = drawer.getByLabel('Markdown 预览');
  await expect(rows).toHaveCount(2);
  await card.getByLabel('CLI 会话项目').selectOption(project.id);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(codexId);
  await card.getByLabel('CLI 会话项目').selectOption('');
  await expect(rows).toHaveCount(2);
  // Hold the first RPC of two exports while the browser supersedes one and closes the other.
  holdNext = true;
  await rows.filter({ hasText: codexId }).getByRole('button', { name: '导出对话', exact: true }).click();
  await expect.poll(() => held.length).toBe(1);
  holdNext = true;
  await drawer.getByRole('checkbox', { name: '包含公开工作步骤' }).check();
  await expect.poll(() => held.length).toBe(2);
  await expect.poll(() => disconnected).toBe(1);
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await expect.poll(() => disconnected).toBe(2);
  for (const release of held) release();
  await expect.poll(() => releasedPages).toBe(2);
  for (const [id, source, other, tool] of [
    [codexId, 'Codex', 'Claude', 'fixture_lookup'],
    [claudeId, 'Claude', 'Codex', 'fixture_read'],
  ]) {
    await rows.filter({ hasText: id }).getByRole('button', { name: '导出对话', exact: true }).click();
    await expect(preview).toContainText('合成 ' + source + ' 最终回复');
    await expect(preview).not.toContainText(tool);
    // The two abandoned reads stopped after their first page. Only this fresh export read the full file.
    if (id === codexId) {
      assert.deepEqual(offsets.slice(0, 3), [0, 0, 0]);
      const laterPages = offsets.slice(3);
      assert.ok(laterPages.length && laterPages.every((offset, i) => offset > (laterPages[i - 1] ?? 0)));
    }
    await drawer.getByRole('checkbox', { name: '包含公开工作步骤' }).check();
    await expect(preview).toContainText(tool);
    const pending = page.waitForEvent('download');
    await drawer.getByRole('button', { name: '下载 .md' }).click();
    const download = await pending;
    assert.match(download.suggestedFilename(), /-\d{4}-\d{2}-\d{2}\.md$/);
    const path = await download.path();
    assert.ok(path);
    const body = await readFile(path, 'utf8');
    assert.equal(body, await preview.textContent());
    const bytes = await page.evaluate(size => size.toLocaleString(), Buffer.byteLength(body));
    await expect(drawer.getByRole('status')).toContainText(bytes + ' 字节');
    assert.ok(body.includes('合成 ' + source + ' 请求'));
    assert.ok(body.includes('图像附件'));
    assert.match(body, /<details><summary>公开工作步骤<\/summary>\s+> 工具调用：fixture_\w+\s+<\/details>/u);
    if (id === claudeId) {
      assert.match(body, /准备读取\s+<details>[^]*?fixture_read\s+<\/details>\s+读取结束/u);
      assert.match(body, /共 3 条消息/);
    }
    assert.ok(!body.includes(image.slice(0, 40)));
    assert.ok(!body.includes('合成 ' + other));
    assert.doesNotMatch(body, /data:image|工具输出标记|参数标记|内部推理标记|其他会话标记|子会话标记/);
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  }

  // A session can record an action before it has produced any message text.
  await writeJsonLines(join(home, '.claude/projects/beta', claudeId + '.jsonl'), [
    { sessionId: claudeId, cwd: claudeCwd, type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'only_public_step', input: { value: '参数标记' } },
    ] } },
  ]);
  await rows.filter({ hasText: claudeId }).getByRole('button', { name: '导出对话', exact: true }).click();
  await expect(drawer.getByRole('status')).toHaveText('暂无可导出的消息');
  await drawer.getByRole('checkbox', { name: '包含公开工作步骤' }).check();
  await expect(preview).toContainText('工具调用：only_public_step');
  await expect(preview).not.toContainText('参数标记');
  await expect(drawer.getByRole('status')).toContainText('共 0 条消息');
  await expect(drawer.getByRole('button', { name: '下载 .md' })).toBeEnabled();
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();

  const request = (cwd: string) => page.request.post(server.url + '/api/v1/conversation-export', {
    headers: { Authorization: 'Bearer ' + token },
    data: { native: { machineId, executorId: 'codex', nativeSessionId: codexId, cwd }, includeWork: true },
  });
  const wrongScope = await request(claudeCwd);
  assert.ok(!wrongScope.ok());
  assert.doesNotMatch(await wrongScope.text(), /合成 Codex 请求|合成 Claude 请求/);
  await node.close();
  await expect(card).toContainText('离线');
  await expect(card.getByRole('button', { name: '导出对话' })).toHaveCount(0);
  const offline = await request(codexCwd);
  assert.equal(offline.status(), 503);
  assert.match(await offline.text(), /离线/);
  assert.equal(server.app.store.list('runs').length, 0);
});

test('只读 CLI 消息跨页收藏，返回原文时校验日志变更与执行机离线，备份仅含快照', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-native-favorite-'));
  const home = join(dir, 'home'), cwd = join(home, 'code', 'fixture');
  const machineId = 'fixture-favorite-machine', sessionId = 'fixture-favorite-thread';
  const token = 'native-favorite-browser-fixture';
  const log = join(home, '.codex/sessions', sessionId + '.jsonl');
  await mkdir(cwd, { recursive: true });
  const texts = Array.from({ length: 125 }, (_, i) => '合成分页消息 ' + String(i + 1).padStart(3, '0'));
  const writeLog = () => writeJsonLines(log, [
    { type: 'session_meta', payload: { id: sessionId, cwd } },
    ...texts.map(text => ({
      type: 'response_item', timestamp: '2026-03-01T09:00:00.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    })),
  ]);
  await writeLog();
  const server = await startServer({ dataDir: join(dir, 'data'), host: '127.0.0.1', port: 0, demo: true, token });
  const history = createCliSessionDiscovery({ home, cwd, temporaryRoots: [] });
  const node = startAgentNode({ url: server.url, token, machineId, name: '合成收藏电脑', dataDir: join(dir, 'node'),
    handlers: history.handlers, executors: [] });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => { await browser?.close(); await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await expect.poll(() => server.machines.list().some(machine => machine.id === machineId && machine.online)).toBe(true);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#agent?token=' + token);
  const card = page.locator('#agent-cli-sessions [data-cli-session]').filter({ hasText: sessionId });
  await card.getByRole('button', { name: '查看消息', exact: true }).click();
  const transcript = page.getByRole('dialog', { name: 'CLI 会话消息', exact: true });
  const rows = transcript.locator('article[data-native-index]');
  await expect(rows.first()).toContainText(texts[0]);
  const countOnFirstPage = await rows.count();
  const targetText = texts[countOnFirstPage]!;
  assert.ok(targetText, '合成会话应跨过第一页');
  await transcript.getByRole('button', { name: '下一页', exact: true }).click();
  const target = rows.filter({ hasText: targetText });
  await expect(target).toBeVisible();
  await target.getByRole('button', { name: '收藏消息', exact: true }).click();
  await expect(target.getByRole('button', { name: '已收藏', exact: true })).toBeVisible();
  await transcript.getByRole('button', { name: '关闭', exact: true }).click();
  await page.goto(server.url + '/#chat');
  const openFavorites = page.getByRole('button', { name: '消息收藏', exact: true });
  const favorites = page.getByRole('dialog', { name: '消息收藏', exact: true });
  await openFavorites.click();
  await expect(favorites).toContainText(targetText);

  const pending = page.waitForEvent('download');
  await favorites.getByRole('button', { name: '下载收藏备份', exact: true }).click();
  const downloaded = await pending;
  const path = await downloaded.path();
  assert.ok(path);
  const body = await readFile(path, 'utf8');
  const { messages } = JSON.parse(body);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, targetText);
  assert.deepEqual(Object.keys(messages[0]).sort(), ['createdAt', 'key', 'omitted', 'role', 'starredAt', 'text', 'title']);
  for (const privateValue of [machineId, sessionId, cwd]) assert.ok(!body.includes(privateValue));

  const api = (data: { action: string; id?: string }) => page.request.post(server.url + '/api/v1/message-favorites', {
    headers: { Authorization: 'Bearer ' + token }, data,
  });
  const list = await api({ action: 'list' });
  assert.equal(list.status(), 200);
  const { items: [saved] } = await list.json();
  assert.equal(saved.text, targetText);
  const requestSource = () => api({ action: 'source', id: saved.id });
  const source = favorites.getByRole('button', { name: '查看原文', exact: true });
  await source.click();
  await expect(transcript.locator('[aria-current="true"]')).toContainText(targetText);
  await expect(transcript.locator('[aria-current="true"]')).toBeInViewport();
  await transcript.getByRole('button', { name: '关闭', exact: true }).click();

  texts[countOnFirstPage] = '改写后不可作为原文的正文';
  await writeLog();
  const changed = await requestSource();
  assert.equal(changed.status(), 409);
  assert.ok(!(await changed.text()).includes(texts[countOnFirstPage]));
  await source.click();
  await expect(transcript.getByRole('alert')).toContainText('原消息已变更');
  await expect(rows).toHaveCount(0);
  await transcript.getByRole('button', { name: '关闭', exact: true }).click();

  await node.close();
  await expect.poll(() => server.machines.list().some(machine => machine.id === machineId && machine.online)).toBe(false);
  await expect(favorites).toContainText(targetText);
  const offline = await requestSource();
  assert.equal(offline.status(), 503);
  assert.match(await offline.text(), /离线/);
  await source.click();
  await expect(transcript.getByRole('alert')).toContainText('离线');
  await expect(rows).toHaveCount(0);
  assert.equal(server.app.store.list('runs').length, 0);
});
