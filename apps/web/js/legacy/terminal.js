import { recoverySummary, recoveryUnavailable, legacyRecovery, unsupportedApi } from '../features/agent-diagnostics.js';

// This drawer observes a session. Closing it never cancels a run or sends executor input.
export function createConsole({ api, getToken }) {
  function node(tag, text, className) {
    const value = document.createElement(tag);
    if (text !== undefined) value.textContent = text;
    if (className) value.className = className;
    return value;
  }
  const drawer = node('dialog', undefined, 'console-drawer');
  drawer.setAttribute('aria-labelledby', 'console-title');
  const heading = node('h2', '会话控制台'); heading.id = 'console-title';
  const closeButton = node('button', '关闭观察', 'secondary'); closeButton.type = 'button';
  const takeControl = node('button', '接管输入', 'secondary'); takeControl.type = 'button';
  const reconnect = node('button', '重新同步画面', 'secondary'); reconnect.type = 'button';
  const context = node('p', '', 'console-context muted');
  const topline = node('div', undefined, 'console-topline'); topline.append(heading, takeControl, reconnect, closeButton);
  const status = node('p', '', 'notice'); status.setAttribute('role', 'status');
  const failure = node('p'); failure.setAttribute('role', 'alert'); failure.hidden = true;
  const recoveryNotice = node('p', '', 'console-context muted');
  const historyLink = node('a', '查看原生 CLI 历史与恢复入口'); historyLink.href = '#agent'; historyLink.hidden = true;
  historyLink.addEventListener('click', close);
  const screen = node('div', undefined, 'console-screen');
  const form = node('form', undefined, 'form-grid');
  const label = node('label', '发送消息（自动回车）');
  const input = node('textarea'); input.name = 'text'; input.maxLength = 20000; label.append(input);
  const send = node('button', '发送消息'); send.type = 'submit';
  const interrupt = node('button', '中断会话', 'secondary'); interrupt.type = 'button';
  const modeNotice = node('p', '任务模式，补充要求请新建任务；需要持续对话请选择交互模式', 'muted');
  modeNotice.hidden = true;
  form.append(modeNotice, label, send, interrupt);
  drawer.append(topline, context, node('p', '这里只显示当前终端画面，不是完整日志。关闭只断开观察。', 'muted'), status, recoveryNotice, historyLink, failure, screen, form);
  document.body.append(drawer);
  let terminal, socket, retry, binding, run, revision = 0, ready = false, writing = false, controlling = false, previousFocus, tokenAtOpen, tokenTimer, recoveryEntry, recoveryBlocked = false;
  form.classList.add('console-controls');
  function controls() {
    const unavailable = !binding || !ready || writing || recoveryBlocked;
    const writable = !recoveryBlocked && recoveryEntry?.canControl !== false;
    reconnect.disabled = !binding || writing || recoveryBlocked;
    const task = run?.executionMode === 'task';
    const bound = Boolean(run?.sessionId);
    const active = bound && ['queued', 'running', 'unknown'].includes(run?.status);
    takeControl.hidden = !writable || !active || run?.executionMode !== 'interactive'; takeControl.disabled = unavailable; takeControl.textContent = controlling ? '停止接管' : '接管输入';
    send.disabled = !writable || unavailable || !active || run?.executionMode !== 'interactive' || !controlling;
    input.disabled = send.disabled;
    interrupt.disabled = !writable || unavailable || !active;
    label.hidden = !bound || !writable; send.hidden = !bound || !writable; interrupt.hidden = !bound || !writable;
    modeNotice.hidden = false;
    modeNotice.textContent = !writable ? '恢复状态未允许控制；此处只保留可核对的观察或历史。' : !bound ? '只读观察：此终端没有可控制的工作台执行记录。' : !active ? '执行已结束，保留画面仅供核对。' : task ? '任务模式，补充要求请新建任务；需要持续对话请选择交互模式' : !controlling ? '当前只读观察。需要补充要求时先接管输入。' : '交互模式：发送文本会提交给当前会话。外部动作结果以实际回执为准。';
  }
  function error(message = '') { failure.textContent = message; failure.hidden = !message; }
  function close() {
    clearInterval(tokenTimer);
    recoveryEntry = undefined; recoveryBlocked = false; recoveryNotice.textContent = ''; historyLink.hidden = true;
    revision++; writing = false; controlling = false; clearTimeout(retry); ready = false; binding = undefined; run = undefined; controls();
    if (socket) { socket.onclose = null; socket.close(); socket = undefined; }
    terminal?.dispose(); terminal = undefined; screen.replaceChildren(); input.value = ''; error();
    if (drawer.open) drawer.close();
    previousFocus?.focus();
  }
  function valid(current) {
    if (current !== revision) return false;
    if (getToken() !== tokenAtOpen) { close(); return false; }
    return drawer.open;
  }
  async function readRecovery(item, found, current) {
    if (!valid(current)) return;
    const snapshot = await api('/state');
    if (!valid(current)) return;
    const recoveryMachine = snapshot?.machines?.find(m => m.id === item.machineId);
    recoveryEntry = undefined; recoveryBlocked = false;
    if (!recoveryMachine) { recoveryBlocked = true; recoveryNotice.textContent = recoveryUnavailable; return; }
    if (!recoveryMachine?.capabilities?.includes('executor.recovery')) {
      recoveryNotice.textContent = legacyRecovery; return;
    }
    let data;
    try { data = await api(`/machines/${encodeURIComponent(item.machineId)}/recovery${item.sessionId ? `?sessionId=${encodeURIComponent(item.sessionId)}` : ''}`); }
    catch (err) {
      if (!valid(current)) return;
      if (unsupportedApi(err)) { recoveryNotice.textContent = legacyRecovery; return; }
      recoveryBlocked = true; recoveryNotice.textContent = recoveryUnavailable; return;
    }
    if (!valid(current)) return;
    recoveryEntry = data?.machineId === item.machineId && Array.isArray(data.sessions)
      ? data.sessions.find(s => s.paneId === found.paneId && (!item.sessionId || s.sessionId === item.sessionId)) : undefined;
    recoveryNotice.textContent = recoverySummary(data);
    // A restored address can refer to another task. Missing permission is never a grant.
    recoveryBlocked = data?.machineId !== item.machineId || !Array.isArray(data?.sessions) || (item.sessionId ? recoveryEntry?.canObserve !== true : recoveryEntry ? recoveryEntry.canObserve !== true : false);
    if (recoveryEntry && (typeof recoveryEntry.canControl !== 'boolean' || !['current-agent', 'restored'].includes(recoveryEntry.origin))) {
      recoveryEntry = { ...recoveryEntry, canControl: false };
    }
    if (recoveryBlocked) recoveryNotice.textContent += recoveryEntry?.origin === 'restored'
      ? ' 这是代理重启前的旧绑定，归属尚未确认，已停止观察与控制，避免显示其他任务屏幕。'
      : ' 未报告此会话的观察权限，恢复状态未确认。';
  }
  async function watch(current, recheck = false) {
    if (!valid(current)) return;
    if (recheck) {
      ready = false; controlling = false; controls();
      try { await readRecovery(run, binding, current); }
      catch { if (valid(current)) { recoveryBlocked = true; recoveryNotice.textContent = recoveryUnavailable; } }
      if (!valid(current)) return;
    }
    if (recoveryBlocked) {
      terminal?.dispose(); terminal = undefined; showHistory();
      ready = false; controls(); status.textContent = '恢复状态未允许观察此终端'; historyLink.hidden = false; return;
    }
    ready = false; controls(); status.textContent = '正在连接，等待完整画面…';
    const url = new URL('/api/v1/terminal', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('machineId', run.machineId); url.searchParams.set('paneId', binding.paneId);
    const token = getToken(); if (token) url.searchParams.set('token', token);
    const ws = new WebSocket(url); socket = ws;
    let epoch, seq = -1, queue = Promise.resolve();
    const active = () => valid(current) && socket === ws && ws.readyState === WebSocket.OPEN;
    ws.onmessage = (event) => {
      // Serialize xterm writes: a new full frame must reset only after older writes finish.
      queue = queue.then(async () => {
        if (!active()) return;
        const frame = JSON.parse(event.data);
        if (typeof frame.epoch !== 'string' || !Number.isSafeInteger(frame.seq) || frame.seq < 0 || typeof frame.full !== 'boolean' || typeof frame.data !== 'string' || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 1000 || frame.height > 1000) throw new Error('终端画面格式无效');
        if (!frame.full && epoch === undefined) return;
        if (epoch === frame.epoch && frame.seq <= seq) return;
        if (!frame.full && (epoch !== frame.epoch || frame.seq !== seq + 1)) throw new Error('终端画面中断，正在重新同步…');
        const bytes = Uint8Array.from(atob(frame.data), char => char.charCodeAt(0));
        if (frame.full) { terminal.reset(); epoch = frame.epoch; }
        terminal.resize(frame.width, frame.height);
        await new Promise(resolve => terminal.write(bytes, resolve));
        if (!active()) return;
        seq = frame.seq; ready = true; controls(); error(); status.textContent = '正在观察当前终端画面';
      }).catch(err => { if (active()) { error(err.message); ready = false; controls(); ws.close(); } });
    };
    ws.onerror = () => { if (valid(current) && socket === ws) error('终端连接异常，正在恢复…'); };
    ws.onclose = () => {
      if (!valid(current) || socket !== ws) return;
      ready = false; controlling = false; controls(); status.textContent = '观察已断开，正在重连并获取完整画面…';
      retry = setTimeout(() => watch(current, true), 2000);
    };
  }
  async function open(item) {
    await show(item, async (current) => {
      const sessions = await api(`/machines/${encodeURIComponent(item.machineId)}/sessions`);
      if (!valid(current)) return;
      const found = sessions.find(entry => entry.sessionId === item.sessionId);
      if (!found?.paneId) throw new Error('没有找到此运行记录关联的会话。');
      await readRecovery(item, found, current);
      return found;
    });
  }
  // Unbound Herdr panes are observable, never writable from this drawer.
  async function openPane(item) { await show(item, async current => {
    const found = { paneId: item.paneId }; await readRecovery(item, found, current); return found;
  }); }
  async function show(item, resolveBinding) {
    close(); tokenAtOpen = getToken(); previousFocus = document.activeElement;
    run = { machineId: item.machineId, sessionId: item.sessionId, executionMode: item.executionMode, status: item.status, output: item.output };
    heading.textContent = item.title || '会话控制台';
    context.textContent = [item.cwd, item.sessionId && `会话 ${item.sessionId}`].filter(Boolean).join(' · ');
    controls();
    const current = revision; drawer.showModal();
    tokenTimer = setInterval(() => valid(revision), 250); status.textContent = '正在查找终端…';
    try {
      const resolved = await resolveBinding(current);
      if (!valid(current)) return;
      if (recoveryBlocked) {
        status.textContent = '恢复状态未允许观察此终端'; historyLink.hidden = false;
        showHistory();
        controls(); return;
      }
      if (typeof globalThis.Terminal !== 'function') throw new Error('终端组件未加载，请检查 /vendor/xterm.js。');
      binding = resolved;
      terminal = new globalThis.Terminal({ cursorBlink: false, disableStdin: true, scrollback: 0, fontSize: 13, theme: { background: '#101719', foreground: '#d9e3df' } });
      terminal.open(screen); watch(current);
    } catch (err) { if (valid(current)) { error('无法读取此终端，状态未确认。'); status.textContent = '无法观察此终端'; } }
  }
  function showHistory() {
    screen.replaceChildren();
    if (typeof run?.output !== 'string' || !run.output) return;
    const history = node('pre', run.output); history.style.whiteSpace = 'pre-wrap'; history.style.overflowWrap = 'anywhere';
    screen.append(node('p', '历史输出（不是当前画面）', 'muted'), history);
  }
  async function call(method) {
    if (!valid(revision) || recoveryBlocked || recoveryEntry?.canControl === false || !ready || !binding || !run?.sessionId || writing || !['queued', 'running', 'unknown'].includes(run.status) || (method === 'executor.input' && (run.executionMode !== 'interactive' || !controlling || !input.value.trim()))) return;
    const current = revision; const text = input.value;
    writing = true; controls(); error();
    try {
      await api(`/machines/${encodeURIComponent(run.machineId)}/call`, { method: 'POST', body: JSON.stringify({ method, params: { sessionId: run.sessionId, ...(method === 'executor.input' ? { text } : {}) } }) });
      if (valid(current) && method === 'executor.input' && input.value === text) input.value = '';
    } catch (err) { if (valid(current)) error(`${err.message}；未自动重试，请确认会话状态。`); }
    finally { if (valid(current)) { writing = false; controls(); } }
  }
  takeControl.addEventListener('click', () => { if (!valid(revision) || recoveryBlocked || recoveryEntry?.canControl === false || !ready || writing) return; controlling = !controlling; controls(); if (controlling) input.focus(); });
  reconnect.addEventListener('click', () => {
    if (!valid(revision) || recoveryBlocked || !binding || !terminal || writing) return;
    revision++; writing = false; clearTimeout(retry);
    if (socket) { socket.onclose = null; socket.close(); socket = undefined; }
    watch(revision, true);
  });
  function update(runs) {
    if (drawer.open && !valid(revision)) return;
    if (!run?.sessionId) return;
    const item = runs.find(x => x.machineId === run.machineId && x.sessionId === run.sessionId);
    if (item) { run.status = item.status; controls(); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); call('executor.input'); });
  interrupt.addEventListener('click', () => call('executor.interrupt'));
  closeButton.addEventListener('click', close);
  drawer.addEventListener('cancel', event => { event.preventDefault(); close(); });
  controls(); return { open, openPane, close, update };
}
