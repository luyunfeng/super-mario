import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import {startAgentNode} from '../apps/agent-node/src/index.ts';
import {createProjectDiscovery} from '../plugins/project-discovery.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('主对话和项目发件卡按原请求恢复，保留新草稿，移除记录保留已受理消息',{timeout:60000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-outbox-web-')),token='fixture-outbox',machineId='fixture-workspace';
  const server=await startServer({host:'127.0.0.1',port:0,token,demo:true,dataDir:join(dir,'server')});
  const cwd=join(dir,'workspace');await mkdir(cwd);
  const workspace=createProjectDiscovery({home:dir,cwd,roots:[],temporaryRoots:[],ignoreEnvironmentRoots:true});
  const node=startAgentNode({url:server.url,machineId,name:'合成工作区',token,dataDir:join(dir,'node'),executors:[],handlers:{'workspace.directory':workspace.handlers['workspace.directory']}});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await node.close();await server.close();await rm(dir,{recursive:true,force:true});});
  await expect.poll(()=>server.machines.list().some(m=>m.id===machineId&&m.online)).toBe(true);
  const project=await server.app.createProject({name:'合成发件项目',workspace:{machineId,cwd}});
  const page=await browser.newPage(),base=server.url+'/api/v1';
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#chat?token='+token);
  for(const isProject of [false,true]){
    const label=isProject?'项目':'主对话',route=isProject?'#projects/'+project.id+'/workspace':'#chat';
    const endpoint=base+(isProject?'/projects/'+project.id:'')+'/messages';
    await page.goto(server.url+'/'+route);
    const input=page.getByRole('textbox',{name:isProject?'项目目标':'给 Agent 的消息'});
    const send=page.getByRole('button',{name:isProject?'发送目标':'发送',exact:true});
    const region=page.getByRole('region',{name:'待确认发件'});
    const entry=(text:string)=>region.getByRole('article').filter({hasText:text});
    const tryFault=async(text:string,accepted:boolean)=>{
      await input.fill(text);
      let key='';
      await page.route(endpoint,async intercepted=>{
        key=intercepted.request().headers()['idempotency-key']!;
        if(accepted){
          const actual=await intercepted.fetch();
          assert.equal(actual.status(),202,await actual.text());
        }
        await intercepted.fulfill({status:503,json:{error:accepted?'合成回执传输失败，结果未知':'合成连接临时不可用'}});
      },{times:1});
      const failed=page.waitForResponse(r=>r.url()===endpoint && r.request().method()==='POST');
      await send.click();assert.equal((await failed).status(),503);assert.ok(key);
      await expect(entry(text)).toBeVisible();
      return key;
    };
    const oldText=label+'需要补发的旧消息',newText=label+'后写的新草稿';
    if(!isProject){
      // The main conversation's own file input. An independent conversation on the same page
      // has another one with the same label.
      await page.locator('#message-form').getByLabel('选择文件').setInputFiles({name:'旧消息资料.txt',mimeType:'text/plain',buffer:Buffer.from('原发件合成附件')});
      await expect(page.getByText('已上传',{exact:true})).toBeVisible();
    }
    const oldKey=await tryFault(oldText,false);
    assert.ok(!server.app.store.list<Message>('messages').some(m=>m.requestId===oldKey));
    if(!isProject) await page.getByRole('button',{name:/移除.*文件/}).click();
    await input.fill(newText);
    const elsewhere=isProject?'#chat':'#projects/'+project.id+'/workspace';
    await page.goto(server.url+'/'+elsewhere);
    await expect(page.getByRole('textbox',{name:isProject?'给 Agent 的消息':'项目目标'})).toBeVisible();
    await expect(entry(oldText)).toHaveCount(0);
    await page.goto(server.url+'/'+route);
    // Visiting a project updates the global project selector. Return to this submission's original scope.
    if(!isProject) await page.locator('#message-form').getByRole('combobox',{name:'项目范围',exact:true}).selectOption('');
    await page.reload();await expect(input).toHaveValue(newText);
    await expect(entry(oldText)).toBeVisible();
    if(!isProject){
      const plugin=base+'/plugins/conversation-outbox',headers={authorization:'Bearer '+token};
      assert.equal((await page.request.post(plugin,{headers,data:{enabled:false}})).status(),200);
      await expect(entry(oldText)).toBeHidden();await expect(input).toHaveValue(newText);
      assert.equal((await page.request.post(plugin,{headers,data:{enabled:true}})).status(),200);
      await expect(entry(oldText)).toBeVisible();
      const lookup=endpoint+'/receipts/'+oldKey;
      await page.route(lookup,r=>r.fulfill({status:404,json:{error:'合成范围不可见'}}),{times:1});
      const denied=page.waitForResponse(r=>r.url()===lookup);let submitted=false;
      const watch=(r:import('@playwright/test').Request)=>{if(r.method()==='POST' && r.url()===endpoint)submitted=true;};
      page.on('request',watch);
      await entry(oldText).getByRole('button',{name:'重新发送'}).click();assert.equal((await denied).status(),404);
      await expect(entry(oldText).getByRole('button',{name:'重新发送'})).toBeEnabled();
      page.off('request',watch);assert.equal(submitted,false);
      assert.ok(!server.app.store.list<Message>('messages').some(m=>m.requestId===oldKey));
    }
    const checked=page.waitForResponse(r=>r.url()===endpoint+'/receipts/'+oldKey);
    const posted=page.waitForResponse(r=>r.url()===endpoint && r.request().method()==='POST');
    await entry(oldText).getByRole('button',{name:'重新发送'}).click();
    const missing=await checked;assert.equal(missing.status(),404);assert.equal((await missing.json()).code,'MESSAGE_RECEIPT_NOT_FOUND');
    const repaired=await posted;assert.equal(repaired.status(),202,await repaired.text());
    assert.equal(repaired.request().headers()['idempotency-key'],oldKey);
    const msg=await repaired.json();assert.equal(msg.text,oldText);assert.equal(msg.requestId,oldKey);
    if(!isProject)assert.equal(msg.files[0].name,'旧消息资料.txt');
    await expect(entry(oldText)).toHaveCount(0);await expect(input).toHaveValue(newText);
    const unknown=label+'服务端已受理但回执丢失',knownKey=await tryFault(unknown,true);
    await input.fill(newText);await page.reload();
    const posts:string[]=[];
    const observe=(r:import('@playwright/test').Request)=>{if(r.url()===endpoint && r.method()==='POST')posts.push(r.postData()??'');};
    page.on('request',observe);
    const found=page.waitForResponse(r=>r.url()===endpoint+'/receipts/'+knownKey);
    await entry(unknown).getByRole('button',{name:'重新发送'}).click();
    assert.equal((await found).status(),200);await expect(entry(unknown)).toHaveCount(0);
    page.off('request',observe);assert.deepEqual(posts,[]);await expect(input).toHaveValue(newText);
    assert.equal(server.app.store.list<Message>('messages').filter(m=>m.requestId===knownKey).length,1);
    const remove=label+'仅从本标签页移除的记录',removeKey=await tryFault(remove,true);
    await entry(remove).getByRole('button',{name:'移除记录'}).click();
    await page.getByRole('dialog',{name:'移除发件记录'}).getByRole('button',{name:'移除记录',exact:true}).click();
    await expect(entry(remove)).toHaveCount(0);await page.reload();await expect(entry(remove)).toHaveCount(0);
    const receipt=await page.request.get(endpoint+'/receipts/'+removeKey,{headers:{authorization:'Bearer '+token}});
    assert.equal(receipt.status(),200);assert.equal((await receipt.json()).text,remove);
  }
});
