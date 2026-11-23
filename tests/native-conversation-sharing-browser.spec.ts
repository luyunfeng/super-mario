import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import {startAgentNode} from '../apps/agent-node/src/index.ts';
import {createCliSessionDiscovery} from '../plugins/cli-session-discovery.ts';

test('从 Agent 原生会话分享选中的正文，匿名端隐藏来源与其他消息，撤销立即生效', {timeout:35000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-native-share-'));
  const home=join(dir,'home'),cwd=join(home,'code','private-fixture');
  const machineId='synthetic-private-machine',sessionId='synthetic-private-session',token='synthetic-owner-share';
  const log=join(home,'.codex/sessions',sessionId+'.jsonl');
  await mkdir(cwd,{recursive:true});await mkdir(dirname(log),{recursive:true});
  const selected='合成可公开的验收结论',other='合成未选中的主人发言';
  const tool='fixture_native_lookup',params='合成私密查询参数',output='合成私密原始结果',call='private-synthetic-call';
  await writeFile(log,[
    {type:'session_meta',payload:{id:sessionId,cwd}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:other}]}},
    {type:'response_item',payload:{type:'function_call',name:tool,call_id:call,arguments:JSON.stringify({query:params})}},
    {type:'response_item',payload:{type:'function_call_output',call_id:call,output}},
    {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:selected}]}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'合成第二轮问题'}]}},
    {type:'response_item',payload:{type:'function_call',name:'fixture_other_turn',call_id:'other-synthetic-call',arguments:'{}'}},
    {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'合成第二轮回复'}]}},
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const server=await startServer({dataDir:join(dir,'data'),host:'127.0.0.1',port:0,demo:true,token});
  const history=createCliSessionDiscovery({home,cwd,temporaryRoots:[]});
  const node=startAgentNode({url:server.url,token,machineId,name:'合成只读电脑',dataDir:join(dir,'node'),handlers:history.handlers,executors:[]});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  t.after(async()=>{await browser?.close();await node.close();await server.close();await rm(dir,{recursive:true,force:true});});
  await expect.poll(()=>server.machines.list().some(row=>row.id===machineId && row.online)).toBe(true);
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const owner=await browser.newPage();await owner.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await owner.goto(server.url+'/#agent?token='+token);
  const card=owner.locator('#agent-cli-sessions [data-cli-session]').filter({hasText:sessionId});
  await card.getByRole('button',{name:'分享对话摘录',exact:true}).click();
  const share=owner.getByRole('dialog',{name:'分享对话摘录',exact:true});
  await expect(share).toBeVisible();await expect(share).toContainText(selected);
  await share.getByRole('checkbox',{name:new RegExp(selected)}).check();
  const includeTools=share.getByRole('checkbox',{name:'包含工具记录',exact:true});
  await expect(includeTools).not.toBeChecked();
  const showPreview=share.getByRole('button',{name:'预览公开内容',exact:true});
  await showPreview.click();
  const preview=share.getByRole('region',{name:'公开内容预览',exact:true});
  await expect(preview).toContainText(selected);await expect(preview).not.toContainText(other);
  const previewTools=preview.getByRole('region',{name:'工具记录'});
  await expect(previewTools).toHaveCount(0);
  await includeTools.check();await showPreview.click();
  const toolLabel=tool+' · 已返回结果';
  await expect(previewTools).toHaveText(toolLabel);
  const hidden=[other,cwd,machineId,sessionId,token,params,output,call,'fixture_other_turn','合成第二轮回复'];
  for(const value of hidden) assert.ok(!(await preview.textContent())?.includes(value));
  await share.getByRole('button',{name:'确认创建分享',exact:true}).click();
  const link=await share.getByRole('textbox',{name:'分享链接',exact:true}).inputValue();
  const reader=await browser.newPage();
  const load=reader.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/public/conversation-share');
  await reader.goto(link);
  const response=await load;assert.equal(response.status(),200);
  const published=await response.json();
  assert.deepEqual(published.messages,[{role:'assistant',text:selected,tools:[{name:tool,status:'returned'}]}]);
  for(const privateValue of hidden) assert.ok(!JSON.stringify(published).includes(privateValue));
  const messages=reader.getByRole('list',{name:'分享的消息'});
  await expect(messages.locator('li > p')).toHaveText([selected]);
  const publishedTools=messages.getByRole('region',{name:'工具记录'});
  await expect(publishedTools).toHaveText(toolLabel);
  const visible=await reader.locator('body').innerText();
  for(const privateValue of hidden) assert.ok(!visible.includes(privateValue));
  await node.close();
  await expect.poll(()=>server.machines.list().some(row=>row.id===machineId && row.online)).toBe(false);
  await owner.reload();
  await owner.getByRole('button',{name:'已分享的原生会话',exact:true}).click();
  await owner.getByRole('button',{name:'管理分享',exact:true}).click();
  await reader.reload();
  await expect(messages.locator('li > p')).toHaveText([selected]);
  await expect(publishedTools).toHaveText(toolLabel);
  await share.getByRole('button',{name:'修改分享',exact:true}).click();
  await expect(includeTools).toBeChecked();await includeTools.uncheck();
  await showPreview.click();await expect(preview).toContainText(selected);
  await expect(previewTools).toHaveCount(0);
  const update=owner.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/conversation-shares' && r.request().postDataJSON().action==='update' && r.ok());
  await share.getByRole('button',{name:'确认更新分享',exact:true}).click();await update;
  const updated=reader.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/public/conversation-share');
  await reader.reload();
  assert.deepEqual((await (await updated).json()).messages,[{role:'assistant',text:selected}]);
  await expect(reader).toHaveURL(link);
  await expect(messages.locator('li > p')).toHaveText([selected]);
  await expect(publishedTools).toHaveCount(0);
  await share.getByRole('button',{name:'撤销分享',exact:true}).click();
  const revoke=owner.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/conversation-shares' && r.request().postDataJSON().action==='revoke' && r.ok());
  await owner.getByRole('button',{name:'确认撤销',exact:true}).click();await revoke;
  await reader.reload();
  await expect(reader.getByRole('status')).toContainText('无法读取');
  await expect(messages.getByRole('listitem')).toHaveCount(0);
});
