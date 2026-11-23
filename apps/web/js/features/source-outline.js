// Add navigation to the original text without changing its line numbers or interpreting
// source markup as HTML. Duplicate titles are identified by line, not by their text.
import {h} from '../lib/dom.js';

export function displaySourceText(text, outline, content, citationLine) {
  const lines=content.split('\n');
  const targets=[], fragment=document.createDocumentFragment();
  let fence='',start=0,citation;
  for(let i=0;i<lines.length;i++) {
    const raw=lines[i],line=raw.replace(/\r$/,'');
    let heading;
    if (fence) {
      const end=line.match(/^ {0,3}(`+|~+)[ \t]*$/)?.[1];
      if (end?.startsWith(fence)) fence='';
    } else {
      const open=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if(open && !(open[1][0]==='`' && open[2].includes('`'))) fence=open[1];
      else heading=line.match(/^ {0,3}(#{1,6})[ \t]+(.+)$/);
    }
    const title=heading?.[2].replace(/(?:^|[ \t]+)#+[ \t]*$/,'').trim();
    if(!title && i+1!==citationLine) continue;
    if(start<i) fragment.append(lines.slice(start,i).join('\n')+'\n');
    const anchor=h(i+1===citationLine?'mark':'span',{},raw);
    if(title) {
      const level=heading[1].length;
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
    const menu=h('details',{},h('summary',{},'文档大纲'),nav);
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
