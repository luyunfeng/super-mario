import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('渠道页面按机器人保存待决定提醒时长，兼容已有自定义值和关闭选项',{timeout:40000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-nudge-ui-'));
  const token='synthetic-nudge-setting';
  const server=await startServer({dataDir:dir,port:0,host:'127.0.0.1',demo:true,token},{
    botFactory:()=>({async start(){},async close(){},status:()=>({connected:true}),collect:async()=>[],async send(){assert.fail('设置时不应发送飞书消息');}}),
  });
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const url=server.url+'/api/v1/feishu/bots';
  async function create(n:number,extra:Record<string,unknown>={}) {
    const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({name:'合成机器人'+n,appId:'cli_'+String(n).repeat(16),
      appSecret:'fixture-only',scope:{kind:n===3?'unmarked':'global'},...extra})});
    assert.equal(response.status,201);
    return (await response.json()).id as string;
  }
  const defaultBot=await create(1),customBot=await create(2,{decisionNudgeMinutes:45}),otherBot=await create(3);
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  async function settings() {
    await page.goto(server.url+'/#channels?token='+token);
    await page.getByText('高级：手动接入、信箱与事件',{exact:true}).click();
  }
  const edit=(id:string)=>page.locator('.bot-card[data-bot-id="'+id+'"]').getByRole('button',{name:'编辑',exact:true}).click();
  const form=page.locator('.bot-form'),choice=form.getByLabel('待决定提醒等待时长');
  async function save(id:string,value:string) {
    await choice.selectOption(value);
    const saved=page.waitForResponse(res=>res.url()===url+'/'+id && res.request().method()==='PATCH');
    await form.getByRole('button',{name:'保存手动接入',exact:true}).click();
    assert.equal((await saved).status(),200);
    await expect(form.getByRole('heading',{name:'添加机器人'})).toBeVisible();
  }
  await settings();await edit(otherBot);await expect(choice).not.toBeVisible();
  await edit(customBot);
  await expect(choice).toHaveValue('45');
  await expect(choice.locator('option:checked')).toHaveText('45 分钟');
  await form.getByRole('button',{name:'取消编辑 / 新建'}).click();
  await expect(choice).toHaveValue('60');
  await expect(choice.locator('option')).toHaveText(['关闭','15 分钟','30 分钟','1 小时','2 小时','4 小时','8 小时']);
  await edit(defaultBot);await expect(choice).toHaveValue('60');await save(defaultBot,'15');
  await edit(customBot);await save(customBot,'0');
  const rows=await (await fetch(url,{headers})).json();
  assert.deepEqual([defaultBot,customBot].map(id=>rows.find((row:{id:string})=>row.id===id).decisionNudgeMinutes),[15,0]);
  await page.reload();await page.getByText('高级：手动接入、信箱与事件',{exact:true}).click();
  await edit(customBot);await expect(choice).toHaveValue('0');
  await page.goto(server.url+'/#agent');
  const openQuiet=()=>page.getByRole('button',{name:'简报与离场通知设置'}).click();
  await openQuiet();
  const drawer=page.getByRole('dialog',{name:'简报与离场通知'});
  const toggle=drawer.getByLabel('飞书待决定提醒免打扰');
  await expect(toggle).not.toBeChecked();await toggle.check();
  const start=drawer.getByLabel('免打扰开始'),end=drawer.getByLabel('免打扰结束');
  await expect(start).toHaveValue('22:00');await expect(end).toHaveValue('08:00');
  await drawer.getByLabel('时区',{exact:true}).fill('Asia/Shanghai');
  await start.fill('23:15');await end.fill('06:45');
  const changed=page.waitForResponse(res=>res.url().endsWith('/briefing/settings') && res.request().method()==='PUT');
  await drawer.getByRole('button',{name:'保存简报设置'}).click();
  assert.equal((await changed).status(),200);
  await expect(drawer).toHaveCount(0);
  const brief=await (await fetch(server.url+'/api/v1/briefing/settings',{headers})).json();
  assert.deepEqual(brief.decisionQuietHours,{enabled:true,start:'23:15',end:'06:45'});
  assert.equal(brief.timezone,'Asia/Shanghai');
  await page.reload();await openQuiet();
  await expect(toggle).toBeChecked();await expect(start).toHaveValue('23:15');await expect(end).toHaveValue('06:45');
});
