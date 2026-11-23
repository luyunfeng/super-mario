import { h, replace, readLocal, writeLocal } from '../lib/dom.js';
import { Button, Check, Field, Input, Select } from '../ui/kit.js';
import { createBoardFlow } from './workspace-board-flow.js';
import { openWorkspaceBoardHistory } from './workspace-board-history.js';
import { confirmDialog, openDrawer } from '../ui/overlay.js';

export function workspaceBoardEnabled(api, store) {
  return !store.view.unauthorized && store.view.snapshotOwner === api.draftOwner() &&
    !!store.view.snapshot?.plugins?.some(p => p.id === 'workspace-board' && p.status === 'active');
}

// Restore successors first, including original neighbours hidden by the current filter.
function inverseBatch(cards, changes) {
  const byId = new Map(changes.map(change => [change.id, change]));
  const successor = new Map();
  const inverse = [];
  for (let i = cards.length - 1; i >= 0; i--) {
    const card = cards[i], change = byId.get(card.id);
    if (change) inverse.push({id:card.id,
      ...(change.columnId !== undefined && {columnId:card.columnId, beforeId:successor.get(card.columnId)}),
      ...(change.pinned !== undefined && {pinned:card.pinned}),
      ...(change.archived !== undefined && {archived:card.archived}),
    });
    successor.set(card.columnId, card.id);
  }
  return inverse;
}

export function openWorkspaceBoard({ api, store, router }) {
  if (!workspaceBoardEnabled(api, store)) return;
  const owner = api.draftOwner();
  const preferenceKey = 'sm.workspace-board.view.' + owner;
  const selected = new Set();
  let board, undo, drag, dropTarget, historyDrawer, removeConfirmation, busy = false, stale = false;
  let seenRevision = store.view.workspaceBoardRevision;
  const message = h('p', { role: 'status', class: 'muted small' });
  const refresh = Button({ label: '刷新看板', size: 'sm', onClick: () => request() });
  const search = Input({ 'aria-label': '筛选项目', placeholder: '按项目、目录或机器搜索', oninput: paintCards });
  const filter = Select({ 'aria-label': '显示卡片', options: [['open','未归档'],['archived','已归档'],['all','全部']], onchange: paintCards });
  const machine = Select({options:[['','全部机器']],onchange:paintCards});
  let machineSignature;
  const tools = h('div', { class: 'row row--wrap' });
  const cards = h('div', { class: 'form-row', style: {alignItems:'start',gridTemplateColumns:'repeat(auto-fit, minmax(min(240px, 100%), 1fr))'} });
  const add = h('div', { class: 'row row--wrap' });
  const columnControls = h('div', { class: 'stack' });
  const manage = h('details', {}, h('summary', {}, '管理看板列'), columnControls);
  const controls = h('fieldset', { class: 'stack', style:{border:'0',padding:'0',margin:'0',minWidth:'0'} }, add, h('div', { class: 'row row--wrap' }, search, Field({label:'绑定机器',control:machine}), filter), tools, h('p',{class:'small muted'},'每列先显示置顶卡片。可拖到同一置顶状态的卡片前，或拖到目标列末。移到列末的卡片会排在本组最后。'), cards, manage);
  const manualHeader=h('div',{class:'row row--between'},message,h('div',{class:'row'},Button({label:'变更历史',size:'sm',onClick:()=>history()}),refresh));
  let automatic=false;
  const flow=createBoardFlow({api,store,router,authorized:()=>authorized(),close:()=>drawer.close()});
  const manualButton=Button({label:'手工列',size:'sm',onClick:()=>switchView(false)});
  const flowButton=Button({label:'自动分组',size:'sm',onClick:()=>switchView(true)});
  manualButton.setAttribute('aria-pressed','true'); flowButton.setAttribute('aria-pressed','false');
  function switchView(next, remember = true) {
    if (!authorized() || automatic===next) return;
    automatic=next;
    if (remember) writeLocal(preferenceKey, automatic ? 'auto' : 'manual');
    manualHeader.hidden=controls.hidden=automatic;
    flowButton.setAttribute('aria-pressed',String(automatic)); manualButton.setAttribute('aria-pressed',String(!automatic));
    if (automatic) { clearDrag(); flow.show(); }
    else { flow.hide(); void request(); }
  }
  const drawer = openDrawer({ title:'工作区看板',wide:true,body:[h('div',{class:'row'},manualButton,flowButton),manualHeader,controls,flow.el],onClose:()=>{
    flow.hide(); historyDrawer?.close(); removeConfirmation?.close(); unsubscribe();
  }});
  const authorized = () => drawer.el.open && api.draftOwner() === owner && workspaceBoardEnabled(api, store);
  const columns = () => board.columns.map(col => [col.id, col.title]);
  const btn = (label, onClick, disabled = false) => Button({ label, onClick, disabled, size: 'sm' });
  function history(card) {
    historyDrawer = openWorkspaceBoardHistory({api,store,authorized,card,linkForCard:id=>{
      const current=board?.cards.find(item=>item.id===id);
      return current && projectLink(current);
    }});
  }
  function projectLink(card) {
    const project = store.view.snapshot.projects?.find(p => p.id === card.projectId);
    if (!project || project.archivedAt) return h('span', {class:'muted small'}, project ? '项目已归档' : '项目已移除');
    const href = router.href('projects', card.projectId, 'workspace');
    return h('a', {href, onclick(event) {
      const current=board?.cards.find(item=>item.id===card.id);
      const project=store.view.snapshot.projects?.find(item=>item.id===card.projectId);
      if (!authorized() || current?.projectId!==card.projectId || !project || project.archivedAt) {
        event.preventDefault();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      drawer.close(); router.go(href);
    }}, '打开项目 ' + card.title);
  }
  function visible() {
    const snapshot=store.view.snapshot;
    const projects=new Map(snapshot.projects?.map(p=>[p.id,p]));
    const names=new Map(snapshot.machines?.map(m=>[m.id,m.name || m.id]));
    const availableIds=new Set([...names.keys(),...board.cards.map(c=>projects.get(c.projectId)?.workspace?.machineId).filter(Boolean)]);
    const current=machine.value;
    const options=[['','全部机器']];
    for (const id of [...availableIds].sort()) {
      const name=names.get(id);
      options.push([id,name && name!==id ? name+' · '+id : id]);
    }
    if (current && !availableIds.has(current)) options.push([current,(names.get(current) || current)+'（当前无绑定卡片）']);
    const signature=JSON.stringify(options);
    if (signature!==machineSignature) {
      replace(machine,options.map(([id,name])=>h('option',{value:id},name)));
      machine.value=current;
      machineSignature=signature;
    }
    const term=search.value.trim().toLocaleLowerCase();
    return board.cards.flatMap(card=>{
      const project=projects.get(card.projectId);
      const title=project?.name ?? card.title;
      const workspace=project?.workspace;
      if (filter.value!=='all' && Boolean(card.archived)!==(filter.value==='archived')) return [];
      if (current && workspace?.machineId!==current) return [];
      if (term && ![title,workspace?.cwd,workspace?.machineId,names.get(workspace?.machineId)].some(value=>value?.toLocaleLowerCase().includes(term))) return [];
      return [{...card,title,location:workspace && [names.get(workspace.machineId) || workspace.machineId,workspace.cwd].filter(Boolean).join(' · ')}];
    });
  }

  function paintCards() {
    if (!board) return;
    const rows = visible();
    const ids = new Set(rows.map(card => card.id));
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
    const chosen = rows.filter(card => selected.has(card.id));
    const batch = change => {
      const changes = chosen.filter(card => Object.entries(change).some(([key,value]) => card[key] !== value))
        .map(card => ({ id: card.id, ...change }));
      if (changes.length) return request({ action: 'batch_cards', changes }, {remember:true});
    };
    const destination = Select({ 'aria-label': '移动到列', options: columns() });
    const receipt = undo;
    const undoButton = !stale && receipt && receipt.revision === board.revision && btn('撤销上次批量操作', () => {
      if (receipt === undo && receipt.revision === board.revision) return request({action:'batch_cards', changes:receipt.changes});
    });
    replace(tools, btn(rows.length && selected.size === rows.length ? '取消全选' : '全选可见卡片', () => {
      if (selected.size === rows.length) selected.clear(); else for (const row of rows) selected.add(row.id);
      paintCards();
    }, !rows.length), undoButton, h('span', { class: 'small muted' }, '已选 ' + selected.size + ' 张'),
      chosen.length > 0 && [
        btn('置顶', () => batch({ pinned:true }), chosen.every(c => c.pinned)),
        btn('取消置顶', () => batch({ pinned:false }), chosen.every(c => !c.pinned)),
        btn('归档', () => batch({ archived:true }), chosen.every(c => c.archived)),
        btn('恢复', () => batch({ archived:false }), chosen.every(c => !c.archived)),
        destination, btn('移动卡片', () => batch({ columnId: destination.value }), !board.columns.length),
      ]);
    replace(cards, board.columns.map(col => {
      const items = rows.filter(card => card.columnId === col.id).sort((a,b) => Number(b.pinned) - Number(a.pinned));
      return h('section', { class: 'card', 'aria-label': col.title }, h('header', { class: 'card__head' }, h('h3', {}, col.title), h('span', {class:'muted small'}, items.length + ' 张')),
        h('div', { class: 'card__body list' }, items.length ? items.map((card,index) => h('div', { class: 'stack', dataset:{boardCard:card.id}, draggable: !selected.size,
          ondragstart(event) {
            if (!authorized() || selected.size || busy || event.target !== event.currentTarget) { event.preventDefault(); return; }
            drag = {id:card.id,pinned:card.pinned,revision:board.revision};
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-super-mario-board-card', card.id);
          }, ondragend:clearDrag, ...dropHandlers(col.id,card) },
          Check({ label: '选择 ' + card.title, checked: selected.has(card.id), onChange: yes => {
            if (yes) selected.add(card.id); else selected.delete(card.id);
            paintCards();
            cards.querySelector('[data-board-card="' + CSS.escape(card.id) + '"] input')?.focus({preventScroll:true});
          } }), projectLink(card), card.location && h('span',{class:'item__meta'},card.location),
          h('div',{class:'row row--wrap'}, ['上移','下移'].map((label,direction) => {
            const peer = items[index + (direction ? 1 : -1)];
            return Button({ label, ariaLabel:label + ' ' + card.title, size:'sm', disabled:!!selected.size || !peer || peer.pinned !== card.pinned,
              onClick: async () => {
                const original = board.cards.filter(item => item.columnId === col.id);
                const before = direction ? original[original.findIndex(item => item.id === peer.id)+1]?.id : peer.id;
                await moveCard(card.id,col.id,before);
                const row = cards.querySelector('[data-board-card="' + CSS.escape(card.id) + '"]');
                if (authorized() && row) (row.querySelector('button[aria-label="' + CSS.escape(label + ' ' + card.title) + '"]:enabled') ?? row.querySelector('input'))?.focus({preventScroll:true});
              } });
          })),
          Button({label:'变更历史',ariaLabel:'变更历史 ' + card.title,size:'sm',onClick:() => history(card)}),
          card.pinned && h('span',{class:'pill'},'已置顶'), card.archived && h('span',{class:'pill'},'已归档'))) :
          h('span', { class: 'muted small' }, '没有符合条件的卡片'),
          h('div',{class:'small muted',dataset:{boardColumnEnd:col.id},...dropHandlers(col.id)}, '拖到此处移至列末')));
    }));
  }

  function clearDrag() {
    drag = undefined;
    if (dropTarget) dropTarget.style.outline = '';
    dropTarget = undefined;
  }
  function dropHandlers(columnId,targetCard) {
    const beforeId = targetCard?.id;
    return {
      ondragover(event) {
        if (!drag || !authorized() || drag.revision !== board.revision || beforeId === drag.id || busy || stale) return;
        event.preventDefault();
        if (targetCard && drag.pinned !== targetCard.pinned) {
          event.dataTransfer.dropEffect = 'none';
          message.textContent = '只能放在同一置顶状态的卡片前，或拖到目标列末。';
          return;
        }
        message.textContent = '';
        event.dataTransfer.dropEffect = 'move';
        if (dropTarget && dropTarget !== event.currentTarget) dropTarget.style.outline = '';
        dropTarget = event.currentTarget;
        dropTarget.style.outline = '2px solid var(--accent)';
      },
      ondragleave(event) {
        if (dropTarget === event.currentTarget && !event.currentTarget.contains(event.relatedTarget)) {
          dropTarget.style.outline = ''; dropTarget = undefined;
        }
      },
      ondrop(event) {
        if (!drag || drag.revision !== board.revision || busy || stale || !authorized()) return;
        event.preventDefault();
        const id = drag.id;
        clearDrag();
        if (!targetCard || board.cards.find(c => c.id === id)?.pinned === targetCard.pinned) void moveCard(id,columnId,beforeId);
      },
    };
  }
  async function moveCard(id,columnId,beforeId) {
    if (id === beforeId) return;
    const original = board.cards.filter(c => c.columnId === columnId);
    const index = original.findIndex(c => c.id === id);
    if (index >= 0 && original[index+1]?.id === beforeId) return;
    await request({action:'batch_cards',changes:[{id,columnId,beforeId}]});
  }

  function paintAdd() {
    const projects = (store.view.snapshot.projects ?? []).filter(project => !project.archivedAt && !board.cards.some(card => card.projectId === project.id));
    const project = Select({ options: projects.map(p => [p.id,p.name]) });
    const column = Select({ options: columns() });
    replace(add, Field({label:'添加项目',control:project}), Field({label:'添加到列',control:column}),
      btn('添加卡片', () => request({action:'add_card', projectId:project.value, columnId:column.value}), !projects.length || !board.columns.length));
  }
  function paintColumns() {
    const title = Input({ 'aria-label':'新增列名称', placeholder:'新增列名称' });
    replace(columnControls, h('div', {class:'row'}, title, btn('添加列', () => title.value.trim() && request({action:'add_column',title:title.value.trim()}))),
      board.columns.map((col,i,all) => {
        const name = Input({ 'aria-label':'列名称 ' + col.title, value:col.title });
        const targets = columns().filter(([id]) => id !== col.id);
        const target = Select({ 'aria-label':'删除后移动到 ' + col.title, options:targets });
        const occupied = board.cards.some(card => card.columnId === col.id);
        return h('section', {class:'stack', 'aria-label':'管理列 ' + col.title},
          h('div', {class:'row row--wrap'}, name, btn('重命名', () => name.value.trim() && request({action:'rename_column',id:col.id,title:name.value.trim()})),
            btn('上移', () => request({action:'move_column',id:col.id,beforeId:all[i-1].id}), i === 0),
            btn('下移', () => request({action:'move_column',id:col.id,beforeId:all[i+2]?.id}), i === all.length-1)),
          h('div', {class:'row row--wrap'}, occupied && Field({label:'删除后移动到',control:target}),
            btn('删除列', async () => {
              const revision = board.revision;
              const moveTo = occupied ? target.value : undefined;
              const destination = targets.find(([id]) => id === moveTo)?.[1];
              const confirmation = confirmDialog({ title:'删除看板列', message:'删除「'+col.title+'」'+(destination?'，将其中卡片移到「'+destination+'」。':'。'), confirmLabel:'删除列',danger:true });
              removeConfirmation = document.activeElement?.closest('dialog.modal');
              const confirmed = await confirmation;
              removeConfirmation = undefined;
              if (confirmed && authorized()) {
                if (revision !== board.revision) { message.textContent='看板已更新，请核对后重新删除。'; return; }
                await request({action:'remove_column', id:col.id, moveTo});
              }
            }, !targets.length)));
      }));
  }

  async function request(change, {remember = false} = {}) {
    if (!authorized() || busy || (change && (!board || stale))) return;
    const inverse = remember ? inverseBatch(board.cards,change.changes) : undefined;
    clearDrag();
    busy = true;
    controls.disabled = controls.inert = refresh.disabled = true;
    message.textContent = change ? '正在保存…' : '正在读取看板…';
    try {
      const doc = await api.post('/workspace-board', change ? {...change,revision:board.revision} : {action:'list'});
      if (!authorized()) return;
      if (inverse) undo = {revision:doc.revision,changes:inverse};
      else if (undo && undo.revision !== doc.revision) undo = undefined;
      board = doc;
      stale = false;
      if (change?.action === 'batch_cards') for (const {id} of change.changes) selected.delete(id);
      paintAdd(); paintCards(); paintColumns();
      message.textContent = '';
    } catch (error) {
      if (!authorized()) return;
      stale = true;
      paintCards();
      message.textContent = error.message + '。请刷新看板后核对。';
    } finally {
      busy = false;
      if (authorized()) {
        controls.inert = false;
        controls.disabled = stale;
        refresh.disabled = false;
        const revision = store.view.workspaceBoardRevision;
        if (!stale && Number.isSafeInteger(revision) && revision > board.revision && revision !== seenRevision) {
          seenRevision = revision;
          void request();
        }
      }
    }
  }
  function bindingSignature() {
    const snapshot=store.view.snapshot;
    return JSON.stringify([snapshot.projects?.map(p=>[p.id,p.name,p.archivedAt,p.workspace?.machineId,p.workspace?.cwd]),
      snapshot.machines?.map(m=>[m.id,m.name])]);
  }
  let projectSignature = bindingSignature();
  let connection = store.view.connection;
  const unsubscribe = store.subscribe(() => {
    if (!authorized()) { flow.hide(); drawer.close(); return; }
    if (automatic) { flow.update(); return; }
    const reconnected = connection !== 'online' && store.view.connection === 'online';
    connection = store.view.connection;
    if (reconnected && !busy) { void request(); return; }
    const revision = store.view.workspaceBoardRevision;
    if (!busy && !stale && Number.isSafeInteger(revision) && revision !== seenRevision) {
      seenRevision = revision;
      if (!board || revision > board.revision) { void request(); return; }
    }
    const next = bindingSignature();
    if (next !== projectSignature && board && !busy) { projectSignature = next; paintAdd(); paintCards(); }
  });
  if (readLocal(preferenceKey,'manual')==='auto') switchView(true,false);
  else void request();
}
