import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createPolicies } from '../packages/core/src/policies.ts';
import { createInteractions } from '../packages/core/src/interactions.ts';
const input = {kind:'question' as const,title:'核对执行目录',body:'请选择已知目录'};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {let resolve!:(text:string)=>void;const promise=new Promise<string>(done=>{resolve=done});return {promise,resolve};}

test('timeout moves supervisor to main Agent then user without expiring the card or accepting a late auto answer', async () => {
  const store=createStore(':memory:');const events=createEventBus(store);const policies=createPolicies({store,events});
  policies.write({}, {agentModes:{supervisor:'auto',main_agent:'auto'},escalateAfterMinutes:1,userDeadlineMinutes:15});
  const first=deferred(),second=deferred();const calls:string[]=[];let writes=0;
  const service=createInteractions({store,events,decide:card=>{const d=policies.decide(card);return {...d,layer:d.layer==='run'?'task':d.layer,answer:d.answer??undefined,ruleId:d.ruleId??undefined}},answer:async()=>{writes++},askAgent:async handler=>{calls.push(handler);return handler==='supervisor'?first.promise:second.promise}});
  try {
    const opened=service.open(input);await tick();assert.deepEqual(calls,['supervisor']);
    service.expireTick(Date.parse(opened.stageDueAt!));await tick();
    let card=service.list()[0];assert.equal(card.status,'open');assert.equal(card.handler,'main_agent');assert.deepEqual(calls,['supervisor','main_agent']);
    first.resolve('late automatic answer');await tick();assert.equal(writes,0);
    service.expireTick(Date.parse(card.stageDueAt!));await tick();card=service.list()[0];
    assert.equal(card.handler,'user');assert.equal(card.status,'open');assert.equal(card.routingHistory!.length,2);
    assert.equal(events.since(0).filter(event=>event.type==='interactions.user_required').length,1);
    second.resolve('also late');await tick();assert.equal(writes,0);
    await service.answer(card.id,card.version,'confirmed by user');assert.equal(writes,1);
    assert.equal(service.list()[0].answeredBy,'user');
  } finally {first.resolve('cleanup');second.resolve('cleanup');await service.close();store.close();}
});

test('a valid suggestion goes directly to user, while a failed stage advances to the next configured actor', async () => {
  const store=createStore(':memory:');const events=createEventBus(store);const policies=createPolicies({store,events});const calls:string[]=[];
  const service=createInteractions({store,events,decide:card=>{const d=policies.decide(card);return {...d,layer:d.layer==='run'?'task':d.layer,answer:d.answer??undefined,ruleId:d.ruleId??undefined}},answer:async()=>{throw new Error('suggestions must not write')},askAgent:async handler=>{calls.push(handler);if(handler==='supervisor')throw new Error('model unavailable');return 'a checked suggestion'}});
  try {
    service.open(input);await tick();await tick();const card=service.list()[0];
    assert.deepEqual(calls,['supervisor','main_agent']);assert.equal(card.handler,'user');assert.equal(card.status,'open');assert.equal(card.suggestion,'a checked suggestion');
    assert.deepEqual(card.routingHistory!.map(step=>step.outcome),['error','suggested']);
  } finally {await service.close();store.close();}
});

test('global user deadline is distinct from stage timeout and default permission never invokes a model', async () => {
  const store=createStore(':memory:');const events=createEventBus(store);const policies=createPolicies({store,events});let asks=0;
  const service=createInteractions({store,events,decide:card=>{const d=policies.decide(card);return {...d,layer:d.layer==='run'?'task':d.layer,answer:d.answer??undefined,ruleId:d.ruleId??undefined}},answer:async()=>{},askAgent:async()=>{asks++;return 'never'}});
  try {
    const card=service.open({...input,kind:'permission'});await tick();assert.equal(asks,0);assert.equal(card.handler,'user');
    assert.equal(Date.parse(card.expiresAt)-Date.parse(card.createdAt),15*60000);
    service.expireTick(Date.parse(card.expiresAt));assert.equal(service.list()[0].status,'expired');
  } finally {await service.close();store.close();}
});

test('delivery confirmation preserves notification facts recorded after the answer claim', async () => {
  const store=createStore(':memory:');const events=createEventBus(store);
  const service=createInteractions({store,events,decide:()=>({handler:'user',layer:'default'}),answer:async()=>{}});
  const off=events.subscribe(event=>{if(event.type!=='interactions.changed')return;const id=(event.data as {id:string}).id;const current=store.get<any>('interactions',id);if(current?.status==='answered'&&!current.userNotifiedAt)store.put('interactions',id,{...current,userNotifiedAt:'recorded-after-claim'})});
  try {const card=service.open(input);const answered=await service.answer(card.id,card.version,'yes');assert.equal(answered.userNotifiedAt,'recorded-after-claim');}
  finally {await off();await service.close();store.close();}
});
