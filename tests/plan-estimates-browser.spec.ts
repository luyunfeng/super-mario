import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('待确认计划和执行历史按任务显示估时来源，旧计划保留原时长', {timeout:30000}, async t => {
  const dir = await mkdtemp(join(tmpdir(),'mario-plan-estimates-'));
  const token = 'offline-plan-estimates';
  const server = await startServer({demo:true,dataDir:dir,host:'127.0.0.1',port:0,token});
  t.after(async () => { await server.close(); await rm(dir,{recursive:true,force:true}); });
  const {app} = server;
  const project = app.projects.create({name:'合成项目'});
  const common = {doneWhen:'核对样例通过',projectId:project.id};
  const now = new Date().toISOString();
  const stored = {id:'mixed',title:'多种来源的计划',version:1,status:'pending',createdAt:now,updatedAt:now,
    tasks:[{...common,prompt:'根据验收历史估算',expectMinutes:19,estimateSource:'learned',estimateEvidence:{sampleCount:7,minutes:19,cohort:'machine'}},
      {...common,prompt:'历史遗留任务',expectMinutes:33}]};
  app.store.put('plans',stored.id,stored);
  const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#projects/'+project.id+'/runs?token='+token);
  const box = page.locator('#plans-box');
  await box.locator('summary').click();
  const legacy = box.locator('[data-plan="mixed"]');
  await expect(legacy.getByRole('listitem').filter({hasText:'根据验收历史估算'})).toContainText('预计 19 分钟（历史估时）');
  await expect(legacy).toContainText('依据 7 个已验收样本');
  const old = legacy.getByRole('listitem').filter({hasText:'历史遗留任务'});
  await expect(old).toHaveText('历史遗留任务 · 预计 33 分钟');
  const created = await page.request.post(new URL('/api/v1/plans',page.url()).href,{headers:{Authorization:'Bearer '+token},data:{
    title:'新提交的合成计划',tasks:[{...common,prompt:'由系统估时'},{...common,prompt:'提交时指定时长',expectMinutes:12}]
  }});
  assert.equal(created.status(),201);
  const plan = await created.json();
  const current = box.locator('[data-plan="'+plan.id+'"]');
  await expect(current.getByRole('listitem').first()).toContainText('预计 '+plan.tasks[0].expectMinutes+' 分钟（默认估时）');
  await expect(current.getByRole('listitem').last()).toContainText('预计 12 分钟（显式指定）');
  await page.goto(new URL('/#chat',page.url()).href);
  const card = page.locator('#attention [data-id="plan:'+plan.id+'"]');
  await card.locator('summary').click();
  await expect(card).toContainText('默认估时');
  await expect(card).toContainText('显式指定');
  assert.equal(app.store.list('runs').length,0);
  await card.getByRole('button',{name:'拒绝',exact:true}).click();
  await page.goto(new URL('/#projects/'+project.id+'/runs',page.url()).href);
  if (!await box.locator('details').evaluate(el => (el as HTMLDetailsElement).open)) await box.locator('summary').click();
  await expect(current).toContainText('已拒绝');
  await expect(current.getByRole('listitem').last()).toContainText('预计 12 分钟（显式指定）');
});
