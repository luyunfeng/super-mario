import QRCode from 'qrcode';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('两台浏览器主动配对、持久登录、单次兑换与撤销',{timeout:40000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-browser-devices-')),token='synthetic-browser-device-owner';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true,token});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
  const admin=await browser.newContext(),fresh=await browser.newContext();
  for(const ctx of [admin,fresh])await ctx.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const owner=await admin.newPage(),device=await fresh.newPage();
  const settings=server.url+'/#agent?browserDevices=1';
  await owner.goto(settings+'&token='+token);
  const manage=owner.getByRole('dialog',{name:'浏览器设备'});
  await manage.getByLabel('设备名称').fill('合成浏览器');await manage.getByRole('button',{name:'生成配对链接'}).click();
  const link=await manage.getByLabel('一次性配对链接').inputValue(),url=new URL(link);
  await expect(manage.getByRole('img',{name:'浏览器配对二维码'})).toHaveAttribute('src',await QRCode.toDataURL(link,{width:240,margin:4,errorCorrectionLevel:'M'}));
  assert.equal(url.search,'');assert.ok(/^#home\?browserPair=[A-Za-z0-9_-]{32}$/.test(url.hash));assert.ok(!link.includes(token));
  let redemptions=0;device.on('request',req=>{
    assert.ok(!req.url().includes(url.hash.slice('#home?browserPair='.length)));
    if(new URL(req.url()).pathname==='/api/v1/public/browser-pair'){
      redemptions++;assert.equal(req.headers()['authorization'],undefined);
    }
  });
  await device.goto(link);
  const accept=device.getByRole('dialog',{name:'配对这台浏览器'});
  await expect(accept).toBeVisible();assert.equal(redemptions,0);assert.equal(new URL(device.url()).hash,'#home');
  await accept.getByRole('button',{name:'确认连接这台浏览器'}).click();await expect(accept).toHaveCount(0);
  assert.equal(redemptions,1);
  await device.goto(settings);await device.reload();
  const paired=device.getByRole('dialog',{name:'浏览器设备'});
  await expect(paired).toContainText('合成浏览器');await expect(paired).toContainText('当前设备');
  await expect(paired.getByRole('button',{name:'生成配对链接'})).toHaveCount(0);
  const replay=await browser.newPage();await replay.goto(link);await replay.getByRole('button',{name:'确认连接这台浏览器'}).click();
  await expect(replay.getByRole('dialog',{name:'配对这台浏览器'})).toContainText('配对码无效或已过期');
  await manage.getByRole('button',{name:'刷新设备'}).click();
  const row=manage.getByRole('article',{name:'合成浏览器'});await expect(row).toContainText('最近活跃');
  await row.getByRole('button',{name:'撤销设备'}).click();const confirm=owner.getByRole('dialog',{name:'撤销浏览器设备'});
  await confirm.getByRole('button',{name:'取消'}).click();await expect(row).toBeVisible();
  await row.getByRole('button',{name:'撤销设备'}).click();await confirm.getByRole('button',{name:'确认撤销'}).click();
  await expect(row).toHaveCount(0);await device.reload();await expect(device.locator('#connection')).toContainText('需要令牌');
});
