// 唯一的数据来源：服务端快照 + 待处理列表，由实时推送驱动刷新。
// 页面只订阅、只读取；不自己轮询，也不提供“刷新”按钮。

export function createStore(api) {
  const listeners = new Set();
  const view = { snapshot: null, attention: [], connection: 'connecting', unauthorized: false, loadError: '' };
  let request = 0;
  let socket;
  let reconnectTimer;
  let refreshTimer;
  let generation = 0;

  const emit = () => { for (const fn of listeners) fn(view); };
  const set = (patch) => { Object.assign(view, patch); emit(); };

  async function refresh() {
    const stamp = ++request;
    try {
      const [snapshot, attention] = await Promise.all([api.get('/state'), api.get('/attention')]);
      if (stamp !== request) return;
      set({ snapshot, attention, unauthorized: false, loadError: '' });
    } catch (error) {
      if (stamp !== request) return;
      if (error.status === 401) set({ unauthorized: true, loadError: error.message });
      else set({ loadError: error.message });
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 120);
  }

  function connect() {
    generation += 1;
    const current = generation;
    clearTimeout(reconnectTimer);
    if (socket) { socket.onclose = null; socket.close(); }
    set({ connection: 'connecting' });
    const url = new URL('/api/v1/events', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (api.token()) url.searchParams.set('token', api.token());
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => { if (current === generation) { set({ connection: 'online' }); refresh(); } };
    ws.onmessage = () => { if (current === generation) scheduleRefresh(); };
    ws.onerror = () => { if (current === generation) set({ connection: 'offline' }); };
    ws.onclose = () => {
      if (current !== generation) return;
      set({ connection: 'offline' });
      reconnectTimer = setTimeout(connect, 1500);
    };
    refresh();
  }

  window.addEventListener('online', connect);
  window.addEventListener('offline', () => { set({ connection: 'offline' }); socket?.close(); });

  return {
    view,
    refresh,
    connect,
    reconnect: connect,
    reset() { request += 1; set({ snapshot: null, attention: [], unauthorized: false, loadError: '' }); connect(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
