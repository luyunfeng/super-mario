import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('抽屉支持键盘关闭并把焦点还给触发它的按钮，窄屏不横向溢出，找不到的对象有提示',{timeout:40000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-keyboard-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#agent');

  // Open a drawer with the keyboard only, then close it with Escape.
  const trigger=page.getByRole('button',{name:'简报与离场通知设置'});
  await trigger.focus();
  await page.keyboard.press('Enter');
  const drawer=page.getByRole('dialog',{name:'简报与离场通知'});
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button',{name:'关闭',exact:true})).toBeFocused();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('dialog')!==null),true,'Tab stays inside the dialog');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // The same drawer on a phone-width screen.
  await page.setViewportSize({width:390,height:844});
  await trigger.click();
  await expect(page.getByRole('dialog',{name:'简报与离场通知'})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('dialog',{name:'简报与离场通知'}).getByRole('button',{name:'关闭',exact:true}).click();

  // An object that does not exist says so, in each place that can be linked to.
  await page.goto(server.url+'/#projects/missing-project/workspace');
  // A project that is gone does not silently become "all projects".
  await expect(page).toHaveURL(/#projects\/all\/todos$/);
  await expect(page.getByRole('status').filter({hasText:'找不到这个项目'})).toBeVisible();
  // A project that exists opens without the notice.
  const project=await server.app.createProject({name:'键盘验收项目'});
  await page.goto(server.url+'/#projects/'+project.id+'/workspace');
  await expect(page.locator('main')).toContainText('键盘验收项目');
  await expect(page.getByRole('status').filter({hasText:'找不到这个项目'})).toHaveCount(0);
  await page.goto(server.url+'/#projects/all/runs/missing-run');
  await expect(page.locator('main')).toContainText('找不到');
  await page.goto(server.url+'/#inbox?item=missing-inbox');
  await expect(page.getByRole('status').filter({hasText:'当前工作台找不到这条收件'})).toBeVisible();
});
