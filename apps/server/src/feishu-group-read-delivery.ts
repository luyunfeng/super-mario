import { createHash } from 'node:crypto';
import type { GroupReadRecord, GroupReadPage } from '../../../packages/protocol/src/index.ts';
import type { FeishuMessageSource } from '../../../plugins/feishu.ts';
import { publicText } from '../../../plugins/agent-progress-card.ts';
import type { FeishuBotSettings } from '../../../plugins/feishu-bot-config.ts';
import type { FeishuBotAdapter, FeishuBotsApp } from './feishu-bots.ts';

export type GroupReadRequest = { botId: string; appId: string; chatId: string; messageId: string; threadId?: string; ownerId: string; task: string };
export interface GroupReadService {
  account(botId: string): string | undefined;
  run(input: GroupReadRequest, assertCurrent: () => void): Promise<string>;
}

const collection = 'feishu.group-read';
type Status = GroupReadRecord['status'];
type Receipt = { status: Exclude<Status, 'working'>; replies?: string[]; history?: {
  id: string; binding: string; previousId?: string; createdAt: string; task: string; answer: string; totalParts: number | null;
} };

function answerPieces(answer: string) {
  let chars = Array.from(publicText(answer, Number.MAX_SAFE_INTEGER));
  // The reader appends coverage and omission notes. Keep that footer when the five-part limit is reached.
  const max = 4000, total = 5 * max;
  const omitted = Array.from('\n（回答过长，中段已省略）\n');
  if (chars.length > total) chars = [...chars.slice(0, total - 2000 - omitted.length), ...omitted, ...chars.slice(-2000)];
  const pieces: string[] = [];
  for (let from = 0; from < chars.length; from += max) pieces.push(chars.slice(from, from + max).join(''));
  return pieces;
}
const keyFor = (bot: FeishuBotSettings, chatId: string, messageId: string) =>
  createHash('sha256').update(JSON.stringify([bot.id, bot.appId, chatId, messageId])).digest('hex');

/** Only this command can reply in an unlisted group. Each part can only reply to the triggering message. */
export function groupReadDelivery(app: FeishuBotsApp, service?: GroupReadService) {
  const working = new Set<string>();
  const changed = (botId: string) => app.events.publish('feishu.changed', { botId, groupReadsChanged: true });
  function visible(row: Receipt): GroupReadRecord {
    const { id, createdAt, task, answer, totalParts } = row.history!;
    const status: Status = row.status === 'unknown' && working.has(id) ? 'working' : row.status;
    return { id, createdAt, task, answer, totalParts, status, confirmedParts: row.replies?.length ?? 0 };
  }
  return {
    list(binding: string, before?: string, recordId?: string): GroupReadPage {
      if (recordId !== undefined) {
        const row = app.store.get<Receipt>(collection, recordId);
        if (!row?.history || row.history.binding !== binding) throw Object.assign(new Error('读群记录不存在'), { status: 404 });
        return { items: [visible(row)], nextBefore: null };
      }
      let id: string | undefined;
      if (before === undefined) id = app.store.get<string>('feishu.group-read.latest', binding);
      else {
        const cursor = app.store.get<Receipt>(collection, before)?.history;
        if (!cursor || cursor.binding !== binding) throw Object.assign(new Error('读群记录游标已失效'), { status: 400 });
        id = cursor.previousId;
      }
      const items: GroupReadRecord[] = [];
      while (id && items.length < 20) {
        const row = app.store.get<Receipt>(collection, id);
        if (!row?.history || row.history.binding !== binding) break;
        items.push(visible(row));
        id = row.history.previousId;
      }
      return { items, nextBefore: id && items.length === 20 ? items[19].id : null };
    },
    recall(bot: FeishuBotSettings, chatId: string, messageId: string) {
      const key = keyFor(bot, chatId, messageId), row = app.store.get<Receipt>(collection, key);
      if ((!row && !bot.readGroup) || row?.status === 'recalled') return;
      app.store.put(collection, key, { ...row, status: 'recalled',
        ...(row?.history && { history: { ...row.history, task: '', answer: '' } }) } satisfies Receipt);
      if (row?.history) changed(bot.id);
    },
    async read(bot: FeishuBotSettings, adapter: FeishuBotAdapter, source: FeishuMessageSource,
      task: string, binding: string, checkOwner: () => boolean, redact: (error: unknown) => string) {
      const { chatId, messageId, threadId, senderId } = source;
      if (!senderId || !chatId || !/^[\w-]+$/.test(messageId) || !checkOwner()) return;
      const key = keyFor(bot, chatId, messageId);
      const history: NonNullable<Receipt['history']> = { id: key, binding, createdAt: new Date().toISOString(),
        task: publicText(redact(task), 4000), answer: '', totalParts: null };
      const claimed = app.store.transaction(() => {
        if (app.store.get(collection, key)) return false;
        // The cursor chain is immutable after insertion. A later request cannot shift an open page.
        history.previousId = app.store.get<string>('feishu.group-read.latest', binding);
        app.store.put('feishu.group-read.latest', binding, key);
        // Claim before I/O, so a crash or missing send receipt cannot cause an unsolicited retry.
        app.store.put(collection, key, { status: 'unknown', history } satisfies Receipt);
        return true;
      });
      if (!claimed) return;
      let account: string | undefined;
      working.add(key);
      changed(bot.id);
      const authorized = () => checkOwner() && service?.account(bot.id) === account
        && app.store.get<Receipt>(collection, key)?.status === 'unknown';
      function guard() {
        if (!authorized()) throw new Error('读群请求的授权或原消息已变化');
      }
      let reaction: string | undefined;
      try {
        account = service?.account(bot.id);
        if (adapter.readReaction) reaction = await adapter.readReaction(messageId, 'OnIt', guard).catch(() => undefined);
        guard();
        let answer: string;
        let answered = false;
        if (!service || !account) answer = '暂时无法读取群消息，请主人在 Web 核对个人飞书账号授权。';
        else {
          try {
            answer = await service.run({ botId: bot.id, appId: bot.appId, chatId, messageId, threadId, ownerId: senderId, task }, guard);
            if (!answer?.trim()) throw new Error('未取得回答');
            answered = true;
          } catch {
            answer = '读取群消息或生成回答失败，请主人在 Web 核对个人飞书授权和模型配置。';
          }
        }
        guard();
        const pieces = answerPieces(redact(answer));
        history.totalParts = pieces.length;
        app.store.put(collection, key, { status: 'unknown', history } satisfies Receipt);
        changed(bot.id);
        const replies: string[] = [];
        for (const [index, text] of pieces.entries()) {
          guard();
          const replyKey = 'rd-' + key.slice(0, 36) + '-' + index;
          const payload = { botId: bot.id, accountId: bot.appId, chatId, target: chatId, key: replyKey, text, replyTo: messageId, ...(threadId && { threadId }) };
          let attempted = false, platformId: string | undefined;
          async function send() {
            guard();
            if (attempted) throw new Error('本段读群回复已尝试投递');
            attempted = true;
            await adapter.send(chatId, text, { replyTo: messageId, threadId, groupReadReply: guard, replyKey, onSent: id => { platformId = id; } });
            guard();
            if (!platformId || replies.includes(platformId)) throw new Error('未收到本段读群回复的独立回执');
            replies.push(platformId);
            history.answer += text;
            app.store.put(collection, key, { status: 'unknown', replies, history } satisfies Receipt);
            changed(bot.id);
            return null;
          }
          if (app.plugins?.invocations) await app.plugins.invocations.invoke('channel.send', payload, async prepared => {
            if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)
              || Object.entries(payload).some(([key, value]) => prepared[key] !== value))
              throw new Error('读群回复的来源、受众或内容已变化');
            return send();
          }); else await send();
          guard();
          if (replies.length !== index + 1) throw new Error('渠道未确认本段读群回复');
        }
        const status = answered ? 'completed' : 'failed';
        app.store.put(collection, key, { status, replies, history } satisfies Receipt);
        changed(bot.id);
        const afterSend = () => {
          if (!checkOwner() || service?.account(bot.id) !== account || app.store.get<Receipt>(collection, key)?.status !== status)
            throw new Error('读群回执已失效');
        };
        if (reaction) await adapter.readReaction?.(messageId, 'OnIt', afterSend, reaction).catch(() => {});
        if (answered) await adapter.readReaction?.(messageId, 'DONE', afterSend).catch(() => {});
      } catch {
        // Source recall, rebind, and ambiguous remote delivery must never detour to another destination.
        if (!authorized()) return;
        if (reaction) await adapter.readReaction?.(messageId, 'OnIt', guard, reaction).catch(() => {});
        throw new Error('读群回复未确认送达，请核对原群消息。');
      } finally {
        working.delete(key);
        if (app.store.get<Receipt>(collection, key)?.status === 'unknown') changed(bot.id);
      }
    },
  };
}
