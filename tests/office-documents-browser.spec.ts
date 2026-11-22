import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import JSZip from 'jszip';
import { startServer } from '../apps/server/src/index.ts';

test('主对话生成三种办公文件，重启后下载并核对文件内容', {timeout: 45000}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-office-'));
  const token = 'office-browser-fixture';
  const start = () => startServer({dataDir, host:'127.0.0.1', port:0, token, demo:true});
  let server = await start();
  const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async () => { await browser.close(); await server.close(); await rm(dataDir,{recursive:true,force:true}); });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen','true'));
  const drawer = page.getByRole('dialog', {name:'办公文件',exact:true});
  const open = async () => {
    await page.goto(server.url + '/#chat?token=' + token);
    await page.getByRole('button',{name:'办公文件',exact:true}).click();
  };
  await open();
  for (const [format, source] of [['docx','# 报告\n\n第一批材料'],['pptx','# 说明\n\n---\n\n# 第二页\n\n- 合成样例'],['xlsx','事项,数量\n样本,3']]) {
    await drawer.getByLabel('文件标题').fill('合成交付');
    await drawer.getByLabel('格式',{exact:true}).selectOption(format);
    await drawer.getByLabel('源内容').fill(source);
    await drawer.getByRole('button',{name:'生成文件'}).click();
    await expect(drawer.getByRole('button',{name:'下载 合成交付.'+format})).toBeVisible();
  }
  await server.close(); server = await start(); await open();
  for (const [format,part,needle] of [['docx','word/document.xml','第一批材料'],['pptx','ppt/slides/slide2.xml','第二页'],['xlsx','xl/worksheets/sheet1.xml','<v>3</v>']]) {
    const pending = page.waitForEvent('download');
    await drawer.getByRole('button',{name:'下载 合成交付.'+format}).click();
    const file = await pending;
    assert.equal(file.suggestedFilename(), '合成交付.'+format);
    const buffer = await readFile((await file.path())!);
    const zip = await JSZip.loadAsync(buffer);
    if (format === 'docx') {
      await drawer.getByText('查看已有文件内容摘要').click();
      await drawer.getByLabel('选择办公文件').setInputFiles({name:'fixture.docx',mimeType:'application/octet-stream',buffer});
      await expect(drawer.locator('details [role=status]')).toContainText(/标题|段落|Word/);
    }
    assert.ok((await zip.file(part)!.async('string')).includes(needle));
  }
  const unauthorized = await fetch(server.url+'/api/v1/office-documents',{method:'POST',body:'{"action":"list"}'});
  assert.equal(unauthorized.status,401);
  const response = await page.request.post(server.url+'/api/v1/plugins/office-documents',{headers:{Authorization:'Bearer '+token},data:{enabled:false}});
  assert.ok(response.ok());
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('button',{name:'办公文件',exact:true})).toBeHidden();
});
