// CLI 元数据只证明历史。发现是只读操作，恢复只能提出审批。
import { h, replace } from '../lib/dom.js';
import { Button, Card, Banner, Empty, Input, Select, Pill } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';
import { messageFavoritesActive, openNativeMessages } from './message-favorites.js';
import { openSessionResume } from './session-resume.js';
import { createConversationSharing } from './conversation-sharing.js';
import { conversationExportActive, openConversationExport } from './conversation-export.js';

const wrap = { minWidth: '0', maxWidth: '100%', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' };
const text = (value) => h('p', { class: 'small', style: wrap }, value);
export function createCliSessions({ api, store, router }) {
  let data = null, error = '', loading = false, seq = 0, signature = '', identity = '', painted = '';
  const cache = new Map();
  const machines = Select({ options: [['', '全部电脑']], 'aria-label': 'CLI 会话电脑' });
  const projects = Select({ options: [['', '全部项目']], 'aria-label': 'CLI 会话项目' });
  const keyword = Input({ type: 'search', placeholder: '会话 ID、目录或执行者', 'aria-label': 'CLI 会话关键词' });
  const list = h('div', { class: 'stack', style: { ...wrap, maxHeight: 'min(60vh, 640px)', overflowY: 'auto' } });
  const notice = h('div');
  const sharing=createConversationSharing({api,store});
  let shareSource,shareOwner,sourcesDrawer;
  const sharedSources=Button({label:'已分享的原生会话',size:'sm',onClick:openSharedSources});
  sharedSources.hidden=true;
  const el = Card({ title: 'CLI会话', id: 'agent-cli-sessions', sub: '独立 CLI 的历史记录（只读）',
    tools: h('div',{class:'row row--wrap'},sharedSources,Button({ label: '重新读取', size: 'sm', onClick: () => load(true) })),
    body: [text('历史 ≠ 当前运行或空闲；恢复前请确认原终端已停止。'),
      h('div', { class: 'stack', style: { ...wrap, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))' } }, machines, projects, keyword), notice, list] });
  const visible = () => router.current.page === 'agent';
  const context = () => JSON.stringify([api.token(), store.view.connection, store.view.unauthorized]);
  const ready = () => store.view.connection === 'online' && !store.view.unauthorized;
  const selection = () => new URLSearchParams({ ...(machines.value ? { machineId: machines.value } : {}), ...(projects.value ? { projectId: projects.value } : {}) }).toString();
  function invalidate() { seq++; cache.clear(); data = null; loading = false; error = ''; }
  let exportDrawer;
  const canExport = machineId => ready() && conversationExportActive(store) && store.view.snapshot?.machines?.some(
    machine => machine.id === machineId && machine.online && machine.capabilities?.includes('agents.transcript'),
  );

  function sharingActive() {
    return visible() && !store.view.unauthorized && Boolean(api.draftOwner?.()) && api.draftOwner()===store.view.snapshotOwner &&
      store.view.snapshot?.plugins?.some(p=>p.id==='conversation-sharing' && p.status==='active');
  }
  function openSharing(machineId,{executorId,nativeSessionId,cwd}) {
    if (!sharingActive()) return;
    sourcesDrawer?.close();
    shareOwner=api.draftOwner();shareSource={native:{machineId,executorId,nativeSessionId,cwd}};
    sharing.update(shareSource);sharing.open();
  }
  async function openSharedSources() {
    if (!sharingActive()) return;
    sourcesDrawer?.close();
    const owner=api.draftOwner();shareOwner=owner;
    const drawer=openDrawer({title:'已分享的原生会话',body:text('正在读取已分享的会话…')});
    sourcesDrawer=drawer;
    const current=()=>drawer.el.open && sourcesDrawer===drawer && sharingActive() && owner===api.draftOwner();
    try {
      const {sources}=await api.post('/conversation-shares',{action:'native_sources'});
      if (!current()) return;
      replace(drawer.body,sources.length?sources.map(native=>{
        const machine=store.view.snapshot?.machines?.find(item=>item.id===native.machineId);
        return h('div',{class:'item'},h('div',{class:'item__main'},h('strong',{},native.executorId+' · '+native.nativeSessionId),
          text((machine?.name || native.machineId)+' · '+native.cwd)),
          Button({label:'管理分享',size:'sm',onClick:()=>{if(current())openSharing(native.machineId,native);}}));
      }):text('还没有已分享的原生会话。'));
    } catch(cause) {if(current())replace(drawer.body,h('p',{role:'alert'},cause.message));}
  }
  function exportHistory(machineId, { executorId, nativeSessionId, cwd }, button) {
    exportDrawer?.close();
    exportDrawer = openConversationExport({
      api, store, source: { native: { machineId, executorId, nativeSessionId, cwd } },
      subtitle: `${executorId} · ${nativeSessionId}`,
      isCurrent: () => visible() && button.isConnected && canExport(machineId),
    });
  }
  function paint() {
    const renderKey = JSON.stringify([ready(), sharingActive(), conversationExportActive(store), messageFavoritesActive(store), error, loading, data, keyword.value.trim().toLowerCase(), machines.value, signature]);
    if (renderKey === painted) return;
    painted = renderKey;
    exportDrawer?.close();
    replace(notice, !ready() ? Banner({ tone: 'warn', children: '连接不可用，请连接服务后重新读取。' })
      : error ? Banner({ tone: 'danger', children: `读取失败：${error}` }) : loading ? text('正在读取 CLI 历史…') : data ? [text(`采集时间：${data.capturedAt}`), data.reason && Banner({ tone: 'warn', children: data.reason })] : null);
    const query = keyword.value.trim().toLowerCase();
    const groups = (data?.machines ?? []).filter(m => !machines.value || machines.value === m.machineId);
    replace(list, groups.map(machine => {
      const rows = machine.sessions.filter(s => `${s.nativeSessionId} ${s.cwd} ${s.executorId}`.toLowerCase().includes(query));
      const current = store.view.snapshot?.machines?.find(m => m.id === machine.machineId);
      const online = machine.online && (current ? current.online : true);
      return h('section', { class: 'stack', style: wrap, dataset: { cliMachine: machine.machineId } },
        h('h3', { style: wrap }, `${machine.machineName} · ${online ? '在线' : '离线'} · ${rows.length} 条记录`),
        machine.reason && text(machine.reason), ...machine.roots.map(root => text(`读取根目录：${root}`)),
        (machine.warnings.length > 0 || machine.truncated) && h('details', { class: 'small', style: wrap },
          h('summary', { style: { cursor: 'pointer' } }, machine.truncated ? '结果已截断，展开查看读取说明' : `${machine.warnings.length} 条读取说明`),
          h('ul', {}, machine.warnings.map(warning => h('li', {}, warning)), machine.truncated && h('li', {}, '这里只显示本次已返回的记录。'))),
        ...rows.map(session => h('article', { class: 'card card--tight', style: wrap, dataset: { cliSession: session.id } },
          h('div', { class: 'card__body stack', style: wrap },
            h('div', { class: 'row row--wrap' }, Pill(session.archived ? '已归档' : '历史'), Pill('只读'), text(session.executorId)),
            text(`原生 ID：${session.nativeSessionId}`), text(`目录：${session.cwd}`),
            text(`观测时间：${session.observedAt}\n元数据时间：${session.metadataTimestamp ?? '未知'}\n文件记录更新：${session.fileModifiedAt ?? '未知'}\n来源：session-metadata`),
            session.parentNativeSessionId && text(`父会话：${session.parentNativeSessionId}`),
            session.relatedRunIds.length > 0 && h('div', { class: 'row row--wrap' }, session.relatedRunIds.map(id => Button({ label: `查看关联执行 ${id}`, size: 'sm', onClick: () => router.go(router.href('projects', 'all', 'runs', id)) }))),
            online && ready() && messageFavoritesActive(store) && current?.capabilities?.includes('agents.transcript') &&
              Button({ label: '查看消息', size: 'sm', onClick: () => openNativeMessages({ api, store, native: {
                machineId: machine.machineId, executorId: session.executorId, nativeSessionId: session.nativeSessionId, cwd: session.cwd,
              } }) }),
            sharingActive() && Button({ label:'分享对话摘录',size:'sm',onClick:()=>openSharing(machine.machineId,session) }),
            online && canExport(machine.machineId) && Button({ label: '导出对话', size: 'sm', onClick: (_, button) => exportHistory(machine.machineId, session, button) }),
            online && current?.capabilities.includes('agents.usage') && Button({ label: '上下文与 Token 用量', size: 'sm', onClick: () => openUsage(machine, session) }),
            session.resumable && online && machine.available
              ? Button({ label: '申请恢复', size: 'sm', onClick: () => openSessionResume({ api, store, router, machine, session, projectId: projects.value }) })
              : text(session.reason || machine.reason || (!online ? '电脑离线，不能申请恢复。' : '此记录暂不支持恢复。'))))),
        !rows.length && Empty({ title: machine.available && online ? '没有符合条件的历史记录' : '暂时无法读取会话', text: machine.reason || (!online ? '电脑离线' : undefined) }));
    }));
    if (data && !groups.length) list.append(Empty({ title: '没有符合条件的电脑' }));
  }
  async function load(force = false) {
    if (!visible()) return;
    if (identity !== context()) { identity = context(); invalidate(); }
    if (!ready()) { paint(); return; }
    const key = selection(), cached = cache.get(key);
    if (!force && cached && Date.now() - cached.at < 30000) { seq++; loading = false; data = cached.data; error = ''; paint(); return; }
    const stamp = ++seq, auth = context();
    data = null; error = ''; loading = true; paint();
    try {
      const result = await api.get(`/agents/sessions${key ? `?${key}` : ''}`);
      if (stamp !== seq || auth !== context() || !visible()) return;
      data = result; cache.set(key, { at: Date.now(), data });
    } catch (cause) { if (stamp !== seq || auth !== context() || !visible()) return; error = cause.message; }
    if (stamp === seq) { loading = false; paint(); }
  }
  function update() {
    sharedSources.hidden=!sharingActive();
    if (sharedSources.hidden || shareOwner!==api.draftOwner()) {shareSource=undefined;sourcesDrawer?.close();}
    sharing.update(shareSource);
    const next = JSON.stringify((store.view.snapshot?.machines ?? []).map(m => [m.id, m.name, m.online, m.connectedAt, m.capabilities]));
    const changed = next !== signature || identity !== context();
    if (changed) { signature = next; identity = context(); invalidate(); }
    const sync = (control, entries, label) => {
      const value = control.value;
      replace(control, h('option', { value: '' }, label), entries.map(([id, name]) => h('option', { value: id }, name)));
      control.value = entries.some(([id]) => id === value) ? value : '';
    };
    sync(machines, (store.view.snapshot?.machines ?? []).map(m => [m.id, m.name]), '全部电脑');
    const before = projects.value;
    sync(projects, (store.view.snapshot?.projects ?? []).filter(p => !p.archivedAt).map(p => [p.id, p.name]), '全部项目');
    if (visible() && (changed || before !== projects.value)) load();
    else if (visible()) paint();
  }
  for (const control of [machines, projects]) control.addEventListener('change', () => load());
  keyword.addEventListener('input', paint);
  router.subscribe(route => { if (route.page !== 'agent') { sharing.update(undefined);shareSource=undefined;sourcesDrawer?.close();seq++; loading = false; } });

  async function openUsage(machine, session) {
    const body = h('div', { class: 'stack' }, text('正在读取会话日志…'));
    const drawer = openDrawer({ title: '上下文与 Token 用量', subtitle: session.nativeSessionId, body });
    const auth = context();
    const query = new URLSearchParams({ machineId: machine.machineId, executorId: session.executorId, nativeSessionId: session.nativeSessionId, cwd: session.cwd });
    try {
      const usage = await api.get('/agents/sessions/usage?' + query);
      if (!drawer.el.open || auth !== context()) return;
      const names = { input: '输入', cached: '缓存读取', cacheWrite: '缓存创建', output: '输出', reasoning: '推理', total: '合计' };
      const describe = record => Object.entries(record).map(([k, n]) => (names[k] ?? k) + ' ' + n.toLocaleString()).join(' · ') || '日志未提供';
      replace(body,
        usage.partial && Banner({ tone: 'warn', children: '只统计了可读取的日志片段。大文件最多读取末尾 8 MiB。' }),
        text('用户消息记录 ' + usage.userMessages + ' · 助手消息记录 ' + usage.assistantMessages + ' · 工具调用记录 ' + usage.toolCalls),
        usage.tools.length > 0 && text('工具：' + usage.tools.map(tool => tool.name + ' × ' + tool.calls).join('、')),
        h('strong', null, session.executorId === 'codex' ? '日志报告的累计用量' : '已读消息去重后的用量'),
        text(describe(usage.cumulative)), text('模型上下文窗口：' + (usage.windowTokens?.toLocaleString() ?? '未知')),
        text(session.executorId === 'codex' ? '输入包含缓存读取，输出包含推理。' : '普通输入、缓存读取和缓存创建分别计数。'),
        h('strong', null, '最近用量记录（最新在前）'),
        usage.records.length ? usage.records.map(r => text(describe(r))) : text('日志未提供用量记录。'));
    } catch (error) { if (drawer.el.open && auth === context()) replace(body, text(error.message)); }
  }

  return { el, onShow() { update(); if (!loading) load(); }, onState: update };
}
