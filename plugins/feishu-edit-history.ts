import {createHash} from 'node:crypto';
import type {Store} from '../packages/plugin-sdk/src/index.ts';

export interface FeishuEditObservation {
  chatId:string; messageId:string; text?:string; timestamp:string; edited:boolean; deleted:boolean; senderId?:string;
}
type Settings = {enabled:boolean;revision:number;enabledAt?:number};
type Version = {text:string;replacedAt:string};
type RecordRow = {key:string;senderId?:string;deleted?:boolean;at:number;text?:string;versions:Version[];truncated:boolean};
const settingsTable = 'feishu.edit-history.settings';
const versionLimit = 50;
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const table = (accountKey:string) => 'feishu.edit-history.rows.' + hash(accountKey);
const rowKey = (chatId:string,messageId:string) => hash(JSON.stringify([chatId,messageId]));

export function createFeishuEditHistory(store:Pick<Store,'get'|'put'|'remove'|'list'|'transaction'>) {
  const state = (accountKey:string):Settings => store.get<Settings>(settingsTable,hash(accountKey)) ?? {enabled:false,revision:0};
  function settings(accountKey:string) {
    const {enabled,revision} = state(accountKey);
    return {enabled,revision};
  }
  function configure(accountKey:string,enabled:boolean,expectedRevision:number) {
    return store.transaction(() => {
      const current = state(accountKey);
      if (current.revision !== expectedRevision) throw Object.assign(new Error('编辑历史设置已变化，请刷新'),{status:409});
      if (enabled !== current.enabled) {
        if (!enabled) for (const row of store.list<RecordRow>(table(accountKey))) store.remove(table(accountKey),row.key);
        store.put(settingsTable,hash(accountKey),{enabled,revision:current.revision+1,...(enabled && {enabledAt:Date.now()})});
      }
      return settings(accountKey);
    });
  }
  function observe(accountKey:string,expectedRevision:number,observations:FeishuEditObservation[]) {
    store.transaction(() => {
      const setting = state(accountKey);
      if (!setting.enabled || setting.revision !== expectedRevision) return;
      const collection = table(accountKey);
      // Process a batch in source time order. Across pages a late event never revises the baseline.
      for (const item of [...observations].sort((a,b) => Date.parse(a.timestamp)-Date.parse(b.timestamp))) {
        if (!item.chatId || !item.messageId) continue;
        const key = rowKey(item.chatId,item.messageId);
        const prior = store.get<RecordRow>(collection,key);
        if (prior?.deleted) continue;
        if (item.deleted) {
          store.put(collection,key,{key,at:0,deleted:true,versions:[],truncated:false});
          continue;
        }
        const at = Date.parse(item.timestamp);
        if (!Number.isFinite(at) || at <= 0 || at > Date.now() || (prior && at < prior.at) || typeof item.text !== 'string') continue;
        if (prior?.senderId && item.senderId && prior.senderId !== item.senderId) continue;
        if (prior && at === prior.at) {
          if (prior.text !== undefined && prior.text !== item.text) {
            // Conflicting projections at the same instant cannot establish a replacement.
            store.put(collection,key,{...prior,text:undefined,versions:prior.versions.filter(v=>Date.parse(v.replacedAt)!==at)});
          }
          continue;
        }
        const row:RecordRow = {key,at,text:item.text,senderId:item.senderId ?? prior?.senderId,
          versions:prior?.versions ?? [],truncated:prior?.truncated ?? false};
        if (item.edited && at >= setting.enabledAt! && prior?.text !== undefined && item.text !== prior.text) {
          row.versions = [{text:prior.text,replacedAt:new Date(at).toISOString()},...row.versions];
          if (row.versions.length > versionLimit) { row.versions.length=versionLimit; row.truncated=true; }
        }
        store.put(collection,key,row);
      }
    });
  }
  function read(accountKey:string,chatId:string,messageId:string) {
    const row = settings(accountKey).enabled ? store.get<RecordRow>(table(accountKey),rowKey(chatId,messageId)) : undefined;
    return {versions:row ? [...row.versions].reverse() : [],truncated:row?.truncated ?? false};
  }
  return {settings,configure,observe,read};
}
