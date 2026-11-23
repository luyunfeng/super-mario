import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('主人从项目页添加项目，按可见范围批量置顶和归档，恢复后保持同一项目', {timeout:30000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-board-browser-'));
  const token='offline-board';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,token,demo:true});
  t.after(async()=>{try{await server.close();}finally{await rm(dataDir,{recursive:true,force:true});}});
  const projects:{id:string;name:string}[]=[];
  for(const name of ['合成签收甲','合成签收乙','合成留档丙']) projects.push(await server.app.createProject({name}));
  const machines=[{id:'fixture-board-west',name:'合成西站'},{id:'fixture-board-west-2',name:'合成东站'}];
  for(const [i,machine] of machines.entries()){
    server.app.store.put('machines',machine.id,{...machine,online:false,capabilities:[],executors:[]});
    server.app.projects.update(projects[i].id,{workspace:{machineId:machine.id,cwd:'/work/'+['algebra','design'][i]}});
  }
  const post=(path:string,body:object)=>fetch(server.url+'/api/v1'+path,{method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  const rows=async()=>{
    const r=await post('/workspace-board',{action:'list'});assert.equal(r.status,200);
    return (await r.json()).cards as {projectId:string;pinned:boolean;archived:boolean}[];
  };
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  page.setDefaultTimeout(6000);
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#projects/'+projects[0].id+'/workspace?token='+token);
  const entry=page.getByRole('button',{name:'工作区看板',exact:true});
  await entry.click();
  const board=page.getByRole('dialog',{name:'工作区看板'});
  const visibleRows=board.getByRole('checkbox',{name:/^选择 /});
  for(const project of projects){
    await board.getByLabel('添加项目',{exact:true}).selectOption({label:project.name});
    await board.getByRole('button',{name:'添加卡片',exact:true}).click();
    await expect(board.getByRole('checkbox',{name:'选择 '+project.name})).toBeVisible();
  }
  const textFilter=board.getByLabel('筛选项目',{exact:true}),machineFilter=board.getByLabel('绑定机器',{exact:true});
  for(const [query,label] of [['签收甲',projects[0].name],['/work/design',projects[1].name],['合成西站',projects[0].name],
    ['fixture-board-west-2',projects[1].name]]){
    await textFilter.fill(query);
    await expect(visibleRows).toHaveCount(1);
    await expect(visibleRows).toHaveAccessibleName('选择 '+label);
  }
  await textFilter.fill('');
  await machineFilter.selectOption(machines[0].id);
  await expect(visibleRows).toHaveCount(1);
  await expect(visibleRows).toHaveAccessibleName('选择 '+projects[0].name);
  await textFilter.fill('签收乙');
  await expect(visibleRows).toHaveCount(0);
  await machineFilter.selectOption({label:'全部机器'});
  await board.getByLabel('筛选项目',{exact:true}).fill('签收');
  await expect(visibleRows).toHaveCount(2);
  await board.getByRole('button',{name:'全选可见卡片',exact:true}).click();
  await board.getByRole('button',{name:'置顶',exact:true}).click();
  await expect.poll(async()=>(await rows()).filter(c=>c.pinned).map(c=>c.projectId).sort()).toEqual(projects.slice(0,2).map(p=>p.id).sort());
  await expect(board.getByText('已置顶',{exact:true})).toHaveCount(2);
  await board.getByRole('button',{name:'全选可见卡片',exact:true}).click();
  await board.getByRole('button',{name:'归档',exact:true}).click();
  await expect(visibleRows).toHaveCount(0);
  await board.getByLabel('显示卡片',{exact:true}).selectOption({label:'已归档'});
  await expect(visibleRows).toHaveCount(2);
  await board.getByRole('button',{name:'全选可见卡片',exact:true}).click();
  await board.getByRole('button',{name:'恢复',exact:true}).click();
  await expect(visibleRows).toHaveCount(0);
  await board.getByLabel('筛选项目',{exact:true}).fill('');
  await board.getByLabel('显示卡片',{exact:true}).selectOption({label:'未归档'});
  await expect(visibleRows).toHaveCount(3);
  const all=await rows();assert.ok(all.every(c=>!c.archived));
  assert.equal(all.find(c=>c.projectId===projects[2].id)?.pinned,false);
  const activity=page.getByRole('dialog',{name:'看板变更历史',exact:true});
  await board.getByRole('button',{name:'变更历史',exact:true}).click();
  const version=(await (await post('/workspace-board',{action:'list'})).json()).revision;
  await activity.getByRole('button',{name:'展开版本 '+version,exact:true}).click();
  await expect(activity).toContainText('变更前');
  await expect(activity).toContainText('变更后');
  await expect(activity).toContainText(projects[0].name);
  await expect(activity).toContainText(projects[1].name);
  const projectLink=activity.getByRole('link',{name:'打开项目 '+projects[1].name,exact:true});
  await projectLink.click();
  await expect.poll(()=>new URL(page.url()).hash).toBe('#projects/'+projects[1].id+'/workspace');
  await expect(activity).toBeHidden();await expect(board).toBeHidden();
  await entry.click();
  const cardHistory=page.getByRole('dialog',{name:'卡片变更历史',exact:true});
  await board.getByRole('button',{name:'变更历史 '+projects[2].name,exact:true}).click();
  await expect(cardHistory.getByRole('button',{name:/^展开版本 /})).toHaveCount(1);
  await cardHistory.getByRole('button',{name:/^展开版本 /}).click();
  await expect(cardHistory).toContainText(projects[2].name);
  await expect(cardHistory).not.toContainText(projects[0].name);
  assert.equal((await post('/plugins/workspace-board',{enabled:false})).status,200);
  await expect(cardHistory).toBeHidden();await expect(board).toBeHidden();await expect(entry).toHaveCount(0);
  const citation='[查看项目](#projects/'+projects[1].id+'/workspace)';
  server.app.store.put('messages','fixture-board-reply',{id:'fixture-board-reply',role:'assistant',conversationId:'main',
    createdAt:new Date().toISOString(),status:'done',text:citation});
  await page.goto(server.url+'/#chat');await page.reload();
  await page.getByRole('link',{name:'查看项目',exact:true}).click();
  await expect.poll(()=>new URL(page.url()).hash).toBe('#projects/'+projects[1].id+'/workspace');
});

test('批量移动非连续卡后撤销还原原序，另一窗口调序立即收回旧撤销', {timeout:30000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-board-order-'));
  const token='synthetic-order';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,token,demo:true});
  t.after(async()=>{try{await server.close();}finally{await rm(dataDir,{recursive:true,force:true});}});
  const post=async(body:object)=>{
    const r=await fetch(server.url+'/api/v1/workspace-board',{method:'POST',headers:{authorization:'Bearer '+token,
      'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(r.status,200);return r.json() as Promise<{revision:number;cards:{columnId:string;title:string}[]}>;
  };
  const names=['批次甲','批次乙','批次丙','批次丁'];
  let version=(await post({action:'list'})).revision;
  let projectId='';
  for(const name of names){
    const p=await server.app.createProject({name});projectId=p.id;
    version=(await post({action:'add_card',projectId:p.id,columnId:'todo',revision:version})).revision;
  }
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const open=async()=>{
    const page=await context.newPage();
    await page.goto(server.url+'/#projects/'+projectId+'/workspace?token='+token);
    await page.getByRole('button',{name:'工作区看板',exact:true}).click();
    const board=page.getByRole('dialog',{name:'工作区看板'});
    await expect(board.getByRole('checkbox',{name:'选择 '+names[0]})).toBeVisible();
    return board;
  };
  const board=await open(),peer=await open();
  const undo=board.getByRole('button',{name:'撤销上次批量操作',exact:true});
  const original=board.getByRole('region',{name:'待办',exact:true}).getByRole('link',{name:/^打开项目 /});
  const doing=board.getByRole('region',{name:'进行中',exact:true}).getByRole('link',{name:/^打开项目 /});
  const links=(items:string[])=>items.map(n=>'打开项目 '+n);
  await expect(original).toHaveText(links(names));
  for(const n of [names[0],names[2]]) await board.getByRole('checkbox',{name:'选择 '+n}).check();
  await board.getByLabel('移动到列',{exact:true}).selectOption('doing');
  await board.getByRole('button',{name:'移动卡片',exact:true}).click();
  await expect(original).toHaveText(links([names[1],names[3]]));
  await expect(doing).toHaveText(links([names[0],names[2]]));
  await undo.click();
  await expect(original).toHaveText(links(names));
  await expect(doing).toHaveCount(0);
  assert.deepEqual((await post({action:'list'})).cards.filter(c=>c.columnId==='todo').map(c=>c.title),names);
  await board.getByRole('checkbox',{name:'选择 '+names[3]}).check();
  await board.getByRole('button',{name:'置顶',exact:true}).click();
  await expect(undo).toBeVisible();
  await expect(peer.getByText('已置顶',{exact:true})).toBeVisible();
  await peer.getByRole('button',{name:'上移 '+names[2],exact:true}).press('Enter');
  await expect(undo).toHaveCount(0);
  await expect(original).toHaveText(links([names[3],names[0],names[2],names[1]]));
  const drag=board.locator('[data-board-card]').filter({has:board.page().getByRole('checkbox',{name:'选择 '+names[0],exact:true})});
  const end=board.locator('[data-board-column-end="doing"]');
  await drag.dragTo(end,{sourcePosition:{x:2,y:2}});
  await expect(doing).toHaveText(links([names[0]]));
  await expect(original).toHaveText(links([names[3],names[2],names[1]]));
  assert.deepEqual((await post({action:'list'})).cards.filter(c=>c.columnId==='doing').map(c=>c.title),[names[0]]);
});

test('项目看板自动分组按工作状态和查询筛选，点击待办进入原详情', {timeout:30000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-board-lanes-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,token:'fixture',demo:true});
  t.after(async()=>{try{await server.close();}finally{await rm(dataDir,{recursive:true,force:true});}});
  const project=await server.app.createProject({name:'合成工作台'});
  const one=server.app.createTodo({title:'合成计划交接'});
  server.app.createTodo({title:'合成计划复核'});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#projects/'+project.id+'/workspace?token=fixture');
  await page.getByRole('button',{name:'工作区看板',exact:true}).click();
  const board=page.getByRole('dialog',{name:'工作区看板'});
  const auto=board.getByRole('button',{name:'自动分组',exact:true}),manual=board.getByRole('button',{name:'手工列',exact:true});
  await expect(manual).toHaveAttribute('aria-pressed','true');
  await auto.click();
  await expect(auto).toHaveAttribute('aria-pressed','true');
  await page.reload();
  const reopen=page.getByRole('button',{name:'工作区看板',exact:true});
  await reopen.click();
  await expect(auto).toHaveAttribute('aria-pressed','true');
  await manual.click();
  await board.getByRole('button',{name:'关闭',exact:true}).click();
  await reopen.click();
  await expect(manual).toHaveAttribute('aria-pressed','true');
  await auto.click();
  await board.getByLabel('工作状态',{exact:true}).selectOption('planned');
  await board.getByLabel('筛选自动分组',{exact:true}).fill('合成计划');
  const planned=board.getByRole('region',{name:'待办',exact:true});
  await expect(planned.getByRole('link',{name:/^打开待办 /})).toHaveCount(2);
  server.app.createTodo({title:'合成计划新增检查'});
  await expect(planned.getByRole('link',{name:/^打开待办 /})).toHaveCount(3);
  await board.getByLabel('筛选自动分组',{exact:true}).fill('交接');
  const target=planned.getByRole('link',{name:'打开待办 '+one.title,exact:true});
  await expect(planned.getByRole('link')).toHaveCount(1);
  await target.click();
  await expect(board).toBeHidden();
  await expect(page).toHaveURL(new RegExp('/todos/detail/'+one.id+'$'));
  await expect(page.getByRole('heading',{name:one.title,exact:true})).toBeVisible();
});
