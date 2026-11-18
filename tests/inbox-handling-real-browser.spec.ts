import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{chromium,expect}from'@playwright/test';
import{startServer}from'../apps/server/src/index.ts';

test('actual Web/HTTP/SQLite: source drawer → chat approval → edit current suggestion → approve without hidden overlays',{timeout:30000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-inbox-ui-'));
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,demo:true,token:'fixture'});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  const project=await server.app.createProject({name:'Synthetic project'});
  await server.app.inbox.ingest('synthetic',[{thread:'one',last:'1',title:'合成来源',text:'请核对本地验收',origin:{kind:'direct'}}]);
  const item=server.app.inbox.list()[0]!;server.app.inbox.assignProject(item.id,item.version,project.id);
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.url+'/#inbox?token=fixture');
  await page.locator('#inbox .mailbox-card').getByRole('button',{name:'查看原文与详情',exact:true}).click();
  await page.getByRole('dialog',{name:'收件箱消息详情',exact:true}).getByRole('button',{name:'处理与建议',exact:true}).click();
  const handling=page.getByRole('dialog',{name:'处理与建议',exact:true});
  await handling.getByRole('button',{name:'手工新建建议',exact:true}).click();
  await handling.getByLabel('待办标题',{exact:true}).fill('初稿');await handling.getByLabel('待办备注',{exact:true}).fill('仅限本地合成验收');
  await handling.getByRole('button',{name:'保存建议（不执行）',exact:true}).click();
  async function submitCurrent(){await handling.getByRole('button',{name:'检查并提交审批',exact:true}).click();await handling.getByRole('button',{name:'提交当前建议审批',exact:true}).click();await expect(handling.getByRole('link',{name:'去对话审批',exact:true})).toBeVisible();}
  await submitCurrent();const old=server.app.approvals.list().find(a=>a.kind==='plugin:inbox-triage.handle-suggestion')!;
  await handling.getByRole('link',{name:'去对话审批',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('#chat')).toBeVisible();
  const more=page.locator('#attention').getByRole('button',{name:/还有.*件/});if(await more.isVisible())await more.click();
  const originalCard=page.locator(`#attention [data-id="approval:${old.id}"]`);
  await originalCard.getByRole('button',{name:'改一下',exact:true}).click();
  await expect(handling).toBeVisible();await handling.getByRole('button',{name:'编辑建议',exact:true}).click();
  await handling.getByLabel('待办标题',{exact:true}).fill('通过来源建议编辑的新标题');
  await handling.getByRole('button',{name:'保存建议（不执行）',exact:true}).click();
  await expect.poll(()=>server.app.approvals.list().find(a=>a.id===old.id)?.status).toBe('rejected');
  await submitCurrent();const next=server.app.approvals.list().find(a=>a.id!==old.id&&a.kind==='plugin:inbox-triage.handle-suggestion'&&a.status==='pending')!;assert.ok(next);
  // The link targets the current route too: closing its own drawer is required
  // even when the router has no hashchange to emit.
  await handling.getByRole('link',{name:'去对话审批',exact:true}).click();await expect(handling).toHaveCount(0);
  if(await more.isVisible())await more.click();
  await page.locator(`#attention [data-id="approval:${next.id}"]`).getByRole('button',{name:'批准',exact:true}).click();
  const consent=page.getByRole('dialog',{name:/高风险/});if(await consent.isVisible())await consent.getByRole('button',{name:'确认批准',exact:true}).click();
  await expect.poll(()=>server.app.todos().length).toBe(1);
  const todo=server.app.todos()[0]!;assert.equal(todo.title,'通过来源建议编辑的新标题');assert.equal(todo.projectId,project.id);assert.equal(todo.completedAt,undefined);assert.ok(server.app.inbox.list()[0]?.archivedAt);
  await page.goto(server.url+'/#memory?curator=1');await expect(page.getByRole('dialog',{name:'记忆整理 Agent',exact:true})).toBeVisible();
  await page.goto(server.url+'/#inbox');await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
});
