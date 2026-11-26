import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { StorageReport } from '../apps/agent-node/src/machine-storage.ts';
import type { Json } from '../packages/plugin-sdk/src/index.ts';

test('电脑详情按需读取存储，显示每个挂载点的用量和读取时间；旧代理和离线时不能读', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-machine-storage-'));
  const token = 'machine-storage-browser-fixture';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), token, demo: true });
  const machineId = 'fixture-storage', oldId = 'fixture-legacy';
  const machineName = '合成存储电脑', oldName = '合成旧代理';
  let reads = 0;
  const report: StorageReport = {
    at: '2026-11-27T10:00:00.000Z', os: 'linux', supported: true, collectedMs: 5,
    mounts: [
      { mount: '/', device: '/dev/vda2', fsType: 'ext4', totalBytes: 100 * 1024 ** 3, usedBytes: 93 * 1024 ** 3, availBytes: 7 * 1024 ** 3, usedPercent: 93, inodesTotal: 1000, inodesUsed: 80, inodesPercent: 8, readOnly: false },
      { mount: '/data00', device: '/dev/vdb', fsType: 'ext4', totalBytes: 500 * 1024 ** 3, usedBytes: 125 * 1024 ** 3, availBytes: 375 * 1024 ** 3, usedPercent: 25, readOnly: false },
      { mount: '/archive', device: '/dev/sr0', fsType: 'iso9660', totalBytes: 1024 ** 3, usedBytes: 1024 ** 3, availBytes: 0, usedPercent: 100, readOnly: true },
    ],
  };
  const readOnlyTerminal = { 'terminal.list': async () => [], 'executor.sessions': async () => [] };
  const machine = startAgentNode({ url: server.url, token, machineId, name: machineName, dataDir: join(dir, 'node'), executors: [],
    handlers: { ...readOnlyTerminal, 'machine.storage': async () => { reads++; return report as unknown as Json; } } });
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

  // The storage is read only when the owner asks for it.
  await open(machineName);
  const drawer = page.getByRole('dialog', { name: machineName, exact: true });
  const storage = drawer.locator('#machine-storage');
  const read = storage.getByRole('button', { name: '查看存储' });
  await expect(read).toBeEnabled();
  await expect(storage).toContainText('尚未读取。');
  assertReads(0);
  await read.click();
  const disks = storage.getByLabel('磁盘用量');
  await expect(disks.getByRole('listitem')).toHaveCount(3);
  assertReads(1);
  // Each mount: where, how full, and a bar whose colour says whether to look.
  const root = disks.getByRole('listitem').nth(0);
  await expect(root).toContainText('/ · /dev/vda2');
  await expect(root).toContainText('ext4');
  await expect(root).toContainText('已用 93%');
  await expect(root).toContainText('可用 7.0 GB');
  await expect(root.locator('.storage-bar__fill')).toHaveClass(/storage-bar__fill--danger/);
  // The filled part is as wide as the mount is full.
  await expect(root.locator('.storage-bar__fill')).toHaveAttribute('style', 'width: 93%;');
  const data = disks.getByRole('listitem').nth(1);
  await expect(data).toContainText('/data00');
  await expect(data).toContainText('已用 25%');
  await expect(data.locator('.storage-bar__fill')).toHaveClass(/storage-bar__fill--ok(?![-\w])/);
  // A disc that is full by its nature is read-only, and says so.
  await expect(disks.getByRole('listitem').nth(2)).toContainText('只读');
  // When it was read is said, so that the numbers are not taken for now.
  await expect(storage).toContainText('读取于 ');
  await expect(storage).toContainText('按挂载点统计');
  // An old agent is named as such, and cannot be read.
  await drawer.getByRole('button', { name: '关闭' }).click();
  await open(oldName);
  const oldDrawer = page.getByRole('dialog', { name: oldName, exact: true });
  const oldStorage = oldDrawer.locator('#machine-storage');
  await expect(oldStorage).toContainText('旧代理缺少存储读取，请升级执行机代理。');
  await expect(oldStorage.getByRole('button', { name: '查看存储' })).toBeDisabled();
  assertReads(1);
  // A computer that goes offline cannot be read either, and the page follows it.
  await oldDrawer.getByRole('button', { name: '关闭' }).click();
  await open(machineName);
  const onlineDrawer = page.getByRole('dialog', { name: machineName, exact: true });
  await expect(onlineDrawer.locator('#machine-storage').getByRole('button', { name: '查看存储' })).toBeEnabled();
  await machine.close();
  await expect(onlineDrawer.locator('#machine-storage').getByRole('button', { name: '查看存储' })).toBeDisabled();
  expect(pageErrors).toEqual([]);

  function assertReads(expected: number) { expect(reads).toBe(expected); }
});
