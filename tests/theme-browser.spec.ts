import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

/** The colour the page is painted with, as Chromium resolves it. */
const background = (page: import('@playwright/test').Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const LIGHT = 'rgb(243, 235, 221)';
const DARK = 'rgb(27, 23, 19)';

test('外观可选浅色或深色，选择保存在当前浏览器，刷新后不先闪浅色，其他标签页跟着变', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-theme-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#agent');
  // Without a choice the workbench is light.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  expect(await background(page)).toBe(LIGHT);

  // The look has its own entry in the settings, apart from the plugins.
  await page.locator('#agent-advanced > summary').click();
  await page.getByRole('button', { name: '打开插件配置' }).click();
  const dialog = page.getByRole('dialog', { name: '插件配置' });
  const look = dialog.getByRole('button', { name: /外观/ });
  await look.click();
  const picker = dialog.getByRole('group', { name: '外观' });
  await expect(picker.getByRole('button', { name: '浅色' })).toHaveAttribute('aria-pressed', 'true');
  // The plugins are not listed while the look is chosen, and the look is not searched for.
  await expect(dialog.getByRole('searchbox', { name: '搜索插件' })).toHaveValue('');
  await expect(dialog.getByRole('button', { name: /主机器人配置/ })).toHaveCount(0);

  // Choosing dark changes the page at once and is kept.
  await picker.getByRole('button', { name: '深色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await background(page)).toBe(DARK);
  await expect(picker.getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true');
  await expect(picker.getByRole('button', { name: '浅色' })).toHaveAttribute('aria-pressed', 'false');
  // Text stays readable: the body's text and its background are far enough apart.
  const colours = await page.evaluate(() => [getComputedStyle(document.body).color, getComputedStyle(document.body).backgroundColor]);
  const [text, bg] = colours.map(value => value.match(/\d+(?:\.\d+)?/g)!.slice(0, 3).map(Number));
  const lum = (rgb: number[]) => rgb.map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const [high, low] = [lum(text!), lum(bg!)].sort((a, b) => b - a);
  expect((high! + 0.05) / (low! + 0.05)).toBeGreaterThan(7);

  // The theme is set by a small script in the page itself, before the app's module starts to
  // load. That is what keeps the first paint from being a flash of the other theme.
  const html = await (await fetch(server.url + '/')).text();
  const setting = html.indexOf("dataset.theme = 'dark'");
  const module = html.indexOf('type="module"');
  expect(setting).toBeGreaterThan(0);
  expect(setting).toBeLessThan(module);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await background(page)).toBe(DARK);
  // The page says which theme it set, before any module ran. The app's own script reads it
  // back and leaves it as it is, so the two agree.
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

  // Another tab of the same browser follows.
  const other = await context.newPage();
  await other.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await other.goto(server.url + '/#agent');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Changing it there changes it here too, with no reload.
  await other.locator('#agent-advanced > summary').click();
  await other.getByRole('button', { name: '打开插件配置' }).click();
  await other.getByRole('dialog', { name: '插件配置' }).getByRole('button', { name: /外观/ }).click();
  await other.getByRole('dialog', { name: '插件配置' }).getByRole('group', { name: '外观' }).getByRole('button', { name: '浅色' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  expect(await background(page)).toBe(LIGHT);
  expect(pageErrors).toEqual([]);
});

test('外观入口不依赖插件：一个插件都没有时也能选', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-theme-none-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  // Stop every plugin, so that the settings page has no plugin to show.
  for (const plugin of server.app.plugins.list()) await server.app.plugins.setEnabled(plugin.id, false);
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#agent');
  await page.locator('#agent-advanced > summary').click();
  await page.getByRole('button', { name: '打开插件配置' }).click();
  const dialog = page.getByRole('dialog', { name: '插件配置' });
  await dialog.getByRole('button', { name: /外观/ }).click();
  await dialog.getByRole('group', { name: '外观' }).getByRole('button', { name: '深色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await background(page)).toBe(DARK);
});
