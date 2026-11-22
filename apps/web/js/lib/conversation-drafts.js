// Keep a shared memory fallback for composers that use the same workbench client.
const clients = new WeakMap();

export function createConversationDrafts({ api, store }) {
  if (clients.has(api)) return clients.get(api);
  const memory = new Map();
  let identity = api.draftOwner();
  function owner() {
    const current = api.draftOwner();
    if (identity !== current) { memory.clear(); identity = current; }
    return identity;
  }
  function persistent() {
    const { snapshot, snapshotOwner, unauthorized } = store.view;
    return snapshotOwner === owner() && !unauthorized &&
      snapshot?.plugins?.some(plugin => plugin.id === 'conversation-drafts' && plugin.status === 'active');
  }
  function storageKey(key) { return 'sm.conversation-draft.' + identity + '.' + key; }

  // A delayed send acknowledgement can remove only its submitted text, including
  // when the acknowledgement arrived while persistence was disabled.
  function flush(key, entry) {
    if (!entry.dirty) return;
    try {
      const path = storageKey(key);
      if (entry.expected !== undefined) {
        const latest = localStorage.getItem(path);
        if (latest === entry.expected || (entry.base !== undefined && latest === entry.base)) localStorage.removeItem(path);
        else entry.text = latest ?? '';
      } else if (entry.text) localStorage.setItem(path, entry.text);
      else localStorage.removeItem(path);
      entry.dirty = false;
      entry.base = entry.text || null;
      delete entry.expected;
    } catch { /* Keep unsaved text or its conditional deletion in memory. */ }
  }

  function read(key) {
    const active = persistent();
    const entry = memory.get(key);
    if (!active) return entry?.text ?? '';
    if (entry?.dirty) { flush(key, entry); return entry.text; }
    try {
      const text = localStorage.getItem(storageKey(key)) ?? '';
      memory.set(key, { text, dirty: false, base: text || null });
      return text;
    } catch { return entry?.text ?? ''; }
  }

  function write(key, text) {
    const active = persistent();
    const entry = { text, dirty: true, base: memory.get(key)?.base };
    memory.set(key, entry);
    if (active) flush(key, entry);
  }

  function clearIf(key, expected) {
    const active = persistent();
    const entry = memory.get(key);
    if ((entry?.dirty || !active) && entry?.text !== expected) return;
    // A quota failure may leave the previous local edit on disk. Remove it
    // only when it still matches the baseline of this unsaved submitted edit.
    const cleared = { text: '', dirty: true, expected, base: entry?.dirty ? entry.base : undefined };
    memory.set(key, cleared);
    if (active) flush(key, cleared);
  }

  store.subscribe(() => {
    if (persistent()) for (const [key, entry] of memory) flush(key, entry);
  });
  const drafts = { read, write, clearIf, owner };
  clients.set(api, drafts);
  return drafts;
}
