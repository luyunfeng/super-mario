import { h, replace } from '../lib/dom.js';
import { Button, Check, Field, Input, Select } from '../ui/kit.js';
import { confirmDialog, openDrawer } from '../ui/overlay.js';

export function workspaceBoardEnabled(api, store) {
  return !store.view.unauthorized && store.view.snapshotOwner === api.draftOwner() &&
    !!store.view.snapshot?.plugins?.some(p => p.id === 'workspace-board' && p.status === 'active');
}

export function openWorkspaceBoard({ api, store, router }) {
  if (!workspaceBoardEnabled(api, store)) return;
  const owner = api.draftOwner();
  const selected = new Set();
  let board, removeConfirmation, busy = false, stale = false;
  let seenRevision = store.view.workspaceBoardRevision;
  const message = h('p', { role: 'status', class: 'muted small' });
  const refresh = Button({ label: '刷新看板', size: 'sm', onClick: () => request() });
  const search = Input({ 'aria-label': '筛选项目', placeholder: '筛选项目', oninput: paintCards });
  const filter = Select({ 'aria-label': '显示卡片', options: [['open','未归档'],['archived','已归档'],['all','全部']], onchange: paintCards });
  const tools = h('div', { class: 'row row--wrap' });
  const cards = h('div', { class: 'form-row', style: {alignItems:'start',gridTemplateColumns:'repeat(auto-fit, minmax(min(240px, 100%), 1fr))'} });
  const add = h('div', { class: 'row row--wrap' });
  const columnControls = h('div', { class: 'stack' });
  const manage = h('details', {}, h('summary', {}, '管理看板列'), columnControls);
  const controls = h('fieldset', { class: 'stack', style:{border:'0',padding:'0',margin:'0',minWidth:'0'} }, add, h('div', { class: 'row row--wrap' }, search, filter), tools, cards, manage);
  const drawer = openDrawer({ title: '工作区看板', wide: true, body: [h('div', { class: 'row row--between' }, message, refresh), controls], onClose: () => { removeConfirmation?.close(); unsubscribe(); } });
  const authorized = () => drawer.el.open && api.draftOwner() === owner && workspaceBoardEnabled(api, store);
  const columns = () => board.columns.map(col => [col.id, col.title]);
  const btn = (label, onClick, disabled = false) => Button({ label, onClick, disabled, size: 'sm' });
  function projectLink(card) {
    const project = store.view.snapshot.projects?.find(p => p.id === card.projectId);
    if (!project || project.archivedAt) return h('span', {class:'muted small'}, project ? '项目已归档' : '项目已移除');
    const href = router.href('projects', card.projectId, 'workspace');
    return h('a', {href, onclick(event) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      if (authorized()) { drawer.close(); router.go(href); }
    }}, '打开项目 ' + card.title);
  }
  function visible() {
    const names = new Map(store.view.snapshot.projects?.map(p => [p.id,p.name]));
    return board.cards.map(card => ({...card,title:names.get(card.projectId) ?? card.title})).filter(card => (filter.value === 'all' || Boolean(card.archived) === (filter.value === 'archived')) &&
      card.title.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
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
      if (changes.length) return request({ action: 'batch_cards', changes });
    };
    const destination = Select({ 'aria-label': '移动到列', options: columns() });
    replace(tools, btn(rows.length && selected.size === rows.length ? '取消全选' : '全选可见卡片', () => {
      if (selected.size === rows.length) selected.clear(); else for (const row of rows) selected.add(row.id);
      paintCards();
    }, !rows.length), h('span', { class: 'small muted' }, '已选 ' + selected.size + ' 张'),
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
        h('div', { class: 'card__body list' }, items.length ? items.map(card => h('div', { class: 'stack', dataset:{boardCard:card.id} },
          Check({ label: '选择 ' + card.title, checked: selected.has(card.id), onChange: yes => {
            if (yes) selected.add(card.id); else selected.delete(card.id);
            paintCards();
            cards.querySelector('[data-board-card="' + CSS.escape(card.id) + '"] input')?.focus({preventScroll:true});
          } }), projectLink(card),
          card.pinned && h('span',{class:'pill'},'已置顶'), card.archived && h('span',{class:'pill'},'已归档'))) :
          h('span', { class: 'muted small' }, '没有符合条件的卡片')));
    }));
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

  async function request(change) {
    if (!authorized() || busy || (change && (!board || stale))) return;
    busy = true;
    controls.disabled = controls.inert = refresh.disabled = true;
    message.textContent = change ? '正在保存…' : '正在读取看板…';
    try {
      const doc = await api.post('/workspace-board', change ? {...change,revision:board.revision} : {action:'list'});
      if (!authorized()) return;
      board = doc;
      stale = false;
      if (change?.action === 'batch_cards') for (const {id} of change.changes) selected.delete(id);
      paintAdd(); paintCards(); paintColumns();
      message.textContent = '';
    } catch (error) {
      if (!authorized()) return;
      stale = true;
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
  let projectSignature = JSON.stringify(store.view.snapshot.projects?.map(p => [p.id,p.name,p.archivedAt]));
  let connection = store.view.connection;
  const unsubscribe = store.subscribe(() => {
    if (!authorized()) { drawer.close(); return; }
    const reconnected = connection !== 'online' && store.view.connection === 'online';
    connection = store.view.connection;
    if (reconnected && !busy) { void request(); return; }
    const revision = store.view.workspaceBoardRevision;
    if (!busy && !stale && Number.isSafeInteger(revision) && revision !== seenRevision) {
      seenRevision = revision;
      if (!board || revision > board.revision) { void request(); return; }
    }
    const next = JSON.stringify(store.view.snapshot.projects?.map(p => [p.id,p.name,p.archivedAt]));
    if (next !== projectSignature && board && !busy) { projectSignature = next; paintAdd(); paintCards(); }
  });
  void request();
}
