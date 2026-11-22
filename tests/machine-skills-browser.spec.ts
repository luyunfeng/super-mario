import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { createMachineSkills } from '../plugins/machine-skills.ts';

test('执行机详情按需读取技能元数据，区分空目录、失败、旧代理、离线和插件停用', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-machine-skills-'));
  const home = join(dir, 'home'), codexHome = join(home, 'codex-config'), claudeHome = join(home, 'claude-config');
  for (const root of [join(codexHome, 'skills'), join(claudeHome, 'skills'), join(home, '.agents/skills')]) {
    await mkdir(root, { recursive: true });
  }
  const token = 'machine-skills-browser-fixture';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token, demo: true });
  const machineId = 'fixture-skills', oldId = 'fixture-legacy';
  const machineName = '合成技能电脑', oldName = '合成旧代理';
  const handlers = createMachineSkills({ home, codexHome, claudeHome }).handlers;
  let rpcCount = 0, simulateFailure = false;
  const readOnlyTerminal = { 'terminal.list': async () => [], 'executor.sessions': async () => [] };
  const agent = startAgentNode({ url: server.url, token, machineId, name: machineName, dataDir: join(dir, 'node'), executors: [],
    handlers: { ...readOnlyTerminal, 'skills.catalog': async params => {
      rpcCount++;
      if (simulateFailure) throw new Error('合成目录读取失败');
      return handlers['skills.catalog'](params);
    } } });
  const old = startAgentNode({ url: server.url, token, machineId: oldId, name: oldName, dataDir: join(dir, 'legacy'),
    executors: [], handlers: readOnlyTerminal });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await old.close();
    await agent.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await expect.poll(() => server.machines.list().filter(m => m.online).length).toBe(2);
  const url = (id: string) => server.url + '/api/v1/machines/' + id + '/skills';
  const headers = { Authorization: 'Bearer ' + token };
  const get = (id: string) => fetch(url(id), { headers });
  assert.equal((await fetch(url(machineId))).status, 401);
  assert.equal((await get('fixture-unknown')).status, 404);

  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#agent?token=' + token);
  const open = (name: string) => page.locator('#agent-computers').getByRole('button', { name: new RegExp(name) }).click();
  const drawer = page.getByRole('dialog', { name: machineName, exact: true });
  const skills = drawer.getByRole('region', { name: '执行机技能', exact: true });
  const read = skills.getByRole('button', { name: /技能清单/ });
  await open(machineName);
  await expect(read).toBeEnabled();
  assert.equal(rpcCount, 0);
  await read.click();
  await expect(skills).toContainText('这台执行机没有报告技能');
  assert.equal(rpcCount, 1);

  const fixtureName = 'fixture-check';
  const expected = [
    { root: codexHome, name: fixtureName, description: '检查合成样例', source: 'codex' },
    { root: claudeHome, name: 'fixture-summary', description: '汇总合成材料', source: 'claude-code' },
    { root: join(home, '.agents'), name: 'fixture-notes', description: '整理合成笔记', source: 'shared' },
  ];
  const privateBody = '只存在本地正文的合成标记';
  for (const { root, name, description } of expected) {
    const folder = join(root, 'skills', name);
    await mkdir(folder);
    await writeFile(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${privateBody}\n`);
  }
  const result = page.waitForResponse(r => r.url() === url(machineId));
  await read.click();
  const response = await result;
  assert.equal(response.status(), 200);
  const payload = await response.json();
  assert.equal(payload.truncated, false);
  assert.equal(payload.skills.length, expected.length);
  for (const { name, description, source } of expected) {
    assert.deepEqual(payload.skills.find((skill: { name: string }) => skill.name === name), { name, description, source });
    await expect(skills).toContainText(description);
  }
  const json = JSON.stringify(payload);
  assert.ok(!json.includes(home) && !json.includes(privateBody));
  await expect(skills).toContainText(fixtureName);
  await expect(skills).toContainText('Codex');
  await expect(skills).toContainText('Claude Code');
  await expect(skills).toContainText('共享目录');
  assert.equal(rpcCount, 2);

  simulateFailure = true;
  const failed = page.waitForResponse(r => r.url() === url(machineId));
  await read.click();
  assert.ok(!(await failed).ok());
  await expect(skills.getByRole('alert')).toContainText('读取失败');
  await expect(skills).not.toContainText(fixtureName);
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();

  await open(oldName);
  const oldDrawer = page.getByRole('dialog', { name: oldName, exact: true });
  await expect(oldDrawer.getByRole('region', { name: '执行机技能' })).toContainText('当前代理不支持读取技能清单');
  assert.equal((await get(oldId)).status, 409);
  await oldDrawer.getByRole('button', { name: '关闭', exact: true }).click();

  simulateFailure = false;
  await open(machineName);
  await read.click();
  await expect(skills).toContainText(fixtureName);
  const toggle = async (enabled: boolean) => {
    const response = await page.request.post(server.url + '/api/v1/plugins/assistant-skills', { headers, data: { enabled } });
    assert.ok(response.ok());
  };
  await toggle(false);
  await expect(skills).toContainText('助手技能插件已停用');
  await expect(skills).not.toContainText(fixtureName);
  await expect(read).toHaveCount(0);
  const previous = rpcCount;
  assert.equal((await get(machineId)).status, 503);
  assert.equal(rpcCount, previous);
  await toggle(true);
  await read.click();
  await expect(skills).toContainText(fixtureName);
  await agent.close();
  await expect(skills).toContainText('执行机离线');
  await expect(skills).not.toContainText(fixtureName);
  assert.equal((await get(machineId)).status, 503);
});
