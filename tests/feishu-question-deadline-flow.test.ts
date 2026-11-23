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

test('不可逆截止只提醒原飞书表单一次，过期导航和重启后原卡仍可明确答复',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-feishu-deadline-'));
  const clients=new Map<string,FeishuOptions>();
  const sent:{id:string;appId:string;target:string;text:string;replyTo?:string;card:any}[]=[];
  const start=()=>startServer({host:'127.0.0.1',port:0,demo:true,dataDir},{botFactory:opts=>{
    clients.set(opts.appId,opts);
    return {async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),
      async send(target,text,ctx){const id=randomUUID(); ctx?.beforeSend?.(); sent.push({id,appId:opts.appId,target,text,replyTo:ctx?.replyTo,card:ctx?.card});ctx?.onSent?.(id,ctx.card?'interactive':'text');}};
  }});
  let server=await start();
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const owner='ou_fixture',chatId='oc_private';
  async function pair(appId:string) {
    const bot=await server.bots.create({appId,appSecret:'synthetic-key',name:'合成私聊',scope:{kind:'global'},requireConfirmation:false});
    const speak=(text:string)=>clients.get(appId)!.onMessage(text,{messageId:randomUUID(),chatId,senderId:owner,chatType:'p2p',senderType:'user'});
    await speak(bot.pairingCode!);
    return {bot,speak};
  }
  const a='cli_1212121212121212',b='cli_1313131313131313';
  const {bot,speak}=await pair(a); const other=await pair(b);
  await speak('/new 合成私聊目标');
  server.app.policies.write({}, {ladder:['user']});
  const original=server.app.store.list<Message>('messages').find(row=>row.text==='合成私聊目标' && row.role==='user')!;
  await t.waitFor(()=>assert.ok(server.app.store.get('message.routes',original.id)),{timeout:10000});
  const question=server.app.interactions.open({kind:'question',title:'合成截止决定',body:'明确选择。',deadline:'2m',reversible:false,
    questions:[{question:'用哪种格式？',options:[{label:'CSV'},{label:'JSON'}],recommend:'CSV'}]},original);
  const forms=()=>sent.filter(row=>row.card && JSON.stringify(row.card).includes(question.id));
  await t.waitFor(()=>assert.equal(forms().length,1,JSON.stringify(server.app.mailboxes.list().map(row=>({title:row.title,status:row.status,error:row.error})))),{timeout:15000});
  const form=forms()[0]; const controls=form.card.body.elements;
  assert.match(JSON.stringify(controls),/北京时间/);
  assert.match(JSON.stringify(controls),/CSV（推荐）/);
  assert.doesNotMatch(JSON.stringify(controls),/initial_option|selected_values/);
  const pick=controls.find((el:any)=>el.text?.content==='JSON').behaviors[0].value;
  // Advance only this persisted question's deadline so the callback also sees an elapsed wall-clock deadline.
  const elapsed = new Date(Date.now()-1000).toISOString();
  const prior = server.app.store.get<Card>('interactions',question.id)!;
  server.app.store.put('interactions',question.id,{...prior,expiresAt:elapsed,decisionDeadlineAt:elapsed});
  server.app.interactions.expireTick(Date.now());
  const notices=()=>sent.filter(row=>row.text.includes('提问已到截止时间'));
  await t.waitFor(()=>assert.equal(notices().length,1),{timeout:10000});
  assert.equal(notices()[0].appId,a);assert.equal(notices()[0].target,chatId);assert.equal(notices()[0].replyTo,form.id);
  assert.match(notices()[0].text,/仍需你在原卡回答/);
  await server.close();server=await start();
  await server.bots.sweepDecisionNudges(bot.id);
  assert.equal(notices().length,1);
  server.app.store.remove('feishu.card.navigation',pick.navigation);
  const click=(appId:string,id:string)=>clients.get(appId)!.onCardAction!({operatorId:owner,chatId,messageId:id,value:pick}) as any;
  assert.doesNotMatch(JSON.stringify(click(b,form.id)),/正在提交/);
  assert.doesNotMatch(JSON.stringify(click(a,randomUUID())),/正在提交/);
  assert.match(click(a,form.id).toast.content,/正在提交/);
  await t.waitFor(()=>assert.equal(server.app.store.get<Card>('interactions',question.id)?.delivery,'confirmed'));
  assert.deepEqual(server.app.store.get<Card>('interactions',question.id)?.answers,[{selected:['JSON']}]);
  assert.equal(forms().length,1);

  const ordinary=server.app.interactions.open({kind:'question',title:'旧式私聊等待问题的唯一标记',body:'由原配对回答'},original);
  await t.waitFor(()=>assert.ok(sent.some(x=>x.appId===a && JSON.stringify(x.card??{}).includes(ordinary.id))),{timeout:10000});
  const project=server.app.projects.create({name:'合成卡片可见项目'});
  const res=await fetch(server.url+'/api/v1/projects/'+project.id+'/messages',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({text:'项目 Web 的合成请求'})});
  assert.equal(res.status,202);
  const web=server.app.interactions.open({kind:'question',title:'项目 Web 可见项',body:'项目待核对'},await res.json() as Message);
  async function questions() {
    await other.speak('/home');
    const home=sent.filter(x=>x.appId===b && x.card?.elements).at(-1)!;
    const nav=home.card.elements.flatMap((el:any)=>el.actions??[]).find((button:any)=>button.value?.kind==='workbench.navigate').value.navigation;
    const open=clients.get(b)!.onCardAction!({operatorId:owner,chatId,messageId:home.id,value:{kind:'workbench.navigate',view:'questions',page:0,navigation:nav}});
    return JSON.stringify(open);
  }
  const dashboard=await questions();
  assert.ok(dashboard.includes(web.title));
  assert.ok(!dashboard.includes(ordinary.title));
  server.app.projects.archive(project.id);
  assert.ok(!(await questions()).includes(web.title));
});
