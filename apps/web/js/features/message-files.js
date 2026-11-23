import { h } from '../lib/dom.js';
import { attachmentDraftStore } from '../lib/attachment-drafts.js';
import { Button } from '../ui/kit.js';

const drafts = attachmentDraftStore('sm-message-file-drafts','files');
const sizeLimit = 200 * 1024 * 1024;
const validFor = 24 * 60 * 60 * 1000;
const active = store => !store.view.unauthorized && store.view.snapshot?.plugins?.some(p => p.id === 'conversation-files' && p.status === 'active');
const size = bytes => bytes < 1024 ? bytes+' B' : bytes < 1024*1024 ? (bytes/1024).toFixed(1)+' KiB' : (bytes/1024/1024).toFixed(1)+' MiB';
const usable = row => !!row.uploadId && Date.now()-row.uploadedAt < validFor;

export function createMessageFiles(api, store, input) {
  const memory = new Map(), jobs = new Map();
  let key,owner,durable,scope,load,generation=0;
  const picker = h('input',{type:'file',multiple:true,hidden:true,'aria-label':'选择文件'});
  const button = Button({label:'添加文件',kind:'ghost',size:'sm',onClick:()=>picker.click()});
  const tray = h('div',{class:'stack'});
  const info = h('p',{class:'small',role:'status',hidden:true});
  const el = h('div',null,picker,tray,info);
  const status = text => {info.textContent=text;info.hidden=!text;};
  function change(k,fn,persist) {
    memory.set(k,fn(memory.get(k)||[]));
    if (persist) void drafts(k,fn).catch(()=>{if(key===k) status('文件草稿仅保留在当前页面。');});
    if(k===key) paint();
  }
  function paint() {
    button.disabled=!key || !!load;
    tray.replaceChildren(...(memory.get(key)||[]).map(row=>h('div',{class:'row row--wrap message-file-draft'},
      h('span',null,row.name+' · '+size(row.blob.size)),h('span',{class:'small muted'},jobs.has(row.id)?'正在上传':usable(row)?'已上传':'待上传'),
      !jobs.has(row.id) && !usable(row) && Button({label:'重试上传',size:'sm',onClick:()=>upload(row)}),
      Button({label:'移除',ariaLabel:'移除文件 '+row.name,kind:'ghost',size:'sm',onClick:()=>{
        jobs.get(row.id)?.abort();
        change(key,rows=>rows.filter(r=>r.id!==row.id),durable);
      }}))));
  }
  async function upload(row) {
    if(!key || !active(store) || jobs.has(row.id) || api.draftOwner()!==owner) return;
    const k=key, stamp=generation, persist=durable;
    const controller=new AbortController();
    jobs.set(row.id,controller);paint();
    try {
      const params=new URLSearchParams({...scope,name:row.name});
      const receipt=await api('/chat-files/uploads?'+params,{method:'PUT',body:row.blob,headers:{'Content-Type':row.blob.type || 'application/octet-stream'},signal:controller.signal});
      if(stamp!==generation || controller.signal.aborted || owner!==api.draftOwner()) return;
      if(typeof receipt?.uploadId!=='string' || typeof receipt.sha256!=='string' || receipt.bytes!==row.blob.size) throw new Error('文件上传回执无效。');
      const patch={uploadId:receipt.uploadId,uploadedAt:Date.now(),name:receipt.name,mime:receipt.mime,bytes:receipt.bytes,sha256:receipt.sha256};
      change(k,rows=>rows.map(r=>r.id===row.id ? {...r,...patch} : r),persist);
    } catch(e) { if(stamp===generation && !controller.signal.aborted) status(row.name+' 上传失败：'+e.message); }
    finally { if(jobs.get(row.id)===controller) jobs.delete(row.id); if(stamp===generation) paint(); }
  }
  async function add(files) {
    const stamp=generation;await load;
    if(stamp!==generation || !key || !files.length || !active(store)) return;
    if((memory.get(key)?.length || 0)+files.length>20) {status('每条消息最多可附 20 个文件。');return;}
    if(files.some(f=>f.size>sizeLimit)) {status('每个文件最多 200 MiB。');return;}
    const rows=files.map(blob=>({id:Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'),name:blob.name,blob}));
    status('');change(key,prev=>[...prev,...rows],durable);
    for(const row of rows) {
      if(stamp!==generation) break;
      const selected=memory.get(key)?.find(item=>item.id===row.id);
      if(selected && !usable(selected)) await upload(selected);
    }
  }
  picker.onchange=()=>{const files=Array.from(picker.files);picker.value='';void add(files);};
  input.addEventListener('dragover',e=>{if(key && [...(e.dataTransfer?.items || [])].some(i=>i.kind==='file' && !i.type.startsWith('image/'))) e.preventDefault();});
  for(const event of ['drop','paste']) input.addEventListener(event,e=>{
    const files=Array.from((e.dataTransfer || e.clipboardData)?.files || []).filter(f=>!f.type.startsWith('image/'));
    if(key && files.length){e.preventDefault();void add(files);}
  });
  return {button,el,update(draftKey,nextOwner,persist,range) {
    const enabled=active(store);
    button.hidden=el.hidden=!enabled;picker.disabled=!enabled;
    const next=enabled && nextOwner && draftKey && JSON.stringify([nextOwner,draftKey]);
    if(next===key && owner===nextOwner && durable===persist) return;
    for(const controller of jobs.values()) controller.abort();
    jobs.clear();generation++;const stamp=generation;
    if(nextOwner!==owner) memory.clear();
    key=next;owner=nextOwner;durable=persist;scope=range;load=undefined;status('');
    if(key && durable) load=drafts(key).then(rows=>{if(generation===stamp) memory.set(key,rows);})
      .catch(()=>{if(generation===stamp) status('文件草稿仅保留在当前页面。');})
      .finally(()=>{if(generation===stamp){load=undefined;paint();}});
    paint();
  },capture:()=>memory.get(key)||[],ready() {
    if(load || (memory.get(key)||[]).some(row=>!usable(row))) {paint();status('请先完成文件上传，或移除待上传文件。');return false;}
    return true;
  },expired(ctx) {
    if(ctx.owner!==owner || !ctx.files?.length) return;
    const ids=new Set(ctx.files.map(r=>r.uploadId));
    change(JSON.stringify([owner,ctx.key]),rows=>rows.map(r=>ids.has(r.uploadId)?{...r,uploadId:undefined}:r),durable);
  },accepted(ctx) {
    if(ctx.owner!==owner || !ctx.files?.length) return;
    const ids=new Set(ctx.files.map(r=>r.id));
    change(JSON.stringify([owner,ctx.key]),rows=>rows.filter(r=>!ids.has(r.id)),durable);
  }};
}

class MessageFiles extends HTMLElement {
  connectedCallback() {
    this.unsubscribe ??= this.source.store.subscribe(()=>this.refresh());
    this.refresh();
  }
  disconnectedCallback() {queueMicrotask(()=>{if(!this.isConnected){this.unsubscribe?.();this.unsubscribe=undefined;this.stop();}});}
  stop() {this.job?.abort();this.job=undefined;this.replaceChildren();this.visible=false;}
  valid() {const {api,owner,store}=this.source;return this.isConnected && active(store) && store.view.snapshotOwner===owner && api.draftOwner()===owner;}
  refresh() {
    this.hidden=!this.valid();
    if(this.hidden) {this.stop();return;}
    if(this.visible) return;
    this.visible=true;
    const {message}=this.source;
    const rows=message.files.map((f,i)=>Button({label:f.name+' · '+size(f.bytes),ariaLabel:'下载文件 '+f.name,kind:'ghost',size:'sm',onClick:()=>this.download(i)}));
    this.note=h('span',{class:'small',role:'status'});
    this.append(...(rows.length>4 ? [...rows.slice(0,3),h('details',null,h('summary',null,'其余 '+(rows.length-3)+' 个文件'),rows.slice(3))] : rows),this.note);
  }
  async download(index) {
    if(!this.valid()) return;
    const {api,message}=this.source;
    this.job?.abort();const job=this.job=new AbortController();
    this.note.textContent='正在下载…';
    try {
      const blob=await api.blob('/messages/'+encodeURIComponent(message.id)+'/files/'+index+'?conversationId='+encodeURIComponent(message.conversationId),job.signal);
      if(job!==this.job || !this.valid()) return;
      const url=URL.createObjectURL(blob);
      const link=h('a',{href:url,download:message.files[index].name});link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);this.note.textContent='';
    } catch(e) {if(job===this.job && this.valid()) this.note.textContent='下载失败：'+e.message;}
  }
}
customElements.define('sm-message-files',MessageFiles);
export function messageFiles(api,store,message) {
  if(!message.files?.length) return null;
  const node=document.createElement('sm-message-files');
  node.className='message-file-list';
  node.source={api,store,message,owner:api.draftOwner()};
  return node;
}
