// 唯一的数据来源：服务端快照 + 待处理列表，由实时推送驱动刷新。
// 页面只订阅、只读取；不自己轮询，也不提供“刷新”按钮。

export function createStore(api) {
  const listeners = new Set();
  const queueChanges = new Set();
  const view = { snapshot: null, snapshotOwner: null, attention: [], savedPromptsRevision: null, workspaceBoardRevision: null, workspaceBoardFlowChange: null, savedSearchesRevision: null, messageFavoritesRevision: null, projectInstructionsChange: null, todoThreadChange: null, todoDecisionsChange: null, deletedFeishuThread: null, revokedAttachment: null, feishuBotChange: null, connection: 'connecting', unauthorized: false, loadError: '' };
  let request = 0;
  let socket;
  let reconnectTimer;
  let refreshTimer;
  let generation = 0;

  const emit = () => { for (const fn of listeners) fn(view); };
  const set = (patch) => { Object.assign(view, patch); emit(); };

  async function refresh() {
    const stamp = ++request;
    const owner = api.draftOwner?.();
    try {
      const [snapshot, attention] = await Promise.all([api.get('/state'), api.get('/attention')]);
      if (stamp !== request || owner !== api.draftOwner?.()) return;
      const messageQueueChanges = [...queueChanges];
      queueChanges.clear();
      set({ snapshot, snapshotOwner: owner, attention, messageQueueChanges, unauthorized: false, loadError: '' });
    } catch (error) {
      if (stamp !== request || owner !== api.draftOwner?.()) return;
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
    const owner = api.draftOwner?.();
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => { if (current === generation) { set({ connection: 'online' }); refresh(); } };
    ws.onmessage = ({ data }) => {
      if (current !== generation || owner !== api.draftOwner?.()) return;
      // Plugin views refresh their private data independently of the workspace snapshot.
      let event;
      try { event = JSON.parse(data); } catch { /* Refresh state after an unrecognized frame. */ }
      if (event?.type === 'messages.changed' && typeof event.data?.conversationId === 'string') {
        queueChanges.add(event.data.conversationId);
        scheduleRefresh();
        return;
      }
      if (event?.type === 'message-attachment.revoked' && typeof event.data?.messageId === 'string') {
        set({ revokedAttachment: { messageId:event.data.messageId } });
        return;
      }
      if (event?.type === 'source-subscriptions.changed') {
        set({ sourceSubscriptionsChange: {} });
        scheduleRefresh();
        return;
      }
      if (['run-review.changed', 'interactions.changed', 'notifications.created'].includes(event?.type)) {
        set({workspaceBoardFlowChange: {}});
        scheduleRefresh();
        return;
      }
      if (event?.type === 'workspace-board.changed' && Number.isSafeInteger(event.data?.revision)) {
        set({ workspaceBoardRevision: event.data.revision });
        return;
      }
      if (event?.type === 'saved-searches.changed' && Number.isSafeInteger(event.data?.revision)) {
        set({ savedSearchesRevision: event.data.revision });
        return;
      }
      if (event?.type === 'saved-prompts.changed' && Number.isSafeInteger(event.data?.revision)) {
        set({ savedPromptsRevision: event.data.revision });
        return;
      }
      if (event?.type === 'message-favorites.changed' && Number.isSafeInteger(event.data?.revision)) {
        set({ messageFavoritesRevision: event.data.revision });
        return;
      }
      if (event?.type === 'project-instructions.changed' && typeof event.data?.projectId === 'string' && Number.isSafeInteger(event.data.revision)) {
        set({ projectInstructionsChange: event.data });
        return;
      }
      if (event?.type === 'todo-decisions.changed' && typeof event.data?.todoId === 'string') {
        set({ todoDecisionsChange: { todoId: event.data.todoId } });
        return;
      }
      if (event?.type === 'todo-thread.changed' && typeof event.data?.todoId === 'string') {
        set({ todoThreadChange: { todoId: event.data.todoId } });
        return;
      }
      if (event?.type === 'feishu.changed' && typeof event.data?.botId === 'string') {
        const botId = event.data.botId;
        const threadId = event.data.deletedThreadId;
        if (event.data.groupReadsChanged === true || typeof event.data.paired === 'boolean' || Object.keys(event.data).length === 1)
          set({ feishuBotChange: { botId, bindingChanged: event.data.groupReadsChanged !== true } });
        if (event.data.threadsChanged === true && typeof threadId === 'string' && /^[0-9a-f]{64}$/.test(threadId))
          set({ deletedFeishuThread: { botId, threadId } });
      }
      scheduleRefresh();
    };
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
    reset() { request += 1; queueChanges.clear(); set({ messageQueueChanges:[], snapshot: null, snapshotOwner: null, attention: [], savedPromptsRevision: null, workspaceBoardRevision: null, workspaceBoardFlowChange: null, savedSearchesRevision: null, messageFavoritesRevision: null, projectInstructionsChange: null, todoThreadChange: null, todoDecisionsChange: null, deletedFeishuThread: null, revokedAttachment: null, feishuBotChange: null, unauthorized: false, loadError: '' }); connect(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
