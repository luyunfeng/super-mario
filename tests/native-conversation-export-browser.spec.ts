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
      { type: 'thinking', thinking: '内部推理标记' }, { type: 'tool_use', name: 'fixture_read', input: { path: '参数标记' } },
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
  const node = startAgentNode({ url: server.url, token, machineId, name: '合成历史电脑', dataDir: join(dir, 'node'),
    handlers: { ...history.handlers, 'workspace.directory': projects.handlers['workspace.directory'] }, executors: [] });
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
  for (const [id, source, other, tool] of [
    [codexId, 'Codex', 'Claude', 'fixture_lookup'],
    [claudeId, 'Claude', 'Codex', 'fixture_read'],
  ]) {
    await rows.filter({ hasText: id }).getByRole('button', { name: '导出对话', exact: true }).click();
    await expect(preview).toContainText('合成 ' + source + ' 最终回复');
    await expect(preview).not.toContainText(tool);
    await drawer.getByRole('checkbox', { name: '包含公开工作步骤' }).check();
    await expect(preview).toContainText(tool);
    const pending = page.waitForEvent('download');
    await drawer.getByRole('button', { name: '下载 .md' }).click();
    const download = await pending;
    assert.match(download.suggestedFilename(), /\.md$/);
    const path = await download.path();
    assert.ok(path);
    const body = await readFile(path, 'utf8');
    assert.equal(body, await preview.textContent());
    assert.ok(body.includes('合成 ' + source + ' 请求'));
    assert.ok(body.includes('图像附件'));
    assert.ok(!body.includes(image.slice(0, 40)));
    assert.ok(!body.includes('合成 ' + other));
    assert.doesNotMatch(body, /data:image|工具输出标记|参数标记|内部推理标记|其他会话标记|子会话标记/);
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  }

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
