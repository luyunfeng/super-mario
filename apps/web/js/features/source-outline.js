// Add navigation to the original text without changing its line numbers or interpreting
// source markup as HTML. Duplicate titles are identified by line, not by their text.
import {h} from '../lib/dom.js';

export function displaySourceText(text, outline, content, citationLine, headings = []) {
  const lines=content.split(/\r\n|\r|\n/);
  const targets=[], fragment=document.createDocumentFragment();
  const byLine=new Map(headings.map(heading=>[heading.line,heading]));
  let start=0,citation;
  for(let i=0;i<lines.length;i++) {
    const raw=lines[i],heading=byLine.get(i+1),title=heading?.title;
    if(!title && i+1!==citationLine) continue;
    if(start<i) fragment.append(lines.slice(start,i).join('\n')+'\n');
    const anchor=h(i+1===citationLine?'mark':'span',{},raw);
    if(title) {
      const level=heading.level;
      anchor.tabIndex=-1;
      anchor.setAttribute('role','heading');
      anchor.setAttribute('aria-level',String(level));
      targets.push({anchor,title,level});
    }
    if(i+1===citationLine) citation=anchor;
    fragment.append(anchor);
    if(i+1<lines.length) fragment.append('\n');
    start=i+1;
  }
  if(start<lines.length) fragment.append(lines.slice(start).join('\n'));
  text.replaceChildren(fragment);
  outline.replaceChildren();
  if(targets.length) {
    const nav=h('nav',{'aria-label':'文档大纲',class:'stack'});
    const filter=h('input',{type:'search',class:'input',placeholder:'筛选标题','aria-label':'筛选文档标题'});
    const empty=h('p',{role:'status',hidden:true},'没有匹配的标题');
    filter.addEventListener('input',()=>{
      const query=filter.value.trim().toLowerCase();
      let matches=0;
      for(const button of nav.children) {
        button.hidden=!button.textContent.toLowerCase().includes(query);
        if(!button.hidden) matches++;
      }
      empty.hidden=matches>0;
    });
    const menu=h('details',{},h('summary',{},'文档大纲'),filter,nav,empty);
    const top=targets.reduce((min,target)=>Math.min(min,target.level),6);
    for(const {anchor,title,level} of targets) {
      nav.append(h('button',{class:'btn btn--ghost btn--sm',type:'button',style:{justifySelf:'start',marginInlineStart:(Math.min(3,level-top)*0.8)+'rem'},
        onclick(){
          menu.open=false;anchor.focus({preventScroll:true});
          anchor.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
        }},title));
    }
    outline.append(menu);
  }
  return citation;
}
