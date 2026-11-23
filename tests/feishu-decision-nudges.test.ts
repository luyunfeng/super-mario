import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../packages/core/src/store.ts';
import {createDecisionNudges,type DecisionNudgeCard} from '../apps/server/src/feishu-decision-nudges.ts';

const minute=60000,begin=Date.parse('2026-01-01T00:00:00Z');
const card=(decisionKey:string,at=begin):DecisionNudgeCard=>({botId:'bot',binding:'bound-A',decisionKey,messageId:'om_'+decisionKey,sentAt:new Date(at).toISOString()});
async function rig(t:test.TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'sm-nudge-')),file=join(dir,'test.db');
  let db=createStore(file),time=begin,ledger=createDecisionNudges(db,()=>time);
  t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
  return {get ledger(){return ledger;},set:(minutes:number)=>{time=begin+minute*minutes;},
    restart(){db.close();db=createStore(file);ledger=createDecisionNudges(db,()=>time);},
    scan:(cards:DecisionNudgeCard[],afterMinutes:number|undefined=undefined,quiet=false,binding='bound-A')=>
      ledger.scan({botId:'bot',binding,cards,afterMinutes,quiet})};
}

test('从原卡确认后默认60分钟，静默保留，先认领先持久化，重启或迟到回执不致重复',async t=>{
  const r=await rig(t),a=card('a'),b=card('b',begin+minute),c=card('c');
  r.set(59);assert.deepEqual(r.scan([b,a]),[]);r.set(61);
  assert.deepEqual(r.scan([a,b],undefined,true),[]);assert.equal(r.ledger.claim(a,undefined,true),undefined);
  assert.deepEqual(r.scan([b,a,a]),[a,b]);const first=r.ledger.claim(a,undefined,false)!;assert.equal(first.attempt,1);
  assert.equal(r.ledger.claim(a,undefined,false),undefined);
  r.restart();assert.deepEqual(r.scan([b,a]),[b]);
  r.ledger.finish(a,1,'unknown');assert.deepEqual(r.scan([a]),[]);
  r.ledger.finish(a,1,'retryable');assert.equal(r.ledger.claim(a,60,false),undefined);
  const claim=r.ledger.claim(b,60,false)!;r.ledger.finish(b,claim.attempt,'sent');
  assert.deepEqual(r.scan([{...b,messageId:'om_edits'}]),[]);
  r.set(60+24*60+1);assert.deepEqual(r.scan([c]),[]);
});

test('关闭再开启跳过此前已过阈值的原卡，静默中设置生效并可重启，不同绑定不能认领旧卡',async t=>{
  const r=await rig(t),a=card('old'),b=card('later',begin+minute*40);
  assert.deepEqual(r.scan([],0),[]);r.set(65);assert.deepEqual(r.scan([],60,true),[]);
  r.restart();r.set(120);assert.deepEqual(r.scan([a,b],60),[b]);
  r.scan([],60,false,'bound-B');assert.equal(r.ledger.claim(b,60,false),undefined);
  const rebound={...a,binding:'bound-B',messageId:'om_new'};
  assert.deepEqual(r.scan([a,b,rebound],60,false,'bound-B'),[rebound]);
  const attempt=r.ledger.claim(rebound,60,false)!;r.ledger.finish(a,attempt.attempt,'retryable');
  assert.deepEqual(r.scan([rebound],60,false,'bound-B'),[]);
});

test('只有确认未发送的临时故障可重试，同键最多三次且不超过首尝试后一小时',async t=>{
  const r=await rig(t),a=card('a'),b=card('b'),c=card('c');
  r.set(60);r.scan([a,b,c]);const start=r.ledger.claim(a,60,false)!;r.ledger.finish(a,1,'retryable');
  r.ledger.finish(b,1,'retryable');const bClaim=r.ledger.claim(b,60,false)!;r.ledger.finish(b,bClaim.attempt,'retryable');
  const cClaim=r.ledger.claim(c,60,false)!;r.ledger.finish(c,cClaim.attempt,'refused');
  r.restart();r.set(65);const next=r.ledger.claim(a,60,false)!;assert.equal(next.attempt,2);assert.equal(next.key,start.key);
  r.ledger.finish(a,1,'sent');r.ledger.finish(a,2,'retryable');
  r.set(120);const third=r.ledger.claim(a,60,false)!;assert.equal(third.attempt,3);assert.equal(third.key,start.key);
  r.ledger.finish(a,3,'retryable');r.set(121);assert.deepEqual(r.scan([a,b,c]),[]);
});
