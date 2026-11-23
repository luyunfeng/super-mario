import {h, replace} from '../lib/dom.js';
import {Button, Field, Input, Select} from '../ui/kit.js';

const lanes = [
  ['needs_you','需要你处理'], ['working','执行中'], ['review','待验收'], ['planned','待办'], ['idle','空闲'],
];

export function createBoardFlow({api,store,router,authorized,close}) {
  const search = Input({placeholder:'筛选自动分组', 'aria-label':'筛选自动分组', oninput:filtersChanged});
  const lane = Select({options:[['','所有状态'],...lanes], onchange:filtersChanged});
  const archive = Select({options:[['open','未归档'],['archived','仅归档卡片']], onchange:filtersChanged});
  const machine = Select({options:[['','全部机器']], onchange:filtersChanged});
  let machineSignature;
  const notice = h('p',{role:'status',class:'muted small'});
  const groupList = h('div',{class:'form-row',style:{alignItems:'start',gridTemplateColumns:'repeat(auto-fit,minmax(min(240px,100%),1fr))'}});
  const more = Button({label:'查看更多工作项',size:'sm',onClick:() => load(nextOffset)});
  const refresh = Button({label:'刷新自动分组',size:'sm',onClick:() => invalidate(true)});
  const el = h('div',{class:'stack',hidden:true},
    h('div',{class:'row row--wrap'},search,Field({label:'工作状态',control:lane}),Field({label:'显示范围',control:archive}),Field({label:'机器',control:machine}),refresh),
    notice,groupList,more);
  let active=false, generation=0, timer, flight, dirty=false, nextOffset=null, counts={};
  let signature, lastSnapshot, changeEvent, connection;
  const items = new Map();

  function link(label,href) {
    return h('a',{href,onclick(event){
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (authorized()) { close(); router.go(href); }
    }},label);
  }
  function row(item) {
    const projectId=item.projectId || 'all';
    const availableProject=store.view.snapshot?.projects?.some(p=>p.id===item.projectId && !p.archivedAt);
    let primary;
    if (item.kind==='card' && availableProject) primary=link('打开项目 '+item.title,router.href('projects',projectId,'workspace'));
    if (item.kind==='todo') primary=link('打开待办 '+item.title,router.href('projects',availableProject ? projectId : 'all','todos','detail',item.id));
    if (item.kind==='run') primary=link('打开执行 '+item.title,router.href('projects',availableProject ? projectId : 'all','runs',item.runId ?? item.id));
    return h('div',{class:'item'},h('div',{class:'item__main'},primary ?? h('strong',{},item.title),
      h('span',{class:'item__meta'},item.reason),
      item.kind!=='run' && item.runId && link('查看关联执行',router.href('projects',availableProject ? projectId : 'all','runs',item.runId))),
      item.pinned && h('span',{class:'pill'},'已置顶'));
  }
  function paint() {
    replace(groupList,lanes.filter(([id])=>!lane.value || lane.value===id).map(([id,title])=>{
      const group=[...items.values()].filter(item=>item.lane===id);
      return h('section',{class:'card','aria-label':title},h('header',{class:'card__head'},h('h3',{},title),h('span',{class:'small muted'},String(counts[id] ?? 0))),
        h('div',{class:'card__body list'},group.map(row),!group.length && h('span',{class:'muted small'},counts[id] ? '查看更多工作项以读取本组。' : '暂无工作项')));
    }));
    more.hidden=nextOffset===null;
  }
  function clear() {
    items.clear(); counts={}; nextOffset=null; groupList.replaceChildren(); more.hidden=true;
  }
  function schedule(delay) {
    if (flight || timer !== undefined) return;
    timer=setTimeout(()=>{timer=undefined;void load(0);},delay);
  }
  function invalidate(reset=false) {
    if (!active || !authorized()) return;
    dirty=true; more.disabled=true;
    if (reset) {
      generation++; clearTimeout(timer); timer=undefined;
      clear(); flight?.abort();
    }
    // Debounce typing, but let ongoing state updates show the current response
    // and coalesce into just one subsequent read of the same filter.
    notice.textContent='正在读取自动分组…';
    schedule(reset ? 180 : 350);
  }
  function filtersChanged() { invalidate(true); }
  async function load(offset) {
    if (!active || !authorized() || flight || offset===null) return;
    const stamp=generation, controller=new AbortController();
    flight=controller; dirty=false; more.disabled=true;
    notice.textContent='正在读取自动分组…';
    try {
      const data=await api('/workspace-board',{method:'POST',signal:controller.signal,body:{action:'flow',
        query:search.value.trim() || undefined,lane:lane.value || undefined,machineId:machine.value || undefined,archived:archive.value==='archived',limit:25,offset}});
      if (stamp!==generation || !active || !authorized()) return;
      if (offset===0) items.clear();
      for (const item of data.items) items.set(JSON.stringify([item.kind,item.id]),item);
      counts=data.counts; nextOffset=data.nextOffset ?? null;
      notice.textContent='已显示 '+items.size+' 项';
      paint();
    } catch (error) {
      if (stamp===generation && active && authorized()) notice.textContent=error.message+'。可重新读取。';
    } finally {
      if (flight===controller) flight=undefined;
      if (active && authorized()) {
        more.disabled=dirty;
        if (dirty) schedule(250);
      }
    }
  }
  function update(force=false) {
    if (!active || !authorized()) return;
    const view=store.view, snapshot=view.snapshot;
    let next=signature;
    if (snapshot!==lastSnapshot) {
      const machines=new Map();
      for (const p of snapshot.projects ?? []) if (p.workspace?.machineId) machines.set(p.workspace.machineId,p.workspace.machineId+'（项目绑定）');
      for (const t of snapshot.todos ?? []) if (t.responsibleSession?.machineId && !machines.has(t.responsibleSession.machineId)) machines.set(t.responsibleSession.machineId,t.responsibleSession.machineId+'（负责会话）');
      for (const r of snapshot.runs ?? []) if (r.machineId && !machines.has(r.machineId)) machines.set(r.machineId,r.machineId+'（执行记录）');
      for (const m of snapshot.machines ?? []) machines.set(m.id,(m.name || m.id)+(m.online ? '' : '（离线）'));
      const previous=machine.value;
      if (previous && !machines.has(previous)) machines.set(previous,previous+'（当前不可用）');
      const options=[['','全部机器'],...machines];
      const encoded=JSON.stringify(options);
      if (encoded!==machineSignature) {
        replace(machine,options.map(([id,name])=>h('option',{value:id},name)));
        machine.value=previous; machineSignature=encoded;
      }
      next=JSON.stringify([machineSignature,
        snapshot.projects?.map(p=>[p.id,p.name,p.archivedAt,p.workspace?.machineId,p.workspace?.cwd]),snapshot.runs?.map(r=>[r.id,r.status,r.updatedAt,r.projectId,r.todoId,r.machineId]),
        snapshot.todos?.map(t=>[t.id,t.updatedAt,t.completedAt,t.projectId,t.waitingOn,t.responsibleSession?.runId,t.responsibleSession?.machineId]),snapshot.approvals?.map(a=>[a.id,a.status,a.version]),
        view.attention?.map(a=>[a.id,a.version,a.status]),snapshot.signals?.map(s=>[s.id,s.state,s.status])]);
      lastSnapshot=snapshot;
    }
    const key=[view.workspaceBoardRevision,view.workspaceBoardFlowChange];
    const changed=force || next!==signature || changeEvent?.[0]!==key[0] || changeEvent?.[1]!==key[1] || (connection!=='online' && view.connection==='online');
    signature=next; changeEvent=key; connection=view.connection;
    if (changed) invalidate();
  }
  function hide() {
    active=false; el.hidden=true; dirty=false; generation++;
    clearTimeout(timer); timer=undefined; flight?.abort(); clear(); notice.textContent='';
  }
  return {el,update,hide,show(){ active=true; el.hidden=false; update(true); }};
}
