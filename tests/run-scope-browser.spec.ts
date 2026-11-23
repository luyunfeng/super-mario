import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import { createRunScopes } from '../packages/core/src/run-scope.ts';
import type { Run } from '../packages/protocol/src/index.ts';

test('展开验收变更，保留冲突草稿，核对丢失的保存回执并阻止重复提交', {timeout:40000}, async t => {
  const dir = await mkdtemp(join(tmpdir(),'mario-run-scope-web-'));
  const token = 'offline-scope';
  const server = await startServer({demo:true,dataDir:dir,host:'127.0.0.1',port:0,token});
  t.after(async () => { await server.close(); await rm(dir,{recursive:true,force:true}); });
  const app = server.app;
  const project = app.projects.create({name:'合成项目'}), todo = app.createTodo({title:'核对表格',projectId:project.id});
  const now = new Date().toISOString();
  const run: Run = {id:'fixture-run',projectId:project.id,todoId:todo.id,executorId:'fixture-node/codex',
    conversationId:'main',prompt:'合成任务',status:'running',doneWhen:'原标准',expectMinutes:10,output:'',createdAt:now,updatedAt:now};
  app.store.put('runs',run.id,run);
  const scopes = createRunScopes(app.store);
  const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen','true'));
  let reads = 0, writes = 0, loseReceipt = false;
  await page.route('**/api/v1/runs/fixture-run/scope*',async route => {
    if (route.request().method() === 'GET') {
      reads++;
      assert.equal(new URL(route.request().url()).searchParams.get('expectedProjectId'),project.id);
    } else {
      writes++;
      assert.equal(route.request().postDataJSON().expectedProjectId,project.id);
      if (loseReceipt) {
        loseReceipt = false;
        const sent = await route.fetch(); assert.equal(sent.status(),200);
        await route.abort('failed'); return;
      }
    }
    await route.continue();
  });
  await page.goto(server.url+'/#projects/'+project.id+'/todos/detail/'+todo.id+'?token='+token);
  const brief = page.locator('details[aria-label="交办依据"]');
  await brief.locator('summary').first().click();
  const scope = brief.locator('details[aria-label="验收标准变更"]');
  await expect(scope).toBeVisible();
  assert.equal(reads,0);
  await scope.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(scope).toContainText('尚无验收标准变更');
  const criterion = scope.getByLabel('新的验收标准'), reason = scope.getByLabel('变更理由');
  const save = scope.getByRole('button',{name:'保存验收标准'});
  await criterion.fill('逐列核对');
  await expect(save).toBeDisabled();
  await reason.fill('核对第二批样例');
  await scope.getByLabel('新的预计分钟（可选）').fill('15');
  scopes.revise(run.id,{expectedDoneWhen:'原标准',expectedVersion:0,doneWhen:'外部调整',reason:'合成调整'}, {kind:'assistant'});
  await save.click();
  await expect(scope).toContainText('草稿已保留');
  await expect(save).toBeDisabled();
  await page.reload();
  await brief.locator(':scope > summary').click();
  await scope.locator('summary').click();
  await expect(scope).toContainText('助手修改');
  await expect(criterion).toHaveValue('逐列核对');
  await expect(reason).toHaveValue('核对第二批样例');
  await scope.getByRole('button',{name:'按最新版本继续编辑'}).click();
  await expect(save).toBeEnabled();
  loseReceipt = true;
  await save.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => scopes.read(run.id).version).toBe(2);
  await scope.getByRole('button',{name:'核对当前版本'}).click();
  await expect(scope).toContainText('核对第二批样例');
  await expect(scope).toContainText('主人在 Web 修改');
  await expect(scope).toContainText('10 分钟 → 15 分钟');
  await expect(reason).toHaveValue('');
  await expect(save).toBeDisabled();
  assert.equal(writes,2);
  const updated = app.store.get<Run>('runs',run.id)!;
  app.store.put('runs',run.id,{...updated,status:'completed'});
  app.events.publish('runs.changed',{id:run.id});
  await expect(scope).toContainText('仅运行中的执行可以修改验收标准');
  await expect(criterion).toBeHidden();
});
