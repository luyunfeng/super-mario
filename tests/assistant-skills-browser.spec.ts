import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import JSZip from 'jszip';
import { startServer } from '../apps/server/src/index.ts';

test('Agent 页可预览和安装技能 ZIP，重启后读取文件并删除，损坏 ZIP 和插件停用均有反馈', { timeout: 45000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-skills-browser-'));
  const token = 'skills-browser-fixture';
  const start = () => startServer({ host: '127.0.0.1', port: 0, dataDir, token, demo: true });
  let server = await start();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const skillName = 'fixture-guide';
  const description = '合成验收步骤说明';
  const guide = '检查合成数据的格式。';
  const reference = '核对样例 A 和样例 B。';
  const zip = new JSZip();
  zip.file(skillName + '/SKILL.md', `---\nname: ${skillName}\ndescription: ${description}\n---\n\n# 检查步骤\n\n${guide}\n`);
  zip.file(skillName + '/references/check.md', reference);
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  const manage = page.locator('#assistant-skills').getByRole('button', { name: '管理技能', exact: true });
  const drawer = page.getByRole('dialog', { name: '助手技能', exact: true });
  const button = (name: string) => drawer.getByRole('button', { name, exact: true });
  const file = drawer.getByLabel('技能 ZIP 文件', { exact: true });
  const open = async () => {
    await page.goto(server.url + '/#agent?token=' + token);
    await manage.click();
  };
  await open();
  await expect(drawer).toContainText('还没有安装助手技能。');
  await file.setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('invalid archive') });
  await expect(drawer.getByRole('alert')).toContainText('预览失败');
  await expect(button('确认安装')).toHaveCount(0);
  await expect(button('查看 ' + skillName)).toHaveCount(0);

  await file.setInputFiles({ name: 'fixture-guide.zip', mimeType: 'application/zip', buffer: archive });
  await expect(button('确认安装')).toBeEnabled();
  await expect(drawer).toContainText(skillName);
  await expect(drawer).toContainText(description);
  const files = drawer.getByRole('list', { name: '文件清单' }).getByRole('listitem');
  await expect(files).toHaveCount(2);
  assert.deepEqual((await files.allTextContents()).sort(), ['SKILL.md', 'references/check.md']);
  await expect(button('查看 ' + skillName)).toHaveCount(0);
  await button('确认安装').click();
  await expect(button('查看 ' + skillName)).toBeVisible();

  await file.setInputFiles({ name: 'fixture-guide.zip', mimeType: 'application/zip', buffer: archive });
  await expect(drawer.getByRole('alert')).toContainText('同名技能已安装');
  await expect(button('确认安装')).toHaveCount(0);

  await page.goto('about:blank');
  await server.close();
  server = await start();
  await open();
  await button('查看 ' + skillName).click();
  const content = drawer.getByLabel('技能文件内容');
  await expect(content).toContainText(guide);
  await drawer.getByLabel('文件路径', { exact: true }).fill('references/check.md');
  await button('读取文件').click();
  await expect(content).toHaveText(reference);
  await button('删除 ' + skillName).click();
  await button('确认删除').click();
  await expect(drawer).toContainText('还没有安装助手技能。');
  await expect(button('查看 ' + skillName)).toHaveCount(0);

  const headers = { Authorization: 'Bearer ' + token };
  const disabled = await page.request.post(server.url + '/api/v1/plugins/assistant-skills', {
    headers, data: { enabled: false },
  });
  assert.ok(disabled.ok());
  await expect(drawer).toBeHidden();
  await expect(manage).toHaveCount(0);
  const unavailable = await page.request.post(server.url + '/api/v1/assistant-skills', { headers, data: { action: 'list' } });
  assert.equal(unavailable.status(), 503);
});
