import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('放宽审批的规则要写授权说明，保存后列表显示说明、时间与可撤销性',{timeout:60000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-policy-grant-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#agent?rules');

  const card=page.locator('#agent-rules');
  await expect(card).toContainText('0 条规则');
  await card.getByRole('button',{name:'编辑规则'}).click();
  const editor=page.getByRole('dialog',{name:'编辑自动处理规则'});
  await editor.getByRole('button',{name:'添加规则'}).click();
  const rule=editor.locator('fieldset.rule').last();
  await rule.getByLabel('遇到',{exact:true}).selectOption('permission');
  await rule.getByLabel('由谁处理',{exact:true}).selectOption('supervisor');
  await rule.getByLabel('处理方式',{exact:true}).selectOption('auto');
  await rule.getByLabel('工作目录',{exact:true}).fill('/srv/fixture-trusted');

  // A relaxed approval without the owner's reason is refused by the server.
  await editor.getByRole('button',{name:'保存规则'}).click();
  const confirm=page.getByRole('dialog').filter({hasText:'保存高风险规则'});
  await confirm.getByRole('button',{name:'确认保存'}).click();
  await expect(editor.getByText('放宽审批的规则必须填写授权说明',{exact:false}).first()).toBeVisible();
  assert.equal(server.app.policies.read().rules.length,0,'the refused rule is not stored');

  await rule.getByLabel('授权说明',{exact:true}).fill('这个目录只放生成的试验产物');
  await rule.getByLabel('能否撤销',{exact:true}).selectOption('yes');
  await editor.getByRole('button',{name:'保存规则'}).click();
  await page.getByRole('dialog').filter({hasText:'保存高风险规则'}).getByRole('button',{name:'确认保存'}).click();
  await expect(editor).toHaveCount(0);

  const saved=server.app.policies.read().rules;
  assert.equal(saved.length,1);
  assert.equal(saved[0]!.note,'这个目录只放生成的试验产物');
  assert.equal(saved[0]!.reversible,true);
  assert.ok(saved[0]!.grantedAt && Number.isFinite(Date.parse(saved[0]!.grantedAt!)),'the editor dates a new grant');

  const shown=card.locator('.item');
  await expect(shown).toContainText('授权说明：这个目录只放生成的试验产物');
  await expect(shown).toContainText('放行的操作可撤销');
  await expect(shown).toContainText('授权于 ');

  // Reopening keeps what was saved, and saving again without changes keeps the same date.
  const firstDate=saved[0]!.grantedAt;
  await card.getByRole('button',{name:'编辑规则'}).click();
  await expect(page.getByRole('dialog',{name:'编辑自动处理规则'}).getByLabel('授权说明',{exact:true})).toHaveValue('这个目录只放生成的试验产物');
  await page.getByRole('dialog',{name:'编辑自动处理规则'}).getByRole('button',{name:'保存规则'}).click();
  await page.getByRole('dialog').filter({hasText:'保存高风险规则'}).getByRole('button',{name:'确认保存'}).click();
  await expect(page.getByRole('dialog',{name:'编辑自动处理规则'})).toHaveCount(0);
  assert.equal(server.app.policies.read().rules[0]!.grantedAt,firstDate,'an unchanged rule keeps its grant date');
});
