import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const kinds = {
  card_added:'添加卡片', card_removed:'移除卡片', card_updated:'更新卡片', cards_reordered:'调整卡片顺序',
  column_added:'添加列', column_removed:'删除列', column_renamed:'重命名列', columns_reordered:'调整列顺序',
};
const fields = {title:'名称',column:'所在列',columnId:'所在列',pinned:'置顶状态',archived:'归档状态'};
function historicalValue(label, value) {
  if (!value) return null;
  const parts = [value.title, value.columnTitle ?? value.columnId];
  if (typeof value.pinned === 'boolean') parts.push(value.pinned ? '已置顶' : '未置顶');
  if (typeof value.archived === 'boolean') parts.push(value.archived ? '已归档' : '未归档');
  return h('p', {class:'small'}, h('strong', {}, label + '　'), parts.filter(Boolean).join(' · '));
}
function changeRow(change, card, linkForCard) {
  return h('div', {class:'stack'}, h('strong', {}, [kinds[change.kind] ?? change.kind, change.title].filter(Boolean).join(' · ')),
    change.kind.startsWith('card_') && change.id && linkForCard(change.id),
    !!change.fields?.length && h('span',{class:'muted small'},'变更字段　' + change.fields.map(f => fields[f] ?? f).join('、')),
    historicalValue('变更前',change.before), historicalValue('变更后',change.after),
    !!change.cardIds?.length && (card ? h('span', {class:'small muted'}, '这张卡片参与了顺序调整。') : h('details',{},h('summary',{},'本次调整涉及的卡片顺序'), h('ol',{},change.cardIds.map(id => h('li',{},id))))));
}

export function openWorkspaceBoardHistory({api, store, authorized, card, linkForCard}) {
  if (!authorized()) return;
  let generation = 0, busy = false, before = null, latest, connection = store.view.connection;
  const list = h('div', {class:'stack'});
  const status = h('p', {role:'status',class:'small muted'});
  const update = h('p', {role:'status',class:'small muted'});
  const reload = Button({label:'刷新历史', size:'sm', onClick:() => load(true)});
  const more = Button({label:'查看更多历史', size:'sm', onClick:() => load(false)});
  more.hidden = true;
  const drawer = openDrawer({title:card ? '卡片变更历史' : '看板变更历史',subtitle:card?.title,
    body:[h('div',{class:'row row--between'},update,reload),status,list,more], onClose:() => { generation++; unsubscribe(); }});
  const alive = stamp => drawer.el.open && authorized() && stamp === generation;
  function notice() {
    update.textContent = latest !== undefined && store.view.workspaceBoardRevision > latest ? '看板有新的变更，可刷新历史。' : '';
  }
  function entryRow(entry, stamp) {
    let detailGeneration = 0, expanded = false, detailBusy = false, offset = 0;
    const changes = h('div',{class:'stack'});
    const feedback = h('p',{role:'status',class:'small muted'});
    const next = Button({label:'查看更多变更',size:'sm',onClick:details});
    const content = h('div',{class:'stack',hidden:true},changes,feedback,next);
    async function details() {
      if (detailBusy || !alive(stamp) || !expanded || offset === null) return;
      const turn = detailGeneration;
      detailBusy = next.disabled = true;
      feedback.textContent = '正在读取变更…';
      try {
        const page = await api.post('/workspace-board',{action:'activity_detail',revision:entry.revision,cardId:card?.id,offset,limit:20});
        if (!alive(stamp) || turn !== detailGeneration || !expanded) return;
        changes.append(...page.changes.map(change => changeRow(change,card,linkForCard)));
        offset = page.nextOffset;
        feedback.textContent = '已显示 ' + changes.childElementCount + ' / ' + page.total + ' 项变更';
        next.textContent = '查看更多变更'; next.hidden = offset === null;
      } catch (error) {
        if (!alive(stamp) || turn !== detailGeneration) return;
        feedback.textContent = error.message;
        next.textContent = '重试读取变更'; next.hidden = false;
      } finally {
        if (turn === detailGeneration) detailBusy = next.disabled = false;
      }
    }
    const toggle = Button({label:'展开版本 ' + entry.revision,size:'sm',onClick:() => {
      if (!alive(stamp)) return;
      expanded = !expanded;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.textContent = (expanded ? '收起版本 ' : '展开版本 ') + entry.revision;
      content.hidden = !expanded;
      if (expanded) { next.hidden = true; void details(); }
      else { detailGeneration++; detailBusy = false; offset = 0; changes.replaceChildren(); feedback.textContent = ''; }
    }});
    toggle.setAttribute('aria-expanded','false');
    const date = new Date(entry.at);
    return h('section', {class:'card', 'aria-label':'版本 ' + entry.revision},
      h('header',{class:'card__head'},h('h3',{},'版本 ' + entry.revision),toggle),
      h('div',{class:'card__body stack'},h('span',{class:'small muted'}, Number.isFinite(date.getTime()) ? date.toLocaleString() : entry.at),
        h('span',{},(card ? '本次提交共 ' : '') + entry.changeCount + ' 项变更 · ' + entry.cardCount + ' 张卡片'),
        h('span',{},entry.kinds.map(kind => kinds[kind] ?? kind).join('、')),content));
  }
  async function load(reset) {
    if (!drawer.el.open || !authorized() || (!reset && (busy || before === null))) return;
    if (reset) { generation++; latest = undefined; before = null; list.replaceChildren(); more.hidden = true; notice(); }
    const stamp = generation;
    busy = more.disabled = reload.disabled = true;
    status.textContent = '正在读取历史…';
    try {
      const page = await api.post('/workspace-board',{action:'activity',cardId:card?.id,before:reset ? undefined : before,limit:20});
      if (!alive(stamp)) return;
      if (reset) latest = page.latestRevision;
      before = page.nextBefore;
      list.append(...page.entries.map(entry => entryRow(entry,stamp)));
      status.textContent = list.childElementCount ? '已显示 ' + list.childElementCount + ' 条历史记录' : '没有可查看的变更历史。';
      if (page.oldestRevision != null && list.childElementCount) status.textContent += ' · 看板最早保留版本 ' + page.oldestRevision;
      more.hidden = before === null;
      notice();
    } catch (error) {
      if (alive(stamp)) status.textContent = error.message;
    } finally {
      if (alive(stamp)) busy = more.disabled = reload.disabled = false;
    }
  }
  const unsubscribe = store.subscribe(() => {
    if (!authorized()) { replace(drawer.body); drawer.close(); return; }
    const reconnected = connection !== 'online' && store.view.connection === 'online';
    connection = store.view.connection;
    if (reconnected) void load(true); else notice();
  });
  void load(true);
  return drawer;
}
