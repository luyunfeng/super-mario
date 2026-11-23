import {h,replace} from '../lib/dom.js';
import {Button,Field,Input} from '../ui/kit.js';

export function commentMentions(input,search,isCurrent) {
  let picked=[],before,composition,stamp=0,controller;
  const query=Input({type:'search'});
  const results=h('div',{class:'stack'}),status=h('p',{class:'small',role:'status'});
  const selected=h('p',{class:'small',hidden:true});
  const title=p=>p.name+'（'+p.openId+'）';
  function showSelected(){
    selected.hidden=!picked.length;
    selected.textContent=picked.length?'将提及：'+picked.map(title).join('、'):'';
  }
  // Only trust edits with a known replacement range; matching a name elsewhere can notify the wrong person.
  function replaceRange(start,end,length){
    const shift=length-(end-start);
    picked=picked.flatMap(p=>{
      if(p.start+p.name.length+1<=start) return [p];
      if(p.start>=end) return [{...p,start:p.start+shift}];
      return [];
    });
    showSelected();
  }
  input.addEventListener('beforeinput',event=>{
    before={value:input.value,start:input.selectionStart,end:input.selectionEnd,type:event.inputType};
  });
  input.addEventListener('input',()=>{
    if(composition) return;
    const old=before;before=undefined;
    if(old){
      let {start,end}=old;
      const delta=input.value.length-old.value.length;
      if(start===end && delta<0 && old.type==='deleteContentBackward') start+=delta;
      if(start===end && delta<0 && old.type==='deleteContentForward') end-=delta;
      const inserted=end-start+delta;
      if(start>=0 && end<=old.value.length && inserted>=0 && /^(?:insertText|insertFromPaste|insertLineBreak|deleteByCut|deleteContentBackward|deleteContentForward)$/.test(old.type) &&
         old.value.slice(0,start)===input.value.slice(0,start) && old.value.slice(end)===input.value.slice(start+inserted)){
        replaceRange(start,end,inserted);return;
      }
    }
    picked=[];showSelected();
  });
  let inline,people=[],index=0,timer,composing=false;
  const popup=h('div',{class:'stack',role:'listbox','aria-label':'匹配的飞书人员',hidden:true});
  const menuId='comment-people-'+Math.random().toString(36).slice(2);
  popup.id=menuId;input.setAttribute('aria-controls',menuId);
  function clearResults(){
    stamp++;controller?.abort();controller=undefined;clearTimeout(timer);inline=undefined;people=[];index=0;popup.hidden=true;
    input.removeAttribute('aria-activedescendant');
    popup.replaceChildren();results.replaceChildren();status.textContent='';
  }
  function choose(person){
    if(!isCurrent()) return;
    let start=input.selectionStart,end=input.selectionEnd;
    if(inline) {
      if(end!==inline.end || start!==end || input.value.slice(inline.start,end)!=='@'+inline.term){clearResults();return;}
      start=inline.start;
    }
    const mention='@'+person.name;
    const followingSpace=/^\s/u.test(input.value.slice(end));
    const insertion=followingSpace?mention:mention+' ';
    replaceRange(start,end,insertion.length);
    input.setRangeText(insertion,start,end,'end');
    const caret=start+mention.length+1;
    input.setSelectionRange(caret,caret);
    picked.push({openId:person.openId,name:person.name,start,proof:person.proof});
    picked.sort((a,b)=>a.start-b.start);
    showSelected();query.value='';clearResults();input.focus();
  }
  function highlight(){
    Array.from(popup.querySelectorAll('[role=option]')).forEach((option,i)=>{
      option.setAttribute('aria-selected',String(i===index));option.classList.toggle('is-active',i===index);
    });
    if(people[index]) input.setAttribute('aria-activedescendant',menuId+'-'+index);
  }
  async function find(term,request,atCaret){
    if(!term || Array.from(term).length>50 || !isCurrent()) return;
    const active=new AbortController();
    controller=active;
    // A request may outlive a drawer closed by navigation, even without a final input blur.
    const drawer=input.closest('dialog');
    const closeDrawer=()=>clearResults();
    drawer?.addEventListener('close',closeDrawer,{signal:active.signal});
    const target=atCaret?popup:results;
    try {
      const data=await search(term,active.signal);
      if(request!==stamp || !isCurrent()) return;
      people=data.people;
      replace(target,people.map((p,i)=>{
        const option=Button({label:title(p)+(p.department?' · '+p.department:''),size:'sm',onClick:()=>choose(p)});
        if(atCaret){
          option.id=menuId+'-'+i;option.setAttribute('role','option');
          option.addEventListener('mousedown',event=>event.preventDefault());
        }
        return option;
      }));
      const note=data.truncated?'仅显示部分匹配人员，请缩小搜索范围。':people.length?'':'没有匹配的人员。';
      if(atCaret){
        if(note) popup.append(h('p',{role:'status'},note));
        popup.hidden=false;highlight();
      } else status.textContent=note;
    } catch(error){if(request===stamp && isCurrent()){
      if(atCaret){replace(popup,h('p',{role:'status'},error.message));popup.hidden=false;}
      else status.textContent=error.message;
    }} finally {
      drawer?.removeEventListener('close',closeDrawer);
      if(controller===active) controller=undefined;
    }
  }
  function searchQuery(){clearResults();return find(query.value.trim(),stamp,false);}
  function atCaret(){
    clearResults();
    if(composing || input.selectionStart!==input.selectionEnd) return;
    const end=input.selectionEnd,match=/(^|[^A-Za-z0-9._%+-])@([^\s@]{1,50})$/u.exec(input.value.slice(0,end));
    if(!match) return;
    const term=match[2],start=end-term.length-1;
    if(picked.some(p=>p.start===start)) return;
    inline={start,end,term};
    const request=stamp;
    timer=setTimeout(()=>void find(term,request,true),250);
  }
  input.addEventListener('input',atCaret);
  input.addEventListener('compositionstart',()=>{
    composing=true;clearResults();
    composition={value:input.value,start:input.selectionStart,end:input.selectionEnd};
  });
  input.addEventListener('compositionend',()=>{
    const old=composition;composition=undefined;composing=false;before=undefined;
    if(old){
      const inserted=old.end-old.start+input.value.length-old.value.length;
      if(inserted>=0 && old.value.slice(0,old.start)===input.value.slice(0,old.start) &&
         old.value.slice(old.end)===input.value.slice(old.start+inserted)){
        replaceRange(old.start,old.end,inserted);
      } else {picked=[];showSelected();}
    }
    atCaret();
  });
  input.addEventListener('click',clearResults);
  input.addEventListener('blur',()=>{if(inline) clearResults();});
  input.addEventListener('keydown',event=>{
    if(composing || event.isComposing || !inline) return;
    if(event.key==='Escape'){event.preventDefault();clearResults();return;}
    if(people.length && ['ArrowDown','ArrowUp','Enter'].includes(event.key)){
      event.preventDefault();
      if(event.key==='Enter'){choose(people[index]);return;}
      index=(index+(event.key==='ArrowDown'?1:-1)+people.length)%people.length;highlight();
    } else if(['ArrowLeft','ArrowRight','Home','End','Tab'].includes(event.key)) clearResults();
  });
  query.addEventListener('input',clearResults);
  query.addEventListener('keydown',event=>{if(event.key==='Enter' && !event.isComposing){event.preventDefault();void searchQuery();}});
  const el=h('div',{class:'stack'},popup,h('details',{},h('summary',{},'提及人员'),Field({label:'搜索飞书人员',control:query}),
    Button({label:'搜索人员',size:'sm',onClick:searchQuery}),status,results),selected);
  return {el,close:clearResults,values:()=>picked.filter(p=>input.value.startsWith('@'+p.name,p.start))};
}
