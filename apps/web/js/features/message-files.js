import { h } from '../lib/dom.js';
import { attachmentDraftStore } from '../lib/attachment-drafts.js';
import { Button } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

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
      h('span',null,row.name+' · '+size(row.bytes ?? row.blob?.size ?? 0)),h('span',{class:'small muted'},jobs.has(row.id)?'正在上传':usable(row)?'已上传':'待上传'),
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
      const valid=()=>stamp===generation && !controller.signal.aborted && owner===api.draftOwner() && active(store);
      const params=new URLSearchParams({...scope,name:row.name});
      let blob=row.blob;
      if (!blob && row.sourceMessageId && Number.isInteger(row.sourceIndex)) {
        blob=await api.blob(filePath({id:row.sourceMessageId,conversationId:scope.conversationId},row.sourceIndex),controller.signal);
        if (!valid()) return;
        if (blob.size!==row.bytes) throw new Error('原文件大小已变化。');
      }
      if (!blob) throw new Error('原文件不可用，请重新选择文件。');
      const receipt=await api('/chat-files/uploads?'+params,{method:'PUT',body:blob,headers:{'Content-Type':row.mime || blob.type || 'application/octet-stream'},signal:controller.signal});
      if(!valid()) return;
      if(typeof receipt?.uploadId!=='string' || typeof receipt.sha256!=='string' || receipt.bytes!==blob.size ||
          (row.sourceMessageId && (receipt.sha256!==row.sha256 || receipt.name!==row.name || receipt.mime!==row.mime))) throw new Error('文件上传回执无效。');
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
  },prepareRestore(ctx,rows) {
    if (!Array.isArray(rows) || rows.length>20) throw new Error('每条消息最多可附 20 个文件。');
    if (!rows.length) return ()=>{};
    const stamp=generation;
    const check=()=>{
      if (!ctx.owner || ctx.owner!==owner || owner!==api.draftOwner() || !ctx.key || key!==JSON.stringify([owner,ctx.key]) ||
          ctx.conversation!==scope?.conversationId || ctx.projectId!==scope?.projectId || ctx.todoId!==scope?.todoId ||
          !active(store) || stamp!==generation || load) throw new Error('原会话的文件草稿不可用。');
    };
    check();
    const files=rows.map(({id,name,mime,bytes,sha256,uploadId,uploadedAt,sourceMessageId,sourceIndex})=>{
      if (typeof id!=='string' || !id || typeof name!=='string' || !name || typeof mime!=='string' || !mime ||
          !Number.isInteger(bytes) || bytes<0 || bytes>sizeLimit || typeof sha256!=='string' || !/^[a-f0-9]{64}$/.test(sha256) ||
          typeof uploadId!=='string' || !uploadId || !Number.isFinite(uploadedAt) ||
          typeof sourceMessageId!=='string' || !sourceMessageId || !Number.isInteger(sourceIndex) || sourceIndex<0 || sourceIndex>=20)
        throw new Error('原消息文件信息无效。');
      return {id,name,mime,bytes,sha256,uploadId,uploadedAt,sourceMessageId,sourceIndex};
    });
    const append=existing=>{
      const combined=[...existing],ids=new Set(existing.map(row=>row.id));
      for (const row of files) if (!ids.has(row.id)) {ids.add(row.id);combined.push(row);}
      if (combined.length>20) throw new Error('每条消息最多可附 20 个文件。');
      return combined;
    };
    append(memory.get(key)||[]);
    return ()=>{check();change(key,append,durable);};
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

const documentKinds = new Map(Object.entries({
  doc:'Word 文档', docx:'Word 文档', xls:'Excel 表格', xlsx:'Excel 表格',
  ppt:'PowerPoint 演示文稿', pptx:'PowerPoint 演示文稿', pages:'Pages 文稿',
  numbers:'Numbers 表格', key:'Keynote 演示文稿', rtf:'RTF 文档', pdf:'PDF 文档',
}));

function extension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function filePath(message, index, preview = false) {
  return '/messages/' + encodeURIComponent(message.id) + '/files/' + index +
    (preview ? '/preview' : '') + '?conversationId=' + encodeURIComponent(message.conversationId);
}

async function firstPage(thumbnail, label) {
  if (!['image/png','image/jpeg'].includes(thumbnail?.mime) || !thumbnail.data) return;
  const img = h('img', {alt:label, src:'data:' + thumbnail.mime + ';base64,' + thumbnail.data});
  try {
    await img.decode();
    return img;
  } catch { return; }
}

// Some thumbnail providers render white text on a black page. Average a small
// sample composited on white before deciding whether to use the type glyph.
function darkThumbnail(image) {
  const canvas = h('canvas', {width:8,height:8});
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0,0,8,8);
  ctx.drawImage(image,0,0,8,8);
  const {data} = ctx.getImageData(0,0,8,8);
  let light = 0;
  for (let i=0;i<data.length;i+=4) light += .299*data[i] + .587*data[i+1] + .114*data[i+2];
  return light / (64*255) < .35;
}

class MessageFiles extends HTMLElement {
  thumbs = new Map();
  connectedCallback() {
    this.unsubscribe ??= this.source.store.subscribe(()=>this.refresh());
    this.refresh();
  }
  disconnectedCallback() {queueMicrotask(()=>{if(!this.isConnected){this.unsubscribe?.();this.unsubscribe=undefined;this.stop();}});}
  stop() {
    this.job?.abort(); this.job=undefined;
    this.drawer?.close(); this.drawer=undefined;
    this.observer?.disconnect(); this.observer=undefined;
    for (const thumb of this.thumbs.values()) thumb.job?.abort();
    this.thumbs.clear();
    this.replaceChildren(); this.visible=false;
  }
  valid() {
    const {api,owner,store,message,webOrigin}=this.source;
    const currentAudience=webOrigin || store.view.connection==='online';
    const officeEnabled=message.role!=='assistant' || store.view.snapshot?.plugins?.some(p=>p.id==='office-documents' && p.status==='active');
    return officeEnabled && currentAudience && this.isConnected && !this.revoked && active(store) && store.view.snapshotOwner===owner && api.draftOwner()===owner;
  }
  refresh() {
    const {store,message}=this.source;
    const revoked=store.view.revokedAttachment?.messageId;
    if (revoked && (revoked===message.id || (message.role==='assistant' && revoked===message.replyTo))) this.revoked=true;
    const change=store.view.feishuBotChange;
    if (change && this.lastBotChange!==change && !this.source.webOrigin) {
      this.stop();
      // After a binding change, require an explicit fresh preview request.
      this.suppressAuto=true;
    }
    this.lastBotChange=change;
    this.hidden=!this.valid();
    if(this.hidden) {this.stop();return;}
    if(this.visible) return;
    this.visible=true;
    this.observer = new IntersectionObserver(entries=>{
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const thumb = this.thumbs.get(entry.target);
        if (thumb && !thumb.done && !thumb.job && this.shown(entry.target)) void this.loadThumb(entry.target,thumb);
      }
    });
    let documentCount = 0;
    const rows = message.files.map((file,index)=>{
      const ext = extension(file.name);
      const kind = documentKinds.get(ext);
      const badge = h('span',{class:'message-file-glyph','aria-hidden':'true'},ext.slice(0,7).toUpperCase() || '文件');
      const preview = h('button',{type:'button',class:'message-file-preview','aria-label':'预览文件 '+file.name,onClick:()=>this.preview(index)},
        badge,h('span',{class:'message-file-caption'},h('strong',null,file.name),
          h('small',{class:'muted'},[kind || ext.toUpperCase() || '文件',size(file.bytes)].join(' · '))));
      if (!this.suppressAuto && kind && ++documentCount <= 6) this.thumbs.set(preview,{index,badge});
      return h('div',{class:'message-file-card'},preview,Button({label:'下载',ariaLabel:'下载文件 '+file.name,kind:'ghost',size:'sm',onClick:()=>this.download(index)}));
    });
    this.note=h('span',{class:'small',role:'status'});
    const more = rows.length>4 && h('details',null,h('summary',null,'其余 '+(rows.length-3)+' 个文件'),rows.slice(3));
    this.append(...(more ? [...rows.slice(0,3),more] : rows),this.note);
    const watch = () => {
      for (const [card,thumb] of this.thumbs) {
        if (thumb.done) continue;
        if (this.shown(card)) this.observer?.observe(card);
        else {
          this.observer?.unobserve(card);
          thumb.job?.abort(); thumb.job=undefined;
        }
      }
    };
    if (more) more.addEventListener('toggle',watch);
    watch();
  }
  shown(card) {
    const fold = card.closest('details');
    return !fold || fold.open;
  }
  clearThumbnails() {
    this.suppressAuto=true;
    this.observer?.disconnect();
    for (const [card,thumb] of this.thumbs) {
      thumb.job?.abort();
      const image=card.querySelector('img');
      if (image) image.replaceWith(thumb.badge);
    }
    this.thumbs.clear();
  }
  async loadThumb(card,thumb) {
    const {api,message}=this.source;
    const job = thumb.job = new AbortController();
    const valid = () => this.valid() && !job.signal.aborted && this.shown(card) && this.thumbs.get(card)===thumb;
    try {
      if (!valid()) return;
      const result = await api(filePath(message,thumb.index,true),{signal:job.signal});
      if (!valid()) return;
      const image = await firstPage(result.thumbnail,'首页缩略图 '+message.files[thumb.index].name);
      if (valid() && image && !darkThumbnail(image)) thumb.badge.replaceWith(image);
    } catch(e) {
      if (valid() && [403,404].includes(e.status)) this.clearThumbnails();
    }
    finally {
      if (thumb.job===job) {
        thumb.job=undefined;
        if (valid()) { thumb.done=true; this.observer?.unobserve(card); }
      }
    }
  }
  async preview(index) {
    if (!this.valid()) return;
    this.drawer?.close();
    const {api,message}=this.source, file=message.files[index];
    const job = new AbortController();
    const status=h('p',{role:'status',class:'small muted'},'正在读取文件预览…');
    const content=h('div',{class:'message-file-detail'},status);
    const drawer=openDrawer({title:'文件预览',subtitle:file.name+' · '+size(file.bytes),body:content,wide:true,
      footer:Button({label:'下载原文件',onClick:()=>this.download(index)}),
      onClose:()=>{job.abort();content.replaceChildren();if (this.drawer===drawer) this.drawer=undefined;}});
    this.drawer=drawer;
    const valid = () => this.valid() && drawer.el.open && this.drawer===drawer && !job.signal.aborted;
    try {
      // Opening the drawer rechecks the source even if this card already has a thumbnail.
      const result=await api(filePath(message,index,true),{signal:job.signal});
      if(!valid()) return;
      const image=await firstPage(result.thumbnail,'文件首页 '+file.name);
      if(!valid()) return;
      const text=typeof result.text==='string' ? result.text : '';
      content.replaceChildren();
      if (image) content.append(image);
      if (text) content.append(h('pre',null,text));
      if (result.truncated) content.append(h('p',{class:'small muted'},'仅显示部分内容，下载原文件可查看全文。'));
      if (result.note) content.append(h('p',{class:'small muted'},result.note));
      if (!image && !text && !result.note) content.append(h('p',{class:'muted'},'暂无可显示的预览，请下载原文件。'));
    } catch(e) {
      if (valid()) {
        if ([403,404].includes(e.status)) this.clearThumbnails();
        content.replaceChildren(h('p',{role:'alert',class:'text-danger'},'预览失败：'+e.message));
      }
    }
  }
  async download(index) {
    if(!this.valid()) return;
    const {api,message}=this.source;
    this.job?.abort();const job=this.job=new AbortController();
    this.note.textContent='正在下载…';
    try {
      const blob=await api.blob(filePath(message,index),job.signal);
      if(job!==this.job || !this.valid()) return;
      const url=URL.createObjectURL(blob);
      const link=h('a',{href:url,download:message.files[index].name});link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);this.note.textContent='';
    } catch(e) {if(job===this.job && this.valid()) this.note.textContent='下载失败：'+e.message;}
  }
}
customElements.define('sm-message-files',MessageFiles);
export function messageFiles(api,store,message,history=store.view.snapshot?.messages,container) {
  if(!message.files?.length) return null;
  // Assistant replies inherit the audience of the original turn. A paginated
  // view can lack that input, in which case keep the live-channel checks.
  const origin=message.role==='assistant'
    ? history?.find(m=>m.id===message.replyTo && m.role==='user' && m.conversationId===message.conversationId)
    : message;
  const webOrigin=origin?.directWebInput===true, owner=api.draftOwner();
  // A status update can replace the bubble while its authorized preview is
  // open. Move the same card only within that list and for identical bytes.
  const existing=container?.querySelector('[data-id="'+CSS.escape(message.id)+'"] sm-message-files');
  const old=existing?.source;
  if (old && old.owner===owner && old.webOrigin===webOrigin && old.message.conversationId===message.conversationId &&
      old.message.role===message.role && old.message.replyTo===message.replyTo &&
      old.message.projectId===message.projectId && old.message.todoId===message.todoId &&
      JSON.stringify(old.message.files)===JSON.stringify(message.files)) return existing;
  const node=document.createElement('sm-message-files');
  node.className='message-file-list';
  node.lastBotChange=store.view.feishuBotChange;
  node.source={api,store,message,webOrigin,owner};
  return node;
}
