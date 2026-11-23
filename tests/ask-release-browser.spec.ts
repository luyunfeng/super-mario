import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('真实后台消息将等待卡转为稍后回答，保留正在编辑的原文、选项与焦点', { timeout: 45000 }, async t => {
  const token = 'fixture-question-release';
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-web-question-release-'));
  const server = await startServer({ host:'127.0.0.1', port:0, dataDir, demo:true, token });
  t.after(async () => { await server.close(); await rm(dataDir,{ recursive:true, force:true }); });
  const browser = await chromium.launch({ executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url + '/#chat?token=' + token);
  const questions = [{ question:'需要哪些列？', multiSelect:true, options:[{label:'部门'},{label:'数量'}] }];
  for (const structured of [false, true]) {
    const title = structured ? '选择导出列' : '填写导出格式';
    const res = await page.request.post(server.url + '/api/v1/messages', {
      headers:{ Authorization:'Bearer ' + token }, data:{text:'请核对' + title} });
    assert.equal(res.status(),202);
    const source = await res.json() as Message;
    const card = server.app.interactions.open({ kind:'question', title, body:'核对后再交付。', ...(structured && {questions}) }, source);
    const row = page.locator('[data-id="interaction:' + card.id + '"]');
    const field = row.getByRole('textbox', {name: structured ? '文字回答' : '回答：' + title});
    await expect(row).toContainText('等待你的回答');
    // Age the stored card before editing. Subsequent events are actual host queue and HTTP operations.
    const current = server.app.interactions.list().find(item => item.id === card.id)!;
    server.app.store.put('interactions',card.id,{...current,createdAt:new Date(Date.now() - 125_000).toISOString()});
    await page.reload();
    if (structured) await row.getByRole('checkbox',{name:'数量'}).check();
    const text = structured ? '按单位汇总' : '请导出成表格';
    await field.fill(text);
    await server.app.agent.post('正在处理另一项只读工作','main',{readOnly:true});
    await server.app.postScopedResult({text:'示例自动进展',scope:{kind:'global'},botId:'test-bot',sourceMessageId:source.id});
    await expect(row).toContainText('可继续聊天，稍后回到这张卡回答。');
    await expect(field).toHaveValue(text);
    await expect(field).toBeFocused();
    if (structured) await expect(row.getByRole('checkbox',{name:'数量'})).toBeChecked();
    await expect(row.getByRole('button',{name:'关闭提问'})).toBeVisible();
    const released = server.app.interactions.list().find(item => item.id === card.id)!;
    const sent = page.waitForResponse(r => r.url().endsWith('/interactions/' + card.id + '/answer') && r.request().method() === 'POST');
    await row.getByRole('button',{name:'回答',exact:true}).click();
    const receipt = await sent;
    assert.equal(receipt.status(),200);
    assert.deepEqual(receipt.request().postDataJSON(), structured ? {version:released.version,answers:[{selected:['数量'],text}]} : {version:released.version,text});
    await expect(row).toHaveCount(0);
  }
});
