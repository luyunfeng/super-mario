import { createHash } from 'node:crypto';
import type { FeishuBotAdapter, FeishuBotsApp } from './feishu-bots.ts';
import type { DashboardView } from './feishu-dashboard.ts';
import { cardDocument, cardPlain } from './feishu-cards.ts';

type Card = Record<string, unknown>;
type Status = { state: 'none' | 'pinned' | 'unconfirmed'; detail?: string };
type View = DashboardView | 'conversations' | 'form';
type Board = { id: string; eventKey: string; contentHash: string; view?: View; page?: number };
interface PinRecord extends Status { botId: string; binding: string; order: number; board?: Board; refreshUnconfirmed?: boolean }
interface Destination {
  binding: string;
  adapter: FeishuBotAdapter;
  authorize: (eventKey: string, messageId: string) => void;
  update: (messageId: string, card: Card, validate: () => boolean) => Promise<void>;
  build: (eventKey: string, view: Exclude<View, 'form'>, page: number) => Card;
}
const collection = 'feishu.pinned-workbench';
const hash = (card: Card) => createHash('sha256').update(JSON.stringify(card)).digest('hex');

// The only messages this service can remove are receipts of a previously confirmed home pin for this binding.
export function createPinnedWorkbench(app: FeishuBotsApp, bindingForStatus: (botId: string) => string | undefined, destination: (botId: string) => Destination | undefined) {
  const jobs = new Map<string, Promise<void>>();
  let closed = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  function serial(botId: string, operation: () => Promise<void>) {
    const job = (jobs.get(botId) ?? Promise.resolve()).catch(() => {}).then(operation);
    jobs.set(botId, job);
    void job.finally(() => { if (jobs.get(botId) === job) jobs.delete(botId); }).catch(() => {});
    return job;
  }
  function read(botId: string, binding: string) {
    const row = app.store.get<PinRecord>(collection, botId);
    return row?.binding === binding ? row : undefined;
  }
  function live(botId: string, dest: Destination) {
    const current = !closed && destination(botId);
    return current && current.binding === dest.binding && current.adapter === dest.adapter;
  }
  function save(row: PinRecord) {
    const previous = app.store.get<PinRecord>(collection, row.botId);
    app.store.put(collection, row.botId, row);
    if (previous?.state !== row.state || previous.detail !== row.detail || previous.binding !== row.binding || previous.refreshUnconfirmed !== row.refreshUnconfirmed)
      app.events.publish('feishu.changed', { botId: row.botId });
  }
  async function refresh(row: PinRecord) {
    const dest = destination(row.botId);
    const latest = read(row.botId, row.binding), board = latest?.board;
    if (!dest || !latest || !board || dest.binding !== row.binding || !live(row.botId, dest) || !dest.adapter.updateCard) return;
    dest.authorize(board.eventKey, board.id);
    if (board.view === 'form') return;
    const card = dest.build(board.eventKey, board.view ?? 'home', board.page ?? 0), contentHash = hash(card);
    if (board.contentHash === contentHash) return;
    // Claim the exact snapshot before remote I/O. A restart or lost response cannot replay it automatically.
    const attempt = { ...latest, board: { ...board, contentHash }, refreshUnconfirmed: true };
    save(attempt);
    try {
      await dest.update(board.id, card, () => Boolean(live(row.botId, dest) && read(row.botId, row.binding)?.board?.contentHash === contentHash));
      const now = read(row.botId, row.binding);
      if (now?.board?.id === board.id && now.board.contentHash === contentHash && live(row.botId, dest))
        save({ ...now, refreshUnconfirmed: false });
    } catch { /* Keep this snapshot's unconfirmed receipt; a later change may clear it. */ }
  }
  function refreshAll() {
    if (closed) return;
    for (const row of app.store.list<PinRecord>(collection)) {
      if (!row.board || jobs.has(row.botId)) continue;
      void serial(row.botId, () => refresh(row)).catch(() => {});
    }
  }
  const timer = setInterval(refreshAll, 60_000);
  timer.unref();
  return {
    scheduleRefresh() {
      if (closed || debounce) return;
      debounce = setTimeout(() => { debounce = undefined; refreshAll(); }, 100);
      debounce.unref();
    },
    eventKey(botId: string, messageId: string) {
      const dest = destination(botId), board = dest && read(botId, dest.binding)?.board;
      if (board?.id === messageId) return board.eventKey;
    },
    displayed(botId: string, messageId: string, view: View, page: number, card: Card) {
      const dest = destination(botId), row = dest && read(botId, dest.binding);
      if (row?.board?.id === messageId)
        save({ ...row, board: { ...row.board, view, page, contentHash: hash(card) } });
    },
    status(botId: string): Status {
      const binding = bindingForStatus(botId);
      const row = binding && read(botId, binding);
      if (!row) return { state: 'none' };
      const detail = [row.detail, row.refreshUnconfirmed && '置顶工作台内容更新未确认，可在私聊发送 /home。'].filter(Boolean).join(' ');
      return { state: row.state, ...(detail && { detail }) };
    },
    deliver(botId: string, binding: string, order: number, eventKey: string, card: Card,
      send: () => Promise<{ messageId?: string; fallback: boolean }>) {
      return serial(botId, async () => {
        const dest = destination(botId);
        if (!dest || dest.binding !== binding || !live(botId, dest)) throw new Error('工作台私聊绑定已变化');
        const previous = read(botId, binding);
        if (previous && order <= previous.order)
          throw Object.assign(new Error('工作台投递已被更新的回执取代，请查看私聊中的卡片。'), { delivery: 'no' });
        const attempt: PinRecord = { botId, binding, order, board: previous?.board,
          state: 'unconfirmed', detail: '本次工作台卡片的置顶结果尚未确认。' };
        save(attempt);
        const sent = await send();
        if (!live(botId, dest)) return;
        if (!sent.messageId || sent.fallback || !dest.adapter.pinMessage) {
          save({ ...attempt, detail: sent.fallback ? '已降级为文本，本次没有可置顶的卡片。'
            : !sent.messageId ? '未收到卡片消息标识，无法置顶。' : '当前适配器未提供置顶能力。' });
          return;
        }
        try { await dest.adapter.pinMessage(sent.messageId); }
        catch (error) {
          const denied = (error as { delivery?: string })?.delivery === 'no';
          if (live(botId, dest)) save({ ...attempt, detail: denied ? '飞书拒绝了置顶请求，请核对机器人权限。' : '工作台置顶结果未知，请核对聊天中的卡片。' });
          return;
        }
        if (!live(botId, dest)) return;
        dest.authorize(eventKey, sent.messageId);
        const old = previous?.board?.id;
        const pinned: PinRecord = { botId, binding, order, state: 'pinned', board: { id: sent.messageId, eventKey, contentHash: hash(card) } };
        if (!old || old === sent.messageId) { save(pinned); return; }
        save({ ...pinned, detail: '新工作台已置顶，上一张工作台的清理结果尚未确认。' });
        if (!live(botId, dest) || !dest.adapter.unpinMessage || !dest.adapter.recallMessage) return;
        try {
          await dest.adapter.unpinMessage(old);
          if (!live(botId, dest)) return;
          try { await dest.adapter.recallMessage(old); }
          catch (error) {
            // A definite rejection allows replacing the old content. An ambiguous withdrawal must not be replayed.
            if ((error as { delivery?: string })?.delivery !== 'no' || !live(botId, dest) || !dest.adapter.updateCard) return;
            await dest.adapter.updateCard(old, cardDocument('工作台已迁移', [{ tag: 'div', text: cardPlain('请查看当前私聊中新置顶的工作台。') }]));
          }
          if (live(botId, dest)) save(pinned);
        } catch { /* The persisted detail keeps unconfirmed cleanup visible to the owner. */ }
      });
    },
    async close() { closed = true; clearInterval(timer); clearTimeout(debounce); await Promise.allSettled([...jobs.values()]); },
  };
}
