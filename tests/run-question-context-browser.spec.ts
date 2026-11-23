import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, {type TestContext} from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import type { Json, JsonObject, Run } from '../packages/protocol/src/index.ts';

async function openRunQuestion(t:TestContext, options:{reversible?:boolean;unknownReceipt?:boolean;externallyVisible?:boolean;modelUrl?:string}={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'run-question-context-web-'));
  const token='fixture-context';
  const server=await startServer({host:'127.0.0.1',port:0,demo:!options.modelUrl,dataDir,token,
    ...(options.modelUrl && {model:{provider:'openai-compatible',model:'delegated-fixture',apiKey:'fixture',baseUrl:options.modelUrl}})});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const {app}=server;
  const writes:JsonObject[]=[];
  const machineId='fixture-context-node';
  app.setMachineClient({
    list:()=>[{id:machineId,name:'合成执行机',online:true,platform:'linux',connectedAt:new Date().toISOString(),capabilities:['executor.start','executor.input'],
      executors:[{id:'codex',machineId,name:'内存替身',kind:'cli',mode:'real',available:true,description:'接收合成数据'}]}],
    async call(_machine,method,params):Promise<Json>{
      if(method==='executor.start') return {sessionId:'synthetic-session'};
      assert.equal(method,'executor.input');writes.push(params);return options.unknownReceipt ? {} : {requested:true};
    },
  });
  const todo=app.createTodo({title:'核对草稿顺序'});
  const run=app.dispatch({todoId:todo.id,prompt:'准备草稿',cwd:dataDir,executionMode:'interactive',executorId:machineId+'/codex'});
  await t.waitFor(()=>assert.ok(app.store.get<Run>('runs',run.id)?.sessionId));
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  const form=await page.request.post(server.url+'/api/v1/interactions',{headers:{Authorization:'Bearer '+token},
    data:{kind:'question',title:'草稿顺序',body:'选择排列方式',runId:run.id,reversible:options.reversible ?? true,externallyVisible:options.externallyVisible,deadline:'5m',
      questions:[{question:'排列方式',options:[{label:'按部门'},{label:'按日期'}],recommend:'按日期'}]}});
  assert.equal(form.status(),201,await form.text());
  const card=await form.json() as Card;
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#chat?token='+token);
  const row=page.locator('[data-id="interaction:'+card.id+'"]');
  return {app,page,row,card,writes};
}

test('原执行提问可先索要背景，刷新保留勾选及补充文字，并按最新版本手答', {timeout:40000},async t=>{
  const {app,page,row,card,writes}=await openRunQuestion(t);
  const chosen=row.getByLabel('按部门',{exact:true});
  const note=row.getByLabel('文字回答');
  const ask=row.getByRole('button',{name:'先告诉我背景',exact:true});
  await chosen.check();await note.fill('草稿先按部门排列');
  const path='/api/v1/interactions/'+card.id+'/context';
  await page.route('**'+path,route=>route.fulfill({status:503,json:{error:'合成暂不可用'}}),{times:1});
  await ask.click();
  await expect(row).toContainText('合成暂不可用');await expect(chosen).toBeChecked();
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  try {
    await page.route('**'+path,async route=>{
      const result=await route.fetch();
      await held;
      await route.fulfill({response:result});
    });
    const received=page.waitForResponse(res=>res.url().endsWith(path));
    await ask.click();
    await expect(row).toContainText('本轮截止默认选择已暂停');
    await expect(ask).toHaveCount(0);
    await expect(row).toContainText('执行目标：准备草稿');
    await expect(note).toBeEditable();
    await expect(chosen).toBeChecked();await expect(note).toHaveValue('草稿先按部门排列');
    app.interactions.expireTick(Date.parse(card.decisionDeadlineAt!)+1);
    assert.equal(writes.length,0);
    // Deliver the same persisted annotation that the supervisor's model would produce.
    const saved=app.store.get<Card>('interactions',card.id)!;
    app.store.put('interactions',card.id,{...saved,decisionExplanation:'本周草稿先用于部门内部核对。'});
    app.events.publish('interactions.changed',{id:card.id});
    await expect(row).toContainText('本周草稿先用于部门内部核对。');
    await expect(chosen).toBeChecked();await expect(note).toHaveValue('草稿先按部门排列');
    const answered=page.waitForResponse(res=>res.url().endsWith('/'+card.id+'/answer'));
    await row.getByRole('button',{name:'回答',exact:true}).click();
    const reply=await answered;
    assert.equal(reply.status(),200,await reply.text());
    assert.deepEqual(reply.request().postDataJSON(),{version:saved.version,answers:[{selected:['按部门'],text:'草稿先按部门排列'}]});
    assert.equal(writes.length,1);
    await expect(row).toHaveCount(0);
    release();
    const res=await received;
    assert.equal(res.status(),200,await res.text());
    assert.deepEqual(res.request().postDataJSON(),{version:card.version});
  } finally { release(); }
});

test('主人从原卡退回要求偏差，反馈可见，已填的选项不会送入执行会话', {timeout:40000},async t=>{
  const {app,page,row,card,writes}=await openRunQuestion(t);
  const reject=row.getByRole('button',{name:'这不是我要的',exact:true});
  await expect(reject).toHaveAttribute('title','退回原督办核对要求，暂停该执行的自动跟进');
  await row.getByLabel('按部门',{exact:true}).check();
  const path='/api/v1/interactions/'+card.id+'/mismatch';
  const received=page.waitForResponse(response=>response.request().method()==='POST' && response.url().endsWith(path));
  await reject.click();
  const res=await received;
  assert.equal(res.status(),200,await res.text());
  assert.deepEqual(res.request().postDataJSON(),{version:card.version});
  const result=await res.json();
  assert.equal(result.status,'withdrawn');assert.equal(result.withdrawnReason,'owner_mismatch');
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('status').filter({hasText:'已退回原督办核对要求，该执行的自动跟进已暂停。'})).toBeVisible();
  app.interactions.expireTick(Date.parse(card.decisionDeadlineAt!)+1);
  assert.equal(writes.length,0);
  assert.equal(app.store.get<Run>('runs',card.runId!)?.status,'running');
});

test('你来定须回到主人确认时，否保留原草稿，是按原推荐送入执行并显示实际回执', {timeout:60000},async t=>{
  for (const mode of ['decline','confirmed','unknown'] as const) await t.test(mode,async t=>{
    const {app,page,row,card,writes}=await openRunQuestion(t,{reversible:false,unknownReceipt:mode==='unknown'});
    const selected=row.getByLabel('按部门',{exact:true}),draft=row.getByLabel('文字回答');
    await selected.check();await draft.fill('我希望保留部门排序');
    const result=page.waitForResponse(res=>res.request().method()==='POST' && res.url().endsWith('/'+card.id+'/delegate'));
    await row.getByRole('button',{name:'你来定',exact:true}).click();
    const delegated=await result;
    assert.equal(delegated.status(),200,await delegated.text());
    assert.deepEqual(delegated.request().postDataJSON(),{version:card.version});
    const owner=await delegated.json();
    assert.equal(owner.status,'open');assert.ok(owner.ownerConfirmation);
    await expect(row).toContainText(owner.ownerConfirmation);
    await expect(row).toContainText('采用推荐前仍需你亲自确认');
    await expect(selected).toBeChecked();await expect(draft).toHaveValue('我希望保留部门排序');
    assert.equal(writes.length,0);
    const accept=mode!=='decline';
    const next=page.waitForResponse(res=>res.url().endsWith('/'+card.id+'/confirm-delegation') && res.request().method()==='POST');
    await row.getByRole('button',{name:accept?'是，采用列出的推荐':'否，我自己选',exact:true}).click();
    const receipt=await next;
    assert.equal(receipt.status(),200,await receipt.text());
    assert.deepEqual(receipt.request().postDataJSON(),{version:owner.version,accept});
    if(!accept) {
      await expect(row.getByRole('button',{name:'否，我自己选',exact:true})).toHaveCount(0);
      await expect(selected).toBeChecked();await expect(draft).toHaveValue('我希望保留部门排序');
      assert.equal(writes.length,0);
      const answered=page.waitForResponse(res=>res.url().endsWith('/'+card.id+'/answer') && res.request().method()==='POST');
      await row.getByRole('button',{name:'回答',exact:true}).click();
      const manual=await answered;
      assert.equal(manual.status(),200,await manual.text());
      assert.equal(manual.request().postDataJSON().version,(await receipt.json()).version);
      assert.deepEqual(manual.request().postDataJSON().answers,[{selected:['按部门'],text:'我希望保留部门排序'}]);
    } else {
      await expect(row).toHaveCount(0);
      const text=mode==='unknown'?'送达结果未知，请先核对回执。':'原执行会话已确认接收。';
      await expect(page.locator('.toast').filter({hasText:text})).toBeVisible();
      const stored=app.store.get<Card>('interactions',card.id)!;
      assert.equal(stored.delivery,mode);
      assert.deepEqual(stored.answers,[{selected:['按日期']}]);
    }
    assert.equal(writes.length,1);
  });
});

test('可逆决定缺可用模型时，Web 显示已暂停原截止并保留草稿供主人回答', {timeout:40000},async t=>{
  const {app,page,row,card,writes}=await openRunQuestion(t,{reversible:true,externallyVisible:false});
  const draft=row.getByLabel('文字回答');
  await draft.fill('先看部门的版本');
  const received=page.waitForResponse(res=>res.url().endsWith('/'+card.id+'/delegate') && res.request().method()==='POST');
  await row.getByRole('button',{name:'你来定',exact:true}).click();
  const res=await received;
  assert.equal(res.status(),200,await res.text());
  assert.equal((await res.json()).status,'open');
  await expect(row).toContainText('督办尚无可核实的选择');
  await expect(row).toContainText('截止默认选择已暂停');
  await expect(draft).toHaveValue('先看部门的版本');
  app.interactions.expireTick(Date.parse(card.decisionDeadlineAt!)+1);
  assert.equal(writes.length,0);
});

test('可逆委托的模型选择和依据从真实服务显示在 Web 回执中', {timeout:40000},async t=>{
  const assumption='内部草稿按部门核对更方便，排序随时可恢复。';
  const choice=JSON.stringify({action:'choose',answers:[{selected:['按部门']}],assumption});
  const model=createServer(async(req,res)=>{
    if(req.url!=='/v1/chat/completions') {res.writeHead(404).end();return;}
    for await(const _chunk of req) { /* Consume the local protocol request. */ }
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,finish_reason] of [[{role:'assistant',content:choice},null],[{},'stop']])
      res.write('data: '+JSON.stringify({id:'delegate',model:'delegated-fixture',created:1,object:'chat.completion.chunk',
        choices:[{index:0,delta,finish_reason}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));});
  const addr=model.address();assert.ok(addr && typeof addr==='object');
  const {page,row,card,writes}=await openRunQuestion(t,{modelUrl:'http://127.0.0.1:'+addr.port+'/v1',externallyVisible:false});
  const next=page.waitForResponse(res=>res.url().endsWith('/'+card.id+'/delegate') && res.request().method()==='POST');
  await row.getByRole('button',{name:'你来定',exact:true}).click();
  const res=await next;
  assert.equal(res.status(),200,await res.text());
  const receipt=await res.json();
  assert.equal(receipt.answeredBy,'supervisor_delegated');assert.equal(receipt.decisionAssumption,assumption);
  await expect(row).toHaveCount(0);
  const toast=page.locator('.toast').filter({hasText:'原执行会话已确认接收。'});
  await expect(toast).toContainText('排列方式：按部门');
  await expect(toast).toContainText(assumption);
  assert.equal(writes.length,1);assert.match(String(writes[0]!.text),/按部门/);
});
