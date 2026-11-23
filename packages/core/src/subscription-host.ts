import { createHash } from 'node:crypto';
import type { Contributions, Extension, KnowledgeBackend, Store } from '../../plugin-sdk/src/index.ts';
import type { InboxThing, Json } from '../../protocol/src/index.ts';
import { subscriptionDrafts } from './subscription-drafts.ts';
import { subscriptionDraftTool, subscriptionReadTool } from './subscription-tools.ts';
import { createSourceSubscriptions } from './source-subscriptions.ts';

export function createSubscriptionHost(options: {
  authorizeRead:()=>{id:string;createdAt:string};
  store: Store;
  contributions: Contributions;
  use: (name:string,input:Json,options:{signal:AbortSignal; timeoutMs:number})=>Promise<Json>;
  ingest: (source:string,things:InboxThing[])=>Promise<void>;
  knowledge: ()=>KnowledgeBackend;
  changed: (event:string,id:string)=>void;
}) {
  let active: ReturnType<typeof createSourceSubscriptions> | undefined;
  let stop: (()=>Promise<void>) | undefined;
  function sources() {
    const services = options.contributions.list('services');
    return options.contributions.list('connectors').flatMap(({value}) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'subscription-source' ||
        typeof value.service !== 'string' || typeof value.name !== 'string' || typeof value.resourceLabel !== 'string' ||
        !services.some(entry => entry.value.name === value.service && entry.value.readOnly === true)) return [];
      return [{id:value.service,name:value.name,resourceLabel:value.resourceLabel}];
    });
  }
  let publicBase:string|undefined;
  const drafts=subscriptionDrafts(options.store,service,id=>options.changed('source-subscriptions.changed',id));
  const extension:Extension = {
    id:'source-subscriptions', name:'来源订阅',capabilities:['subscriptions'],
    activate(context) {
      const service = createSourceSubscriptions({
        store:options.store,sources,
        async read(sourceId,resource,signal) {
          if (!sources().some(source => source.id === sourceId)) throw Object.assign(new Error('订阅来源不可用'),{status:503});
          const provider = options.contributions.list('services').find(s => s.value.name === sourceId)?.value;
          const value = await options.use(sourceId,{resource},{signal,timeoutMs:30000});
          if (!options.contributions.list('services').some(s => s.value === provider))
            throw Object.assign(new Error('读取过程中来源插件已切换'),{sourceReadCode:'unavailable'});
          if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.items)) throw new Error('来源返回的条目无效');
          // The subscription service validates each item before either destination can receive it.
          return value.items as {id:string;title:string;text:string;url?:string}[];
        },
        async deliver(destination,key,item,subscription) {
          const id = 'subscription-'+createHash('sha256').update(key).digest('hex');
          const content = [item.text,item.url].filter(Boolean).join('\n\n');
          if (destination === 'inbox') {
            await options.ingest('subscription:'+subscription.id,[{thread:id,last:id,title:item.title,text:content,sender:subscription.name}]);
            return;
          }
          const backend = options.knowledge();
          if (!backend.supportsCreateOnly)
            throw Object.assign(new Error('知识后端不支持按编号仅创建'),{code:'CREATE_ONLY_UNAVAILABLE'});
          try {
            await backend.put({id,title:item.title,content,layer:'personal',tags:['来源订阅']}, null);
            options.changed('knowledge.changed',id);
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'KNOWLEDGE_EXISTS')) throw error;
          }
        },
        onChange:id=>options.changed('source-subscriptions.changed',id),
      });
      context.contribute('tools','source_subscriptions_read',subscriptionReadTool(service,sources,options.authorizeRead));
      context.contribute('tools','source_subscription_draft',subscriptionDraftTool((input,signal)=>drafts.propose(input,options.authorizeRead,signal),()=>publicBase));
      active = service;
      const timer = setInterval(() => { void service.tick().catch(error => console.error('来源订阅调度失败',error)); },30000);
      timer.unref();
      stop = async () => {
        clearInterval(timer);
        active=undefined;
        await service.close();
      };
      context.defer(stop);
    },
  };
  function service() {
    if (!active) throw Object.assign(new Error('请启用来源订阅插件'),{status:503});
    return active;
  }
  return {extension,service,sources,drafts,setPublicBase:(base:string|undefined)=>{publicBase=base;},close:()=>stop?.()};
}
