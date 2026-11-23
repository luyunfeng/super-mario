import { h } from '../lib/dom.js';
import { confirmDialog, toast } from '../ui/overlay.js';
import { messageRequestLimit } from '../lib/message-submissions.js';
import { turnQueueActive } from './stop-turn.js';

export function createQueuedDraftEditor({api,store,input,pictures,files,context,isEditing,isSending,persist}) {
  let generation=0, location;
  const pending=new Set(), restored=new Set();
  function observe(key,owner,visible) {
    const next=JSON.stringify([key,owner,visible,turnQueueActive(store)]);
    if(next!==location) {location=next;generation++;}
  }
  function sameScope(ctx,message) {
    return message.conversationId===ctx.conversation && message.projectId===ctx.projectId && message.todoId===ctx.todoId;
  }
  function stamp(ctx) {
    return JSON.stringify([ctx.draft,ctx.captured,ctx.epoch,ctx.images.map(x=>[x.id,x.sha256]),ctx.files.map(x=>[x.id,x.uploadId])]);
  }
  function validate(ctx,msg) {
    if(ctx.captured || isEditing() || isSending(ctx.key) || !pictures.ready() || !files.ready())
      throw Error('请先完成当前引用、编辑或附件处理，再恢复这条消息。');
    const count=rows=>Array.isArray(rows)?rows.length:Number(rows||0);
    for(const [rows,plugin,label] of [[msg.images,'conversation-images','图片'],[msg.files,'conversation-files','文件']]) {
      if(count(rows) && !store.view.snapshot?.plugins?.some(p=>p.id===plugin && p.status==='active'))
        throw Error('请先启用对话'+label+'插件。');
    }
    const existing=kind=>ctx[kind].filter(row=>!row.id?.startsWith('queue-edit:'+msg.id+':')).length;
    if(existing('images')+count(msg.images)>20 || existing('files')+count(msg.files)>20)
      throw Error('追加后会超过每条消息 20 张图片或 20 个文件的上限。');
    const text=[ctx.draft,msg.text].filter(Boolean).join('\n\n');
    if(text.length>20000) throw Error('追加后超过 20000 字，请先处理已有草稿。');
    // Estimate the exact wire size from immutable image metadata without copying base64 buffers.
    const merged=kind=>[...ctx[kind],...(Array.isArray(msg[kind])?msg[kind]:[]).filter((_,idx)=>
      !ctx[kind].some(row=>row.id==='queue-edit:'+msg.id+':'+kind+':'+idx))];
    const images=merged('images'), attachments=merged('files');
    const envelope={text,projectId:ctx.projectId,todoId:ctx.todoId,
      ...(images.length && {images:images.map(row=>({mime:row.mime,data:''}))}),
      ...(attachments.length && {files:attachments.map(row=>({uploadId:row.uploadId || '0'.repeat(36)}))})};
    const encodedBytes=images.reduce((n,row)=>n+4*Math.ceil(row.bytes/3),0);
    if(encodedBytes+new Blob([JSON.stringify(envelope)]).size>messageRequestLimit)
      throw Error('追加后消息会超过 32 MiB，请先处理已有草稿。');
    return text;
  }
  async function restore(msg) {
    const ctx=context(),start=generation;
    if(!turnQueueActive(store) || !ctx.owner || !ctx.key || input.disabled) return;
    const key=JSON.stringify(['queue-edit',ctx.owner,ctx.key,msg.id]);
    if(pending.has(key)) return;
    const current=()=>start===generation && turnQueueActive(store) && context().key===ctx.key && api.draftOwner()===ctx.owner;
    const draftStamp=stamp(ctx);
    pending.add(key);
    try {
      if(msg.conversationId && !sameScope(ctx,msg)) throw Error('请在原项目和待办范围取回消息。');
      let saved=restored.has(key);
      if(persist()) try {saved ||= sessionStorage.getItem(key)==='1';} catch {}
      const containsText=!msg.text || ctx.draft.includes(msg.text);
      const hasRows=(kind)=>Array.isArray(msg[kind]) ? msg[kind].every((_,idx)=>ctx[kind].some(row=>row.id==='queue-edit:'+msg.id+':'+kind+':'+idx)) : !msg[kind];
      if(saved && containsText && hasRows('images') && hasRows('files')) {toast('这条消息已恢复到草稿。');return;}
      // When an attachment was removed or a draft was partially restored, do not append the original text twice.
      const addText=saved && containsText?'':msg.text;
      validate(ctx,{...msg,text:addText});
      if((ctx.draft || ctx.images.length || ctx.files.length) && !await confirmDialog({title:'追加到现有草稿',
        message:'保留当前正文和附件，将取回的内容追加到同一草稿。',confirmLabel:'追加到草稿'})) return;
      if(!current()) return;
      if(stamp(context())!==draftStamp) throw Error('草稿已变化，请重新核对。');
      validate(context(),{...msg,text:addText});
      const result=await api.post(ctx.url+'/'+encodeURIComponent(msg.id)+'/edit-queued',{projectId:ctx.projectId,todoId:ctx.todoId});
      if(!current()) return;
      if(stamp(context())!==draftStamp) throw Error('草稿已变化。请在原消息上选择「恢复到草稿」。');
      const original=result?.input;
      if(original?.id!==msg.id || !sameScope(ctx,original) || !original.directWebInput || original.role!=='user' ||
        original.queueState!=='withdrawn' || typeof original.text!=='string' || !Array.isArray(result.images) || !Array.isArray(result.files) ||
        result.images.length!==(original.images?.length||0) || result.files.length!==(original.files?.length||0))
        throw Error('取回回执不完整，请核对原消息状态。');
      const text=validate(context(),{...original,text:saved && original.text && ctx.draft.includes(original.text)?'':original.text});
      function rows(kind) {
        return result[kind].map((row,index)=>{
          const ref=original[kind][index];
          if(row.sha256!==ref.sha256 || row.bytes!==ref.bytes || row.mime!==ref.mime ||
            (kind==='files' && row.name!==ref.name)) throw Error('附件回执与原消息不符，请重新核对。');
          return {...row,id:'queue-edit:'+msg.id+':'+kind+':'+index,
            ...(kind==='images'?{name:'消息图片 '+(index+1)}:{sourceMessageId:msg.id,sourceIndex:index,uploadedAt:Date.now()})};
        });
      }
      const appendImages=result.images.length && pictures.prepareRestore(ctx,rows('images'));
      const appendFiles=result.files.length && files.prepareRestore(ctx,rows('files'));
      if(appendImages) appendImages();
      if(appendFiles) appendFiles();
      input.value=text; input.dispatchEvent(new Event('input',{bubbles:true}));
      restored.add(key);
      if(persist()) try {sessionStorage.setItem(key,'1');} catch {}
      input.focus();toast('已恢复到草稿，可继续编辑。');
    } catch(error) {
      if(current()) toast(error.message || '取回回执未确认，请核对原消息状态。');
    } finally {pending.delete(key);}
  }
  function action(message,summary=false) {
    if(!turnQueueActive(store)) return null;
    if(!summary && (!message.directWebInput || message.role!=='user' || !sameScope(context(),message) ||
      !['queued','withdrawn'].includes(message.queueState))) return null;
    return h('button',{type:'button',class:'btn btn--ghost btn--sm',onClick:()=>void restore(message)},
      message.queueState==='withdrawn'?'恢复到草稿':'取回编辑');
  }
  return {observe,action};
}
