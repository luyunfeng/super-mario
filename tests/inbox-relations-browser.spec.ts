import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('收件详情关联、原消息导航与解除，过滤子孙并在写冲突后显示真实关系',{timeout:45000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-inbox-relations-')),token='relations-fixture';
  const server=await startServer({dataDir:dir,port:0,host:'127.0.0.1',demo:true,token});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const names=['上级样例','当前样例','子项样例','孙项样例','归档候选'];
  for(const title of names) await server.app.inbox.ingest('synthetic',[{thread:title,last:'one',title,text:'原始正文 '+title}]);
  const [root,middle,child,leaf,archived]=names.map(title=>server.app.inbox.list().find(item=>item.title===title)!);
  server.app.inbox.archive(archived!.id,archived!.version);
  await server.app.inbox.ingest('合成渠道二',[{thread:'duplicate',last:'two',title:root!.title,text:'同名的另一条原文'}]);
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const endpoint=(id:string)=>server.url+'/api/v1/inbox/'+id;
  const parent=(id:string,parentId:string,version:number)=>page.request.put(endpoint(id)+'/parent',{headers:{Authorization:'Bearer '+token},data:{parentId,version}});
  assert.ok((await parent(leaf!.id,child!.id,leaf!.version)).ok());
  assert.equal(server.app.inbox.offerConnectorParent(child!.id,middle!.id),'applied');
  await page.goto(server.url+'/#inbox?token='+token);
  const detail=page.getByRole('dialog',{name:'收件箱消息详情'});
  const relation=detail.getByRole('region',{name:'同一事项'});
  async function open(title:string){
    await page.locator('#inbox .mailbox-card').filter({has:page.getByRole('heading',{name:title,exact:true})}).getByRole('button',{name:'查看原文与详情'}).click();
  }
  await open(middle!.title);
  await relation.getByRole('button',{name:'关联到另一条收件'}).click();
  const search=relation.getByRole('searchbox');
  await search.fill('孙项');
  await expect(relation).toContainText('没有匹配的收件');
  await search.fill('归档');
  await expect(relation).toContainText('没有匹配的收件');
  await search.fill('上级');
  await expect(relation.getByRole('button',{name:root!.title,exact:true})).toHaveCount(2);
  await expect(relation).toContainText('合成渠道二');
  await relation.locator('.row').filter({hasText:'synthetic'}).getByRole('button',{name:root!.title,exact:true}).click();
  await expect(relation).toContainText('上级收件');
  const edge=(name:string)=>relation.locator('.row').filter({has:page.getByRole('button',{name,exact:true})});
  await expect(edge(root!.title)).toContainText('主人手动关联');
  await expect(edge(child!.title)).toContainText('飞书直接回复');
  await relation.getByRole('button',{name:child!.title,exact:true}).click();
  await expect(edge(middle!.title)).toContainText('飞书直接回复');
  await expect(edge(root!.title)).toContainText('主人手动关联');
  await relation.getByRole('button',{name:'保留此上级'}).click();
  await expect(edge(middle!.title)).toContainText('主人手动关联');
  await expect(relation.getByRole('button',{name:'保留此上级'})).toHaveCount(0);
  assert.equal(server.app.inbox.offerConnectorParent(child!.id,middle!.id),'ignored');
  assert.equal(server.app.inbox.offerConnectorParent(child!.id,root!.id),'ignored');
  assert.equal(server.app.inbox.tree(child!.id).item.parentInboxId,middle!.id);
  await relation.getByRole('button',{name:middle!.title,exact:true}).click();
  await relation.getByRole('button',{name:root!.title,exact:true}).click();
  await expect(detail.locator('h3')).toHaveText(root!.title);
  await expect(detail).toContainText('原始正文 '+root!.title);
  await relation.getByRole('button',{name:middle!.title,exact:true}).click();
  await expect(detail.locator('h3')).toHaveText(middle!.title);
  await page.reload();
  await open(middle!.title);
  await expect(relation.getByRole('button',{name:root!.title,exact:true})).toBeVisible();
  // Commit a competing real write between reading the tree and submitting the versioned edit.
  let raced=false;
  await page.route('**/inbox/'+middle!.id+'/parent',async route=>{
    if(!raced && route.request().method()==='PUT') {
      raced=true;
      const version=route.request().postDataJSON().version;
      assert.ok((await parent(middle!.id,archived!.id,version)).ok());
    }
    await route.continue();
  });
  await relation.getByRole('button',{name:'解除上级关联'}).click();
  await expect(relation).toContainText('关联存在冲突');
  await expect(relation.getByRole('button',{name:'归档候选（已归档）'})).toBeVisible();
  await relation.getByRole('button',{name:'解除上级关联'}).click();
  await expect(relation.getByRole('button',{name:'解除上级关联'})).toHaveCount(0);
  const tree=await (await page.request.get(endpoint(middle!.id)+'/tree',{headers:{Authorization:'Bearer '+token}})).json();
  assert.deepEqual(tree.ancestors,[]);
  assert.equal(tree.children[0].id,child!.id);
});
