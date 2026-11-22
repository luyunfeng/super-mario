import { h, replace } from '../lib/dom.js';
import { Banner, Button, Card, Empty, Pill } from '../ui/kit.js';
import { renderFormattedText } from '../lib/markdown.js';
import { openDrawer } from '../ui/overlay.js';

const STATES = { working: '正在工作', blocked: '等待你输入', idle: '等待输入', done: '终端已停下', unknown: '状态待确认' };
const encode = text => btoa(Array.from(new TextEncoder().encode(text), value => String.fromCharCode(value)).join(''));

/** External live panes are observed in place. No Run, resume, or completion is invented. */
export function createLiveTerminals({ api, store, router }) {
  let projectId = 'all', rows = [], loading = false, error = '', revision = 0, timer, drawer;
  let closeTerminal = () => {}, signature = '', openedItem;
  let historyRows = [], historyLoading = false, historyError = '', historyLimit = 15;
  const body = h('div', { class: 'stack' });
  const wallLink = h('a', { class: 'btn btn--sm btn--primary', href: '/terminals.html', target: '_blank', rel: 'noopener' }, '多屏现场墙 ↗');
  const el = Card({ title: '项目会话（现场 + 历史）', sub: '合并展示项目目录及子目录下的活终端与历史 CLI 对话，按会话去重', id: 'project-live-terminals', tools: wallLink, body });
  const visible = () => router.current.page === 'projects' && router.current.parts?.[1] === 'runs' && !router.current.parts?.[2];
  const context = () => JSON.stringify([api.token?.(), projectId, store.view.snapshot?.projects?.find(p => p.id === projectId)?.workspace,
    store.view.snapshot?.projects?.find(p => p.id === projectId)?.archivedAt,
    (store.view.snapshot?.machines ?? []).map(m => [m.id, m.online, m.connectedAt, m.agentInstanceId, m.capabilities])]);
  const call = (machineId, method, params) => api.post(`/machines/${encodeURIComponent(machineId)}/call`, { method, params });
  function paintHistory() { paint(); }
  async function loadHistory() {
    if (!visible()) return;
    historyLoading = true; historyError = ''; paint();
    try {
      const qs = projectId !== 'all' ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const data = await api.get(`/agents/sessions${qs}`);
      const list = (data.machines ?? []).flatMap(m => (m.sessions ?? []).map(s => ({ ...s, machineId: m.machineId, machineName: m.machineName })));
      list.sort((a, b) => String(b.fileModifiedAt || b.metadataTimestamp || '').localeCompare(String(a.fileModifiedAt || a.metadataTimestamp || '')));
      historyRows = list;
    } catch (cause) { historyError = cause.message; }
    historyLoading = false; paint();
  }
  function openHistoryAnalysis(session) {
    const box = h('div', { class: 'stack' }, h('p', { role: 'status' }, '正在读取并分析完整对话…'));
    let timerId, closed = false;
    openDrawer({
      title: `会话分析 · ${session.executorId}`,
      sub: `${session.machineName || session.machineId} · ${session.cwd}`,
      body: box,
      onClose() { closed = true; clearTimeout(timerId); },
    });
    const poll = async job => {
      if (closed) return;
      if (job.status === 'done') {
        replace(box, h('div', { class: 'msg__bubble' }, renderFormattedText(job.result?.summary || '分析已完成。')));
        return;
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        replace(box, Banner({ tone: 'danger', children: job.error || '分析未完成。' }));
        return;
      }
      replace(box, h('p', { role: 'status' }, `${job.progress || '正在分析完整对话…'}`));
      timerId = setTimeout(async () => {
        try { await poll(await api.get(`/agents/sessions/analysis/${encodeURIComponent(job.id)}`)); }
        catch (cause) { if (!closed) replace(box, Banner({ tone: 'danger', children: cause.message })); }
      }, 1500);
    };
    api.post('/agents/sessions/analyze', { machineId: session.machineId, executorId: session.executorId, nativeSessionId: session.nativeSessionId, cwd: session.cwd })
      .then(poll)
      .catch(cause => { if (!closed) replace(box, Banner({ tone: 'danger', children: cause.message })); });
  }
  function paint() {
    const project = store.view.snapshot?.projects?.find(p => p.id === projectId && !p.archivedAt);
    const rootCwd = project?.workspace?.cwd || '';
    const relOf = dir => !rootCwd || dir === rootCwd ? dir : dir.startsWith(rootCwd + '/') ? './' + dir.slice(rootCwd.length + 1) : dir;
    const liveIds = new Set(rows.map(r => r.nativeSessionId).filter(Boolean));
    const dedupHistory = historyRows.filter(s => !liveIds.has(s.nativeSessionId));
    const liveItems = rows.map(item => {
      const execId = item.agent === 'claude' || item.agent === 'claude-code' ? 'claude-code' : item.agent;
      return h('article', { class: 'item', dataset: { livePane: item.paneId }, style: { minWidth: 0 } },
        h('div', { class: 'item__main', style: { overflowWrap: 'anywhere' } },
          h('strong', null, item.title), h('p', { class: 'small muted' }, `${item.agent} · ${item.machineName} · ${relOf(item.cwd)}`),
          h('div', { class: 'row row--wrap' }, Pill(STATES[item.state] ?? '状态待确认', item.state === 'working' ? 'info' : ''), Pill('现场运行中', 'ok'))),
        h('div', { class: 'row' },
          item.nativeSessionId && Button({ label: '分析对话', size: 'sm', onClick: () => openHistoryAnalysis({ machineId: item.machineId, machineName: item.machineName, executorId: execId, nativeSessionId: item.nativeSessionId, cwd: item.cwd }) }),
          Button({ label: '打开现场', size: 'sm', onClick: () => open(item) })));
    });
    const histItems = dedupHistory.slice(0, historyLimit).map(s => h('article', { class: 'item', style: { minWidth: 0 } },
      h('div', { class: 'item__main', style: { overflowWrap: 'anywhere' } },
        h('strong', null, `${s.executorId} · ${relOf(s.cwd)}`),
        h('p', { class: 'small muted' }, `${s.metadataTimestamp || s.fileModifiedAt || '时间未知'} · ${s.nativeSessionId}`),
        h('div', { class: 'row row--wrap' }, Pill('历史会话'))),
      Button({ label: '分析对话', size: 'sm', onClick: () => openHistoryAnalysis(s) })));
    replace(body,
      error && Banner({ tone: 'warn', children: error }),
      historyError && Banner({ tone: 'warn', children: historyError }),
      (loading || historyLoading) && !liveItems.length && !histItems.length ? h('p', { class: 'small muted' }, '正在扫描现场终端与历史会话…')
        : (liveItems.length || histItems.length) ? [
          ...liveItems,
          ...histItems,
          dedupHistory.length > historyLimit && Button({ label: `显示其余 ${dedupHistory.length - historyLimit} 条历史会话`, size: 'sm', onClick: () => { historyLimit += 30; paint(); } }),
        ]
        : !loading && !historyLoading && Empty({ title: error ? '现场终端暂不可用' : '当前目录及子目录暂无可见会话', text: '正在运行的终端与历史 CLI 会话都会合并显示在这里；工作台派发记录显示在下方。' }),
      h('div', { class: 'row' }, Button({ label: '重新读取现场', size: 'sm', onClick: () => { void load(); void loadHistory(); } })));
  }
  async function load() {
    clearTimeout(timer);
    if (!visible()) return;
    const stamp = ++revision, identity = context(), project = store.view.snapshot?.projects?.find(p => p.id === projectId && !p.archivedAt);
    const machines = (store.view.snapshot?.machines ?? []).filter(m => m.online && (projectId === 'all' || project?.workspace?.machineId === m.id));
    loading = true; error = ''; paint();
    const results = await Promise.allSettled(machines.map(async machine => {
      if (!machine.capabilities?.includes('terminal.live.list')) throw new Error(`${machine.name} 的代理尚未支持现场终端，请更新代理`);
      const data = await call(machine.id, 'terminal.live.list', project?.workspace ? { cwd: project.workspace.cwd } : {});
      if (!Array.isArray(data.panes)) throw new Error('现场终端列表无效');
      return data.panes.map(pane => ({ ...pane, machineId: machine.id, machineName: machine.name }));
    }));
    if (stamp !== revision || identity !== context() || !visible()) return;
    const nextRows = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    if (openedItem && !nextRows.some(item => item.machineId === openedItem.machineId && item.paneId === openedItem.paneId && item.terminalId === openedItem.terminalId && item.cwd === openedItem.cwd)) closeTerminal();
    rows = nextRows;
    error = results.filter(result => result.status === 'rejected').map(result => result.reason.message).join('；');
    if (!machines.length) error = projectId !== 'all' ? '项目绑定的电脑未连接，或项目尚未绑定目录。' : '还没有在线执行机。';
    loading = false; paint(); timer = setTimeout(load, 5000);
  }
  function open(item) {
    closeTerminal(); openedItem = item;
    const identity = context(), token = api.token?.();
    let lease, epoch = 0, disposed = false, frameTimer, terminal, controlling = false, ready = false, writes = Promise.resolve();
    const current = stamp => !disposed && stamp === epoch && identity === context() && token === api.token?.();
    const screen = h('div', { class: 'console-screen', style: { maxWidth: '100%', overflow: 'auto', minHeight: '320px', background: '#101719' } });
    const status = h('p', { role: 'status', class: 'small' }, '正在连接现场终端…');
    const failure = h('div');
    let analysisTimer, analysing = false;
    const analysis = h('section', { hidden: true, class: 'stack', 'aria-label': '对话分析结果', style: { overflowWrap: 'anywhere' } });
    const analysisCurrent = () => !disposed && identity === context() && token === api.token?.();
    const analyse = Button({ label: '一键分析完整对话', onClick: async () => {
      if (analysing) return;
      analysing = true; analyse.disabled = true; analysis.hidden = false;
      replace(analysis, h('p', { role: 'status' }, '正在定位完整原生会话…'));
      try {
        const executorId = item.agent === 'claude' || item.agent === 'claude-code' ? 'claude-code' : item.agent;
        let nativeSessionId = item.nativeSessionId;
        if (!nativeSessionId) {
          const project = store.view.snapshot?.projects?.find(p => p.id === projectId && !p.archivedAt);
          const rootCwd = project?.workspace?.cwd || item.cwd;
          const data = await api.get(`/agents/sessions/analysis-sources?machineId=${encodeURIComponent(item.machineId)}&cwd=${encodeURIComponent(rootCwd)}`);
          if (!analysisCurrent()) return;
          const inDir = (base, target) => target === base || target.startsWith(base.endsWith('/') ? base : base + '/');
          const sessions = (data.sessions ?? []).filter(session => inDir(rootCwd, session.cwd) && (!executorId || executorId === 'terminal' || session.executorId === executorId));
          if (!sessions.length) throw new Error('未找到这个目录及子目录的完整会话记录。不会用最近输出代替。');
          replace(analysis, data.truncated && Banner({ tone: 'warn', children: '会话列表未完全读取；请选择已核验的会话，分析时仍会核验其完整日志。' }),
            h('p', null, '终端未提供可核验的会话 ID。请选择要分析的完整会话（含子目录）：'),
            ...sessions.map(session => {
              const rel = session.cwd === rootCwd ? '.' : session.cwd.slice(rootCwd.length).replace(/^\/+/, '');
              return Button({ label: `${session.metadataTimestamp || session.fileModifiedAt || '时间未知'} · ${rel} · ${session.nativeSessionId}`, onClick: () => begin(session.executorId, session.nativeSessionId, session.cwd) });
            }));
          analysing = false; analyse.disabled = false; return;
        }
        await begin(executorId, nativeSessionId, item.cwd);
      } catch (cause) { if (analysisCurrent()) { replace(analysis, Banner({ tone: 'danger', children: cause.message })); analysing = false; analyse.disabled = false; } }
    } });
    async function begin(executorId, nativeSessionId, targetCwd = item.cwd) {
      if (!analysisCurrent()) return;
      analysing = true; analyse.disabled = true;
      replace(analysis, h('p', { role: 'status' }, '正在读取整个会话…'));
      try {
        const job = await api.post('/agents/sessions/analyze', { machineId: item.machineId, executorId, nativeSessionId, cwd: targetCwd });
        if (!analysisCurrent()) return;
        await watchAnalysis(job);
      } catch (cause) { if (analysisCurrent()) { replace(analysis, Banner({ tone: 'danger', children: cause.message })); analysing = false; analyse.disabled = false; } }
    }
    async function watchAnalysis(job) {
      if (!analysisCurrent()) return;
      replace(analysis, h('strong', null, '完整对话分析'), h('p', { class: 'small muted' }, `会话：${job.nativeSessionId}`),
        job.text ? renderFormattedText(job.text) : h('p', { role: 'status', class: 'small' }, job.detail),
        ['failed', 'unknown'].includes(job.status) && Banner({ tone: 'danger', children: job.detail }));
      if (['done', 'failed', 'unknown'].includes(job.status)) { analysing = false; analyse.disabled = false; return; }
      analysisTimer = setTimeout(async () => {
        try { const value = await api.get(`/agents/sessions/analysis/${encodeURIComponent(job.id)}`); await watchAnalysis(value); }
        catch (cause) { if (analysisCurrent()) { replace(analysis, Banner({ tone: 'danger', children: cause.message })); analysing = false; analyse.disabled = false; } }
      }, 1000);
    }
    const recent = h('pre', { hidden: true, class: 'small', style: { maxHeight: '360px', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } });
    const control = Button({ label: '接管输入', kind: 'primary', disabled: true, onClick: () => connect(controlling ? 'observe' : 'control') });
    function controls() {
      control.disabled = !ready; control.textContent = controlling ? '停止接管' : '接管输入';
      terminal?.options && (terminal.options.disableStdin = !controlling || !ready);
    }
    async function release(value) { if (value) await call(item.machineId, 'terminal.live.release', { connectionId: value }).catch(() => {}); }
    closeTerminal = () => {
      if (disposed) return;
      disposed = true; openedItem = undefined; epoch++; clearTimeout(frameTimer); clearTimeout(analysisTimer); terminal?.dispose(); void release(lease); lease = undefined;
      if (drawer?.el.open) drawer.close(); drawer = undefined;
    };
    drawer = openDrawer({ title: '现场终端', subtitle: `${item.agent} · ${item.cwd}`, wide: true,
      body: [h('div', { class: 'row row--wrap' }, analyse, h('span', { class: 'small muted' }, '完整会话分段分析，结果显示在下方')), analysis, h('p', { class: 'small muted' }, '打开后只读观察。接管后可直接在终端输入；关闭只断开连接，不停止 Codex 或其他 CLI。终端状态不代表业务任务已完成。'), status, failure, screen, recent],
      footer: [Button({ label: '关闭观察', onClick: closeTerminal }), Button({ label: '最近输出', onClick: async () => {
        const stamp = epoch;
        try { const value = await call(item.machineId, 'terminal.live.read', { paneId: item.paneId, terminalId: item.terminalId, cwd: item.cwd });
          if (current(stamp)) { recent.hidden = false; recent.textContent = `最近终端输出（最多300行，不代表完整历史）\n\n${value.text}`; }
        } catch (cause) { if (current(stamp)) replace(failure, Banner({ tone: 'danger', children: cause.message })); }
      } }), Button({ label: '重新观察', onClick: () => connect('observe') }), control], onClose: closeTerminal });
    if (typeof globalThis.Terminal !== 'function') { replace(failure, Banner({ tone: 'danger', children: '终端显示组件未加载，请重新打开页面。' })); return; }
    terminal = new globalThis.Terminal({ disableStdin: true, cursorBlink: false, scrollback: 1000, fontSize: 13, minimumContrastRatio: 7, theme: { background: '#101719', foreground: '#e6edf3', cursor: '#f8fafc', selectionBackground: '#40546c', black: '#101719', red: '#ff7b86', green: '#9cdb86', yellow: '#e8ca77', blue: '#86b7ff', magenta: '#d6a0ef', cyan: '#86d7db', white: '#e6edf3', brightBlack: '#a8b3bd', brightRed: '#ffa1a8', brightGreen: '#b9efa1', brightYellow: '#ffe099', brightBlue: '#adcfff', brightMagenta: '#e7bdff', brightCyan: '#b2eff2', brightWhite: '#ffffff' } });
    terminal.open(screen);
    terminal.onData(data => {
      if (!controlling || !ready || !current(epoch)) return;
      const stamp = epoch, id = lease;
      // Preserve ordering. A failed input closes control rather than replaying bytes.
      writes = writes.then(async () => { if (current(stamp) && ready) await call(item.machineId, 'terminal.live.input', { connectionId: id, data: encode(data) }); })
        .catch(cause => { if (current(stamp)) { epoch++; clearTimeout(frameTimer); ready = false; controlling = false; controls(); status.textContent = '现场连接已断开'; replace(failure, Banner({ tone: 'danger', children: `${cause.message}。输入未自动重试。` })); void release(lease); lease = undefined; } });
    });
    async function poll(stamp, seq = -1) {
      if (!current(stamp)) { closeTerminal(); return; }
      try {
        const value = await call(item.machineId, 'terminal.live.frames', { connectionId: lease, after: seq });
        if (!current(stamp)) return;
        for (const frame of value.frames) {
          if (terminal.cols !== frame.width || terminal.rows !== frame.height) terminal.resize(frame.width, frame.height);
          // Keep clear + repaint in one synchronized write; never expose a blank reset frame.
          const bytes = (frame.full ? '\x1bc' : '') + '\x1b[?2026h' + atob(frame.data) + '\x1b[?2026l';
          await new Promise(resolve => terminal.write(Uint8Array.from(bytes, char => char.charCodeAt(0)), resolve));
          if (!current(stamp)) return;
          seq = frame.seq; ready = true;
        }
        status.textContent = controlling ? '已接管：可直接在终端中输入' : '正在观察现场画面（只读）'; controls();
        frameTimer = setTimeout(() => poll(stamp, seq), 400);
      } catch (cause) { if (current(stamp)) { epoch++; clearTimeout(frameTimer); ready = false; controlling = false; controls(); status.textContent = '现场连接已断开'; replace(failure, Banner({ tone: 'danger', children: cause.message })); void release(lease); lease = undefined; } }
    }
    async function connect(mode) {
      const stamp = ++epoch; clearTimeout(frameTimer); ready = false; controlling = false; controls(); replace(failure);
      const previous = lease; lease = undefined; await release(previous);
      if (!current(stamp)) return;
      status.textContent = mode === 'control' ? '正在取得现场输入控制…' : '正在连接现场画面…';
      try {
        const value = await call(item.machineId, 'terminal.live.open', { paneId: item.paneId, terminalId: item.terminalId, cwd: item.cwd, mode });
        if (!current(stamp)) { await release(value.connectionId); return; }
        lease = value.connectionId; controlling = mode === 'control';
        if (controlling) terminal.focus();
        await poll(stamp);
      } catch (cause) { if (current(stamp)) { status.textContent = '无法接入此现场终端'; replace(failure, Banner({ tone: 'danger', children: cause.message })); } }
    }
    void connect('observe');
  }
  router.subscribe(() => { if (!visible()) { clearTimeout(timer); revision++; closeTerminal(); } });
  return { el, show(id) { if (id !== projectId) { projectId = id; wallLink.href = id && id !== 'all' ? `/terminals.html?projectId=${encodeURIComponent(id)}` : '/terminals.html'; revision++; rows = []; historyRows = []; closeTerminal(); signature = context(); } if (visible()) { void load(); void loadHistory(); } }, update() {
    const key = context(); if (key !== signature) { signature = key; revision++; rows = []; historyRows = []; closeTerminal(); if (visible()) { void load(); void loadHistory(); } }
  } };
}
