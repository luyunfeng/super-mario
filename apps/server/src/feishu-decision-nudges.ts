import {createHash} from 'node:crypto';
import type {Store} from '../../../packages/plugin-sdk/src/index.ts';

/** A confirmed send receipt. The caller owns checks for the current owner, open decision and original platform card. */
export interface DecisionNudgeCard {
  botId:string;
  binding:string;
  decisionKey:string;
  messageId:string;
  sentAt:string;
}
type Outcome='sent'|'unknown'|'refused'|'retryable';
type Attempt={messageId:string;attempt:number;firstAt:number;state:'claimed'|Outcome};
type Policy={binding:string;minutes:number;skipSentBefore?:number};
type Sweep={botId:string;binding:string;afterMinutes?:number;quiet:boolean;cards:DecisionNudgeCard[]};
const minute=60000,day=24*60*minute;
const policies='feishu.nudge-policy',attempts='feishu.nudge-attempts';
const identifier=(value:string)=>typeof value==='string' && value.trim().length>0;
const minutesOf=(value?:number)=>value===undefined?60:value;

function keyFor(card:DecisionNudgeCard) {
  // Re-rendering a decision in another platform message must not create a second reminder.
  return 'nudge-'+createHash('sha256').update(JSON.stringify([card.botId,card.binding,card.decisionKey])).digest('hex').slice(0,32);
}

export function createDecisionNudges(store:Pick<Store,'get'|'put'|'transaction'>,now:()=>number=Date.now) {
  function eligible(card:DecisionNudgeCard,policy:Policy|undefined,after:number,quiet:boolean,time:number) {
    if(quiet!==false || !policy || policy.binding!==card.binding || policy.minutes!==after || after<=0 ||
      !identifier(card.botId) || !identifier(card.binding) || !identifier(card.decisionKey) || !identifier(card.messageId))return false;
    const sent=Date.parse(card.sentAt),age=time-sent-after*minute;
    if(!Number.isFinite(age) || age<0 || age>day || sent<=(policy.skipSentBefore ?? -Infinity))return false;
    const attempt=store.get<Attempt>(attempts,keyFor(card));
    return !attempt || attempt.state==='retryable' && attempt.messageId===card.messageId && attempt.attempt<3 &&
      time>=attempt.firstAt && time-attempt.firstAt<=60*minute;
  }

  function scan<T extends DecisionNudgeCard>(input:Omit<Sweep,'cards'>&{cards:T[]}):T[] {
    const after=minutesOf(input.afterMinutes),time=now();
    if(!identifier(input.botId) || !identifier(input.binding) || !Number.isSafeInteger(after) || after<0)return [];
    const policy=store.transaction(()=>{
      const previous=store.get<Policy>(policies,input.botId);
      if(previous?.binding===input.binding && previous.minutes===after)return previous;
      const next:Policy={binding:input.binding,minutes:after};
      if(previous?.binding===input.binding) {
        if(previous.skipSentBefore!==undefined)next.skipSentBefore=previous.skipSentBefore;
        // Persist even when no candidates were listed: a delayed or replayed receipt must obey the same boundary.
        if(previous.minutes===0 && after>0)next.skipSentBefore=Math.max(next.skipSentBefore ?? -Infinity,time-after*minute);
      }
      store.put(policies,input.botId,next);
      return next;
    });
    if(!after || input.quiet!==false)return [];
    const due=input.cards.filter(card=>card.botId===input.botId && card.binding===input.binding && eligible(card,policy,after,input.quiet,time))
      .sort((a,b)=>Date.parse(a.sentAt)-Date.parse(b.sentAt) || a.messageId.localeCompare(b.messageId));
    const seen=new Set<string>();
    return due.filter(card=>{if(seen.has(card.decisionKey))return false;seen.add(card.decisionKey);return true;});
  }

  function claim(card:DecisionNudgeCard,afterMinutes:number|undefined,quiet:boolean) {
    return store.transaction(()=>{
      const time=now(),key=keyFor(card);
      if(!eligible(card,store.get<Policy>(policies,card.botId),minutesOf(afterMinutes),quiet,time))return;
      const previous=store.get<Attempt>(attempts,key);
      const attempt=(previous?.attempt ?? 0)+1;
      // Claim before the external action. A crash or missing receipt cannot authorize a second send.
      store.put(attempts,key,{messageId:card.messageId,attempt,firstAt:previous?.firstAt ?? time,state:'claimed'} satisfies Attempt);
      return {key,attempt};
    });
  }

  function finish(card:DecisionNudgeCard,attempt:number,outcome:Outcome) {
    store.transaction(()=>{
      const key=keyFor(card),record=store.get<Attempt>(attempts,key);
      if(!record || record.messageId!==card.messageId || record.attempt!==attempt || record.state!=='claimed')return;
      store.put(attempts,key,{...record,state:outcome});
    });
  }
  return {scan,claim,finish};
}
