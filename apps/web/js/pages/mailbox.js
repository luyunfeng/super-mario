import { h, replace, keyedList } from '../lib/dom.js';
import { personalGroupSize } from '../lib/group-size.js';
import { timeAgo, formatDate } from '../lib/format.js';
import { Banner, Button, Card, Empty, Input, Pill, Select } from '../ui/kit.js';
import { Hint, hintCopy } from '../ui/hint.js';
import { openDrawer } from '../ui/overlay.js';
import { openInboxHandlingDrawer } from '../features/inbox-handling.js';

const DELIVERY = { queued: '等待发送', needs_approval: '待确认', sending: '发送中', sent: '已发送', held: '暂缓发送', failed: '发送失败', unknown: '结果未知', expired: '已过期', cancelled: '已取消' };
const MAIL = { pending: '待确认', ready: '等待处理', processing: '处理中', rejected: '已拒绝', failed: '处理失败', unknown: '结果未知' };
const ORIGINS = [['all', '全部'], ['direct', '私聊'], ['mentioned', '群@我'], ['group', '群聊'], ['agent', 'Agent协作'], ['unknown', '未识别']];
const STAGES = [['human', '待人决策'], ['ai', '待AI执行'], ['processing', '处理中'], ['done', '已处理'], ['all', '全部']];
const TIER = { action: '需要处理', fyi: '知会', noise: '低优先级' };
const PAGE_SIZE = 50;
const readable = text => String(text ?? '').replace(/^\[(?:om_|omt_)[^\]]*\]\s*/gm, '');

/** Display the existing inbox and both delivery ledgers. Opening the page never sends a message. */
export function createMailboxPage({ api, store, router, direction }) {
  const incoming = direction === 'inbox';
  const name = incoming ? '收件箱' : '发件箱';
  let snapshot = store.view.snapshot;
  let mailbox = [], deliveries = [];
  let error = '', loadError = '', loaded = false, loading = false, revision = 0, lastSnapshot;
  let drawer, selected, detailKey;
  let sourceFilter = 'all', stageFilter = 'all';
  let displayLimit = PAGE_SIZE, dirty = true;
  const drafts = new Map(), pending = new Set(), uncertain = new Set(), updated = new Map();
  let handlingRows,handlingIndex=new Map();
  function handlingState(item){const rows=snapshot?.inboxHandling;if(rows!==handlingRows){handlingRows=rows;handlingIndex=new Map((rows??[]).map(row=>[`${row.source.kind}:${row.source.id}`,row]));}return handlingIndex.get(item.id);}
  const sourceChips = h('div', { class: 'mailbox-chips', role: 'group', 'aria-label': '消息来源' });
  const stageChips = h('div', { class: 'mailbox-chips', role: 'group', 'aria-label': '处理阶段' });
  const projectFilter = Select({ 'aria-label': '收件项目', value: 'all', options: [['all', '全部项目']] });
  const query = Input({ type: 'search', placeholder: '搜索消息内容、来源或发送目标', 'aria-label': `搜索${name}` });
  const filter = Select({ 'aria-label': `${name}状态`, value: 'all', options: incoming
    ? [['all', '全部消息'], ['action', '需要处理'], ['fyi', '知会'], ['noise', '低优先级'], ['archived', '已归档'], ['todo', '已转待办'], ['large-group', '已忽略的大群']]
    : [['all', '全部状态'], ['pending', '待确认'], ['sending', '等待与发送中'], ['sent', '已发送'], ['failed', '失败或结果未知'], ['closed', '已取消、拒绝或过期']] });
  const summary = h('p', { class: 'small muted', role: 'status' });
  const notice = h('div');
  const list = h('div', { class: 'stack', 'aria-label': `${name}消息列表` });
  const more = Button({ label: '加载更多', onClick: () => { displayLimit += PAGE_SIZE; paint(); } });
  more.hidden = true;
  const el = h('section', { class: 'page', id: direction }, h('div', { class: 'page__inner' },
    h('header', { class: 'page__head' }, h('div', { class: 'page__title' }, h('h1', null, name), h('p', { class: 'page__sub' }, hintCopy(`nav.${direction}`).tag)),
      h('div', { class: 'page__actions' }, h('a', { class: 'btn btn--sm', href: router.href(incoming ? 'outbox' : 'inbox') }, incoming ? '查看发件箱' : '查看收件箱'), Hint(`nav.${direction}`))),
    h('div', { class: 'stack' },
      incoming && h('p', { class: 'small muted' }, '按来源、处理阶段和项目查看消息。已转待办表示消息已处理，不代表任务完成。'),
      h('div', { class: 'mailbox-toolbar stack' },
        incoming && sourceChips, incoming && stageChips,
        h('div', { class: 'row row--wrap mailbox-filters' }, h('div', { class: 'grow', style: { minWidth: '180px' } }, query), incoming && projectFilter, filter)), summary, notice, list, more)));

  function records() {
    const personal = incoming ? (snapshot?.inbox ?? []).map(item => updated.get(item.id)?.version > item.version ? updated.get(item.id) : item).map(item => ({
      id: `personal:${item.id}`, kind: 'personal', raw: item,
      title: /^oc_/.test(item.title) ? item.origin?.chatName || '会话消息' : item.title,
      text: readable(item.text), source: item.origin?.connector || (item.source?.startsWith('feishu:') ? '飞书采集' : '收件消息'),
      status: item.todoId ? '已转待办' : item.archivedAt ? '已归档' : TIER[item.tier] ?? '待查看',
      time: item.receivedAt ?? item.updatedAt,
    })) : [];
    // A background delivery can create a bot-mailbox record with the same event key.
    // Keep the delivery's actual status rather than showing that send twice.
    const deliveryKeys = new Set(deliveries.map(item => item.dedupKey));
    const botMail = mailbox.filter(item => incoming || !deliveryKeys.has(item.eventKey)).map(item => ({
      id: `mailbox:${item.id}`, kind: 'mailbox', raw: item, title: incoming && /^oc_/.test(item.title) ? item.origin?.chatName || '会话消息' : item.title, text: item.text,
      source: incoming ? '飞书机器人收件' : '飞书机器人发件',
      status: item.status === 'completed' ? incoming ? '已处理' : '已发送' : MAIL[item.status] ?? '待查看', time: item.updatedAt,
    }));
    const outgoing = incoming ? [] : deliveries.map(item => ({
      id: `delivery:${item.id}`, kind: 'delivery', raw: item,
      title: item.content?.text?.split('\n').find(line => line.trim())?.slice(0, 100) || '工作台通知',
      text: item.content?.text ?? '', source: item.channel?.startsWith('feishu.personal:') ? '飞书个人回复' : item.channel?.startsWith('feishu') ? '飞书通知' : item.channel || '工作台通知',
      status: DELIVERY[item.status] ?? '待查看', time: item.updatedAt,
    }));
    return [...personal, ...botMail, ...outgoing].sort((a, b) => String(b.time).localeCompare(String(a.time)));
  }
  // Provenance is supplied by the connector; chat IDs and message text are not evidence.
  function originKind(item) {
    return ['direct', 'group', 'agent'].includes(item.raw.origin?.kind) ? item.raw.origin.kind : 'unknown';
  }
  function originLabel(item) {
    const kind = originKind(item);
    return kind === 'group' && item.raw.origin?.mentionedMe === true ? '群@我' : ORIGINS.find(([key]) => key === kind)?.[1];
  }
  function stage(item) {
    const raw = item.raw;
    if (raw.todoId || raw.archivedAt || ['completed', 'rejected', 'archived'].includes(raw.status)) return 'done';
    if (item.kind === 'personal' && personalGroupSize(raw.origin) > 50) return 'info';
    if(handlingState(item))return handlingState(item).stage;
    if (item.kind === 'mailbox') return raw.status === 'pending' ? 'human' : raw.status === 'ready' ? 'ai' : raw.status === 'processing' ? 'processing' : 'human';
    if (originKind(item) === 'direct' || (originKind(item) === 'group' && raw.origin?.mentionedMe === true) || raw.tier === 'action') return 'human';
    // FYI/noise does not itself mean an AI execution is waiting.
    return 'info';
  }
  function projectId(item) { return item.kind === 'personal' ? item.raw.projectId : item.raw.scope?.kind === 'project' ? item.raw.scope.projectId : undefined; }
  function projectName(item) {
    const id = projectId(item);
    return id ? snapshot?.projects?.find(project => project.id === id)?.name || '项目不可用' : '未归项目';
  }
  function matches(item, omit) {
    const search = query.value.trim().toLowerCase(), raw = item.raw;
    if (search && ![item.title, item.text, item.source, raw.sender, raw.target, raw.origin?.chatName, raw.origin?.senderName, incoming && originLabel(item), incoming && projectName(item)].some(value => String(value ?? '').toLowerCase().includes(search))) return false;
    if (incoming) {
      if (omit !== 'source' && sourceFilter !== 'all' && !(sourceFilter === 'mentioned' ? originKind(item) === 'group' && raw.origin?.mentionedMe === true : originKind(item) === sourceFilter)) return false;
      if (omit !== 'stage' && stageFilter !== 'all' && stage(item) !== stageFilter) return false;
      if (omit !== 'project' && projectFilter.value !== 'all' && (projectId(item) || 'none') !== projectFilter.value) return false;
    }
    const value = filter.value;
    if (incoming && item.kind === 'personal' && personalGroupSize(raw.origin) > 50 && !raw.todoId && !raw.archivedAt) return value === 'large-group';
    if (value === 'large-group') return item.kind === 'personal' && personalGroupSize(raw.origin) > 50;
    if (value === 'all') return true;
    if (incoming) {
      if (value === 'archived') return Boolean(raw.archivedAt) || raw.status === 'archived';
      if (value === 'todo') return Boolean(raw.todoId);
      return item.kind === 'personal' && raw.tier === value && !raw.archivedAt && !raw.todoId;
    }
    if (value === 'pending') return ['pending', 'needs_approval'].includes(raw.status);
    if (value === 'sending') return ['ready', 'processing', 'queued', 'sending', 'held'].includes(raw.status);
    if (value === 'sent') return ['completed', 'sent'].includes(raw.status);
    if (value === 'failed') return ['failed', 'unknown'].includes(raw.status);
    return ['cancelled', 'expired', 'rejected'].includes(raw.status);
  }
  function clearFilters() {
    query.value = ''; filter.value = 'all'; projectFilter.value = 'all'; sourceFilter = 'all'; stageFilter = 'all'; resetWindow();
  }
  function resetWindow() { displayLimit = PAGE_SIZE; paint(); }
  function paintFilters(all) {
    function chips(el, options, dimension, active, change) {
      replace(el, options.map(([key, label]) => {
        const count = all.filter(item => matches(item, dimension) && (key === 'all' || (dimension === 'stage' ? stage(item) === key : key === 'mentioned' ? originKind(item) === 'group' && item.raw.origin?.mentionedMe === true : originKind(item) === key))).length;
        return h('button', { type: 'button', class: 'mailbox-chip', 'aria-pressed': String(active === key), onclick: () => { change(key); resetWindow(); } }, label, h('span', { class: 'mailbox-chip__count' }, count));
      }));
    }
    chips(sourceChips, ORIGINS, 'source', sourceFilter, value => { sourceFilter = value; });
    chips(stageChips, STAGES, 'stage', stageFilter, value => { stageFilter = value; });
    const current = projectFilter.value;
    const ids = new Set([...all.map(projectId).filter(Boolean), ...(snapshot?.projects ?? []).filter(project => !project.archivedAt).map(project => project.id)]);
    if (!['all', 'none'].includes(current)) ids.add(current);
    const options = [['all', '全部项目'], ['none', '未归项目'], ...[...ids].map(id => [id, snapshot?.projects?.find(project => project.id === id)?.name || '项目不可用'])];
    replace(projectFilter, options.map(([id, label]) => h('option', { value: id }, `${label} (${all.filter(item => matches(item, 'project') && (id === 'all' || (projectId(item) || 'none') === id)).length})`)));
    projectFilter.value = current;
  }
  function metadata(item) {
    const origin = item.raw.origin;
    return h('div', { class: 'row row--wrap mailbox-meta' }, Pill(originLabel(item)),
      origin?.chatName && h('span', null, `会话：${origin.chatName}`),
      (origin?.senderName || item.raw.sender) && h('span', null, `最近发言人：${origin?.senderName || item.raw.sender}`),
      h('span', null, `项目：${projectName(item)}`));
  }
  const tone = item => ['unknown', 'failed'].includes(item.raw.status) ? 'danger' : ['已发送', '已处理', '已转待办'].includes(item.status) ? 'ok' : item.status === '需要处理' || item.status === '待确认' ? 'warn' : '';
  function card(item) {
    const mod = incoming ? stage(item) : tone(item) || 'default';
    const handleBtn = incoming && !item.raw.archivedAt && item.raw.status !== 'archived'
      ? Button({ label: '处理与建议', size: 'sm', kind: 'secondary', onClick: () => openInboxHandlingDrawer({ api, store, source: { kind: item.kind, id: item.raw.id } }) })
      : null;
    return Card({ title: item.title, sub: `${item.source} · ${timeAgo(item.time)}`, className: `mailbox-card mailbox-card--${mod}`,
      tools: h('div', { class: 'row row--wrap' }, incoming && stage(item) !== 'info' && Pill(STAGES.find(([key]) => key === stage(item))[1], stage(item) === 'human' ? 'warn' : ''), Pill(item.status, tone(item))), body: h('div', { class: 'stack' },
        incoming && metadata(item),
        incoming && handlingState(item) && h('p',{class:'small muted'},handlingState(item).label),
        h('p', { class: 'mailbox-preview' }, item.text || '这条消息没有文本正文。'),
        item.raw.target && h('p', { class: 'small muted mailbox-meta' }, `发送目标：${item.raw.target}`),
        item.raw.error && Banner({ tone: 'danger', children: item.raw.error }),
        h('div', { class: 'row row--wrap' }, Button({ label: '查看原文与详情', size: 'sm', onClick: () => open(item.id) }), handleBtn, ...actions(item))) });
  }
  async function act(item, operation) {
    if (pending.has(item.id) || uncertain.has(item.id)) return;
    pending.add(item.id); error = ''; paint();
    try {
      await api.post(`/inbox/${encodeURIComponent(item.raw.id)}/${operation}`, { version: item.raw.version });
    } catch (cause) {
      if (!cause.status) uncertain.add(item.id);
      error = cause.status === 409 ? '这条消息刚被更新，请核对最新内容后再操作。' : `操作未完成：${cause.message}`;
    }
    try { await store.refresh(); snapshot = store.view.snapshot; }
    catch { loadError = '操作后读取最新消息失败，请刷新核对。'; }
    finally { pending.delete(item.id); paint(); }
  }
  function actions(item) {
    if (item.kind !== 'personal') return [];
    if (pending.has(item.id) || uncertain.has(item.id)) return [h('span', { class: 'small muted' }, pending.has(item.id) ? '正在保存…' : '操作结果未知，请刷新核对后再操作。')];
    const todo = (snapshot?.todos ?? []).find(todo => todo.id === item.raw.todoId);
    const todoLink = item.raw.todoId && h('a', { class: 'btn btn--sm', href: router.href('projects', todo?.projectId ?? 'all', 'todos'), onclick: () => drawer?.close() }, '查看待办');
    // Confirming an inbox item also archives it. Keep its resulting todo accessible.
    if (item.raw.archivedAt) return [...(todoLink ? [todoLink] : []), Button({ label: '恢复到收件箱', size: 'sm', onClick: () => act(item, 'reopen') })];
    return [todoLink || Button({ label: '转为待办', kind: 'primary', size: 'sm', onClick: () => act(item, 'confirm') }),
    Button({ label: '归档', size: 'sm', onClick: () => act(item, 'archive') })];
  }
  function detail() {
    if (!drawer) return;
    const item = records().find(item => item.id === selected);
    if (!item) { detailKey = undefined; replace(drawer.body, h('p', null, '这条记录已更新，请关闭后查看列表。')); replace(drawer.foot, Button({ label: '关闭', onClick: () => drawer.close() })); return; }
    const raw = item.raw;
    const key = JSON.stringify([item, error, snapshot?.projects, drafts.get(item.id), pending.has(item.id), uncertain.has(item.id)]);
    if (detailKey === key) return;
    detailKey = key;
    replace(drawer.body, h('h3', null, item.title),
      h('div', { class: 'row row--wrap' }, Pill(item.status, tone(item)), h('span', { class: 'small muted' }, item.source, ' · ', formatDate(item.time, true))),
      incoming && metadata(item),
      !incoming && raw.sender && h('p', { class: 'small mailbox-meta' }, `最近发言人：${raw.sender}`),
      raw.target && h('p', { class: 'small mailbox-meta' }, `发送目标：${raw.target}`),
      raw.reason && h('p', { class: 'small muted' }, `分拣建议：${raw.reason.replace(/^注入分拣器：/, '')}`),
      raw.error && Banner({ tone: 'danger', children: raw.error }),
      raw.status === 'unknown' && Banner({ tone: 'warn', children: '发送结果未知。请先核对实际送达情况，工作台不会自动重复发送。' }),
      h('pre', { class: 'mailbox-content' }, item.text || '没有文本正文。'),
      ['pending', 'needs_approval'].includes(raw.status) && !incoming && h('p', { class: 'small muted' }, '内容仍待确认，尚未发送。可在对话页处理审批，或在渠道高级设置中处理机器人发件。'),
      incoming && projectEditor(item),
      error && Banner({ tone: 'danger', children: error }));
    replace(drawer.foot, Button({ label: '关闭', onClick: () => drawer.close() }), ...actions(item),
      incoming && Button({ label: '处理与建议', onClick: () => {
        drawer.close();
        openInboxHandlingDrawer({ api, store, source: { kind: item.kind, id: item.raw.id } });
      } }));
  }
  function projectEditor(item) {
    if (item.kind !== 'personal') return h('p', { class: 'small muted' }, ['completed', 'rejected', 'archived'].includes(item.raw.status)
      ? '已处理的机器人消息仅展示项目来源，不能修改处理范围。'
      : '机器人消息的项目范围请通过渠道高级设置中的已有范围入口修改；范围会影响消息处理。');
    const draft = drafts.get(item.id) ?? { projectId: item.raw.projectId || '', version: item.raw.version };
    const projects = (snapshot?.projects ?? []).filter(project => !project.archivedAt);
    const options = [['', '不归项目'], ...projects.map(project => [project.id, project.name])];
    const unavailable = draft.projectId && !projects.some(project => project.id === draft.projectId);
    if (unavailable) options.push([draft.projectId, `${snapshot?.projects?.find(project => project.id === draft.projectId)?.name || '项目不可用'}（已归档或不可用）`]);
    const select = Select({ 'aria-label': '归入项目', options, value: draft.projectId, disabled: pending.has(item.id) || uncertain.has(item.id) });
    if (unavailable) select.options[select.options.length - 1].disabled = true;
    select.addEventListener('change', () => { draft.projectId = select.value; drafts.set(item.id, draft); });
    return h('div', { class: 'mailbox-project-editor stack' }, h('strong', null, '归入项目'),
      h('p', { class: 'small muted' }, '只更新消息归属，不会归档、转为待办或执行消息。'),
      h('div', { class: 'row row--wrap' }, select, Button({ label: '保存项目', size: 'sm', disabled: pending.has(item.id) || uncertain.has(item.id), onClick: () => saveProject(item, draft) })));
  }
  async function saveProject(item, draft) {
    if (pending.has(item.id) || uncertain.has(item.id)) return;
    // A newer snapshot can win the refresh started by a conflict response.
    // On this explicit retry, use the latest known version and keep the choice.
    const current = records().find(record => record.id === item.id);
    if (current?.kind === 'personal' && current.raw.version > draft.version) draft.version = current.raw.version;
    drafts.set(item.id, draft); pending.add(item.id); error = ''; paint();
    try {
      const saved = await api.patch(`/inbox/${encodeURIComponent(item.raw.id)}/project`, { version: draft.version, projectId: draft.projectId });
      updated.set(saved.id, saved);
      // Do not discard another drawer's draft when a late response arrives.
      if (drafts.get(item.id) === draft) drafts.delete(item.id);
      try { await store.refresh(); snapshot = store.view.snapshot; }
      catch { loadError = '项目已保存，读取最新消息失败，请刷新核对。'; }
    } catch (cause) {
      if (!cause.status) uncertain.add(item.id);
      error = !cause.status ? '项目保存结果未知，请刷新核对归属，不要重复提交。' : `项目保存失败：${cause.message}`;
      try { await store.refresh(); snapshot = store.view.snapshot; } catch { /* Keep the draft and original failure visible. */ }
      if (cause.status === 409) {
        const latest = records().find(record => record.id === item.id);
        if (latest) draft.version = latest.raw.version;
      }
    } finally { pending.delete(item.id); paint(); }
  }
  function open(id) {
    selected = id; detailKey = undefined;
    if (!drawer) drawer = openDrawer({ title: `${name}消息详情`, body: [], footer: [], wide: true, onClose: () => { drawer = undefined; selected = undefined; detailKey = undefined; } });
    detail();
  }
  const expandedGroups = new Map();
  function chatKey(item) {
    const origin = item.raw.origin;
    if (originKind(item) !== 'group' || !origin.chatId) return;
    return JSON.stringify([origin.connector || item.raw.source || item.source, origin.chatId]);
  }
  function groupedRows(all, visible) {
    // 用全量历史识别同群已确认的项目，再按当前筛选结果聚合，避免跨页漏消息。
    const history = new Map(), groups = new Map(), rows = [];
    const projects = (snapshot?.projects ?? []).filter(p => !p.archivedAt);
    for (const item of all) {
      const key = chatKey(item), id = projectId(item);
      if (!key || !id) continue;
      if (!history.has(key)) history.set(key, new Set());
      history.get(key).add(id);
    }
    for (const item of visible) {
      const chat = chatKey(item);
      if (!chat) { rows.push(item); continue; }
      const project = projectId(item) || '';
      const id = JSON.stringify([project, chat]);
      let group = groups.get(id);
      if (!group) {
        const name = item.raw.origin.chatName || item.title;
        const prior = history.get(chat);
        const candidates = prior ? projects.filter(p => prior.has(p.id))
          : projects.filter(p => p.name.trim().length >= 2 && name.toLowerCase().includes(p.name.trim().toLowerCase()));
        group = { id, project, name, items: [], candidates, prior: Boolean(prior), latest: item };
        groups.set(id, group); rows.push(group);
      }
      group.items.push(item);
      if (item.time > group.latest.time) group.latest = item;
    }
    return rows;
  }
  function groupCard(group) {
    const { items, latest, candidates } = group;
    const limit = expandedGroups.get(group.id) || 0;
    const expand = n => { expandedGroups.set(group.id, n); paint(); };
    const suggested = candidates.length === 1 ? candidates[0] : undefined;
    return Card({ title: group.name, className: 'mailbox-group', sub: `${items.length} 条消息 · ${items.filter(i => i.raw.origin.mentionedMe).length} 条群@我 · ${items.filter(i => stage(i) === 'human').length} 条待人决策`,
      tools: Button({ label: limit ? '收起消息' : '展开消息', size: 'sm', onClick: () => expand(limit ? 0 : 10) }),
      body: h('div', { class: 'stack' },
        h('p', { class: 'mailbox-preview' }, '最近 · ', latest.raw.origin.senderName || latest.raw.sender || '群成员', ' · ', timeAgo(latest.time), '　', latest.text),
        !group.project && h('div', { class: 'small muted' }, suggested
          ? `建议合并到「${suggested.name}」：${group.prior ? '同群消息已有此归属' : '群名包含项目名'}。展开消息可逐条确认。`
          : candidates.length ? `同群涉及多个项目：${candidates.map(p => p.name).join('、')}。请按消息选择。`
          : h('span', null, '建议按此群集中跟进，可', h('a', { href: router.href('projects') }, '新建项目'), '或展开消息选择已有项目。')),
        items.slice(0, limit).map(item => h('div', { class: 'stack' }, card(item),
          !group.project && suggested && item.kind === 'personal' && Button({ label: `归入「${suggested.name}」`, size: 'sm',
            disabled: pending.has(item.id) || uncertain.has(item.id), onClick: () => saveProject(item, { projectId: suggested.id, version: item.raw.version }) }))),
        limit > 0 && limit < items.length && Button({ label: '更多群消息', size: 'sm', onClick: () => expand(limit + 10) })) });
  }
  function paint() {
    // Late reads and action completions can arrive after navigation. Keep their data,
    // but leave the hidden DOM untouched until onShow; alerts use global state.
    dirty = true;
    if (router.current.page !== direction) return;
    dirty = false;
    const all = records();
    if (incoming) paintFilters(all);
    const visible = all.filter(item => matches(item));
    if (incoming) visible.sort((a, b) => (stage(a) === 'human' ? 0 : 1) - (stage(b) === 'human' ? 0 : 1));
    const rows = incoming ? groupedRows(all, visible) : visible;
    const window = rows.slice(0, displayLimit);
    const grouped = rows.some(row => row.items);
    summary.textContent = `共 ${all.length} 条${incoming ? '收件' : '发件'}记录，显示 ${window.length} / 匹配 ${visible.length} 条`;
    if (grouped) summary.textContent = `匹配 ${visible.length} 条消息，按群聚合后显示 ${window.length} / ${rows.length} 项`;
    more.hidden = window.length >= rows.length;
    replace(notice, error && Banner({ tone: 'danger', children: error }), loadError && Banner({ tone: 'danger', children: loadError, action: Button({ label: '重试读取', size: 'sm', onClick: () => load() }) }),
      !incoming && deliveries.length >= 200 && h('p', { class: 'small muted' }, '自动发送记录当前展示最近 200 条。'));
    // Cache only the displayed window. Unchanged snapshots and read completions
    // preserve cards (and focus); signatures also cover action state and labels.
    if (grouped) {
      const sections = new Map();
      for (const row of window) {
        const key = row.items ? row.project : 'individual';
        if (!sections.has(key)) sections.set(key, []);
        sections.get(key).push(row);
      }
      const render = ([key, entries]) => h('section', { class: 'stack' },
        h('h2', null, key === 'individual' ? '其他消息' : key ? snapshot.projects.find(p => p.id === key)?.name || '项目不可用' : '未归项目'),
        entries.map(row => row.items ? groupCard(row) : card(row)));
      keyedList(list, [...sections], ([key]) => 'section:' + key, render, ([key, entries]) => JSON.stringify([
        key, entries, snapshot.projects, entries.flatMap(row => [expandedGroups.get(row.id),
          ...(row.items || [row]).map(item => [stage(item), pending.has(item.id), uncertain.has(item.id), handlingState(item)])])
      ]));
    } else if (visible.length) keyedList(list, window, item => item.id, card, item => JSON.stringify([
      item, incoming && projectName(item),
      incoming && handlingState(item),
      (snapshot?.todos ?? []).find(todo => todo.id === item.raw.todoId)?.projectId,
      pending.has(item.id), uncertain.has(item.id),
    ]));
    else {
      list._keyed = undefined;
      replace(list, loading && !loaded ? h('p', { role: 'status' }, '正在读取消息…') : loadError && !all.length ? null
      : Empty({ title: all.length ? '没有匹配的消息' : incoming ? '还没有收到消息' : '还没有发件记录',
        action: incoming && all.length ? Button({ label: '清除筛选', size: 'sm', onClick: clearFilters }) : undefined,
        text: all.length ? '试试其他关键词、来源、处理阶段或项目。' : incoming ? '开启飞书采集后，消息原文和分拣建议会出现在这里。' : '待确认的发送内容与实际发送结果会显示在这里。' }));
    }
    detail();
  }
  async function load() {
    const stamp = ++revision; loading = true; paint();
    const results = await Promise.allSettled([api.get(`/mailboxes?direction=${direction}`), ...(!incoming ? [api.get('/outbox')] : [])]);
    if (stamp !== revision) return;
    if (results[0].status === 'fulfilled') mailbox = results[0].value;
    if (results[1]?.status === 'fulfilled') deliveries = results[1].value;
    loadError = results.some(item => item.status === 'rejected') ? '部分消息记录读取失败，已保留当前可见内容。请重试读取。' : '';
    loaded = true; loading = false; paint();
  }
  query.addEventListener('input', resetWindow); filter.addEventListener('change', resetWindow); projectFilter.addEventListener('change', resetWindow);
  return { el, onShow() { snapshot = store.view.snapshot; if (dirty) paint(); lastSnapshot = snapshot; load(); }, onState({ snapshot: next }) {
    snapshot = next;
    dirty = true;
    if (router.current.page !== direction) return;
    paint();
    if (next !== lastSnapshot) { lastSnapshot = next; load(); }
  } };
}
