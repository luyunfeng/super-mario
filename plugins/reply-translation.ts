import type { Extension, Json, Store } from '../packages/plugin-sdk/src/index.ts';
import type { InboxItem, MailboxEntry, Message, Project } from '../packages/protocol/src/index.ts';

const languages = new Map([
  ['zh-Hans', '简体中文'], ['zh-Hant', '繁體中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'],
  ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['ru', 'Русский'], ['pt', 'Português'],
]);
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function readReply(store: Store, conversationId: string, messageId: string) {
  const missing = () => fail(404, '当前对话中没有这条可翻译的回复');
  const message = store.get<Message>('messages', messageId);
  if (!message || message.conversationId !== conversationId || message.role !== 'assistant' ||
      (message.status ?? 'done') !== 'done' || (message.origin && message.origin !== 'user') || (typeof message.text !== 'string' || !message.text.trim())) return missing();
  if (conversationId !== 'main') {
    const projectId = /^project:(.+):work$/.exec(conversationId)?.[1];
    if (!projectId || (message.projectId && message.projectId !== projectId)) return missing();
    const project = store.get<Project>('projects', projectId);
    if (!project || project.archivedAt) return missing();
  }
  return message.text;
}

type InboxRef = { kind: 'personal' | 'mailbox'; id: string; version: number; account: string; chatId: string };

function readInbox(store: Store, ref: InboxRef): string {
  const missing = () => fail(404, '当前飞书会话中没有这条可翻译的收件');
  function checkProject(id?: string) {
    if (!id) return;
    const project = store.get<Project>('projects', id);
    if (!project || project.archivedAt) missing();
  }
  let text: string, version: number;
  if (ref.kind === 'personal') {
    const item = store.get<InboxItem>('inbox', ref.id);
    if (!item || item.source !== ref.account || !item.source.startsWith('feishu:') ||
        item.origin?.connector !== '飞书' || item.origin.chatId !== ref.chatId ||
        !['direct', 'group'].includes(item.origin.kind) || typeof item.text !== 'string') return missing();
    checkProject(item.projectId);
    text = item.text.replace(/^\[(?:om_|omt_)[^\]]*\]\s*/gm, '');
    version = item.version;
  } else {
    const entry = store.get<MailboxEntry>('event.mailboxes', ref.id);
    if (!entry || entry.direction !== 'inbox' || entry.botId !== ref.account || !entry.sourceMessageId ||
        !entry.origin || !['direct', 'group'].includes(entry.origin.kind) || entry.origin.chatId !== ref.chatId ||
        (entry.target && entry.target !== ref.chatId) || typeof entry.text !== 'string') return missing();
    const connector = entry.origin.connector;
    if (!(connector === '飞书机器人' && entry.eventKey.startsWith('feishu-in:') ||
          connector === '飞书' && entry.eventKey.startsWith('feishu-collect:') ||
          connector === '飞书总指挥群' && entry.eventKey.startsWith('feishu-command:in:'))) return missing();
    if ('projectId' in entry.scope) checkProject(entry.scope.projectId);
    // A global bot can route a private chat into a selected project workspace.
    checkProject(store.get<{ chatProject?: string }>('feishu.bot.envelopes', ref.id)?.chatProject);
    text = entry.text;
    version = entry.version;
  }
  if (version !== ref.version) fail(409, '收件已更新，请刷新后重新翻译');
  if (!text.trim()) return missing();
  return text;
}

type Translate = (text: string, language: string, signal: AbortSignal) => Promise<string>;

export function createReplyTranslation(translate: Translate, modelRevision: () => string): Extension {
  return {
    id: 'reply-translation', name: '回复翻译', capabilities: ['conversation.reply.translate', 'inbox.message.translate'],
    permissions: ['service.provide:reply-translation.translate', 'service.provide:reply-translation.inbox', 'store.read'],
    activate(context) {
      const lifetime = new AbortController();
      // Keep a small in-memory cache across page reloads. Recheck access before
      // each hit, even when the same reply was already translated.
      const cache = new Map<string, { source: string; text: string }>();
      let cachedModel = modelRevision();
      context.defer(() => lifetime.abort());
      async function translateSource(identity: (string | number)[], target: string, request: AbortSignal, read: () => string) {
        const language = languages.get(target);
        if (!language) fail(400, '不支持这个翻译目标语言');
        const signal = AbortSignal.any([lifetime.signal, request]);
        signal.throwIfAborted();
        const source = read();
        const model = modelRevision();
        if (model !== cachedModel) { cache.clear(); cachedModel = model; }
        const key = JSON.stringify([...identity, target]);
        const cached = cache.get(key);
        if (cached?.source === source) return { text: cached.text };
        const text = await translate(source, language, signal);
        signal.throwIfAborted();
        // A project may be archived, or a message changed, while the model is running.
        if (read() !== source)
          fail(409, '回复已更新，请重新翻译');
        if (modelRevision() !== model) fail(409, '翻译模型已改变，请重新翻译');
        if (!cache.has(key) && cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(key, { source, text });
        return { text };
      }
      context.provide('reply-translation.translate', async (input: Json, request) => {
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            typeof input.messageId !== 'string' || !input.messageId || typeof input.conversationId !== 'string' || !input.conversationId ||
            typeof input.target !== 'string' || Object.keys(input).some(k => !['messageId', 'conversationId', 'target'].includes(k)))
          fail(400, '请指定回复、所属对话和目标语言');
        const { conversationId, messageId, target } = input;
        return translateSource(['reply', conversationId, messageId], target, request,
          () => readReply(context.store, conversationId, messageId));
      });
      context.provide('reply-translation.inbox', async (input: Json, request) => {
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).some(k => !['kind', 'id', 'version', 'account', 'chatId', 'target'].includes(k)))
          fail(400, '收件翻译参数无效');
        const { kind, id, version, account, chatId, target } = input;
        if ((kind !== 'personal' && kind !== 'mailbox') || typeof id !== 'string' || !id.trim() ||
            typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 ||
            typeof account !== 'string' || !account.trim() || typeof chatId !== 'string' || !chatId.trim() ||
            typeof target !== 'string') fail(400, '请指定收件、版本、账号、会话和目标语言');
        return translateSource(['inbox', kind, id, account, chatId, version], target, request,
          () => readInbox(context.store, { kind, id, version, account, chatId }));
      });
    },
  };
}
