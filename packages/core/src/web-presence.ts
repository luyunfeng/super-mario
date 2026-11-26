import type { WebPresenceInput } from '../../protocol/src/index.ts';

/** Leases belong to this server lifetime: a restart must not inherit a live browser. */
export function createWebPresence(now = Date.now) {
  const tabs = new Map<string, { visible: boolean; focused: boolean; expiresAt: number; sequence: number; device: string }>();
  function status() {
    for (const [id, tab] of tabs) if (tab.expiresAt <= now()) tabs.delete(id);
    return { present: [...tabs.values()].some(t => t.visible && t.focused), tabs: tabs.size, leaseMs: 45000 };
  }
  /** Whether this browser has a page that is visible and in front. A browser that sent no device
   *  id is never matched: it is told apart only by the one it did send. */
  function devicePresent(device: string) {
    status();
    return [...tabs.values()].some(tab => tab.device === device && tab.device !== '' && tab.visible && tab.focused);
  }
  return { status, devicePresent, heartbeat(input: WebPresenceInput) {
    if (!input || typeof input.tabId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.tabId)
      || typeof input.visible !== 'boolean' || typeof input.focused !== 'boolean') throw Object.assign(new Error('页面在场参数无效'), { status: 400 });
    if (input.sequence !== undefined && (!Number.isSafeInteger(input.sequence) || input.sequence < 0)) throw Object.assign(new Error('页面序号无效'), {status:400});
    if (input.device !== undefined && (typeof input.device !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.device))) throw Object.assign(new Error('浏览器编号无效'), { status: 400 });
    status();
    const sequence = input.sequence ?? (tabs.get(input.tabId)?.sequence ?? -1) + 1;
    if ((tabs.get(input.tabId)?.sequence ?? -1) >= sequence) return status();
    if (!tabs.has(input.tabId) && tabs.size >= 256) throw Object.assign(new Error('页面数量达到上限'), { status: 429 });
    tabs.set(input.tabId, { visible: input.visible, focused: input.focused, expiresAt: now() + 45000, sequence, device: input.device ?? '' });
    return status();
  } };
}
