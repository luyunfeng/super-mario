import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Json } from '../packages/plugin-sdk/src/index.ts';

test('电脑详情按需读取资源和网络，显示处理器、内存、趋势、地址、端口和读取时间；旧代理不能读', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-machine-inspect-'));
  const token = 'machine-inspect-browser-fixture';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token, demo: true });
  const machineId = 'fixture-inspect', oldId = 'fixture-legacy-inspect';
  const machineName = '合成资源电脑', oldName = '合成旧代理资源';
  let resourceReads = 0, networkReads = 0;
  const resources = {
    at: '2026-11-27T10:00:00.000Z', os: 'linux', supported: true, cpus: 8,
    memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 4 * 1024 ** 3, usedPercent: 75 },
    load: [1.5, 2, 2.5], uptimeSeconds: 90061, windowSeconds: 900,
    samples: Array.from({ length: 12 }, (_, index) => ({ at: new Date(Date.parse('2026-11-27T10:00:00.000Z') - (11 - index) * 5000).toISOString(), cpuPercent: index * 8, memoryPercent: 70 + index, load: [1, 1, 1] })),
  };
  const network = {
    at: '2026-11-27T10:00:00.000Z', os: 'linux', supported: true, collectedMs: 9, processesKnown: false,
    addresses: [{ name: 'eth0', address: '10.0.0.5', family: 'IPv4', mac: '', internal: false, netmask: '', cidr: '' }],
    ports: [
      { protocol: 'tcp', address: '0.0.0.0', port: 22, pid: 1234, processName: 'sshd' },
      { protocol: 'tcp', address: '127.0.0.1', port: 8080 },
    ],
    probes: [{ host: '10.0.0.1', ok: true, ms: 2 }, { host: '10.0.0.53', ok: false, error: 'timed out' }],
  };
  const readOnlyTerminal = { 'terminal.list': async () => [], 'executor.sessions': async () => [] };
  const machine = startAgentNode({ url: server.url, token, machineId, name: machineName, dataDir: join(dir, 'node'), executors: [],
    handlers: { ...readOnlyTerminal,
      'machine.resources': async () => { resourceReads++; return resources as unknown as Json; },
      'machine.network': async () => { networkReads++; return network as unknown as Json; } } });
  const old = startAgentNode({ url: server.url, token, machineId: oldId, name: oldName, dataDir: join(dir, 'legacy'), executors: [], handlers: readOnlyTerminal });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await old.close();
    await machine.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await expect.poll(() => server.machines.list().filter(m => m.online).length).toBe(2);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#agent?token=' + token);
  const open = (name: string) => page.locator('#agent-computers').getByRole('button', { name: new RegExp(name) }).click();

  await open(machineName);
  const drawer = page.getByRole('dialog', { name: machineName, exact: true });
  // Both are read only when the owner asks.
  const resourcePanel = drawer.locator('#machine-resources');
  const networkPanel = drawer.locator('#machine-network');
  await expect(resourcePanel.getByRole('button', { name: '查看资源' })).toBeEnabled();
  await expect(networkPanel.getByRole('button', { name: '查看网络' })).toBeEnabled();
  assert.equal(resourceReads, 0);
  assert.equal(networkReads, 0);
  await resourcePanel.getByRole('button', { name: '查看资源' }).click();
  await expect(resourcePanel).toContainText('8 核');
  await expect(resourcePanel).toContainText('负载 1.50 / 2.00 / 2.50');
  await expect(resourcePanel).toContainText('75%');
  await expect(resourcePanel).toContainText('12.0 GB / 16.0 GB');
  await expect(resourcePanel).toContainText('运行了 1 天 1 小时');
  // One line for each of processor and memory, each saying the most it reached.
  await expect(resourcePanel.getByRole('img', { name: '处理器最近十五分钟最高 88%' })).toBeVisible();
  await expect(resourcePanel.getByRole('img', { name: '内存最近十五分钟最高 81%' })).toBeVisible();
  assert.equal(resourceReads, 1);
  await networkPanel.getByRole('button', { name: '查看网络' }).click();
  await expect(networkPanel).toContainText('eth0 10.0.0.5');
  await expect(networkPanel).toContainText('2 毫秒');
  await expect(networkPanel).toContainText('不通');
  const ports = networkPanel.getByLabel('监听端口');
  await expect(ports.getByRole('listitem')).toHaveCount(2);
  await expect(ports.getByRole('listitem').nth(0)).toContainText('0.0.0.0:22');
  await expect(ports.getByRole('listitem').nth(0)).toContainText('sshd · 1234');
  await expect(ports.getByRole('listitem').nth(1)).toContainText('127.0.0.1:8080');
  await expect(networkPanel).toContainText('别的用户的进程读不到');
  await expect(networkPanel).toContainText('不向外网发探测');
  assert.equal(networkReads, 1);
  await drawer.getByRole('button', { name: '关闭' }).click();

  // An older agent offers neither reading, and the page says so instead of failing.
  await open(oldName);
  const oldDrawer = page.getByRole('dialog', { name: oldName, exact: true });
  await expect(oldDrawer.locator('#machine-resources')).toContainText('旧代理缺少资源读取');
  await expect(oldDrawer.locator('#machine-resources').getByRole('button', { name: '查看资源' })).toBeDisabled();
  await expect(oldDrawer.locator('#machine-network')).toContainText('旧代理缺少网络读取');
  await expect(oldDrawer.locator('#machine-network').getByRole('button', { name: '查看网络' })).toBeDisabled();
  assert.equal(resourceReads, 1);
  assert.equal(networkReads, 1);
  assert.deepEqual(pageErrors, []);
});
