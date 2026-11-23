import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createInteractions, type Card } from '../packages/core/src/interactions.ts';
import { runQuestionReply } from '../packages/core/src/run-question-deadline.ts';

const input={kind:'question' as const,runId:'run',title:'排序草稿',body:'留作内部练习',deadline:'5m',reversible:true,externallyVisible:false,
  questions:[{question:'列',options:[{label:'日'},{label:'月'}],recommend:'日'},
    {question:'方向',options:[{label:'升'},{label:'降'}],recommend:'升'}]};
const valid={action:'choose',answers:[{selected:['月']},{selected:['降']}],assumption:'假设先看近期合计'};

test('委托只接受原选项、记录督办依据和送达回执；同卡重放不能发两次',async t=>{
  const store=createStore(':memory:');let calls=0;
  const sent:string[]=[];
  let resolve!:(x:unknown)=>void;
  const service=createInteractions({store,events:createEventBus(store),decide:()=>({handler:'user',layer:'default'}),deadlineOutcome:()=>'eligible',
    chooseDelegated:async()=>{calls++;return new Promise<unknown>(yes=>{resolve=yes;});},
    answer:async(card,text)=>{sent.push(runQuestionReply(card,text));}});
  t.after(async()=>{await service.close();store.close();});
  const card=service.open(input,false,true);
  const p=service.delegateDecision(card.id,card.version);
  const duplicate=service.delegateDecision(card.id,card.version);
  await Promise.resolve();assert.equal(calls,1);
  service.expireTick(Date.parse(card.expiresAt)+1);assert.deepEqual(sent,[]);
  resolve(valid);const done=await p;
  assert.deepEqual(await duplicate,done);assert.deepEqual(await service.delegateDecision(card.id,card.version),done);
  assert.equal(done.answeredBy,'supervisor_delegated');assert.equal(done.delivery,'confirmed');assert.equal(done.byDefault,undefined);
  assert.equal(done.decisionAssumption,valid.assumption);assert.deepEqual(done.answers,valid.answers);
  assert.equal(sent.length,1);assert.match(sent[0]!,/督办受委托/);assert.match(sent[0]!,/假设先看近期合计/);
});

test('不可逆、可能外部可见、可见性未登记的决定由主人确认，拒绝后可手答，原截止不再代选',async t=>{
  const store=createStore(':memory:');const sent:Card[]=[];
  const service=createInteractions({store,events:createEventBus(store),decide:()=>({handler:'user',layer:'default'}),deadlineOutcome:()=>'eligible',
    chooseDelegated:async()=>{throw new Error('不应使用模型');},answer:async card=>{sent.push(card);}});
  t.after(async()=>{await service.close();store.close();});
  for (const patch of [{externallyVisible:true},{externallyVisible:undefined},{reversible:false}]) {
    const card=service.open({...input,...patch},false,true);
    const confirm=await service.delegateDecision(card.id,card.version);
    assert.match(confirm.ownerConfirmation!,/是否采用/);assert.match(confirm.ownerConfirmation!,/方向 → 升/);
    assert.deepEqual(confirm.questions,card.questions);assert.equal(confirm.status,'open');
    assert.equal(sent.length,0);
    const denied=await service.confirmDelegation(card.id,confirm.version,false);
    assert.ok(denied.delegationRequestedAt);assert.equal(denied.ownerConfirmation,undefined);
    await assert.rejects(service.confirmDelegation(card.id,confirm.version,true),{status:409});
    assert.deepEqual(service.expireTick(Date.parse(card.expiresAt)+1),[]);
  }
  const card=service.open({...input,externallyVisible:true},false,true);
  assert.equal(card.reversible,false);
  service.expireTick(Date.parse(card.expiresAt)+1);assert.equal(sent.length,0);
  const ask=await service.delegateDecision(card.id,card.version);
  const answer=await service.confirmDelegation(card.id,ask.version,true,'user_feishu');
  assert.equal(answer.answeredBy,'user_feishu');assert.equal(answer.ownerConfirmation,undefined);
  assert.deepEqual(answer.answers,[{selected:['日']},{selected:['升']}]);
  assert.equal(sent.length,1);
});

test('模型失效、后台复核期间变化及发送前中断均保留人工决定，已领取且不确定不重发',async t=>{
  const store=createStore(':memory:'),sent:Card[]=[];
  let basis='目标一',held=false,choice:unknown={...valid,answers:[{selected:['伪造']},{selected:['升']}]};
  const service=createInteractions({store,events:createEventBus(store),decide:()=>({handler:'user',layer:'default'}),deadlineOutcome:()=>'eligible',defaultHeld:()=>held,delegationBasis:()=>basis,
    chooseDelegated:async()=>choice,answer:async card=>{sent.push(card);throw Object.assign(new Error('未获回执'),{delivery:'unknown'});}});
  t.after(async()=>{await service.close();store.close();});
  const card=service.open(input,false,true),invalid=await service.delegateDecision(card.id,card.version);
  assert.equal(invalid.status,'open');assert.match(invalid.error!,/原卡作答/);
  choice={action:'confirm'};
  const initial=service.open(input,false,true),unsafe=await service.delegateDecision(initial.id,initial.version);
  assert.ok(unsafe.ownerConfirmation);assert.equal(sent.length,0);
  choice=valid;
  const revised=service.open(input,false,true),oldBasis=service.delegateDecision(revised.id,revised.version);
  basis='目标二';assert.equal((await oldBasis).status,'open');assert.equal(sent.length,0);
  const later=service.open(input,false,true),pending=service.delegateDecision(later.id,later.version);
  held=true;
  await assert.rejects(pending,{status:409});assert.equal(sent.length,0);held=false;
  const last=service.open(input,false,true);const uncertain=await service.delegateDecision(last.id,last.version);
  assert.equal(uncertain.delivery,'unknown');assert.equal(sent.length,1);
  await service.delegateDecision(last.id,last.version);assert.equal(sent.length,1);
  // No effect exists at this simulated crash boundary; an already-running model decision cannot be reinstated.
  store.put('interactions',last.id,{...uncertain,error:undefined});
  service.recoverRunDefault(last.id,false);
  const reopened=store.get<Card>('interactions',last.id)!;
  assert.equal(reopened.status,'open');assert.equal(reopened.answers,undefined);assert.equal(reopened.decisionAssumption,undefined);
  assert.ok(reopened.delegationRequestedAt);assert.equal(sent.length,1);
});
