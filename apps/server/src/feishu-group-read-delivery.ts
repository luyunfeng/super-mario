import { createHash } from 'node:crypto';
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
type Receipt = { status: 'unknown' | 'completed' | 'failed' | 'recalled'; replies?: string[] };

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
  return {
    recall(bot: FeishuBotSettings, chatId: string, messageId: string) {
      app.store.put(collection, keyFor(bot, chatId, messageId), { status: 'recalled' } satisfies Receipt);
    },
    async read(bot: FeishuBotSettings, adapter: FeishuBotAdapter, source: FeishuMessageSource,
      task: string, checkOwner: () => boolean, redact: (error: unknown) => string) {
      const { chatId, messageId, threadId, senderId } = source;
      if (!senderId || !chatId || !/^[\w-]+$/.test(messageId) || !checkOwner()) return;
      const key = keyFor(bot, chatId, messageId);
      const claimed = app.store.transaction(() => {
        if (app.store.get(collection, key)) return false;
        // Claim before I/O, so a crash or missing send receipt cannot cause an unsolicited retry.
        app.store.put(collection, key, { status: 'unknown' } satisfies Receipt);
        return true;
      });
      if (!claimed) return;
      const account = service?.account(bot.id);
      const authorized = () => checkOwner() && service?.account(bot.id) === account
        && app.store.get<Receipt>(collection, key)?.status === 'unknown';
      function guard() {
        if (!authorized()) throw new Error('读群请求的授权或原消息已变化');
      }
      let reaction: string | undefined;
      try {
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
            app.store.put(collection, key, { status: 'unknown', replies } satisfies Receipt);
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
        app.store.put(collection, key, { status, replies } satisfies Receipt);
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
      }
    },
  };
}
