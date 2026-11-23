import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createInteractions, type Card } from '../packages/core/src/interactions.ts';
import { cardAcceptsAnswer, questionDeadline } from '../packages/core/src/question-deadline.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';

const input={kind:'question' as const,title:'审阅草稿',body:'',deadline:'2h',reversible:true,
  questions:['版本','顺序'].map(question=>({question,options:[{label:'甲'},{label:'乙'}],recommend:'乙'}))};

test('明确期限须有每题推荐、风险声明以及带时区时间或支持的时长',()=>{
  const now=Date.parse('2026-02-01T00:00:00Z');
  for (const [deadline,ms] of [['1m',60000],['+1h30m',5400000],['.5h',1800000],['720h',30*86400000],['2026-02-01T08:01:00+08:00',60000]] as const)
    assert.equal(Date.parse(questionDeadline({...input,deadline},now).decisionDeadlineAt!),now+ms);
  for (const deadline of ['59s','721h','2hfoo','2026-02-01T00:03:00','2026-02-30T00:00:00Z','2026-02-01T24:00:00Z'])
    assert.throws(()=>questionDeadline({...input,deadline},now));
  for (const patch of [{runId:'r'},{kind:'permission'},{questions:[]},{reversible:undefined},
      {questions:[{...input.questions[0]!,recommend:'其他'}]}])
    assert.throws(()=>questionDeadline({...input,...patch},now));
});

test('跨进程到期以 SQLite 裁决，早答、聊天、无授权和不可逆分别处理',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'deadline-'));
  const path=join(dir,'data.sqlite');
  const outcomes=new Map<string,'spoke'|'unverified'>();
  const defaults:string[]=[];
  function start() {
    const store=createStore(path),events=createEventBus(store);
    const svc=createInteractions({store,events,deadlineOutcome:card=>outcomes.get(card.id)??'eligible',
      decide:()=>({handler:'rules',layer:'default',mode:'auto',answer:'策略建议',deadlineAt:new Date(Date.now()+1000).toISOString()}),
      answer:async card=>{ if (card.byDefault) defaults.push(card.id); }});
    return {store,events,svc,read:(id:string)=>store.get<Card>('interactions',id)!,
      async close(){await svc.close();store.close();}};
  }
  let f=start();
  t.after(async()=>{await f.close();rmSync(dir,{force:true,recursive:true});});
  const normal=f.svc.open(input), early=f.svc.open(input), irreversible=f.svc.open({...input,reversible:false});
  const spoken=f.svc.open({...input,wait:false}),unverified=f.svc.open(input);
  outcomes.set(spoken.id,'spoke');outcomes.set(unverified.id,'unverified');
  assert.equal(normal.expiresAt,normal.decisionDeadlineAt);
  assert.equal(normal.handler,'user');
  assert.deepEqual(f.svc.expireTick(Date.now()+5000),[]);
  await f.svc.answer(early.id,early.version,[{selected:['甲']},{selected:['乙']}]);
  await f.close(); f=start();
  const due=Date.now()+3*3600000;
  assert.equal(f.svc.expireTick(due).length,4);
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.deepEqual(defaults,[normal.id]);
  const record=f.read(normal.id);
  assert.equal(record.answeredBy,'deadline_default');
  assert.equal(record.byDefault,true);
  assert.equal(record.delivery,'confirmed');
  assert.deepEqual(record.answers,[{selected:['乙']},{selected:['乙']}]);
  assert.equal(f.read(early.id).answeredBy,'user');
  assert.equal(f.read(spoken.id).status,'expired');
  assert.equal(f.read(spoken.id).byDefault,undefined);
  for(const id of [irreversible.id,unverified.id]) {
    const c=f.read(id);
    assert.equal(c.deadlineRemindedAt,new Date(due).toISOString());assert.equal(c.status,'open');
    assert.equal(c.version,1);assert.equal(cardAcceptsAnswer(c,due+60000),true);
  }
  await f.close();f=start();
  assert.deepEqual(f.svc.expireTick(due+60000),[]);
  assert.equal(f.events.since(0).filter(e=>e.type==='interactions.deadline_overdue').length,2);
  assert.deepEqual(defaults,[normal.id]);
  // The real form remains usable after the clock passes its cutoff.
  const past=new Date(Date.now()-60000).toISOString();
  f.store.put('interactions',irreversible.id,{...f.read(irreversible.id),decisionDeadlineAt:past,expiresAt:past});
  const manual=await f.svc.answer(irreversible.id,irreversible.version,[{selected:['甲']},{selected:['甲']}]);
  assert.equal(manual.answeredBy,'user');assert.equal(manual.byDefault,undefined);
  const last=f.svc.open(input);
  f.store.put('interactions',last.id,{...last,expiresAt:past,decisionDeadlineAt:past});
  assert.throws(()=>f.svc.answer(last.id,last.version,[{selected:['甲']},{selected:['甲']}]),{status:409});
  assert.equal(f.read(last.id).byDefault,true);
  const whenSpoke=f.svc.open(input);
  f.store.put('interactions',whenSpoke.id,{...whenSpoke,expiresAt:past,decisionDeadlineAt:past});
  assert.equal(f.svc.withdraw(whenSpoke.id,whenSpoke.version,'user_spoke').byDefault,true);
});
