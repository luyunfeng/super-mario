import { messageRequestLimit as requestLimit } from '../lib/message-submissions.js';
import { attachmentDraftStore } from '../lib/attachment-drafts.js';
import { openChatImageViewer } from './chat-image-viewer.js';
import { openChatImageEditor } from './chat-image-editor.js';
import { h } from '../lib/dom.js';
import { Button } from '../ui/kit.js';

const byteLimit = 3750000;

export function conversationImagesActive(store) {
  return !store.view.unauthorized && store.view.snapshot?.plugins?.some(plugin=>plugin.id==='conversation-images' && plugin.status==='active');
}
const allowed = ['image/png','image/jpeg','image/webp','image/gif'];
const storedDraft = attachmentDraftStore('sm-message-image-drafts','images');

async function prepare(file) {
  if (!allowed.includes(file.type)) throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片。');
  let blob = file;
  if (file.size > byteLimit) {
    if (file.type === 'image/gif') throw new Error('GIF 超过 3,750,000 字节，请缩小后再添加。');
    const bitmap = await createImageBitmap(file);
    try {
      let ratio = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height), Math.sqrt(byteLimit / file.size));
      do {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
        canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
        blob = await new Promise(resolve => canvas.toBlob(resolve,'image/webp',0.9));
        if (!blob) throw new Error('无法缩小这张图片。');
        if (blob.size <= byteLimit) break;
        ratio *= 0.75;
      } while (ratio > 0.001);
    } finally { bitmap.close(); }
  }
  if (!blob.size || blob.size > byteLimit) throw new Error('图片为空或超过单张大小限制。');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha256 = Array.from(globalThis.sha256(bytes), x => x.toString(16).padStart(2,'0')).join('');
  const reader = new FileReader();
  const data = await new Promise((resolve,reject) => {
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取图片。'));
    reader.readAsDataURL(blob);
  });
  const id = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
  return { id, name:file.name || '粘贴的图片', mime:blob.type, data, bytes:blob.size, sha256 };
}

export function createMessageImages(input) {
  const memory = new Map();
  let current, owner, persist, loading, busy = false, generation = 0;
  let editor;
  const picker = h('input',{type:'file',accept:allowed.join(','),multiple:true,hidden:true,'aria-label':'选择图片'});
  const button = Button({label:'添加图片',size:'sm',kind:'ghost',onClick:()=>picker.click()});
  const tray = h('div',{class:'message-images'});
  const note = h('p',{class:'small',role:'status',hidden:true});
  const el = h('div',null,picker,tray,note);
  function status(value) { note.textContent=value; note.hidden=!value; }
  function paint() {
    const rows = memory.get(current) || [];
    button.disabled = !current || !!loading || busy;
    tray.replaceChildren(...rows.map((row,index) => h('div',{class:'message-image-draft'},
      h('img',{src:'data:'+row.mime+';base64,'+row.data,alt:row.name}),
      Button({label:'编辑',ariaLabel:'编辑第 '+(index+1)+' 张图片',size:'sm',kind:'ghost',disabled:busy || !!loading,onClick:()=>edit(row)}),
      Button({label:'移除',ariaLabel:'移除第 '+(index+1)+' 张图片',size:'sm',kind:'ghost',onClick:()=>remove(current,[row.id],persist)}))));
  }
  function mutate(key,change,durable) {
    memory.set(key,change(memory.get(key) || []));
    if (durable) void storedDraft(key,change).catch(()=>{if(current===key) status('浏览器未保存图片草稿，请在此页完成发送。');});
    if (current===key) paint();
  }
  function remove(key,ids,durable) { mutate(key,rows=>rows.filter(row=>!ids.includes(row.id)),durable); }
  function edit(row,original) {
    if (!current || busy || loading || editor) return;
    const key = current, stamp = generation;
    // Each edited version gets a new row ID. A delayed receipt for the
    // previous version must not clear the replacement from this draft.
    const handle = openChatImageEditor({
      row,
      async onSave(blob,history) {
        if (original) await original.verify();
        const saved = await prepare(new File([blob],row.name,{type:blob.type}));
        if (!handle.isOpen() || editor !== handle || generation !== stamp) throw new Error('图片草稿已切换。');
        const rows = memory.get(key) || [];
        if (original && (!original.valid() || rows.length >= 20)) throw new Error('原会话已变化或草稿图片已满。');
        if (!original && !rows.some(item=>item.id === row.id)) throw new Error('这张图片已移出草稿。');
        const encodedBytes = rows.reduce((total,item)=>total + (item.id === row.id ? saved.data.length : item.data.length),0);
        if (encodedBytes + (original ? saved.data.length : 0) > requestLimit) throw new Error('编辑后图片合计超过 32 MiB，请先移除部分图片。');
        saved.editSource = row.editSource || {mime:row.mime,data:row.data};
        saved.editHistory = history;
        mutate(key,items=>original ? [...items,saved] : items.map(item=>item.id === row.id ? saved : item),persist);
      },
      onClose() { editor = undefined; },
    });
    editor = handle;
  }
  async function add(files) {
    if (!current || busy) return;
    const stamp=generation,key=current;
    busy=true;paint();
    try {
      await loading;
      if (stamp!==generation) return;
      const previous=memory.get(key) || [];
      if (files.length+previous.length>20) throw new Error('一条消息最多可附 20 张图片。');
      const rows=[];
      for (const file of files) {
        const row=await prepare(file);
        if (stamp!==generation) return;
        rows.push(row);
        if ([...previous,...rows].reduce((sum,item)=>sum+item.data.length,0)>requestLimit)
          throw new Error('图片合计超过 32 MiB，请分批发送。');
      }
      status('');
      mutate(key,old=>[...old,...rows],persist);
    } catch(error) { if(stamp===generation) status(error.message || '图片处理失败。'); }
    finally { if(stamp===generation) { busy=false;paint(); } }
  }
  picker.onchange=()=>{const files=Array.from(picker.files);picker.value='';if(files.length) void add(files);};
  input.addEventListener('dragover',event=>{
    if(current && Array.from(event.dataTransfer?.items || []).some(item=>item.kind==='file' && item.type.startsWith('image/'))) event.preventDefault();
  });
  input.addEventListener('drop',event=>{
    const files=Array.from(event.dataTransfer?.files || []).filter(file=>file.type.startsWith('image/'));
    if(current && files.length) {event.preventDefault();void add(files);}
  });
  input.addEventListener('paste',event=>{
    const files=Array.from(event.clipboardData?.files || []).filter(file=>file.type.startsWith('image/'));
    if (current && files.length) {event.preventDefault();void add(files);}
  });
  return {el,button,
    update(key,nextOwner,durable,active) {
      button.hidden=el.hidden=!active;
      picker.disabled=!active;
      const next=active && key && nextOwner && JSON.stringify([nextOwner,key]);
      if(next===current && owner===nextOwner && persist===durable) return;
      editor?.close();
      if(owner!==nextOwner) memory.clear();
      owner=nextOwner;current=next;persist=durable;
      const stamp=++generation;
      busy=false;loading=undefined;status('');
      if(current && durable) {
        loading=storedDraft(current).then(rows=>{if(stamp===generation) memory.set(next,rows);})
          .catch(()=>{if(stamp===generation) status('图片草稿仅保留在当前页面。');})
          .finally(()=>{if(stamp===generation){loading=undefined;paint();}});
      }
      paint();
    },
    async editCopy(key,blob,original) {
      const stamp = generation;
      if (!key || current !== JSON.stringify([owner,key]) || busy || loading || editor) throw new Error('原会话的图片草稿不可用。');
      const file = new File([blob],'消息图片',{type:blob.type});
      const row = await prepare(file);
      if (stamp !== generation || !original.valid()) throw new Error('原会话已变化。');
      edit(row,original);
    },
    closeEditor() { editor?.close(); },
    capture:()=>memory.get(current) || [],
    ready(){if(editor){status('请先完成或取消图片编辑。');return false;}if(loading || busy){status('正在准备图片，请稍后发送。');return false;}return true;},
    accepted(ctx) {
      if(ctx.owner!==owner || !ctx.images?.length) return;
      remove(JSON.stringify([ctx.owner,ctx.key]),ctx.images.map(i=>i.id),persist);
    },
  };
}

// Keyed message rows can be temporarily detached by the renderer. Keep a transfer
// alive across that synchronous move, and cancel/revoke it when the row really leaves.
class MessageImage extends HTMLElement {
  connectedCallback() {
    if(!this.source) return;
    this.unsubscribe ??= this.source.store.subscribe(()=>this.refresh());
    this.refresh();
  }
  refresh() {
    if(!this.source) return;
    const visible=conversationImagesActive(this.source.store) && this.source.owner===this.source.api.draftOwner() &&
      this.source.owner===this.source.store.view.snapshotOwner;
    this.hidden=!visible;
    if(!visible) { if(this.job) this.clear(); return; }
    if(this.job) return;
    const {api,path,label,owner}=this.source;
    if(api.draftOwner()!==owner) return;
    const job=this.job=new AbortController();
    const load=async()=>{
      try {
        const blob=await api.blob(path,job.signal);
        if(this.job!==job || !this.isConnected || api.draftOwner()!==owner) return;
        if(!allowed.includes(blob.type)) throw new Error('图片格式无效');
        this.url=URL.createObjectURL(blob);
        this.replaceChildren(h('button',{type:'button',class:'message-image-open','aria-label':'查看'+label,onClick:()=>this.openViewer()},
          h('img',{src:this.url,alt:label,class:'message-image-thumb'})));
      } catch {
        if(this.job!==job || job.signal.aborted) return;
        this.replaceChildren(Button({label:'重试读取'+label,size:'sm',kind:'ghost',onClick:()=>{this.job=undefined;this.refresh();}}));
      }
    };
    void load();
  }
  openViewer() {
    const {api,store,owner,group} = this.source;
    const route = location.hash;
    const valid = () => this.isConnected && location.hash === route && api.draftOwner() === owner &&
      store.view.snapshotOwner === owner && conversationImagesActive(store);
    if (!valid()) return;
    // Walk visible thumbnails in reading order. A project or task filter is
    // part of the audience even when main chat uses one conversation ID.
    const items = [...document.querySelectorAll('sm-message-image')].filter(el =>
      el.source?.group === group && el.source.owner === owner && el.getClientRects().length);
    const index = items.indexOf(this);
    if (index < 0) return;
    const load = (at,signal) => {
      if (!valid() || !items[at]?.isConnected) throw new Error('原会话已变化。');
      return api.blob(items[at].source.path,signal);
    };
    this.viewer?.close();
    this.viewer = openChatImageViewer({index,count:items.length,load,valid,onClose:()=>{this.viewer=undefined;},
      ...(this.source.editCopy && {onEdit:(at,blob)=>{
        const item = items[at];
        if (!item.source.editCopy || !item.isConnected) throw new Error('原会话的图片草稿不可用。');
        return item.source.editCopy(blob,{valid:()=>valid() && item.isConnected,verify:()=>load(at)});
      }}),
    });
  }
  disconnectedCallback() { queueMicrotask(()=>{
    if(this.isConnected) return;
    this.unsubscribe?.();this.unsubscribe=undefined;this.clear();
  }); }
  clear() {
    this.viewer?.close();this.viewer=undefined;
    this.job?.abort();this.job=undefined;
    if(this.url) URL.revokeObjectURL(this.url);
    this.url=undefined;this.replaceChildren();
  }
}
customElements.define('sm-message-image',MessageImage);
export function messageImages(api,store,message,editCopy) {
  if(!message.images?.length) return null;
  return h('div',{class:'message-images'},message.images.map((_,index)=>{
    const el=document.createElement('sm-message-image');
    el.source={api,store,editCopy,group:JSON.stringify([message.conversationId,message.projectId,message.todoId]),owner:api.draftOwner(),label:'消息图片 '+(index+1),path:'/messages/'+encodeURIComponent(message.id)+'/images/'+index+'?conversationId='+encodeURIComponent(message.conversationId)};
    return el;
  }));
}
