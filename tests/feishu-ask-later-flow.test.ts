import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('飞书稍后回答卡跨重启可用，聊天不答卡，切换会话后回答仍送回原私聊线程', async t => {
  const dataDir = await mkdtemp(join(tmpdir(),'mario-feishu-ask-later-'));
  const clients = new Map<string,FeishuOptions>();
  const deliveries: {appId:string;id:string;target:string;card:any;text:string}[] = [];
  const start = () => startServer({dataDir,host:'127.0.0.1',port:0,demo:true},{botFactory:options => {
    clients.set(options.appId,options);
    return {async start(){}, async close(){}, async collect(){return [];},status:()=>({connected:true}),
      async send(target,text,ctx) {
        const id = 'om-'+randomUUID();
        deliveries.push({appId:options.appId,id,target,text,card:ctx?.card});
        ctx?.onSent?.(id,ctx.card ? 'interactive' : 'text');
      }};
  }});
  let server = await start();
  t.after(async()=>{await server.close(); await rm(dataDir,{recursive:true,force:true});});
  const account = 'cli_1212121212121212', secondary = 'cli_1313131313131313';
  const owner = 'ou_test', chat = 'oc_private';
  const speak = (text:string, appId=account, id:string=randomUUID()) => clients.get(appId)!.onMessage(text,{messageId:id,chatId:chat,senderId:owner,chatType:'p2p',senderType:'user'});
  const click = (value:Record<string,unknown>,messageId:string,formValue?:Record<string,unknown>,appId=account) =>
    clients.get(appId)!.onCardAction!({operatorId:owner,chatId:chat,messageId,value,formValue}) as any;
  const buttons = (card:any) => card.elements.flatMap((el:any)=>el.actions??[]);
  const create = (appId:string) => server.bots.create({appId,appSecret:'synthetic-test-secret',name:'合成私聊',scope:{kind:'global'},requireConfirmation:false});
  const bot = await create(account);
  await speak(bot.pairingCode!);
  const originalText = '合成独立线程的原始目标';
  await speak('/new '+originalText);
  const original = server.app.store.list<Message>('messages').find(m=>m.role==='user' && m.text===originalText)!;
  assert.match(original.conversationId,/:thread:/);
  server.app.policies.write({}, {ladder:['user']});
  const card = server.app.interactions.open({kind:'question',title:'仅原配对可见的合成题',body:'合成选项',wait:false},original);
  const stored = () => server.app.store.get<Card>('interactions',card.id)!;
  const isForm = (x: typeof deliveries[number]) => x.card?.body?.elements?.some((row:any)=>row.name==='answer_question') &&
    JSON.stringify(x.card).includes(card.id);
  await t.waitFor(()=>assert.ok(deliveries.some(isForm)));
  const form = deliveries.find(isForm)!;
  assert.match(JSON.stringify(form.card),/可稍后回答|可以继续在原对话聊天/);
  const submit = form.card.body.elements.find((row:any)=>row.tag==='form').elements.at(-1).behaviors[0].value;
  await speak('我还要补充别的事');
  await speak('/main');
  assert.equal(stored().status,'open');
  assert.equal(stored().answer,undefined);

  // Even an independently paired global bot for the same synthetic user cannot read the private question.
  const second = await create(secondary);
  await speak(second.pairingCode!,secondary);
  await speak('/home',secondary);
  const otherHome = deliveries.filter(row=>row.appId===secondary).at(-1)!;
  assert.doesNotMatch(JSON.stringify(otherHome.card),/仅原配对可见的合成题/);
  const nav = buttons(otherHome.card).find((b:any)=>b.value?.kind==='workbench.navigate').value.navigation;
  const otherList = click({kind:'workbench.navigate',view:'questions',page:0,navigation:nav},otherHome.id,undefined,secondary);
  assert.doesNotMatch(JSON.stringify(otherList),/仅原配对可见的合成题/);
  assert.doesNotMatch(JSON.stringify(click(submit,form.id,{answer:'冒充答案'},secondary)),/正在提交/);
  assert.equal(stored().status,'open');

  await server.close();
  server = await start();
  await speak('保持主会话选中');
  const reply = '这才是明确回答';
  assert.match(click(submit,form.id,{answer:reply}).toast.content,/正在提交/);
  await t.waitFor(()=>assert.equal(stored().delivery,'confirmed'));
  const continuationId = server.app.store.get<{continuationId:string}>('interaction-origins',card.id)!.continuationId;
  const next = server.app.store.get<Message>('messages',continuationId)!;
  assert.equal(next.conversationId,original.conversationId);
  assert.match(next.text,/这才是明确回答/);
  const route = server.app.store.get<{botId:string;target:string;sourceMessageId:string}>('message.routes',next.id)!;
  assert.equal(route.botId,bot.id);
  assert.equal(route.target,chat);
  assert.deepEqual(route.sourceMessageId,server.app.store.get<{sourceMessageId:string}>('message.routes',original.id)?.sourceMessageId);
  assert.equal(stored().answeredBy,'user_feishu');
  assert.doesNotMatch(JSON.stringify(click(submit,form.id,{answer:'重复'})),/正在提交/);
  assert.equal(deliveries.filter(isForm).length,1);

  const closeCard = server.app.interactions.open({kind:'question',title:'仅在原线程关闭',body:'不需要作答',wait:false},original);
  const itsForm = (id:string) => deliveries.find(x => x.card?.body?.elements && JSON.stringify(x.card).includes(id));
  await t.waitFor(()=>assert.ok(itsForm(closeCard.id)));
  const closeForm = itsForm(closeCard.id)!;
  const close = closeForm.card.body.elements.find((el:any)=>el.text?.content==='关闭提问').behaviors[0].value;
  assert.doesNotMatch(JSON.stringify(click(close,form.id)),/提问已关闭/);
  assert.match(click(close,closeForm.id).toast.content,/已关闭，未提交答案/);
  await t.waitFor(()=>assert.ok(server.app.store.get<{continuationId?:string}>('interaction-origins',closeCard.id)?.continuationId));
  const closedId = server.app.store.get<{continuationId:string}>('interaction-origins',closeCard.id)!.continuationId;
  const receipt = server.app.store.get<Message>('messages',closedId)!;
  assert.equal(receipt.conversationId,original.conversationId);
  assert.equal(receipt.readOnly,true);
  assert.match(receipt.text,/未提供答案/);
  assert.equal(server.app.store.get<Card>('interactions',closeCard.id)?.answer,undefined);

  const stale = server.app.interactions.open({kind:'question',title:'旧配对独有的标识',body:'不能交给新受众',wait:false},original);
  await t.waitFor(()=>assert.ok(itsForm(stale.id)));
  const staleForm = itsForm(stale.id)!;
  const staleClose = staleForm.card.body.elements.find((el:any)=>el.text?.content==='关闭提问').behaviors[0].value;
  const newAccount = 'cli_1414141414141414';
  const rebound = await server.bots.update(bot.id,{appId:newAccount,appSecret:'synthetic-new-secret'});
  await speak(rebound.pairingCode!,newAccount);
  await speak('/home',newAccount);
  const home = deliveries.filter(row=>row.appId===newAccount).at(-1)!;
  assert.doesNotMatch(JSON.stringify(home.card),/旧配对独有的标识/);
  const reboundNav = buttons(home.card).find((b:any)=>b.value?.kind==='workbench.navigate').value.navigation;
  const reboundList = click({kind:'workbench.navigate',view:'questions',page:0,navigation:reboundNav},home.id,undefined,newAccount);
  assert.doesNotMatch(JSON.stringify(reboundList),/旧配对独有的标识/);
  await speak('/today',newAccount);
  await t.waitFor(()=>assert.match(deliveries.filter(row=>row.appId===newAccount).at(-1)!.text,/今日简报/));
  assert.doesNotMatch(deliveries.filter(row=>row.appId===newAccount).at(-1)!.text,/旧配对独有的标识/);
  click(staleClose,staleForm.id,undefined,newAccount);
  assert.equal(server.app.store.get<Card>('interactions',stale.id)?.status,'open');
});
