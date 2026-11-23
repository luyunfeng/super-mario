import {h,replace} from '../lib/dom.js';
import {Button} from '../ui/kit.js';
import {openDrawer} from '../ui/overlay.js';

export function createWebImageExport({api,source,redraw}) {
  const selected=new Set();
  let choosing=false,drawer;
  const enter=Button({label:'导出消息图片',size:'sm',onClick:()=>{
    if(!source())return;
    choosing=true;paint();redraw();
  }});
  const count=h('span',{class:'small',role:'status'});
  const preview=Button({label:'预览图片',size:'sm',onClick:open});
  const controls=h('div',{class:'row row--wrap'},count,preview,Button({label:'取消选择',kind:'ghost',size:'sm',onClick:()=>{
    clear();paint();redraw();
  }}));
  function clear(){
    choosing=false;selected.clear();drawer?.close();
  }
  function paint(){
    const enabled=!!source();
    if(!enabled)clear();
    enter.hidden=!enabled || choosing;controls.hidden=!enabled || !choosing;
    preview.disabled=!selected.size;count.textContent='已选择 '+selected.size+' 条消息';
  }
  function checkbox(row){
    if(!choosing || row.status!=='done' || row.stoppedByUser || row.queueState || !['user','assistant'].includes(row.role) ||
      row.origin==='notification' || row.origin==='result')return null;
    const check=h('input',{type:'checkbox',checked:selected.has(row.id),'aria-label':'选择导出 '+(row.text?.slice(0,48) || '附件消息'),
      onchange:()=>{
        if(!source() || !choosing)return;
        if(check.checked && selected.size>=100){check.checked=false;count.textContent='每次最多选择 100 条消息。';return;}
        if(check.checked)selected.add(row.id);else selected.delete(row.id);
        paint();
      }});
    return h('label',{class:'row small'},check,'导出');
  }
  function open(){
    const range=source(),ids=[...selected];
    if(!range || !ids.length || drawer?.el.open)return;
    const questions=h('input',{type:'checkbox'}),heading=h('input',{type:'checkbox',checked:true}),dates=h('input',{type:'checkbox',checked:true});
    const option=(control,label)=>h('label',{class:'row'},control,label);
    const status=h('p',{class:'small',role:'status'}),output=h('div',{class:'stack','aria-label':'PNG 预览'});
    let request,urls=[];
    const panel=openDrawer({title:'导出消息图片',subtitle:range.title,wide:true,body:[
      h('div',{class:'row row--wrap'},option(questions,'附上对应提问'),option(heading,'显示对话标题'),option(dates,'显示日期')),status,output],
      footer:[],onClose:()=>{discard();if(drawer===panel)drawer=undefined;}});
    drawer=panel;
    function discard(){
      request?.abort();for(const url of urls)URL.revokeObjectURL(url);
      urls=[];replace(output);replace(panel.foot);
    }
    function current(){
      const now=source();
      return panel.el.open && now?.id===range.id && now.owner===range.owner && now.projectId===range.projectId &&
        now.imagesEnabled===range.imagesEnabled && now.filesEnabled===range.filesEnabled;
    }
    panel.check=()=>{if(!current())panel.close();};
    async function load(){
      discard();if(!current())return;
      const controller=request=new AbortController(),signal=controller.signal;
      const valid=()=>!signal.aborted && current();
      status.textContent='正在生成图片…';
      try{
        const result=await api('/conversation-export',{method:'POST',signal,body:{action:'preview_image',webThreadId:range.id,
          ...(range.projectId && {projectId:range.projectId}),messageIds:ids,includeQuestions:questions.checked}});
        if(!valid())return;
        const {renderConversationPNGs}=await import('./conversation-export-png.js');
        if(!valid())return;
        const pages=await renderConversationPNGs({api,conversationId:'web:'+range.id,title:result.title,messages:result.messages,
          heading:heading.checked,dates:dates.checked,signal});
        if(!valid())return;
        urls=pages.map(blob=>URL.createObjectURL(blob));
        const filename=heading.checked && result.title
          ? '对话摘录-'+result.title.replace(/[^\p{L}\p{N}_-]/gu,'-').slice(0,48) : '对话摘录';
        function download(index){
          if(valid())h('a',{href:urls[index],download:filename+'-'+(index+1)+'.png'}).click();
        }
        replace(output,pages.map((blob,i)=>{
          const label='第 '+(i+1)+' 页';
          return h('section',{class:'stack'},h('img',{src:urls[i],alt:'PNG 预览 '+label,style:{maxWidth:'100%',height:'auto'}}),
            pages.length>1 && h('small',{class:'muted'},label+'，共 '+pages.length+' 页'),
            h('div',{class:'row row--wrap'},Button({label:'复制'+label,size:'sm',onClick:async()=>{
              if(!valid())return;
              try{await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);if(valid())status.textContent='已复制'+label+'。';}
              catch{if(valid())status.textContent='浏览器无法复制图片，请下载 PNG。';}
            }}),Button({label:'下载'+label,size:'sm',onClick:()=>download(i)})));
        }));
        if(pages.length>1)replace(panel.foot,Button({label:'下载全部 PNG',onClick:()=>pages.forEach((_,i)=>download(i))}));
        status.textContent='共 '+result.messages.length+' 条消息 · '+pages.length+' 页';
      }catch(error){
        if(valid())replace(status,error.message+' ',Button({label:'重试',size:'sm',onClick:load}));
      }
    }
    questions.onchange=heading.onchange=dates.onchange=load;void load();
  }
  return {enter,controls,checkbox,reset(){clear();enter.hidden=true;controls.hidden=true;},update(){paint();drawer?.check();}};
}
