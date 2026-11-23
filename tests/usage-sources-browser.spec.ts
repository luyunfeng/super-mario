import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('工作台管理用量来源：试读、凭据保护、窗口、筛选与停用',{timeout:40000},async t=>{
  const key='synthetic-usage-source-only',dataDir=await mkdtemp(join(tmpdir(),'mario-usage-'));
  let percent=37;
  const upstream=createServer((req,res)=>{
    if(req.headers.authorization!=='Bearer '+key){res.writeHead(401).end();return;}
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({accounts:[{id:'fixture',name:'合成订阅账户',provider:'fixture',plan:'合成计划',sampled_at:new Date().toISOString(),
      windows:[{label:'5h',used_percent:percent,resets_at:new Date(Date.now()+3600000).toISOString()}]}]}));
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>upstream.close(()=>resolve())));
  const address=upstream.address();assert.ok(address && typeof address!=='string');
  const url='http://127.0.0.1:'+address.port+'/quota',token='synthetic-owner';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true,token});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
  const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#agent?usageSources=1&token='+token);
  const panel=page.getByRole('dialog',{name:'用量来源',exact:true});
  await panel.getByRole('button',{name:'新增用量来源'}).click();
  const add=page.getByRole('dialog',{name:'新增用量来源'});
  await add.getByLabel('来源类型').selectOption('generic');await add.getByLabel('来源名称').fill('合成用量源');
  await add.getByLabel('接口地址').fill(url);await add.getByLabel('访问密钥').fill(key);
  await add.getByRole('button',{name:'试读来源'}).click();await expect(add).toContainText('1 个账户，1 个用量窗口');
  await add.getByRole('button',{name:'保存来源'}).click();
  const source=panel.getByRole('region',{name:'合成用量源'});
  await source.getByRole('button',{name:'立即读取'}).click();
  const account=panel.getByRole('article',{name:'合成订阅账户'});await expect(account).toContainText('已用 37%');
  await source.getByRole('button',{name:'编辑来源'}).click();
  const edit=page.getByRole('dialog',{name:'编辑用量来源'});
  await expect(edit.getByLabel('访问密钥')).toHaveValue('');
  await edit.getByLabel('接口地址').fill(url+'2');await expect(edit.getByRole('button',{name:'试读来源'})).toBeDisabled();
  await edit.getByLabel('接口地址').fill(url);await edit.getByLabel('来源名称').fill('合成已修改');await edit.getByRole('button',{name:'保存来源'}).click();
  const renamed=panel.getByRole('region',{name:'合成已修改'});
  await expect(renamed).toBeVisible();await expect(panel).not.toContainText(key);
  const h={'Authorization':'Bearer '+token};
  const state=await (await fetch(server.url+'/api/v1/usage/sources',{headers:h})).json();assert.ok(!JSON.stringify(state).includes(key));
  await panel.getByLabel('轮询间隔（分钟）').fill('23');
  percent=51;const id=state.sources[0].id;
  const response=await fetch(server.url+'/api/v1/usage/sources/'+id+'/refresh',{method:'POST',headers:{...h,'Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,200);await expect(account).toContainText('已用 51%');
  await expect(panel.getByLabel('轮询间隔（分钟）')).toHaveValue('23');
  await panel.getByRole('checkbox',{name:'显示 fixture'}).uncheck();
  await panel.getByRole('button',{name:'保存轮询设置'}).click();await expect(account).toHaveCount(0);
  await panel.getByRole('checkbox',{name:'显示 fixture'}).check();
  await panel.getByLabel('轮询间隔（分钟）').fill('15');await panel.getByRole('button',{name:'保存轮询设置'}).click();
  await expect(account).toBeVisible();await expect(panel.getByLabel('轮询间隔（分钟）')).toHaveValue('15');
  await renamed.getByLabel('启用此来源').uncheck();await expect(account).toHaveCount(0);
  await renamed.getByRole('button',{name:'删除来源'}).click();await page.getByRole('dialog',{name:'删除用量来源'}).getByRole('button',{name:'删除来源'}).click();
  await expect(renamed).toHaveCount(0);
});
