import type {InboxFallbackInput,InboxFallbackPlan} from '../packages/protocol/src/index.ts';

const twoHours=2*60*60*1000;

/** The host supplies one verified conversation and its eligible matters. Titles and bodies are not evidence. */
export function groupFeishuInbox(input:InboxFallbackInput):InboxFallbackPlan {
  const candidates=new Set(input.existing.map(matter=>matter.id));
  const messages=new Map(input.messages.map(message=>[message.id,message]));
  const compareId=(a:string,b:string)=>a===b ? 0 : a<b ? -1 : 1;
  const ordered=[...messages.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at) || compareId(a.id,b.id));
  const existing=[...input.existing].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at) || compareId(b.id,a.id));
  const now=Date.parse(input.now);
  const recent=input.kind==='direct' && existing.find(matter=>{
    const at=Date.parse(matter.at);
    return at>=now-twoHours && at<=now;
  });

  // Follow only explicit reply edges, including parents arriving later in this batch.
  // A corrupt loop cannot prove any of its members belongs to another member's event.
  function root(message:InboxFallbackInput['messages'][number]) {
    const visited=new Set<string>();
    let current=message;
    while(!current.replyToMatterId || !candidates.has(current.replyToMatterId)) {
      const parent=current.replyToMessageId && messages.get(current.replyToMessageId);
      if(!parent) break;
      if(visited.has(parent.id) || parent.id===current.id) return message;
      visited.add(current.id);
      current=parent;
    }
    return current;
  }
  const roots=new Map(ordered.map(message=>[message.id,root(message)]));
  const topicTargets=new Map<string,Set<string>>();
  const rootTopics=new Map<string,Set<string>>();
  function noteTopic(topic:string,event:string) {
    const targets=topicTargets.get(topic);
    if(targets) targets.add(event);
    else topicTargets.set(topic,new Set([event]));
  }
  for(const matter of existing) for(const topic of matter.topicIds ?? []) noteTopic(topic,matter.id);
  for(const message of ordered) {
    const parent=roots.get(message.id)!;
    if(!message.topicId) continue;
    const topics=rootTopics.get(parent.id);
    if(topics) topics.add(message.topicId);
    else rootTopics.set(parent.id,new Set([message.topicId]));
    const target=parent.replyToMatterId;
    if(target && candidates.has(target)) noteTopic(message.topicId,target);
  }

  const byRoot=new Map<string,string>(),byTopic=new Map<string,string>();
  let next=0;
  for(const message of ordered) {
    const parent=roots.get(message.id)!;
    if(byRoot.has(parent.id)) continue;
    const directTarget=parent.replyToMatterId && candidates.has(parent.replyToMatterId) ? parent.replyToMatterId : undefined;
    let event=directTarget;
    const topics=rootTopics.get(parent.id);
    const topic=parent.topicId ?? (topics?.size===1 ? topics.values().next().value : undefined);
    if(!event && topic) {
      const targets=topicTargets.get(topic);
      if(targets?.size===1) event=targets.values().next().value;
      event ??= byTopic.get(topic);
    }
    event ??= recent ? recent.id : 'new:'+(++next);
    byRoot.set(parent.id,event);
    if(topic && !directTarget && !byTopic.has(topic)) byTopic.set(topic,event);
  }
  return {assign:input.messages.map(message=>({message:message.id,event:byRoot.get(roots.get(message.id)!.id)!}))};
}
