import {h,replace} from '../lib/dom.js';
import {formatDate} from '../lib/format.js';
import {Button,Input} from '../ui/kit.js';

export function createInboxRelations({api,store,id,openSource,active}) {
  const owner=api.draftOwner(), path='/inbox/'+encodeURIComponent(id);
  const el=h('section',{class:'stack','aria-label':'同一事项'});
  const search=Input({type:'search','aria-label':'搜索关联收件',placeholder:'搜索标题、来源或发言人'});
  const choices=h('div',{class:'stack'});
  let tree,editing=false,busy=false,loading=false,revision=0,limit=30,note='',readError='',signature;
  const current=()=>active() && api.draftOwner()===owner;
  const button=(label,onClick)=>Button({label,size:'sm',disabled:busy,onClick});
  const caption=item=>item.title+(item.archivedAt?'（已归档）':'');
  function candidates() {
    const items=store.view.snapshot?.inbox ?? [];
    const byId=new Map(items.map(row=>[row.id,row]));
    const excluded=new Set([id,...(tree?.children??[]).map(row=>row.id)]);
    const query=search.value.trim().toLowerCase();
    const matches=items.filter(row=>{
      if(row.archivedAt || row.todoId || row.id===tree?.item.parentInboxId || excluded.has(row.id)) return false;
      const visited=new Set();
      for(let node=row;node;node=byId.get(node.parentInboxId)){
        if(excluded.has(node.id) || visited.has(node.id)) return false;
        visited.add(node.id);
      }
      return !query || [row.title,row.source,row.sender,row.origin?.chatName,row.origin?.senderName].some(value=>value?.toLowerCase().includes(query));
    });
    replace(choices,...matches.slice(0,limit).map(row=>h('div',{class:'row row--wrap'},
      button(caption(row),()=>save(row.id)),h('span',{class:'small muted'},[
        row.origin?.chatName || row.source,row.origin?.senderName || row.sender,formatDate(row.receivedAt ?? row.updatedAt,true),
      ].filter(Boolean).join(' · ')))),
      matches.length>limit && button('更多候选',()=>{limit+=30;candidates();}),
      !matches.length && h('p',{class:'small muted'},'没有匹配的收件。'));
  }
  search.addEventListener('input',()=>{limit=30;candidates();});
  function draw() {
    if(!current()) return;
    const section=(label,items)=>items.length && h('div',{class:'stack'},h('strong',null,label),
      items.map(row=>button(caption(row),()=>openSource(row.id))));
    replace(el,h('h4',null,'同一事项'),note && h('p',{role:'status'},note),
      readError && h('p',{role:'alert'},readError),readError && button('重新读取关联',load),
      loading && !tree && h('p',{role:'status'},'正在读取关联…'),
      tree && [section('上级收件',tree.ancestors)||null,section('下级收件',tree.children)||null,
        !tree.ancestors.length && !tree.children.length && h('p',{class:'small muted'},'尚未关联其他收件。'),
        h('div',{class:'row row--wrap'},button(editing?'取消选择':'关联到另一条收件',()=>{
          editing=!editing;draw();if(editing)search.focus();
        }),tree.item.parentInboxId && button('解除上级关联',()=>save(null))),
        editing && [search,choices]]);
    if(editing && tree) candidates();
  }
  async function load() {
    const generation=++revision;
    loading=true;readError='';draw();
    try {
      const data=await api.get(path+'/tree');
      if(generation===revision && current()) tree=data;
    } catch(error) {
      if(generation===revision && current()) {tree=undefined;readError='读取关联失败：'+error.message;}
    } finally {
      if(generation===revision){loading=false;draw();}
    }
  }
  async function save(parentId) {
    if(!tree || busy || !current()) return;
    const version=tree.item.version;
    busy=true;note='';draw();
    try {
      await api.put(path+'/parent',{parentId,version});
      if(!current()) return;
      editing=false;search.value='';
    } catch(error) {
      if(!current()) return;
      note=error.status===409?'关联存在冲突，请核对最新关系后再操作。':
        error.status?'关联未保存：'+error.message:'保存结果未知，请核对最新关系。';
    } finally {
      if(current()) {
        try {await store.refresh();} catch { /* The tree query below reads the actual saved relation. */ }
        if(current()){await load();busy=false;draw();}
      }
    }
  }
  function update(items) {
    // A child may move to another parent without changing the selected item's version.
    const next=JSON.stringify(items.map(row=>[row.id,row.version,row.parentInboxId]));
    if(next===signature) return;
    signature=next;
    if(!busy) void load();
  }
  return {el,update};
}
