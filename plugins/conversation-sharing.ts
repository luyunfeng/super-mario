import {nativeSource} from './native-conversation-source.ts';
import {nativeShareKey,nativeTail,nextNativeRows,type NativeAnchor,readShareItems,type ReadNative,type NativeToolRecord} from './conversation-sharing-native.ts';
import {collectFuture,futureScopeFor,startFollowing,stopFollowing,type FutureScope} from './conversation-sharing-future.ts';
import {checkedResult,phaseLabels,record,traceObject} from './tool-trace-public-fields.ts';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Extension,Json,JsonObject,Store} from '../packages/plugin-sdk/src/index.ts';
import type {Message,Project,Todo,NativeExportSource} from '../packages/protocol/src/index.ts';
import {publicText} from './agent-progress-card.ts';

const shares='conversation-sharing.shares', snapshots='conversation-sharing.snapshots', tokens='conversation-sharing.tokens';
type ToolRecord={name:string;status:NativeToolRecord['status'];args?:string;result?:string};
type Excerpt={role:'user'|'assistant';text:string;tools?:ToolRecord[]};
type Share={nativeAnchor?:NativeAnchor;native?:NativeExportSource;includeFuture?:boolean;futureScope?:FutureScope;pauseReason?:string;showTools?:boolean;revision?:number;id:string;conversationId:string;createdAt:string;expiresAt:string;revokedAt?:string;messageCount:number;tokenHash:string};
type Snapshot={ids:string[];messages:Excerpt[];scopeHash:string};

function fail(status:number,message:string):never {throw Object.assign(Error(message),{status});}
function missing():never {return fail(404,'分享不存在或已失效');}
function hash(value:string) {return createHash('sha256').update(value).digest('hex');}
function args(raw:Json):JsonObject {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) fail(400,'分享请求格式无效');
  return raw;
}
function scope(store:Store,value:Json|undefined,allowArchived=false) {
  if (value==='main') return 'main';
  const match=typeof value==='string' && /^project:([^:]{1,256}):(work|memory)$/.exec(value);
  if (!match) return missing();
  const project=store.get<Project>('projects',match[1]!);
  if (!project || project.id!==match[1] || (!allowArchived && project.archivedAt)) return missing();
  return String(value);
}
function sourceRow(store:Store,conversationId:string,id:string) {
  const row=store.get<Message>('messages',id);
  if (!row || row.id!==id || row.conversationId!==conversationId || row.status!=='done' || row.queueState ||
      (row.origin && row.origin!=='user') || row.runResult || row.stoppedByUser || store.get('message.routes',id)) return missing();
  if (conversationId!=='main' && conversationId!==`project:${row.projectId}:work` && conversationId!==`project:${row.projectId}:memory`) return missing();
  if (row.projectId) {
    const project=store.get<Project>('projects',row.projectId);
    if (project?.id!==row.projectId || project.archivedAt) return missing();
  }
  if (row.todoId) {
    const todo=store.get<Todo>('todos',row.todoId);
    if (todo?.id!==row.todoId || todo.projectId!==row.projectId) return missing();
  }
  return row;
}
function selected(store:Store,conversationId:string,ids:string[]) {
  return ids.map(id=>{
    const row=sourceRow(store,conversationId,id);
    if (row.role!=='user' && row.role!=='assistant') return missing();
    const source=row.role==='user' ? row : row.replyTo && sourceRow(store,conversationId,row.replyTo);
    if (!source || source.role!=='user' || !source.directWebInput || source.replyTo || source.projectId!==row.projectId ||
        source.todoId!==row.todoId || !row.text?.trim()) return missing();
    return row;
  });
}
function visibleText(raw:string,workspaceToken:string) {
  const hidden='[凭证已隐藏]';
  let text=workspaceToken ? raw.replaceAll(workspaceToken,hidden) : raw;
  text=text.replace(/\bdata:[^\s<>"')]+/gi,'[内嵌数据已隐藏]')
    .replace(/\bhttps?:\/\/[^\s\/@]+:[^\s\/@]+@/gi,'https://[凭证已隐藏]@')
    .replace(/\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-)[\w-]{8,}|\bAKIA[A-Z0-9]{16}\b|\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g,hidden)
    .replace(/((?:密码|口令|密钥|令牌|验证码)\s*[：:=]\s*)[^\s，。；;]+/gu,'$1'+hidden)
    .replace(/([#/]share[\/#])[A-Za-z0-9_-]{32,}/gi,'$1'+hidden)
    .replace(/((?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi,'$1'+hidden)
    .replace(/(?:[A-Za-z0-9+/]{256,}={0,2})/g,'[内嵌数据已隐藏]');
  return publicText(text,262144);
}
function searchArgs(args:Record<string,unknown>|undefined,sourceText:string|undefined) {
  if (!args || Object.keys(args).some(k=>!['category','query','before'].includes(k))) return;
  const safe:Record<string,string>={};
  // An assistant may derive a search from private context. Only quote words the
  // owner is sharing in this very turn; a hidden source is never made visible.
  if (typeof args.query==='string' && args.query.trim() && args.query.length<=500 && sourceText?.includes(args.query)) safe.query=args.query;
  if (typeof args.category==='string' && ['text','quoted','file','tool_name','event','tool_input','tool_output'].includes(args.category)) safe.category=args.category;
  return Object.keys(safe).length ? JSON.stringify(safe) : undefined;
}
function toolRecords(store:Store,row:Message,sourceText:string|undefined) {
  const trace=store.get<{id:string;conversationId:string;userMessageId:string;projectId?:string;toolCalls:unknown[]}>('agent.traces',row.id);
  if (!trace || trace.id!==row.id || trace.conversationId!==row.conversationId || trace.userMessageId!==row.replyTo ||
      trace.projectId!==row.projectId || !Array.isArray(trace.toolCalls)) return [];
  const tools:ToolRecord[]=[];
  for (const call of trace.toolCalls) {
    if (!record(call) || typeof call.name!=='string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(call.name)) continue;
    const completed=typeof call.result==='string' && typeof call.isError==='boolean';
    const item:ToolRecord={name:call.name,status:completed ? (call.isError?'failed':'succeeded') : 'unknown'};
    if (call.name==='current_web_message_search') {
      const args=searchArgs(traceObject(call.args,32768),sourceText);
      if (args) item.args=args;
    } else if (call.name==='conversation_status' && item.status==='succeeded') {
      const phase=checkedResult(call)?.phase;
      if (typeof phase==='string' && Object.hasOwn(phaseLabels,phase)) item.result=JSON.stringify({phase});
    }
    tools.push(item);
  }
  return tools;
}
function selectionIds(value:Json|undefined) {
  if (!Array.isArray(value) || !value.length || value.length>100 || new Set(value).size!==value.length ||
      !value.every((id):id is string=>typeof id==='string' && id.length>0 && id.length<=256)) fail(400,'请选择 1 至 100 条不同的消息');
  return value;
}
function scopeFingerprint(rows:Message[]) {
  return hash(JSON.stringify(rows.map(row=>[row.id,row.role,row.replyTo,row.projectId,row.todoId])));
}
function currentSnapshot(store:Store,share:Share) {
  if (share.revokedAt || !(Date.parse(share.expiresAt)>Date.now())) return missing();
  const snapshot=store.get<Snapshot>(snapshots,share.id);
  if (!snapshot) return missing();
  if (share.native) {
    if (nativeShareKey(share.native)!==share.conversationId || snapshot.scopeHash!==hash(JSON.stringify([share.conversationId,snapshot.ids]))) return missing();
  } else if (scopeFingerprint(selected(store,scope(store,share.conversationId),snapshot.ids))!==snapshot.scopeHash) return missing();
  return snapshot;
}
function futureInfo(share:Share) {
  return {includeFuture:share.includeFuture===true,...(share.futureScope && {futureScope:share.futureScope}),...(share.pauseReason && {pauseReason:share.pauseReason})};
}
function synchronize(store:Store,share:Share,token:string):Share {
  if (!share.includeFuture || !share.futureScope || share.revokedAt || Date.parse(share.expiresAt)<=Date.now()) return share;
  const saved=store.get<Snapshot>(snapshots,share.id);
  if (!saved) return share;
  const ids=[...saved.ids],messages=[...saved.messages],seen=new Set(ids);
  let pauseReason:string|undefined;
  collectFuture(store,share.id,share.conversationId,share.futureScope,seen,candidate=>{
    let row:Message;
    try {
      scope(store,share.conversationId);
      row=selected(store,share.conversationId,[candidate.id])[0]!;
    } catch(error) {
      if ((error as {status?:number}).status===404) return 'skip';
      throw error;
    }
    const text=visibleText(row.text,token),message:Excerpt={role:row.role,text};
    if (share.showTools && row.role==='assistant') {
      const sourceIndex=ids.indexOf(row.replyTo!);
      const tools=toolRecords(store,row,messages[sourceIndex]?.text);
      if (tools.length) message.tools=tools;
    }
    const bytes=Buffer.byteLength(JSON.stringify([...messages,message]));
    if (ids.length>=100 || bytes>262144) {
      pauseReason=ids.length>=100 ? '已达到 100 条消息上限' : '后续消息将超过 256 KiB 上限';
      return 'full';
    }
    ids.push(row.id);messages.push(message);
    if (ids.length===100 || bytes===262144) {
      pauseReason=ids.length===100 ? '已达到 100 条消息上限' : '已达到 256 KiB 上限';
      return 'full';
    }
    return 'added';
  });
  if (ids.length===saved.ids.length && !pauseReason) return share;
  // A previously frozen source can lose its authorization. Do not catch up
  // this interval later if the original source becomes visible again.
  try {currentSnapshot(store,share);}
  catch (error) {
    if ((error as {status?:number}).status!==404) throw error;
    startFollowing(store,share.id);
    return share;
  }
  const scopeHash=scopeFingerprint(selected(store,share.conversationId,ids));
  const next={...share,revision:(share.revision??1)+1,messageCount:ids.length,...(pauseReason && {includeFuture:false,pauseReason})};
  store.put(snapshots,share.id,{ids,messages,scopeHash});
  store.put(shares,share.id,next);
  return next;
}
function checkRevision(value:Json|undefined,share:Share) {
  if (typeof value!=='number' || !Number.isSafeInteger(value) || value<1) fail(400,'需要有效的分享版本');
  if (value!==(share.revision??1)) fail(409,'分享已经修改，请刷新后重试');
}
export function createConversationSharing(workspaceToken='',readNative?:ReadNative):Extension {
  return {id:'conversation-sharing',name:'对话摘录分享',capabilities:['conversation.sharing'],
    permissions:['store.read','store.write','events.subscribe','service.provide:conversation-sharing.manage','service.provide:conversation-sharing.read'],
    activate({store,provide,onEvent,defer}) {
      let active=true;
      const lifetime=new AbortController();
      defer(()=>{active=false;lifetime.abort();});
      function requireActive() {if (!active) fail(503,'对话摘录分享已停用');}
      const generation=store.get<{revision?:number}>('core.plugin-settings','conversation-sharing')?.revision??1;
      // A live machine cannot be queried synchronously at plugin activation.
      // Pause native publication across an explicit disable until the owner can confirm a new tail.
      store.transaction(()=>{
        if (store.get<number>('conversation-sharing.settings','generation')!==generation) {
          for (const share of store.list<Share>(shares)) if (share.includeFuture && !share.revokedAt) {
            if (share.native) store.put(shares,share.id,{...share,includeFuture:false,revision:(share.revision??1)+1,pauseReason:'插件曾停用，请重新开启后续分享'});
            else startFollowing(store,share.id);
          }
          store.put('conversation-sharing.settings','generation',generation);
        }
      });
      const jobs=new Map<string,Promise<void>>(),nextPoll=new Map<string,number>();
      async function refreshNative(share:Share) {
        if (!share.native || !share.includeFuture || !share.nativeAnchor || share.revokedAt || Date.parse(share.expiresAt)<=Date.now()) return;
        const inFlight=jobs.get(share.id);
        if (inFlight) return inFlight;
        if ((nextPoll.get(share.id)??0)>Date.now()) return;
        for (const [id,deadline] of nextPoll) if (deadline<=Date.now()) nextPoll.delete(id);
        nextPoll.set(share.id,Date.now()+15000);
        const source=share.native,anchor=share.nativeAnchor;
        const signal=AbortSignal.any([lifetime.signal,AbortSignal.timeout(30000)]);
        const job=(async()=>{
          let items:Awaited<ReturnType<typeof nextNativeRows>>['items']=[],pause:string|undefined;
          try {({items,pause}=await nextNativeRows(readNative,source,anchor,!!share.showTools,signal));}
          catch(error) {
            const status=(error as {status?:number}).status;
            if (status===400) pause='后续消息超过分享容量，请调整摘录';
            else if (status===409) pause='原生会话历史暂时无法核对，请重新确认追加起点';
            else return; // Offline: serve the confirmed snapshot and retry at the next poll.
          }
          if (!active || signal.aborted || (!items.length && !pause)) return;
          store.transaction(()=>{
            const live=store.get<Share>(shares,share.id);
            if (!live?.includeFuture || live.revokedAt || Date.parse(live.expiresAt)<=Date.now() || live.revision!==share.revision ||
                live.nativeAnchor?.id!==anchor.id || live.nativeAnchor?.index!==anchor.index) return;
            const snapshot=currentSnapshot(store,live);
            let last=anchor;
            for (const item of items) {
              if (snapshot.ids.includes(item.id)) {pause='原生消息顺序已变化，请重新确认追加起点';break;}
              if (Buffer.byteLength(item.text)>262144) {pause='后续消息将超过 256 KiB 上限';break;}
              const text=visibleText(item.text,workspaceToken);
              if (text.trim()) {
                const message={role:item.role,text,...(item.tools?.length && {tools:item.tools})};
                const bytes=Buffer.byteLength(JSON.stringify([...snapshot.messages,message]));
                if (bytes>262144) {pause='后续消息将超过 256 KiB 上限';break;}
                snapshot.ids.push(item.id);snapshot.messages.push(message);
                if (snapshot.ids.length>=100 || bytes===262144) pause=snapshot.ids.length>=100?'已达到 100 条消息上限':'已达到 256 KiB 上限';
              }
              last={index:item.index,id:item.id};
              if (pause) break;
            }
            snapshot.scopeHash=hash(JSON.stringify([live.conversationId,snapshot.ids]));
            store.put(snapshots,live.id,snapshot);
            store.put(shares,live.id,{...live,nativeAnchor:last,revision:(live.revision??1)+1,messageCount:snapshot.ids.length,
              ...(pause && {includeFuture:false,pauseReason:pause})});
          });
        })();
        jobs.set(share.id,job);
        try {await job;} finally {jobs.delete(share.id);}
      }
      onEvent(event=>{
        if (event.type!=='messages.changed' || !record(event.data)) return;
        const conversationId=event.data.conversationId;
        for (const row of store.list<Share>(shares)) if (row.includeFuture && !row.revokedAt && row.conversationId===conversationId) {
          try {store.transaction(()=>{const live=store.get<Share>(shares,row.id);if (live) synchronize(store,live,workspaceToken);});}
          catch(error) {if ((error as {status?:number}).status!==404) console.warn('后续分享消息同步暂未完成');}
        }
      });
      provide('conversation-sharing.manage',async(raw,signal):Promise<Json>=>{
        signal.throwIfAborted();
        const input=args(raw), action=input.action;
        if (action==='native_sources') {
          if (input.native!==undefined || input.conversationId!==undefined) fail(400,'原生来源清单不接受会话范围');
          const sources=new Map<string,NativeExportSource>();
          for (const share of store.list<Share>(shares)) if (share.native && !share.revokedAt && Date.parse(share.expiresAt)>Date.now() &&
              nativeShareKey(share.native)===share.conversationId) sources.set(share.conversationId,share.native);
          return {sources:[...sources.values()].map(source=>({...source}))};
        }
        const native=input.native===undefined ? undefined : nativeSource(input.native);
        if (native && input.conversationId!==undefined) fail(400,'请选择一种会话来源');
        const nativeKey=native && nativeShareKey(native);
        let nativeTexts:Map<string,Excerpt>|undefined,newAnchor:NativeAnchor|undefined;
        if (native && nativeKey) {
          if ((input.includeFuture!==undefined && typeof input.includeFuture!=='boolean') || input.futureScope!==undefined)
            fail(400,'后续消息只能来自同一原生会话');
          if (input.showTools!==undefined && typeof input.showTools!=='boolean') fail(400,'请选择是否分享工具记录');
          if (action==='catalog') {
            const offset=input.offset??0;
            if (typeof offset!=='number' || !Number.isSafeInteger(offset) || offset<0) fail(400,'原生会话分页位置无效');
            const page=await readShareItems(readNative,native,{offset},signal);
            requireActive();
            return {items:page.items.map(item=>({...item,text:Buffer.byteLength(item.text)>262144 ? '该消息超过分享容量' :
              Array.from(visibleText(item.text,workspaceToken)).slice(0,500).join('')})),total:page.total};
          }
          if (action==='preview' || action==='update' || action==='create') {
            const ids=selectionIds(input.messageIds);
            if (ids.some(id=>!/^[a-f0-9]{64}$/.test(id))) fail(400,'原生消息指纹无效');
            let retained:string[]=[],previousTools=false,wasFollowing=false;
            if (action==='update' || input.id!==undefined) {
              const share=typeof input.id==='string' && store.get<Share>(shares,input.id);
              if (!share || share.conversationId!==nativeKey || !share.native) return missing();
              checkRevision(input.revision,share);
              retained=currentSnapshot(store,share).ids;
              previousTools=share.showTools===true;wasFollowing=share.includeFuture===true;
            }
            const showTools=input.showTools??previousTools;
            const fresh=showTools && !previousTools ? ids : ids.filter(id=>!retained.includes(id));
            const {items}=fresh.length ? await readShareItems(readNative,native,{ids:fresh,...(showTools && {showTools:true})},signal) : {items:[]};
            if (action!=='preview' && input.includeFuture===true && !wasFollowing) newAnchor=await nativeTail(readNative,native,signal);
            nativeTexts=new Map(items.map(({id,role,text,tools})=>[id,{role,text,...(tools && {tools})}]));
          }
        }
        requireActive();
        return store.transaction(():Json=>{
        signal.throwIfAborted();
        const conversationId=nativeKey??scope(store,input.conversationId,action==='list' || action==='revoke');
        if (action==='list') {
          return {shares:store.list<Share>(shares).filter(s=>s.conversationId===conversationId).reverse()
            .map(row=>{
              let current=row;
              try {current=store.transaction(()=>synchronize(store,row,workspaceToken));}
              catch(error) {if ((error as {status?:number}).status!==404) throw error;}
              const {id,createdAt,expiresAt,revokedAt,messageCount,revision=1,showTools=false}=current;
              return {id,revision,showTools,createdAt,expiresAt,...(revokedAt && {revokedAt}),messageCount,...futureInfo(current)};
            })};
        }
        const editing=action==='detail' || action==='update' || (action==='preview' && input.id!==undefined);
        let share:Share|undefined, original:Snapshot|undefined;
        if (editing || action==='revoke') {
          const found=typeof input.id==='string' && store.get<Share>(shares,input.id);
          if (!found || found.id!==input.id || found.conversationId!==conversationId) return missing();
          share=found;
          if (action==='revoke') {
            if (input.revision!==undefined) checkRevision(input.revision,share);
            if (!share.revokedAt) {
              store.put(shares,share.id,{...share,revokedAt:new Date().toISOString()});
              store.remove(tokens,share.tokenHash);store.remove(snapshots,share.id);stopFollowing(store,share.id);
            }
            return {revoked:true};
          }
          share=synchronize(store,share,workspaceToken);
          original=currentSnapshot(store,share);
          if (action==='detail') return {...futureInfo(share),id:share.id,revision:share.revision??1,showTools:share.showTools??false,messageIds:original.ids,expiresAt:share.expiresAt,messages:original.messages};
          checkRevision(input.revision,share);
        } else if (input.id!==undefined || input.revision!==undefined) fail(400,'分享标识与操作不匹配');
        if (action!=='preview' && action!=='create' && action!=='update') fail(400,'分享操作无效');
        // null means retain the exact expiry even when preview and update occur at different times.
        const hours=input.expireHours===undefined ? (editing ? null : 24) : input.expireHours;
        if (hours!==null && (typeof hours!=='number' || !Number.isInteger(hours) || hours<1 || hours>720) || input.expireHours===null)
          fail(400,'分享期限须为 1 至 720 小时');
        const ids=selectionIds(input.messageIds), rows=native ? [] : selected(store,conversationId,ids);
        const includeFuture=input.includeFuture===undefined ? share?.includeFuture??false : input.includeFuture;
        if (typeof includeFuture!=='boolean') fail(400,'请选择是否追加后续消息');
        const futureScope=native ? undefined : futureScopeFor(input.futureScope,share?.futureScope,includeFuture,rows);
        const retained=new Map(original?.ids.map((id,i)=>[id,original.messages[i]!]));
        const nativeItems=native ? ids.map(id=>retained.get(id)??nativeTexts?.get(id)??missing()) : undefined;
        const texts=nativeItems ? nativeItems.map(item=>item.text) : rows.map(row=>retained.get(row.id)?.text??row.text);
        if (nativeItems && texts.some(text=>!text.trim())) fail(400,'所选原生消息缺少可分享正文');
        if (texts.reduce((n,text)=>n+Buffer.byteLength(text),0)>262144) fail(400,'选择的正文超过 256 KiB');
        const showTools=input.showTools===undefined ? (share?.showTools??false) : input.showTools;
        if (typeof showTools!=='boolean') fail(400,'请选择是否分享工具记录');
        const excerpts=new Map(rows.map(row=>[row.id,retained.get(row.id)?.text??visibleText(row.text,workspaceToken)]));
        const messages=nativeItems ? nativeItems.map((item,i):Excerpt=>{
          const key=ids[i]!,previous=retained.get(key),fresh=nativeTexts?.get(key);
          if (previous && fresh && previous.role!==fresh.role) fail(409,'原生消息角色已变化，请重新选择');
          const tools=showTools && item.role==='assistant' && (previous && share?.showTools ? previous.tools : fresh?.tools);
          return {role:item.role,text:previous?.text??visibleText(item.text,workspaceToken),...(tools && {tools})};
        }) : rows.map((row):Excerpt=>{
          const message:Excerpt={role:row.role,text:excerpts.get(row.id)!};
          if (showTools && row.role==='assistant') {
            const sourceText=row.replyTo && excerpts.get(row.replyTo);
            const previous=retained.get(row.id);
            const tools=previous && share?.showTools ? (previous.tools??[]).map(tool=>{
              if (tool.name!=='current_web_message_search' || !tool.args) return tool;
              // Removing the original question must also remove its echoed private search words.
              const {args,...rest}=tool,allowed=searchArgs(traceObject(args,32768),sourceText);
              return allowed ? {...rest,args:allowed} : rest;
            }) : toolRecords(store,row,sourceText);
            if (tools.length) message.tools=tools;
          }
          return message;
        });
        if (Buffer.byteLength(JSON.stringify(messages))>262144)
          fail(400,'分享摘录超过 256 KiB，请减少所选消息或关闭工具记录');
        const scopeHash=native ? hash(JSON.stringify([conversationId,ids])) : scopeFingerprint(rows);
        const previewHash=hash(JSON.stringify([conversationId,share?.id,share?.revision??1,hours??share?.expiresAt,showTools,includeFuture,futureScope,scopeHash,texts,messages]));
        if (action==='preview') return {messages,previewHash};
        if (input.previewHash!==previewHash) fail(409,'消息已变化，请重新预览');
        const full=includeFuture && (ids.length>=100 || Buffer.byteLength(JSON.stringify(messages))>=262144);
        const policy={...(newAnchor && {nativeAnchor:newAnchor}),includeFuture:includeFuture && !full,...(futureScope && {futureScope}),...(full && {pauseReason:ids.length>=100?'已达到 100 条消息上限':'已达到 256 KiB 上限'})};
        if (share) {
          if (!native && policy.includeFuture && !share.includeFuture) startFollowing(store,share.id);
          if (!policy.includeFuture && share.includeFuture) stopFollowing(store,share.id);
          const expiresAt=hours===null ? share.expiresAt : new Date(Date.now()+hours*3600000).toISOString();
          const revision=(share.revision??1)+1;
          store.put(snapshots,share.id,{ids,messages,scopeHash});
          const {pauseReason:priorPause,...existing}=share;
          store.put(shares,share.id,{...existing,...policy,expiresAt,revision,showTools,messageCount:ids.length});
          return {id:share.id,expiresAt,revision};
        }
        const now=Date.now(), existing=store.list<Share>(shares);
        // Drop expired snapshots before admitting another; keep recent metadata for the owner's list.
        for (const share of existing) if (Date.parse(share.expiresAt)<=now) {
          store.remove(snapshots,share.id);store.remove(tokens,share.tokenHash);stopFollowing(store,share.id);
          if (Date.parse(share.expiresAt)<now-30*86400000) store.remove(shares,share.id);
        }
        const inactive=existing.filter(s=>s.revokedAt || Date.parse(s.expiresAt)<=now);
        for (const old of inactive.slice(0,Math.max(0,inactive.length-512))) store.remove(shares,old.id);
        const active=existing.filter(s=>!s.revokedAt && Date.parse(s.expiresAt)>now);
        if (active.length>=256 || active.filter(s=>s.conversationId===conversationId).length>=64) fail(409,'有效分享已达上限，请先撤销旧分享');
        const id=randomUUID(),token=randomBytes(32).toString('base64url'),tokenHash=hash(token);
        const createdAt=new Date(now).toISOString(),expiresAt=new Date(now+(hours??24)*3600000).toISOString();
        if (!native && policy.includeFuture) startFollowing(store,id);
        store.put(shares,id,{...policy,...(native && {native}),id,revision:1,showTools,conversationId,createdAt,expiresAt,messageCount:ids.length,tokenHash});
        store.put(snapshots,id,{ids,messages,scopeHash});store.put(tokens,tokenHash,id);
        return {id,token,expiresAt};
        });
      });
      provide('conversation-sharing.read',async(raw,signal):Promise<Json>=>{
        signal.throwIfAborted();
        const {token,knownRevision}=args(raw);
        if (typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return missing();
        const digest=hash(token),id=store.get<string>(tokens,digest),share=id && store.get<Share>(shares,id);
        if (!share || share.id!==id || share.tokenHash!==digest) return missing();
        // Readers obtain the last authorized snapshot while a slow machine is being checked.
        // One viewer closing its tab must not cancel the shared publication refresh.
        if (share.native && share.includeFuture) {
          let timeout:ReturnType<typeof setTimeout>|undefined;
          try {
            await Promise.race([refreshNative(share),new Promise<void>(resolve=>{timeout=setTimeout(resolve,350);timeout.unref();})]);
          } finally {clearTimeout(timeout);}
        }
        requireActive();signal.throwIfAborted();
        return store.transaction(():Json=>{
        const latest=store.get<Share>(shares,share.id);
        if (!latest || latest.tokenHash!==digest) return missing();
        const current=synchronize(store,latest,workspaceToken);
        const snapshot=currentSnapshot(store,current);
        const revision=current.revision??1;
        const response:JsonObject={expiresAt:current.expiresAt,revision};
        if (current.futureScope || current.nativeAnchor) response.publicationStatus=current.includeFuture?'live':current.pauseReason?'paused':'frozen';
        if (knownRevision===revision) response.unchanged=true;
        else response.messages=snapshot.messages;
        return response;
        });
      });
    }};
}
